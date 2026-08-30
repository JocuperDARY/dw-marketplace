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
const UTC_TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?Z$/;
const SENSITIVE_KEY = /(?:^|_)(?:user_?prompt|model_?(?:reply|response)|command_?output|stdout|stderr|api_?key|access_?token|credential|secret|password)(?:$|_)/i;
const SENSITIVE_VALUE = /(?:^|[\s,;:{[(])(?:api[_-]?key|access[_-]?token|credential|secret|password|bearer)(?:\s|=|:|$)/i;

const PROCESS_BASE_KEYS = Object.freeze([
  'schema',
  'schema_version',
  'platform',
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
  'harness_kind',
  'session_id',
  'owner_id',
  'run_id',
  'lease_generation',
  'harness_instance_id',
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
const SUPPORT_CLAIM_KEYS = Object.freeze(['capability_id', 'state', 'evidence_refs']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
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
      errors.push(error('IDENTITY_ADDITIONAL_PROPERTY', `${path}.${key}`, 'unsupported property'));
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
  requireStrings(identity, ['launch_nonce', 'manager_run_id'], errors);
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
      ['proc_start_ticks', 'boot_id_sha256'],
      ['proc_start_ticks', 'boot_id_sha256'], errors, '$.linux_identity')) {
      if (!isPositiveInteger(identity.linux_identity.proc_start_ticks)) {
        errors.push(error('PROCESS_PLATFORM_FIELD_INVALID', '$.linux_identity.proc_start_ticks', 'proc start ticks must be a positive safe integer'));
      }
      if (!SHA256.test(identity.linux_identity.boot_id_sha256 || '')) {
        errors.push(error('IDENTITY_HASH_INVALID', '$.linux_identity.boot_id_sha256', 'boot ID must be a lowercase SHA-256 value'));
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
  const required = HARNESS_KEYS.filter((key) => key !== 'process_identity');
  if (!requireExactKeys(identity, HARNESS_KEYS, required, errors)) return result(errors);
  requireSchema(identity, 'HarnessSessionIdentity2', errors);
  if (!['agent_session', 'runtime_thread'].includes(identity.harness_kind)) {
    errors.push(error('HARNESS_KIND_INVALID', '$.harness_kind', 'unsupported harness kind'));
  }
  requireStrings(identity, ['session_id', 'owner_id', 'run_id', 'harness_instance_id'], errors);
  if (!isPositiveInteger(identity.lease_generation)) {
    errors.push(error('HARNESS_GENERATION_INVALID', '$.lease_generation', 'lease generation must be positive'));
  }
  if (Object.hasOwn(identity, 'process_identity')) {
    const processResult = validateProcessIdentity2(identity.process_identity);
    for (const processError of processResult.errors) {
      errors.push(error(processError.code, `$.process_identity${processError.path.slice(1)}`, processError.message));
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
  requireHashes(identity, ['manifest_sha256'], errors);
  if (!isPositiveInteger(identity.lease_generation)) {
    errors.push(error('TEMPORARY_GENERATION_INVALID', '$.lease_generation', 'lease generation must be positive'));
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

function findSensitiveContent(value, path = '$', matches = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveContent(item, `${path}[${index}]`, matches));
    return matches;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (SENSITIVE_KEY.test(key)) matches.push(childPath);
      findSensitiveContent(item, childPath, matches);
    }
    return matches;
  }
  if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) matches.push(path);
  return matches;
}

function validateStringArray(value, path, errors, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => !isNonEmptyString(item)) || new Set(value).size !== value.length) {
    errors.push(error('REFERENCE_LIST_INVALID', path, 'references must be unique non-empty strings'));
  }
}

function validateRecoveryRecord2(record) {
  const errors = [];
  const sensitivePaths = findSensitiveContent(record);
  for (const path of sensitivePaths) {
    errors.push(error('RECOVERY_SENSITIVE_CONTENT', path, 'sensitive content is forbidden in recovery records'));
  }
  if (!requireExactKeys(record, RECOVERY_KEYS, RECOVERY_KEYS, errors)) return result(errors);
  requireSchema(record, 'RecoveryRecord2', errors);
  requireStrings(record, [
    'resource_id', 'resource_type', 'run_id', 'session_id', 'cleanup_authority_ref', 'teardown_condition',
  ], errors);
  if (!isPositiveInteger(record.lease_generation)) {
    errors.push(error('RECOVERY_GENERATION_INVALID', '$.lease_generation', 'lease generation must be positive'));
  }
  const identityResult = validateResourceIdentity2(record.resource_type, record.identity);
  for (const identityError of identityResult.errors) {
    errors.push(error(identityError.code, `$.identity${identityError.path.slice(1)}`, identityError.message));
  }
  validateStringArray(record.evidence_refs, '$.evidence_refs', errors);
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
  if (!Array.isArray(matrix.claims) || matrix.claims.length === 0) {
    errors.push(error('SUPPORT_CLAIMS_INVALID', '$.claims', 'at least one support claim is required'));
  } else {
    const capabilityIds = new Set();
    matrix.claims.forEach((claim, index) => {
      const path = `$.claims[${index}]`;
      if (!requireExactKeys(claim, SUPPORT_CLAIM_KEYS, SUPPORT_CLAIM_KEYS, errors, path)) return;
      if (!isNonEmptyString(claim.capability_id)) {
        errors.push(error('SUPPORT_CAPABILITY_INVALID', `${path}.capability_id`, 'capability ID must be non-empty'));
      } else if (capabilityIds.has(claim.capability_id)) {
        errors.push(error('SUPPORT_CAPABILITY_DUPLICATE', `${path}.capability_id`, 'capability IDs must be unique'));
      } else capabilityIds.add(claim.capability_id);
      if (!SUPPORT_STATE_SET.has(claim.state)) {
        errors.push(error('SUPPORT_STATE_INVALID', `${path}.state`, 'support state is not controlled'));
      }
      validateStringArray(claim.evidence_refs, `${path}.evidence_refs`, errors, claim.state === 'NOT_RUN');
      if (claim.state === 'NOT_RUN'
        && Array.isArray(claim.evidence_refs)
        && claim.evidence_refs.length !== 0) {
        errors.push(error('SUPPORT_NOT_RUN_HAS_EVIDENCE', `${path}.evidence_refs`, 'NOT_RUN claims cannot cite execution evidence'));
      }
    });
  }
  if (matrix.overall_state === 'VERIFIED_FULL'
    && Array.isArray(matrix.claims)
    && matrix.claims.some((claim) => claim.state !== 'VERIFIED_FULL')) {
    errors.push(error('SUPPORT_FULL_WITH_INCOMPLETE_CLAIM', '$.overall_state', 'full support requires every claim to be fully verified'));
  }
  if (matrix.overall_state === 'NOT_RUN'
    && Array.isArray(matrix.claims)
    && matrix.claims.some((claim) => claim.state !== 'NOT_RUN')) {
    errors.push(error('SUPPORT_NOT_RUN_WITH_EXECUTED_CLAIM', '$.overall_state', 'NOT_RUN requires every claim to be NOT_RUN'));
  }
  const effectiveState = errors.some((item) => item.code === 'SUPPORT_FULL_WITH_INCOMPLETE_CLAIM')
    ? 'UNVERIFIED'
    : (SUPPORT_STATE_SET.has(matrix.overall_state) ? matrix.overall_state : 'UNVERIFIED');
  return result(errors, { effective_state: effectiveState });
}

module.exports = {
  SUPPORT_STATES2,
  validateHarnessSessionIdentity2,
  validateProcessIdentity2,
  validateRecoveryRecord2,
  validateResourceIdentity2,
  validateSupportMatrix2,
  validateTemporaryAllocationIdentity2,
};
