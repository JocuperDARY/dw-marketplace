#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');

const {
  FailureLoopGuard,
} = require('../skills/dw-collaboration/scripts/lib/failure-loop-guard');
const {
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('../skills/dw-collaboration/scripts/lib/canonical-json');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const clone = (value) => (value === null || value === undefined
  ? value
  : JSON.parse(JSON.stringify(value)));

function failure(overrides = {}) {
  return {
    phase: 'implementation',
    checkpoint: 'failure-loop-hardening',
    errorClass: 'AssertionError',
    errorCode: 'ERR_HARDENING',
    commandId: 'failure-loop-guard-hardening.test.js',
    inputHashes: [hash('input')],
    artifactHashes: [hash('artifact-a')],
    environmentIdentity: { node: process.version, platform: process.platform },
    sideEffectState: 'none',
    classification: 'code_defect',
    hypothesis: 'guard state was not persisted atomically',
    affectedScope: 'FailureLoopGuard',
    validationConclusion: 'focused hardening test failed',
    evidenceRefs: ['evidence-1'],
    occurredAt: '2026-08-30T00:00:00Z',
    attemptKind: 'repair',
    changeSetHash: hash('change-1'),
    repairScope: 'FailureLoopGuard',
    ...overrides,
  };
}

function validExit(overrides = {}) {
  return {
    generation: 1,
    method: 'MINIMIZE_REPRODUCTION',
    evidenceRefs: ['evidence-1'],
    authorizationRef: 'approval-1',
    maxAttempts: 1,
    successCriterion: 'the reduced case distinguishes the hypothesis',
    failureCriterion: 'the same family recurs without new evidence',
    forbiddenActions: ['broaden permissions'],
    cleanupCondition: 'the task scope remains closed',
    ...overrides,
  };
}

function expectedAcknowledgement(next, context) {
  return {
    persisted: true,
    runId: context.runId,
    guardId: context.guardId,
    expectedRevision: context.expectedRevision,
    expectedStateSha256: context.expectedStateSha256,
    revision: next.revision,
    previousStateSha256: next.previousStateSha256,
    stateSha256: next.stateSha256,
  };
}

function casStore() {
  let current = null;
  const versions = [];
  let nextFailure = null;
  let loadOverride;
  return {
    load() {
      return clone(loadOverride === undefined ? current : loadOverride);
    },
    save(next, context) {
      if (nextFailure !== null) {
        const failureMode = nextFailure;
        nextFailure = null;
        if (failureMode === 'throw') throw new Error('store unavailable');
        if (failureMode === 'no-op') return expectedAcknowledgement(next, context);
      }
      const actualRevision = current === null ? 0 : current.revision;
      const actualHead = current === null ? null : current.stateSha256;
      if (context.expectedRevision !== actualRevision
        || context.expectedStateSha256 !== actualHead) {
        return { persisted: false };
      }
      current = clone(next);
      versions.push(clone(next));
      return expectedAcknowledgement(next, context);
    },
    current: () => clone(current),
    version: (index) => clone(versions[index]),
    failNext: (mode) => { nextFailure = mode; },
    overrideLoad: (value) => { loadOverride = clone(value); },
    clearLoadOverride: () => { loadOverride = undefined; },
  };
}

function trustedStateResolverFor(store, calls = []) {
  return (context) => {
    calls.push(clone(context));
    const current = store.current();
    return current !== null
      && context.stateRevision === current.revision
      && context.stateSha256 === current.stateSha256;
  };
}

function makeGuard(overrides = {}) {
  const store = overrides.store || casStore();
  const trustCalls = overrides.trustCalls || [];
  const options = { ...overrides };
  delete options.trustCalls;
  return new FailureLoopGuard({
    runId: 'run-hardening',
    guardId: 'guard-hardening',
    retryBudget: 2,
    repairBudget: 2,
    store,
    evidenceResolver: () => true,
    classificationResolver: ({ observation }) => observation.classification,
    authorizationResolver: ({ authorizationRef }) => authorizationRef === 'approval-1',
    trustedStateResolver: trustedStateResolverFor(store, trustCalls),
    ...options,
  });
}

test('requires a trusted state resolver and an exact durable CAS acknowledgement', () => {
  const missingResolverStore = casStore();
  assert.throws(
    () => new FailureLoopGuard({
      runId: 'run-hardening',
      guardId: 'guard-hardening',
      retryBudget: 1,
      repairBudget: 1,
      store: missingResolverStore,
      evidenceResolver: () => true,
      classificationResolver: ({ observation }) => observation.classification,
      authorizationResolver: () => true,
    }),
    /FAILURE_TRUST_RESOLVER_REQUIRED/,
  );

  const noOpStore = casStore();
  noOpStore.failNext('no-op');
  assert.throws(
    () => makeGuard({ store: noOpStore }),
    /FAILURE_STORE_CAS_FAILED/,
  );

  const store = casStore();
  const trustCalls = [];
  makeGuard({ store, trustCalls });
  const initial = store.current();
  assert.strictEqual(initial.revision, 1);
  assert.strictEqual(initial.previousStateSha256, null);
  assert.match(initial.stateSha256, /^[0-9a-f]{64}$/);
  assert(trustCalls.some(({ purpose }) => purpose === 'failure_state_save_ack'));
});

test('rolls back record, summary, budget, generation, evidence, and exit state on persistence failure', () => {
  const recordStore = casStore();
  const recordGuard = makeGuard({ store: recordStore });
  const recordBefore = recordGuard.snapshot();
  recordStore.failNext('throw');
  assert.throws(() => recordGuard.recordFailure(failure()), /FAILURE_STORE_WRITE_FAILED/);
  assert.deepStrictEqual(recordGuard.snapshot(), recordBefore);
  assert.strictEqual(recordGuard.recordFailure(failure()).action, 'REPAIR');
  const generationBefore = recordGuard.snapshot();
  recordStore.failNext('throw');
  assert.throws(
    () => recordGuard.recordFailure(failure({
      hypothesis: 'new evidence would otherwise create a generation',
      validationConclusion: 'the failed write must erase that generation',
      evidenceRefs: ['evidence-2'],
    })),
    /FAILURE_STORE_WRITE_FAILED/,
  );
  assert.deepStrictEqual(recordGuard.snapshot(), generationBefore);

  const summaryStore = casStore();
  const summaryGuard = makeGuard({ store: summaryStore });
  assert.strictEqual(summaryGuard.recordFailure(failure()).action, 'REPAIR');
  assert.strictEqual(
    summaryGuard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' })).action,
    'SUMMARIZE_AND_STOP_DISPATCH',
  );
  const summaryBefore = summaryGuard.snapshot();
  summaryStore.failNext('throw');
  assert.throws(() => summaryGuard.summarize(1), /FAILURE_STORE_WRITE_FAILED/);
  assert.deepStrictEqual(summaryGuard.snapshot(), summaryBefore);

  const exitStore = casStore();
  const exitGuard = makeGuard({ store: exitStore });
  exitGuard.recordFailure(failure());
  exitGuard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' }));
  const exitBefore = exitGuard.snapshot();
  exitStore.failNext('throw');
  assert.throws(() => exitGuard.chooseExit(validExit()), /FAILURE_STORE_WRITE_FAILED/);
  assert.deepStrictEqual(exitGuard.snapshot(), exitBefore);
  assert.strictEqual(exitGuard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
});

test('rejects stale snapshots and concurrent writers with a monotonic hash-linked CAS state', () => {
  const store = casStore();
  const first = makeGuard({ store });
  const initial = store.current();
  const concurrent = makeGuard({ store });
  const concurrentBefore = concurrent.snapshot();

  assert.strictEqual(first.recordFailure(failure()).action, 'REPAIR');
  const newest = store.current();
  assert.strictEqual(newest.revision, initial.revision + 1);
  assert.strictEqual(newest.previousStateSha256, initial.stateSha256);

  assert.throws(
    () => concurrent.recordFailure(failure()),
    /FAILURE_STORE_CAS_FAILED/,
  );
  assert.deepStrictEqual(concurrent.snapshot(), concurrentBefore);

  store.overrideLoad(initial);
  assert.throws(() => makeGuard({ store }), /FAILURE_STATE_INVALID/);
  store.clearLoadOverride();
});

test('does not summarize or choose an exit before a persisted stop trigger', () => {
  const store = casStore();
  const guard = makeGuard({ store, repairBudget: 3 });
  assert.strictEqual(guard.recordFailure(failure()).action, 'REPAIR');
  const revisionBefore = store.current().revision;

  const prematureSummary = guard.summarize(1);
  assert.strictEqual(prematureSummary.action, 'HOLD');
  assert(prematureSummary.reasons.includes('LOOP_SUMMARY_NOT_ELIGIBLE'));
  assert.strictEqual(store.current().revision, revisionBefore);
  const prematureExit = guard.chooseExit(validExit());
  assert.strictEqual(prematureExit.action, 'HOLD');
  assert(prematureExit.reasons.includes('LOOP_SUMMARY_NOT_ELIGIBLE'));

  assert.strictEqual(
    guard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' })).action,
    'SUMMARIZE_AND_STOP_DISPATCH',
  );
  const generation = guard.snapshot().failures[0].generations[0];
  assert.strictEqual(generation.summaryEligible, true);
  assert.strictEqual(generation.summaryTrigger, 'REPEATED_FAILURE');
  const restored = makeGuard({ store, repairBudget: 3 });
  const restoredGeneration = restored.snapshot().failures[0].generations[0];
  assert.strictEqual(restoredGeneration.summaryEligible, true);
  assert.strictEqual(restoredGeneration.summaryTrigger, 'REPEATED_FAILURE');
  assert.strictEqual(restored.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
});

test('allows exit selection only for the current failure generation', () => {
  const guard = makeGuard({ repairBudget: 4 });
  assert.strictEqual(guard.recordFailure(failure()).action, 'REPAIR');
  assert.strictEqual(
    guard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' })).action,
    'SUMMARIZE_AND_STOP_DISPATCH',
  );
  const advanced = guard.recordFailure(failure({
    hypothesis: 'new trusted evidence creates the current generation',
    validationConclusion: 'generation two has a different verified hypothesis',
    evidenceRefs: ['evidence-2'],
    occurredAt: '2026-08-30T00:02:00Z',
  }));
  assert.strictEqual(advanced.generation, 2);
  assert.strictEqual(advanced.action, 'REPAIR');

  const staleExit = guard.chooseExit(validExit({ generation: 1 }));
  assert.strictEqual(staleExit.action, 'HOLD');
  assert(staleExit.reasons.includes('LOOP_GENERATION_NOT_CURRENT'));
  const prematureCurrentExit = guard.chooseExit(validExit({
    generation: 2,
    evidenceRefs: ['evidence-2'],
  }));
  assert.strictEqual(prematureCurrentExit.action, 'HOLD');
  assert(prematureCurrentExit.reasons.includes('LOOP_SUMMARY_NOT_ELIGIBLE'));
});

function consumeOneExit(guard) {
  assert.strictEqual(guard.recordFailure(failure()).action, 'REPAIR');
  assert.strictEqual(
    guard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' })).action,
    'SUMMARIZE_AND_STOP_DISPATCH',
  );
  assert.strictEqual(guard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
}

test('never grants a second exit to a consumed family after artifact or generation changes', () => {
  const artifactGuard = makeGuard();
  consumeOneExit(artifactGuard);
  const changedArtifact = artifactGuard.recordFailure(failure({
    artifactHashes: [hash('artifact-b')],
    hypothesis: 'the regenerated artifact changed the visible failure',
    validationConclusion: 'the same failure family remains',
    evidenceRefs: ['evidence-2'],
    occurredAt: '2026-08-30T00:02:00Z',
  }));
  assert.strictEqual(changedArtifact.action, 'STOP_AND_PRESERVE');
  assert.strictEqual(
    artifactGuard.chooseExit(validExit({
      generation: changedArtifact.generation,
      evidenceRefs: ['evidence-2'],
    })).action,
    'STOP_AND_PRESERVE',
  );

  const generationGuard = makeGuard();
  consumeOneExit(generationGuard);
  const changedSemantics = generationGuard.recordFailure(failure({
    hypothesis: 'new trusted evidence changes the root-cause hypothesis',
    validationConclusion: 'new evidence creates generation two',
    evidenceRefs: ['evidence-2'],
    occurredAt: '2026-08-30T00:02:00Z',
  }));
  assert.strictEqual(changedSemantics.generation, 2);
  assert.strictEqual(changedSemantics.action, 'STOP_AND_PRESERVE');
  assert.strictEqual(
    generationGuard.chooseExit(validExit({
      generation: 2,
      evidenceRefs: ['evidence-2'],
    })).action,
    'STOP_AND_PRESERVE',
  );
});

test('binds command wrappers to one trusted canonical operation family', () => {
  const mappings = new Map([
    ['test.js', {
      canonicalOperationId: 'test.js',
      bindingRef: 'operation-binding:test.js',
    }],
    ['cmd /c test.js', {
      canonicalOperationId: 'test.js',
      bindingRef: 'operation-binding:test.js',
    }],
    ['other.js', {
      canonicalOperationId: 'other.js',
      bindingRef: 'operation-binding:other.js',
    }],
  ]);
  const resolverCalls = [];
  const guard = makeGuard({
    repairBudget: 6,
    operationIdentityResolver: (context) => {
      resolverCalls.push(context);
      return mappings.get(context.observedCommandId) || null;
    },
  });
  const first = guard.recordFailure(failure({ commandId: 'test.js' }));
  assert.strictEqual(first.action, 'REPAIR');
  assert.strictEqual(
    guard.recordFailure(failure({
      commandId: 'test.js',
      occurredAt: '2026-08-30T00:01:00Z',
    })).action,
    'SUMMARIZE_AND_STOP_DISPATCH',
  );
  assert.strictEqual(guard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');

  const wrapped = guard.recordFailure(failure({
    commandId: 'cmd /c test.js',
    occurredAt: '2026-08-30T00:02:00Z',
  }));
  assert.strictEqual(wrapped.action, 'STOP_AND_PRESERVE');
  assert.strictEqual(wrapped.fingerprint, first.fingerprint);
  assert.strictEqual(guard.snapshot().failures.length, 1);

  const different = guard.recordFailure(failure({
    commandId: 'other.js',
    occurredAt: '2026-08-30T00:03:00Z',
  }));
  assert.strictEqual(different.action, 'REPAIR');
  assert.notStrictEqual(different.fingerprint, first.fingerprint);
  assert.strictEqual(guard.snapshot().failures.length, 2);
  assert(resolverCalls.every(({ purpose }) => purpose === 'failure_operation_identity'));

  assert.throws(
    () => makeGuard().recordFailure(failure({ commandId: 'cmd /c test.js' })),
    /FAILURE_OPERATION_IDENTITY_UNTRUSTED/,
  );
});

test('fails closed when a resolver or store callback reenters a public state operation', () => {
  const resolverStore = casStore();
  let resolverGuard;
  let nestedResolverResult;
  let resolverCalls = 0;
  resolverGuard = makeGuard({
    store: resolverStore,
    authorizationResolver: () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        try {
          nestedResolverResult = resolverGuard.chooseExit(validExit());
        } catch (caught) {
          nestedResolverResult = caught;
        }
      }
      return true;
    },
  });
  resolverGuard.recordFailure(failure());
  resolverGuard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' }));
  const resolverBefore = resolverGuard.snapshot();

  assert.throws(
    () => resolverGuard.chooseExit(validExit()),
    /FAILURE_OPERATION_REENTRANT/,
  );
  assert.strictEqual(nestedResolverResult.code, 'FAILURE_OPERATION_REENTRANT');
  assert.deepStrictEqual(resolverGuard.snapshot(), resolverBefore);

  const backingStore = casStore();
  let storeGuard;
  let reenterOnSave = false;
  let nestedStoreResult;
  const reentrantStore = {
    load: (...args) => backingStore.load(...args),
    save(next, context) {
      if (reenterOnSave) {
        reenterOnSave = false;
        try {
          nestedStoreResult = storeGuard.snapshot();
        } catch (caught) {
          nestedStoreResult = caught;
        }
      }
      return backingStore.save(next, context);
    },
    current: () => backingStore.current(),
  };
  storeGuard = makeGuard({ store: reentrantStore });
  const storeBefore = storeGuard.snapshot();
  reenterOnSave = true;

  assert.throws(
    () => storeGuard.recordFailure(failure()),
    /FAILURE_OPERATION_REENTRANT/,
  );
  assert.strictEqual(nestedStoreResult.code, 'FAILURE_OPERATION_REENTRANT');
  assert.deepStrictEqual(storeGuard.snapshot(), storeBefore);
});

test('binds authorization to the complete immutable exit plan and explicit restore target', () => {
  const expectedPlan = {
    method: 'MINIMIZE_REPRODUCTION',
    evidenceRefs: ['evidence-1'],
    successCriterion: 'the reduced case distinguishes the hypothesis',
    failureCriterion: 'the same family recurs without new evidence',
    cleanupCondition: 'the task scope remains closed',
    forbiddenActions: ['broaden permissions'],
    maxAttempts: 1,
  };
  const expectedPlanSha256 = computeDetachedSha256(
    createDetachedJsonSnapshot(expectedPlan).snapshot,
  );
  const authorizationCalls = [];
  const guard = makeGuard({
    authorizationResolver: (context) => {
      authorizationCalls.push(context);
      return context.purpose === 'failure_loop_exit'
        && context.authorizationRef === 'approval-1'
        && context.exitPlanSha256 === expectedPlanSha256
        && computeDetachedSha256(context.exitPlan) === expectedPlanSha256;
    },
  });
  guard.recordFailure(failure());
  guard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' }));

  const changedBoundary = guard.chooseExit(validExit({
    cleanupCondition: 'a different cleanup boundary',
  }));
  assert.strictEqual(changedBoundary.action, 'HOLD');
  assert(changedBoundary.reasons.includes('EXIT_NOT_AUTHORIZED'));
  assert.strictEqual(guard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  const acceptedCall = authorizationCalls.find(
    ({ exitPlanSha256 }) => exitPlanSha256 === expectedPlanSha256,
  );
  assert(acceptedCall);
  assert.deepStrictEqual(acceptedCall.exitPlan, expectedPlan);
  assert(Object.isFrozen(acceptedCall.exitPlan));
  assert(Object.isFrozen(acceptedCall.exitPlan.evidenceRefs));
  assert(Object.isFrozen(acceptedCall.exitPlan.forbiddenActions));

  const restoreTargetHash = hash('known-good-state');
  const restorePlan = {
    method: 'RESTORE_KNOWN_GOOD',
    evidenceRefs: ['evidence-1'],
    successCriterion: 'the known-good state restores the last verified behavior',
    failureCriterion: 'the restore does not reproduce the verified behavior',
    cleanupCondition: 'the replaced state remains retained for rollback',
    forbiddenActions: ['delete the replaced state'],
    maxAttempts: 1,
    restoreTargetHash,
    restoreScope: 'FailureLoopGuard persisted state',
    rollbackCondition: 'restore the retained pre-attempt state on verification failure',
  };
  const restorePlanSha256 = computeDetachedSha256(
    createDetachedJsonSnapshot(restorePlan).snapshot,
  );
  const restoreCalls = [];
  const restoreGuard = makeGuard({
    authorizationResolver: (context) => {
      restoreCalls.push(context);
      const expectedReference = context.purpose === 'restore_known_good'
        ? 'restore-approval-1'
        : 'approval-1';
      return context.authorizationRef === expectedReference
        && context.exitPlanSha256 === restorePlanSha256
        && computeDetachedSha256(context.exitPlan) === restorePlanSha256;
    },
  });
  restoreGuard.recordFailure(failure());
  restoreGuard.recordFailure(failure({ occurredAt: '2026-08-30T00:01:00Z' }));

  const incompleteRestore = restoreGuard.chooseExit(validExit({
    method: 'RESTORE_KNOWN_GOOD',
    successCriterion: restorePlan.successCriterion,
    failureCriterion: restorePlan.failureCriterion,
    cleanupCondition: restorePlan.cleanupCondition,
    forbiddenActions: restorePlan.forbiddenActions,
    reversibleAuthorizationRef: 'restore-approval-1',
    restoreScope: restorePlan.restoreScope,
    rollbackCondition: restorePlan.rollbackCondition,
  }));
  assert.strictEqual(incompleteRestore.action, 'HOLD');
  assert(incompleteRestore.reasons.includes('RESTORE_BOUNDARY_INCOMPLETE'));

  assert.strictEqual(restoreGuard.chooseExit(validExit({
    method: 'RESTORE_KNOWN_GOOD',
    successCriterion: restorePlan.successCriterion,
    failureCriterion: restorePlan.failureCriterion,
    cleanupCondition: restorePlan.cleanupCondition,
    forbiddenActions: restorePlan.forbiddenActions,
    reversibleAuthorizationRef: 'restore-approval-1',
    restoreTargetHash,
    restoreScope: restorePlan.restoreScope,
    rollbackCondition: restorePlan.rollbackCondition,
  })).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  assert.deepStrictEqual(
    restoreCalls.map(({ purpose }) => purpose),
    ['failure_loop_exit', 'restore_known_good'],
  );
  for (const context of restoreCalls) {
    assert.deepStrictEqual(context.exitPlan, restorePlan);
    assert.strictEqual(context.exitPlanSha256, restorePlanSha256);
  }
});

test('enforces cumulative generation, evidence, and serialized-state limits on mutation and restore', () => {
  const generationStore = casStore();
  const generationGuard = makeGuard({
    store: generationStore,
    limits: {
      maxFailures: 2,
      maxRecordsPerGeneration: 2,
      maxGenerationsPerFailure: 2,
      maxEvidenceRefsPerFailure: 3,
      maxStateBytes: 64 * 1024,
    },
  });
  generationGuard.recordFailure(failure());
  generationGuard.recordFailure(failure({
    hypothesis: 'trusted evidence creates generation two',
    validationConclusion: 'generation two is justified',
    evidenceRefs: ['evidence-2'],
  }));
  const generationBefore = generationGuard.snapshot();
  assert.throws(
    () => generationGuard.recordFailure(failure({
      hypothesis: 'trusted evidence attempts generation three',
      validationConclusion: 'generation three exceeds the cumulative limit',
      evidenceRefs: ['evidence-3'],
    })),
    /FAILURE_GENERATION_LIMIT_REACHED/,
  );
  assert.deepStrictEqual(generationGuard.snapshot(), generationBefore);

  assert.throws(
    () => makeGuard({
      store: generationStore,
      limits: {
        maxFailures: 2,
        maxRecordsPerGeneration: 2,
        maxGenerationsPerFailure: 1,
        maxEvidenceRefsPerFailure: 3,
        maxStateBytes: 64 * 1024,
      },
    }),
    /FAILURE_STATE_INVALID/,
  );
  assert.throws(
    () => makeGuard({
      store: generationStore,
      limits: {
        maxFailures: 2,
        maxRecordsPerGeneration: 2,
        maxGenerationsPerFailure: 2,
        maxEvidenceRefsPerFailure: 1,
        maxStateBytes: 64 * 1024,
      },
    }),
    /FAILURE_STATE_INVALID/,
  );
  assert.throws(
    () => makeGuard({
      store: generationStore,
      limits: {
        maxFailures: 2,
        maxRecordsPerGeneration: 2,
        maxGenerationsPerFailure: 2,
        maxEvidenceRefsPerFailure: 3,
        maxStateBytes: 1000,
      },
    }),
    /FAILURE_STATE_INVALID/,
  );

  const evidenceGuard = makeGuard({
    limits: {
      maxFailures: 2,
      maxRecordsPerGeneration: 2,
      maxGenerationsPerFailure: 2,
      maxEvidenceRefsPerFailure: 2,
      maxStateBytes: 64 * 1024,
    },
  });
  const evidenceBefore = evidenceGuard.snapshot();
  assert.throws(
    () => evidenceGuard.recordFailure(failure({
      evidenceRefs: ['evidence-1', 'evidence-2', 'evidence-3'],
    })),
    /FAILURE_EVIDENCE_LIMIT_REACHED/,
  );
  assert.deepStrictEqual(evidenceGuard.snapshot(), evidenceBefore);

  const byteGuard = makeGuard({
    limits: {
      maxFailures: 2,
      maxRecordsPerGeneration: 2,
      maxGenerationsPerFailure: 2,
      maxEvidenceRefsPerFailure: 4,
      maxStateBytes: 1000,
    },
  });
  const byteBefore = byteGuard.snapshot();
  assert.throws(
    () => byteGuard.recordFailure(failure({ hypothesis: 'x'.repeat(1200) })),
    /FAILURE_STATE_LIMIT_REACHED/,
  );
  assert.deepStrictEqual(byteGuard.snapshot(), byteBefore);
});

test('keeps identity, budgets, critical collections, and ordinal ordering outside caller control', () => {
  const guard = makeGuard();
  guard.recordFailure(failure());
  guard.recordFailure(failure({
    errorCode: 'ERR_SECOND',
    evidenceRefs: ['evidence-2'],
    changeSetHash: hash('change-2'),
  }));
  const before = guard.snapshot();

  for (const [field, value] of [
    ['runId', 'other-run'],
    ['guardId', 'other-guard'],
    ['retryBudget', 999],
    ['repairBudget', 999],
    ['retryUsed', 0],
    ['repairUsed', 0],
    ['_failures', new Map()],
    ['_consumedExitFamilies', new Set()],
  ]) {
    assert.throws(() => { guard[field] = value; }, TypeError);
  }
  assert.strictEqual(Object.prototype.hasOwnProperty.call(guard, '_failures'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(guard, '_consumedExitFamilies'), false);
  assert.deepStrictEqual(guard.snapshot(), before);
  assert.throws(() => guard._activeGeneration(1), /FAILURE_INTERNAL_ACCESS_FORBIDDEN/);

  const restoreStore = casStore();
  const restoreGuard = makeGuard({ store: restoreStore });
  const stale = restoreStore.current();
  restoreGuard.recordFailure(failure());
  const restoreBefore = restoreGuard.snapshot();
  assert.throws(
    () => restoreGuard._restore(stale, false),
    /FAILURE_INTERNAL_ACCESS_FORBIDDEN/,
  );
  assert.deepStrictEqual(restoreGuard.snapshot(), restoreBefore);

  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw new Error('locale ordering is forbidden'); };
  try {
    assert.strictEqual(guard.snapshot().failures.length, 2);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (caught) {
    console.error(`not ok - ${name}`);
    console.error(caught && caught.stack ? caught.stack : caught);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`failure loop hardening passed (${passed}/${tests.length})`);
}
