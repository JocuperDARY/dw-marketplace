import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportContract, reportPrompt, assessReport } from '../src/report.js';
import { planExecution } from '../src/planning.js';

const reportContract = { facts: [
  { id: 'work_seconds', kind: 'limit', value: 180, unit: 'seconds', source: 'stage-start.json:limits_proposal.work_seconds' },
  { id: 'tests', kind: 'execution-status', value: 'NOT_RUN', unit: '', source: 'stage-start.json:tests' },
] };
const assess = value => assessReport(JSON.stringify(value), reportContract, { status: 'completed' });

test('report facts preserve roles, types, units, source locators and complete coverage', () => {
  const good = { ...structuredClone(reportContract), prose: '预算上限 180 秒；测试尚未执行。' };
  assert.equal(assess(good).status, 'facts_preserved');
  for (const [field, value] of [['kind', 'observation'], ['value', '180'], ['unit', 'ms'], ['source', 'invented']]) {
    const bad = structuredClone(good); bad.facts[0][field] = value;
    assert.equal(assess(bad).status, 'mismatch', field);
  }
  assert.equal(assess({ ...good, facts: good.facts.slice(1) }).status, 'mismatch');
  assert.equal(assess({ ...good, facts: [...good.facts, good.facts[0]] }).status, 'mismatch');
  assert.equal(assess({ ...good, facts: [...good.facts].reverse() }).status, 'facts_preserved');
  assert.equal(assess({ ...good, accepted: true }).status, 'mismatch');
});

test('copied facts cannot certify false prose or runtime completion as acceptance', () => {
  const falseProse = assess({ ...reportContract, prose: '本次实际耗时 180 秒，测试已完成。' });
  assert.equal(falseProse.status, 'facts_preserved');
  assert.equal(falseProse.scope, 'literal_facts_only');
  assert.equal(falseProse.proseAcceptance, 'not_assessed');
  assert.equal(assessReport('{}', reportContract, { status: 'failed' }).status, 'not_evaluated');
  assert.equal(assessReport('{}', null, { status: 'completed' }).status, 'not_requested');
});

test('report checking parses whole JSON and only the completed summary', () => {
  const payload = JSON.stringify({ ...reportContract, prose: '未执行；180 秒为上限。' });
  assert.equal(assessReport(`prefix ${payload}`, reportContract, { status: 'completed' }).status, 'mismatch');
  assert.equal(assessReport(JSON.stringify({ state: 'completed', summary: payload, nextSteps: '' }), reportContract, { status: 'completed', orchestrated: true }).status, 'facts_preserved');
  assert.equal(assessReport(JSON.stringify({ state: 'checkpoint', summary: payload }), reportContract, { status: 'completed', orchestrated: true }).status, 'mismatch');
  const prompt = reportPrompt('Write a report.', reportContract, true);
  assert.match(prompt, /never measured/);
  assert.match(prompt, /Worker-writing instructions/);
  assert.match(prompt, /summary/);
});

test('report planning is explicit, bounded and backwards compatible', () => {
  const input = { executionMode: 'single-request', reportContract };
  const plan = planExecution(input);
  assert.equal(plan.workload, 'drafting');
  assert.equal(plan.effort, 'off');
  assert.equal(plan.outputFormat, 'json-object');
  assert.equal(planExecution({ ...input, effort: 'high', maxTokens: 1024 }).maxTokens, 1024);
  assert.throws(() => planExecution({ ...input, outputFormat: 'text' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => planExecution({ ...input, reviewContract: { caseIds: ['C'], ruleIds: ['R'], checkIds: [] } }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeReportContract({ facts: [reportContract.facts[0], reportContract.facts[0]] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeReportContract({ facts: [{ ...reportContract.facts[1], value: null }] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeReportContract({ facts: Array.from({ length: 64 }, (_, i) => ({ ...reportContract.facts[0], id: `f${i}`, source: 'x'.repeat(512) })) }), { code: 'INVALID_ARGUMENT' });
});
