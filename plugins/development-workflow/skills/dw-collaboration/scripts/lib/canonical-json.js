'use strict';

const crypto = require('crypto');

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const arrayIsArray = Array.isArray;
const reflectOwnKeys = Reflect.ownKeys;
const objectHasOwn = Object.prototype.hasOwnProperty;
const intrinsicArrayPrototype = Array.prototype;
const intrinsicObjectPrototype = Object.prototype;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const freeze = Object.freeze;
const jsonStringify = JSON.stringify;
const DEFAULT_BUDGET = Object.freeze({
  maxDepth: 64,
  maxNodes: 250000,
  maxKeys: 250000,
  maxArrayItems: 100000,
  maxStringBytes: 8 * 1024 * 1024,
});

function contractError(code, path) {
  const { ContractError } = require('./contracts');
  return new ContractError(code, path, 'canonical JSON rejected');
}

function stableCanonicalFailure(caught) {
  const { ContractError } = require('./contracts');
  if (caught instanceof ContractError) return caught;
  return contractError('CANONICAL_REJECTED', '$');
}

function safeGetPrototypeOf(value) {
  try { return getPrototypeOf(value); }
  catch (_) { throw contractError('CANONICAL_REJECTED', '$'); }
}

function safeOwnKeys(value) {
  try { return reflectOwnKeys(value); }
  catch (_) { throw contractError('CANONICAL_REJECTED', '$'); }
}

function safeGetOwnPropertyDescriptor(value, key) {
  try { return getOwnPropertyDescriptor(value, key); }
  catch (_) { throw contractError('CANONICAL_REJECTED', '$'); }
}

function requireDataDescriptor(descriptor, path, enumerable) {
  if (!descriptor || !objectHasOwn.call(descriptor, 'value') || descriptor.enumerable !== enumerable) {
    throw contractError('CANONICAL_NON_JSON', path);
  }
  return descriptor.value;
}

function createDetachedJsonSnapshot(value) {
  try {
    const origins = new WeakMap();
    const budget = { ...DEFAULT_BUDGET, nodes: 0, keys: 0, arrayItems: 0, stringBytes: 0 };
    const snapshot = detachValue(value, '$', new WeakSet(), origins, budget, 0);
    return freeze({ snapshot, origins });
  } catch (caught) {
    throw stableCanonicalFailure(caught);
  }
}

function consumeBudget(budget, field, amount, limit) {
  budget[field] += amount;
  if (budget[field] > limit) throw contractError('CONTRACT_LIMIT_EXCEEDED', '$');
}

function detachValue(value, path, ancestors, origins, budget, depth) {
  if (depth > budget.maxDepth) throw contractError('CONTRACT_LIMIT_EXCEEDED', path);
  consumeBudget(budget, 'nodes', 1, budget.maxNodes);
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      consumeBudget(budget, 'stringBytes', Buffer.byteLength(value, 'utf8'), budget.maxStringBytes);
      return value;
    case 'boolean': return value;
    case 'number':
      if (!Number.isFinite(value)) throw contractError('CANONICAL_NON_JSON', path);
      return value;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint': throw contractError('CANONICAL_NON_JSON', path);
    case 'object': break;
    default: throw contractError('CANONICAL_NON_JSON', path);
  }

  if (ancestors.has(value)) throw contractError('CANONICAL_CYCLE', path);
  const isArray = arrayIsArray(value);
  const prototype = safeGetPrototypeOf(value);
  if (isArray ? prototype !== intrinsicArrayPrototype : prototype !== intrinsicObjectPrototype) {
    throw contractError('CANONICAL_NON_JSON', path);
  }

  ancestors.add(value);
  try {
    const keys = safeOwnKeys(value);
    if (isArray) return detachArray(value, keys, path, ancestors, origins, budget, depth);
    return detachObject(value, keys, path, ancestors, origins, budget, depth);
  } finally {
    ancestors.delete(value);
  }
}

