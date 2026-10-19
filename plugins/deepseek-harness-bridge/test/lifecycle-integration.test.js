import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';

const source = JSON.parse(await readFile(new URL('./fixtures/lifecycle-failure.json', import.meta.url), 'utf8'));
const lifecycleContract = JSON.parse(await readFile(new URL('./fixtures/lifecycle-contract.json', import.meta.url), 'utf8'));

test('original lifecycle contradiction is rejected without rewriting runtime, raw output or single-request limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let calls = 0;
  const manager = await new TaskManager({ dataDir: join(root, 'state'),
    resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }), runner: async () => {
    calls++;
    return { terminal: 'completed', cleanup: 'confirmed', text: source.text, toolCalls: 0 };
  } }).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const task = await manager.submit({ workspace, requestId: 'original-lifecycle', prompt: JSON.stringify(source.assignment),
    executionMode: 'single-request', workload: 'mechanical', effort: 'off', maxTokens: 2048, timeoutMs: 60000,
    outputFormat: 'json-object', lifecycleContract });
  const done = await manager.wait({ taskId: task.taskId });
  assert.equal(done.lifecycleValidation?.status, 'mismatch');
  assert.ok(done.lifecycleValidation.issues.some(issue => issue.code === 'STATUS_NOT_ALLOWED' && issue.path === 'rows.S3.status'));
  assert.equal(done.status, 'completed');
  assert.equal(done.cleanup, 'confirmed');
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.parentAcceptance, 'not_assessed');
  assert.equal((await manager.result({ taskId: task.taskId })).text, source.text);
  await assert.rejects(manager.continue({ taskId: task.taskId, requestId: 'no-retry', prompt: 'Fix it' }), { code: 'NOT_RESUMABLE' });
  assert.equal(calls, 1);
});

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-state-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dataDir = join(root, 'state');
  const managers = [];
  const create = () => {
    const manager = new TaskManager({ dataDir, runner, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) });
    managers.push(manager);
    return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(root, { recursive: true, force: true }); });
  const manager = await create().open();
  return { dataDir, manager, create, input: { workspace, requestId: 'lifecycle-state', prompt: JSON.stringify(source.assignment),
    executionMode: 'single-request', lifecycleContract, effort: 'off', maxTokens: 2048 } };
}

test('lifecycle contract and mismatch survive reopen and affect idempotent request identity', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ prompt }) => {
    calls++;
    assert.match(prompt, /Lifecycle consistency contract/);
    return { terminal: 'completed', cleanup: 'confirmed', text: source.text };
  });
  const task = await f.manager.submit(f.input);
  await f.manager.wait({ taskId: task.taskId });
  await f.manager.close();
  const reopened = await f.create().open();
  const result = await reopened.result({ taskId: task.taskId });
  assert.deepEqual(result.lifecycleContract, lifecycleContract);
  assert.equal(result.lifecycleValidation.status, 'mismatch');
  assert.equal(result.text, source.text);
  assert.equal((await reopened.submit(f.input)).duplicate, true);
  const changed = structuredClone(lifecycleContract);
  changed.cases[2].allowedStatuses = ['closed'];
  await assert.rejects(reopened.submit({ ...f.input, lifecycleContract: changed }), { code: 'REQUEST_CONFLICT' });
  assert.equal(calls, 1);
});

test('invalid persisted lifecycle contract retains original record and ownership lock', async t => {
  const f = await fixture(t, async () => ({ terminal: 'completed', cleanup: 'confirmed', text: source.text }));
  const task = await f.manager.submit(f.input);
  await f.manager.wait({ taskId: task.taskId });
  await f.manager.close();
  const path = join(f.dataDir, 'tasks', task.taskId, 'task.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.lifecycleContract.cases[2].allowedStatuses = [];
  const bytes = JSON.stringify(saved);
  await writeFile(path, bytes);
  const reopened = f.create();
  await assert.rejects(reopened.open(), { code: 'INVALID_STATE' });
  assert.equal(reopened.records.size, 0);
  assert.equal(reopened.blocked, true);
  assert.equal(await readFile(path, 'utf8'), bytes);
  await access(join(f.dataDir, 'owner.lock'));
  await assert.rejects(f.create().open(), { code: 'STATE_LOCKED' });
});

test('budgeted content mismatch does not spend recovery allowance; explicit continuation retains the contract', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ task, prompt }) => {
    calls++;
    assert.deepEqual(task.lifecycleContract, lifecycleContract);
    assert.match(prompt, /summary string/);
    return { terminal: 'completed', cleanup: 'confirmed', text: JSON.stringify({ state: 'completed', summary: source.text, nextSteps: '' }), toolCalls: 0,
      budget: { nonce: task.stageBudget.nonce, modelRequests: 1, denied: null,
        calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: { outputTokens: 100 }, finished: true }] } };
  });
  const budget = { totalModelRequests: 5, totalOutputTokens: 16000, totalToolCalls: 0, totalDurationMs: 30000 };
  const task = await f.manager.submit({ ...f.input, executionMode: 'budgeted', budget, maxModelRequests: 2, capabilityProfile: 'inference-only' });
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.lifecycleValidation.status, 'mismatch');
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.orchestration.recoveries, 0);
  assert.equal(calls, 1);
  await f.manager.continue({ taskId: task.taskId, requestId: 'explicit-followup', prompt: 'Parent requests a bounded follow-up under the same declared expectations.' });
  const next = await f.manager.wait({ taskId: task.taskId });
  assert.equal(calls, 2);
  assert.deepEqual(next.lifecycleContract, lifecycleContract);
  assert.deepEqual(next.orchestration.authorized, budget);
  assert.equal(next.lifecycleValidation.status, 'mismatch');
  assert.equal(next.parentAcceptance, 'not_assessed');
  assert.equal(next.orchestration.recoveries, 0);
});
