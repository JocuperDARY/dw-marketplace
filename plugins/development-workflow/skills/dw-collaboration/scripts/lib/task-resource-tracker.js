'use strict';

const {
  canonicalize,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');
const {
  decideProcessRecovery,
  decideTemporaryLease,
} = require('./contracts');
const {
  validateProcessIdentity,
} = require('./state-machines');
const {
  validateResourceIdentity2,
} = require('./identity-support-v2');

const PROCESS_V2_RESOURCE_TYPES = new Set([
  'process_tree',
  'command_session',
]);
const HARNESS_RESOURCE_TYPES = new Set([
  'agent_session',
  'runtime_thread',
]);
const LEGACY_PROCESS_IDENTITY_KEYS = new Set([
  'pid',
  'native_handle',
  'start_time',
  'exe_path_hash',
  'argv_hash',
  'parent_identity_hash',
  'nonce',
  'native_process_manager_run_id',
  'confidence',
]);
const LEGACY_PROCESS_REQUIRED_KEYS = [
  'pid',
  'native_handle',
  'start_time',
  'exe_path_hash',
  'argv_hash',
  'parent_identity_hash',
  'nonce',
  'native_process_manager_run_id',
];
const V2_EXCLUSIVE_KEYS = new Set([
  'schema',
  'schema_version',
  'platform',
  'adapter_generation',
  'manager_generation',
  'launch_nonce',
  'harness_kind',
  'harness_instance_id',
  'agent_id',
  'thread_id',
  'allocation_id',
  'task_directory',
  'confirmed_parent_directory',
  'creation_nonce',
]);

const PROCESS_RESOURCE_TYPES = new Set([
  'agent_session',
  'runtime_thread',
  'process_tree',
  'terminal_session',
  'command_session',
  'port',
  'constrained_compute',
]);
const RESOURCE_TYPES = new Set([
  ...PROCESS_RESOURCE_TYPES,
  'temporary_allocation',
  'artifact',
]);
const HISTORY_KINDS = new Set([
  'SCOPE_OPENED',
  'RESOURCE_REGISTERED',
  'RESOURCE_BOUND',
  'RESOURCE_OBSERVED',
  'RESOURCE_RELEASE_CONFIRMED',
  'RESOURCE_RETENTION_CONFIRMED',
  'RESOURCE_HELD',
  'SCOPE_CLOSE_REQUESTED',
  'SCOPE_CLOSE_EVALUATED',
  'TASK_SCOPE_CLAIMED',
  'TASK_CLOSE_CONSUMED',
]);
const DEFAULT_LIMITS = Object.freeze({
  maxScopes: 1024,
  maxResources: 8192,
  maxHistoryEvents: 65536,
  maxInputBytes: 64 * 1024,
  maxEventBytes: 256 * 1024,
  maxHistoryBytes: 4 * 1024 * 1024,
  maxStateBytes: 4 * 1024 * 1024,
});
const SHA256 = /^[0-9a-f]{64}$/;

class ResourceTrackerError extends Error {
  constructor(code, message = code) {
    super(`${code}: ${message}`);
    this.name = 'ResourceTrackerError';
    this.code = code;
  }
}

function detached(value) {
  return createDetachedJsonSnapshot(value).snapshot;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireString(value, code, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResourceTrackerError(code, `${field} must be a non-empty string`);
  }
  return value;
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ResourceTrackerError('GENERATION_INVALID', 'generation must be a positive safe integer');
  }
  return value;
}

function requireEvidenceRefs(value, code = 'EVIDENCE_REFS_INVALID') {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new ResourceTrackerError(code, 'evidenceRefs must contain non-empty strings');
  }
  return Array.from(new Set(value));
}

function sameValue(left, right) {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch (_) {
    return false;
  }
}

function valueBytes(value) {
  return Buffer.byteLength(canonicalize(value), 'utf8');
}

