import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBudget } from '../src/budget.js';

async function gate(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let listener;
  let assemble;
  let prepare;
  const config = { nonce: 'attempt:1', budgetPath: join(home, 'budget.json'), armedPath: join(home, 'armed'),
    maxModelRequests: 1, maxTokens: 512, maxRequestBytes: 1024, effort: 'high', ...overrides };
  await installBudget({ on: (event, handler) => { if (event === 'llm/stream') listener = handler; else if (event === 'system-prompt/assemble') assemble = handler; else if (event === 'agent/request') prepare = handler; else assert.fail(event); } }, config);
  const request = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }] };
  const arm = () => writeFile(config.armedPath, config.nonce);
  const receipt = async () => JSON.parse(await readFile(config.budgetPath, 'utf8'));
  const collect = async (options, next, beforeStream = () => {}) => {
    if (assemble) {
      const assembly = { sections: [{ name: 'test', text: options.system ?? '' }], tools: options.tools ?? [] };
      const prepared = await assemble(assembly, {}, async () => assembly);
      options = Object.assign(options, { system: prepared.sections.map(s => s.text).join('\n'), tools: prepared.tools });
    }
    if (prepare) Object.assign(options, await prepare({}, async () => ({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens })));
    beforeStream();
    for await (const _chunk of listener(Object.freeze(options), next)) { /* consume */ }
  };
  return { config, request, arm, receipt, collect };
}

test('worker initialization cannot call a provider; denied attempts do not consume a request', async t => {
  const g = await gate(t);
  let sends = 0;
  await assert.rejects(g.collect(g.request, () => { sends++; }), /NOT_ARMED/);
  assert.equal(sends, 0);
  assert.equal((await g.receipt()).modelRequests, 0);
});

test('stage gate reserves a final text-only checkpoint request and counts it in the output budget', async t => {
  const g = await gate(t, { maxModelRequests: 2, maxOutputTokens: 1024, maxRequestBytes: 16384, checkpoint: { softDeadline: Date.now() + 10000 } });
  await g.arm();
  async function* adapter() { yield { type: 'usage', usage: { outputTokens: 100 } }; yield { type: 'finish', reason: 'stop' }; }
  await g.collect({ ...g.request, tools: [{ name: 'bridge_read' }] }, adapter);
  const last = { ...g.request, tools: [{ name: 'bridge_read' }] };
  await g.collect(last, adapter);
  assert.deepEqual(last.tools, []);
  assert.match(last.system, /checkpoint/);
  const receipt = await g.receipt();
  assert.equal(receipt.calls[1].checkpoint, true);
  assert.equal(receipt.calls[1].reservedOutputTokens, 512);
  assert.equal(receipt.calls[0].effort, 'high');
  assert.equal(receipt.calls[1].effort, 'off');
  assert.equal(receipt.modelRequests, 2);
  await assert.rejects(g.collect(g.request, adapter), /MODEL_REQUEST_LIMIT|CHECKPOINT_CLOSED/);
});

