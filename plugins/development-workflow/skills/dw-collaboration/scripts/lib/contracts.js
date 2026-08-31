'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  canonicalize,
  computeDetachedContentSha256,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');
const stateMachines = require('./state-machines');
const identitySupportV2 = require('./identity-support-v2');

const CAPABILITY_IDS = Object.freeze(['spawn_child', 'collect_result', 'child_to_root_message', 'root_to_child_message', 'interrupt_child', 'request_shutdown', 'verify_child_exit', 'shared_task_status', 'isolated_workspace', 'exclusive_file_ownership', 'runtime_liveness', 'process_identity', 'process_tree_terminate', 'terminal_session_control', 'temporary_lease', 'constrained_compute_lease', 'resource_observation', 'model_request_control', 'reasoning_request_control', 'actual_model_metadata', 'actual_effort_metadata']);
const CAPABILITY_SUBJECTS = Object.freeze(['root', 'child', 'adapter']);
const SUPPORT = Object.freeze(['supported', 'request_only', 'unsupported', 'unknown']);
const EVIDENCE_LEVELS = Object.freeze(['DECLARED', 'PROBED', 'OBSERVED', 'VERIFIED']);
const SOURCE_KINDS = Object.freeze(['config', 'inventory', 'probe', 'runtime_event', 'verifier']);
const REDACTION_POLICIES = Object.freeze(['metadata_only', 'hashed_identifiers', 'approved_excerpt']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EXTENSION_KEY = /^[a-z][a-z0-9_-]*:[A-Za-z0-9_.-]+$/;
const UTC_TIMESTAMP_PATTERN = '^(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)(?:\\.(\\d+))?Z$';
const UTC_TIMESTAMP_RE = new RegExp(UTC_TIMESTAMP_PATTERN);
const MAX_CAPABILITIES = 1024;
const MAX_SUPERSEDES = 64;
const MAX_SUPERSEDES_TOTAL = 8192;
const MAX_PLAN_ARTIFACTS = 256;
const MAX_PLAN_PHASES = 256;
const MAX_PHASE_DEPENDENCIES = 256;
const MAX_OWNERSHIP_PATHS = 256;
const MAX_ROUTE_FALLBACKS = 256;
const CAPABILITY_CLASS_RANK = Object.freeze({ light: 0, standard: 1, engineering: 2, professional: 3, assurance: 4 });
const TASK_PACKET_KEYS = Object.freeze([
  'packet_version', 'phase_id', 'objective', 'acceptance_criteria',
  'dependency_artifact_hashes', 'owned_paths_resources', 'forbidden_actions',
  'authorization_scope', 'allowed_capabilities', 'expected_output_schema',
  'validation_commands', 'timeout_progress_contract', 'cleanup_duties', 'return_channel',
]);
const PLAN_ROOT_KEYS = Object.freeze([
  'schema', 'schema_version', 'artifact_id', 'run_id', 'session_id', 'created_at',
  'producer', 'redaction', 'status', 'topology', 'capability_matrix_ref', 'phases',
  'resource_policy', 'failure_policy', 'telemetry_policy', 'gates', 'content_sha256',
]);
const PLAN_PHASE_KEYS = Object.freeze([
  'phase_id', 'task_type', 'scope', 'dependencies', 'risk', 'reversibility',
  'phase_kind', 'latency_cost', 'validation_failure_cost', 'task_packet_ref',
  'ownership', 'route',
]);
const PLAN_ROUTE_KEYS = Object.freeze([
  'requested_model', 'requested_effort', 'selected_model', 'selected_effort',
  'selection_evidence', 'allowed_fallbacks',
]);
const PLAN_TASK_TYPES = Object.freeze(['retrieval', 'classification', 'planning', 'implementation', 'debugging', 'review', 'verification', 'mechanical', 'unknown']);
const PLAN_SCOPES = Object.freeze(['single_unit', 'bounded_single_module', 'cross_module', 'cross_system', 'unknown']);
const PLAN_RISKS = Object.freeze(['low', 'medium', 'high', 'extreme']);
const PLAN_REVERSIBILITY = Object.freeze(['reversible', 'unclear', 'irreversible']);
const PLAN_PHASE_KINDS = Object.freeze(['diagnosis', 'planning', 'implementation', 'data_integrity', 'test_gates', 'verification', 'wrapup', 'unknown']);
const PLAN_LATENCY_COSTS = Object.freeze(['interactive', 'balanced', 'throughput', 'offline', 'unknown']);
const PLAN_VALIDATION_COSTS = Object.freeze(['automatic_check', 'focused_tests', 'independent_verification', 'rollback_proof', 'full_surface_audit', 'unknown']);
const PLAN_EFFORTS = Object.freeze(['unspecified', 'low', 'medium', 'high', 'xhigh', 'max', 'unknown']);
const PROCESS_RECOVERY_ACTIONS = Object.freeze(['REQUEST_GRACEFUL', 'WAIT_BOUNDED', 'TERMINATE_EXACT_TREE', 'OBSERVE_ONLY', 'HOLD']);
const TEMPORARY_LEASE_ACTIONS = Object.freeze(['ALLOW_WRITE', 'STOP_EXPANSION', 'STOP_DISPATCH', 'OBSERVE_ONLY', 'QUARANTINE', 'RECLAIM_EXACT', 'HOLD']);
const PROGRESS_CLASSIFICATIONS = Object.freeze(['QUIET_PROGRESS', 'EXTERNAL_WAIT', 'SUSPECTED_HUNG', 'UNVERIFIED']);
const RUN_OUTCOMES = Object.freeze(['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED', 'HOLD', 'UNVERIFIED']);
const ROUTE_ATTESTATIONS = Object.freeze(['VERIFIED', 'UNVERIFIED', 'NOT_REQUIRED']);
const CLEANUP_STATUSES = Object.freeze(['all_reclaimed', 'quarantined', 'unknown']);
const AUTHORIZATION_ACTIONS = Object.freeze(['execute_plan', 'select_assurance_route', 'local_edit', 'stage', 'commit', 'push', 'merge', 'publish', 'deploy', 'paid_job', 'credential_change', 'config_change', 'constrained_compute']);
const TEMP_MANIFEST_KEYS = Object.freeze(['owner_id', 'run_id', 'session_id', 'lease_generation', 'canonical_root_identity', 'created_at', 'quota_profile_ref', 'watermark_policy_ref', 'child_sublease_map', 'retention_set', 'state', 'manifest_sha256']);
const TEMP_ROOT_KEYS = Object.freeze(['canonical_path', 'path_identity_hash', 'parent_identity_hash', 'platform']);
const TEMP_SUBLEASE_KEYS = Object.freeze(['owner_id', 'canonical_descendant', 'nonce', 'lease_generation', 'soft_quota', 'hard_quota', 'teardown_condition']);
const TEMP_OBSERVATION_KEYS = Object.freeze(['owner_id', 'run_id', 'session_id', 'lease_generation', 'canonical_root_identity', 'child_path', 'usage', 'available', 'ttl_expired', 'active_handles', 'quiescent', 'identity_observed', 'reparse_boundary', 'path_rebound', 'retention_set_sealed', 'retention_set_hash', 'teardown_condition_met', 'precheck_identity_hash', 'postcheck_identity_hash']);
const POLICY_RECEIPT_KEYS = Object.freeze(['policy_id', 'kind', 'source_kind', 'observed_at', 'values', 'evidence_refs', 'source_sha256']);
const artifactSnapshots = new WeakMap();
const capabilitySnapshots = new WeakMap();
let authorizationGeneration = Object.freeze({});

class ContractError extends Error {
  constructor(code, path, message) { super(message || 'contract rejected'); this.name = 'ContractError'; this.code = code; this.path = path || '$'; }
  toJSON() { return { code: this.code, path: this.path, message: this.message }; }
}

function makeResult(schema) { return { valid: false, schema: schema || null, errors: [], warnings: [] }; }
function error(result, code, path, message) { result.errors.push(new ContractError(code, path, message)); }
function isPlainObject(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null; }
function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }
function trustedResolverAccepts(resolver, purpose, record, context) {
  if (typeof resolver !== 'function') return false;
  try {
    const request = Object.freeze({
      purpose,
      record: createDetachedJsonSnapshot(record).snapshot,
      context: createDetachedJsonSnapshot(context).snapshot,
    });
    return resolver(request) === true;
  } catch (_) {
    return false;
  }
}
function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText));
  date.setUTCHours(Number(hourText), Number(minuteText), Number(secondText), 0);
  return date.getUTCFullYear() === Number(yearText)
    && date.getUTCMonth() === Number(monthText) - 1
    && date.getUTCDate() === Number(dayText)
    && date.getUTCHours() === Number(hourText)
    && date.getUTCMinutes() === Number(minuteText)
    && date.getUTCSeconds() === Number(secondText);
}
function compareUtcTimestamps(left, right) {
  const leftMatch = typeof left === 'string' ? UTC_TIMESTAMP_RE.exec(left) : null;
  const rightMatch = typeof right === 'string' ? UTC_TIMESTAMP_RE.exec(right) : null;
  if (!leftMatch || !rightMatch) return 0;
  for (let index = 1; index <= 6; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  const leftFraction = leftMatch[7] || '';
  const rightFraction = rightMatch[7] || '';
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, '0');
  const normalizedRight = rightFraction.padEnd(width, '0');
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}
function hasOnlyKeys(value, allowed, path, result) { for (const key of Object.keys(value)) if (!allowed.has(key)) error(result, 'ADDITIONAL_PROPERTY', `${path}.*`, 'unrecognized contract property'); }
function validateExtensions(extensions, path, result) { if (extensions === undefined) return; if (!isPlainObject(extensions)) { error(result, 'EXTENSIONS_INVALID', path, 'extensions must be an object'); return; } for (const key of Object.keys(extensions)) if (!EXTENSION_KEY.test(key)) error(result, 'EXTENSION_NAMESPACE_INVALID', `${path}.*`, 'extension key must be namespaced'); }

function validateOwnContentHash(snapshot) {
  const result = makeResult(isPlainObject(snapshot) && typeof snapshot.schema === 'string' ? snapshot.schema : null);
  if (!isPlainObject(snapshot)) { error(result, 'ARTIFACT_SHAPE_INVALID', '$', 'artifact must be an object'); return result; }
  const supplied = snapshot.content_sha256;
  if (typeof supplied !== 'string' || !SHA256_HEX.test(supplied)) { error(result, 'CONTENT_HASH_INVALID', '$.content_sha256', 'content hash must be lowercase SHA-256 hex'); return result; }
  let computed;
  try { computed = computeDetachedContentSha256(snapshot); } catch (_) { error(result, 'CANONICAL_REJECTED', '$', 'canonical JSON rejected'); return result; }
  if (!crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(computed, 'hex'))) error(result, 'CONTENT_HASH_MISMATCH', '$.content_sha256', 'content hash does not match');
  result.valid = result.errors.length === 0;
  return result;
}

function validateCommonFields(artifact, result) {
  const required = ['schema', 'schema_version', 'artifact_id', 'run_id', 'session_id', 'created_at', 'producer', 'redaction', 'capabilities', 'content_sha256'];
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(artifact, field)) error(result, 'REQUIRED_FIELD_MISSING', `$.${field}`, 'required contract field is missing');
  hasOnlyKeys(artifact, new Set([...required, 'extensions']), '$', result); validateExtensions(artifact.extensions, '$.extensions', result);
  if (artifact.schema !== 'CapabilityMatrix1') error(result, 'SCHEMA_IDENTITY_INVALID', '$.schema', 'unsupported artifact schema');
  if (artifact.schema_version !== 1) error(result, 'SCHEMA_VERSION_UNSUPPORTED', '$.schema_version', 'unsupported schema version');
  for (const field of ['artifact_id', 'run_id', 'session_id']) if (!isNonEmptyString(artifact[field])) error(result, 'IDENTIFIER_INVALID', `$.${field}`, 'identifier must be a non-empty string');
  if (!isUtcTimestamp(artifact.created_at)) error(result, 'TIMESTAMP_INVALID', '$.created_at', 'timestamp must be RFC3339 UTC');
  if (!isPlainObject(artifact.producer) || !CAPABILITY_SUBJECTS.includes(artifact.producer.role)) error(result, 'PRODUCER_INVALID', '$.producer', 'producer identity is invalid');
  else { hasOnlyKeys(artifact.producer, new Set(['role', 'adapter_id']), '$.producer', result); if (!isNonEmptyString(artifact.producer.adapter_id)) error(result, 'PRODUCER_ADAPTER_REQUIRED', '$.producer.adapter_id', 'producer adapter identity is required'); }
  if (!isPlainObject(artifact.redaction) || !REDACTION_POLICIES.includes(artifact.redaction.policy)) error(result, 'REDACTION_INVALID', '$.redaction', 'redaction policy is invalid');
  else hasOnlyKeys(artifact.redaction, new Set(['policy']), '$.redaction', result);
  if (!Array.isArray(artifact.capabilities)) error(result, 'CAPABILITIES_INVALID', '$.capabilities', 'capabilities must be an array');
}

function validateScope(scope, path, result, options) {
  if (!isPlainObject(scope)) { error(result, 'CAPABILITY_SCOPE_INVALID', path, 'scope must be an object'); return; }
  hasOnlyKeys(scope, new Set(['adapter_fingerprint', 'auth_fingerprint', 'adapter_generation']), path, result);
  for (const field of ['adapter_fingerprint', 'auth_fingerprint']) if (!Object.prototype.hasOwnProperty.call(scope, field) || !isNonEmptyString(scope[field])) error(result, 'CAPABILITY_SCOPE_INVALID', `${path}.${field}`, 'scope identity is required');
  if (!Object.prototype.hasOwnProperty.call(scope, 'adapter_generation')) error(result, 'CAPABILITY_GENERATION_INVALID', `${path}.adapter_generation`, 'adapter generation is required');
  if (!Number.isSafeInteger(scope.adapter_generation) || scope.adapter_generation < 1) error(result, 'CAPABILITY_GENERATION_INVALID', `${path}.adapter_generation`, 'adapter generation is required');
  if (options.adapterFingerprint && scope.adapter_fingerprint !== options.adapterFingerprint) error(result, 'CAPABILITY_ADAPTER_MISMATCH', `${path}.adapter_fingerprint`, 'adapter identity does not match');
  if (options.authFingerprint && scope.auth_fingerprint !== options.authFingerprint) error(result, 'CAPABILITY_AUTH_MISMATCH', `${path}.auth_fingerprint`, 'authorization identity does not match');
  if (options.adapterGeneration && scope.adapter_generation !== options.adapterGeneration) error(result, 'CAPABILITY_GENERATION_MISMATCH', `${path}.adapter_generation`, 'adapter generation does not match');
}

function validateContradictions(contradictions, observedAt, path, result) {
  if (!Array.isArray(contradictions)) { error(result, 'CONTRADICTIONS_INVALID', path, 'contradictions must be an array'); return; }
  for (let index = 0; index < contradictions.length; index += 1) {
    const item = contradictions[index]; const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item) || !isNonEmptyString(item.evidence_ref) || !isUtcTimestamp(item.observed_at) || !SUPPORT.includes(item.support) || !SOURCE_KINDS.includes(item.source_kind) || !isNonEmptyString(item.reason_code)) { error(result, 'CONTRADICTION_INVALID', itemPath, 'contradiction evidence is invalid'); continue; }
    hasOnlyKeys(item, new Set(['evidence_ref', 'observed_at', 'support', 'source_kind', 'reason_code']), itemPath, result);
    if (compareUtcTimestamps(item.observed_at, observedAt) > 0) error(result, 'CAPABILITY_CONTRADICTED', itemPath, 'newer contradiction prevents use');
  }
}

