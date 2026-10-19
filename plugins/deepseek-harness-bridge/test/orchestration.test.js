import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';

const authorization = { totalModelRequests: 6, totalOutputTokens: 3072, totalToolCalls: 4, totalDurationMs: 30000 };
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-orchestration-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const manager = await new TaskManager({ dataDir: join(root, 'state'), runner,
    resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const input = { requestId: 'planned', workspace, prompt: 'Maintain the assigned document.', maxTokens: 512, maxModelRequests: 2, maxToolCalls: 2, budget: authorization };
  return { root, manager, input };
}
function reply(task, state, summary = 'progress', nextSteps = 'continue', usage = 100) {
  return { terminal: 'completed', cleanup: 'confirmed', toolCalls: 0,
    text: JSON.stringify({ state, summary, nextSteps }),
    budget: { nonce: task.stageBudget?.nonce, modelRequests: 1, denied: null,
      calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: usage === null ? null : { outputTokens: usage }, finished: true }] } };
}

test('authorized task saves a checkpoint before autonomously allocating its next stage', async t => {
  const seen = [];
  const f = await fixture(t, async args => {
    seen.push(args);
    if (seen.length === 2) {
      const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', args.task.taskId, 'task.json'), 'utf8'));
      assert.equal(saved.orchestration.stages[0].status, 'checkpoint');
      assert.equal(JSON.parse(await readFile(saved.orchestration.lastCheckpoint.path, 'utf8')).summary, 'read file A');
      assert.match(args.prompt, /read file A/);
      assert.notEqual(args.task.sessionId, seen[0].task.sessionId);
    }
    return reply(args.task, seen.length === 1 ? 'checkpoint' : 'completed', seen.length === 1 ? 'read file A' : 'done');
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(seen.length, 2);
  assert.equal(done.status, 'completed');
  assert.equal(done.orchestration.charged.modelRequests, 2);
  assert.equal(done.orchestration.charged.outputTokens, 200);
  assert.equal(done.orchestration.remaining.modelRequests, 4);
  assert.equal((await f.manager.submit(f.input)).duplicate, true);
  assert.equal(seen.length, 2);
});

test('exhausted total pauses with durable progress and continuation cannot replenish it', async t => {
  let launches = 0;
  const f = await fixture(t, async ({ task }) => { launches++; return reply(task, 'checkpoint', `saved partial ${launches}`, 'more', null); });
  const first = await f.manager.submit({ ...f.input, budget: { ...authorization, totalModelRequests: 2, totalOutputTokens: 512 } });
  const done = await f.manager.wait({ taskId: first.taskId });
  assert.equal(done.status, 'paused');
  assert.equal(done.orchestration.charged.outputTokens, 512);
  assert.equal(done.pauseReason, 'TOTAL_BUDGET_EXHAUSTED');
  assert.match((await f.manager.result({ taskId: first.taskId })).text, /saved partial/);
  await assert.rejects(f.manager.continue({ taskId: first.taskId, requestId: 'no-refill', prompt: 'continue' }), { code: 'TOTAL_BUDGET_EXHAUSTED' });
  assert.equal(launches, 2);
});

test('malformed checkpoint, cleanup failure and repeated progress never loop automatically', async t => {
  for (const mode of ['malformed', 'cleanup', 'stalled']) {
    let launches = 0;
    const f = await fixture(t, async ({ task }) => {
      launches++;
      const output = reply(task, 'checkpoint');
      if (mode === 'malformed') output.text = 'not a checkpoint';
      if (mode === 'cleanup') output.cleanup = 'unverified';
      return output;
    });
    const task = await f.manager.submit(f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(launches, mode === 'stalled' ? 2 : 1);
    assert.equal(done.status, mode === 'cleanup' ? 'cleanup_failed' : mode === 'stalled' ? 'paused' : 'failed');
    if (mode === 'stalled') assert.equal(done.pauseReason, 'NO_PROGRESS');
  }
});

test('an interrupted stage reserves its allocation before launch and cancellation starts no next stage', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, ({ signal, task }) => new Promise(resolve => {
    started(task);
    signal.addEventListener('abort', () => resolve({ terminal: 'aborted', cleanup: 'confirmed', text: 'partial', toolCalls: 0, budget: null }), { once: true });
  }));
  const task = await f.manager.submit(f.input);
  const runningTask = await ready;
  assert.ok(runningTask.stageBudget);
  const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', task.taskId, 'task.json'), 'utf8'));
  assert.equal(saved.orchestration.stages[0].charged.modelRequests, 2);
  const done = await f.manager.cancel({ taskId: task.taskId });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.orchestration.stages, 1);
  assert.equal(done.orchestration.charged.modelRequests, 2);
});

