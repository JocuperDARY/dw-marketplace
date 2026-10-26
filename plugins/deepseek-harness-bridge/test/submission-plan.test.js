import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { ConnectionTasks } from '../src/connection-tasks.js';
import { createServer } from '../src/server.js';
import { workerEnvironment } from '../src/sdk-runner.js';
import { createHash } from 'node:crypto';
import { previewSubmission } from '../src/submission-plan.js';
import { resolveProfile } from '../src/capabilities.js';

async function fixture(t, { locked = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-plan-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'state');
  await mkdir(workspace);
  if (locked) {
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'owner.lock'), 'untouched-fixture-owner');
    await writeFile(join(dataDir, 'registry.lock'), 'untouched-fixture-registry');
  }
  const effects = { workers: 0, credentials: 0 };
  const manager = new ConnectionTasks({ dataDir,
    resolveCapabilities: async (id, _config, { access }) => ({ id, digest: 'a'.repeat(64), access,
      fileTools: id !== 'inference-only', tools: [], modules: [], skills: [] }),
    runner: async () => { effects.workers++; return { terminal: 'completed', cleanup: 'confirmed', text: '{}' }; },
  });
  const server = createServer({ manager, doctor: () => ({}), preflight: () => { effects.credentials++; } });
  const client = new Client({ name: 'submission-plan-test', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); await manager.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  return { workspace, dataDir, manager, effects, client, call,
    input: { requestId: 'preview-reused-for-submit', workspace, prompt: 'private-assignment-marker', executionMode: 'single-request', effort: 'low', maxTokens: 2048, timeoutMs: 60000 } };
}

test('preview exposes the exact single-request limits and warning without touching either lock or credentials', async t => {
  const f = await fixture(t, { locked: true });
  const result = await f.call('dsh_plan', f.input);
  assert.equal(result.kind, 'submission-plan');
  assert.equal(result.scope, 'new-task');
  assert.equal(result.execution.executionMode, 'single-request');
  assert.equal(result.execution.effort, 'low');
  assert.equal(result.limits.maxTokens, 2048);
  assert.equal(result.limits.maxModelRequests, 1);
  assert.equal(result.limits.maxToolCalls, 0);
  assert.equal(result.limits.timeoutMs, 60000);
  assert.equal(result.limitSources.maxTokens, 'caller');
  assert.equal(result.limitSources.maxModelRequests, 'mode');
  assert.equal(result.recovery.available, false);
  assert.equal(result.continuation.available, false);
  assert.match(result.warnings.join(' '), /cannot recover or retry/);
  assert.equal(result.checks.authorization, 'not_assessed');
  assert.equal(result.checks.admission, 'not_checked');
  assert.equal(result.validation.modelCalls, 0);
  assert.match(result.implementationConstraints.join(' '), /256000.*not verified provider hard maxima/);
  assert.match(result.implementationConstraints.join(' '), /30 seconds.*1 MiB/);
  assert.equal(JSON.stringify(result).includes('private-assignment-marker'), false);
  assert.equal(f.manager.manager, null);
  assert.deepEqual(f.effects, { workers: 0, credentials: 0 });
  assert.deepEqual((await readdir(f.dataDir)).sort(), ['owner.lock', 'registry.lock']);
  assert.equal(await readFile(join(f.dataDir, 'owner.lock'), 'utf8'), 'untouched-fixture-owner');
  assert.equal(await readFile(join(f.dataDir, 'registry.lock'), 'utf8'), 'untouched-fixture-registry');
  const nullLimits = await f.call('dsh_plan', { ...f.input, maxModelRequests: null, maxToolCalls: null });
  assert.equal(nullLimits.limits.maxModelRequests, 1);
  assert.equal(nullLimits.limitSources.maxModelRequests, 'mode');
  assert.equal(nullLimits.limitSources.maxToolCalls, 'mode');
  assert.equal(nullLimits.limitInputs.maxModelRequests, 'caller-unspecified');
  assert.equal(nullLimits.limitInputs.maxToolCalls, 'caller-unspecified');
  assert.equal(result.limitInputs.maxModelRequests, 'omitted');
  assert.equal(result.limitInputs.maxTokens, 'caller');
});

test('native preview reports unavailable requested components without exposing module settings', async t => {
  const f = await fixture(t);
  const result = await previewSubmission({ requestId: 'missing-teams', workspace: f.workspace, prompt: 'Task',
    access: 'workspace-write', nativePlugins: ['files', 'teams'] }, { dataDir: f.dataDir,
    resolveCapabilities: () => resolveProfile('native', { inventoryHome: join(f.workspace, 'empty-inventory') },
      { workspace: f.workspace, access: 'workspace-write', nativePlugins: ['files', 'teams'] }) });
  assert.deepEqual(result.capabilities.native.selected, ['files', 'teams']);
  const components = result.capabilities.native.components;
  assert.equal(components.find(c => c.capability === 'files').selected, true);
  assert.equal(components.find(c => c.capability === 'teams').selected, false);
  assert.match(components.find(c => c.capability === 'teams').reason, /not installed/);
  assert.match(result.warnings.join(' '), /teams is unavailable/);
  assert.equal(components.every(c => c.runtimeVerified === false), true);
  assert.equal(JSON.stringify(result).includes('managerCore'), false);
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
});