function validateProbe(item, artifact, path, result) {
  const hasProbe = Object.prototype.hasOwnProperty.call(item, 'probe');
  if (hasProbe && !['PROBED', 'VERIFIED'].includes(item.evidence_level)) error(result, 'PROBE_EVIDENCE_LEVEL_INVALID', path, 'probe requires probed evidence');
  if (!hasProbe && item.evidence_level !== 'PROBED') return;
  if (item.evidence_level === 'PROBED' && item.source_kind !== 'probe') error(result, 'PROBE_ACK_REQUIRED', path, 'probed capability requires probe evidence');
  if (!hasProbe || !isPlainObject(item.probe)) { error(result, 'PROBE_ACK_REQUIRED', path, 'probed capability requires probe evidence'); return; }
  hasOnlyKeys(item.probe, new Set(['session_id', 'nonce', 'ack_ref']), path, result);
  for (const field of ['session_id', 'nonce', 'ack_ref']) {
    if (!Object.prototype.hasOwnProperty.call(item.probe, field) || !isNonEmptyString(item.probe[field])) error(result, 'PROBE_ACK_REQUIRED', `${path}.${field}`, 'probe nonce and acknowledgement are required');
  }
  if (item.probe.session_id !== artifact.session_id) error(result, 'PROBE_SESSION_MISMATCH', `${path}.session_id`, 'probe session does not match artifact');
}

function validateVerification(item, artifact, path, result, options) {
  if (item.verification !== undefined && item.evidence_level !== 'VERIFIED') error(result, 'VERIFICATION_EVIDENCE_LEVEL_INVALID', path, 'verification requires VERIFIED evidence');
  if (item.evidence_level !== 'VERIFIED') return;
  const verification = item.verification;
  if (!isPlainObject(verification)
    || !Object.prototype.hasOwnProperty.call(verification, 'verifier_id')
    || !Object.prototype.hasOwnProperty.call(verification, 'artifact_id')
    || !Object.prototype.hasOwnProperty.call(verification, 'content_sha256')
    || !isNonEmptyString(verification.verifier_id)
    || !isNonEmptyString(verification.artifact_id)
    || typeof verification.content_sha256 !== 'string'
    || !SHA256_HEX.test(verification.content_sha256)) error(result, 'VERIFIER_EVIDENCE_REQUIRED', path, 'verified capability requires verifier identity and artifact hash');
  if (item.source_kind !== 'verifier') error(result, 'VERIFIER_SOURCE_REQUIRED', `${path}.source_kind`, 'verified capability requires verifier source');
  if (isPlainObject(verification)) {
    hasOnlyKeys(verification, new Set(['verifier_id', 'artifact_id', 'content_sha256']), path, result);
    if (!(options.artifactIndex instanceof Map)) {
      error(result, 'VERIFIED_ARTIFACT_MISSING', `${path}.artifact_id`, 'verified artifact index is required');
    } else if (isNonEmptyString(verification.artifact_id)) {
      const verifiedArtifact = options.artifactIndex.get(verification.artifact_id);
      if (!verifiedArtifact) error(result, 'VERIFIED_ARTIFACT_MISSING', `${path}.artifact_id`, 'verified artifact is not present');
      else {
        if (verification.content_sha256 !== verifiedArtifact.content_sha256) error(result, 'VERIFIED_HASH_MISMATCH', `${path}.content_sha256`, 'verified artifact hash does not match');
        if (artifact.run_id !== verifiedArtifact.run_id || artifact.session_id !== verifiedArtifact.session_id) error(result, 'VERIFIED_SESSION_MISMATCH', path, 'verified artifact session does not match');
        if (!trustedResolverAccepts(options.trustedRuntimeResolver, 'capability_verification', verifiedArtifact, {
          matrix_artifact_id: artifact.artifact_id,
          capability_evidence_ref: item.evidence_ref,
          verifier_id: verification.verifier_id,
          run_id: artifact.run_id,
          session_id: artifact.session_id,
        })) error(result, 'VERIFIED_TRUST_NOT_PROVEN', path, 'verified capability requires a trusted host attestation resolver');
      }
    }
  }
}

function validateCapability(item, artifact, index, result, options) {
  const path = `$.capabilities[${index}]`;
  if (!isPlainObject(item)) { error(result, 'CAPABILITY_INVALID', path, 'capability must be an object'); return null; }
  const required = ['capability_id', 'subject', 'support', 'evidence_level', 'source_kind', 'scope', 'observed_at', 'expires_at', 'evidence_ref', 'contradictions'];
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(item, field)) error(result, 'REQUIRED_FIELD_MISSING', `${path}.${field}`, 'required capability field is missing');
  hasOnlyKeys(item, new Set([...required, 'supersedes', 'probe', 'verification', 'extensions']), path, result); validateExtensions(item.extensions, `${path}.extensions`, result);
  if (!CAPABILITY_IDS.includes(item.capability_id)) error(result, 'CAPABILITY_ID_INVALID', `${path}.capability_id`, 'unsupported capability ID');
  if (!CAPABILITY_SUBJECTS.includes(item.subject)) error(result, 'CAPABILITY_SUBJECT_INVALID', `${path}.subject`, 'invalid capability subject');
  if (!SUPPORT.includes(item.support)) error(result, 'CAPABILITY_SUPPORT_INVALID', `${path}.support`, 'invalid capability support');
  if (!EVIDENCE_LEVELS.includes(item.evidence_level)) error(result, 'EVIDENCE_LEVEL_INVALID', `${path}.evidence_level`, 'invalid evidence level');
  if (!SOURCE_KINDS.includes(item.source_kind)) error(result, 'SOURCE_KIND_INVALID', `${path}.source_kind`, 'invalid evidence source');
  validateScope(item.scope, `${path}.scope`, result, options);
  if (!isUtcTimestamp(item.observed_at) || !isUtcTimestamp(item.expires_at)) error(result, 'TIMESTAMP_INVALID', path, 'capability times must be RFC3339 UTC');
  else { if (compareUtcTimestamps(item.observed_at, options.now) > 0) error(result, 'CAPABILITY_FUTURE', `${path}.observed_at`, 'capability observation is in the future'); if (compareUtcTimestamps(item.expires_at, item.observed_at) <= 0) error(result, 'CAPABILITY_TIME_WINDOW_INVALID', path, 'expiry must follow observation'); if (compareUtcTimestamps(item.expires_at, options.now) <= 0) error(result, 'CAPABILITY_STALE', `${path}.expires_at`, 'capability evidence has expired'); }
  if (!isNonEmptyString(item.evidence_ref)) error(result, 'EVIDENCE_REFERENCE_INVALID', `${path}.evidence_ref`, 'evidence reference is required');
  if (item.supersedes !== undefined && (!Array.isArray(item.supersedes) || item.supersedes.some((entry) => !isNonEmptyString(entry)))) error(result, 'SUPERSEDES_INVALID', `${path}.supersedes`, 'supersedes must contain evidence identifiers');
  if (Array.isArray(item.supersedes) && item.supersedes.length > MAX_SUPERSEDES) error(result, 'CONTRACT_LIMIT_EXCEEDED', `${path}.supersedes`, 'supersedes limit exceeded');
  validateContradictions(item.contradictions, item.observed_at, `${path}.contradictions`, result); validateProbe(item, artifact, `${path}.probe`, result); validateVerification(item, artifact, `${path}.verification`, result, options);
  return item;
}

function validateDuplicateCapabilities(capabilities, result) {
  const groups = new Map();
  for (const item of capabilities) {
    if (!item || !isNonEmptyString(item.capability_id) || !isNonEmptyString(item.subject) || !isPlainObject(item.scope)) continue;
    let scopeKey; try { scopeKey = canonicalize(item.scope); } catch (_) { continue; }
    const key = `${item.subject}\u0000${item.capability_id}\u0000${scopeKey}`; const group = groups.get(key) || []; group.push(item); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (group.length > MAX_CAPABILITIES) { error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.capabilities', 'capability group limit exceeded'); continue; }
    const refs = new Set(group.map((item) => item.evidence_ref).filter(isNonEmptyString)); const byRef = new Map(group.map((item) => [item.evidence_ref, new Set(Array.isArray(item.supersedes) ? item.supersedes : [])])); let validChain = true;
    const ordered = [...group].sort((left, right) => compareUtcTimestamps(left.observed_at, right.observed_at));
    for (let index = 1; index < ordered.length; index += 1) if (!Array.isArray(ordered[index].supersedes) || !ordered[index].supersedes.includes(ordered[index - 1].evidence_ref)) validChain = false;
    const state = new Map();
    for (const root of byRef.keys()) {
      if (state.get(root) === 2) continue;
      const stack = [[root, false]];
      while (stack.length) {
        const [reference, exiting] = stack.pop();
        if (exiting) { state.set(reference, 2); continue; }
        if (state.get(reference) === 1) { validChain = false; continue; }
        if (state.get(reference) === 2) continue;
        state.set(reference, 1); stack.push([reference, true]);
        for (const next of byRef.get(reference) || []) { if (!refs.has(next)) { validChain = false; continue; } stack.push([next, false]); }
      }
    }
    if (!validChain) error(result, 'DUPLICATE_EFFECTIVE_CAPABILITY', '$.capabilities', 'duplicate capability lacks an acyclic supersedes chain');
  }
}

function clearSnapshots(artifact) {
  if (!artifact || typeof artifact !== 'object') return;
  const record = artifactSnapshots.get(artifact);
  if (record) invalidateRecord(record);
}
function invalidateRecord(record) {
  if (artifactSnapshots.get(record.source) === record) artifactSnapshots.delete(record.source);
  for (const binding of record.bindings) {
    const token = capabilitySnapshots.get(binding.source);
    if (token && token.record === record) capabilitySnapshots.delete(binding.source);
  }
}
function rejectedResult(caught) {
  const result = makeResult(null);
  error(result, caught && caught.code === 'CONTRACT_LIMIT_EXCEEDED' ? 'CONTRACT_LIMIT_EXCEEDED' : 'CANONICAL_REJECTED', '$', 'artifact input rejected');
  return result;
}
function invalidateAllAuthorization() { authorizationGeneration = Object.freeze({}); }
function makePreparedArtifact(source, snapshot, origins) {
  return {
    source,
    snapshot,
    origins,
    contentHash: computeDetachedContentSha256(snapshot),
    fullHash: computeDetachedSha256(snapshot),
  };
}
function prepareArtifact(source) {
  const { snapshot, origins } = createDetachedJsonSnapshot(source);
  return makePreparedArtifact(source, snapshot, origins);
}
function getCapabilityBindings(prepared) {
  if (!isPlainObject(prepared.snapshot) || !Array.isArray(prepared.snapshot.capabilities)) return [];
  return prepared.snapshot.capabilities.map((snapshot, index) => ({
    index,
    snapshot,
    source: snapshot && typeof snapshot === 'object' ? prepared.origins.get(snapshot) : null,
  }));
}
function publishSnapshot(prepared) {
  clearSnapshots(prepared.source);
  const bindings = getCapabilityBindings(prepared).filter((binding) => binding.source && typeof binding.source === 'object');
  const record = Object.freeze({
    authorizationGeneration,
    bindings: Object.freeze(bindings.map((binding) => Object.freeze(binding))),
    fullHash: prepared.fullHash,
    snapshot: prepared.snapshot,
    source: prepared.source,
  });
  artifactSnapshots.set(prepared.source, record);
  for (const binding of record.bindings) capabilitySnapshots.set(binding.source, Object.freeze({ binding, record }));
}
function recordIsCurrent(record) {
  try {
    if (record.authorizationGeneration !== authorizationGeneration) { invalidateRecord(record); return false; }
    const fresh = prepareArtifact(record.source);
    if (fresh.fullHash !== record.fullHash) { invalidateRecord(record); return false; }
    const freshBindings = getCapabilityBindings(fresh);
    if (freshBindings.length !== record.bindings.length) { invalidateRecord(record); return false; }
    for (let index = 0; index < record.bindings.length; index += 1) {
      if (freshBindings[index].source !== record.bindings[index].source) { invalidateRecord(record); return false; }
    }
    return artifactSnapshots.get(record.source) === record;
  } catch (_) {
    invalidateRecord(record);
    return false;
  }
}
function artifactSnapshotIsCurrent(artifact) {
  const record = artifact && typeof artifact === 'object' ? artifactSnapshots.get(artifact) : null;
  return Boolean(record && recordIsCurrent(record));
}
function currentCapabilityToken(capability) {
  const token = capability && typeof capability === 'object' ? capabilitySnapshots.get(capability) : null;
  if (!token || !recordIsCurrent(token.record) || capabilitySnapshots.get(capability) !== token) return null;
  return token;
}
function validatePreparedArtifact(prepared, options = {}, publish = true) {
  const artifact = prepared.snapshot;
  const hashResult = validateOwnContentHash(artifact); if (!hashResult.valid) return hashResult;
  const hasNow = Object.prototype.hasOwnProperty.call(options, 'now');
  const result = makeResult(artifact.schema); const normalizedOptions = { ...options, now: hasNow ? options.now : new Date().toISOString() };
  if (!isUtcTimestamp(normalizedOptions.now)) { error(result, 'NOW_INVALID', '$options.now', 'validation time must be RFC3339 UTC'); return result; }
  validateCommonFields(artifact, result);
  if (isUtcTimestamp(artifact.created_at) && compareUtcTimestamps(artifact.created_at, normalizedOptions.now) > 0) error(result, 'ARTIFACT_FUTURE', '$.created_at', 'artifact creation is in the future');
  if (options.expectedSessionId && artifact.session_id !== options.expectedSessionId) error(result, 'SESSION_MISMATCH', '$.session_id', 'artifact session does not match');
  if (Array.isArray(artifact.capabilities) && artifact.capabilities.length > MAX_CAPABILITIES) error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.capabilities', 'capability limit exceeded');
  const capabilities = Array.isArray(artifact.capabilities) && artifact.capabilities.length <= MAX_CAPABILITIES ? artifact.capabilities.map((item, index) => validateCapability(item, artifact, index, result, normalizedOptions)) : [];
  const supersedesTotal = capabilities.reduce((total, capability) => total + (capability && Array.isArray(capability.supersedes) ? capability.supersedes.length : 0), 0);
  if (supersedesTotal > MAX_SUPERSEDES_TOTAL) error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.capabilities', 'combined supersedes limit exceeded');
  validateDuplicateCapabilities(capabilities, result); result.valid = result.errors.length === 0;
  if (result.valid && publish) publishSnapshot(prepared);
  return result;
}
function validateCapabilityMatrix(artifact, options = {}) {
  clearSnapshots(artifact);
  try {
    return validatePreparedArtifact(prepareArtifact(artifact), options, true);
  }
  catch (caught) { clearSnapshots(artifact); return rejectedResult(caught); }
}

function validateCapabilityMatrixSet(artifacts, options = {}) {
  const result = { valid: false, errors: [], warnings: [], index: new Map() };
  try {
    const detachedSet = createDetachedJsonSnapshot(artifacts);
    if (!Array.isArray(detachedSet.snapshot)) { error(result, 'ARTIFACT_SET_INVALID', '$', 'artifact set must be an array'); return result; }
    const sources = detachedSet.snapshot.map((snapshot) => (snapshot && typeof snapshot === 'object' ? detachedSet.origins.get(snapshot) : null));
    for (const source of sources) clearSnapshots(source);
    const preparedArtifacts = detachedSet.snapshot.map((snapshot, index) => makePreparedArtifact(
      sources[index],
      snapshot,
      detachedSet.origins,
    ));
    for (const prepared of preparedArtifacts) { const hashResult = validateOwnContentHash(prepared.snapshot); result.errors.push(...hashResult.errors); }
    if (result.errors.length) return result;
    const snapshotIndex = new Map();
    for (let index = 0; index < preparedArtifacts.length; index += 1) {
      const prepared = preparedArtifacts[index]; const artifactId = prepared.snapshot.artifact_id;
      if (result.index.has(artifactId)) error(result, 'DUPLICATE_ARTIFACT_ID', `$[${index}].artifact_id`, 'artifact identifier is duplicated');
      else { result.index.set(artifactId, prepared.source); snapshotIndex.set(artifactId, prepared.snapshot); }
    }
    if (result.errors.length) return result;
    const { hashOnly: _ignoredHashOnly, artifactIndex: _ignoredArtifactIndex, ...semanticOptions } = options;
    for (const prepared of preparedArtifacts) { const artifactResult = validatePreparedArtifact(prepared, { ...semanticOptions, artifactIndex: snapshotIndex }, false); result.errors.push(...artifactResult.errors); result.warnings.push(...artifactResult.warnings); }
    result.valid = result.errors.length === 0;
    if (result.valid) for (const prepared of preparedArtifacts) publishSnapshot(prepared);
    return result;
  } catch (_) { invalidateAllAuthorization(); return { valid: false, errors: rejectedResult().errors, warnings: [], index: new Map() }; }
}

function validateTaskPacketEnvelopeArtifact(artifact) {
  const result = makeResult('TaskPacket1');
  try {
    artifact = prepareArtifact(artifact).snapshot;
    validateTaskPacketArtifact(artifact, artifact && artifact.packet && artifact.packet.phase_id, '$', result);
    result.valid = result.errors.length === 0;
    return result;
  } catch (_) { return rejectedResult(); }
}

function validateArtifact(artifact, options = {}) {
  let schema;
  try { schema = prepareArtifact(artifact).snapshot.schema; } catch (_) { return rejectedResult(); }
  switch (schema) {
    case 'CapabilityMatrix1': return validateCapabilityMatrix(artifact, options);
    case 'TaskPacket1': return validateTaskPacketEnvelopeArtifact(artifact);
    case 'CollaborationPlan1': return validateCollaborationPlan(artifact, options.artifactIndex || options.artifacts || [], options);
    case 'ResourceLedger1': return stateMachines.validateResourceLedger(artifact, options);
    case 'ExecutionReceipt1': return validateExecutionReceipt(artifact, options);
    default: {
      const result = makeResult(typeof artifact.schema === 'string' ? artifact.schema : null);
      error(result, 'SCHEMA_IDENTITY_INVALID', '$.schema', 'unsupported artifact schema');
      return result;
    }
  }
}

function validateArtifactSet(artifacts, options = {}) {
  const result = { valid: false, errors: [], warnings: [], index: new Map() };
  invalidateAllAuthorization();
  try {
    const detached = createDetachedJsonSnapshot(artifacts);
    if (!Array.isArray(detached.snapshot)) { error(result, 'ARTIFACT_SET_INVALID', '$', 'artifact set must be an array'); return result; }
    if (detached.snapshot.length === 0) { error(result, 'ARTIFACT_SET_EMPTY', '$', 'artifact set must not be empty'); return result; }
    if (detached.snapshot.length > MAX_PLAN_ARTIFACTS) { error(result, 'CONTRACT_LIMIT_EXCEEDED', '$', 'artifact set exceeds its limit'); return result; }
    const sources = detached.snapshot.map((snapshot) => snapshot && typeof snapshot === 'object' ? detached.origins.get(snapshot) : null);
    for (let index = 0; index < detached.snapshot.length; index += 1) {
      const artifact = detached.snapshot[index];
      const hashResult = validateOwnContentHash(artifact);
      result.errors.push(...hashResult.errors);
      const artifactId = artifact && artifact.artifact_id;
      if (!isNonEmptyString(artifactId)) error(result, 'ARTIFACT_SET_MEMBER_INVALID', `$[${index}].artifact_id`, 'artifact identifier is required');
      else if (result.index.has(artifactId)) error(result, 'DUPLICATE_ARTIFACT_ID', `$[${index}].artifact_id`, 'artifact identifier is duplicated');
      else result.index.set(artifactId, sources[index]);
    }
    if (result.errors.length) return result;
    if (detached.snapshot.every((artifact) => artifact.schema === 'CapabilityMatrix1')) return validateCapabilityMatrixSet(sources, options);
    const artifactIndex = new Map(sources.map((artifact) => [artifact.artifact_id, artifact]));
    for (const artifact of sources) {
      const artifactResult = validateArtifact(artifact, { ...options, artifactIndex });
      result.errors.push(...artifactResult.errors);
      result.warnings.push(...artifactResult.warnings);
    }
    result.valid = result.errors.length === 0;
    if (!result.valid) invalidateAllAuthorization();
    return result;
  } catch (_) {
    invalidateAllAuthorization();
    return { valid: false, errors: rejectedResult().errors, warnings: [], index: new Map() };
  }
}

function hasNewerContradiction(capability) { return Array.isArray(capability.contradictions) && capability.contradictions.some((entry) => isUtcTimestamp(entry.observed_at) && isUtcTimestamp(capability.observed_at) && compareUtcTimestamps(entry.observed_at, capability.observed_at) > 0); }
function effectiveCapabilitiesFromValidatedSnapshot(snapshot, now) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.capabilities) || !isUtcTimestamp(now)) return [];
  const groups = new Map();
  for (const capability of snapshot.capabilities) {
    if (!capability || !isPlainObject(capability.scope) || !isNonEmptyString(capability.capability_id) || !isNonEmptyString(capability.subject)) continue;
    let scopeKey; try { scopeKey = canonicalize(capability.scope); } catch (_) { continue; }
    const key = `${capability.subject}\u0000${capability.capability_id}\u0000${scopeKey}`;
    const group = groups.get(key) || []; group.push(capability); groups.set(key, group);
  }
  const effective = [];
  for (const group of groups.values()) {
    const superseded = new Set(group.flatMap((capability) => Array.isArray(capability.supersedes) ? capability.supersedes : []));
    const heads = group.filter((capability) => !superseded.has(capability.evidence_ref));
    for (const head of heads) {
      if (!isUtcTimestamp(head.observed_at) || !isUtcTimestamp(head.expires_at) || compareUtcTimestamps(head.observed_at, now) > 0 || compareUtcTimestamps(head.expires_at, now) <= 0) continue;
      if (hasNewerContradiction(head)) effective.push(Object.freeze({ ...head, support: 'unknown' }));
      else effective.push(head);
    }
  }
  return effective;
}
function getEffectiveCapabilities(artifact, options = {}) {
  try {
    const record = artifact && typeof artifact === 'object' ? artifactSnapshots.get(artifact) : null;
    if (!record || !recordIsCurrent(record) || !Array.isArray(record.snapshot.capabilities)) return [];
    const hasNow = Object.prototype.hasOwnProperty.call(options, 'now');
    const now = hasNow ? options.now : new Date().toISOString();
    return effectiveCapabilitiesFromValidatedSnapshot(record.snapshot, now);
  } catch (_) {
    return [];
  }
}
function isCapabilitySupported(capability, options = {}) {
  try {
    const hasNow = Object.prototype.hasOwnProperty.call(options, 'now');
    const now = hasNow ? options.now : new Date().toISOString();
    const token = currentCapabilityToken(capability);
    if (!token) return false;
    const snapshot = token.binding.snapshot;
    return snapshot.support === 'supported'
      && ['PROBED', 'OBSERVED', 'VERIFIED'].includes(snapshot.evidence_level)
      && isUtcTimestamp(now)
      && isUtcTimestamp(snapshot.observed_at)
      && isUtcTimestamp(snapshot.expires_at)
      && compareUtcTimestamps(snapshot.observed_at, now) <= 0
      && compareUtcTimestamps(snapshot.expires_at, now) > 0
      && !hasNewerContradiction(snapshot);
  } catch (_) {
    return false;
  }
}

