import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessLifecycle, normalizeLifecycleContract, lifecyclePrompt } from '../src/lifecycle.js';
import { planExecution } from '../src/planning.js';

const contract = JSON.parse(await readFile(new URL('./fixtures/lifecycle-contract.json', import.meta.url), 'utf8'));
const original = JSON.parse(await readFile(new URL('./fixtures/lifecycle-failure.json', import.meta.url), 'utf8'));
const raw = JSON.parse(original.text);
function corrected() {
  const output = structuredClone(raw);
  output.rows[2].status = 'unknown';
  output.status_counts.closed = 1;
  output.status_counts.unknown = 2;
  output.caveats = ['S3 uses the explicitly declared parent fallback; this does not establish real runtime state.'];
  return output;
}
const assess = (value, expected = contract) => assessLifecycle(JSON.stringify(value), expected, { status: 'completed' });

test('original contradiction fails its declared S3 outcome even though row counts agree', () => {
  const result = assess(raw);
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.issues, [{ code: 'STATUS_NOT_ALLOWED', path: 'rows.S3.status' }]);
  assert.equal(result.proseAcceptance, 'not_assessed');
  assert.equal(assess(corrected()).status, 'consistent');
  assert.equal(raw.rows[2].status, 'closed');
});

test('row coverage, order, statuses, booleans and all counts are checked independently', async t => {
  const mutations = [
    ['missing row', value => value.rows.pop(), 'MISSING_ID'],
    ['duplicate row', value => value.rows.push(value.rows[0]), 'DUPLICATE_ID'],
    ['unexpected row', value => { value.rows[0].id = 'extra'; }, 'UNEXPECTED_ID'],
    ['row order', value => value.rows.reverse(), 'ORDER_MISMATCH'],
    ['unknown status', value => { value.rows[0].status = 'invented'; }, 'UNKNOWN_STATUS'],
    ['wrong reuse', value => { value.rows[2].slot_reusable = true; }, 'SLOT_REUSE_MISMATCH'],
    ['string boolean', value => { value.rows[2].slot_reusable = 'false'; }, 'INVALID_SHAPE'],
    ['stale count after row correction', value => { value.status_counts.closed = 2; }, 'COUNT_MISMATCH'],
    ['missing count', value => { delete value.status_counts.live; }, 'MISSING_COUNT'],
    ['invented count', value => { value.status_counts.invented = 0; }, 'UNEXPECTED_COUNT'],
    ['negative count', value => { value.status_counts.closed = -1; }, 'INVALID_SHAPE'],
    ['fractional count', value => { value.status_counts.closed = 1.5; }, 'INVALID_SHAPE'],
    ['string count', value => { value.status_counts.closed = '1'; }, 'INVALID_SHAPE'],
    ['self certified acceptance', value => { value.accepted = true; }, 'INVALID_SHAPE'],
  ];
  for (const [name, mutate, code] of mutations) await t.test(name, () => {
    const value = corrected(); mutate(value);
    const result = assess(value);
    assert.equal(result.status, 'mismatch');
    assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result));
  });
  const expected = { ...contract, statuses: [...contract.statuses, 'unused'] };
  assert.equal(assess(corrected(), expected).status, 'mismatch');
  const withZero = corrected(); withZero.status_counts.unused = 0;
  assert.equal(assess(withZero, expected).status, 'consistent');
});

test('matching declarations does not validate prose, source truth or a universal lifecycle policy', () => {
  const falseProse = corrected();
  falseProse.caveats = ['S3 is closed and its slot is reusable.'];
  const result = assess(falseProse);
  assert.equal(result.status, 'consistent');
  assert.equal(result.scope, 'declared_lifecycle_outcomes');
  assert.equal(result.proseAcceptance, 'not_assessed');
  const wrongParent = structuredClone(contract);
  wrongParent.cases[2].allowedStatuses = ['closed'];
  assert.equal(assess(raw, wrongParent).status, 'consistent');
  const ambiguous = structuredClone(contract);
  ambiguous.cases[2].allowedStatuses = ['unknown', 'submitted'];
  const allowed = corrected(); allowed.rows[2].status = 'submitted';
  allowed.status_counts.unknown--; allowed.status_counts.submitted++;
  assert.equal(assess(allowed, ambiguous).status, 'consistent');
});