function detachArray(value, keys, path, ancestors, origins, budget, depth) {
  const lengthDescriptor = safeGetOwnPropertyDescriptor(value, 'length');
  const length = requireDataDescriptor(lengthDescriptor, path, false);
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw contractError('CANONICAL_NON_JSON', path);
  }
  consumeBudget(budget, 'arrayItems', length, budget.maxArrayItems);

  const descriptors = new Map();
  for (const key of keys) {
    if (typeof key === 'symbol') throw contractError('CANONICAL_NON_JSON', path);
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      throw contractError('CANONICAL_NON_JSON', path);
    }
    descriptors.set(Number(key), safeGetOwnPropertyDescriptor(value, key));
  }
  if (descriptors.size !== length) throw contractError('CANONICAL_NON_JSON', '$[]');

  const snapshot = new Array(length);
  origins.set(snapshot, value);
  for (let index = 0; index < length; index += 1) {
    if (!descriptors.has(index)) throw contractError('CANONICAL_NON_JSON', '$[]');
    const entry = requireDataDescriptor(descriptors.get(index), '$[]', true);
    snapshot[index] = detachValue(entry, '$[]', ancestors, origins, budget, depth + 1);
  }
  return freeze(snapshot);
}

function detachObject(value, keys, path, ancestors, origins, budget, depth) {
  consumeBudget(budget, 'keys', keys.length, budget.maxKeys);
  const descriptors = [];
  for (const key of keys) {
    if (typeof key === 'symbol') throw contractError('CANONICAL_NON_JSON', path);
    consumeBudget(budget, 'stringBytes', Buffer.byteLength(key, 'utf8'), budget.maxStringBytes);
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) throw contractError('CANONICAL_PROTOTYPE_KEY', path);
    descriptors.push([key, safeGetOwnPropertyDescriptor(value, key)]);
  }

  const snapshot = {};
  origins.set(snapshot, value);
  for (const [key, descriptor] of descriptors) {
    const entry = requireDataDescriptor(descriptor, '$.*', true);
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: detachValue(entry, '$.*', ancestors, origins, budget, depth + 1),
      writable: false,
    });
  }
  return freeze(snapshot);
}

function canonicalizeDetachedSnapshot(snapshot, excludeTopLevelContentHash = false) {
  try {
    return serializeDetachedValue(snapshot, '$', excludeTopLevelContentHash);
  } catch (caught) {
    throw stableCanonicalFailure(caught);
  }
}

function serializeDetachedValue(value, path, excludeTopLevelContentHash) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return jsonStringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw contractError('CANONICAL_NON_JSON', path);
      return jsonStringify(value);
    case 'object': break;
    default: throw contractError('CANONICAL_NON_JSON', path);
  }

  if (arrayIsArray(value)) {
    const entries = [];
    const length = requireDataDescriptor(safeGetOwnPropertyDescriptor(value, 'length'), path, false);
    for (let index = 0; index < length; index += 1) {
      const entry = requireDataDescriptor(safeGetOwnPropertyDescriptor(value, String(index)), '$[]', true);
      entries.push(serializeDetachedValue(entry, '$[]', false));
    }
    return `[${entries.join(',')}]`;
  }

  const keys = safeOwnKeys(value).filter((key) => (
    typeof key === 'string'
    && (!excludeTopLevelContentHash || key !== 'content_sha256')
  ));
  keys.sort();
  const entries = [];
  for (const key of keys) {
    const entry = requireDataDescriptor(safeGetOwnPropertyDescriptor(value, key), '$.*', true);
    entries.push(`${jsonStringify(key)}:${serializeDetachedValue(entry, '$.*', false)}`);
  }
  return `{${entries.join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function computeDetachedContentSha256(snapshot) {
  return sha256(canonicalizeDetachedSnapshot(snapshot, true));
}

function computeDetachedSha256(snapshot) {
  return sha256(canonicalizeDetachedSnapshot(snapshot, false));
}

function canonicalize(value) {
  return canonicalizeDetachedSnapshot(createDetachedJsonSnapshot(value).snapshot);
}

function computeContentSha256(artifact) {
  const { snapshot } = createDetachedJsonSnapshot(artifact);
  if (snapshot === null || typeof snapshot !== 'object' || arrayIsArray(snapshot) || safeGetPrototypeOf(snapshot) !== intrinsicObjectPrototype) {
    throw contractError('CANONICAL_NON_JSON', '$');
  }
  return computeDetachedContentSha256(snapshot);
}

module.exports = {
  canonicalize,
  canonicalizeDetachedSnapshot,
  computeContentSha256,
  computeDetachedContentSha256,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
};