function validateTaskPacket(packet) {
  try { packet = createDetachedJsonSnapshot(packet).snapshot; }
  catch (caught) {
    const code = caught && caught.code === 'CONTRACT_LIMIT_EXCEEDED' ? 'CONTRACT_LIMIT_EXCEEDED' : 'CANONICAL_REJECTED';
    return { valid: false, missing: [], invalid: [code] };
  }
  if (!isPlainObject(packet)) return { valid: false, missing: [...TASK_PACKET_KEYS] };
  const missing = TASK_PACKET_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(packet, key));
  const invalid = [];
  if (Object.keys(packet).some((key) => !TASK_PACKET_KEYS.includes(key))) invalid.push('additional_properties');
  if (packet.packet_version !== 1) invalid.push('packet_version');
  for (const key of ['phase_id', 'objective', 'authorization_scope', 'expected_output_schema', 'return_channel']) {
    if (!isNonEmptyString(packet[key])) invalid.push(key);
  }
  for (const key of ['acceptance_criteria', 'owned_paths_resources', 'validation_commands', 'cleanup_duties']) {
    if (!Array.isArray(packet[key]) || packet[key].length === 0 || packet[key].some((item) => !isNonEmptyString(item))) invalid.push(key);
  }
  if (!Array.isArray(packet.dependency_artifact_hashes) || packet.dependency_artifact_hashes.some((item) => typeof item !== 'string' || !SHA256_HEX.test(item))) invalid.push('dependency_artifact_hashes');
  for (const key of ['forbidden_actions', 'allowed_capabilities']) {
    if (!Array.isArray(packet[key]) || packet[key].some((item) => !isNonEmptyString(item))) invalid.push(key);
  }
  const timeout = packet.timeout_progress_contract;
  if (!isPlainObject(timeout)
    || Object.keys(timeout).length !== 2
    || !Object.prototype.hasOwnProperty.call(timeout, 'timeout_seconds')
    || !Object.prototype.hasOwnProperty.call(timeout, 'progress_interval_seconds')
    || !Number.isSafeInteger(timeout.timeout_seconds) || timeout.timeout_seconds < 1
    || !Number.isSafeInteger(timeout.progress_interval_seconds) || timeout.progress_interval_seconds < 1
    || timeout.progress_interval_seconds > timeout.timeout_seconds) invalid.push('timeout_progress_contract');
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid: [...new Set(invalid)] };
}

function capabilitiesByScope(effective) {
  const byScope = new Map();
  for (const capability of effective.filter((item) => (
    ['root', 'child'].includes(item.subject)
    && isPlainObject(item.scope)
    && item.support === 'supported'
    && ['PROBED', 'OBSERVED', 'VERIFIED'].includes(item.evidence_level)
  ))) {
    let scopeKey;
    try { scopeKey = canonicalize(capability.scope); } catch (_) { continue; }
    const subjects = byScope.get(scopeKey) || new Map([['root', new Set()], ['child', new Set()]]);
    subjects.get(capability.subject).add(capability.capability_id);
    byScope.set(scopeKey, subjects);
  }
  return byScope;
}

function supportedCapabilitiesByScope(capabilityMatrix, now) {
  return capabilitiesByScope(getEffectiveCapabilities(capabilityMatrix, { now }));
}

function supportedCapabilitiesByValidatedSnapshot(snapshot, now) {
  return capabilitiesByScope(effectiveCapabilitiesFromValidatedSnapshot(snapshot, now));
}

function hasSubjectCapabilities(subjects, subject, required) {
  const capabilities = subjects.get(subject);
  return capabilities instanceof Set && required.every((capability) => capabilities.has(capability));
}

function selectTopology(capabilityMatrix, taskShape = {}, now) {
  const scopes = supportedCapabilitiesByScope(capabilityMatrix, now);
  if (!taskShape.child_useful) return { topology: 'single', reasons: ['child_not_useful'], downgrade: 'serial_fallback' };
  const assignmentScopes = [...scopes.values()].filter((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['spawn_child', 'collect_result'])
  ));
  if (assignmentScopes.length === 0) return { topology: 'serial_fallback', reasons: ['spawn_collect_not_freshly_supported'], downgrade: 'single' };
  if (!taskShape.requires_interaction) return { topology: 'assignment_only', reasons: ['fresh_spawn_collect'], downgrade: 'serial_fallback' };
  const interactive = assignmentScopes.some((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['root_to_child_message', 'runtime_liveness'])
    && hasSubjectCapabilities(subjects, 'child', ['child_to_root_message'])
  ));
  if (interactive) return { topology: 'interactive_shared', reasons: ['fresh_interactive_intersection'], downgrade: 'assignment_only' };
  return { topology: 'assignment_only', reasons: ['interactive_capability_not_freshly_supported'], downgrade: 'serial_fallback' };
}

function supportsDeclaredTopology(capabilityMatrix, topology, now) {
  if (topology === 'single' || topology === 'serial_fallback') return true;
  const scopes = supportedCapabilitiesByScope(capabilityMatrix, now);
  const assignmentScopes = [...scopes.values()].filter((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['spawn_child', 'collect_result'])
  ));
  if (topology === 'assignment_only') return assignmentScopes.length > 0;
  if (topology !== 'interactive_shared') return false;
  return assignmentScopes.some((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['root_to_child_message', 'runtime_liveness'])
    && hasSubjectCapabilities(subjects, 'child', ['child_to_root_message'])
  ));
}

function supportsDeclaredTopologyFromValidatedSnapshot(snapshot, topology, now) {
  if (topology === 'single' || topology === 'serial_fallback') return true;
  const scopes = supportedCapabilitiesByValidatedSnapshot(snapshot, now);
  const assignmentScopes = [...scopes.values()].filter((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['spawn_child', 'collect_result'])
  ));
  if (topology === 'assignment_only') return assignmentScopes.length > 0;
  if (topology !== 'interactive_shared') return false;
  return assignmentScopes.some((subjects) => (
    hasSubjectCapabilities(subjects, 'root', ['root_to_child_message', 'runtime_liveness'])
    && hasSubjectCapabilities(subjects, 'child', ['child_to_root_message'])
  ));
}

function routeFloor(phaseAxes, policy) {
  const axes = phaseAxes || {};
  const controlled = [
    ['task_type', PLAN_TASK_TYPES], ['scope', PLAN_SCOPES], ['risk', PLAN_RISKS],
    ['reversibility', PLAN_REVERSIBILITY], ['phase_kind', PLAN_PHASE_KINDS],
    ['latency_cost', PLAN_LATENCY_COSTS], ['validation_failure_cost', PLAN_VALIDATION_COSTS],
  ];
  const unresolved = controlled.some(([key, values]) => axes[key] === undefined || axes[key] === 'unknown' || !values.includes(axes[key]));
  if (unresolved) return policy && policy.unknown_floor === 'professional' ? 'professional' : null;
  if (axes.risk === 'extreme' || axes.reversibility === 'irreversible' || ['rollback_proof', 'full_surface_audit'].includes(axes.validation_failure_cost) || axes.critical_security === true) return 'assurance';
  if (axes.scope === 'cross_system' || axes.risk === 'high' || ['planning', 'review', 'verification'].includes(axes.task_type) || ['planning', 'verification'].includes(axes.phase_kind) || axes.validation_failure_cost === 'independent_verification') return 'professional';
  if (['implementation', 'debugging'].includes(axes.task_type) || ['implementation', 'debugging'].includes(axes.phase_kind) || axes.validation_failure_cost === 'focused_tests') return 'engineering';
  if (axes.phase_kind === 'test_gates') return 'standard';
  return 'light';
}

function selectedEffort(lane, floor) {
  if (lane.request_control_support !== 'supported') return 'unspecified';
  const preferred = floor === 'light' ? 'low' : floor === 'standard' ? 'medium' : floor === 'assurance' ? 'max' : 'high';
  if (Array.isArray(lane.supported_efforts) && lane.supported_efforts.includes(preferred)) return preferred;
  return 'unspecified';
}

function hasValidAssuranceGate(phaseAxes, policy) {
  const binding = policy.assurance_binding;
  const authorization = policy.assurance_authorization;
  const lease = policy.assurance_lease;
  const now = isUtcTimestamp(policy.now) ? policy.now : new Date().toISOString();
  const keys = ['actor_id', 'action', 'phase_id', 'plan_hash', 'resource_scope', 'expires_at', 'exit_condition'];
  if (![binding, lease].every(isPlainObject) || !isPlainObject(authorization)) return false;
  if ([binding, lease].some((item) => Object.keys(item).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(item, key)))) return false;
  let sameBinding;
  try { sameBinding = canonicalize(binding) === canonicalize(lease); } catch (_) { return false; }
  const currentPlanRef = phaseAxes && phaseAxes.plan_ref;
  const currentResources = phaseAxes && phaseAxes.resource_scope;
  const authorizationResult = validateAuthorization(authorization, {
    expectedActorId: binding && binding.actor_id,
    expectedScope: `assurance-route:${phaseAxes && phaseAxes.phase_id}`,
    expectedAction: 'select_assurance_route',
    expectedResourceIds: currentResources,
    now,
    planRef: currentPlanRef,
    authorizationEvidenceIndex: policy.authorizationEvidenceIndex,
    allowedSourceEvidenceClasses: policy.allowedSourceEvidenceClasses,
    trustedAuthorizationResolver: policy.trustedAuthorizationResolver,
  });
  return sameBinding && authorizationResult.valid
    && isNonEmptyString(binding.actor_id)
    && binding.action === 'select_assurance_route'
    && binding.phase_id === phaseAxes.phase_id
    && validArtifactRef(currentPlanRef) && binding.plan_hash === currentPlanRef.content_sha256
    && nonEmptyUniqueStrings(binding.resource_scope) && nonEmptyUniqueStrings(currentResources)
    && canonicalize(binding.resource_scope) === canonicalize(currentResources)
    && isUtcTimestamp(binding.expires_at) && compareUtcTimestamps(binding.expires_at, now) > 0
    && isNonEmptyString(binding.exit_condition);
}