function normalizeLimits(value) {
  const limits = { ...DEFAULT_LIMITS, ...(value || {}) };
  for (const field of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 1) {
      throw new ResourceTrackerError('TRACKER_LIMIT_INVALID', `${field} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function jsonObservation(value, omittedKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResourceTrackerError('RESOURCE_OBSERVATION_INVALID');
  }
  const omitted = new Set(omittedKeys);
  return detached(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key))));
}

function resolverAccepts(resolver, context) {
  if (typeof resolver !== 'function') return false;
  try {
    return resolver(detached(context)) === true;
  } catch (_) {
    return false;
  }
}

function cloneRecord(record) {
  return detached({
    resourceId: record.resourceId,
    type: record.type,
    ownerId: record.ownerId,
    scopeId: record.scopeId,
    parentScopeId: record.parentScopeId,
    parentResourceId: record.parentResourceId,
    generation: record.generation,
    purpose: record.purpose,
    quota: record.quota,
    teardownCondition: record.teardownCondition,
    acquisitionOrder: record.acquisitionOrder,
    state: record.state,
    evidenceRefs: record.evidenceRefs,
    identity: record.identity,
    boundGeneration: record.boundGeneration,
    decision: record.decision,
    releaseConfirmed: record.releaseConfirmed,
  });
}

function validateTemporaryIdentity(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && typeof identity.owner_id === 'string' && identity.owner_id !== ''
    && typeof identity.run_id === 'string' && identity.run_id !== ''
    && typeof identity.session_id === 'string' && identity.session_id !== ''
    && Number.isSafeInteger(identity.lease_generation) && identity.lease_generation > 0
    && SHA256.test(identity.manifest_sha256 || '')
    && identity.canonical_root_identity && typeof identity.canonical_root_identity === 'object'
    && typeof identity.child_id === 'string' && identity.child_id !== '';
}

function hasV2IdentityIntent(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).some((key) => V2_EXCLUSIVE_KEYS.has(key));
}

function isStrictLegacyProcessIdentity(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && LEGACY_PROCESS_REQUIRED_KEYS.every((key) => hasOwn(identity, key))
    && Object.keys(identity).every((key) => LEGACY_PROCESS_IDENTITY_KEYS.has(key));
}

function trackerIdentityError(code, path, message) {
  return { code, path, message };
}

function structuredIdentityHold(errors, disposition = 'HOLD') {
  return detached({
    valid: false,
    disposition,
    action_authorized: false,
    errors,
  });
}

const TRACKER_SCOPE_OPERATIONS = new WeakMap();

class ResourceScope {
  #operations;

  constructor(tracker, scopeId) {
    const operations = TRACKER_SCOPE_OPERATIONS.get(tracker);
    if (!operations) throw new ResourceTrackerError('TRACKER_INSTANCE_INVALID');
    this.#operations = operations;
    Object.defineProperty(this, 'scopeId', {
      value: scopeId,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.freeze(this);
  }

  openChild(input) {
    return this.#operations.openChild(this.scopeId, input);
  }

  register(input) {
    return this.#operations.register(this.scopeId, input);
  }

  bind(resourceId, observation) {
    return this.#operations.bind(this.scopeId, resourceId, observation);
  }

  observe(resourceId, observation) {
    return this.#operations.observe(this.scopeId, resourceId, observation);
  }

  confirmRelease(resourceId, observation) {
    return this.#operations.confirmRelease(this.scopeId, resourceId, observation);
  }

  confirmRetention(resourceId, observation) {
    return this.#operations.confirmRetention(this.scopeId, resourceId, observation);
  }

  close(reason) {
    return this.#operations.close(this.scopeId, reason);
  }

  getResource(resourceId) {
    return this.#operations.getResource(this.scopeId, resourceId);
  }

  snapshot() {
    return this.#operations.snapshot(this.scopeId);
  }
}

class TaskResourceTracker {
  #trustedObservationResolver;
  #trustedFilesystemResolver;
  #limits;
  #scopes;
  #resources;
  #taskClaims;
  #scopeClaims;
  #consumedTaskCloses;
  #history;
  #historyBytes;
  #sequence;
  #revision;
  #acquisitionOrder;
  #rootScopeId;
  #historyHeadSha256;
  #replaying;

  constructor(options = {}) {
    if (hasOwn(options, 'processDecision') || hasOwn(options, 'temporaryDecision')) {
      throw new ResourceTrackerError('DECISION_OVERRIDE_FORBIDDEN');
    }
    const ownerId = requireString(options.ownerId, 'OWNER_INVALID', 'ownerId');
    const runId = requireString(options.runId, 'RUN_ID_INVALID', 'runId');
    const generation = requireGeneration(options.generation);
    Object.defineProperties(this, {
      ownerId: { value: ownerId, enumerable: true, configurable: false, writable: false },
      runId: { value: runId, enumerable: true, configurable: false, writable: false },
      generation: { value: generation, enumerable: true, configurable: false, writable: false },
    });
    this.#trustedObservationResolver = options.trustedObservationResolver || null;
    if (this.#trustedObservationResolver !== null && typeof this.#trustedObservationResolver !== 'function') {
      throw new ResourceTrackerError('OBSERVATION_RESOLVER_INVALID');
    }
    this.#trustedFilesystemResolver = options.trustedFilesystemResolver || null;
    if (this.#trustedFilesystemResolver !== null && typeof this.#trustedFilesystemResolver !== 'function') {
      throw new ResourceTrackerError('FILESYSTEM_RESOLVER_INVALID');
    }
    this.#limits = normalizeLimits(options.limits);
    this.#scopes = new Map();
    this.#resources = new Map();
    this.#taskClaims = new Map();
    this.#scopeClaims = new Map();
    this.#consumedTaskCloses = new Map();
    this.#history = [];
    this.#historyBytes = 0;
    this.#sequence = 0;
    this.#revision = 0;
    this.#acquisitionOrder = 0;
    this.#rootScopeId = null;
    this.#historyHeadSha256 = null;
    this.#replaying = false;
    TRACKER_SCOPE_OPERATIONS.set(this, Object.freeze({
      openChild: (scopeId, input) => this.#openChild(scopeId, input),
      register: (scopeId, input) => this.#register(scopeId, input),
      bind: (scopeId, resourceId, observation) => this.#bind(scopeId, resourceId, observation),
      observe: (scopeId, resourceId, observation) => this.#observe(scopeId, resourceId, observation),
      confirmRelease: (scopeId, resourceId, observation) => (
        this.#confirmRelease(scopeId, resourceId, observation)
      ),
      confirmRetention: (scopeId, resourceId, observation) => (
        this.#confirmRetention(scopeId, resourceId, observation)
      ),
      close: (scopeId, reason) => this.#closeScope(scopeId, reason),
      getResource: (scopeId, resourceId) => this.#getResource(scopeId, resourceId),
      snapshot: (scopeId) => this.#scopeSnapshot(scopeId),
    }));
    Object.freeze(this);
  }

  openRootScope(input = {}) {
    if (this.#rootScopeId !== null) {
      throw new ResourceTrackerError('ROOT_SCOPE_ALREADY_OPEN');
    }
    const scope = this.#openScope({
      ...input,
      ownerId: input.ownerId || this.ownerId,
      parentScopeId: null,
    });
    this.#rootScopeId = scope.scopeId;
    return scope;
  }

  hasOpenScope(binding = {}) {
    const scope = this.#scopes.get(binding.scopeId);
    return Boolean(scope
      && binding.ownerId === scope.ownerId
      && binding.runId === this.runId
      && binding.generation === this.generation
      && scope.generation === this.generation
      && scope.accepting === true
      && scope.closing === false
      && scope.closed === false);
  }

  verifyCloseResult(result, binding = {}) {
    const scope = this.#scopes.get(binding.scopeId);
    if (!scope || scope.closed !== true || scope.closeCache === null) return false;
    if (binding.ownerId !== scope.ownerId || binding.runId !== this.runId
      || binding.generation !== this.generation) return false;
    return result && result.status === 'CLOSED' && sameValue(result, scope.closeCache);
  }

  claimTaskScope(taskId, binding = {}, resourceIds = []) {
    if (typeof taskId !== 'string' || taskId.trim() === ''
      || !Array.isArray(resourceIds) || resourceIds.length === 0
      || resourceIds.some((item) => typeof item !== 'string' || item.trim() === '')
      || new Set(resourceIds).size !== resourceIds.length
      || !this.hasOpenScope(binding)) return false;
    const safeResourceIds = Array.from(resourceIds).sort();
    const requestedClaim = { taskId, binding, resourceIds: safeResourceIds };
    if (!this.#taskClaimResourcesAreActive(binding, safeResourceIds)) return false;
    const existingTask = this.#taskClaims.get(taskId);
    if (existingTask) {
      return this.#scopeClaims.get(binding.scopeId) === taskId
        && sameValue(existingTask, requestedClaim);
    }
    if (this.#scopeClaims.has(binding.scopeId)) return false;
    const claim = detached(requestedClaim);
    this.#assertInputSize(claim);
    this.#requireHistoryCapacity([{ kind: 'TASK_SCOPE_CLAIMED', payload: claim }]);
    const checkpoint = this.#checkpoint();
    try {
      this.#taskClaims.set(taskId, claim);
      this.#scopeClaims.set(binding.scopeId, taskId);
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('TASK_SCOPE_CLAIMED', claim);
      return true;
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
  }

  #taskClaimResourcesAreActive(binding, resourceIds) {
    for (const resourceId of resourceIds) {
      const record = this.#resources.get(resourceId);
      if (!record || record.scopeId !== binding.scopeId || record.ownerId !== binding.ownerId
        || record.generation !== binding.generation || record.boundGeneration !== binding.generation
        || record.bindSignature === null || record.identity === null
        || record.state !== 'ACTIVE' || record.releaseConfirmed !== false) return false;
      const currentSignature = {
        resourceId: record.resourceId,
        type: record.type,
        ownerId: record.ownerId,
        scopeId: record.scopeId,
        parentScopeId: record.parentScopeId,
        parentResourceId: record.parentResourceId,
        generation: record.boundGeneration,
        identity: record.identity,
      };
      if (!sameValue(record.bindSignature, currentSignature)) return false;
    }
    return true;
  }

  consumeTaskCloseResult(taskId, result, binding = {}, resourceIds = []) {
    const claim = this.#taskClaims.get(taskId);
    const safeResourceIds = Array.isArray(resourceIds) ? Array.from(resourceIds).sort() : [];
    if (!claim || !sameValue(claim, { taskId, binding, resourceIds: safeResourceIds })
      || !this.verifyCloseResult(result, binding)) return false;
    const closeSha256 = computeDetachedSha256(result);
    const consumed = this.#consumedTaskCloses.get(taskId);
    if (consumed) return consumed === closeSha256;
    const payload = detached({ taskId, scopeId: binding.scopeId, resourceIds: safeResourceIds, closeSha256 });
    this.#requireHistoryCapacity([{ kind: 'TASK_CLOSE_CONSUMED', payload }]);
    const checkpoint = this.#checkpoint();
    try {
      this.#consumedTaskCloses.set(taskId, closeSha256);
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('TASK_CLOSE_CONSUMED', payload);
      return true;
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
  }

  #openChild(parentScopeId, input = {}) {
    const parent = this.#requireScope(parentScopeId);
    if (!parent.accepting || parent.closed) {
      throw new ResourceTrackerError('PARENT_SCOPE_NOT_ACTIVE');
    }
    return this.#openScope({
      ...input,
      ownerId: input.ownerId || parent.ownerId,
      parentScopeId,
    });
  }

  #openScope(input) {
    if (this.#scopes.size >= this.#limits.maxScopes) throw new ResourceTrackerError('SCOPE_LIMIT_REACHED');
    const scopeId = requireString(input.scopeId, 'SCOPE_ID_INVALID', 'scopeId');
    const ownerId = requireString(input.ownerId, 'OWNER_INVALID', 'ownerId');
    const purpose = requireString(input.purpose, 'PURPOSE_INVALID', 'purpose');
    if (this.#scopes.has(scopeId)) throw new ResourceTrackerError('SCOPE_ALREADY_EXISTS');
    if (input.parentScopeId !== null && !this.#scopes.has(input.parentScopeId)) {
      throw new ResourceTrackerError('PARENT_SCOPE_NOT_FOUND');
    }
    const eventPayload = { scopeId, ownerId, parentScopeId: input.parentScopeId, purpose };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'SCOPE_OPENED', payload: eventPayload }]);
    const scope = {
      scopeId,
      ownerId,
      parentScopeId: input.parentScopeId,
      purpose,
      generation: this.generation,
      accepting: true,
      closing: false,
      closed: false,
      children: [],
      resourceIds: [],
      closeCache: null,
      closeCacheRevision: -1,
    };
    const checkpoint = this.#checkpoint();
    try {
      this.#scopes.set(scopeId, scope);
      if (scope.parentScopeId !== null) this.#scopes.get(scope.parentScopeId).children.push(scopeId);
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('SCOPE_OPENED', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return new ResourceScope(this, scopeId);
  }

  #register(scopeId, input = {}) {
    const scope = this.#requireScope(scopeId);
    if (!scope.accepting || scope.closing || scope.closed) {
      throw new ResourceTrackerError('SCOPE_NOT_ACCEPTING_RESOURCES');
    }
    if (this.#resources.size >= this.#limits.maxResources) {
      throw new ResourceTrackerError('RESOURCE_LIMIT_REACHED');
    }
    const resourceId = requireString(input.resourceId, 'RESOURCE_ID_INVALID', 'resourceId');
    const type = requireString(input.type, 'RESOURCE_TYPE_INVALID', 'type');
    if (!RESOURCE_TYPES.has(type)) throw new ResourceTrackerError('RESOURCE_TYPE_INVALID');
    if (this.#resources.has(resourceId)) throw new ResourceTrackerError('RESOURCE_ALREADY_REGISTERED');
    const parentResourceId = input.parentResourceId === undefined || input.parentResourceId === null
      ? null
      : requireString(input.parentResourceId, 'PARENT_RESOURCE_INVALID', 'parentResourceId');
    if (parentResourceId !== null) {
      const parent = this.#resources.get(parentResourceId);
      if (!parent) throw new ResourceTrackerError('PARENT_RESOURCE_NOT_REGISTERED');
      if (parent.generation !== this.generation || !this.#scopeIsSameOrAncestor(parent.scopeId, scopeId)) {
        throw new ResourceTrackerError('PARENT_RESOURCE_SCOPE_INVALID');
      }
    }
    const declaration = {
      resourceId,
      type,
      purpose: requireString(input.purpose, 'PURPOSE_INVALID', 'purpose'),
      teardownCondition: requireString(input.teardownCondition, 'TEARDOWN_CONDITION_INVALID', 'teardownCondition'),
      quota: input.quota === undefined ? null : detached(input.quota),
      evidenceRefs: requireEvidenceRefs(input.evidenceRefs),
      parentResourceId,
    };
    this.#assertInputSize(declaration);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_REGISTERED', payload: { scopeId, declaration } }]);
    const record = {
      ...declaration,
      ownerId: scope.ownerId,
      scopeId,
      parentScopeId: scope.parentScopeId,
      generation: this.generation,
      acquisitionOrder: this.#acquisitionOrder + 1,
      state: 'DECLARED',
      identity: null,
      boundGeneration: null,
      bindSignature: null,
      decision: null,
      latestObservation: null,
      releaseConfirmed: false,
    };
    const checkpoint = this.#checkpoint();
    try {
      this.#acquisitionOrder += 1;
      this.#resources.set(resourceId, record);
      scope.resourceIds.push(resourceId);
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_REGISTERED', { scopeId, declaration });
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return cloneRecord(record);
  }

  #bind(scopeId, resourceId, observation = {}) {
    const record = this.#requireOwnedResource(scopeId, resourceId);
    this.#requireScopeMutable(scopeId);
    const generation = requireGeneration(observation.generation);
    const identity = detached(observation.identity);
    const evidenceRefs = requireEvidenceRefs(observation.evidenceRefs);
    const signature = detached({
      resourceId,
      type: record.type,
      ownerId: record.ownerId,
      scopeId: record.scopeId,
      parentScopeId: record.parentScopeId,
      parentResourceId: record.parentResourceId,
      generation,
      identity,
    });
    let identityValidation = hasV2IdentityIntent(identity)
      ? this.#validateIdentity(record, identity, generation)
      : null;
    if (record.bindSignature !== null) {
      if (sameValue(record.bindSignature, signature)) return cloneRecord(record);
      if (identityValidation !== null) {
        if (!identityValidation.valid) {
          return this.#holdInvalidV2Identity(record, scopeId, identityValidation, evidenceRefs);
        }
        return this.#holdInvalidV2Identity(record, scopeId, structuredIdentityHold([
          trackerIdentityError('RESOURCE_IDENTITY_DRIFT', '$.identity', 'version-2 identity must remain unchanged after binding'),
        ]), evidenceRefs);
      }
      this.#markIdentityDrift(record, 'BINDING_CHANGED');
    }
    if (identityValidation === null) identityValidation = this.#validateIdentity(record, identity, generation);
    if (identityValidation !== null && !identityValidation.valid) {
      return this.#holdInvalidV2Identity(record, scopeId, identityValidation, evidenceRefs);
    }
    const eventPayload = { scopeId, resourceId, observation: { identity, generation, evidenceRefs } };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_BOUND', payload: eventPayload }]);
    const checkpoint = this.#checkpoint();
    try {
      record.identity = identity;
      record.boundGeneration = generation;
      record.bindSignature = signature;
      record.evidenceRefs = Array.from(new Set([...record.evidenceRefs, ...evidenceRefs]));
      record.state = 'ACTIVE';
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_BOUND', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return cloneRecord(record);
  }

  #validateIdentity(record, identity, generation) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || Object.keys(identity).length === 0) {
      if (PROCESS_RESOURCE_TYPES.has(record.type)) {
        throw new ResourceTrackerError('PROCESS_IDENTITY_INVALID');
      }
      throw new ResourceTrackerError('RESOURCE_IDENTITY_INVALID');
    }
    if (hasV2IdentityIntent(identity)) {
      const validation = validateResourceIdentity2(record.type, identity);
      const errors = validation.errors.map((item) => ({
        code: item.code,
        path: item.path,
        message: item.message,
      }));
      if (generation !== this.generation || record.generation !== this.generation) {
        errors.push(trackerIdentityError('TRACKER_GENERATION_MISMATCH', '$.generation', 'bind generation must match tracker generation'));
      }
      if (validation.valid && (HARNESS_RESOURCE_TYPES.has(record.type) || PROCESS_V2_RESOURCE_TYPES.has(record.type))) {
        if (identity.owner_id !== record.ownerId) {
          errors.push(trackerIdentityError('TRACKER_OWNER_MISMATCH', '$.owner_id', 'identity owner must match resource owner'));
        }
        if (identity.run_id !== this.runId) {
          errors.push(trackerIdentityError('TRACKER_RUN_MISMATCH', '$.run_id', 'identity run must match tracker run'));
        }
        if (identity.lease_generation !== generation) {
          errors.push(trackerIdentityError('TRACKER_LEASE_GENERATION_MISMATCH', '$.lease_generation', 'identity lease generation must match bind generation'));
        }
        if (identity.adapter_generation !== generation) {
          errors.push(trackerIdentityError('TRACKER_ADAPTER_GENERATION_MISMATCH', '$.adapter_generation', 'adapter generation must match bind generation'));
        }
      }
      if (validation.valid && record.type === 'temporary_allocation') {
        if (identity.owner_id !== record.ownerId) {
          errors.push(trackerIdentityError('TRACKER_OWNER_MISMATCH', '$.owner_id', 'identity owner must match resource owner'));
        }
        if (identity.run_id !== this.runId) {
          errors.push(trackerIdentityError('TRACKER_RUN_MISMATCH', '$.run_id', 'identity run must match tracker run'));
        }
        if (identity.lease_generation !== generation) {
          errors.push(trackerIdentityError('TRACKER_LEASE_GENERATION_MISMATCH', '$.lease_generation', 'identity lease generation must match bind generation'));
        }
      }
      return errors.length === 0 ? validation : structuredIdentityHold(errors);
    }
    if (PROCESS_RESOURCE_TYPES.has(record.type)) {
      const validation = isStrictLegacyProcessIdentity(identity)
        ? validateProcessIdentity(identity)
        : { valid: false };
      if (!validation.valid) throw new ResourceTrackerError('PROCESS_IDENTITY_INVALID');
    }
    if (generation !== this.generation) this.#markIdentityDrift(record, 'GENERATION_CHANGED');
    if (record.type === 'temporary_allocation') {
      if (!validateTemporaryIdentity(identity)
        || identity.owner_id !== record.ownerId
        || identity.run_id !== this.runId
        || identity.lease_generation !== generation) {
        throw new ResourceTrackerError('TEMPORARY_IDENTITY_INVALID');
      }
    }
    return null;
  }

  #holdInvalidV2Identity(record, scopeId, validation, evidenceRefs) {
    const decision = detached(validation);
    const eventPayload = {
      scopeId,
      resourceId: record.resourceId,
      reason: 'V2_IDENTITY_VALIDATION_FAILED',
      decision,
      evidenceRefs,
    };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_HELD', payload: eventPayload }]);
    const checkpoint = this.#checkpoint();
    try {
      record.state = 'HOLD';
      record.releaseConfirmed = false;
      record.decision = decision;
      record.evidenceRefs = Array.from(new Set([...record.evidenceRefs, ...evidenceRefs]));
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_HELD', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return decision;
  }

  #observe(scopeId, resourceId, observation) {
    const record = this.#requireOwnedResource(scopeId, resourceId);
    this.#requireScopeMutable(scopeId);
    if (record.bindSignature === null) throw new ResourceTrackerError('RESOURCE_NOT_BOUND');
    let safeObservation;
    let decision;
    let purpose = 'resource_observation';
    if (record.type === 'temporary_allocation') {
      purpose = 'temporary_reclaim';
      safeObservation = jsonObservation(observation, ['trustedFilesystemResolver']);
      if (!this.#temporaryObservationMatches(record, safeObservation)) {
        decision = { action: 'HOLD', reasons: ['TEMP_BOUND_IDENTITY_MISMATCH'] };
      } else {
        decision = decideTemporaryLease({
          ...safeObservation,
          trustedFilesystemResolver: this.#trustedFilesystemResolver,
        });
      }
    } else if (PROCESS_RESOURCE_TYPES.has(record.type)) {
      purpose = 'process_recovery';
      safeObservation = jsonObservation(observation);
      if (!this.#processObservationMatches(record, safeObservation)) {
        decision = { action: 'HOLD', reasons: ['TRACKER_BINDING_MISMATCH'] };
      } else {
        decision = decideProcessRecovery(safeObservation);
      }
    } else {
      safeObservation = jsonObservation(observation);
      decision = { action: 'OBSERVE_ONLY', reasons: ['EXPLICIT_RELEASE_CONFIRMATION_REQUIRED'] };
    }
    decision = detached(decision);
    if (PROCESS_RESOURCE_TYPES.has(record.type)
      && decision.downstream_release_allowed === true
      && !this.#typeReleaseProofMatches(record, safeObservation)) {
      decision = detached({ action: 'HOLD', reasons: ['RESOURCE_TYPE_RELEASE_PROOF_MISSING'] });
    }
    const releaseCapable = decision.downstream_release_allowed === true
      || decision.action === 'TERMINATE_EXACT_TREE'
      || decision.action === 'RECLAIM_EXACT';
    if (releaseCapable && !resolverAccepts(this.#trustedObservationResolver, {
      purpose,
      ownerId: this.ownerId,
      runId: this.runId,
      generation: this.generation,
      resource: cloneRecord(record),
      observation: safeObservation,
      decision,
    })) {
      decision = detached({ action: 'HOLD', reasons: ['OBSERVATION_TRUST_NOT_PROVEN'] });
    }
    const eventPayload = {
      scopeId,
      resourceId,
      observation: safeObservation,
      decision,
    };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_OBSERVED', payload: eventPayload }]);
    const checkpoint = this.#checkpoint();
    try {
      this.#applyObservation(record, safeObservation, decision);
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_OBSERVED', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return record.decision;
  }

  #applyObservation(record, safeObservation, decision) {
    record.latestObservation = safeObservation;
    record.decision = detached(decision);
    record.releaseConfirmed = record.decision.downstream_release_allowed === true;
    record.state = record.decision.action === 'HOLD' ? 'HOLD' : 'ACTIVE';
    this.#touch();
  }

  #processObservationMatches(record, observation) {
    const expectedScope = { kind: 'scope', value: record.scopeId };
    return observation.expected_generation === record.boundGeneration
      && sameValue(observation.expected_identity, record.identity)
      && sameValue(observation.expected_scope, expectedScope)
      && sameValue(observation.observed_scope, expectedScope);
  }

  #temporaryObservationMatches(record, input) {
    const identity = record.identity;
    const manifest = input.manifest;
    return input.child_id === identity.child_id
      && manifest && manifest.manifest_sha256 === identity.manifest_sha256
      && manifest.owner_id === identity.owner_id
      && manifest.run_id === identity.run_id
      && manifest.session_id === identity.session_id
      && manifest.lease_generation === identity.lease_generation
      && sameValue(manifest.canonical_root_identity, identity.canonical_root_identity);
  }

  #typeReleaseProofMatches(record, observation) {
    const absence = observation && observation.absence;
    if (record.type === 'agent_session') return observation.child_closed === true;
    if (record.type === 'runtime_thread') return Boolean(absence && absence.thread_absent === true);
    if (record.type === 'process_tree' || record.type === 'command_session') {
      return Boolean(absence && absence.process_absent === true);
    }
    if (record.type === 'terminal_session') return Boolean(absence && absence.terminal_absent === true);
    if (record.type === 'port') return Boolean(absence && absence.port_absent === true);
    if (record.type === 'constrained_compute') return observation.compute_released === true;
    return true;
  }

  #confirmRelease(scopeId, resourceId, observation = {}) {
    const record = this.#requireOwnedResource(scopeId, resourceId);
    this.#requireScopeMutable(scopeId);
    if (record.bindSignature === null) throw new ResourceTrackerError('RESOURCE_NOT_BOUND');
    if (PROCESS_RESOURCE_TYPES.has(record.type)) {
      throw new ResourceTrackerError('PROCESS_RELEASE_REQUIRES_SAFETY_OBSERVATION');
    }
    const generation = requireGeneration(observation.generation);
    const identity = detached(observation.identity);
    if (generation !== record.boundGeneration || !sameValue(identity, record.identity)) {
      this.#markIdentityDrift(record, 'RELEASE_IDENTITY_CHANGED');
    }
    if (observation.absenceVerified !== true) {
      throw new ResourceTrackerError('ABSENCE_NOT_VERIFIED');
    }
    if (record.type === 'temporary_allocation'
      && (!record.decision || record.decision.action !== 'RECLAIM_EXACT'
        || record.decision.requires_post_removal_absence_check !== true)) {
      throw new ResourceTrackerError('TEMPORARY_RECLAIM_NOT_AUTHORIZED');
    }
    const evidenceRefs = requireEvidenceRefs(observation.evidenceRefs);
    if (!resolverAccepts(this.#trustedObservationResolver, {
      purpose: record.type === 'temporary_allocation' ? 'temporary_absence' : 'resource_absence',
      ownerId: this.ownerId,
      runId: this.runId,
      generation: this.generation,
      resource: cloneRecord(record),
      observation: { identity, generation, absenceVerified: true, evidenceRefs },
    })) {
      throw new ResourceTrackerError('ABSENCE_TRUST_NOT_PROVEN');
    }
    const eventPayload = {
      scopeId,
      resourceId,
      observation: { identity, generation, absenceVerified: true, evidenceRefs },
    };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_RELEASE_CONFIRMED', payload: eventPayload }]);
    const checkpoint = this.#checkpoint();
    try {
      this.#applyRelease(record, evidenceRefs);
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_RELEASE_CONFIRMED', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return cloneRecord(record);
  }

  #confirmRetention(scopeId, resourceId, observation = {}) {
    const record = this.#requireOwnedResource(scopeId, resourceId);
    this.#requireScopeMutable(scopeId);
    if (record.type !== 'artifact') throw new ResourceTrackerError('RETENTION_RESOURCE_TYPE_INVALID');
    if (record.bindSignature === null) throw new ResourceTrackerError('RESOURCE_NOT_BOUND');
    const generation = requireGeneration(observation.generation);
    const identity = detached(observation.identity);
    if (generation !== record.boundGeneration || !sameValue(identity, record.identity)) {
      this.#markIdentityDrift(record, 'RETENTION_IDENTITY_CHANGED');
    }
    if (observation.retained !== true || observation.artifactSealed !== true) {
      throw new ResourceTrackerError('ARTIFACT_RETENTION_NOT_PROVEN');
    }
    const authorizationRef = requireString(
      observation.authorizationRef,
      'RETENTION_AUTHORIZATION_INVALID',
      'authorizationRef',
    );
    const evidenceRefs = requireEvidenceRefs(observation.evidenceRefs);
    const safeObservation = detached({
      identity,
      generation,
      retained: true,
      artifactSealed: true,
      authorizationRef,
      evidenceRefs,
    });
    if (!resolverAccepts(this.#trustedObservationResolver, {
      purpose: 'artifact_retention',
      ownerId: this.ownerId,
      runId: this.runId,
      generation: this.generation,
      resource: cloneRecord(record),
      observation: safeObservation,
    })) throw new ResourceTrackerError('RETENTION_TRUST_NOT_PROVEN');
    const eventPayload = { scopeId, resourceId, observation: safeObservation };
    this.#assertInputSize(eventPayload);
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_RETENTION_CONFIRMED', payload: eventPayload }]);
    const checkpoint = this.#checkpoint();
    try {
      record.evidenceRefs = Array.from(new Set([...record.evidenceRefs, ...evidenceRefs]));
      record.releaseConfirmed = true;
      record.state = 'RETAINED';
      record.decision = detached({ action: 'RETAIN_ARTIFACT', authorizationRef });
      this.#touch();
      this.#assertStateWithinLimit();
      this.#record('RESOURCE_RETENTION_CONFIRMED', eventPayload);
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
    return cloneRecord(record);
  }

  #applyRelease(record, evidenceRefs) {
    record.evidenceRefs = Array.from(new Set([...record.evidenceRefs, ...evidenceRefs]));
    record.releaseConfirmed = true;
    if (record.state === 'HOLD') record.state = 'ACTIVE';
    this.#touch();
  }

  #closeScope(scopeId, reason) {
    const scope = this.#requireScope(scopeId);
    requireString(reason, 'CLOSE_REASON_INVALID', 'reason');
    this.#assertInputSize({ scopeId, reason });
    if (scope.closed === true && scope.closeCache !== null) {
      return scope.closeCache;
    }
    if (scope.closeCache !== null && scope.closeCacheRevision === this.#revision) {
      return scope.closeCache;
    }
    const firstClose = !scope.closing;
    this.#requireHistoryCapacity(firstClose
      ? [{ kind: 'SCOPE_CLOSE_REQUESTED', payload: { scopeId, reason } }, null]
      : [null]);
    const checkpoint = this.#checkpoint();
    try {
      if (firstClose) {
        this.#freezeSubtree(scopeId);
        this.#touch();
        this.#record('SCOPE_CLOSE_REQUESTED', { scopeId, reason });
      }
      const order = [];
      const decisions = [];
      const reasons = new Set();
      const closed = this.#closeSubtree(scopeId, order, decisions, reasons);
      const result = detached({
        ownerId: scope.ownerId,
        runId: this.runId,
        scopeId,
        generation: this.generation,
        status: closed ? 'CLOSED' : 'HOLD',
        reasons: Array.from(reasons),
        order,
        decisions,
      });
      scope.closeCache = result;
      scope.closeCacheRevision = this.#revision;
      this.#assertStateWithinLimit();
      this.#record('SCOPE_CLOSE_EVALUATED', { scopeId, reason, result });
      return result;
    } catch (error) {
      this.#restoreCheckpoint(checkpoint);
      throw error;
    }
  }

  #freezeSubtree(scopeId) {
    const scope = this.#requireScope(scopeId);
    scope.accepting = false;
    scope.closing = true;
    for (const childId of scope.children) this.#freezeSubtree(childId);
  }

  #closeSubtree(scopeId, order, decisions, reasons) {
    const scope = this.#requireScope(scopeId);
    let childrenClosed = true;
    for (const childId of scope.children) {
      if (!this.#closeSubtree(childId, order, decisions, reasons)) childrenClosed = false;
    }
    if (!childrenClosed) {
      reasons.add('CHILD_RELEASE_NOT_VERIFIED');
      return false;
    }
    let resourcesClosed = true;
    const records = scope.resourceIds
      .map((resourceId) => this.#resources.get(resourceId))
      .sort((left, right) => right.acquisitionOrder - left.acquisitionOrder);
    for (const record of records) {
      order.push(record.resourceId);
      decisions.push({
        resourceId: record.resourceId,
        action: record.decision ? record.decision.action : 'OBSERVE_ONLY',
        releaseConfirmed: record.releaseConfirmed,
      });
      if (!this.#resourceChildrenTerminal(record.resourceId)) {
        resourcesClosed = false;
        reasons.add('CHILD_RESOURCE_RELEASE_NOT_VERIFIED');
      } else if (!record.releaseConfirmed || record.state === 'HOLD') {
        resourcesClosed = false;
        reasons.add('RESOURCE_RELEASE_NOT_VERIFIED');
      } else if (record.state !== 'RELEASED' && record.state !== 'RETAINED') {
        record.state = 'RELEASED';
        this.#touch();
      }
    }
    if (resourcesClosed && !scope.closed) {
      scope.closed = true;
      scope.accepting = false;
      scope.closing = false;
      this.#touch();
    }
    return resourcesClosed;
  }

  #resourceChildrenTerminal(resourceId) {
    for (const child of this.#resources.values()) {
      if (child.parentResourceId !== resourceId) continue;
      if (!['RELEASED', 'RETAINED'].includes(child.state)
        || !this.#resourceChildrenTerminal(child.resourceId)) return false;
    }
    return true;
  }

  #markIdentityDrift(record, reason) {
    const payload = {
      scopeId: record.scopeId,
      resourceId: record.resourceId,
      reason,
    };
    this.#requireHistoryCapacity([{ kind: 'RESOURCE_HELD', payload }]);
    record.state = 'HOLD';
    record.releaseConfirmed = false;
    this.#touch();
    this.#record('RESOURCE_HELD', payload);
    throw new ResourceTrackerError('RESOURCE_IDENTITY_DRIFT');
  }

  #getResource(scopeId, resourceId) {
    return cloneRecord(this.#requireOwnedResource(scopeId, resourceId));
  }

  #scopeSnapshot(scopeId) {
    const scope = this.#requireScope(scopeId);
    return detached({
      scopeId: scope.scopeId,
      ownerId: scope.ownerId,
      parentScopeId: scope.parentScopeId,
      purpose: scope.purpose,
      generation: scope.generation,
      accepting: scope.accepting,
      closing: scope.closing,
      closed: scope.closed,
      children: scope.children,
      resourceIds: scope.resourceIds,
    });
  }

  snapshot() {
    const scopes = Array.from(this.#scopes.keys()).sort().map((scopeId) => this.#scopeSnapshot(scopeId));
    const resources = Array.from(this.#resources.keys()).sort().map((resourceId) => cloneRecord(this.#resources.get(resourceId)));
    const taskClaims = Array.from(this.#taskClaims.values())
      .sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
    return detached({
      ownerId: this.ownerId,
      runId: this.runId,
      generation: this.generation,
      rootScopeId: this.#rootScopeId,
      historyHeadSha256: this.#historyHeadSha256,
      scopes,
      resources,
      taskClaims,
      consumedTaskCloseIds: Array.from(this.#consumedTaskCloses.keys()).sort(),
    });
  }

  exportHistory() {
    return detached(this.#history);
  }

  exportLedgerProjection() {
    const resourceIdFor = (event) => {
      if (event.kind === 'RESOURCE_REGISTERED') return event.payload.declaration.resourceId;
      return event.payload.resourceId || null;
    };
    const hints = this.#history
      .filter((event) => event.kind.startsWith('RESOURCE_'))
      .map((event) => ({
        trackerSequence: event.sequence,
        trackerEventKind: event.kind,
        resourceId: resourceIdFor(event),
        decisionAction: event.payload.decision ? event.payload.decision.action : null,
        evidenceRefs: event.payload.observation && Array.isArray(event.payload.observation.evidenceRefs)
          ? event.payload.observation.evidenceRefs
          : [],
      }));
    const states = Array.from(this.#resources.values())
      .sort((left, right) => left.acquisitionOrder - right.acquisitionOrder)
      .map((record) => ({
        resourceId: record.resourceId,
        trackerState: record.state,
        ledgerActionRequired: record.state === 'RETAINED'
          ? 'VALIDATE_RETAIN_ARTIFACT'
          : record.state === 'RELEASED'
            ? 'VALIDATE_VERIFY_RECLAIM'
            : 'LEDGER_TRANSITION_REQUIRED',
      }));
    return detached({
      schema: 'TaskResourceTrackerLedgerHints1',
      runId: this.runId,
      generation: this.generation,
      projectionIsResourceLedger: false,
      hints,
      states,
      requiredNextStep: 'Build and validate actual ResourceLedger1 events from host action receipts',
      completionChain: 'ResourceLedger1 -> ExecutionReceipt1',
    });
  }

  static fromHistory(options, history) {
    const limits = normalizeLimits(options && options.limits);
    if (!Array.isArray(history) || history.length === 0 || history.length > limits.maxHistoryEvents) {
      throw new ResourceTrackerError('HISTORY_INVALID');
    }
    let events;
    try {
      events = detached(history);
    } catch (_) {
      throw new ResourceTrackerError('HISTORY_INVALID');
    }
    if (!Array.isArray(events) || events.length === 0) throw new ResourceTrackerError('HISTORY_INVALID');
    let priorHash = null;
    let historyBytes = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || event.sequence !== index + 1 || !HISTORY_KINDS.has(event.kind)
        || event.ownerId !== options.ownerId || event.runId !== options.runId
        || event.generation !== options.generation || event.previousEventSha256 !== priorHash
        || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        throw new ResourceTrackerError('HISTORY_INVALID');
      }
      const expectedHash = computeDetachedSha256({
        sequence: event.sequence,
        kind: event.kind,
        ownerId: event.ownerId,
        runId: event.runId,
        generation: event.generation,
        previousEventSha256: event.previousEventSha256,
        payload: event.payload,
      });
      if (event.eventSha256 !== expectedHash) throw new ResourceTrackerError('HISTORY_INVALID');
      const eventBytes = valueBytes(event);
      historyBytes += eventBytes;
      if (eventBytes > limits.maxEventBytes || historyBytes > limits.maxHistoryBytes) {
        throw new ResourceTrackerError('HISTORY_INVALID');
      }
      priorHash = event.eventSha256;
    }
    if (!resolverAccepts(options.trustedHistoryResolver, {
      purpose: 'task_resource_history',
      ownerId: options.ownerId,
      runId: options.runId,
      generation: options.generation,
      eventCount: events.length,
      historyHeadSha256: priorHash,
    })) {
      throw new ResourceTrackerError('HISTORY_TRUST_NOT_PROVEN');
    }
    const tracker = new TaskResourceTracker(options);
    tracker.#replaying = true;
    try {
      for (const event of events) tracker.#replay(event);
    } catch (_) {
      throw new ResourceTrackerError('HISTORY_INVALID');
    } finally {
      tracker.#replaying = false;
    }
    tracker.#history = Array.from(events);
    tracker.#historyBytes = historyBytes;
    tracker.#sequence = events.length;
    tracker.#historyHeadSha256 = priorHash;
    tracker.#assertStateWithinLimit();
    return tracker;
  }

  #replay(event) {
    const payload = event.payload;
    switch (event.kind) {
      case 'SCOPE_OPENED':
        if (payload.parentScopeId === null) this.openRootScope(payload);
        else this.#openChild(payload.parentScopeId, payload);
        break;
      case 'RESOURCE_REGISTERED':
        this.#register(payload.scopeId, payload.declaration);
        break;
      case 'RESOURCE_BOUND':
        this.#bind(payload.scopeId, payload.resourceId, payload.observation);
        break;
      case 'RESOURCE_OBSERVED': {
        const record = this.#requireOwnedResource(payload.scopeId, payload.resourceId);
        this.#applyObservation(record, payload.observation, payload.decision);
        break;
      }
      case 'RESOURCE_RELEASE_CONFIRMED': {
        const record = this.#requireOwnedResource(payload.scopeId, payload.resourceId);
        const observation = payload.observation;
        if (observation.generation !== record.boundGeneration
          || !sameValue(observation.identity, record.identity)
          || observation.absenceVerified !== true) throw new ResourceTrackerError('HISTORY_INVALID');
        this.#applyRelease(record, requireEvidenceRefs(observation.evidenceRefs));
        break;
      }
      case 'RESOURCE_RETENTION_CONFIRMED': {
        const record = this.#requireOwnedResource(payload.scopeId, payload.resourceId);
        const observation = payload.observation;
        if (record.type !== 'artifact' || observation.generation !== record.boundGeneration
          || !sameValue(observation.identity, record.identity) || observation.retained !== true
          || observation.artifactSealed !== true) throw new ResourceTrackerError('HISTORY_INVALID');
        record.evidenceRefs = Array.from(new Set([
          ...record.evidenceRefs,
          ...requireEvidenceRefs(observation.evidenceRefs),
        ]));
        record.releaseConfirmed = true;
        record.state = 'RETAINED';
        record.decision = detached({
          action: 'RETAIN_ARTIFACT',
          authorizationRef: observation.authorizationRef,
        });
        this.#touch();
        break;
      }
      case 'RESOURCE_HELD': {
        const record = this.#requireOwnedResource(payload.scopeId, payload.resourceId);
        record.state = 'HOLD';
        record.releaseConfirmed = false;
        if (payload.decision !== undefined) record.decision = detached(payload.decision);
        if (Array.isArray(payload.evidenceRefs)) {
          record.evidenceRefs = Array.from(new Set([...record.evidenceRefs, ...payload.evidenceRefs]));
        }
        this.#touch();
        break;
      }
      case 'SCOPE_CLOSE_REQUESTED':
        this.#applyCloseRequested(payload.scopeId, payload.reason);
        break;
      case 'SCOPE_CLOSE_EVALUATED': {
        const result = this.#closeScope(payload.scopeId, payload.reason);
        if (!sameValue(result, payload.result)) throw new ResourceTrackerError('HISTORY_INVALID');
        break;
      }
      case 'TASK_SCOPE_CLAIMED': {
        if (!this.claimTaskScope(payload.taskId, payload.binding, payload.resourceIds)) {
          throw new ResourceTrackerError('HISTORY_INVALID');
        }
        break;
      }
      case 'TASK_CLOSE_CONSUMED': {
        const claim = this.#taskClaims.get(payload.taskId);
        const scope = this.#scopes.get(payload.scopeId);
        if (!claim || claim.binding.scopeId !== payload.scopeId
          || !sameValue(claim.resourceIds, payload.resourceIds)
          || !scope || scope.closed !== true || scope.closeCache === null
          || computeDetachedSha256(scope.closeCache) !== payload.closeSha256) {
          throw new ResourceTrackerError('HISTORY_INVALID');
        }
        this.#consumedTaskCloses.set(payload.taskId, payload.closeSha256);
        this.#touch();
        break;
      }
      default:
        throw new ResourceTrackerError('HISTORY_INVALID');
    }
  }

  #record(kind, payload) {
    if (this.#replaying) return;
    this.#requireHistoryCapacity([{ kind, payload }]);
    const event = this.#buildHistoryEvent(kind, payload, this.#sequence + 1, this.#historyHeadSha256);
    this.#history.push(event);
    this.#sequence = event.sequence;
    this.#historyHeadSha256 = event.eventSha256;
    this.#historyBytes += valueBytes(event);
  }

  #buildHistoryEvent(kind, payload, sequence, previousEventSha256) {
    const base = detached({
      sequence,
      kind,
      ownerId: this.ownerId,
      runId: this.runId,
      generation: this.generation,
      previousEventSha256,
      payload,
    });
    return detached({ ...base, eventSha256: computeDetachedSha256(base) });
  }

  #requireHistoryCapacity(entries) {
    if (this.#replaying) return;
    if (!Array.isArray(entries) || this.#history.length + entries.length > this.#limits.maxHistoryEvents) {
      throw new ResourceTrackerError('TRACKER_HISTORY_LIMIT_REACHED');
    }
    let bytes = this.#historyBytes;
    let sequence = this.#sequence;
    let previous = this.#historyHeadSha256;
    for (const entry of entries) {
      if (entry === null) {
        bytes += this.#limits.maxEventBytes;
        continue;
      }
      const event = this.#buildHistoryEvent(entry.kind, entry.payload, sequence + 1, previous);
      const eventBytes = valueBytes(event);
      if (eventBytes > this.#limits.maxEventBytes) {
        throw new ResourceTrackerError('TRACKER_EVENT_LIMIT_REACHED');
      }
      bytes += eventBytes;
      sequence += 1;
      previous = event.eventSha256;
    }
    if (bytes > this.#limits.maxHistoryBytes) {
      throw new ResourceTrackerError('TRACKER_HISTORY_BYTES_LIMIT_REACHED');
    }
  }

  #assertInputSize(value) {
    if (valueBytes(value) > this.#limits.maxInputBytes) {
      throw new ResourceTrackerError('TRACKER_INPUT_LIMIT_REACHED');
    }
  }

  #assertStateWithinLimit() {
    const state = {
      scopes: Array.from(this.#scopes.values()),
      resources: Array.from(this.#resources.values()),
      taskClaims: Array.from(this.#taskClaims.values()),
      scopeClaims: Array.from(this.#scopeClaims.entries()),
      consumedTaskCloses: Array.from(this.#consumedTaskCloses.entries()),
    };
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > this.#limits.maxStateBytes) {
      throw new ResourceTrackerError('TRACKER_STATE_LIMIT_REACHED');
    }
  }

  #checkpoint() {
    return {
      scopes: new Map(Array.from(this.#scopes, ([key, scope]) => [key, {
        ...scope,
        children: Array.from(scope.children),
        resourceIds: Array.from(scope.resourceIds),
      }])),
      resources: new Map(Array.from(this.#resources, ([key, record]) => [key, {
        ...record,
        evidenceRefs: Array.from(record.evidenceRefs),
      }])),
      taskClaims: new Map(this.#taskClaims),
      scopeClaims: new Map(this.#scopeClaims),
      consumedTaskCloses: new Map(this.#consumedTaskCloses),
      history: Array.from(this.#history),
      historyBytes: this.#historyBytes,
      sequence: this.#sequence,
      revision: this.#revision,
      acquisitionOrder: this.#acquisitionOrder,
      rootScopeId: this.#rootScopeId,
      historyHeadSha256: this.#historyHeadSha256,
    };
  }

  #restoreCheckpoint(checkpoint) {
    this.#scopes = checkpoint.scopes;
    this.#resources = checkpoint.resources;
    this.#taskClaims = checkpoint.taskClaims;
    this.#scopeClaims = checkpoint.scopeClaims;
    this.#consumedTaskCloses = checkpoint.consumedTaskCloses;
    this.#history = checkpoint.history;
    this.#historyBytes = checkpoint.historyBytes;
    this.#sequence = checkpoint.sequence;
    this.#revision = checkpoint.revision;
    this.#acquisitionOrder = checkpoint.acquisitionOrder;
    this.#rootScopeId = checkpoint.rootScopeId;
    this.#historyHeadSha256 = checkpoint.historyHeadSha256;
  }

  #applyCloseRequested(scopeId, reason) {
    const scope = this.#requireScope(scopeId);
    requireString(reason, 'CLOSE_REASON_INVALID', 'reason');
    if (!scope.closing && !scope.closed) {
      this.#freezeSubtree(scopeId);
      this.#touch();
    }
  }

  #touch() {
    this.#revision += 1;
  }

  #requireScope(scopeId) {
    const scope = this.#scopes.get(scopeId);
    if (!scope) throw new ResourceTrackerError('SCOPE_NOT_FOUND');
    return scope;
  }

  #requireScopeMutable(scopeId) {
    const scope = this.#requireScope(scopeId);
    if (scope.closed) throw new ResourceTrackerError('SCOPE_ALREADY_CLOSED');
    return scope;
  }

  #requireOwnedResource(scopeId, resourceId) {
    const record = this.#resources.get(resourceId);
    if (!record) throw new ResourceTrackerError('RESOURCE_NOT_REGISTERED');
    if (record.scopeId !== scopeId) throw new ResourceTrackerError('RESOURCE_SCOPE_MISMATCH');
    return record;
  }

  #scopeIsSameOrAncestor(candidateAncestorId, scopeId) {
    let current = this.#scopes.get(scopeId);
    while (current) {
      if (current.scopeId === candidateAncestorId) return true;
      current = current.parentScopeId === null ? null : this.#scopes.get(current.parentScopeId);
    }
    return false;
  }
}

module.exports = {
  ResourceScope,
  ResourceTrackerError,
  TaskResourceTracker,
};
