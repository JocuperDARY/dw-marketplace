import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSavedResult } from '../src/parent-evidence.js';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, object, receiptPatch = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-parent-evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const taskId = randomUUID();
  const text = typeof object === 'string' ? object : JSON.stringify(object);
  const calls = [];
  const callTool = async request => {
    assert.equal(request.name, 'dsh_result');
    assert.equal(request.arguments.taskId, taskId);
    assert.equal(request.arguments.attempt, 1);
    calls.push(request);
    const { offset, limit } = request.arguments;
    return { taskId, sessionId: 'synthetic-session', requestId: 'synthetic-request', number: 1, workspace,
      status: 'completed', terminal: 'completed', cleanup: 'confirmed', planning: { executionMode: 'automatic' },
      output: { kind: 'complete_text', modelTruncated: false, storageTruncated: false }, outputTruncated: false,
      ...receiptPatch, resultAvailable: true, text: text.slice(offset, offset + limit), offset,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      resultPage: { unit: 'utf16-code-units', totalCharacters: text.length, sha256: digest(text) } };
  };
  return { workspace, taskId, calls, callTool,
    run: checks => checkSavedResult(callTool, { taskId, attempt: 1, checks }),
    source: async (path, content) => { await writeFile(join(workspace, path), content); return { path, sha256: digest(content) }; } };
}

test('literal, count and arithmetic checks pass independently without claiming semantic acceptance', async t => {
  const f = await fixture(t, { value: 4, items: ['a', 'b'], sum: 6, product: 24, padded: '界😀'.repeat(14000) });
  const result = await f.run([
    { id: 'literal', kind: 'literal', pointer: '/value', expected: 4 },
    { id: 'count', kind: 'count', pointer: '/items', expected: 2 },
    { id: 'sum', kind: 'arithmetic', pointer: '/sum', operator: 'sum', operands: [1, 2, 3] },
    { id: 'product', kind: 'arithmetic', pointer: '/product', operator: 'product', operands: [2, 3, 4] },
  ]);
  assert.equal(result.status, 'checks_passed');
  assert.deepEqual(result.counts, { total: 4, passed: 4, failed: 0, unknown: 0 });
  assert.equal(result.parentAcceptance, 'not_assessed');
  assert.equal(result.sourceAuthority, 'not_assessed');
  assert.equal(result.resultIdentity.attempt, 1);
  assert.ok(result.retrieval.pages > 1);
  assert.ok(f.calls.length > 1);
  assert.equal(result.validation.modelCalls, 0);
});

test('wrong facts/counts fail; missing evidence and unsupported prerequisites remain unknown', async t => {
  const f = await fixture(t, { value: 3, items: ['a'], sum: 7, prerequisite: 'Must execute before stating any general rule' });
  const result = await f.run([
    { id: 'fact', kind: 'literal', pointer: '/value', expected: 4 },
    { id: 'count', kind: 'count', pointer: '/items', expected: 2 },
    { id: 'sum', kind: 'arithmetic', pointer: '/sum', operator: 'sum', operands: [1, 2, 3] },
    { id: 'missing', kind: 'literal', pointer: '/absent', expected: true },
    { id: 'prerequisite', kind: 'manual', reason: 'prerequisite' },
  ]);
  assert.equal(result.status, 'checks_failed');
  assert.deepEqual(result.counts, { total: 5, passed: 0, failed: 3, unknown: 2 });
  assert.equal(result.items.find(x => x.id === 'missing').code, 'CLAIM_MISSING');
  assert.equal(result.items.find(x => x.id === 'prerequisite').code, 'PARENT_REVIEW_REQUIRED');
});