function selectRouteFromEffectiveCapabilities(availableLanes, phaseAxes, effectiveCapabilities, policy = {}) {
  const floor = routeFloor(phaseAxes, policy);
  const requestedModel = isNonEmptyString(phaseAxes && phaseAxes.requested_model) ? phaseAxes.requested_model : 'unspecified';
  const requestedEffort = isNonEmptyString(phaseAxes && phaseAxes.requested_effort) ? phaseAxes.requested_effort : 'unspecified';
  if (!floor) return { status: 'NEEDS_EVIDENCE', requested_model: requestedModel, requested_effort: requestedEffort, selected_model: 'unspecified', selected_effort: 'unspecified', capability_class: 'unspecified', reasons: ['route_axes_unknown'], required_validation: 'evidence_collection', fallbacks: [] };
  if (floor === 'assurance' && !hasValidAssuranceGate(phaseAxes, policy)) {
    return { status: 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED', requested_model: requestedModel, requested_effort: requestedEffort, selected_model: 'unspecified', selected_effort: 'unspecified', capability_class: floor, reasons: ['assurance_authorization_or_lease_missing'], required_validation: 'full_surface_audit', fallbacks: [] };
  }
  const minimumRank = CAPABILITY_CLASS_RANK[floor];
  const lanes = Array.isArray(availableLanes) ? availableLanes : [];
  const freshEvidence = new Set((Array.isArray(effectiveCapabilities) ? effectiveCapabilities : []).filter((capability) => (
    capability.support === 'supported'
    && ['PROBED', 'OBSERVED', 'VERIFIED'].includes(capability.evidence_level)
  )).map((capability) => capability.evidence_ref));
  const eligible = lanes
    .filter((lane) => isPlainObject(lane)
      && isNonEmptyString(lane.lane_id)
      && CAPABILITY_CLASS_RANK[lane.capability_class] >= minimumRank
      && isNonEmptyString(lane.availability_evidence_ref)
      && freshEvidence.has(lane.availability_evidence_ref)
      && Array.isArray(lane.supported_task_types)
      && lane.supported_task_types.includes(phaseAxes.task_type)
      && lane.latency_class === phaseAxes.latency_cost)
    .sort((left, right) => CAPABILITY_CLASS_RANK[left.capability_class] - CAPABILITY_CLASS_RANK[right.capability_class] || left.cost_rank - right.cost_rank);
  const candidate = eligible[0];
  if (!candidate) return { status: 'HOLD_ROUTE_UNAVAILABLE', requested_model: requestedModel, requested_effort: requestedEffort, selected_model: 'unspecified', selected_effort: 'unspecified', capability_class: floor, reasons: ['no_fresh_lane_meets_floor'], required_validation: phaseAxes.validation_failure_cost, fallbacks: [] };
  return {
    status: 'SELECTED',
    requested_model: requestedModel,
    requested_effort: requestedEffort,
    selected_model: candidate.lane_id,
    selected_effort: selectedEffort(candidate, floor),
    capability_class: candidate.capability_class,
    reasons: [`floor_${floor}`, `availability_${candidate.availability_evidence_ref}`],
    required_validation: phaseAxes.validation_failure_cost,
    fallbacks: eligible.filter((lane) => lane !== candidate).map((lane) => lane.lane_id),
  };
}

function selectRoute(availableLanes, phaseAxes, capabilityMatrix, policy = {}) {
  return selectRouteFromEffectiveCapabilities(
    availableLanes,
    phaseAxes,
    getEffectiveCapabilities(capabilityMatrix, { now: policy.now }),
    policy,
  );
}

function selectRouteFromValidatedSnapshot(availableLanes, phaseAxes, capabilityMatrixSnapshot, policy = {}) {
  return selectRouteFromEffectiveCapabilities(
    availableLanes,
    phaseAxes,
    effectiveCapabilitiesFromValidatedSnapshot(capabilityMatrixSnapshot, policy.now),
    policy,
  );
}

function validateRouteDecision(decision, availableLanes, phaseAxes, capabilityMatrix, policy = {}) {
  if (!isPlainObject(decision)) return false;
  const expected = selectRoute(availableLanes, phaseAxes, capabilityMatrix, policy);
  try { return canonicalize(decision) === canonicalize(expected); } catch (_) { return false; }
}

function prepareArtifactCollection(artifacts, result) {
  let detachedSet;
  let mapKeys = null;
  if (artifacts instanceof Map) {
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(artifacts);
    if (mapSize > MAX_PLAN_ARTIFACTS) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.artifacts', 'artifact collection limit exceeded');
      return null;
    }
    const entries = Array.from(Map.prototype.entries.call(artifacts));
    mapKeys = entries.map(([key]) => key);
    detachedSet = createDetachedJsonSnapshot(entries.map(([, source]) => source));
  } else if (Array.isArray(artifacts)) {
    if (artifacts.length > MAX_PLAN_ARTIFACTS) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.artifacts', 'artifact collection limit exceeded');
      return null;
    }
    detachedSet = createDetachedJsonSnapshot(artifacts);
  } else {
    error(result, 'ARTIFACT_SET_INVALID', '$.artifacts', 'artifacts must be an array or identity-aligned map');
    return null;
  }

  const preparedArtifacts = detachedSet.snapshot.map((snapshot) => makePreparedArtifact(
    snapshot && typeof snapshot === 'object' ? detachedSet.origins.get(snapshot) : null,
    snapshot,
    detachedSet.origins,
  ));

  for (const prepared of preparedArtifacts) {
    if (!isPlainObject(prepared.snapshot) || !isNonEmptyString(prepared.snapshot.artifact_id)) {
      error(result, 'ARTIFACT_SET_MEMBER_INVALID', '$.artifacts', 'artifact set member is invalid');
      continue;
    }
    const hashResult = validateOwnContentHash(prepared.snapshot);
    if (!hashResult.valid) error(result, 'ARTIFACT_SET_MEMBER_INVALID', '$.artifacts', 'artifact set member hash is invalid');
  }
  if (result.errors.length) return null;

  const seenIds = new Set();
  for (const prepared of preparedArtifacts) {
    const artifactId = prepared.snapshot.artifact_id;
    if (seenIds.has(artifactId)) error(result, 'DUPLICATE_ARTIFACT_ID', '$.artifacts', 'artifact identifiers must be unique');
    seenIds.add(artifactId);
  }
  if (result.errors.length) return null;

  if (mapKeys) {
    for (let index = 0; index < preparedArtifacts.length; index += 1) {
      if (!isNonEmptyString(mapKeys[index]) || preparedArtifacts[index].snapshot.artifact_id !== mapKeys[index]) {
        error(result, 'ARTIFACT_INDEX_INVALID', '$.artifacts', 'artifact map key must match artifact identifier');
      }
    }
  }
  if (result.errors.length) return null;

  const snapshotIndex = new Map();
  const preparedIndex = new Map();
  for (const prepared of preparedArtifacts) {
    snapshotIndex.set(prepared.snapshot.artifact_id, prepared.snapshot);
    preparedIndex.set(prepared.snapshot.artifact_id, prepared);
  }
  return { preparedIndex, snapshotIndex };
}

function validateArtifactReference(reference, plan, artifactIndex, path, result) {
  if (!isPlainObject(reference) || !isNonEmptyString(reference.artifact_id) || typeof reference.content_sha256 !== 'string' || !SHA256_HEX.test(reference.content_sha256)) {
    error(result, 'ARTIFACT_REFERENCE_INVALID', path, 'artifact reference requires identifier and hash');
    return null;
  }
  const referenced = artifactIndex.get(reference.artifact_id);
  if (!referenced) { error(result, 'ARTIFACT_REFERENCE_MISSING', path, 'referenced artifact is unavailable'); return null; }
  if (referenced.content_sha256 !== reference.content_sha256) { error(result, 'ARTIFACT_REFERENCE_HASH_MISMATCH', path, 'referenced artifact hash does not match'); return null; }
  if (referenced.run_id !== plan.run_id || referenced.session_id !== plan.session_id) { error(result, 'ARTIFACT_REFERENCE_SESSION_MISMATCH', path, 'referenced artifact is outside this run/session'); return null; }
  return referenced;
}

function ownDataValue(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}

function validatePlanResourceLimits(plan, result) {
  const phases = ownDataValue(plan, 'phases');
  if (!Array.isArray(phases)) return;
  if (phases.length > MAX_PLAN_PHASES) error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.phases', 'plan phase limit exceeded');
  const inspected = Math.min(phases.length, MAX_PLAN_PHASES);
  for (let index = 0; index < inspected; index += 1) {
    const phase = ownDataValue(phases, String(index));
    const dependencies = ownDataValue(phase, 'dependencies');
    if (Array.isArray(dependencies) && dependencies.length > MAX_PHASE_DEPENDENCIES) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', `$.phases[${index}].dependencies`, 'phase dependency limit exceeded');
    }
    const ownership = ownDataValue(phase, 'ownership');
    const exclusivePaths = ownDataValue(ownership, 'exclusive_paths');
    if (Array.isArray(exclusivePaths) && exclusivePaths.length > MAX_OWNERSHIP_PATHS) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', `$.phases[${index}].ownership.exclusive_paths`, 'phase ownership limit exceeded');
    }
    const route = ownDataValue(phase, 'route');
    const allowedFallbacks = ownDataValue(route, 'allowed_fallbacks');
    if (Array.isArray(allowedFallbacks) && allowedFallbacks.length > MAX_ROUTE_FALLBACKS) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', `$.phases[${index}].route.allowed_fallbacks`, 'route fallback limit exceeded');
    }
  }
}

function analyzePhaseGraph(phases, result) {
  const phaseIds = [...phases.keys()];
  const phaseIndexes = new Map(phaseIds.map((phaseId, index) => [phaseId, index]));
  const indegrees = new Map(phaseIds.map((phaseId) => [phaseId, 0]));
  const dependents = new Map(phaseIds.map((phaseId) => [phaseId, []]));
  let missing = false;
  for (const phase of phases.values()) {
    if (!Array.isArray(phase.dependencies)) continue;
    for (const dependency of phase.dependencies) {
      if (!phases.has(dependency)) {
        error(result, 'PLAN_DEPENDENCY_MISSING', '$.phases', 'phase dependency is unavailable');
        missing = true;
        continue;
      }
      indegrees.set(phase.phase_id, indegrees.get(phase.phase_id) + 1);
      dependents.get(dependency).push(phase.phase_id);
    }
  }
  const queue = phaseIds.filter((phaseId) => indegrees.get(phaseId) === 0);
  const order = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const phaseId = queue[cursor];
    order.push(phaseId);
    for (const dependent of dependents.get(phaseId)) {
      const next = indegrees.get(dependent) - 1;
      indegrees.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length !== phaseIds.length) {
    error(result, 'PLAN_DEPENDENCY_CYCLE', '$.phases', 'phase dependencies must be acyclic');
    return null;
  }
  if (missing) return null;
  const ancestors = new Map();
  for (const phaseId of order) {
    let mask = 0n;
    for (const dependency of phases.get(phaseId).dependencies) {
      mask |= (1n << BigInt(phaseIndexes.get(dependency))) | (ancestors.get(dependency) || 0n);
    }
    ancestors.set(phaseId, mask);
  }
  return { ancestors, phaseIndexes };
}

function graphOrders(graph, fromId, targetId) {
  if (!graph || !graph.phaseIndexes.has(targetId)) return false;
  const targetBit = 1n << BigInt(graph.phaseIndexes.get(targetId));
  return ((graph.ancestors.get(fromId) || 0n) & targetBit) !== 0n;
}

function validatePlanExactKeys(value, required, path, result, missingCode) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) error(result, missingCode, `${path}.${key}`, 'required plan field is missing');
  }
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) error(result, 'PLAN_ADDITIONAL_PROPERTY', `${path}.${key}`, 'unrecognized plan property');
  }
}

function validatePlanEnvelope(plan, result) {
  validatePlanExactKeys(plan, PLAN_ROOT_KEYS, '$', result, 'PLAN_REQUIRED_FIELD_MISSING');
  for (const field of ['created_at', 'producer', 'redaction']) {
    if (!Object.prototype.hasOwnProperty.call(plan, field)) error(result, 'PLAN_COMMON_FIELD_MISSING', `$.${field}`, 'common artifact field is missing');
  }
  for (const field of ['artifact_id', 'run_id', 'session_id']) {
    if (!isNonEmptyString(plan[field])) error(result, 'PLAN_IDENTIFIER_INVALID', `$.${field}`, 'plan identifier must be a non-empty string');
  }
  if (!isUtcTimestamp(plan.created_at)) error(result, 'PLAN_TIMESTAMP_INVALID', '$.created_at', 'plan timestamp must be RFC3339 UTC');
  if (!isPlainObject(plan.producer) || !CAPABILITY_SUBJECTS.includes(plan.producer.role) || !isNonEmptyString(plan.producer.adapter_id)) {
    error(result, 'PLAN_PRODUCER_INVALID', '$.producer', 'plan producer identity is invalid');
  } else {
    validatePlanExactKeys(plan.producer, ['role', 'adapter_id'], '$.producer', result, 'PLAN_PRODUCER_INVALID');
  }
  if (!isPlainObject(plan.redaction) || !REDACTION_POLICIES.includes(plan.redaction.policy)) {
    error(result, 'PLAN_REDACTION_INVALID', '$.redaction', 'plan redaction policy is invalid');
  } else {
    validatePlanExactKeys(plan.redaction, ['policy'], '$.redaction', result, 'PLAN_REDACTION_INVALID');
  }
  for (const field of ['resource_policy', 'failure_policy', 'telemetry_policy']) {
    if (!isPlainObject(plan[field])) error(result, 'PLAN_POLICY_INVALID', `$.${field}`, 'plan policy must be an object');
  }
  const gateKeys = ['authorization', 'pre_dispatch', 'root_review', 'verification', 'cleanup'];
  if (!isPlainObject(plan.gates)) error(result, 'PLAN_GATES_INVALID', '$.gates', 'plan gates must be an object');
  else {
    validatePlanExactKeys(plan.gates, gateKeys, '$.gates', result, 'PLAN_GATES_INVALID');
    for (const key of gateKeys) if (!isPlainObject(plan.gates[key])) error(result, 'PLAN_GATES_INVALID', `$.gates.${key}`, 'plan gate must be an object');
  }
}

function validatePlanRoute(route, path, result) {
  if (!isPlainObject(route)) { error(result, 'PLAN_ROUTE_INVALID', path, 'plan route must be an object'); return; }
  const before = result.errors.length;
  validatePlanExactKeys(route, PLAN_ROUTE_KEYS, path, result, 'PLAN_ROUTE_INVALID');
  if (Array.isArray(route.allowed_fallbacks) && route.allowed_fallbacks.length > MAX_ROUTE_FALLBACKS) {
    error(result, 'CONTRACT_LIMIT_EXCEEDED', `${path}.allowed_fallbacks`, 'route fallback limit exceeded');
  }
  if (!isNonEmptyString(route.requested_model) || !isNonEmptyString(route.selected_model)
    || !PLAN_EFFORTS.includes(route.requested_effort) || !PLAN_EFFORTS.includes(route.selected_effort)
    || !isNonEmptyString(route.selection_evidence)
    || !Array.isArray(route.allowed_fallbacks) || route.allowed_fallbacks.some((item) => !isNonEmptyString(item))) {
    error(result, 'PLAN_ROUTE_INVALID', path, 'plan route values are invalid');
  }
  if (result.errors.length > before && !result.errors.slice(before).some((item) => item.code === 'PLAN_ROUTE_INVALID')) {
    error(result, 'PLAN_ROUTE_INVALID', path, 'plan route contains an unrecognized field');
  }
}

