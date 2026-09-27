#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contracts = require('../skills/dw-collaboration/scripts/lib/contracts');
const {
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('../skills/dw-collaboration/scripts/lib/canonical-json');

const {
  TaskResourceTracker,
  ResourceTrackerError,
} = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');
const {
  FAILURE_FINGERPRINT_VERSION,
  FailureLoopGuard,
  computeFailureFingerprint,
} = require('../skills/dw-collaboration/scripts/lib/failure-loop-guard');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const pluginRoot = path.resolve(__dirname, '..');
const sourceHash = (record, field = 'source_sha256') => {
  const copy = clone(record);
  delete copy[field];
  return computeDetachedSha256(createDetachedJsonSnapshot(copy).snapshot);
};

function memoryStore() {
  let value = null;
  return {
    load: () => value,
    save: (next, context) => {
      const actualRevision = value === null ? 0 : value.revision;
      const actualHead = value === null ? null : value.stateSha256;
      if (context.expectedRevision !== actualRevision
        || context.expectedStateSha256 !== actualHead) return { persisted: false };
      value = next;
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
    },
    current: () => value,
  };
}

function processIdentity(overrides = {}) {
  return {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('resource-control-test'),
    parent_identity_hash: hash('parent'),
    nonce: 'launch-nonce-1',
    native_process_manager_run_id: 'native-run-1',
    ...overrides,
  };
}

function processObservation({ absent = false, generation = 1, identity = processIdentity() } = {}) {
  return {
    owner_status: 'owned',
    duplicate_run_lock: false,
    orphaned: false,
    expected_identity: processIdentity(),
    observed_identity: identity,
    expected_generation: 1,
    observed_generation: generation,
    expected_scope: { kind: 'scope', value: 'root' },
    observed_scope: { kind: 'scope', value: 'root' },
    graceful: { requested: true, deadline_reached: true, exit_observed: absent },
    exact_tree_termination_supported: true,
    absence: {
      process_absent: absent,
      thread_absent: absent,
      port_absent: absent,
    },
  };
}

function makeTracker(overrides = {}) {
  return new TaskResourceTracker({
    ownerId: 'root',
    runId: 'run-resource-control',
    generation: 1,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    ...overrides,
  });
}

function resource(resourceId, type = 'process_tree', overrides = {}) {
  return {
    resourceId,
    type,
    purpose: `${resourceId} purpose`,
    teardownCondition: 'scope_close',
    quota: { kind: 'bounded-test', value: 1 },
    evidenceRefs: [`declare-${resourceId}`],
    ...overrides,
  };
}

function bindObservation(overrides = {}) {
  return {
    identity: processIdentity(),
    generation: 1,
    evidenceRefs: ['spawn-observed'],
    ...overrides,
  };
}

function confirm(scope, resourceId, identity = processIdentity()) {
  return scope.confirmRelease(resourceId, {
    identity,
    generation: 1,
    absenceVerified: true,
    evidenceRefs: [`absence-${resourceId}`],
  });
}

test('registers before bind and rejects duplicate or drifting identity', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  assert.throws(() => scope.bind('missing', bindObservation()), /RESOURCE_NOT_REGISTERED/);
  scope.register(resource('proc'));
  assert.strictEqual(scope.bind('proc', bindObservation()).state, 'ACTIVE');
  assert.strictEqual(scope.bind('proc', bindObservation()).state, 'ACTIVE');
  assert.throws(
    () => scope.bind('proc', bindObservation({ generation: 2 })),
    (caught) => caught instanceof ResourceTrackerError && caught.code === 'RESOURCE_IDENTITY_DRIFT',
  );
  assert.strictEqual(scope.getResource('proc').state, 'HOLD');
});

test('rejects incomplete process identities and decision-function overrides', () => {
  assert.throws(
    () => makeTracker({ processDecision: () => ({ downstream_release_allowed: true }) }),
    /DECISION_OVERRIDE_FORBIDDEN/,
  );
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('proc'));
  assert.throws(
    () => scope.bind('proc', bindObservation({ identity: {} })),
    /PROCESS_IDENTITY_INVALID/,
  );
});

test('holds owner, parent, scope, generation, and compound identity drift', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  const child = root.openChild({ scopeId: 'child', ownerId: 'worker-1', purpose: 'child work' });
  child.register(resource('proc'));
  child.bind('proc', bindObservation());
  const drift = child.observe('proc', {
    ...processObservation({ identity: processIdentity({ argv_hash: hash('different') }) }),
    expected_scope: { kind: 'scope', value: 'child' },
    observed_scope: { kind: 'scope', value: 'child' },
  });
  assert.strictEqual(drift.action, 'HOLD');
  assert.strictEqual(child.getResource('proc').state, 'HOLD');
  assert.strictEqual(child.getResource('proc').ownerId, 'worker-1');
  assert.strictEqual(child.getResource('proc').parentScopeId, 'root');
});

test('uses the existing process safety decision and requires verified absence', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('proc'));
  scope.bind('proc', bindObservation());
  const terminate = scope.observe('proc', processObservation());
  assert.strictEqual(terminate.action, 'TERMINATE_EXACT_TREE');
  assert.strictEqual(scope.close('task_complete').status, 'HOLD');
  const absent = scope.observe('proc', processObservation({ absent: true }));
  assert.strictEqual(absent.downstream_release_allowed, true);
  assert.strictEqual(scope.close('task_complete').status, 'CLOSED');
});

test('requires the ResourceLedger type-specific proof before releasing constrained compute', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('gpu-job', 'constrained_compute'));
  scope.bind('gpu-job', bindObservation());
  assert.strictEqual(
    scope.observe('gpu-job', processObservation({ absent: true })).action,
    'HOLD',
  );
  const released = scope.observe('gpu-job', {
    ...processObservation({ absent: true }),
    compute_released: true,
  });
  assert.strictEqual(released.downstream_release_allowed, true);
  assert.strictEqual(scope.close('task_complete').status, 'CLOSED');
});

test('process release is bound to the registered identity and cannot use direct confirmation', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('proc'));
  scope.bind('proc', bindObservation());
  assert.throws(() => confirm(scope, 'proc'), /PROCESS_RELEASE_REQUIRES_SAFETY_OBSERVATION/);

  const otherIdentity = processIdentity({ pid: 42002, native_handle: 'handle-42002' });
  const mismatched = scope.observe('proc', {
    ...processObservation({ absent: true, identity: otherIdentity }),
    expected_identity: otherIdentity,
  });
  assert.strictEqual(mismatched.action, 'HOLD');
  assert.strictEqual(scope.getResource('proc').releaseConfirmed, false);
  assert.strictEqual(scope.close('task_complete').status, 'HOLD');
});

