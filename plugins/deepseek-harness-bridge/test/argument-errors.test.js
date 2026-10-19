import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, safeError } from '../src/errors.js';

test('validation diagnostics discard values, arbitrary keys, raw messages and unknown codes', () => {
  const secret = 'private-key-input-marker';
  const error = new BridgeError('INVALID_ARGUMENT', 'Invalid arguments.', { validation: {
    phase: 'schema', issues: [
      { code: 'invalid_type', path: ['reportContract', 'facts', 3, 'value'], expected: 'string', input: secret, message: secret },
      { code: 'unrecognized_keys', path: [], keys: [secret], message: secret },
      { code: secret, path: [secret], expected: secret, message: secret },
    ],
  } });
  const result = safeError(error);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.validation.issues[0], { path: ['reportContract', 'facts', 3, 'value'], code: 'invalid_type', message: 'Expected string.' });
  assert.deepEqual(result.validation.issues[2].path, ['[field]']);
  assert.equal(result.validation.issues[2].code, 'invalid_value');
});

test('validation diagnostics bound issue count and path length without changing other error envelopes', () => {
  const result = safeError(new BridgeError('INVALID_ARGUMENT', 'Invalid arguments.', { validation: {
    phase: 'schema', issues: Array.from({ length: 100 }, () => ({ code: 'custom', path: Array(100).fill('source') })),
  } }));
  assert.equal(result.validation.issues.length, 16);
  assert.equal(result.validation.issuesTruncated, true);
  assert.equal(result.validation.issues[0].path.length, 12);
  assert.deepEqual(safeError(new BridgeError('STATE_LOCKED', 'State is owned.', { operation: 'observation', retryable: true, retryAfterMs: 100 })),
    { code: 'STATE_LOCKED', message: 'State is owned.', operation: 'observation', retryable: true, retryAfterMs: 100 });
  assert.equal(safeError(new Error('private-error')).code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(safeError(new Error('private-error'))).includes('private-error'), false);
});
