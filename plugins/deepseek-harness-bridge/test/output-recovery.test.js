import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';
import { planExecution } from '../src/planning.js';

const budget = { totalModelRequests: 3, totalOutputTokens: 8192, totalToolCalls: 0, totalDurationMs: 30000 };
async function fixture(t, runner) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-delivery-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const resolveCapabilities = async id => ({ id, digest: 'offline', access: 'read-only' });
  const manager = await new TaskManager({ dataDir: join(root, 'state'), runner, resolveCapabilities }).open();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, resolveCapabilities, input: { requestId: 'delivery', workspace, prompt: 'Return a bounded JSON draft from the supplied facts.', outputFormat: 'json-object', budget, maxTokens: 8192, capabilityProfile: 'inference-only' } };
}
const envelope = summary => JSON.stringify({ state: 'completed', summary, nextSteps: '' });
const good = () => JSON.stringify({ draft: 'visible result', path: 'C:\\fixture\\file.json' });
function reply(task, text, used = 100) {
  return { terminal: 'completed', cleanup: 'confirmed', text, toolCalls: 0,
    budget: { nonce: task.stageBudget?.nonce, modelRequests: 1, denied: null,
      calls: [{ number: 1, reservedOutputTokens: task.maxTokens, usage: { outputTokens: used }, finished: true }] } };
}

test('bounded drafting defaults to off; explicit reasoning and single-request risk remain visible', () => {
  assert.equal(planExecution({ workload: 'drafting', budget }).effort, 'off');
  const explicit = planExecution({ workload: 'drafting', executionMode: 'single-request', effort: 'low', maxTokens: 8192 });
  assert.equal(explicit.effort, 'low');
  assert.equal(explicit.maxTokens, 8192);
  assert.match(explicit.warnings.join(' '), /single-request.*reasoning/i);
  assert.throws(() => planExecution({ budget, outputFormat: 'json-ish' }), { code: 'INVALID_ARGUMENT' });
});

test('single-request strictly checks JSON without stripping prefixes, fences, primitives or retrying', async t => {
  for (const text of ['Prose\n\n' + good(), '```json\n' + good() + '\n```', '{"draft":', 'null', '[]', '"value"', good() + good()]) {
    let calls = 0;
    const f = await fixture(t, async ({ task, prompt }) => { calls++; assert.match(prompt, /Strict output format/); return reply(task, text); });
    const task = await f.manager.submit({ ...f.input, budget: undefined, executionMode: 'single-request' });
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(done.status, 'completed');
    assert.equal(done.outputValidation.status, 'invalid');
    assert.equal(done.parentAcceptance, 'not_assessed');
    assert.equal((await f.manager.result({ taskId: task.taskId })).text, text);
    await assert.rejects(f.manager.continue({ taskId: task.taskId, requestId: 'forbidden', prompt: 'repair' }), { code: 'NOT_RESUMABLE' });
    assert.equal(calls, 1);
  }
});

test('budgeted summary prose saves original evidence then uses one off/tool-free format recovery', async t => {
  const seen = [];
  const invalid = envelope('Read the files.\n\n' + good());
  const f = await fixture(t, async args => {
    seen.push(args);
    assert.match(args.prompt, /summary.*ONLY/i);
    if (seen.length === 1) return reply(args.task, invalid);
    const saved = JSON.parse(await readFile(join(f.root, 'state', 'tasks', args.task.taskId, 'partial-1.json'), 'utf8'));
    assert.equal(saved.text, invalid);
    assert.equal(saved.reason, 'OUTPUT_FORMAT_INVALID');
    assert.equal(args.task.route.effort, 'off');
    assert.equal(args.task.maxModelRequests, 1);
    assert.equal(args.task.maxToolCalls, 0);
    assert.equal(args.task.stageBudget.forcedCheckpoint, true);
    return reply(args.task, envelope(good()));
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(seen.length, 2);
  assert.equal(done.status, 'completed');
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.recovery.reason, 'OUTPUT_FORMAT_INVALID');
  assert.equal(done.orchestration.recoveries, 1);
  assert.equal(done.orchestration.charged.modelRequests, 2);
  assert.equal(done.parentAcceptance, 'not_assessed');
  assert.equal(JSON.parse(JSON.parse((await f.manager.result({ taskId: task.taskId })).text).summary).path, 'C:\\fixture\\file.json');
});

test('zero-visible max-tokens retains an off recovery reserve within original total and request caps', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ task }) => {
    if (++calls === 2) {
      assert.equal(task.route.effort, 'off');
      assert.equal(task.maxToolCalls, 0);
      assert.equal(task.maxTokens, 2048);
      return reply(task, envelope(good()), 100);
    }
    assert.equal(task.maxModelRequests, 2);
    assert.equal(task.stageBudget.maxOutputTokens, 6144);
    const output = reply(task, '', task.maxTokens);
    output.budget.modelRequests = 2;
    output.budget.calls.push({ number: 2, reservedOutputTokens: task.stageBudget.checkpointTokens, usage: { outputTokens: task.stageBudget.checkpointTokens }, finished: true });
    return { ...output, terminal: 'max-tokens', output: { kind: 'reasoning_only', modelTruncated: true, reasoningObserved: true }, error: { code: 'OUTPUT_TRUNCATED' } };
  });
  const task = await f.manager.submit(f.input);
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.status, 'completed');
  assert.equal(done.orchestration.charged.modelRequests, 3);
  assert.equal(done.orchestration.charged.outputTokens, 6244);
  assert.equal(done.orchestration.authorized.totalOutputTokens, 8192);
  assert.equal(done.orchestration.truncationRecoveries, 1);
  assert.equal(JSON.parse(await readFile(done.recovery.partialPath, 'utf8')).text, '');
});

