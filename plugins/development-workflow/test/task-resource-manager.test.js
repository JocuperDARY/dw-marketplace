#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
  canonicalizeDetachedSnapshot,
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('../skills/dw-collaboration/scripts/lib/canonical-json');

const targetSpecifier = '../skills/dw-collaboration/scripts/lib/task-resource-manager';
let api;
let targetPath;
try {
  targetPath = require.resolve(targetSpecifier);
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    api = {};
  } else {
    throw error;
  }
}
if (targetPath) api = require(targetPath);

assert.strictEqual(
  typeof api.TaskResourceManager?.open,
  'function',
  'RED: TaskResourceManager.open() must create a private, trusted manager root',
);

assert.strictEqual(
  typeof api.TaskResourceManager?.prototype?.startCommand,
  'function',
  'RED: TaskResourceManager.startCommand() must register and bind a trusted command before launch',
);

const { TaskResourceManager, TaskResourceManagerError } = api;
const SHA256 = 'a'.repeat(64);
const AUTHORITY_REF = `authority:${'b'.repeat(64)}`;
const EVIDENCE_REF = `evidence:${'c'.repeat(64)}`;
const REQUIRED_REFERENCES = Object.freeze([AUTHORITY_REF, EVIDENCE_REF].sort());
const DATA_ROOT = path.join(path.parse(process.cwd()).root, 'task-resource-data');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function authorization(allowForceTermination = false) {
  return {
    type: 'TaskResourceAuthorization1',
    cleanupAuthorityRef: AUTHORITY_REF,
    allowForceTermination,
  };
}

function supportMatrix(claimOverrides = {}) {
  return {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'adapter-A',
    platform: 'windows',
    observed_at: '2026-09-04T01:02:03Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      process_identity: { state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] },
      temporary_lease: { state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] },
      ...claimOverrides,
    },
  };
}

function capabilityEnvelope(inputAuthorization, overrides = {}) {
  const snapshot = createDetachedJsonSnapshot(inputAuthorization).snapshot;
  const provenance = {
    type: 'TaskResourceProvenance1',
    runId: 'run-3-1',
    harnessId: 'harness-A',
    producerId: 'producer-A',
    ownerId: 'owner-A',
    sessionId: 'session-A',
    managerRunId: 'manager-run-A',
    managerGeneration: 1,
    adapterId: 'adapter-A',
    adapterGeneration: 1,
    platform: 'windows',
    observedAt: '2026-09-04T01:02:03Z',
    authorizationSha256: computeDetachedSha256(snapshot),
  };
  const envelope = {
    type: 'TaskResourceCapabilityEnvelope1',
    provenance,
    supportMatrix: supportMatrix(overrides.claimOverrides),
  };
  return {
    ...envelope,
    ...overrides,
    provenance: { ...provenance, ...(overrides.provenance || {}) },
    supportMatrix: overrides.supportMatrix || envelope.supportMatrix,
  };
}

function validInput({
  envelopeMutator, trustedProducer, limits, adapterHandlers, rejectResolutionType,
  allowForceTermination = false,
} = {}) {
  const inputAuthorization = authorization(allowForceTermination);
  const calls = {
    probeCapabilities: 0,
    spawnManaged: 0,
    observeProcess: 0,
    requestGracefulStop: 0,
    terminateOwnedTree: 0,
    verifyProcessAbsent: 0,
    allocateTemporaryRoot: 0,
    quarantineTemporaryRoot: 0,
    removeTemporaryRoot: 0,
    verifyTemporaryAbsent: 0,
  };
  const expectedAuthorizationSha256 = computeDetachedSha256(
    createDetachedJsonSnapshot(inputAuthorization).snapshot,
  );
  let receivedEnvelope = null;
  let receivedContext = null;
  let probedEnvelope = null;
  const producer = trustedProducer || ((envelope, context) => {
    if (context.resolutionType === 'observation' || context.resolutionType === 'filesystem') {
      if (context.resolutionType === rejectResolutionType) return false;
      return Object.isFrozen(envelope)
        && context.runId === 'run-3-1'
        && context.harnessId === 'harness-A'
        && context.adapterId === 'adapter-A'
        && context.provenance.runId === 'run-3-1';
    }
    receivedEnvelope = envelope;
    receivedContext = context;
    return Object.isFrozen(envelope)
      && Object.isFrozen(context)
      && envelope.provenance.runId === 'run-3-1'
      && context.runId === 'run-3-1'
      && context.harnessId === 'harness-A'
      && context.adapterId === 'adapter-A'
      && context.authorizationSha256 === expectedAuthorizationSha256
      && Array.isArray(context.requiredReferences)
      && context.requiredReferences.length === REQUIRED_REFERENCES.length
      && context.requiredReferences.every((reference) => REQUIRED_REFERENCES.includes(reference));
  });
  const platformAdapter = {
    type: 'TaskResourcePlatformAdapter1',
    adapterId: 'adapter-A',
    probeCapabilities: (context) => {
      calls.probeCapabilities += 1;
      assert(Object.isFrozen(context), 'probe context must be frozen');
      assert.deepStrictEqual(Object.keys(context).sort(), ['adapterId', 'harnessId', 'runId', 'type']);
      const envelope = capabilityEnvelope(inputAuthorization);
      if (envelopeMutator) envelopeMutator(envelope);
      probedEnvelope = envelope;
      return envelope;
    },
    spawnManaged: (request) => {
      calls.spawnManaged += 1;
      return adapterHandlers?.spawnManaged?.(request);
    },
    observeProcess: () => { calls.observeProcess += 1; },
    requestGracefulStop: () => { calls.requestGracefulStop += 1; },
    terminateOwnedTree: () => { calls.terminateOwnedTree += 1; },
    verifyProcessAbsent: () => { calls.verifyProcessAbsent += 1; },
    allocateTemporaryRoot: (request) => {
      calls.allocateTemporaryRoot += 1;
      return adapterHandlers?.allocateTemporaryRoot?.(request);
    },
    quarantineTemporaryRoot: () => { calls.quarantineTemporaryRoot += 1; },
    removeTemporaryRoot: () => { calls.removeTemporaryRoot += 1; },
    verifyTemporaryAbsent: () => { calls.verifyTemporaryAbsent += 1; },
  };
  return {
    input: {
      runId: 'run-3-1',
      harness: { type: 'TaskResourceHarness1', harnessId: 'harness-A', trustedProducer: producer },
      dataRoot: DATA_ROOT,
      platformAdapter,
      authorization: inputAuthorization,
      limits: limits || { tracker: { maxScopes: 3 } },
    },
    calls,
    platformAdapter,
    received: () => ({ envelope: receivedEnvelope, context: receivedContext, probedEnvelope }),
  };
}

function expectHold(action, label) {
  assert.throws(
    action,
    (error) => error instanceof TaskResourceManagerError
      && error.code === 'TASK_RESOURCE_MANAGER_HOLD'
      && !String(error.message).includes('authority:'),
    label,
  );
}

test('open creates a frozen manager only after provenance and reference trust validation', () => {
  const fixture = validInput();
  const manager = TaskResourceManager.open(fixture.input);
  assert(Object.isFrozen(manager));
  assert.strictEqual(JSON.stringify(manager), '{}');
  assert.deepStrictEqual(Object.keys(manager), []);
  for (const forbidden of ['platformAdapter', 'authorization', 'provenance', 'tracker', 'dataRoot', 'trustedProducer']) {
    assert.strictEqual(Object.hasOwn(manager, forbidden), false, `${forbidden} must remain private`);
  }
  const received = fixture.received();
  assert(received.envelope && received.context, 'trusted producer must receive a detached envelope and context');
  assert.notStrictEqual(received.envelope, received.probedEnvelope);
  assert.deepStrictEqual(received.context.requiredReferences, REQUIRED_REFERENCES);
  assert(Object.isFrozen(received.context.requiredReferences));
  assert.strictEqual(fixture.calls.probeCapabilities, 1);
});

test('open holds on unknown references, provenance mismatch, authorization hash mismatch, and invalid support matrix', () => {
  const cases = [
    ['unknown reference', (envelope) => { envelope.supportMatrix.claims.process_identity.evidence_refs = [`evidence:${'d'.repeat(64)}`]; }],
    ['adapter mismatch', (envelope) => { envelope.provenance.adapterId = 'adapter-B'; }],
    ['support-matrix adapter mismatch', (envelope) => { envelope.supportMatrix.adapter_id = 'adapter-B'; }],
    ['authorization hash mismatch', (envelope) => { envelope.provenance.authorizationSha256 = SHA256; }],
    ['invalid support matrix', (envelope) => { envelope.supportMatrix.claims.process_identity.evidence_refs = []; }],
  ];
  for (const [label, envelopeMutator] of cases) {
    const fixture = validInput({ envelopeMutator });
    expectHold(() => TaskResourceManager.open(fixture.input), label);
    assert.strictEqual(fixture.calls.probeCapabilities, 1, `${label} must probe exactly once`);
  }
});

test('open holds when trusted producer rejects the otherwise valid envelope', () => {
  const fixture = validInput({ trustedProducer: () => false });
  expectHold(() => TaskResourceManager.open(fixture.input), 'trusted producer rejection');
});

test('open rejects a RecoveryRecord2-shaped authorization before probing', () => {
  const fixture = validInput();
  fixture.input.authorization = {
    schema: 'RecoveryRecord2',
    schema_version: 2,
    resource_id: 'resource-A',
    resource_type: 'process_tree',
    run_id: 'run-3-1',
    session_id: 'session-A',
    lease_generation: 1,
    identity: {},
    current_phase: { phase: 'cleanup', state: 'HOLD' },
    last_valid_observation: {},
    cleanup_authority_ref: AUTHORITY_REF,
    teardown_condition: 'identity_absence_verified',
    evidence_refs: [EVIDENCE_REF],
  };
  expectHold(() => TaskResourceManager.open(fixture.input), 'RecoveryRecord2 authorization');
  assert.strictEqual(fixture.calls.probeCapabilities, 0);
});

test('open does not call any future platform action during root creation', () => {
  const fixture = validInput();
  TaskResourceManager.open(fixture.input);
  for (const [name, calls] of Object.entries(fixture.calls)) {
    if (name !== 'probeCapabilities') assert.strictEqual(calls, 0, `${name} must not run during open`);
  }
});

test('open rejects getters, extra top-level fields, and illegal limits before probing', () => {
  const getterFixture = validInput();
  Object.defineProperty(getterFixture.input, 'runId', {
    enumerable: true,
    get() { throw new Error('must not read getter'); },
  });
  expectHold(() => TaskResourceManager.open(getterFixture.input), 'getter input');
  assert.strictEqual(getterFixture.calls.probeCapabilities, 0);

  const extraFixture = validInput();
  extraFixture.input.extra = true;
  expectHold(() => TaskResourceManager.open(extraFixture.input), 'extra input field');
  assert.strictEqual(extraFixture.calls.probeCapabilities, 0);

  const limitsFixture = validInput({ limits: { tracker: { maxScopes: 0 } } });
  expectHold(() => TaskResourceManager.open(limitsFixture.input), 'invalid tracker limits');
  assert.strictEqual(limitsFixture.calls.probeCapabilities, 0);
});

function commandInput(overrides = {}) {
  const root = path.parse(process.cwd()).root;
  return {
    commandId: 'command-A',
    executable: 'node.exe',
    args: ['--version'],
    cwd: path.join(root, 'task-resource-cwd'),
    timeoutMs: 5000,
    temporaryRoot: path.join(root, 'task-resource-temporary-parent'),
    ...overrides,
  };
}

function processIdentityFor(request, overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: request.provenance.platform,
    owner_id: request.provenance.ownerId,
    run_id: request.provenance.runId,
    session_id: request.provenance.sessionId,
    lease_generation: request.provenance.managerGeneration,
    adapter_generation: request.provenance.adapterGeneration,
    manager_generation: request.provenance.managerGeneration,
    pid: 41002,
    start_time: '2026-09-04T01:00:00Z',
    executable_path_sha256: SHA256,
    argv_sha256: 'd'.repeat(64),
    parent_identity_sha256: 'e'.repeat(64),
    launch_nonce: request.launchNonce,
    manager_run_id: request.provenance.managerRunId,
    windows_identity: {
      process_creation_time_filetime: '134167428000000000',
      process_handle: '0x0000000000001234',
    },
    ...overrides,
  };
}

function temporaryIdentityFor(request, overrides = {}) {
  const taskDirectory = path.join(request.temporaryRoot, request.allocationId);
  return {
    schema: 'TemporaryAllocationIdentity2',
    schema_version: 2,
    platform: request.provenance.platform,
    allocation_id: request.allocationId,
    owner_id: request.provenance.ownerId,
    run_id: request.provenance.runId,
    session_id: request.provenance.sessionId,
    lease_generation: request.provenance.managerGeneration,
    child_id: request.resourceIds.commandSession,
    manifest_sha256: SHA256,
    canonical_root: request.temporaryRoot,
    task_directory: {
      path: taskDirectory,
      windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' },
    },
    confirmed_parent_directory: {
      path: request.temporaryRoot,
      windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'parent-A' },
    },
    quota: { unit: 'bytes', limit: 1048576 },
    creation_nonce: request.creationNonce,
    windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'parent-A' },
    ...overrides,
  };
}

function startFixture({
  envelopeMutator, limits, trustedProducer, allocation, spawn, rejectResolutionType,
  allowForceTermination,
} = {}) {
  const actions = [];
  const fixture = validInput({
    envelopeMutator,
    limits,
    trustedProducer,
    rejectResolutionType,
    allowForceTermination,
    adapterHandlers: {
      allocateTemporaryRoot: (request) => {
        actions.push({ kind: 'allocate', request });
        return allocation ? allocation(request) : {
          identity: temporaryIdentityFor(request),
          evidenceRefs: [EVIDENCE_REF],
          requestSha256: request.requestSha256,
        };
      },
      spawnManaged: (request) => {
        actions.push({ kind: 'spawn', request });
        return spawn ? spawn(request) : {
          identity: processIdentityFor(request),
          evidenceRefs: [EVIDENCE_REF],
          requestSha256: request.requestSha256,
        };
      },
    },
  });
  return { ...fixture, actions, manager: () => TaskResourceManager.open(fixture.input) };
}

function recomputeRequestSha256(request) {
  const { requestSha256, ...preimage } = request;
  return computeDetachedSha256(createDetachedJsonSnapshot(preimage).snapshot);
}

async function expectHoldAsync(action, label) {
  await assert.rejects(
    action,
    (error) => error instanceof TaskResourceManagerError
      && error.code === 'TASK_RESOURCE_MANAGER_HOLD'
      && !String(error.message).includes('authority:'),
    label,
  );
}