function validatePlanPhaseAxes(phase, path, result) {
  const controlled = [
    ['task_type', PLAN_TASK_TYPES], ['scope', PLAN_SCOPES], ['risk', PLAN_RISKS],
    ['reversibility', PLAN_REVERSIBILITY], ['phase_kind', PLAN_PHASE_KINDS],
    ['latency_cost', PLAN_LATENCY_COSTS], ['validation_failure_cost', PLAN_VALIDATION_COSTS],
  ];
  for (const [field, values] of controlled) {
    if (!values.includes(phase[field])) error(result, 'PLAN_PHASE_AXIS_INVALID', `${path}.${field}`, 'phase axis uses an unsupported value');
  }
}

function validateTaskPacketArtifact(artifact, phaseId, path, result) {
  if (!isPlainObject(artifact)) { error(result, 'TASK_PACKET_ARTIFACT_INVALID', path, 'task packet artifact must be an object'); return; }
  if (artifact.schema !== 'TaskPacket1' || artifact.schema_version !== 1) {
    error(result, 'TASK_PACKET_SCHEMA_INVALID', `${path}.schema`, 'referenced artifact is not TaskPacket1');
    return;
  }
  const required = ['schema', 'schema_version', 'artifact_id', 'run_id', 'session_id', 'created_at', 'producer', 'redaction', 'packet', 'content_sha256'];
  let envelopeValid = true;
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(artifact, key)) envelopeValid = false;
  if (Object.keys(artifact).some((key) => !required.includes(key))) envelopeValid = false;
  if (!isNonEmptyString(artifact.artifact_id) || !isNonEmptyString(artifact.run_id) || !isNonEmptyString(artifact.session_id) || !isUtcTimestamp(artifact.created_at)) envelopeValid = false;
  if (!isPlainObject(artifact.producer) || !CAPABILITY_SUBJECTS.includes(artifact.producer.role) || !isNonEmptyString(artifact.producer.adapter_id)
    || Object.keys(artifact.producer).some((key) => !['role', 'adapter_id'].includes(key))) envelopeValid = false;
  if (!isPlainObject(artifact.redaction) || !REDACTION_POLICIES.includes(artifact.redaction.policy)
    || Object.keys(artifact.redaction).some((key) => key !== 'policy')) envelopeValid = false;
  const hashResult = validateOwnContentHash(artifact);
  if (!hashResult.valid) envelopeValid = false;
  if (!envelopeValid) error(result, 'TASK_PACKET_ARTIFACT_INVALID', path, 'task packet envelope or content hash is invalid');
  const packetResult = validateTaskPacket(artifact.packet);
  if (!packetResult.valid) error(result, 'TASK_PACKET_INCOMPLETE', `${path}.packet`, `task packet is missing: ${packetResult.missing.join(', ')}`);
  if (packetResult.valid && artifact.packet.phase_id !== phaseId) error(result, 'TASK_PACKET_PHASE_MISMATCH', `${path}.packet.phase_id`, 'task packet phase does not match plan phase');
}

function validateAuthorizedPlan(plan, capabilityMatrix, options, result) {
  if (plan.status !== 'AUTHORIZED') return;
  const gate = plan.gates && plan.gates.authorization;
  const gateKeys = ['authorization_ref', 'actor_id', 'scope', 'allowed_source_evidence_classes'];
  const expectedScope = `collaboration-plan:${plan.artifact_id}`;
  if (!isPlainObject(gate) || !exactOwnKeys(gate, gateKeys) || !isNonEmptyString(gate.authorization_ref)
    || !isNonEmptyString(gate.actor_id) || gate.scope !== expectedScope || !uniqueStrings(gate.allowed_source_evidence_classes)) {
    error(result, 'PLAN_AUTHORIZATION_REQUIRED', '$.gates.authorization', 'AUTHORIZED plan requires one exact scope-bound authorization reference');
    return;
  }
  const authorization = indexedRecord(options.authorizationIndex, gate.authorization_ref);
  const authorizationResult = validateAuthorization(authorization, {
    expectedActorId: gate.actor_id,
    expectedScope,
    expectedAction: 'execute_plan',
    expectedResourceIds: plan.phases.map((phase) => `phase:${phase.phase_id}`),
    now: options.now,
    planRef: { artifact_id: plan.artifact_id, content_sha256: plan.content_sha256 },
    authorizationEvidenceIndex: options.authorizationEvidenceIndex,
    allowedSourceEvidenceClasses: gate.allowed_source_evidence_classes,
    trustedAuthorizationResolver: options.trustedAuthorizationResolver,
  });
  if (!authorizationResult.valid) {
    error(result, 'PLAN_AUTHORIZATION_REQUIRED', '$.gates.authorization.authorization_ref', 'plan authorization is missing, stale, or not bound to this plan');
    return;
  }
  if (!Array.isArray(options.availableLanes)) {
    error(result, 'PLAN_ROUTE_EVIDENCE_REQUIRED', '$options.availableLanes', 'AUTHORIZED plan requires an independently supplied lane catalog');
    return;
  }
  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index];
    const policyIndex = options.routePolicyByPhase;
    const policy = indexedRecord(policyIndex, phase.phase_id) || { now: options.now };
    const axes = {
      phase_id: phase.phase_id,
      task_type: phase.task_type,
      scope: phase.scope,
      risk: phase.risk,
      reversibility: phase.reversibility,
      phase_kind: phase.phase_kind,
      latency_cost: phase.latency_cost,
      validation_failure_cost: phase.validation_failure_cost,
      requested_model: phase.route.requested_model,
      requested_effort: phase.route.requested_effort,
      plan_ref: { artifact_id: plan.artifact_id, content_sha256: plan.content_sha256 },
      resource_scope: phase.ownership.exclusive_paths,
    };
    const expected = selectRouteFromValidatedSnapshot(options.availableLanes, axes, capabilityMatrix, {
      ...policy,
      now: options.now,
      authorizationEvidenceIndex: options.authorizationEvidenceIndex,
      allowedSourceEvidenceClasses: gate.allowed_source_evidence_classes,
      trustedAuthorizationResolver: options.trustedAuthorizationResolver,
    });
    const lane = options.availableLanes.find((candidate) => candidate && candidate.lane_id === phase.route.selected_model);
    const exactFallbacks = Array.isArray(expected.fallbacks) && canonicalize(expected.fallbacks) === canonicalize(phase.route.allowed_fallbacks);
    if (expected.status !== 'SELECTED' || !lane || phase.route.requested_model !== expected.requested_model
      || phase.route.requested_effort !== expected.requested_effort || phase.route.selected_model !== expected.selected_model
      || phase.route.selected_effort !== expected.selected_effort || phase.route.selection_evidence !== lane.availability_evidence_ref
      || !exactFallbacks || expected.required_validation !== phase.validation_failure_cost) {
      error(result, 'PLAN_ROUTE_EVIDENCE_REQUIRED', `$.phases[${index}].route`, 'AUTHORIZED plan route does not match the independently recomputed route');
    }
  }
}

function validateCollaborationPlanTransaction(plan, artifacts, options = {}) {
  const result = makeResult('CollaborationPlan1');
  const collection = prepareArtifactCollection(artifacts, result);
  if (!collection) return result;
  validatePlanResourceLimits(plan, result);
  if (result.errors.length) return result;
  plan = prepareArtifact(plan).snapshot;
  if (!isPlainObject(plan)) { error(result, 'PLAN_SHAPE_INVALID', '$', 'collaboration plan must be an object'); return result; }
  if (plan.schema !== 'CollaborationPlan1' || plan.schema_version !== 1) { error(result, 'PLAN_SCHEMA_INVALID', '$.schema', 'unsupported collaboration plan schema'); return result; }
  validatePlanEnvelope(plan, result);
  const hashResult = validateOwnContentHash(plan);
  result.errors.push(...hashResult.errors);
  if (!['DRAFT', 'VALIDATED', 'AUTHORIZED', 'SUPERSEDED', 'CANCELLED'].includes(plan.status)) error(result, 'PLAN_STATUS_INVALID', '$.status', 'plan status is invalid');
  if (!['single', 'assignment_only', 'interactive_shared', 'serial_fallback'].includes(plan.topology)) error(result, 'PLAN_TOPOLOGY_INVALID', '$.topology', 'plan topology is invalid');
  const { preparedIndex, snapshotIndex: artifactIndex } = collection;
  const capabilityMatrix = validateArtifactReference(plan.capability_matrix_ref, plan, artifactIndex, '$.capability_matrix_ref', result);
  let preparedCapabilityMatrix = null;
  if (capabilityMatrix) {
    preparedCapabilityMatrix = preparedIndex.get(capabilityMatrix.artifact_id) || null;
    const validationNow = isUtcTimestamp(options.now) ? options.now : plan.created_at;
    const matrixResult = validatePreparedArtifact(preparedCapabilityMatrix, {
      now: validationNow,
      expectedSessionId: plan.session_id,
      artifactIndex,
      trustedRuntimeResolver: options.trustedRuntimeResolver,
    }, false);
    if (!matrixResult.valid) error(result, 'CAPABILITY_MATRIX_INVALID', '$.capability_matrix_ref', 'referenced capability matrix is invalid or stale');
    else if (!supportsDeclaredTopologyFromValidatedSnapshot(capabilityMatrix, plan.topology, validationNow)) {
      error(result, 'PLAN_TOPOLOGY_CAPABILITY_MISMATCH', '$.topology', 'declared topology exceeds current capability evidence');
    }
  }
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) { error(result, 'PLAN_PHASES_INVALID', '$.phases', 'plan requires at least one phase'); return result; }
  if (plan.phases.length > MAX_PLAN_PHASES) { error(result, 'CONTRACT_LIMIT_EXCEEDED', '$.phases', 'plan phase limit exceeded'); return result; }
  const phases = new Map();
  let graphShapeValid = true;
  let ownershipShapeValid = true;
  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index]; const path = `$.phases[${index}]`;
    if (!isPlainObject(phase)) { error(result, 'PLAN_PHASE_INVALID', path, 'plan phase is incomplete'); graphShapeValid = false; continue; }
    validatePlanExactKeys(phase, PLAN_PHASE_KEYS, path, result, 'PLAN_PHASE_INVALID');
    if (PLAN_PHASE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(phase, key)) || !isNonEmptyString(phase.phase_id)) { error(result, 'PLAN_PHASE_INVALID', path, 'plan phase is incomplete'); graphShapeValid = false; continue; }
    validatePlanPhaseAxes(phase, path, result);
    if (phases.has(phase.phase_id)) {
      error(result, 'PLAN_PHASE_DUPLICATE', `${path}.phase_id`, 'phase identifier is duplicated');
      graphShapeValid = false;
    } else phases.set(phase.phase_id, phase);
    const taskPacketArtifact = validateArtifactReference(phase.task_packet_ref, plan, artifactIndex, `${path}.task_packet_ref`, result);
    if (taskPacketArtifact) validateTaskPacketArtifact(taskPacketArtifact, phase.phase_id, `${path}.task_packet_ref`, result);
    if (Array.isArray(phase.dependencies) && phase.dependencies.length > MAX_PHASE_DEPENDENCIES) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', `${path}.dependencies`, 'phase dependency limit exceeded');
      graphShapeValid = false;
    }
    if (!Array.isArray(phase.dependencies)
      || phase.dependencies.some((dependency) => !isNonEmptyString(dependency))
      || new Set(phase.dependencies).size !== phase.dependencies.length) {
      error(result, 'PLAN_DEPENDENCIES_INVALID', `${path}.dependencies`, 'phase dependencies must contain unique identifiers');
      graphShapeValid = false;
    }
    if (isPlainObject(phase.ownership) && Array.isArray(phase.ownership.exclusive_paths)
      && phase.ownership.exclusive_paths.length > MAX_OWNERSHIP_PATHS) {
      error(result, 'CONTRACT_LIMIT_EXCEEDED', `${path}.ownership.exclusive_paths`, 'phase ownership limit exceeded');
      ownershipShapeValid = false;
    }
    if (!isPlainObject(phase.ownership)
      || Object.keys(phase.ownership).length !== 1
      || !Array.isArray(phase.ownership.exclusive_paths)
      || phase.ownership.exclusive_paths.length === 0
      || phase.ownership.exclusive_paths.some((item) => !isNonEmptyString(item))
      || new Set(phase.ownership.exclusive_paths).size !== phase.ownership.exclusive_paths.length) {
      error(result, 'PLAN_OWNERSHIP_INVALID', `${path}.ownership`, 'phase ownership requires unique non-empty exclusive paths');
      ownershipShapeValid = false;
    }
    validatePlanRoute(phase.route, `${path}.route`, result);
  }
  const graph = graphShapeValid ? analyzePhaseGraph(phases, result) : null;
  if (graph && ownershipShapeValid) {
    const phasesByPath = new Map();
    for (const phase of phases.values()) {
      if (!isPlainObject(phase.ownership) || !Array.isArray(phase.ownership.exclusive_paths)) continue;
      for (const ownedPath of phase.ownership.exclusive_paths) {
        const owners = phasesByPath.get(ownedPath) || [];
        owners.push(phase.phase_id);
        phasesByPath.set(ownedPath, owners);
      }
    }
    const reportedPairs = new Set();
    for (const owners of phasesByPath.values()) for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
      const leftId = owners[leftIndex]; const rightId = owners[rightIndex];
      const pairKey = [leftId, rightId].sort().join('\u0000');
      if (!reportedPairs.has(pairKey) && !graphOrders(graph, leftId, rightId) && !graphOrders(graph, rightId, leftId)) {
        reportedPairs.add(pairKey);
        error(result, 'SHARED_WRITE_CONFLICT', '$.phases', 'parallel phases cannot share exclusive paths');
      }
    }
  }
  validateAuthorizedPlan(plan, capabilityMatrix, options, result);
  result.valid = result.errors.length === 0;
  if (result.valid) publishSnapshot(preparedCapabilityMatrix);
  return result;
}

function validateCollaborationPlan(plan, artifacts, options = {}) {
  try { return validateCollaborationPlanTransaction(plan, artifacts, options); }
  catch (_) { return rejectedResult(); }
}

function controlledDecision(action, reasons, extra = {}) {
  return { action, reasons: Array.from(new Set(reasons)), ...extra };
}

function sameJson(left, right) {
  try { return canonicalize(left) === canonicalize(right); } catch (_) { return false; }
}

function decideProcessRecovery(input) {
  try {
    const value = createDetachedJsonSnapshot(input).snapshot;
    if (!isPlainObject(value)) return controlledDecision('HOLD', ['PROCESS_RECOVERY_INPUT_INVALID']);
    if (value.duplicate_run_lock === true) return controlledDecision('HOLD', ['DUPLICATE_RUN_LOCK']);
    if (value.owner_status !== 'owned') return controlledDecision('HOLD', ['OWNER_NOT_EXACT']);
    const confidence = stateMachines.compareProcessIdentity(
      value.expected_identity,
      value.observed_identity,
      value.expected_generation,
      value.observed_generation,
    );
    if (confidence === 'MISMATCH') return controlledDecision('HOLD', ['IDENTITY_MISMATCH'], { identity_confidence: confidence });
    if (confidence !== 'MATCH') return controlledDecision('OBSERVE_ONLY', ['IDENTITY_PARTIAL'], { identity_confidence: confidence });
    if (!sameJson(value.expected_scope, value.observed_scope)) return controlledDecision('HOLD', ['SCOPE_IDENTITY_MISMATCH'], { identity_confidence: confidence });
    const absence = value.absence;
    if (isPlainObject(absence) && absence.process_absent === true && absence.thread_absent === true && absence.port_absent === true) {
      return controlledDecision('OBSERVE_ONLY', ['ABSENCE_VERIFIED'], { identity_confidence: confidence, downstream_release_allowed: true });
    }
    const graceful = value.graceful;
    if (!isPlainObject(graceful) || graceful.requested !== true) return controlledDecision('REQUEST_GRACEFUL', ['GRACEFUL_NOT_REQUESTED'], { identity_confidence: confidence });
    if (graceful.exit_observed === true) return controlledDecision('WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED'], { identity_confidence: confidence });
    if (graceful.deadline_reached !== true) return controlledDecision('WAIT_BOUNDED', ['GRACEFUL_WINDOW_OPEN'], { identity_confidence: confidence });
    if (value.exact_tree_termination_supported !== true) return controlledDecision('HOLD', ['EXACT_TREE_TERMINATION_UNSUPPORTED'], { identity_confidence: confidence });
    return controlledDecision('TERMINATE_EXACT_TREE', ['EXACT_OWNED_TREE'], {
      identity_confidence: confidence,
      orphan_recovery: value.orphaned === true,
      requires_identity_recheck: true,
      requires_absence_verification: true,
    });
  } catch (_) {
    return controlledDecision('HOLD', ['PROCESS_RECOVERY_INPUT_INVALID']);
  }
}

