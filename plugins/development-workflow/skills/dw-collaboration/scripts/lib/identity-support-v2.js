'use strict';

const SUPPORT_STATES2 = Object.freeze([
  'VERIFIED_FULL',
  'VERIFIED_DEGRADED',
  'UNVERIFIED',
  'NOT_RUN',
  'FAILED',
]);

const SUPPORT_STATE_SET = new Set(SUPPORT_STATES2);
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE_REF = /^(authority|evidence|observation|identity):[0-9a-f]{64}$/;
const SECRET_TOKEN = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|bareCredentialValue[A-Za-z0-9_-]*)/;
const UTC_TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?Z$/;
const SENSITIVE_KEY = /(?:^|_)(?:user_?prompt|model_?(?:reply|response)|command_?output|stdout|stderr|api_?key|access_?token|credential|secret|password)(?:$|_)/i;
const SENSITIVE_VALUE = /(?:^|[\s,;:{[(])(?:api[_-]?key|access[_-]?token|credential|secret|password|bearer)(?:\s|=|:|$)/i;
const SAFE_DIAGNOSTIC_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RECOVERY_GRAPH_MAX_DEPTH = 8;
const RECOVERY_GRAPH_MAX_NODES = 256;
const RECOVERY_GRAPH_MAX_OBJECT_KEYS = 32;
const RECOVERY_GRAPH_MAX_KEY_BYTES = 128;
const RECOVERY_GRAPH_MAX_STRING_BYTES = 4096;
const RECOVERY_GRAPH_MAX_TOTAL_BYTES = 32768;
const reflectOwnKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const arrayIsArray = Array.isArray;
const utf8ByteLength = Buffer.byteLength.bind(Buffer);

const PROCESS_BASE_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'platform',
  'owner_id',
  'run_id',
  'session_id',
  'lease_generation',
  'adapter_generation',
  'manager_generation',
  'pid',
  'start_time',
  'executable_path_sha256',
  'argv_sha256',
  'parent_identity_sha256',
  'launch_nonce',
  'manager_run_id',
]);
const HARNESS_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'harness',
  'harness_kind',
  'session_id',
  'owner_id',
  'run_id',
  'lease_generation',
  'adapter_generation',
  'harness_instance_id',
  'launch_nonce',
  'agent_id',
  'thread_id',
  'process_identity',
]);
const TEMPORARY_BASE_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'platform',
  'allocation_id',
  'owner_id',
  'run_id',
  'session_id',
  'lease_generation',
  'child_id',
  'manifest_sha256',
  'canonical_root',
  'task_directory',
  'confirmed_parent_directory',
  'quota',
  'creation_nonce',
]);
const RECOVERY_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'resource_id',
  'resource_type',
  'run_id',
  'session_id',
  'lease_generation',
  'identity',
  'current_phase',
  'last_valid_observation',
  'cleanup_authority_ref',
  'teardown_condition',
  'evidence_refs',
]);
const SUPPORT_MATRIX_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'adapter_id',
  'platform',
  'observed_at',
  'overall_state',
  'claims',
]);
const SUPPORT_CLAIM_KEYS = Object.freeze(['state', 'evidence_refs']);
const CAPABILITY_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const FORBIDDEN_CAPABILITY_IDS = new Set(['constructor', 'prototype']);
const RECOVERY_PHASES = new Set(['execution', 'cleanup']);
const RECOVERY_PHASE_STATES = new Set(['ACTIVE', 'HOLD', 'COMPLETE']);
const TEARDOWN_CONDITIONS = new Set(['identity_absence_verified', 'harness_closed', 'allocation_absence_verified']);
const RECOVERY_TEARDOWN_BY_TYPE = Object.freeze({
  process_tree: 'identity_absence_verified',
  command_session: 'identity_absence_verified',
  agent_session: 'harness_closed',
  runtime_thread: 'harness_closed',
  temporary_allocation: 'allocation_absence_verified',
});

