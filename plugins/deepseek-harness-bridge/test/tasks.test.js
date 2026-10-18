import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const manager = new TaskManager({ dataDir: join(root, 'state'), runner });
  await manager.open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, workspace, root };
}

test('a submitted task finishes with durable status and retrievable output', async t => {
  const { manager, workspace } = await fixture(t, async () => ({ terminal: 'completed', text: 'result', cleanup: 'confirmed' }));
  const submitted = await manager.submit({ requestId: 'request-1', prompt: 'Summarize the files.', workspace });
  assert.equal(submitted.status, 'running');
  const done = await manager.wait({ taskId: submitted.taskId, timeoutMs: 1000 });
  assert.equal(done.status, 'completed');
  assert.equal((await manager.result({ taskId: submitted.taskId })).text, 'result');
});

const completed = async () => ({ terminal: 'completed', text: 'result', cleanup: 'confirmed' });
const untilAborted = ({ signal }) => new Promise(resolve => {
  const done = () => resolve({ terminal: 'aborted', text: 'partial', cleanup: 'confirmed' });
  if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
});

test('concurrent duplicate submissions launch once; changed input conflicts and other tasks are busy', async t => {
  let launches = 0;
  const { manager, workspace } = await fixture(t, args => { launches++; return untilAborted(args); });
  const input = { requestId: 'idempotent-1', prompt: 'Task', workspace };
  const [first, duplicate] = await Promise.all([manager.submit(input), manager.submit(input)]);
  assert.equal(first.taskId, duplicate.taskId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(launches, 1);
  await assert.rejects(manager.submit({ ...input, prompt: 'Changed' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(manager.submit({ ...input, requestId: 'other' }), { code: 'BUSY' });
  assert.equal((await manager.cancel({ taskId: first.taskId })).status, 'cancelled');
  assert.equal((await manager.result({ taskId: first.taskId })).text, 'partial');
});

test('wall timeout stops and reaps the worker before publishing timed_out', async t => {
  const { manager, workspace } = await fixture(t, untilAborted);
  const task = await manager.submit({ requestId: 'timed', prompt: 'Task', workspace, timeoutMs: 1000 });
  const done = await manager.wait({ taskId: task.taskId, timeoutMs: 3000 });
  assert.equal(done.status, 'timed_out');
  assert.equal(done.cleanup, 'confirmed');
  await assert.rejects(manager.continue({ taskId: task.taskId, requestId: 'followup', prompt: 'More' }), { code: 'NOT_RESUMABLE' });
});

test('cleanup failure retains ownership and blocks later workers and restarts', async t => {
  const { manager, workspace, root } = await fixture(t, async () => ({ terminal: 'completed', text: 'result', cleanup: 'unverified' }));
  const task = await manager.submit({ requestId: 'unclean', prompt: 'Task', workspace });
  assert.equal((await manager.wait({ taskId: task.taskId, timeoutMs: 1000 })).status, 'cleanup_failed');
  await assert.rejects(manager.submit({ requestId: 'blocked', prompt: 'Task', workspace }), { code: 'RECOVERY_REQUIRED' });
  await manager.close();
  await access(join(root, 'state', 'owner.lock'));
  const next = new TaskManager({ dataDir: join(root, 'state'), runner: completed });
  await assert.rejects(next.open(), { code: 'STATE_LOCKED' });
});

test('completed records survive restart and continuation preserves session and old result', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  const input = { requestId: 'first', prompt: 'Task', workspace };
  const first = await manager.submit(input);
  await manager.wait({ taskId: first.taskId, timeoutMs: 1000 });
  await manager.close();
  let resumed;
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: async args => { resumed = args; return { terminal: 'completed', text: 'continued', cleanup: 'confirmed' }; } }).open();
  t.after(() => next.close());
  assert.equal((await next.submit(input)).duplicate, true);
  const second = await next.continue({ taskId: first.taskId, requestId: 'second', prompt: 'More' });
  await next.wait({ taskId: first.taskId, timeoutMs: 1000 });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(resumed.resume, true);
  assert.equal((await next.result({ taskId: first.taskId, attempt: 1 })).text, 'result');
  assert.equal((await next.result({ taskId: first.taskId, attempt: 2, offset: 1, limit: 3 })).text, 'ont');
  assert.equal(next.list().tasks.length, 1);
  await next.close();
});

test('state/workspace overlap and input limits reject before launching', async t => {
  let launches = 0;
  const { manager, workspace, root } = await fixture(t, async () => { launches++; return completed(); });
  const input = { requestId: 'invalid', prompt: 'Task', workspace };
  for (const overrides of [{ workspace: root }, { workspace: join(root, 'state') }, { prompt: '' }, { maxTokens: 32769 }, { maxToolCalls: 0 }, { effort: 'low' }, { timeoutMs: 1 }]) {
    await assert.rejects(manager.submit({ ...input, ...overrides }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(launches, 0);
});

test('noncompleted and oversized results are failed, not accepted', async t => {
  const { manager, workspace } = await fixture(t, async ({ prompt }) => ({ terminal: prompt === 'truncated' ? 'max-tokens' : 'completed', text: prompt === 'truncated' ? 'partial' : 'x'.repeat(1048577), cleanup: 'confirmed' }));
  for (const prompt of ['truncated', 'oversized']) {
    const task = await manager.submit({ requestId: prompt, prompt, workspace });
    const done = await manager.wait({ taskId: task.taskId, timeoutMs: 1000 });
    assert.equal(done.status, 'failed');
    assert.equal(done.parentAcceptance, 'not_assessed');
  }
});

test('incomplete saved execution is marked interrupted and cannot silently resume', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  const task = await manager.submit({ requestId: 'saved', prompt: 'Task', workspace });
  await manager.wait({ taskId: task.taskId, timeoutMs: 1000 });
  await manager.close();
  const path = join(root, 'state', 'tasks', task.taskId, 'task.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.attempts[0].status = 'running';
  record.attempts[0].cleanup = 'pending';
  await writeFile(path, JSON.stringify(record));
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: completed }).open();
  assert.equal(next.status({ taskId: task.taskId }).status, 'interrupted');
  await assert.rejects(next.submit({ requestId: 'other', prompt: 'Task', workspace }), { code: 'RECOVERY_REQUIRED' });
  await next.close();
});

for (const stage of ['saveResult', 'persist']) {
  test(`status stays running while terminal ${stage} is pending`, async t => {
    const { manager, workspace } = await fixture(t, completed);
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const original = manager[stage].bind(manager);
    manager[stage] = async (...args) => {
      if (stage === 'saveResult' || args[0].attempts.at(-1).status === 'completed') { entered(); await gate; }
      return original(...args);
    };
    const task = await manager.submit({ requestId: `publish-${stage}`, prompt: 'Task', workspace });
    await reached;
    try {
      assert.equal(manager.status({ taskId: task.taskId }).status, 'running');
      await assert.rejects(manager.result({ taskId: task.taskId }), { code: 'NOT_FINISHED' });
    } finally { release(); }
    await manager.wait({ taskId: task.taskId, timeoutMs: 1000 });
    assert.equal((await manager.result({ taskId: task.taskId })).text, 'result');
    assert.equal(manager.status({ taskId: task.taskId }).status, 'completed');
  });
}

test('recent-task recovery sorts execution timestamps rather than directory order', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  for (let index = 0; index < 51; index++) {
    const taskId = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 51 - index)).toISOString();
    const record = { schemaVersion: 1, taskId, sessionId: `session-${index}`, workspace,
      route: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' }, access: 'read-only', maxTokens: 256, maxToolCalls: 1, createdAt: startedAt,
      attempts: [{ number: 1, requestId: `request-${index}`, fingerprint: `hash-${index}`, status: 'completed', cleanup: 'confirmed', startedAt }] };
    await mkdir(join(root, 'state', 'tasks', taskId));
    await manager.persist(record);
  }
  await manager.close();
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: completed }).open();
  try {
    const tasks = next.list().tasks;
    assert.equal(tasks.length, 50);
    assert.equal(tasks[0].requestId, 'request-0');
    assert.ok(!tasks.some(task => task.requestId === 'request-50'));
  } finally { await next.close(); }
});
