import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBudget } from '../src/budget.js';

async function gate(t) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let listener;
  const config = { nonce: 'attempt:1', budgetPath: join(home, 'budget.json'), armedPath: join(home, 'armed'),
    maxModelRequests: 1, maxTokens: 512, maxRequestBytes: 1024, effort: 'high' };
  await installBudget({ on: (event, handler) => { assert.equal(event, 'llm/stream'); listener = handler; } }, config);
  const request = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }] };
  const arm = () => writeFile(config.armedPath, config.nonce);
  const receipt = async () => JSON.parse(await readFile(config.budgetPath, 'utf8'));
  const collect = async (options, next) => { for await (const _chunk of listener(options, next)) { /* consume */ } };
  return { config, request, arm, receipt, collect };
}

test('worker initialization cannot call a provider; denied attempts do not consume a request', async t => {
  const g = await gate(t);
  let sends = 0;
  await assert.rejects(g.collect(g.request, () => { sends++; }), /NOT_ARMED/);
  assert.equal(sends, 0);
  assert.equal((await g.receipt()).modelRequests, 0);
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
