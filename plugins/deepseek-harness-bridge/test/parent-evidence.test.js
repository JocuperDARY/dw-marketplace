import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSavedResult } from '../src/parent-evidence.js';
import { WorkspaceFiles } from '../src/workspace.js';

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

for (const corrected of [false, true]) test(`implementation test accounting keeps evidence levels separate (${corrected ? 'correct control' : 'inflated claims'})`, async t => {
  // Anonymous synthetic counterexample; these are parent-declared facts, not
  // test totals inferred from prose or a claim of scientific acceptance.
  const draft = {
    uniqueMethods: corrected ? 115 : 117, executions: 117, errorRecords: 5,
    finalFullRun: !corrected, workerExecuted: !corrected,
    firstRun: { identity: 'full-1', status: corrected ? 'failed' : 'succeeded' },
    targetedRerun: { identity: 'affected-2', status: 'succeeded' },
    gradients: { identity: 'gradient-probe', status: 'succeeded' },
  };
  const original = JSON.stringify(draft);
  const f = await fixture(t, original);
  const first = await f.source('full-1.json', '{"runId":"full-1","exitCode":1}');
  const rerun = await f.source('affected-2.json', '{"runId":"affected-2","exitCode":0}');
  const execution = (id, pointer, receipt, identity) => ({ id, kind: 'execution', pointer, receipt,
    identity: { pointer: '/runId', expected: identity }, exitCodePointer: '/exitCode' });
  const result = await f.run([
    { id: 'unique-methods', kind: 'literal', pointer: '/uniqueMethods', expected: 115 },
    { id: 'executions', kind: 'arithmetic', pointer: '/executions', operands: [115, 2], operator: 'sum' },
    { id: 'error-records', kind: 'literal', pointer: '/errorRecords', expected: 5 },
    { id: 'final-full-run', kind: 'literal', pointer: '/finalFullRun', expected: false },
    { id: 'worker-execution', kind: 'literal', pointer: '/workerExecuted', expected: false },
    execution('original-failure', '/firstRun', first, 'full-1'),
    execution('targeted-pass', '/targetedRerun', rerun, 'affected-2'),
    execution('missing-gradient-evidence', '/gradients', { path: 'absent.json', sha256: 'a'.repeat(64) }, 'gradient-probe'),
    { id: 'shape-and-gradient-correctness', kind: 'manual', reason: 'semantic' },
    { id: 'scientific-acceptance', kind: 'manual', reason: 'scientific' },
  ]);
  const claim = corrected ? 'PASS' : 'FAIL';
  assert.deepEqual(result.items.map(item => item.status), [claim, 'PASS', 'PASS', claim, claim, claim, 'PASS', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.equal(result.status, corrected ? 'incomplete' : 'checks_failed');
  assert.equal(result.parentAcceptance, 'not_assessed');
  assert.equal(result.sourceAuthority, 'not_assessed');
  assert.ok(f.calls.every(request => request.name === 'dsh_result'));
  const preserved = await f.callTool({ name: 'dsh_result', arguments: { taskId: f.taskId, attempt: 1, offset: 0, limit: 32000 } });
  assert.equal(preserved.text, original);
  assert.equal(await readFile(join(f.workspace, 'full-1.json'), 'utf8'), '{"runId":"full-1","exitCode":1}');
});

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
  await mkdir(join(f.workspace, 'source-dir'));
  await writeFile(join(f.workspace, 'source-dir', 'ordinary.txt'), 'private-file-marker');
  await symlink(join(f.workspace, 'source-dir'), join(f.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const paths = ['.env', '../outside.txt', join(f.workspace, '.env'), 'alias/ordinary.txt'];
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
  ['pending lease', { leasePending: true }],
  ['unconfirmed persistence', { durability: 'unconfirmed' }],
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

test('JSON exponent overflow is rejected before any observation by the installed Zod schema', async () => {
  const checks = JSON.parse('[{"id":"infinite","kind":"arithmetic","pointer":"/value","operator":"sum","operands":[1],"absoluteTolerance":1e999}]');
  assert.equal(checks[0].absoluteTolerance, Infinity);
  await assert.rejects(checkSavedResult(() => assert.fail('must not observe'), { taskId: randomUUID(), attempt: 1, checks }), { code: 'INVALID_ARGUMENT' });
});

test('source quotes preserve a leading BOM; only newline conventions are normalized', async t => {
  const f = await fixture(t, { omitted: { startLine: 1, endLine: 1, quote: 'alpha' }, exact: { startLine: 1, endLine: 1, quote: '\uFEFFalpha' } });
  const source = await f.source('bom.txt', '\uFEFFalpha\r\nbeta');
  const result = await f.run(['omitted', 'exact'].map(id => ({ id, kind: 'source-quote', pointer: '/'+id, source })));
  assert.deepEqual(result.items.map(x => x.status), ['FAIL', 'PASS']);
});

test('evidence read rejects a parent directory swapped for a junction after resolution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-evidence-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const outside = join(root, 'outside');
  await mkdir(workspace); await mkdir(outside); await mkdir(join(workspace, 'parent'));
  await writeFile(join(workspace, 'parent', 'evidence.json'), '{"inside":true}');
  await writeFile(join(outside, 'evidence.json'), '{"private":true}');
  const files = new WorkspaceFiles({ workspace, access: 'read-only' });
  const read = files.readBytes.bind(files);
  let swaps = 0;
  files.readBytes = async (target, verify) => {
    swaps++;
    await rename(join(workspace, 'parent'), join(workspace, 'saved-parent'));
    await symlink(outside, join(workspace, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
    return read(target, verify);
  };
  await assert.rejects(files.readEvidence('parent/evidence.json'), { code: 'PATH_DENIED' });
  assert.equal(swaps, 1);
});
