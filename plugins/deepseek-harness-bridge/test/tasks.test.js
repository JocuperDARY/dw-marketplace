import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/tasks.js';
import { contract, correct, wrongDraft } from './fixtures/verification-data.js';

test('completed incorrect drafts retain evidence and never become parent-accepted or auto-retried', async t => {
  let launches = 0;
  const wrong = wrongDraft();
  const { manager, workspace, root } = await fixture(t, async ({ prompt, task }) => {
    launches++;
    assert.match(prompt, /Verification delivery contract/);
    assert.equal(task.route.effort, 'high');
    return { terminal: 'completed', text: JSON.stringify(wrong), cleanup: 'confirmed', toolCalls: 0 };
  });
  const input = { executionMode: 'single-request', requestId: 'quality', prompt: 'Classify the supplied paths using labeled rules.', workspace, reviewContract: contract };
  const submitted = await manager.submit(input);
  await manager.wait({ taskId: submitted.taskId });
  const result = await manager.result({ taskId: submitted.taskId });
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup, 'confirmed');
  assert.equal(result.deliveryValidation.status, 'incomplete');
  assert.equal(result.parentAcceptance, 'not_assessed');
  assert.deepEqual(JSON.parse(result.text), wrong);
  assert.equal(launches, 1);
  await manager.close();
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: () => { throw new Error('Replay launched'); }, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
  t.after(() => next.close());
  const replay = await next.submit(input);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.reviewContract, contract);
  assert.equal(replay.deliveryValidation.status, 'incomplete');
  await assert.rejects(next.submit({ ...input, reviewContract: { ...contract, checkIds: [] } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(next.continue({ taskId: submitted.taskId, requestId: 'retry', prompt: 'repair' }), { code: 'NOT_RESUMABLE' });
  await next.close();
});

test('budgeted verification preserves the contract and total ledger across stages and continuation', async t => {
  let calls = 0;
  const { manager, workspace } = await fixture(t, async ({ task, prompt }) => {
    calls++;
    assert.match(prompt, /summary string/);
    const state = calls === 1 ? 'checkpoint' : 'completed';
    return { terminal: 'completed', text: JSON.stringify({ state, summary: state === 'checkpoint' ? 'partial progress' : JSON.stringify(correct), nextSteps: state === 'checkpoint' ? 'finish all cases' : '' }), cleanup: 'confirmed', toolCalls: 0,
      budget: { nonce: task.stageBudget.nonce, modelRequests: 1, calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: { outputTokens: 100 }, finished: true }] } };
  });
  const first = await manager.submit({ requestId: 'verification-stages', prompt: 'Labeled rules and cases.', workspace, reviewContract: contract, capabilityProfile: 'inference-only', maxModelRequests: 2,
    budget: { totalModelRequests: 6, totalOutputTokens: 32768, totalToolCalls: 0, totalDurationMs: 60000 } });
  const done = await manager.wait({ taskId: first.taskId });
  assert.equal(done.deliveryValidation.status, 'structure_complete');
  assert.equal(done.parentAcceptance, 'not_assessed');
  assert.equal(done.orchestration.charged.modelRequests, 2);
  await manager.continue({ taskId: first.taskId, requestId: 'verification-followup', prompt: 'Recheck the same cases without adding scope.' });
  const continued = await manager.wait({ taskId: first.taskId });
  assert.equal(continued.orchestration.charged.modelRequests, 3);
  assert.equal(continued.orchestration.deadlineAt, done.orchestration.deadlineAt);
  assert.equal(continued.deliveryValidation.status, 'structure_complete');
  assert.equal(continued.parentAcceptance, 'not_assessed');
});

async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const manager = new TaskManager({ dataDir: join(root, 'state'), runner, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) });
  await manager.open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, workspace, root };
}

test('a submitted task finishes with durable status and retrievable output', async t => {
  const { manager, workspace } = await fixture(t, async () => ({ terminal: 'completed', text: 'result', cleanup: 'confirmed' }));
  const submitted = await manager.submit({ executionMode: 'single-request', requestId: 'request-1', prompt: 'Summarize the files.', workspace });
  assert.equal(submitted.status, 'running');
  const done = await manager.wait({ taskId: submitted.taskId, timeoutMs: 1000 });
  assert.equal(done.status, 'completed');
  assert.equal((await manager.result({ taskId: submitted.taskId })).text, 'result');
});

