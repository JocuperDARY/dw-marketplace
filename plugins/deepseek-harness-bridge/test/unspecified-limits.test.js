import test from 'node:test';
import assert from 'node:assert/strict';
import { planExecution } from '../src/planning.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';
import { deadlineTimer } from '../src/limits.js';
import { runOrchestrated, validateSavedBudget } from '../src/orchestration.js';

test('omitted resources are unspecified instead of agent-created spending caps', () => {
  const plan = planExecution({});
  assert.equal(plan.executionMode, 'automatic');
  for (const key of ['maxTokens', 'maxModelRequests', 'maxToolCalls']) assert.equal(plan[key], null, key);
  assert.equal(plan.budget, null);
  assert.equal(plan.capabilityProfile, 'native');
});

test('explicit single-request retains its one-call/no-tools boundary without inventing an output cap', () => {
  const plan = planExecution({ executionMode: 'single-request' });
  assert.equal(plan.maxTokens, null);
  assert.equal(plan.maxModelRequests, 1);
  assert.equal(plan.maxToolCalls, 0);
  assert.equal(plan.capabilityProfile, 'inference-only');
  assert.throws(() => planExecution({ executionMode: 'single-request', maxModelRequests: 2 }));
});

test('partial explicit totals leave other totals unspecified and preserve explicit request caps', () => {
  const plan = planExecution({ maxTokens: 8192, budget: { totalOutputTokens: 24000 } });
  assert.equal(plan.maxTokens, 8192);
  assert.deepEqual(plan.budget, { totalModelRequests: null, totalOutputTokens: 24000, totalToolCalls: null, totalDurationMs: null });
  assert.equal(plan.maxModelRequests, null);
});

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'unspecified-limits-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const options = { dataDir: join(root, 'data'), runner, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) };
  const manager = await new TaskManager(options).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, options, manager };
}

test('unspecified limits survive persistence, replay and more than sixteen authorized continuations', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ task }) => {
    calls++;
    for (const key of ['maxTokens', 'maxToolCalls', 'maxModelRequests', 'maxRequestBytes']) assert.equal(task[key], null);
    assert.equal(task.attempts.at(-1).timeoutMs, null);
    return { terminal: 'completed', cleanup: 'confirmed', text: 'fixture' };
  });
  const input = { requestId: 'omitted', prompt: 'Task', workspace: f.workspace };
  const task = await f.manager.submit(input);
  await f.manager.wait({ taskId: task.taskId });
  assert.equal((await f.manager.submit(input)).duplicate, true);
  for (let i = 0; i < 17; i++) {
    await f.manager.continue({ taskId: task.taskId, requestId: `follow-${i}`, prompt: 'Continue the fixture.' });
    await f.manager.wait({ taskId: task.taskId });
  }
  assert.equal(calls, 18);
  await f.manager.close();
  const next = await new TaskManager(f.options).open();
  try { assert.equal((await next.status({ taskId: task.taskId })).number, 18); }
  finally { await next.close(); }
});

test('v1 replay keeps its original finite defaults without relaxing existing authorization', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { terminal: 'completed', cleanup: 'confirmed', text: 'fixture' }; });
  const original = { requestId: 'legacy-v1', prompt: 'Task', workspace: f.workspace, executionMode: 'single-request', workload: 'standard' };
  const task = await f.manager.submit({ ...original, maxTokens: 8192, maxRequestBytes: 262144, timeoutMs: 300000 });
  await f.manager.wait({ taskId: task.taskId });
  await f.manager.close();
  const registry = JSON.parse(await readFile(join(f.root, 'data', 'registry.json'), 'utf8'));
  const path = join(f.root, 'data', ...registry.tasks[task.taskId].snapshot.split('/'));
  const saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.planning.limitsPolicy;
  await writeFile(path, JSON.stringify(saved));
  const next = await new TaskManager(f.options).open();
  try { assert.equal((await next.submit(original)).duplicate, true); assert.equal(calls, 1); }
  finally { await next.close(); }
});

