'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  canonicalizeDetachedSnapshot,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');
const { validateResourceIdentity2, validateSupportMatrix2 } = require('./identity-support-v2');
const { TaskResourceTracker } = require('./task-resource-tracker');
const { createInitialFailureLoopState, FailureLoopGuard } = require('./failure-loop-guard');
const { RecoveryStore } = require('./recovery-store');
const VERIFY_TRACKER_CLOSE = TaskResourceTracker.prototype.verifyCloseResult;

const CONSTRUCTOR_TOKEN = Symbol('TaskResourceManager.constructor');
const PRIVATE_STATE = new WeakMap();
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHORITY_REFERENCE = /^authority:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOP_LEVEL_KEYS = Object.freeze([
  'runId', 'harness', 'dataRoot', 'platformAdapter', 'authorization', 'limits',
]);
const HARNESS_KEYS = Object.freeze(['type', 'harnessId', 'trustedProducer']);
const AUTHORIZATION_KEYS = Object.freeze([
  'type', 'cleanupAuthorityRef', 'allowForceTermination',
]);
const ADAPTER_KEYS = Object.freeze([
  'type', 'adapterId', 'probeCapabilities', 'spawnManaged', 'observeProcess',
  'requestGracefulStop', 'terminateOwnedTree', 'verifyProcessAbsent',
  'allocateTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot',
  'verifyTemporaryAbsent',
]);
const ADAPTER_V2_KEYS = Object.freeze([...ADAPTER_KEYS, 'observeTemporaryRoot']);
const PROVENANCE_KEYS = Object.freeze([
  'type', 'runId', 'harnessId', 'producerId', 'ownerId', 'sessionId', 'managerRunId',
  'managerGeneration', 'adapterId', 'adapterGeneration', 'platform', 'observedAt',
  'authorizationSha256',
]);
const ENVELOPE_KEYS = Object.freeze(['type', 'provenance', 'supportMatrix']);
const COMMAND_KEYS = Object.freeze([
  'commandId', 'executable', 'args', 'cwd', 'timeoutMs', 'temporaryRoot',
]);
const COMMAND_V2_KEYS = Object.freeze([...COMMAND_KEYS, 'gracefulShutdown']);
const GRACEFUL_SHUTDOWN_KEYS = Object.freeze([
  'type', 'protocol', 'authorityRef', 'acknowledgementRequired',
]);
const ADAPTER_RESPONSE_KEYS = Object.freeze(['identity', 'evidenceRefs', 'requestSha256']);
const POLICY_RECEIPT_KEYS = Object.freeze([
  'policy_id', 'kind', 'source_kind', 'observed_at', 'values', 'evidence_refs', 'source_sha256',
]);
const LIMIT_NAMESPACES = Object.freeze(['tracker', 'recovery', 'failureLoop']);
const TRACKER_LIMITS = Object.freeze([
  'maxScopes', 'maxResources', 'maxHistoryEvents', 'maxInputBytes', 'maxEventBytes',
  'maxHistoryBytes', 'maxStateBytes',
]);
const RECOVERY_LIMITS = Object.freeze([
  'maxRecords', 'maxItemBytes', 'maxTotalBytes', 'maxRevisionScan',
]);
const FAILURE_LOOP_LIMITS = Object.freeze([
  'maxFailures', 'maxRecordsPerGeneration', 'maxGenerationsPerFailure',
  'maxEvidenceRefsPerFailure', 'maxOperationBindings', 'maxStateBytes',
]);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const PROCESS_TREE_RESOURCE_ID =
  /^command:[A-Za-z0-9][A-Za-z0-9_-]{0,127}:process-tree$/;
const CONTROL_CHARACTER = /[\0\r\n]/;
const DEFAULT_TRACKER_MAX_INPUT_BYTES = 64 * 1024;
const STOP_REASON_CODES = new Set([
  'user_requested', 'task_completed', 'task_failed', 'timeout_elapsed', 'manager_close',
  'recovery_resume',
]);
const ACTION_DISPOSITIONS = new Set([
  'COMPLETED', 'UNSUPPORTED', 'IDENTITY_INSUFFICIENT', 'AUTHORIZATION_BLOCKED', 'FAILED',
]);
const STOP_ACTION_TIMEOUT_MS = 30_000;

class TaskResourceManagerError extends Error {
  constructor() {
    super('task resource manager hold');
    this.name = 'TaskResourceManagerError';
    this.code = 'TASK_RESOURCE_MANAGER_HOLD';
  }
}

function hold() {
  return new TaskResourceManagerError();
}

function safeGetPrototypeOf(value) {
  try { return Object.getPrototypeOf(value); } catch (_) { throw hold(); }
}

function safeOwnKeys(value) {
  try { return Reflect.ownKeys(value); } catch (_) { throw hold(); }
}

function safeDescriptor(value, key) {
  try { return Object.getOwnPropertyDescriptor(value, key); } catch (_) { throw hold(); }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && safeGetPrototypeOf(value) === Object.prototype;
}

function readExactDataObject(value, keys) {
  if (!isPlainObject(value)) throw hold();
  const ownKeys = safeOwnKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) throw hold();
  const required = new Set(keys);
  const output = {};
  for (const key of ownKeys) {
    if (!required.has(key)) throw hold();
    const descriptor = safeDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) throw hold();
    output[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.hasOwn(output, key)) throw hold();
  }
  return output;
}

function readOptionalDataObject(value, keys) {
  if (!isPlainObject(value)) throw hold();
  const allowed = new Set(keys);
  const output = {};
  for (const key of safeOwnKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw hold();
    const descriptor = safeDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) throw hold();
    output[key] = descriptor.value;
  }
  return output;
}

function requireSafeIdentifier(value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) throw hold();
  return value;
}

function requirePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw hold();
  return value;
}

function detachedSnapshot(value) {
  try { return createDetachedJsonSnapshot(value).snapshot; } catch (_) { throw hold(); }
}

function freezeContext(value) {
  return Object.freeze(value);
}

function normalizeDataRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw hold();
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw hold();
  return resolved;
}

function normalizeNonRootAbsolutePath(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value) || !path.isAbsolute(value)) throw hold();
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw hold();
  return resolved;
}

function normalizeCommandArgs(value) {
  const normalized = detachedSnapshot(value);
  if (!Array.isArray(normalized)
    || normalized.some((item) => typeof item !== 'string' || CONTROL_CHARACTER.test(item))) throw hold();
  return normalized;
}

function hasExactKeySet(ownKeys, expectedKeys) {
  if (ownKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return ownKeys.every((key) => typeof key === 'string' && expected.has(key));
}

function classifyCommandInput(value) {
  if (!isPlainObject(value)) throw hold();
  const ownKeys = safeOwnKeys(value);
  const variants = [
    { keys: COMMAND_KEYS, version: 1, verification: false },
    { keys: COMMAND_V2_KEYS, version: 2, verification: false },
    { keys: VERIFICATION_COMMAND_KEYS, version: 1, verification: true },
    { keys: VERIFICATION_COMMAND_V2_KEYS, version: 2, verification: true },
  ].filter((variant) => hasExactKeySet(ownKeys, variant.keys));
  if (variants.length !== 1) throw hold();
  return variants[0];
}

function normalizeGracefulShutdown(value) {
  if (value === null) return null;
  const input = readExactDataObject(value, GRACEFUL_SHUTDOWN_KEYS);
  if (input.type !== 'TaskResourceGracefulShutdown1'
    || input.protocol !== 'trusted_dispatch'
    || typeof input.authorityRef !== 'string' || !AUTHORITY_REFERENCE.test(input.authorityRef)
    || input.acknowledgementRequired !== true) throw hold();
  return freezeContext(input);
}

function normalizeCommandInput(value) {
  const variant = classifyCommandInput(value);
  const input = readExactDataObject(value, variant.keys);
  const verification = variant.verification ? {
    bootstrapVerificationHolder: input.bootstrapVerificationHolder,
    retryBudget: input.retryBudget, repairBudget: input.repairBudget,
  } : null;
  if (verification && (!Number.isSafeInteger(verification.retryBudget) || verification.retryBudget < 0
    || !Number.isSafeInteger(verification.repairBudget) || verification.repairBudget < 0)) throw hold();
  if (typeof input.commandId !== 'string' || !COMMAND_ID.test(input.commandId)
    || typeof input.executable !== 'string' || input.executable.length === 0
    || CONTROL_CHARACTER.test(input.executable)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw hold();
  const command = freezeContext({
    commandId: input.commandId,
    executable: input.executable,
    args: normalizeCommandArgs(input.args),
    cwd: normalizeNonRootAbsolutePath(input.cwd),
    timeoutMs: input.timeoutMs,
    temporaryRoot: input.temporaryRoot === null ? null : normalizeNonRootAbsolutePath(input.temporaryRoot),
    commandVersion: variant.version,
    gracefulShutdownSha256: variant.version === 2
      ? computeDetachedSha256(normalizeGracefulShutdown(input.gracefulShutdown)) : null,
  });
  return { command, verification };
}

// The holder conveys admitted bootstrap data only to its exact trusted producer.
// It does not isolate hostile same-process code possessing that capability.
const BOOTSTRAP_HOLDER_STATE = new WeakMap();
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const VERIFICATION_COMMAND_KEYS = Object.freeze([
  ...COMMAND_KEYS, 'bootstrapVerificationHolder', 'retryBudget', 'repairBudget',
]);
const VERIFICATION_COMMAND_V2_KEYS = Object.freeze([
  ...COMMAND_V2_KEYS, 'bootstrapVerificationHolder', 'retryBudget', 'repairBudget',
]);
const CONSUME_SEED_KEYS = Object.freeze(['commandId', 'purpose']);

function observeRejectedNativePromise(value) {
  // Native brand checking rejects arbitrary thenables without reading `then`.
  // This observes a rejected action even when admission refuses before await.
  try { Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]); } catch (_) { /* not a native Promise */ }
}

function revokeBootstrapGrant(grant) {
  if (grant) { grant.callbackWindow = false; grant.revoked = true; }
}

function requireBootstrapStartOpen(state, record, attempt) {
  if (state.closeTransaction.admissionClosed || state.closeTransaction.phase !== 'OPEN'
    || state.commands.get(record.command.commandId) !== record
    || record.startAttempt !== attempt || record.status !== 'STARTING') throw hold();
}

function consumeBootstrapSeed(value) {
  const holderState = BOOTSTRAP_HOLDER_STATE.get(this);
  const grant = holderState?.grant;
  try {
    if (arguments.length !== 1 || !grant || grant.holder !== this || !holderState.used
      || holderState.trustedProducer !== grant.producer || grant.revoked || grant.consumed
      || !grant.callbackWindow || grant.deliveryInProgress) throw hold();
    const input = readExactDataObject(value, CONSUME_SEED_KEYS);
    const state = PRIVATE_STATE.get(grant.manager);
    const record = grant.record;
    if (!state || state.harness.trustedProducer !== grant.producer
      || record.bootstrapGrant !== grant || input.commandId !== grant.commandId
      || input.purpose !== 'bootstrap_store_schema_red'
      || record.phase !== 'BOOTSTRAP_SEED_CALLBACK_WINDOW'
      || grant.expectedPendingAction === null || record.pendingAction !== grant.expectedPendingAction
      || record.pendingAction.action !== grant.expectedAction) throw hold();
    requireBootstrapStartOpen(state, record, grant.attempt);
    // All potentially throwing copy/freeze work precedes successful delivery.
    grant.deliveryInProgress = true;
    grant.callbackWindow = false;
    const result = Object.freeze(detachedSnapshot(grant.seed));
    requireBootstrapStartOpen(state, record, grant.attempt);
    if (grant.revoked || record.phase !== 'BOOTSTRAP_SEED_CALLBACK_WINDOW'
      || record.pendingAction !== grant.expectedPendingAction) throw hold();
    grant.deliveryInProgress = false;
    grant.consumed = true;
    grant.deliverySucceeded = true;
    revokeBootstrapGrant(grant);
    return result;
  } catch (_) {
    revokeBootstrapGrant(grant);
    throw hold();
  }
}

