import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDelivery, deliveryPrompt, normalizeReviewContract } from '../src/delivery.js';
import { contract, correct, wrongDraft } from './fixtures/verification-data.js';

const assess = value => assessDelivery(JSON.stringify(value), contract, { status: 'completed' });

test('review contract requires bounded unique IDs and explicit check coverage', () => {
  assert.equal(normalizeReviewContract(undefined), null);
  assert.deepEqual(normalizeReviewContract(contract), contract);
  for (const value of [null, {}, { ...contract, caseIds: [] }, { ...contract, caseIds: ['A', 'A'] },
    { ...contract, ruleIds: ['bad\nrule'] }, { ...contract, checkIds: ['A', 'A'] }, { ...contract, caseIds: Array.from({ length: 65 }, (_, i) => `C${i}`) },
    { ...contract, checkIds: undefined }, { ...contract, accepted: true }]) {
    assert.throws(() => normalizeReviewContract(value), { code: 'INVALID_ARGUMENT' });
  }
});

test('delivery requires exact cases, checks, known rules and per-item factual basis', () => {
  assert.equal(assess(correct).status, 'structure_complete');
  const variants = [
    value => value.cases.pop(),
    value => value.cases.push(structuredClone(value.cases[0])),
    value => { value.cases[0].id = 'EXTRA'; },
    value => { value.cases[0].ruleIds = ['UNKNOWN']; },
    value => { delete value.cases[0].basis; },
    value => { value.cases[0].basis = '  '; },
    value => { value.checks = []; },
    value => value.checks.push(structuredClone(value.checks[0])),
    value => { value.checks[0].id = 'OTHER_SUM'; },
    value => { delete value.checks[0].result; },
    value => { value.accepted = true; },
  ];
  for (const mutate of variants) {
    const value = structuredClone(correct);
    mutate(value);
    const report = assess(value);
    assert.equal(report.status, 'incomplete');
    assert.ok(report.issueCount > 0);
    assert.equal(report.scope, 'structure_only');
  }
});

test('historical failure shape detects omission but does not certify wrong classification or thresholds', () => {
  const wrong = wrongDraft();
  assert.ok(assess(wrong).issues.some(issue => issue.code === 'MISSING_ID' && issue.path === 'checks.CACHE_SUM'));
  wrong.checks = structuredClone(correct.checks);
  assert.equal(assess(wrong).status, 'structure_complete');
  // Independent parent expectations still reject these substantive errors.
  assert.notEqual(wrong.cases.find(entry => entry.id === 'C06').classification, 'scratch');
  assert.ok(!wrong.cases.find(entry => entry.id === 'C05').basis.includes('64 MiB'));
  assert.equal(Object.hasOwn(assess(wrong), 'accepted'), false);
});

test('partial/fenced JSON is not repaired and noncompleted output is not assessed as a final delivery', () => {
  for (const text of ['{"cases":', '```json\n{}\n```', '{}', 'null']) {
    assert.equal(assessDelivery(text, contract, { status: 'completed' }).status, 'incomplete');
  }
  for (const status of ['failed', 'paused', 'timed_out', 'cleanup_failed', 'cancelled']) {
    assert.equal(assessDelivery(JSON.stringify(correct), contract, { status }).status, 'not_evaluated');
  }
  assert.equal(assessDelivery('legacy result', undefined, { status: 'completed' }).status, 'not_requested');
});

test('orchestrated delivery checks the completed summary, not checkpoint progress', () => {
  const text = JSON.stringify({ state: 'completed', summary: JSON.stringify(correct), nextSteps: '' });
  assert.equal(assessDelivery(text, contract, { status: 'completed', orchestrated: true }).status, 'structure_complete');
  const checkpoint = JSON.stringify({ state: 'checkpoint', summary: JSON.stringify(correct), nextSteps: 'more' });
  assert.equal(assessDelivery(checkpoint, contract, { status: 'paused', orchestrated: true }).status, 'not_evaluated');
  assert.equal(assessDelivery(checkpoint, contract, { status: 'completed', orchestrated: true }).status, 'incomplete');
});

test('delivery prompt keeps ordinary tasks byte-identical and asks for evidence without granting retries', () => {
  assert.equal(deliveryPrompt('original', null, false), 'original');
  const prompt = deliveryPrompt('original rules', contract, true);
  assert.ok(prompt.startsWith('original rules'));
  for (const required of ['classification, exception eligibility', 'anchored path boundaries', 'not private chain-of-thought', 'exact case/check coverage', 'summary string', 'No extra model request']) assert.ok(prompt.includes(required), required);
});
