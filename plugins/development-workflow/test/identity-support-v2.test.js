#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contracts = require('../skills/dw-collaboration/scripts/lib/contracts');
const stateMachines = require('../skills/dw-collaboration/scripts/lib/state-machines');
const {
  ResourceTrackerError,
  TaskResourceTracker,
} = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const opaqueRef = (kind, value) => `${kind}:${hash(value)}`;
const schemaRoot = path.resolve(__dirname, '../skills/dw-collaboration/references/schemas');
const loadSchema = (name) => JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8'));

function windowsProcess(overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: 'windows',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    adapter_generation: 2,
    manager_generation: 7,
    pid: 41002,
    start_time: '2026-08-30T01:00:00Z',
    executable_path_sha256: hash('C:\\Program Files\\nodejs\\node.exe'),
    argv_sha256: hash('node worker.js'),
    parent_identity_sha256: hash('parent-windows'),
    launch_nonce: 'launch-windows-1',
    manager_run_id: 'manager-run-windows-1',
    windows_identity: {
      process_creation_time_filetime: '134167428000000000',
      process_handle: '0x0000000000001234',
    },
    ...overrides,
  };
}

function linuxProcess(overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: 'linux',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    adapter_generation: 2,
    manager_generation: 7,
    pid: 41003,
    start_time: '2026-08-30T01:00:01Z',
    executable_path_sha256: hash('/usr/bin/node'),
    argv_sha256: hash('node worker.js'),
    parent_identity_sha256: hash('parent-linux'),
    launch_nonce: 'launch-linux-1',
    manager_run_id: 'manager-run-linux-1',
    linux_identity: {
      proc_start_ticks: 998877,
      boot_id_sha256: hash('boot-id-linux'),
    },
    ...overrides,
  };
}

function harnessSession(kind = 'agent_session', overrides = {}) {
  return {
    schema: 'HarnessSessionIdentity2',
    schema_version: 2,
    harness_kind: kind,
    session_id: 'session-A',
    owner_id: 'root-A',
    run_id: 'run-A',
    lease_generation: 2,
    adapter_generation: 2,
    harness_instance_id: `instance-${kind}-A`,
    launch_nonce: `launch-${kind}-A`,
    ...(kind === 'agent_session' ? { agent_id: 'agent-A' } : { thread_id: 'thread-A' }),
    ...overrides,
  };
}

function temporaryAllocation(overrides = {}) {
  return {
    schema: 'TemporaryAllocationIdentity2',
    schema_version: 2,
    platform: 'linux',
    allocation_id: 'temp-A',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    child_id: 'child-A',
    manifest_sha256: hash('manifest-A'),
    canonical_root: '/tmp/dw/run-A',
    task_directory: {
      path: '/tmp/dw/run-A/task-A',
      linux_file_identity: { device_id: 'dev-2049', inode: 889901 },
    },
    confirmed_parent_directory: {
      path: '/tmp/dw/run-A',
      linux_file_identity: { device_id: 'dev-2049', inode: 889900 },
    },
    quota: { unit: 'bytes', limit: 1048576 },
    creation_nonce: 'creation-temp-A',
    linux_file_identity: {
      device_id: 'dev-2049',
      inode: 889900,
    },
    ...overrides,
  };
}

function legacyProcess(overrides = {}) {
  return {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
    ...overrides,
  };
}

function makeTracker() {
  return new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
  });
}

function resource(resourceId, type) {
  return {
    resourceId,
    type,
    purpose: 'identity routing test',
    teardownCondition: 'scope_close',
    quota: { kind: 'bounded-test', value: 1 },
    evidenceRefs: [`declare-${resourceId}`],
  };
}

test('exports the version-2 validation surface and controlled support states', () => {
  for (const name of [
    'validateProcessIdentity2',
    'validateHarnessSessionIdentity2',
    'validateTemporaryAllocationIdentity2',
    'validateRecoveryRecord2',
    'validateSupportMatrix2',
    'validateResourceIdentity2',
    'createResourceIdentity2',
    'createRecoveryRecord2',
  ]) assert.strictEqual(typeof contracts[name], 'function', `${name} must be exported`);
  assert.deepStrictEqual(contracts.SUPPORT_STATES2, [
    'VERIFIED_FULL',
    'VERIFIED_DEGRADED',
    'UNVERIFIED',
    'NOT_RUN',
    'FAILED',
  ]);
});