test('preview deadline returns safely while a late metadata rejection is observed', async t => {
  const f = await fixture(t);
  let rejectResolution;
  const stalled = previewSubmission(f.input, { dataDir: f.dataDir, previewTimeoutMs: 100,
    resolveCapabilities: () => new Promise((_, reject) => { rejectResolution = reject; }) });
  await assert.rejects(stalled, { code: 'PLAN_TIMEOUT' });
  assert.equal(typeof rejectResolution, 'function');
  rejectResolution(new Error('private-metadata-exception'));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
});

test('inapplicable nativePlugins is a field error before state access, even for empty selection', async t => {
  const f = await fixture(t, { locked: true });
  for (const nativePlugins of [[], ['files']]) for (const tool of ['dsh_plan', 'dsh_submit']) {
    const result = await f.call(tool, { ...f.input, nativePlugins });
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(result.error.validation.issues[0].path, ['nativePlugins']);
    assert.equal(result.error.validation.issues[0].code, 'native_profile_required');
    assert.match(result.error.message, /Omit this field/);
    assert.equal(JSON.stringify(result).includes('private-assignment-marker'), false);
  }
  const corrected = await f.call('dsh_plan', f.input);
  assert.equal(corrected.limits.maxModelRequests, 1);
  assert.equal(corrected.limits.maxToolCalls, 0);
  const native = await f.call('dsh_plan', { ...f.input, executionMode: 'automatic', nativePlugins: [] });
  assert.equal(native.execution.capabilityProfile, 'native');
  assert.deepEqual(f.effects, { workers: 0, credentials: 0 });
  assert.equal(f.manager.manager, null);
});

test('preview does not consume the request ID and matches new-task admission without restoring omitted limits', async t => {
  const f = await fixture(t);
  const input = { ...f.input, effort: undefined, maxTokens: null, executionMode: 'budgeted', workload: 'drafting', budget: { totalModelRequests: 7 } };
  const plan = await f.call('dsh_plan', input);
  assert.equal(plan.execution.effort, 'off');
  assert.equal(plan.limits.maxTokens, null);
  assert.equal(plan.limitSources.maxTokens, 'caller-unspecified');
  assert.equal(plan.limitSources.maxToolCalls, 'omitted');
  assert.equal(plan.limits.budget.totalOutputTokens, null);
  assert.equal(plan.limitSources['budget.totalModelRequests'], 'caller');
  assert.equal(plan.limitSources['budget.totalOutputTokens'], 'omitted');
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
  const admitted = await f.call('dsh_submit', { ...f.input, effort: 'off' });
  const singlePlan = await f.call('dsh_plan', { ...f.input, effort: 'off' });
  assert.equal(admitted.route.effort, singlePlan.execution.effort);
  assert.equal(admitted.maxTokensPerRequest, singlePlan.limits.maxTokens);
  assert.equal(admitted.timeoutMs, singlePlan.limits.timeoutMs);
  assert.equal(admitted.maxModelRequests, singlePlan.limits.maxModelRequests);
  assert.equal(admitted.maxToolCalls, singlePlan.limits.maxToolCalls);
  assert.equal(admitted.planning.executionMode, singlePlan.execution.executionMode);
  assert.equal(admitted.capabilityDigest, singlePlan.capabilities.digest);
  assert.notEqual(admitted.duplicate, true);
  await f.call('dsh_wait', { taskId: admitted.taskId, timeoutMs: 1000 });
  assert.deepEqual(f.effects, { workers: 1, credentials: 1 });
});