function createBootstrapSeedVerificationHolder(trustedProducer) {
  if (arguments.length !== 1 || typeof trustedProducer !== 'function') throw hold();
  const holder = Object.freeze({ consumeBootstrapSeed });
  BOOTSTRAP_HOLDER_STATE.set(holder, { trustedProducer, used: false, grant: null });
  return holder;
}

function bindBootstrapGrant(manager, state, record, verification, holderState, attempt) {
  const trackerHistory = state.tracker.exportHistory();
  // Retain the real hash-linked history; runtime history is never filtered into
  // a fabricated bootstrap history or disclosed through this verification seam.
  if (trackerHistory.some(event => event.kind !== 'SCOPE_OPENED'
    && event.kind !== 'RESOURCE_REGISTERED')) throw hold();
  const seed = detachedSnapshot({
    type: 'TaskResourceManagerBootstrapSeed1', schema_version: 1,
    commandId: record.command.commandId,
    originalProvenance: state.provenance,
    originalAuthorization: state.authorization,
    originalCapabilityEnvelope: state.capabilityEnvelope,
    trackerHistory,
    failureLoopState: createInitialFailureLoopState({
      runId: state.provenance.runId,
      guardId: `manager:${state.provenance.managerRunId}:failure-loop`,
      retryBudget: verification.retryBudget, repairBudget: verification.repairBudget,
    }),
  });
  const grant = {
    manager, record, holder: verification.bootstrapVerificationHolder,
    producer: holderState.trustedProducer, commandId: record.command.commandId, attempt, seed,
    expectedAction: record.command.temporaryRoot === null ? 'spawnManaged' : 'allocateTemporaryRoot',
    expectedPendingAction: null, callbackWindow: false,
    consumed: false, deliverySucceeded: false, deliveryInProgress: false, revoked: false,
  };
  holderState.used = true;
  holderState.grant = grant;
  record.bootstrapGrant = grant;
  record.phase = 'BOOTSTRAP_SEED_READY';
}

function invokeBootstrapFirstAction(state, record, attempt, action, nextPhase) {
  const grant = record.bootstrapGrant;
  const pending = record.pendingAction;
  grant.expectedPendingAction = pending;
  record.phase = 'BOOTSTRAP_SEED_CALLBACK_WINDOW';
  grant.callbackWindow = true;
  let returned;
  try { returned = action(); }
  finally {
    grant.callbackWindow = false;
    if (!grant.consumed) revokeBootstrapGrant(grant);
  }
  try {
    requireBootstrapStartOpen(state, record, attempt);
    if (record.phase !== 'BOOTSTRAP_SEED_CALLBACK_WINDOW'
      || record.pendingAction !== pending || grant.expectedPendingAction !== pending
      || !grant.consumed || !grant.deliverySucceeded || !grant.revoked) throw hold();
  } catch (_) {
    revokeBootstrapGrant(grant);
    observeRejectedNativePromise(returned);
    throw hold();
  }
  record.phase = nextPhase;
  return returned;
}


function requireVerifiedCapability(supportMatrix, capability) {
  const claim = supportMatrix && supportMatrix.claims && supportMatrix.claims[capability];
  if (!claim || claim.state !== 'VERIFIED_FULL') throw hold();
}

function randomOpaqueValue() {
  try { return crypto.randomBytes(32).toString('hex'); } catch (_) { throw hold(); }
}

function isStrictPathDescendant(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string'
    || !path.isAbsolute(child) || path.resolve(child) !== child) return false;
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resourceIdsFor(commandId, needsTemporaryAllocation) {
  return freezeContext({
    temporaryAllocation: needsTemporaryAllocation ? `command:${commandId}:temporary` : null,
    commandSession: `command:${commandId}:session`,
    processTree: `command:${commandId}:process-tree`,
  });
}

function adapterProvenance(provenance) {
  return freezeContext({
    ownerId: provenance.ownerId,
    runId: provenance.runId,
    sessionId: provenance.sessionId,
    managerRunId: provenance.managerRunId,
    managerGeneration: provenance.managerGeneration,
    adapterGeneration: provenance.adapterGeneration,
    platform: provenance.platform,
  });
}

function createAdapterRequest(type, fields) {
  const preimage = detachedSnapshot({ type, ...fields });
  return detachedSnapshot({ ...preimage, requestSha256: computeDetachedSha256(preimage) });
}

function normalizeAdapterResponse(value) {
  const response = readExactDataObject(detachedSnapshot(value), ADAPTER_RESPONSE_KEYS);
  if (typeof response.requestSha256 !== 'string' || !SHA256.test(response.requestSha256)) throw hold();
  return freezeContext(response);
}

function normalizeObservationResponse(value, request, maxInputBytes) {
  const response = readExactDataObject(detachedSnapshot(value), ADAPTER_RESPONSE_KEYS);
  if (typeof response.requestSha256 !== 'string' || !SHA256.test(response.requestSha256)
    || response.requestSha256 !== request.requestSha256) throw hold();
  if (!Array.isArray(response.evidenceRefs) || response.evidenceRefs.length === 0
    || response.evidenceRefs.some((reference) => typeof reference !== 'string'
      || !/^evidence:[0-9a-f]{64}$/.test(reference))
    || new Set(response.evidenceRefs).size !== response.evidenceRefs.length
    || Buffer.byteLength(canonicalizeDetachedSnapshot(response), 'utf8') > maxInputBytes
    || !validateResourceIdentity2('process_tree', response.identity).valid) throw hold();
  return freezeContext(response);
}

function requireEvidenceResponse(response, maxInputBytes) {
  if (!Array.isArray(response.evidenceRefs) || response.evidenceRefs.length === 0
    || response.evidenceRefs.some((reference) => typeof reference !== 'string'
      || !/^evidence:[0-9a-f]{64}$/.test(reference))
    || new Set(response.evidenceRefs).size !== response.evidenceRefs.length
    || Buffer.byteLength(canonicalizeDetachedSnapshot(response), 'utf8') > maxInputBytes) throw hold();
}

function normalizeStopActionResponse(value, request, maxInputBytes) {
  const response = readExactDataObject(detachedSnapshot(value), [
    'disposition', 'targetIdentitySha256', 'identityRevalidated', 'evidenceRefs', 'requestSha256',
  ]);
  if (!ACTION_DISPOSITIONS.has(response.disposition)
    || response.targetIdentitySha256 !== computeDetachedSha256(request.expectedIdentity)
    || typeof response.identityRevalidated !== 'boolean'
    || response.requestSha256 !== request.requestSha256) throw hold();
  requireEvidenceResponse(response, maxInputBytes);
  return detachedSnapshot(response);
}

function normalizeStopObservationResponse(value, request, maxInputBytes) {
  const response = readExactDataObject(detachedSnapshot(value), [
    'identity', 'graceful', 'exactTreeTerminationSupported', 'evidenceRefs', 'requestSha256',
  ]);
  const graceful = readExactDataObject(response.graceful, [
    'requested', 'deadlineReached', 'exitObserved',
  ]);
  if (response.requestSha256 !== request.requestSha256
    || !validateResourceIdentity2('process_tree', response.identity).valid
    || typeof graceful.requested !== 'boolean' || typeof graceful.deadlineReached !== 'boolean'
    || typeof graceful.exitObserved !== 'boolean' || graceful.requested !== true
    || typeof response.exactTreeTerminationSupported !== 'boolean') throw hold();
  requireEvidenceResponse(response, maxInputBytes);
  return detachedSnapshot(response);
}

function normalizeAbsenceResponse(value, request, maxInputBytes) {
  const response = readExactDataObject(detachedSnapshot(value), [
    'disposition', 'targetIdentitySha256', 'absence', 'evidenceRefs', 'requestSha256',
  ]);
  const absence = readExactDataObject(response.absence, [
    'processAbsent', 'threadAbsent', 'portAbsent',
  ]);
  if (!(ACTION_DISPOSITIONS.has(response.disposition) || response.disposition === 'ABSENT_CONFIRMED')
    || response.targetIdentitySha256 !== request.expectedIdentitySha256
    || response.requestSha256 !== request.requestSha256
    || typeof absence.processAbsent !== 'boolean' || typeof absence.threadAbsent !== 'boolean'
    || typeof absence.portAbsent !== 'boolean') throw hold();
  if (response.disposition === 'ABSENT_CONFIRMED'
    && (!absence.processAbsent || !absence.threadAbsent || !absence.portAbsent)) throw hold();
  requireEvidenceResponse(response, maxInputBytes);
  return detachedSnapshot(response);
}

function stopResult(status, resourceId, decision) {
  return detachedSnapshot({ status, resourceId, decision });
}

function publicStopDecision(action, reasons, extra = {}) {
  return detachedSnapshot({ action, reasons, action_authorized: false, ...extra });
}

function stopHold(state, record, resourceId, reason) {
  const result = stopResult('HOLD', resourceId, publicStopDecision('HOLD', [reason]));
  record.status = 'HOLD';
  record.phase = 'STOP_HOLD';
  record.stopResult = result;
  // Defensive default, inert on every currently reachable path: each of the eight
  // stopHold call sites is reached only after the newest action of its command has
  // already been settled, so runtimeSettleLatest finds it resolved and returns
  // without writing. The first settle therefore stands, and a refusal of a successor
  // — a tracker or an authorization policy declining to release — cannot be written
  // onto an observation or an absence fact that had already succeeded. This line is
  // kept for an exit that might one day reach stopHold before any settle; no such
  // exit exists today, so do not read it as the source of the durable class above.
  runtimeSettleLatest(state, record, 'REJECTED');
  return result;
}

function managerCloseResult(status, reason) {
  return detachedSnapshot({
    status,
    decision: {
      action: status === 'CLOSED' ? 'CLOSE_COMPLETE' : status === 'HOLD' ? 'HOLD' : 'WAIT_BOUNDED',
      reasons: [reason],
      action_authorized: false,
    },
  });
}

function closePreflightFailure(state, records) {
  // Liveness and topology have manager-wide priority, not per-record priority.
  if (records.some((record) => record.startAttempt !== undefined
    || record.observationAttempt !== undefined || record.stopAttempt !== undefined)) {
    return 'COMMAND_OPERATION_IN_PROGRESS';
  }
  if (state.adapter.type === 'TaskResourcePlatformAdapter1'
    && records.some((record) => record.command.temporaryRoot !== null
      || record.resourceIds?.temporaryAllocation != null || record.allocationResponse !== null)) {
    return 'TEMPORARY_CLEANUP_UNAVAILABLE';
  }
  for (const record of records) {
    if (record.scopeClosed === true) continue;
    if (record.scope === null || record.resourceIds === null || record.spawnResponse === null) {
      return 'COMMAND_START_INCOMPLETE';
    }
    let processTree;
    let commandSession;
    try {
      processTree = record.scope.getResource(record.resourceIds.processTree);
      commandSession = record.scope.getResource(record.resourceIds.commandSession);
    } catch (_) {
      return 'COMMAND_START_INCOMPLETE';
    }
    if (!processTree || !commandSession || processTree.identity === null
      || commandSession.identity === null || processTree.boundGeneration === null
      || commandSession.boundGeneration === null) return 'COMMAND_START_INCOMPLETE';
    const identity = record.spawnResponse.identity;
    const bound = (resource, type, resourceId, parentResourceId, expectedIdentity) => resource
      && resource.type === type
      && resource.resourceId === resourceId && resource.parentResourceId === parentResourceId
      && resource.ownerId === state.provenance.ownerId
      && resource.scopeId === record.scope.scopeId
      && resource.generation === state.provenance.managerGeneration
      && resource.boundGeneration === state.provenance.managerGeneration
      && canonicalizeDetachedSnapshot(resource.identity) === canonicalizeDetachedSnapshot(expectedIdentity);
    const temporaryId = record.resourceIds.temporaryAllocation;
    if (record.command.temporaryRoot !== null || temporaryId !== null || record.allocationResponse !== null) {
      try {
        const temporaryIdentity = record.allocationResponse?.identity;
        const temporary = record.scope.getResource(temporaryId);
        requireVerifiedCapability(state.capabilityEnvelope.supportMatrix, 'temporary_lease');
        if (state.adapter.type !== 'TaskResourcePlatformAdapter2' || temporaryId === null
          || !validateResourceIdentity2('temporary_allocation', temporaryIdentity).valid
          || !sameProvenance(temporaryIdentity, state.provenance)
          || temporaryIdentity.canonical_root !== record.command.temporaryRoot
          || temporaryIdentity.child_id !== record.resourceIds.commandSession
          || temporaryIdentity.confirmed_parent_directory.path !== temporaryIdentity.canonical_root
          || !isStrictPathDescendant(temporaryIdentity.canonical_root, temporaryIdentity.task_directory.path)
          || path.dirname(temporaryIdentity.task_directory.path) !== temporaryIdentity.confirmed_parent_directory.path
          || !bound(temporary, 'temporary_allocation', temporaryId, null, temporaryIdentity)
          || temporary.state !== 'ACTIVE' || temporary.releaseConfirmed === true) {
          return 'TEMPORARY_STATE_INVALID';
        }
      } catch (_) {
        return 'TEMPORARY_STATE_INVALID';
      }
    }
    if (!validateResourceIdentity2('process_tree', identity).valid
      || !sameProvenance(identity, state.provenance)
      || !bound(processTree, 'process_tree', record.resourceIds.processTree, record.resourceIds.commandSession, identity)
      || !bound(commandSession, 'command_session', record.resourceIds.commandSession, temporaryId, identity)) {
      return 'COMMAND_STATE_INVALID';
    }
    if (record.status === 'HOLD' && (record.stopFailed === true || record.phase === 'STOP_HOLD')) {
      return 'COMMAND_STOP_HOLD';
    }
    if (record.pendingAction !== null
      || !['STARTED', 'STOP_REQUESTED', 'WAITING', 'STOPPED'].includes(record.status)
      || processTree.state !== 'ACTIVE' || commandSession.state !== 'ACTIVE') {
      return 'COMMAND_STATE_INVALID';
    }
  }
  return null;
}