const completed = async () => ({ terminal: 'completed', text: 'result', cleanup: 'confirmed' });

test('report contract persists through replay and rejects changed roles without retrying', async t => {
  const reportContract = { facts: [{ id: 'seconds', kind: 'limit', value: 180, unit: 's', source: 'plan.json:limits.seconds' }] };
  let launches = 0;
  const { manager, workspace, root } = await fixture(t, async ({ task, prompt }) => {
    launches++;
    assert.match(prompt, /never measured/);
    assert.equal(task.route.effort, 'off');
    return { terminal: 'completed', cleanup: 'confirmed', text: JSON.stringify({ facts: [{ ...reportContract.facts[0], kind: 'observation' }], prose: 'Measured 180 seconds.' }),
      budget: { modelRequests: 1, calls: [{ number: 1, finished: true, usage: { inputTokens: 542, outputTokens: 414, totalTokens: 956 } }] } };
  });
  const input = { executionMode: 'single-request', requestId: 'report', workspace, prompt: 'Report the limit without claiming measured time.', reportContract };
  const task = await manager.submit(input);
  const done = await manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.reportValidation.status, 'mismatch');
  assert.equal(done.parentAcceptance, 'not_assessed');
  assert.equal(manager.usage({ taskId: task.taskId }).tokens.totalTokens.reported, 956);
  await manager.close();
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: () => { throw new Error('must not launch'); }, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
  t.after(() => next.close());
  const replay = await next.submit(input);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reportValidation.status, 'mismatch');
  assert.deepEqual(replay.reportContract, reportContract);
  await assert.rejects(next.submit({ ...input, reportContract: { facts: [{ ...reportContract.facts[0], value: 200 }] } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(next.continue({ taskId: task.taskId, requestId: 'repair-report', prompt: 'repair' }), { code: 'NOT_RESUMABLE' });
  assert.equal(next.usage().tokens.totalTokens.reported, 956);
  assert.equal(launches, 1);
  await next.close();
});

test('report facts and each stage receipt survive continuation and restart without tail double counting', async t => {
  const reportContract = { facts: [{ id: 'tests', kind: 'execution-status', value: 'NOT_RUN', unit: '', source: 'stage.json:tests' }] };
  let launches = 0;
  const { manager, workspace, root } = await fixture(t, async ({ task, prompt }) => {
    launches++;
    assert.match(prompt, /NOT_RUN/);
    const state = launches === 1 ? 'checkpoint' : 'completed';
    const report = { ...reportContract, prose: 'Tests have not run.' };
    return { terminal: 'completed', cleanup: 'confirmed', toolCalls: 0,
      text: JSON.stringify({ state, summary: state === 'checkpoint' ? 'Need final report.' : JSON.stringify(report), nextSteps: state === 'checkpoint' ? 'write report' : '' }),
      budget: { nonce: task.stageBudget.nonce, modelRequests: 1, calls: [{ number: 1, reservedOutputTokens: task.maxTokens, finished: true, usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 } }] } };
  });
  const task = await manager.submit({ requestId: 'report-stages', workspace, prompt: 'Report supplied execution status.', reportContract,
    capabilityProfile: 'inference-only', maxModelRequests: 2, budget: { totalModelRequests: 6, totalOutputTokens: 16384, totalToolCalls: 0, totalDurationMs: 60000 } });
  await manager.wait({ taskId: task.taskId });
  await manager.continue({ taskId: task.taskId, requestId: 'report-followup', prompt: 'Recheck against unchanged facts.' });
  const done = await manager.wait({ taskId: task.taskId });
  assert.equal(done.reportValidation.status, 'facts_preserved');
  assert.equal(done.reportValidation.proseAcceptance, 'not_assessed');
  assert.equal(manager.usage().recordedModelRequests, 3);
  assert.equal(manager.usage().tokens.totalTokens.reported, 150);
  await manager.close();
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: completed }).open();
  t.after(() => next.close());
  assert.equal(next.usage().recordedModelRequests, 3);
  assert.equal(next.usage().unknownReceiptGroups, 0);
  assert.equal(next.record(task.taskId).orchestration.stages.length, 3);
  assert.ok(next.record(task.taskId).orchestration.stages.every(stage => stage.budget.calls.length === 1));
  await next.close();
});
const untilAborted = ({ signal }) => new Promise(resolve => {
  const done = () => resolve({ terminal: 'aborted', text: 'partial', cleanup: 'confirmed' });
  if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
});