test('startCommand registers before fake allocation and spawn, binds only cross-checked identities, and returns only a frozen opaque process resource id', async () => {
  const fixture = startFixture();
  const manager = fixture.manager();
  const result = await manager.startCommand(commandInput());
  assert.deepStrictEqual(result, {
    status: 'STARTED',
    commandId: 'command-A',
    resourceId: 'command:command-A:process-tree',
  });
  assert(Object.isFrozen(result));
  assert.strictEqual(fixture.actions.length, 2);
  assert.deepStrictEqual(fixture.actions.map((entry) => entry.kind), ['allocate', 'spawn']);
  const [allocation, spawn] = fixture.actions.map((entry) => entry.request);
  assert(Object.isFrozen(allocation));
  assert(Object.isFrozen(allocation.args));
  assert(Object.isFrozen(spawn));
  assert(Object.isFrozen(spawn.args));
  assert.strictEqual(Object.hasOwn(allocation, 'command'), false);
  assert.strictEqual(Object.hasOwn(spawn, 'command'), false);
  assert.strictEqual(allocation.executable, 'node.exe');
  assert.deepStrictEqual(allocation.args, ['--version']);
  assert.strictEqual(allocation.resourceIds.temporaryAllocation, 'command:command-A:temporary');
  assert.strictEqual(allocation.resourceIds.commandSession, 'command:command-A:session');
  assert.strictEqual(allocation.resourceIds.processTree, 'command:command-A:process-tree');
  assert.strictEqual(spawn.temporaryAllocationIdentity.allocation_id, allocation.allocationId);
  assert.notStrictEqual(allocation.requestSha256, spawn.requestSha256);
  assert.strictEqual(typeof allocation.allocationId, 'string');
  assert.strictEqual(typeof allocation.creationNonce, 'string');
  assert.strictEqual(typeof spawn.launchNonce, 'string');
  assert.strictEqual(allocation.requestSha256, recomputeRequestSha256(allocation));
  assert.strictEqual(spawn.requestSha256, recomputeRequestSha256(spawn));
  assert.notStrictEqual(processIdentityFor(spawn).executable_path_sha256, spawn.requestSha256);
  assert.notStrictEqual(processIdentityFor(spawn).argv_sha256, spawn.requestSha256);
});

test('startCommand skips temporary allocation when temporaryRoot is null', async () => {
  const fixture = startFixture();
  const result = await fixture.manager().startCommand(commandInput({ commandId: 'command-B', temporaryRoot: null }));
  assert.strictEqual(result.resourceId, 'command:command-B:process-tree');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 0);
  assert.strictEqual(fixture.calls.spawnManaged, 1);
  assert.strictEqual(fixture.actions[0].request.temporaryAllocationIdentity, null);
});

test('startCommand holds before actions when registration capacity, inputs, capabilities, or generation do not allow launch', async () => {
  const capacityFixture = startFixture({ limits: { tracker: { maxScopes: 3, maxResources: 2 } } });
  await expectHoldAsync(() => capacityFixture.manager().startCommand(commandInput()), 'last registration capacity');
  assert.strictEqual(capacityFixture.calls.allocateTemporaryRoot, 0);
  assert.strictEqual(capacityFixture.calls.spawnManaged, 0);

  const invalidCases = [
    ['extra field', { extra: true }],
    ['string args', { commandId: 'command-C', args: '--version' }],
    ['empty executable', { commandId: 'command-D', executable: '' }],
    ['control executable', { commandId: 'command-E', executable: 'node\n.exe' }],
    ['relative cwd', { commandId: 'command-F', cwd: 'relative' }],
    ['root cwd', { commandId: 'command-G', cwd: path.parse(process.cwd()).root }],
    ['root temporary', { commandId: 'command-H', temporaryRoot: path.parse(process.cwd()).root }],
    ['invalid timeout', { commandId: 'command-I', timeoutMs: 0 }],
    ['invalid command id', { commandId: '-bad' }],
  ];
  for (const [label, overrides] of invalidCases) {
    const fixture = startFixture();
    await expectHoldAsync(() => fixture.manager().startCommand(commandInput(overrides)), label);
    assert.strictEqual(fixture.calls.allocateTemporaryRoot, 0, `${label} allocation`);
    assert.strictEqual(fixture.calls.spawnManaged, 0, `${label} spawn`);
  }

  const sparseFixture = startFixture();
  const sparse = ['--version']; delete sparse[0];
  await expectHoldAsync(() => sparseFixture.manager().startCommand(commandInput({ commandId: 'command-J', args: sparse })), 'sparse args');
  assert.strictEqual(sparseFixture.calls.spawnManaged, 0);

  const capabilityFixture = startFixture({ envelopeMutator: (envelope) => {
    envelope.supportMatrix.claims.process_identity.state = 'UNVERIFIED';
    envelope.supportMatrix.overall_state = 'UNVERIFIED';
  } });
  await expectHoldAsync(() => capabilityFixture.manager().startCommand(commandInput({ commandId: 'command-K' })), 'process capability');
  assert.strictEqual(capabilityFixture.calls.spawnManaged, 0);

  const generationFixture = startFixture({ envelopeMutator: (envelope) => { envelope.provenance.adapterGeneration = 2; } });
  await expectHoldAsync(() => generationFixture.manager().startCommand(commandInput({ commandId: 'command-L' })), 'generation mismatch');
  assert.strictEqual(generationFixture.calls.allocateTemporaryRoot, 0);
  assert.strictEqual(generationFixture.calls.spawnManaged, 0);
});

test('startCommand holds on rejected allocation responses without spawning and keeps the command id unavailable', async () => {
  const fixture = startFixture({ allocation: (request) => ({
    identity: temporaryIdentityFor(request, { creation_nonce: 'other-creation-nonce' }),
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: request.requestSha256,
  }) });
  const manager = fixture.manager();
  await expectHoldAsync(() => manager.startCommand(commandInput({ commandId: 'command-M' })), 'allocation nonce mismatch');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1);
  assert.strictEqual(fixture.calls.spawnManaged, 0);
  await expectHoldAsync(() => manager.startCommand(commandInput({ commandId: 'command-M' })), 'held command reuse');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1);
});

test('startCommand holds on rejected spawn responses and never republishes a command id after a failed bind', async () => {
  const fixture = startFixture({ spawn: (request) => ({
    identity: processIdentityFor(request, { windows_identity: { process_creation_time_filetime: '134167428000000000', process_handle: '' } }),
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: request.requestSha256,
  }) });
  const manager = fixture.manager();
  await expectHoldAsync(() => manager.startCommand(commandInput({ commandId: 'command-N' })), 'spawn bind hold');
  assert.strictEqual(fixture.calls.spawnManaged, 1);
  await expectHoldAsync(() => manager.startCommand(commandInput({ commandId: 'command-N' })), 'failed spawn command reuse');
  assert.strictEqual(fixture.calls.spawnManaged, 1);
});