test('requires task binding, adapter generations, nonces, and platform directory identities', () => {
  for (const field of ['owner_id', 'run_id', 'session_id', 'lease_generation', 'adapter_generation', 'manager_generation']) {
    const identity = windowsProcess();
    delete identity[field];
    assert.strictEqual(contracts.validateProcessIdentity2(identity).valid, false, `process ${field}`);
  }
  for (const field of ['launch_nonce', 'adapter_generation', 'agent_id']) {
    const identity = harnessSession();
    delete identity[field];
    assert.strictEqual(contracts.validateHarnessSessionIdentity2(identity).valid, false, `harness ${field}`);
  }
  const wrongHarnessKind = harnessSession('runtime_thread', { agent_id: 'agent-A' });
  delete wrongHarnessKind.thread_id;
  assert.strictEqual(contracts.validateHarnessSessionIdentity2(wrongHarnessKind).valid, false);
  for (const field of ['task_directory', 'confirmed_parent_directory', 'quota', 'creation_nonce']) {
    const identity = temporaryAllocation();
    delete identity[field];
    assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(identity).valid, false, `temporary ${field}`);
  }
  const missingParentFileIdentity = temporaryAllocation();
  delete missingParentFileIdentity.confirmed_parent_directory.linux_file_identity;
  assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(missingParentFileIdentity).valid, false);
});

test('process identities reject cross-type and mixed-platform shapes', () => {
  assert.strictEqual(contracts.validateProcessIdentity2(windowsProcess()).valid, true);
  assert.strictEqual(contracts.validateProcessIdentity2(linuxProcess()).valid, true);

  const crossType = contracts.validateProcessIdentity2(harnessSession());
  assert.strictEqual(crossType.valid, false);
  assert.strictEqual(crossType.disposition, 'HOLD');
  assert.strictEqual(crossType.action_authorized, false);
  assert(crossType.errors.some((error) => error.code === 'IDENTITY_SCHEMA_MISMATCH'));

  const missingWindows = clone(windowsProcess());
  delete missingWindows.windows_identity;
  const missingResult = contracts.validateProcessIdentity2(missingWindows);
  assert.strictEqual(missingResult.valid, false);
  assert(missingResult.errors.some((error) => error.code === 'PROCESS_PLATFORM_FIELDS_MISSING'));

  const mixed = windowsProcess({ linux_identity: linuxProcess().linux_identity });
  const mixedResult = contracts.validateProcessIdentity2(mixed);
  assert.strictEqual(mixedResult.valid, false);
  assert(mixedResult.errors.some((error) => error.code === 'PROCESS_PLATFORM_MIXED'));
});

test('harness sessions need no PID and only attach real optional OS identity', () => {
  const session = harnessSession();
  const result = contracts.validateHarnessSessionIdentity2(session);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(Object.hasOwn(session, 'pid'), false);

  const fabricated = contracts.validateHarnessSessionIdentity2(harnessSession('runtime_thread', { pid: 41002 }));
  assert.strictEqual(fabricated.valid, false);
  assert(fabricated.errors.some((error) => error.code === 'IDENTITY_ADDITIONAL_PROPERTY'));

  assert.strictEqual(contracts.validateHarnessSessionIdentity2(
    harnessSession('runtime_thread', { process_identity: windowsProcess() }),
  ).valid, true);
  assert.strictEqual(contracts.validateHarnessSessionIdentity2(
    harnessSession('runtime_thread', { process_identity: temporaryAllocation() }),
  ).valid, false);
});

test('temporary allocation identity requires platform-specific file identity', () => {
  assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(temporaryAllocation()).valid, true);
  const missing = clone(temporaryAllocation());
  delete missing.linux_file_identity;
  const missingResult = contracts.validateTemporaryAllocationIdentity2(missing);
  assert.strictEqual(missingResult.valid, false);
  assert(missingResult.errors.some((error) => error.code === 'TEMPORARY_PLATFORM_FIELDS_MISSING'));

  const mixed = temporaryAllocation({
    windows_file_identity: { volume_serial_number: 'A1B2-C3D4', file_id: '0011223344556677' },
  });
  assert(contracts.validateTemporaryAllocationIdentity2(mixed).errors
    .some((error) => error.code === 'TEMPORARY_PLATFORM_MIXED'));
});