test('first-save failure does not publish a phantom task or request', async t => {
  let launches = 0;
  const { manager, workspace } = await fixture(t, async () => { launches++; return completed(); });
  manager.persist = async () => { throw new Error('offline disk failure'); };
  const input = { executionMode: 'single-request', requestId: 'disk-failure', prompt: 'task', workspace };
  await assert.rejects(manager.submit(input), { code: 'STATE_WRITE_FAILED' });
  assert.equal(launches, 0);
  assert.equal(manager.records.size, 0);
  assert.equal(manager.requests.size, 0);
  assert.deepEqual(await readdir(manager.tasksDir), []);
  await assert.rejects(manager.submit(input), { code: 'RECOVERY_REQUIRED' });
});

test('single-request authorization cannot be continued or refilled', async t => {
  const { manager, workspace } = await fixture(t, completed);
  const task = await manager.submit({ executionMode: 'single-request', requestId: 'saved', prompt: 'task', workspace });
  await manager.wait({ taskId: task.taskId });
  await assert.rejects(manager.continue({ taskId: task.taskId, requestId: 'unsaved', prompt: 'more' }), { code: 'NOT_RESUMABLE' });
  assert.equal(manager.status({ taskId: task.taskId }).number, 1);
  assert.equal(manager.status({ taskId: task.taskId }).status, 'completed');
  assert.equal(manager.requests.has('unsaved'), false);
});

test('startup removes only an empty unpublished task directory', async t => {
  const { manager, root } = await fixture(t, completed);
  await manager.close();
  const orphan = join(root, 'state', 'tasks', '00000000-0000-0000-0000-000000000000');
  await mkdir(orphan);
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: completed }).open();
  assert.equal(next.list().total, 0);
  await next.close();
  await mkdir(orphan);
  await writeFile(join(orphan, 'unknown'), 'preserve');
  const blocked = new TaskManager({ dataDir: join(root, 'state'), runner: completed });
  await assert.rejects(blocked.open(), { code: 'INVALID_STATE' });
  assert.equal(await readFile(join(orphan, 'unknown'), 'utf8'), 'preserve');
});

test('startup rejects malformed saved attempts before registration and retains the original state', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  const task = await manager.submit({ executionMode: 'single-request', requestId: 'valid', prompt: 'fixture', workspace });
  await manager.wait({ taskId: task.taskId });
  const valid = structuredClone(manager.record(task.taskId));
  await manager.close();
  const invalid = [
    ['empty', []], ['non-array', {}], ['null-element', [null]], ['missing-fields', [{}]],
    ...['number', 'requestId', 'fingerprint', 'startedAt', 'status', 'cleanup'].map(key => {
      const attempt = { ...valid.attempts[0] };
      delete attempt[key];
      return [`missing-${key}`, [attempt]];
    }),
    ['wrong-number', [{ ...valid.attempts[0], number: 2 }]],
    ['invalid-request', [{ ...valid.attempts[0], requestId: 'with spaces' }]],
    ['invalid-fingerprint', [{ ...valid.attempts[0], fingerprint: 'bad' }]],
    ['invalid-date', [{ ...valid.attempts[0], startedAt: 'not-a-date' }]],
    ['unknown-status', [{ ...valid.attempts[0], status: 'accepted' }]],
    ['unknown-cleanup', [{ ...valid.attempts[0], cleanup: 'unknown' }]],
    ['too-many', Array.from({ length: 17 }, (_, index) => ({ ...valid.attempts[0], number: index + 1, requestId: `request-${index}` }))],
    ['duplicate-request', [valid.attempts[0], { ...valid.attempts[0], number: 2 }]],
  ];
  for (const [name, attempts] of invalid) await t.test(name, async () => {
    const dataDir = join(root, name);
    const path = join(dataDir, 'tasks', task.taskId, 'task.json');
    await mkdir(join(dataDir, 'tasks', task.taskId), { recursive: true });
    const saved = JSON.stringify({ ...valid, attempts });
    await writeFile(path, saved);
    let launches = 0;
    const next = new TaskManager({ dataDir, runner: () => { launches++; throw new Error('must not launch'); } });
    try {
      await assert.rejects(next.open(), { code: 'INVALID_STATE' });
      assert.equal(next.blocked, true);
      assert.equal(next.records.has(task.taskId), false);
      await next.close();
      await access(join(dataDir, 'owner.lock'));
      assert.equal(await readFile(path, 'utf8'), saved);
      assert.equal(launches, 0);
    } finally { await next.close(); }
  });
});

