import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage } from '../src/usage.js';

const call = (outputTokens, extras = {}) => ({ number: 1, finished: true, usage: { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens, reasoningTokens: 2, ...extras } });
const receipt = (nonce, outputTokens) => ({ nonce, modelRequests: 1, calls: [call(outputTokens)] });
const stage = (number, budget) => ({ number, attempt: 1, nonce: `n${number}`, status: 'completed', budget, charged: { modelRequests: 1, outputTokens: 256, toolCalls: 0 } });

test('an unbounded interrupted reservation stays unknown instead of becoming zero', () => {
  const unknown = { ...stage(1), charged: { modelRequests: null, outputTokens: null, toolCalls: null } };
  const record = { attempts: [{ number: 1, status: 'interrupted' }], orchestration: { stages: [unknown, stage(2)] } };
  assert.deepEqual(summarizeUsage([record]).orchestrationCharged, { modelRequests: null, outputTokens: null, toolCalls: null });
});

test('usage aggregates every stage once, including recovery, without repeating attempt tails', () => {
  const last = receipt('n2', 7);
  const record = { attempts: [{ number: 1, status: 'completed', budget: last }], orchestration: { stages: [stage(1, receipt('n1', 5)), { ...stage(2, last), purpose: 'format-recovery' }] } };
  const r = summarizeUsage([record]);
  assert.equal(r.recordedModelRequests, 2);
  assert.equal(r.tokens.outputTokens.reported, 12);
  assert.equal(r.tokens.totalTokens.reported, 32);
  assert.equal(r.tokens.reasoningTokens.reported, 4);
  assert.equal(r.tokens.cacheReadTokens.missingCalls, 2);
  assert.equal(r.orchestrationCharged.outputTokens, 512);
  assert.equal(r.unknownReceiptGroups, 0);
  assert.equal(r.cost, null);
  assert.equal(r.modelCallsPerformed, 0);
});

test('legacy missing stages stay unknown; only nonce-matched tail receipts are recovered', () => {
  const record = { attempts: [{ number: 1, status: 'completed', budget: receipt('n2', 7) }], orchestration: { stages: [stage(1), stage(2)] } };
  const r = summarizeUsage([record]);
  assert.equal(r.unknownReceiptGroups, 1);
  assert.equal(r.recordedModelRequests, 1);
  assert.equal(r.tokens.outputTokens.reported, 7);
  record.attempts[0].budget.nonce = 'wrong';
  assert.equal(summarizeUsage([record]).unknownReceiptGroups, 2);
});

test('unknown, incomplete and malformed usage is not zero or a bill', () => {
  const r = summarizeUsage([{ attempts: [
    { status: 'running' },
    { status: 'failed', budget: { modelRequests: 2, calls: [call(3), { number: 2, finished: false, usage: { outputTokens: 4, inputTokens: -1 } }] } },
    { status: 'failed', budget: { modelRequests: 1, calls: [] } },
  ] }]);
  assert.equal(r.unknownReceiptGroups, 2);
  assert.equal(r.recordedModelRequests, 2);
  assert.equal(r.finishedModelRequests, 1);
  assert.equal(r.tokens.outputTokens.reported, 7);
  assert.equal(r.tokens.inputTokens.missingCalls, 1);
  assert.equal(r.attemptStatuses.failed, 2);
});

test('all retained tasks count beyond the recent-list window, with no prompt or credential fields', () => {
  const records = Array.from({ length: 51 }, () => ({ prompt: 'SECRET', workspace: 'PRIVATE', route: {}, attempts: [{ status: 'completed', budget: receipt('n', 5) }] }));
  const r = summarizeUsage(records);
  assert.equal(r.tasks, 51);
  assert.equal(r.recordedModelRequests, 51);
  assert.equal(r.tokens.inputTokens.reported, 510);
  assert.doesNotMatch(JSON.stringify(r), /SECRET|PRIVATE/);
  assert.equal(summarizeUsage([]).tokens.totalTokens.reported, 0);
});