test('strict whole-object and completed summary parsing preserve failure states', () => {
  const value = JSON.stringify(corrected());
  for (const bad of ['prefix ' + value, value + value, '```json\n' + value + '\n```', 'null', '[]', JSON.stringify(value), value.slice(0, -1)]) {
    assert.equal(assessLifecycle(bad, contract, { status: 'completed' }).status, 'mismatch');
  }
  const wrapped = JSON.stringify({ state: 'completed', summary: value, nextSteps: '' });
  assert.equal(assessLifecycle(wrapped, contract, { status: 'completed', orchestrated: true }).status, 'consistent');
  assert.equal(assessLifecycle(JSON.stringify({ state: 'checkpoint', summary: value }), contract, { status: 'completed', orchestrated: true }).status, 'mismatch');
  assert.equal(assessLifecycle(value, contract, { status: 'cleanup_failed' }).status, 'not_evaluated');
  assert.equal(assessLifecycle(value, null, { status: 'completed' }).status, 'not_requested');
});

test('contracts reject missing fallbacks, invalid declarations and unbounded payloads before launch', () => {
  assert.deepEqual(normalizeLifecycleContract(contract), contract);
  const invalid = [
    null, {}, { ...contract, statuses: [] }, { ...contract, statuses: ['closed', 'closed'] },
    { ...contract, cases: [contract.cases[0], contract.cases[0]] },
    { ...contract, cases: [{ ...contract.cases[0], allowedStatuses: [] }] },
    { ...contract, cases: [{ ...contract.cases[0], allowedStatuses: ['invented'] }] },
    { ...contract, cases: [{ ...contract.cases[0], allowedStatuses: ['closed', 'closed'] }] },
    { ...contract, cases: [{ ...contract.cases[0], slotReusable: 'true' }] },
    { ...contract, cases: [{ ...contract.cases[0], basis: ' ' }] },
    { ...contract, cases: [{ ...contract.cases[0], basis: undefined }] },
    { ...contract, cases: Array.from({ length: 65 }, (_, i) => ({ ...contract.cases[0], id: 'C' + i })) },
    { ...contract, cases: Array.from({ length: 64 }, (_, i) => ({ ...contract.cases[0], id: 'C' + i, basis: 'x'.repeat(2048) })) },
    { ...contract, extraAuthority: true },
  ];
  for (const value of invalid) assert.throws(() => normalizeLifecycleContract(value), { code: 'INVALID_ARGUMENT' });
});

test('lifecycle planning defaults to verification, preserves explicit caps and rejects conflicting contracts', () => {
  const input = { executionMode: 'single-request', lifecycleContract: contract };
  const planned = planExecution(input);
  assert.equal(planned.workload, 'verification');
  assert.equal(planned.effort, 'high');
  assert.equal(planned.outputFormat, 'json-object');
  const explicit = planExecution({ ...input, workload: 'mechanical', effort: 'off', maxTokens: 2048 });
  assert.equal(explicit.workload, 'mechanical');
  assert.equal(explicit.effort, 'off');
  assert.equal(explicit.maxTokens, 2048);
  assert.equal(explicit.maxModelRequests, 1);
  assert.equal(explicit.maxToolCalls, 0);
  assert.match(explicit.warnings.join(' '), /mechanical/);
  assert.match(explicit.warnings.join(' '), /off setting is preserved/);
  assert.throws(() => planExecution({ ...input, outputFormat: 'text' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => planExecution({ ...input, reviewContract: { caseIds: ['C'], ruleIds: ['R'], checkIds: [] } }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => planExecution({ ...input, reportContract: { facts: [{ id: 'F', kind: 'limit', value: 1, unit: 's', source: 'fixture' }] } }), { code: 'INVALID_ARGUMENT' });
  const prompt = lifecyclePrompt('Classify.', contract, true);
  assert.match(prompt, /accepted completion without confirmed cleanup/);
  assert.match(prompt, /separate from this worker/);
  assert.match(prompt, /caveat must not negate/);
  assert.match(prompt, /summary string/);
});
