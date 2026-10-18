import { boundedInteger, requireValue } from './errors.js';
import { normalizeBudget } from './orchestration.js';

const EFFORT = { mechanical: 'off', standard: 'low', reasoning: 'high' };
const HEADROOM = { off: 4096, low: 8192, high: 16384, max: 32768 };

/** Planning never creates authorization: new multi-step work requires explicit totals. */
export function planExecution(input, { legacy = false } = {}) {
  const executionMode = legacy ? 'legacy' : input.executionMode ?? 'budgeted';
  const workload = input.workload ?? 'standard';
  requireValue(legacy || ['budgeted', 'single-request'].includes(executionMode), 'INVALID_ARGUMENT', 'executionMode must be budgeted or single-request.');
  requireValue(Object.hasOwn(EFFORT, workload), 'INVALID_ARGUMENT', 'workload must be mechanical, standard or reasoning.');
  const effort = input.effort ?? (legacy ? 'high' : EFFORT[workload]);
  requireValue(Object.hasOwn(HEADROOM, effort), 'INVALID_ARGUMENT', 'effort must be off, low, high or max.');
  const single = executionMode === 'single-request';
  const capabilityProfile = input.capabilityProfile || (single ? 'inference-only' : 'files');
  const maxTokens = boundedInteger(input.maxTokens, legacy ? 8192 : HEADROOM[effort], 256, 32768, 'maxTokens');
  const maxModelRequests = boundedInteger(input.maxModelRequests, single ? 1 : legacy ? 16 : 6, 1, 128, 'maxModelRequests');
  const maxToolCalls = boundedInteger(input.maxToolCalls, single || (!legacy && capabilityProfile === 'inference-only') ? 0 : 32, 0, 128, 'maxToolCalls');
  if (executionMode === 'budgeted') requireValue(input.budget !== undefined, 'BUDGET_REQUIRED', 'Long or multi-step tasks require a preauthorized budget with all four totals. For exactly one text-only inference call explicitly select executionMode: single-request. No worker was launched.');
  if (single) requireValue(input.budget === undefined && maxModelRequests === 1 && maxToolCalls === 0 && capabilityProfile === 'inference-only' && (input.access ?? 'read-only') === 'read-only',
    'INVALID_ARGUMENT', 'single-request permits exactly one read-only inference request, no tools, no budget object and no continuation.');
  const budget = normalizeBudget(input.budget, maxModelRequests);
  const warnings = [];
  if ((effort === 'high' && maxTokens < 8192) || (effort === 'max' && maxTokens < 16384)) warnings.push('The explicit output cap leaves limited room for reasoning and visible text. Consider a lower effort or a larger cap within the authorized total.');
  return { executionMode, workload, effort, maxTokens, maxModelRequests, maxToolCalls, capabilityProfile, budget, warnings };
}