function isValidProcessScope2(scope) {
  return isPlainObject(scope)
    && Object.keys(scope).length === 2
    && Object.prototype.propertyIsEnumerable.call(scope, 'kind')
    && Object.prototype.propertyIsEnumerable.call(scope, 'value')
    && scope.kind === 'scope'
    && typeof scope.value === 'string'
    && scope.value.trim() !== '';
}

function decideProcessRecovery2(input) {
  const decision = (action, reasons, extra = {}) => controlledDecision(action, reasons, {
    ...extra,
    action_authorized: false,
  });
  try {
    const value = createDetachedJsonSnapshot(input).snapshot;
    if (!isPlainObject(value)) return decision('HOLD', ['PROCESS_RECOVERY_INPUT_INVALID']);
    if (value.duplicate_run_lock === true) return decision('HOLD', ['DUPLICATE_RUN_LOCK']);
    if (value.owner_status !== 'owned') return decision('HOLD', ['OWNER_NOT_EXACT']);
    const expected = identitySupportV2.validateProcessIdentity2(value.expected_identity);
    const observed = identitySupportV2.validateProcessIdentity2(value.observed_identity);
    if (!expected.valid || !observed.valid) return decision('HOLD', ['IDENTITY_INCOMPLETE'], { identity_confidence: 'PARTIAL' });
    if (!Number.isSafeInteger(value.expected_generation) || value.expected_generation < 1
      || !Number.isSafeInteger(value.observed_generation) || value.observed_generation < 1
      || value.expected_generation !== value.observed_generation
      || value.expected_generation !== value.expected_identity.lease_generation
      || value.observed_generation !== value.observed_identity.lease_generation
      || !sameJson(value.expected_identity, value.observed_identity)) {
      return decision('HOLD', ['IDENTITY_MISMATCH'], { identity_confidence: 'MISMATCH' });
    }
    const confidence = 'MATCH';
    if (!isValidProcessScope2(value.expected_scope) || !isValidProcessScope2(value.observed_scope)) {
      return decision('HOLD', ['SCOPE_IDENTITY_INVALID'], { identity_confidence: confidence });
    }
    if (!sameJson(value.expected_scope, value.observed_scope)) {
      return decision('HOLD', ['SCOPE_IDENTITY_MISMATCH'], { identity_confidence: confidence });
    }
    const absence = value.absence;
    if (isPlainObject(absence) && absence.process_absent === true && absence.thread_absent === true && absence.port_absent === true) {
      return decision('OBSERVE_ONLY', ['ABSENCE_VERIFIED'], { identity_confidence: confidence, downstream_release_allowed: true });
    }
    const graceful = value.graceful;
    if (!isPlainObject(graceful) || graceful.requested !== true) return decision('REQUEST_GRACEFUL', ['GRACEFUL_NOT_REQUESTED'], { identity_confidence: confidence });
    if (graceful.exit_observed === true) return decision('WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED'], { identity_confidence: confidence });
    if (graceful.deadline_reached !== true) return decision('WAIT_BOUNDED', ['GRACEFUL_WINDOW_OPEN'], { identity_confidence: confidence });
    if (value.exact_tree_termination_supported !== true) return decision('HOLD', ['EXACT_TREE_TERMINATION_UNSUPPORTED'], { identity_confidence: confidence });
    return decision('TERMINATE_EXACT_TREE', ['EXACT_OWNED_TREE'], {
      identity_confidence: confidence,
      orphan_recovery: value.orphaned === true,
      requires_identity_recheck: true,
      requires_absence_verification: true,
    });
  } catch (_) {
    return decision('HOLD', ['PROCESS_RECOVERY_INPUT_INVALID']);
  }
}

function hashWithoutField(value, field) {
  const detached = {};
  for (const key of Object.keys(value)) if (key !== field) detached[key] = value[key];
  return computeDetachedSha256(createDetachedJsonSnapshot(detached).snapshot);
}

function computeTemporaryManifestSha256(manifest) {
  const value = createDetachedJsonSnapshot(manifest).snapshot;
  if (!isPlainObject(value)) throw new ContractError('TEMP_MANIFEST_INVALID', '$', 'temporary manifest must be an object');
  return hashWithoutField(value, 'manifest_sha256');
}

function exactOwnKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validPolicyReceipt(record, expectedId, expectedKind) {
  if (!exactOwnKeys(record, POLICY_RECEIPT_KEYS)) return false;
  if (record.policy_id !== expectedId || record.kind !== expectedKind || !['host_policy', 'workload_policy', 'synthetic_test_fixture'].includes(record.source_kind)) return false;
  if (!isUtcTimestamp(record.observed_at) || !isPlainObject(record.values) || !Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0 || record.evidence_refs.some((item) => !isNonEmptyString(item))) return false;
  return SHA256_HEX.test(record.source_sha256 || '') && hashWithoutField(record, 'source_sha256') === record.source_sha256;
}

function resolvePolicy(policyIndex, reference, kind) {
  if (!isPlainObject(policyIndex) || !isNonEmptyString(reference)) return null;
  const record = policyIndex[reference];
  return validPolicyReceipt(record, reference, kind) ? record : null;
}

function validateTemporaryManifest(manifest) {
  if (!exactOwnKeys(manifest, TEMP_MANIFEST_KEYS)) return false;
  if (!isNonEmptyString(manifest.owner_id) || !isNonEmptyString(manifest.run_id) || !isNonEmptyString(manifest.session_id)
    || !Number.isSafeInteger(manifest.lease_generation) || manifest.lease_generation < 1 || !isUtcTimestamp(manifest.created_at)
    || !isNonEmptyString(manifest.quota_profile_ref) || !isNonEmptyString(manifest.watermark_policy_ref)
    || !['DECLARED', 'ACTIVE', 'QUIESCING', 'RECLAIMING', 'RETAINED'].includes(manifest.state)
    || !SHA256_HEX.test(manifest.manifest_sha256 || '') || computeTemporaryManifestSha256(manifest) !== manifest.manifest_sha256) return false;
  const root = manifest.canonical_root_identity;
  if (!exactOwnKeys(root, TEMP_ROOT_KEYS) || !isNonEmptyString(root.canonical_path) || !SHA256_HEX.test(root.path_identity_hash || '')
    || !SHA256_HEX.test(root.parent_identity_hash || '') || !isNonEmptyString(root.platform)) return false;
  const flavor = root.platform === 'win32' ? path.win32 : ['linux', 'darwin'].includes(root.platform) ? path.posix : null;
  if (!flavor || !flavor.isAbsolute(root.canonical_path)) return false;
  if (!isPlainObject(manifest.child_sublease_map) || !Array.isArray(manifest.retention_set) || manifest.retention_set.some((item) => !isNonEmptyString(item))) return false;
  for (const [childId, sublease] of Object.entries(manifest.child_sublease_map)) {
    if (!isNonEmptyString(childId) || !exactOwnKeys(sublease, TEMP_SUBLEASE_KEYS) || sublease.owner_id !== childId
      || !isNonEmptyString(sublease.canonical_descendant) || !isNonEmptyString(sublease.nonce)
      || !Number.isSafeInteger(sublease.lease_generation) || sublease.lease_generation !== manifest.lease_generation
      || !Number.isFinite(sublease.soft_quota) || !Number.isFinite(sublease.hard_quota) || sublease.soft_quota < 0
      || sublease.hard_quota <= sublease.soft_quota || !isNonEmptyString(sublease.teardown_condition)) return false;
  }
  return true;
}

function pathFlavor(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') ? path.win32 : path.posix;
}

function isCanonicalDescendant(root, candidate) {
  if (!isNonEmptyString(root) || !isNonEmptyString(candidate)) return false;
  const flavor = pathFlavor(root);
  const normalizedRoot = flavor.resolve(root);
  const normalizedCandidate = flavor.resolve(candidate);
  const relative = flavor.relative(normalizedRoot, normalizedCandidate);
  if (!relative || relative === '..' || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)) return false;
  if (flavor === path.win32) return normalizedCandidate.toLowerCase() === flavor.resolve(normalizedRoot, relative).toLowerCase();
  return normalizedCandidate === flavor.resolve(normalizedRoot, relative);
}

function decideTemporaryLease(input) {
  try {
    const trustedFilesystemResolver = input && input.trustedFilesystemResolver;
    const jsonInput = isPlainObject(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'trustedFilesystemResolver'))
      : input;
    const value = createDetachedJsonSnapshot(jsonInput).snapshot;
    if (!isPlainObject(value) || !validateTemporaryManifest(value.manifest)) return controlledDecision('HOLD', ['TEMP_MANIFEST_INVALID']);
    const { manifest, observation } = value;
    const quota = resolvePolicy(value.policyIndex, manifest.quota_profile_ref, 'quota');
    const watermark = resolvePolicy(value.policyIndex, manifest.watermark_policy_ref, 'watermark');
    if (!quota || !watermark) return controlledDecision('OBSERVE_ONLY', ['POLICY_NOT_OBSERVABLE'], { observability: 'UNVERIFIED' });
    const sublease = manifest.child_sublease_map[value.child_id];
    if (!sublease) return controlledDecision('HOLD', ['CHILD_SUBLEASE_UNRESOLVED']);
    if (!exactOwnKeys(observation, TEMP_OBSERVATION_KEYS) || observation.owner_id !== manifest.owner_id || observation.run_id !== manifest.run_id
      || observation.session_id !== manifest.session_id || observation.lease_generation !== manifest.lease_generation
      || !sameJson(observation.canonical_root_identity, manifest.canonical_root_identity)) return controlledDecision('HOLD', ['LEASE_IDENTITY_MISMATCH']);
    if (!isCanonicalDescendant(manifest.canonical_root_identity.canonical_path, observation.child_path)
      || !isCanonicalDescendant(manifest.canonical_root_identity.canonical_path, sublease.canonical_descendant)
      || !sameJson(observation.child_path, sublease.canonical_descendant)) return controlledDecision('HOLD', ['CANONICAL_ROOT_ESCAPE']);
    if (observation.identity_observed !== true) return controlledDecision('HOLD', ['PATH_SAFETY_NOT_PROVEN']);
    if (observation.reparse_boundary === true) return controlledDecision('HOLD', ['REPARSE_BOUNDARY']);
    if (observation.reparse_boundary !== false) return controlledDecision('HOLD', ['PATH_SAFETY_NOT_PROVEN']);
    if (observation.path_rebound === true) return controlledDecision('HOLD', ['PATH_IDENTITY_REBOUND']);
    if (observation.path_rebound !== false) return controlledDecision('HOLD', ['PATH_SAFETY_NOT_PROVEN']);
    const quotaValues = quota.values;
    const watermarkValues = watermark.values;
    if (!Number.isFinite(quotaValues.soft_quota) || !Number.isFinite(quotaValues.hard_quota) || quotaValues.soft_quota !== sublease.soft_quota
      || quotaValues.hard_quota !== sublease.hard_quota || !Number.isFinite(watermarkValues.low_watermark)
      || !Number.isFinite(watermarkValues.critical_watermark) || watermarkValues.critical_watermark >= watermarkValues.low_watermark) {
      return controlledDecision('HOLD', ['POLICY_CONTRACT_INVALID']);
    }
    if (value.intent === 'write') {
      if (!Number.isFinite(observation.usage) || !Number.isFinite(observation.available)) return controlledDecision('OBSERVE_ONLY', ['USAGE_NOT_OBSERVABLE'], { observability: 'UNVERIFIED' });
      if (observation.usage >= quotaValues.hard_quota) return controlledDecision('STOP_DISPATCH', ['HARD_QUOTA_EXCEEDED']);
      if (observation.available <= watermarkValues.critical_watermark) return controlledDecision('STOP_DISPATCH', ['CRITICAL_WATERMARK']);
      if (observation.usage >= quotaValues.soft_quota) return controlledDecision('STOP_EXPANSION', ['SOFT_QUOTA_REACHED']);
      if (observation.available <= watermarkValues.low_watermark) return controlledDecision('STOP_EXPANSION', ['LOW_WATERMARK']);
      return controlledDecision('ALLOW_WRITE', ['WITHIN_POLICY'], { observability: 'VERIFIED' });
    }
    if (value.intent !== 'reclaim') return controlledDecision('OBSERVE_ONLY', ['INTENT_OBSERVATION_ONLY']);
    if (observation.ttl_expired === true && (observation.active_handles !== 0 || observation.quiescent !== true)) return controlledDecision('OBSERVE_ONLY', ['TTL_WITH_ACTIVE_HANDLE']);
    const retentionSetHash = computeDetachedSha256(createDetachedJsonSnapshot(manifest.retention_set).snapshot);
    if (observation.quiescent !== true || observation.active_handles !== 0 || observation.retention_set_sealed !== true
      || observation.retention_set_hash !== retentionSetHash || observation.teardown_condition_met !== true
      || observation.precheck_identity_hash !== manifest.canonical_root_identity.path_identity_hash
      || observation.postcheck_identity_hash !== manifest.canonical_root_identity.path_identity_hash) return controlledDecision('HOLD', ['RECLAIM_PRECONDITION_MISSING']);
    if (!trustedResolverAccepts(trustedFilesystemResolver, 'temporary_reclaim', observation, {
      manifest_sha256: manifest.manifest_sha256,
      canonical_root_identity: manifest.canonical_root_identity,
      child_id: value.child_id,
      child_path: observation.child_path,
    })) return controlledDecision('HOLD', ['RECLAIM_TRUST_NOT_PROVEN']);
    return controlledDecision('RECLAIM_EXACT', ['RECLAIM_PRECONDITIONS_VERIFIED'], {
      requires_same_parent_quarantine: true,
      requires_post_removal_absence_check: true,
    });
  } catch (_) {
    return controlledDecision('HOLD', ['TEMP_INPUT_INVALID']);
  }
}

function progressError(code, pathValue) { return new ContractError(code, pathValue, 'progress report rejected'); }

