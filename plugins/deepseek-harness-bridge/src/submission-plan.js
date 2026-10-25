import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { BridgeError, boundedInteger, requireValue } from './errors.js';
import { resolveProfile } from './capabilities.js';
import { planExecution } from './planning.js';
import { optionalLimit, deadlineAfter } from './limits.js';
import { commonImplementationConstraints } from './implementation-constraints.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const inside = (root, child) => { const p = relative(root, child); return p === '' || (!p.startsWith(`..${sep}`) && p !== '..' && !isAbsolute(p)); };

export function inputPrompt(value) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 65536,
    'INVALID_ARGUMENT', 'prompt must be nonempty and at most 64 KiB.');
  return value;
}

export function requestId(value) {
  requireValue(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', 'requestId must contain 1–80 letters, digits, dots, underscores or hyphens.');
  return value;
}

// Resolve missing state ancestry without creating it or opening the task store.
export async function canonicalStatePath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalStatePath(parent), basename(path));
  }
}

export async function resolveWorkspace(value, dataDir) {
  requireValue(typeof value === 'string' && isAbsolute(value), 'INVALID_ARGUMENT', 'workspace must be an absolute existing directory.');
  let resolved;
  try { resolved = await realpath(value); requireValue((await stat(resolved)).isDirectory(), 'INVALID_ARGUMENT', 'workspace must be a directory.'); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('INVALID_ARGUMENT', 'workspace is not an accessible directory.'); }
  requireValue(!inside(resolved, dataDir) && !inside(dataDir, resolved), 'INVALID_ARGUMENT', 'Task workspace and bridge state must not contain one another.');
  return resolved;
}

// Shared with admission. Legacy replay options are selected only by the store;
// a standalone preview describes a NEW request and cannot approve a replay.
export function normalizeSubmission(input, options = {}) {
  const prompt = inputPrompt(input.prompt);
  const id = requestId(input.requestId);
  const planned = planExecution(input, options);
  const access = input.access ?? 'read-only';
  requireValue(['read-only', 'workspace-write'].includes(access), 'INVALID_ARGUMENT', 'access must be read-only or workspace-write.');
  const timeoutMs = options.compatibilityV1 ? boundedInteger(input.timeoutMs, 300000, 1000, 1800000, 'timeoutMs') : optionalLimit(input.timeoutMs, 'timeoutMs');
  const maxRequestBytes = options.compatibilityV1 ? boundedInteger(input.maxRequestBytes, 262144, 1024, 1048576, 'maxRequestBytes') : optionalLimit(input.maxRequestBytes, 'maxRequestBytes');
  // Replay does not gain a new deadline and must retain its original receipt.
  if (options.validateDeadlines !== false) {
    deadlineAfter(timeoutMs);
    deadlineAfter(planned.budget?.totalDurationMs);
  }
  if (input.parentLabel !== undefined) requireValue(typeof input.parentLabel === 'string' && input.parentLabel.length <= 160,
    'INVALID_ARGUMENT', 'parentLabel must be a string of at most 160 characters.');
  return { prompt, id, planned, access, timeoutMs, maxRequestBytes };
}

const origin = (object, key, derived = false) => object?.[key] != null ? 'caller'
  : derived ? 'mode' : object?.[key] === null ? 'caller-unspecified' : 'omitted';

export async function previewSubmission(input, { dataDir, resolveCapabilities = resolveProfile }) {
  const { planned, access, timeoutMs, maxRequestBytes } = normalizeSubmission(input);
  requireValue(typeof dataDir === 'string' && isAbsolute(dataDir), 'INVALID_CONFIG', 'The bridge data directory must be absolute.');
  const workspace = await resolveWorkspace(input.workspace, await canonicalStatePath(dataDir));
  const profile = await resolveCapabilities(planned.capabilityProfile, undefined, { workspace, requestedWorkspace: input.workspace, access, nativePlugins: input.nativePlugins });
  requireValue(access === 'workspace-write' || profile.access === 'read-only', 'PROFILE_ACCESS', 'This capability profile requires workspace-write access.');
  const single = planned.executionMode === 'single-request';
  const limits = { maxTokens: planned.maxTokens, maxModelRequests: planned.maxModelRequests, maxToolCalls: planned.maxToolCalls,
    timeoutMs, maxRequestBytes, budget: planned.budget };
  const limitSources = Object.fromEntries(['maxTokens', 'maxModelRequests', 'maxToolCalls', 'timeoutMs', 'maxRequestBytes'].map(key =>
    [key, origin(input, key, (key === 'maxModelRequests' && single) || (key === 'maxToolCalls' && (single || planned.capabilityProfile === 'inference-only')))]));
  if (planned.budget) for (const key of Object.keys(planned.budget)) limitSources[`budget.${key}`] = origin(input.budget, key);
  return {
    kind: 'submission-plan', scope: 'new-task',
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    execution: { executionMode: planned.executionMode, workload: planned.workload, effort: planned.effort,
      effortSource: input.effort === undefined ? 'workload' : 'caller', capabilityProfile: planned.capabilityProfile, access, outputFormat: planned.outputFormat },
    workspace, limits, limitSources, warnings: planned.warnings,
    implementationConstraints: [...commonImplementationConstraints],
    recovery: { available: planned.executionMode === 'budgeted', policy: planned.executionMode === 'budgeted' ? 'bounded-v1' : 'none',
      condition: 'Only eligible format/truncation failures with confirmed cleanup, valid accounting and remaining authorization; no side effects are repeated.' },
    continuation: { available: !single, condition: single ? 'Prohibited by single-request.' : 'Only completed sessions or safely paused budgeted tasks, with original authorization and control ownership.' },
    capabilities: { id: profile.id, digest: profile.digest, fileTools: profile.fileTools, declaredTools: profile.tools,
      moduleCount: profile.modules.length, skillCount: profile.skills.length, runtimeVerified: false,
      ...(profile.native?.remainingImplementationConstraints ? { remainingImplementationConstraints: profile.native.remainingImplementationConstraints } : {}) },
    checks: { arguments: 'valid', workspace: 'valid', capabilities: 'resolved', credentials: 'not_checked', admission: 'not_checked', replay: 'not_checked', authorization: 'not_assessed' },
    parentAcceptance: 'not_assessed', validation: { modelCalls: 0, workerStarts: 0, stateWrites: 0 },
  };
}