test('tracker routes v2 identities by resource type while retaining v1 compatibility', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('agent-A', 'agent_session'));
  assert.strictEqual(scope.bind('agent-A', {
    identity: harnessSession(), generation: 2, evidenceRefs: ['harness-observed'],
  }).state, 'ACTIVE');

  scope.register(resource('process-A', 'process_tree'));
  const wrongType = scope.bind('process-A', {
    identity: harnessSession(), generation: 2, evidenceRefs: ['wrong-type'],
  });
  assert.strictEqual(wrongType.disposition, 'HOLD');
  assert.strictEqual(wrongType.action_authorized, false);
  assert(Array.isArray(wrongType.errors) && wrongType.errors.length > 0);
  assert.strictEqual(scope.getResource('process-A').state, 'HOLD');
  assert.strictEqual(scope.getResource('process-A').identity, null);

  const validProcessTracker = makeTracker();
  const validProcessScope = validProcessTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  validProcessScope.register(resource('process-A', 'process_tree'));
  assert.strictEqual(validProcessScope.bind('process-A', {
    identity: windowsProcess(), generation: 2, evidenceRefs: ['process-observed'],
  }).state, 'ACTIVE');

  scope.register(resource('temp-A', 'temporary_allocation'));
  assert.strictEqual(scope.bind('temp-A', {
    identity: temporaryAllocation(), generation: 2, evidenceRefs: ['temp-observed'],
  }).state, 'ACTIVE');

  const legacy = {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
  };
  assert.strictEqual(stateMachines.validateProcessIdentity(legacy).valid, true);
  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy', purpose: 'v1 compatibility' });
  legacyScope.register(resource('legacy-process', 'process_tree'));
  assert.strictEqual(legacyScope.bind('legacy-process', {
    identity: legacy, generation: 2, evidenceRefs: ['legacy-observed'],
  }).state, 'ACTIVE');
});