test('replaying an earlier continuation remains idempotent after a later timeout is narrowed and restarted', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { terminal: 'completed', cleanup: 'confirmed', text: 'fixture' }; });
  const first = await f.manager.submit({ requestId: 'replay-start', prompt: 'Task', workspace: f.workspace });
  await f.manager.wait({ taskId: first.taskId });
  const continuation = { taskId: first.taskId, requestId: 'replay-followup', prompt: 'Follow up.', timeoutMs: 60000 };
  await f.manager.continue(continuation); await f.manager.wait({ taskId: first.taskId });
  await f.manager.continue({ taskId: first.taskId, requestId: 'narrowed', prompt: 'Further follow up.', timeoutMs: 30000 });
  await f.manager.wait({ taskId: first.taskId });
  assert.equal((await f.manager.continue(continuation)).duplicate, true);
  await f.manager.close();
  const next = await new TaskManager(f.options).open();
  try {
    const replay = await next.continue({ ...continuation, controlToken: first.controlToken });
    assert.equal(replay.duplicate, true); assert.equal(replay.timeoutMs, 60000); assert.equal(calls, 3);
    await assert.rejects(next.continue({ ...continuation, prompt: 'changed', controlToken: first.controlToken }), { code: 'REQUEST_CONFLICT' });
  } finally { await next.close(); }
});

test('partial totals persist without inventing request, tool or time totals', async t => {
  const f = await fixture(t, async ({ task }) => ({ terminal: 'completed', cleanup: 'confirmed', toolCalls: 0,
    text: JSON.stringify({ state: 'completed', summary: 'done', nextSteps: '' }),
    budget: { nonce: task.stageBudget.nonce, modelRequests: 1, calls: [{ number: 1, reservedOutputTokens: task.maxTokens, finished: true, usage: { outputTokens: 100 } }] },
  }));
  const task = await f.manager.submit({ requestId: 'partial', prompt: 'Task', workspace: f.workspace, budget: { totalOutputTokens: 20000 } });
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.equal(done.orchestration.deadlineAt, null);
  assert.deepEqual(done.orchestration.remaining, { modelRequests: null, outputTokens: 19900, toolCalls: null, durationMs: null });
  await f.manager.close();
  const next = await new TaskManager(f.options).open();
  try { assert.equal((await next.status({ taskId: task.taskId })).orchestration.remaining.outputTokens, 19900); }
  finally { await next.close(); }
});

test('large explicit timer is not converted by Node into an immediate timeout', async () => {
  let fired = false;
  const cancel = deadlineTimer(() => { fired = true; }, 2147483648);
  try { await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(fired, false); }
  finally { cancel(); }
});

test('durable progress can extend beyond the former 1040-stage ceiling without fake unlimited numbers', async () => {
  const record = { taskId: 'chain', createdAt: new Date().toISOString(), maxTokens: null, maxModelRequests: null, maxToolCalls: null,
    route: { effort: 'off' }, planning: { executionMode: 'budgeted', limitsPolicy: 'explicit-v2' },
    orchestration: { authorized: { totalModelRequests: null, totalOutputTokens: null, totalToolCalls: null, totalDurationMs: null },
      assignment: 'Process a finite sequence of useful pages.', deadlineAt: null, stages: [], recoveryPolicy: 'bounded-v1' } };
  const persisted = [];
  let checkpointWrites = 0;
  let calls = 0;
  const result = await runOrchestrated({ record, attempt: { number: 1, timeoutMs: null }, prompt: '', signal: new AbortController().signal,
    home: 'unused-offline', persist: async () => { persisted.push(record.orchestration.stages.at(-1)?.status); },
    saveCheckpoint: async number => { checkpointWrites++; return `checkpoint-${number}.json`; }, savePartial: async () => assert.fail('no failures expected'),
    runner: async ({ task, prompt }) => {
      calls++;
      if (calls > 1) { assert.equal(checkpointWrites, calls - 1); assert.ok(prompt.includes(`page ${calls - 1}`)); }
      assert.equal(task.maxModelRequests, null); assert.equal(task.stageBudget.maxOutputTokens, null);
      return { terminal: 'completed', cleanup: 'confirmed', toolCalls: 0,
        text: JSON.stringify({ state: calls === 1042 ? 'completed' : 'checkpoint', summary: `page ${calls}`, nextSteps: 'next page' }),
        budget: { nonce: task.stageBudget.nonce, modelRequests: 1, calls: [{ number: 1, reservedOutputTokens: null, finished: true, usage: { outputTokens: 10 } }] } };
    } });
  assert.equal(result.terminal, 'completed'); assert.equal(calls, 1042); assert.equal(checkpointWrites, 1042);
  assert.equal(record.orchestration.deadlineAt, null); assert.ok(persisted.includes('checkpoint'));
  validateSavedBudget(record);
});
