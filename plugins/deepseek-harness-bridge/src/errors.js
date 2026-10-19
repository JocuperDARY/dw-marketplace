// Only schema-owned field names may leave the process in validation diagnostics.
// Never expose rejected values, unknown property names, or Zod's raw messages.
const validationFields = new Set(('requestId prompt workspace access executionMode workload outputFormat reviewContract reportContract lifecycleContract statuses cases allowedStatuses slotReusable basis effort timeoutMs budget totalModelRequests totalOutputTokens totalToolCalls totalDurationMs maxTokens maxToolCalls maxModelRequests maxRequestBytes nativePlugins capabilityProfile taskId attempt offset limit caseIds ruleIds checkIds facts id kind value unit source').split(' '));
const validationMessages = {
  invalid_type: 'Use the type specified by the advertised schema.',
  invalid_value: 'Use one of the advertised values.',
  invalid_union: 'Value does not match any advertised alternative.',
  invalid_format: 'Value does not match the advertised format.',
  too_small: 'Value is below the advertised minimum or is empty.',
  too_big: 'Value exceeds the advertised maximum.',
  unrecognized_keys: 'Remove unrecognized fields from this object.',
  custom: 'Value violates an advertised constraint.',
  duplicate_id: 'Fact IDs must be unique.',
  duplicate_case_id: 'Case IDs must be unique.',
  status_not_declared: 'Allowed statuses must belong to the declared status vocabulary.',
  lifecycle_utf8_size_limit: 'Lifecycle contract must not exceed 16384 UTF-8 bytes.',
  utf8_size_limit: 'Report contract must not exceed 16384 UTF-8 bytes.',
};

function safeValidation(validation) {
  if (!validation || !['schema', 'contract'].includes(validation.phase) || !Array.isArray(validation.issues)) return undefined;
  return { phase: validation.phase, issues: validation.issues.slice(0, 16).map(issue => {
    const code = Object.hasOwn(validationMessages, issue.code) ? issue.code : 'invalid_value';
    const path = Array.isArray(issue.path) ? issue.path.slice(0, 12).map(part =>
      Number.isSafeInteger(part) && part >= 0 ? part : validationFields.has(part) ? part : '[field]') : [];
    const expected = ['string', 'number', 'boolean', 'object', 'array', 'null'].includes(issue.expected) ? issue.expected : undefined;
    const uniqueReviewIds = code === 'custom' && path[0] === 'reviewContract' && ['caseIds', 'ruleIds', 'checkIds'].includes(path[1]);
    const uniqueLifecycleIds = code === 'custom' && path[0] === 'lifecycleContract' && (path[1] === 'statuses' || path[3] === 'allowedStatuses');
    return { path, code, message: code === 'invalid_type' && expected ? `Expected ${expected}.`
      : uniqueReviewIds || uniqueLifecycleIds ? 'IDs in this array must be unique.' : validationMessages[code] };
  }), ...(validation.issues.length > 16 ? { issuesTruncated: true } : {}) };
}

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'BridgeError'; this.code = code;
    if (details.operation === 'observation') { this.operation = 'observation'; this.retryable = details.retryable === true; this.retryAfterMs = details.retryAfterMs; }
    const validation = safeValidation(details.validation);
    if (validation) this.validation = validation;
  }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new BridgeError(code, message);
}

export function safeError(error) {
  return error instanceof BridgeError
    ? { code: error.code, message: error.message, ...(error.validation ? { validation: error.validation } : {}), ...(error.operation === 'observation' ? { operation: error.operation, retryable: error.retryable, retryAfterMs: error.retryAfterMs } : {}) }
    : { code: 'INTERNAL_ERROR', message: 'The operation failed. Provider stderr and exception details are not exposed.' };
}

export function boundedInteger(value, fallback, min, max, name) {
  const result = value ?? fallback;
  requireValue(Number.isSafeInteger(result) && result >= min && result <= max,
    'INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`);
  return result;
}