function verifiedTrackerClose(state, scope, result) {
  return result && result.status === 'CLOSED'
    && Reflect.apply(VERIFY_TRACKER_CLOSE, state.tracker, [result, {
      ownerId: state.provenance.ownerId,
      runId: state.provenance.runId,
      generation: state.provenance.managerGeneration,
      scopeId: scope.scopeId,
    }]) === true;
}

// Admit only the policies used for this reclaim into the Tracker history.
// Receipt authenticity alone does not make unrelated policy payload persistable.
// POLICY_RECEIPT_KEYS mirrors contracts.js, which resolvePolicy already applies
// before a reclaim can be authorised; checking it here only moves that rejection
// ahead of Tracker.observe, so no receipt that could be resolved is refused.
function requireTemporaryPolicyShape(observation) {
  const quotaRef = observation.manifest.quota_profile_ref;
  const watermarkRef = observation.manifest.watermark_policy_ref;
  if (typeof quotaRef !== 'string' || typeof watermarkRef !== 'string'
    || quotaRef.length === 0 || watermarkRef.length === 0 || quotaRef === watermarkRef) throw hold();
  const policies = readExactDataObject(observation.policyIndex, [quotaRef, watermarkRef]);
  for (const [reference, valueKeys] of [[quotaRef, ['soft_quota', 'hard_quota']],
    [watermarkRef, ['low_watermark', 'critical_watermark']]]) {
    const policy = readExactDataObject(policies[reference], POLICY_RECEIPT_KEYS);
    readExactDataObject(policy.values, valueKeys);
  }
}

async function advanceTemporaryClose(state, record) {
  let failure = 'TEMPORARY_OBSERVATION_REJECTED';
  // Declared outside the try: the catch below reads pendingAction to decide
  // whether an action may already have reached the platform.
  const temporary = { pendingAction: null, requests: {}, receipts: {}, decision: null };
  record.temporaryClose = temporary;
  try {
    const identity = record.allocationResponse.identity;
    const identitySha256 = computeDetachedSha256(identity);
    // This live-manager journal is private. Durable intent/restart handling is a
    // separate recovery unit; an uncertain action is never replayed by close().
    const same = (left, right) => canonicalizeDetachedSnapshot(left) === canonicalizeDetachedSnapshot(right);
    const requestFor = (type, fields, operationNonce = randomOpaqueValue()) => createAdapterRequest(type, {
      commandId: record.command.commandId,
      resourceId: record.resourceIds.temporaryAllocation,
      scopeId: record.scope.scopeId,
      expectedIdentity: identity,
      expectedIdentitySha256: identitySha256,
      operationNonce,
      timeoutMs: STOP_ACTION_TIMEOUT_MS,
      provenance: adapterProvenance(state.provenance),
      authorizationSha256: state.provenance.authorizationSha256,
      ...fields,
    });
    const receive = async (method, request, type, keys) => {
      temporary.requests[method] = request;
      temporary.pendingAction = freezeContext({ method, requestSha256: request.requestSha256 });
      // u9: durable pre-action intent for the temporary-side call points.
      runtimeIntent(state, record, method, request);
      const receipt = detachedSnapshot(await state.adapter[method](request));
      temporary.receipts[method] = receipt;
      const response = readExactDataObject(receipt, keys);
      if (response.type !== type || response.requestSha256 !== request.requestSha256) throw hold();
      requireEvidenceResponse(response, state.trackerMaxInputBytes);
      if (response.evidenceRefs.some((reference) => reference.length !== 73)) throw hold();
      return receipt;
    };
    const authenticate = (receipt) => {
      if (state.trustedFilesystemResolver(receipt) !== true) throw hold();
      temporary.pendingAction = null;
      // The receipt was accepted by the host resolver, so this action is settled
      // before the manager publishes the decision that depends on it.
      runtimeSettleLatest(state, record, 'CONFIRMED');
    };

    const observationRequest = requestFor('TaskResourceTemporaryObservationRequest1', {
      processAbsenceEvidenceRefs: record.absenceResponse.evidenceRefs,
    });
    const observation = await receive('observeTemporaryRoot', observationRequest,
      'TaskResourceTemporaryObservation1', [
        'type', 'disposition', 'identity', 'manifest', 'policyIndex', 'observation',
        'evidenceRefs', 'requestSha256',
      ]);
    if (observation.disposition !== 'OBSERVED'
      || !validateResourceIdentity2('temporary_allocation', observation.identity).valid
      || !same(observation.identity, identity)) throw hold();
    authenticate(observation);

    failure = 'TEMPORARY_RECLAIM_REJECTED';
    if (!Array.isArray(observation.manifest?.retention_set)
      || observation.manifest.retention_set.length !== 0) throw hold();
    requireTemporaryPolicyShape(observation);
    const reclaim = detachedSnapshot(record.scope.observe(record.resourceIds.temporaryAllocation, {
      manifest: observation.manifest,
      policyIndex: observation.policyIndex,
      child_id: identity.child_id,
      intent: 'reclaim',
      observation: observation.observation,
    }));
    temporary.decision = reclaim;
    if (reclaim.action !== 'RECLAIM_EXACT'
      || reclaim.requires_same_parent_quarantine !== true
      || reclaim.requires_post_removal_absence_check !== true) throw hold();

    failure = 'TEMPORARY_QUARANTINE_REJECTED';
    const parentDirectory = identity.confirmed_parent_directory;
    const quarantineNonce = randomOpaqueValue();
    const quarantinePath = path.join(parentDirectory.path, `.dw-quarantine-${quarantineNonce}`);
    if (quarantinePath === identity.task_directory.path
      || path.dirname(quarantinePath) !== parentDirectory.path
      || !isStrictPathDescendant(parentDirectory.path, quarantinePath)) throw hold();
    const quarantinedDirectory = detachedSnapshot({ ...identity.task_directory, path: quarantinePath });
    const quarantineRequest = requestFor('TaskResourceTemporaryQuarantineRequest1', {
      observationRequestSha256: observationRequest.requestSha256,
      observationReceiptSha256: computeDetachedSha256(observation),
      trackerDecisionSha256: computeDetachedSha256(reclaim),
      parentDirectory,
      taskDirectory: identity.task_directory,
      quarantinePath,
    }, quarantineNonce);
    const quarantine = await receive('quarantineTemporaryRoot', quarantineRequest,
      'TaskResourceTemporaryQuarantine1', [
        'type', 'disposition', 'targetIdentitySha256', 'parentDirectory',
        'quarantinedDirectory', 'identityRevalidated', 'parentRevalidated',
        'destinationPreviouslyAbsent', 'originalEntryAbsent', 'evidenceRefs', 'requestSha256',
      ]);
    if (quarantine.disposition !== 'COMPLETED' || quarantine.targetIdentitySha256 !== identitySha256
      || quarantine.identityRevalidated !== true || quarantine.parentRevalidated !== true
      || quarantine.destinationPreviouslyAbsent !== true || quarantine.originalEntryAbsent !== true
      || !same(quarantine.parentDirectory, parentDirectory)
      || !same(quarantine.quarantinedDirectory, quarantinedDirectory)) throw hold();
    authenticate(quarantine);

    failure = 'TEMPORARY_REMOVAL_REJECTED';
    const removalRequest = requestFor('TaskResourceTemporaryRemovalRequest1', {
      quarantineRequestSha256: quarantineRequest.requestSha256,
      quarantineReceiptSha256: computeDetachedSha256(quarantine),
      parentDirectory,
      quarantinedDirectory,
    });
    const removal = await receive('removeTemporaryRoot', removalRequest,
      'TaskResourceTemporaryRemoval1', [
        'type', 'disposition', 'targetIdentitySha256', 'parentDirectory',
        'quarantinedDirectory', 'identityRevalidated', 'parentRevalidated', 'evidenceRefs', 'requestSha256',
      ]);
    if (removal.disposition !== 'COMPLETED' || removal.targetIdentitySha256 !== identitySha256
      || removal.identityRevalidated !== true || removal.parentRevalidated !== true
      || !same(removal.parentDirectory, parentDirectory)
      || !same(removal.quarantinedDirectory, quarantinedDirectory)) throw hold();
    authenticate(removal);

    failure = 'TEMPORARY_ABSENCE_REJECTED';
    const absenceRequest = requestFor('TaskResourceTemporaryAbsenceRequest1', {
      removalRequestSha256: removalRequest.requestSha256,
      removalReceiptSha256: computeDetachedSha256(removal),
      parentDirectory,
      quarantinePath,
    });
    const absence = await receive('verifyTemporaryAbsent', absenceRequest,
      'TaskResourceTemporaryAbsence1', [
        'type', 'disposition', 'targetIdentitySha256', 'parentDirectory',
        'parentRevalidated', 'quarantinePath', 'absence', 'evidenceRefs', 'requestSha256',
      ]);
    const paths = readExactDataObject(absence.absence, ['originalPathAbsent', 'quarantinePathAbsent']);
    if (absence.disposition !== 'ABSENT_CONFIRMED' || absence.targetIdentitySha256 !== identitySha256
      || absence.parentRevalidated !== true || !same(absence.parentDirectory, parentDirectory)
      || absence.quarantinePath !== quarantinePath
      || paths.originalPathAbsent !== true || paths.quarantinePathAbsent !== true) throw hold();
    authenticate(absence);

    failure = 'TEMPORARY_RELEASE_REJECTED';
    const released = detachedSnapshot(record.scope.confirmRelease(record.resourceIds.temporaryAllocation, {
      identity,
      generation: state.provenance.managerGeneration,
      absenceVerified: true,
      evidenceRefs: absence.evidenceRefs,
    }));
    if (released.releaseConfirmed !== true || released.state !== 'ACTIVE'
      || released.type !== 'temporary_allocation'
      || released.resourceId !== record.resourceIds.temporaryAllocation
      || released.parentResourceId !== null || released.ownerId !== state.provenance.ownerId
      || released.scopeId !== record.scope.scopeId
      || released.generation !== state.provenance.managerGeneration
      || released.boundGeneration !== state.provenance.managerGeneration
      || !same(released.identity, identity)) throw hold();
    temporary.released = released;
    return null;
  } catch (_) {
    // u9 §2.2: an in-flight action may already have reached the platform, so the
    // durable record must not claim a clean rejection. With no action in flight
    // the refusal is conclusive. runtimeSettleLatest is a no-op where authenticate
    // already settled the action, and it never leaves a settled outcome rewritten.
    runtimeSettleLatest(state, record, temporary.pendingAction === null ? 'REJECTED' : 'UNCERTAIN');
    // An action that may already have reached the platform is a real unresolved
    // failure, not a refusal. It is recorded through the real Guard so the durable
    // failure state advances on the same chain as every other runtime fact. The
    // refusal above is already durable and already authenticated, so a failure to
    // add the auxiliary Guard record must not replace it with an internal hold:
    // that would degrade a known fact into an unknown one. The degraded outcome is
    // kept as a named private fact instead of being dropped.
    if (temporary.pendingAction !== null) {
      try {
        runtimeRecordUncertainFailure(state, record, temporary, failure);
      } catch (guardError) {
        temporary.guardRecording = guardError && guardError.code !== undefined
          ? String(guardError.code) : 'FAILURE_GUARD_UNAVAILABLE';
      }
    }
    temporary.pendingAction = null;
    return failure;
  }
}