test('a later unsafe process observation revokes an earlier absence decision', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('proc'));
  scope.bind('proc', bindObservation());
  assert.strictEqual(scope.observe('proc', processObservation({ absent: true })).downstream_release_allowed, true);
  assert.strictEqual(scope.getResource('proc').releaseConfirmed, true);
  const unsafe = scope.observe('proc', { ...processObservation({ absent: true }), owner_status: 'unknown' });
  assert.strictEqual(unsafe.action, 'HOLD');
  assert.strictEqual(scope.getResource('proc').releaseConfirmed, false);
  assert.strictEqual(scope.close('task_complete').status, 'HOLD');
});

test('temporary release requires a safe reclaim decision and a later exact absence check', () => {
  const policy = (policyId, kind, values) => {
    const record = {
      policy_id: policyId,
      kind,
      source_kind: 'synthetic_test_fixture',
      observed_at: '2026-08-29T00:00:00Z',
      values,
      evidence_refs: [`${policyId}-evidence`],
      source_sha256: '0'.repeat(64),
    };
    record.source_sha256 = sourceHash(record);
    return record;
  };
  const policyIndex = {
    'quota-test': policy('quota-test', 'quota', { soft_quota: 64, hard_quota: 128, unit: 'bytes' }),
    'watermark-test': policy('watermark-test', 'watermark', { low_watermark: 100, critical_watermark: 50, unit: 'bytes_available' }),
  };
  const canonicalRoot = process.platform === 'win32'
    ? 'C:\\Users\\tester\\.codex\\tmp\\resource-control'
    : '/tmp/resource-control';
  const childPath = process.platform === 'win32'
    ? `${canonicalRoot}\\child-A`
    : `${canonicalRoot}/child-A`;
  const manifest = {
    owner_id: 'root',
    run_id: 'run-resource-control',
    session_id: 'session-A',
    lease_generation: 4,
    canonical_root_identity: {
      canonical_path: canonicalRoot,
      path_identity_hash: hash(canonicalRoot),
      parent_identity_hash: hash(path.dirname(canonicalRoot)),
      platform: process.platform,
    },
    created_at: '2026-08-29T00:00:00Z',
    quota_profile_ref: 'quota-test',
    watermark_policy_ref: 'watermark-test',
    child_sublease_map: {
      'child-A': {
        owner_id: 'child-A',
        canonical_descendant: childPath,
        nonce: 'child-nonce',
        lease_generation: 4,
        soft_quota: 64,
        hard_quota: 128,
        teardown_condition: 'task_complete',
      },
    },
    retention_set: [],
    state: 'ACTIVE',
    manifest_sha256: '0'.repeat(64),
  };
  manifest.manifest_sha256 = contracts.computeTemporaryManifestSha256(manifest);
  const tempIdentity = {
    owner_id: manifest.owner_id,
    run_id: manifest.run_id,
    session_id: manifest.session_id,
    lease_generation: manifest.lease_generation,
    manifest_sha256: manifest.manifest_sha256,
    canonical_root_identity: clone(manifest.canonical_root_identity),
    child_id: 'child-A',
  };
  const observation = {
    owner_id: 'root',
    run_id: 'run-resource-control',
    session_id: 'session-A',
    lease_generation: 4,
    canonical_root_identity: clone(manifest.canonical_root_identity),
    child_path: childPath,
    usage: 32,
    available: 200,
    ttl_expired: true,
    active_handles: 0,
    quiescent: true,
    identity_observed: true,
    reparse_boundary: false,
    path_rebound: false,
    retention_set_sealed: true,
    retention_set_hash: hash(JSON.stringify(manifest.retention_set)),
    teardown_condition_met: true,
    precheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
    postcheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
  };
  const untrustedTracker = makeTracker({ generation: 4, trustedFilesystemResolver: () => false });
  const untrustedScope = untrustedTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  untrustedScope.register(resource('temp', 'temporary_allocation'));
  untrustedScope.bind('temp', { identity: tempIdentity, generation: 4, evidenceRefs: ['temporary-manifest'] });
  assert.strictEqual(untrustedScope.observe('temp', {
    manifest,
    child_id: 'child-A',
    intent: 'reclaim',
    observation,
    policyIndex,
    trustedFilesystemResolver: () => true,
  }).action, 'HOLD');

  const tracker = makeTracker({ generation: 4 });
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('temp', 'temporary_allocation'));
  scope.bind('temp', { identity: tempIdentity, generation: 4, evidenceRefs: ['temporary-manifest'] });
  const reclaim = scope.observe('temp', {
    manifest,
    child_id: 'child-A',
    intent: 'reclaim',
    observation,
    policyIndex,
  });
  assert.strictEqual(reclaim.action, 'RECLAIM_EXACT');
  assert.strictEqual(scope.close('task_complete').status, 'HOLD');
  scope.confirmRelease('temp', {
    identity: tempIdentity,
    generation: 4,
    absenceVerified: true,
    evidenceRefs: ['temporary-absence'],
  });
  assert.strictEqual(scope.close('task_complete').status, 'CLOSED');
});

test('closes deeper scopes first and resources in reverse acquisition order', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  const child = root.openChild({ scopeId: 'child', ownerId: 'worker-1', purpose: 'child work' });
  child.register(resource('child-a', 'artifact'));
  child.bind('child-a', bindObservation());
  confirm(child, 'child-a');
  child.register(resource('child-b', 'artifact'));
  child.bind('child-b', bindObservation());
  confirm(child, 'child-b');
  root.register(resource('root-a', 'artifact'));
  root.bind('root-a', bindObservation());
  confirm(root, 'root-a');
  const result = root.close('task_complete');
  assert.strictEqual(result.status, 'CLOSED');
  assert.deepStrictEqual(result.order, ['child-b', 'child-a', 'root-a']);
  const projection = tracker.exportLedgerProjection();
  assert.strictEqual(projection.projectionIsResourceLedger, false);
  assert.strictEqual(projection.events, undefined);
  assert(projection.hints.some((event) => event.trackerEventKind === 'RESOURCE_RELEASE_CONFIRMED'));
  assert(projection.states.every((state) => state.ledgerActionRequired === 'VALIDATE_VERIFY_RECLAIM'));
  assert.strictEqual(projection.completionChain, 'ResourceLedger1 -> ExecutionReceipt1');
});

test('keeps an authorized retained artifact distinct from a reclaimed resource', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('report', 'artifact'));
  root.bind('report', bindObservation());
  root.confirmRetention('report', {
    identity: processIdentity(),
    generation: 1,
    retained: true,
    artifactSealed: true,
    authorizationRef: 'retain:final-report',
    evidenceRefs: ['artifact-seal', 'retention-approval'],
  });
  assert.strictEqual(root.close('task_complete').status, 'CLOSED');
  assert.strictEqual(root.getResource('report').state, 'RETAINED');
  const projection = tracker.exportLedgerProjection();
  assert(projection.hints.some((event) => event.trackerEventKind === 'RESOURCE_RETENTION_CONFIRMED'));
  assert.strictEqual(projection.states[0].ledgerActionRequired, 'VALIDATE_RETAIN_ARTIFACT');
});

