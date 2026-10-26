import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BridgeError, requireValue } from './errors.js';
import { WorkspaceFiles } from './workspace.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const pointer = z.string().max(1024).regex(/^(?:\/(?:[^~]|~[01])*)?$/);
const expected = z.union([z.string().max(8192), z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.boolean(), z.null()]);
export const recoveryMilestonesSchema = z.array(z.object({ id, path: z.string().min(1).max(1024),
  assertions: z.array(z.object({ pointer, expected }).strict()).min(1).max(32) }).strict()).min(1).max(64);

export function normalizeRecoveryMilestones(value, executionMode) {
  if (value === undefined) return null;
  const parsed = recoveryMilestonesSchema.safeParse(value);
  const issues = parsed.success ? [] : parsed.error.issues.map(issue => ({ ...issue, path: ['recoveryMilestones', ...issue.path] }));
  if (executionMode !== 'budgeted') issues.push({ path: ['recoveryMilestones'], code: 'budgeted_required' });
  if (parsed.success) {
    const ids = new Set();
    for (const [index, milestone] of parsed.data.entries()) {
      if (ids.has(milestone.id)) issues.push({ path: ['recoveryMilestones', index, 'id'], code: 'duplicate_check_id' });
      ids.add(milestone.id);
      if (isAbsolute(milestone.path) || milestone.path.includes(':') || milestone.path.split(/[\\/]/).some(part => ['.', '..', ''].includes(part))) {
        issues.push({ path: ['recoveryMilestones', index, 'path'], code: 'invalid_format' });
      }
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > 32768) issues.push({ path: ['recoveryMilestones'], code: 'checks_utf8_size_limit' });
  }
  if (issues.length) throw new BridgeError('INVALID_ARGUMENT', 'Invalid recovery milestone contract.', { validation: { phase: 'contract', issues } });
  return parsed.data;
}

function matches(value, assertion) {
  for (const key of assertion.pointer === '' ? [] : assertion.pointer.slice(1).split('/').map(x => x.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
    value = value[key];
  }
  return value === assertion.expected;
}

// Only parent-declared guarded artifacts are observed. Missing or unparseable
// evidence cannot grant progress; no worker-reported progress counter is trusted.
async function readMilestones(record, signal) {
  const plan = record.orchestration;
  const seen = new Set(plan.progressSeen ?? []);
  const files = new WorkspaceFiles({ workspace: record.workspace, access: 'read-only' });
  const cache = new Map();
  const observed = [];
  const known = [];
  for (const milestone of plan.recoveryMilestones ?? []) {
    if (signal.aborted) return { evidence: [], known: [] };
    if (seen.has(milestone.id)) continue;
    if (!cache.has(milestone.path)) cache.set(milestone.path, (async () => {
      try {
        const bytes = await files.readEvidence(milestone.path);
        if (bytes.includes(0)) return { known: true };
        let object;
        try { object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { return { known: true }; }
        if (!object || typeof object !== 'object' || Array.isArray(object)) return { known: true };
        return { object, sha256: createHash('sha256').update(bytes).digest('hex') };
      } catch (error) { return error.code === 'ENOENT' ? { known: true } : null; }
    })());
    const file = await cache.get(milestone.path);
    if (signal.aborted) return { evidence: [], known: [] };
    if (file) known.push(milestone.id);
    if (file?.object && milestone.assertions.every(assertion => matches(file.object, assertion))) observed.push({ id: milestone.id, sha256: file.sha256 });
  }
  return { evidence: observed, known };
}

export async function observeMilestones(record, { signal, timeoutMs = 5000, read = readMilestones } = {}) {
  if (!record.orchestration.recoveryMilestones?.length) return { status: 'not_requested', evidence: [], known: [] };
  if (signal?.aborted) return { status: 'aborted', evidence: [], known: [] };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    return await Promise.race([
      read(record, controller.signal).then(observed => ({ status: 'observed', ...observed })),
      new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ status: signal?.aborted ? 'aborted' : 'timed_out', evidence: [], known: [] }), { once: true })),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

export function recoveryEligible(plan) {
  const lastRecovery = plan.stages.findLast(stage => ['truncation-recovery', 'format-recovery'].includes(stage.purpose));
  if (!lastRecovery) return true;
  return plan.recoveryPolicy === 'progress-v2' && plan.stages.some(stage => stage.number > lastRecovery.number
    && stage.purpose === 'work' && stage.status === 'checkpoint' && stage.progressEvidence?.length > 0);
}

export function validateProgress(plan) {
  const milestones = normalizeRecoveryMilestones(plan.recoveryMilestones, 'budgeted') ?? [];
  const ids = new Set(milestones.map(x => x.id));
  const seen = plan.progressSeen;
  requireValue(Array.isArray(seen) && new Set(seen).size === seen.length && seen.every(id => ids.has(id)), 'INVALID_STATE', 'Invalid saved progress identity.');
  const credited = new Set();
  for (const stage of plan.stages) {
    if (stage.progressEvidence === undefined) continue;
    requireValue(stage.purpose === 'work' && ['checkpoint', 'completed'].includes(stage.status) && Array.isArray(stage.progressEvidence),
      'INVALID_STATE', 'Invalid progress stage.');
    for (const proof of stage.progressEvidence) {
      requireValue(proof && ids.has(proof.id) && seen.includes(proof.id) && !credited.has(proof.id)
        && stage.progressBaseline === 'observed' && Array.isArray(stage.progressBaselineKnown) && stage.progressBaselineKnown.includes(proof.id)
        && stage.progressObservation === 'observed' && /^[a-f0-9]{64}$/.test(proof.sha256), 'INVALID_STATE', 'Invalid saved progress evidence.');
      credited.add(proof.id);
    }
  }
}
