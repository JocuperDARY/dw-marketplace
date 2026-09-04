'use strict';

const path = require('path');

const {
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');
const { validateSupportMatrix2 } = require('./identity-support-v2');
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
        limits: input.limits.tracker,
      });
      const rootScope = tracker.openRootScope({
        scopeId: provenance.managerRunId,
        purpose: 'task_resource_manager',
      });
      return new TaskResourceManager(CONSTRUCTOR_TOKEN, freezeContext({
        adapter: input.adapter,
        authorization: input.authorization,
        capabilityEnvelope: envelope,
        dataRoot: input.dataRoot,
        harness: input.harness,
        limits: input.limits,
        provenance,
        requiredReferences,
        rootScope,
        tracker,
        trustedFilesystemResolver,
        trustedObservationResolver,
      }));
    } catch (_) {
      throw hold();
    }
  }
}

module.exports = { TaskResourceManager, TaskResourceManagerError };