test('per-request allocation keeps a small checkpoint reserve and uses released actual usage', async t => {
  const g = await gate(t, { maxTokens: 8192, maxModelRequests: 4, maxOutputTokens: 12288, maxRequestBytes: 16384,
    checkpoint: { maxTokens: 2048, softDeadline: Date.now() + 10000 } });
  await g.arm();
  const adapter = async function* () { yield { type: 'usage', usage: { outputTokens: 5000 } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; };
  await g.collect({ ...g.request }, adapter);
  await g.collect({ ...g.request }, adapter);
  const afterWork = await g.receipt();
  assert.deepEqual(afterWork.calls.map(call => call.reservedOutputTokens), [8192, 5240]);
  await g.collect({ ...g.request }, async function* () { yield { type: 'usage', usage: { outputTokens: 100 } }; yield { type: 'finish', reason: { kind: 'stop' } }; });
  const last = (await g.receipt()).calls[2];
  assert.equal(last.checkpoint, true);
  assert.equal(last.effort, 'off');
  assert.equal(last.reservedOutputTokens, 2048);
});

test('one request is reserved before dispatch and the second cannot reach the adapter', async t => {
  const g = await gate(t);
  await g.arm();
  let sends = 0;
  async function* adapter() {
    sends++;
    assert.equal((await g.receipt()).modelRequests, 1);
    yield { type: 'usage', usage: { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 0, secret: 'discard' } };
    yield { type: 'finish', reason: 'stop' };
  }
  await g.collect(g.request, adapter);
  await assert.rejects(g.collect(g.request, adapter), /MODEL_REQUEST_LIMIT/);
  assert.equal(sends, 1);
  const receipt = await g.receipt();
  assert.deepEqual(receipt.calls[0].usage, { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 0 });
  assert.equal(receipt.calls[0].finished, true);
  assert.equal(receipt.denied, 'MODEL_REQUEST_LIMIT');
});

test('route, output cap, oversized input and images are rejected before dispatch', async t => {
  for (const [override, code] of [
    [{ provider: 'other' }, 'ROUTE_DENIED'], [{ maxTokens: 513 }, 'OUTPUT_TOKEN_LIMIT'],
    [{ messages: [{ content: [{ type: 'text', text: 'x'.repeat(2048) }] }] }, 'REQUEST_SIZE_LIMIT'],
    [{ messages: [{ content: [{ type: 'image', source: 'x' }] }] }, 'NON_TEXT_REQUEST'],
  ]) {
    const g = await gate(t);
    await g.arm();
    await assert.rejects(g.collect({ ...g.request, ...override }, () => { throw new Error('adapter must not run'); }), new RegExp(code));
    assert.equal((await g.receipt()).modelRequests, 0);
  }
});

test('provider failure leaves reserved request and unknown usage; no retry is inferred', async t => {
  const g = await gate(t);
  await g.arm();
  await assert.rejects(g.collect(g.request, async function* () { throw new Error('transport interrupted'); }), /transport interrupted/);
  const receipt = await g.receipt();
  assert.equal(receipt.modelRequests, 1);
  assert.equal(receipt.calls[0].usage, null);
  assert.equal(receipt.calls[0].finished, false);
});

test('concurrent calls cannot spend the same remaining output reservation', async t => {
  const g = await gate(t, { maxModelRequests: 2, maxOutputTokens: 512 });
  await g.arm();
  let sends = 0;
  async function* adapter() { sends++; yield { type: 'finish', reason: 'stop' }; }
  const results = await Promise.allSettled([g.collect({ ...g.request }, adapter), g.collect({ ...g.request }, adapter)]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(sends, 1);
  assert.equal((await g.receipt()).calls[0].reservedOutputTokens, 512);
});

test('output headroom and the soft deadline request a checkpoint before the request-count cap', async t => {
  for (const overrides of [{ maxOutputTokens: 512 }, { checkpoint: { softDeadline: 0 } }]) {
    const g = await gate(t, { maxModelRequests: 8, maxOutputTokens: 4096, maxRequestBytes: 16384, checkpoint: { softDeadline: Date.now() + 10000 }, ...overrides });
    await g.arm();
    const request = { ...g.request, tools: [{ name: 'bridge_read' }] };
    await g.collect(request, async function* () { yield { type: 'finish', reason: 'stop' }; });
    assert.deepEqual(request.tools, []);
    assert.equal((await g.receipt()).calls[0].checkpoint, true);
  }
});

test('checkpoint response cannot smuggle a complete tool-call block to the executor', async t => {
  const g = await gate(t, { maxModelRequests: 2, maxOutputTokens: 512, maxRequestBytes: 16384, checkpoint: { softDeadline: 0 } });
  await g.arm();
  await assert.rejects(g.collect({ ...g.request }, async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'bridge_write' } };
  }), /Checkpoint-only/);
  assert.equal((await g.receipt()).denied, 'CHECKPOINT_TOOL_CALL');
});

test('a soft deadline crossing after assembly checkpoints the next request without rejecting prepared work', async t => {
  const g = await gate(t, { maxModelRequests: 4, maxOutputTokens: 2048, maxRequestBytes: 16384, checkpoint: { softDeadline: Date.now() + 10000 } });
  await g.arm();
  const adapter = async function* () { yield { type: 'usage', usage: { outputTokens: 100 } }; yield { type: 'finish', reason: 'stop' }; };
  await g.collect({ ...g.request, tools: [{ name: 'bridge_read' }] }, adapter, () => { g.config.checkpoint.softDeadline = 0; });
  assert.equal((await g.receipt()).calls[0].checkpoint, false);
  await g.collect({ ...g.request, tools: [{ name: 'bridge_read' }] }, adapter);
  assert.equal((await g.receipt()).calls[1].checkpoint, true);
});
