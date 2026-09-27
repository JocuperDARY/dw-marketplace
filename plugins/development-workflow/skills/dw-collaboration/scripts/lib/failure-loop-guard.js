'use strict';

const {
  canonicalizeDetachedSnapshot,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');

const FAILURE_FINGERPRINT_VERSION = 'FailureFingerprint1';
const FAILURE_STATE_VERSION = 'FailureLoopGuardState3';
const FAILURE_CLASSIFICATIONS = new Set(['code_defect', 'transient', 'environment', 'external', 'unknown']);
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_OPERATION_ID = new RegExp(
  '^[A-Za-z0-9][A-Za-z0-9._:/\\\\-]{0,511}$',
  'u',
);
const DEFAULT_LIMITS = Object.freeze({
  maxFailures: 1024,
  maxRecordsPerGeneration: 64,
  maxGenerationsPerFailure: 64,
  maxEvidenceRefsPerFailure: 512,
  maxOperationBindings: 2048,
  maxStateBytes: 4 * 1024 * 1024,
});
const INTERNAL_STATE = new WeakMap();
const INTERNAL_AUTHORITY = Object.freeze({});
const EXIT_METHODS = new Set([
  'MINIMIZE_REPRODUCTION',
  'CHANGE_OBSERVATION',
  'CHANGE_IMPLEMENTATION_PATH',
  'RESTORE_KNOWN_GOOD',
  'WAIT_EXTERNAL',
  'REQUEST_USER_DECISION',
  'STOP_AND_PRESERVE',
]);
const SUMMARY_TRIGGERS = new Set([
  'FAILURE_RECORD_LIMIT_REACHED',
  'FAILURE_FAMILY_EXIT_ALREADY_USED',
  'REPEATED_FAILURE',
  'RETRY_BUDGET_EXHAUSTED',
  'REPAIR_BUDGET_EXHAUSTED',
]);

class FailureLoopError extends Error {
  constructor(code, message = code) {
    super(`${code}: ${message}`);
    this.name = 'FailureLoopError';
    this.code = code;
  }
}

function detached(value) {
  return createDetachedJsonSnapshot(value).snapshot;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function internalState(guard) {
  const state = INTERNAL_STATE.get(guard);
  if (!state) throw new FailureLoopError('FAILURE_GUARD_STATE_INVALID');
  return state;
}

function assertCallbackState(guard, expected) {
  const state = internalState(guard);
  if (state.operationCompromised
    || state.operationActive !== expected.operationActive
    || state.operationToken !== expected.operationToken
    || state.stateRevision !== expected.stateRevision
    || state.stateHeadSha256 !== expected.stateHeadSha256
    || state.activeFingerprint !== expected.activeFingerprint) {
    throw new FailureLoopError('FAILURE_OPERATION_REENTRANT');
  }
}

function captureCallbackState(guard) {
  const state = internalState(guard);
  return {
    operationActive: state.operationActive,
    operationToken: state.operationToken,
    stateRevision: state.stateRevision,
    stateHeadSha256: state.stateHeadSha256,
    activeFingerprint: state.activeFingerprint,
  };
}

function captureExitState(guard, failure, generation) {
  const state = internalState(guard);
  return {
    callback: captureCallbackState(guard),
    failure,
    fingerprint: failure.fingerprint,
    familyFingerprint: failure.familyFingerprint,
    currentGeneration: failure.currentGeneration,
    generation,
    generationNumber: generation.generation,
    summary: generation.summary,
    summaryEligible: generation.summaryEligible,
    summaryTrigger: generation.summaryTrigger,
    exitAttemptConsumed: generation.exitAttemptConsumed,
    familyConsumed: state.consumedExitFamilies.has(failure.familyFingerprint),
  };
}

function assertExitState(guard, expected) {
  assertCallbackState(guard, expected.callback);
  const state = internalState(guard);
  const failure = state.failures.get(expected.fingerprint);
  if (failure !== expected.failure
    || state.activeFingerprint !== expected.fingerprint
    || failure.currentGeneration !== expected.currentGeneration
    || failure.generations.get(expected.generationNumber) !== expected.generation
    || expected.generation.summary !== expected.summary
    || expected.generation.summaryEligible !== expected.summaryEligible
    || expected.generation.summaryTrigger !== expected.summaryTrigger
    || expected.generation.exitAttemptConsumed !== expected.exitAttemptConsumed
    || state.consumedExitFamilies.has(expected.familyFingerprint) !== expected.familyConsumed) {
    throw new FailureLoopError('FAILURE_OPERATION_REENTRANT');
  }
}

function runPublicOperation(guard, operation) {
  const state = internalState(guard);
  if (state.operationActive) {
    state.operationCompromised = true;
    throw new FailureLoopError('FAILURE_OPERATION_REENTRANT');
  }
  const token = Object.freeze({});
  state.operationActive = true;
  state.operationToken = token;
  state.operationCompromised = false;
  try {
    const result = operation();
    assertCallbackState(guard, {
      operationActive: true,
      operationToken: token,
      stateRevision: state.stateRevision,
      stateHeadSha256: state.stateHeadSha256,
      activeFingerprint: state.activeFingerprint,
    });
    return result;
  } finally {
    state.operationActive = false;
    state.operationToken = null;
    state.operationCompromised = false;
  }
}

function requireInternalAuthority(authority) {
  if (authority !== INTERNAL_AUTHORITY) {
    throw new FailureLoopError('FAILURE_INTERNAL_ACCESS_FORBIDDEN');
  }
}

function normalizedStrings(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(nonEmpty))).sort(compareCodeUnits);
}

function normalizedHashes(value, field, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || !SHA256.test(item))) {
    throw new FailureLoopError('FAILURE_OBSERVATION_INVALID', `${field} must contain SHA-256 values`);
  }
  return Array.from(new Set(value)).sort(compareCodeUnits);
}

function normalizeFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FailureLoopError('FAILURE_OBSERVATION_INVALID');
  }
  const required = [
    'phase',
    'checkpoint',
    'errorClass',
    'errorCode',
    'commandId',
    'classification',
    'hypothesis',
    'affectedScope',
    'validationConclusion',
    'sideEffectState',
  ];
  if (required.some((field) => !nonEmpty(value[field]))) {
    throw new FailureLoopError('FAILURE_OBSERVATION_INVALID');
  }
  return detached({
    version: FAILURE_FINGERPRINT_VERSION,
    phase: value.phase,
    checkpoint: value.checkpoint,
    errorClass: value.errorClass,
    errorCode: value.errorCode,
    commandId: value.commandId,
    inputHashes: normalizedHashes(value.inputHashes, 'inputHashes', false),
    artifactHashes: normalizedHashes(value.artifactHashes, 'artifactHashes'),
    environmentIdentity: value.environmentIdentity || 'not_observable',
    sideEffectState: value.sideEffectState,
  });
}

function normalizeFailureFamily(value) {
  const normalized = normalizeFailure(value);
  return detached({ ...normalized, artifactHashes: [] });
}

function semanticEvidence(value) {
  return detached({
    classification: value.classification,
    hypothesis: value.hypothesis,
    affectedScope: value.affectedScope,
    validationConclusion: value.validationConclusion,
  });
}

function computeFailureFingerprint(value) {
  return computeDetachedSha256(normalizeFailure(value));
}

function computeFailureFamily(value) {
  return computeDetachedSha256(normalizeFailureFamily(value));
}

function sanitizeFailure(value) {
  normalizeFailure(value);
  return detached({
    phase: value.phase,
    checkpoint: value.checkpoint,
    errorClass: value.errorClass,
    errorCode: value.errorCode,
    commandId: value.commandId,
    inputHashes: normalizedHashes(value.inputHashes, 'inputHashes', false),
    artifactHashes: normalizedHashes(value.artifactHashes, 'artifactHashes'),
    environmentIdentity: value.environmentIdentity || 'not_observable',
    sideEffectState: value.sideEffectState,
    classification: value.classification,
    hypothesis: value.hypothesis,
    affectedScope: value.affectedScope,
    validationConclusion: value.validationConclusion,
    evidenceRefs: normalizedStrings(value.evidenceRefs),
    occurredAt: nonEmpty(value.occurredAt) ? value.occurredAt : 'not_observable',
    attemptKind: nonEmpty(value.attemptKind) ? value.attemptKind : 'not_observable',
    idempotencyKey: nonEmpty(value.idempotencyKey) ? value.idempotencyKey : null,
    retryPolicyRef: nonEmpty(value.retryPolicyRef) ? value.retryPolicyRef : null,
    operationIdentityRef: nonEmpty(value.operationIdentityRef) ? value.operationIdentityRef : null,
    changeSetHash: SHA256.test(value.changeSetHash || '') ? value.changeSetHash : null,
    repairScope: nonEmpty(value.repairScope) ? value.repairScope : null,
    lastSuccessfulState: value.lastSuccessfulState || 'not_observable',
    resources: value.resources || 'not_observable',
    userDecisionNeeded: value.userDecisionNeeded === true,
  });
}

function normalizeLimits(value) {
  const limits = { ...DEFAULT_LIMITS, ...(value || {}) };
  for (const field of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 1) {
      throw new FailureLoopError('FAILURE_LIMIT_INVALID');
    }
  }
  return Object.freeze(limits);
}

function readInitialStateInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new FailureLoopError('FAILURE_INITIAL_STATE_INVALID');
  }
  const keys = Reflect.ownKeys(value);
  const required = ['runId', 'guardId', 'retryBudget', 'repairBudget'];
  if (keys.length !== required.length || keys.some((key) => typeof key !== 'string')
    || keys.some((key) => !required.includes(key))) {
    throw new FailureLoopError('FAILURE_INITIAL_STATE_INVALID');
  }
  const output = {};
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new FailureLoopError('FAILURE_INITIAL_STATE_INVALID');
    }
    output[key] = descriptor.value;
  }
  return output;
}

/**
 * Build the durable, pre-operation Guard state without constructing a Guard or
 * touching its Store/resolver collaborators.  This is deliberately a pure
 * schema seam for the manager bootstrap snapshot.
 */
function createInitialFailureLoopState(value) {
  try {
    const input = readInitialStateInput(value);
    if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId)
      || typeof input.guardId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.guardId)
      || !Number.isSafeInteger(input.retryBudget) || input.retryBudget < 0
      || !Number.isSafeInteger(input.repairBudget) || input.repairBudget < 0) {
      throw new FailureLoopError('FAILURE_INITIAL_STATE_INVALID');
    }
    const payload = {
      schema: FAILURE_STATE_VERSION,
      runId: input.runId,
      guardId: input.guardId,
      revision: 1,
      previousStateSha256: null,
      retryBudget: input.retryBudget,
      repairBudget: input.repairBudget,
      retryUsed: 0,
      repairUsed: 0,
      activeFingerprint: null,
      operationBindings: [],
      consumedExitFamilies: [],
      failures: [],
    };
    return detached({ ...payload, stateSha256: computeDetachedSha256(payload) });
  } catch (error) {
    if (error instanceof FailureLoopError) throw error;
    throw new FailureLoopError('FAILURE_INITIAL_STATE_INVALID');
  }
}

function resolverAccepts(resolver, context) {
  if (typeof resolver !== 'function') return false;
  try {
    return resolver(detached(context)) === true;
  } catch (_) {
    return false;
  }
}

function resolveClassification(resolver, observation) {
  if (typeof resolver !== 'function') return null;
  try {
    const result = resolver(detached({ purpose: 'failure_classification', observation }));
    return FAILURE_CLASSIFICATIONS.has(result) ? result : null;
  } catch (_) {
    return null;
  }
}

function normalizedOperationIdentityBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const binding = detached(value);
    const keys = Object.keys(binding).sort(compareCodeUnits);
    if (keys.length !== 2 || keys[0] !== 'bindingRef' || keys[1] !== 'canonicalOperationId'
      || !CANONICAL_OPERATION_ID.test(binding.canonicalOperationId)
      || !nonEmpty(binding.bindingRef)) return null;
    return detached({
      canonicalOperationId: binding.canonicalOperationId,
      bindingRef: binding.bindingRef,
    });
  } catch (_) {
    return null;
  }
}

function resolveOperationIdentity(resolver, context) {
  if (typeof resolver !== 'function') return null;
  try {
    return normalizedOperationIdentityBinding(resolver(detached(context)));
  } catch (_) {
    return null;
  }
}