test('identical checkpoint fields with different JSON key order pause without consuming further stages', async t => {
  let launches = 0;
  const f = await fixture(t, async ({ task }) => {
    const output = reply(task, 'checkpoint', 'same progress', 'same next step');
    if (++launches % 2 === 0) output.text = JSON.stringify({ summary: 'same progress', nextSteps: 'same next step', state: 'checkpoint' });
    return output;
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'paused');
  assert.equal(done.pauseReason, 'NO_PROGRESS');
  assert.equal(launches, 2);
  assert.equal(done.orchestration.charged.modelRequests, 2);
});

test('restart and manual continuation preserve totals, deadline and authorization fingerprint', async t => {
  let launches = 0;
  const runner = async ({ task }) => { launches++; return reply(task, 'completed', 'done', ''); };
  const f = await fixture(t, runner);
  const submitted = await f.manager.submit(f.input);
  const first = await f.manager.wait({ taskId: submitted.taskId });
  await f.manager.close();
  const next = await new TaskManager({ dataDir: join(f.root, 'state'), runner,
    resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
  t.after(() => next.close());
  assert.equal((await next.submit(f.input)).duplicate, true);
  await assert.rejects(next.submit({ ...f.input, budget: { ...authorization, totalModelRequests: 8 } }), { code: 'REQUEST_CONFLICT' });
  await next.continue({ taskId: submitted.taskId, requestId: 'follow-up', prompt: 'Review the saved result.' });
  const second = await next.wait({ taskId: submitted.taskId });
  assert.equal(launches, 2);
  assert.equal(second.orchestration.charged.modelRequests, 2);
  assert.equal(second.orchestration.deadlineAt, first.orchestration.deadlineAt);
  assert.deepEqual(second.orchestration.authorized, authorization);
  await next.close();
});

test('failed checkpoint publication keeps ownership and starts no further work', async t => {
  let launches = 0;
  const f = await fixture(t, async ({ task }) => { launches++; return reply(task, 'checkpoint'); });
  const persist = f.manager.persist.bind(f.manager);
  f.manager.persist = async record => {
    if (record.orchestration.lastCheckpoint) throw new Error('disk write failed');
    await persist(record);
  };
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'state_write_failed');
  assert.equal(launches, 1);
  assert.equal(f.manager.blocked, true);
  const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', task.taskId, 'task.json'), 'utf8'));
  assert.equal(saved.orchestration.stages[0].charged.modelRequests, 2);
  assert.equal(JSON.parse(await readFile(join(f.root, 'state', 'tasks', task.taskId, 'checkpoint-1.json'), 'utf8')).state, 'checkpoint');
});

test('invalid usage receipts keep the full reservation and never auto-retry', async t => {
  for (const change of [output => { output.budget = null; }, output => { output.budget.nonce = 'stale'; }, output => { output.budget.calls[0].usage.outputTokens = 513; }]) {
    let launches = 0;
    const f = await fixture(t, async ({ task }) => { launches++; const output = reply(task, 'checkpoint'); change(output); return output; });
    const task = await f.manager.submit(f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(done.status, 'failed');
    assert.equal(done.orchestration.charged.modelRequests, 2);
    assert.equal(done.orchestration.charged.outputTokens, 1024);
    assert.equal(launches, 1);
  }
});

test('invalid total authorization is rejected without launching a worker', async t => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; });
  for (const overrides of [{ budget: [] }, { budget: { totalModelRequests: 0 } }, { budget: { totalOutputTokens: -1 } }, { budget: { ...authorization, extra: true } }, { maxModelRequests: 0 }]) {
    await assert.rejects(f.manager.submit({ ...f.input, ...overrides }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(launches, 0);
});

test('truncation saves partial evidence before one tool-free recovery charged to the original total', async t => {
  const seen = [];
  const f = await fixture(t, async args => {
    seen.push(args);
    if (seen.length === 1) return { ...reply(args.task, 'completed', 'unused'), terminal: 'max-tokens', text: '{"rows":[1,2',
      output: { kind: 'partial_text', modelTruncated: true }, error: { code: 'OUTPUT_TRUNCATED', message: 'bounded fixture' } };
    if (seen.length > 2) return reply(args.task, 'completed', 'Reviewed result', '');
    const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', args.task.taskId, 'partial-1.json'), 'utf8'));
    assert.equal(saved.text, '{"rows":[1,2');
    assert.equal(args.task.route.effort, 'off');
    assert.equal(args.task.maxModelRequests, 1);
    assert.equal(args.task.maxToolCalls, 0);
    assert.equal(args.task.stageBudget.forcedCheckpoint, true);
    assert.equal(args.resume, false);
    assert.match(args.prompt, /NOT a completed result/);
    return reply(args.task, 'completed', 'Recovered from visible evidence', '');
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.equal(done.orchestration.charged.modelRequests, 2);
  assert.equal(done.orchestration.charged.outputTokens, 200);
  assert.equal(done.orchestration.truncationRecoveries, 1);
  assert.equal(done.recovery.status, 'completed');
  assert.equal(seen.length, 2);
  const followup = { taskId: task.taskId, requestId: 'recovered-followup', prompt: 'Review the result' };
  await f.manager.continue(followup);
  await f.manager.wait({ taskId: task.taskId });
  assert.equal((await f.manager.continue(followup)).duplicate, true);
});

test('exhaustion, uncertain accounting, failed cleanup and repeated truncation never refill or loop', async t => {
  for (const mode of ['exhausted', 'unknown', 'cleanup', 'twice']) {
    let launches = 0;
    const f = await fixture(t, async ({ task }) => {
      launches++;
      const result = { ...reply(task, 'completed', 'unused', '', mode === 'exhausted' ? null : 100), terminal: 'max-tokens', text: '{"partial":',
        error: { code: 'OUTPUT_TRUNCATED', message: 'bounded fixture' } };
      if (mode === 'exhausted') {
        result.budget.modelRequests = 2;
        result.budget.calls.push({ ...result.budget.calls[0], number: 2 });
      }
      if (mode === 'unknown') result.budget = null;
      if (mode === 'cleanup') result.cleanup = 'unverified';
      return result;
    });
    const task = await f.manager.submit(mode === 'exhausted' ? { ...f.input, budget: { ...authorization, totalModelRequests: 2, totalOutputTokens: 1024 } } : f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(launches, mode === 'twice' ? 2 : 1);
    assert.equal(done.status, mode === 'cleanup' ? 'cleanup_failed' : 'failed');
    assert.equal(done.terminal, 'max-tokens');
    assert.ok(done.orchestration.charged.outputTokens <= done.orchestration.authorized.totalOutputTokens);
    assert.equal((await f.manager.result({ taskId: task.taskId })).text, '{"partial":');
  }
});

test('failed continuation publication preserves prior completed work and consumes no request', async t => {
  let launches = 0;
  const f = await fixture(t, async ({ task }) => { launches++; return reply(task, 'completed', 'done', ''); });
  const first = await f.manager.submit(f.input);
  await f.manager.wait({ taskId: first.taskId });
  f.manager.persist = async () => { throw new Error('offline disk failure'); };
  await assert.rejects(f.manager.continue({ taskId: first.taskId, requestId: 'unsaved', prompt: 'more' }), { code: 'STATE_WRITE_FAILED' });
  assert.equal(f.manager.status({ taskId: first.taskId }).status, 'completed');
  assert.equal(f.manager.status({ taskId: first.taskId }).number, 1);
  assert.equal(launches, 1);
  assert.equal(f.manager.requests.has('unsaved'), false);
});

test('clipped partial context is labeled for recovery and failed publication starts no recovery', async t => {
  for (const failPublication of [false, true]) {
    let launches = 0;
    const partialText = 'visible'.repeat(3000) + 'tail-marker';
    const f = await fixture(t, async ({ task, prompt }) => {
      if (++launches === 1) return { ...reply(task, 'completed', 'unused'), terminal: 'max-tokens', text: partialText,
        output: { kind: 'partial_text', modelTruncated: true }, error: { code: 'OUTPUT_TRUNCATED' } };
      assert.match(prompt, /"contextTruncated":true/);
      assert.match(prompt, /partial-1\.json/);
      assert.match(prompt, /"kind":"partial_text"/);
      assert.ok(!prompt.includes('tail-marker'));
      return reply(task, 'completed', 'Regenerated result', '');
    });
    if (failPublication) {
      const persist = f.manager.persist.bind(f.manager);
      f.manager.persist = async record => { if (record.orchestration.lastPartial) throw new Error('disk failed'); await persist(record); };
    }
    const task = await f.manager.submit(f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(done.status, failPublication ? 'state_write_failed' : 'completed');
    assert.equal(launches, failPublication ? 1 : 2);
    assert.equal(f.manager.blocked, failPublication);
    const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', task.taskId, 'partial-1.json'), 'utf8'));
    assert.equal(saved.text, partialText);
  }
});

test('corrupt persisted spending cannot increase authorization after restart', async t => {
  let launches = 0;
  const runner = async ({ task }) => { launches++; return reply(task, 'completed', 'done', ''); };
  const f = await fixture(t, runner);
  const submitted = await f.manager.submit(f.input);
  await f.manager.wait({ taskId: submitted.taskId });
  await f.manager.close();
  const path = join(f.root, 'state', 'tasks', submitted.taskId, 'task.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.orchestration.stages[0].charged.modelRequests = -1;
  await writeFile(path, JSON.stringify(record));
  const next = new TaskManager({ dataDir: join(f.root, 'state'), runner });
  await assert.rejects(next.open(), { code: 'INVALID_STATE' });
  assert.equal(launches, 1);
  assert.ok(await readFile(join(f.root, 'state', 'owner.lock'), 'utf8'));
});