class IdentitySupportV2Error extends Error {
  constructor(code, validation) {
    super(code);
    this.name = 'IdentitySupportV2Error';
    this.code = code;
    this.validation = validation;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isCapabilityId(value) {
  return CAPABILITY_ID.test(value) && !FORBIDDEN_CAPABILITY_IDS.has(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value) {
  if (!isNonEmptyString(value) || !UTC_TIMESTAMP.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function error(code, path, message) {
  return Object.freeze({ code, path, message });
}

function safeDiagnosticKey(key) {
  return typeof key === 'string'
    && SAFE_DIAGNOSTIC_KEY.test(key)
    && !SENSITIVE_KEY.test(key)
    && !SENSITIVE_VALUE.test(key)
    && !SECRET_TOKEN.test(key)
    ? key
    : '<redacted-key>';
}

function propertyPath(path, key) {
  return `${path}.${safeDiagnosticKey(key)}`;
}

function result(errors, extras = {}) {
  const valid = errors.length === 0;
  return Object.freeze({
    valid,
    disposition: valid ? 'VERIFIED' : 'HOLD',
    action_authorized: false,
    errors: Object.freeze(errors),
    ...extras,
  });
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  if (!isPlainObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
  ));
}

function requireExactKeys(value, allowedKeys, requiredKeys, errors, path = '$') {
  if (!isPlainObject(value)) {
    errors.push(error('IDENTITY_SHAPE_INVALID', path, 'value must be a plain object'));
    return false;
  }
  const allowed = new Set(allowedKeys);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      errors.push(error('IDENTITY_FIELD_MISSING', `${path}.${key}`, 'required field is missing'));
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(error('IDENTITY_ADDITIONAL_PROPERTY', propertyPath(path, key), 'unsupported property'));
    }
  }
  return true;
}

function requireSchema(value, schema, errors) {
  if (value.schema !== schema || value.schema_version !== 2) {
    errors.push(error('IDENTITY_SCHEMA_MISMATCH', '$.schema', `expected ${schema} version 2`));
  }
}

function requireStrings(value, fields, errors) {
  for (const field of fields) {
    if (!isNonEmptyString(value[field])) {
      errors.push(error('IDENTITY_FIELD_INVALID', `$.${field}`, 'field must be a non-empty string'));
    }
  }
}

function requireHashes(value, fields, errors) {
  for (const field of fields) {
    if (!SHA256.test(value[field] || '')) {
      errors.push(error('IDENTITY_HASH_INVALID', `$.${field}`, 'field must be a lowercase SHA-256 value'));
    }
  }
}

function requirePositiveIntegers(value, fields, errors) {
  for (const field of fields) {
    if (!isPositiveInteger(value[field])) {
      errors.push(error('IDENTITY_GENERATION_INVALID', `$.${field}`, 'field must be a positive safe integer'));
    }
  }
}

function validateOpaqueReference(value, kind, path, errors, errorCode = 'RECOVERY_REFERENCE_INVALID') {
  const match = typeof value === 'string' ? OPAQUE_REF.exec(value) : null;
  if (!match || match[1] !== kind) {
    errors.push(error(errorCode, path, `reference must use ${kind}:<sha256>`));
  }
}

function validatePlatformFileIdentity(container, platform, path, errors) {
  if (!isPlainObject(container)) {
    errors.push(error('TEMPORARY_DIRECTORY_INVALID', path, 'directory identity must be an object'));
    return;
  }
  const platformKey = platform === 'windows' ? 'windows_file_identity' : 'linux_file_identity';
  const otherKey = platform === 'windows' ? 'linux_file_identity' : 'windows_file_identity';
  if (!requireExactKeys(container, ['path', platformKey], ['path', platformKey], errors, path)) return;
  if (!isNonEmptyString(container.path)) {
    errors.push(error('TEMPORARY_DIRECTORY_PATH_INVALID', `${path}.path`, 'directory path must be non-empty'));
  }
  if (Object.hasOwn(container, otherKey)) {
    errors.push(error('TEMPORARY_PLATFORM_MIXED', `${path}.${otherKey}`, 'directory identity mixes platforms'));
  }
  const nativeIdentity = container[platformKey];
  if (platform === 'windows') {
    if (requireExactKeys(nativeIdentity, ['volume_serial_number', 'file_id'], ['volume_serial_number', 'file_id'], errors, `${path}.${platformKey}`)) {
      if (!isNonEmptyString(nativeIdentity.volume_serial_number) || !isNonEmptyString(nativeIdentity.file_id)) {
        errors.push(error('TEMPORARY_PLATFORM_FIELD_INVALID', `${path}.${platformKey}`, 'Windows file identity fields must be non-empty'));
      }
    }
  } else if (platform === 'linux') {
    if (requireExactKeys(nativeIdentity, ['device_id', 'inode'], ['device_id', 'inode'], errors, `${path}.${platformKey}`)) {
      if (!isNonEmptyString(nativeIdentity.device_id) || !isPositiveInteger(nativeIdentity.inode)) {
        errors.push(error('TEMPORARY_PLATFORM_FIELD_INVALID', `${path}.${platformKey}`, 'Linux file identity fields are invalid'));
      }
    }
  }
}

function validateProcessIdentity2(identity) {
  const errors = [];
  const allowed = [...PROCESS_BASE_KEYS, 'windows_identity', 'linux_identity'];
  if (!requireExactKeys(identity, allowed, PROCESS_BASE_KEYS, errors)) return result(errors);
  requireSchema(identity, 'ProcessIdentity2', errors);
  if (!['windows', 'linux'].includes(identity.platform)) {
    errors.push(error('PROCESS_PLATFORM_INVALID', '$.platform', 'platform must be windows or linux'));
  }
  if (!isPositiveInteger(identity.pid)) errors.push(error('PROCESS_PID_INVALID', '$.pid', 'pid must be a positive safe integer'));
  if (!isTimestamp(identity.start_time)) errors.push(error('PROCESS_START_TIME_INVALID', '$.start_time', 'start_time must be a UTC timestamp'));
  requireStrings(identity, ['owner_id', 'run_id', 'session_id', 'launch_nonce', 'manager_run_id'], errors);
  requirePositiveIntegers(identity, ['lease_generation', 'adapter_generation', 'manager_generation'], errors);
  requireHashes(identity, ['executable_path_sha256', 'argv_sha256', 'parent_identity_sha256'], errors);

  if (identity.platform === 'windows') {
    if (!Object.hasOwn(identity, 'windows_identity')) {
      errors.push(error('PROCESS_PLATFORM_FIELDS_MISSING', '$.windows_identity', 'Windows identity fields are required'));
    } else if (requireExactKeys(identity.windows_identity,
      ['process_creation_time_filetime', 'process_handle'],
      ['process_creation_time_filetime', 'process_handle'], errors, '$.windows_identity')) {
      requireStrings(identity.windows_identity, ['process_creation_time_filetime', 'process_handle'], errors);
      if (!/^\d+$/.test(identity.windows_identity.process_creation_time_filetime || '')) {
        errors.push(error('PROCESS_PLATFORM_FIELD_INVALID', '$.windows_identity.process_creation_time_filetime', 'FILETIME must contain decimal digits'));
      }
    }
    if (Object.hasOwn(identity, 'linux_identity')) {
      errors.push(error('PROCESS_PLATFORM_MIXED', '$.linux_identity', 'Linux fields are forbidden on Windows identities'));
    }
  }
  if (identity.platform === 'linux') {
    if (!Object.hasOwn(identity, 'linux_identity')) {
      errors.push(error('PROCESS_PLATFORM_FIELDS_MISSING', '$.linux_identity', 'Linux identity fields are required'));
    } else if (requireExactKeys(identity.linux_identity,
      ['proc_start_ticks', 'boot_id_sha256', 'process_group_id', 'os_session_id', 'executable_device_id', 'executable_inode'],
      ['proc_start_ticks', 'boot_id_sha256', 'process_group_id', 'os_session_id', 'executable_device_id', 'executable_inode'], errors, '$.linux_identity')) {
      if (!isPositiveInteger(identity.linux_identity.proc_start_ticks)) {
        errors.push(error('PROCESS_PLATFORM_FIELD_INVALID', '$.linux_identity.proc_start_ticks', 'proc start ticks must be a positive safe integer'));
      }
      if (!SHA256.test(identity.linux_identity.boot_id_sha256 || '')) {
        errors.push(error('IDENTITY_HASH_INVALID', '$.linux_identity.boot_id_sha256', 'boot ID must be a lowercase SHA-256 value'));
      }
      for (const field of ['process_group_id', 'os_session_id', 'executable_inode']) {
        if (!isPositiveInteger(identity.linux_identity[field])) {
          errors.push(error('PROCESS_PLATFORM_FIELD_INVALID', `$.linux_identity.${field}`, `${field} must be a positive safe integer`));
        }
      }
      if (!isNonEmptyString(identity.linux_identity.executable_device_id)) {
        errors.push(error('PROCESS_PLATFORM_FIELD_INVALID', '$.linux_identity.executable_device_id', 'executable device ID must be non-empty'));
      }
    }
    if (Object.hasOwn(identity, 'windows_identity')) {
      errors.push(error('PROCESS_PLATFORM_MIXED', '$.windows_identity', 'Windows fields are forbidden on Linux identities'));
    }
  }
  return result(errors);
}

function validateHarnessSessionIdentity2(identity) {
  const errors = [];
  const required = HARNESS_KEYS.filter((key) => !['process_identity', 'agent_id', 'thread_id'].includes(key));
  if (!requireExactKeys(identity, HARNESS_KEYS, required, errors)) return result(errors);
  requireSchema(identity, 'HarnessSessionIdentity2', errors);
  if (!['agent_session', 'runtime_thread'].includes(identity.harness_kind)) {
    errors.push(error('HARNESS_KIND_INVALID', '$.harness_kind', 'unsupported harness kind'));
  }
  requireStrings(identity, ['harness', 'session_id', 'owner_id', 'run_id', 'harness_instance_id', 'launch_nonce'], errors);
  requirePositiveIntegers(identity, ['lease_generation', 'adapter_generation'], errors);
  if (identity.harness_kind === 'agent_session') {
    if (!isNonEmptyString(identity.agent_id)) errors.push(error('HARNESS_AGENT_ID_REQUIRED', '$.agent_id', 'agent session requires agent_id'));
    if (Object.hasOwn(identity, 'thread_id')) errors.push(error('HARNESS_IDENTITY_MIXED', '$.thread_id', 'agent session cannot carry thread_id'));
  }
  if (identity.harness_kind === 'runtime_thread') {
    if (!isNonEmptyString(identity.thread_id)) errors.push(error('HARNESS_THREAD_ID_REQUIRED', '$.thread_id', 'runtime thread requires thread_id'));
    if (Object.hasOwn(identity, 'agent_id')) errors.push(error('HARNESS_IDENTITY_MIXED', '$.agent_id', 'runtime thread cannot carry agent_id'));
  }
  if (Object.hasOwn(identity, 'process_identity')) {
    const processResult = validateProcessIdentity2(identity.process_identity);
    for (const processError of processResult.errors) {
      errors.push(error(processError.code, `$.process_identity${processError.path.slice(1)}`, processError.message));
    }
    if (processResult.valid) {
      for (const field of ['owner_id', 'run_id', 'session_id', 'lease_generation', 'adapter_generation']) {
        if (identity.process_identity[field] !== identity[field]) {
          errors.push(error('HARNESS_PROCESS_BINDING_MISMATCH', `$.process_identity.${field}`, `process ${field} must match harness`));
        }
      }
    }
  }
  return result(errors);
}

function validateTemporaryAllocationIdentity2(identity) {
  const errors = [];
  const allowed = [...TEMPORARY_BASE_KEYS, 'windows_file_identity', 'linux_file_identity'];
  if (!requireExactKeys(identity, allowed, TEMPORARY_BASE_KEYS, errors)) return result(errors);
  requireSchema(identity, 'TemporaryAllocationIdentity2', errors);
  if (!['windows', 'linux'].includes(identity.platform)) {
    errors.push(error('TEMPORARY_PLATFORM_INVALID', '$.platform', 'platform must be windows or linux'));
  }
  requireStrings(identity, ['allocation_id', 'owner_id', 'run_id', 'session_id', 'child_id', 'canonical_root'], errors);
  requireStrings(identity, ['creation_nonce'], errors);
  requireHashes(identity, ['manifest_sha256'], errors);
  if (!isPositiveInteger(identity.lease_generation)) {
    errors.push(error('TEMPORARY_GENERATION_INVALID', '$.lease_generation', 'lease generation must be positive'));
  }
  validatePlatformFileIdentity(identity.task_directory, identity.platform, '$.task_directory', errors);
  validatePlatformFileIdentity(identity.confirmed_parent_directory, identity.platform, '$.confirmed_parent_directory', errors);
  if (!isPlainObject(identity.quota)
    || !requireExactKeys(identity.quota, ['unit', 'limit'], ['unit', 'limit'], errors, '$.quota')
    || identity.quota.unit !== 'bytes' || !isPositiveInteger(identity.quota.limit)) {
    errors.push(error('TEMPORARY_QUOTA_INVALID', '$.quota', 'quota must be a positive byte limit'));
  }

  if (identity.platform === 'windows') {
    if (!Object.hasOwn(identity, 'windows_file_identity')) {
      errors.push(error('TEMPORARY_PLATFORM_FIELDS_MISSING', '$.windows_file_identity', 'Windows file identity is required'));
    } else if (requireExactKeys(identity.windows_file_identity,
      ['volume_serial_number', 'file_id'], ['volume_serial_number', 'file_id'], errors, '$.windows_file_identity')) {
      requireStrings(identity.windows_file_identity, ['volume_serial_number', 'file_id'], errors);
    }
    if (Object.hasOwn(identity, 'linux_file_identity')) {
      errors.push(error('TEMPORARY_PLATFORM_MIXED', '$.linux_file_identity', 'Linux fields are forbidden on Windows allocations'));
    }
  }
  if (identity.platform === 'linux') {
    if (!Object.hasOwn(identity, 'linux_file_identity')) {
      errors.push(error('TEMPORARY_PLATFORM_FIELDS_MISSING', '$.linux_file_identity', 'Linux file identity is required'));
    } else if (requireExactKeys(identity.linux_file_identity,
      ['device_id', 'inode'], ['device_id', 'inode'], errors, '$.linux_file_identity')) {
      if (!isNonEmptyString(identity.linux_file_identity.device_id)) {
        errors.push(error('TEMPORARY_PLATFORM_FIELD_INVALID', '$.linux_file_identity.device_id', 'device ID must be non-empty'));
      }
      if (!isPositiveInteger(identity.linux_file_identity.inode)) {
        errors.push(error('TEMPORARY_PLATFORM_FIELD_INVALID', '$.linux_file_identity.inode', 'inode must be a positive safe integer'));
      }
    }
    if (Object.hasOwn(identity, 'windows_file_identity')) {
      errors.push(error('TEMPORARY_PLATFORM_MIXED', '$.windows_file_identity', 'Windows fields are forbidden on Linux allocations'));
    }
  }
  return result(errors);
}

function validateResourceIdentity2(resourceType, identity) {
  if (resourceType === 'process_tree' || resourceType === 'command_session') {
    return validateProcessIdentity2(identity);
  }
  if (resourceType === 'agent_session' || resourceType === 'runtime_thread') {
    const validated = validateHarnessSessionIdentity2(identity);
    if (validated.valid && identity.harness_kind !== resourceType) {
      return result([error('HARNESS_RESOURCE_TYPE_MISMATCH', '$.harness_kind', 'harness kind does not match resource type')]);
    }
    return validated;
  }
  if (resourceType === 'temporary_allocation') return validateTemporaryAllocationIdentity2(identity);
  return result([error('RESOURCE_IDENTITY_TYPE_UNSUPPORTED', '$.resource_type', 'resource type has no version-2 identity validator')]);
}

function scanRecoveryGraph(root) {
  const sensitivePaths = [];
  let graphError = null;
  let nodes = 0;
  let aggregateBytes = 0;
  let currentPath = '$';
  const activeAncestors = new Set();
  const stack = [{ kind: 'enter', value: root, path: '$', depth: 0, root: true }];

  const reject = (code, path, message) => {
    if (graphError === null) graphError = error(code, path, message);
  };
  const addBytes = (count, path) => {
    aggregateBytes += count;
    if (aggregateBytes > RECOVERY_GRAPH_MAX_TOTAL_BYTES) {
      reject('RECOVERY_AGGREGATE_SIZE_LIMIT_EXCEEDED', path, 'recovery graph exceeds maximum aggregate UTF-8 byte length');
    }
  };
  const inspectString = (value, path) => {
    if (value.length > RECOVERY_GRAPH_MAX_STRING_BYTES) {
      reject('RECOVERY_STRING_SIZE_LIMIT_EXCEEDED', path, 'recovery string exceeds maximum UTF-8 byte length');
      return;
    }
    const bytes = utf8ByteLength(value, 'utf8');
    if (bytes > RECOVERY_GRAPH_MAX_STRING_BYTES) {
      reject('RECOVERY_STRING_SIZE_LIMIT_EXCEEDED', path, 'recovery string exceeds maximum UTF-8 byte length');
      return;
    }
    addBytes(bytes, path);
    if (!graphError && (SENSITIVE_VALUE.test(value) || SECRET_TOKEN.test(value))) sensitivePaths.push(path);
  };
  const inspectKey = (key, path) => {
    if (key.length > RECOVERY_GRAPH_MAX_KEY_BYTES) {
      reject('RECOVERY_KEY_SIZE_LIMIT_EXCEEDED', `${path}.*`, 'recovery object key exceeds maximum UTF-8 byte length');
      return;
    }
    const bytes = utf8ByteLength(key, 'utf8');
    if (bytes > RECOVERY_GRAPH_MAX_KEY_BYTES) {
      reject('RECOVERY_KEY_SIZE_LIMIT_EXCEEDED', `${path}.*`, 'recovery object key exceeds maximum UTF-8 byte length');
      return;
    }
    const keyPath = propertyPath(path, key);
    addBytes(bytes, keyPath);
    if (!graphError && (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(key) || SECRET_TOKEN.test(key))) {
      sensitivePaths.push(keyPath);
    }
  };

  try {
    while (stack.length > 0 && !graphError) {
      const frame = stack.pop();
      currentPath = frame.path;
      if (frame.kind === 'exit') {
        activeAncestors.delete(frame.value);
        continue;
      }
      if (frame.depth > RECOVERY_GRAPH_MAX_DEPTH) {
        reject('RECOVERY_DEPTH_LIMIT_EXCEEDED', frame.path, 'recovery graph exceeds maximum depth');
        break;
      }
      nodes += 1;
      if (nodes > RECOVERY_GRAPH_MAX_NODES) {
        reject('RECOVERY_NODE_LIMIT_EXCEEDED', frame.path, 'recovery graph exceeds maximum node count');
        break;
      }
      const { value, path, depth } = frame;
      if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
        }
        continue;
      }
      if (typeof value === 'string') {
        inspectString(value, path);
        continue;
      }
      if (typeof value !== 'object') {
        reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
        continue;
      }
      if (activeAncestors.has(value)) {
        reject('RECOVERY_GRAPH_CYCLE', path, 'recovery graph contains an active-ancestor cycle');
        break;
      }

      const isArray = arrayIsArray(value);
      const prototype = getPrototypeOf(value);
      if (isArray ? prototype !== arrayPrototype : prototype !== objectPrototype) {
        reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
        break;
      }
      activeAncestors.add(value);
      stack.push({ kind: 'exit', value });

      if (isArray) {
        const lengthDescriptor = getOwnPropertyDescriptor(value, 'length');
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
          || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0 || lengthDescriptor.enumerable !== false) {
          reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
          break;
        }
        const length = lengthDescriptor.value;
        if (length > RECOVERY_GRAPH_MAX_NODES - nodes) {
          reject('RECOVERY_NODE_LIMIT_EXCEEDED', path, 'recovery graph exceeds maximum node count');
          break;
        }
        const keys = reflectOwnKeys(value);
        if (keys.some((key) => typeof key !== 'string') || keys.length !== length + 1) {
          reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
          break;
        }
        const descriptors = getOwnPropertyDescriptors(value);
        if (!Object.hasOwn(descriptors, 'length') || Object.keys(descriptors).length !== length + 1) {
          reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
          break;
        }
        for (let index = length - 1; index >= 0; index -= 1) {
          const key = String(index);
          const descriptor = descriptors[key];
          if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
            reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
            break;
          }
          stack.push({ kind: 'enter', value: descriptor.value, path: `${path}[${index}]`, depth: depth + 1, root: false });
        }
        continue;
      }

