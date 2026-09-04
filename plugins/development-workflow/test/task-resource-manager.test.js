#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
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

function authorization() {
  return {
    type: 'TaskResourceAuthorization1',
    cleanupAuthorityRef: AUTHORITY_REF,
    allowForceTermination: false,
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

function validInput({ envelopeMutator, trustedProducer, limits, adapterHandlers, rejectResolutionType } = {}) {
  const inputAuthorization = authorization();
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
} = {}) {
  const actions = [];
  const fixture = validInput({
    envelopeMutator,
    limits,
    trustedProducer,
    rejectResolutionType,
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

(async () => {
  for (const { name, fn } of tests) await fn();
  process.stdout.write(`task resource manager tests passed (${tests.length} tests).\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
