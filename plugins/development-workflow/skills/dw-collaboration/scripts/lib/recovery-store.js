'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { validateRecoveryRecord2, validateSupportMatrix2 } = require('./identity-support-v2');
const {
  canonicalizeDetachedSnapshot,
  computeDetachedContentSha256,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');

const ENVELOPE_SCHEMA = 'RecoveryStorePending1';
const ENVELOPE_VERSION = 1;
const LEASE_SCHEMA = 'RecoveryStoreLease1';
const LEASE_FILENAME = 'writer-lease.json';
const REVISION_PATTERN = /^pending-revision-([1-9]\d*)\.json$/;
const MAX_LEASE_BYTES = 4096;
const DEFAULT_LIMITS = Object.freeze({
  maxRecords: 128,
  maxItemBytes: 32768,
  maxTotalBytes: 1024 * 1024,
  maxRevisionScan: 256,
});

class RecoveryStoreError extends Error {
  constructor(code = 'RECOVERY_STORE_HOLD') {
    super(code);
    this.name = 'RecoveryStoreError';
    this.code = code;
  }
}

function hold() {
  return new RecoveryStoreError();
}

class RevalidationMismatchError extends Error {}

class RevalidationObservationError extends Error {}

function revalidationMismatch() {
  return new RevalidationMismatchError();
}

function revalidationObservation() {
  return new RevalidationObservationError();
}

function freeze(value) {
  return Object.freeze(value);
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function strictDescendant(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fileIdentity(stat) {
  return freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

function sameFileIdentity(left, right) {
  return left !== null && right !== null && left.device === right.device && left.inode === right.inode;
}

function normalizeLimits(limits) {
  if (limits !== undefined && !isPlainObject(limits)) throw hold();
  const source = limits || {};
  if (Object.keys(source).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw hold();
  const normalized = {
    maxRecords: Object.hasOwn(source, 'maxRecords') ? source.maxRecords : DEFAULT_LIMITS.maxRecords,
    maxItemBytes: Object.hasOwn(source, 'maxItemBytes') ? source.maxItemBytes : DEFAULT_LIMITS.maxItemBytes,
    maxTotalBytes: Object.hasOwn(source, 'maxTotalBytes') ? source.maxTotalBytes : DEFAULT_LIMITS.maxTotalBytes,
    maxRevisionScan: Object.hasOwn(source, 'maxRevisionScan') ? source.maxRevisionScan : DEFAULT_LIMITS.maxRevisionScan,
  };
  if (Object.values(normalized).some((value) => !validLimit(value))) throw hold();
  return freeze(normalized);
}

function ensureChildDirectory(canonicalRoot, parent, name) {
  const target = path.join(parent, name);
  if (!strictDescendant(parent, target)) throw hold();
  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw hold();
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw hold();
  const realTarget = fs.realpathSync(target);
  if (!strictDescendant(canonicalRoot, realTarget) || !strictDescendant(parent, realTarget)) throw hold();
  return realTarget;
}

function openDataRoot(dataRoot, runId) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || !isSafeIdentifier(runId)) throw hold();
  const normalized = path.normalize(dataRoot);
  if (normalized !== dataRoot || normalized === path.parse(normalized).root) throw hold();
  try {
    if (fs.existsSync(normalized)) {
      const existing = fs.lstatSync(normalized);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw hold();
    } else {
      fs.mkdirSync(normalized, { recursive: true });
    }
    const root = fs.realpathSync(normalized);
    if (!samePath(root, normalized) || !fs.lstatSync(root).isDirectory()) throw hold();
    const namespace = ensureChildDirectory(root, root, 'development-workflow');
    const recovery = ensureChildDirectory(root, namespace, 'recovery');
    return ensureChildDirectory(root, recovery, runId);
  } catch (error) {
    if (error instanceof RecoveryStoreError) throw error;
    throw hold();
  }
}

function detachedSnapshot(value) {
  try {
    return createDetachedJsonSnapshot(value).snapshot;
  } catch (_) {
    throw hold();
  }
}

function validateRecordSet(records, limits, runId) {
  if (!Array.isArray(records) || records.length > limits.maxRecords) throw hold();
  let totalBytes = 0;
  for (const record of records) {
    if (record.run_id !== runId) throw hold();
    const validation = validateRecoveryRecord2(record);
    if (!validation.valid) throw hold();
    let bytes;
    try {
      bytes = Buffer.byteLength(canonicalizeDetachedSnapshot(record), 'utf8');
    } catch (_) {
      throw hold();
    }
    if (bytes > limits.maxItemBytes) throw hold();
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw hold();
  }
}

function envelopeSnapshot(envelope, limits, runId) {
  if (!exactKeys(envelope, ['schema', 'schema_version', 'run_id', 'revision', 'records', 'content_sha256'])
    || envelope.schema !== ENVELOPE_SCHEMA || envelope.schema_version !== ENVELOPE_VERSION
    || envelope.run_id !== runId || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
    || typeof envelope.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.content_sha256)) throw hold();
  validateRecordSet(envelope.records, limits, runId);
  try {
    if (computeDetachedContentSha256(envelope) !== envelope.content_sha256) throw hold();
  } catch (_) {
    throw hold();
  }
  return envelope;
}

const TRANSACTION_SCHEMA = 'RecoveryStoreTransaction2';
const BOOTSTRAP_SCHEMA = 'TaskResourceManagerBootstrap2';
const SHA256 = /^[0-9a-f]{64}$/;
const MANAGER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// 3-6B runtime chain. A separately named discriminator so the accepted Bootstrap2/3
// semantics and every V1 reader stay untouched: an existing bootstrap-headed run
// directory is never appended by this chain (continuity holds schema equal).
const RUNTIME_SCHEMA = 'TaskResourceManagerRuntime1';
const RUNTIME_VERSION = 1;
const RUNTIME_COMMAND_KEYS = ['commandId', 'scopeId', 'resourceIds', 'timeoutMs', 'state', 'actionOrdinals'];
const RUNTIME_ACTION_KEYS = ['sequence', 'commandId', 'method', 'requestSha256', 'nonce',
  'resourceIds', 'predecessor', 'intent', 'outcome'];
// The ten adapter entry points the manager dispatches, reached from eleven call
// sites (the stop path observes twice). Enumerated by the u9 contract §2.1.
const RUNTIME_METHODS = ['allocateTemporaryRoot', 'spawnManaged', 'observeProcess',
  'requestGracefulStop', 'terminateOwnedTree', 'verifyProcessAbsent',
  'observeTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot',
  'verifyTemporaryAbsent'];
const RUNTIME_CLOSE_KEYS = ['admission', 'phase', 'reason', 'trackerClose'];
// Scope and resource identifiers are DERIVED from the command id (for example
// `command:<id>:process-tree`), so they are legitimately longer than the id bound
// the manager applies to the command itself. Bounding them by the derivation's own
// size keeps the Store from rejecting identifiers the product can really produce.
const RUNTIME_DERIVED_ID = new RegExp('^[^\\u0000-\\u001F]{1,256}$');
const RUNTIME_KEYS = ['schema', 'schema_version', 'originalProvenance', 'originalAuthorization',
  'originalCapabilityEnvelope', 'commands', 'actions', 'records', 'trackerHistory',
  'failureLoopState', 'close'];

function sameCanonical(left, right) {
  return canonicalizeDetachedSnapshot(left) === canonicalizeDetachedSnapshot(right);
}

function validateDigest(value, field) {
  if (typeof value[field] !== 'string' || !SHA256.test(value[field])) throw hold();
  const base = { ...value };
  delete base[field];
  if (computeDetachedSha256(base) !== value[field]) throw hold();
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === match[1] + '.' + (match[2] || '').padEnd(3, '0').slice(0, 3) + 'Z';
}

function validateBootstrapHistory(history, provenance, authority, limits, requiredReferences = null) {
  if (!Array.isArray(history) || history.length === 0) throw hold();
  const commands = new Map();
  let previousHash = null;
  let resources = 0;
  for (const [index, event] of history.entries()) {
    if (!exactKeys(event, ['sequence', 'kind', 'ownerId', 'runId', 'generation',
      'previousEventSha256', 'payload', 'eventSha256'])
      || event.sequence !== index + 1 || event.ownerId !== provenance.ownerId
      || event.runId !== provenance.runId || event.generation !== provenance.managerGeneration
      || event.previousEventSha256 !== previousHash
      || Buffer.byteLength(canonicalizeDetachedSnapshot(event), 'utf8') > limits.maxItemBytes) throw hold();
    validateDigest(event, 'eventSha256');
    previousHash = event.eventSha256;
    const payload = event.payload;
    if (event.kind === 'SCOPE_OPENED') {
      if (!exactKeys(payload, ['scopeId', 'ownerId', 'parentScopeId', 'purpose'])
        || payload.ownerId !== provenance.ownerId) throw hold();
      if (index === 0) {
        if (payload.scopeId !== provenance.managerRunId || payload.parentScopeId !== null
          || payload.purpose !== 'task_resource_manager') throw hold();
      } else {
        const command = typeof payload.scopeId === 'string'
          ? /^command:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(payload.scopeId) : null;
        if (!command || payload.parentScopeId !== provenance.managerRunId
          || payload.purpose !== 'managed_command' || payload.scopeId === provenance.managerRunId
          || commands.has(payload.scopeId)) throw hold();
        commands.set(payload.scopeId, { temporary: null, session: null, processTree: null });
      }
    } else if (event.kind === 'RESOURCE_REGISTERED' && index > 0) {
      if (!exactKeys(payload, ['scopeId', 'declaration']) || !commands.has(payload.scopeId)) throw hold();
      const declaration = payload.declaration;
      if (!exactKeys(declaration, ['resourceId', 'type', 'purpose', 'teardownCondition',
        'quota', 'evidenceRefs', 'parentResourceId'])) throw hold();
      const refs = declaration.evidenceRefs;
      if (!Array.isArray(refs) || refs.length === 0
        || !refs.includes(authority.cleanupAuthorityRef)
        || !refs.some((ref) => typeof ref === 'string' && ref.startsWith('evidence:'))
        || refs.some((ref, position) => typeof ref !== 'string'
          || !/^(authority|evidence):[0-9a-f]{64}$/.test(ref)
          || (position > 0 && refs[position - 1] >= ref))) throw hold();
      if (requiredReferences !== null && !sameCanonical(refs, requiredReferences)) throw hold();
      resources += 1;
      if (resources > limits.maxRecords) throw hold();
      const command = commands.get(payload.scopeId);
      if (declaration.type === 'temporary_allocation') {
        if (command.temporary || command.session || command.processTree
          || declaration.resourceId !== payload.scopeId + ':temporary'
          || declaration.purpose !== 'task_temporary_directory'
          || declaration.teardownCondition !== 'allocation_absence_verified'
          || declaration.quota !== null || declaration.parentResourceId !== null) throw hold();
        command.temporary = declaration;
      } else {
        if (!exactKeys(declaration.quota, ['timeoutMs']) || !validLimit(declaration.quota.timeoutMs)
          || declaration.teardownCondition !== 'identity_absence_verified') throw hold();
        if (declaration.type === 'command_session') {
          if (command.session || command.processTree
            || declaration.resourceId !== payload.scopeId + ':session'
            || declaration.purpose !== 'managed_command_session'
            || declaration.parentResourceId !== (command.temporary ? command.temporary.resourceId : null)) throw hold();
          command.session = declaration;
        } else if (declaration.type === 'process_tree') {
          if (!command.session || command.processTree
            || declaration.resourceId !== payload.scopeId + ':process-tree'
            || declaration.purpose !== 'managed_command_process_tree'
            || declaration.parentResourceId !== command.session.resourceId
            || declaration.quota.timeoutMs !== command.session.quota.timeoutMs) throw hold();
          command.processTree = declaration;
        } else throw hold();
      }
    } else throw hold();
  }
}

function validateBootstrap(transaction, limits, runId) {
  const isV3 = transaction.schema === 'TaskResourceManagerBootstrap3' && transaction.schema_version === 3;
  const keys = ['schema', 'schema_version', 'originalProvenance',
    'originalAuthorization', 'trackerHistory', 'failureLoopState', 'records'];
  if (isV3) keys.push('originalCapabilityEnvelope');
  if (!exactKeys(transaction, keys)
    || (!isV3 && (transaction.schema !== BOOTSTRAP_SCHEMA || transaction.schema_version !== 2))
    || !Array.isArray(transaction.records) || transaction.records.length !== 0) throw hold();
  const provenance = transaction.originalProvenance;
  const authority = transaction.originalAuthorization;
  if (!exactKeys(provenance, ['type', 'runId', 'harnessId', 'producerId', 'ownerId', 'sessionId',
    'managerRunId', 'managerGeneration', 'adapterId', 'adapterGeneration', 'platform',
    'observedAt', 'authorizationSha256'])
    || provenance.type !== 'TaskResourceProvenance1' || provenance.runId !== runId
    || !['windows', 'linux'].includes(provenance.platform)
    || !validUtcTimestamp(provenance.observedAt)
    || !validLimit(provenance.managerGeneration) || !validLimit(provenance.adapterGeneration)
    || ['harnessId', 'producerId', 'ownerId', 'sessionId', 'managerRunId', 'adapterId']
      .some((key) => typeof provenance[key] !== 'string' || !MANAGER_IDENTIFIER.test(provenance[key]))) throw hold();
  if (!exactKeys(authority, ['type', 'cleanupAuthorityRef', 'allowForceTermination'])
    || authority.type !== 'TaskResourceAuthorization1'
    || typeof authority.cleanupAuthorityRef !== 'string'
    || !/^authority:[0-9a-f]{64}$/.test(authority.cleanupAuthorityRef)
    || typeof authority.allowForceTermination !== 'boolean'
    || provenance.authorizationSha256 !== computeDetachedSha256(authority)) throw hold();
  const guard = transaction.failureLoopState;
  if (!exactKeys(guard, ['schema', 'runId', 'guardId', 'revision', 'previousStateSha256',
    'retryBudget', 'repairBudget', 'retryUsed', 'repairUsed', 'activeFingerprint',
    'operationBindings', 'consumedExitFamilies', 'failures', 'stateSha256'])
    || guard.schema !== 'FailureLoopGuardState3' || guard.runId !== runId
    || guard.guardId !== 'manager:' + provenance.managerRunId + ':failure-loop'
    || guard.revision !== 1 || guard.previousStateSha256 !== null
    || !Number.isSafeInteger(guard.retryBudget) || guard.retryBudget < 0
    || !Number.isSafeInteger(guard.repairBudget) || guard.repairBudget < 0
    || guard.retryUsed !== 0 || guard.repairUsed !== 0 || guard.activeFingerprint !== null
    || ['operationBindings', 'consumedExitFamilies', 'failures']
      .some((key) => !Array.isArray(guard[key]) || guard[key].length !== 0)) throw hold();
  validateDigest(guard, 'stateSha256');
  for (const item of [provenance, authority, guard]) {
    if (Buffer.byteLength(canonicalizeDetachedSnapshot(item), 'utf8') > limits.maxItemBytes) throw hold();
  }
  let requiredReferences = null;
  if (isV3) {
    const envelope = transaction.originalCapabilityEnvelope;
    if (!exactKeys(envelope, ['type', 'provenance', 'supportMatrix'])
      || envelope.type !== 'TaskResourceCapabilityEnvelope1'
      || !sameCanonical(envelope.provenance, provenance)
      || !validateSupportMatrix2(envelope.supportMatrix).valid
      || envelope.supportMatrix.adapter_id !== provenance.adapterId
      || envelope.supportMatrix.platform !== provenance.platform
      || envelope.supportMatrix.observed_at !== provenance.observedAt
      || Buffer.byteLength(canonicalizeDetachedSnapshot(envelope), 'utf8') > limits.maxItemBytes) throw hold();
    // Reproduce the manager's union of every claim, including degraded claims.
    requiredReferences = [...new Set([authority.cleanupAuthorityRef,
      ...Object.values(envelope.supportMatrix.claims).flatMap(claim => claim.evidence_refs)])].sort();
  }
  validateBootstrapHistory(transaction.trackerHistory, provenance, authority, limits, requiredReferences);
}

function validateBootstrapContinuity(previous, next) {
  if (previous === null) return;
  if (previous.schema !== next.schema || previous.schema_version !== next.schema_version) throw hold();
  const keys = ['originalProvenance', 'originalAuthorization', 'failureLoopState'];
  if (next.schema_version === 3) keys.push('originalCapabilityEnvelope');
  for (const key of keys) {
    if (!sameCanonical(previous[key], next[key])) throw hold();
  }
  if (previous.trackerHistory.length > next.trackerHistory.length
    || previous.trackerHistory.some((event, index) => !sameCanonical(event, next.trackerHistory[index]))) throw hold();
}

// --- 3-6B runtime chain -------------------------------------------------------
// The provenance/authority/envelope checks below are intentionally duplicated from
// validateBootstrap rather than extracted from it: the accepted Bootstrap2/3 path
// and every V1 reader must stay byte-for-byte unchanged, and duplication is the
// only way to add a second discriminator without editing that path.
const RUNTIME_TRACKER_EVENT_KEYS = ['sequence', 'kind', 'ownerId', 'runId', 'generation',
  'previousEventSha256', 'payload', 'eventSha256'];
const RESOURCE_ID_KEYS = ['commandSession', 'processTree', 'temporaryAllocation'];

function validateRuntimeResourceIds(value) {
  if (!exactKeys(value, RESOURCE_ID_KEYS)) throw hold();
  for (const key of RESOURCE_ID_KEYS) {
    const entry = value[key];
    if (entry !== null && (typeof entry !== 'string' || !RUNTIME_DERIVED_ID.test(entry))) throw hold();
  }
}

function validateRuntimeHistory(history, provenance, limits) {
  if (!Array.isArray(history)) throw hold();
  let previous = null;
  let position = 0;
  for (const event of history) {
    position += 1;
    if (!exactKeys(event, RUNTIME_TRACKER_EVENT_KEYS)
      // The array must be the complete real exportHistory(): no projected, filtered
      // or reordered events, so the sequence has to match its own position.
      || event.sequence !== position
      || !Number.isSafeInteger(event.sequence) || event.sequence < 1
      || typeof event.kind !== 'string' || event.kind.length === 0
      || event.ownerId !== provenance.ownerId || event.runId !== provenance.runId
      || event.generation !== provenance.managerGeneration
      || event.previousEventSha256 !== previous
      || !SHA256.test(event.eventSha256 || '')
      || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw hold();
    // Recompute exactly the way the tracker does: over the seven named fields.
    // Recomputing the digest is content binding; it is never producer provenance.
    const expected = computeDetachedSha256({
      sequence: event.sequence,
      kind: event.kind,
      ownerId: event.ownerId,
      runId: event.runId,
      generation: event.generation,
      previousEventSha256: event.previousEventSha256,
      payload: event.payload,
    });
    if (event.eventSha256 !== expected) throw hold();
    previous = event.eventSha256;
  }
  if (Buffer.byteLength(canonicalizeDetachedSnapshot(history), 'utf8') > limits.maxTotalBytes) throw hold();
}

function validateRuntimeGuard(guard, runId, provenance) {
  if (!exactKeys(guard, ['schema', 'runId', 'guardId', 'revision', 'previousStateSha256',
    'retryBudget', 'repairBudget', 'retryUsed', 'repairUsed', 'activeFingerprint',
    'operationBindings', 'consumedExitFamilies', 'failures', 'stateSha256'])
    || guard.schema !== 'FailureLoopGuardState3' || guard.runId !== runId
    || guard.guardId !== 'manager:' + provenance.managerRunId + ':failure-loop'
    || !Number.isSafeInteger(guard.revision) || guard.revision < 1
    || !Number.isSafeInteger(guard.retryBudget) || guard.retryBudget < 0
    || !Number.isSafeInteger(guard.repairBudget) || guard.repairBudget < 0
    || !Number.isSafeInteger(guard.retryUsed) || guard.retryUsed < 0 || guard.retryUsed > guard.retryBudget
    || !Number.isSafeInteger(guard.repairUsed) || guard.repairUsed < 0 || guard.repairUsed > guard.repairBudget
    || !Array.isArray(guard.operationBindings) || !Array.isArray(guard.consumedExitFamilies)
    || !Array.isArray(guard.failures)) throw hold();
  if (guard.revision === 1 && guard.previousStateSha256 !== null) throw hold();
  if (guard.revision > 1 && !SHA256.test(guard.previousStateSha256 || '')) throw hold();
  validateDigest(guard, 'stateSha256');
}

function validateRuntime(transaction, limits, runId) {
  if (transaction.schema !== RUNTIME_SCHEMA || transaction.schema_version !== RUNTIME_VERSION
    || !exactKeys(transaction, RUNTIME_KEYS)) throw hold();
  if (!Array.isArray(transaction.commands) || !Array.isArray(transaction.actions)
    || !Array.isArray(transaction.records)) throw hold();
  // Records are now admitted on the runtime chain (u9 §2.5 F6): each must be a
  // real, bound RecoveryRecord2 for this run. The bootstrap chain keeps its own
  // `records.length !== 0` refusal untouched.
  for (const record of transaction.records) {
    if (!record || typeof record !== 'object' || record.run_id !== runId
      || !validateRecoveryRecord2(record).valid) throw hold();
    if (Buffer.byteLength(canonicalizeDetachedSnapshot(record), 'utf8') > limits.maxItemBytes) throw hold();
  }
  if (transaction.records.length > limits.maxRecords) throw hold();
  const provenance = transaction.originalProvenance;
  const authority = transaction.originalAuthorization;
  if (!exactKeys(provenance, ['type', 'runId', 'harnessId', 'producerId', 'ownerId', 'sessionId',
    'managerRunId', 'managerGeneration', 'adapterId', 'adapterGeneration', 'platform',
    'observedAt', 'authorizationSha256'])
    || provenance.type !== 'TaskResourceProvenance1' || provenance.runId !== runId
    || !['windows', 'linux'].includes(provenance.platform)
    || !validUtcTimestamp(provenance.observedAt)
    || !validLimit(provenance.managerGeneration) || !validLimit(provenance.adapterGeneration)
    || ['harnessId', 'producerId', 'ownerId', 'sessionId', 'managerRunId', 'adapterId']
      .some((key) => typeof provenance[key] !== 'string' || !MANAGER_IDENTIFIER.test(provenance[key]))) throw hold();
  if (!exactKeys(authority, ['type', 'cleanupAuthorityRef', 'allowForceTermination'])
    || authority.type !== 'TaskResourceAuthorization1'
    || typeof authority.cleanupAuthorityRef !== 'string'
    || !/^authority:[0-9a-f]{64}$/.test(authority.cleanupAuthorityRef)
    || typeof authority.allowForceTermination !== 'boolean'
    || provenance.authorizationSha256 !== computeDetachedSha256(authority)) throw hold();
  const envelope = transaction.originalCapabilityEnvelope;
  if (!exactKeys(envelope, ['type', 'provenance', 'supportMatrix'])
    || envelope.type !== 'TaskResourceCapabilityEnvelope1'
    || !sameCanonical(envelope.provenance, provenance)
    || !validateSupportMatrix2(envelope.supportMatrix).valid
    || envelope.supportMatrix.adapter_id !== provenance.adapterId
    || envelope.supportMatrix.platform !== provenance.platform
    || envelope.supportMatrix.observed_at !== provenance.observedAt) throw hold();
  for (const command of transaction.commands) {
    if (!exactKeys(command, RUNTIME_COMMAND_KEYS)
      || typeof command.commandId !== 'string' || !RUNTIME_DERIVED_ID.test(command.commandId)
      || typeof command.scopeId !== 'string' || !RUNTIME_DERIVED_ID.test(command.scopeId)
      || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1
      || !['OPEN', 'CLOSED'].includes(command.state)) throw hold();
    validateRuntimeResourceIds(command.resourceIds);
    if (!Array.isArray(command.actionOrdinals)
      || command.actionOrdinals.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) throw hold();
  }
  let expected = 1;
  for (const action of transaction.actions) {
    if (!exactKeys(action, RUNTIME_ACTION_KEYS)
      || action.sequence !== expected
      || typeof action.commandId !== 'string' || !RUNTIME_DERIVED_ID.test(action.commandId)
      || !RUNTIME_METHODS.includes(action.method)
      || !SHA256.test(action.requestSha256 || '')
      || (action.nonce !== null && (typeof action.nonce !== 'string' || !RUNTIME_DERIVED_ID.test(action.nonce)))
      || (action.predecessor !== null && (!Number.isSafeInteger(action.predecessor)
        || action.predecessor < 1 || action.predecessor >= expected))) throw hold();
    // An action must belong to a recorded command, and a declared dependency must
    // already be settled: an unresolved action blocks the successors that depend on
    // it, while leaving unrelated later work free to proceed.
    if (!transaction.commands.some((command) => command.commandId === action.commandId)) throw hold();
    if (action.predecessor !== null) {
      const dependency = transaction.actions[action.predecessor - 1];
      if (!dependency || dependency.outcome === null || dependency.outcome.status === 'UNCERTAIN') throw hold();
    }
    validateRuntimeResourceIds(action.resourceIds);
    if (!exactKeys(action.intent, ['type', 'phase']) || action.intent.type !== action.method
      || typeof action.intent.phase !== 'string' || action.intent.phase.length === 0) throw hold();
    if (action.outcome !== null) {
      if (!exactKeys(action.outcome, ['status', 'identitySha256'])
        || !['CONFIRMED', 'REJECTED', 'UNCERTAIN'].includes(action.outcome.status)
        || (action.outcome.identitySha256 !== null && !SHA256.test(action.outcome.identitySha256))) throw hold();
    }
    expected += 1;
  }
  // N3: commands and actions must agree in BOTH directions. A command may not list
  // an ordinal no action carries, and every action's ordinal must be listed by the
  // command it belongs to — so a hand-edited head cannot claim work it does not own
  // or hide work it does.
  for (const command of transaction.commands) {
    const owned = transaction.actions
      .filter((action) => action.commandId === command.commandId)
      .map((action) => action.sequence);
    if (command.actionOrdinals.length !== owned.length
      || command.actionOrdinals.some((value, index) => value !== owned[index])) throw hold();
  }
  validateRuntimeHistory(transaction.trackerHistory, provenance, limits);
  validateRuntimeGuard(transaction.failureLoopState, runId, provenance);
  if (!exactKeys(transaction.close, RUNTIME_CLOSE_KEYS)
    || typeof transaction.close.admission !== 'boolean'
    || !['OPEN', 'CLOSING', 'CLOSED', 'HOLD'].includes(transaction.close.phase)
    || (transaction.close.reason !== null
      && (typeof transaction.close.reason !== 'string' || transaction.close.reason.length === 0))
    || !['NONE', 'VERIFIED', 'PENDING'].includes(transaction.close.trackerClose)) throw hold();
  for (const item of [provenance, authority, envelope, transaction.failureLoopState]) {
    if (Buffer.byteLength(canonicalizeDetachedSnapshot(item), 'utf8') > limits.maxItemBytes) throw hold();
  }
}

function canonicalPrefix(earlier, later) {
  return Array.isArray(later) && later.length >= earlier.length
    && earlier.every((entry, index) => sameCanonical(entry, later[index]));
}

function canonicalSuperset(later, earlier) {
  return Array.isArray(later) && earlier.every((entry) => later.includes(entry));
}

// Guard invariants that u8 registered as unimplemented (`review.md` §12.3 F3).
// The Guard enforces the same rules in memory, but re-deriving them from the
// durable pair is the point of this function: a Store that only re-validated its
// own input could not tell a genuine Guard successor from a rewritten one that
// happens to keep the revision arithmetic intact. Only fields whose Guard-side
// mutation is provably monotone are constrained here.
function validateRuntimeGuardHistory(before, after) {
  // A consumed exit family is never released, and a command identity binds once.
  if (!canonicalSuperset(after.consumedExitFamilies, before.consumedExitFamilies)) throw hold();
  const bindings = new Map(after.operationBindings.map((entry) => [entry.observedCommandId, entry]));
  for (const entry of before.operationBindings) {
    const current = bindings.get(entry.observedCommandId);
    if (current === undefined || !sameCanonical(entry, current)) throw hold();
  }
  if (before.failures.length > after.failures.length) throw hold();
  const failures = new Map(after.failures.map((entry) => [entry.fingerprint, entry]));
  for (const previous of before.failures) {
    const next = failures.get(previous.fingerprint);
    // Failures are keyed by content fingerprint, so the serialized order moves as
    // new ones arrive; identity, not position, is what must survive.
    if (next === undefined || next.familyFingerprint !== previous.familyFingerprint
      || next.currentGeneration < previous.currentGeneration
      || !canonicalSuperset(next.evidenceRefs, previous.evidenceRefs)) throw hold();
    if (previous.generations.length > next.generations.length) throw hold();
    const generations = new Map(next.generations.map((entry) => [entry.generation, entry]));
    for (const earlier of previous.generations) {
      const later = generations.get(earlier.generation);
      if (later === undefined || !sameCanonical(later.semantics, earlier.semantics)
        || later.firstOccurredAt !== earlier.firstOccurredAt
        // Records are append-only, and a produced summary or exit decision is
        // never rewritten. The remaining generation fields are monotone flags.
        || !canonicalPrefix(earlier.records, later.records)
        || !canonicalSuperset(later.hypotheses, earlier.hypotheses)
        || !canonicalSuperset(later.evidenceRefs, earlier.evidenceRefs)
        || (earlier.summaryEligible && !later.summaryEligible)
        || (earlier.summaryTrigger !== null && later.summaryTrigger !== earlier.summaryTrigger)
        || (earlier.summary !== null && !sameCanonical(earlier.summary, later.summary))
        || (earlier.exitAttemptConsumed && !later.exitAttemptConsumed)
        || (earlier.exitDecision !== null && !sameCanonical(earlier.exitDecision, later.exitDecision))) throw hold();
    }
  }
}

function validateRuntimeContinuity(previous, next) {
  if (previous === null) return;
  if (previous.schema !== next.schema || previous.schema_version !== next.schema_version) throw hold();
  for (const key of ['originalProvenance', 'originalAuthorization', 'originalCapabilityEnvelope']) {
    if (!sameCanonical(previous[key], next[key])) throw hold();
  }
  if (previous.trackerHistory.length > next.trackerHistory.length
    || previous.trackerHistory.some((entry, index) => !sameCanonical(entry, next.trackerHistory[index]))) throw hold();
  // Records are append-only: an existing bound record is never rewritten or
  // dropped. Compacting them is 3-6D, not this unit.
  if (previous.records.length > next.records.length
    || previous.records.some((entry, index) => !sameCanonical(entry, next.records[index]))) throw hold();
  // Commands are append-only, and an existing command may only gain the ordinals
  // of the actions that were appended after it; every other field is immutable.
  if (previous.commands.length > next.commands.length) throw hold();
  for (let index = 0; index < previous.commands.length; index += 1) {
    const before = previous.commands[index];
    const after = next.commands[index];
    for (const key of RUNTIME_COMMAND_KEYS) {
      if (key === 'actionOrdinals') continue;
      if (!sameCanonical(before[key], after[key])) throw hold();
    }
    if (before.actionOrdinals.length > after.actionOrdinals.length
      || before.actionOrdinals.some((value, cursor) => value !== after.actionOrdinals[cursor])) throw hold();
  }
  // An action's intent is immutable and its identity fields never drift. Only the
  // trailing entry may settle, and a settled outcome is never rewritten.
  if (previous.actions.length > next.actions.length) throw hold();
  for (let index = 0; index < previous.actions.length; index += 1) {
    const before = previous.actions[index];
    const after = next.actions[index];
    if (before.sequence !== after.sequence || before.commandId !== after.commandId
      || before.method !== after.method || before.requestSha256 !== after.requestSha256
      || before.nonce !== after.nonce || before.predecessor !== after.predecessor
      || !sameCanonical(before.intent, after.intent)
      || !sameCanonical(before.resourceIds, after.resourceIds)) throw hold();
    if (sameCanonical(before.outcome, after.outcome)) continue;
    if (index !== previous.actions.length - 1) throw hold();
    if (before.outcome !== null) throw hold();
  }
  if (sameCanonical(previous.failureLoopState, next.failureLoopState)) return;
  const before = previous.failureLoopState;
  const after = next.failureLoopState;
  if (after.revision !== before.revision + 1 || after.previousStateSha256 !== before.stateSha256
    || after.retryBudget !== before.retryBudget || after.repairBudget !== before.repairBudget
    || after.retryUsed < before.retryUsed || after.repairUsed < before.repairUsed) throw hold();
  validateRuntimeGuardHistory(before, after);
}

function validateTransaction(transaction, limits, runId) {
  if (transaction && transaction.schema === RUNTIME_SCHEMA) validateRuntime(transaction, limits, runId);
  else validateBootstrap(transaction, limits, runId);
}

function validateContinuity(previous, next) {
  if (previous && previous.schema === RUNTIME_SCHEMA) validateRuntimeContinuity(previous, next);
  else validateBootstrapContinuity(previous, next);
}

function transactionEnvelopeSnapshot(envelope, limits, runId) {
  if (!exactKeys(envelope, ['schema', 'schema_version', 'run_id', 'revision',
    'previous_content_sha256', 'transaction', 'content_sha256'])
    || envelope.schema !== TRANSACTION_SCHEMA || envelope.schema_version !== 2
    || envelope.run_id !== runId || !validLimit(envelope.revision)
    || (envelope.revision === 1 ? envelope.previous_content_sha256 !== null
      : typeof envelope.previous_content_sha256 !== 'string' || !SHA256.test(envelope.previous_content_sha256))
    || typeof envelope.content_sha256 !== 'string' || !SHA256.test(envelope.content_sha256)) throw hold();
  validateTransaction(envelope.transaction, limits, runId);
  if (computeDetachedContentSha256(envelope) !== envelope.content_sha256) throw hold();
  return envelope;
}

class RecoveryStore {
  static open(options) {
    const input = detachedSnapshot(options);
    if (!exactKeys(input, ['dataRoot', 'runId', 'writerId', 'limits']) && !exactKeys(input, ['dataRoot', 'runId', 'writerId'])) throw hold();
    if (!isSafeIdentifier(input.writerId)) throw hold();
    const limits = normalizeLimits(input.limits);
    const runDirectory = openDataRoot(input.dataRoot, input.runId);
    const store = new RecoveryStore(runDirectory, input.runId, input.writerId, limits);
    store.#acquireLease();
    return store;
  }

  #runDirectory;

  #runRealPath;

  #runIdentity;

  #runId;

  #writerId;

  #limits;

  #leaseNonce;

  #leaseContent;

  #leaseIdentity = null;

  #state = 'ACTIVE';

  #releaseResult = null;

  #deferredTemp = null;

  constructor(runDirectory, runId, writerId, limits) {
    this.#runDirectory = runDirectory;
    this.#runRealPath = runDirectory;
    this.#runId = runId;
    this.#writerId = writerId;
    this.#limits = limits;
    this.#leaseNonce = crypto.randomBytes(32).toString('hex');
    try {
      const stat = fs.lstatSync(runDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw hold();
      this.#runIdentity = fileIdentity(stat);
    } catch (_) {
      throw hold();
    }
  }

  #leasePath() {
    return path.join(this.#runDirectory, LEASE_FILENAME);
  }

  #assertRunDirectory() {
    try {
      const stat = fs.lstatSync(this.#runDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(fileIdentity(stat), this.#runIdentity)) throw revalidationMismatch();
      if (!samePath(fs.realpathSync(this.#runDirectory), this.#runRealPath)) throw revalidationMismatch();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) throw error;
      throw revalidationObservation();
    }
  }

  #readBoundedFile(filePath, maximumBytes, classifyRevalidation = false) {
    let descriptor;
    try {
      const initial = fs.lstatSync(filePath);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maximumBytes) throw hold();
      descriptor = fs.openSync(filePath, 'r');
      const current = fs.fstatSync(descriptor);
      if (!current.isFile() || current.size > maximumBytes || !sameFileIdentity(fileIdentity(initial), fileIdentity(current))) throw hold();
      const buffer = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
        if (!Number.isSafeInteger(read) || read <= 0) throw hold();
        offset += read;
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
      return freeze({ content: buffer.toString('utf8'), identity: fileIdentity(initial), byteLength: current.size });
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* preserve controlled HOLD */ }
      }
      if (classifyRevalidation) {
        if (error instanceof RevalidationMismatchError) throw error;
        if (error instanceof RecoveryStoreError) throw revalidationMismatch();
        throw revalidationObservation();
      }
      throw hold();
    }
  }

  #assertLease() {
    const loaded = this.#readBoundedFile(this.#leasePath(), MAX_LEASE_BYTES, true);
    if (!sameFileIdentity(loaded.identity, this.#leaseIdentity) || loaded.content !== this.#leaseContent) throw revalidationMismatch();
    try {
      if (!this.#leaseMatches(JSON.parse(loaded.content))) throw revalidationMismatch();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) throw error;
      throw revalidationMismatch();
    }
  }

  #fence() {
    if (this.#state !== 'RELEASED') this.#state = 'FENCED';
  }

  #revalidateOperation() {
    if (this.#state !== 'ACTIVE' && this.#state !== 'CLOSE_PENDING') throw hold();
    try {
      this.#assertRunDirectory();
      this.#assertLease();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) this.#fence();
      throw hold();
    }
  }

  #acquireLease() {
    const lease = freeze({ schema: LEASE_SCHEMA, schema_version: 1, run_id: this.#runId, writer_id: this.#writerId, nonce: this.#leaseNonce });
    const content = canonicalizeDetachedSnapshot(lease);
    const leasePath = this.#leasePath();
    let descriptor;
    let createdIdentity = null;
    try {
      descriptor = fs.openSync(leasePath, 'wx', 0o600);
      createdIdentity = fileIdentity(fs.fstatSync(descriptor));
      const leaseStat = fs.lstatSync(leasePath);
      if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || !sameFileIdentity(createdIdentity, fileIdentity(leaseStat))) throw hold();
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const loaded = this.#readBoundedFile(leasePath, MAX_LEASE_BYTES);
      if (!sameFileIdentity(loaded.identity, createdIdentity) || loaded.content !== content || !this.#leaseMatches(JSON.parse(loaded.content))) throw hold();
      this.#leaseContent = content;
      this.#leaseIdentity = loaded.identity;
    } catch (_) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* cleanup is identity-bound below */ }
      }
      if (createdIdentity !== null) {
        try { this.#removeTrackedFile(leasePath, createdIdentity); } catch (_) { /* preserve foreign or unverified state */ }
      }
      throw hold();
    }
  }

  #leaseMatches(lease) {
    return exactKeys(lease, ['schema', 'schema_version', 'run_id', 'writer_id', 'nonce'])
      && lease.schema === LEASE_SCHEMA && lease.schema_version === 1 && lease.run_id === this.#runId
      && lease.writer_id === this.#writerId && lease.nonce === this.#leaseNonce;
  }

  #removeTrackedFile(filePath, identity, expectedContent) {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentity(fileIdentity(stat), identity)) throw hold();
      if (expectedContent !== undefined) {
        const loaded = this.#readBoundedFile(filePath, this.#limits.maxTotalBytes);
        if (!sameFileIdentity(loaded.identity, identity) || loaded.content !== expectedContent) throw hold();
      }
      fs.unlinkSync(filePath);
    } catch (_) {
      throw hold();
    }
  }

  #assertOpen() {
    if (this.#state !== 'ACTIVE') throw hold();
  }

  #revisionFiles() {
    let directory;
    let closed = false;
    const names = [];
    try {
      directory = fs.opendirSync(this.#runDirectory);
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (names.length >= this.#limits.maxRevisionScan) throw hold();
        names.push(entry.name);
      }
      directory.closeSync();
      closed = true;
    } catch (_) {
      if (directory !== undefined && !closed) {
        try { directory.closeSync(); } catch (_) { /* preserve controlled HOLD */ }
      }
      throw hold();
    }
    const revisions = [];
    for (const name of names) {
      const match = REVISION_PATTERN.exec(name);
      if (!match) continue;
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision)) throw hold();
      revisions.push({ name, revision, path: path.join(this.#runDirectory, name) });
    }
    if (revisions.length > this.#limits.maxRevisionScan) throw hold();
    revisions.sort((left, right) => left.revision - right.revision || left.name.localeCompare(right.name));
    for (let index = 1; index < revisions.length; index += 1) {
      if (revisions[index - 1].revision === revisions[index].revision) throw hold();
    }
    return revisions;
  }

  #readRevision(entry) {
    const loaded = this.#readBoundedFile(entry.path, this.#limits.maxTotalBytes);
    let parsed;
    try {
      parsed = detachedSnapshot(JSON.parse(loaded.content));
    } catch (_) {
      throw hold();
    }
    const snapshot = envelopeSnapshot(parsed, this.#limits, this.#runId);
    if (snapshot.revision !== entry.revision) throw hold();
    return snapshot;
  }

  #scanCurrent() {
    const files = this.#revisionFiles();
    if (files.length === 0) return null;
    const revisions = files.map((entry) => this.#readRevision(entry));
    return revisions[revisions.length - 1];
  }

  #createEnvelope(records, revision) {
    const base = freeze({
      schema: ENVELOPE_SCHEMA,
      schema_version: ENVELOPE_VERSION,
      run_id: this.#runId,
      revision,
      records,
      content_sha256: '0'.repeat(64),
    });
    return freeze({ ...base, content_sha256: computeDetachedContentSha256(base) });
  }

  savePending(payload) {
    const input = detachedSnapshot(payload);
    if (this.#state !== 'ACTIVE') throw hold();
    this.#revalidateOperation();
    if (!exactKeys(input, ['records'])) throw hold();
    validateRecordSet(input.records, this.#limits, this.#runId);
    const current = this.#scanCurrent();
    const revision = current === null ? 1 : current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw hold();
    let snapshot;
    let content;
    try {
      snapshot = this.#createEnvelope(input.records, revision);
      content = canonicalizeDetachedSnapshot(snapshot);
      if (Buffer.byteLength(content, 'utf8') > this.#limits.maxTotalBytes) throw hold();
    } catch (_) {
      throw hold();
    }
    const revisionPath = path.join(this.#runDirectory, `pending-revision-${revision}.json`);
    let tempPath;
    let descriptor;
    let tempIdentity = null;
    let committed = false;
    let verifiedContent;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        tempPath = path.join(this.#runDirectory, `.pending-${crypto.randomBytes(24).toString('hex')}.tmp`);
        try {
          descriptor = fs.openSync(tempPath, 'wx', 0o600);
          tempIdentity = fileIdentity(fs.fstatSync(descriptor));
          const tempStat = fs.lstatSync(tempPath);
          if (!tempStat.isFile() || tempStat.isSymbolicLink() || !sameFileIdentity(tempIdentity, fileIdentity(tempStat))) throw hold();
          break;
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
      }
      if (descriptor === undefined || tempIdentity === null) throw hold();
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const verifiedTemp = this.#readBoundedFile(tempPath, this.#limits.maxTotalBytes);
      if (!sameFileIdentity(verifiedTemp.identity, tempIdentity) || verifiedTemp.content !== content) throw hold();
      let verifiedSnapshot;
      try {
        verifiedSnapshot = envelopeSnapshot(detachedSnapshot(JSON.parse(verifiedTemp.content)), this.#limits, this.#runId);
      } catch (_) {
        throw hold();
      }
      if (verifiedSnapshot.revision !== revision || verifiedSnapshot.content_sha256 !== snapshot.content_sha256) throw hold();
      verifiedContent = verifiedTemp.content;
      this.#revalidateOperation();
      fs.linkSync(tempPath, revisionPath);
      committed = true;
      try {
        this.#removeTrackedFile(tempPath, tempIdentity, content);
        tempPath = undefined;
      } catch (_) {
        if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
        this.#deferredTemp = freeze({ path: tempPath, identity: tempIdentity, content: verifiedContent });
      }
      return freeze({ revision, content_sha256: verifiedSnapshot.content_sha256 });
    } catch (_) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* tracked cleanup below */ }
      }
      if (!committed && tempPath !== undefined && tempIdentity !== null) {
        try {
          this.#removeTrackedFile(tempPath, tempIdentity, verifiedContent);
        } catch (_) {
          if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
          this.#deferredTemp = verifiedContent === undefined
            ? freeze({ path: tempPath, identity: tempIdentity })
            : freeze({ path: tempPath, identity: tempIdentity, content: verifiedContent });
        }
      }
      throw hold();
    }
  }

  loadPending() {
    this.#assertOpen();
    this.#revalidateOperation();
    const current = this.#scanCurrent();
    if (current === null) return null;
    return freeze({ revision: current.revision, records: current.records, content_sha256: current.content_sha256 });
  }

  #scanTransactions(excludedTemp = null) {
    let directory;
    const names = [];
    try {
      directory = fs.opendirSync(this.#runDirectory);
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (names.length >= this.#limits.maxRevisionScan) throw hold();
        names.push(entry.name);
      }
    } catch (_) {
      throw hold();
    } finally {
      if (directory !== undefined) directory.closeSync();
    }
    let retainedBytes = 0;
    let leaseFound = false;
    let excludedFound = false;
    const revisions = [];
    for (const name of names) {
      const target = path.join(this.#runDirectory, name);
      if (excludedTemp !== null && target === excludedTemp.path) {
        const observed = this.#readBoundedFile(target, this.#limits.maxTotalBytes);
        if (!sameFileIdentity(observed.identity, excludedTemp.identity)
          || observed.content !== excludedTemp.content) throw hold();
        excludedFound = true;
        continue;
      }
      const loaded = this.#readBoundedFile(target,
        name === LEASE_FILENAME ? MAX_LEASE_BYTES : this.#limits.maxTotalBytes);
      retainedBytes += loaded.byteLength;
      if (!Number.isSafeInteger(retainedBytes) || retainedBytes > this.#limits.maxTotalBytes) throw hold();
      if (name === LEASE_FILENAME) {
        if (!sameFileIdentity(loaded.identity, this.#leaseIdentity) || loaded.content !== this.#leaseContent) throw hold();
        leaseFound = true;
        continue;
      }
      const match = REVISION_PATTERN.exec(name);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw hold();
      const snapshot = transactionEnvelopeSnapshot(detachedSnapshot(JSON.parse(loaded.content)), this.#limits, this.#runId);
      if (snapshot.revision !== Number(match[1])) throw hold();
      revisions.push({ snapshot, identity: loaded.identity });
    }
    if (!leaseFound || (excludedTemp !== null && !excludedFound)) throw hold();
    revisions.sort((left, right) => left.snapshot.revision - right.snapshot.revision);
    let previous = null;
    for (const entry of revisions) {
      const snapshot = entry.snapshot;
      if (snapshot.revision !== (previous === null ? 1 : previous.revision + 1)
        || snapshot.previous_content_sha256 !== (previous === null ? null : previous.content_sha256)) throw hold();
      validateContinuity(previous === null ? null : previous.transaction, snapshot.transaction);
      previous = snapshot;
    }
    return {
      head: previous,
      headIdentity: revisions.length === 0 ? null : revisions[revisions.length - 1].identity,
      retainedBytes,
      entryCount: names.length - (excludedFound ? 1 : 0),
    };
  }

  #assertExpectedTransactionHead(input, current) {
    if (input.expectedRevision !== (current.head === null ? 0 : current.head.revision)
      || input.expectedContentSha256 !== (current.head === null ? null : current.head.content_sha256)) throw hold();
    validateContinuity(current.head === null ? null : current.head.transaction, input.transaction);
  }

  #assertTransactionCapacity(current, proposedBytes) {
    if (current.entryCount + 2 > this.#limits.maxRevisionScan
      || current.retainedBytes + proposedBytes > this.#limits.maxTotalBytes) throw hold();
  }

  saveTransaction(payload) {
    let tempPath;
    let descriptor;
    let tempIdentity = null;
    let committed = false;
    let verifiedContent;
    try {
      const input = detachedSnapshot(payload);
      this.#assertOpen();
      this.#revalidateOperation();
      if (!exactKeys(input, ['expectedRevision', 'expectedContentSha256', 'transaction'])
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || (input.expectedRevision === 0 ? input.expectedContentSha256 !== null
          : typeof input.expectedContentSha256 !== 'string' || !SHA256.test(input.expectedContentSha256))) throw hold();
      validateTransaction(input.transaction, this.#limits, this.#runId);
      const current = this.#scanTransactions();
      this.#assertExpectedTransactionHead(input, current);
      const revision = input.expectedRevision + 1;
      if (!validLimit(revision)) throw hold();
      const base = {
        schema: TRANSACTION_SCHEMA, schema_version: 2, run_id: this.#runId,
        revision, previous_content_sha256: input.expectedContentSha256, transaction: input.transaction,
      };
      const snapshot = detachedSnapshot({ ...base, content_sha256: computeDetachedContentSha256(base) });
      const content = canonicalizeDetachedSnapshot(snapshot);
      const proposedBytes = Buffer.byteLength(content, 'utf8');
      this.#assertTransactionCapacity(current, proposedBytes);
      this.#revalidateOperation();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        tempPath = path.join(this.#runDirectory, '.pending-' + crypto.randomBytes(24).toString('hex') + '.tmp');
        try {
          descriptor = fs.openSync(tempPath, 'wx', 0o600);
          tempIdentity = fileIdentity(fs.fstatSync(descriptor));
          const stat = fs.lstatSync(tempPath);
          if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentity(tempIdentity, fileIdentity(stat))) throw hold();
          break;
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
      }
      if (descriptor === undefined || tempIdentity === null) throw hold();
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const observedTemp = this.#readBoundedFile(tempPath, this.#limits.maxTotalBytes);
      if (!sameFileIdentity(observedTemp.identity, tempIdentity) || observedTemp.content !== content) throw hold();
      verifiedContent = content;
      const excludedTemp = { path: tempPath, identity: tempIdentity, content };
      this.#revalidateOperation();
      const beforeLink = this.#scanTransactions(excludedTemp);
      this.#assertExpectedTransactionHead(input, beforeLink);
      this.#assertTransactionCapacity(beforeLink, proposedBytes);
      const revisionPath = path.join(this.#runDirectory, 'pending-revision-' + revision + '.json');
      fs.linkSync(tempPath, revisionPath);
      committed = true;
      try {
        this.#removeTrackedFile(tempPath, tempIdentity, content);
        tempPath = undefined;
      } catch (_) {
        this.#state = 'CLOSE_PENDING';
        this.#deferredTemp = freeze(excludedTemp);
      }
      // V2 acknowledges only a verified durable head; V1 deliberately remains unchanged.
      this.#revalidateOperation();
      const published = this.#readBoundedFile(revisionPath, this.#limits.maxTotalBytes);
      if (!sameFileIdentity(published.identity, tempIdentity) || published.content !== content) throw hold();
      const afterLink = this.#scanTransactions(tempPath === undefined ? null : excludedTemp);
      if (afterLink.head === null || afterLink.head.revision !== revision
        || afterLink.head.content_sha256 !== snapshot.content_sha256
        || !sameFileIdentity(afterLink.headIdentity, tempIdentity)) throw hold();
      this.#revalidateOperation();
      return freeze({
        persisted: true, runId: this.#runId, expectedRevision: input.expectedRevision,
        expectedContentSha256: input.expectedContentSha256, revision,
        previousContentSha256: input.expectedContentSha256, contentSha256: snapshot.content_sha256,
      });
    } catch (_) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* tracked cleanup below */ }
      }
      if (committed) {
        // Durable uncertainty is not rollback; close may release only lease/deferred temp.
        if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
      } else if (tempPath !== undefined && tempIdentity !== null) {
        try {
          this.#removeTrackedFile(tempPath, tempIdentity, verifiedContent);
        } catch (_) {
          if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
          this.#deferredTemp = verifiedContent === undefined
            ? freeze({ path: tempPath, identity: tempIdentity })
            : freeze({ path: tempPath, identity: tempIdentity, content: verifiedContent });
        }
      }
      throw hold();
    }
  }

  loadTransaction() {
    try {
      if (arguments.length !== 0) throw hold();
      this.#assertOpen();
      this.#revalidateOperation();
      const current = this.#scanTransactions();
      this.#revalidateOperation();
      return current.head;
    } catch (_) {
      throw hold();
    }
  }

  close() {
    if (this.#state === 'RELEASED') return this.#releaseResult;
    if (this.#state === 'FENCED') return freeze({ released: false, disposition: 'HOLD' });
    try {
      this.#revalidateOperation();
      if (this.#deferredTemp !== null) {
        this.#removeTrackedFile(this.#deferredTemp.path, this.#deferredTemp.identity, this.#deferredTemp.content);
        this.#deferredTemp = null;
        this.#state = 'ACTIVE';
      }
      this.#revalidateOperation();
      fs.unlinkSync(this.#leasePath());
      this.#state = 'RELEASED';
      this.#releaseResult = freeze({ released: true, disposition: 'RELEASED' });
      return this.#releaseResult;
    } catch (_) {
      return freeze({ released: false, disposition: 'HOLD' });
    }
  }
}

module.exports = { RecoveryStore, RecoveryStoreError };