test('close is idempotent and never releases a parent before its child', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  const child = root.openChild({ scopeId: 'child', ownerId: 'worker-1', purpose: 'child work' });
  child.register(resource('child-resource', 'artifact'));
  child.bind('child-resource', bindObservation());
  root.register(resource('parent-resource', 'artifact'));
  root.bind('parent-resource', bindObservation());
  confirm(root, 'parent-resource');
  const first = root.close('task_complete');
  const second = root.close('task_complete');
  assert.strictEqual(second, first);
  assert.strictEqual(first.status, 'HOLD');
  assert(first.reasons.includes('CHILD_RELEASE_NOT_VERIFIED'));
  assert.strictEqual(root.getResource('parent-resource').state, 'ACTIVE');
  confirm(child, 'child-resource');
  const resumed = root.close('task_complete');
  assert.strictEqual(resumed.status, 'CLOSED');
  assert.notStrictEqual(resumed, first);

  const history = tracker.exportHistory();
  const expectedHead = history[history.length - 1].eventSha256;
  const rebuilt = TaskResourceTracker.fromHistory({
    ownerId: 'root',
    runId: 'run-resource-control',
    generation: 1,
    trustedObservationResolver: () => true,
    trustedHistoryResolver: ({ historyHeadSha256 }) => historyHeadSha256 === expectedHead,
  }, history);
  assert.deepStrictEqual(rebuilt.snapshot(), tracker.snapshot());
});

test('claims one real task scope once and consumes only its exact close result', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('task-resource', 'artifact'));
  root.bind('task-resource', bindObservation());
  const binding = {
    ownerId: 'root', runId: 'run-resource-control', scopeId: 'root', generation: 1,
  };
  assert.strictEqual(tracker.claimTaskScope('task-a', binding, ['task-resource']), true);
  assert.strictEqual(tracker.claimTaskScope('task-b', binding, ['task-resource']), false);
  confirm(root, 'task-resource');
  const closeResult = root.close('task_complete');
  assert.strictEqual(tracker.consumeTaskCloseResult(
    'task-a', closeResult, binding, ['task-resource'],
  ), true);
  assert.strictEqual(tracker.consumeTaskCloseResult(
    'task-a', closeResult, binding, ['task-resource'],
  ), true);
  assert.strictEqual(tracker.consumeTaskCloseResult(
    'task-b', closeResult, binding, ['task-resource'],
  ), false);
  const history = tracker.exportHistory();
  const expectedHead = history[history.length - 1].eventSha256;
  const rebuilt = TaskResourceTracker.fromHistory({
    ownerId: 'root',
    runId: 'run-resource-control',
    generation: 1,
    trustedHistoryResolver: ({ historyHeadSha256 }) => historyHeadSha256 === expectedHead,
  }, history);
  assert.deepStrictEqual(rebuilt.snapshot(), tracker.snapshot());
});

test('revalidates every tracked resource for first and repeated task claims', () => {
  const binding = {
    ownerId: 'root', runId: 'run-resource-control', scopeId: 'root', generation: 1,
  };

  const firstTracker = makeTracker();
  const firstRoot = firstTracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  firstRoot.register(resource('already-confirmed', 'artifact'));
  firstRoot.bind('already-confirmed', bindObservation());
  confirm(firstRoot, 'already-confirmed');
  assert.strictEqual(
    firstTracker.claimTaskScope('task-before-first-claim', binding, ['already-confirmed']),
    false,
  );

  const repeatedTracker = makeTracker();
  const repeatedRoot = repeatedTracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  repeatedRoot.register(resource('claimed-resource', 'artifact'));
  repeatedRoot.bind('claimed-resource', bindObservation());
  assert.strictEqual(
    repeatedTracker.claimTaskScope('task-repeat', binding, ['claimed-resource']),
    true,
  );
  confirm(repeatedRoot, 'claimed-resource');
  assert.strictEqual(
    repeatedTracker.claimTaskScope('task-repeat', binding, ['claimed-resource']),
    false,
  );
  repeatedRoot.close('task_complete');
  assert.strictEqual(
    repeatedTracker.claimTaskScope('task-repeat', binding, ['claimed-resource']),
    false,
  );

  const driftTracker = makeTracker();
  const driftRoot = driftTracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  driftRoot.register(resource('drifted-resource'));
  driftRoot.bind('drifted-resource', bindObservation());
  assert.strictEqual(
    driftTracker.claimTaskScope('task-drift', binding, ['drifted-resource']),
    true,
  );
  assert.throws(
    () => driftRoot.bind('drifted-resource', bindObservation({
      identity: processIdentity({ nonce: 'changed-launch-nonce' }),
    })),
    /RESOURCE_IDENTITY_DRIFT/,
  );
  assert.strictEqual(
    driftTracker.claimTaskScope('task-drift', binding, ['drifted-resource']),
    false,
  );
});

test('keeps tracker authority and mutable state behind immutable public views', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('private-resource', 'artifact'));
  root.bind('private-resource', bindObservation());

  for (const field of [
    '_trustedObservationResolver',
    '_trustedFilesystemResolver',
    '_limits',
    '_scopes',
    '_resources',
    '_taskClaims',
    '_scopeClaims',
    '_consumedTaskCloses',
    '_history',
    '_historyBytes',
    '_sequence',
    '_revision',
    '_acquisitionOrder',
    '_rootScopeId',
    '_historyHeadSha256',
    '_replaying',
  ]) {
    assert.strictEqual(tracker[field], undefined, `${field} must not expose private state`);
  }
  for (const method of [
    '_requireScope',
    '_requireOwnedResource',
    '_checkpoint',
    '_restoreCheckpoint',
    '_touch',
    '_record',
    '_replay',
    '_freezeSubtree',
    '_closeSubtree',
    '_applyRelease',
    '_applyObservation',
  ]) {
    assert.strictEqual(tracker[method], undefined, `${method} must not expose internal operations`);
  }
  assert.strictEqual(root._tracker, undefined);
  assert(Object.isFrozen(tracker));
  assert(Object.isFrozen(root));
  assert.throws(() => { tracker._resources = new Map(); }, TypeError);
  assert.throws(() => { root._tracker = null; }, TypeError);

  const before = tracker.snapshot();
  assert(Object.isFrozen(before));
  assert(Object.isFrozen(before.scopes));
  assert(Object.isFrozen(before.scopes[0]));
  assert(Object.isFrozen(before.scopes[0].resourceIds));
  assert(Object.isFrozen(before.resources));
  assert(Object.isFrozen(before.resources[0]));
  assert(Object.isFrozen(before.resources[0].evidenceRefs));
  assert.throws(() => { before.scopes[0].resourceIds.push('injected'); }, TypeError);
  assert.throws(() => { before.resources[0].state = 'RELEASED'; }, TypeError);
  assert.deepStrictEqual(tracker.snapshot(), before);
});

