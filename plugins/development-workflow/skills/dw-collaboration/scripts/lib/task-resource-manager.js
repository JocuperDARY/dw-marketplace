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
const CONTROL_CHARACTER = /[\0\r\n]/;
const DEFAULT_TRACKER_MAX_INPUT_BYTES = 64 * 1024;

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
}

module.exports = { TaskResourceManager, TaskResourceManagerError };
