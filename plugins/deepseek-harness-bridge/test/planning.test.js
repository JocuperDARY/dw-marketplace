import test from 'node:test';
import assert from 'node:assert/strict';
import { planExecution } from '../src/planning.js';
import { allocateStage } from '../src/orchestration.js';

const budget = { totalModelRequests: 6, totalOutputTokens: 24576, totalToolCalls: 4, totalDurationMs: 60000 };
const reviewContract = { caseIds: ['C06'], ruleIds: ['SCRATCH', 'AUDIT'], checkIds: ['SUM'] };

test('rule verification selects reasoning without inventing output limits and requires coverage', () => {
  const plan = planExecution({ budget, workload: 'verification', reviewContract });
  assert.equal(plan.effort, 'high');
  assert.equal(plan.maxTokens, null);
  assert.deepEqual(plan.reviewContract, reviewContract);
  assert.equal(planExecution({ budget, reviewContract }).workload, 'verification');
  assert.throws(() => planExecution({ budget, workload: 'verification' }), { code: 'REVIEW_CONTRACT_REQUIRED' });
});

test('verification warnings preserve authorized overrides rather than increasing caps or retrying', () => {
  for (const effort of ['off', 'low']) {
    const plan = planExecution({ budget, reviewContract, effort, maxTokens: 4096, maxModelRequests: 2 });
    assert.equal(plan.effort, effort);
    assert.equal(plan.maxTokens, 4096);
    assert.equal(plan.maxModelRequests, 2);
    assert.deepEqual(plan.budget, budget);
    assert.match(plan.warnings.join(' '), /verification/i);
  }
  assert.match(planExecution({ budget, reviewContract, workload: 'mechanical' }).warnings.join(' '), /mechanical/i);
});

test('omitted totals do not block assigned work; explicit one-request constraints remain', () => {
  assert.equal(planExecution({}).executionMode, 'automatic');
  assert.equal(planExecution({ maxModelRequests: 1 }).maxModelRequests, 1);
  const single = planExecution({ executionMode: 'single-request', workload: 'mechanical' });
  assert.equal(single.maxModelRequests, 1);
  assert.equal(single.maxToolCalls, 0);
  assert.equal(single.capabilityProfile, 'inference-only');
  assert.equal(single.effort, 'off');
  for (const extra of [{ maxModelRequests: 2 }, { maxToolCalls: 1 }, { budget }, { capabilityProfile: 'files' }, { access: 'workspace-write' }]) {
    assert.throws(() => planExecution({ executionMode: 'single-request', ...extra }), { code: 'INVALID_ARGUMENT' });
  }
});

test('workload selects suitable effort without supplying token caps', () => {
  for (const [workload, effort] of [['mechanical', 'off'], ['standard', 'low'], ['reasoning', 'high']]) {
    const plan = planExecution({ workload, budget });
    assert.equal(plan.effort, effort);
    assert.equal(plan.maxTokens, null);
    assert.deepEqual(plan.budget, budget);
  }
  const explicit = planExecution({ budget, effort: 'high', maxTokens: 2048 });
  assert.equal(explicit.maxTokens, 2048);
  assert.equal(explicit.effort, 'high');
  assert.match(explicit.warnings.join(' '), /reasoning/i);
});

test('stage reserves a small checkpoint while allocating work from the actual remaining total', () => {
  const record = { maxTokens: 16384, maxModelRequests: 6, maxToolCalls: 4,
    orchestration: { authorized: budget, deadlineAt: Date.now() + 60000, stages: [] } };
  const allocation = allocateStage(record, 30000);
  assert.equal(allocation.maxTokens, 16384);
  assert.equal(allocation.checkpointTokens, 2048);
  assert.equal(allocation.outputTokens, 24576);
  assert.ok(allocation.maxTokens + allocation.checkpointTokens <= allocation.outputTokens);
});

test('legacy replay normalization retains the original defaults without granting new totals', () => {
  const plan = planExecution({}, { legacy: true });
  assert.equal(plan.effort, 'high');
  assert.equal(plan.maxModelRequests, 16);
  assert.equal(plan.maxTokens, 8192);
  assert.equal(plan.budget, null);
  assert.equal(planExecution({ capabilityProfile: 'inference-only' }, { legacy: true }).maxToolCalls, 32);
});
