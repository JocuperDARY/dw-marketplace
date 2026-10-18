import test from 'node:test';
import assert from 'node:assert/strict';
import { planExecution } from '../src/planning.js';
import { allocateStage } from '../src/orchestration.js';

const budget = { totalModelRequests: 6, totalOutputTokens: 24576, totalToolCalls: 4, totalDurationMs: 60000 };
const reviewContract = { caseIds: ['C06'], ruleIds: ['SCRATCH', 'AUDIT'], checkIds: ['SUM'] };

test('rule verification selects reasoning headroom and requires an explicit coverage contract', () => {
  const plan = planExecution({ budget, workload: 'verification', reviewContract });
  assert.equal(plan.effort, 'high');
  assert.equal(plan.maxTokens, 16384);
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

test('new tasks require total authorization unless explicitly selecting one inference request', () => {
  assert.throws(() => planExecution({}), { code: 'BUDGET_REQUIRED' });
  assert.throws(() => planExecution({ maxModelRequests: 1 }), { code: 'BUDGET_REQUIRED' });
  const single = planExecution({ executionMode: 'single-request', workload: 'mechanical' });
  assert.equal(single.maxModelRequests, 1);
  assert.equal(single.maxToolCalls, 0);
  assert.equal(single.capabilityProfile, 'inference-only');
  assert.equal(single.effort, 'off');
  for (const extra of [{ maxModelRequests: 2 }, { maxToolCalls: 1 }, { budget }, { capabilityProfile: 'files' }, { access: 'workspace-write' }]) {
    assert.throws(() => planExecution({ executionMode: 'single-request', ...extra }), { code: 'INVALID_ARGUMENT' });
  }
});

test('workload selects suitable effort and request headroom without overriding explicit caps', () => {
  for (const [workload, effort, maxTokens] of [['mechanical', 'off', 4096], ['standard', 'low', 8192], ['reasoning', 'high', 16384]]) {
    const plan = planExecution({ workload, budget });
    assert.equal(plan.effort, effort);
    assert.equal(plan.maxTokens, maxTokens);
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