function validateProgressReport(report, options = {}) {
  const result = { valid: false, classification: 'UNVERIFIED', errors: [], warnings: [] };
  try {
    const value = createDetachedJsonSnapshot(report).snapshot;
    const policyIndex = createDetachedJsonSnapshot(options.policyIndex || {}).snapshot;
    const required = ['counts', 'return_code_distribution', 'liveness', 'newest_artifact', 'resource_usage', 'temp', 'coordination', 'last_meaningful_progress', 'next_gate', 'progress_policy_ref', 'windows'];
    if (!isPlainObject(value) || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
      result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$'));
      return result;
    }
    const counts = value.counts;
    if (!isPlainObject(counts) || ['successful', 'failed', 'completed', 'pending'].some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$.counts'));
    if (!isPlainObject(value.return_code_distribution) || Object.values(value.return_code_distribution).some((count) => !Number.isSafeInteger(count) || count < 0)) result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$.return_code_distribution'));
    if (!isPlainObject(value.liveness) || !['MATCH', 'PARTIAL', 'MISMATCH', 'not_observable'].includes(value.liveness.identity_confidence)) result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$.liveness'));
    const usage = value.resource_usage;
    if (!isPlainObject(usage) || ['cpu', 'gpu', 'memory', 'io'].some((key) => !(usage[key] === 'not_observable' || (Number.isFinite(usage[key]) && usage[key] >= 0)))) result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$.resource_usage'));
    const newestArtifactValid = value.newest_artifact === 'not_observable'
      || (isPlainObject(value.newest_artifact) && SHA256_HEX.test(value.newest_artifact.path_hash || '') && isUtcTimestamp(value.newest_artifact.last_write_at));
    if (!newestArtifactValid || !isPlainObject(value.temp) || !Number.isFinite(value.temp.usage)
      || !isNonEmptyString(value.temp.quota_profile_ref) || !Number.isFinite(value.temp.disk_watermark)
      || !isNonEmptyString(value.temp.watermark_policy_ref) || !isPlainObject(value.coordination)
      || !Array.isArray(value.coordination.blockers) || !Object.prototype.hasOwnProperty.call(value.coordination, 'external_wait')
      || !isNonEmptyString(value.coordination.retry_state) || !isNonEmptyString(value.coordination.circuit_state)
      || !isPlainObject(value.last_meaningful_progress) || !isUtcTimestamp(value.last_meaningful_progress.observed_at)
      || !Array.isArray(value.last_meaningful_progress.evidence_refs) || !isNonEmptyString(value.next_gate)
      || !Array.isArray(value.windows) || value.windows.length === 0 || value.windows.length > 256) result.errors.push(progressError('PROGRESS_REPORT_INCOMPLETE', '$'));
    if (result.errors.length) return result;
    const progressPolicy = resolvePolicy(policyIndex, value.progress_policy_ref, 'progress');
    if (!progressPolicy || !Number.isSafeInteger(progressPolicy.values.no_progress_windows) || progressPolicy.values.no_progress_windows < 2) {
      result.valid = true;
      result.warnings.push(progressError('PROGRESS_POLICY_NOT_OBSERVABLE', '$.progress_policy_ref'));
      return result;
    }
    const latest = value.windows[value.windows.length - 1];
    const meaningful = isPlainObject(latest) && ((Number.isFinite(latest.cpu_delta) && latest.cpu_delta > 0)
      || (Number.isFinite(latest.io_delta) && latest.io_delta > 0) || latest.artifact_write === true || latest.heartbeat === true);
    if (meaningful) result.classification = 'QUIET_PROGRESS';
    else if (isPlainObject(latest) && isPlainObject(latest.external_wait) && isNonEmptyString(latest.external_wait.job_identity)
      && isUtcTimestamp(latest.external_wait.next_check_at) && Array.isArray(latest.external_wait.evidence_refs) && latest.external_wait.evidence_refs.length > 0) result.classification = 'EXTERNAL_WAIT';
    else {
      const requiredWindows = progressPolicy.values.no_progress_windows;
      const recent = value.windows.slice(-requiredWindows);
      const noProgress = recent.length === requiredWindows && recent.every((window) => isPlainObject(window)
        && !(Number.isFinite(window.cpu_delta) && window.cpu_delta > 0) && !(Number.isFinite(window.io_delta) && window.io_delta > 0)
        && window.artifact_write !== true && window.heartbeat !== true && window.external_wait === null);
      result.classification = noProgress ? 'SUSPECTED_HUNG' : 'UNVERIFIED';
    }
    result.valid = true;
    return result;
  } catch (_) {
    result.errors.push(progressError('PROGRESS_REPORT_INVALID', '$'));
    return result;
  }
}

function decideRetry(state, options = {}) {
  try {
    const value = createDetachedJsonSnapshot(state).snapshot;
    const policyIndex = createDetachedJsonSnapshot(options.policyIndex || {}).snapshot;
    const policy = isPlainObject(value) ? resolvePolicy(policyIndex, value.retry_policy_ref, 'retry') : null;
    if (!policy) return controlledDecision('HOLD', ['RETRY_POLICY_NOT_OBSERVABLE']);
    if (value.side_effect_state !== 'none') return controlledDecision('HOLD', ['SIDE_EFFECT_STATE_NOT_CLEAN']);
    if (!isNonEmptyString(value.idempotency_key)) return controlledDecision('HOLD', ['IDEMPOTENCY_KEY_REQUIRED']);
    if (!isNonEmptyString(value.failure_fingerprint)) return controlledDecision('HOLD', ['FAILURE_FINGERPRINT_REQUIRED']);
    const maxAttempts = policy.values.max_attempts;
    const schedule = policy.values.backoff_schedule_ms;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Array.isArray(schedule) || schedule.length < maxAttempts
      || schedule.some((delay) => !Number.isSafeInteger(delay) || delay < 0) || !Number.isSafeInteger(policy.values.jitter_max_ms) || policy.values.jitter_max_ms < 0) {
      return controlledDecision('HOLD', ['RETRY_POLICY_INVALID']);
    }
    if (value.repeated_failure === true || !Number.isSafeInteger(value.attempts) || value.attempts >= maxAttempts) return controlledDecision('OPEN_CIRCUIT', ['RETRY_BUDGET_EXHAUSTED'], { stop_new_dispatch: true });
    if (value.transient !== true) return controlledDecision('HOLD', ['FAILURE_NOT_TRANSIENT']);
    return controlledDecision('RETRY', ['TRANSIENT_IDEMPOTENT'], { backoff_ms: schedule[value.attempts], jitter_max_ms: policy.values.jitter_max_ms, idempotency_key: value.idempotency_key });
  } catch (_) {
    return controlledDecision('HOLD', ['RETRY_INPUT_INVALID']);
  }
}

const RECEIPT_KEYS = Object.freeze(['schema', 'schema_version', 'artifact_id', 'run_id', 'session_id', 'created_at', 'producer', 'redaction', 'plan_ref', 'ledger_ref', 'run_outcome', 'phase_receipts', 'cleanup_summary', 'authorization_summary', 'contradictions', 'residual_risks', 'content_sha256']);
const PHASE_RECEIPT_KEYS = Object.freeze(['phase_id', 'child_id', 'dispatch_event', 'running_evidence', 'result_submission', 'root_acceptance', 'review', 'verification', 'requested_model', 'selected_model', 'actual_model', 'requested_effort', 'selected_effort', 'actual_effort', 'route_attestation', 'actual_route_evidence', 'artifact_refs']);
const VALIDATION_RECORD_KEYS = Object.freeze(['artifact_id', 'schema', 'content_sha256', 'run_id', 'session_id', 'status', 'plan_generation', 'required_phase_ids', 'exact_lane_required_phase_ids', 'validated_at', 'validated_by_authority_ref', 'evidence_refs', 'source_sha256']);
const LEDGER_VALIDATION_KEYS = Object.freeze(['artifact_id', 'schema', 'content_sha256', 'run_id', 'session_id', 'status', 'plan_ref', 'terminal_run_state', 'resource_states', 'retained_artifact_ids', 'validated_at', 'validated_by_authority_ref', 'evidence_refs', 'source_sha256']);
const RECEIPT_EVIDENCE_KEYS = Object.freeze(['evidence_id', 'run_id', 'session_id', 'phase_id', 'kind', 'status', 'actor_role', 'actor_id', 'actor_authority_ref', 'observed_at', 'result_sha256', 'linked_evidence_ref', 'evidence_refs', 'source_sha256']);
const RECEIPT_AUTHORITY_KEYS = Object.freeze(['authority_id', 'run_id', 'subject_id', 'plan_generation', 'actor_role', 'actor_id', 'valid_from', 'valid_until', 'evidence_refs', 'source_sha256']);
const ACTUAL_ROUTE_EVIDENCE_KEYS = Object.freeze(['evidence_id', 'run_id', 'session_id', 'phase_id', 'actual_model', 'actual_effort', 'source_kind', 'observed_at', 'evidence_refs', 'source_sha256']);
const LEDGER_RESOURCE_STATE_KEYS = Object.freeze(['resource_id', 'type', 'state']);
const AUTHORIZATION_KEYS = Object.freeze(['authorization_id', 'actor_id', 'actor_kind', 'scope', 'action', 'resource_ids', 'issued_at', 'expires_at', 'plan_ref', 'source_evidence_ref', 'source_sha256']);
const AUTHORIZATION_EVIDENCE_KEYS = Object.freeze(['evidence_id', 'evidence_class', 'actor_id', 'observed_at', 'evidence_refs', 'source_sha256']);

function validationResult(schemaName) { return { valid: false, schema: schemaName, errors: [], warnings: [] }; }
function pushValidationError(result, code, pathValue, message) { result.errors.push(new ContractError(code, pathValue, message || 'contract rejected')); }
function validArtifactIdentity(value) { return isPlainObject(value) && isNonEmptyString(value.artifact_id) && SHA256_HEX.test(value.content_sha256 || ''); }
function validArtifactRef(value) { return exactOwnKeys(value, ['artifact_id', 'content_sha256']) && validArtifactIdentity(value); }
function sameArtifactRef(left, right) { return validArtifactIdentity(left) && validArtifactIdentity(right) && left.artifact_id === right.artifact_id && left.content_sha256 === right.content_sha256; }
function uniqueStrings(value) { return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length; }
function nonEmptyUniqueStrings(value) { return uniqueStrings(value) && value.length > 0; }
function indexedRecord(index, key) { return isPlainObject(index) && isNonEmptyString(key) ? index[key] : null; }
function recordOwnHashValid(record) { return isPlainObject(record) && SHA256_HEX.test(record.source_sha256 || '') && hashWithoutField(record, 'source_sha256') === record.source_sha256; }
function ledgerResourceStatesValid(resourceStates) {
  if (!Array.isArray(resourceStates) || resourceStates.length > 256) return false;
  const ids = new Set();
  for (const resource of resourceStates) {
    if (!exactOwnKeys(resource, LEDGER_RESOURCE_STATE_KEYS) || !isNonEmptyString(resource.resource_id)
      || !stateMachines.RESOURCE_TYPES.includes(resource.type) || !stateMachines.RESOURCE_STATES.includes(resource.state)
      || ids.has(resource.resource_id)) return false;
    ids.add(resource.resource_id);
  }
  return true;
}

function receiptAuthorityValid(authorityIndex, reference, expected, trustedAuthorityResolver) {
  const record = indexedRecord(authorityIndex, reference);
  const structurallyValid = exactOwnKeys(record, RECEIPT_AUTHORITY_KEYS) && record.authority_id === reference && recordOwnHashValid(record)
    && record.run_id === expected.runId && record.subject_id === expected.subjectId && record.plan_generation === expected.planGeneration
    && record.actor_role === expected.actorRole && isNonEmptyString(record.actor_id) && (!expected.actorId || record.actor_id === expected.actorId)
    && isUtcTimestamp(record.valid_from) && isUtcTimestamp(record.valid_until)
    && compareUtcTimestamps(record.valid_from, expected.observedAt) <= 0 && compareUtcTimestamps(expected.observedAt, record.valid_until) <= 0
    && uniqueStrings(record.evidence_refs);
  return structurallyValid && trustedResolverAccepts(trustedAuthorityResolver, 'receipt_authority', record, {
    run_id: expected.runId,
    subject_id: expected.subjectId,
    plan_generation: expected.planGeneration,
    actor_role: expected.actorRole,
    actor_id: expected.actorId || record.actor_id,
    observed_at: expected.observedAt,
  });
}

function resolvePlanValidation(receipt, options, result) {
  const record = indexedRecord(options.planIndex, receipt.plan_ref && receipt.plan_ref.artifact_id);
  if (!exactOwnKeys(record, VALIDATION_RECORD_KEYS) || !recordOwnHashValid(record) || record.schema !== 'CollaborationPlan1'
    || record.status !== 'VALID' || !sameArtifactRef(receipt.plan_ref, record) || record.run_id !== receipt.run_id || record.session_id !== receipt.session_id
    || !Number.isSafeInteger(record.plan_generation) || record.plan_generation < 1 || !uniqueStrings(record.required_phase_ids)
    || !uniqueStrings(record.exact_lane_required_phase_ids) || !record.exact_lane_required_phase_ids.every((id) => record.required_phase_ids.includes(id))
    || !isUtcTimestamp(record.validated_at) || !uniqueStrings(record.evidence_refs)
    || !receiptAuthorityValid(options.authorityIndex, record.validated_by_authority_ref, { runId: receipt.run_id, subjectId: receipt.run_id, planGeneration: record.plan_generation, actorRole: 'root', observedAt: record.validated_at }, options.trustedAuthorityResolver)) {
    pushValidationError(result, 'PLAN_REFERENCE_INVALID', '$.plan_ref'); return null;
  }
  return record;
}

function resolveLedgerValidation(receipt, plan, options, result) {
  const record = indexedRecord(options.ledgerIndex, receipt.ledger_ref && receipt.ledger_ref.artifact_id);
  if (!exactOwnKeys(record, LEDGER_VALIDATION_KEYS) || !recordOwnHashValid(record) || record.schema !== 'ResourceLedger1'
    || record.status !== 'VALID' || !sameArtifactRef(receipt.ledger_ref, record) || record.run_id !== receipt.run_id || record.session_id !== receipt.session_id
    || !sameArtifactRef(record.plan_ref, receipt.plan_ref) || !['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED', 'HOLD'].includes(record.terminal_run_state)
    || !ledgerResourceStatesValid(record.resource_states) || !uniqueStrings(record.retained_artifact_ids) || !isUtcTimestamp(record.validated_at) || !uniqueStrings(record.evidence_refs)
    || !receiptAuthorityValid(options.authorityIndex, record.validated_by_authority_ref, { runId: receipt.run_id, subjectId: receipt.run_id, planGeneration: plan.plan_generation, actorRole: 'verifier', observedAt: record.validated_at }, options.trustedAuthorityResolver)) {
    pushValidationError(result, 'LEDGER_REFERENCE_INVALID', '$.ledger_ref'); return null;
  }
  return record;
}

function resolvePhaseEvidence(reference, expectedKind, phase, receipt, plan, options, result, code) {
  const record = indexedRecord(options.evidenceIndex, reference);
  if (!exactOwnKeys(record, RECEIPT_EVIDENCE_KEYS) || !recordOwnHashValid(record) || record.evidence_id !== reference
    || record.run_id !== receipt.run_id || record.session_id !== receipt.session_id || record.phase_id !== phase.phase_id
    || record.kind !== expectedKind || record.status !== 'PASS' || !isNonEmptyString(record.actor_role) || !isNonEmptyString(record.actor_id)
    || !isUtcTimestamp(record.observed_at) || !SHA256_HEX.test(record.result_sha256 || '') || !uniqueStrings(record.evidence_refs)) {
    pushValidationError(result, code, `$.phase_receipts.${phase.phase_id}.${expectedKind}`); return null;
  }
  if (['root', 'verifier'].includes(record.actor_role) && !receiptAuthorityValid(options.authorityIndex, record.actor_authority_ref, {
    runId: receipt.run_id, subjectId: receipt.run_id, planGeneration: plan.plan_generation,
    actorRole: record.actor_role, actorId: record.actor_id, observedAt: record.observed_at,
  }, options.trustedAuthorityResolver)) { pushValidationError(result, code, `$.phase_receipts.${phase.phase_id}.${expectedKind}`); return null; }
  return record;
}