      const keys = reflectOwnKeys(value);
      if (keys.some((key) => typeof key !== 'string')) {
        reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
        break;
      }
      if (keys.length > RECOVERY_GRAPH_MAX_OBJECT_KEYS) {
        reject('RECOVERY_OBJECT_KEY_LIMIT_EXCEEDED', path, 'recovery object exceeds maximum key count');
        break;
      }
      const descriptors = getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== keys.length) {
        reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
        break;
      }
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          reject('RECOVERY_GRAPH_INVALID', path, 'recovery graph is not plain descriptor-only JSON-like data');
          break;
        }
        inspectKey(key, path);
        if (graphError) break;
        stack.push({ kind: 'enter', value: descriptor.value, path: propertyPath(path, key), depth: depth + 1, root: false });
      }
    }
  } catch {
    reject('RECOVERY_GRAPH_INVALID', currentPath, 'recovery graph is not plain descriptor-only JSON-like data');
  }
  return Object.freeze({
    sensitivePaths: Object.freeze(sensitivePaths),
    graphError,
  });
}

function validateStringArray(value, path, errors, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => !isNonEmptyString(item)) || new Set(value).size !== value.length) {
    errors.push(error('REFERENCE_LIST_INVALID', path, 'references must be unique non-empty strings'));
  }
}

