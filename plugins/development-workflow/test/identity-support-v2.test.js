#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');

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

function windowsProcess(overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: 'windows',
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
    session_id: `${kind}-A`,
    owner_id: 'root-A',
    run_id: 'run-A',
    lease_generation: 2,
    harness_instance_id: `instance-${kind}-A`,
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
    linux_file_identity: {
      device_id: 'dev-2049',
      inode: 889900,
    },
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
  ]) assert.strictEqual(typeof contracts[name], 'function', `${name} must be exported`);
  assert.deepStrictEqual(contracts.SUPPORT_STATES2, [
    'VERIFIED_FULL',
    'VERIFIED_DEGRADED',
    'UNVERIFIED',
    'NOT_RUN',
    'FAILED',
  ]);
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
  assert.throws(
    () => scope.bind('process-A', {
      identity: harnessSession(), generation: 2, evidenceRefs: ['wrong-type'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'PROCESS_IDENTITY_INVALID',
  );
  assert.strictEqual(scope.bind('process-A', {
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
    cleanup_authority_ref: 'cleanup-authority-A',
    teardown_condition: 'identity-bound absence verified',
    evidence_refs: ['host-observation-A'],
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
  assert(contracts.validateRecoveryRecord2(sensitiveValue).errors
    .some((error) => error.code === 'RECOVERY_SENSITIVE_CONTENT'));
});

test('support matrices cannot turn skipped or not-run claims into full support', () => {
  const full = {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'windows-local-A',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: 'VERIFIED_FULL',
    claims: [{ capability_id: 'process_identity', state: 'VERIFIED_FULL', evidence_refs: ['test-A'] }],
  };
  const fullResult = contracts.validateSupportMatrix2(full);
  assert.strictEqual(fullResult.valid, true);
  assert.strictEqual(fullResult.effective_state, 'VERIFIED_FULL');

  const skippedAsFull = clone(full);
  skippedAsFull.claims.push({ capability_id: 'process_tree_terminate', state: 'NOT_RUN', evidence_refs: [] });
  const skippedResult = contracts.validateSupportMatrix2(skippedAsFull);
  assert.strictEqual(skippedResult.valid, false);
  assert.strictEqual(skippedResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(skippedResult.action_authorized, false);
  assert(skippedResult.errors.some((error) => error.code === 'SUPPORT_FULL_WITH_INCOMPLETE_CLAIM'));

  const skipped = clone(full);
  skipped.overall_state = 'NOT_RUN';
  skipped.claims = [{ capability_id: 'process_tree_terminate', state: 'NOT_RUN', evidence_refs: [] }];
  assert.strictEqual(contracts.validateSupportMatrix2(skipped).valid, true);

  const uncontrolled = clone(full);
  uncontrolled.overall_state = 'SKIPPED';
  assert(contracts.validateSupportMatrix2(uncontrolled).errors
    .some((error) => error.code === 'SUPPORT_STATE_INVALID'));

  const incompleteNotRun = clone(skipped);
  delete incompleteNotRun.claims[0].evidence_refs;
  const incompleteResult = contracts.validateSupportMatrix2(incompleteNotRun);
  assert.strictEqual(incompleteResult.valid, false);
  assert.strictEqual(incompleteResult.disposition, 'HOLD');
  assert.strictEqual(incompleteResult.action_authorized, false);
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
