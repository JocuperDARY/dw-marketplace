'use strict';

const {
  canonicalize,
  computeDetachedContentSha256,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');

const RUN_EDGES = Object.freeze({
  PLANNING: ['PLAN_VALIDATED', 'CANCELLING', 'FAILED', 'HOLD'],
  PLAN_VALIDATED: ['AUTHORIZED', 'CANCELLING', 'FAILED', 'HOLD'],
  AUTHORIZED: ['LEDGER_OPEN', 'CANCELLING', 'FAILED', 'HOLD'],
  LEDGER_OPEN: ['DISPATCHING', 'RUNNING', 'CANCELLING', 'FAILED', 'HOLD'],
  DISPATCHING: ['RUNNING', 'CANCELLING', 'FAILED', 'HOLD'],
  RUNNING: ['COLLECTING', 'ROOT_REVIEW', 'CANCELLING', 'FAILED', 'HOLD'],
  COLLECTING: ['ROOT_REVIEW', 'CANCELLING', 'FAILED', 'HOLD'],
  ROOT_REVIEW: ['VERIFYING', 'CANCELLING', 'FAILED', 'HOLD'],
  VERIFYING: ['RECLAIMING', 'CANCELLING', 'FAILED', 'HOLD'],
  CANCELLING: ['RECLAIMING', 'HOLD'],
  FAILED: ['RECLAIMING', 'HOLD'],
  RECLAIMING: ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED', 'HOLD'],
  COMPLETE: [], CANCELLED: [], FAILED_RECLAIMED: [], HOLD: [],
});
const CHILD_EDGES = Object.freeze({
  DECLARED: ['DISPATCH_REQUESTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  DISPATCH_REQUESTED: ['DISPATCH_ACKED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  DISPATCH_ACKED: ['START_OBSERVED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  START_OBSERVED: ['WORKING', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  WORKING: ['QUIET_PROGRESS', 'EXTERNAL_WAIT', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  QUIET_PROGRESS: ['WORKING', 'EXTERNAL_WAIT', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  EXTERNAL_WAIT: ['WORKING', 'QUIET_PROGRESS', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  SUSPECTED_HUNG: ['WORKING', 'INTERRUPT_REQUESTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_SUBMITTED: ['RESULT_ACCEPTED', 'RESULT_REJECTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_REJECTED: ['WORKING', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_ACCEPTED: ['REVIEWED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  REVIEWED: ['VERIFIED', 'FAILED', 'UNKNOWN'],
  VERIFIED: ['CLOSED', 'UNKNOWN'],
  INTERRUPT_REQUESTED: ['EXIT_OBSERVED', 'FAILED', 'UNKNOWN'],
  CANCEL_REQUESTED: ['INTERRUPT_REQUESTED', 'EXIT_OBSERVED', 'FAILED', 'UNKNOWN'],
  FAILED: ['EXIT_OBSERVED', 'CLOSED', 'UNKNOWN'],
  EXIT_OBSERVED: ['CLOSED', 'UNKNOWN'],
  CLOSED: [], UNKNOWN: [],
});
const RESOURCE_EDGES = Object.freeze({
  DECLARED: ['LEASED', 'UNKNOWN', 'QUARANTINED'],
  LEASED: ['START_REQUESTED', 'ACTIVE', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  START_REQUESTED: ['ACTIVE', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  ACTIVE: ['QUIESCING', 'TERMINATE_REQUESTED', 'EXIT_OBSERVED', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  QUIESCING: ['ACTIVE', 'TERMINATE_REQUESTED', 'EXIT_OBSERVED', 'UNKNOWN', 'QUARANTINED'],
  TERMINATE_REQUESTED: ['EXIT_OBSERVED', 'UNKNOWN', 'QUARANTINED'],
  EXIT_OBSERVED: ['RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  RECLAIMING: ['RECLAIMED', 'RETAINED', 'UNKNOWN', 'QUARANTINED'],
  RECLAIMED: [], RETAINED: [], UNKNOWN: [], QUARANTINED: [],
});
const RUN_STATES = Object.freeze(Object.keys(RUN_EDGES));
const CHILD_STATES = Object.freeze(Object.keys(CHILD_EDGES));
const RESOURCE_STATES = Object.freeze(Object.keys(RESOURCE_EDGES));
const RESOURCE_EVENT_KINDS = Object.freeze(['DECLARE', 'LEASE', 'REQUEST_START', 'OBSERVE_ACTIVE', 'REQUEST_QUIESCE', 'REQUEST_TERMINATE', 'OBSERVE_EXIT', 'BEGIN_RECLAIM', 'VERIFY_RECLAIM', 'RETAIN_ARTIFACT', 'MARK_UNKNOWN', 'QUARANTINE']);
const IDENTITY_RESULTS = Object.freeze(['MATCH', 'PARTIAL', 'MISMATCH']);
const RESOURCE_TYPES = Object.freeze(['agent_session', 'runtime_thread', 'process_tree', 'terminal_session', 'command_session', 'port', 'temporary_allocation', 'artifact', 'constrained_compute']);
const EXECUTABLE_TYPES = new Set(['agent_session', 'runtime_thread', 'process_tree', 'terminal_session', 'command_session', 'port', 'constrained_compute']);
const TERMINAL_RUN_STATES = new Set(['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED', 'HOLD']);
const TERMINAL_CHILD_STATES = new Set(['CLOSED', 'UNKNOWN']);
const TERMINAL_RESOURCE_STATES = new Set(['RECLAIMED', 'RETAINED', 'UNKNOWN', 'QUARANTINED']);
const MAX_EVENTS = 4096;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?Z$/;
const LIFECYCLE_KEYS = new Set(['event_id', 'machine', 'subject_id', 'from_state', 'to_state', 'sequence', 'observed_at', 'actor_role', 'actor_id', 'plan_generation', 'evidence_refs', 'guard_refs', 'supersedes_event_id']);
const RESOURCE_EVENT_KEYS = new Set(['event_id', 'resource_id', 'event_kind', 'from_state', 'to_state', 'sequence', 'observed_at', 'actor_role', 'actor_id', 'lease_generation', 'identity_ref', 'evidence_refs', 'postconditions', 'supersedes_event_id']);
const RESOURCE_KEYS = new Set(['resource_id', 'type', 'owner_role', 'owner_id', 'parent_resource_id', 'sublease_ref', 'lease_generation', 'state', 'identity', 'created_by_event', 'scope', 'quota_policy', 'cleanup_policy', 'last_verified_at', 'evidence_refs']);
const GUARD_KEYS = new Set(['guard_id', 'run_id', 'machine', 'subject_id', 'plan_generation', 'from_state', 'to_state', 'kind', 'observed_at', 'actor_role', 'actor_id', 'actor_authority_ref', 'evidence_refs', 'payload', 'source_sha256']);
const AUTHORITY_KEYS = new Set(['authority_id', 'run_id', 'subject_id', 'plan_generation', 'actor_role', 'actor_id', 'valid_from', 'valid_until', 'evidence_refs', 'source_sha256']);
const RESOURCE_SEAL_KEYS = new Set(['resource_id', 'run_id', 'plan_ref', 'launch_card', 'sealed_at', 'sealed_by_authority_ref', 'evidence_refs', 'source_sha256']);
const SUBLEASE_KEYS = new Set(['sublease_id', 'run_id', 'plan_ref', 'resource_id', 'parent_resource_id', 'child_id', 'lease_generation', 'authorized_at', 'authorized_by_authority_ref', 'verified_at', 'verified_by_authority_ref', 'evidence_refs', 'source_sha256']);
const RETENTION_KEYS = new Set(['retention_id', 'run_id', 'plan_ref', 'resource_id', 'policy_ref', 'authorized_at', 'authorized_by_authority_ref', 'verified_at', 'verified_by_authority_ref', 'evidence_refs', 'source_sha256']);
const PLAN_RECORD_KEYS = new Set(['plan_artifact_id', 'content_sha256', 'run_id', 'session_id', 'plan_generation', 'status', 'validated_at', 'validated_by_authority_ref', 'evidence_refs', 'source_sha256']);
const POSTCONDITION_KEYS = new Set(['never_started', 'no_side_effects', 'quiescent', 'no_handles', 'owner_verified', 'generation_verified', 'liveness_absent', 'port_absent', 'thread_absent', 'terminal_absent', 'temp_absent', 'compute_released', 'child_closed', 'artifact_sealed', 'target_is_host_session', 'identity_result', 'evidence_refs']);
const GUARD_KINDS = new Set(['ledger_open', 'new_packet_version', 'terminal_intent', 'terminal_intent_seal', 'resources_reclaimed', 'result_acceptance', 'result_review', 'result_verification']);

class StateMachineError extends Error {
  constructor(code, path, message) {
    super(message || code);
    this.name = 'StateMachineError';
    this.code = code;
    this.path = path || '$';
  }
  toJSON() { return { code: this.code, path: this.path, message: this.message }; }
}

function fail(code, path, message) { throw new StateMachineError(code, path, message); }
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }
function isTimestamp(value) {
  if (!isNonEmptyString(value) || !TIMESTAMP.test(value)) return false;
  const match = TIMESTAMP.exec(value);
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}
function asIndex(value) {
  if (value instanceof Map) return value;
  if (isPlainObject(value)) return new Map(Object.entries(value));
  return new Map();
}
function asSet(value) { return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []); }
function snapshot(value) { return createDetachedJsonSnapshot(value).snapshot; }
function exactKeys(value, keys, path) {
  if (!isPlainObject(value)) fail('EVENT_SHAPE_INVALID', path, 'event must be a plain object');
  const present = Object.keys(value);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail('EVENT_FIELD_MISSING', `${path}.${key}`, 'event field is required');
  for (const key of present) if (!keys.has(key)) fail('EVENT_ADDITIONAL_PROPERTY', `${path}.${key}`, 'event contains an unsupported property');
}
function exactRecordKeys(value, keys, path, code) {
  if (!isPlainObject(value)) fail(code, path, 'record must be a plain object');
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${path}.${key}`, 'record field is required');
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(code, `${path}.${key}`, 'record contains an unsupported property');
}
function samePlanRef(left, right) {
  return isPlainObject(left) && isPlainObject(right) && left.artifact_id === right.artifact_id && left.content_sha256 === right.content_sha256
    && isNonEmptyString(left.artifact_id) && SHA256_HEX.test(left.content_sha256 || '');
}
function verifySourceHash(record, path, code) {
  if (!isPlainObject(record) || !SHA256_HEX.test(record.source_sha256 || '')) fail(code, `${path}.source_sha256`, 'record source hash is invalid');
  const detached = { ...snapshot(record) };
  delete detached.source_sha256;
  if (computeDetachedSha256(detached) !== record.source_sha256) fail(code, `${path}.source_sha256`, 'record source hash does not match');
}
function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) fail('EVENT_REFERENCE_INVALID', path, 'references must be non-empty strings');
  if (new Set(value).size !== value.length) fail('EVENT_REFERENCE_DUPLICATE', path, 'references must be unique');
}
function unionEvidence(target, refs) { for (const ref of refs) if (!target.includes(ref)) target.push(ref); }
function canTransition(machine, from, to) {
  const tables = { run: RUN_EDGES, child: CHILD_EDGES, resource: RESOURCE_EDGES };
  const table = tables[machine];
  return Boolean(table && Object.prototype.hasOwnProperty.call(table, from) && table[from].includes(to));
}

function validateSupersedes(event, earlierEvents, sealedEventIds, path, generationField) {
  if (event.supersedes_event_id === null) return;
  if (!isNonEmptyString(event.supersedes_event_id)) fail('SUPERSEDED_EVENT_INVALID', `${path}.supersedes_event_id`, 'superseded event ID must be null or non-empty');
  const target = earlierEvents.get(event.supersedes_event_id);
  const sameSubject = target && (target.subject_id === event.subject_id || target.resource_id === event.resource_id);
  if (!target || !sameSubject || target[generationField] !== event[generationField] || sealedEventIds.has(event.supersedes_event_id)) {
    fail('SUPERSEDED_EVENT_INVALID', `${path}.supersedes_event_id`, 'superseded event must be an earlier unsealed event for the same subject and generation');
  }
}

function resolveAuthority(reference, options, binding, path, requiredRole) {
  const indexedAuthority = asIndex(options.authorityIndex).get(reference);
  if (!indexedAuthority) fail('GUARD_AUTHORITY_UNRESOLVED', path, 'authority reference does not resolve');
  let authority;
  try { authority = snapshot(indexedAuthority); }
  catch (_) { fail('GUARD_AUTHORITY_UNRESOLVED', path, 'authority record is not detached JSON'); }
  exactRecordKeys(authority, AUTHORITY_KEYS, path, 'GUARD_AUTHORITY_UNRESOLVED');
  verifySourceHash(authority, path, 'AUTHORITY_SOURCE_HASH_MISMATCH');
  stringArray(authority.evidence_refs, `${path}.evidence_refs`);
  if (!authority.evidence_refs.length || authority.authority_id !== reference || authority.run_id !== binding.runId
    || ![binding.subjectId, '*'].includes(authority.subject_id) || authority.plan_generation !== binding.generation) {
    fail('GUARD_ACTOR_UNAUTHORIZED', path, 'authority is not bound to this run, subject, or generation');
  }
  if (requiredRole && authority.actor_role !== requiredRole) fail('GUARD_ACTOR_UNAUTHORIZED', path, 'authority role is not permitted');
  if (binding.actorRole && (authority.actor_role !== binding.actorRole || authority.actor_id !== binding.actorId)) fail('GUARD_ACTOR_UNAUTHORIZED', path, 'authority actor does not match record actor');
  if (!isTimestamp(authority.valid_from) || !isTimestamp(authority.valid_until) || !isTimestamp(binding.observedAt)
    || Date.parse(authority.valid_from) > Date.parse(binding.observedAt) || Date.parse(authority.valid_until) < Date.parse(binding.observedAt)) {
    fail('GUARD_ACTOR_UNAUTHORIZED', path, 'authority is outside its validity window');
  }
  const resolver = options.trustedAuthorityResolver;
  if (typeof resolver !== 'function') fail('AUTHORITY_TRUST_NOT_PROVEN', path, 'trusted authority resolver is required');
  const context = snapshot({
    authorityRef: reference,
    purpose: binding.purpose || 'authority_resolution',
    runId: binding.runId,
    subjectId: binding.subjectId,
    generation: binding.generation,
    requiredRole: requiredRole || null,
    actorRole: binding.actorRole || null,
    actorId: binding.actorId || null,
    observedAt: binding.observedAt,
    usage: path,
  });
  let trusted = false;
  try { trusted = resolver(authority, context) === true; } catch (_) { trusted = false; }
  if (!trusted) fail('AUTHORITY_TRUST_NOT_PROVEN', path, 'authority was not accepted by the trusted resolver');
  return authority;
}
function payloadHasOnly(payload, keys) { return isPlainObject(payload) && Object.keys(payload).every((key) => keys.includes(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(payload, key)); }
function validateGuardPayload(guard, path) {
  const payload = guard.payload;
  switch (guard.kind) {
    case 'ledger_open': if (!payloadHasOnly(payload, [])) break; return;
    case 'new_packet_version': if (payloadHasOnly(payload, ['packet_version', 'packet_sha256']) && Number.isSafeInteger(payload.packet_version) && payload.packet_version > 0 && SHA256_HEX.test(payload.packet_sha256 || '')) return; break;
    case 'terminal_intent': if (payloadHasOnly(payload, ['intent']) && ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED'].includes(payload.intent)) return; break;
    case 'terminal_intent_seal': if (payloadHasOnly(payload, ['intent', 'intent_guard_id', 'intent_source_sha256']) && ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED'].includes(payload.intent) && isNonEmptyString(payload.intent_guard_id) && SHA256_HEX.test(payload.intent_source_sha256 || '')) return; break;
    case 'resources_reclaimed': if (payloadHasOnly(payload, ['resource_ids', 'resource_snapshot_sha256']) && Array.isArray(payload.resource_ids) && payload.resource_ids.every(isNonEmptyString) && new Set(payload.resource_ids).size === payload.resource_ids.length && SHA256_HEX.test(payload.resource_snapshot_sha256 || '')) return; break;
    case 'result_acceptance': if (payloadHasOnly(payload, ['result_sha256']) && SHA256_HEX.test(payload.result_sha256 || '')) return; break;
    case 'result_review': if (payloadHasOnly(payload, ['acceptance_guard_id', 'result_sha256']) && isNonEmptyString(payload.acceptance_guard_id) && SHA256_HEX.test(payload.result_sha256 || '')) return; break;
    case 'result_verification': if (payloadHasOnly(payload, ['review_guard_id', 'result_sha256']) && isNonEmptyString(payload.review_guard_id) && SHA256_HEX.test(payload.result_sha256 || '')) return; break;
    default: break;
  }
  fail('GUARD_PAYLOAD_INVALID', `${path}.payload`, 'guard payload is invalid for its kind');
}
function resolveGuards(event, options, path) {
  const index = asIndex(options.guardIndex);
  const guards = [];
  for (let position = 0; position < event.guard_refs.length; position += 1) {
    const ref = event.guard_refs[position];
    const guardPath = `${path}.guard_refs[${position}]`;
    const guard = index.get(ref);
    if (!guard) fail('GUARD_REFERENCE_UNRESOLVED', guardPath, 'guard reference does not resolve');
    exactRecordKeys(guard, GUARD_KEYS, guardPath, 'GUARD_RECORD_INVALID');
    if (guard.guard_id !== ref || !GUARD_KINDS.has(guard.kind)) fail('GUARD_RECORD_INVALID', guardPath, 'guard identity or kind is invalid');
    verifySourceHash(guard, guardPath, 'GUARD_SOURCE_HASH_MISMATCH');
    stringArray(guard.evidence_refs, `${guardPath}.evidence_refs`);
    if (!guard.evidence_refs.length) fail('GUARD_EVIDENCE_REQUIRED', guardPath, 'guard evidence is required');
    if (guard.run_id !== options.runId) fail('GUARD_RUN_MISMATCH', guardPath, 'guard run does not match');
    if (guard.machine !== event.machine || guard.subject_id !== event.subject_id) fail('GUARD_SUBJECT_MISMATCH', guardPath, 'guard machine or subject does not match');
    if (guard.plan_generation !== event.plan_generation) fail('GUARD_GENERATION_MISMATCH', guardPath, 'guard generation does not match');
    if (guard.from_state !== event.from_state || guard.to_state !== event.to_state) fail('GUARD_EDGE_MISMATCH', guardPath, 'guard edge does not match');
    if (!isTimestamp(guard.observed_at) || Date.parse(guard.observed_at) > Date.parse(event.observed_at)) fail('GUARD_FROM_FUTURE', guardPath, 'guard is newer than the guarded event');
    if (guard.actor_role !== event.actor_role || guard.actor_id !== event.actor_id) fail('GUARD_ACTOR_UNAUTHORIZED', guardPath, 'guard actor differs from event actor');
    validateGuardPayload(guard, guardPath);
    const authority = resolveAuthority(guard.actor_authority_ref, options, { purpose: 'lifecycle_guard', runId: options.runId, subjectId: event.subject_id, generation: event.plan_generation, actorRole: guard.actor_role, actorId: guard.actor_id, observedAt: event.observed_at }, `${guardPath}.actor_authority_ref`);
    if (Date.parse(guard.observed_at) < Date.parse(authority.valid_from)) fail('GUARD_ACTOR_UNAUTHORIZED', guardPath, 'guard predates its authority window');
    guards.push(guard);
  }
  return guards;
}
function findGuard(guards, kind) { return guards.find((guard) => guard.kind === kind); }
function enforceLifecycleGuards(event, guards, current, path) {
  const updates = {};
  if (event.machine === 'child' && event.to_state === 'RESULT_REJECTED') updates._lastRejectionAt = event.observed_at;
  if (event.machine === 'run' && event.to_state === 'DISPATCHING' && !findGuard(guards, 'ledger_open')) fail('LEDGER_BEFORE_DISPATCH_REQUIRED', path, 'dispatch requires a bound ledger-open guard');
  if (event.machine === 'run' && event.from_state === 'RECLAIMING' && ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED'].includes(event.to_state)) {
    const intent = findGuard(guards, 'terminal_intent');
    const seal = findGuard(guards, 'terminal_intent_seal');
    if (!intent || intent.payload.intent !== event.to_state) fail('TERMINAL_INTENT_MISMATCH', path, 'terminal state must match intent');
    if (!seal || seal.payload.intent !== intent.payload.intent || seal.payload.intent_guard_id !== intent.guard_id || seal.payload.intent_source_sha256 !== intent.source_sha256) fail('TERMINAL_INTENT_SEAL_MISMATCH', path, 'terminal seal must bind the exact intent guard');
    if (!findGuard(guards, 'resources_reclaimed')) fail('RESOURCES_NOT_RECLAIMED', path, 'terminal transition requires reclaimed resources');
  }
  if (event.machine === 'child' && event.from_state === 'RESULT_REJECTED' && event.to_state === 'WORKING') {
    const packet = findGuard(guards, 'new_packet_version');
    if (!packet || packet.payload.packet_version <= (current._lastPacketVersion || 0) || packet.payload.packet_sha256 === current._lastPacketSha256
      || !current._lastRejectionAt || Date.parse(packet.observed_at) <= Date.parse(current._lastRejectionAt)) fail('NEW_PACKET_VERSION_REQUIRED', path, 'rework requires a fresh strictly newer packet guard');
    updates._lastPacketVersion = packet.payload.packet_version; updates._lastPacketSha256 = packet.payload.packet_sha256;
  }
  if (event.machine === 'child' && event.from_state === 'RESULT_SUBMITTED' && event.to_state === 'RESULT_ACCEPTED') {
    const acceptance = findGuard(guards, 'result_acceptance');
    if (!acceptance || event.actor_role !== 'root') fail('ROOT_ACCEPTANCE_REQUIRED', path, 'result acceptance requires root authority');
    updates._acceptanceGuardId = acceptance.guard_id; updates._resultSha256 = acceptance.payload.result_sha256; updates._reviewActorId = event.actor_id;
  }
  if (event.machine === 'child' && event.from_state === 'RESULT_ACCEPTED' && event.to_state === 'REVIEWED') {
    const review = findGuard(guards, 'result_review');
    if (!review || event.actor_role !== 'root' || review.payload.acceptance_guard_id !== current._acceptanceGuardId || review.payload.result_sha256 !== current._resultSha256) fail('ROOT_REVIEW_REQUIRED', path, 'review must bind root acceptance');
    updates._reviewGuardId = review.guard_id; updates._resultSha256 = review.payload.result_sha256; updates._reviewActorId = event.actor_id;
  }
  if (event.machine === 'child' && event.from_state === 'REVIEWED' && event.to_state === 'VERIFIED') {
    const verification = findGuard(guards, 'result_verification');
    if (!verification || event.actor_role !== 'verifier' || verification.payload.review_guard_id !== current._reviewGuardId || verification.payload.result_sha256 !== current._resultSha256) fail('VERIFIER_VERIFICATION_REQUIRED', path, 'verification must bind the reviewed result');
    if (event.actor_id === current._reviewActorId) fail('VERIFIER_NOT_INDEPENDENT', path, 'verifier must be independent from reviewer');
  }
  return updates;
}

function validateLifecycleEvent(event, path) {
  exactKeys(event, LIFECYCLE_KEYS, path);
  if (!['run', 'child'].includes(event.machine) || !isNonEmptyString(event.event_id) || !isNonEmptyString(event.subject_id)) fail('EVENT_IDENTITY_INVALID', path, 'lifecycle event identity is invalid');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isSafeInteger(event.plan_generation) || event.plan_generation < 1) fail('EVENT_SEQUENCE_INVALID', path, 'event sequence and generation must be positive safe integers');
  if (!isTimestamp(event.observed_at)) fail('EVENT_TIMESTAMP_INVALID', `${path}.observed_at`, 'event timestamp must be RFC3339 UTC');
  if (!isNonEmptyString(event.actor_role) || !isNonEmptyString(event.actor_id)) fail('EVENT_ACTOR_INVALID', path, 'event actor is required');
  stringArray(event.evidence_refs, `${path}.evidence_refs`);
  stringArray(event.guard_refs, `${path}.guard_refs`);
  const states = event.machine === 'run' ? RUN_STATES : CHILD_STATES;
  if (!states.includes(event.to_state) || (event.from_state !== null && !states.includes(event.from_state))) fail('EVENT_STATE_INVALID', path, 'event state is unsupported');
}

function reduceLifecycleEvents(events, options = {}) {
  if (!Array.isArray(events)) fail('EVENT_COLLECTION_INVALID', '$', 'lifecycle events must be an array');
  if (events.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', '$', 'lifecycle event limit exceeded');
  const states = new Map();
  const earlierEvents = new Map();
  const sealedEventIds = asSet(options.sealedEventIds);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `$[${index}]`;
    validateLifecycleEvent(event, path);
    if (options.planGeneration !== undefined && event.plan_generation !== options.planGeneration) fail('PLAN_GENERATION_MISMATCH', `${path}.plan_generation`, 'lifecycle event generation does not match the independently validated plan');
    if (earlierEvents.has(event.event_id)) fail('EVENT_ID_DUPLICATE', `${path}.event_id`, 'event ID must be unique');
    validateSupersedes(event, earlierEvents, sealedEventIds, path, 'plan_generation');
    const key = `${event.machine}\u0000${event.subject_id}`;
    const current = states.get(key);
    const initialState = event.machine === 'run' ? 'PLANNING' : 'DECLARED';
    if (!current) {
      if (event.sequence !== 1) fail('EVENT_SEQUENCE_INVALID', path, 'first subject event must have sequence 1');
      if (event.from_state !== null || event.to_state !== initialState) fail('INITIAL_STATE_INVALID', path, 'first subject event has an invalid initial transition');
    } else {
      if (event.sequence !== current.sequence + 1) fail('EVENT_SEQUENCE_INVALID', path, 'event sequence must increase by exactly one');
      if (event.from_state !== current.state) fail('EVENT_FROM_STATE_MISMATCH', path, 'event from-state differs from reduced state');
      if (event.plan_generation !== current.plan_generation) fail('EVENT_GENERATION_MISMATCH', path, 'plan generation cannot change within a subject stream');
      if (Date.parse(event.observed_at) <= Date.parse(current.observed_at)) fail('EVENT_TIME_NOT_MONOTONIC', path, 'event time must increase strictly');
      if (!canTransition(event.machine, event.from_state, event.to_state)) fail('ILLEGAL_TRANSITION', path, 'transition is not in the canonical edge table');
    }
    const guards = resolveGuards(event, options, path);
    const guardUpdates = enforceLifecycleGuards(event, guards, current || {}, path);
    const evidenceRefs = current ? [...current.evidence_refs] : [];
    unionEvidence(evidenceRefs, event.evidence_refs);
    const guardRefs = current ? [...current.guard_refs] : [];
    unionEvidence(guardRefs, event.guard_refs);
    states.set(key, {
      ...(current || {}),
      machine: event.machine,
      subject_id: event.subject_id,
      state: event.to_state,
      sequence: event.sequence,
      observed_at: event.observed_at,
      plan_generation: event.plan_generation,
      evidence_refs: evidenceRefs,
      guard_refs: guardRefs,
      last_event_id: event.event_id,
      ...guardUpdates,
    });
    earlierEvents.set(event.event_id, event);
  }
  return [...states.values()].map((value) => {
    const { _acceptanceGuardId, _reviewGuardId, _resultSha256, _reviewActorId, _lastRejectionAt, _lastPacketVersion, _lastPacketSha256, ...publicValue } = value;
    return snapshot(publicValue);
  });
}

const IDENTITY_FIELDS = Object.freeze(['pid', 'native_handle', 'start_time', 'exe_path_hash', 'argv_hash', 'parent_identity_hash', 'nonce', 'native_process_manager_run_id']);
function identityValueKnown(field, value) {
  if (field === 'pid') return Number.isSafeInteger(value) && value > 0;
  if (!isNonEmptyString(value) || value === 'unknown' || value === 'not_observable') return false;
  if (['exe_path_hash', 'argv_hash', 'parent_identity_hash'].includes(field)) return SHA256_HEX.test(value);
  if (field === 'start_time') return isTimestamp(value);
  return true;
}
function compareProcessIdentity(expected, observed, expectedGeneration, observedGeneration) {
  if (!Number.isSafeInteger(expectedGeneration) || !Number.isSafeInteger(observedGeneration)) return 'PARTIAL';
  if (expectedGeneration !== observedGeneration) return 'MISMATCH';
  if (!isPlainObject(expected) || !isPlainObject(observed)) return 'PARTIAL';
  let partial = false;
  for (const field of IDENTITY_FIELDS) {
    const leftKnown = identityValueKnown(field, expected[field]);
    const rightKnown = identityValueKnown(field, observed[field]);
    if (!leftKnown || !rightKnown) { partial = true; continue; }
    if (expected[field] !== observed[field]) return 'MISMATCH';
  }
  return partial ? 'PARTIAL' : 'MATCH';
}
function validateProcessIdentity(identity) {
  const errors = [];
  if (!isPlainObject(identity)) errors.push(new StateMachineError('PROCESS_IDENTITY_INVALID', '$', 'process identity must be an object'));
  else for (const field of IDENTITY_FIELDS) if (!identityValueKnown(field, identity[field]) && !(field === 'native_process_manager_run_id' && identity[field] === 'not_available')) {
    errors.push(new StateMachineError('PROCESS_IDENTITY_PARTIAL', `$.${field}`, 'process identity field is not exact'));
  }
  return { valid: errors.length === 0, errors, confidence: errors.length ? 'PARTIAL' : 'MATCH' };
}
function compareResourceIdentity(entry, observed) {
  if (EXECUTABLE_TYPES.has(entry.type)) return compareProcessIdentity(entry.identity, observed, entry.lease_generation, entry.lease_generation);
  if (!isPlainObject(entry.identity) || !isPlainObject(observed)) return 'PARTIAL';
  try { return canonicalize(entry.identity) === canonicalize(observed) ? 'MATCH' : 'MISMATCH'; } catch (_) { return 'PARTIAL'; }
}

function validateResourceEvent(event, path) {
  exactKeys(event, RESOURCE_EVENT_KEYS, path);
  if (!isNonEmptyString(event.event_id) || !isNonEmptyString(event.resource_id) || !RESOURCE_EVENT_KINDS.includes(event.event_kind)) fail('RESOURCE_EVENT_INVALID', path, 'resource event identity or kind is invalid');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isSafeInteger(event.lease_generation) || event.lease_generation < 1) fail('EVENT_SEQUENCE_INVALID', path, 'event sequence and generation must be positive safe integers');
  if (!isTimestamp(event.observed_at) || !isNonEmptyString(event.actor_role) || !isNonEmptyString(event.actor_id) || !isNonEmptyString(event.identity_ref)) fail('RESOURCE_EVENT_INVALID', path, 'resource observation identity is invalid');
  if (!RESOURCE_STATES.includes(event.to_state) || (event.from_state !== null && !RESOURCE_STATES.includes(event.from_state))) fail('RESOURCE_STATE_INVALID', path, 'resource state is unsupported');
  stringArray(event.evidence_refs, `${path}.evidence_refs`);
  if (!isPlainObject(event.postconditions)) fail('RESOURCE_POSTCONDITIONS_INVALID', `${path}.postconditions`, 'postconditions must be an object');
  for (const key of Object.keys(event.postconditions)) if (!POSTCONDITION_KEYS.has(key)) fail('RESOURCE_POSTCONDITIONS_INVALID', `${path}.postconditions.${key}`, 'unsupported postcondition');
  if (event.postconditions.evidence_refs !== undefined) stringArray(event.postconditions.evidence_refs, `${path}.postconditions.evidence_refs`);
}
function validateResourceDeclaration(entry, path) {
  if (!isPlainObject(entry) || !isNonEmptyString(entry.resource_id) || !RESOURCE_TYPES.includes(entry.type)) fail('RESOURCE_DECLARATION_INVALID', path, 'resource declaration is invalid');
  exactRecordKeys(entry, RESOURCE_KEYS, path, 'RESOURCE_DECLARATION_INVALID');
  for (const field of ['owner_role', 'owner_id', 'created_by_event']) if (!isNonEmptyString(entry[field])) fail('RESOURCE_DECLARATION_INVALID', `${path}.${field}`, 'resource ownership and creation event are required');
  if (!['root', 'child'].includes(entry.owner_role)) fail('RESOURCE_DECLARATION_INVALID', `${path}.owner_role`, 'resource owner role is invalid');
  if (entry.parent_resource_id !== null && !isNonEmptyString(entry.parent_resource_id)) fail('RESOURCE_DECLARATION_INVALID', `${path}.parent_resource_id`, 'parent resource ID must be null or non-empty');
  if (entry.sublease_ref !== null && !isNonEmptyString(entry.sublease_ref)) fail('RESOURCE_DECLARATION_INVALID', `${path}.sublease_ref`, 'sublease reference must be null or non-empty');
  if (entry.owner_role === 'child' && entry.parent_resource_id === null) fail('CHILD_PARENT_REQUIRED', `${path}.parent_resource_id`, 'child resource requires an authorized parent');
  if (entry.owner_role === 'child' && entry.sublease_ref === null) fail('CHILD_SUBLEASE_REQUIRED', `${path}.sublease_ref`, 'child resource requires a verified sublease');
  if (entry.owner_role === 'root' && entry.sublease_ref !== null) fail('ROOT_RESOURCE_SUBLEASE_FORBIDDEN', `${path}.sublease_ref`, 'root resource cannot claim a child sublease');
  if (!Number.isSafeInteger(entry.lease_generation) || entry.lease_generation < 1 || entry.state !== 'DECLARED') fail('RESOURCE_DECLARATION_INVALID', path, 'resource declaration generation or initial state is invalid');
  if (!isPlainObject(entry.scope) || !isPlainObject(entry.quota_policy) || !isPlainObject(entry.cleanup_policy) || !Array.isArray(entry.evidence_refs)) fail('RESOURCE_DECLARATION_INVALID', path, 'resource launch card is incomplete');
  stringArray(entry.evidence_refs, `${path}.evidence_refs`);
}
function requirePostconditions(event, names, code = 'RECLAIM_POSTCONDITION_MISSING') {
  for (const name of names) if (event.postconditions[name] !== true) fail(code, `$.postconditions.${name}`, `required postcondition is missing: ${name}`);
}
function enforceResourceGuards(event, entry, identityResult, options, path) {
  if (event.event_kind === 'LEASE' && (!isNonEmptyString(options.runId) || !samePlanRef(options.planRef, options.validatedPlanRef))) fail('PLAN_BEFORE_LEASE_REQUIRED', path, 'resource lease requires an independently validated plan binding');
  if (event.event_kind === 'REQUEST_TERMINATE' && entry.owner_role === 'child' && event.postconditions.target_is_host_session === true) {
    fail('CHILD_HOST_TERMINATION_FORBIDDEN', path, 'a child cannot terminate its own host session');
  }
  if (identityResult === 'MISMATCH' && event.to_state !== 'UNKNOWN') fail('IDENTITY_MISMATCH_REQUIRES_UNKNOWN', path, 'identity mismatch requires UNKNOWN state');
  if (['REQUEST_TERMINATE', 'BEGIN_RECLAIM', 'VERIFY_RECLAIM', 'RETAIN_ARTIFACT'].includes(event.event_kind) && identityResult !== 'MATCH') {
    fail('IDENTITY_MATCH_REQUIRED', path, 'destructive or reclaim action requires exact identity');
  }
  if (event.event_kind === 'BEGIN_RECLAIM' && ['LEASED', 'START_REQUESTED'].includes(event.from_state)) {
    requirePostconditions(event, ['never_started', 'no_side_effects', 'owner_verified', 'generation_verified']);
  }
  if (event.event_kind === 'BEGIN_RECLAIM' && event.from_state === 'ACTIVE') {
    if (EXECUTABLE_TYPES.has(entry.type)) fail('EXECUTABLE_EXIT_REQUIRED', path, 'executable resources must reach EXIT_OBSERVED before reclaim');
    if (!['temporary_allocation', 'artifact'].includes(entry.type)) fail('ACTIVE_RECLAIM_FORBIDDEN', path, 'active direct reclaim is restricted to safe non-executable types');
    requirePostconditions(event, ['quiescent', 'no_handles', 'owner_verified', 'generation_verified']);
  }
  if (event.event_kind === 'VERIFY_RECLAIM') {
    requirePostconditions(event, ['owner_verified', 'generation_verified']);
    const typeProof = {
      agent_session: 'child_closed', runtime_thread: 'thread_absent', process_tree: 'liveness_absent',
      terminal_session: 'terminal_absent', command_session: 'liveness_absent', port: 'port_absent',
      temporary_allocation: 'temp_absent', artifact: 'artifact_sealed', constrained_compute: 'compute_released',
    }[entry.type];
    requirePostconditions(event, [typeProof]);
    if (EXECUTABLE_TYPES.has(entry.type) && event.postconditions.identity_result !== 'MATCH') fail('RECLAIM_POSTCONDITION_MISSING', `${path}.postconditions.identity_result`, 'executable reclaim requires identity_result MATCH');
  }
  if (event.event_kind === 'RETAIN_ARTIFACT') {
    requirePostconditions(event, ['owner_verified', 'generation_verified', 'artifact_sealed']);
    validateRetention(entry, event, options, `${path}.retention`);
  }
}
function validateSublease(entry, options, path) {
  if (entry.owner_role !== 'child') return null;
  const record = asIndex(options.subleaseIndex).get(entry.sublease_ref);
  if (!record) fail('CHILD_SUBLEASE_UNRESOLVED', `${path}.sublease_ref`, 'child sublease does not resolve');
  exactRecordKeys(record, SUBLEASE_KEYS, `${path}.sublease_ref`, 'CHILD_SUBLEASE_UNRESOLVED');
  verifySourceHash(record, `${path}.sublease_ref`, 'CHILD_SUBLEASE_HASH_MISMATCH');
  stringArray(record.evidence_refs, `${path}.sublease_ref.evidence_refs`);
  if (!record.evidence_refs.length || record.sublease_id !== entry.sublease_ref || record.run_id !== options.runId || !samePlanRef(record.plan_ref, options.planRef)
    || record.resource_id !== entry.resource_id || record.parent_resource_id !== entry.parent_resource_id || record.child_id !== entry.owner_id || record.lease_generation !== entry.lease_generation) {
    fail('CHILD_SUBLEASE_BINDING_MISMATCH', `${path}.sublease_ref`, 'sublease binding does not match resource, parent, child, run, plan, or generation');
  }
  if (!isTimestamp(record.authorized_at) || !isTimestamp(record.verified_at) || Date.parse(record.authorized_at) > Date.parse(record.verified_at)) fail('CHILD_SUBLEASE_TIME_INVALID', `${path}.sublease_ref`, 'sublease authorization time is invalid');
  const rootAuthority = resolveAuthority(record.authorized_by_authority_ref, options, { purpose: 'sublease_authorization', runId: options.runId, subjectId: entry.resource_id, generation: entry.lease_generation, observedAt: record.authorized_at }, `${path}.sublease_ref.authorized_by_authority_ref`, 'root');
  const verifierAuthority = resolveAuthority(record.verified_by_authority_ref, options, { purpose: 'sublease_verification', runId: options.runId, subjectId: entry.resource_id, generation: entry.lease_generation, observedAt: record.verified_at }, `${path}.sublease_ref.verified_by_authority_ref`, 'verifier');
  if (rootAuthority.actor_id === verifierAuthority.actor_id) fail('CHILD_SUBLEASE_VERIFICATION_INVALID', `${path}.sublease_ref`, 'sublease verifier must be independent');
  return record;
}
function validateRetention(entry, event, options, path) {
  const record = asIndex(options.retentionIndex).get(entry.resource_id);
  if (!record) fail('ARTIFACT_RETENTION_AUTHORIZATION_REQUIRED', path, 'retained artifact requires an independent retention record');
  exactRecordKeys(record, RETENTION_KEYS, path, 'ARTIFACT_RETENTION_AUTHORIZATION_REQUIRED');
  verifySourceHash(record, path, 'ARTIFACT_RETENTION_HASH_MISMATCH');
  stringArray(record.evidence_refs, `${path}.evidence_refs`);
  if (entry.type !== 'artifact' || entry.owner_role !== 'root' || !record.evidence_refs.length || !isNonEmptyString(record.retention_id)
    || record.run_id !== options.runId || !samePlanRef(record.plan_ref, options.planRef) || record.resource_id !== entry.resource_id
    || !isNonEmptyString(record.policy_ref) || !isTimestamp(record.authorized_at) || !isTimestamp(record.verified_at)
    || Date.parse(record.authorized_at) > Date.parse(record.verified_at) || Date.parse(record.verified_at) > Date.parse(event.observed_at)) {
    fail('ARTIFACT_RETENTION_BINDING_INVALID', path, 'retention record is not bound to this root-owned artifact, run, plan, policy, or event time');
  }
  const rootAuthority = resolveAuthority(record.authorized_by_authority_ref, options, { purpose: 'retention_authorization', runId: options.runId, subjectId: entry.resource_id, generation: entry.lease_generation, observedAt: record.authorized_at }, `${path}.authorized_by_authority_ref`, 'root');
  const verifierAuthority = resolveAuthority(record.verified_by_authority_ref, options, { purpose: 'retention_verification', runId: options.runId, subjectId: entry.resource_id, generation: entry.lease_generation, observedAt: record.verified_at }, `${path}.verified_by_authority_ref`, 'verifier');
  if (rootAuthority.actor_id === verifierAuthority.actor_id) fail('ARTIFACT_RETENTION_VERIFICATION_INVALID', path, 'retention verifier must be independent');
}
function enforceResourceEventKind(event, path) {
  const allowed = {
    DECLARE: [[null, 'DECLARED']],
    LEASE: [['DECLARED', 'LEASED']],
    REQUEST_START: [['LEASED', 'START_REQUESTED']],
    OBSERVE_ACTIVE: [['LEASED', 'ACTIVE'], ['START_REQUESTED', 'ACTIVE'], ['QUIESCING', 'ACTIVE']],
    REQUEST_QUIESCE: [['ACTIVE', 'QUIESCING']],
    REQUEST_TERMINATE: [['ACTIVE', 'TERMINATE_REQUESTED'], ['QUIESCING', 'TERMINATE_REQUESTED']],
    OBSERVE_EXIT: [['ACTIVE', 'EXIT_OBSERVED'], ['QUIESCING', 'EXIT_OBSERVED'], ['TERMINATE_REQUESTED', 'EXIT_OBSERVED']],
    BEGIN_RECLAIM: [['LEASED', 'RECLAIMING'], ['START_REQUESTED', 'RECLAIMING'], ['ACTIVE', 'RECLAIMING'], ['EXIT_OBSERVED', 'RECLAIMING']],
    VERIFY_RECLAIM: [['RECLAIMING', 'RECLAIMED']],
    RETAIN_ARTIFACT: [['RECLAIMING', 'RETAINED']],
    MARK_UNKNOWN: RESOURCE_STATES.filter((state) => !TERMINAL_RESOURCE_STATES.has(state)).map((state) => [state, 'UNKNOWN']),
    QUARANTINE: RESOURCE_STATES.filter((state) => !TERMINAL_RESOURCE_STATES.has(state)).map((state) => [state, 'QUARANTINED']),
  }[event.event_kind];
  if (!allowed.some(([from, to]) => from === event.from_state && to === event.to_state)) fail('RESOURCE_EVENT_KIND_MISMATCH', path, 'resource event kind does not match its transition');
}

function reduceResourceEvents(events, declarations = [], options = {}) {
  if (!Array.isArray(events) || !Array.isArray(declarations)) fail('RESOURCE_COLLECTION_INVALID', '$', 'resource events and declarations must be arrays');
  if (events.length > MAX_EVENTS || declarations.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', '$', 'resource collection limit exceeded');
  const declarationIndex = new Map();
  const subleases = new Map();
  for (let index = 0; index < declarations.length; index += 1) {
    const entry = declarations[index];
    validateResourceDeclaration(entry, `$declarations[${index}]`);
    if (declarationIndex.has(entry.resource_id)) fail('RESOURCE_ID_DUPLICATE', `$declarations[${index}].resource_id`, 'resource ID must be unique');
    declarationIndex.set(entry.resource_id, entry);
    const sublease = validateSublease(entry, options, `$declarations[${index}]`);
    if (sublease) subleases.set(entry.resource_id, sublease);
  }
  for (const entry of declarationIndex.values()) {
    if (entry.parent_resource_id !== null) {
      const parent = declarationIndex.get(entry.parent_resource_id);
      if (!parent || parent.lease_generation !== entry.lease_generation) fail('PARENT_LEASE_INVALID', '$declarations', 'parent lease is missing or generation mismatched');
      if (entry.owner_role === 'child' && (parent.owner_role !== 'root' || !['agent_session', 'runtime_thread', 'process_tree', 'terminal_session'].includes(parent.type))) fail('PARENT_LEASE_INVALID', '$declarations', 'child parent must be an allowed root-owned outer resource');
    }
  }
  const identityIndex = asIndex(options.identityIndex);
  const sealedEventIds = asSet(options.sealedEventIds);
  const earlierEvents = new Map();
  const reduced = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `$events[${index}]`;
    validateResourceEvent(event, path);
    if (earlierEvents.has(event.event_id)) fail('EVENT_ID_DUPLICATE', `${path}.event_id`, 'event ID must be unique');
    validateSupersedes(event, earlierEvents, sealedEventIds, path, 'lease_generation');
    const entry = declarationIndex.get(event.resource_id);
    if (!entry) fail('RESOURCE_DECLARATION_MISSING', `${path}.resource_id`, 'resource event has no declaration');
    const current = reduced.get(event.resource_id);
    if (!current) {
      if (event.sequence !== 1) fail('EVENT_SEQUENCE_INVALID', path, 'first resource event must have sequence 1');
      if (event.event_kind !== 'DECLARE' || event.from_state !== null || event.to_state !== 'DECLARED') fail('INITIAL_STATE_INVALID', path, 'first resource event must declare the resource');
      if (entry.created_by_event !== event.event_id) fail('RESOURCE_CREATION_EVENT_MISMATCH', path, 'declaration must bind the first event');
    } else {
      if (event.sequence !== current._sequence + 1) fail('EVENT_SEQUENCE_INVALID', path, 'resource sequence must increase by exactly one');
      if (event.from_state !== current.state) fail('RESOURCE_FROM_STATE_MISMATCH', path, 'event from-state differs from reduced resource state');
      if (Date.parse(event.observed_at) <= Date.parse(current._observedAt)) fail('EVENT_TIME_NOT_MONOTONIC', path, 'resource event time must increase strictly');
      if (!canTransition('resource', event.from_state, event.to_state)) fail('ILLEGAL_TRANSITION', path, 'transition is not in the canonical resource edge table');
    }
    if (event.lease_generation !== entry.lease_generation) fail('EVENT_GENERATION_MISMATCH', path, 'resource event generation differs from declaration');
    if (event.actor_role !== entry.owner_role || event.actor_id !== entry.owner_id) fail('RESOURCE_OWNERSHIP_TRANSFER_FORBIDDEN', path, 'resource event actor differs from its declared owner');
    enforceResourceEventKind(event, path);
    const observedIdentity = identityIndex.get(event.identity_ref);
    if (!observedIdentity) fail('IDENTITY_REFERENCE_UNRESOLVED', `${path}.identity_ref`, 'identity reference does not resolve');
    const identityResult = compareResourceIdentity(entry, observedIdentity);
    if (event.event_kind === 'LEASE' && entry.owner_role === 'child') {
      const parent = reduced.get(entry.parent_resource_id);
      const sublease = subleases.get(entry.resource_id);
      if (!parent || parent.state === 'DECLARED' || Date.parse(parent._observedAt) >= Date.parse(event.observed_at)) fail('PARENT_LEASE_EVENT_REQUIRED', path, 'parent matching-generation lease must precede child lease');
      if (!['LEASED', 'START_REQUESTED', 'ACTIVE'].includes(parent.state)) fail('PARENT_LEASE_NOT_ACTIVE', path, 'parent must remain in an explicit live lease state');
      if (!sublease || Date.parse(sublease.verified_at) > Date.parse(event.observed_at)) fail('CHILD_SUBLEASE_TIME_INVALID', path, 'verified sublease must precede child lease');
    }
    enforceResourceGuards(event, entry, identityResult, options, path);
    const evidenceRefs = current ? [...current.evidence_refs] : [...entry.evidence_refs];
    unionEvidence(evidenceRefs, event.evidence_refs);
    reduced.set(event.resource_id, {
      ...snapshot(entry), state: event.to_state, _sequence: event.sequence, _observedAt: event.observed_at,
      last_verified_at: ['OBSERVE_ACTIVE', 'OBSERVE_EXIT', 'VERIFY_RECLAIM', 'RETAIN_ARTIFACT'].includes(event.event_kind) ? event.observed_at : (current ? current.last_verified_at : entry.last_verified_at),
      evidence_refs: evidenceRefs,
    });
    earlierEvents.set(event.event_id, event);
  }
  for (const resourceId of declarationIndex.keys()) if (!reduced.has(resourceId)) fail('RESOURCE_EVENT_MISSING', '$events', 'declared resource has no event stream');
  return [...declarationIndex.keys()].map((resourceId) => {
    const { _sequence, _observedAt, ...publicValue } = reduced.get(resourceId);
    return snapshot(publicValue);
  });
}

function validationError(code, path, message) { return new StateMachineError(code, path, message); }
function sameSnapshot(left, right) {
  try { return canonicalize(left) === canonicalize(right); } catch (_) { return false; }
}
function assertLifecyclePartition(events, machine, path) {
  for (let index = 0; index < events.length; index += 1) if (!events[index] || events[index].machine !== machine) fail('LIFECYCLE_EVENT_PARTITION_MISMATCH', `${path}[${index}].machine`, 'lifecycle event is stored in the wrong machine partition');
}
function validatePlanBinding(ledger, options) {
  if (!(options.planIndex instanceof Map) && !isPlainObject(options.planIndex)) fail('PLAN_INDEX_REQUIRED', '$options.planIndex', 'independent validated-plan index is required');
  const record = asIndex(options.planIndex).get(ledger.plan_ref.artifact_id);
  if (!record) fail('VALIDATED_PLAN_MISSING', '$options.planIndex', 'validated plan record is missing');
  exactRecordKeys(record, PLAN_RECORD_KEYS, '$options.planIndex.plan', 'VALIDATED_PLAN_RECORD_INVALID');
  verifySourceHash(record, '$options.planIndex.plan', 'VALIDATED_PLAN_HASH_MISMATCH');
  stringArray(record.evidence_refs, '$options.planIndex.plan.evidence_refs');
  if (!record.evidence_refs.length || record.plan_artifact_id !== ledger.plan_ref.artifact_id || record.content_sha256 !== ledger.plan_ref.content_sha256
    || record.run_id !== ledger.run_id || record.session_id !== ledger.session_id || !Number.isSafeInteger(record.plan_generation) || record.plan_generation < 1
    || record.status !== 'AUTHORIZED' || !isTimestamp(record.validated_at) || Date.parse(record.validated_at) > Date.parse(ledger.created_at)) {
    fail('VALIDATED_PLAN_BINDING_MISMATCH', '$options.planIndex.plan', 'validated plan does not match ledger identity, status, or time');
  }
  resolveAuthority(record.validated_by_authority_ref, options, { purpose: 'validated_plan_authorization', runId: ledger.run_id, subjectId: ledger.run_id, generation: record.plan_generation, observedAt: record.validated_at }, '$options.planIndex.plan.validated_by_authority_ref', 'root');
  return { planRef: { artifact_id: record.plan_artifact_id, content_sha256: record.content_sha256 }, planGeneration: record.plan_generation };
}
function validateResourceSeals(ledger, options) {
  if (!(options.resourceIndex instanceof Map) && !isPlainObject(options.resourceIndex)) fail('RESOURCE_INDEX_REQUIRED', '$options.resourceIndex', 'independent sealed resource index is required');
  const index = asIndex(options.resourceIndex);
  const snapshotIds = new Set();
  for (let position = 0; position < ledger.resources.length; position += 1) {
    const resourceId = ledger.resources[position] && ledger.resources[position].resource_id;
    if (!isNonEmptyString(resourceId)) fail('RESOURCE_DECLARATION_INVALID', `$.resources[${position}].resource_id`, 'resource ID is required');
    if (snapshotIds.has(resourceId)) fail('RESOURCE_ID_DUPLICATE', `$.resources[${position}].resource_id`, 'resource snapshot ID is duplicated');
    snapshotIds.add(resourceId);
  }
  const eventIds = new Set(ledger.resource_events.map((event) => event && event.resource_id).filter(isNonEmptyString));
  for (const key of index.keys()) if (!snapshotIds.has(key) || !eventIds.has(key)) fail('RESOURCE_INDEX_ORPHANED', '$options.resourceIndex', 'resource index contains an orphaned seal');
  const declarations = [];
  for (const resourceId of snapshotIds) {
    const record = index.get(resourceId);
    if (!record) fail('RESOURCE_SEAL_MISSING', '$options.resourceIndex', 'resource seal is missing');
    const recordPath = `$options.resourceIndex.${resourceId}`;
    exactRecordKeys(record, RESOURCE_SEAL_KEYS, recordPath, 'RESOURCE_SEAL_MISSING');
    if (record.resource_id !== resourceId || !isPlainObject(record.launch_card) || record.launch_card.resource_id !== resourceId) fail('RESOURCE_INDEX_KEY_MISMATCH', recordPath, 'resource index key does not match seal or launch card');
    verifySourceHash(record, recordPath, 'RESOURCE_SEAL_HASH_MISMATCH');
    stringArray(record.evidence_refs, `${recordPath}.evidence_refs`);
    if (!record.evidence_refs.length || record.run_id !== ledger.run_id) fail('RESOURCE_RUN_BINDING_MISMATCH', recordPath, 'resource seal run does not match ledger');
    if (!samePlanRef(record.plan_ref, ledger.plan_ref)) fail('RESOURCE_PLAN_BINDING_MISMATCH', recordPath, 'resource seal plan does not match ledger');
    validateResourceDeclaration(record.launch_card, `${recordPath}.launch_card`);
    if (record.launch_card.state !== 'DECLARED' || record.launch_card.last_verified_at !== null) fail('RESOURCE_SEAL_MISSING', `${recordPath}.launch_card`, 'sealed launch card must be in initial state');
    const declare = ledger.resource_events.find((event) => event && event.resource_id === resourceId);
    if (!declare || declare.event_kind !== 'DECLARE' || declare.event_id !== record.launch_card.created_by_event) fail('RESOURCE_CREATION_EVENT_MISMATCH', recordPath, 'launch card must bind the first DECLARE event');
    if (!isTimestamp(record.sealed_at) || Date.parse(record.sealed_at) > Date.parse(declare.observed_at)) fail('RESOURCE_SEALED_AFTER_DECLARE', `${recordPath}.sealed_at`, 'launch card must be sealed before DECLARE');
    resolveAuthority(record.sealed_by_authority_ref, options, { purpose: 'resource_seal_authorization', runId: ledger.run_id, subjectId: resourceId, generation: record.launch_card.lease_generation, observedAt: record.sealed_at }, `${recordPath}.sealed_by_authority_ref`, 'root');
    declarations.push(snapshot(record.launch_card));
  }
  return declarations;
}
function validateResourceLedger(ledger, options = {}) {
  const result = { valid: false, schema: 'ResourceLedger1', errors: [], warnings: [] };
  try {
    if (!isPlainObject(ledger)) fail('LEDGER_SHAPE_INVALID', '$', 'resource ledger must be an object');
    const keys = new Set(['schema', 'schema_version', 'artifact_id', 'run_id', 'session_id', 'created_at', 'producer', 'redaction', 'plan_ref', 'run_events', 'child_events', 'resource_events', 'resources', 'content_sha256']);
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(ledger, key)) fail('LEDGER_FIELD_MISSING', `$.${key}`, 'resource ledger field is required');
    for (const key of Object.keys(ledger)) if (!keys.has(key)) fail('LEDGER_ADDITIONAL_PROPERTY', `$.${key}`, 'resource ledger contains an unsupported property');
    if (ledger.schema !== 'ResourceLedger1' || ledger.schema_version !== 1) fail('LEDGER_SCHEMA_INVALID', '$.schema', 'unsupported resource ledger schema');
    for (const field of ['artifact_id', 'run_id', 'session_id']) if (!isNonEmptyString(ledger[field])) fail('LEDGER_IDENTITY_INVALID', `$.${field}`, 'ledger identifier is invalid');
    if (!isTimestamp(ledger.created_at)
      || !isPlainObject(ledger.producer) || Object.keys(ledger.producer).length !== 2
      || !Object.prototype.hasOwnProperty.call(ledger.producer, 'role') || !Object.prototype.hasOwnProperty.call(ledger.producer, 'adapter_id')
      || !['root', 'child', 'adapter'].includes(ledger.producer.role) || !isNonEmptyString(ledger.producer.adapter_id)
      || !isPlainObject(ledger.redaction) || Object.keys(ledger.redaction).length !== 1
      || !Object.prototype.hasOwnProperty.call(ledger.redaction, 'policy')
      || !['metadata_only', 'hashed_identifiers', 'approved_excerpt'].includes(ledger.redaction.policy)
      || !isPlainObject(ledger.plan_ref)) fail('LEDGER_ENVELOPE_INVALID', '$', 'ledger envelope is invalid');
    if (Object.keys(ledger.plan_ref).length !== 2
      || !Object.prototype.hasOwnProperty.call(ledger.plan_ref, 'artifact_id') || !Object.prototype.hasOwnProperty.call(ledger.plan_ref, 'content_sha256')
      || !isNonEmptyString(ledger.plan_ref.artifact_id) || !SHA256_HEX.test(ledger.plan_ref.content_sha256 || '')) fail('LEDGER_PLAN_REF_INVALID', '$.plan_ref', 'ledger plan reference is invalid');
    if (!SHA256_HEX.test(ledger.content_sha256 || '') || computeDetachedContentSha256(ledger) !== ledger.content_sha256) fail('CONTENT_HASH_MISMATCH', '$.content_sha256', 'ledger content hash does not match');
    for (const field of ['run_events', 'child_events', 'resource_events', 'resources']) if (!Array.isArray(ledger[field]) || ledger[field].length > (field === 'resources' ? 256 : MAX_EVENTS)) fail('EVENT_LIMIT_EXCEEDED', `$.${field}`, 'ledger collection is invalid or exceeds its limit');
    if (ledger.run_events.length === 0) fail('RUN_EVENT_STREAM_REQUIRED', '$.run_events', 'ledger must contain one canonical run stream');
    assertLifecyclePartition(ledger.run_events, 'run', '$.run_events');
    assertLifecyclePartition(ledger.child_events, 'child', '$.child_events');
    const eventIds = new Set();
    for (const [field, events] of [['run_events', ledger.run_events], ['child_events', ledger.child_events], ['resource_events', ledger.resource_events]]) {
      for (let index = 0; index < events.length; index += 1) {
        const eventId = events[index] && events[index].event_id;
        if (!isNonEmptyString(eventId)) fail('EVENT_IDENTITY_INVALID', `$.${field}[${index}].event_id`, 'event ID is required');
        if (eventIds.has(eventId)) fail('EVENT_ID_DUPLICATE', `$.${field}[${index}].event_id`, 'event IDs share one global namespace');
        eventIds.add(eventId);
      }
    }
    const validatedPlan = validatePlanBinding(ledger, { ...options, runId: ledger.run_id });
    const boundOptions = { ...options, runId: ledger.run_id, planRef: snapshot(ledger.plan_ref), validatedPlanRef: snapshot(validatedPlan.planRef), planGeneration: validatedPlan.planGeneration };
    const declarations = validateResourceSeals(ledger, boundOptions);
    const runSnapshots = reduceLifecycleEvents(ledger.run_events, boundOptions);
    const childSnapshots = reduceLifecycleEvents(ledger.child_events, boundOptions);
    const resourceSnapshots = reduceResourceEvents(ledger.resource_events, declarations, boundOptions);
    if (resourceSnapshots.length !== ledger.resources.length) result.errors.push(validationError('RESOURCE_SNAPSHOT_MISMATCH', '$.resources', 'resource snapshot count differs from deterministic reduction'));
    const submittedById = new Map(ledger.resources.map((entry) => [entry.resource_id, entry]));
    for (const reduced of resourceSnapshots) if (!sameSnapshot(reduced, submittedById.get(reduced.resource_id))) result.errors.push(validationError('RESOURCE_SNAPSHOT_MISMATCH', `$.resources.${reduced.resource_id}`, 'resource snapshot differs from deterministic reduction'));
    if (runSnapshots.length !== 1 || runSnapshots[0].subject_id !== ledger.run_id) result.errors.push(validationError('RUN_ID_BINDING_MISMATCH', '$.run_events', 'ledger run stream must reduce to exactly its run_id'));
    const terminalRun = runSnapshots.find((entry) => ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED'].includes(entry.state));
    if (terminalRun && ledger.resources.some((entry) => entry.state !== 'RECLAIMED' && !(entry.type === 'artifact' && entry.state === 'RETAINED'))) {
      const code = terminalRun.state === 'COMPLETE' ? 'RUN_COMPLETE_WITH_UNRECLAIMED_RESOURCE' : 'RUN_TERMINAL_WITH_UNRECLAIMED_RESOURCE';
      result.errors.push(validationError(code, '$.resources', `${terminalRun.state} run requires every resource to be reclaimed or an authorized retained artifact`));
    }
    if (terminalRun && childSnapshots.some((entry) => entry.state !== 'CLOSED')) {
      const code = terminalRun.state === 'COMPLETE' ? 'RUN_COMPLETE_WITH_OPEN_CHILD' : 'RUN_TERMINAL_WITH_OPEN_CHILD';
      result.errors.push(validationError(code, '$.child_events', `${terminalRun.state} run requires every child to be CLOSED`));
    }
    result.valid = result.errors.length === 0;
  } catch (caught) {
    result.errors.push(caught instanceof StateMachineError ? caught : validationError('LEDGER_VALIDATION_REJECTED', '$', 'resource ledger validation rejected input'));
  }
  return result;
}

module.exports = {
  RUN_EDGES, CHILD_EDGES, RESOURCE_EDGES, RUN_STATES, CHILD_STATES, RESOURCE_STATES,
  RESOURCE_EVENT_KINDS, IDENTITY_RESULTS, RESOURCE_TYPES, StateMachineError,
  canTransition, reduceLifecycleEvents, reduceResourceEvents, compareProcessIdentity,
  validateProcessIdentity, validateResourceLedger,
};