test('tracker binds harness task identity and holds every ambiguous v2 path without legacy fallback', () => {
  for (const [label, overrides] of [
    ['owner', { owner_id: 'other-root' }],
    ['run', { run_id: 'other-run' }],
    ['lease generation', { lease_generation: 3 }],
    ['adapter generation', { adapter_generation: 3 }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `root-${label.replace(/\s/g, '-')}`, purpose: 'binding' });
    scope.register(resource(`agent-${label}`, 'agent_session'));
    const held = scope.bind(`agent-${label}`, {
      identity: harnessSession('agent_session', overrides), generation: 2, evidenceRefs: [`binding-${label}`],
    });
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert.strictEqual(scope.getResource(`agent-${label}`).state, 'HOLD', label);
  }

  for (const [label, identity] of [
    ['malformed schema', { ...windowsProcess(), schema: 'ProcessIdentity3' }],
    ['wrong schema', { ...windowsProcess(), schema: 'HarnessSessionIdentity2' }],
    ['mixed legacy v2', { ...windowsProcess(), native_handle: 'legacy-handle' }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `root-${label.replace(/\s/g, '-')}`, purpose: 'routing' });
    scope.register(resource(`process-${label}`, 'process_tree'));
    const held = scope.bind(`process-${label}`, {
      identity, generation: 2, evidenceRefs: [`routing-${label}`],
    });
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert.strictEqual(scope.getResource(`process-${label}`).state, 'HOLD', label);
  }

  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-invalid', purpose: 'legacy behavior' });
  legacyScope.register(resource('legacy-invalid', 'process_tree'));
  assert.throws(
    () => legacyScope.bind('legacy-invalid', {
      identity: { pid: 1 }, generation: 2, evidenceRefs: ['legacy-invalid'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'PROCESS_IDENTITY_INVALID',
  );
});

test('tracker returns replayable structured holds for rejected version-2 rebinds and preserves legacy drift exceptions', () => {
  const incompleteProcess = windowsProcess();
  delete incompleteProcess.launch_nonce;
  const rebindCases = [
    ['changed valid identity', windowsProcess({ pid: 41004 })],
    ['incomplete identity', incompleteProcess],
    ['wrong identity type', harnessSession()],
    ['wrong identity schema', windowsProcess({ schema: 'ProcessIdentity3' })],
  ];

  for (const [label, identity] of rebindCases) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `versioned-rebind-${label.replace(/\s/g, '-')}`, purpose: 'rebind' });
    const resourceId = `versioned-rebind-${label.replace(/\s/g, '-')}`;
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, { identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`] });
    const bound = scope.getResource(resourceId);

    const held = scope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-rebind`],
    });
    assert.strictEqual(held.valid, false, label);
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert(Array.isArray(held.errors) && held.errors.length > 0, label);

    const after = scope.getResource(resourceId);
    assert.notStrictEqual(after.state, 'ACTIVE', label);
    assert.deepStrictEqual(after.identity, bound.identity, label);
    const history = tracker.exportHistory();
    const heldEvent = history.at(-1);
    assert.strictEqual(heldEvent.kind, 'RESOURCE_HELD', label);
    assert.deepStrictEqual(heldEvent.payload.decision, held, label);

    const replay = TaskResourceTracker.fromHistory({
      ownerId: 'root-A',
      runId: 'run-A',
      generation: 2,
      trustedObservationResolver: () => true,
      trustedFilesystemResolver: () => true,
      trustedHistoryResolver: () => true,
    }, history);
    const replayed = replay.snapshot().resources.find((item) => item.resourceId === resourceId);
    assert.strictEqual(replayed.state, 'HOLD', label);
    assert.deepStrictEqual(replayed.identity, bound.identity, label);
    assert.deepStrictEqual(replayed.decision, held, label);
  }

  const legacy = {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
  };
  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-rebind', purpose: 'legacy rebind' });
  legacyScope.register(resource('legacy-rebind', 'process_tree'));
  legacyScope.bind('legacy-rebind', { identity: legacy, generation: 2, evidenceRefs: ['legacy-initial'] });
  assert.throws(
    () => legacyScope.bind('legacy-rebind', {
      identity: { ...legacy, pid: 41002 }, generation: 2, evidenceRefs: ['legacy-changed'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'RESOURCE_IDENTITY_DRIFT',
  );
});

test('tracker classifies complete resource-specific v2 intent without narrowing legacy process validation', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'v2-bound-v1-rebind', purpose: 'classification' });
  scope.register(resource('v2-bound-v1-rebind', 'process_tree'));
  scope.bind('v2-bound-v1-rebind', {
    identity: windowsProcess(), generation: 2, evidenceRefs: ['v2-initial'],
  });
  const bound = scope.getResource('v2-bound-v1-rebind');
  const held = scope.bind('v2-bound-v1-rebind', {
    identity: legacyProcess(), generation: 2, evidenceRefs: ['pure-v1-rebind'],
  });
  assert.strictEqual(held.valid, false);
  assert.strictEqual(held.disposition, 'HOLD');
  assert.strictEqual(held.action_authorized, false);
  assert(held.errors.length > 0);
  const after = scope.getResource('v2-bound-v1-rebind');
  assert.strictEqual(after.state, 'HOLD');
  assert.deepStrictEqual(after.identity, bound.identity);
  const history = tracker.exportHistory();
  assert.strictEqual(history.at(-1).kind, 'RESOURCE_HELD');
  assert.deepStrictEqual(history.at(-1).payload.decision, held);
  const replay = TaskResourceTracker.fromHistory({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    trustedHistoryResolver: () => true,
  }, history);
  const replayed = replay.snapshot().resources.find((item) => item.resourceId === 'v2-bound-v1-rebind');
  assert.strictEqual(replayed.state, 'HOLD');
  assert.deepStrictEqual(replayed.identity, bound.identity);
  assert.deepStrictEqual(replayed.decision, held);

  for (const [label, identity] of [
    ['windows identity only', { windows_identity: windowsProcess().windows_identity }],
    ['process hash only', { executable_path_sha256: windowsProcess().executable_path_sha256 }],
  ]) {
    const firstTracker = makeTracker();
    const firstScope = firstTracker.openRootScope({ scopeId: `first-${label.replace(/\s/g, '-')}`, purpose: 'classification' });
    const firstResourceId = `first-${label.replace(/\s/g, '-')}`;
    firstScope.register(resource(firstResourceId, 'process_tree'));
    const firstHold = firstScope.bind(firstResourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-first`],
    });
    assert.strictEqual(firstHold.disposition, 'HOLD', `${label} first bind`);
    assert.strictEqual(firstHold.action_authorized, false, `${label} first bind`);

    const rebindTracker = makeTracker();
    const rebindScope = rebindTracker.openRootScope({ scopeId: `rebind-${label.replace(/\s/g, '-')}`, purpose: 'classification' });
    const rebindResourceId = `rebind-${label.replace(/\s/g, '-')}`;
    rebindScope.register(resource(rebindResourceId, 'process_tree'));
    rebindScope.bind(rebindResourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    const rebindHold = rebindScope.bind(rebindResourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-rebind`],
    });
    assert.strictEqual(rebindHold.disposition, 'HOLD', `${label} rebind`);
    assert.strictEqual(rebindHold.action_authorized, false, `${label} rebind`);
  }

  for (const [resourceType, identity] of [
    ['agent_session', { process_identity: windowsProcess() }],
    ['temporary_allocation', { quota: { unit: 'bytes', limit: 1 } }],
  ]) {
    const strictTracker = makeTracker();
    const strictScope = strictTracker.openRootScope({ scopeId: `exclusive-${resourceType}`, purpose: 'classification' });
    const resourceId = `exclusive-${resourceType}`;
    strictScope.register(resource(resourceId, resourceType));
    const strictHold = strictScope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`exclusive-${resourceType}`],
    });
    assert.strictEqual(strictHold.disposition, 'HOLD', resourceType);
    assert.strictEqual(strictHold.action_authorized, false, resourceType);
  }

  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-observation-id', purpose: 'legacy compatibility' });
  legacyScope.register(resource('legacy-observation-id', 'process_tree'));
  const legacy = legacyProcess({ observation_id: 'harmless-observation' });
  assert.strictEqual(legacyScope.bind('legacy-observation-id', {
    identity: legacy, generation: 2, evidenceRefs: ['legacy-extra-first'],
  }).state, 'ACTIVE');
  assert.throws(
    () => legacyScope.bind('legacy-observation-id', {
      identity: { ...legacy, pid: 41002 }, generation: 2, evidenceRefs: ['legacy-extra-rebind'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'RESOURCE_IDENTITY_DRIFT',
  );
});

test('tracker holds versioned generation, nonce, and confirmed parent identity drift', () => {
  const processTracker = makeTracker();
  const processScope = processTracker.openRootScope({ scopeId: 'process-drift', purpose: 'drift' });
  processScope.register(resource('process-drift', 'process_tree'));
  processScope.bind('process-drift', { identity: windowsProcess(), generation: 2, evidenceRefs: ['process-bind'] });
  const processHold = processScope.bind('process-drift', {
    identity: windowsProcess({ adapter_generation: 3 }), generation: 2, evidenceRefs: ['generation-drift'],
  });
  assert.strictEqual(processHold.disposition, 'HOLD');
  assert.strictEqual(processHold.action_authorized, false);

  const nonceTracker = makeTracker();
  const nonceScope = nonceTracker.openRootScope({ scopeId: 'nonce-drift', purpose: 'drift' });
  nonceScope.register(resource('nonce-drift', 'agent_session'));
  nonceScope.bind('nonce-drift', { identity: harnessSession(), generation: 2, evidenceRefs: ['nonce-bind'] });
  const nonceHold = nonceScope.bind('nonce-drift', {
    identity: harnessSession('agent_session', { launch_nonce: 'changed-nonce' }), generation: 2, evidenceRefs: ['nonce-drift'],
  });
  assert.strictEqual(nonceHold.disposition, 'HOLD');
  assert.strictEqual(nonceHold.action_authorized, false);

  const parentTracker = makeTracker();
  const parentScope = parentTracker.openRootScope({ scopeId: 'parent-drift', purpose: 'drift' });
  parentScope.register(resource('parent-drift', 'temporary_allocation'));
  parentScope.bind('parent-drift', { identity: temporaryAllocation(), generation: 2, evidenceRefs: ['parent-bind'] });
  const changedParent = temporaryAllocation();
  changedParent.confirmed_parent_directory.linux_file_identity.inode += 1;
  const parentHold = parentScope.bind('parent-drift', {
    identity: changedParent, generation: 2, evidenceRefs: ['parent-drift'],
  });
  assert.strictEqual(parentHold.disposition, 'HOLD');
  assert.strictEqual(parentHold.action_authorized, false);
});

test('recovery records reject prompt, reply, command output, and credential material', () => {
  const valid = {
    schema: 'RecoveryRecord2',
    schema_version: 2,
    resource_id: 'process-A',
    resource_type: 'process_tree',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    identity: windowsProcess(),
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z',
      observation_ref: opaqueRef('observation', 'host-observation-A'),
      identity_ref: opaqueRef('identity', 'process-A'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'cleanup-authority-A'),
    teardown_condition: 'identity_absence_verified',
    evidence_refs: [opaqueRef('evidence', 'host-observation-A')],
  };
  assert.strictEqual(contracts.validateRecoveryRecord2(valid).valid, true);

  for (const [field, value] of [
    ['user_prompt', 'delete everything'],
    ['model_reply', 'done'],
    ['command_output', 'stdout text'],
    ['api_key', 'key-value'],
    ['access_token', 'token-value'],
    ['credential', 'credential-value'],
    ['secret', 'secret-value'],
  ]) {
    const result = contracts.validateRecoveryRecord2({ ...clone(valid), [field]: value });
    assert.strictEqual(result.valid, false, field);
    assert.strictEqual(result.disposition, 'HOLD', field);
    assert.strictEqual(result.action_authorized, false, field);
    assert(result.errors.some((error) => error.code === 'RECOVERY_SENSITIVE_CONTENT'), field);
  }
  const sensitiveValue = clone(valid);
  sensitiveValue.evidence_refs = ['access_token=do-not-store'];
  assert.strictEqual(contracts.validateRecoveryRecord2(sensitiveValue).valid, false);

  for (const nakedSecret of [
    'sk-proj-1234567890abcdef',
    'ghp_1234567890abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    'bareCredentialValue123456',
  ]) {
    const exposed = clone(valid);
    exposed.evidence_refs = [nakedSecret];
    assert.strictEqual(contracts.validateRecoveryRecord2(exposed).valid, false, nakedSecret);
  }
});

test('recovery records bind phase, observation, resource type, and outer task identity', () => {
  const identities = [
    ['process_tree', windowsProcess()],
    ['command_session', windowsProcess()],
    ['agent_session', harnessSession('agent_session')],
    ['runtime_thread', harnessSession('runtime_thread')],
    ['temporary_allocation', temporaryAllocation()],
  ];
  const base = {
    schema: 'RecoveryRecord2', schema_version: 2, resource_id: 'resource-A', resource_type: 'process_tree',
    run_id: 'run-A', session_id: 'session-A', lease_generation: 2, identity: windowsProcess(),
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z', observation_ref: opaqueRef('observation', 'obs-A'),
      identity_ref: opaqueRef('identity', 'identity-A'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'authority-A'),
    teardown_condition: 'identity_absence_verified', evidence_refs: [opaqueRef('evidence', 'evidence-A')],
  };
  for (const [resourceType, identity] of identities) {
    const record = {
      ...clone(base),
      resource_type: resourceType,
      run_id: identity.run_id,
      session_id: identity.session_id,
      lease_generation: identity.lease_generation,
      identity: clone(identity),
    };
    assert.strictEqual(contracts.validateRecoveryRecord2(record).valid, true, resourceType);
    const wrongType = { ...clone(record), resource_type: resourceType === 'agent_session' ? 'process_tree' : 'agent_session' };
    assert.strictEqual(contracts.validateRecoveryRecord2(wrongType).valid, false, `${resourceType} cross type`);
    for (const field of ['run_id', 'session_id', 'lease_generation']) {
      const mismatch = clone(record);
      mismatch[field] = field === 'lease_generation' ? 3 : `other-${field}`;
      const result = contracts.validateRecoveryRecord2(mismatch);
      assert.strictEqual(result.valid, false, `${resourceType} ${field}`);
      assert(result.errors.some((error) => error.code === 'RECOVERY_IDENTITY_BINDING_MISMATCH'));
    }
  }
  for (const field of ['current_phase', 'last_valid_observation']) {
    const missing = clone(base);
    delete missing[field];
    assert.strictEqual(contracts.validateRecoveryRecord2(missing).valid, false, field);
  }
});

test('support matrices cannot turn skipped or not-run claims into full support', () => {
  const full = {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'windows-local-A',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      process_identity: { state: 'VERIFIED_FULL', evidence_refs: ['test-A'] },
    },
  };
  const fullResult = contracts.validateSupportMatrix2(full);
  assert.strictEqual(fullResult.valid, true);
  assert.strictEqual(fullResult.effective_state, 'VERIFIED_FULL');

  const skippedAsFull = clone(full);
  skippedAsFull.claims.process_tree_terminate = { state: 'NOT_RUN', evidence_refs: [] };
  const skippedResult = contracts.validateSupportMatrix2(skippedAsFull);
  assert.strictEqual(skippedResult.valid, false);
  assert.strictEqual(skippedResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(skippedResult.action_authorized, false);
  assert(skippedResult.errors.some((error) => error.code === 'SUPPORT_FULL_WITH_INCOMPLETE_CLAIM'));

  const skipped = clone(full);
  skipped.overall_state = 'NOT_RUN';
  skipped.claims = { process_tree_terminate: { state: 'NOT_RUN', evidence_refs: [] } };
  assert.strictEqual(contracts.validateSupportMatrix2(skipped).valid, true);

  const uncontrolled = clone(full);
  uncontrolled.overall_state = 'SKIPPED';
  assert(contracts.validateSupportMatrix2(uncontrolled).errors
    .some((error) => error.code === 'SUPPORT_STATE_INVALID'));

  const incompleteNotRun = clone(skipped);
  delete incompleteNotRun.claims.process_tree_terminate.evidence_refs;
  const incompleteResult = contracts.validateSupportMatrix2(incompleteNotRun);
  assert.strictEqual(incompleteResult.valid, false);
  assert.strictEqual(incompleteResult.disposition, 'HOLD');
  assert.strictEqual(incompleteResult.action_authorized, false);

  const emptyFullEvidence = clone(full);
  emptyFullEvidence.claims.process_identity.evidence_refs = [];
  const emptyFullResult = contracts.validateSupportMatrix2(emptyFullEvidence);
  assert.strictEqual(emptyFullResult.valid, false);
  assert.strictEqual(emptyFullResult.effective_state, 'UNVERIFIED');

  const notRunEvidence = clone(skipped);
  notRunEvidence.claims.process_tree_terminate.evidence_refs = ['test-ran'];
  const notRunEvidenceResult = contracts.validateSupportMatrix2(notRunEvidence);
  assert.strictEqual(notRunEvidenceResult.valid, false);
  assert.strictEqual(notRunEvidenceResult.effective_state, 'UNVERIFIED');

  const legacyArray = {
    ...clone(full),
    claims: [
      { capability_id: 'process_identity', state: 'VERIFIED_FULL', evidence_refs: ['test-A'] },
      { capability_id: 'process_tree_terminate', state: 'VERIFIED_FULL', evidence_refs: ['test-B'] },
    ],
  };
  const legacyArrayResult = contracts.validateSupportMatrix2(legacyArray);
  assert.strictEqual(legacyArrayResult.valid, false);
  assert.strictEqual(legacyArrayResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(legacyArrayResult.action_authorized, false);

  const distinctCapabilities = clone(full);
  distinctCapabilities.claims.process_tree_terminate = {
    state: 'VERIFIED_FULL', evidence_refs: ['test-B'],
  };
  const distinctCapabilitiesResult = contracts.validateSupportMatrix2(distinctCapabilities);
  assert.strictEqual(distinctCapabilitiesResult.valid, true);
  assert.strictEqual(distinctCapabilitiesResult.effective_state, 'VERIFIED_FULL');

  const invalidKey = clone(full);
  invalidKey.claims.constructor = { state: 'VERIFIED_FULL', evidence_refs: ['test-B'] };
  const invalidKeyResult = contracts.validateSupportMatrix2(invalidKey);
  assert.strictEqual(invalidKeyResult.valid, false);
  assert.strictEqual(invalidKeyResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(invalidKeyResult.action_authorized, false);
});

test('schema contracts encode the same critical identity, recovery, and support rules', () => {
  const processSchema = loadSchema('ProcessIdentity2.schema.json');
  for (const field of ['owner_id', 'run_id', 'session_id', 'lease_generation', 'adapter_generation', 'manager_generation']) {
    assert(processSchema.$defs.common.required.includes(field), field);
  }
  const harnessSchema = loadSchema('HarnessSessionIdentity2.schema.json');
  for (const field of ['launch_nonce', 'adapter_generation']) assert(harnessSchema.required.includes(field), field);
  assert(Array.isArray(harnessSchema.oneOf) && harnessSchema.oneOf.length === 2);
  const temporarySchema = loadSchema('TemporaryAllocationIdentity2.schema.json');
  for (const field of ['task_directory', 'confirmed_parent_directory', 'quota', 'creation_nonce']) {
    assert(temporarySchema.$defs.common.required.includes(field), field);
  }
  const recoverySchema = loadSchema('RecoveryRecord2.schema.json');
  assert(recoverySchema.required.includes('current_phase'));
  assert(recoverySchema.required.includes('last_valid_observation'));
  assert(Array.isArray(recoverySchema.allOf) && recoverySchema.allOf.length === 5);
  const supportSchema = loadSchema('SupportMatrix2.schema.json');
  assert(Array.isArray(supportSchema.allOf) && supportSchema.allOf.length >= 2);
  assert.strictEqual(supportSchema.properties.claims.type, 'object');
  assert.strictEqual(supportSchema.properties.claims.minProperties, 1);
  assert.strictEqual(typeof supportSchema.properties.claims.propertyNames, 'object');
  assert.strictEqual(supportSchema.properties.claims['x-uniqueBy'], undefined);
});

test('version-2 factories own schema fields and reject legacy identity input', () => {
  const processFields = windowsProcess();
  delete processFields.schema;
  delete processFields.schema_version;
  const createdProcess = contracts.createResourceIdentity2('process_tree', processFields);
  assert.strictEqual(createdProcess.schema, 'ProcessIdentity2');
  assert.strictEqual(createdProcess.schema_version, 2);
  assert(Object.isFrozen(createdProcess));

  const harnessFields = harnessSession();
  delete harnessFields.schema;
  delete harnessFields.schema_version;
  delete harnessFields.harness_kind;
  assert.strictEqual(contracts.createResourceIdentity2('agent_session', harnessFields).schema_version, 2);

  const recoveryFields = {
    resource_id: 'process-A', resource_type: 'process_tree', run_id: 'run-A', session_id: 'session-A',
    lease_generation: 2, identity: createdProcess, current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z', observation_ref: opaqueRef('observation', 'factory-observation'),
      identity_ref: opaqueRef('identity', 'factory-identity'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'factory-authority'),
    teardown_condition: 'identity_absence_verified', evidence_refs: [opaqueRef('evidence', 'factory-evidence')],
  };
  assert.strictEqual(contracts.createRecoveryRecord2(recoveryFields).schema_version, 2);
  assert.throws(() => contracts.createResourceIdentity2('process_tree', {
    pid: 1, native_handle: 'legacy', start_time: '2026-08-30T01:00:00Z',
    exe_path_hash: hash('legacy'), argv_hash: hash('legacy'), parent_identity_hash: hash('legacy'),
    nonce: 'legacy', native_process_manager_run_id: 'legacy',
  }), /IDENTITY_V2_BUILD_REJECTED/);
  assert.throws(() => contracts.createRecoveryRecord2({ ...recoveryFields, identity: {
    pid: 1, native_handle: 'legacy', start_time: '2026-08-30T01:00:00Z',
    exe_path_hash: hash('legacy'), argv_hash: hash('legacy'), parent_identity_hash: hash('legacy'),
    nonce: 'legacy', native_process_manager_run_id: 'legacy',
  } }), /RECOVERY_V2_BUILD_REJECTED/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failed > 0) process.exitCode = 1;
else process.stdout.write(`${tests.length} identity/support v2 tests passed.\n`);