test('source locators are checked against pinned bytes; the preserved off-by-one case fails', async t => {
  const f = await fixture(t, { right: { startLine: 2, endLine: 2, quote: "const alpha = require('./alpha');" },
    wrong: { startLine: 3, endLine: 3, quote: "const alpha = require('./alpha');" } });
  const source = await f.source('module.cjs', "// header\r\nconst alpha = require('./alpha');\r\nconst beta = require('./beta');\r\n");
  const result = await f.run([
    { id: 'right', kind: 'source-quote', pointer: '/right', source },
    { id: 'wrong', kind: 'source-quote', pointer: '/wrong', source },
  ]);
  assert.equal(result.items[0].status, 'PASS');
  assert.equal(result.items[1].status, 'FAIL');
  assert.equal(result.items[1].code, 'SOURCE_QUOTE_MISMATCH');
  assert.equal(result.parentAcceptance, 'not_assessed');
  assert.equal(JSON.stringify(result).includes("require('./alpha')"), false);
});

test('execution success needs matching receipt evidence, never a definition or import', async t => {
  const f = await fixture(t, { success: { identity: 'run-1', status: 'succeeded' }, failure: { identity: 'run-1', status: 'failed' } });
  const failedReceipt = await f.source('failed.json', '{"runId":"run-1","exitCode":1}');
  const missingExit = await f.source('definition.json', '{"runId":"run-1","definition":"function objective() {}"}');
  const unrelated = await f.source('other.json', '{"runId":"other-run","exitCode":0}');
  const successReceipt = await f.source('success.json', '{"runId":"run-1","exitCode":0}');
  const check = (id, pointer, receipt) => ({ id, kind: 'execution', pointer, receipt,
    identity: { pointer: '/runId', expected: 'run-1' }, exitCodePointer: '/exitCode' });
  const result = await f.run([
    check('failed-claim', '/success', failedReceipt), check('failed-control', '/failure', failedReceipt),
    check('definition-only', '/success', missingExit), check('other-run', '/success', unrelated),
    check('missing', '/success', { path: 'absent.json', sha256: 'a'.repeat(64) }), check('success-control', '/success', successReceipt),
  ]);
  assert.deepEqual(result.items.map(x => x.status), ['FAIL', 'PASS', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'PASS']);
  assert.equal(result.sourceAuthority, 'not_assessed');
});

test('source changes, protected paths and links never become an accepted source claim', async t => {
  const f = await fixture(t, { quote: { startLine: 1, endLine: 1, quote: 'private-file-marker' } });
  const source = await f.source('source.txt', 'private-file-marker');
  await writeFile(join(f.workspace, 'source.txt'), 'changed');
  await writeFile(join(f.workspace, '.env'), 'private-file-marker');
  await symlink(join(f.workspace, '.env'), join(f.workspace, 'alias.txt'));
  const paths = ['.env', '../outside.txt', join(f.workspace, '.env'), 'alias.txt'];
  const result = await f.run([
    { id: 'changed', kind: 'source-quote', pointer: '/quote', source },
    ...paths.map((path, i) => ({ id: `path-${i}`, kind: 'source-quote', pointer: '/quote', source: { path, sha256: digest('private-file-marker') } })),
  ]);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.items.every(x => x.status === 'UNKNOWN'));
  assert.equal(result.items[0].code, 'SOURCE_CHANGED');
  assert.equal(JSON.stringify(result).includes('private-file-marker'), false);
  assert.equal(await readFile(join(f.workspace, '.env'), 'utf8'), 'private-file-marker');
});

for (const [name, patch] of [
  ['failed runtime', { status: 'failed', terminal: 'error' }],
  ['unconfirmed cleanup', { cleanup: 'unverified' }],
  ['model clipping', { output: { modelTruncated: true, storageTruncated: false } }],
  ['unknown clipping', { output: undefined }],
  ['storage clipping', { outputTruncated: true }],
]) test(`${name} cannot produce aggregate pass`, async t => {
  const f = await fixture(t, { value: true }, patch);
  const result = await f.run([{ id: 'value', kind: 'literal', pointer: '/value', expected: true }]);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.items[0].status, 'UNKNOWN');
});