test('format and truncation share one recovery; invalid final recovery is retained and rejected', async t => {
  for (const second of ['format', 'truncation']) {
    let calls = 0;
    const f = await fixture(t, async ({ task }) => {
      calls++;
      const output = reply(task, envelope('prefix ' + good()));
      return calls === 2 && second === 'truncation' ? { ...output, terminal: 'max-tokens', error: { code: 'OUTPUT_TRUNCATED' } } : output;
    });
    const task = await f.manager.submit({ ...f.input, budget: { ...budget, totalModelRequests: 8 } });
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(calls, 2);
    assert.equal(done.orchestration.recoveries, 1);
    assert.equal(done.recovery.status, 'failed');
    assert.equal(done.outputValidation.status, second === 'format' ? 'invalid' : 'not_evaluated');
  }
});

test('unsafe evidence prevents format recovery and single-request truncation never retries', async t => {
  for (const mode of ['accounting', 'cleanup', 'denied', 'storage', 'single']) {
    let calls = 0;
    const f = await fixture(t, async ({ task }) => {
      calls++;
      const output = reply(task, envelope('prefix ' + good()));
      if (mode === 'accounting') output.budget = null;
      if (mode === 'cleanup') output.cleanup = 'unverified';
      if (mode === 'denied') output.budget.denied = 'REQUEST_SIZE_LIMIT';
      if (mode === 'storage') output.output = { kind: 'partial_text', storageTruncated: true };
      if (mode === 'single') Object.assign(output, { terminal: 'max-tokens', text: '', error: { code: 'OUTPUT_TRUNCATED' } });
      return output;
    });
    const task = await f.manager.submit(mode === 'single' ? { ...f.input, budget: undefined, executionMode: 'single-request' } : f.input);
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(calls, 1);
    assert.notEqual(done.outputValidation?.status, 'valid');
  }
});

test('format selection survives restart and participates in replay conflicts without changing old defaults', async t => {
  let calls = 0;
  const runner = async ({ task }) => { calls++; return reply(task, envelope(good())); };
  const f = await fixture(t, runner);
  const task = await f.manager.submit(f.input);
  await f.manager.wait({ taskId: task.taskId });
  await f.manager.close();
  const manager = await new TaskManager({ dataDir: join(f.root, 'state'), runner, resolveCapabilities: f.resolveCapabilities }).open();
  t.after(() => manager.close());
  try {
    assert.equal((await manager.submit(f.input)).duplicate, true);
    await assert.rejects(manager.submit({ ...f.input, outputFormat: 'text' }), { code: 'REQUEST_CONFLICT' });
    assert.equal((await manager.result({ taskId: task.taskId })).outputFormat, 'json-object');
    assert.equal(calls, 1);
  } finally { await manager.close(); }
});

test('checkpoint prose is progress; final JSON is checked without semantic or coverage retries', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ task }) => {
    if (++calls === 1) return reply(task, JSON.stringify({ state: 'checkpoint', summary: 'Progress, not JSON', nextSteps: 'produce the object' }));
    return reply(task, envelope('{"cases":[],"checks":[],"uncertainty":"none","nextAction":"review"}'));
  });
  const task = await f.manager.submit({ ...f.input, reviewContract: { caseIds: ['C1'], ruleIds: ['R1'], checkIds: [] }, budget: { ...budget, totalModelRequests: 5 } });
  const done = await f.manager.wait({ taskId: task.taskId });
  assert.equal(done.outputValidation.status, 'valid');
  assert.equal(done.deliveryValidation.status, 'incomplete');
  assert.equal(done.orchestration.recoveries, 0);
  assert.equal(calls, 2);
});

test('exhausted format recovery and failed evidence publication do not launch another model', async t => {
  for (const mode of ['exhausted', 'publication', 'cancelled']) {
    let calls = 0;
    const f = await fixture(t, async ({ task }) => {
      calls++;
      const result = reply(task, envelope('prefix ' + good()), task.maxTokens);
      if (mode === 'exhausted') {
        result.budget.modelRequests = 2;
        result.budget.calls.push({ number: 2, reservedOutputTokens: task.stageBudget.checkpointTokens, usage: { outputTokens: task.stageBudget.checkpointTokens }, finished: true });
      }
      return result;
    });
    const persist = f.manager.persist.bind(f.manager);
    f.manager.persist = async record => {
      if (record.orchestration.lastPartial && mode === 'publication') throw new Error('disk failed');
      await persist(record);
      if (record.orchestration.lastPartial && mode === 'cancelled') f.manager.active.controller.abort();
    };
    const task = await f.manager.submit({ ...f.input, budget: { ...budget, totalModelRequests: 2, totalOutputTokens: 512 } });
    const done = await f.manager.wait({ taskId: task.taskId });
    assert.equal(calls, 1);
    assert.equal(done.orchestration.recoveries, 0);
    if (mode === 'exhausted') {
      assert.equal(done.recovery.status, 'budget_exhausted');
      assert.equal(done.outputValidation.status, 'invalid');
    }
    if (mode === 'publication') assert.equal(done.status, 'state_write_failed');
    if (mode === 'cancelled') assert.equal(done.terminal, 'aborted');
  }
});