test('R1 aggregates safe args inspection, canonical allocation paths, and one launch nonce', async () => {
  const actual = {};

  let lengthGets = 0;
  const proxiedArgs = new Proxy(['--version'], {
    get(target, property, receiver) {
      if (property === 'length') {
        lengthGets += 1;
        throw new Error('length getter must not run');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const proxyFixture = startFixture();
  try {
    await proxyFixture.manager().startCommand(commandInput({
      commandId: 'command-r1-proxy',
      args: proxiedArgs,
    }));
    actual.proxy = { status: 'STARTED', lengthGets, actions: proxyFixture.actions.length };
  } catch (error) {
    actual.proxy = {
      status: error instanceof TaskResourceManagerError ? 'HOLD' : 'ERROR',
      lengthGets,
      actions: proxyFixture.actions.length,
    };
  }

  const relativeFixture = startFixture({ allocation: (request) => {
    const relativeTaskPath = path.relative(
      process.cwd(),
      path.join(request.temporaryRoot, request.allocationId),
    );
    return {
      identity: temporaryIdentityFor(request, {
        task_directory: {
          path: relativeTaskPath,
          windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' },
        },
      }),
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    };
  } });
  try {
    await relativeFixture.manager().startCommand(commandInput({ commandId: 'command-r1-relative' }));
    actual.relativePath = { status: 'STARTED', spawn: relativeFixture.calls.spawnManaged };
  } catch (error) {
    actual.relativePath = {
      status: error instanceof TaskResourceManagerError ? 'HOLD' : 'ERROR',
      spawn: relativeFixture.calls.spawnManaged,
    };
  }

  const nonceFixture = startFixture();
  await nonceFixture.manager().startCommand(commandInput({ commandId: 'command-r1-nonce' }));
  const [allocationRequest, spawnRequest] = nonceFixture.actions.map((entry) => entry.request);
  actual.launchNonce = {
    bothNonEmpty: typeof allocationRequest.launchNonce === 'string'
      && allocationRequest.launchNonce.length > 0
      && typeof spawnRequest.launchNonce === 'string'
      && spawnRequest.launchNonce.length > 0,
    same: allocationRequest.launchNonce === spawnRequest.launchNonce,
  };

  assert.deepStrictEqual(actual, {
    proxy: { status: 'STARTED', lengthGets: 0, actions: 2 },
    relativePath: { status: 'HOLD', spawn: 0 },
    launchNonce: { bothNonEmpty: true, same: true },
  });
});

test('startCommand rejects unsafe command object and argv shapes before adapter actions', async () => {
  const cases = [
    ['missing field', () => { const value = commandInput({ commandId: 'unsafe-missing' }); delete value.cwd; return value; }],
    ['top-level getter', () => {
      const value = commandInput({ commandId: 'unsafe-getter' });
      Object.defineProperty(value, 'cwd', { enumerable: true, get() { throw new Error('must not run'); } });
      return value;
    }],
    ['top-level symbol', () => { const value = commandInput({ commandId: 'unsafe-symbol' }); value[Symbol('x')] = true; return value; }],
    ['argv accessor', () => {
      const args = ['--version'];
      Object.defineProperty(args, '0', { enumerable: true, get() { throw new Error('must not run'); } });
      return commandInput({ commandId: 'unsafe-argv-accessor', args });
    }],
    ['argv extra property', () => { const args = ['--version']; args.extra = true; return commandInput({ commandId: 'unsafe-argv-extra', args }); }],
    ['argv symbol', () => { const args = ['--version']; args[Symbol('x')] = true; return commandInput({ commandId: 'unsafe-argv-symbol', args }); }],
    ['argv control character', () => commandInput({ commandId: 'unsafe-argv-control', args: ['--bad\nvalue'] })],
  ];
  for (const [label, makeInput] of cases) {
    const fixture = startFixture();
    await expectHoldAsync(() => fixture.manager().startCommand(makeInput()), label);
    assert.strictEqual(fixture.calls.allocateTemporaryRoot, 0, `${label} allocation`);
    assert.strictEqual(fixture.calls.spawnManaged, 0, `${label} spawn`);
  }
});

test('startCommand requires temporary lease capability before allocation', async () => {
  const fixture = startFixture({ envelopeMutator: (envelope) => {
    envelope.supportMatrix.claims.temporary_lease.state = 'UNVERIFIED';
    envelope.supportMatrix.overall_state = 'UNVERIFIED';
  } });
  await expectHoldAsync(
    () => fixture.manager().startCommand(commandInput({ commandId: 'temporary-lease-hold' })),
    'temporary lease capability',
  );
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 0);
  assert.strictEqual(fixture.calls.spawnManaged, 0);
});

test('startCommand converts adapter errors and resolver rejection to one-shot HOLD', async () => {
  const cases = [
    ['allocation throw', { allocation: () => { throw new Error('allocation failure'); } }, 1, 0],
    ['spawn throw', { spawn: () => { throw new Error('spawn failure'); } }, 1, 1],
    ['filesystem resolver', { rejectResolutionType: 'filesystem' }, 1, 0],
    ['observation resolver', { rejectResolutionType: 'observation' }, 1, 1],
  ];
  for (const [label, options, allocationCalls, spawnCalls] of cases) {
    const fixture = startFixture(options);
    const manager = fixture.manager();
    const input = commandInput({ commandId: `adapter-${label.replaceAll(' ', '-')}` });
    await expectHoldAsync(() => manager.startCommand(input), label);
    assert.strictEqual(fixture.calls.allocateTemporaryRoot, allocationCalls, `${label} allocation`);
    assert.strictEqual(fixture.calls.spawnManaged, spawnCalls, `${label} spawn`);
    await expectHoldAsync(() => manager.startCommand(input), `${label} duplicate`);
    assert.strictEqual(fixture.calls.allocateTemporaryRoot, allocationCalls, `${label} allocation retry`);
    assert.strictEqual(fixture.calls.spawnManaged, spawnCalls, `${label} spawn retry`);
  }
});

test('startCommand rejects mismatched allocation bindings, paths, and response shapes before spawn', async () => {
  const allocationCases = [
    ['request hash', (request) => ({ requestSha256: 'f'.repeat(64) })],
    ['allocation id', (request) => ({ identity: temporaryIdentityFor(request, { allocation_id: 'other-allocation' }) })],
    ['child id', (request) => ({ identity: temporaryIdentityFor(request, { child_id: 'other-child' }) })],
    ['creation nonce', (request) => ({ identity: temporaryIdentityFor(request, { creation_nonce: 'other-nonce' }) })],
    ['owner', (request) => ({ identity: temporaryIdentityFor(request, { owner_id: 'other-owner' }) })],
    ['run', (request) => ({ identity: temporaryIdentityFor(request, { run_id: 'other-run' }) })],
    ['session', (request) => ({ identity: temporaryIdentityFor(request, { session_id: 'other-session' }) })],
    ['lease generation', (request) => ({ identity: temporaryIdentityFor(request, { lease_generation: 2 }) })],
    ['platform', (request) => ({ identity: temporaryIdentityFor(request, { platform: 'linux' }) })],
    ['parent itself', (request) => ({ identity: temporaryIdentityFor(request, {
      task_directory: { path: request.temporaryRoot, windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' } },
    }) })],
    ['outside parent', (request) => ({ identity: temporaryIdentityFor(request, {
      task_directory: { path: path.join(path.parse(request.temporaryRoot).root, 'outside-task-directory'), windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' } },
    }) })],
    ['relative path', (request) => ({ identity: temporaryIdentityFor(request, {
      task_directory: { path: path.relative(process.cwd(), path.join(request.temporaryRoot, request.allocationId)), windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' } },
    }) })],
    ['unnormalized path', (request) => ({ identity: temporaryIdentityFor(request, {
      task_directory: { path: `${request.temporaryRoot}${path.sep}nested${path.sep}..${path.sep}${request.allocationId}`, windows_file_identity: { volume_serial_number: 'volume-A', file_id: 'task-A' } },
    }) })],
    ['extra response field', (request) => ({ extra: true })],
    ['response getter', (request) => {
      const response = { identity: temporaryIdentityFor(request), evidenceRefs: [EVIDENCE_REF] };
      Object.defineProperty(response, 'requestSha256', { enumerable: true, get() { throw new Error('must not run'); } });
      return response;
    }],
  ];
  for (const [label, mutate] of allocationCases) {
    const fixture = startFixture({ allocation: (request) => {
      const mutation = mutate(request);
      if (label === 'response getter') return mutation;
      return {
        identity: temporaryIdentityFor(request),
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
        ...mutation,
      };
    } });
    await expectHoldAsync(
      () => fixture.manager().startCommand(commandInput({ commandId: `allocation-${label.replaceAll(' ', '-')}` })),
      label,
    );
    assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1, `${label} allocation`);
    assert.strictEqual(fixture.calls.spawnManaged, 0, `${label} spawn`);
  }
});

test('startCommand rejects mismatched process bindings and response shapes', async () => {
  const spawnCases = [
    ['request hash', (request) => ({ requestSha256: 'f'.repeat(64) })],
    ['launch nonce', (request) => ({ identity: processIdentityFor(request, { launch_nonce: 'other-launch' }) })],
    ['owner', (request) => ({ identity: processIdentityFor(request, { owner_id: 'other-owner' }) })],
    ['run', (request) => ({ identity: processIdentityFor(request, { run_id: 'other-run' }) })],
    ['session', (request) => ({ identity: processIdentityFor(request, { session_id: 'other-session' }) })],
    ['lease generation', (request) => ({ identity: processIdentityFor(request, { lease_generation: 2 }) })],
    ['adapter generation', (request) => ({ identity: processIdentityFor(request, { adapter_generation: 2 }) })],
    ['manager generation', (request) => ({ identity: processIdentityFor(request, { manager_generation: 2 }) })],
    ['manager run', (request) => ({ identity: processIdentityFor(request, { manager_run_id: 'other-manager-run' }) })],
    ['platform', (request) => ({ identity: processIdentityFor(request, { platform: 'linux', windows_identity: undefined }) })],
    ['extra response field', () => ({ extra: true })],
    ['response getter', (request) => {
      const response = { identity: processIdentityFor(request), evidenceRefs: [EVIDENCE_REF] };
      Object.defineProperty(response, 'requestSha256', { enumerable: true, get() { throw new Error('must not run'); } });
      return response;
    }],
  ];
  for (const [label, mutate] of spawnCases) {
    const fixture = startFixture({ spawn: (request) => {
      const mutation = mutate(request);
      if (label === 'response getter') return mutation;
      return {
        identity: processIdentityFor(request),
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
        ...mutation,
      };
    } });
    await expectHoldAsync(
      () => fixture.manager().startCommand(commandInput({ commandId: `spawn-${label.replaceAll(' ', '-')}` })),
      label,
    );
    assert.strictEqual(fixture.calls.spawnManaged, 1, `${label} spawn`);
  }
});

test('startCommand holds after allocation when maxHistoryEvents=5 prevents temporary binding', async () => {
  const fixture = startFixture({ limits: { tracker: { maxScopes: 3, maxHistoryEvents: 5 } } });
  const manager = fixture.manager();
  const input = commandInput({ commandId: 'history-5' });
  await expectHoldAsync(() => manager.startCommand(input), 'history 5');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1);
  assert.strictEqual(fixture.calls.spawnManaged, 0);
  assert.deepStrictEqual(fixture.actions.map((entry) => entry.kind), ['allocate']);
  const allocation = fixture.actions[0].request;
  assert(Object.isFrozen(allocation));
  assert(Object.isFrozen(allocation.args));
  for (const field of ['requestSha256', 'launchNonce', 'allocationId', 'creationNonce']) {
    assert.match(allocation[field], /^[0-9a-f]{64}$/);
  }
  assert.strictEqual(allocation.requestSha256, recomputeRequestSha256(allocation));
  await expectHoldAsync(() => manager.startCommand(input), 'history 5 duplicate');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1);
  assert.strictEqual(fixture.calls.spawnManaged, 0);
});

test('startCommand never republishes after either process bind cannot record history', async () => {
  for (const maxHistoryEvents of [6, 7]) {
    const fixture = startFixture({ limits: { tracker: { maxScopes: 3, maxHistoryEvents } } });
    const manager = fixture.manager();
    const input = commandInput({ commandId: `history-${maxHistoryEvents}` });
    await expectHoldAsync(() => manager.startCommand(input), `history ${maxHistoryEvents}`);
    assert.strictEqual(fixture.calls.spawnManaged, 1, `history ${maxHistoryEvents} spawn`);
    await expectHoldAsync(() => manager.startCommand(input), `history ${maxHistoryEvents} duplicate`);
    assert.strictEqual(fixture.calls.spawnManaged, 1, `history ${maxHistoryEvents} no respawn`);
  }
});

test('startCommand does not allocate or spawn again for an already successful command id', async () => {
  const fixture = startFixture();
  const manager = fixture.manager();
  const input = commandInput({ commandId: 'successful-duplicate' });
  await manager.startCommand(input);
  await expectHoldAsync(() => manager.startCommand(input), 'successful duplicate');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 1);
  assert.strictEqual(fixture.calls.spawnManaged, 1);
});

test('observe obtains one fresh trusted process observation without exposing private command state or taking a system action', async () => {
  const subjects = [];
  const makeFixture = ({ observe, limits, producerBehavior } = {}) => {
    const trustedResolutionCalls = { observation: 0 };
    const fixture = startFixture({
      limits,
      trustedProducer: (candidate, context) => {
        if (context.resolutionType === 'observation') {
          trustedResolutionCalls.observation += 1;
          return producerBehavior ? producerBehavior(candidate, context) : true;
        }
        return true;
      },
    });
    const observationRequests = [];
    fixture.platformAdapter.observeProcess = (request) => {
      fixture.calls.observeProcess += 1;
      observationRequests.push(request);
      return observe ? observe(request) : {
        identity: processIdentityFor(request),
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    };
    const subject = { fixture, manager: fixture.manager(), observationRequests, trustedResolutionCalls };
    subjects.push(subject);
    return subject;
  };
  const captureStart = async (subject, input) => {
    const started = await subject.manager.startCommand(input);
    subject.started = started;
    subject.startOnlyCalls = { ...subject.fixture.calls };
    subject.startTrustedResolutionCalls = subject.trustedResolutionCalls.observation;
    return started;
  };
  const assertCallVector = (subject, observationCalls) => {
    assert.deepStrictEqual(subject.fixture.calls, {
      ...subject.startOnlyCalls,
      observeProcess: subject.startOnlyCalls.observeProcess + observationCalls,
    });
  };
  const valid = makeFixture();
  const started = await captureStart(valid, commandInput({ commandId: 'observe-valid' }));
  assert.strictEqual(
    typeof valid.manager.observe,
    'function',
    'RED: TaskResourceManager.observe() must obtain one newly trusted process observation',
  );
  for (const resourceId of [
    null,
    1,
    started.commandId,
    'command:observe-valid:session',
    'command:observe-valid:temporary',
    'command:unknown:process-tree',
  ]) {
    await expectHoldAsync(() => valid.manager.observe(resourceId), `preflight ${String(resourceId)}`);
  }
  assertCallVector(valid, 0);
  const observed = await valid.manager.observe(started.resourceId);
  assert.deepStrictEqual(observed, {
    status: 'OBSERVED',
    resourceId: started.resourceId,
    decision: {
      action: 'REQUEST_GRACEFUL',
      reasons: ['GRACEFUL_NOT_REQUESTED'],
      identity_confidence: 'MATCH',
      action_authorized: false,
    },
  });
  assert(Object.isFrozen(observed));
  assert(Object.isFrozen(observed.decision));
  assert(Object.isFrozen(observed.decision.reasons));
  assertCallVector(valid, 1);
  const request = valid.observationRequests[0];
  const spawnRequest = valid.fixture.actions.find((entry) => entry.kind === 'spawn').request;
  assert(Object.isFrozen(request));
  assert.deepStrictEqual(Object.keys(request).sort(), [
    'commandId', 'expectedGeneration', 'expectedIdentity', 'expectedScope', 'launchNonce',
    'provenance', 'requestSha256', 'resourceIds', 'spawnRequestSha256', 'type',
  ].sort());
  assert.strictEqual(request.type, 'TaskResourceProcessObservationRequest1');
  assert.strictEqual(request.commandId, 'observe-valid');
  assert.deepStrictEqual(request.resourceIds, {
    temporaryAllocation: 'command:observe-valid:temporary',
    commandSession: 'command:observe-valid:session',
    processTree: started.resourceId,
  });
  assert.strictEqual(request.spawnRequestSha256, spawnRequest.requestSha256);
  assert.strictEqual(request.launchNonce, spawnRequest.launchNonce);
  assert.deepStrictEqual(request.expectedIdentity, processIdentityFor(spawnRequest));
  assert.strictEqual(request.expectedGeneration, 1);
  assert.deepStrictEqual(request.expectedScope, { kind: 'scope', value: 'command:observe-valid' });
  assert.deepStrictEqual(request.provenance, {
    ownerId: 'owner-A', runId: 'run-3-1', sessionId: 'session-A', managerRunId: 'manager-run-A',
    managerGeneration: 1, adapterGeneration: 1, platform: 'windows',
  });
  assert(Object.isFrozen(request.resourceIds));
  assert(Object.isFrozen(request.expectedIdentity));
  assert(Object.isFrozen(request.expectedIdentity.windows_identity));
  assert(Object.isFrozen(request.expectedScope));
  assert(Object.isFrozen(request.provenance));
  assert.strictEqual(request.requestSha256, recomputeRequestSha256(request));
  assert(!/node\.exe|--version|authority:|adapterId|tracker|trusted/i.test(JSON.stringify(request)));
  assert.strictEqual(JSON.stringify(observed), JSON.stringify(createDetachedJsonSnapshot(observed).snapshot));
  assert(!/node\.exe|--version|authority:|adapter|tracker|trusted/i.test(JSON.stringify(observed)));

  const drift = makeFixture({ observe: (request) => ({
    identity: processIdentityFor(request, { pid: 41003 }),
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: request.requestSha256,
  }) });
  const driftStart = await captureStart(drift, commandInput({ commandId: 'observe-drift' }));
  assert.deepStrictEqual(await drift.manager.observe(driftStart.resourceId), {
    status: 'HOLD',
    resourceId: driftStart.resourceId,
    decision: {
      action: 'HOLD',
      reasons: ['IDENTITY_MISMATCH'],
      identity_confidence: 'MISMATCH',
      action_authorized: false,
    },
  });
  assertCallVector(drift, 1);

  for (const [label, observe] of [
    ['duplicate evidence', (request) => ({ identity: processIdentityFor(request), evidenceRefs: [EVIDENCE_REF, EVIDENCE_REF], requestSha256: request.requestSha256 })],
  ]) {
    const rejected = makeFixture({ observe });
    const rejectedStart = await captureStart(rejected, commandInput({ commandId: `observe-${label.replaceAll(' ', '-')}` }));
    await expectHoldAsync(() => rejected.manager.observe(rejectedStart.resourceId), label);
    assertCallVector(rejected, 1);
    await expectHoldAsync(() => rejected.manager.observe(rejectedStart.resourceId), `${label} held record`);
    assertCallVector(rejected, 1);
  }

  let rejectedHash = null;
  const trustReject = makeFixture({
    producerBehavior: (candidate) => candidate.requestSha256 !== rejectedHash,
    observe: (request) => {
      rejectedHash = request.requestSha256;
      return { identity: processIdentityFor(request), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 };
    },
  });
  const trustStart = await captureStart(trustReject, commandInput({ commandId: 'observe-trust' }));
  await expectHoldAsync(() => trustReject.manager.observe(trustStart.resourceId), 'trusted producer rejection');
  assertCallVector(trustReject, 1);

  let releaseObservation;
  let pendingRequest = null;
  const concurrent = makeFixture({ observe: (request) => {
    pendingRequest = request;
    return new Promise((resolve) => { releaseObservation = resolve; });
  } });
  const concurrentStart = await captureStart(concurrent, commandInput({ commandId: 'observe-concurrent' }));
  const first = concurrent.manager.observe(concurrentStart.resourceId);
  await Promise.resolve();
  assertCallVector(concurrent, 1);
  await expectHoldAsync(() => concurrent.manager.observe(concurrentStart.resourceId), 'concurrent second');
  await expectHoldAsync(() => concurrent.manager.observe(concurrentStart.resourceId), 'concurrent third');
  assertCallVector(concurrent, 1);
  releaseObservation({ identity: processIdentityFor(pendingRequest), evidenceRefs: [EVIDENCE_REF], requestSha256: pendingRequest.requestSha256 });
  assert.strictEqual((await first).status, 'OBSERVED');

  const provenanceDrift = makeFixture({ observe: (request) => ({
    identity: processIdentityFor(request, { owner_id: 'other-owner' }),
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: request.requestSha256,
  }) });
  const provenanceStart = await captureStart(
    provenanceDrift,
    commandInput({ commandId: 'observe-provenance-drift' }),
  );
  let provenanceDriftResult;
  try {
    provenanceDriftResult = { kind: 'result', value: await provenanceDrift.manager.observe(provenanceStart.resourceId) };
  } catch (error) {
    provenanceDriftResult = { kind: 'error', code: error.code };
  }
  assertCallVector(provenanceDrift, 1);

  const wrongHash = makeFixture({ observe: (request) => ({
    identity: processIdentityFor(request),
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: 'f'.repeat(64),
  }) });
  const wrongHashStart = await captureStart(wrongHash, commandInput({ commandId: 'observe-wrong-hash' }));
  await expectHoldAsync(() => wrongHash.manager.observe(wrongHashStart.resourceId), 'wrong request hash');
  assertCallVector(wrongHash, 1);
  const wrongHashResult = {
    outcome: 'HOLD',
    observeCalls: wrongHash.fixture.calls.observeProcess - wrongHash.startOnlyCalls.observeProcess,
    trustedResolutionCalls: wrongHash.trustedResolutionCalls.observation - wrongHash.startTrustedResolutionCalls,
  };

  const maxInputBytes = 8192;
  const oversizedEvidenceRefs = Array.from(
    { length: 128 },
    (_, index) => `evidence:${index.toString(16).padStart(64, '0')}`,
  );
  let oversizedResponse = null;
  const oversized = makeFixture({
    limits: { tracker: { maxScopes: 3, maxInputBytes } },
    observe: (request) => ({ ...oversizedResponse, requestSha256: request.requestSha256 }),
  });
  const oversizedStart = await captureStart(oversized, commandInput({ commandId: 'observe-oversized' }));
  const oversizedSpawnRequest = oversized.fixture.actions.find((entry) => entry.kind === 'spawn').request;
  oversizedResponse = {
    identity: processIdentityFor(oversizedSpawnRequest),
    evidenceRefs: oversizedEvidenceRefs,
    requestSha256: 'f'.repeat(64),
  };
  const oversizedSnapshot = createDetachedJsonSnapshot(oversizedResponse).snapshot;
  assert(Buffer.byteLength(canonicalizeDetachedSnapshot(oversizedSnapshot), 'utf8') > maxInputBytes);
  await expectHoldAsync(() => oversized.manager.observe(oversizedStart.resourceId), 'oversized observation response');
  assertCallVector(oversized, 1);
  const oversizedResult = {
    outcome: 'HOLD',
    observeCalls: oversized.fixture.calls.observeProcess - oversized.startOnlyCalls.observeProcess,
    trustedResolutionCalls: oversized.trustedResolutionCalls.observation - oversized.startTrustedResolutionCalls,
  };

  for (const subject of subjects) assertCallVector(subject, 1);
  assert.deepStrictEqual(
    { provenanceDriftResult, wrongHashResult, oversizedResult },
    {
      provenanceDriftResult: {
        kind: 'result',
        value: {
          status: 'HOLD',
          resourceId: provenanceStart.resourceId,
          decision: {
            action: 'HOLD',
            reasons: ['IDENTITY_MISMATCH'],
            identity_confidence: 'MISMATCH',
            action_authorized: false,
          },
        },
      },
      wrongHashResult: { outcome: 'HOLD', observeCalls: 1, trustedResolutionCalls: 0 },
      oversizedResult: { outcome: 'HOLD', observeCalls: 1, trustedResolutionCalls: 0 },
    },
  );

});

test('stop uses one caller-driven, trusted lifecycle without exposing private state or touching real resources', async () => {
  assert.strictEqual(
    typeof TaskResourceManager?.prototype?.stop,
    'function',
    'RED: TaskResourceManager.stop() must request a bounded trusted command stop',
  );

  const targetHash = (request) => computeDetachedSha256(request.expectedIdentity);
  const capability = () => ({ state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] });
  const exactCommandId = (length) => `a${'b'.repeat(length - 1)}`;
  const stopCounterNames = Object.freeze([
    'requestGracefulStop', 'observeProcess', 'terminateOwnedTree', 'verifyProcessAbsent',
  ]);
  const temporaryCounterNames = Object.freeze([
    'allocateTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot',
    'verifyTemporaryAbsent',
  ]);
  const stopSubjects = [];
  let commandSequence = 0;
  const makeSubject = ({
    allowForceTermination = false,
    resourceObservation = 'VERIFIED_FULL',
    requestShutdown = 'VERIFIED_FULL',
    processTreeTerminate = 'VERIFIED_FULL',
    graceful, observe, terminate, absence, trustedProducer,
    commandId, timeoutMs = 60000, limits,
  } = {}) => {
    const requests = { graceful: [], observe: [], terminate: [], absence: [] };
    const trustedResolutionCalls = { observation: 0, filesystem: 0 };
    let trustedResolutionValidationFailures = 0;
    const expectedAuthorizationSha256 = computeDetachedSha256(
      createDetachedJsonSnapshot(authorization(allowForceTermination)).snapshot,
    );
    const expectedResolverProvenance = {
      type: 'TaskResourceProvenance1',
      runId: 'run-3-1',
      harnessId: 'harness-A',
      producerId: 'producer-A',
      ownerId: 'owner-A',
      sessionId: 'session-A',
      managerRunId: 'manager-run-A',
      managerGeneration: 1,
      adapterId: 'adapter-A',
      adapterGeneration: 1,
      platform: 'windows',
      observedAt: '2026-09-04T01:02:03Z',
      authorizationSha256: expectedAuthorizationSha256,
    };
    const countingTrustedProducer = (candidate, context) => {
      const resolutionType = context?.resolutionType;
      if (resolutionType === 'observation' || resolutionType === 'filesystem') {
        trustedResolutionCalls[resolutionType] += 1;
        const validResolution = Object.isFrozen(candidate)
          && Object.isFrozen(context)
          && context.runId === 'run-3-1'
          && context.harnessId === 'harness-A'
          && context.adapterId === 'adapter-A'
          && context.authorizationSha256 === expectedAuthorizationSha256
          && Array.isArray(context.requiredReferences)
          && context.requiredReferences.length === REQUIRED_REFERENCES.length
          && context.requiredReferences.every((reference) => REQUIRED_REFERENCES.includes(reference))
          && computeDetachedSha256(context.provenance)
            === computeDetachedSha256(expectedResolverProvenance)
          && JSON.stringify(sortedKeys(context)) === JSON.stringify([
            'adapterId', 'authorizationSha256', 'harnessId', 'provenance',
            'requiredReferences', 'resolutionType', 'runId',
          ]);
        if (!validResolution) {
          trustedResolutionValidationFailures += 1;
          return false;
        }
      } else {
        const validEnvelope = Object.isFrozen(candidate)
          && Object.isFrozen(context)
          && context?.runId === 'run-3-1'
          && context?.harnessId === 'harness-A'
          && context?.adapterId === 'adapter-A'
          && context?.authorizationSha256 === expectedAuthorizationSha256
          && Array.isArray(context?.requiredReferences)
          && context.requiredReferences.length === REQUIRED_REFERENCES.length
          && context.requiredReferences.every((reference) => REQUIRED_REFERENCES.includes(reference));
        if (!validEnvelope) return false;
      }
      return trustedProducer ? trustedProducer(candidate, context) === true : true;
    };
    const fixture = startFixture({
      envelopeMutator: (envelope) => {
        const setClaim = (name, state) => {
          if (state === null) {
            delete envelope.supportMatrix.claims[name];
          } else {
            envelope.supportMatrix.claims[name] = {
              state,
              evidence_refs: [EVIDENCE_REF],
            };
          }
        };
        setClaim('resource_observation', resourceObservation);
        setClaim('request_shutdown', requestShutdown);
        setClaim('process_tree_terminate', processTreeTerminate);
        const states = Object.values(envelope.supportMatrix.claims).map((claim) => claim.state);
        envelope.supportMatrix.overall_state = states.includes('VERIFIED_DEGRADED')
          ? 'VERIFIED_DEGRADED'
          : 'VERIFIED_FULL';
      },
      trustedProducer: countingTrustedProducer,
      allowForceTermination,
      limits,
    });
    const fakePaths = new Set(['fixture://unchanged']);
    for (const name of temporaryCounterNames) {
      const original = fixture.platformAdapter[name];
      fixture.platformAdapter[name] = (...args) => {
        fakePaths.add(`unexpected://${name}`);
        return original(...args);
      };
    }
    fixture.platformAdapter.requestGracefulStop = (request) => {
      fixture.calls.requestGracefulStop += 1;
      requests.graceful.push(request);
      return graceful ? graceful(request) : {
        disposition: 'COMPLETED',
        targetIdentitySha256: targetHash(request),
        identityRevalidated: true,
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    };
    fixture.platformAdapter.observeProcess = (request) => {
      fixture.calls.observeProcess += 1;
      requests.observe.push(request);
      return observe ? observe(request) : {
        identity: processIdentityFor(request),
        graceful: { requested: true, deadlineReached: false, exitObserved: false },
        exactTreeTerminationSupported: false,
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    };
    fixture.platformAdapter.terminateOwnedTree = (request) => {
      fixture.calls.terminateOwnedTree += 1;
      requests.terminate.push(request);
      return terminate ? terminate(request) : {
        disposition: 'COMPLETED',
        targetIdentitySha256: targetHash(request),
        identityRevalidated: true,
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    };
    fixture.platformAdapter.verifyProcessAbsent = (request) => {
      fixture.calls.verifyProcessAbsent += 1;
      requests.absence.push(request);
      return absence ? absence(request) : {
        disposition: 'ABSENT_CONFIRMED',
        targetIdentitySha256: targetHash(request),
        absence: { processAbsent: true, threadAbsent: true, portAbsent: true },
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    };
    const manager = fixture.manager();
    const command = commandInput({
      commandId: commandId || `stop-${++commandSequence}`,
      timeoutMs,
      temporaryRoot: null,
    });
    const subject = {
      fixture, manager, requests, command, trustedResolutionCalls, fakePaths,
      expectedAuthorizationSha256, expectedResolverProvenance,
      trustedResolutionValidationFailures: () => trustedResolutionValidationFailures,
    };
    stopSubjects.push(subject);
    return subject;
  };
  const started = async (subject) => {
    subject.started = await subject.manager.startCommand(subject.command);
    subject.startCalls = { ...subject.fixture.calls };
    subject.startTrustedResolutionCalls = { ...subject.trustedResolutionCalls };
    subject.startTrustedResolutionValidationFailures = subject.trustedResolutionValidationFailures();
    subject.startFakePathState = JSON.stringify([...subject.fakePaths].sort());
    return subject.started;
  };
  const assertResult = (result, status, resourceId, action, reasons) => {
    assert.deepStrictEqual(result, {
      status,
      resourceId,
      decision: { action, reasons, action_authorized: false },
    });
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.decision));
    assert(Object.isFrozen(result.decision.reasons));
    assert(!/node\.exe|authority:|timeout_elapsed|adapter|tracker|trusted/i.test(JSON.stringify(result)));
  };
  const isDeepFrozen = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return true;
    if (!Object.isFrozen(value)) return false;
    seen.add(value);
    return Reflect.ownKeys(value).every((key) => isDeepFrozen(value[key], seen));
  };
  const sortedKeys = (value) => Object.keys(value).sort();
  const summarizeResult = (result, resourceId) => ({
    kind: 'result',
    status: result.status,
    resourceMatches: result.resourceId === resourceId,
    decision: {
      ...result.decision,
      reasons: [...result.decision.reasons],
    },
  });
  const captureStopOutcome = async (action, resourceId) => {
    try {
      const value = await action();
      return { value, summary: summarizeResult(value, resourceId) };
    } catch (error) {
      if (!(error instanceof TaskResourceManagerError)
        || error.code !== 'TASK_RESOURCE_MANAGER_HOLD') throw error;
      return {
        value: null,
        summary: { kind: 'error', code: error.code },
      };
    }
  };
  const counterDeltas = (subject, names) => Object.fromEntries(names.map((name) => [
    name,
    subject.fixture.calls[name] - subject.startCalls[name],
  ]));
  const workSummary = (subject) => ({
    trustedResolver: subject.trustedResolutionCalls.observation
      - subject.startTrustedResolutionCalls.observation,
    filesystemResolver: subject.trustedResolutionCalls.filesystem
      - subject.startTrustedResolutionCalls.filesystem,
    trustedValidationFailures: subject.trustedResolutionValidationFailures()
      - subject.startTrustedResolutionValidationFailures,
    lifecycleCalls: counterDeltas(subject, ['probeCapabilities', 'spawnManaged']),
    stopCalls: counterDeltas(subject, stopCounterNames),
    temporaryCalls: counterDeltas(subject, temporaryCounterNames),
    fakePaths: {
      before: subject.startFakePathState,
      after: JSON.stringify([...subject.fakePaths].sort()),
    },
  });
  const workMarker = (subject) => JSON.stringify(workSummary(subject));
  const publicResultAudit = (result, subject) => {
    const requestHashes = Object.values(subject.requests)
      .flat()
      .map((request) => request.requestSha256);
    const privateStringSentinels = [
      'node.exe', '--version', subject.command.cwd,
      '2026-09-04T01:00:00Z', SHA256, 'd'.repeat(64), 'e'.repeat(64),
      'user_requested', 'task_completed', 'timeout_elapsed', AUTHORITY_REF, EVIDENCE_REF,
      subject.expectedAuthorizationSha256, 'owner-A', 'session-A', 'manager-run-A',
      'adapter-A', 'producer-A', 'harness-A', ...requestHashes,
    ];
    const publicStrings = [];
    const publicNumbers = [];
    const collectPublicValues = (value, seen = new Set()) => {
      if (typeof value === 'string') publicStrings.push(value);
      if (typeof value === 'number') publicNumbers.push(value);
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const key of Reflect.ownKeys(value)) collectPublicValues(value[key], seen);
    };
    collectPublicValues(result);
    return {
      topLevelKeys: sortedKeys(result),
      decisionKeys: sortedKeys(result.decision),
      noHiddenTopLevelKeys: Reflect.ownKeys(result).length === Object.keys(result).length,
      noHiddenDecisionKeys: Reflect.ownKeys(result.decision).length
        === Object.keys(result.decision).length,
      deepFrozen: isDeepFrozen(result),
      privateSentinelsAbsent: privateStringSentinels.every((sentinel) => (
        publicStrings.every((value) => !value.includes(sentinel))
      )) && !publicNumbers.includes(41002),
    };
  };
  const requestKeySets = Object.freeze({
    graceful: [
      'actionTimeoutMs', 'commandId', 'expectedGeneration', 'expectedIdentity',
      'expectedScope', 'launchNonce', 'provenance', 'reasonCode', 'requestSha256',
      'resourceIds', 'spawnRequestSha256', 'type',
    ],
    observe: [
      'actionTimeoutMs', 'boundedWaitMs', 'commandId', 'expectedGeneration',
      'expectedIdentity', 'expectedScope', 'gracefulRequestSha256', 'launchNonce',
      'provenance', 'requestSha256', 'resourceIds', 'spawnRequestSha256', 'type',
    ],
    terminate: [
      'actionTimeoutMs', 'commandId', 'confirmedIdentity', 'expectedGeneration',
      'expectedIdentity', 'expectedScope', 'forceAuthorization',
      'gracefulRequestSha256', 'launchNonce', 'observationRequestSha256',
      'provenance', 'reasonCode', 'requestSha256', 'resourceIds',
      'spawnRequestSha256', 'type',
    ],
    absence: [
      'actionTimeoutMs', 'commandId', 'expectedGeneration', 'expectedIdentity',
      'expectedIdentitySha256', 'expectedScope', 'gracefulRequestSha256',
      'launchNonce', 'provenance', 'requestSha256', 'resourceIds',
      'spawnRequestSha256', 'terminalAction', 'terminalActionRequestSha256', 'type',
    ],
  });
  const requestTypeByKind = Object.freeze({
    graceful: 'TaskResourceGracefulStopRequest1',
    observe: 'TaskResourceStopObservationRequest1',
    terminate: 'TaskResourceTerminateOwnedTreeRequest1',
    absence: 'TaskResourceProcessAbsenceVerificationRequest1',
  });
  const requestAudit = (
    kind, request, subject, expectedReason, expectedTerminalAction = null,
  ) => {
    const spawnRequest = subject.fixture.actions.find((entry) => entry.kind === 'spawn').request;
    const expectedResourceIds = {
      temporaryAllocation: null,
      commandSession: `command:${subject.command.commandId}:session`,
      processTree: `command:${subject.command.commandId}:process-tree`,
    };
    const expectedScope = { kind: 'scope', value: `command:${subject.command.commandId}` };
    const expectedRequestProvenance = {
      ownerId: 'owner-A',
      runId: 'run-3-1',
      sessionId: 'session-A',
      managerRunId: 'manager-run-A',
      managerGeneration: 1,
      adapterGeneration: 1,
      platform: 'windows',
    };
    const expectedIdentity = processIdentityFor(spawnRequest);
    const gracefulRequest = subject.requests.graceful[0];
    const observationRequest = subject.requests.observe[0];
    const terminationRequest = subject.requests.terminate[0];
    const commonCorrelation = request.type === requestTypeByKind[kind]
      && request.commandId === subject.command.commandId
      && JSON.stringify(request.resourceIds) === JSON.stringify(expectedResourceIds)
      && request.spawnRequestSha256 === spawnRequest.requestSha256
      && request.launchNonce === spawnRequest.launchNonce
      && request.expectedGeneration === 1
      && JSON.stringify(request.expectedScope) === JSON.stringify(expectedScope)
      && computeDetachedSha256(request.expectedIdentity) === computeDetachedSha256(expectedIdentity)
      && request.actionTimeoutMs === 30000;
    let chainedCorrelation = true;
    if (kind !== 'graceful') {
      chainedCorrelation = request.gracefulRequestSha256 === gracefulRequest?.requestSha256;
    }
    if (kind === 'observe') chainedCorrelation = chainedCorrelation && request.boundedWaitMs === 30000;
    if (kind === 'terminate') {
      chainedCorrelation = chainedCorrelation
        && request.observationRequestSha256 === observationRequest?.requestSha256
        && computeDetachedSha256(request.confirmedIdentity)
          === computeDetachedSha256(observationRequest && processIdentityFor(observationRequest))
        && request.forceAuthorization?.allowedAtOpen === true
        && request.forceAuthorization?.authorizationSha256 === subject.expectedAuthorizationSha256
        && JSON.stringify(sortedKeys(request.forceAuthorization))
          === JSON.stringify(['allowedAtOpen', 'authorizationSha256'])
        && request.reasonCode === expectedReason;
    }
    if (kind === 'absence') {
      const terminalRequest = expectedTerminalAction === 'force_termination'
        ? terminationRequest
        : observationRequest;
      chainedCorrelation = chainedCorrelation
        && request.terminalAction === expectedTerminalAction
        && request.terminalActionRequestSha256 === terminalRequest?.requestSha256
        && request.expectedIdentitySha256 === computeDetachedSha256(request.expectedIdentity);
    }
    if (kind === 'graceful') chainedCorrelation = request.reasonCode === expectedReason;
    return {
      exactKeys: JSON.stringify(sortedKeys(request))
        === JSON.stringify(requestKeySets[kind]),
      exactResourceKeys: JSON.stringify(sortedKeys(request.resourceIds))
        === JSON.stringify(['commandSession', 'processTree', 'temporaryAllocation']),
      exactProvenanceKeys: JSON.stringify(sortedKeys(request.provenance)) === JSON.stringify([
        'adapterGeneration', 'managerGeneration', 'managerRunId', 'ownerId',
        'platform', 'runId', 'sessionId',
      ]),
      exactProvenanceValues: computeDetachedSha256(request.provenance)
        === computeDetachedSha256(expectedRequestProvenance),
      exactScopeKeys: JSON.stringify(sortedKeys(request.expectedScope))
        === JSON.stringify(['kind', 'value']),
      exactExpectedIdentityKeys: JSON.stringify(sortedKeys(request.expectedIdentity))
        === JSON.stringify([
          'adapter_generation', 'argv_sha256', 'executable_path_sha256', 'launch_nonce',
          'lease_generation', 'manager_generation', 'manager_run_id',
          'owner_id', 'parent_identity_sha256', 'pid', 'platform', 'run_id',
          'schema', 'schema_version', 'session_id', 'start_time', 'windows_identity',
        ]),
      exactWindowsIdentityKeys: JSON.stringify(sortedKeys(request.expectedIdentity.windows_identity))
        === JSON.stringify(['process_creation_time_filetime', 'process_handle']),
      exactConfirmedIdentityKeys: kind !== 'terminate'
        || JSON.stringify(sortedKeys(request.confirmedIdentity))
          === JSON.stringify(sortedKeys(request.expectedIdentity)),
      requestHashMatches: request.requestSha256 === recomputeRequestSha256(request),
      deepFrozen: isDeepFrozen(request),
      correlationMatches: commonCorrelation && chainedCorrelation,
      clearAuthorityAbsent: !JSON.stringify(request).includes(AUTHORITY_REF),
    };
  };

  const normal = makeSubject({
    observe: (request) => ({
      identity: processIdentityFor(request),
      graceful: { requested: true, deadlineReached: false, exitObserved: false },
      exactTreeTerminationSupported: false,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
  });
  const normalStarted = await started(normal);
  for (const bad of [null, 1, normalStarted.commandId, 'command:other:process-tree']) {
    await expectHoldAsync(() => normal.manager.stop(bad, { reason: 'user_requested' }), `bad resource ${String(bad)}`);
  }
  for (const badOptions of [null, {}, { reason: 'arbitrary text' }, { reason: 'user_requested', extra: true }]) {
    await expectHoldAsync(() => normal.manager.stop(normalStarted.resourceId, badOptions), 'bad stop options');
  }
  assert.deepStrictEqual(normal.fixture.calls, normal.startCalls);
  const requested = await normal.manager.stop(normalStarted.resourceId, { reason: 'user_requested' });
  assertResult(requested, 'STOP_REQUESTED', normalStarted.resourceId, 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED']);
  assert.strictEqual(normal.fixture.calls.requestGracefulStop, normal.startCalls.requestGracefulStop + 1);
  assert.strictEqual(normal.fixture.calls.observeProcess, normal.startCalls.observeProcess);
  assert.strictEqual(normal.fixture.calls.terminateOwnedTree, normal.startCalls.terminateOwnedTree);
  assert.strictEqual(normal.fixture.calls.verifyProcessAbsent, normal.startCalls.verifyProcessAbsent);
  const gracefulRequest = normal.requests.graceful[0];
  assert(Object.isFrozen(gracefulRequest));
  assert.strictEqual(gracefulRequest.type, 'TaskResourceGracefulStopRequest1');
  assert.strictEqual(gracefulRequest.actionTimeoutMs, 30000);
  assert.strictEqual(gracefulRequest.reasonCode, 'user_requested');
  assert.strictEqual(gracefulRequest.requestSha256, recomputeRequestSha256(gracefulRequest));
  assert(!/node\.exe|--version|authority:/.test(JSON.stringify(gracefulRequest)));
  const beforeReasonDrift = workMarker(normal);
  const reasonDriftOutcome = await captureStopOutcome(
    () => normal.manager.stop(normalStarted.resourceId, { reason: 'task_failed' }),
    normalStarted.resourceId,
  );
  const reasonDriftDidNoWork = beforeReasonDrift === workMarker(normal);
  assert.strictEqual(normal.fixture.calls.requestGracefulStop, normal.startCalls.requestGracefulStop + 1);
  const waiting = await normal.manager.stop(normalStarted.resourceId, { reason: 'user_requested' });
  assertResult(waiting, 'WAITING', normalStarted.resourceId, 'WAIT_BOUNDED', ['GRACEFUL_WINDOW_OPEN']);
  assert.strictEqual(normal.fixture.calls.observeProcess, normal.startCalls.observeProcess + 1);
  assert.strictEqual(normal.requests.observe[0].actionTimeoutMs, 30000);
  assert.strictEqual(normal.requests.observe[0].boundedWaitMs, 30000);
  assert.strictEqual(normal.requests.observe[0].requestSha256, recomputeRequestSha256(normal.requests.observe[0]));
  assert(!/node\.exe|authority:/.test(JSON.stringify(normal.requests.observe[0])));

  const normalExit = makeSubject({
    observe: (request) => ({
      identity: processIdentityFor(request),
      graceful: { requested: true, deadlineReached: false, exitObserved: true },
      exactTreeTerminationSupported: false,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
  });
  const normalExitStarted = await started(normalExit);
  await normalExit.manager.stop(normalExitStarted.resourceId, { reason: 'task_completed' });
  const stopped = await normalExit.manager.stop(normalExitStarted.resourceId, { reason: 'task_completed' });
  assert.strictEqual(stopped.status, 'STOPPED');
  assert.strictEqual(stopped.decision.action, 'OBSERVE_ONLY');
  assert.deepStrictEqual(stopped.decision.reasons, ['ABSENCE_VERIFIED']);
  assert.strictEqual(stopped.decision.downstream_release_allowed, true);
  assert.strictEqual(normalExit.fixture.calls.requestGracefulStop, normalExit.startCalls.requestGracefulStop + 1);
  assert.strictEqual(normalExit.fixture.calls.observeProcess, normalExit.startCalls.observeProcess + 1);
  assert.strictEqual(normalExit.fixture.calls.verifyProcessAbsent, normalExit.startCalls.verifyProcessAbsent + 1);
  const stoppedAgain = await normalExit.manager.stop(normalExitStarted.resourceId, { reason: 'task_completed' });
  assert.strictEqual(stoppedAgain, stopped);
  assert.strictEqual(normalExit.fixture.calls.verifyProcessAbsent, normalExit.startCalls.verifyProcessAbsent + 1);

  let pendingAbsence = true;
  const absencePending = makeSubject({
    observe: (request) => ({
      identity: processIdentityFor(request),
      graceful: { requested: true, deadlineReached: false, exitObserved: true },
      exactTreeTerminationSupported: false,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
    absence: (request) => ({
      disposition: pendingAbsence ? 'COMPLETED' : 'ABSENT_CONFIRMED',
      targetIdentitySha256: targetHash(request),
      absence: { processAbsent: true, threadAbsent: true, portAbsent: true },
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
  });
  const absencePendingStarted = await started(absencePending);
  await absencePending.manager.stop(absencePendingStarted.resourceId, { reason: 'task_completed' });
  assert.strictEqual((await absencePending.manager.stop(absencePendingStarted.resourceId, { reason: 'task_completed' })).status, 'WAITING');
  pendingAbsence = false;
  assert.strictEqual((await absencePending.manager.stop(absencePendingStarted.resourceId, { reason: 'task_completed' })).status, 'STOPPED');
  assert.strictEqual(absencePending.fixture.calls.observeProcess, absencePending.startCalls.observeProcess + 1);
  assert.strictEqual(absencePending.fixture.calls.verifyProcessAbsent, absencePending.startCalls.verifyProcessAbsent + 2);

  const noForce = makeSubject({
    observe: (request) => ({
      identity: processIdentityFor(request),
      graceful: { requested: true, deadlineReached: true, exitObserved: false },
      exactTreeTerminationSupported: true,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
  });
  const noForceStarted = await started(noForce);
  await noForce.manager.stop(noForceStarted.resourceId, { reason: 'timeout_elapsed' });
  const noForceResult = await noForce.manager.stop(noForceStarted.resourceId, { reason: 'timeout_elapsed' });
  assert.strictEqual(noForceResult.status, 'HOLD');
  assert.deepStrictEqual(noForceResult.decision.reasons, ['FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN']);
  assert.strictEqual(noForce.fixture.calls.terminateOwnedTree, noForce.startCalls.terminateOwnedTree);
  assert.strictEqual(noForce.fixture.calls.verifyProcessAbsent, noForce.startCalls.verifyProcessAbsent);
  const noForceWorkBeforeRepeat = workMarker(noForce);
  const noForceAgain = await noForce.manager.stop(noForceStarted.resourceId, { reason: 'timeout_elapsed' });
  const noForceRepeatDidNoWork = noForceWorkBeforeRepeat === workMarker(noForce);

  const force = makeSubject({
    allowForceTermination: true,
    observe: (request) => ({
      identity: processIdentityFor(request),
      graceful: { requested: true, deadlineReached: true, exitObserved: false },
      exactTreeTerminationSupported: true,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }),
  });
  const forceStarted = await started(force);
  await force.manager.stop(forceStarted.resourceId, { reason: 'timeout_elapsed' });
  const forced = await force.manager.stop(forceStarted.resourceId, { reason: 'timeout_elapsed' });
  assert.strictEqual(forced.status, 'STOPPED');
  assert.strictEqual(force.fixture.calls.terminateOwnedTree, force.startCalls.terminateOwnedTree + 1);
  assert.strictEqual(force.fixture.calls.verifyProcessAbsent, force.startCalls.verifyProcessAbsent + 1);
  assert.strictEqual(force.requests.terminate[0].actionTimeoutMs, 30000);
  assert.strictEqual(force.requests.terminate[0].forceAuthorization.allowedAtOpen, true);
  assert(!/authority:/.test(JSON.stringify(force.requests.terminate[0])));
  const forceWorkBeforeRepeat = workMarker(force);
  const forcedAgain = await force.manager.stop(forceStarted.resourceId, { reason: 'timeout_elapsed' });
  const forceRepeatDidNoWork = forceWorkBeforeRepeat === workMarker(force);

  const badReceipt = makeSubject({
    graceful: (request) => ({
      disposition: 'COMPLETED', targetIdentitySha256: targetHash(request), identityRevalidated: false,
      evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
    }),
  });
  const badReceiptStarted = await started(badReceipt);
  await expectHoldAsync(() => badReceipt.manager.stop(badReceiptStarted.resourceId, { reason: 'user_requested' }), 'unrevalidated graceful receipt');
  assert.strictEqual(badReceipt.fixture.calls.observeProcess, badReceipt.startCalls.observeProcess);
  await expectHoldAsync(() => badReceipt.manager.stop(badReceiptStarted.resourceId, { reason: 'user_requested' }), 'held receipt');
  assert.strictEqual(badReceipt.fixture.calls.requestGracefulStop, badReceipt.startCalls.requestGracefulStop + 1);

  let releaseGraceful;
  const concurrent = makeSubject({
    graceful: (request) => new Promise((resolve) => { releaseGraceful = () => resolve({
      disposition: 'COMPLETED', targetIdentitySha256: targetHash(request), identityRevalidated: true,
      evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
    }); }),
  });
  const concurrentStarted = await started(concurrent);
  const first = concurrent.manager.stop(concurrentStarted.resourceId, { reason: 'user_requested' });
  await Promise.resolve();
  const concurrentSecond = await captureStopOutcome(
    () => concurrent.manager.stop(concurrentStarted.resourceId, { reason: 'user_requested' }),
    concurrentStarted.resourceId,
  );
  const concurrentWorkAfterSecond = workMarker(concurrent);
  const concurrentThird = await captureStopOutcome(
    () => concurrent.manager.stop(concurrentStarted.resourceId, { reason: 'user_requested' }),
    concurrentStarted.resourceId,
  );
  const concurrentGuardPreserved = concurrentWorkAfterSecond === workMarker(concurrent);
  releaseGraceful();
  const concurrentFirstResult = await first;
  const concurrentContinuation = await captureStopOutcome(
    () => concurrent.manager.stop(concurrentStarted.resourceId, { reason: 'user_requested' }),
    concurrentStarted.resourceId,
  );
  assert.strictEqual(concurrentFirstResult.status, 'STOP_REQUESTED');
  assert.strictEqual(concurrent.fixture.calls.requestGracefulStop, concurrent.startCalls.requestGracefulStop + 1);

  const captureHoldOutcome = async (action) => {
    try {
      return { kind: 'result', value: await action() };
    } catch (error) {
      if (!(error instanceof TaskResourceManagerError) || error.code !== 'TASK_RESOURCE_MANAGER_HOLD') throw error;
      return { kind: 'error', code: error.code };
    }
  };
  const aggregateActual = {};
  const aggregateExpected = {};
  for (const disposition of ['UNSUPPORTED', 'IDENTITY_INSUFFICIENT', 'AUTHORIZATION_BLOCKED', 'FAILED']) {
    const subject = makeSubject({
      graceful: (request) => ({
        disposition, targetIdentitySha256: targetHash(request), identityRevalidated: true,
        evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
      }),
    });
    const resource = await started(subject);
    aggregateActual[`graceful_${disposition}`] = {
      first: await captureHoldOutcome(() => subject.manager.stop(resource.resourceId, { reason: 'user_requested' })),
      second: await captureHoldOutcome(() => subject.manager.stop(resource.resourceId, { reason: 'user_requested' })),
      calls: {
        graceful: subject.fixture.calls.requestGracefulStop - subject.startCalls.requestGracefulStop,
        observe: subject.fixture.calls.observeProcess - subject.startCalls.observeProcess,
        terminate: subject.fixture.calls.terminateOwnedTree - subject.startCalls.terminateOwnedTree,
        absence: subject.fixture.calls.verifyProcessAbsent - subject.startCalls.verifyProcessAbsent,
      },
    };
    const value = {
      status: 'HOLD', resourceId: resource.resourceId,
      decision: { action: 'HOLD', reasons: [`GRACEFUL_STOP_${disposition}`], action_authorized: false },
    };
    aggregateExpected[`graceful_${disposition}`] = {
      first: { kind: 'result', value }, second: { kind: 'result', value },
      calls: { graceful: 1, observe: 0, terminate: 0, absence: 0 },
    };
  }
  for (const disposition of ['UNSUPPORTED', 'IDENTITY_INSUFFICIENT', 'AUTHORIZATION_BLOCKED', 'FAILED']) {
    const subject = makeSubject({
      allowForceTermination: true,
      observe: (request) => ({
        identity: processIdentityFor(request),
        graceful: { requested: true, deadlineReached: true, exitObserved: false },
        exactTreeTerminationSupported: true,
        evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
      }),
      terminate: (request) => ({
        disposition, targetIdentitySha256: targetHash(request), identityRevalidated: true,
        evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
      }),
    });
    const resource = await started(subject);
    await subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' });
    aggregateActual[`termination_${disposition}`] = {
      first: await captureHoldOutcome(() => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' })),
      second: await captureHoldOutcome(() => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' })),
      calls: {
        graceful: subject.fixture.calls.requestGracefulStop - subject.startCalls.requestGracefulStop,
        observe: subject.fixture.calls.observeProcess - subject.startCalls.observeProcess,
        terminate: subject.fixture.calls.terminateOwnedTree - subject.startCalls.terminateOwnedTree,
        absence: subject.fixture.calls.verifyProcessAbsent - subject.startCalls.verifyProcessAbsent,
      },
    };
    const value = {
      status: 'HOLD', resourceId: resource.resourceId,
      decision: { action: 'HOLD', reasons: [`EXACT_TREE_TERMINATION_${disposition}`], action_authorized: false },
    };
    aggregateExpected[`termination_${disposition}`] = {
      first: { kind: 'result', value }, second: { kind: 'result', value },
      calls: { graceful: 1, observe: 1, terminate: 1, absence: 0 },
    };
  }
  const stale = makeSubject({ limits: { tracker: { maxScopes: 3, maxHistoryEvents: 6 } } });
  const staleResource = await started(stale);
  await stale.manager.stop(staleResource.resourceId, { reason: 'user_requested' });
  aggregateActual.stale_result = {
    first: await captureHoldOutcome(() => stale.manager.stop(staleResource.resourceId, { reason: 'user_requested' })),
    second: await captureHoldOutcome(() => stale.manager.stop(staleResource.resourceId, { reason: 'user_requested' })),
    calls: {
      graceful: stale.fixture.calls.requestGracefulStop - stale.startCalls.requestGracefulStop,
      observe: stale.fixture.calls.observeProcess - stale.startCalls.observeProcess,
      terminate: stale.fixture.calls.terminateOwnedTree - stale.startCalls.terminateOwnedTree,
      absence: stale.fixture.calls.verifyProcessAbsent - stale.startCalls.verifyProcessAbsent,
    },
  };
  aggregateExpected.stale_result = {
    first: { kind: 'error', code: 'TASK_RESOURCE_MANAGER_HOLD' },
    second: { kind: 'error', code: 'TASK_RESOURCE_MANAGER_HOLD' },
    calls: { graceful: 1, observe: 1, terminate: 0, absence: 0 },
  };

  const errorOutcome = () => ({ kind: 'error', code: 'TASK_RESOURCE_MANAGER_HOLD' });
  const publicOutcome = (status, action, reasons, extra = {}) => ({
    kind: 'result',
    status,
    resourceMatches: true,
    decision: { action, reasons, action_authorized: false, ...extra },
  });
  const expectedWorkSummary = ({
    trustedResolver = 0, graceful = 0, observe: observeCalls = 0,
    terminate: terminateCalls = 0, absence: absenceCalls = 0,
  } = {}) => ({
    trustedResolver,
    filesystemResolver: 0,
    trustedValidationFailures: 0,
    lifecycleCalls: { probeCapabilities: 0, spawnManaged: 0 },
    stopCalls: {
      requestGracefulStop: graceful,
      observeProcess: observeCalls,
      terminateOwnedTree: terminateCalls,
      verifyProcessAbsent: absenceCalls,
    },
    temporaryCalls: {
      allocateTemporaryRoot: 0,
      quarantineTemporaryRoot: 0,
      removeTemporaryRoot: 0,
      verifyTemporaryAbsent: 0,
    },
    fakePaths: {
      before: '["fixture://unchanged"]',
      after: '["fixture://unchanged"]',
    },
  });
  const validTargetResponse = (target, request) => {
    if (target === 'observe') {
      return {
        identity: processIdentityFor(request),
        graceful: { requested: true, deadlineReached: false, exitObserved: false },
        exactTreeTerminationSupported: false,
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    }
    if (target === 'absence') {
      return {
        disposition: 'ABSENT_CONFIRMED',
        targetIdentitySha256: targetHash(request),
        absence: { processAbsent: true, threadAbsent: true, portAbsent: true },
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      };
    }
    return {
      disposition: 'COMPLETED',
      targetIdentitySha256: targetHash(request),
      identityRevalidated: true,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    };
  };
  const oversizedEvidenceRefs = Object.freeze(Array.from(
    { length: 256 },
    (_, index) => `evidence:${index.toString(16).padStart(64, '0')}`,
  ));
  const responseFailureTargets = ['graceful', 'observe', 'terminate', 'absence'];
  const responseFailureVariants = [
    'wrong_request_hash', 'oversized_response', 'duplicate_evidence',
    'malformed_evidence', 'trusted_rejection',
  ];
  const localResolverCounts = { graceful: 0, observe: 1, terminate: 3, absence: 2 };
  const responseMaxInputBytes = 8192;
  const expectedTargetCalls = {
    graceful: { graceful: 1, observe: 0, terminate: 0, absence: 0 },
    observe: { graceful: 1, observe: 1, terminate: 0, absence: 0 },
    terminate: { graceful: 1, observe: 1, terminate: 1, absence: 0 },
    absence: { graceful: 1, observe: 1, terminate: 0, absence: 1 },
  };
  for (const target of responseFailureTargets) {
    for (const variant of responseFailureVariants) {
      const rejectionTarget = {
        assigned: false,
        requestSha256: null,
        hitCount: 0,
        assignedBeforeHit: false,
      };
      let targetResponseForAudit = null;
      const targetHandler = (request) => {
        rejectionTarget.assigned = true;
        rejectionTarget.requestSha256 = request.requestSha256;
        const valid = validTargetResponse(target, request);
        let response = valid;
        if (variant === 'wrong_request_hash') response = { ...valid, requestSha256: 'f'.repeat(64) };
        if (variant === 'oversized_response') response = { ...valid, evidenceRefs: oversizedEvidenceRefs };
        if (variant === 'duplicate_evidence') response = { ...valid, evidenceRefs: [EVIDENCE_REF, EVIDENCE_REF] };
        if (variant === 'malformed_evidence') response = { ...valid, evidenceRefs: ['evidence:not-a-canonical-reference'] };
        targetResponseForAudit = response;
        return response;
      };
      const trustPolicy = (candidate, context) => {
        if (variant !== 'trusted_rejection' || context.resolutionType !== 'observation') return true;
        const targetMatches = rejectionTarget.assigned
          && typeof candidate?.requestSha256 === 'string'
          && candidate.requestSha256 === rejectionTarget.requestSha256;
        if (!targetMatches) return true;
        rejectionTarget.assignedBeforeHit = rejectionTarget.assigned;
        rejectionTarget.hitCount += 1;
        return false;
      };
      const options = {
        trustedProducer: trustPolicy,
        limits: { tracker: { maxScopes: 3, maxInputBytes: responseMaxInputBytes } },
        [target]: targetHandler,
      };
      if (target === 'terminate') {
        options.allowForceTermination = true;
        options.observe = (request) => ({
          identity: processIdentityFor(request),
          graceful: { requested: true, deadlineReached: true, exitObserved: false },
          exactTreeTerminationSupported: true,
          evidenceRefs: [EVIDENCE_REF],
          requestSha256: request.requestSha256,
        });
      }
      if (target === 'absence') {
        options.observe = (request) => ({
          identity: processIdentityFor(request),
          graceful: { requested: true, deadlineReached: false, exitObserved: true },
          exactTreeTerminationSupported: false,
          evidenceRefs: [EVIDENCE_REF],
          requestSha256: request.requestSha256,
        });
      }
      const subject = makeSubject(options);
      const resource = await started(subject);
      const setup = [];
      if (target !== 'graceful') {
        setup.push(await captureStopOutcome(
          () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' }),
          resource.resourceId,
        ));
      }
      const firstOutcome = await captureStopOutcome(
        () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' }),
        resource.resourceId,
      );
      const workBeforeRepeat = workMarker(subject);
      const secondOutcome = await captureStopOutcome(
        () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' }),
        resource.resourceId,
      );
      const scenario = `response_${target}_${variant}`;
      aggregateActual[scenario] = {
        scenario,
        setup: setup.map((entry) => entry.summary),
        setupDeepFrozen: setup.map((entry) => isDeepFrozen(entry.value)),
        first: firstOutcome.summary,
        second: secondOutcome.summary,
        sameObject: null,
        firstDeepFrozen: null,
        repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
        targetPolicyHits: rejectionTarget.hitCount,
        targetHashAssignedBeforeRejection: variant === 'trusted_rejection'
          ? rejectionTarget.assignedBeforeHit
          : null,
        configuredMaxInputBytes: options.limits.tracker.maxInputBytes,
        responseWasOversized: variant === 'oversized_response'
          ? Buffer.byteLength(canonicalizeDetachedSnapshot(
            createDetachedJsonSnapshot(targetResponseForAudit).snapshot,
          ), 'utf8') > options.limits.tracker.maxInputBytes
          : null,
        ...workSummary(subject),
      };
      const expectedSetup = target === 'graceful' ? [] : [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )];
      const targetCalls = expectedTargetCalls[target];
      aggregateExpected[scenario] = {
        scenario,
        setup: expectedSetup,
        setupDeepFrozen: expectedSetup.map(() => true),
        first: errorOutcome(),
        second: errorOutcome(),
        sameObject: null,
        firstDeepFrozen: null,
        repeatedCallDidNoWork: true,
        targetPolicyHits: variant === 'trusted_rejection' ? 1 : 0,
        targetHashAssignedBeforeRejection: variant === 'trusted_rejection' ? true : null,
        configuredMaxInputBytes: responseMaxInputBytes,
        responseWasOversized: variant === 'oversized_response' ? true : null,
        ...expectedWorkSummary({
          trustedResolver: localResolverCounts[target]
            + (variant === 'trusted_rejection' ? 1 : 0),
          ...targetCalls,
        }),
      };
    }
  }

  const earlyCapabilityCases = [
    ['capability_resource_observation_missing', { resourceObservation: null }],
    ['capability_resource_observation_degraded', { resourceObservation: 'VERIFIED_DEGRADED' }],
    ['capability_request_shutdown_missing', { requestShutdown: null }],
    ['capability_request_shutdown_degraded', { requestShutdown: 'VERIFIED_DEGRADED' }],
  ];
  for (const [scenario, options] of earlyCapabilityCases) {
    const subject = makeSubject(options);
    const resource = await started(subject);
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      setup: [],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      setup: [],
      first: errorOutcome(),
      second: errorOutcome(),
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary(),
    };
  }

  const timeoutObservation = (exactTreeTerminationSupported = true, identityOverrides = {}) => (
    (request) => ({
      identity: processIdentityFor(request, identityOverrides),
      graceful: { requested: true, deadlineReached: true, exitObserved: false },
      exactTreeTerminationSupported,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    })
  );
  const lateCapabilityCases = [
    ['capability_process_tree_terminate_missing', {
      allowForceTermination: true,
      processTreeTerminate: null,
      observe: timeoutObservation(true),
      reason: 'EXACT_TREE_TERMINATION_UNSUPPORTED',
      trustedResolver: 2,
    }],
    ['capability_process_tree_terminate_degraded', {
      allowForceTermination: true,
      processTreeTerminate: 'VERIFIED_DEGRADED',
      observe: timeoutObservation(true),
      reason: 'EXACT_TREE_TERMINATION_UNSUPPORTED',
      trustedResolver: 2,
    }],
    ['capability_adapter_exact_tree_false', {
      allowForceTermination: true,
      observe: timeoutObservation(false),
      reason: 'EXACT_TREE_TERMINATION_UNSUPPORTED',
      trustedResolver: 2,
    }],
    ['capability_force_not_authorized', {
      allowForceTermination: false,
      observe: timeoutObservation(true),
      reason: 'FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN',
      trustedResolver: 3,
    }],
  ];
  for (const [scenario, definition] of lateCapabilityCases) {
    const {
      reason, trustedResolver, ...subjectOptions
    } = definition;
    const subject = makeSubject(subjectOptions);
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: firstOutcome.value === secondOutcome.value,
      firstDeepFrozen: isDeepFrozen(firstOutcome.value),
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: publicOutcome('HOLD', 'HOLD', [reason]),
      second: publicOutcome('HOLD', 'HOLD', [reason]),
      sameObject: true,
      firstDeepFrozen: true,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({ trustedResolver, graceful: 1, observe: 1 }),
    };
  }

  const identityDriftCases = [
    ['pid', 41003],
    ['start_time', '2026-09-04T01:00:01Z'],
    ['lease_generation', 2],
    ['launch_nonce', 'f'.repeat(64)],
    ['parent_identity_sha256', 'f'.repeat(64)],
  ];
  for (const [field, value] of identityDriftCases) {
    const scenario = `identity_drift_${field}`;
    const subject = makeSubject({
      allowForceTermination: true,
      observe: timeoutObservation(true, { [field]: value }),
    });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      changedField: field,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: firstOutcome.value === secondOutcome.value,
      firstDeepFrozen: isDeepFrozen(firstOutcome.value),
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      changedField: field,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: publicOutcome('HOLD', 'HOLD', ['IDENTITY_MISMATCH']),
      second: publicOutcome('HOLD', 'HOLD', ['IDENTITY_MISMATCH']),
      sameObject: true,
      firstDeepFrozen: true,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({ trustedResolver: 2, graceful: 1, observe: 1 }),
    };
  }

  const terminationExceptionCases = [
    ['termination_target_identity_mismatch', (request) => ({
      disposition: 'COMPLETED',
      targetIdentitySha256: 'f'.repeat(64),
      identityRevalidated: true,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }), 3],
    ['termination_identity_not_revalidated', (request) => ({
      disposition: 'COMPLETED',
      targetIdentitySha256: targetHash(request),
      identityRevalidated: false,
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    }), 4],
  ];
  for (const [scenario, terminate, trustedResolver] of terminationExceptionCases) {
    const subject = makeSubject({
      allowForceTermination: true,
      observe: timeoutObservation(true),
      terminate,
    });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: errorOutcome(),
      second: errorOutcome(),
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({
        trustedResolver, graceful: 1, observe: 1, terminate: 1,
      }),
    };
  }

  const normalExitObservation = (request) => ({
    identity: processIdentityFor(request),
    graceful: { requested: true, deadlineReached: false, exitObserved: true },
    exactTreeTerminationSupported: false,
    evidenceRefs: [EVIDENCE_REF],
    requestSha256: request.requestSha256,
  });
  for (const falseField of ['processAbsent', 'threadAbsent', 'portAbsent']) {
    const scenario = `absence_confirmed_false_${falseField}`;
    const absence = (request) => ({
      disposition: 'ABSENT_CONFIRMED',
      targetIdentitySha256: targetHash(request),
      absence: {
        processAbsent: falseField !== 'processAbsent',
        threadAbsent: falseField !== 'threadAbsent',
        portAbsent: falseField !== 'portAbsent',
      },
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    });
    const subject = makeSubject({ observe: normalExitObservation, absence });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      falseField,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      falseField,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: errorOutcome(),
      second: errorOutcome(),
      sameObject: null,
      firstDeepFrozen: null,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({ trustedResolver: 2, graceful: 1, observe: 1, absence: 1 }),
    };
  }

  const completedAbsenceCases = [
    ['all_true', null],
    ['process_false', 'processAbsent'],
    ['thread_false', 'threadAbsent'],
    ['port_false', 'portAbsent'],
  ];
  for (const [label, falseField] of completedAbsenceCases) {
    const scenario = `absence_completed_${label}`;
    const absence = (request) => ({
      disposition: 'COMPLETED',
      targetIdentitySha256: targetHash(request),
      absence: {
        processAbsent: falseField !== 'processAbsent',
        threadAbsent: falseField !== 'threadAbsent',
        portAbsent: falseField !== 'portAbsent',
      },
      evidenceRefs: [EVIDENCE_REF],
      requestSha256: request.requestSha256,
    });
    const subject = makeSubject({ observe: normalExitObservation, absence });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const afterFirst = workSummary(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const afterSecond = workSummary(subject);
    const onlyOneNewAbsenceCheck = afterSecond.trustedResolver === afterFirst.trustedResolver + 1
      && afterSecond.stopCalls.requestGracefulStop === afterFirst.stopCalls.requestGracefulStop
      && afterSecond.stopCalls.observeProcess === afterFirst.stopCalls.observeProcess
      && afterSecond.stopCalls.terminateOwnedTree === afterFirst.stopCalls.terminateOwnedTree
      && afterSecond.stopCalls.verifyProcessAbsent === afterFirst.stopCalls.verifyProcessAbsent + 1
      && JSON.stringify(afterSecond.temporaryCalls) === JSON.stringify(afterFirst.temporaryCalls)
      && afterSecond.fakePaths.after === afterFirst.fakePaths.after;
    aggregateActual[scenario] = {
      scenario,
      falseField,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: firstOutcome.value === secondOutcome.value,
      bothDeepFrozen: isDeepFrozen(firstOutcome.value) && isDeepFrozen(secondOutcome.value),
      onlyOneNewAbsenceCheck,
      ...afterSecond,
    };
    aggregateExpected[scenario] = {
      scenario,
      falseField,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: publicOutcome('WAITING', 'WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED']),
      second: publicOutcome('WAITING', 'WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED']),
      sameObject: false,
      bothDeepFrozen: true,
      onlyOneNewAbsenceCheck: true,
      ...expectedWorkSummary({ trustedResolver: 4, graceful: 1, observe: 1, absence: 2 }),
    };
  }

  for (const disposition of ['UNSUPPORTED', 'IDENTITY_INSUFFICIENT', 'AUTHORIZATION_BLOCKED', 'FAILED']) {
    const scenario = `absence_cached_${disposition}`;
    const subject = makeSubject({
      observe: normalExitObservation,
      absence: (request) => ({
        disposition,
        targetIdentitySha256: targetHash(request),
        absence: { processAbsent: false, threadAbsent: false, portAbsent: false },
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      }),
    });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'task_completed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: firstOutcome.value === secondOutcome.value,
      firstDeepFrozen: isDeepFrozen(firstOutcome.value),
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: publicOutcome('HOLD', 'HOLD', [`ABSENCE_${disposition}`]),
      second: publicOutcome('HOLD', 'HOLD', [`ABSENCE_${disposition}`]),
      sameObject: true,
      firstDeepFrozen: true,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({ trustedResolver: 3, graceful: 1, observe: 1, absence: 1 }),
    };
  }

  const finalTrackerReject = makeSubject({
    observe: normalExitObservation,
    trustedProducer: (candidate, context) => !(context.resolutionType === 'observation'
      && candidate?.decision?.downstream_release_allowed === true),
  });
  const finalTrackerRejectResource = await started(finalTrackerReject);
  const finalTrackerRejectSetup = await captureStopOutcome(
    () => finalTrackerReject.manager.stop(finalTrackerRejectResource.resourceId, { reason: 'task_completed' }),
    finalTrackerRejectResource.resourceId,
  );
  const finalTrackerRejectFirst = await captureStopOutcome(
    () => finalTrackerReject.manager.stop(finalTrackerRejectResource.resourceId, { reason: 'task_completed' }),
    finalTrackerRejectResource.resourceId,
  );
  const finalTrackerRejectWorkBeforeRepeat = workMarker(finalTrackerReject);
  const finalTrackerRejectSecond = await captureStopOutcome(
    () => finalTrackerReject.manager.stop(finalTrackerRejectResource.resourceId, { reason: 'task_completed' }),
    finalTrackerRejectResource.resourceId,
  );
  aggregateActual.absence_final_tracker_rejection = {
    scenario: 'absence_final_tracker_rejection',
    setup: [finalTrackerRejectSetup.summary],
    first: finalTrackerRejectFirst.summary,
    second: finalTrackerRejectSecond.summary,
    sameObject: finalTrackerRejectFirst.value === finalTrackerRejectSecond.value,
    firstDeepFrozen: isDeepFrozen(finalTrackerRejectFirst.value),
    repeatedCallDidNoWork: finalTrackerRejectWorkBeforeRepeat === workMarker(finalTrackerReject),
    ...workSummary(finalTrackerReject),
  };
  aggregateExpected.absence_final_tracker_rejection = {
    scenario: 'absence_final_tracker_rejection',
    setup: [publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    )],
    first: publicOutcome('HOLD', 'HOLD', ['ABSENCE_PROOF_REJECTED']),
    second: publicOutcome('HOLD', 'HOLD', ['ABSENCE_PROOF_REJECTED']),
    sameObject: true,
    firstDeepFrozen: true,
    repeatedCallDidNoWork: true,
    ...expectedWorkSummary({ trustedResolver: 4, graceful: 1, observe: 1, absence: 1 }),
  };

  aggregateActual.idempotent_normal_exit = {
    scenario: 'idempotent_normal_exit',
    first: summarizeResult(stopped, normalExitStarted.resourceId),
    second: summarizeResult(stoppedAgain, normalExitStarted.resourceId),
    sameObject: stopped === stoppedAgain,
    firstDeepFrozen: isDeepFrozen(stopped),
    ...workSummary(normalExit),
  };
  aggregateExpected.idempotent_normal_exit = {
    scenario: 'idempotent_normal_exit',
    first: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    second: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    sameObject: true,
    firstDeepFrozen: true,
    ...expectedWorkSummary({ trustedResolver: 4, graceful: 1, observe: 1, absence: 1 }),
  };
  aggregateActual.idempotent_force_stop = {
    scenario: 'idempotent_force_stop',
    first: summarizeResult(forced, forceStarted.resourceId),
    second: summarizeResult(forcedAgain, forceStarted.resourceId),
    sameObject: forced === forcedAgain,
    firstDeepFrozen: isDeepFrozen(forced),
    repeatedCallDidNoWork: forceRepeatDidNoWork,
    ...workSummary(force),
  };
  aggregateExpected.idempotent_force_stop = {
    scenario: 'idempotent_force_stop',
    first: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    second: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    sameObject: true,
    firstDeepFrozen: true,
    repeatedCallDidNoWork: true,
    ...expectedWorkSummary({
      trustedResolver: 6, graceful: 1, observe: 1, terminate: 1, absence: 1,
    }),
  };
  aggregateActual.idempotent_structured_hold = {
    scenario: 'idempotent_structured_hold',
    first: summarizeResult(noForceResult, noForceStarted.resourceId),
    second: summarizeResult(noForceAgain, noForceStarted.resourceId),
    sameObject: noForceResult === noForceAgain,
    firstDeepFrozen: isDeepFrozen(noForceResult),
    repeatedCallDidNoWork: noForceRepeatDidNoWork,
    ...workSummary(noForce),
  };
  aggregateExpected.idempotent_structured_hold = {
    scenario: 'idempotent_structured_hold',
    first: publicOutcome(
      'HOLD', 'HOLD', ['FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN'],
    ),
    second: publicOutcome(
      'HOLD', 'HOLD', ['FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN'],
    ),
    sameObject: true,
    firstDeepFrozen: true,
    repeatedCallDidNoWork: true,
    ...expectedWorkSummary({ trustedResolver: 3, graceful: 1, observe: 1 }),
  };
  aggregateActual.concurrent_stop_guard = {
    scenario: 'concurrent_stop_guard',
    first: summarizeResult(concurrentFirstResult, concurrentStarted.resourceId),
    second: concurrentSecond.summary,
    third: concurrentThird.summary,
    postResolutionContinuation: concurrentContinuation.summary,
    guardPreserved: concurrentGuardPreserved,
    ...workSummary(concurrent),
  };
  aggregateExpected.concurrent_stop_guard = {
    scenario: 'concurrent_stop_guard',
    first: publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    ),
    second: errorOutcome(),
    third: errorOutcome(),
    postResolutionContinuation: publicOutcome(
      'WAITING', 'WAIT_BOUNDED', ['GRACEFUL_WINDOW_OPEN'],
    ),
    guardPreserved: true,
    ...expectedWorkSummary({ trustedResolver: 2, graceful: 1, observe: 1 }),
  };
  aggregateActual.reason_drift_does_not_advance = {
    scenario: 'reason_drift_does_not_advance',
    initial: summarizeResult(requested, normalStarted.resourceId),
    drift: reasonDriftOutcome.summary,
    continued: summarizeResult(waiting, normalStarted.resourceId),
    driftDidNoWork: reasonDriftDidNoWork,
    ...workSummary(normal),
  };
  aggregateExpected.reason_drift_does_not_advance = {
    scenario: 'reason_drift_does_not_advance',
    initial: publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    ),
    drift: errorOutcome(),
    continued: publicOutcome('WAITING', 'WAIT_BOUNDED', ['GRACEFUL_WINDOW_OPEN']),
    driftDidNoWork: true,
    ...expectedWorkSummary({ trustedResolver: 2, graceful: 1, observe: 1 }),
  };

  aggregateActual.public_result_audits = {
    stopRequested: publicResultAudit(requested, normal),
    waiting: publicResultAudit(waiting, normal),
    stopped: publicResultAudit(stopped, normalExit),
    structuredHold: publicResultAudit(noForceResult, noForce),
  };
  aggregateExpected.public_result_audits = {
    stopRequested: {
      topLevelKeys: ['decision', 'resourceId', 'status'],
      decisionKeys: ['action', 'action_authorized', 'reasons'],
      noHiddenTopLevelKeys: true,
      noHiddenDecisionKeys: true,
      deepFrozen: true,
      privateSentinelsAbsent: true,
    },
    waiting: {
      topLevelKeys: ['decision', 'resourceId', 'status'],
      decisionKeys: ['action', 'action_authorized', 'reasons'],
      noHiddenTopLevelKeys: true,
      noHiddenDecisionKeys: true,
      deepFrozen: true,
      privateSentinelsAbsent: true,
    },
    stopped: {
      topLevelKeys: ['decision', 'resourceId', 'status'],
      decisionKeys: [
        'action', 'action_authorized', 'downstream_release_allowed',
        'identity_confidence', 'reasons',
      ],
      noHiddenTopLevelKeys: true,
      noHiddenDecisionKeys: true,
      deepFrozen: true,
      privateSentinelsAbsent: true,
    },
    structuredHold: {
      topLevelKeys: ['decision', 'resourceId', 'status'],
      decisionKeys: ['action', 'action_authorized', 'reasons'],
      noHiddenTopLevelKeys: true,
      noHiddenDecisionKeys: true,
      deepFrozen: true,
      privateSentinelsAbsent: true,
    },
  };

  aggregateActual.force_request_audits = {
    graceful: requestAudit('graceful', force.requests.graceful[0], force, 'timeout_elapsed'),
    observe: requestAudit('observe', force.requests.observe[0], force, 'timeout_elapsed'),
    terminate: requestAudit('terminate', force.requests.terminate[0], force, 'timeout_elapsed'),
    absence: requestAudit(
      'absence', force.requests.absence[0], force, 'timeout_elapsed', 'force_termination',
    ),
    normalExitAbsence: requestAudit(
      'absence', normalExit.requests.absence[0], normalExit, 'task_completed', 'graceful_exit',
    ),
  };
  const completeRequestAudit = {
    exactKeys: true,
    exactResourceKeys: true,
    exactProvenanceKeys: true,
    exactProvenanceValues: true,
    exactScopeKeys: true,
    exactExpectedIdentityKeys: true,
    exactWindowsIdentityKeys: true,
    exactConfirmedIdentityKeys: true,
    requestHashMatches: true,
    deepFrozen: true,
    correlationMatches: true,
    clearAuthorityAbsent: true,
  };
  aggregateExpected.force_request_audits = {
    graceful: completeRequestAudit,
    observe: completeRequestAudit,
    terminate: completeRequestAudit,
    absence: completeRequestAudit,
    normalExitAbsence: completeRequestAudit,
  };

  const invalidTarget = makeSubject();
  const invalidTargetResource = await started(invalidTarget);
  const foreignSource = makeSubject();
  const foreignResource = await started(foreignSource);
  const invalidResourceIds = [
    ['null', null],
    ['number', 1],
    ['malformed_process_tree', 'command:bad!:process-tree'],
    ['unknown_process_tree', 'command:unknown:process-tree'],
    ['command_session', `command:${invalidTargetResource.commandId}:session`],
    ['temporary_allocation', `command:${invalidTargetResource.commandId}:temporary`],
    ['foreign_process_tree', foreignResource.resourceId],
    ['oversized_command_portion', `command:${exactCommandId(129)}:process-tree`],
  ];
  const invalidOutcomes = [];
  for (const [label, resourceId] of invalidResourceIds) {
    const outcome = await captureStopOutcome(
      () => invalidTarget.manager.stop(resourceId, { reason: 'user_requested' }),
      invalidTargetResource.resourceId,
    );
    invalidOutcomes.push({ label, outcome: outcome.summary });
  }
  aggregateActual.invalid_process_tree_ids = {
    scenario: 'invalid_process_tree_ids',
    outcomes: invalidOutcomes,
    foreignSourceUnchanged: JSON.stringify(workSummary(foreignSource))
      === JSON.stringify(expectedWorkSummary()),
    ...workSummary(invalidTarget),
  };
  aggregateExpected.invalid_process_tree_ids = {
    scenario: 'invalid_process_tree_ids',
    outcomes: invalidResourceIds.map(([label]) => ({ label, outcome: errorOutcome() })),
    foreignSourceUnchanged: true,
    ...expectedWorkSummary(),
  };

  for (const commandIdLength of [107, 108, 128]) {
    const scenario = `command_id_boundary_${commandIdLength}`;
    const subject = makeSubject({ commandId: exactCommandId(commandIdLength) });
    const resource = await started(subject);
    const stopOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      commandIdLength: subject.command.commandId.length,
      derivedResourceIdLength: resource.resourceId.length,
      startSucceeded: resource.status === 'STARTED'
        && resource.commandId === subject.command.commandId,
      stopUsedReturnedResourceId: stopOutcome.value === null
        || stopOutcome.value.resourceId === resource.resourceId,
      stop: stopOutcome.summary,
      stopDeepFrozen: stopOutcome.value === null ? null : isDeepFrozen(stopOutcome.value),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      commandIdLength,
      derivedResourceIdLength: commandIdLength + 21,
      startSucceeded: true,
      stopUsedReturnedResourceId: true,
      stop: publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      ),
      stopDeepFrozen: true,
      ...expectedWorkSummary({ trustedResolver: 1, graceful: 1 }),
    };
  }

  for (const disposition of ['UNSUPPORTED', 'IDENTITY_INSUFFICIENT', 'AUTHORIZATION_BLOCKED', 'FAILED']) {
    const scenario = `termination_cached_${disposition}`;
    const subject = makeSubject({
      allowForceTermination: true,
      observe: timeoutObservation(true),
      terminate: (request) => ({
        disposition,
        targetIdentitySha256: targetHash(request),
        identityRevalidated: true,
        evidenceRefs: [EVIDENCE_REF],
        requestSha256: request.requestSha256,
      }),
    });
    const resource = await started(subject);
    const setupOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    aggregateActual[scenario] = {
      scenario,
      setup: [setupOutcome.summary],
      first: firstOutcome.summary,
      second: secondOutcome.summary,
      sameObject: firstOutcome.value === secondOutcome.value,
      firstDeepFrozen: isDeepFrozen(firstOutcome.value),
      repeatedCallDidNoWork: workBeforeRepeat === workMarker(subject),
      ...workSummary(subject),
    };
    aggregateExpected[scenario] = {
      scenario,
      setup: [publicOutcome(
        'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
      )],
      first: publicOutcome('HOLD', 'HOLD', [`EXACT_TREE_TERMINATION_${disposition}`]),
      second: publicOutcome('HOLD', 'HOLD', [`EXACT_TREE_TERMINATION_${disposition}`]),
      sameObject: true,
      firstDeepFrozen: true,
      repeatedCallDidNoWork: true,
      ...expectedWorkSummary({
        trustedResolver: 4, graceful: 1, observe: 1, terminate: 1,
      }),
    };
  }

  const sanitizedHoldOutcome = () => ({
    kind: 'manager_hold',
    name: 'TaskResourceManagerError',
    code: 'TASK_RESOURCE_MANAGER_HOLD',
    message: 'task resource manager hold',
    freshError: true,
    causeAbsent: true,
    privateMarkersAbsent: true,
  });
  const containsPrivateMarker = (value, privateMarkers, seen = new Set()) => {
    if (typeof value === 'string') {
      return privateMarkers.some((marker) => value.includes(marker));
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')
      || seen.has(value)) return false;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (privateMarkers.some((marker) => String(key).includes(marker))) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')
        && containsPrivateMarker(descriptor.value, privateMarkers, seen)) return true;
    }
    return false;
  };
  const auditManagerHold = (error, injectedError, privateMarkers) => ({
    kind: 'manager_hold',
    name: error.name,
    code: error.code,
    message: error.message,
    freshError: error !== injectedError,
    causeAbsent: !Object.hasOwn(error, 'cause'),
    privateMarkersAbsent: !containsPrivateMarker(error, privateMarkers)
      && privateMarkers.every((marker) => !String(error).includes(marker)),
  });
  const captureAbsenceBoundaryOutcome = async (
    action, resourceId, injectedError = null, privateMarkers = [],
  ) => {
    try {
      const value = await action();
      return { value, summary: summarizeResult(value, resourceId) };
    } catch (error) {
      if (error === injectedError) {
        return { value: null, summary: { kind: 'injected_adapter_error' } };
      }
      if (!(error instanceof TaskResourceManagerError)
        || error.code !== 'TASK_RESOURCE_MANAGER_HOLD') throw error;
      return {
        value: null,
        summary: auditManagerHold(error, injectedError, privateMarkers),
      };
    }
  };

  const absenceRejectionDefinitions = [
    {
      scenario: 'absence_adapter_rejection_graceful_exit',
      reason: 'task_completed',
      terminalAction: 'graceful_exit',
      subjectOptions: { observe: normalExitObservation },
      completedAbsenceBeforeFailure: false,
      trustedResolver: 2,
      absenceCalls: 1,
    },
    {
      scenario: 'absence_adapter_rejection_absence_pending',
      reason: 'task_completed',
      terminalAction: 'graceful_exit',
      subjectOptions: { observe: normalExitObservation },
      completedAbsenceBeforeFailure: true,
      trustedResolver: 3,
      absenceCalls: 2,
    },
    {
      scenario: 'absence_adapter_rejection_force_termination',
      reason: 'timeout_elapsed',
      terminalAction: 'force_termination',
      subjectOptions: {
        allowForceTermination: true,
        observe: timeoutObservation(true),
      },
      completedAbsenceBeforeFailure: false,
      trustedResolver: 4,
      absenceCalls: 1,
    },
  ];
  for (const definition of absenceRejectionDefinitions) {
    const privateMarkers = [
      `raw-absence-${definition.scenario}`,
      `authority:${'f'.repeat(64)}`,
      `synthetic-private-path-${definition.scenario}`,
    ];
    const injectedError = new Error(privateMarkers.join('|'));
    injectedError.cause = new Error(`synthetic-private-cause-${definition.scenario}`);
    let rejectAdapter;
    const pendingAdapter = new Promise((_, reject) => { rejectAdapter = reject; });
    let signalAdapterReached;
    const adapterReached = new Promise((resolve) => { signalAdapterReached = resolve; });
    let absenceCallCount = 0;
    const subject = makeSubject({
      ...definition.subjectOptions,
      absence: (request) => {
        absenceCallCount += 1;
        if (definition.completedAbsenceBeforeFailure && absenceCallCount === 1) {
          return { ...validTargetResponse('absence', request), disposition: 'COMPLETED' };
        }
        signalAdapterReached();
        return pendingAdapter;
      },
    });
    const resource = await started(subject);
    const setup = [];
    setup.push((await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: definition.reason }),
      resource.resourceId,
    )).summary);
    if (definition.completedAbsenceBeforeFailure) {
      setup.push((await captureStopOutcome(
        () => subject.manager.stop(resource.resourceId, { reason: definition.reason }),
        resource.resourceId,
      )).summary);
    }
    const failurePromise = captureAbsenceBoundaryOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: definition.reason }),
      resource.resourceId,
      injectedError,
      privateMarkers,
    );
    await adapterReached;
    const rejectingRequest = subject.requests.absence[subject.requests.absence.length - 1];
    const workBeforeInFlightCall = workMarker(subject);
    const inFlightPromise = captureAbsenceBoundaryOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: definition.reason }),
      resource.resourceId,
      injectedError,
      privateMarkers,
    );
    const inFlightCallDidNoWork = workBeforeInFlightCall === workMarker(subject);
    rejectAdapter(injectedError);
    const [inFlightOutcome, failureOutcome] = await Promise.all([
      inFlightPromise,
      failurePromise,
    ]);
    const workBeforeRepeat = workMarker(subject);
    const repeatOutcome = await captureAbsenceBoundaryOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: definition.reason }),
      resource.resourceId,
      injectedError,
      privateMarkers,
    );
    const repeatedCallDidNoWork = workBeforeRepeat === workMarker(subject);
    aggregateActual[definition.scenario] = {
      scenario: definition.scenario,
      setup,
      inFlight: inFlightOutcome.summary,
      failure: failureOutcome.summary,
      repeat: repeatOutcome.summary,
      adapterReachedBeforeRejection: rejectingRequest !== undefined,
      rejectionAdapterCalls: absenceCallCount,
      inFlightCallDidNoWork,
      repeatedCallDidNoWork,
      absenceRequest: requestAudit(
        'absence', rejectingRequest, subject, definition.reason, definition.terminalAction,
      ),
      terminationRequest: definition.terminalAction === 'force_termination'
        ? requestAudit(
          'terminate', subject.requests.terminate[0], subject, definition.reason,
        )
        : null,
      ...workSummary(subject),
    };
    const expectedSetup = [publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    )];
    if (definition.completedAbsenceBeforeFailure) {
      expectedSetup.push(publicOutcome(
        'WAITING', 'WAIT_BOUNDED', ['EXIT_ABSENCE_NOT_VERIFIED'],
      ));
    }
    aggregateExpected[definition.scenario] = {
      scenario: definition.scenario,
      setup: expectedSetup,
      inFlight: sanitizedHoldOutcome(),
      failure: sanitizedHoldOutcome(),
      repeat: sanitizedHoldOutcome(),
      adapterReachedBeforeRejection: true,
      rejectionAdapterCalls: definition.absenceCalls,
      inFlightCallDidNoWork: true,
      repeatedCallDidNoWork: true,
      absenceRequest: completeRequestAudit,
      terminationRequest: definition.terminalAction === 'force_termination'
        ? completeRequestAudit
        : null,
      ...expectedWorkSummary({
        trustedResolver: definition.trustedResolver,
        graceful: 1,
        observe: 1,
        terminate: definition.terminalAction === 'force_termination' ? 1 : 0,
        absence: definition.absenceCalls,
      }),
    };
  }

  const captureTrackerBoundaryOutcome = async (action, resourceId) => {
    try {
      const value = await action();
      return { value, summary: summarizeResult(value, resourceId) };
    } catch (error) {
      if (error instanceof TaskResourceManagerError
        && error.code === 'TASK_RESOURCE_MANAGER_HOLD') {
        return { value: null, summary: auditManagerHold(error, null, []) };
      }
      if (error?.name === 'ResourceTrackerError'
        && error?.code === 'TRACKER_HISTORY_LIMIT_REACHED') {
        return {
          value: null,
          summary: {
            kind: 'tracker_history_error',
            name: error.name,
            code: error.code,
          },
        };
      }
      throw error;
    }
  };
  const trackerBoundary = makeSubject({
    observe: normalExitObservation,
    limits: { tracker: { maxScopes: 3, maxHistoryEvents: 7 } },
  });
  const trackerBoundaryResource = await started(trackerBoundary);
  const trackerBoundarySetup = await captureStopOutcome(
    () => trackerBoundary.manager.stop(
      trackerBoundaryResource.resourceId, { reason: 'task_completed' },
    ),
    trackerBoundaryResource.resourceId,
  );
  const trackerBoundaryFirst = await captureTrackerBoundaryOutcome(
    () => trackerBoundary.manager.stop(
      trackerBoundaryResource.resourceId, { reason: 'task_completed' },
    ),
    trackerBoundaryResource.resourceId,
  );
  const trackerBoundaryWorkBeforeRepeat = workMarker(trackerBoundary);
  const trackerBoundarySecond = await captureTrackerBoundaryOutcome(
    () => trackerBoundary.manager.stop(
      trackerBoundaryResource.resourceId, { reason: 'task_completed' },
    ),
    trackerBoundaryResource.resourceId,
  );
  aggregateActual.absence_final_tracker_exception = {
    scenario: 'absence_final_tracker_exception',
    setup: [trackerBoundarySetup.summary],
    first: trackerBoundaryFirst.summary,
    second: trackerBoundarySecond.summary,
    repeatedCallDidNoWork: trackerBoundaryWorkBeforeRepeat === workMarker(trackerBoundary),
    absenceRequest: requestAudit(
      'absence', trackerBoundary.requests.absence[0], trackerBoundary,
      'task_completed', 'graceful_exit',
    ),
    ...workSummary(trackerBoundary),
  };
  aggregateExpected.absence_final_tracker_exception = {
    scenario: 'absence_final_tracker_exception',
    setup: [publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    )],
    first: sanitizedHoldOutcome(),
    second: sanitizedHoldOutcome(),
    repeatedCallDidNoWork: true,
    absenceRequest: completeRequestAudit,
    ...expectedWorkSummary({ trustedResolver: 4, graceful: 1, observe: 1, absence: 1 }),
  };

  let reentrySubject;
  let reentryPromise = null;
  let reentryWorkBefore = null;
  let reentryTargetHits = 0;
  let reentryTargetAudit = null;
  const reentryTrustedProducer = (candidate, context) => {
    if (context?.resolutionType === 'observation'
      && candidate?.decision?.downstream_release_allowed === true) {
      reentryTargetHits += 1;
      reentryTargetAudit = {
        resolutionType: context.resolutionType,
        candidateFrozen: Object.isFrozen(candidate),
        contextFrozen: Object.isFrozen(context),
        decisionAction: candidate.decision.action,
        decisionReasons: [...candidate.decision.reasons],
        downstreamReleaseAllowed: candidate.decision.downstream_release_allowed,
        contextMatches: context.runId === 'run-3-1'
          && context.harnessId === 'harness-A'
          && context.adapterId === 'adapter-A'
          && context.authorizationSha256 === reentrySubject.expectedAuthorizationSha256
          && computeDetachedSha256(context.provenance)
            === computeDetachedSha256(reentrySubject.expectedResolverProvenance)
          && JSON.stringify(context.requiredReferences) === JSON.stringify(REQUIRED_REFERENCES),
      };
      if (reentryPromise === null) {
        reentryWorkBefore = workMarker(reentrySubject);
        reentryPromise = captureAbsenceBoundaryOutcome(
          () => reentrySubject.manager.stop(
            reentrySubject.started.resourceId, { reason: 'timeout_elapsed' },
          ),
          reentrySubject.started.resourceId,
        );
      }
    }
    return true;
  };
  reentrySubject = makeSubject({
    allowForceTermination: true,
    observe: timeoutObservation(true),
    trustedProducer: reentryTrustedProducer,
  });
  const reentryResource = await started(reentrySubject);
  const reentrySetup = await captureStopOutcome(
    () => reentrySubject.manager.stop(
      reentryResource.resourceId, { reason: 'timeout_elapsed' },
    ),
    reentryResource.resourceId,
  );
  const reentryFirst = await reentrySubject.manager.stop(
    reentryResource.resourceId, { reason: 'timeout_elapsed' },
  );
  const reentryOutcome = reentryPromise === null
    ? { value: null, summary: { kind: 'target_not_hit' } }
    : await reentryPromise;
  const reentryGuardDidNoWork = reentryWorkBefore !== null
    && reentryWorkBefore === workMarker(reentrySubject);
  const reentryWorkBeforeRepeat = workMarker(reentrySubject);
  const reentryRepeat = await captureStopOutcome(
    () => reentrySubject.manager.stop(
      reentryResource.resourceId, { reason: 'timeout_elapsed' },
    ),
    reentryResource.resourceId,
  );
  aggregateActual.absence_final_resolution_reentry_guard = {
    scenario: 'absence_final_resolution_reentry_guard',
    setup: [reentrySetup.summary],
    first: summarizeResult(reentryFirst, reentryResource.resourceId),
    reentry: reentryOutcome.summary,
    repeat: reentryRepeat.summary,
    firstDeepFrozen: isDeepFrozen(reentryFirst),
    repeatReturnsFirstObject: reentryRepeat.value === reentryFirst,
    targetHits: reentryTargetHits,
    targetAudit: reentryTargetAudit,
    reentryGuardDidNoWork,
    repeatedCallDidNoWork: reentryWorkBeforeRepeat === workMarker(reentrySubject),
    terminationRequest: requestAudit(
      'terminate', reentrySubject.requests.terminate[0], reentrySubject,
      'timeout_elapsed',
    ),
    absenceRequest: requestAudit(
      'absence', reentrySubject.requests.absence[0], reentrySubject,
      'timeout_elapsed', 'force_termination',
    ),
    ...workSummary(reentrySubject),
  };
  aggregateExpected.absence_final_resolution_reentry_guard = {
    scenario: 'absence_final_resolution_reentry_guard',
    setup: [publicOutcome(
      'STOP_REQUESTED', 'WAIT_BOUNDED', ['GRACEFUL_REQUEST_ACKNOWLEDGED'],
    )],
    first: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    reentry: sanitizedHoldOutcome(),
    repeat: publicOutcome('STOPPED', 'OBSERVE_ONLY', ['ABSENCE_VERIFIED'], {
      identity_confidence: 'MATCH', downstream_release_allowed: true,
    }),
    firstDeepFrozen: true,
    repeatReturnsFirstObject: true,
    targetHits: 1,
    targetAudit: {
      resolutionType: 'observation',
      candidateFrozen: true,
      contextFrozen: true,
      decisionAction: 'OBSERVE_ONLY',
      decisionReasons: ['ABSENCE_VERIFIED'],
      downstreamReleaseAllowed: true,
      contextMatches: true,
    },
    reentryGuardDidNoWork: true,
    repeatedCallDidNoWork: true,
    terminationRequest: completeRequestAudit,
    absenceRequest: completeRequestAudit,
    ...expectedWorkSummary({
      trustedResolver: 6, graceful: 1, observe: 1, terminate: 1, absence: 1,
    }),
  };
  for (const subject of stopSubjects) {
    for (const name of temporaryCounterNames) {
      assert.strictEqual(subject.fixture.calls[name], subject.startCalls[name], `${name} must remain fake/no-op`);
    }
    assert.strictEqual(
      subject.fixture.calls.probeCapabilities,
      subject.startCalls.probeCapabilities,
      'stop must not re-probe capabilities',
    );
    assert.strictEqual(
      subject.fixture.calls.spawnManaged,
      subject.startCalls.spawnManaged,
      'stop must not spawn another command',
    );
    assert.strictEqual(
      subject.trustedResolutionCalls.filesystem,
      subject.startTrustedResolutionCalls.filesystem,
      'stop must not invoke the filesystem trusted resolver',
    );
    assert.strictEqual(
      JSON.stringify([...subject.fakePaths].sort()),
      subject.startFakePathState,
      'stop must not mutate fake path state',
    );
  }
  assert.deepStrictEqual(aggregateActual, aggregateExpected);
});

(async () => {
  for (const { name, fn } of tests) await fn();
  process.stdout.write(`task resource manager tests passed (${tests.length} tests).\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
