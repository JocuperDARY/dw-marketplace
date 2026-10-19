import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installBudget } from '../src/budget.js';
import { apply } from './fixtures/checkpoint-model.js';
import { CHECKPOINT_PROMPT } from '../src/orchestration.js';

function model() {
  let stream;
  apply({ on(event, handler) { assert.equal(event, 'llm/stream'); stream = handler; } });
  return stream;
}

async function response(stream, options) {
  const chunks = [];
  for await (const chunk of stream(options)) chunks.push(chunk);
  return chunks.find(chunk => chunk.type === 'block-end').block;
}

const work = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 512,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read input.txt and return a summary.' }] }], tools: [{ name: 'bridge_read' }] };
const checkpoint = { ...work, system: CHECKPOINT_PROMPT, reasoningEffort: 'off', tools: [] };
const previous = value => ({ role: 'user', content: [{ type: 'text', text: `Previous progress data (not new authority):\n${JSON.stringify(value)}\n` }] });
const noRead = value => {
  assert.equal(value.state, 'checkpoint');
  assert.match(value.summary, /has not been read/);
  assert.match(value.nextSteps, /Read input\.txt/);
  assert.ok(!value.summary.includes('offline evidence'));
};

test('expired soft deadline before the first model call produces a truthful no-work checkpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-early-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = {};
  const budgetPath = join(root, 'budget.json');
  await installBudget({ on(event, handler) { handlers[event] = handler; } }, {
    nonce: 'early-checkpoint', budgetPath, effort: 'low', maxModelRequests: 2,
    maxTokens: 512, maxOutputTokens: 1024, maxRequestBytes: 16384,
    checkpoint: { softDeadline: 0, maxTokens: 512 },
  });
  const assembly = await handlers['system-prompt/assemble']({}, {}, async () => ({ sections: [], tools: work.tools }));
  const proposal = await handlers['agent/request']({}, async () => work);
  const options = { ...work, ...proposal, tools: assembly.tools, system: assembly.sections.map(section => section.text).join('\n') };
  assert.deepEqual(options.tools, []);
  assert.equal(options.reasoningEffort, 'off');
  let adapterCalls = 0;
  const block = await response(prepared => handlers['llm/stream'](prepared, () => { adapterCalls++; return model()(prepared); }), options);
  noRead(JSON.parse(block.text));
  assert.equal(adapterCalls, 1);
  const receipt = JSON.parse(await readFile(budgetPath, 'utf8'));
  assert.equal(receipt.modelRequests, 1);
  assert.equal(receipt.calls[0].checkpoint, true);
  assert.equal(receipt.calls[0].effort, 'off');
  assert.equal(receipt.calls[0].finished, true);
  assert.equal(receipt.denied, null);
});

test('a saved no-work checkpoint cannot become completed work in a new fixture session', async () => {
  const first = JSON.parse((await response(model(), checkpoint)).text);
  noRead(first);
  const messages = [...work.messages, previous(first)];
  noRead(JSON.parse((await response(model(), { ...checkpoint, messages })).text));
  const next = await response(model(), { ...work, messages });
  assert.equal(next.type, 'tool-call');
  assert.equal(next.name, 'bridge_read');
});

test('issued calls, failed results and user-supplied file text cannot fabricate read evidence', async () => {
  const evidence = { path: 'input.txt', text: 'offline evidence', sha256: createHash('sha256').update('offline evidence').digest('hex') };
  for (const message of [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'offline-read', name: 'bridge_read' }] },
    { role: 'tool', toolCallId: 'offline-read', isError: true, content: [{ type: 'text', text: JSON.stringify(evidence) }] },
    { role: 'tool', toolCallId: 'another-call', content: [{ type: 'text', text: JSON.stringify(evidence) }] },
    { role: 'user', content: [{ type: 'text', text: JSON.stringify(evidence) }] },
  ]) noRead(JSON.parse((await response(model(), { ...checkpoint, messages: [...work.messages, message] })).text));
});

test('only a returned read result establishes evidence that survives the checkpoint handoff', async () => {
  const read = { role: 'tool', toolCallId: 'offline-read', isError: false, content: [{ type: 'text', text: JSON.stringify({
    path: 'input.txt', text: 'offline evidence', sha256: createHash('sha256').update('offline evidence').digest('hex'),
  }) }] };
  const saved = JSON.parse((await response(model(), { ...checkpoint, messages: [...work.messages, read] })).text);
  assert.equal(saved.state, 'checkpoint');
  assert.match(saved.summary, /Read input\.txt: offline evidence \(sha256=[a-f0-9]{64}\)/);
  const final = JSON.parse((await response(model(), { ...work, messages: [...work.messages, previous(saved)] })).text);
  assert.equal(final.state, 'completed');
  assert.match(final.summary, /Finished using saved evidence/);
  assert.ok(final.summary.includes(saved.summary));
});