function sameProvenance(identity, provenance) {
  return identity && identity.owner_id === provenance.ownerId
    && identity.run_id === provenance.runId
    && identity.session_id === provenance.sessionId
    && identity.lease_generation === provenance.managerGeneration
    && identity.platform === provenance.platform;
}

function verifyTemporaryResponse(response, request, provenance) {
  const identity = response.identity;
  if (!validateResourceIdentity2('temporary_allocation', identity).valid
    || response.requestSha256 !== request.requestSha256
    || !sameProvenance(identity, provenance)
    || identity.canonical_root !== request.temporaryRoot
    || !identity.confirmed_parent_directory
    || identity.confirmed_parent_directory.path !== request.temporaryRoot
    || !identity.task_directory
    || !isStrictPathDescendant(request.temporaryRoot, identity.task_directory.path)
    || identity.allocation_id !== request.allocationId
    || identity.child_id !== request.resourceIds.commandSession
    || identity.creation_nonce !== request.creationNonce) throw hold();
}

function verifyProcessResponse(response, request, provenance) {
  const identity = response.identity;
  if (!validateResourceIdentity2('process_tree', identity).valid
    || response.requestSha256 !== request.requestSha256
    || !sameProvenance(identity, provenance)
    || identity.adapter_generation !== provenance.adapterGeneration
    || identity.manager_generation !== provenance.managerGeneration
    || identity.manager_run_id !== provenance.managerRunId
    || identity.launch_nonce !== request.launchNonce) throw hold();
}

function requireActiveBind(scope, resourceId, identity, generation, evidenceRefs) {
  const result = scope.bind(resourceId, { identity, generation, evidenceRefs });
  if (!result || result.state !== 'ACTIVE') throw hold();
}

function normalizeHarness(value) {
  const harness = readExactDataObject(value, HARNESS_KEYS);
  if (harness.type !== 'TaskResourceHarness1' || typeof harness.trustedProducer !== 'function') throw hold();
  return freezeContext({
    type: harness.type,
    harnessId: requireSafeIdentifier(harness.harnessId),
    trustedProducer: harness.trustedProducer,
  });
}

function normalizeAuthorization(value) {
  const authorization = readExactDataObject(value, AUTHORIZATION_KEYS);
  if (authorization.type !== 'TaskResourceAuthorization1'
    || !AUTHORITY_REFERENCE.test(authorization.cleanupAuthorityRef)
    || typeof authorization.allowForceTermination !== 'boolean') throw hold();
  return detachedSnapshot({
    type: authorization.type,
    cleanupAuthorityRef: authorization.cleanupAuthorityRef,
    allowForceTermination: authorization.allowForceTermination,
  });
}

function normalizeAdapter(value) {
  const version = safeDescriptor(value, 'type');
  const keys = version && Object.hasOwn(version, 'value')
    && version.value === 'TaskResourcePlatformAdapter2' ? ADAPTER_V2_KEYS : ADAPTER_KEYS;
  const adapter = readExactDataObject(value, keys);
  if (adapter.type !== version?.value
    || !['TaskResourcePlatformAdapter1', 'TaskResourcePlatformAdapter2'].includes(adapter.type)) throw hold();
  for (const key of keys) {
    if (key !== 'type' && key !== 'adapterId' && typeof adapter[key] !== 'function') throw hold();
  }
  return freezeContext({ ...adapter, adapterId: requireSafeIdentifier(adapter.adapterId) });
}

function normalizeLimitNamespace(value, allowedKeys) {
  const source = readOptionalDataObject(value, allowedKeys);
  for (const item of Object.values(source)) requirePositiveInteger(item);
  return detachedSnapshot(source);
}

function normalizeLimits(value) {
  const source = readOptionalDataObject(value, LIMIT_NAMESPACES);
  const normalized = {};
  if (Object.hasOwn(source, 'tracker')) {
    normalized.tracker = normalizeLimitNamespace(source.tracker, TRACKER_LIMITS);
  }
  if (Object.hasOwn(source, 'recovery')) {
    normalized.recovery = normalizeLimitNamespace(source.recovery, RECOVERY_LIMITS);
  }
  if (Object.hasOwn(source, 'failureLoop')) {
    normalized.failureLoop = normalizeLimitNamespace(source.failureLoop, FAILURE_LOOP_LIMITS);
  }
  return detachedSnapshot(normalized);
}

function normalizeProvenance(value, input, authorizationSha256, supportMatrix) {
  const provenance = readExactDataObject(value, PROVENANCE_KEYS);
  if (provenance.type !== 'TaskResourceProvenance1'
    || provenance.runId !== input.runId
    || provenance.harnessId !== input.harness.harnessId
    || provenance.adapterId !== input.adapter.adapterId
    || provenance.adapterId !== supportMatrix.adapter_id
    || !['windows', 'linux'].includes(provenance.platform)
    || provenance.platform !== supportMatrix.platform
    || provenance.observedAt !== supportMatrix.observed_at
    || provenance.authorizationSha256 !== authorizationSha256
    || !SHA256.test(provenance.authorizationSha256)) throw hold();
  for (const key of ['producerId', 'ownerId', 'sessionId', 'managerRunId']) {
    requireSafeIdentifier(provenance[key]);
  }
  requirePositiveInteger(provenance.managerGeneration);
  requirePositiveInteger(provenance.adapterGeneration);
  return detachedSnapshot(provenance);
}

function collectRequiredReferences(supportMatrix, authorization) {
  const references = new Set([authorization.cleanupAuthorityRef]);
  for (const claim of Object.values(supportMatrix.claims)) {
    for (const reference of claim.evidence_refs) references.add(reference);
  }
  return Object.freeze([...references].sort());
}

function trustedResolution(producer, expectedContext, provenance, resolutionType) {
  return (candidate) => {
    try {
      const context = freezeContext({
        ...expectedContext,
        resolutionType,
        provenance,
      });
      const result = producer(candidate, context);
      if (result !== true) observeRejectedNativePromise(result);
      return result === true;
    } catch (_) {
      return false;
    }
  };
}

// --- 3-6B durable runtime transaction ----------------------------------------
// The manager already records every adapter action in memory before dispatch
// (record.pendingAction). This makes the same facts durable: the Store head is
// opened lazily at the first persisting operation, and STARTED is only published
// once the authenticated result and its Tracker changes are on disk.
function runtimeGuardState(state) {
  if (state.runtime.guardState === null) {
    state.runtime.guardState = createInitialFailureLoopState({
      runId: state.provenance.runId,
      guardId: guardIdFor(state.provenance),
      retryBudget: 0,
      repairBudget: 0,
    });
  }
  return state.runtime.guardState;
}

function runtimeBody(state) {
  return detachedSnapshot({
    schema: 'TaskResourceManagerRuntime1',
    schema_version: 1,
    originalProvenance: state.provenance,
    originalAuthorization: state.authorization,
    originalCapabilityEnvelope: state.capabilityEnvelope,
    commands: state.runtime.commands,
    actions: state.runtime.actions,
    records: [],
    trackerHistory: state.tracker.exportHistory(),
    failureLoopState: runtimeGuardState(state),
    close: {
      admission: state.closeTransaction.admissionClosed,
      phase: state.runtime.phase,
      reason: state.runtime.reason,
      trackerClose: state.runtime.trackerClose,
    },
  });
}

// One durable serialization point. The expected head is read from the runtime
// state at the moment of the write, never from a revision cached before an await.
function runtimePersist(state) {
  const result = state.runtime.store.saveTransaction({
    expectedRevision: state.runtime.revision,
    expectedContentSha256: state.runtime.contentSha256,
    transaction: runtimeBody(state),
  });
  state.runtime.revision = result.revision;
  state.runtime.contentSha256 = result.contentSha256;
  return result;
}

function runtimeOpen(state) {
  if (state.runtime.store !== null) return;
  state.runtime.store = RecoveryStore.open({
    dataRoot: state.dataRoot,
    runId: state.provenance.runId,
    writerId: state.provenance.managerRunId,
    // F11: the validated recovery namespace must actually reach the Store. It can
    // only narrow the stock defaults; nothing here relaxes them.
    ...(state.limits.recovery === undefined ? {} : { limits: state.limits.recovery }),
  });
  state.runtime.revision = 0;
  state.runtime.contentSha256 = null;
}

// --- §2.4 Guard facade -------------------------------------------------------
// The FailureLoopGuard owns a synchronous load/save protocol and authenticates its
// store's receipt by exact field-by-field equality. Both are served from the one
// runtime serialization point, so the Guard state can never advance on a chain of
// its own. Two shape translations are mandatory here and are deliberately written
// out rather than left to chance:
//   1. the Store acknowledges a content digest under a different name and knows
//      nothing about the Guard's identity or revisions, so its receipt must be
//      re-named field by field before the Guard is allowed to see it. Returning
//      the Store receipt unchanged makes every Guard save fail its exact-equality
//      acknowledgement check - a permanent HOLD, not a degraded mode;
//   2. the Guard invokes its resolvers with its own context object, which the
//      manager's trustedResolution would forward as if it were a producer
//      candidate. The two shapes are not interchangeable.
const GUARD_STATE_KEYS = Object.freeze(['schema', 'runId', 'guardId', 'revision', 'previousStateSha256',
  'retryBudget', 'repairBudget', 'retryUsed', 'repairUsed', 'activeFingerprint',
  'operationBindings', 'consumedExitFamilies', 'failures', 'stateSha256']);
const GUARD_LOAD_QUERY_KEYS = Object.freeze(['runId', 'guardId']);
const GUARD_SAVE_CONTEXT_KEYS = Object.freeze(['runId', 'guardId', 'expectedRevision', 'expectedStateSha256']);
const GUARD_TRUST_REQUEST_KEYS = Object.freeze(['type', 'purpose', 'runId', 'guardId', 'stateRevision',
  'previousStateSha256', 'stateSha256', 'acknowledgement', 'observationSha256', 'classification',
  'evidenceRefs']);
const GUARD_DIGEST = /^[0-9a-f]{64}$/;
const FAILURE_OBSERVATION_CODE = Object.freeze({
  phase: 'TEMPORARY_CLOSE',
  errorClass: 'platform_uncertainty',
  hypothesis: 'TEMPORARY_ACTION_UNCERTAIN',
  affectedScope: 'temporary_allocation',
  validationConclusion: 'NOT_VALIDATED',
  classification: 'unknown',
  sideEffectState: 'unknown',
  occurredAt: 'not_observable',
});