function validateRecoveryRecord2(record) {
  const errors = [];
  const scan = scanRecoveryGraph(record);
  for (const path of scan.sensitivePaths) {
    errors.push(error('RECOVERY_SENSITIVE_CONTENT', path, 'sensitive content is forbidden in recovery records'));
  }
  if (scan.graphError) {
    errors.push(scan.graphError);
    return result(errors);
  }
  if (!requireExactKeys(record, RECOVERY_KEYS, RECOVERY_KEYS, errors)) return result(errors);
  requireSchema(record, 'RecoveryRecord2', errors);
  requireStrings(record, [
    'resource_id', 'resource_type', 'run_id', 'session_id',
  ], errors);
  if (!isPositiveInteger(record.lease_generation)) {
    errors.push(error('RECOVERY_GENERATION_INVALID', '$.lease_generation', 'lease generation must be positive'));
  }
  const identityResult = validateResourceIdentity2(record.resource_type, record.identity);
  for (const identityError of identityResult.errors) {
    errors.push(error(identityError.code, `$.identity${identityError.path.slice(1)}`, identityError.message));
  }
  if (identityResult.valid) {
    for (const field of ['run_id', 'session_id', 'lease_generation']) {
      if (record[field] !== record.identity[field]) {
        errors.push(error('RECOVERY_IDENTITY_BINDING_MISMATCH', `$.${field}`, `outer ${field} must match identity`));
      }
    }
  }
  if (!isPlainObject(record.current_phase)
    || !requireExactKeys(record.current_phase, ['phase', 'state'], ['phase', 'state'], errors, '$.current_phase')
    || !RECOVERY_PHASES.has(record.current_phase.phase)
    || !RECOVERY_PHASE_STATES.has(record.current_phase.state)) {
    errors.push(error('RECOVERY_PHASE_INVALID', '$.current_phase', 'current phase is invalid'));
  }
  if (!isPlainObject(record.last_valid_observation)
    || !requireExactKeys(record.last_valid_observation,
      ['observed_at', 'observation_ref', 'identity_ref'],
      ['observed_at', 'observation_ref', 'identity_ref'], errors, '$.last_valid_observation')) {
    errors.push(error('RECOVERY_OBSERVATION_INVALID', '$.last_valid_observation', 'last valid observation is invalid'));
  } else {
    if (!isTimestamp(record.last_valid_observation.observed_at)) {
      errors.push(error('RECOVERY_OBSERVATION_INVALID', '$.last_valid_observation.observed_at', 'observation timestamp is invalid'));
    }
    validateOpaqueReference(record.last_valid_observation.observation_ref, 'observation', '$.last_valid_observation.observation_ref', errors);
    validateOpaqueReference(record.last_valid_observation.identity_ref, 'identity', '$.last_valid_observation.identity_ref', errors);
  }
  validateOpaqueReference(record.cleanup_authority_ref, 'authority', '$.cleanup_authority_ref', errors);
  if (!TEARDOWN_CONDITIONS.has(record.teardown_condition)) {
    errors.push(error('RECOVERY_TEARDOWN_CONDITION_INVALID', '$.teardown_condition', 'teardown condition must be controlled'));
  } else if (RECOVERY_TEARDOWN_BY_TYPE[record.resource_type]
    && record.teardown_condition !== RECOVERY_TEARDOWN_BY_TYPE[record.resource_type]) {
    errors.push(error('RECOVERY_TEARDOWN_CONDITION_MISMATCH', '$.teardown_condition', 'teardown condition does not match resource type'));
  }
  validateStringArray(record.evidence_refs, '$.evidence_refs', errors);
  if (Array.isArray(record.evidence_refs)) {
    record.evidence_refs.forEach((ref, index) => validateOpaqueReference(ref, 'evidence', `$.evidence_refs[${index}]`, errors));
  }
  return result(errors);
}

