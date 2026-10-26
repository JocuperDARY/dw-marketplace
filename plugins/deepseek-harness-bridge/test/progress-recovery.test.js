import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';
import { validateSavedBudget } from '../src/orchestration.js';
import { normalizeRecoveryMilestones, observeMilestones, recoveryEligible, validateProgress } from '../src/recovery-progress.js';
import { planExecution } from '../src/planning.js';
import { snapshotPath } from './fixtures/committed-state.js';

const milestones = [{ id: 'phase-1', path: 'phase1.json', assertions: [{ pointer: '/passed', expected: true }] }];
function reply(task, state = 'checkpoint', summary = 'progress') {
  return { terminal: 'completed', cleanup: 'confirmed', text: JSON.stringify({ state, summary, nextSteps: state === 'completed' ? '' : 'continue' }), toolCalls: 0,
    budget: { nonce: task.stageBudget.nonce, modelRequests: 1, denied: null,
      calls: [{ number: 1, reservedOutputTokens: task.maxTokens, finished: true, usage: { outputTokens: 10 } }] } };
}
function truncated(task) { return { ...reply(task), terminal: 'max-tokens', text: 'partial', output: { modelTruncated: true }, error: { code: 'OUTPUT_TRUNCATED' } }; }
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-progress-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const options = { dataDir: join(root, 'state'), runner, resolveCapabilities: async id => ({ id, digest: 'offline', access: 'workspace-write' }) };
  const manager = await new TaskManager(options).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, options, manager, input: { requestId: 'progress', workspace, prompt: 'Synthetic phases', access: 'workspace-write',
    executionMode: 'budgeted', budget: {}, effort: 'high', maxTokens: 1024, maxModelRequests: 2, recoveryMilestones: milestones } };
}

test('a newly verified ordinary checkpoint renews recovery within original totals and retains both partials', async t => {
  const calls = [];
  const f = await fixture(t, async ({ task }) => {
    calls.push(task);
    if ([1, 4].includes(calls.length)) return truncated(task);
    if (calls.length === 3) await writeFile(join(task.workspace, 'phase1.json'), '{"passed":true}');
    return reply(task, calls.length === 5 ? 'completed' : 'checkpoint');
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'completed'); assert.equal(calls.length, 5);
  assert.equal(done.orchestration.recoveries, 2);
  assert.equal(done.orchestration.charged.modelRequests, 5);
  assert.equal(done.orchestration.charged.outputTokens, 50);
  assert.equal(done.orchestration.authorized.totalModelRequests, null);
  assert.equal(done.orchestration.recoveryPolicy, 'progress-v2');
  assert.equal(done.orchestration.verifiedProgress[0].stage, 3);
  assert.equal(done.orchestration.verifiedProgress[0].id, 'phase-1');
  for (const i of [1, 4]) {
    const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks-v3', task.taskId, `partial-${i}.json`), 'utf8'));
    assert.equal(saved.text, 'partial');
  }
  for (const i of [1, 4]) { assert.equal(calls[i].maxToolCalls, 0); assert.equal(calls[i].maxModelRequests, 1); assert.equal(calls[i].route.effort, 'off'); }
  assert.equal(calls[2].route.effort, 'high');
  const saved = JSON.parse(await readFile(await snapshotPath(f.options.dataDir, task.taskId), 'utf8'));
  validateSavedBudget(saved);
  await assert.rejects(f.manager.submit({ ...f.input, recoveryMilestones: [{ ...milestones[0], id: 'changed' }] }), { code: 'REQUEST_CONFLICT' });
});

for (const mode of ['prose-only', 'pre-existing', 'wrong-assertion', 'recovery-created', 'failed-stage-created']) {
  test(`${mode} cannot renew recovery`, async t => {
    let calls = 0;
    const f = await fixture(t, async ({ task }) => {
      calls++;
      if ((mode === 'recovery-created' && calls === 2) || (mode === 'failed-stage-created' && calls === 1)) {
        await writeFile(join(task.workspace, 'phase1.json'), '{"passed":true}');
      }
      if ([1, 4].includes(calls)) return truncated(task);
      if (mode === 'wrong-assertion' && calls === 3) await writeFile(join(task.workspace, 'phase1.json'), '{"passed":false}');
      return reply(task, 'checkpoint', `changed prose ${calls}`);
    });
    if (mode === 'pre-existing') await writeFile(join(f.workspace, 'phase1.json'), '{"passed":true}');
    const task = await f.manager.submit(f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(calls, 4); assert.equal(done.status, 'failed');
    assert.equal(done.orchestration.recoveries, 1);
    assert.deepEqual(done.orchestration.verifiedProgress, []);
  });
}

test('restart and continuation retain consumed progress and original authorization', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ task }) => {
    calls++;
    if ([1, 4, 8].includes(calls)) return truncated(task);
    if (calls === 3) await writeFile(join(task.workspace, 'phase1.json'), '{"passed":true}');
    return reply(task, 'checkpoint', calls >= 5 ? 'same after recovery' : `phase ${calls}`);
  });
  const task = await f.manager.submit(f.input);
  const paused = await f.manager.wait({ taskId: task.taskId });
  assert.equal(paused.status, 'paused'); assert.equal(calls, 6);
  assert.equal(paused.orchestration.recoveries, 2);
  await f.manager.close();
  const next = await new TaskManager({ ...f.options, runner: async ({ task: current }) => {
    calls++; return calls === 7 ? reply(current, 'checkpoint', 'new prose after restart') : truncated(current);
  } }).open();
  t.after(() => next.close());
  await next.continue({ taskId: task.taskId, requestId: 'continued', prompt: 'Continue remaining work.', controlToken: task.controlToken });
  const done = await next.wait({ taskId: task.taskId });
  assert.equal(calls, 8); assert.equal(done.status, 'failed');
  assert.equal(done.orchestration.recoveries, 2);
  assert.deepEqual(done.orchestration.authorized, paused.orchestration.authorized);
  assert.equal(done.orchestration.charged.modelRequests, 8);
});

