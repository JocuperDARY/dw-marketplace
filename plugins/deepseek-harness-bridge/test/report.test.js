import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import Ajv from 'ajv';
import { normalizeReportContract, reportContractSchema, reportPrompt, assessReport } from '../src/report.js';
import { planExecution } from '../src/planning.js';
import { safeError } from '../src/errors.js';

const reportContract = { facts: [
  { id: 'work_seconds', kind: 'limit', value: 180, unit: 'seconds', source: 'stage-start.json:limits_proposal.work_seconds' },
  { id: 'tests', kind: 'execution-status', value: 'NOT_RUN', unit: '', source: 'stage-start.json:tests' },
] };
const assess = value => assessReport(JSON.stringify(value), reportContract, { status: 'completed' });

test('published report schema agrees with runtime for execution-status scalar types', () => {
  const validate = new Ajv().compile(z.toJSONSchema(reportContractSchema, { target: 'draft-7' }));
  for (const value of [0, false, null, '', ' \t\n']) {
    const input = { facts: [{ ...reportContract.facts[1], value }] };
    assert.equal(validate(input), false, `published schema must reject status ${JSON.stringify(value)}`);
    assert.equal(reportContractSchema.safeParse(input).success, false);
    assert.throws(() => normalizeReportContract(input), { code: 'INVALID_ARGUMENT' });
  }
});

test('published report schema preserves scalar values and rejects invalid kinds and source locators', () => {
  const validate = new Ajv().compile(z.toJSONSchema(reportContractSchema, { target: 'draft-7' }));
  const validFacts = [
    { ...reportContract.facts[0], value: 0 },
    { ...reportContract.facts[0], kind: 'observation', value: false },
    { ...reportContract.facts[0], kind: 'observation', value: null },
    { ...reportContract.facts[0], kind: 'observation', value: '' },
    { ...reportContract.facts[1], value: ' NOT_RUN ', source: ' source.json:tests ' },
  ];
  for (const fact of validFacts) {
    const input = { facts: [fact] };
    assert.equal(validate(input), true, JSON.stringify(validate.errors));
    assert.deepEqual(normalizeReportContract(input), input);
    assert.equal(assessReport(JSON.stringify({ ...input, prose: 'Supplied fact retained.' }), input, { status: 'completed' }).status, 'facts_preserved');
  }
  const invalidFacts = [
    { ...reportContract.facts[0], kind: undefined },
    { ...reportContract.facts[0], kind: 'executed' },
    { ...reportContract.facts[0], source: '' },
    { ...reportContract.facts[0], source: ' \t\r\n' },
    { ...reportContract.facts[0], value: {} },
    { ...reportContract.facts[0], value: Infinity },
  ];
  for (const fact of invalidFacts) {
    const input = { facts: [fact] };
    assert.equal(validate(input), false);
    assert.equal(reportContractSchema.safeParse(input).success, false);
    assert.throws(() => normalizeReportContract(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(normalizeReportContract(undefined), null);
});

test('unrepresentable report checks remain explicit and enforce unique IDs and exact UTF-8 byte bounds', () => {
  const schema = z.toJSONSchema(reportContractSchema, { target: 'draft-7' });
  const validate = new Ajv().compile(schema);
  assert.match(schema.description, /unique facts\[\]\.id/);
  assert.match(schema.description, /16384 UTF-8 bytes/);
  const duplicate = { facts: [reportContract.facts[0], { ...reportContract.facts[0], value: 0 }] };
  assert.equal(validate(duplicate), true);
  assert.throws(() => normalizeReportContract(duplicate), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(safeError(error).validation, { phase: 'contract', issues: [{
      path: ['reportContract', 'facts', 1, 'id'], code: 'duplicate_id', message: 'Fact IDs must be unique.',
    }] });
    return true;
  });
  const boundary = { facts: Array.from({ length: 8 }, (_, index) => ({
    id: `f${index}`, kind: 'observation', value: 'x'.repeat(1920), unit: '', source: 's',
  })) };
  const prefixBytes = Buffer.byteLength(JSON.stringify(boundary), 'utf8');
  boundary.facts[0].source += 'x'.repeat(16384 - prefixBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), 'utf8'), 16384);
  assert.deepEqual(normalizeReportContract(boundary), boundary);
  const over = structuredClone(boundary);
  over.facts[0].source += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), 16385);
  const multibyte = structuredClone(boundary);
  multibyte.facts[0].source = `界${multibyte.facts[0].source.slice(1)}`;
  assert.equal(JSON.stringify(multibyte).length, JSON.stringify(boundary).length);
  assert.equal(Buffer.byteLength(JSON.stringify(multibyte), 'utf8'), 16386);
  for (const input of [over, multibyte]) {
    assert.equal(validate(input), true);
    assert.throws(() => normalizeReportContract(input), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(safeError(error).validation, { phase: 'contract', issues: [{
        path: ['reportContract'], code: 'utf8_size_limit', message: 'Report contract must not exceed 16384 UTF-8 bytes.',
      }] });
      return true;
    });
  }
});

test('report contract diagnostics locate fields without echoing rejected input', () => {
  const secret = 'private-input-marker';
  for (const [field, rejected, path] of [
    ['value', { secret }, ['reportContract', 'facts', 0, 'value']],
    ['source', { secret }, ['reportContract', 'facts', 0, 'source']],
    ['kind', secret, ['reportContract', 'facts', 0, 'kind']],
  ]) {
    assert.throws(() => normalizeReportContract({ facts: [{ ...reportContract.facts[1], [field]: rejected }] }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      const serialized = safeError(error);
      assert.equal(serialized.validation.phase, 'contract');
      assert.ok(serialized.validation.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path)));
      assert.equal(JSON.stringify(serialized).includes(secret), false);
      return true;
    });
  }
});

test('report output still rejects malformed status facts and whitespace-only source locators', () => {
  for (const value of [0, false, null, '', ' \t\n']) {
    assert.equal(assess({ facts: [reportContract.facts[0], { ...reportContract.facts[1], value }], prose: 'Test state.' }).status, 'mismatch');
  }
  assert.equal(assess({ facts: reportContract.facts.map(fact => ({ ...fact, source: ' \t\n' })), prose: 'Test state.' }).status, 'mismatch');
});

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