function validateSupportMatrix2(matrix) {
  const errors = [];
  if (!requireExactKeys(matrix, SUPPORT_MATRIX_KEYS, SUPPORT_MATRIX_KEYS, errors)) {
    return result(errors, { effective_state: 'UNVERIFIED' });
  }
  requireSchema(matrix, 'SupportMatrix2', errors);
  requireStrings(matrix, ['adapter_id'], errors);
  if (!['windows', 'linux'].includes(matrix.platform)) {
    errors.push(error('SUPPORT_PLATFORM_INVALID', '$.platform', 'platform must be windows or linux'));
  }
  if (!isTimestamp(matrix.observed_at)) {
    errors.push(error('SUPPORT_TIMESTAMP_INVALID', '$.observed_at', 'observed_at must be a UTC timestamp'));
  }
  if (!SUPPORT_STATE_SET.has(matrix.overall_state)) {
    errors.push(error('SUPPORT_STATE_INVALID', '$.overall_state', 'support state is not controlled'));
  }
  if (!isPlainObject(matrix.claims) || Object.keys(matrix.claims).length === 0) {
    errors.push(error('SUPPORT_CLAIMS_INVALID', '$.claims', 'at least one support claim is required'));
  } else {
    Object.entries(matrix.claims).forEach(([capabilityId, claim]) => {
      const path = isCapabilityId(capabilityId)
        ? propertyPath('$.claims', capabilityId)
        : '$.claims.<redacted-key>';
      if (!requireExactKeys(claim, SUPPORT_CLAIM_KEYS, SUPPORT_CLAIM_KEYS, errors, path)) return;
      if (!isCapabilityId(capabilityId)) {
        errors.push(error('SUPPORT_CAPABILITY_INVALID', path, 'capability ID must use the controlled key grammar'));
      }
      if (!SUPPORT_STATE_SET.has(claim.state)) {
        errors.push(error('SUPPORT_STATE_INVALID', `${path}.state`, 'support state is not controlled'));
      }
      validateStringArray(claim.evidence_refs, `${path}.evidence_refs`, errors, claim.state === 'NOT_RUN');
      if (Array.isArray(claim.evidence_refs)) {
        claim.evidence_refs.forEach((ref, index) => validateOpaqueReference(
          ref,
          'evidence',
          `${path}.evidence_refs[${index}]`,
          errors,
          'SUPPORT_EVIDENCE_REFERENCE_INVALID',
        ));
      }
      if (claim.state === 'VERIFIED_FULL'
        && (!Array.isArray(claim.evidence_refs) || claim.evidence_refs.length === 0)) {
        errors.push(error('SUPPORT_FULL_EVIDENCE_REQUIRED', `${path}.evidence_refs`, 'full claims require execution evidence'));
      }
      if (claim.state === 'NOT_RUN'
        && Array.isArray(claim.evidence_refs)
        && claim.evidence_refs.length !== 0) {
        errors.push(error('SUPPORT_NOT_RUN_HAS_EVIDENCE', `${path}.evidence_refs`, 'NOT_RUN claims cannot cite execution evidence'));
      }
    });
  }
  if (errors.length === 0) {
    const states = Object.values(matrix.claims).map((claim) => claim.state);
    const effective = states.includes('FAILED')
      ? 'FAILED'
      : states.every((state) => state === 'NOT_RUN')
        ? 'NOT_RUN'
        : states.includes('UNVERIFIED')
          ? 'UNVERIFIED'
          : states.includes('NOT_RUN')
            ? 'UNVERIFIED'
            : states.includes('VERIFIED_DEGRADED')
              ? 'VERIFIED_DEGRADED'
              : 'VERIFIED_FULL';
    if (matrix.overall_state !== effective) {
      if (matrix.overall_state === 'VERIFIED_FULL') {
        errors.push(error('SUPPORT_FULL_WITH_INCOMPLETE_CLAIM', '$.overall_state', 'full support requires every claim to be fully verified'));
      }
      if (matrix.overall_state === 'NOT_RUN') {
        errors.push(error('SUPPORT_NOT_RUN_WITH_EXECUTED_CLAIM', '$.overall_state', 'NOT_RUN requires every claim to be NOT_RUN'));
      }
      errors.push(error('SUPPORT_OVERALL_STATE_MISMATCH', '$.overall_state', 'overall state does not match validated claims'));
    }
  }
  const effectiveState = errors.length > 0
    ? 'UNVERIFIED'
    : matrix.overall_state;
  return result(errors, { effective_state: effectiveState });
}

