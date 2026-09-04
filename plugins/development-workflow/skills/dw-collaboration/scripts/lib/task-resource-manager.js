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
const PROVENANCE_KEYS = Object.freeze([
  'type', 'runId', 'harnessId', 'producerId', 'ownerId', 'sessionId', 'managerRunId',
  'managerGeneration', 'adapterId', 'adapterGeneration', 'platform', 'observedAt',
  'authorizationSha256',
]);
const ENVELOPE_KEYS = Object.freeze(['type', 'provenance', 'supportMatrix']);
const COMMAND_KEYS = Object.freeze([
  'commandId', 'executable', 'args', 'cwd', 'timeoutMs', 'temporaryRoot',
]);
const ADAPTER_RESPONSE_KEYS = Object.freeze(['identity', 'evidenceRefs', 'requestSha256']);
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

function normalizeCommandInput(value) {
  const input = readExactDataObject(value, COMMAND_KEYS);
  if (typeof input.commandId !== 'string' || !COMMAND_ID.test(input.commandId)
    || typeof input.executable !== 'string' || input.executable.length === 0
    || CONTROL_CHARACTER.test(input.executable)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw hold();
  return freezeContext({
    commandId: input.commandId,
    executable: input.executable,
    args: normalizeCommandArgs(input.args),
    cwd: normalizeNonRootAbsolutePath(input.cwd),
    timeoutMs: input.timeoutMs,
    temporaryRoot: input.temporaryRoot === null ? null : normalizeNonRootAbsolutePath(input.temporaryRoot),
  });
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

function stopHold(record, resourceId, reason) {
  const result = stopResult('HOLD', resourceId, publicStopDecision('HOLD', [reason]));
  record.status = 'HOLD';
  record.phase = 'STOP_HOLD';
  record.stopResult = result;
  return result;
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
  const adapter = readExactDataObject(value, ADAPTER_KEYS);
  if (adapter.type !== 'TaskResourcePlatformAdapter1') throw hold();
  for (const key of ADAPTER_KEYS) {
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
      return producer(candidate, context) === true;
    } catch (_) {
      return false;
    }
  };
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
      if (input.harness.trustedProducer(envelope, expectedContext) !== true) throw hold();
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
        dataRoot: input.dataRoot,
        harness: input.harness,
        limits: input.limits,
        provenance,
        requiredReferences,
        rootScope,
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
    try {
      command = normalizeCommandInput(value);
      state = PRIVATE_STATE.get(this);
      if (!state || state.commands.has(command.commandId)) throw hold();
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
        record.phase = 'ALLOCATING_TEMPORARY_ROOT';
        const allocationResponse = normalizeAdapterResponse(
          await state.adapter.allocateTemporaryRoot(allocationRequest),
        );
        if (state.trustedFilesystemResolver(allocationResponse) !== true) throw hold();
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
      }

      const spawnRequest = createAdapterRequest('TaskResourceSpawnRequest1', {
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
      });
      record.pendingAction = freezeContext({
        action: 'spawnManaged',
        requestSha256: spawnRequest.requestSha256,
        resourceIds,
        launchNonce,
        allocationId: null,
        creationNonce: null,
      });
      record.phase = 'SPAWNING';
      const spawnResponse = normalizeAdapterResponse(await state.adapter.spawnManaged(spawnRequest));
      if (state.trustedObservationResolver(spawnResponse) !== true) throw hold();
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
    }
  }

  async observe(resourceId) {
    const state = PRIVATE_STATE.get(this);
    if (!state || typeof resourceId !== 'string') throw hold();
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
      const response = normalizeObservationResponse(
        await state.adapter.observeProcess(request),
        request,
        state.trackerMaxInputBytes,
      );
      if (state.trustedObservationResolver(response) !== true) throw hold();
      record.observationResponse = response;
      record.pendingAction = null;
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
    if (!state || typeof resourceId !== 'string'
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
      };
      const clearPending = () => { record.pendingAction = null; };
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
        clearPending();
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
            || decision.downstream_release_allowed !== true) return stopHold(record, resourceId, 'ABSENCE_PROOF_REJECTED');
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
        return stopHold(record, resourceId, `ABSENCE_${response.disposition}`);
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
        clearPending();
        if (response.disposition !== 'COMPLETED') {
          return stopHold(record, resourceId, `GRACEFUL_STOP_${response.disposition}`);
        }
        if (response.identityRevalidated !== true) throw hold();
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
      clearPending();
      const decision = trackerObservation(
        response,
        {
          requested: true,
          deadline_reached: response.graceful.deadlineReached,
          exit_observed: response.graceful.exitObserved,
        },
        { process_absent: false, thread_absent: false, port_absent: false },
      );
      if (decision.action === 'HOLD') return stopHold(record, resourceId, decision.reasons[0] || 'STOP_OBSERVATION_HOLD');
      if (decision.action === 'WAIT_BOUNDED') {
        if (response.graceful.exitObserved === true) {
          record.absenceTerminalAction = 'graceful_exit';
          record.absenceTerminalActionRequestSha256 = request.requestSha256;
          return await verifyAbsence('graceful_exit', request.requestSha256);
        }
        return storeWaiting(decision, 'WAITING_FOR_GRACEFUL_EXIT');
      }
      if (decision.action !== 'TERMINATE_EXACT_TREE') {
        return stopHold(record, resourceId, 'STOP_DECISION_UNSUPPORTED');
      }
      if (state.authorization.allowForceTermination !== true) {
        return stopHold(record, resourceId, 'FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN');
      }
      requireVerifiedCapability(supportMatrix, 'process_tree_terminate');
      if (response.exactTreeTerminationSupported !== true
        || decision.identity_confidence !== 'MATCH'
        || decision.requires_identity_recheck !== true
        || decision.requires_absence_verification !== true) {
        return stopHold(record, resourceId, 'FORCE_TERMINATION_NOT_SAFE');
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
      clearPending();
      if (terminationResponse.disposition !== 'COMPLETED') {
        return stopHold(record, resourceId, `EXACT_TREE_TERMINATION_${terminationResponse.disposition}`);
      }
      if (terminationResponse.identityRevalidated !== true) throw hold();
      record.absenceTerminalAction = 'force_termination';
      record.absenceTerminalActionRequestSha256 = terminationRequest.requestSha256;
      return await verifyAbsence('force_termination', terminationRequest.requestSha256);
    } catch (_) {
      record.status = 'HOLD';
      record.stopResult = undefined;
      throw hold();
    } finally {
      if (record.stopAttempt === attempt) record.stopAttempt = undefined;
    }
  }
}

module.exports = { TaskResourceManager, TaskResourceManagerError };