test('keeps a successful close stable across unrelated tracker revisions', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  const completed = root.openChild({
    scopeId: 'completed-child', ownerId: 'worker-complete', purpose: 'completed work',
  });
  const first = completed.close('task_complete');
  assert.strictEqual(first.status, 'CLOSED');

  root.register(resource('unrelated', 'artifact'));
  const historyAfterUnrelatedMutation = tracker.exportHistory();
  const second = completed.close('task_complete');
  assert.strictEqual(second, first);
  assert.deepStrictEqual(tracker.exportHistory(), historyAfterUnrelatedMutation);
  assert.deepStrictEqual(
    completed.snapshot(),
    {
      scopeId: 'completed-child',
      ownerId: 'worker-complete',
      parentScopeId: 'root',
      purpose: 'completed work',
      generation: 1,
      accepting: false,
      closing: false,
      closed: true,
      children: [],
      resourceIds: [],
    },
  );
  assert.strictEqual(completed.close('already_complete'), first);
  assert.deepStrictEqual(tracker.exportHistory(), historyAfterUnrelatedMutation);
});

test('rejects cross-sibling resource parents and closes same-scope children first', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  const left = root.openChild({ scopeId: 'left', ownerId: 'worker-left', purpose: 'left work' });
  const right = root.openChild({ scopeId: 'right', ownerId: 'worker-right', purpose: 'right work' });
  left.register(resource('parent', 'artifact'));
  assert.throws(
    () => right.register(resource('cross-sibling', 'artifact', { parentResourceId: 'parent' })),
    /PARENT_RESOURCE_SCOPE_INVALID/,
  );
  left.register(resource('child', 'artifact', { parentResourceId: 'parent' }));
  left.bind('parent', bindObservation());
  left.bind('child', bindObservation());
  confirm(left, 'parent');
  confirm(left, 'child');
  assert.deepStrictEqual(root.close('task_complete').order, ['child', 'parent']);
});

test('does not release a parent resource while a same-scope child remains active', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('parent', 'artifact'));
  root.register(resource('child', 'artifact', { parentResourceId: 'parent' }));
  root.bind('parent', bindObservation());
  root.bind('child', bindObservation());
  confirm(root, 'parent');

  const result = root.close('task_complete');
  assert.strictEqual(result.status, 'HOLD');
  assert.strictEqual(root.getResource('child').state, 'ACTIVE');
  assert.strictEqual(root.getResource('parent').state, 'ACTIVE');
});

test('stops new registration when close begins and returns immutable snapshots', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('pending', 'artifact'));
  root.bind('pending', bindObservation());
  const result = root.close('task_complete');
  assert.strictEqual(result.status, 'HOLD');
  assert.throws(() => root.register(resource('late', 'artifact')), /SCOPE_NOT_ACCEPTING_RESOURCES/);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(root.getResource('pending')));
});

test('rebuilds valid append-only history without sharing caller state', () => {
  const tracker = makeTracker();
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'root work' });
  root.register(resource('artifact', 'artifact'));
  root.bind('artifact', bindObservation());
  confirm(root, 'artifact');
  root.close('task_complete');
  const history = tracker.exportHistory();
  const expectedHead = history[history.length - 1].eventSha256;
  const rebuilt = TaskResourceTracker.fromHistory({
    ownerId: 'root',
    runId: 'run-resource-control',
    generation: 1,
    trustedObservationResolver: () => true,
    trustedHistoryResolver: ({ historyHeadSha256 }) => historyHeadSha256 === expectedHead,
  }, history);
  assert.deepStrictEqual(rebuilt.snapshot(), tracker.snapshot());
  assert(Object.isFrozen(history));
  assert.throws(
    () => TaskResourceTracker.fromHistory({
      ownerId: 'root',
      runId: 'run-resource-control',
      generation: 1,
      trustedHistoryResolver: () => true,
    }, [{ sequence: 9 }]),
    /HISTORY_INVALID/,
  );

  const tampered = clone(history);
  tampered[0].payload.purpose = 'tampered';
  assert.throws(
    () => TaskResourceTracker.fromHistory({
      ownerId: 'root',
      runId: 'run-resource-control',
      generation: 1,
      trustedHistoryResolver: () => true,
    }, tampered),
    /HISTORY_INVALID/,
  );
  assert.throws(
    () => TaskResourceTracker.fromHistory({
      ownerId: 'root',
      runId: 'other-run',
      generation: 1,
      trustedHistoryResolver: () => true,
    }, history),
    /HISTORY_INVALID/,
  );
  assert.throws(
    () => TaskResourceTracker.fromHistory({
      ownerId: 'root', runId: 'run-resource-control', generation: 1,
    }, history),
    /HISTORY_TRUST_NOT_PROVEN/,
  );
  assert.throws(
    () => TaskResourceTracker.fromHistory({
      ownerId: 'root',
      runId: 'run-resource-control',
      generation: 1,
      limits: { maxHistoryEvents: history.length - 1 },
      trustedHistoryResolver: () => true,
    }, history),
    /HISTORY_INVALID/,
  );
});

test('records identity drift and enforces cumulative tracker limits', () => {
  const tracker = makeTracker({ limits: { maxScopes: 2, maxResources: 1, maxHistoryEvents: 32 } });
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  root.register(resource('proc'));
  root.bind('proc', bindObservation());
  assert.throws(() => root.bind('proc', bindObservation({ generation: 2 })), /RESOURCE_IDENTITY_DRIFT/);
  const history = tracker.exportHistory();
  const expectedHead = history[history.length - 1].eventSha256;
  const rebuilt = TaskResourceTracker.fromHistory({
    ownerId: 'root',
    runId: 'run-resource-control',
    generation: 1,
    trustedHistoryResolver: ({ historyHeadSha256 }) => historyHeadSha256 === expectedHead,
  }, history);
  assert.strictEqual(rebuilt.snapshot().resources[0].state, 'HOLD');
  root.openChild({ scopeId: 'child', ownerId: 'worker', purpose: 'child' });
  assert.throws(() => root.openChild({ scopeId: 'overflow', purpose: 'overflow' }), /SCOPE_LIMIT_REACHED/);
  assert.throws(() => root.register(resource('second')), /RESOURCE_LIMIT_REACHED/);

  const sizeTracker = makeTracker({ limits: { maxInputBytes: 1024 } });
  const sizeRoot = sizeTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  assert.throws(
    () => sizeRoot.register(resource('huge', 'artifact', { purpose: 'x'.repeat(2048) })),
    /TRACKER_INPUT_LIMIT_REACHED/,
  );
});