function validatePhaseReceipt(phase, receipt, plan, options, result) {
  if (!exactOwnKeys(phase, PHASE_RECEIPT_KEYS) || !isNonEmptyString(phase.phase_id) || !uniqueStrings(phase.artifact_refs) || phase.artifact_refs.length === 0
    || !ROUTE_ATTESTATIONS.includes(phase.route_attestation)
    || ['requested_model', 'selected_model', 'actual_model', 'requested_effort', 'selected_effort', 'actual_effort'].some((key) => !isNonEmptyString(phase[key]))
    || !(phase.child_id === null || isNonEmptyString(phase.child_id))) { pushValidationError(result, 'PHASE_RECEIPT_INVALID', '$.phase_receipts'); return; }
  const dispatch = resolvePhaseEvidence(phase.dispatch_event, 'dispatch', phase, receipt, plan, options, result, 'DISPATCH_EVIDENCE_REQUIRED');
  const running = resolvePhaseEvidence(phase.running_evidence, 'running', phase, receipt, plan, options, result, 'RUNNING_EVIDENCE_REQUIRED');
  const submission = resolvePhaseEvidence(phase.result_submission, 'result_submission', phase, receipt, plan, options, result, 'RESULT_SUBMISSION_REQUIRED');
  const acceptance = resolvePhaseEvidence(phase.root_acceptance, 'root_acceptance', phase, receipt, plan, options, result, 'ROOT_ACCEPTANCE_REQUIRED');
  const review = resolvePhaseEvidence(phase.review, 'review', phase, receipt, plan, options, result, 'ROOT_REVIEW_REQUIRED');
  const verification = resolvePhaseEvidence(phase.verification, 'verification', phase, receipt, plan, options, result, 'VERIFICATION_REQUIRED');
  if (!dispatch || !running || !submission || !acceptance || !review || !verification) return;
  const ordered = [dispatch, running, submission, acceptance, review, verification];
  if (running.linked_evidence_ref !== dispatch.evidence_id || submission.linked_evidence_ref !== running.evidence_id
    || ordered.some((entry, index) => index > 0 && compareUtcTimestamps(ordered[index - 1].observed_at, entry.observed_at) > 0)) pushValidationError(result, 'RESULT_CHAIN_MISMATCH', '$.phase_receipts');
  if (acceptance.actor_role !== 'root' || acceptance.linked_evidence_ref !== submission.evidence_id) pushValidationError(result, 'ROOT_ACCEPTANCE_REQUIRED', '$.phase_receipts.root_acceptance');
  if (review.actor_role !== 'root' || review.linked_evidence_ref !== acceptance.evidence_id) pushValidationError(result, 'ROOT_REVIEW_REQUIRED', '$.phase_receipts.review');
  if (verification.actor_role !== 'verifier' || verification.linked_evidence_ref !== review.evidence_id) pushValidationError(result, 'VERIFICATION_REQUIRED', '$.phase_receipts.verification');
  if (verification.actor_id === acceptance.actor_id || verification.actor_id === review.actor_id) pushValidationError(result, 'VERIFIER_NOT_INDEPENDENT', '$.phase_receipts.verification');
  if (![dispatch, running, submission, acceptance, review, verification].every((entry) => entry.result_sha256 === submission.result_sha256)) pushValidationError(result, 'RESULT_CHAIN_MISMATCH', '$.phase_receipts');
  if (phase.route_attestation === 'UNVERIFIED' && (phase.actual_model !== 'unknown' || phase.actual_effort !== 'unknown' || phase.actual_route_evidence !== null)) pushValidationError(result, 'ACTUAL_ROUTE_UNVERIFIED', '$.phase_receipts.route_attestation');
  if (phase.route_attestation === 'NOT_REQUIRED' && (phase.actual_model !== 'unknown' || phase.actual_effort !== 'unknown' || phase.actual_route_evidence !== null)) pushValidationError(result, 'ACTUAL_ROUTE_NOT_REQUIRED', '$.phase_receipts.route_attestation');
  if (phase.route_attestation === 'VERIFIED') {
    const route = indexedRecord(options.actualRouteIndex, phase.actual_route_evidence);
    if (!isNonEmptyString(phase.actual_route_evidence) || phase.actual_model === 'unknown' || phase.actual_effort === 'unknown'
      || !exactOwnKeys(route, ACTUAL_ROUTE_EVIDENCE_KEYS) || !recordOwnHashValid(route) || route.evidence_id !== phase.actual_route_evidence
      || route.run_id !== receipt.run_id || route.session_id !== receipt.session_id || route.phase_id !== phase.phase_id
      || route.actual_model !== phase.actual_model || route.actual_effort !== phase.actual_effort || route.source_kind !== 'host_runtime_metadata'
      || !isUtcTimestamp(route.observed_at) || !uniqueStrings(route.evidence_refs)
      || !trustedResolverAccepts(options.trustedRuntimeResolver, 'actual_route', route, {
        run_id: receipt.run_id,
        session_id: receipt.session_id,
        phase_id: phase.phase_id,
        actual_model: phase.actual_model,
        actual_effort: phase.actual_effort,
      })) pushValidationError(result, 'ACTUAL_ROUTE_EVIDENCE_REQUIRED', '$.phase_receipts.actual_route_evidence');
  }
  if (plan.exact_lane_required_phase_ids.includes(phase.phase_id) && phase.route_attestation !== 'VERIFIED') pushValidationError(result, 'EXACT_ROUTE_ATTESTATION_REQUIRED', '$.phase_receipts.route_attestation');
}

function validateExecutionReceipt(receipt, options = {}) {
  const result = validationResult('ExecutionReceipt1');
  try {
    const trustedAuthorityResolver = options && options.trustedAuthorityResolver;
    const trustedRuntimeResolver = options && options.trustedRuntimeResolver;
    const jsonOptions = isPlainObject(options)
      ? Object.fromEntries(Object.entries(options).filter(([key]) => !['trustedAuthorityResolver', 'trustedRuntimeResolver'].includes(key)))
      : options;
    receipt = createDetachedJsonSnapshot(receipt).snapshot;
    options = { ...createDetachedJsonSnapshot(jsonOptions).snapshot, trustedAuthorityResolver, trustedRuntimeResolver };
    if (!exactOwnKeys(receipt, RECEIPT_KEYS) || receipt.schema !== 'ExecutionReceipt1' || receipt.schema_version !== 1
      || !isNonEmptyString(receipt.artifact_id) || !isNonEmptyString(receipt.run_id) || !isNonEmptyString(receipt.session_id)
      || !isUtcTimestamp(receipt.created_at) || !RUN_OUTCOMES.includes(receipt.run_outcome)) { pushValidationError(result, 'EXECUTION_RECEIPT_INVALID', '$'); return result; }
    const ownHashResult = validateOwnContentHash(receipt); result.errors.push(...ownHashResult.errors);
    if (!exactOwnKeys(receipt.producer, ['role', 'adapter_id']) || receipt.producer.role !== 'root' || !isNonEmptyString(receipt.producer.adapter_id)) pushValidationError(result, 'RECEIPT_PRODUCER_INVALID', '$.producer');
    if (!exactOwnKeys(receipt.redaction, ['policy']) || !REDACTION_POLICIES.includes(receipt.redaction.policy)) pushValidationError(result, 'RECEIPT_REDACTION_INVALID', '$.redaction');
    if (!exactOwnKeys(receipt.plan_ref, ['artifact_id', 'content_sha256'])) pushValidationError(result, 'PLAN_REFERENCE_INVALID', '$.plan_ref');
    if (!exactOwnKeys(receipt.ledger_ref, ['artifact_id', 'content_sha256'])) pushValidationError(result, 'LEDGER_REFERENCE_INVALID', '$.ledger_ref');
    if (isNonEmptyString(options.expectedSessionId) && receipt.session_id !== options.expectedSessionId) pushValidationError(result, 'RECEIPT_SESSION_MISMATCH', '$.session_id');
    const plan = resolvePlanValidation(receipt, options, result);
    const ledger = plan ? resolveLedgerValidation(receipt, plan, options, result) : null;
    if (!plan || !ledger) return result;
    if (!Array.isArray(receipt.phase_receipts) || receipt.phase_receipts.length === 0 || receipt.phase_receipts.length > 256) pushValidationError(result, 'REQUIRED_PHASE_MISSING', '$.phase_receipts');
    const phaseIds = Array.isArray(receipt.phase_receipts) ? receipt.phase_receipts.map((phase) => phase && phase.phase_id) : [];
    const phaseSetValid = new Set(phaseIds).size === phaseIds.length && phaseIds.every((id) => plan.required_phase_ids.includes(id));
    if (!phaseSetValid || (receipt.run_outcome === 'COMPLETE' && (phaseIds.length !== plan.required_phase_ids.length || !plan.required_phase_ids.every((id) => phaseIds.includes(id))))) pushValidationError(result, 'REQUIRED_PHASE_MISSING', '$.phase_receipts');
    if (Array.isArray(receipt.phase_receipts)) for (const phase of receipt.phase_receipts) validatePhaseReceipt(phase, receipt, plan, options, result);
    if (!Array.isArray(receipt.contradictions) || receipt.contradictions.length > 256 || receipt.contradictions.some((item) => !isPlainObject(item))) pushValidationError(result, 'CONTRADICTION_INVALID', '$.contradictions');
    else if (receipt.run_outcome === 'COMPLETE' && receipt.contradictions.some((item) => item.status !== 'RESOLVED')) pushValidationError(result, 'UNRESOLVED_CONTRADICTION', '$.contradictions');
    if (!Array.isArray(receipt.residual_risks) || receipt.residual_risks.length > 256 || receipt.residual_risks.some((item) => !isPlainObject(item))) pushValidationError(result, 'RESIDUAL_RISKS_INVALID', '$.residual_risks');
    const retainedResources = ledger.resource_states.filter((resource) => isPlainObject(resource) && resource.state === 'RETAINED');
    const retainedIds = retainedResources.map((resource) => resource.resource_id);
    const retentionValid = retainedResources.every((resource) => resource.type === 'artifact' && isNonEmptyString(resource.resource_id))
      && retainedIds.length === ledger.retained_artifact_ids.length
      && retainedIds.every((id) => ledger.retained_artifact_ids.includes(id));
    if (!retentionValid) pushValidationError(result, 'RETAINED_ARTIFACT_INVALID', '$.ledger_ref');
    const expectedTerminal = { COMPLETE: 'COMPLETE', CANCELLED: 'CANCELLED', FAILED: 'FAILED_RECLAIMED', PARTIAL: 'HOLD', HOLD: 'HOLD', UNVERIFIED: 'HOLD' }[receipt.run_outcome];
    if (ledger.terminal_run_state !== expectedTerminal) pushValidationError(result, 'OUTCOME_LEDGER_MISMATCH', '$.run_outcome');
    const terminalSafe = ledger.resource_states.every((resource) => isPlainObject(resource) && (resource.state === 'RECLAIMED'
      || (resource.type === 'artifact' && resource.state === 'RETAINED' && ledger.retained_artifact_ids.includes(resource.resource_id))));
    const terminalObserved = (state) => ledger.resource_states.some((resource) => isPlainObject(resource) && resource.state === state);
    const nonCompleteCleanupSafe = receipt.cleanup_summary && (
      (receipt.cleanup_summary.status === 'all_reclaimed' && terminalSafe)
      || (receipt.cleanup_summary.status === 'quarantined' && terminalObserved('QUARANTINED') && ledger.resource_states.every((resource) => ['RECLAIMED', 'RETAINED', 'QUARANTINED'].includes(resource.state)))
      || (receipt.cleanup_summary.status === 'unknown' && !terminalSafe)
    );
    const completionOutcome = ['COMPLETE', 'CANCELLED', 'FAILED'].includes(receipt.run_outcome);
    const cleanupValid = exactOwnKeys(receipt.cleanup_summary, ['status', 'ledger_hash']) && CLEANUP_STATUSES.includes(receipt.cleanup_summary.status)
      && receipt.cleanup_summary.ledger_hash === receipt.ledger_ref.content_sha256
      && (completionOutcome ? receipt.cleanup_summary.status === 'all_reclaimed' && terminalSafe : nonCompleteCleanupSafe);
    if (!cleanupValid) pushValidationError(result, 'CLEANUP_NOT_COMPLETE', '$.cleanup_summary');
    if (!exactOwnKeys(receipt.authorization_summary, ['authorization_refs']) || !uniqueStrings(receipt.authorization_summary.authorization_refs)) pushValidationError(result, 'AUTHORIZATION_SUMMARY_INVALID', '$.authorization_summary');
    if (receipt.run_outcome === 'COMPLETE' && result.errors.length) pushValidationError(result, 'COMPLETE_GATE_REJECTED', '$.run_outcome');
    result.valid = result.errors.length === 0;
    return result;
  } catch (_) {
    pushValidationError(result, 'EXECUTION_RECEIPT_INVALID', '$'); return result;
  }
}

function validateAuthorization(authorization, context = {}) {
  const result = validationResult('Authorization1');
  try {
    const trustedAuthorizationResolver = context && context.trustedAuthorizationResolver;
    const jsonContext = isPlainObject(context)
      ? Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'trustedAuthorizationResolver'))
      : context;
    authorization = createDetachedJsonSnapshot(authorization).snapshot;
    context = createDetachedJsonSnapshot(jsonContext).snapshot;
    if (!exactOwnKeys(authorization, AUTHORIZATION_KEYS) || !recordOwnHashValid(authorization) || !isNonEmptyString(authorization.authorization_id)
      || !isNonEmptyString(authorization.actor_id) || !isNonEmptyString(authorization.scope) || !AUTHORIZATION_ACTIONS.includes(authorization.action)
      || !nonEmptyUniqueStrings(authorization.resource_ids) || !isUtcTimestamp(authorization.issued_at) || !isUtcTimestamp(authorization.expires_at)
      || !validArtifactRef(authorization.plan_ref) || !isNonEmptyString(authorization.source_evidence_ref)) { pushValidationError(result, 'AUTHORIZATION_INVALID', '$'); return result; }
    if (!['human', 'system'].includes(authorization.actor_kind)) pushValidationError(result, 'AUTHORIZING_ACTOR_FORBIDDEN', '$.actor_kind');
    if (authorization.actor_id !== context.expectedActorId) pushValidationError(result, 'AUTHORIZATION_ACTOR_MISMATCH', '$.actor_id');
    if (authorization.scope !== context.expectedScope) pushValidationError(result, 'AUTHORIZATION_SCOPE_MISMATCH', '$.scope');
    if (authorization.action !== context.expectedAction) pushValidationError(result, 'AUTHORIZATION_ACTION_MISMATCH', '$.action');
    if (!nonEmptyUniqueStrings(context.expectedResourceIds) || authorization.resource_ids.length !== context.expectedResourceIds.length || !authorization.resource_ids.every((id) => context.expectedResourceIds.includes(id))) pushValidationError(result, 'AUTHORIZATION_RESOURCE_MISMATCH', '$.resource_ids');
    if (!sameArtifactRef(authorization.plan_ref, context.planRef)) pushValidationError(result, 'AUTHORIZATION_PLAN_MISMATCH', '$.plan_ref');
    if (!isUtcTimestamp(context.now) || compareUtcTimestamps(context.now, authorization.issued_at) < 0 || compareUtcTimestamps(context.now, authorization.expires_at) > 0) pushValidationError(result, 'AUTHORIZATION_EXPIRED', '$.expires_at');
    const evidence = indexedRecord(context.authorizationEvidenceIndex, authorization.source_evidence_ref);
    if (!exactOwnKeys(evidence, AUTHORIZATION_EVIDENCE_KEYS) || !recordOwnHashValid(evidence) || evidence.evidence_id !== authorization.source_evidence_ref
      || evidence.actor_id !== authorization.actor_id || !Array.isArray(context.allowedSourceEvidenceClasses) || !context.allowedSourceEvidenceClasses.includes(evidence.evidence_class)
      || !isUtcTimestamp(evidence.observed_at) || compareUtcTimestamps(evidence.observed_at, authorization.issued_at) > 0 || !uniqueStrings(evidence.evidence_refs)) pushValidationError(result, 'AUTHORIZATION_SOURCE_INVALID', '$.source_evidence_ref');
    if (!trustedResolverAccepts(trustedAuthorizationResolver, 'authorization', authorization, {
      expected_actor_id: context.expectedActorId,
      expected_scope: context.expectedScope,
      expected_action: context.expectedAction,
      expected_resource_ids: context.expectedResourceIds,
      plan_ref: context.planRef,
      source_evidence: evidence,
    })) pushValidationError(result, 'AUTHORIZATION_TRUST_NOT_PROVEN', '$.source_evidence_ref');
    result.valid = result.errors.length === 0; return result;
  } catch (_) {
    pushValidationError(result, 'AUTHORIZATION_INVALID', '$'); return result;
  }
}

function isActionAuthorized(action, authorization, context = {}) {
  if (!AUTHORIZATION_ACTIONS.includes(action)) return false;
  return validateAuthorization(authorization, { ...context, expectedAction: action }).valid;
}

module.exports = { CAPABILITY_IDS, CAPABILITY_SUBJECTS, SUPPORT, EVIDENCE_LEVELS, SOURCE_KINDS, REDACTION_POLICIES, UTC_TIMESTAMP_PATTERN, PROCESS_RECOVERY_ACTIONS, TEMPORARY_LEASE_ACTIONS, PROGRESS_CLASSIFICATIONS, RUN_OUTCOMES, ROUTE_ATTESTATIONS, CLEANUP_STATUSES, AUTHORIZATION_ACTIONS, ContractError, getEffectiveCapabilities, isCapabilitySupported, validateArtifact, validateArtifactSet, validateTaskPacket, selectTopology, selectRoute, validateRouteDecision, validateCollaborationPlan, decideProcessRecovery, decideProcessRecovery2, computeTemporaryManifestSha256, decideTemporaryLease, validateProgressReport, decideRetry, validateExecutionReceipt, validateAuthorization, isActionAuthorized, ...stateMachines, ...identitySupportV2 };