function guardIdFor(provenance) {
  return `manager:${provenance.managerRunId}:failure-loop`;
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function sameCanonicalValue(left, right) {
  try {
    return canonicalizeDetachedSnapshot(detachedSnapshot(left))
      === canonicalizeDetachedSnapshot(detachedSnapshot(right));
  } catch (_) {
    return false;
  }
}

// The durable head is read from the Store every time rather than remembered, so a
// Guard acknowledgement is never derived from a value that was cached before an
// await or before another writer's revision.
function runtimeDurableHead(state) {
  if (state.runtime.store === null) return null;
  return state.runtime.store.loadTransaction();
}

function guardFacadeLoad(state, query) {
  if (!hasExactKeys(query, GUARD_LOAD_QUERY_KEYS)
    || query.runId !== state.provenance.runId
    || query.guardId !== guardIdFor(state.provenance)) throw hold();
  // Before the first transaction there is no head, and the Guard must build its
  // own initial state rather than restore one no Store ever accepted.
  const head = runtimeDurableHead(state);
  return head === null ? null : head.transaction.failureLoopState;
}

// Whether an aborted write reached the durable head decides whether the manager's
// in-memory Guard head may be rolled back. A write that did reach it is durable
// uncertainty, and a memory rollback is not a disk rollback.
function runtimeWriteLanded(state, beforeRevision) {
  try {
    const head = runtimeDurableHead(state);
    return head === null ? false : head.revision > beforeRevision;
  } catch (_) {
    // The head can no longer be read, so no rollback can be observed. The
    // conservative answer keeps the new state instead of asserting a disk state
    // the manager cannot see.
    return true;
  }
}

function guardFacadeSave(state, next, context) {
  const head = runtimeGuardState(state);
  const { stateSha256, ...payload } = hasExactKeys(next, GUARD_STATE_KEYS) ? next : {};
  if (!hasExactKeys(next, GUARD_STATE_KEYS) || !hasExactKeys(context, GUARD_SAVE_CONTEXT_KEYS)
    || next.schema !== 'FailureLoopGuardState3'
    || next.runId !== state.provenance.runId || next.guardId !== guardIdFor(state.provenance)
    || context.runId !== next.runId || context.guardId !== next.guardId
    || typeof stateSha256 !== 'string' || !GUARD_DIGEST.test(stateSha256)
    || computeDetachedSha256(payload) !== stateSha256
    || next.retryBudget !== head.retryBudget || next.repairBudget !== head.repairBudget
    || !Number.isSafeInteger(next.retryUsed) || next.retryUsed < head.retryUsed || next.retryUsed > next.retryBudget
    || !Number.isSafeInteger(next.repairUsed) || next.repairUsed < head.repairUsed || next.repairUsed > next.repairBudget) {
    throw hold();
  }
  // The Guard's own initialization write is accepted only when it is byte-identical
  // to the state this manager already holds and its expected head is the empty one.
  // Everything else must be a one-step advance chained to the current head digest.
  // Guard revision and Store revision are compared separately: the Store's compare
  // and swap below is over its own head, which the Guard never sees.
  const initialization = context.expectedRevision === 0 && context.expectedStateSha256 === null
    && sameCanonicalValue(next, head);
  if (!initialization
    && (context.expectedRevision !== head.revision || context.expectedStateSha256 !== head.stateSha256
      || next.revision !== head.revision + 1 || next.previousStateSha256 !== head.stateSha256)) throw hold();
  const openedRevision = state.runtime.revision;
  state.runtime.guardState = next;
  runtimeOpen(state);
  let receipt;
  try {
    receipt = runtimePersist(state);
  } catch (error) {
    if (!runtimeWriteLanded(state, openedRevision)) state.runtime.guardState = head;
    throw error;
  }
  // Full read-back: the Guard is not acknowledged until the manager has re-read
  // the published revision and found this exact state in it.
  const published = runtimeDurableHead(state);
  if (published === null || published.revision !== receipt.revision
    || published.content_sha256 !== receipt.contentSha256
    || !sameCanonicalValue(published.transaction.failureLoopState, next)) throw hold();
  return Object.freeze({
    persisted: receipt.persisted,
    runId: receipt.runId,
    guardId: next.guardId,
    expectedRevision: context.expectedRevision,
    expectedStateSha256: context.expectedStateSha256,
    revision: next.revision,
    previousStateSha256: next.previousStateSha256,
    stateSha256: next.stateSha256,
  });
}

function runtimeGuardStore(state) {
  if (state.runtime.guardStore === null) {
    state.runtime.guardStore = Object.freeze({
      load(query) { return guardFacadeLoad(state, query); },
      save(next, context) { return guardFacadeSave(state, next, context); },
    });
  }
  return state.runtime.guardStore;
}

// The Guard calls each resolver with its own context, so every one of them is
// wrapped by an explicit adapter that turns that context into a producer request.
// Forwarding the Guard context unchanged would deny every acknowledgement.
function guardTrustRequest(fields) {
  return freezeContext({ ...Object.fromEntries(GUARD_TRUST_REQUEST_KEYS.map((key) => [key, null])), ...fields });
}

function guardResolvers(state) {
  const resolve = (resolutionType) => trustedResolution(state.harness.trustedProducer, freezeContext({
    runId: state.provenance.runId,
    harnessId: state.provenance.harnessId,
    adapterId: state.provenance.adapterId,
    authorizationSha256: state.provenance.authorizationSha256,
    requiredReferences: state.requiredReferences,
  }), state.provenance, resolutionType);
  const trustedState = resolve('failure_state');
  const evidence = resolve('failure_evidence');
  const classification = resolve('failure_classification');
  return Object.freeze({
    trustedStateResolver: (context) => trustedState(guardTrustRequest({
      type: 'TaskResourceFailureTrustRequest1',
      purpose: context.purpose,
      runId: context.runId,
      guardId: context.guardId,
      stateRevision: context.stateRevision,
      previousStateSha256: context.previousStateSha256,
      stateSha256: context.stateSha256,
      acknowledgement: context.acknowledgement === undefined ? null : context.acknowledgement,
    })),
    evidenceResolver: (context) => evidence(guardTrustRequest({
      type: 'TaskResourceFailureTrustRequest1',
      purpose: context.purpose,
      runId: context.runId,
      guardId: context.guardId,
      observationSha256: computeDetachedSha256(context.observation),
      evidenceRefs: context.evidenceRefs,
    })),
    // An unauthenticated classification must stay null: returning the observation's
    // own claim would let the Guard certify a classification no producer confirmed.
    classificationResolver: (context) => (classification(guardTrustRequest({
      type: 'TaskResourceFailureTrustRequest1',
      purpose: context.purpose,
      runId: state.provenance.runId,
      guardId: guardIdFor(state.provenance),
      observationSha256: computeDetachedSha256(context.observation),
      classification: context.observation.classification,
    })) ? context.observation.classification : null),
    // No exit is authorized on this chain in this unit: exit selection and writer
    // takeover belong to 3-6D, so the answer is a registered refusal, not an
    // inference from the observation.
    authorizationResolver: () => false,
  });
}

function runtimeGuard(state) {
  if (state.runtime.guard === null) {
    state.runtime.guard = new FailureLoopGuard({
      runId: state.provenance.runId,
      guardId: guardIdFor(state.provenance),
      retryBudget: 0,
      repairBudget: 0,
      store: runtimeGuardStore(state),
      ...guardResolvers(state),
    });
  }
  return state.runtime.guard;
}

// A failure that the manager can only describe in controlled, already-registered
// terms. Every hash and reference binds to a fact this chain already recorded, and
// the Guard is left to produce the successor state itself - the manager never
// assembles a Guard state by hand.
function runtimeRecordUncertainFailure(state, record, temporary, errorCode) {
  if (runtimeCommandEntry(state, record) === undefined) return;
  const unsettled = state.runtime.actions.filter((action) =>
    action.commandId === record.command.commandId && action.outcome !== null
    && action.outcome.status === 'UNCERTAIN');
  if (unsettled.length === 0) return;
  runtimeGuard(state).recordFailure({
    ...FAILURE_OBSERVATION_CODE,
    checkpoint: temporary.pendingAction.method,
    errorCode,
    commandId: record.command.commandId,
    inputHashes: [unsettled[unsettled.length - 1].requestSha256],
    artifactHashes: [],
    environmentIdentity: `adapter:${state.provenance.adapterId}:gen:${state.provenance.adapterGeneration}`,
    evidenceRefs: state.requiredReferences,
    lastSuccessfulState: `phase:${FAILURE_OBSERVATION_CODE.phase};actions:${state.runtime.actions.length}`,
    resources: detachedSnapshot({
      commandId: record.command.commandId,
      scopeId: record.scope.scopeId,
      resourceIds: record.resourceIds,
    }),
  });
}

function runtimeCommandEntry(state, record) {
  return state.runtime.commands.find((entry) => entry.commandId === record.command.commandId);
}

// A write failure before dispatch must leave zero platform actions taken, so the
// caller converts any non-hold failure into the controlled manager hold.
function runtimeRecordCommand(state, record) {
  state.runtime.commands.push({
    commandId: record.command.commandId,
    scopeId: `command:${record.command.commandId}`,
    resourceIds: record.resourceIds,
    timeoutMs: record.command.timeoutMs,
    state: 'OPEN',
    actionOrdinals: [],
  });
  runtimePersist(state);
}

function runtimeIntent(state, record, method, request) {
  if (state.runtime.store === null) return;
  // A command outside the runtime chain — the bootstrap-verification seam keeps
  // its own chain — contributes no actions to it. Checked before the journal is
  // mutated, so a command that is refused here cannot leave an orphaned action.
  const entry = runtimeCommandEntry(state, record);
  if (entry === undefined) return;
  const sequence = state.runtime.actions.length + 1;
  // The predecessor is a REAL dependency, not merely the previous line: a spawn
  // depends on this command's allocation when one was requested and on nothing
  // when it was not. Declaring a false dependency would let one unresolved action
  // block unrelated later work, which the contract does not ask for.
  let predecessor = null;
  if (method === 'spawnManaged') {
    const allocation = state.runtime.actions.find((candidate) =>
      candidate.commandId === record.command.commandId && candidate.method === 'allocateTemporaryRoot');
    if (allocation !== undefined) predecessor = allocation.sequence;
  }
  state.runtime.actions.push({
    sequence,
    commandId: record.command.commandId,
    method,
    requestSha256: request.requestSha256,
    // The real operation nonce, so a recovery reader can bind this intent to the
    // adapter request it authorised rather than only to a request digest. N4: this
    // is fail-closed — a request without a usable nonce must not be recorded as a
    // silently unbound intent.
    nonce: (() => {
      // The process-side requests carry launchNonce; the temporary-side requests
      // carry operationNonce. The contract asks for the real operation/launch
      // nonce, so either is the right binding — but a request carrying neither
      // must fail closed rather than be recorded as an unbound intent.
      for (const candidate of [request.launchNonce, request.operationNonce]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      throw hold();
    })(),
    resourceIds: record.resourceIds,
    predecessor,
    intent: { type: method, phase: record.phase },
    outcome: null,
  });
  entry.actionOrdinals.push(sequence);
  runtimePersist(state);
}

// Settles the command's newest still-unresolved action. Used where the caller
// knows an action completed but not which method it was, so the same guard as
// runtimeOutcome applies: nothing is settled for a command outside the chain.
function runtimeSettleLatest(state, record, status) {
  if (state.runtime.store === null) return;
  if (runtimeCommandEntry(state, record) === undefined) return;
  const actions = state.runtime.actions;
  for (let cursor = actions.length - 1; cursor >= 0; cursor -= 1) {
    if (actions[cursor].commandId === record.command.commandId) {
      if (actions[cursor].outcome !== null) return;
      actions[cursor].outcome = { status, identitySha256: null };
      runtimePersist(state);
      return;
    }
  }
}

function runtimeOutcome(state, record, method, status, identitySha256) {
  if (state.runtime.store === null) return;
  // Mirror of the intent-side guard: a command outside the runtime chain settles
  // nothing here. Without this the verification path would throw AFTER its platform
  // action had already run, leaving a performed action with no durable intent at
  // all — the exact inversion of this unit's invariant.
  if (runtimeCommandEntry(state, record) === undefined) return;
  const actions = state.runtime.actions;
  let index = -1;
  for (let cursor = actions.length - 1; cursor >= 0; cursor -= 1) {
    if (actions[cursor].method === method && actions[cursor].commandId === record.command.commandId) {
      index = cursor;
      break;
    }
  }
  if (index < 0 || actions[index].outcome !== null) throw hold();
  actions[index].outcome = { status, identitySha256: identitySha256 ?? null };
  runtimePersist(state);
}

class TaskResourceManager {
  constructor(token, state) {
    if (token !== CONSTRUCTOR_TOKEN) throw hold();
    PRIVATE_STATE.set(this, state);
    Object.freeze(this);
  }

  static open(value) {
    try {
      const options = readExactDataObject(value, TOP_LEVEL_KEYS);
      if (typeof options.runId !== 'string' || !RUN_ID.test(options.runId)) throw hold();
      const input = freezeContext({
        runId: options.runId,
        dataRoot: normalizeDataRoot(options.dataRoot),
        harness: normalizeHarness(options.harness),
        adapter: normalizeAdapter(options.platformAdapter),
        authorization: normalizeAuthorization(options.authorization),
        limits: normalizeLimits(options.limits),
      });
      const trackerMaxInputBytes = input.limits.tracker?.maxInputBytes
        ?? DEFAULT_TRACKER_MAX_INPUT_BYTES;
      const trackerLimits = detachedSnapshot({
        ...(input.limits.tracker || {}),
        maxInputBytes: trackerMaxInputBytes,
      });
      const authorizationSha256 = computeDetachedSha256(input.authorization);
      const probeContext = freezeContext({
        type: 'TaskResourceCapabilityProbe1',
        runId: input.runId,
        harnessId: input.harness.harnessId,
        adapterId: input.adapter.adapterId,
      });
      const envelope = detachedSnapshot(input.adapter.probeCapabilities(probeContext));
      const envelopeFields = readExactDataObject(envelope, ENVELOPE_KEYS);
      if (envelopeFields.type !== 'TaskResourceCapabilityEnvelope1') throw hold();
      const supportValidation = validateSupportMatrix2(envelopeFields.supportMatrix);
      if (!supportValidation || supportValidation.valid !== true) throw hold();
      const provenance = normalizeProvenance(
        envelopeFields.provenance,
        input,
        authorizationSha256,
        envelopeFields.supportMatrix,
      );
      const requiredReferences = collectRequiredReferences(envelopeFields.supportMatrix, input.authorization);
      const expectedContext = freezeContext({
        runId: input.runId,
        harnessId: input.harness.harnessId,
        adapterId: input.adapter.adapterId,
        authorizationSha256,
        requiredReferences,
      });
      const admitted = input.harness.trustedProducer(envelope, expectedContext);
      if (admitted !== true) { observeRejectedNativePromise(admitted); throw hold(); }
      const trustedObservationResolver = trustedResolution(
        input.harness.trustedProducer,
        expectedContext,
        provenance,
        'observation',
      );
      const trustedFilesystemResolver = trustedResolution(
        input.harness.trustedProducer,
        expectedContext,
        provenance,
        'filesystem',
      );
      const tracker = new TaskResourceTracker({
        ownerId: provenance.ownerId,
        runId: input.runId,
        generation: provenance.managerGeneration,
        trustedObservationResolver,
        trustedFilesystemResolver,
        limits: trackerLimits,
      });
      const rootScope = tracker.openRootScope({
        scopeId: provenance.managerRunId,
        purpose: 'task_resource_manager',
      });
      return new TaskResourceManager(CONSTRUCTOR_TOKEN, freezeContext({
        adapter: input.adapter,
        authorization: input.authorization,
        capabilityEnvelope: envelope,
        commands: new Map(),
        closeTransaction: {
          admissionClosed: false,
          phase: 'OPEN',
          attempt: undefined,
          terminalResult: null,
          busyResult: managerCloseResult('CLOSING', 'CLOSE_ATTEMPT_IN_PROGRESS'),
        },
        dataRoot: input.dataRoot,
        harness: input.harness,
        limits: input.limits,
        provenance,
        requiredReferences,
        rootScope,
        // 3-6B: the outer state is frozen, so the lazily created durable head and
        // the append-only action journal live in this pre-built mutable object.
        runtime: {
          store: null,
          revision: 0,
          contentSha256: null,
          commands: [],
          actions: [],
          guard: null,
          guardStore: null,
          guardState: null,
          phase: 'OPEN',
          reason: null,
          trackerClose: 'NONE',
        },
        tracker,
        trackerMaxInputBytes,
        trustedFilesystemResolver,
        trustedObservationResolver,
      }));
    } catch (_) {
      throw hold();
    }
  }

  async startCommand(value) {
    let command;
    let state;
    let record;
    let attempt;
    try {
      const normalized = normalizeCommandInput(value);
      command = normalized.command;
      const verification = normalized.verification;
      state = PRIVATE_STATE.get(this);
      if (!state || state.closeTransaction.admissionClosed
        || state.commands.has(command.commandId)) throw hold();
      let holderState = null;
      if (verification) {
        holderState = BOOTSTRAP_HOLDER_STATE.get(verification.bootstrapVerificationHolder);
        if (!holderState || holderState.trustedProducer !== state.harness.trustedProducer
          || holderState.used || holderState.grant !== null) throw hold();
      }
      attempt = Symbol('TaskResourceManager.startCommand');
      record = {
        status: 'STARTING',
        command,
        scope: null,
        resourceIds: null,
        phase: 'INPUT_ACCEPTED',
        pendingAction: null,
        allocationResponse: null,
        spawnResponse: null,
        observationResponse: null,
        observationAttempt: undefined,
        startAttempt: attempt,
        scopeClosed: false,
        bootstrapGrant: null,
      };
      state.commands.set(command.commandId, record);

      requireVerifiedCapability(state.capabilityEnvelope.supportMatrix, 'process_identity');
      if (command.temporaryRoot !== null) {
        requireVerifiedCapability(state.capabilityEnvelope.supportMatrix, 'temporary_lease');
      }
      if (state.provenance.adapterGeneration !== state.provenance.managerGeneration) throw hold();

      const scope = state.rootScope.openChild({
        scopeId: `command:${command.commandId}`,
        purpose: 'managed_command',
      });
      const resourceIds = resourceIdsFor(command.commandId, command.temporaryRoot !== null);
      record.scope = scope;
      record.resourceIds = resourceIds;
      record.phase = 'REGISTERING';
      if (resourceIds.temporaryAllocation !== null) {
        scope.register({
          resourceId: resourceIds.temporaryAllocation,
          type: 'temporary_allocation',
          purpose: 'task_temporary_directory',
          teardownCondition: 'allocation_absence_verified',
          quota: null,
          evidenceRefs: state.requiredReferences,
        });
      }
      scope.register({
        resourceId: resourceIds.commandSession,
        type: 'command_session',
        purpose: 'managed_command_session',
        teardownCondition: 'identity_absence_verified',
        quota: { timeoutMs: command.timeoutMs },
        evidenceRefs: state.requiredReferences,
        parentResourceId: resourceIds.temporaryAllocation,
      });
      scope.register({
        resourceId: resourceIds.processTree,
        type: 'process_tree',
        purpose: 'managed_command_process_tree',
        teardownCondition: 'identity_absence_verified',
        quota: { timeoutMs: command.timeoutMs },
        evidenceRefs: state.requiredReferences,
        parentResourceId: resourceIds.commandSession,
      });
      record.phase = 'REGISTERED';

      // 3-6B: the first persisting operation opens the durable head and records
      // the command that the following intents belong to. This runs after the
      // real Tracker prefix exists and before any platform action, so a Store
      // that cannot be established yields a controlled HOLD with zero actions.
      // The bootstrap-verification command keeps its own pre-existing chain.
      if (!verification) {
        try {
          runtimeOpen(state);
          runtimeRecordCommand(state, record);
        } catch (error) {
          if (error instanceof TaskResourceManagerError) throw error;
          throw hold();
        }
      }

      if (verification) bindBootstrapGrant(this, state, record, verification, holderState, attempt);

      if (state.closeTransaction.admissionClosed) throw hold();

      const provenance = adapterProvenance(state.provenance);
      const launchNonce = randomOpaqueValue();
      let temporaryAllocationIdentity = null;
      if (command.temporaryRoot !== null) {
        const allocationId = randomOpaqueValue();
        const creationNonce = randomOpaqueValue();
        const allocationRequest = createAdapterRequest('TaskResourceTemporaryAllocationRequest1', {
          commandId: command.commandId,
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          timeoutMs: command.timeoutMs,
          temporaryRoot: command.temporaryRoot,
          resourceIds,
          allocationId,
          creationNonce,
          launchNonce,
          provenance,
        });
        record.pendingAction = freezeContext({
          action: 'allocateTemporaryRoot',
          requestSha256: allocationRequest.requestSha256,
          resourceIds,
          launchNonce,
          allocationId,
          creationNonce,
        });
        runtimeIntent(state, record, 'allocateTemporaryRoot', allocationRequest);
        const allocationValue = record.bootstrapGrant
          ? invokeBootstrapFirstAction(state, record, attempt,
            () => state.adapter.allocateTemporaryRoot(allocationRequest), 'ALLOCATING_TEMPORARY_ROOT')
          : state.adapter.allocateTemporaryRoot(allocationRequest);
        const allocationResolved = await allocationValue;
        if (record.bootstrapGrant) requireBootstrapStartOpen(state, record, attempt);
        const allocationResponse = normalizeAdapterResponse(allocationResolved);
        record.phase = 'ALLOCATING_TEMPORARY_ROOT';
        if (state.trustedFilesystemResolver(allocationResponse) !== true) throw hold();
        if (record.bootstrapGrant) requireBootstrapStartOpen(state, record, attempt);
        verifyTemporaryResponse(allocationResponse, allocationRequest, provenance);
        record.allocationResponse = allocationResponse;
        record.pendingAction = null;
        record.phase = 'TEMPORARY_ROOT_CONFIRMED';
        requireActiveBind(
          scope,
          resourceIds.temporaryAllocation,
          allocationResponse.identity,
          provenance.managerGeneration,
          allocationResponse.evidenceRefs,
        );
        record.phase = 'TEMPORARY_ROOT_BOUND';
        temporaryAllocationIdentity = allocationResponse.identity;
        runtimeOutcome(state, record, 'allocateTemporaryRoot', 'CONFIRMED',
          computeDetachedSha256(allocationResponse.identity));
      }

      // An admitted allocation may bind after close, but it cannot launch new work.
      if (state.closeTransaction.admissionClosed) throw hold();
      const spawnFields = {
        commandId: command.commandId,
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
        temporaryRoot: command.temporaryRoot,
        resourceIds,
        allocationId: null,
        creationNonce: null,
        launchNonce,
        temporaryAllocationIdentity,
        provenance,
      };
      if (command.commandVersion === 2) {
        spawnFields.gracefulShutdownSha256 = command.gracefulShutdownSha256;
      }
      const spawnRequest = createAdapterRequest(
        command.commandVersion === 2 ? 'TaskResourceSpawnRequest2' : 'TaskResourceSpawnRequest1',
        spawnFields,
      );
      record.pendingAction = freezeContext({
        action: 'spawnManaged',
        requestSha256: spawnRequest.requestSha256,
        resourceIds,
        launchNonce,
        allocationId: null,
        creationNonce: null,
      });
      record.phase = 'SPAWNING';
      runtimeIntent(state, record, 'spawnManaged', spawnRequest);
      const spawnValue = record.bootstrapGrant && command.temporaryRoot === null
        ? invokeBootstrapFirstAction(state, record, attempt,
          () => state.adapter.spawnManaged(spawnRequest), 'SPAWNING')
        : state.adapter.spawnManaged(spawnRequest);
      const spawnResolved = await spawnValue;
      if (record.bootstrapGrant) requireBootstrapStartOpen(state, record, attempt);
      const spawnResponse = normalizeAdapterResponse(spawnResolved);
      if (state.trustedObservationResolver(spawnResponse) !== true) throw hold();
      if (record.bootstrapGrant) requireBootstrapStartOpen(state, record, attempt);
      verifyProcessResponse(spawnResponse, spawnRequest, provenance);
      record.spawnResponse = spawnResponse;
      record.pendingAction = null;
      record.phase = 'SPAWN_CONFIRMED';
      requireActiveBind(
        scope,
        resourceIds.commandSession,
        spawnResponse.identity,
        provenance.managerGeneration,
        spawnResponse.evidenceRefs,
      );
      requireActiveBind(
        scope,
        resourceIds.processTree,
        spawnResponse.identity,
        provenance.managerGeneration,
        spawnResponse.evidenceRefs,
      );
      record.phase = 'BOUND';
      runtimeOutcome(state, record, 'spawnManaged', 'CONFIRMED',
        computeDetachedSha256(spawnResponse.identity));
      if (record.bootstrapGrant) requireBootstrapStartOpen(state, record, attempt);
      record.status = 'STARTED';
      record.phase = 'STARTED';
      return Object.freeze({
        status: 'STARTED',
        commandId: command.commandId,
        resourceId: resourceIds.processTree,
      });
    } catch (_) {
      if (state && command && record && state.commands.get(command.commandId) === record) {
        record.status = 'HOLD';
      }
      throw hold();
    } finally {
      revokeBootstrapGrant(record?.bootstrapGrant);
      if (record && record.startAttempt === attempt) record.startAttempt = undefined;
    }
  }

  async observe(resourceId) {
    const state = PRIVATE_STATE.get(this);
    if (!state || state.closeTransaction.admissionClosed || typeof resourceId !== 'string') throw hold();
    let record = null;
    for (const candidate of state.commands.values()) {
      if (candidate.resourceIds !== null && candidate.resourceIds.processTree === resourceId) {
        record = candidate;
        break;
      }
    }
    if (!record || record.status !== 'STARTED' || record.scope === null
      || record.spawnResponse === null || record.pendingAction !== null
      || record.observationAttempt !== undefined) throw hold();

    const attempt = Symbol('TaskResourceManager.observe');
    record.observationAttempt = attempt;
    try {
      const provenance = adapterProvenance(state.provenance);
      const request = createAdapterRequest('TaskResourceProcessObservationRequest1', {
        commandId: record.command.commandId,
        resourceIds: record.resourceIds,
        spawnRequestSha256: record.spawnResponse.requestSha256,
        launchNonce: record.spawnResponse.identity.launch_nonce,
        expectedIdentity: record.spawnResponse.identity,
        expectedGeneration: state.provenance.managerGeneration,
        expectedScope: { kind: 'scope', value: record.scope.scopeId },
        provenance,
      });
      record.pendingAction = freezeContext({
        action: 'observeProcess',
        requestSha256: request.requestSha256,
        resourceIds: record.resourceIds,
        launchNonce: record.spawnResponse.identity.launch_nonce,
      });
      record.phase = 'OBSERVING';
      // u9: durable pre-action intent for the public observation call point.
      runtimeIntent(state, record, 'observeProcess', request);
      const response = normalizeObservationResponse(
        await state.adapter.observeProcess(request),
        request,
        state.trackerMaxInputBytes,
      );
      if (state.trustedObservationResolver(response) !== true) throw hold();
      record.observationResponse = response;
      record.pendingAction = null;
      // The observation was accepted by the host resolver, so it is settled
      // before the Tracker decision and the public result are published.
      runtimeSettleLatest(state, record, 'CONFIRMED');
      record.phase = 'OBSERVATION_CONFIRMED';
      const decision = detachedSnapshot(record.scope.observe(record.resourceIds.processTree, {
        duplicate_run_lock: false,
        owner_status: 'owned',
        orphaned: false,
        expected_identity: record.spawnResponse.identity,
        observed_identity: response.identity,
        expected_generation: state.provenance.managerGeneration,
        observed_generation: response.identity.lease_generation,
        expected_scope: { kind: 'scope', value: record.scope.scopeId },
        observed_scope: { kind: 'scope', value: record.scope.scopeId },
        graceful: { requested: false, deadline_reached: false, exit_observed: false },
        exact_tree_termination_supported: false,
        absence: { process_absent: false, thread_absent: false, port_absent: false },
        evidence_refs: response.evidenceRefs,
      }));
      if (decision.action === 'HOLD') {
        record.status = 'HOLD';
        record.phase = 'OBSERVATION_HOLD';
        return detachedSnapshot({ status: 'HOLD', resourceId, decision });
      }
      record.phase = 'OBSERVED';
      return detachedSnapshot({ status: 'OBSERVED', resourceId, decision });
    } catch (_) {
      record.status = 'HOLD';
      throw hold();
    } finally {
      if (record.observationAttempt === attempt) record.observationAttempt = undefined;
    }
  }

  async stop(resourceId, options) {
    const state = PRIVATE_STATE.get(this);
    if (!state || state.closeTransaction.admissionClosed || typeof resourceId !== 'string'
      || !PROCESS_TREE_RESOURCE_ID.test(resourceId)) throw hold();
    let record = null;
    for (const candidate of state.commands.values()) {
      if (candidate.resourceIds !== null && candidate.resourceIds.processTree === resourceId) {
        record = candidate;
        break;
      }
    }
    let reasonCode;
    try {
      reasonCode = readExactDataObject(options, ['reason']).reason;
    } catch (_) {
      throw hold();
    }
    return await this.#advanceStop(state, record, reasonCode);
  }

  async #advanceStop(state, record, reasonCode, closeAttempt) {
    if (PRIVATE_STATE.get(this) !== state || !record
      || state.commands.get(record.command.commandId) !== record
      || (closeAttempt === undefined
        ? state.closeTransaction.admissionClosed
        : state.closeTransaction.attempt !== closeAttempt)) throw hold();
    const resourceId = record.resourceIds?.processTree;
    if (!STOP_REASON_CODES.has(reasonCode) || !record || record.scope === null
      || record.spawnResponse === null || record.pendingAction !== null
      || record.observationAttempt !== undefined || record.stopAttempt !== undefined) throw hold();
    if (record.stopReasonCode !== undefined && record.stopReasonCode !== reasonCode) throw hold();
    if (record.status === 'STOPPED' && record.stopResult !== undefined) return record.stopResult;
    if (record.status === 'HOLD') {
      if (record.stopResult !== undefined) return record.stopResult;
      throw hold();
    }
    if (!['STARTED', 'STOP_REQUESTED', 'WAITING'].includes(record.status)) throw hold();

    const attempt = Symbol('TaskResourceManager.stop');
    record.stopAttempt = attempt;
    try {
      const supportMatrix = state.capabilityEnvelope.supportMatrix;
      const provenance = adapterProvenance(state.provenance);
      const boundIdentity = record.spawnResponse.identity;
      const expectedScope = detachedSnapshot({ kind: 'scope', value: record.scope.scopeId });
      const actionTimeoutMs = Math.min(record.command.timeoutMs, STOP_ACTION_TIMEOUT_MS);
      requirePositiveInteger(actionTimeoutMs);
      const savePending = (action, request, phase) => {
        record.pendingAction = freezeContext({
          action,
          requestSha256: request.requestSha256,
          resourceIds: record.resourceIds,
          launchNonce: boundIdentity.launch_nonce,
        });
        record.phase = phase;
        // u9: the same pre-action fact the manager already holds in memory becomes
        // durable before the adapter is dispatched.
        runtimeIntent(state, record, action, request);
      };
      const clearPending = (status) => {
        record.pendingAction = null;
        // The first settle decides the durable class and the continuity rule forbids
        // rewriting it, so every caller must state the class its own action actually
        // established rather than defaulting the whole stop path to CONFIRMED.
        // No default argument: an omitted status is undefined, which canonical-json
        // rejects instead of silently writing a class nobody chose. That rejection
        // reaches the caller as the recovery store's own hold, not as the raw
        // canonical code, because the persist path re-wraps any canonical failure —
        // fail-closed either way, but do not look for CANONICAL_NON_JSON in a log.
        runtimeSettleLatest(state, record, status);
      };
      const trusted = (response) => state.trustedObservationResolver(response) === true;
      const storeWaiting = (decision, phase) => {
        const result = stopResult('WAITING', resourceId, publicStopDecision(
          decision.action,
          decision.reasons,
        ));
        record.status = 'WAITING';
        record.phase = phase;
        record.stopResult = result;
        return result;
      };
      const trackerObservation = (response, graceful, absence) => detachedSnapshot(
        record.scope.observe(record.resourceIds.processTree, {
          duplicate_run_lock: false,
          owner_status: 'owned',
          orphaned: false,
          expected_identity: boundIdentity,
          observed_identity: response.identity,
          expected_generation: state.provenance.managerGeneration,
          observed_generation: response.identity.lease_generation,
          expected_scope: expectedScope,
          observed_scope: expectedScope,
          graceful,
          exact_tree_termination_supported: supportMatrix.claims.process_tree_terminate?.state === 'VERIFIED_FULL'
            && response.exactTreeTerminationSupported === true,
          absence,
          evidence_refs: response.evidenceRefs,
        }),
      );
      const verifyAbsence = async (terminalAction, terminalActionRequestSha256) => {
        const request = createAdapterRequest('TaskResourceProcessAbsenceVerificationRequest1', {
          commandId: record.command.commandId,
          resourceIds: record.resourceIds,
          spawnRequestSha256: record.spawnResponse.requestSha256,
          gracefulRequestSha256: record.gracefulStopResponse.requestSha256,
          terminalAction,
          terminalActionRequestSha256,
          launchNonce: boundIdentity.launch_nonce,
          expectedIdentity: boundIdentity,
          expectedIdentitySha256: computeDetachedSha256(boundIdentity),
          expectedGeneration: state.provenance.managerGeneration,
          expectedScope,
          actionTimeoutMs,
          provenance,
        });
        savePending('verifyProcessAbsent', request, 'VERIFYING_PROCESS_ABSENCE');
        const response = normalizeAbsenceResponse(
          await state.adapter.verifyProcessAbsent(request), request, state.trackerMaxInputBytes,
        );
        if (!trusted(response)) throw hold();
        record.absenceResponse = response;
        // An authenticated ABSENT_CONFIRMED is a confirmed adapter fact and a
        // COMPLETED call is a completed call, so both settle CONFIRMED; any other
        // disposition is the adapter's own authenticated refusal of this action.
        // The tracker release gate below judges whether release may follow and must
        // not reclassify a fact the adapter has already established.
        clearPending(response.disposition === 'ABSENT_CONFIRMED'
          || response.disposition === 'COMPLETED' ? 'CONFIRMED' : 'REJECTED');
        if (response.disposition === 'ABSENT_CONFIRMED') {
          const finalObservation = detachedSnapshot({
            identity: boundIdentity,
            evidenceRefs: response.evidenceRefs,
            exactTreeTerminationSupported: false,
          });
          const decision = trackerObservation(
            finalObservation,
            { requested: true, deadline_reached: false, exit_observed: true },
            {
              process_absent: response.absence.processAbsent,
              thread_absent: response.absence.threadAbsent,
              port_absent: response.absence.portAbsent,
            },
          );
          if (decision.action !== 'OBSERVE_ONLY'
            || !decision.reasons.includes('ABSENCE_VERIFIED')
            || decision.identity_confidence !== 'MATCH'
            || decision.downstream_release_allowed !== true) return stopHold(state, record, resourceId, 'ABSENCE_PROOF_REJECTED');
          const result = stopResult('STOPPED', resourceId, decision);
          record.status = 'STOPPED';
          record.phase = 'STOPPED';
          record.stopResult = result;
          return result;
        }
        if (response.disposition === 'COMPLETED') {
          record.status = 'WAITING';
          record.phase = 'ABSENCE_PENDING';
          record.absencePending = true;
          return storeWaiting(publicStopDecision('WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED']), 'ABSENCE_PENDING');
        }
        return stopHold(state, record, resourceId, `ABSENCE_${response.disposition}`);
      };

      if (record.stopReasonCode === undefined) {
        requireVerifiedCapability(supportMatrix, 'process_identity');
        requireVerifiedCapability(supportMatrix, 'resource_observation');
        requireVerifiedCapability(supportMatrix, 'request_shutdown');
        const request = createAdapterRequest('TaskResourceGracefulStopRequest1', {
          commandId: record.command.commandId,
          resourceIds: record.resourceIds,
          spawnRequestSha256: record.spawnResponse.requestSha256,
          launchNonce: boundIdentity.launch_nonce,
          expectedIdentity: boundIdentity,
          expectedGeneration: state.provenance.managerGeneration,
          expectedScope,
          actionTimeoutMs,
          reasonCode,
          provenance,
        });
        record.stopReasonCode = reasonCode;
        savePending('requestGracefulStop', request, 'REQUESTING_GRACEFUL_STOP');
        const response = normalizeStopActionResponse(
          await state.adapter.requestGracefulStop(request), request, state.trackerMaxInputBytes,
        );
        if (!trusted(response)) throw hold();
        record.gracefulStopResponse = response;
        if (response.disposition !== 'COMPLETED') {
          // The adapter refused this action outright, so the class belongs to it.
          clearPending('REJECTED');
          return stopHold(state, record, resourceId, `GRACEFUL_STOP_${response.disposition}`);
        }
        if (response.identityRevalidated !== true) {
          // A completed call whose identity re-verification did not hold proves
          // neither success nor refusal; rounding it either way would assert a fact
          // nobody established.
          clearPending('UNCERTAIN');
          throw hold();
        }
        clearPending('CONFIRMED');
        record.status = 'STOP_REQUESTED';
        record.phase = 'GRACEFUL_STOP_CONFIRMED';
        const result = stopResult('STOP_REQUESTED', resourceId, publicStopDecision(
          'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
        ));
        record.stopResult = result;
        return result;
      }

      if (record.absencePending === true) {
        return await verifyAbsence(
          record.absenceTerminalAction,
          record.absenceTerminalActionRequestSha256,
        );
      }

      requireVerifiedCapability(supportMatrix, 'process_identity');
      requireVerifiedCapability(supportMatrix, 'resource_observation');
      const request = createAdapterRequest('TaskResourceStopObservationRequest1', {
        commandId: record.command.commandId,
        resourceIds: record.resourceIds,
        spawnRequestSha256: record.spawnResponse.requestSha256,
        gracefulRequestSha256: record.gracefulStopResponse.requestSha256,
        launchNonce: boundIdentity.launch_nonce,
        expectedIdentity: boundIdentity,
        expectedGeneration: state.provenance.managerGeneration,
        expectedScope,
        actionTimeoutMs,
        boundedWaitMs: actionTimeoutMs,
        provenance,
      });
      savePending('observeProcess', request, 'STOP_OBSERVING');
      const response = normalizeStopObservationResponse(
        await state.adapter.observeProcess(request), request, state.trackerMaxInputBytes,
      );
      if (!trusted(response)) throw hold();
      record.stopObservationResponse = response;
      // The observation itself succeeded and was authenticated. A later tracker or
      // authorization refusal rejects the successor, not this completed action.
      clearPending('CONFIRMED');
      const decision = trackerObservation(
        response,
        {
          requested: true,
          deadline_reached: response.graceful.deadlineReached,
          exit_observed: response.graceful.exitObserved,
        },
        { process_absent: false, thread_absent: false, port_absent: false },
      );
      if (decision.action === 'HOLD') return stopHold(state, record, resourceId, decision.reasons[0] || 'STOP_OBSERVATION_HOLD');
      if (decision.action === 'WAIT_BOUNDED') {
        if (response.graceful.exitObserved === true) {
          record.absenceTerminalAction = 'graceful_exit';
          record.absenceTerminalActionRequestSha256 = request.requestSha256;
          return await verifyAbsence('graceful_exit', request.requestSha256);
        }
        return storeWaiting(decision, 'WAITING_FOR_GRACEFUL_EXIT');
      }
      if (decision.action !== 'TERMINATE_EXACT_TREE') {
        return stopHold(state, record, resourceId, 'STOP_DECISION_UNSUPPORTED');
      }
      if (state.authorization.allowForceTermination !== true) {
        return stopHold(state, record, resourceId, 'FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN');
      }
      requireVerifiedCapability(supportMatrix, 'process_tree_terminate');
      if (response.exactTreeTerminationSupported !== true
        || decision.identity_confidence !== 'MATCH'
        || decision.requires_identity_recheck !== true
        || decision.requires_absence_verification !== true) {
        return stopHold(state, record, resourceId, 'FORCE_TERMINATION_NOT_SAFE');
      }
      const terminationRequest = createAdapterRequest('TaskResourceTerminateOwnedTreeRequest1', {
        commandId: record.command.commandId,
        resourceIds: record.resourceIds,
        spawnRequestSha256: record.spawnResponse.requestSha256,
        gracefulRequestSha256: record.gracefulStopResponse.requestSha256,
        observationRequestSha256: request.requestSha256,
        launchNonce: boundIdentity.launch_nonce,
        expectedIdentity: boundIdentity,
        confirmedIdentity: response.identity,
        expectedGeneration: state.provenance.managerGeneration,
        expectedScope,
        actionTimeoutMs,
        forceAuthorization: {
          allowedAtOpen: true,
          authorizationSha256: state.provenance.authorizationSha256,
        },
        reasonCode,
        provenance,
      });
      savePending('terminateOwnedTree', terminationRequest, 'TERMINATING_EXACT_TREE');
      const terminationResponse = normalizeStopActionResponse(
        await state.adapter.terminateOwnedTree(terminationRequest),
        terminationRequest,
        state.trackerMaxInputBytes,
      );
      if (!trusted(terminationResponse)) throw hold();
      record.terminationResponse = terminationResponse;
      if (terminationResponse.disposition !== 'COMPLETED') {
        clearPending('REJECTED');
        return stopHold(state, record, resourceId, `EXACT_TREE_TERMINATION_${terminationResponse.disposition}`);
      }
      if (terminationResponse.identityRevalidated !== true) {
        clearPending('UNCERTAIN');
        throw hold();
      }
      clearPending('CONFIRMED');
      record.absenceTerminalAction = 'force_termination';
      record.absenceTerminalActionRequestSha256 = terminationRequest.requestSha256;
      return await verifyAbsence('force_termination', terminationRequest.requestSha256);
    } catch (_) {
      record.status = 'HOLD';
      record.stopResult = undefined;
      record.stopFailed = true;
      throw hold();
    } finally {
      if (record.stopAttempt === attempt) record.stopAttempt = undefined;
    }
  }

  async close() {
    if (arguments.length !== 0) throw hold();
    const state = PRIVATE_STATE.get(this);
    if (!state) throw hold();
    const transaction = state.closeTransaction;
    if (transaction.terminalResult !== null) return transaction.terminalResult;
    if (transaction.attempt !== undefined) return transaction.busyResult;

    const attempt = Symbol('TaskResourceManager.close');
    transaction.attempt = attempt;
    for (const record of state.commands.values()) revokeBootstrapGrant(record.bootstrapGrant);
    transaction.admissionClosed = true;
    transaction.phase = 'CLOSE_REQUESTED';
    const finish = (reason) => {
      const status = reason === 'ALL_RESOURCES_RELEASED' ? 'CLOSED' : 'HOLD';
      transaction.terminalResult = managerCloseResult(status, reason);
      transaction.phase = status === 'CLOSED' ? 'CLOSED' : 'TERMINAL_HOLD';
      return transaction.terminalResult;
    };
    try {
      const records = [...state.commands.values()].reverse();
      const preflightFailure = closePreflightFailure(state, records);
      transaction.phase = 'CLOSING';
      if (preflightFailure === 'COMMAND_OPERATION_IN_PROGRESS') {
        return managerCloseResult('CLOSING', preflightFailure);
      }
      if (preflightFailure !== null) return finish(preflightFailure);

      const record = records.find((candidate) => candidate.scopeClosed !== true);
      if (record) {
        try {
          if (record.status !== 'STOPPED') {
            const stopped = await this.#advanceStop(
              state, record, record.stopReasonCode ?? 'manager_close', attempt,
            );
            if (stopped.status === 'STOP_REQUESTED' || stopped.status === 'WAITING') {
              return managerCloseResult('CLOSING', 'COMMAND_STOP_IN_PROGRESS');
            }
            if (stopped.status !== 'STOPPED') return finish('COMMAND_STOP_HOLD');
          }
          const processTree = record.scope.getResource(record.resourceIds.processTree);
          if (record.status !== 'STOPPED' || record.pendingAction !== null
            || record.absenceResponse?.disposition !== 'ABSENT_CONFIRMED'
            || processTree.releaseConfirmed !== true) return finish('COMMAND_STOP_HOLD');
        } catch (_) {
          return finish('COMMAND_STOP_HOLD');
        }

        try {
          const session = record.scope.getResource(record.resourceIds.commandSession);
          if (session.releaseConfirmed !== true) {
            const identity = record.spawnResponse.identity;
            const scope = { kind: 'scope', value: record.scope.scopeId };
            const decision = record.scope.observe(record.resourceIds.commandSession, {
              duplicate_run_lock: false,
              owner_status: 'owned',
              orphaned: false,
              expected_identity: identity,
              observed_identity: identity,
              expected_generation: state.provenance.managerGeneration,
              observed_generation: state.provenance.managerGeneration,
              expected_scope: scope,
              observed_scope: scope,
              graceful: { requested: true, deadline_reached: false, exit_observed: true },
              exact_tree_termination_supported: false,
              absence: { process_absent: true, thread_absent: true, port_absent: true },
              evidence_refs: record.absenceResponse.evidenceRefs,
            });
            if (decision.action !== 'OBSERVE_ONLY' || decision.reasons.length !== 1
              || decision.reasons[0] !== 'ABSENCE_VERIFIED'
              || decision.identity_confidence !== 'MATCH'
              || decision.downstream_release_allowed !== true) {
              return finish('COMMAND_SESSION_RELEASE_REJECTED');
            }
          }
        } catch (_) {
          return finish('COMMAND_SESSION_RELEASE_REJECTED');
        }

        if (record.resourceIds.temporaryAllocation !== null) {
          const temporaryFailure = await advanceTemporaryClose(state, record);
          if (temporaryFailure !== null) return finish(temporaryFailure);
        }

        try {
          const closed = await record.scope.close('manager_close');
          const hasTemporary = record.resourceIds.temporaryAllocation !== null;
          if (!verifiedTrackerClose(state, record.scope, closed)
            || closed.order.length !== (hasTemporary ? 3 : 2)
            || closed.order[0] !== record.resourceIds.processTree
            || closed.order[1] !== record.resourceIds.commandSession
            || (hasTemporary && closed.order[2] !== record.resourceIds.temporaryAllocation)) {
            return finish('COMMAND_SCOPE_CLOSE_REJECTED');
          }
          record.scopeClosed = true;
        } catch (_) {
          return finish('COMMAND_SCOPE_CLOSE_REJECTED');
        }
        if (records.some((candidate) => candidate.scopeClosed !== true)) {
          return managerCloseResult('CLOSING', 'COMMANDS_REMAINING');
        }
      }

      try {
        const closed = await state.rootScope.close('manager_close');
        if (!verifiedTrackerClose(state, state.rootScope, closed)) {
          return finish('ROOT_SCOPE_CLOSE_REJECTED');
        }
      } catch (_) {
        return finish('ROOT_SCOPE_CLOSE_REJECTED');
      }
      return finish('ALL_RESOURCES_RELEASED');
    } catch (_) {
      return finish('CLOSE_INTERNAL_HOLD');
    } finally {
      if (transaction.attempt === attempt) transaction.attempt = undefined;
      state.runtime.phase = transaction.phase;
      state.runtime.reason = transaction.terminalResult === null ? null : transaction.terminalResult.reason;
      // The durable head is released through the Store's own lifecycle so the
      // writer lease is never hand-deleted. Only a terminal close releases it: a
      // close that settled on CLOSING still has in-flight operations that need the
      // serialization point. Retained revision files are the product's detailed
      // state; compacting them is 3-6D, not this unit.
      if (state.runtime.store !== null && transaction.terminalResult !== null
        && state.runtime.storeReleased !== true) {
        try {
          // F7: the Store reports the real disposition rather than throwing, so the
          // lease is only recorded as released when it actually was. A retained
          // lease is never hand-deleted, and it is never claimed as released.
          const released = state.runtime.store.close();
          state.runtime.storeReleased = released !== null && typeof released === 'object'
            && released.released === true;
        } catch (_) {
          // An unverifiable lease is retained rather than deleted.
          state.runtime.storeReleased = false;
        }
      }
    }
  }
}

module.exports = { TaskResourceManager, TaskResourceManagerError, createBootstrapSeedVerificationHolder };