test('single-request and malformed contracts reject; observations time out or cancel without granting evidence', async () => {
  assert.throws(() => planExecution({ executionMode: 'single-request', recoveryMilestones: milestones }), { code: 'INVALID_ARGUMENT' });
  for (const bad of [[], [milestones[0], milestones[0]], [{ ...milestones[0], path: '../private' }]]) {
    assert.throws(() => normalizeRecoveryMilestones(bad, 'budgeted'), { code: 'INVALID_ARGUMENT' });
  }
  const record = { orchestration: { recoveryMilestones: milestones } };
  const timed = await observeMilestones(record, { timeoutMs: 10, read: () => new Promise(() => {}) });
  assert.deepEqual(timed, { status: 'timed_out', evidence: [], known: [] });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await observeMilestones(record, { signal: controller.signal }), { status: 'aborted', evidence: [], known: [] });
});

test('legacy recovery eligibility never renews and forged duplicate progress cannot load', () => {
  const stages = [{ number: 1, purpose: 'truncation-recovery' }, { number: 2, purpose: 'work', status: 'checkpoint', progressEvidence: [{ id: 'phase-1', sha256: 'a'.repeat(64) }] }];
  assert.equal(recoveryEligible({ stages, recoveryPolicy: 'bounded-v1' }), false);
  assert.equal(recoveryEligible({ stages, recoveryPolicy: 'progress-v2' }), true);
  const stage = { ...stages[1], progressBaseline: 'observed', progressBaselineKnown: ['phase-1'], progressObservation: 'observed' };
  const plan = { recoveryMilestones: milestones, progressSeen: ['phase-1'], stages: [stage] };
  validateProgress(plan);
  assert.throws(() => validateProgress({ ...plan, stages: [stage, { ...stage, number: 3 }] }), { code: 'INVALID_STATE' });
  assert.throws(() => validateProgress({ ...plan, stages: [{ ...stage, progressBaseline: 'timed_out' }] }), { code: 'INVALID_STATE' });
});