test('idempotent retries do not require credentials or start a new attempt', async t => {
  let launches = 0;
  const { manager, workspace } = await fixture(t, async () => { launches++; return completed(); });
  const input = { executionMode: 'single-request', requestId: 'accepted', prompt: 'task', workspace };
  const first = await manager.submit(input);
  await manager.wait({ taskId: first.taskId });
  const deny = () => { throw Object.assign(new Error('not configured'), { code: 'MISSING_CREDENTIAL' }); };
  assert.equal((await manager.submit(input, deny)).duplicate, true);
  await assert.rejects(manager.submit({ executionMode: 'single-request', ...input, prompt: 'changed' }, deny), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(manager.submit({ executionMode: 'single-request', ...input, requestId: 'new' }, deny), { code: 'MISSING_CREDENTIAL' });
  assert.equal(launches, 1);
});

test('concurrent duplicate submissions launch once; changed input conflicts and other tasks are busy', async t => {
  let launches = 0;
  const { manager, workspace } = await fixture(t, args => { launches++; return untilAborted(args); });
  const input = { executionMode: 'single-request', requestId: 'idempotent-1', prompt: 'Task', workspace };
  const [first, duplicate] = await Promise.all([manager.submit(input), manager.submit(input)]);
  assert.equal(first.taskId, duplicate.taskId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(launches, 1);
  await assert.rejects(manager.submit({ executionMode: 'single-request', ...input, prompt: 'Changed' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(manager.submit({ executionMode: 'single-request', ...input, requestId: 'other' }), { code: 'BUSY' });
  assert.equal((await manager.cancel({ taskId: first.taskId })).status, 'cancelled');
  assert.equal((await manager.result({ taskId: first.taskId })).text, 'partial');
});

test('wall timeout stops and reaps the worker before publishing timed_out', async t => {
  const { manager, workspace } = await fixture(t, untilAborted);
  const task = await manager.submit({ executionMode: 'single-request', requestId: 'timed', prompt: 'Task', workspace, timeoutMs: 1000 });
  const done = await manager.wait({ taskId: task.taskId, timeoutMs: 3000 });
  assert.equal(done.status, 'timed_out');
  assert.equal(done.cleanup, 'confirmed');
  await assert.rejects(manager.continue({ taskId: task.taskId, requestId: 'followup', prompt: 'More' }), { code: 'NOT_RESUMABLE' });
});

test('cleanup failure retains ownership and blocks later workers and restarts', async t => {
  const { manager, workspace, root } = await fixture(t, async () => ({ terminal: 'completed', text: 'result', cleanup: 'unverified' }));
  const task = await manager.submit({ executionMode: 'single-request', requestId: 'unclean', prompt: 'Task', workspace });
  assert.equal((await manager.wait({ taskId: task.taskId, timeoutMs: 1000 })).status, 'cleanup_failed');
  await assert.rejects(manager.submit({ executionMode: 'single-request', requestId: 'blocked', prompt: 'Task', workspace }), { code: 'RECOVERY_REQUIRED' });
  await manager.close();
  await access(join(root, 'state', 'owner.lock'));
  const next = new TaskManager({ dataDir: join(root, 'state'), runner: completed });
  await assert.rejects(next.open(), { code: 'STATE_LOCKED' });
});

test('legacy records retain idempotent replay and same-session continuation after upgrade', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  const input = { requestId: 'first', prompt: 'Task', workspace, effort: 'high', maxTokens: 8192, maxModelRequests: 1, maxToolCalls: 0, capabilityProfile: 'inference-only' };
  const first = await manager.submit({ ...input, executionMode: 'single-request' });
  await manager.wait({ taskId: first.taskId, timeoutMs: 1000 });
  // Serialize the exact pre-1.0 record/fingerprint shape, including explicit caps.
  const record = manager.record(first.taskId);
  delete record.planning;
  record.attempts[0].fingerprint = createHash('sha256').update(JSON.stringify({ prompt: input.prompt, workspace: record.workspace, access: 'read-only', effort: 'high', timeoutMs: 300000, maxTokens: 8192, maxToolCalls: 0, maxModelRequests: 1, maxRequestBytes: 262144, capabilityProfile: 'inference-only', capabilityDigest: 'offline' })).digest('hex');
  await manager.persist(record);
  await manager.close();
  let resumed;
  const next = await new TaskManager({ dataDir: join(root, 'state'), resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }), runner: async args => { resumed = args; return { terminal: 'completed', text: 'continued', cleanup: 'confirmed' }; } }).open();
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
  const reopened = await new TaskManager({ dataDir: join(root, 'state'), runner: () => { throw new Error('must not launch'); } }).open();
  try {
    assert.equal(reopened.status({ taskId: first.taskId }).number, 2);
    assert.equal((await reopened.result({ taskId: first.taskId, attempt: 1 })).text, 'result');
    assert.equal((await reopened.result({ taskId: first.taskId, attempt: 2 })).text, 'continued');
  } finally { await reopened.close(); }
});

test('state/workspace overlap and input limits reject before launching', async t => {
  let launches = 0;
  const { manager, workspace, root } = await fixture(t, async () => { launches++; return completed(); });
  const input = { executionMode: 'single-request', requestId: 'invalid', prompt: 'Task', workspace };
  for (const overrides of [{ workspace: root }, { workspace: join(root, 'state') }, { prompt: '' }, { maxTokens: 32769 }, { maxToolCalls: -1 }, { maxModelRequests: 0 }, { maxRequestBytes: 1023 }, { effort: 'invalid' }, { timeoutMs: 1 }]) {
    await assert.rejects(manager.submit({ executionMode: 'single-request', ...input, ...overrides }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(launches, 0);
});

test('noncompleted and oversized results are failed, not accepted', async t => {
  const { manager, workspace } = await fixture(t, async ({ prompt }) => ({ terminal: prompt === 'truncated' ? 'max-tokens' : 'completed', text: prompt === 'truncated' ? 'partial' : 'x'.repeat(1048577), cleanup: 'confirmed' }));
  for (const prompt of ['truncated', 'oversized']) {
    const task = await manager.submit({ executionMode: 'single-request', requestId: prompt, prompt, workspace });
    const done = await manager.wait({ taskId: task.taskId, timeoutMs: 1000 });
    assert.equal(done.status, 'failed');
    assert.equal(done.parentAcceptance, 'not_assessed');
  }
});

test('incomplete saved execution is marked interrupted and cannot silently resume', async t => {
  const { manager, workspace, root } = await fixture(t, completed);
  const task = await manager.submit({ executionMode: 'single-request', requestId: 'saved', prompt: 'Task', workspace });
  await manager.wait({ taskId: task.taskId, timeoutMs: 1000 });
  await manager.close();
  const path = join(root, 'state', 'tasks', task.taskId, 'task.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.attempts[0].status = 'running';
  record.attempts[0].cleanup = 'pending';
  await writeFile(path, JSON.stringify(record));
  const next = await new TaskManager({ dataDir: join(root, 'state'), runner: completed, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
  assert.equal(next.status({ taskId: task.taskId }).status, 'interrupted');
  await assert.rejects(next.submit({ executionMode: 'single-request', requestId: 'other', prompt: 'Task', workspace }), { code: 'RECOVERY_REQUIRED' });
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
    const task = await manager.submit({ executionMode: 'single-request', requestId: `publish-${stage}`, prompt: 'Task', workspace });
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
      attempts: [{ number: 1, requestId: `request-${index}`, fingerprint: createHash('sha256').update(`request-${index}`).digest('hex'), status: 'completed', cleanup: 'confirmed', startedAt }] };
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