function invokeResolver(guard, resolver, context) {
  const expected = captureCallbackState(guard);
  const accepted = resolverAccepts(resolver, context);
  assertCallbackState(guard, expected);
  return accepted;
}

function invokeClassificationResolver(guard, resolver, observation) {
  const expected = captureCallbackState(guard);
  const classification = resolveClassification(resolver, observation);
  assertCallbackState(guard, expected);
  return classification;
}

function invokeOperationIdentityResolver(guard, resolver, context) {
  const expected = captureCallbackState(guard);
  const binding = resolveOperationIdentity(resolver, context);
  assertCallbackState(guard, expected);
  return binding;
}

function bindOperationIdentity(guard, observation) {
  const state = internalState(guard);
  let binding;
  if (state.operationIdentityResolver !== null) {
    binding = invokeOperationIdentityResolver(guard, state.operationIdentityResolver, {
      purpose: 'failure_operation_identity',
      runId: guard.runId,
      guardId: guard.guardId,
      observedCommandId: observation.commandId,
      operationIdentityRef: observation.operationIdentityRef,
      phase: observation.phase,
      checkpoint: observation.checkpoint,
      inputHashes: observation.inputHashes,
    });
  } else if (CANONICAL_OPERATION_ID.test(observation.commandId)) {
    binding = detached({
      canonicalOperationId: observation.commandId,
      bindingRef: `exact-command-id:${computeDetachedSha256(detached({
        commandId: observation.commandId,
      }))}`,
    });
  }
  if (binding === null || binding === undefined) {
    throw new FailureLoopError('FAILURE_OPERATION_IDENTITY_UNTRUSTED');
  }
  const existing = state.operationBindings.get(observation.commandId);
  if (existing && !sameValue(existing, binding)) {
    throw new FailureLoopError('FAILURE_OPERATION_IDENTITY_DRIFT');
  }
  if (!existing) {
    if (state.operationBindings.size >= state.limits.maxOperationBindings) {
      throw new FailureLoopError('FAILURE_OPERATION_BINDING_LIMIT_REACHED');
    }
    state.operationBindings.set(observation.commandId, binding);
  }
  return binding;
}

function invokeExitResolver(guard, resolver, context, failure, generation) {
  const expected = captureExitState(guard, failure, generation);
  const accepted = resolverAccepts(resolver, context);
  assertExitState(guard, expected);
  return accepted;
}

function controlled(action, reasons, extra = {}) {
  return detached({ action, reasons: Array.from(new Set(reasons)), ...extra });
}

function sameValue(left, right) {
  try {
    return canonicalizeDetachedSnapshot(detached(left))
      === canonicalizeDetachedSnapshot(detached(right));
  } catch (_) {
    return false;
  }
}