function createResourceIdentity2(resourceType, fields) {
  if (!isPlainObject(fields) || Object.hasOwn(fields, 'schema') || Object.hasOwn(fields, 'schema_version')) {
    throw new IdentitySupportV2Error('IDENTITY_V2_BUILD_REJECTED', result([
      error('IDENTITY_FACTORY_INPUT_INVALID', '$', 'factory owns schema fields'),
    ]));
  }
  let identity;
  if (resourceType === 'process_tree' || resourceType === 'command_session') {
    identity = { schema: 'ProcessIdentity2', schema_version: 2, ...fields };
  } else if (resourceType === 'agent_session' || resourceType === 'runtime_thread') {
    identity = { schema: 'HarnessSessionIdentity2', schema_version: 2, harness_kind: resourceType, ...fields };
  } else if (resourceType === 'temporary_allocation') {
    identity = { schema: 'TemporaryAllocationIdentity2', schema_version: 2, ...fields };
  } else {
    throw new IdentitySupportV2Error('IDENTITY_V2_BUILD_REJECTED', result([
      error('RESOURCE_IDENTITY_TYPE_UNSUPPORTED', '$.resource_type', 'resource type is unsupported'),
    ]));
  }
  const validation = validateResourceIdentity2(resourceType, identity);
  if (!validation.valid) throw new IdentitySupportV2Error('IDENTITY_V2_BUILD_REJECTED', validation);
  return cloneAndFreeze(identity);
}

function createRecoveryRecord2(fields) {
  if (!isPlainObject(fields) || Object.hasOwn(fields, 'schema') || Object.hasOwn(fields, 'schema_version')) {
    throw new IdentitySupportV2Error('RECOVERY_V2_BUILD_REJECTED', result([
      error('RECOVERY_FACTORY_INPUT_INVALID', '$', 'factory owns schema fields'),
    ]));
  }
  const record = { schema: 'RecoveryRecord2', schema_version: 2, ...fields };
  const validation = validateRecoveryRecord2(record);
  if (!validation.valid) throw new IdentitySupportV2Error('RECOVERY_V2_BUILD_REJECTED', validation);
  return cloneAndFreeze(record);
}

module.exports = {
  IdentitySupportV2Error,
  SUPPORT_STATES2,
  createRecoveryRecord2,
  createResourceIdentity2,
  validateHarnessSessionIdentity2,
  validateProcessIdentity2,
  validateRecoveryRecord2,
  validateResourceIdentity2,
  validateSupportMatrix2,
  validateTemporaryAllocationIdentity2,
};