test('malformed JSON and completed budgeted summaries have distinct checkable outcomes', async t => {
  const malformed = await fixture(t, '{"value":');
  assert.equal((await malformed.run([{ id: 'value', kind: 'literal', pointer: '/value', expected: true }])).status, 'incomplete');
  const staged = await fixture(t, { state: 'completed', summary: '{"value":true}', nextSteps: '' }, { planning: { executionMode: 'budgeted' } });
  const result = await staged.run([{ id: 'value', kind: 'literal', pointer: '/value', expected: true }]);
  assert.equal(result.status, 'checks_passed');
});

test('JSON pointers use own properties and explicit escapes; arithmetic never silently overflows', async t => {
  const f = await fixture(t, '{"a/b":{"~key":4},"huge":1,"decimal":0.3}');
  const result = await f.run([
    { id: 'escaped', kind: 'literal', pointer: '/a~1b/~0key', expected: 4 },
    { id: 'prototype', kind: 'literal', pointer: '/constructor', expected: null },
    { id: 'overflow', kind: 'arithmetic', pointer: '/huge', operator: 'product', operands: [1e308, 1e308] },
    { id: 'intermediate-overflow', kind: 'arithmetic', pointer: '/huge', operator: 'sum', operands: [Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER] },
    { id: 'decimal-exact', kind: 'arithmetic', pointer: '/decimal', operator: 'sum', operands: [0.1, 0.2] },
    { id: 'decimal-tolerance', kind: 'arithmetic', pointer: '/decimal', operator: 'sum', operands: [0.1, 0.2], absoluteTolerance: 1e-12 },
  ]);
  assert.deepEqual(result.items.map(x => x.status), ['PASS', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'FAIL', 'PASS']);
});

test('binary, invalid UTF-8 and oversized evidence remain unknown without echoing bytes', async t => {
  const f = await fixture(t, { claim: { startLine: 1, endLine: 1, quote: 'private-file-marker' } });
  const sources = [await f.source('binary.txt', Buffer.from([65, 0, 66])),
    await f.source('invalid.txt', Buffer.from([0xff, 0xfe])), await f.source('large.txt', 'a'.repeat(262145))];
  const result = await f.run(sources.map((source, i) => ({ id: `source-${i}`, kind: 'source-quote', pointer: '/claim', source })));
  assert.deepEqual(result.items.map(x => x.status), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.equal(JSON.stringify(result).includes('private-file-marker'), false);
});

test('fractional operands do not disable integer guards and product underflow stays unknown', async t => {
  const f = await fixture(t, { rounded: 1.5, small: 0, valid: 2.5 });
  const result = await f.run([
    { id: 'mixed-overflow', kind: 'arithmetic', pointer: '/rounded', operator: 'sum', operands: [Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER, 0.5] },
    { id: 'mixed-control', kind: 'arithmetic', pointer: '/valid', operator: 'sum', operands: [1, 2, -1, 0.5] },
    { id: 'underflow', kind: 'arithmetic', pointer: '/small', operator: 'product', operands: [1e-300, 1e-300] },
    { id: 'zero-control', kind: 'arithmetic', pointer: '/small', operator: 'product', operands: [0, 1e-300] },
  ]);
  assert.deepEqual(result.items.map(x => x.status), ['UNKNOWN', 'PASS', 'UNKNOWN', 'PASS']);
});

test('invalid or duplicate check contracts reject before result/file observation and suppress private inputs', async () => {
  let observations = 0;
  const call = async () => { observations++; throw new Error('must not observe'); };
  const check = { id: 'A', kind: 'literal', pointer: '/a', expected: true };
  for (const checks of [[], [check, check], [{ ...check, pointer: 'private-invalid-pointer' }], [{ ...check, unexpected: 'private-value' }]]) {
    await assert.rejects(checkSavedResult(call, { taskId: randomUUID(), attempt: 1, checks }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(JSON.stringify(error).includes('private-'), false);
      return true;
    });
  }
  assert.equal(observations, 0);
});
