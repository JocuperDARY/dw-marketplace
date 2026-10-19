import { boundedInteger, requireValue } from './errors.js';
import { normalizeBudget } from './orchestration.js';
import { normalizeOutputFormat, normalizeReviewContract } from './delivery.js';
import { normalizeReportContract } from './report.js';
import { normalizeLifecycleContract } from './lifecycle.js';

const EFFORT = { mechanical: 'off', drafting: 'off', standard: 'low', reasoning: 'high', verification: 'high' };
const HEADROOM = { off: 4096, low: 8192, high: 16384, max: 32768 };

/** Planning never creates authorization: new multi-step work requires explicit totals. */
export function planExecution(input, { legacy = false } = {}) {
  const executionMode = legacy ? 'legacy' : input.executionMode ?? 'budgeted';
  const reviewContract = normalizeReviewContract(input.reviewContract);
  const reportContract = normalizeReportContract(input.reportContract);
  const lifecycleContract = normalizeLifecycleContract(input.lifecycleContract);
  requireValue([reportContract, reviewContract, lifecycleContract].filter(Boolean).length <= 1, 'INVALID_ARGUMENT', 'Delivery contracts require different shapes; choose one of reviewContract, reportContract or lifecycleContract.');
  const outputFormat = normalizeOutputFormat(input.outputFormat, reviewContract, reportContract, lifecycleContract);
  const verifying = reviewContract || lifecycleContract;
  const workload = input.workload ?? (verifying ? 'verification' : reportContract ? 'drafting' : 'standard');
  requireValue(legacy || ['budgeted', 'single-request'].includes(executionMode), 'INVALID_ARGUMENT', 'executionMode must be budgeted or single-request.');
  requireValue(Object.hasOwn(EFFORT, workload), 'INVALID_ARGUMENT', 'workload must be mechanical, drafting, standard, reasoning or verification.');
  requireValue(workload !== 'verification' || verifying, 'REVIEW_CONTRACT_REQUIRED', 'verification requires reviewContract or lifecycleContract. Supply authoritative rules and explicit uncertainty handling.');
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
  if (single && effort !== 'off') warnings.push('single-request reasoning shares the output allowance and may leave no visible answer, even at low effort. This mode cannot recover or retry; explicit effort and caps are preserved. Use drafting/off for bounded prose from supplied facts, or authorize a total budget when recovery is needed.');
  if (budget && (budget.totalModelRequests < 3 || budget.totalOutputTokens < 768)) warnings.push('This total cannot separately reserve work, checkpoint and recovery. It remains a hard limit; recovery may be unavailable.');
  if (verifying && workload === 'mechanical') warnings.push('Rule verification is not mechanical extraction. Prefer workload: verification for lifecycle/path classification, exceptions and test expectations; the explicit workload is preserved.');
  if (verifying && ['off', 'low'].includes(effort)) warnings.push('Rule verification normally uses high effort. The explicit low/off setting is preserved; independently verify every case and required check before adoption.');
  if ((effort === 'high' && maxTokens < 8192) || (effort === 'max' && maxTokens < 16384)) warnings.push('The explicit output cap leaves limited room for reasoning and visible text. Consider a lower effort or a larger cap within the authorized total.');
  return { executionMode, workload, effort, maxTokens, maxModelRequests, maxToolCalls, capabilityProfile, budget, warnings, reviewContract, reportContract, lifecycleContract, outputFormat };
}
