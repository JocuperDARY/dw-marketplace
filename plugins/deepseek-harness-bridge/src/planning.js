import { BridgeError, boundedInteger, requireValue } from './errors.js';
import { normalizeBudget } from './orchestration.js';
import { normalizeOutputFormat, normalizeReviewContract } from './delivery.js';
import { normalizeReportContract } from './report.js';
import { normalizeLifecycleContract } from './lifecycle.js';
import { optionalLimit } from './limits.js';
import { normalizeRecoveryMilestones } from './recovery-progress.js';

const EFFORT = { mechanical: 'off', drafting: 'off', standard: 'low', reasoning: 'high', verification: 'high' };
const HEADROOM = { off: 4096, low: 8192, high: 16384, max: 32768 };

export function validateNativeSelection(input, capabilityProfile = input.capabilityProfile ||
  (input.executionMode === 'single-request' ? 'inference-only' : 'native')) {
  if (input.nativePlugins !== undefined && capabilityProfile !== 'native') throw new BridgeError('INVALID_ARGUMENT',
    'nativePlugins is permitted only with the native capability profile. Omit this field for inference-only, including single-request.',
    { validation: { phase: 'contract', issues: [{ path: ['nativePlugins'], code: 'native_profile_required' }] } });
}

/** Omitted resource limits remain omitted; only explicit limits constrain work. */
export function planExecution(input, { legacy = false, compatibilityV1 = false } = {}) {
  const oldDefaults = legacy || compatibilityV1;
  const executionMode = legacy ? 'legacy' : input.executionMode ?? (compatibilityV1 || input.budget !== undefined ? 'budgeted' : 'automatic');
  const reviewContract = normalizeReviewContract(input.reviewContract);
  const reportContract = normalizeReportContract(input.reportContract);
  const lifecycleContract = normalizeLifecycleContract(input.lifecycleContract);
  requireValue([reportContract, reviewContract, lifecycleContract].filter(Boolean).length <= 1, 'INVALID_ARGUMENT', 'Delivery contracts require different shapes; choose one of reviewContract, reportContract or lifecycleContract.');
  const verifying = reviewContract || lifecycleContract;
  const outputFormat = normalizeOutputFormat(input.outputFormat, reviewContract, reportContract, lifecycleContract);
  const workload = input.workload ?? (verifying ? 'verification' : reportContract ? 'drafting' : 'standard');
  requireValue(legacy || ['automatic', 'budgeted', 'single-request'].includes(executionMode), 'INVALID_ARGUMENT', 'executionMode must be automatic, budgeted or single-request.');
  requireValue(executionMode !== 'automatic' || input.budget === undefined, 'INVALID_ARGUMENT', 'A supplied total budget uses budgeted mode; omit executionMode or select budgeted.');
  requireValue(Object.hasOwn(EFFORT, workload), 'INVALID_ARGUMENT', 'workload must be mechanical, drafting, standard, reasoning or verification.');
  requireValue(workload !== 'verification' || verifying, 'REVIEW_CONTRACT_REQUIRED', 'verification requires reviewContract or lifecycleContract. Supply authoritative rules and explicit uncertainty handling.');
  const effort = input.effort ?? (legacy ? 'high' : EFFORT[workload]);
  requireValue(Object.hasOwn(HEADROOM, effort), 'INVALID_ARGUMENT', 'effort must be off, low, high or max.');
  const single = executionMode === 'single-request';
  const capabilityProfile = input.capabilityProfile || (single ? 'inference-only' : oldDefaults ? 'files' : 'native');
  validateNativeSelection(input, capabilityProfile);
  const maxTokens = oldDefaults ? boundedInteger(input.maxTokens, legacy ? 8192 : HEADROOM[effort], 256, 32768, 'maxTokens') : optionalLimit(input.maxTokens, 'maxTokens');
  const maxModelRequests = oldDefaults ? boundedInteger(input.maxModelRequests, single ? 1 : legacy ? 16 : 6, 1, 128, 'maxModelRequests') : optionalLimit(input.maxModelRequests ?? (single ? 1 : null), 'maxModelRequests');
  const maxToolCalls = oldDefaults ? boundedInteger(input.maxToolCalls, single || (!legacy && capabilityProfile === 'inference-only') ? 0 : 32, 0, 128, 'maxToolCalls') : optionalLimit(input.maxToolCalls ?? (single || capabilityProfile === 'inference-only' ? 0 : null), 'maxToolCalls', 0);
  if (single) requireValue(input.budget === undefined && maxModelRequests === 1 && maxToolCalls === 0 && capabilityProfile === 'inference-only' && (input.access ?? 'read-only') === 'read-only',
    'INVALID_ARGUMENT', 'single-request permits exactly one read-only inference request, no tools, no budget object and no continuation.');
  const budget = normalizeBudget(input.budget ?? (executionMode === 'budgeted' ? {} : undefined), maxModelRequests);
  const recoveryMilestones = normalizeRecoveryMilestones(input.recoveryMilestones, executionMode);
  const warnings = [];
  if (single && effort !== 'off') warnings.push('single-request reasoning shares the output allowance and may leave no visible answer, even at low effort. This mode cannot recover or retry; explicit effort and caps are preserved. Use drafting/off for bounded prose from supplied facts, or authorize a total budget when recovery is needed.');
  if (budget && ((budget.totalModelRequests != null && budget.totalModelRequests < 3) || (budget.totalOutputTokens != null && budget.totalOutputTokens < 768))) warnings.push('This explicit total may not fund separate work, checkpoint and recovery. Recovery never increases the limit.');
  if (verifying && workload === 'mechanical') warnings.push('Rule verification is not mechanical extraction. Prefer workload: verification for path classification, exceptions and test expectations; the explicit workload is preserved.');
  if (verifying && ['off', 'low'].includes(effort)) warnings.push('Rule verification normally uses high effort. The explicit low/off setting is preserved; independently verify every case and required check before adoption.');
  if (maxTokens != null && ((effort === 'high' && maxTokens < 8192) || (effort === 'max' && maxTokens < 16384))) warnings.push('The explicit output cap leaves limited room for reasoning and visible text. Consider a lower effort or a larger cap within the authorized total.');
  return { executionMode, workload, effort, maxTokens, maxModelRequests, maxToolCalls, capabilityProfile, budget, warnings, reviewContract, reportContract, lifecycleContract, outputFormat, recoveryMilestones };
}