class FailureLoopGuard {
  constructor(options = {}) {
    if (!Number.isSafeInteger(options.retryBudget) || options.retryBudget < 0
      || !Number.isSafeInteger(options.repairBudget) || options.repairBudget < 0) {
      throw new FailureLoopError('FAILURE_BUDGET_INVALID');
    }
    if (!nonEmpty(options.runId) || !nonEmpty(options.guardId)) {
      throw new FailureLoopError('FAILURE_GUARD_IDENTITY_INVALID');
    }
    if (!options.store || typeof options.store.load !== 'function' || typeof options.store.save !== 'function') {
      throw new FailureLoopError('FAILURE_STORE_REQUIRED');
    }
    if (typeof options.evidenceResolver !== 'function'
      || typeof options.classificationResolver !== 'function'
      || typeof options.authorizationResolver !== 'function'
      || typeof options.trustedStateResolver !== 'function') {
      throw new FailureLoopError('FAILURE_TRUST_RESOLVER_REQUIRED');
    }
    const limits = normalizeLimits(options.limits);
    INTERNAL_STATE.set(this, {
      store: options.store,
      evidenceResolver: options.evidenceResolver,
      classificationResolver: options.classificationResolver,
      authorizationResolver: options.authorizationResolver,
      trustedStateResolver: options.trustedStateResolver,
      operationIdentityResolver: typeof options.operationIdentityResolver === 'function'
        ? options.operationIdentityResolver
        : null,
      limits,
      budgets: { retryUsed: 0, repairUsed: 0 },
      failures: new Map(),
      activeFingerprint: null,
      consumedExitFamilies: new Set(),
      operationBindings: new Map(),
      stateRevision: 0,
      stateHeadSha256: null,
      persistedState: null,
      operationActive: false,
      operationToken: null,
      operationCompromised: false,
    });
    Object.defineProperties(this, {
      runId: {
        value: options.runId,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      guardId: {
        value: options.guardId,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      retryBudget: {
        value: options.retryBudget,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      repairBudget: {
        value: options.repairBudget,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      retryUsed: {
        enumerable: true,
        configurable: false,
        get: () => internalState(this).budgets.retryUsed,
      },
      repairUsed: {
        enumerable: true,
        configurable: false,
        get: () => internalState(this).budgets.repairUsed,
      },
    });
    let saved;
    try {
      saved = internalState(this).store.load({ runId: this.runId, guardId: this.guardId });
    } catch (_) {
      throw new FailureLoopError('FAILURE_STORE_READ_FAILED');
    }
    if (saved !== null && saved !== undefined) this._restore(saved, INTERNAL_AUTHORITY, true);
    else this._persist();
    Object.preventExtensions(this);
  }

  recordFailure(observation) {
    return this._withRollback(() => runPublicOperation(
      this,
      () => this._recordFailure(observation, INTERNAL_AUTHORITY),
    ));
  }

  _recordFailure(observation, authority) {
    requireInternalAuthority(authority);
    const state = internalState(this);
    const observedFailure = sanitizeFailure(observation);
    const operationIdentity = bindOperationIdentity(this, observedFailure);
    const safeObservation = detached({
      ...observedFailure,
      observedCommandId: observedFailure.commandId,
      commandId: operationIdentity.canonicalOperationId,
      operationIdentityBindingRef: operationIdentity.bindingRef,
    });
    const fingerprint = computeFailureFingerprint(safeObservation);
    const familyFingerprint = computeFailureFamily(safeObservation);
    const semantics = semanticEvidence(safeObservation);
    const semanticsHash = computeDetachedSha256(semantics);
    const evidenceRefs = normalizedStrings(safeObservation.evidenceRefs);
    const trustedEvidence = evidenceRefs.length > 0 && invokeResolver(this, state.evidenceResolver, {
      purpose: 'failure_evidence',
      runId: this.runId,
      guardId: this.guardId,
      observation: safeObservation,
      evidenceRefs,
    });
    const trustedClassification = invokeClassificationResolver(
      this,
      state.classificationResolver,
      safeObservation,
    );
    let failure = state.failures.get(fingerprint);
    if (!failure) {
      if (state.failures.size >= state.limits.maxFailures) {
        throw new FailureLoopError('FAILURE_LIMIT_REACHED');
      }
      if (trustedEvidence && evidenceRefs.length > state.limits.maxEvidenceRefsPerFailure) {
        throw new FailureLoopError('FAILURE_EVIDENCE_LIMIT_REACHED');
      }
      failure = {
        fingerprint,
        familyFingerprint,
        currentGeneration: 1,
        evidenceRefs: new Set(trustedEvidence ? evidenceRefs : []),
        semanticsHash,
        generations: new Map(),
      };
      failure.generations.set(1, this._newGeneration(1, semantics, safeObservation));
      state.failures.set(fingerprint, failure);
    } else {
      const hasNewEvidence = trustedEvidence
        && evidenceRefs.some((item) => !failure.evidenceRefs.has(item));
      if (trustedEvidence) {
        const nextEvidenceRefs = new Set([...failure.evidenceRefs, ...evidenceRefs]);
        if (nextEvidenceRefs.size > state.limits.maxEvidenceRefsPerFailure) {
          throw new FailureLoopError('FAILURE_EVIDENCE_LIMIT_REACHED');
        }
      }
      if (semanticsHash !== failure.semanticsHash && hasNewEvidence) {
        if (failure.generations.size >= state.limits.maxGenerationsPerFailure) {
          throw new FailureLoopError('FAILURE_GENERATION_LIMIT_REACHED');
        }
        failure.currentGeneration += 1;
        failure.semanticsHash = semanticsHash;
        failure.generations.set(
          failure.currentGeneration,
          this._newGeneration(failure.currentGeneration, semantics, safeObservation),
        );
      }
      if (trustedEvidence) for (const item of evidenceRefs) failure.evidenceRefs.add(item);
    }
    state.activeFingerprint = fingerprint;
    const generation = failure.generations.get(failure.currentGeneration);
    if (generation.records.length >= state.limits.maxRecordsPerGeneration) {
      this._markSummaryEligible(generation, 'FAILURE_RECORD_LIMIT_REACHED');
      this._ensureSummary(failure, generation);
      return this._persistResult(this._result(
        failure,
        generation,
        'STOP_AND_PRESERVE',
        ['FAILURE_RECORD_LIMIT_REACHED'],
      ));
    }
    generation.records.push(safeObservation);
    generation.lastOccurredAt = nonEmpty(safeObservation.occurredAt)
      ? safeObservation.occurredAt
      : generation.lastOccurredAt;
    generation.hypotheses.add(safeObservation.hypothesis);
    if (trustedEvidence) for (const item of evidenceRefs) generation.evidenceRefs.add(item);

    if (state.consumedExitFamilies.has(familyFingerprint)) {
      this._markSummaryEligible(generation, 'FAILURE_FAMILY_EXIT_ALREADY_USED');
      this._ensureSummary(failure, generation);
      return this._persistResult(this._result(
        failure,
        generation,
        'STOP_AND_PRESERVE',
        ['FAILURE_FAMILY_EXIT_ALREADY_USED'],
        { summaryReused: generation.summary !== null },
      ));
    }

    if (generation.exitAttemptConsumed) {
      return this._persistResult(this._result(failure, generation, 'STOP_AND_PRESERVE', ['SAME_FAILURE_AFTER_EXIT_ATTEMPT'], {
        summaryReused: generation.summary !== null,
      }));
    }

    if (generation.records.length > 1) {
      const reused = generation.summary !== null;
      this._markSummaryEligible(generation, 'REPEATED_FAILURE');
      this._ensureSummary(failure, generation);
      return this._persistResult(this._result(failure, generation, 'SUMMARIZE_AND_STOP_DISPATCH', ['REPEATED_FAILURE'], {
        summaryReused: reused,
      }));
    }

    let action = 'HOLD';
    const reasons = [];
    if (trustedClassification === null || trustedClassification !== safeObservation.classification) {
      reasons.push('CLASSIFICATION_NOT_VERIFIED');
    } else if (!trustedEvidence) {
      reasons.push('FAILURE_EVIDENCE_NOT_VERIFIED');
    } else if (safeObservation.classification === 'environment') {
      action = safeObservation.sideEffectState === 'none' ? 'WAIT_EXTERNAL' : 'HOLD';
      reasons.push(action === 'WAIT_EXTERNAL' ? 'ENVIRONMENT_REQUIRES_EXTERNAL_CHANGE' : 'SIDE_EFFECT_STATE_NOT_CLEAN');
    } else if (safeObservation.classification === 'transient' && safeObservation.attemptKind === 'retry') {
      if (safeObservation.sideEffectState !== 'none') {
        reasons.push('SIDE_EFFECT_STATE_NOT_CLEAN');
      } else if (!nonEmpty(safeObservation.idempotencyKey) || !nonEmpty(safeObservation.retryPolicyRef)) {
        reasons.push('RETRY_IDEMPOTENCY_NOT_PROVEN');
      } else if (this.retryUsed < this.retryBudget) {
        state.budgets.retryUsed += 1;
        action = 'RETRY';
        reasons.push('TRANSIENT_WITHIN_RETRY_BUDGET');
      } else {
        this._markSummaryEligible(generation, 'RETRY_BUDGET_EXHAUSTED');
        this._ensureSummary(failure, generation);
        action = 'SUMMARIZE_AND_STOP_DISPATCH';
        reasons.push('RETRY_BUDGET_EXHAUSTED');
      }
    } else if (safeObservation.classification === 'code_defect' && safeObservation.attemptKind === 'repair') {
      if (safeObservation.sideEffectState !== 'none') {
        reasons.push('SIDE_EFFECT_STATE_NOT_CLEAN');
      } else if (!SHA256.test(safeObservation.changeSetHash || '') || !nonEmpty(safeObservation.repairScope)) {
        reasons.push('REPAIR_BOUNDARY_INCOMPLETE');
      } else if (this.repairUsed < this.repairBudget) {
        state.budgets.repairUsed += 1;
        action = 'REPAIR';
        reasons.push('EVIDENCED_CODE_DEFECT');
      } else {
        this._markSummaryEligible(generation, 'REPAIR_BUDGET_EXHAUSTED');
        this._ensureSummary(failure, generation);
        action = 'SUMMARIZE_AND_STOP_DISPATCH';
        reasons.push('REPAIR_BUDGET_EXHAUSTED');
      }
    } else {
      reasons.push('FAILURE_CLASSIFICATION_NOT_ACTIONABLE');
    }
    return this._persistResult(this._result(failure, generation, action, reasons));
  }

  summarize(generationNumber) {
    return this._withRollback(() => runPublicOperation(
      this,
      () => this._summarize(generationNumber, INTERNAL_AUTHORITY),
    ));
  }

  _summarize(generationNumber, authority) {
    requireInternalAuthority(authority);
    const { failure, generation } = this._activeGeneration(generationNumber, INTERNAL_AUTHORITY);
    if (!generation.summaryEligible || !SUMMARY_TRIGGERS.has(generation.summaryTrigger)) {
      return controlled('HOLD', ['LOOP_SUMMARY_NOT_ELIGIBLE'], {
        generation: generation.generation,
        fingerprint: failure.fingerprint,
      });
    }
    const summary = this._ensureSummary(failure, generation);
    this._persist();
    return summary;
  }

  chooseExit(input = {}) {
    return this._withRollback(() => runPublicOperation(
      this,
      () => this._chooseExit(input, INTERNAL_AUTHORITY),
    ));
  }

  _chooseExit(input = {}, authority) {
    requireInternalAuthority(authority);
    const state = internalState(this);
    let active;
    try {
      active = this._activeGeneration(input.generation, INTERNAL_AUTHORITY);
    } catch (_) {
      return controlled('HOLD', ['LOOP_GENERATION_NOT_FOUND']);
    }
    const { failure, generation } = active;
    if (generation.generation !== failure.currentGeneration) {
      return controlled('HOLD', ['LOOP_GENERATION_NOT_CURRENT'], {
        generation: generation.generation,
        currentGeneration: failure.currentGeneration,
        fingerprint: failure.fingerprint,
      });
    }
    if (!generation.summaryEligible || !SUMMARY_TRIGGERS.has(generation.summaryTrigger)) {
      return controlled('HOLD', ['LOOP_SUMMARY_NOT_ELIGIBLE']);
    }
    if (generation.summary === null) return controlled('HOLD', ['LOOP_SUMMARY_REQUIRED']);
    if (state.consumedExitFamilies.has(failure.familyFingerprint)) {
      return controlled('STOP_AND_PRESERVE', ['FAILURE_FAMILY_EXIT_ALREADY_USED'], {
        generation: generation.generation,
        fingerprint: failure.fingerprint,
      });
    }
    if (generation.exitAttemptConsumed) {
      return controlled('STOP_AND_PRESERVE', ['BOUNDED_EXIT_ATTEMPT_ALREADY_USED'], {
        generation: generation.generation,
        fingerprint: failure.fingerprint,
      });
    }
    if (!EXIT_METHODS.has(input.method)) return controlled('HOLD', ['EXIT_METHOD_UNSUPPORTED']);
    if (input.maxAttempts !== 1) return controlled('HOLD', ['EXIT_ATTEMPT_MUST_BE_ONE']);
    const evidenceRefs = normalizedStrings(input.evidenceRefs);
    const forbiddenActions = normalizedStrings(input.forbiddenActions);
    if (!nonEmpty(input.successCriterion) || !nonEmpty(input.failureCriterion)
      || !nonEmpty(input.cleanupCondition) || forbiddenActions.length === 0) {
      return controlled('HOLD', ['EXIT_BOUNDARY_INCOMPLETE']);
    }
    if (input.method === 'RESTORE_KNOWN_GOOD'
      && (!SHA256.test(input.restoreTargetHash || '')
        || !nonEmpty(input.restoreScope)
        || !nonEmpty(input.rollbackCondition))) {
      return controlled('HOLD', ['RESTORE_BOUNDARY_INCOMPLETE']);
    }
    const exitPlan = detached({
      method: input.method,
      evidenceRefs,
      successCriterion: input.successCriterion,
      failureCriterion: input.failureCriterion,
      cleanupCondition: input.cleanupCondition,
      forbiddenActions,
      maxAttempts: 1,
      ...(input.method === 'RESTORE_KNOWN_GOOD' ? {
        restoreTargetHash: input.restoreTargetHash,
        restoreScope: input.restoreScope,
        rollbackCondition: input.rollbackCondition,
      } : {}),
    });
    const exitPlanSha256 = computeDetachedSha256(exitPlan);
    if (evidenceRefs.length === 0
      || evidenceRefs.some((item) => !generation.evidenceRefs.has(item))
      || !invokeExitResolver(this, state.evidenceResolver, {
        purpose: 'failure_loop_exit_evidence',
        runId: this.runId,
        guardId: this.guardId,
        evidenceRefs,
        fingerprint: failure.fingerprint,
        familyFingerprint: failure.familyFingerprint,
        generation: generation.generation,
        exitPlan,
        exitPlanSha256,
      }, failure, generation)) return controlled('HOLD', ['EXIT_EVIDENCE_REQUIRED']);
    if (!nonEmpty(input.authorizationRef)
      || !invokeExitResolver(this, state.authorizationResolver, {
        purpose: 'failure_loop_exit',
        runId: this.runId,
        guardId: this.guardId,
        authorizationRef: input.authorizationRef,
        method: input.method,
        generation: generation.generation,
        fingerprint: failure.fingerprint,
        familyFingerprint: failure.familyFingerprint,
        exitPlan,
        exitPlanSha256,
      }, failure, generation)) return controlled('HOLD', ['EXIT_NOT_AUTHORIZED']);
    if (input.method === 'RESTORE_KNOWN_GOOD'
      && (!nonEmpty(input.reversibleAuthorizationRef)
        || !invokeExitResolver(this, state.authorizationResolver, {
        purpose: 'restore_known_good',
        runId: this.runId,
        guardId: this.guardId,
        authorizationRef: input.reversibleAuthorizationRef,
        generation: generation.generation,
        fingerprint: failure.fingerprint,
        familyFingerprint: failure.familyFingerprint,
        exitPlan,
        exitPlanSha256,
      }, failure, generation))) {
      return controlled('HOLD', ['RESTORE_AUTHORIZATION_REQUIRED']);
    }
    generation.exitDecision = detached({
      exitPlan,
      exitPlanSha256,
      authorizationRef: input.authorizationRef,
      reversibleAuthorizationRef: input.method === 'RESTORE_KNOWN_GOOD'
        ? input.reversibleAuthorizationRef
        : null,
    });
    if (input.method === 'STOP_AND_PRESERVE') {
      generation.exitAttemptConsumed = true;
      state.consumedExitFamilies.add(failure.familyFingerprint);
      return this._persistResult(controlled('STOP_AND_PRESERVE', ['EXPLICIT_STOP_SELECTED'], {
        generation: generation.generation,
        fingerprint: failure.fingerprint,
        exitPlanSha256,
      }));
    }
    generation.exitAttemptConsumed = true;
    state.consumedExitFamilies.add(failure.familyFingerprint);
    const action = input.method === 'WAIT_EXTERNAL'
      ? 'WAIT_EXTERNAL'
      : input.method === 'REQUEST_USER_DECISION'
        ? 'REQUEST_USER_DECISION'
        : 'ALLOW_ONE_BOUNDED_ATTEMPT';
    return this._persistResult(controlled(action, ['EVIDENCED_BOUNDED_EXIT'], {
      generation: generation.generation,
      fingerprint: failure.fingerprint,
      method: input.method,
      maxAttempts: 1,
      cleanupCondition: input.cleanupCondition,
      exitPlanSha256,
    }));
  }

  snapshot() {
    return runPublicOperation(this, () => this._snapshot(INTERNAL_AUTHORITY));
  }

  _snapshot(authority) {
    requireInternalAuthority(authority);
    const state = internalState(this);
    const failures = Array.from(state.failures.values())
      .sort((left, right) => compareCodeUnits(left.fingerprint, right.fingerprint))
      .map((failure) => ({
        fingerprint: failure.fingerprint,
        familyFingerprint: failure.familyFingerprint,
        currentGeneration: failure.currentGeneration,
        evidenceRefs: Array.from(failure.evidenceRefs).sort(compareCodeUnits),
        generations: Array.from(failure.generations.values())
          .sort((left, right) => left.generation - right.generation)
          .map((generation) => ({
            generation: generation.generation,
            recordCount: generation.records.length,
            summaryEligible: generation.summaryEligible,
            summaryTrigger: generation.summaryTrigger,
            exitAttemptConsumed: generation.exitAttemptConsumed,
            summary: generation.summary,
          })),
      }));
    return detached({
      version: FAILURE_FINGERPRINT_VERSION,
      runId: this.runId,
      guardId: this.guardId,
      budgets: this._budgets(),
      operationBindings: Array.from(state.operationBindings.entries())
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([observedCommandId, binding]) => ({ observedCommandId, ...binding })),
      consumedExitFamilies: Array.from(state.consumedExitFamilies).sort(compareCodeUnits),
      failures,
    });
  }

  _serializedState() {
    const internal = internalState(this);
    const failures = Array.from(internal.failures.values())
      .sort((left, right) => compareCodeUnits(left.fingerprint, right.fingerprint))
      .map((failure) => ({
        fingerprint: failure.fingerprint,
        familyFingerprint: failure.familyFingerprint,
        currentGeneration: failure.currentGeneration,
        evidenceRefs: Array.from(failure.evidenceRefs).sort(compareCodeUnits),
        semanticsHash: failure.semanticsHash,
        generations: Array.from(failure.generations.values())
          .sort((left, right) => left.generation - right.generation)
          .map((generation) => ({
            generation: generation.generation,
            semantics: generation.semantics,
            firstOccurredAt: generation.firstOccurredAt,
            lastOccurredAt: generation.lastOccurredAt,
            records: generation.records,
            hypotheses: Array.from(generation.hypotheses).sort(compareCodeUnits),
            evidenceRefs: Array.from(generation.evidenceRefs).sort(compareCodeUnits),
            summaryEligible: generation.summaryEligible,
            summaryTrigger: generation.summaryTrigger,
            summary: generation.summary,
            exitAttemptConsumed: generation.exitAttemptConsumed,
            exitDecision: generation.exitDecision,
          })),
      }));
    try {
      const payload = detached({
        schema: FAILURE_STATE_VERSION,
        runId: this.runId,
        guardId: this.guardId,
        revision: internal.stateRevision + 1,
        previousStateSha256: internal.stateHeadSha256,
        retryBudget: this.retryBudget,
        repairBudget: this.repairBudget,
        retryUsed: this.retryUsed,
        repairUsed: this.repairUsed,
        activeFingerprint: internal.activeFingerprint,
        operationBindings: Array.from(internal.operationBindings.entries())
          .sort(([left], [right]) => compareCodeUnits(left, right))
          .map(([observedCommandId, binding]) => ({ observedCommandId, ...binding })),
        consumedExitFamilies: Array.from(internal.consumedExitFamilies).sort(compareCodeUnits),
        failures,
      });
      const state = detached({ ...payload, stateSha256: computeDetachedSha256(payload) });
      if (Buffer.byteLength(canonicalizeDetachedSnapshot(state), 'utf8') > internal.limits.maxStateBytes) {
        throw new FailureLoopError('FAILURE_STATE_LIMIT_REACHED');
      }
      return state;
    } catch (caught) {
      if (caught instanceof FailureLoopError) throw caught;
      throw new FailureLoopError('FAILURE_STATE_LIMIT_REACHED');
    }
  }

  _restore(saved, authority, requireTrust) {
    requireInternalAuthority(authority);
    try {
      const internal = internalState(this);
      const state = detached(saved);
      if (Buffer.byteLength(canonicalizeDetachedSnapshot(state), 'utf8') > internal.limits.maxStateBytes) {
        throw new Error('state too large');
      }
      const { stateSha256, ...payload } = state;
      if (!SHA256.test(stateSha256 || '') || computeDetachedSha256(payload) !== stateSha256
        || payload.schema !== FAILURE_STATE_VERSION
        || payload.runId !== this.runId || payload.guardId !== this.guardId
        || !Number.isSafeInteger(payload.revision) || payload.revision < 1
        || (payload.revision === 1
          ? payload.previousStateSha256 !== null
          : !SHA256.test(payload.previousStateSha256 || ''))
        || payload.retryBudget !== this.retryBudget || payload.repairBudget !== this.repairBudget
        || !Number.isSafeInteger(payload.retryUsed) || payload.retryUsed < 0 || payload.retryUsed > this.retryBudget
        || !Number.isSafeInteger(payload.repairUsed) || payload.repairUsed < 0 || payload.repairUsed > this.repairBudget
        || !Array.isArray(payload.failures) || payload.failures.length > internal.limits.maxFailures
        || !Array.isArray(payload.operationBindings)
        || payload.operationBindings.length > internal.limits.maxOperationBindings
        || !Array.isArray(payload.consumedExitFamilies)
        || payload.consumedExitFamilies.length > internal.limits.maxFailures) {
        throw new Error('invalid state');
      }
      const operationBindings = new Map();
      for (const bindingValue of payload.operationBindings) {
        if (!bindingValue || typeof bindingValue !== 'object' || Array.isArray(bindingValue)
          || !nonEmpty(bindingValue.observedCommandId)
          || !CANONICAL_OPERATION_ID.test(bindingValue.canonicalOperationId)
          || !nonEmpty(bindingValue.bindingRef)
          || operationBindings.has(bindingValue.observedCommandId)) {
          throw new Error('invalid operation binding');
        }
        operationBindings.set(bindingValue.observedCommandId, detached({
          canonicalOperationId: bindingValue.canonicalOperationId,
          bindingRef: bindingValue.bindingRef,
        }));
      }
      const failures = new Map();
      for (const failureValue of payload.failures) {
        if (!SHA256.test(failureValue.fingerprint || '') || !SHA256.test(failureValue.familyFingerprint || '')
          || failures.has(failureValue.fingerprint) || !Array.isArray(failureValue.evidenceRefs)
          || failureValue.evidenceRefs.length > internal.limits.maxEvidenceRefsPerFailure
          || !Array.isArray(failureValue.generations)
          || failureValue.generations.length > internal.limits.maxGenerationsPerFailure) {
          throw new Error('invalid failure');
        }
        const generations = new Map();
        for (const generationValue of failureValue.generations) {
          if (!Number.isSafeInteger(generationValue.generation) || generationValue.generation < 1
            || generations.has(generationValue.generation) || !Array.isArray(generationValue.records)
            || generationValue.records.length > internal.limits.maxRecordsPerGeneration
            || !Array.isArray(generationValue.hypotheses) || !Array.isArray(generationValue.evidenceRefs)
            || generationValue.evidenceRefs.length > internal.limits.maxEvidenceRefsPerFailure
            || typeof generationValue.summaryEligible !== 'boolean'
            || (generationValue.summaryEligible
              ? !SUMMARY_TRIGGERS.has(generationValue.summaryTrigger)
              : generationValue.summaryTrigger !== null)
            || (generationValue.summary !== null
              && (!generationValue.summaryEligible
                || generationValue.summary.summaryTrigger !== generationValue.summaryTrigger))) {
            throw new Error('invalid generation');
          }
          for (const record of generationValue.records) {
            const binding = record && operationBindings.get(record.observedCommandId);
            if (!binding || record.commandId !== binding.canonicalOperationId
              || record.operationIdentityBindingRef !== binding.bindingRef) {
              throw new Error('invalid record operation binding');
            }
          }
          generations.set(generationValue.generation, {
            generation: generationValue.generation,
            semantics: detached(generationValue.semantics),
            firstOccurredAt: generationValue.firstOccurredAt,
            lastOccurredAt: generationValue.lastOccurredAt,
            records: detached(generationValue.records),
            hypotheses: new Set(generationValue.hypotheses),
            evidenceRefs: new Set(generationValue.evidenceRefs),
            summaryEligible: generationValue.summaryEligible,
            summaryTrigger: generationValue.summaryTrigger,
            summary: generationValue.summary === null ? null : detached(generationValue.summary),
            exitAttemptConsumed: generationValue.exitAttemptConsumed === true,
            exitDecision: generationValue.exitDecision === null ? null : detached(generationValue.exitDecision),
          });
        }
        if (!generations.has(failureValue.currentGeneration)) throw new Error('missing current generation');
        failures.set(failureValue.fingerprint, {
          fingerprint: failureValue.fingerprint,
          familyFingerprint: failureValue.familyFingerprint,
          currentGeneration: failureValue.currentGeneration,
          evidenceRefs: new Set(failureValue.evidenceRefs),
          semanticsHash: failureValue.semanticsHash,
          generations,
        });
      }
      if (payload.activeFingerprint !== null && !failures.has(payload.activeFingerprint)) {
        throw new Error('missing active failure');
      }
      if (requireTrust && !invokeResolver(this, internal.trustedStateResolver, {
        purpose: 'failure_state_load',
        runId: this.runId,
        guardId: this.guardId,
        stateRevision: payload.revision,
        previousStateSha256: payload.previousStateSha256,
        stateSha256,
      })) throw new Error('state trust not proven');
      internal.budgets = { retryUsed: payload.retryUsed, repairUsed: payload.repairUsed };
      internal.activeFingerprint = payload.activeFingerprint;
      internal.consumedExitFamilies = new Set(payload.consumedExitFamilies);
      internal.operationBindings = operationBindings;
      internal.failures = failures;
      internal.stateRevision = payload.revision;
      internal.stateHeadSha256 = stateSha256;
      internal.persistedState = state;
    } catch (_) {
      throw new FailureLoopError('FAILURE_STATE_INVALID');
    }
  }

  _persist() {
    const state = internalState(this);
    const next = this._serializedState();
    const assertPendingState = () => {
      if (!sameValue(this._serializedState(), next)) {
        throw new FailureLoopError('FAILURE_OPERATION_STATE_CHANGED');
      }
    };
    const context = detached({
      runId: this.runId,
      guardId: this.guardId,
      expectedRevision: state.stateRevision,
      expectedStateSha256: state.stateHeadSha256,
    });
    let acknowledgement;
    const saveInvariant = captureCallbackState(this);
    try {
      acknowledgement = state.store.save(next, context);
    } catch (_) {
      assertCallbackState(this, saveInvariant);
      throw new FailureLoopError('FAILURE_STORE_WRITE_FAILED');
    }
    assertCallbackState(this, saveInvariant);
    assertPendingState();
    const expectedAcknowledgement = detached({
      persisted: true,
      runId: this.runId,
      guardId: this.guardId,
      expectedRevision: state.stateRevision,
      expectedStateSha256: state.stateHeadSha256,
      revision: next.revision,
      previousStateSha256: next.previousStateSha256,
      stateSha256: next.stateSha256,
    });
    if (!sameValue(acknowledgement, expectedAcknowledgement)) {
      throw new FailureLoopError('FAILURE_STORE_CAS_FAILED');
    }
    let readBack;
    const loadInvariant = captureCallbackState(this);
    try {
      readBack = state.store.load({ runId: this.runId, guardId: this.guardId });
    } catch (_) {
      assertCallbackState(this, loadInvariant);
      throw new FailureLoopError('FAILURE_STORE_READ_FAILED');
    }
    assertCallbackState(this, loadInvariant);
    assertPendingState();
    if (!sameValue(readBack, next)) {
      throw new FailureLoopError('FAILURE_STORE_CAS_FAILED');
    }
    if (!invokeResolver(this, state.trustedStateResolver, {
        purpose: 'failure_state_save_ack',
        runId: this.runId,
        guardId: this.guardId,
        expectedRevision: state.stateRevision,
        expectedStateSha256: state.stateHeadSha256,
        stateRevision: next.revision,
        previousStateSha256: next.previousStateSha256,
        stateSha256: next.stateSha256,
        acknowledgement: expectedAcknowledgement,
      })) {
      throw new FailureLoopError('FAILURE_STORE_CAS_FAILED');
    }
    assertPendingState();
    state.stateRevision = next.revision;
    state.stateHeadSha256 = next.stateSha256;
    state.persistedState = next;
  }

  _persistResult(result) {
    this._persist();
    return result;
  }

  _withRollback(operation) {
    const checkpoint = internalState(this).persistedState;
    try {
      return operation();
    } catch (caught) {
      if (checkpoint !== null) this._restore(checkpoint, INTERNAL_AUTHORITY, false);
      throw caught;
    }
  }

  _newGeneration(generation, semantics, observation) {
    return {
      generation,
      semantics,
      firstOccurredAt: nonEmpty(observation.occurredAt) ? observation.occurredAt : 'not_observable',
      lastOccurredAt: nonEmpty(observation.occurredAt) ? observation.occurredAt : 'not_observable',
      records: [],
      hypotheses: new Set(),
      evidenceRefs: new Set(),
      summaryEligible: false,
      summaryTrigger: null,
      summary: null,
      exitAttemptConsumed: false,
      exitDecision: null,
    };
  }

  _activeGeneration(generationNumber, authority) {
    requireInternalAuthority(authority);
    const state = internalState(this);
    const failure = state.failures.get(state.activeFingerprint);
    if (!failure) throw new FailureLoopError('LOOP_GENERATION_NOT_FOUND');
    const generation = failure.generations.get(generationNumber);
    if (!generation) throw new FailureLoopError('LOOP_GENERATION_NOT_FOUND');
    return { failure, generation };
  }

  _ensureSummary(failure, generation) {
    if (!generation.summaryEligible || !SUMMARY_TRIGGERS.has(generation.summaryTrigger)) {
      throw new FailureLoopError('LOOP_SUMMARY_NOT_ELIGIBLE');
    }
    if (generation.summary !== null) return generation.summary;
    const records = generation.records;
    const last = records[records.length - 1] || {};
    generation.summary = detached({
      version: 'LoopSummary1',
      fingerprint: failure.fingerprint,
      generation: generation.generation,
      summaryTrigger: generation.summaryTrigger,
      firstOccurredAt: generation.firstOccurredAt,
      lastOccurredAt: generation.lastOccurredAt,
      retry: { used: this.retryUsed, remaining: Math.max(0, this.retryBudget - this.retryUsed) },
      repair: { used: this.repairUsed, remaining: Math.max(0, this.repairBudget - this.repairUsed) },
      hypotheses: Array.from(generation.hypotheses),
      unchangedObservations: {
        checkpoint: last.checkpoint,
        errorClass: last.errorClass,
        errorCode: last.errorCode,
        sideEffectState: last.sideEffectState,
      },
      newEvidenceRefs: Array.from(generation.evidenceRefs).sort(compareCodeUnits),
      environmentStatus: last.environmentIdentity || 'not_observable',
      lastSuccessfulState: last.lastSuccessfulState || 'not_observable',
      resources: last.resources || 'not_observable',
      userDecisionNeeded: last.userDecisionNeeded || false,
    });
    return generation.summary;
  }

  _markSummaryEligible(generation, trigger) {
    if (!SUMMARY_TRIGGERS.has(trigger)) {
      throw new FailureLoopError('LOOP_SUMMARY_TRIGGER_INVALID');
    }
    if (!generation.summaryEligible) {
      generation.summaryEligible = true;
      generation.summaryTrigger = trigger;
    }
  }

  _budgets() {
    return {
      retry: { used: this.retryUsed, remaining: Math.max(0, this.retryBudget - this.retryUsed) },
      repair: { used: this.repairUsed, remaining: Math.max(0, this.repairBudget - this.repairUsed) },
    };
  }

  _result(failure, generation, action, reasons, extra = {}) {
    return controlled(action, reasons, {
      version: FAILURE_FINGERPRINT_VERSION,
      fingerprint: failure.fingerprint,
      generation: generation.generation,
      budgets: this._budgets(),
      ...extra,
    });
  }
}

module.exports = {
  EXIT_METHODS: Object.freeze(Array.from(EXIT_METHODS)),
  FAILURE_FINGERPRINT_VERSION,
  FailureLoopError,
  FailureLoopGuard,
  createInitialFailureLoopState,
  computeFailureFingerprint,
};