test('preview and submit share schema and safe contract rejection before state access', async t => {
  const f = await fixture(t, { locked: true });
  const tools = (await f.client.listTools()).tools;
  const preview = tools.find(tool => tool.name === 'dsh_plan');
  const submit = tools.find(tool => tool.name === 'dsh_submit');
  assert.deepEqual(preview.inputSchema, submit.inputSchema);
  assert.deepEqual(preview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const invalid = { ...f.input, maxTokens: 'private-invalid-value' };
  const fact = { id: 'F', kind: 'observation', value: 1, unit: '', source: 'private-source-marker' };
  for (const input of [invalid, { ...f.input, reportContract: { facts: [fact, fact] } }, { ...f.input, prompt: '界'.repeat(30000) }]) {
    const planned = await f.call('dsh_plan', input);
    const submitted = await f.call('dsh_submit', input);
    assert.equal(planned.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(planned.error, submitted.error);
    assert.equal(JSON.stringify(planned).includes('private-'), false);
  }
  const denied = await f.call('dsh_plan', { ...f.input, maxModelRequests: 2 });
  assert.equal(denied.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(f.effects, { workers: 0, credentials: 0 });
  assert.equal(f.manager.manager, null);
});

test('preview describes new requests without approving replay, semantics or unexecuted capabilities', async t => {
  const f = await fixture(t);
  const plan = await f.call('dsh_plan', { requestId: 'auto', workspace: f.workspace, prompt: 'Task' });
  assert.equal(plan.execution.executionMode, 'automatic');
  assert.equal(plan.execution.capabilityProfile, 'native');
  assert.equal(plan.limits.maxTokens, null);
  assert.equal(plan.limits.maxModelRequests, null);
  assert.equal(plan.continuation.available, true);
  assert.equal(plan.checks.replay, 'not_checked');
  assert.equal(plan.capabilities.runtimeVerified, false);
  assert.equal(plan.parentAcceptance, 'not_assessed');
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
});

test('preview and admission reject unrepresentable new deadlines before creating state or spending', async t => {
  const f = await fixture(t);
  for (const extra of [{ timeoutMs: Number.MAX_SAFE_INTEGER },
    { executionMode: 'budgeted', budget: { totalDurationMs: Number.MAX_SAFE_INTEGER } }]) {
    const input = { ...f.input, ...extra };
    const planned = await f.call('dsh_plan', input);
    const submitted = await f.call('dsh_submit', input);
    assert.equal(planned.error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(planned.error, submitted.error);
  }
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
  assert.deepEqual(f.effects, { workers: 0, credentials: 0 });
});

test('configured preview verifies pinned files without evaluating code or exposing module/skill contents', async t => {
  const f = await fixture(t);
  const modulePath = join(f.workspace, 'module.mjs');
  const skillPath = join(f.workspace, 'skill.md');
  const moduleText = 'throw new Error("private-module-executed");';
  const skillText = 'private-skill-contents';
  await writeFile(modulePath, moduleText);
  await writeFile(skillPath, skillText);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const config = { capabilityProfiles: [{ id: 'reviewed-custom', access: 'read-only', fileTools: false,
    modules: [{ path: modulePath, sha256: digest(moduleText), tools: ['custom_read'], config: { private: 'private-config-value' } }],
    skills: [{ path: skillPath, sha256: digest(skillText) }] }] };
  const result = await previewSubmission({ requestId: 'custom-plan', prompt: 'Task', workspace: f.workspace, capabilityProfile: 'reviewed-custom' },
    { dataDir: f.dataDir, resolveCapabilities: (id, _config, context) => resolveProfile(id, config, context) });
  assert.equal(result.capabilities.moduleCount, 1);
  assert.equal(result.capabilities.skillCount, 1);
  assert.deepEqual(result.capabilities.declaredTools, ['custom_read']);
  assert.ok(result.implementationConstraints.length > 0);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  await assert.rejects(access(f.dataDir), { code: 'ENOENT' });
});

test('production stdio previews with no API key and preserves existing protocol/lock bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-plan-stdio-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  await mkdir(workspace);
  await mkdir(state);
  const names = ['owner.lock', 'registry.lock', 'protocol.json'];
  for (const name of names) await writeFile(join(state, name), `private-state-${name}`);
  const env = workerEnvironment();
  delete env.DEEPSEEK_API_KEY;
  env.DSH_BRIDGE_DATA_DIR = state;
  env.DSH_BRIDGE_CONFIG_DIR = join(root, 'empty-config');
  const client = new Client({ name: 'plan-production-test', version: '1' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../index.js', import.meta.url))], env, stderr: 'pipe' });
  await client.connect(transport);
  transport.stderr?.resume();
  const result = await client.callTool({ name: 'dsh_plan', arguments: { requestId: 'production-plan', prompt: 'Synthetic prose',
    workspace, executionMode: 'single-request', workload: 'drafting', outputFormat: 'json-object' } });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.execution.effort, 'off');
  assert.equal(result.structuredContent.validation.modelCalls, 0);
  assert.equal(result.structuredContent.checks.credentials, 'not_checked');
  const native = await client.callTool({ name: 'dsh_plan', arguments: { requestId: 'native-plan', prompt: 'Synthetic read',
    workspace, nativePlugins: ['files'] } });
  assert.notEqual(native.isError, true);
  assert.equal(native.structuredContent.capabilities.id, 'native');
  assert.equal(native.structuredContent.capabilities.runtimeVerified, false);
  assert.ok(native.structuredContent.implementationConstraints.length > 0);
  for (const name of names) assert.equal(await readFile(join(state, name), 'utf8'), `private-state-${name}`);
  assert.deepEqual((await readdir(state)).sort(), names.sort());
});