test('rejects every tracked mutation before state changes when history capacity is exhausted', () => {
  const registerTracker = makeTracker({ limits: { maxHistoryEvents: 1 } });
  const registerRoot = registerTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  const beforeRegister = registerTracker.snapshot();
  assert.throws(() => registerRoot.register(resource('unrecorded')), /TRACKER_HISTORY_LIMIT_REACHED/);
  assert.deepStrictEqual(registerTracker.snapshot(), beforeRegister);

  const bindTracker = makeTracker({ limits: { maxHistoryEvents: 2 } });
  const bindRoot = bindTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  bindRoot.register(resource('proc'));
  const beforeBind = bindTracker.snapshot();
  assert.throws(() => bindRoot.bind('proc', bindObservation()), /TRACKER_HISTORY_LIMIT_REACHED/);
  assert.deepStrictEqual(bindTracker.snapshot(), beforeBind);

  const observeTracker = makeTracker({ limits: { maxHistoryEvents: 3 } });
  const observeRoot = observeTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  observeRoot.register(resource('proc'));
  observeRoot.bind('proc', bindObservation());
  const beforeObserve = observeTracker.snapshot();
  assert.throws(
    () => observeRoot.observe('proc', processObservation()),
    /TRACKER_HISTORY_LIMIT_REACHED/,
  );
  assert.deepStrictEqual(observeTracker.snapshot(), beforeObserve);

  const closeTracker = makeTracker({ limits: { maxHistoryEvents: 2 } });
  const closeRoot = closeTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  const beforeClose = closeTracker.snapshot();
  assert.throws(() => closeRoot.close('task_complete'), /TRACKER_HISTORY_LIMIT_REACHED/);
  assert.deepStrictEqual(closeTracker.snapshot(), beforeClose);
  assert.strictEqual(closeTracker.verifyCloseResult({ status: 'CLOSED' }, {
    ownerId: 'root', runId: 'run-resource-control', scopeId: 'root', generation: 1,
  }), false);
});

function failure(overrides = {}) {
  return {
    phase: 'implementation',
    checkpoint: 'resource-control-focused-test',
    errorClass: 'AssertionError',
    errorCode: 'ERR_ASSERTION',
    commandId: 'resource-control.test.js',
    inputHashes: [hash('input-a')],
    artifactHashes: [hash('artifact-a')],
    environmentIdentity: { node: process.version, platform: process.platform },
    sideEffectState: 'none',
    classification: 'code_defect',
    hypothesis: 'close order is incorrect',
    affectedScope: 'TaskResourceTracker.close',
    validationConclusion: 'focused test failed',
    evidenceRefs: ['failure-1'],
    idempotencyKey: 'resource-control-focused-test:1',
    retryPolicyRef: 'retry-policy-test',
    changeSetHash: hash('change-set-1'),
    repairScope: 'TaskResourceTracker.close',
    occurredAt: '2026-08-29T01:00:00Z',
    attemptKind: 'repair',
    wrapper: 'cmd /c',
    logPath: 'first.log',
    callerFingerprint: 'untrusted',
    ...overrides,
  };
}

function makeGuard(overrides = {}) {
  const knownEvidence = overrides.knownEvidence || new Set(['failure-1', 'trace-generation-drift']);
  const options = { ...overrides };
  delete options.knownEvidence;
  const store = options.store || memoryStore();
  delete options.store;
  return new FailureLoopGuard({
    runId: 'run-resource-control',
    guardId: 'resource-control-loop',
    retryBudget: 2,
    repairBudget: 1,
    store,
    evidenceResolver: ({ evidenceRefs }) => evidenceRefs.every((item) => knownEvidence.has(item)),
    classificationResolver: ({ observation }) => (
      observation.errorClass === 'NetworkError' ? 'environment' : observation.classification
    ),
    authorizationResolver: ({ authorizationRef }) => authorizationRef === 'approval-loop-exit',
    trustedStateResolver: ({ stateRevision, stateSha256 }) => {
      const current = store.current();
      return current !== null && current.revision === stateRevision
        && current.stateSha256 === stateSha256;
    },
    ...options,
  });
}

function exhaustedGuard() {
  const guard = makeGuard();
  guard.recordFailure(failure());
  guard.recordFailure(failure({ occurredAt: '2026-08-29T01:01:00Z', evidenceRefs: ['failure-1'] }));
  return guard;
}

function validExit(overrides = {}) {
  return {
    generation: 1,
    method: 'MINIMIZE_REPRODUCTION',
    evidenceRefs: ['failure-1'],
    authorizationRef: 'approval-loop-exit',
    maxAttempts: 1,
    successCriterion: 'minimal reproduction distinguishes the hypothesis',
    failureCriterion: 'same fingerprint without new evidence',
    forbiddenActions: ['broaden permissions', 'change unrelated code'],
    cleanupCondition: 'resource scope closed',
    ...overrides,
  };
}

