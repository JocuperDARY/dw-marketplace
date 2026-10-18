export class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new BridgeError(code, message);
}

export function safeError(error) {
  return error instanceof BridgeError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: 'The operation failed. Provider stderr and exception details are not exposed.' };
}

export function boundedInteger(value, fallback, min, max, name) {
  const result = value ?? fallback;
  requireValue(Number.isSafeInteger(result) && result >= min && result <= max,
    'INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`);
  return result;
}