test('derives a versioned stable fingerprint and ignores wrappers, log paths, and caller fingerprints', () => {
  assert.strictEqual(FAILURE_FINGERPRINT_VERSION, 'FailureFingerprint1');
  const first = computeFailureFingerprint(failure());
  const second = computeFailureFingerprint(failure({
    wrapper: 'powershell',
    logPath: 'second.log',
    callerFingerprint: hash('different'),
    occurredAt: '2026-08-29T01:03:00Z',
  }));
  assert.strictEqual(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('pins a runtime-independent failure fingerprint vector', () => {
  const vector = {
    phase: 'test',
    checkpoint: 'fixed-vector',
    errorClass: 'AssertionError',
    errorCode: 'ERR_FIXED',
    commandId: 'fixed-command',
    inputHashes: ['a'.repeat(64)],
    artifactHashes: ['b'.repeat(64)],
    environmentIdentity: { node: 'fixed', platform: 'fixed' },
    sideEffectState: 'none',
    classification: 'code_defect',
    hypothesis: 'fixed hypothesis',
    affectedScope: 'fixed scope',
    validationConclusion: 'fixed conclusion',
  };
  assert.strictEqual(
    computeFailureFingerprint(vector),
    'c46d410656f99fffa75f77390208a867e16af7bce64ebee47208f6081bba50b2',
  );
});

test('stops dispatch on the repeated failure and reuses one immutable loop summary', () => {
  const guard = makeGuard();
  assert.strictEqual(guard.recordFailure(failure()).action, 'REPAIR');
  const repeated = guard.recordFailure(failure({ occurredAt: '2026-08-29T01:01:00Z' }));
  assert.strictEqual(repeated.action, 'SUMMARIZE_AND_STOP_DISPATCH');
  const first = guard.summarize(1);
  const second = guard.summarize(1);
  assert.strictEqual(second, first);
  assert(Object.isFrozen(first));
  assert.strictEqual(first.repair.used, 1);
  assert.strictEqual(first.repair.remaining, 0);
});

test('permits one evidence-based bounded exit attempt and then stops', () => {
  const guard = exhaustedGuard();
  const allowed = guard.chooseExit(validExit());
  assert.strictEqual(allowed.action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  assert.strictEqual(guard.chooseExit(validExit()).action, 'STOP_AND_PRESERVE');
  const sameFailure = guard.recordFailure(failure({ occurredAt: '2026-08-29T01:02:00Z' }));
  assert.strictEqual(sameFailure.action, 'STOP_AND_PRESERVE');
  assert.strictEqual(sameFailure.summaryReused, true);
  assert.strictEqual(guard.summarize(1), guard.summarize(1));
});

test('rejects unsupported, unapproved, unbounded, or unevidenced exit methods', () => {
  const guard = exhaustedGuard();
  assert.strictEqual(guard.chooseExit(validExit({ method: 'CHANGE_MODEL' })).action, 'HOLD');
  assert.strictEqual(guard.chooseExit(validExit({ authorizationRef: 'not-approved' })).action, 'HOLD');
  assert.strictEqual(guard.chooseExit(validExit({ maxAttempts: 2 })).action, 'HOLD');
  assert.strictEqual(guard.chooseExit(validExit({ evidenceRefs: [] })).action, 'HOLD');
});

test('new semantic evidence creates a new generation but does not reset budgets', () => {
  const guard = exhaustedGuard();
  const changed = guard.recordFailure(failure({
    hypothesis: 'identity generation drift is the root cause',
    evidenceRefs: ['failure-1', 'trace-generation-drift'],
    occurredAt: '2026-08-29T01:04:00Z',
  }));
  assert.strictEqual(changed.generation, 2);
  assert.strictEqual(changed.budgets.repair.remaining, 0);
});

test('environment failures never produce a code-repair action', () => {
  const guard = makeGuard({ repairBudget: 3 });
  const result = guard.recordFailure(failure({
    classification: 'environment',
    errorClass: 'SandboxDenied',
    errorCode: 'EACCES',
    hypothesis: 'sandbox permission is missing',
    affectedScope: 'workspace',
    validationConclusion: 'write denied before code ran',
  }));
  assert.notStrictEqual(result.action, 'REPAIR');
  assert(['WAIT_EXTERNAL', 'REQUEST_USER_DECISION', 'HOLD'].includes(result.action));
});

test('requires trusted evidence, clean side effects, and retry idempotency before action', () => {
  assert.strictEqual(makeGuard().recordFailure(failure({ evidenceRefs: [] })).action, 'HOLD');
  assert.strictEqual(makeGuard().recordFailure(failure({ sideEffectState: 'unknown' })).action, 'HOLD');
  assert.strictEqual(makeGuard().recordFailure(failure({
    classification: 'transient',
    attemptKind: 'retry',
    idempotencyKey: '',
  })).action, 'HOLD');
  assert.strictEqual(makeGuard().recordFailure(failure({
    errorClass: 'NetworkError',
    errorCode: 'ECONNRESET',
    classification: 'code_defect',
  })).action, 'HOLD');
});

test('changing output artifacts cannot buy another exit attempt', () => {
  const guard = exhaustedGuard();
  assert.strictEqual(guard.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  const changedArtifact = guard.recordFailure(failure({
    artifactHashes: [hash('artifact-b')],
    occurredAt: '2026-08-29T01:05:00Z',
  }));
  assert.strictEqual(changedArtifact.action, 'STOP_AND_PRESERVE');
});

test('persistent guard state prevents restart from resetting budgets or exit use', () => {
  const store = memoryStore();
  const first = makeGuard({ store });
  first.recordFailure(failure());
  first.recordFailure(failure({ occurredAt: '2026-08-29T01:01:00Z' }));
  assert.strictEqual(first.chooseExit(validExit()).action, 'ALLOW_ONE_BOUNDED_ATTEMPT');
  const second = makeGuard({ store });
  assert.strictEqual(second.snapshot().budgets.repair.remaining, 0);
  assert.strictEqual(second.chooseExit(validExit()).action, 'STOP_AND_PRESERVE');
});

test('rejects malformed fingerprint hash arrays instead of silently dropping entries', () => {
  assert.throws(
    () => computeFailureFingerprint(failure({ inputHashes: ['not-a-sha256'] })),
    /FAILURE_OBSERVATION_INVALID/,
  );
});

test('documents resource control and loop exit in plain operational language', () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'dw-collaboration', 'SKILL.md'),
    'utf8',
  );
  const lifecycle = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'dw-collaboration', 'references', 'resource-lifecycle.md'),
    'utf8',
  );
  const controlPath = path.join(
    pluginRoot,
    'skills',
    'dw-collaboration',
    'references',
    'resource-control.md',
  );
  assert(fs.existsSync(controlPath), 'resource-control.md must be packaged with dw-collaboration');
  const control = fs.readFileSync(controlPath, 'utf8');
  const wrapup = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'dw-wrapup', 'SKILL.md'),
    'utf8',
  );
  const workflowRule = fs.readFileSync(
    path.join(pluginRoot, 'rules', 'development-workflow.md'),
    'utf8',
  );

  assert.match(skill, /resource-control\.md/);
  assert.match(lifecycle, /TaskResourceTracker/);
  assert.match(control, /register before|启动前登记/);
  assert.match(control, /owner.*generation|所有者.*代次/s);
  assert.match(control, /child.*before.*parent|子级.*父级/s);
  assert.match(control, /absence|确认.*不存在/s);
  assert.match(control, /LoopSummary/);
  assert.match(control, /one bounded|一次有界/s);
  assert.match(control, /same failure.*stop|同一失败.*停止/s);
  assert.match(control, /light.*standard.*high/s);
  assert.match(control, /backfill|空隙补位/);
  assert.match(control, /starvation|长期等待/);
  assert.match(control, /draining/);
  assert.match(control, /schedulable VRAM|可调度显存/);
  assert.match(control, /useful GPU compute|有效 GPU 计算/);
  assert.match(control, /85%/);
  assert.match(control, /开始.*进度.*失败.*结束/s);
  assert.match(control, /付费模型.*不.*5\.2\.0|5\.2\.0.*不.*付费模型/s);

  const openFence = (line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) return null;
    const marker = match[1][0];
    if (marker === '`' && match[2].includes('`')) return null;
    return { marker, length: match[1].length };
  };
  const closesFence = (line, fence) => {
    const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
    return Boolean(
      match
      && match[1][0] === fence.marker
      && match[1].length >= fence.length
    );
  };
  const markdownSection = (text, heading, { includeFenced = false } = {}) => {
    const lines = text.split(/\r?\n/);
    const body = [];
    let fence = null;
    let sectionFound = false;

    for (let index = 0; index < lines.length; index += 1) {
      if (fence) {
        if (sectionFound && includeFenced) body.push(lines[index]);
        if (closesFence(lines[index], fence)) fence = null;
        continue;
      }

      const opening = openFence(lines[index]);
      if (opening) {
        fence = opening;
        if (sectionFound && includeFenced) body.push(lines[index]);
        continue;
      }

      if (!sectionFound) {
        if (lines[index] === `## ${heading}`) sectionFound = true;
        continue;
      }

      if (/^## /.test(lines[index])) break;
      body.push(lines[index]);
    }
    return sectionFound ? body.join('\n') : '';
  };
  const lineContaining = (text, marker) => (
    text.split(/\r?\n/).find((line) => line.includes(marker)) || ''
  );
  const hasAll = (text, patterns) => patterns.every((pattern) => pattern.test(text));
  const missingProcessTriageRequirements = (documents) => {
    const baseline = markdownSection(
      documents.lifecycle,
      'Read-only host baseline before intervention',
    );
    const persistent = markdownSection(
      documents.lifecycle,
      'Persistent repair, recovery, and comparison',
    );
    const scheduled = markdownSection(documents.control, 'Scheduled audit gate');
    const ownedCleanup = markdownSection(
      documents.wrapup,
      '自有资源清理',
      { includeFenced: true },
    );
    const windowsSignals = lineContaining(baseline, 'On Windows,');
    const nonTaskOwnedDefaults = lineContaining(baseline, 'Third-party,');
    const postActionComparison = lineContaining(ownedCleanup, '每次处置后');

    return [
      ['read-only host baseline precedes classification', hasAll(baseline, [
        /bounded, read-only host baseline/i,
        /before classification or action/i,
      ])],
      ['ownership, progress, relevance, and action stay separate', hasAll(baseline, [
        /\*\*ownership\*\*/i,
        /\*\*progress\*\*/i,
        /\*\*relevance\*\*/i,
        /\*\*action\*\*/i,
        /keep four questions separate/i,
      ])],
      ['historical observations cannot authorize current action', hasAll(baseline, [
        /Historical crashes, PIDs, WAL growth, load samples, or earlier cleanup results/i,
        /not current action authority/i,
      ])],
      ['home-profile Git roots receive bounded read-only inspection', hasAll(baseline, [
        /resolve the Git root read-only/i,
        /Git root is a user home or profile directory/i,
        /bounded summary of the tracked set/i,
        /redacted remotes/i,
        /applicable ignore rules/i,
      ])],
      ['process and platform signals are evidence, not kill selectors', hasAll(windowsSignals, [
        /\bCodex\b/i,
        /\bGit\b/i,
        /\bDefender\b/i,
        /\brenderer\b/i,
        /\bGPU\b/i,
        /\bNode\b/i,
        /evidence filters, not kill selectors/i,
      ])],
      ['non-task-owned processes remain observation-only or hold', hasAll(nonTaskOwnedDefaults, [
        /\bThird-party\b/i,
        /\bsystem\b/i,
        /\bforeground\b/i,
        /\buser-started\b/i,
        /\bexternal\b/i,
        /\bunknown processes default to `OBSERVE_ONLY` or `HOLD`/i,
      ])],
      ['weak liveness signals do not prove a hung process', hasAll(baseline, [
        /Low CPU and no output do not establish `SUSPECTED_HUNG`/i,
        /timeout, teardown condition, task failure, interruption, old age, stable memory, a repeated command, or a process name is also insufficient by itself/i,
      ])],
      ['only declared task-owned candidates bind the task ledger', hasAll(baseline, [
        /candidate already declared by the current task/i,
        /proven `TASK_OWNED`/i,
        /bound to the task ledger/i,
        /Do not register an `EXTERNAL` or `UNKNOWN` candidate as task-owned/i,
        /bounded, redacted observation evidence/i,
      ])],
      ['audit axes are prose rather than executable classifications', hasAll(baseline, [
        /four host-audit axes are prose reasoning dimensions/i,
        /not serialized runtime fields/i,
        /`PROGRESS_CLASSIFICATIONS`/i,
        /existing runtime progress mapping remains/i,
      ])],
      ['persistent repair requires an exact backup and restoration check', hasAll(persistent, [
        /exact, minimal backup/i,
        /supported consistent snapshot method/i,
        /source identity and hash/i,
        /backup identity and hash/i,
        /restoration steps/i,
        /restoration acceptance check/i,
      ])],
      ['a backup grants no stop or delete authority', hasAll(persistent, [
        /backup neither makes process termination reversible/i,
        /nor grants stop, delete, or force authority/i,
      ])],
      ['Git metadata cannot be deleted or reset as cleanup', hasAll(persistent, [
        /Never delete, move, reset, or reinitialize `\.git` as diagnosis or cleanup/i,
        /Repair only the proven configuration or metadata after its exact backup/i,
      ])],
      ['active WAL files require a supported consistent snapshot', hasAll(persistent, [
        /Never delete, truncate, replace, or force-checkpoint an active SQLite WAL/i,
        /application's supported backup interface/i,
        /owned, verified quiescent state/i,
        /consistent database\/WAL\/SHM snapshot/i,
      ])],
      ['force recovery uses a fresh request-bound host identity', hasAll(persistent, [
        /fresh host-owned identity resolution/i,
        /bound to the request/i,
        /expected-identity hashes/i,
      ])],
      ['managed-boundary descendants do not require individual subleases', hasAll(persistent, [
        /authenticated managed job, process group, or session boundary/i,
        /without an individual sublease for each child/i,
        /outside that authenticated managed boundary/i,
        /lacking a valid individual sublease plus identity binding/i,
        /whole tree `HOLD`/i,
      ])],
      ['post-action comparison spans at least 15 seconds', hasAll(persistent, [
        /at least three strictly time-ordered samples/i,
        /spanning at least 15 seconds/i,
        /same-method scope/i,
      ])],
      ['15 seconds is not an automatic pass or stop threshold', hasAll(persistent, [
        /15-second floor applies only to post-action host comparison/i,
        /not a hung threshold, wait timeout, termination permission, or automatic PASS/i,
        /absence remains a separate required check/i,
      ])],
      ['the v1 progress classifier is not action authority', hasAll(persistent, [
        /`validateProgressReport\(\)` version 1 is a descriptive classifier/i,
        /does not authenticate elapsed time, sampling method, target identity, or host authority/i,
        /is not action or termination authority/i,
      ])],
      ['scheduled audits do not create cleanup authority', hasAll(scheduled, [
        /scheduled audit is only a policy-timed trigger/i,
        /bounded read-only observation/i,
        /does not create, grant, inherit, refresh, or expand cleanup authority or termination authority/i,
      ])],
      ['each scheduled audit reacquires identity and authorization', hasAll(scheduled, [
        /Each run must reacquire/i,
        /current owner/i,
        /complete process identity/i,
        /action authorization/i,
        /prior run's PID, status, classification, or receipt is historical evidence only/i,
      ])],
      ['scheduled observation cannot manufacture a Git polling loop', hasAll(scheduled, [
        /Detect repeated source-control enumeration by observing existing commands and I\/O/i,
        /do not create the same polling loop as the measurement/i,
      ])],
      ['overlapping audits cannot perform concurrent remediation', hasAll(scheduled, [
        /audits overlap/i,
        /skip, coalesce, or `HOLD` the later run/i,
        /never perform concurrent remediation/i,
      ])],
      ['wrap-up uses read-only triage and a 15-second comparison', (
        hasAll(ownedCleanup, [/有界、只读的当前基线/])
        && hasAll(postActionComparison, [
          /至少 15 秒/,
          /Git/,
          /CPU/,
          /WAL/,
          /界面响应/,
          /单独验证资源不存在/,
        ])
      )],
      ['the always-loaded rule preserves stop authority and observation gates', hasAll(documents.workflowRule, [
        /bounded read-only baseline/i,
        /current compound identity/i,
        /grants no stop authority/i,
        /graceful-first recovery/i,
        /verify exact absence/i,
        /at least three same-method samples/i,
        /15-second-or-longer post-action window/i,
        /`HOLD`\/`UNVERIFIED`/i,
      ])],
      ['the always-loaded rule separates teardown from incident cause', hasAll(documents.workflowRule, [
        /Normal teardown requires a valid teardown reason or condition/i,
        /Incident response or persistent repair additionally requires the applicable cause to be confirmed/i,
        /applicable cause evidence/i,
        /post-action observation is `HOLD`\/`UNVERIFIED`/i,
      ])],
    ].filter(([, present]) => !present).map(([requirement]) => requirement);
  };
  const documents = { lifecycle, control, wrapup, workflowRule };
  const mutate = (text, search, replacement = '') => {
    const mutated = text.replace(search, replacement);
    assert.notStrictEqual(mutated, text, 'controlled mutation must alter its fixture');
    return mutated;
  };
  const scheduledBodyFixture = markdownSection(control, 'Scheduled audit gate');
  const scheduledAuthorityFixture = lineContaining(
    scheduledBodyFixture,
    'A scheduled audit is only',
  );
  assert(scheduledAuthorityFixture, 'scheduled-audit authority fixture must exist');
  const mutations = [
    {
      name: 'active WAL deletion guard',
      document: 'lifecycle',
      text: mutate(
        lifecycle,
        'Never delete, truncate, replace, or force-checkpoint an active SQLite WAL merely because it grew. ',
      ),
      requirement: 'active WAL files require a supported consistent snapshot',
    },
    {
      name: 'always-loaded stop-authority and HOLD guard',
      document: 'workflowRule',
      text: mutate(
        workflowRule,
        'a schedule, PID, name, path, age, timeout, low load, no output, historical event, or suspected-hung label grants no stop authority. ',
      ),
      requirement: 'the always-loaded rule preserves stop authority and observation gates',
    },
    {
      name: 'external candidates cannot enter the task ledger',
      document: 'lifecycle',
      text: mutate(
        lifecycle,
        'Do not register an `EXTERNAL` or `UNKNOWN` candidate as task-owned; retain only bounded, redacted observation evidence and keep its action `OBSERVE_ONLY` or `HOLD`. ',
      ),
      requirement: 'only declared task-owned candidates bind the task ledger',
    },
    {
      name: 'authenticated managed-boundary descendant rule',
      document: 'lifecycle',
      text: mutate(
        lifecycle,
        'An authenticated managed job, process group, or session boundary may cover its descendants without an individual sublease for each child. ',
      ),
      requirement: 'managed-boundary descendants do not require individual subleases',
    },
    {
      name: 'Windows Git observation example',
      document: 'lifecycle',
      text: mutate(
        lifecycle,
        'On Windows, Codex, Git, Defender, renderer, GPU, and Node',
        'On Windows, Codex, Defender, renderer, GPU, and Node',
      ),
      requirement: 'process and platform signals are evidence, not kill selectors',
    },
    {
      name: 'system-process observation-only category',
      document: 'lifecycle',
      text: mutate(
        lifecycle,
        'Third-party, system, foreground, user-started, external, and unknown',
        'Third-party, foreground, user-started, external, and unknown',
      ),
      requirement: 'non-task-owned processes remain observation-only or hold',
    },
    {
      name: 'post-action CPU comparison metric',
      document: 'wrapup',
      text: mutate(
        wrapup,
        '进程、Git、CPU、I/O、GPU、WAL 和界面响应',
        '进程、Git、I/O、GPU、WAL 和界面响应',
      ),
      requirement: 'wrap-up uses read-only triage and a 15-second comparison',
    },
    {
      name: 'scheduled audit exact level-two heading',
      document: 'control',
      text: mutate(control, '## Scheduled audit gate', '### Scheduled audit gate'),
      requirement: 'scheduled audits do not create cleanup authority',
    },
    {
      name: 'four-backtick fence cannot expose a fake scheduled-audit heading',
      document: 'control',
      text: [
        '````markdown',
        '```',
        '## Scheduled audit gate',
        scheduledBodyFixture,
        '````',
        mutate(control, '## Scheduled audit gate', '### Scheduled audit gate'),
      ].join('\n'),
      requirement: 'scheduled audits do not create cleanup authority',
    },
    {
      name: 'fenced policy text cannot replace the real scheduled-audit clause',
      document: 'control',
      text: mutate(
        control,
        scheduledAuthorityFixture,
        ['````text', scheduledAuthorityFixture, '````'].join('\n'),
      ),
      requirement: 'scheduled audits do not create cleanup authority',
    },
  ];
  assert.deepStrictEqual(
    {
      missing: missingProcessTriageRequirements(documents),
      undetectedMutations: mutations
        .filter(({ document, text: mutated, requirement }) => {
          const candidate = { ...documents, [document]: mutated };
          return !missingProcessTriageRequirements(candidate).includes(requirement);
        })
        .map(({ name }) => name),
    },
    { missing: [], undetectedMutations: [] },
    'process triage and reversible cleanup contract must be complete',
  );
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

if (!process.exitCode) console.log(`resource control contract passed (${passed}/${tests.length})`);
