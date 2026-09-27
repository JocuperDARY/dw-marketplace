#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
assert.strictEqual(
  typeof TaskResourceManager.prototype.close,
  'function',
  'RED: TaskResourceManager.close() must expose the zero-argument manager close seam',
);
assert.strictEqual(TaskResourceManager.prototype.close.length, 0);
const SHA256 = 'a'.repeat(64);
const AUTHORITY_REF = `authority:${'b'.repeat(64)}`;
const EVIDENCE_REF = `evidence:${'c'.repeat(64)}`;
const REQUIRED_REFERENCES = Object.freeze([AUTHORITY_REF, EVIDENCE_REF].sort());
const DATA_ROOT = path.join(path.parse(process.cwd()).root, 'task-resource-data');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- u8/3-6B fixture migration -------------------------------------------------
// The registered fixture root is created exactly once by the first registered
// step; every manager instance then receives its own sub-root beneath it. The
// Store creates those sub-roots lazily (through the launcher's registered
// mkdirSync), so constructing a fixture stays side-effect free for open-only
// tests that never reach a persisting operation.
const fixtureState = { root: undefined, counter: 0, owned: new Map(), managers: [] };
const fixtureSame = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
const fixtureBind = (target) => {
  const stat = fs.lstatSync(target, { bigint: true });
  assert(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()),
    'fixture entries must be real directories or files');
  if (fixtureState.owned.has(target)) {
    assert(fixtureSame(stat, fixtureState.owned.get(target)), 'never adopt a replacement');
  } else fixtureState.owned.set(target, stat);
  return stat;
};
// A per-instance dataRoot that is NOT created here: the Store's own lazy open
// creates it under the registered fixture root, which the launcher binds.
const instanceDataRoot = () => {
  assert(fixtureState.root !== undefined,
    'fixture root must be created by the suite setup step before any fixture is built');
  fixtureState.counter += 1;
  return path.join(fixtureState.root, `h${fixtureState.counter}`);
};
const openTrackedManager = (input) => {
  const manager = TaskResourceManager.open(input);
  fixtureState.managers.push(manager);
  return manager;
};
const createFixtureRoot = () => {
  if (fixtureState.root !== undefined) return fixtureState.root;
  const tempParent = fs.realpathSync(os.tmpdir());
  const requested = process.env.DW_TRANSACTION_TEST_ROOT;
  if (requested !== undefined) {
    assert(path.isAbsolute(requested) && path.normalize(requested) === requested,
      'registered fixture root must be a canonical absolute path');
    assert.strictEqual(path.dirname(requested), tempParent,
      'registered fixture root must be a direct child of the task temporary parent');
    assert.strictEqual(fs.existsSync(requested), false, 'registered fixture root must be absent');
    fs.mkdirSync(requested);
    fixtureState.root = requested;
  } else fixtureState.root = fs.mkdtempSync(path.join(tempParent, 'dw-bootstrap-'));
  fixtureBind(fixtureState.root);
  assert.strictEqual(fs.realpathSync(fixtureState.root), fixtureState.root);
  return fixtureState.root;
};
// Suite setup runs first (it is registered before every other test) so that any
// later fixture construction has a registered root to hang its sub-roots from.
test('u8 fixture root is created once under the registered task temporary parent', () => {
  const root = createFixtureRoot();
  assert.strictEqual(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.strictEqual(fs.readdirSync(root).length, 0, 'fixture root starts empty');
});

// Closing the tracked managers first frees every writer lease, so the file-level
// teardown that follows can remove registered entries without hand-editing any
// lease (which the unit contract forbids on both the product and test side).
const closeTrackedManagers = async (failures) => {
  for (const manager of fixtureState.managers.slice().reverse()) {
    try {
      // manager.close() is async by contract: it revokes the holder and closes
      // admission synchronously, then settles CLOSING / terminal HOLD / CLOSED.
      // Every settled outcome is legitimate here; only a throw is a failure.
      await manager.close();
    } catch (error) { failures.push(error); }
  }
};
// Idempotent: the tracer may hand the tree over early, and the suite finalizer
// then finds it already gone. Whole inventory is inspected before any mutation,
// each entry is re-checked against its recorded creation identity, deletion is
// non-recursive, and the registered root is removed last.
const removeOwnedFixtureTree = (failures) => {
  const root = fixtureState.root;
  if (root === undefined || !fs.existsSync(root)) return;
  const collected = [];
  const inspect = (target) => {
    // Registered bound, re-measured for the u9 call-point expansion. Previous
    // registered peak was 2544 (u8); the nine added call points each write a
    // durable intent and outcome transaction, which raised the measured peak to
    // 4235 — the growth the u9 contract §3.3 predicted. 8192 leaves modest
    // headroom; raising it again requires a fresh measurement and a registered
    // reason, never a convenience bump.
    assert(collected.length < 8192, 'fixture inventory must stay within the registered bound');
    const stat = fs.lstatSync(target, { bigint: true });
    if (!fixtureState.owned.has(target)) {
      // Managed runs bind every created entry through the launcher's registered
      // wrappers, so this never fires there. The direct (non-managed) entry has no
      // patcher, so entries the Store created inside a registered instance sub-root
      // are adopted here after verifying they are real, non-symlink entries. The
      // registered root itself is never adopted, and a replaced entry is rejected
      // by the identity check on every later pass.
      assert(stat.isDirectory() || stat.isFile(), 'unknown fixture entry must be retained');
      assert(!stat.isSymbolicLink(), 'a symbolic link is never adopted as fixture content');
      fixtureState.owned.set(target, stat);
    }
    assert(fixtureSame(stat, fixtureState.owned.get(target)),
      'unknown or replaced fixture entry must be retained');
    collected.push(target);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) inspect(path.join(target, name));
    }
  };
  try {
    inspect(root);
    for (const target of collected.reverse()) {
      assert.strictEqual(fs.realpathSync(path.dirname(target)), path.dirname(target));
      const stat = fs.lstatSync(target, { bigint: true });
      assert(fixtureState.owned.has(target) && fixtureSame(stat, fixtureState.owned.get(target))
        && !stat.isSymbolicLink(), 'entry identity drifted before removal');
      if (stat.isDirectory()) fs.rmdirSync(target); else fs.unlinkSync(target);
      fixtureState.owned.delete(target);
      assert.strictEqual(fs.existsSync(target), false);
    }
  } catch (error) { failures.push(error); }
};


function bootstrapTransactionFromSeed(seed) {
  const exactSeedKeys = [
    'type', 'schema_version', 'commandId', 'originalProvenance', 'originalAuthorization',
    'originalCapabilityEnvelope', 'trackerHistory', 'failureLoopState',
  ];
  assert(seed !== null && typeof seed === 'object' && !Array.isArray(seed)
    && Object.getPrototypeOf(seed) === Object.prototype, 'bootstrap seed must be a plain object');
  assert.deepStrictEqual(Reflect.ownKeys(seed).sort(), [...exactSeedKeys].sort(), 'bootstrap seed grammar is exact');
  for (const key of exactSeedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(seed, key);
    assert(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
      'bootstrap seed must contain enumerable data properties');
  }
  const detached = createDetachedJsonSnapshot(seed).snapshot;
  assert.strictEqual(detached.type, 'TaskResourceManagerBootstrapSeed1');
  assert.strictEqual(detached.schema_version, 1);
  return createDetachedJsonSnapshot({
    schema: 'TaskResourceManagerBootstrap3',
    schema_version: 3,
    originalProvenance: detached.originalProvenance,
    originalAuthorization: detached.originalAuthorization,
    originalCapabilityEnvelope: detached.originalCapabilityEnvelope,
    trackerHistory: detached.trackerHistory,
    failureLoopState: detached.failureLoopState,
    records: [],
  }).snapshot;
}

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
  allowForceTermination = false, dataRootOverride,
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
      dataRoot: dataRootOverride || instanceDataRoot(),
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

function gracefulShutdownContract(overrides = {}) {
  return {
    type: 'TaskResourceGracefulShutdown1',
    protocol: 'trusted_dispatch',
    authorityRef: `authority:${'a'.repeat(64)}`,
    acknowledgementRequired: true,
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
  allowForceTermination, dataRootOverride,
} = {}) {
  const actions = [];
  const fixture = validInput({
    envelopeMutator,
    limits,
    trustedProducer,
    rejectResolutionType,
    allowForceTermination,
    dataRootOverride,
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
  return { ...fixture, actions, manager: () => openTrackedManager(fixture.input) };
}

test('C holder factory replaces public Seed1 export with a minimal frozen capability', () => {
  assert.strictEqual(typeof api.createBootstrapSeedVerificationHolder, 'function',
    'C_HOLDER_FACTORY_REQUIRED');
  assert.strictEqual('exportBootstrapSeed' in TaskResourceManager.prototype, false);
  const producer = () => true;
  Object.defineProperty(producer, 'then', { get() { throw new Error('producer property read'); } });
  const holder = api.createBootstrapSeedVerificationHolder(producer);
  assert(Object.isFrozen(holder));
  assert.deepStrictEqual(Reflect.ownKeys(holder), ['consumeBootstrapSeed']);
  for (const args of [[], [null], [producer, producer]]) {
    expectHold(() => api.createBootstrapSeedVerificationHolder(...args));
  }
  expectHold(() => holder.consumeBootstrapSeed({ commandId: 'C', purpose: 'bootstrap_store_schema_red' }));
});

function holderScenario({ noRoot = false, first, fixtureOptions = {}, command = {} } = {}) {
  const observed = { entries: 0, irreversible: 0, seeds: [], requests: [], close: null };
  let subject;
  const handle = (request, kind) => {
    observed.entries += 1;
    observed.requests.push(request);
    const response = () => ({ identity: kind === 'allocate' ? temporaryIdentityFor(request)
      : processIdentityFor(request), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 });
    const consume = (receiver = subject.holder, value = {
      commandId: request.commandId, purpose: 'bootstrap_store_schema_red',
    }) => {
      assert.strictEqual(observed.entries, 1);
      assert.strictEqual(observed.irreversible, 0);
      const seed = subject.holder.consumeBootstrapSeed.call(receiver, value);
      observed.seeds.push(seed);
      return seed;
    };
    if (observed.entries === 1) {
      if (first) return first({ subject, observed, request, response, consume });
      consume();
    }
    observed.irreversible += 1;
    return response();
  };
  const fixture = startFixture({ ...fixtureOptions,
    allocation: request => handle(request, 'allocate'), spawn: request => handle(request, 'spawn') });
  const holder = api.createBootstrapSeedVerificationHolder(fixture.input.harness.trustedProducer);
  const manager = fixture.manager();
  subject = { fixture, holder, manager, observed, command: commandInput({
    commandId: 'C-holder', ...(noRoot ? { temporaryRoot: null } : {}),
    bootstrapVerificationHolder: holder, retryBudget: 2, repairBudget: 3, ...command,
  }) };
  return subject;
}

function m2NormalV2Command(overrides = {}) {
  return commandInput({
    commandId: 'm2-normal-v2',
    temporaryRoot: null,
    gracefulShutdown: null,
    ...overrides,
  });
}

function m2ThrowingAccessor(label) {
  let reads = 0;
  return {
    descriptor: {
      enumerable: true,
      get() { reads += 1; throw new Error(`must not read ${label}`); },
    },
    assertUnread() { assert.strictEqual(reads, 0, `${label}: accessor reads`); },
  };
}

function m2NoEffectSnapshot(fixture) {
  return {
    calls: { ...fixture.calls },
    actions: fixture.actions.length,
    dataRootExists: fs.existsSync(fixture.input.dataRoot),
  };
}

function assertM2NoStartEffects(fixture, before, label) {
  assert.deepStrictEqual(fixture.calls, before.calls, `${label}: adapter calls`);
  assert.strictEqual(fixture.actions.length, before.actions, `${label}: adapter actions`);
  assert.strictEqual(fs.existsSync(fixture.input.dataRoot), before.dataRootExists,
    `${label}: runtime persistence root`);
}

const M2_SPAWN_REQUEST2_KEYS = Object.freeze([
  'type', 'commandId', 'executable', 'args', 'cwd', 'timeoutMs', 'temporaryRoot',
  'resourceIds', 'allocationId', 'creationNonce', 'launchNonce', 'temporaryAllocationIdentity',
  'provenance', 'gracefulShutdownSha256', 'requestSha256',
]);

function assertM2SpawnRequest2(request, gracefulShutdownSha256, label) {
  assert(Object.isFrozen(request), `${label}: frozen request`);
  assert.deepStrictEqual(Reflect.ownKeys(request).sort(), [...M2_SPAWN_REQUEST2_KEYS].sort(),
    `${label}: exact request keys`);
  for (const key of M2_SPAWN_REQUEST2_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    assert(descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value'),
      `${label}: ${key} own enumerable data`);
    assert.strictEqual(descriptor.writable, false, `${label}: ${key} frozen writable`);
    assert.strictEqual(descriptor.configurable, false, `${label}: ${key} frozen configurable`);
  }
  assert.strictEqual(request.type, 'TaskResourceSpawnRequest2', `${label}: request type`);
  assert.strictEqual(request.gracefulShutdownSha256, gracefulShutdownSha256,
    `${label}: detached contract hash`);
  assert.strictEqual(Object.hasOwn(request, 'gracefulShutdown'), false,
    `${label}: raw contract absent`);
  assert.strictEqual(JSON.stringify(request).includes('authority:'), false,
    `${label}: authority material absent`);
  assert.strictEqual(request.requestSha256, recomputeRequestSha256(request),
    `${label}: request hash`);
}

async function expectM2NormalRejectWithoutEffects(fixture, manager, input, recovery, label) {
  const before = m2NoEffectSnapshot(fixture);
  await expectHoldAsync(() => manager.startCommand(input), label);
  assertM2NoStartEffects(fixture, before, label);
  assert.strictEqual((await manager.startCommand(recovery)).status, 'STARTED',
    `${label}: same-manager same-id V1 recovery`);
}

async function expectM2BootstrapRejectWithoutEffects(subject, input, label) {
  const before = m2NoEffectSnapshot(subject.fixture);
  await expectHoldAsync(() => subject.manager.startCommand(input), label);
  assertM2NoStartEffects(subject.fixture, before, label);
  assert.strictEqual(subject.observed.entries, 0, `${label}: holder callback`);
  assert.strictEqual(subject.observed.irreversible, 0, `${label}: irreversible action`);
  assert.strictEqual(subject.observed.seeds.length, 0, `${label}: holder consumed`);
  assert.strictEqual(subject.observed.requests.length, 0, `${label}: request recorded`);
  assert.strictEqual((await subject.manager.startCommand(subject.command)).status, 'STARTED',
    `${label}: later valid holder use`);
}

test('M2 grammar baseline retains exact normal V1 and bootstrap V1 admission', async () => {
  const normal = startFixture();
  assert.strictEqual((await normal.manager().startCommand(commandInput({
    commandId: 'm2-normal-v1', temporaryRoot: null,
  }))).status, 'STARTED');
  const bootstrap = holderScenario({ noRoot: true });
  assert.strictEqual((await bootstrap.manager.startCommand(bootstrap.command)).status, 'STARTED');
  assert.strictEqual(bootstrap.observed.seeds.length, 1);
});

test('M2 RED admits exact seven-key normal V2 null contract before start effects', async () => {
  const fixture = startFixture();
  const result = await fixture.manager().startCommand(m2NormalV2Command({
    commandId: 'm2-normal-v2-null', gracefulShutdown: null,
  }));
  assert.strictEqual(result.status, 'STARTED');
  assert.strictEqual(fixture.calls.allocateTemporaryRoot, 0);
  assert.strictEqual(fixture.calls.spawnManaged, 1);
  const [spawn] = fixture.actions.map(entry => entry.request);
  assertM2SpawnRequest2(spawn, computeDetachedSha256(null), 'normal V2 null');
});

test('M2 RED admits exact seven-key normal V2 non-null contract without authority material', async () => {
  const fixture = startFixture();
  const contract = gracefulShutdownContract();
  const result = await fixture.manager().startCommand(m2NormalV2Command({
    commandId: 'm2-normal-v2-contract', gracefulShutdown: contract,
  }));
  assert.strictEqual(result.status, 'STARTED');
  const [spawn] = fixture.actions.map(entry => entry.request);
  assertM2SpawnRequest2(spawn, computeDetachedSha256(contract), 'normal V2 contract');
});

test('M2 RED admits exact ten-key bootstrap V2 null and non-null contracts', async () => {
  const nullSubject = holderScenario({ noRoot: true, command: {
    commandId: 'm2-bootstrap-v2-null', gracefulShutdown: null,
  } });
  assert.strictEqual((await nullSubject.manager.startCommand(nullSubject.command)).status, 'STARTED');
  assert.strictEqual(nullSubject.observed.seeds.length, 1);
  assertM2SpawnRequest2(nullSubject.observed.requests[0], computeDetachedSha256(null),
    'bootstrap V2 null');

  const contract = gracefulShutdownContract();
  const contractSubject = holderScenario({ noRoot: true, command: {
    commandId: 'm2-bootstrap-v2-contract', gracefulShutdown: contract,
  } });
  assert.strictEqual((await contractSubject.manager.startCommand(contractSubject.command)).status, 'STARTED');
  assert.strictEqual(contractSubject.observed.seeds.length, 1);
  assertM2SpawnRequest2(contractSubject.observed.requests[0], computeDetachedSha256(contract),
    'bootstrap V2 contract');
});

test('M2 exact-set rejects malformed normal and bootstrap V2 shapes before effects', async () => {
  const normalCases = [
    ['partial bootstrap', input => { input.retryBudget = 1; }],
    ['same-count unrelated', input => { delete input.gracefulShutdown; input.unrelated = true; }],
    ['extra field', input => { input.extra = true; }],
    ['missing V2 field becomes non-exact', input => { delete input.gracefulShutdown; input.repairBudget = 1; }],
  ];
  for (const [label, mutate] of normalCases) {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-normal-invalid-${label.replaceAll(' ', '-')}`, temporaryRoot: null });
    const bad = m2NormalV2Command({ commandId: recovery.commandId });
    mutate(bad);
    await expectM2NormalRejectWithoutEffects(fixture, manager, bad, recovery, label);
  }

  const bootstrapCases = [
    ['fourth bootstrap field', input => { input.bootstrapExtra = true; }],
    ['partial V2 bootstrap', input => { input.gracefulShutdown = null; delete input.repairBudget; }],
    ['same-count unrelated bootstrap V2', input => { delete input.gracefulShutdown; input.unrelated = true; }],
  ];
  for (const [label, mutate] of bootstrapCases) {
    const subject = holderScenario({ noRoot: true, command: { gracefulShutdown: null } });
    const bad = { ...subject.command }; mutate(bad);
    await expectM2BootstrapRejectWithoutEffects(subject, bad, label);
  }
});

test('M2 descriptor and object rejections preserve the universal no-effect boundary', async () => {
  const normalCases = [
    ['graceful accessor', input => {
      const probe = m2ThrowingAccessor('normal graceful accessor');
      Object.defineProperty(input, 'gracefulShutdown', probe.descriptor); return probe.assertUnread;
    }],
    ['symbol key', input => { input[Symbol('m2')] = true; }],
    ['non-enumerable graceful', input => Object.defineProperty(input, 'gracefulShutdown', {
      enumerable: false, value: null,
    })],
    ['non-plain prototype', input => Object.setPrototypeOf(input, null)],
  ];
  for (const [label, mutate] of normalCases) {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-normal-object-${label.replaceAll(/[^a-z]+/gi, '-')}`, temporaryRoot: null });
    const bad = m2NormalV2Command({ commandId: recovery.commandId });
    const assertUnread = mutate(bad);
    await expectM2NormalRejectWithoutEffects(fixture, manager, bad, recovery, label);
    if (assertUnread) assertUnread();
  }

  const bootstrapCases = [
    ['bootstrap graceful accessor', input => {
      const probe = m2ThrowingAccessor('bootstrap graceful accessor');
      Object.defineProperty(input, 'gracefulShutdown', probe.descriptor); return probe.assertUnread;
    }],
    ['bootstrap holder accessor', input => {
      const probe = m2ThrowingAccessor('bootstrap holder accessor');
      Object.defineProperty(input, 'bootstrapVerificationHolder', probe.descriptor); return probe.assertUnread;
    }],
    ['bootstrap retry accessor', input => {
      const probe = m2ThrowingAccessor('bootstrap retry accessor');
      Object.defineProperty(input, 'retryBudget', probe.descriptor); return probe.assertUnread;
    }],
    ['bootstrap repair accessor', input => {
      const probe = m2ThrowingAccessor('bootstrap repair accessor');
      Object.defineProperty(input, 'repairBudget', probe.descriptor); return probe.assertUnread;
    }],
    ['bootstrap V2 symbol', input => { input[Symbol('m2-bootstrap')] = true; }],
    ['bootstrap V2 non-enumerable', input => Object.defineProperty(input, 'gracefulShutdown', {
      enumerable: false, value: null,
    })],
  ];
  for (const [label, mutate] of bootstrapCases) {
    const subject = holderScenario({ noRoot: true, command: { gracefulShutdown: null } });
    const bad = { ...subject.command }; const assertUnread = mutate(bad);
    await expectM2BootstrapRejectWithoutEffects(subject, bad, label);
    if (assertUnread) assertUnread();
  }
});

test('M2 non-null contract grammar rejects exact-shape violations before effects', async () => {
  const normalCases = [
    ['missing type', contract => { delete contract.type; }],
    ['extra contract field', contract => { contract.extra = true; }],
    ['same-count unrelated field', contract => { delete contract.protocol; contract.unrelated = true; }],
    ['invalid type', contract => { contract.type = 'TaskResourceGracefulShutdown0'; }],
    ['invalid protocol', contract => { contract.protocol = 'window_message'; }],
    ['invalid authority reference', contract => { contract.authorityRef = 'not-an-authority-reference'; }],
    ['acknowledgement false', contract => { contract.acknowledgementRequired = false; }],
    ['authority accessor', contract => {
      const probe = m2ThrowingAccessor('contract authority accessor');
      Object.defineProperty(contract, 'authorityRef', probe.descriptor); return probe.assertUnread;
    }],
    ['non-enumerable protocol', contract => Object.defineProperty(contract, 'protocol', {
      enumerable: false, value: 'trusted_dispatch',
    })],
    ['contract symbol', contract => { contract[Symbol('m2-contract')] = true; }],
    ['contract non-plain prototype', contract => Object.setPrototypeOf(contract, null)],
  ];
  for (const [label, mutate] of normalCases) {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-contract-${label.replaceAll(/[^a-z]+/gi, '-')}`, temporaryRoot: null });
    const contract = gracefulShutdownContract(); const assertUnread = mutate(contract);
    await expectM2NormalRejectWithoutEffects(fixture, manager, m2NormalV2Command({
      commandId: recovery.commandId, gracefulShutdown: contract,
    }), recovery, `normal contract ${label}`);
    if (assertUnread) assertUnread();
  }
  for (const [label, handler] of [
    ['ownKeys', { ownKeys() { throw new Error('contract ownKeys trap'); } }],
    ['descriptor', { getOwnPropertyDescriptor() { throw new Error('contract descriptor trap'); } }],
    ['prototype', { getPrototypeOf() { throw new Error('contract prototype trap'); } }],
  ]) {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-contract-trap-${label}`, temporaryRoot: null });
    const contract = new Proxy(gracefulShutdownContract(), handler);
    await expectM2NormalRejectWithoutEffects(fixture, manager, m2NormalV2Command({
      commandId: recovery.commandId, gracefulShutdown: contract,
    }), recovery, `normal contract ${label}`);
  }
  for (const [label, mutate] of [
    ['bootstrap contract missing type', contract => { delete contract.type; }],
    ['bootstrap contract extra field', contract => { contract.extra = true; }],
    ['bootstrap contract trap', contract => new Proxy(contract, {
      getOwnPropertyDescriptor() { throw new Error('bootstrap contract descriptor trap'); },
    })],
  ]) {
    const subject = holderScenario({ noRoot: true, command: { gracefulShutdown: null } });
    let contract = gracefulShutdownContract(); contract = mutate(contract) || contract;
    await expectM2BootstrapRejectWithoutEffects(subject, {
      ...subject.command, gracefulShutdown: contract,
    }, label);
  }
});

test('M2 reflection traps reject normal and bootstrap V2 before effects', async () => {
  const normalTraps = [
    ['ownKeys', { ownKeys() { throw new Error('ownKeys trap'); } }],
    ['descriptor', { getOwnPropertyDescriptor() { throw new Error('descriptor trap'); } }],
    ['prototype', { getPrototypeOf() { throw new Error('prototype trap'); } }],
  ];
  for (const [label, handler] of normalTraps) {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-normal-trap-${label}`, temporaryRoot: null });
    const trapped = new Proxy(m2NormalV2Command({ commandId: recovery.commandId }), handler);
    await expectM2NormalRejectWithoutEffects(fixture, manager, trapped, recovery, `normal ${label}`);
  }
  for (const [label, handler] of normalTraps) {
    const subject = holderScenario({ noRoot: true, command: { gracefulShutdown: null } });
    const trapped = new Proxy(subject.command, handler);
    await expectM2BootstrapRejectWithoutEffects(subject, trapped, `bootstrap ${label}`);
  }
});

test('M2 exhaustive V2 malformed contract and command specimens remain pre-effect holds', async () => {
  const rejectNormal = async (label, input) => {
    const fixture = startFixture(); const manager = fixture.manager();
    const recovery = commandInput({ commandId: `m2-exhaustive-normal-${label}`, temporaryRoot: null });
    input.commandId = recovery.commandId;
    await expectM2NormalRejectWithoutEffects(fixture, manager, input, recovery, `normal ${label}`);
  };
  const rejectBootstrap = async (label, mutate) => {
    const subject = holderScenario({ noRoot: true, command: { gracefulShutdown: null } });
    const bad = mutate(subject.command);
    await expectM2BootstrapRejectWithoutEffects(subject, bad, `bootstrap ${label}`);
  };

  for (const [label, value] of [
    ['undefined-contract', undefined], ['string-contract', 'trusted_dispatch'],
    ['boolean-contract', true], ['array-contract', []],
  ]) {
    await rejectNormal(label, m2NormalV2Command({ gracefulShutdown: value }));
    await rejectBootstrap(label, command => ({ ...command, gracefulShutdown: value }));
  }

  for (const field of ['type', 'protocol', 'authorityRef', 'acknowledgementRequired']) {
    const normalProbe = m2ThrowingAccessor(`normal contract ${field} accessor`);
    const normalContract = gracefulShutdownContract();
    Object.defineProperty(normalContract, field, normalProbe.descriptor);
    await rejectNormal(`contract-${field}-accessor`, m2NormalV2Command({ gracefulShutdown: normalContract }));
    normalProbe.assertUnread();

    const bootstrapProbe = m2ThrowingAccessor(`bootstrap contract ${field} accessor`);
    await rejectBootstrap(`contract-${field}-accessor`, command => {
      const contract = gracefulShutdownContract();
      Object.defineProperty(contract, field, bootstrapProbe.descriptor);
      return { ...command, gracefulShutdown: contract };
    });
    bootstrapProbe.assertUnread();
  }

  for (const [label, makeNormal, makeBootstrap] of [
    ['array-command', () => Object.assign([], m2NormalV2Command()), command => Object.assign([], command)],
    ['sparse-array-command', () => { const value = Object.assign([], m2NormalV2Command()); value[2] = 'sparse'; return value; },
      command => { const value = Object.assign([], command); value[2] = 'sparse'; return value; }],
    ['null-prototype-command', () => Object.assign(Object.create(null), m2NormalV2Command()),
      command => Object.assign(Object.create(null), command)],
  ]) {
    await rejectNormal(label, makeNormal());
    await rejectBootstrap(label, command => makeBootstrap(command));
  }

  const normalArgs = new Proxy(['--version'], { ownKeys() { throw new Error('normal detached snapshot trap'); } });
  await rejectNormal('detached-snapshot-failure', m2NormalV2Command({ args: normalArgs }));
  const bootstrapArgs = new Proxy(['--version'], { ownKeys() { throw new Error('bootstrap detached snapshot trap'); } });
  await rejectBootstrap('detached-snapshot-failure', command => ({ ...command, args: bootstrapArgs }));
});

test('C real Seed1 has applicable registration history, budgets and deep immutable data on both paths', async () => {
  for (const noRoot of [false, true]) {
    const s = holderScenario({ noRoot });
    expectHold(() => s.holder.consumeBootstrapSeed({ commandId: s.command.commandId,
      purpose: 'bootstrap_store_schema_red' }));
    const result = await s.manager.startCommand(s.command);
    assert.strictEqual(result.status, 'STARTED');
    assert.strictEqual(s.observed.entries, noRoot ? 1 : 2);
    assert.strictEqual(s.fixture.calls.allocateTemporaryRoot, noRoot ? 0 : 1);
    const [seed] = s.observed.seeds;
    assert.strictEqual(s.observed.seeds.length, 1);
    assert.strictEqual(seed.type, 'TaskResourceManagerBootstrapSeed1');
    const recursivelyFrozen = value => {
      if (value && typeof value === 'object') {
        assert(Object.isFrozen(value));
        for (const nested of Object.values(value)) recursivelyFrozen(nested);
      }
    };
    recursivelyFrozen(seed);
    assert.strictEqual(seed.failureLoopState.retryBudget, 2);
    assert.strictEqual(seed.failureLoopState.repairBudget, 3);
    assert.strictEqual(seed.failureLoopState.revision, 1);
    const transaction = bootstrapTransactionFromSeed(seed);
    assert.strictEqual(transaction.schema, 'TaskResourceManagerBootstrap3');
    const history = JSON.stringify(seed.trackerHistory);
    assert(history.includes('command_session') && history.includes('process_tree'));
    assert.strictEqual(history.includes('temporary_allocation'), !noRoot);
    assert(!history.includes('RESOURCE_BOUND'));
    assert(!JSON.stringify(seed).includes(s.command.executable));
    assert(!JSON.stringify(seed).includes(s.command.cwd));
    for (const request of s.observed.requests) {
      for (const name of ['bootstrapVerificationHolder','retryBudget','repairBudget']) {
        assert.strictEqual(Object.hasOwn(request, name), false);
      }
    }
    expectHold(() => s.holder.consumeBootstrapSeed({ commandId: s.command.commandId,
      purpose: 'bootstrap_store_schema_red' }));
    await expectHoldAsync(() => s.manager.startCommand(s.command));
  }
});

test('C malformed verification commands reject before insertion and permit corrected same ID', async () => {
  const changes = [c => { delete c.repairBudget; }, c => { delete c.retryBudget; },
    c => { c.extra = true; }, c => { c.retryBudget = -1; }, c => { c.repairBudget = 0.5; },
    c => { c.retryBudget = Number.MAX_SAFE_INTEGER + 1; }, c => { c.bootstrapVerificationHolder = {}; },
    c => { c.bootstrapVerificationHolder = api.createBootstrapSeedVerificationHolder(() => true); },
    c => { Object.defineProperty(c, 'repairBudget', { get() { throw Error('getter'); }, enumerable: true }); }];
  for (const mutate of changes) {
    const s = holderScenario(); const bad = { ...s.command }; mutate(bad);
    await expectHoldAsync(() => s.manager.startCommand(bad));
    assert.strictEqual(s.observed.entries, 0);
    assert.strictEqual((await s.manager.startCommand(s.command)).status, 'STARTED');
  }
});

test('C exact receivers include extracted call and exclude copied or same-producer replacement holders', async () => {
  for (const mode of ['unbound','copied','replacement','wrong-purpose','extra','getter','wrong-id','extracted']) {
    const s = holderScenario({ first: ({ subject, consume, response }) => {
      const input = { commandId: subject.command.commandId, purpose: 'bootstrap_store_schema_red' };
      const fn = subject.holder.consumeBootstrapSeed;
      if (mode === 'extracted') { const seed = fn.call(subject.holder, input); subject.observed.seeds.push(seed); return response(); }
      if (mode === 'wrong-purpose') input.purpose = 'other';
      if (mode === 'wrong-id') input.commandId = 'other';
      if (mode === 'extra') input.extra = 1;
      if (mode === 'getter') Object.defineProperty(input, 'purpose', { get() { throw Error('getter'); }, enumerable: true });
      const receiver = mode === 'unbound' ? undefined : mode === 'copied' ? { ...subject.holder }
        : mode === 'replacement' ? api.createBootstrapSeedVerificationHolder(subject.fixture.input.harness.trustedProducer)
          : subject.holder;
      expectHold(() => fn.call(receiver, input));
      return response();
    } });
    if (mode === 'extracted') assert.strictEqual((await s.manager.startCommand(s.command)).status, 'STARTED');
    else { await expectHoldAsync(() => s.manager.startCommand(s.command)); assert.strictEqual(s.observed.entries, 1); }
  }
});

test('C no consumption, caught bad consumption and synchronous throw never enter a later action', async () => {
  for (const mode of ['none','caught','throw','consumed-throw']) {
    const s = holderScenario({ first: ({ consume, response, subject }) => {
      if (mode === 'caught') expectHold(() => consume(subject.holder, { commandId: 'bad', purpose: 'bad' }));
      if (mode === 'consumed-throw') consume();
      if (mode.includes('throw')) throw Error('adapter failed');
      return response();
    } });
    await expectHoldAsync(() => s.manager.startCommand(s.command));
    assert.strictEqual(s.observed.entries, 1);
    assert.strictEqual(s.observed.irreversible, 0);
    await expectHoldAsync(() => s.manager.startCommand(s.command));
  }
});

test('C rejected or pending native promises after missed delivery cannot leak a later grant or rejection', async () => {
  for (const reject of [false, true]) {
    let settle;
    const pending = new Promise((resolve, rejection) => { settle = reject ? rejection : resolve; });
    const unhandled = [];
    const listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const s = holderScenario({ first: () => pending });
      await expectHoldAsync(() => s.manager.startCommand(s.command));
      expectHold(() => s.holder.consumeBootstrapSeed({ commandId: s.command.commandId,
        purpose: 'bootstrap_store_schema_red' }));
      settle(reject ? Error('C collected adapter rejection') : null);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
      assert.strictEqual(s.observed.entries, 1);
    } finally { process.removeListener('unhandledRejection', listener); }
  }
});

test('C then getters cannot reopen a grant and refusal does not evaluate a returned thenable', async () => {
  for (const consumed of [false, true]) {
    let thenReads = 0;
    const s = holderScenario({ first: ({ subject, consume, response }) => {
      if (consumed) consume();
      return Object.defineProperty({}, 'then', { get() {
        thenReads += 1;
        expectHold(() => subject.holder.consumeBootstrapSeed({ commandId: subject.command.commandId,
          purpose: 'bootstrap_store_schema_red' }));
        return resolve => resolve(response());
      } });
    } });
    if (consumed) assert.strictEqual((await s.manager.startCommand(s.command)).status, 'STARTED');
    else await expectHoldAsync(() => s.manager.startCommand(s.command));
    assert.strictEqual(thenReads, consumed ? 1 : 0);
  }
});

test('C close at first adapter entry revokes both allocation and null-root spawn grants', async () => {
  for (const noRoot of [false, true]) {
    const s = holderScenario({ noRoot, first: ({ subject, consume, response }) => {
      subject.observed.close = subject.manager.close();
      expectHold(() => consume());
      return response();
    } });
    await expectHoldAsync(() => s.manager.startCommand(s.command));
    await s.observed.close;
    assert.strictEqual(s.observed.entries, 1);
    assert.strictEqual(s.observed.irreversible, 0);
    assert.strictEqual(s.fixture.calls.allocateTemporaryRoot, noRoot ? 0 : 1);
    await expectHoldAsync(() => s.manager.startCommand(s.command));
    assert.notStrictEqual((await s.manager.close()).status, 'CLOSED');
  }
});

test('C failed detached delivery cannot become success when adapter catches the error', async () => {
  const s = holderScenario({ first: ({ consume, response }) => {
    const freeze = Object.freeze;
    let trapped = 0;
    Object.freeze = value => {
      if (value?.type === 'TaskResourceManagerBootstrapSeed1') { trapped += 1; throw Error('C delivery freeze'); }
      return freeze(value);
    };
    try { expectHold(() => consume()); } finally { Object.freeze = freeze; }
    assert.strictEqual(trapped, 1);
    return response();
  } });
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  assert.strictEqual(s.observed.entries, 1);
  assert.strictEqual(s.observed.seeds.length, 0);
  assert.strictEqual(s.observed.irreversible, 0);
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  assert.notStrictEqual((await s.manager.close()).status, 'CLOSED');
});

test('C test converter rejects top-level descriptors before nested reads', () => {
  let reads = 0;
  const bad = { type: 'TaskResourceManagerBootstrapSeed1', schema_version: 1, commandId: 'C',
    originalProvenance: {}, originalAuthorization: {}, originalCapabilityEnvelope: {},
    trackerHistory: [], failureLoopState: {} };
  Object.defineProperty(bad, 'originalProvenance', { get() { reads += 1; throw Error('nested read'); }, enumerable: true });
  assert.throws(() => bootstrapTransactionFromSeed(bad));
  assert.strictEqual(reads, 0);
});

test('C close or recursive consumption during detached copying prevents outer delivery', async () => {
  for (const action of ['close','consume']) {
    const s = holderScenario({ first: ({ subject, consume, response }) => {
      const freeze = Object.freeze;
      let entered = false;
      Object.freeze = value => {
        if (!entered && value?.type === 'TaskResourceManagerBootstrapSeed1') {
          entered = true;
          if (action === 'close') subject.observed.close = subject.manager.close();
          else expectHold(() => consume());
        }
        return freeze(value);
      };
      try { expectHold(() => consume()); } finally { Object.freeze = freeze; }
      assert(entered);
      return response();
    } });
    await expectHoldAsync(() => s.manager.startCommand(s.command));
    if (s.observed.close) await s.observed.close;
    assert.strictEqual(s.observed.seeds.length, 0);
    assert.strictEqual(s.observed.entries, 1);
  }
});

test('C successful synchronous consumption supports pending resolution and rejects resolver promises', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let response;
  const s = holderScenario({ noRoot: true, first: ({ consume, response: make }) => {
    consume(); response = make(); return pending;
  } });
  const started = s.manager.startCommand(s.command);
  assert.strictEqual(s.observed.seeds.length, 1);
  expectHold(() => s.holder.consumeBootstrapSeed({ commandId: s.command.commandId, purpose: 'bootstrap_store_schema_red' }));
  resolve(response);
  assert.strictEqual((await started).status, 'STARTED');
  const rejected = [];
  const listener = error => rejected.push(error);
  process.on('unhandledRejection', listener);
  try {
    const fixture = validInput({ trustedProducer: () => Promise.reject(Error('C producer rejected')) });
    expectHold(() => TaskResourceManager.open(fixture.input));
    const subject = holderScenario();
    const producer = subject.fixture.input.harness.trustedProducer;
    const wrapped = (value, context) => context.resolutionType
      ? Promise.reject(Error('C resolver rejected')) : producer(value, context);
    const r = holderScenario({ fixtureOptions: { trustedProducer: wrapped } });
    await expectHoldAsync(() => r.manager.startCommand(r.command));
    assert.strictEqual(r.observed.entries, 1);
    await new Promise(done => setImmediate(done));
    assert.deepStrictEqual(rejected, []);
  } finally { process.removeListener('unhandledRejection', listener); }
});

test('C same-producer holder identity cannot substitute and ordinary commands never deliver a seed', async () => {
  const s = holderScenario();
  const second = api.createBootstrapSeedVerificationHolder(s.fixture.input.harness.trustedProducer);
  assert.notStrictEqual(second, s.holder);
  await expectHoldAsync(() => s.manager.startCommand({ ...s.command, bootstrapVerificationHolder: second }));
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  s.observed.entries = 0;
  assert.strictEqual((await s.manager.startCommand({ ...s.command, commandId: 'C-next' })).status, 'STARTED');
  const ordinary = startFixture();
  const manager = ordinary.manager();
  const result = await manager.startCommand(commandInput());
  assert.deepStrictEqual(Object.keys(result).sort(), ['commandId','resourceId','status']);
  assert.strictEqual('exportBootstrapSeed' in manager, false);
});

test('C registration failure consumes command ID but leaves unbound holder available to another manager', async () => {
  const s = holderScenario({ fixtureOptions: { limits: { tracker: { maxScopes: 1 } } } });
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  assert.strictEqual(s.observed.entries, 0);
  const next = holderScenario({ fixtureOptions: { trustedProducer: s.fixture.input.harness.trustedProducer } });
  next.holder = s.holder;
  next.command.bootstrapVerificationHolder = s.holder;
  assert.strictEqual((await next.manager.startCommand(next.command)).status, 'STARTED');
  assert.strictEqual(next.observed.seeds.length, 1);
});

test('C rejection observation discards fulfilled native Promise values without thenable assimilation', async () => {
  const value = {};
  const fulfilled = Promise.resolve(value);
  let reads = 0;
  Object.defineProperty(value, 'then', { get() { reads += 1; throw Error('C unexpected assimilation'); } });
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const s = holderScenario({ first: () => fulfilled });
    await expectHoldAsync(() => s.manager.startCommand(s.command));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(unhandled, []);
    assert.strictEqual(s.observed.entries, 1);
  } finally { process.removeListener('unhandledRejection', listener); }
});

test('C close reentry from either trusted resolver prevents final STARTED and later action', async () => {
  for (const noRoot of [false, true]) {
    const baseline = validInput();
    let subject;
    const trustedProducer = (value, context) => {
      if (context.resolutionType) subject.observed.close = subject.manager.close();
      return baseline.input.harness.trustedProducer(value, context);
    };
    subject = holderScenario({ noRoot, fixtureOptions: { trustedProducer } });
    await expectHoldAsync(() => subject.manager.startCommand(subject.command));
    await subject.observed.close;
    assert.strictEqual(subject.observed.entries, 1);
    assert.strictEqual(subject.observed.seeds.length, 1);
    await expectHoldAsync(() => subject.manager.startCommand(subject.command));
    assert.notStrictEqual((await subject.manager.close()).status, 'CLOSED');
  }
});

test('C close during thenable resolution and repeat consumption never grant another seed', async () => {
  for (const closeDuringThen of [false, true]) {
    const s = holderScenario({ noRoot: true, first: ({ subject, consume, response }) => {
      consume();
      expectHold(() => consume());
      if (!closeDuringThen) return response();
      return { then(resolve) { subject.observed.close = subject.manager.close(); resolve(response()); } };
    } });
    if (closeDuringThen) {
      await expectHoldAsync(() => s.manager.startCommand(s.command));
      await s.observed.close;
    } else assert.strictEqual((await s.manager.startCommand(s.command)).status, 'STARTED');
    assert.strictEqual(s.observed.seeds.length, 1);
    assert.strictEqual(s.observed.entries, 1);
  }
});

test('C previous bound runtime history is refused intact before a new verification callback', async () => {
  const s = holderScenario({ noRoot: true, first: ({ response }) => response() });
  assert.strictEqual((await s.manager.startCommand(commandInput({
    commandId: 'C-ordinary-first', temporaryRoot: null,
  }))).status, 'STARTED');
  assert.strictEqual(s.observed.entries, 1);
  await expectHoldAsync(() => s.manager.startCommand(s.command));
  assert.strictEqual(s.observed.entries, 1);
  assert.strictEqual(s.observed.seeds.length, 0);
  await expectHoldAsync(() => s.manager.startCommand(s.command));
});


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
  // T-1: reads the durable class recorded for the manager's newest action. Returns a
  // distinct sentinel when no durable state was found, so a broken probe cannot be
  // mistaken for the defect under test.
  const NO_DURABLE_STATE = 'NO_DURABLE_STATE';
  const durableOutcomeStatus = (subject) => {
    const directory = path.join(
      subject.fixture.input.dataRoot, 'development-workflow', 'recovery', subject.fixture.input.runId,
    );
    if (!fs.existsSync(directory)) return NO_DURABLE_STATE;
    // Numeric order, not lexicographic: 'pending-revision-10.json' sorts before
    // '...-9.json' as a string, which would read a stale revision once a fixture
    // exceeds nine of them.
    const revisions = fs.readdirSync(directory)
      .map((name) => /^pending-revision-(\d+)\.json$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
    if (revisions.length === 0) return NO_DURABLE_STATE;
    const transaction = JSON.parse(
      fs.readFileSync(path.join(directory, `pending-revision-${revisions.pop()}.json`), 'utf8'),
    ).transaction;
    // A bootstrap transaction carries no `commands` key at all, and a records
    // envelope written by savePending carries no `transaction` key at all, so either
    // shape is the sentinel rather than a crash — the helper must not report a broken
    // probe as an error of its own.
    if (transaction === undefined || transaction.commands === undefined) return NO_DURABLE_STATE;
    // The newest action of the whole transaction is the action under test only while
    // a subject issues exactly one command — unlike runtimeSettleLatest, which scans
    // for the newest action OF THE COMMAND. Enforce the precondition here so a future
    // second command fails loudly instead of silently re-pointing this read.
    assert.strictEqual(transaction.commands.length, 1);
    const action = transaction.actions.at(-1);
    return action === undefined || action.outcome === null ? NO_DURABLE_STATE : action.outcome.status;
  };
  // Row 2 of the settled oracle: the graceful adapter answered COMPLETED but declared
  // it could not revalidate the target identity, so the manager cannot tell a
  // successful stop from a stop of the wrong process. That ambiguity is what UNCERTAIN
  // records — not CONFIRMED, which the old unconditional clearPending wrote, and not
  // REJECTED, which would assert a refusal nobody observed. The scenario itself is
  // driven in the stop section above; only its durable class is new here.
  aggregateActual.bad_receipt_durable = durableOutcomeStatus(badReceipt);
  aggregateExpected.bad_receipt_durable = 'UNCERTAIN';
  // T-1 at the stop-side observe exit: `noForce` authenticates its observe response
  // and clearPending settles THAT action, so the durable class belongs to the observe
  // step — which genuinely succeeded — and not to the FORCE_TERMINATION_NOT_AUTHORIZED_AT_OPEN
  // policy hold raised after it. CONFIRMED is therefore correct, and stopHold's
  // REJECTED is correctly swallowed by runtimeSettleLatest's first-settle-wins rule.
  // This expectation read REJECTED before the T-1 convergence: the old unconditional
  // clearPending wrote CONFIRMED anyway, so the file and the durable record disagreed.
  // The refusal stays observable to the caller as the HOLD, asserted separately below.
  // It registers in the aggregate rather than as a bare assert, so a T-1 failure
  // reports every durable key in one frame instead of aborting here.
  aggregateActual.no_force_durable = durableOutcomeStatus(noForce);
  aggregateExpected.no_force_durable = 'CONFIRMED';
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
    // T-1: an explicit negative disposition means the graceful request itself failed,
    // so ITS action is the newest one and must be durably REJECTED. This is the case
    // the old unconditional clearPending got wrong — it settled CONFIRMED before the
    // disposition was even examined. clearPending now states the class that the
    // adapter's own answer established.
    aggregateActual[`graceful_${disposition}_durable`] = durableOutcomeStatus(subject);
    const value = {
      status: 'HOLD', resourceId: resource.resourceId,
      decision: { action: 'HOLD', reasons: [`GRACEFUL_STOP_${disposition}`], action_authorized: false },
    };
    aggregateExpected[`graceful_${disposition}_durable`] = 'REJECTED';
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
    // T-1 reaches this call site too, and the same explicit-negative rule applies:
    // the termination request failed, its action is the newest one, and it must be
    // durably REJECTED. The old unconditional clearPending wrote CONFIRMED here by
    // defaulting the whole stop path to success before the disposition was examined.
    aggregateActual[`termination_${disposition}_durable`] = durableOutcomeStatus(subject);
    aggregateExpected[`termination_${disposition}_durable`] = 'REJECTED';
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
    // Counter-assertion to the REJECTED family: the setup step's graceful request
    // legitimately succeeds and must stay durably CONFIRMED. Without this, a "fix"
    // that simply removed the settle from every stop path — successes included —
    // would satisfy every REJECTED expectation in this file. The discriminating power
    // now rests on the explicit-negative sites — the graceful_*, termination_* and
    // absence_* dispositions — because the observe-then-hold sites below are CONFIRMED
    // on both sides of this loop and so no longer oppose it.
    aggregateActual[`${scenario}_durable_after_setup`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable_after_setup`] = 'CONFIRMED';
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
    // T-1 reaches the observe-side decision refusals as well: the observe response is
    // authenticated and settled before the decision refuses, and that settle is the
    // first one, so it stands. The class is CONFIRMED rather than REJECTED because the
    // settle names the disposition of the observe step itself — which succeeded — while
    // the refusal is a policy hold raised after it. The newest action is the observe
    // one: verifyAbsence is only reached from the WAIT_BOUNDED branch, and these
    // scenarios observe with exit_observed false. This expectation read REJECTED before
    // the T-1 convergence; the HOLD is still asserted in the entry below.
    aggregateActual[`${scenario}_durable`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable`] = 'CONFIRMED';
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
    // Counter-assertion, same as the capability loop: the setup's graceful request
    // legitimately succeeds and must stay durably CONFIRMED.
    aggregateActual[`${scenario}_durable_after_setup`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable_after_setup`] = 'CONFIRMED';
    const firstOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    const workBeforeRepeat = workMarker(subject);
    const secondOutcome = await captureStopOutcome(
      () => subject.manager.stop(resource.resourceId, { reason: 'timeout_elapsed' }),
      resource.resourceId,
    );
    // T-1 reaches this decision refusal too: identical shape and identical class to the
    // capability loop above — the observe response is authenticated and settled before
    // the tracker decision refuses, that observe step genuinely succeeded, so the
    // durable class is CONFIRMED with the IDENTITY_MISMATCH hold asserted separately
    // below. The counters (graceful 1, observe 1) leave the observe action newest;
    // verifyAbsence is not reached because the WAIT_BOUNDED branch requires
    // exit_observed, which timeoutObservation leaves false. This expectation read
    // REJECTED before the T-1 convergence.
    aggregateActual[`${scenario}_durable`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable`] = 'CONFIRMED';
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
    // Row 2 of the settled oracle, second half. `termination_identity_not_revalidated`
    // answers COMPLETED but declares it could not revalidate the target identity, so the
    // manager cannot tell a successful tree termination from one aimed at the wrong
    // process: UNCERTAIN, not CONFIRMED as the old unconditional clearPending wrote, and
    // not REJECTED, which would assert a refusal nobody observed. Note this changes the
    // durable class only — the before code already threw at the same guard, so no
    // adapter or resolver count moves, including the trustedResolver expectation above.
    // `termination_target_identity_mismatch` is the control: normalizeStopActionResponse
    // refuses its receipt on the target-identity comparison before any trust check runs,
    // so no clearPending executes on either side and the action stays unsettled. That the
    // two differ is the point — the probe must distinguish "settled uncertain" from
    // "never settled" rather than collapsing both to one sentinel.
    aggregateActual[`${scenario}_durable`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable`] = scenario === 'termination_identity_not_revalidated'
      ? 'UNCERTAIN' : NO_DURABLE_STATE;
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
    // T-1 at the absence exits: an explicit negative disposition from the absence probe
    // means the probe itself failed, so its action is the newest one and must be
    // durably REJECTED — the old unconditional clearPending wrote CONFIRMED here. The
    // newest action is the absence one by control flow, not by the counters below:
    // the observe intent is settled before the tracker decision runs, and
    // verifyProcessAbsent is only reached from that decision's WAIT_BOUNDED branch,
    // so nothing can be pushed after it. (The counters pin cardinality, not order.)
    aggregateActual[`${scenario}_durable`] = durableOutcomeStatus(subject);
    aggregateExpected[`${scenario}_durable`] = 'REJECTED';
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
  // T-1 at ABSENCE_PROOF_REJECTED: the graceful and observe action each run once, then
  // verifyProcessAbsent succeeds and answers ABSENT_CONFIRMED, so the newest action is
  // the absence one and ITS disposition — a confirmed absence — is what the durable
  // class records: CONFIRMED. The tracker's later refusal of the downstream release is
  // a policy hold raised after the probe, not a failed probe, and it stays asserted as
  // the ABSENCE_PROOF_REJECTED HOLD in the entry below. This expectation read REJECTED
  // before the T-1 convergence.
  aggregateActual.absence_final_tracker_rejection_durable = durableOutcomeStatus(finalTrackerReject);
  aggregateExpected.absence_final_tracker_rejection_durable = 'CONFIRMED';
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

test('close aggregates caller-driven no-temp convergence, global gates, and contained fake failures', async () => {
  const { ResourceScope, TaskResourceTracker } = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');
  const authenticClose = TaskResourceManager.prototype.close;
  const scopeMethods = ['openChild', 'register', 'bind', 'observe', 'confirmRelease', 'confirmRetention', 'close'];
  const trackerMethods = ['openRootScope', 'claimTaskScope', 'consumeTaskCloseResult'];
  const counterNames = [
    'probeCapabilities', 'spawnManaged', 'allocateTemporaryRoot', 'requestGracefulStop',
    'observeProcess', 'terminateOwnedTree', 'verifyProcessAbsent', 'quarantineTemporaryRoot',
    'removeTemporaryRoot', 'verifyTemporaryAbsent',
  ];
  const saved = [];
  const stopDescriptor = Object.getOwnPropertyDescriptor(TaskResourceManager.prototype, 'stop');
  const verifierDescriptor = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'verifyCloseResult');
  const promiseLedger = [];
  const controls = [];
  const subjects = [];
  const publicResults = [];
  const harnessErrors = [];
  const rejectionAudits = [];
  const rawMarker = 'U35A_PRIVATE_RAW_FAILURE';
  let active = null;
  let verifierTrapHits = 0;
  let stopTrapHits = 0;
  let getterHits = 0;
  const actual = {};

  // Each source Promise gets both handlers immediately. The retained observation
  // Promise always fulfills; no discarded finally chain can become unhandled.
  const track = (label, promise, permittedRawFailure = false) => {
    const entry = { label, promise, settled: false, outcome: null, permittedRawFailure };
    promiseLedger.push(entry);
    entry.observed = promise.then(
      (value) => {
        entry.settled = true;
        entry.outcome = { kind: 'value', value };
        return entry.outcome;
      },
      (error) => {
        entry.settled = true;
        entry.outcome = { kind: 'error', error };
        return entry.outcome;
      },
    );
    return entry;
  };
  const invoke = (label, operation) => {
    try {
      return track(label, operation());
    } catch (error) {
      return track(label, Promise.reject(error));
    }
  };
  const take = (outcome) => {
    if (outcome.kind === 'value') return outcome.value;
    if (outcome.error instanceof TaskResourceManagerError
      && outcome.error.code === 'TASK_RESOURCE_MANAGER_HOLD') return 'CONTROLLED_ERROR';
    throw outcome.error;
  };
  const auditRejection = (label, outcome) => {
    const isRejection = outcome.kind === 'error';
    rejectionAudits.push({
      label, kind: outcome.kind, rejected: isRejection,
      managerError: isRejection && outcome.error instanceof TaskResourceManagerError,
      code: isRejection ? outcome.error.code : null,
    });
    return take(outcome);
  };
  const drain = () => track('drain', Promise.allSettled(promiseLedger.map((entry) => entry.observed)));
  const gate = (label) => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = track(label, promise, true);
    const control = { entry, resolve, reject, response: null };
    controls.push(control);
    return control;
  };
  const guarded = (handler) => function (...args) {
    try { return Reflect.apply(handler, this, args); } catch (error) {
      harnessErrors.push(error);
      throw error;
    }
  };
  const work = (subject) => JSON.stringify({
    adapters: counterNames.map((name) => subject.fixture.calls[name]),
    resolvers: [subject.resolvers.observation, subject.resolvers.filesystem],
    scopes: subject.scopeMutations,
    trackers: subject.trackerMutations,
    fakeState: subject.fakeState,
  });
  const processCounts = (subject) => [
    subject.fixture.calls.requestGracefulStop, subject.fixture.calls.observeProcess,
    subject.fixture.calls.terminateOwnedTree, subject.fixture.calls.verifyProcessAbsent,
  ];
  const data = (value, key) => {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const result = (subject, outcome) => {
    const value = take(outcome);
    publicResults.push({ subject, value });
    return value;
  };
  const summary = (value) => `${data(value, 'status')}/${data(data(data(value, 'decision'), 'reasons'), '0')}`;
  const close = (subject, ...args) => {
    if (args.length === 0 && subject.closeAdmissionCounters === undefined) {
      subject.closeAdmissionCounters = [subject.fixture.calls.probeCapabilities,
        subject.fixture.calls.spawnManaged, subject.fixture.calls.allocateTemporaryRoot];
      subject.closeAdmissionFakeState = JSON.stringify(subject.fakeState);
    }
    return invoke('close', () => Reflect.apply(authenticClose, subject.manager, args));
  };
  const start = (subject, commandId = 'close-A', temporaryRoot = null) => invoke('start', () => (
    subject.manager.startCommand(commandInput({ commandId, temporaryRoot, timeoutMs: 60000 }))
  ));
  const stop = (subject, resourceId) => invoke('stop', () => (
    subject.manager.stop(resourceId, { reason: 'user_requested' })
  ));
  const receipt = (request) => ({
    disposition: 'COMPLETED', targetIdentitySha256: computeDetachedSha256(request.expectedIdentity),
    identityRevalidated: true, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
  });
  const observed = (request, waiting = false) => ({
    identity: processIdentityFor(request),
    graceful: { requested: true, deadlineReached: !waiting, exitObserved: false },
    exactTreeTerminationSupported: !waiting,
    evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
  });
  const spawnReceipt = (request) => ({
    identity: processIdentityFor(request), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
  });
  const allocationReceipt = (request) => ({
    identity: temporaryIdentityFor(request), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
  });
  const install = (prototype, name, kind) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    saved.push({ prototype, name, descriptor });
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: function (...args) {
        const subject = active;
        if (!subject) throw new Error('Missing close aggregate attribution');
        const scopeId = kind === 'scope' ? this.scopeId : args[0]?.scopeId || null;
        const entry = { method: name, scopeId };
        (kind === 'scope' ? subject.scopeMutations : subject.trackerMutations).push(entry);
        if (kind === 'scope' && name === 'close') {
          const root = this.scopeId === 'manager-run-A';
          subject.actions.push(root ? 'root' : `child:${this.scopeId.slice('command:'.length)}`);
          const closeEntry = { scopeId: this.scopeId, reason: args[0], delegated: false, status: null, order: null, error: null };
          subject.closes.push(closeEntry);
          if (subject.mode === (root ? 'forge-root' : 'forge-child')) {
            closeEntry.status = 'FORGED';
            return Object.freeze({
              ownerId: 'owner-A', runId: 'run-3-1', scopeId: this.scopeId, generation: 1,
              status: 'CLOSED', reasons: [], decisions: [],
              order: root ? [] : ['command:close-A:process-tree', 'command:close-A:session'],
            });
          }
          if (subject.mode === 'throw-child' && !root) {
            closeEntry.error = rawMarker;
            throw new Error(rawMarker);
          }
          closeEntry.delegated = true;
          try {
            const value = Reflect.apply(descriptor.value, this, args);
            closeEntry.status = value.status;
            closeEntry.order = value.order;
            return value;
          } catch (error) {
            closeEntry.error = error.code || error.message;
            if (error.code !== 'TRACKER_HISTORY_LIMIT_REACHED') harnessErrors.push(error);
            throw error;
          }
        }
        try { return Reflect.apply(descriptor.value, this, args); } catch (error) {
          harnessErrors.push(error);
          throw error;
        }
      },
    });
  };
  const makeSubject = (options = {}) => {
    if (promiseLedger.some((entry) => !entry.settled)) throw new Error('Undrained subject attribution');
    const subject = {
      fixture: null, manager: null, resolvers: { observation: 0, filesystem: 0 },
      scopeMutations: [], trackerMutations: [], actions: [], closes: [], requests: [], responses: [],
      fakeState: ['fixture://unchanged'], mode: options.mode || null, sessionChecks: [],
      resolverChecks: [], reentries: [], resolverSettlement: { order: [], outerPendingAtBusy: [] },
    };
    active = subject;
    const allowForceTermination = options.allowForceTermination !== false;
    const expectedAuthorizationSha256 = computeDetachedSha256(authorization(allowForceTermination));
    const fixture = startFixture({
      allowForceTermination,
      limits: options.limits || { tracker: { maxScopes: 8 } },
      trustedProducer: guarded((candidate, context) => {
        if (context.resolutionType === 'observation' || context.resolutionType === 'filesystem') {
          subject.resolvers[context.resolutionType] += 1;
        }
        const trusted = Object.isFrozen(candidate) && Object.isFrozen(context)
          && context.runId === 'run-3-1' && context.harnessId === 'harness-A'
          && context.adapterId === 'adapter-A'
          && context.authorizationSha256 === expectedAuthorizationSha256
          && JSON.stringify(context.requiredReferences) === JSON.stringify(REQUIRED_REFERENCES);
        subject.resolverChecks.push(trusted);
        if (candidate.resource?.type === 'command_session') {
          const commandId = candidate.resource.scopeId.slice('command:'.length);
          subject.actions.push(`session:${commandId}`);
          const spawnRequest = subject.requests.find((entry) => entry.kind === 'spawn' && entry.request.commandId === commandId)?.request;
          const expectedIdentity = spawnRequest && processIdentityFor(spawnRequest);
          const expectedObservation = {
            duplicate_run_lock: false, owner_status: 'owned', orphaned: false,
            expected_identity: expectedIdentity, observed_identity: expectedIdentity,
            expected_generation: 1, observed_generation: 1,
            expected_scope: { kind: 'scope', value: `command:${commandId}` },
            observed_scope: { kind: 'scope', value: `command:${commandId}` },
            graceful: { requested: true, deadline_reached: false, exit_observed: true },
            exact_tree_termination_supported: false,
            absence: { process_absent: true, thread_absent: true, port_absent: true },
            evidence_refs: [EVIDENCE_REF],
          };
          subject.sessionChecks.push(context.resolutionType === 'observation'
            && candidate.resource.resourceId === `command:${commandId}:session`
            && candidate.resource.ownerId === 'owner-A'
            && candidate.resource.generation === 1
            && canonicalizeDetachedSnapshot(candidate.observation) === canonicalizeDetachedSnapshot(expectedObservation)
            && candidate.decision.action === 'OBSERVE_ONLY'
            && JSON.stringify(candidate.decision.reasons) === JSON.stringify(['ABSENCE_VERIFIED'])
            && candidate.decision.identity_confidence === 'MATCH'
            && candidate.decision.downstream_release_allowed === true);
          if (options.rejectSession) return false;
        }
        if (options.resolverReentry && candidate.resource?.type === 'process_tree'
          && candidate.decision?.downstream_release_allowed === true) {
          const reentry = close(subject);
          subject.reentries.push(reentry);
          track('resolver-busy-settlement', reentry.promise.then(
            (value) => {
              subject.resolverSettlement.order.push('busy');
              subject.resolverSettlement.outerPendingAtBusy.push(
                options.outerConvergence !== undefined && !options.outerConvergence.settled,
              );
              return value;
            },
            (error) => {
              subject.resolverSettlement.order.push('busy-rejected');
              subject.resolverSettlement.outerPendingAtBusy.push(
                options.outerConvergence !== undefined && !options.outerConvergence.settled,
              );
              throw error;
            },
          ));
          options.resolverReentry.resolve(true);
        }
        return trusted;
      }),
      spawn: guarded((request) => {
        subject.requests.push({ kind: 'spawn', request });
        if (options.spawnGate) {
          options.spawnGate.response = spawnReceipt(request);
          if (options.rejectSpawn) options.spawnGate.reject(new Error(rawMarker));
          return options.spawnGate.entry.promise;
        }
        return spawnReceipt(request);
      }),
      allocation: guarded((request) => {
        subject.requests.push({ kind: 'allocate', request });
        subject.fakeState.push(`allocated:${request.commandId}`);
        if (options.allocationGate) {
          options.allocationGate.response = allocationReceipt(request);
          return options.allocationGate.entry.promise;
        }
        return allocationReceipt(request);
      }),
    });
    subject.fixture = fixture;
    // Override the shared helper's assertion-bearing probe for this aggregate.
    fixture.platformAdapter.probeCapabilities = guarded(() => {
      fixture.calls.probeCapabilities += 1;
      const envelope = capabilityEnvelope(authorization(allowForceTermination));
      for (const claim of ['resource_observation', 'request_shutdown', 'process_tree_terminate']) {
        envelope.supportMatrix.claims[claim] = { state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] };
      }
      return envelope;
    });
    const handlers = {
      requestGracefulStop: ['graceful', (request) => {
        if (options.adapterReentry) subject.reentries.push(close(subject));
        if (options.gracefulGate) {
          options.gracefulGate.response = receipt(request);
          if (options.rejectGraceful) options.gracefulGate.reject(new Error(rawMarker));
          return options.gracefulGate.entry.promise;
        }
        return receipt(request);
      }],
      observeProcess: ['observe', (request) => {
        const value = request.type === 'TaskResourceProcessObservationRequest1'
          ? spawnReceipt(request) : observed(request, options.waiting === true);
        subject.responses.push({ kind: 'observe', value });
        if (options.observeGate) {
          options.observeGate.response = value;
          return options.observeGate.entry.promise;
        }
        return value;
      }],
      terminateOwnedTree: ['terminate', receipt],
      verifyProcessAbsent: ['absence', (request) => ({
        disposition: 'ABSENT_CONFIRMED', targetIdentitySha256: computeDetachedSha256(request.expectedIdentity),
        absence: { processAbsent: true, threadAbsent: true, portAbsent: true },
        evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256,
      })],
    };
    for (const [name, [kind, handler]] of Object.entries(handlers)) {
      fixture.platformAdapter[name] = guarded((request) => {
        fixture.calls[name] += 1;
        subject.requests.push({ kind, request });
        subject.actions.push(`${kind}:${request.commandId}`);
        return handler(request);
      });
    }
    for (const name of ['quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent']) {
      fixture.platformAdapter[name] = () => {
        fixture.calls[name] += 1;
        subject.fakeState.push(`unexpected:${name}`);
      };
    }
    subject.manager = fixture.manager();
    subjects.push(subject);
    return subject;
  };

  try {
    for (const name of scopeMethods) install(ResourceScope.prototype, name, 'scope');
    for (const name of trackerMethods) install(TaskResourceTracker.prototype, name, 'tracker');

    // 1-2: argument count and private receiver checks precede cache and all work.
    const empty = makeSubject();
    const hostile = {};
    Object.defineProperty(hostile, 'authority', { get() { getterHits += 1; throw new Error(rawMarker); } });
    Object.defineProperty(hostile, Symbol('authority'), { get() { getterHits += 1; throw new Error(rawMarker); } });
    const surrogate = Object.create(TaskResourceManager.prototype);
    Object.defineProperty(surrogate, 'state', { get() { getterHits += 1; throw new Error(rawMarker); } });
    Object.defineProperty(surrogate, Symbol('state'), { get() { getterHits += 1; throw new Error(rawMarker); } });
    const emptyBefore = work(empty);
    const invalidUndefined = auditRejection('close-undefined', await close(empty, undefined).observed);
    const invalidObject = auditRejection('close-object', await close(empty, hostile).observed);
    const invalidReceiver = auditRejection('close-surrogate', await invoke('close-surrogate', () => Reflect.apply(authenticClose, surrogate, [])).observed);
    const authorityNoWork = emptyBefore === work(empty);
    const emptyFirst = result(empty, await close(empty).observed);
    const emptyAfter = work(empty);
    const emptyAgain = result(empty, await close(empty).observed);
    const terminalArgument = auditRejection('terminal-close-object', await close(empty, hostile).observed);
    const terminalUndefined = auditRejection('terminal-close-undefined', await close(empty, undefined).observed);
    const terminalStart = auditRejection('terminal-start', await start(empty).observed);
    actual.authority = {
      arity: authenticClose.length, invalidUndefined, invalidObject, invalidReceiver,
      authorityNoWork, terminalArgument, terminalUndefined, terminalStart,
      terminalNoWork: emptyAfter === work(empty), getterHits,
    };
    actual.empty = {
      first: summary(emptyFirst), sameObject: emptyFirst === emptyAgain,
      counters: counterNames.map((name) => empty.fixture.calls[name]),
      resolvers: [empty.resolvers.observation, empty.resolvers.filesystem],
      scopeMethods: empty.scopeMutations.map((entry) => entry.method),
      trackerMethods: empty.trackerMutations.map((entry) => entry.method),
      closes: empty.closes,
    };
    take(await drain().observed);

    const history = makeSubject({ limits: { tracker: { maxHistoryEvents: 2 } } });
    const historyFirst = result(history, await close(history).observed);
    const historyWork = work(history);
    const historyAgain = result(history, await close(history).observed);
    actual.history = { first: summary(historyFirst), sameObject: historyFirst === historyAgain,
      noRepeatWork: historyWork === work(history), closes: history.closes };
    take(await drain().observed);

    // 3: force authority is captured at open, and each call owns one transition.
    const force = makeSubject();
    take(await start(force).observed);
    const forceFirst = result(force, await close(force).observed);
    const firstCounts = processCounts(force);
    const forceSecond = result(force, await close(force).observed);
    const forceWork = work(force);
    const forceAgain = result(force, await close(force).observed);
    actual.force = { sequence: [summary(forceFirst), summary(forceSecond), summary(forceAgain)],
      firstCounts, finalCounts: processCounts(force), sameObject: forceSecond === forceAgain,
      noRepeatWork: forceWork === work(force), actions: force.actions,
      sessionChecks: force.sessionChecks, closes: force.closes,
      terminationAuthority: force.requests.filter((entry) => entry.kind === 'terminate').map(({ request }) => (
        request.reasonCode === 'manager_close' && request.forceAuthorization.allowedAtOpen === true
        && request.forceAuthorization.authorizationSha256 === computeDetachedSha256(authorization(true))
        && computeDetachedSha256(request.expectedIdentity) === computeDetachedSha256(request.confirmedIdentity)
      )),
    };
    take(await drain().observed);

    // 4: both public-stop pending stages retain their original reason and token.
    actual.existingStop = [];
    for (const stage of ['graceful', 'observe']) {
      const options = {};
      const subject = makeSubject(options);
      const resource = take(await start(subject).observed);
      const pending = gate(`public-stop-${stage}`);
      options[`${stage}Gate`] = pending;
      if (stage === 'observe') take(await stop(subject, resource.resourceId).observed);
      const publicStop = stop(subject, resource.resourceId);
      const before = work(subject);
      const busy = result(subject, await close(subject).observed);
      const noWork = before === work(subject);
      pending.resolve(pending.response);
      const stopOutcome = take(await publicStop.observed);
      const processBeforeConvergence = processCounts(subject);
      const actionBeforeConvergence = subject.actions.length;
      const converged = result(subject, await close(subject).observed);
      actual.existingStop.push({ stage, during: summary(busy), noWork, stopStatus: stopOutcome.status,
        after: summary(converged), counts: processCounts(subject),
        convergenceProcessDelta: processCounts(subject).map((count, index) => count - processBeforeConvergence[index]),
        convergenceActions: subject.actions.slice(actionBeforeConvergence),
        reasons: subject.requests.filter((entry) => ['graceful', 'terminate'].includes(entry.kind)).map((entry) => entry.request.reasonCode),
      });
      take(await drain().observed);
    }
    const prestopped = makeSubject();
    const prestoppedResource = take(await start(prestopped).observed);
    take(await stop(prestopped, prestoppedResource.resourceId).observed);
    const stopped = take(await stop(prestopped, prestoppedResource.resourceId).observed);
    const prestoppedCounts = processCounts(prestopped);
    const prestoppedActions = prestopped.actions.length;
    const prestoppedClose = result(prestopped, await close(prestopped).observed);
    actual.prestopped = { stopStatus: stopped.status, close: summary(prestoppedClose),
      processUnchanged: JSON.stringify(prestoppedCounts) === JSON.stringify(processCounts(prestopped)),
      actions: prestopped.actions.slice(prestoppedActions) };
    take(await drain().observed);
    const waiting = makeSubject({ waiting: true });
    take(await start(waiting).observed);
    const waitingFirst = result(waiting, await close(waiting).observed);
    const waitingSecond = result(waiting, await close(waiting).observed);
    actual.waiting = { sequence: [summary(waitingFirst), summary(waitingSecond)], counts: processCounts(waiting),
      graceful: waiting.responses.find((entry) => entry.kind === 'observe')?.value.graceful,
      closeCalls: waiting.closes.length };
    take(await drain().observed);
    const noForce = makeSubject({ allowForceTermination: false });
    take(await start(noForce).observed);
    result(noForce, await close(noForce).observed);
    const noForceHold = result(noForce, await close(noForce).observed);
    const noForceWork = work(noForce);
    const noForceRepeat = result(noForce, await close(noForce).observed);
    actual.noForce = { result: summary(noForceHold), sameObject: noForceHold === noForceRepeat,
      noRepeatWork: noForceWork === work(noForce), counts: processCounts(noForce) };
    take(await drain().observed);

    // 5: prove the named failure stages after trusted process absence, including
    // forgery paired with a mutable verifier trap that authentic close must ignore.
    actual.rejections = [];
    for (const mode of ['reject-session', 'forge-child', 'forge-root', 'throw-child', 'empty-forge-root']) {
      const subject = makeSubject({
        rejectSession: mode === 'reject-session', mode: mode === 'empty-forge-root' ? 'forge-root' : mode,
      });
      if (mode !== 'empty-forge-root') {
        take(await start(subject).observed);
        result(subject, await close(subject).observed);
      }
      if (mode === 'forge-child') {
        Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', {
          ...verifierDescriptor,
          value: function () { verifierTrapHits += 1; return true; },
        });
      }
      const held = result(subject, await close(subject).observed);
      const beforeRepeat = work(subject);
      const repeated = result(subject, await close(subject).observed);
      actual.rejections.push({ mode, result: summary(held), sameObject: held === repeated,
        noRepeatWork: beforeRepeat === work(subject), counts: processCounts(subject),
        sessionChecks: subject.sessionChecks,
        closes: subject.closes.map((entry) => [entry.scopeId, entry.status, entry.error]),
      });
      take(await drain().observed);
      Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', verifierDescriptor);
    }

    // 6: preserve the unsorted whole-command action order, including session and scopes.
    const siblings = makeSubject();
    take(await start(siblings, 'close-A').observed);
    take(await start(siblings, 'close-B').observed);
    const siblingSequence = [];
    const siblingBoundaries = [];
    for (let index = 0; index < 4; index += 1) {
      siblingSequence.push(summary(result(siblings, await close(siblings).observed)));
      siblingBoundaries.push(siblings.actions.slice());
    }
    actual.siblings = { sequence: siblingSequence, boundaries: siblingBoundaries,
      sessionChecks: siblings.sessionChecks,
      childOrders: siblings.closes.filter((entry) => entry.scopeId !== 'manager-run-A').map((entry) => entry.order),
      rootLast: siblings.closes[siblings.closes.length - 1]?.scopeId === 'manager-run-A',
    };
    take(await drain().observed);

    // 7: preflight is global and performs no partial sibling work in either order.
    actual.topology = [];
    for (const topology of ['temp', 'plain-temp', 'temp-plain']) {
      const subject = makeSubject();
      const temporaryRoot = commandInput().temporaryRoot;
      if (topology === 'plain-temp') {
        take(await start(subject, 'close-A').observed);
        take(await start(subject, 'close-B', temporaryRoot).observed);
      } else {
        take(await start(subject, 'close-A', temporaryRoot).observed);
        if (topology === 'temp-plain') take(await start(subject, 'close-B').observed);
      }
      const before = work(subject);
      const first = result(subject, await close(subject).observed);
      const repeated = result(subject, await close(subject).observed);
      actual.topology.push({ topology, result: summary(first), noWork: before === work(subject),
        sameObject: first === repeated });
      take(await drain().observed);
    }

    // Cross-record witnesses require global priority passes, in both admission orders.
    actual.priority = [];
    for (const order of ['plain-first', 'temp-first']) {
      const options = {};
      const subject = makeSubject(options);
      if (order === 'temp-first') take(await start(subject, 'close-B', commandInput().temporaryRoot).observed);
      const resource = take(await start(subject, 'close-A').observed);
      if (order === 'plain-first') take(await start(subject, 'close-B', commandInput().temporaryRoot).observed);
      const pending = gate(`priority-observe-${order}`);
      options.observeGate = pending;
      const observingA = invoke('priority-observe-A', () => subject.manager.observe(resource.resourceId));
      const before = work(subject);
      const during = result(subject, await close(subject).observed);
      const liveNoWork = before === work(subject);
      pending.resolve(pending.response);
      const observedA = take(await observingA.observed);
      take(await drain().observed);
      delete options.observeGate;
      const settledBefore = work(subject);
      const terminal = result(subject, await close(subject).observed);
      const repeated = result(subject, await close(subject).observed);
      actual.priority.push({ topology: 'live-plain-plus-temp', order, during: summary(during), liveNoWork,
        settledOperation: observedA.status, terminal: summary(terminal),
        settledNoWork: settledBefore === work(subject), sameObject: terminal === repeated });
      take(await drain().observed);
    }
    for (const order of ['plain-first', 'temp-first']) {
      const options = {};
      const subject = makeSubject(options);
      if (order === 'temp-first') take(await start(subject, 'close-B', commandInput().temporaryRoot).observed);
      const pending = gate(`priority-rejected-start-${order}`);
      options.spawnGate = pending;
      options.rejectSpawn = true;
      const startingA = start(subject, 'close-A');
      const failedStart = auditRejection(`priority-${order}-start`, await startingA.observed);
      take(await drain().observed);
      delete options.spawnGate;
      options.rejectSpawn = false;
      if (order === 'plain-first') take(await start(subject, 'close-B', commandInput().temporaryRoot).observed);
      const before = work(subject);
      const terminal = result(subject, await close(subject).observed);
      const repeated = result(subject, await close(subject).observed);
      actual.priority.push({ topology: 'settled-failed-plain-plus-temp', order, failedStart,
        terminal: summary(terminal), noWork: before === work(subject), sameObject: terminal === repeated });
      take(await drain().observed);
    }

    // 8: live start tokens outrank topology; only an already-issued action settles.
    actual.starts = [];
    for (const stage of ['spawn', 'allocation', 'rejected-spawn']) {
      const options = {};
      const subject = makeSubject(options);
      const pending = gate(stage);
      options[stage === 'allocation' ? 'allocationGate' : 'spawnGate'] = pending;
      options.rejectSpawn = stage === 'rejected-spawn';
      const starting = start(subject, 'close-A', stage === 'allocation' ? commandInput().temporaryRoot : null);
      if (stage === 'rejected-spawn') {
        const startOutcome = auditRejection('rejected-spawn-start', await starting.observed);
        const before = work(subject);
        const held = result(subject, await close(subject).observed);
        const repeated = result(subject, await close(subject).observed);
        actual.starts.push({ stage, start: startOutcome, result: summary(held),
          noWork: before === work(subject), sameObject: held === repeated,
          counts: [subject.fixture.calls.spawnManaged, subject.fixture.calls.allocateTemporaryRoot] });
      } else {
        const before = work(subject);
        const during = result(subject, await close(subject).observed);
        const noWork = before === work(subject);
        const denied = auditRejection(`pending-${stage}-new-start`, await start(subject, 'close-B').observed);
        const admissionNoWork = before === work(subject);
        pending.resolve(pending.response);
        const startedOutcome = await starting.observed;
        const startedValue = stage === 'allocation'
          ? auditRejection('pending-allocation-start-continuation', startedOutcome) : take(startedOutcome);
        const afterStart = work(subject);
        const after = result(subject, await close(subject).observed);
        const settledNoWork = afterStart === work(subject);
        let terminal = after;
        if (stage === 'spawn') terminal = result(subject, await close(subject).observed);
        actual.starts.push({ stage, during: summary(during), noWork, denied, admissionNoWork,
          start: startedValue === 'CONTROLLED_ERROR' ? startedValue : startedValue.status,
          after: summary(after), terminal: summary(terminal), settledNoWork,
          counts: [subject.fixture.calls.spawnManaged, subject.fixture.calls.allocateTemporaryRoot] });
      }
      take(await drain().observed);
    }

    // 9: a real admitted observe token remains live until its issued response settles.
    const observeOptions = {};
    const observing = makeSubject(observeOptions);
    const observedResource = take(await start(observing).observed);
    const observationGate = gate('public-observe');
    observeOptions.observeGate = observationGate;
    const publicObserve = invoke('observe', () => observing.manager.observe(observedResource.resourceId));
    const observeBefore = work(observing);
    const observeClose = result(observing, await close(observing).observed);
    const observeNoWork = observeBefore === work(observing);
    observationGate.resolve(observationGate.response);
    const publicObserved = take(await publicObserve.observed);
    take(await drain().observed);
    delete observeOptions.observeGate;
    const observeNext = result(observing, await close(observing).observed);
    const observeFinal = result(observing, await close(observing).observed);
    actual.observe = { during: summary(observeClose), noWork: observeNoWork, observation: publicObserved.status,
      after: [summary(observeNext), summary(observeFinal)], counts: processCounts(observing) };
    take(await drain().observed);

    // 9-10: while B owns close, globally gate idle A. Reentry Promises are kept
    // synchronously and consumed before awaiting their owning outer invocation.
    const concurrentOptions = { adapterReentry: true };
    const concurrent = makeSubject(concurrentOptions);
    const idleA = take(await start(concurrent, 'close-A').observed);
    take(await start(concurrent, 'close-B').observed);
    const gracefulGate = gate('close-graceful');
    concurrentOptions.gracefulGate = gracefulGate;
    const outer = close(concurrent);
    const concurrentBefore = work(concurrent);
    const second = close(concurrent);
    const busy = result(concurrent, await second.observed);
    const adapterBusy = concurrent.reentries[0]
      ? result(concurrent, await concurrent.reentries[0].observed) : undefined;
    const invalidBusy = auditRejection('busy-close-undefined', await close(concurrent, undefined).observed);
    const invalidBusyObject = auditRejection('busy-close-object', await close(concurrent, hostile).observed);
    const deniedObserve = auditRejection('busy-observe-idle-A', await invoke('observe-idle-A', () => concurrent.manager.observe(idleA.resourceId)).observed);
    const deniedStop = auditRejection('busy-stop-idle-A', await stop(concurrent, idleA.resourceId).observed);
    const deniedStart = auditRejection('busy-new-start', await start(concurrent, 'close-C').observed);
    const gateNoWork = concurrentBefore === work(concurrent);
    const outerStillPending = !outer.settled;
    gracefulGate.resolve(gracefulGate.response);
    const outerValue = result(concurrent, await outer.observed);
    take(await drain().observed);
    delete concurrentOptions.gracefulGate;
    concurrentOptions.adapterReentry = false;
    const resolverEntered = gate('resolver-reentry-entered');
    concurrentOptions.resolverReentry = resolverEntered;
    const convergence = close(concurrent);
    concurrentOptions.outerConvergence = convergence;
    // If the target stage is skipped, release the rendezvous when the outer call
    // settles so the aggregate records missing reentry instead of hanging forever.
    track('resolver-or-outer-settlement', convergence.promise.then(
      () => { concurrent.resolverSettlement.order.push('outer'); resolverEntered.resolve(false); },
      () => { concurrent.resolverSettlement.order.push('outer-rejected'); resolverEntered.resolve(false); },
    ));
    take(await resolverEntered.entry.observed);
    const resolverBusy = concurrent.reentries[1]
      ? result(concurrent, await concurrent.reentries[1].observed) : undefined;
    const convergenceValue = result(concurrent, await convergence.observed);
    take(await drain().observed);
    delete concurrentOptions.resolverReentry;
    delete concurrentOptions.outerConvergence;
    const earlierFirst = result(concurrent, await close(concurrent).observed);
    const earlierFinal = result(concurrent, await close(concurrent).observed);
    actual.concurrent = {
      busy: summary(busy), adapterBusy: summary(adapterBusy), resolverBusy: summary(resolverBusy),
      sharedBusy: busy === adapterBusy && busy === resolverBusy,
      invalidBusy, invalidBusyObject, deniedObserve, deniedStop, deniedStart,
      gateNoWork, outerStillPending, getterHits,
      sequence: [summary(outerValue), summary(convergenceValue), summary(earlierFirst), summary(earlierFinal)],
      counts: processCounts(concurrent), reentryCount: concurrent.reentries.length,
      resolverSettlement: concurrent.resolverSettlement,
    };
    take(await drain().observed);

    const isolated = makeSubject();
    const isolatedResource = take(await start(isolated).observed);
    Object.defineProperty(TaskResourceManager.prototype, 'stop', {
      ...stopDescriptor,
      value: function () { stopTrapHits += 1; throw new Error(rawMarker); },
    });
    const isolatedFirst = result(isolated, await close(isolated).observed);
    const isolatedFinal = result(isolated, await close(isolated).observed);
    take(await drain().observed);
    Object.defineProperty(TaskResourceManager.prototype, 'stop', stopDescriptor);
    const isolatedBefore = work(isolated);
    const afterCloseStart = auditRejection('closed-start', await start(isolated, 'close-B').observed);
    const afterCloseObserve = auditRejection('closed-observe', await invoke('observe-closed', () => isolated.manager.observe(isolatedResource.resourceId)).observed);
    const afterCloseStop = auditRejection('closed-stop', await stop(isolated, isolatedResource.resourceId).observed);
    actual.isolation = { sequence: [summary(isolatedFirst), summary(isolatedFinal)],
      counts: processCounts(isolated), stopTrapHits, verifierTrapHits,
      afterCloseStart, afterCloseObserve, afterCloseStop, noWork: isolatedBefore === work(isolated) };
    take(await drain().observed);

    // 11: a deliberately rejected adapter Promise is contained as a terminal
    // manager HOLD. Other fixture/programming exceptions are retained and rethrown.
    const rejectedOptions = { rejectGraceful: true };
    const rejected = makeSubject(rejectedOptions);
    take(await start(rejected).observed);
    rejectedOptions.gracefulGate = gate('rejected-graceful');
    const rejectedFirst = result(rejected, await close(rejected).observed);
    const rejectedBefore = work(rejected);
    const rejectedAgain = result(rejected, await close(rejected).observed);
    actual.rejected = { result: summary(rejectedFirst), sameObject: rejectedFirst === rejectedAgain,
      noRepeatWork: rejectedBefore === work(rejected), counts: processCounts(rejected) };
    take(await drain().observed);

    const auditPublic = ({ subject, value }) => {
      const decision = data(value, 'decision');
      const reasons = data(decision, 'reasons');
      const ownKeysEqual = (object, expected) => object !== null && typeof object === 'object'
        && JSON.stringify(Reflect.ownKeys(object)) === JSON.stringify(expected)
        && Reflect.ownKeys(object).every((key) => typeof key === 'string');
      const descriptors = (object, keys) => object !== null && typeof object === 'object'
        && keys.every((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          return descriptor && Object.hasOwn(descriptor, 'value') && !descriptor.writable
            && !descriptor.configurable && descriptor.enumerable === (key !== 'length');
        });
      const privateStrings = [
        'U35A_PRIVATE_RAW_FAILURE', 'TRACKER_HISTORY_LIMIT_REACHED',
        'close-A', 'close-B', 'close-C', 'command:close-A', 'command:close-B',
        'command:close-A:process-tree', 'command:close-A:session', 'command:close-A:temporary',
        'command:close-B:process-tree', 'command:close-B:session', 'command:close-B:temporary',
        'owner-A', 'run-3-1', 'session-A', 'manager-run-A', 'adapter-A', 'producer-A', 'harness-A',
        'node.exe', '--version', 'task-resource-cwd', 'task-resource-temporary-parent', 'task-resource-data',
        '2026-09-04T01:00:00Z', '134167428000000000', '0x0000000000001234',
        'authority:', 'evidence:', 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64),
        'manager_close', 'user_requested', computeDetachedSha256(authorization(true)),
        computeDetachedSha256(authorization(false)),
      ];
      // Dynamic sentinels come from independent fake requests, never public output.
      for (const { request } of subject.requests) {
        for (const marker of [request.requestSha256, request.spawnRequestSha256, request.gracefulRequestSha256,
          request.observationRequestSha256, request.terminalActionRequestSha256, request.expectedIdentitySha256,
          request.launchNonce, request.allocationId, request.creationNonce, request.cwd, request.temporaryRoot]) {
          if (typeof marker === 'string') privateStrings.push(marker);
        }
        if (request.expectedIdentity) privateStrings.push(computeDetachedSha256(request.expectedIdentity));
      }
      let noPrivateValues = true;
      let deepFrozenData = true;
      const seen = new Set();
      const scan = (candidate) => {
        if (typeof candidate === 'string' && privateStrings.some((marker) => candidate.includes(marker))) noPrivateValues = false;
        if (typeof candidate === 'number' && candidate === 41002) noPrivateValues = false;
        if (typeof candidate === 'symbol' && privateStrings.some((marker) => String(candidate).includes(marker))) noPrivateValues = false;
        if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function') || seen.has(candidate)) return;
        seen.add(candidate);
        if (!Object.isFrozen(candidate)) deepFrozenData = false;
        for (const key of Reflect.ownKeys(candidate)) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!Object.hasOwn(descriptor, 'value')) deepFrozenData = false;
          else scan(descriptor.value);
        }
      };
      scan(value);
      const expectedAction = {
        CLOSE_ATTEMPT_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'],
        COMMAND_OPERATION_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'],
        COMMAND_STOP_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'],
        COMMANDS_REMAINING: ['CLOSING', 'WAIT_BOUNDED'],
        TEMPORARY_CLEANUP_UNAVAILABLE: ['HOLD', 'HOLD'],
        COMMAND_START_INCOMPLETE: ['HOLD', 'HOLD'], COMMAND_STATE_INVALID: ['HOLD', 'HOLD'],
        COMMAND_STOP_HOLD: ['HOLD', 'HOLD'], COMMAND_SESSION_RELEASE_REJECTED: ['HOLD', 'HOLD'],
        COMMAND_SCOPE_CLOSE_REJECTED: ['HOLD', 'HOLD'], ROOT_SCOPE_CLOSE_REJECTED: ['HOLD', 'HOLD'],
        ALL_RESOURCES_RELEASED: ['CLOSED', 'CLOSE_COMPLETE'], CLOSE_INTERNAL_HOLD: ['HOLD', 'HOLD'],
      }[data(reasons, '0')];
      return ownKeysEqual(value, ['status', 'decision'])
        && ownKeysEqual(decision, ['action', 'reasons', 'action_authorized'])
        && ownKeysEqual(reasons, ['0', 'length'])
        && descriptors(value, ['status', 'decision'])
        && descriptors(decision, ['action', 'reasons', 'action_authorized'])
        && descriptors(reasons, ['0', 'length'])
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.getPrototypeOf(decision) === Object.prototype
        && Object.getPrototypeOf(reasons) === Array.prototype
        && deepFrozenData && noPrivateValues && expectedAction !== undefined
        && data(value, 'status') === expectedAction[0] && data(decision, 'action') === expectedAction[1]
        && data(decision, 'action_authorized') === false;
    };
    actual.containment = {
      allPublicResultsAudited: publicResults.length > 0 && publicResults.every(auditPublic),
      coversEveryPublicStatus: ['CLOSING', 'HOLD', 'CLOSED'].every((status) => publicResults.some(({ value }) => data(value, 'status') === status)),
      coversBusy: publicResults.some(({ value }) => summary(value) === 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS'),
      allResolverContextsValid: subjects.every((subject) => subject.resolverChecks.every(Boolean)),
      allSessionObservationsValid: subjects.every((subject) => subject.sessionChecks.every(Boolean)),
      noNewLaunchAfterClose: subjects.every((subject) => JSON.stringify(subject.closeAdmissionCounters)
        === JSON.stringify([subject.fixture.calls.probeCapabilities, subject.fixture.calls.spawnManaged,
          subject.fixture.calls.allocateTemporaryRoot])),
      noFakeStateMutationAfterClose: subjects.every((subject) => subject.closeAdmissionFakeState === JSON.stringify(subject.fakeState)),
      fakeCleanupNeverCalled: subjects.every((subject) => ['quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent']
        .every((name) => subject.fixture.calls[name] === 0)),
      getterHits,
    };
  } finally {
    for (const control of controls) {
      if (!control.entry.settled) control.reject(new Error(rawMarker));
    }
    take(await drain().observed);
    Object.defineProperty(TaskResourceManager.prototype, 'stop', stopDescriptor);
    Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', verifierDescriptor);
    for (const { prototype, name, descriptor } of saved) Object.defineProperty(prototype, name, descriptor);
  }
  if (harnessErrors.length) throw harnessErrors[0];
  for (const entry of promiseLedger) {
    if (entry.outcome?.kind === 'error'
      && !(entry.outcome.error instanceof TaskResourceManagerError)
      && !(entry.permittedRawFailure && entry.outcome.error.message === rawMarker)) throw entry.outcome.error;
  }
  actual.promiseContainment = {
    pending: promiseLedger.filter((entry) => !entry.settled).length,
    allObserved: promiseLedger.every((entry) => entry.observed instanceof Promise),
    allControlsSettled: controls.every((control) => control.entry.settled),
    descriptorsRestored: saved.every(({ prototype, name, descriptor }) => {
      const restored = Object.getOwnPropertyDescriptor(prototype, name);
      return restored.value === descriptor.value && restored.enumerable === descriptor.enumerable
        && restored.configurable === descriptor.configurable && restored.writable === descriptor.writable;
    }) && Object.getOwnPropertyDescriptor(TaskResourceManager.prototype, 'stop').value === stopDescriptor.value
      && Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'verifyCloseResult').value === verifierDescriptor.value,
  };
  actual.closeAggregateReached = true;
  actual.rejectionAudits = rejectionAudits;
  assert.deepStrictEqual(actual, {
    authority: { arity: 0, invalidUndefined: 'CONTROLLED_ERROR', invalidObject: 'CONTROLLED_ERROR',
      invalidReceiver: 'CONTROLLED_ERROR', authorityNoWork: true, terminalArgument: 'CONTROLLED_ERROR',
      terminalUndefined: 'CONTROLLED_ERROR', terminalStart: 'CONTROLLED_ERROR', terminalNoWork: true, getterHits: 0 },
    empty: { first: 'CLOSED/ALL_RESOURCES_RELEASED', sameObject: true,
      counters: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], resolvers: [0, 0],
      scopeMethods: ['close'], trackerMethods: ['openRootScope'],
      closes: [{ scopeId: 'manager-run-A', reason: 'manager_close', delegated: true, status: 'CLOSED', order: [], error: null }] },
    history: { first: 'HOLD/ROOT_SCOPE_CLOSE_REJECTED', sameObject: true, noRepeatWork: true,
      closes: [{ scopeId: 'manager-run-A', reason: 'manager_close', delegated: true, status: null, order: null, error: 'TRACKER_HISTORY_LIMIT_REACHED' }] },
    force: { sequence: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSED/ALL_RESOURCES_RELEASED', 'CLOSED/ALL_RESOURCES_RELEASED'],
      firstCounts: [1, 0, 0, 0], finalCounts: [1, 1, 1, 1], sameObject: true, noRepeatWork: true,
      actions: ['graceful:close-A', 'observe:close-A', 'terminate:close-A', 'absence:close-A', 'session:close-A', 'child:close-A', 'root'],
      sessionChecks: [true],
      closes: [
        { scopeId: 'command:close-A', reason: 'manager_close', delegated: true, status: 'CLOSED', order: ['command:close-A:process-tree', 'command:close-A:session'], error: null },
        { scopeId: 'manager-run-A', reason: 'manager_close', delegated: true, status: 'CLOSED', order: ['command:close-A:process-tree', 'command:close-A:session'], error: null },
      ], terminationAuthority: [true] },
    existingStop: [
      { stage: 'graceful', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, stopStatus: 'STOP_REQUESTED',
        after: 'CLOSED/ALL_RESOURCES_RELEASED', counts: [1, 1, 1, 1], convergenceProcessDelta: [0, 1, 1, 1],
        convergenceActions: ['observe:close-A', 'terminate:close-A', 'absence:close-A', 'session:close-A', 'child:close-A', 'root'],
        reasons: ['user_requested', 'user_requested'] },
      { stage: 'observe', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, stopStatus: 'STOPPED',
        after: 'CLOSED/ALL_RESOURCES_RELEASED', counts: [1, 1, 1, 1], convergenceProcessDelta: [0, 0, 0, 0],
        convergenceActions: ['session:close-A', 'child:close-A', 'root'], reasons: ['user_requested', 'user_requested'] },
    ],
    prestopped: { stopStatus: 'STOPPED', close: 'CLOSED/ALL_RESOURCES_RELEASED', processUnchanged: true,
      actions: ['session:close-A', 'child:close-A', 'root'] },
    waiting: { sequence: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSING/COMMAND_STOP_IN_PROGRESS'], counts: [1, 1, 0, 0],
      graceful: { requested: true, deadlineReached: false, exitObserved: false }, closeCalls: 0 },
    noForce: { result: 'HOLD/COMMAND_STOP_HOLD', sameObject: true, noRepeatWork: true, counts: [1, 1, 0, 0] },
    rejections: [
      { mode: 'reject-session', result: 'HOLD/COMMAND_SESSION_RELEASE_REJECTED', sameObject: true, noRepeatWork: true,
        counts: [1, 1, 1, 1], sessionChecks: [true], closes: [] },
      { mode: 'forge-child', result: 'HOLD/COMMAND_SCOPE_CLOSE_REJECTED', sameObject: true, noRepeatWork: true,
        counts: [1, 1, 1, 1], sessionChecks: [true], closes: [['command:close-A', 'FORGED', null]] },
      { mode: 'forge-root', result: 'HOLD/ROOT_SCOPE_CLOSE_REJECTED', sameObject: true, noRepeatWork: true,
        counts: [1, 1, 1, 1], sessionChecks: [true], closes: [['command:close-A', 'CLOSED', null], ['manager-run-A', 'FORGED', null]] },
      { mode: 'throw-child', result: 'HOLD/COMMAND_SCOPE_CLOSE_REJECTED', sameObject: true, noRepeatWork: true,
        counts: [1, 1, 1, 1], sessionChecks: [true], closes: [['command:close-A', null, 'U35A_PRIVATE_RAW_FAILURE']] },
      { mode: 'empty-forge-root', result: 'HOLD/ROOT_SCOPE_CLOSE_REJECTED', sameObject: true, noRepeatWork: true,
        counts: [0, 0, 0, 0], sessionChecks: [], closes: [['manager-run-A', 'FORGED', null]] },
    ],
    siblings: { sequence: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSING/COMMANDS_REMAINING', 'CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSED/ALL_RESOURCES_RELEASED'],
      boundaries: [
        ['graceful:close-B'],
        ['graceful:close-B', 'observe:close-B', 'terminate:close-B', 'absence:close-B', 'session:close-B', 'child:close-B'],
        ['graceful:close-B', 'observe:close-B', 'terminate:close-B', 'absence:close-B', 'session:close-B', 'child:close-B', 'graceful:close-A'],
        ['graceful:close-B', 'observe:close-B', 'terminate:close-B', 'absence:close-B', 'session:close-B', 'child:close-B', 'graceful:close-A',
          'observe:close-A', 'terminate:close-A', 'absence:close-A', 'session:close-A', 'child:close-A', 'root'],
      ], sessionChecks: [true, true],
      childOrders: [['command:close-B:process-tree', 'command:close-B:session'], ['command:close-A:process-tree', 'command:close-A:session']], rootLast: true },
    topology: [
      { topology: 'temp', result: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', noWork: true, sameObject: true },
      { topology: 'plain-temp', result: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', noWork: true, sameObject: true },
      { topology: 'temp-plain', result: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', noWork: true, sameObject: true },
    ],
    priority: [
      { topology: 'live-plain-plus-temp', order: 'plain-first', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', liveNoWork: true,
        settledOperation: 'OBSERVED', terminal: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', settledNoWork: true, sameObject: true },
      { topology: 'live-plain-plus-temp', order: 'temp-first', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', liveNoWork: true,
        settledOperation: 'OBSERVED', terminal: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', settledNoWork: true, sameObject: true },
      { topology: 'settled-failed-plain-plus-temp', order: 'plain-first', failedStart: 'CONTROLLED_ERROR',
        terminal: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', noWork: true, sameObject: true },
      { topology: 'settled-failed-plain-plus-temp', order: 'temp-first', failedStart: 'CONTROLLED_ERROR',
        terminal: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', noWork: true, sameObject: true },
    ],
    starts: [
      { stage: 'spawn', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, denied: 'CONTROLLED_ERROR', admissionNoWork: true,
        start: 'STARTED', after: 'CLOSING/COMMAND_STOP_IN_PROGRESS', terminal: 'CLOSED/ALL_RESOURCES_RELEASED', settledNoWork: false, counts: [1, 0] },
      { stage: 'allocation', during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, denied: 'CONTROLLED_ERROR', admissionNoWork: true,
        start: 'CONTROLLED_ERROR', after: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', terminal: 'HOLD/TEMPORARY_CLEANUP_UNAVAILABLE', settledNoWork: true, counts: [0, 1] },
      { stage: 'rejected-spawn', start: 'CONTROLLED_ERROR', result: 'HOLD/COMMAND_START_INCOMPLETE', noWork: true, sameObject: true, counts: [1, 0] },
    ],
    observe: { during: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, observation: 'OBSERVED',
      after: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSED/ALL_RESOURCES_RELEASED'], counts: [1, 2, 1, 1] },
    concurrent: { busy: 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS', adapterBusy: 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS',
      resolverBusy: 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS', sharedBusy: true,
      invalidBusy: 'CONTROLLED_ERROR', invalidBusyObject: 'CONTROLLED_ERROR', deniedObserve: 'CONTROLLED_ERROR',
      deniedStop: 'CONTROLLED_ERROR', deniedStart: 'CONTROLLED_ERROR', gateNoWork: true, outerStillPending: true, getterHits: 0,
      sequence: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSING/COMMANDS_REMAINING', 'CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSED/ALL_RESOURCES_RELEASED'],
      counts: [2, 2, 2, 2], reentryCount: 2, resolverSettlement: { order: ['busy', 'outer'], outerPendingAtBusy: [true] } },
    isolation: { sequence: ['CLOSING/COMMAND_STOP_IN_PROGRESS', 'CLOSED/ALL_RESOURCES_RELEASED'], counts: [1, 1, 1, 1],
      stopTrapHits: 0, verifierTrapHits: 0, afterCloseStart: 'CONTROLLED_ERROR', afterCloseObserve: 'CONTROLLED_ERROR',
      afterCloseStop: 'CONTROLLED_ERROR', noWork: true },
    rejected: { result: 'HOLD/COMMAND_STOP_HOLD', sameObject: true, noRepeatWork: true, counts: [1, 0, 0, 0] },
    containment: { allPublicResultsAudited: true, coversEveryPublicStatus: true, coversBusy: true,
      allResolverContextsValid: true, allSessionObservationsValid: true, noNewLaunchAfterClose: true,
      noFakeStateMutationAfterClose: true, fakeCleanupNeverCalled: true, getterHits: 0 },
    promiseContainment: { pending: 0, allObserved: true, allControlsSettled: true, descriptorsRestored: true },
    closeAggregateReached: true,
    rejectionAudits: [
      { label: 'close-undefined', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'close-object', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'close-surrogate', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'terminal-close-object', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'terminal-close-undefined', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'terminal-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'priority-plain-first-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'priority-temp-first-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'pending-spawn-new-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'pending-allocation-new-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'pending-allocation-start-continuation', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'rejected-spawn-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'busy-close-undefined', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'busy-close-object', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'busy-observe-idle-A', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'busy-stop-idle-A', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'busy-new-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'closed-start', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'closed-observe', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
      { label: 'closed-stop', kind: 'error', rejected: true, managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
    ],
  });
});

// Unit 3-5B: memory-only host evidence; all safety decisions use real modules.
function u35bCopy(value) { return JSON.parse(JSON.stringify(value)); }
function u35bHash(value) { return computeDetachedSha256(createDetachedJsonSnapshot(value).snapshot); }
function u35bPolicy(policyId, kind, values, extra = {}) {
  const policy = { policy_id: policyId, kind, source_kind: 'synthetic_test_fixture',
    observed_at: '2026-09-05T00:00:00Z', values, evidence_refs: [EVIDENCE_REF], ...extra };
  return { ...policy, source_sha256: u35bHash(policy) };
}
function u35bTemporary(request, options = {}) {
  const platform = request.provenance.platform;
  const flavor = platform === 'windows' ? path.win32 : path.posix;
  const nativeKey = platform === 'windows' ? 'windows_file_identity' : 'linux_file_identity';
  const parentNative = platform === 'windows' ? { volume_serial_number: 'u35b-volume', file_id: 'u35b-parent' } : { device_id: 'u35b-device', inode: 9001 };
  const taskNative = platform === 'windows' ? { volume_serial_number: 'u35b-volume', file_id: `u35b-${request.commandId}` } : { device_id: 'u35b-device', inode: 9002 };
  const taskPath = options.deep ? flavor.join(request.temporaryRoot, 'nested', request.allocationId) : flavor.join(request.temporaryRoot, request.allocationId);
  const manifest = {
    owner_id: request.provenance.ownerId, run_id: request.provenance.runId, session_id: request.provenance.sessionId,
    lease_generation: request.provenance.managerGeneration,
    canonical_root_identity: { canonical_path: request.temporaryRoot, path_identity_hash: '1'.repeat(64), parent_identity_hash: '2'.repeat(64), platform: platform === 'windows' ? 'win32' : 'linux' },
    created_at: '2026-09-05T00:00:00Z', quota_profile_ref: 'u35b-quota', watermark_policy_ref: 'u35b-watermark',
    child_sublease_map: { [request.resourceIds.commandSession]: {
      owner_id: request.resourceIds.commandSession, canonical_descendant: taskPath, nonce: request.creationNonce,
      lease_generation: request.provenance.managerGeneration, soft_quota: 524288, hard_quota: 1048576, teardown_condition: 'allocation_absence_verified',
    } }, retention_set: [], state: 'QUIESCING',
  };
  // Negative manifest payloads are changed before allocation-time digest binding.
  if (options.manifest) options.manifest(manifest, request);
  manifest.manifest_sha256 = u35bHash(manifest);
  const identity = {
    schema: 'TemporaryAllocationIdentity2', schema_version: 2, platform, allocation_id: request.allocationId,
    owner_id: request.provenance.ownerId, run_id: request.provenance.runId, session_id: request.provenance.sessionId,
    lease_generation: request.provenance.managerGeneration, child_id: request.resourceIds.commandSession,
    manifest_sha256: manifest.manifest_sha256, canonical_root: request.temporaryRoot,
    task_directory: { path: taskPath, [nativeKey]: taskNative },
    confirmed_parent_directory: { path: request.temporaryRoot, [nativeKey]: parentNative },
    quota: { unit: 'bytes', limit: 1048576 }, creation_nonce: request.creationNonce, [nativeKey]: parentNative,
  };
  const policyIndex = {
    'u35b-quota': u35bPolicy('u35b-quota', 'quota', { soft_quota: 524288, hard_quota: 1048576 }),
    'u35b-watermark': u35bPolicy('u35b-watermark', 'watermark', { low_watermark: 4096, critical_watermark: 1024 }),
  };
  const observation = {
    owner_id: manifest.owner_id, run_id: manifest.run_id, session_id: manifest.session_id, lease_generation: manifest.lease_generation,
    canonical_root_identity: u35bCopy(manifest.canonical_root_identity), child_path: taskPath,
    usage: 64, available: 65536, ttl_expired: false, active_handles: 0, quiescent: true, identity_observed: true,
    reparse_boundary: false, path_rebound: false, retention_set_sealed: true,
    // A deliberately missing manifest retention field still receives a valid
    // independently observed empty-set hash, so contracts see the missing field.
    retention_set_hash: u35bHash(Object.hasOwn(manifest, 'retention_set') ? manifest.retention_set : []),
    teardown_condition_met: true, precheck_identity_hash: '1'.repeat(64), postcheck_identity_hash: '1'.repeat(64),
  };
  return { identity, manifest, policyIndex, observation, nativeKey };
}
function u35bProcess(request) {
  const identity = processIdentityFor(request);
  if (request.provenance.platform === 'linux') {
    delete identity.windows_identity;
    identity.linux_identity = { proc_start_ticks: 9001, boot_id_sha256: '3'.repeat(64), process_group_id: 41002,
      os_session_id: 41002, executable_device_id: 'u35b-device', executable_inode: 9003 };
  }
  return identity;
}

test('close V2 aggregates trusted temporary reclaim, exact action binding, and terminal containment', async () => {
  const { ResourceScope, TaskResourceTracker } = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');
  const actual = {}; const expected = {};
  const record = (label, value, literal) => { actual[label] = value; expected[label] = literal; };
  const same = (a, b) => canonicalizeDetachedSnapshot(createDetachedJsonSnapshot(a).snapshot) === canonicalizeDetachedSnapshot(createDetachedJsonSnapshot(b).snapshot);
  const methods = ['probeCapabilities', 'spawnManaged', 'observeProcess', 'requestGracefulStop', 'terminateOwnedTree',
    'verifyProcessAbsent', 'allocateTemporaryRoot', 'observeTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent'];
  const tempMethods = ['observeTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent'];
  const scopeMethods = ['openChild', 'register', 'bind', 'observe', 'confirmRelease', 'confirmRetention', 'close', 'getResource'];
  const trackerMethods = ['openRootScope', 'claimTaskScope', 'consumeTaskCloseResult'];
  const savedTracker = [];
  const saved = []; const promises = []; const controls = []; const subjects = []; const publicResults = []; const fixtureErrors = [];
  const rawMarker = 'U35B_PRIVATE_ADAPTER_ERROR';
  const authenticClose = TaskResourceManager.prototype.close;
  const stopDescriptor = Object.getOwnPropertyDescriptor(TaskResourceManager.prototype, 'stop');
  const verifierDescriptor = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'verifyCloseResult');
  let active = null; let getterHits = 0; let forgedVerifierHits = 0; let forgedStopHits = 0;
  const track = (label, operation) => {
    let promise;
    try { promise = Promise.resolve(operation()); } catch (error) { promise = Promise.reject(error); }
    const entry = { label, promise, settled: false, outcome: null };
    entry.observed = promise.then(
      (value) => { entry.settled = true; entry.outcome = { kind: 'value', value }; return entry.outcome; },
      (error) => { entry.settled = true; entry.outcome = { kind: 'error', error }; return entry.outcome; });
    promises.push(entry); return entry;
  };
  const value = (outcome) => { if (outcome.kind === 'error') throw outcome.error; return outcome.value; };
  const rejection = (outcome) => ({ kind: outcome.kind,
    managerError: outcome.kind === 'error' && outcome.error instanceof TaskResourceManagerError,
    code: outcome.kind === 'error' ? outcome.error.code : null });
  const close = (subject) => track('close', () => Reflect.apply(authenticClose, subject.manager, []));
  const readClose = async (entry) => { const result = value(await entry.observed); publicResults.push(result); return result; };
  const data = (object, key) => {
    if (object === null || typeof object !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const summary = (result) => {
    const status = data(result, 'status'); const reason = data(data(data(result, 'decision'), 'reasons'), '0');
    return `${typeof status === 'string' ? status : 'INVALID_STATUS'}/${typeof reason === 'string' ? reason : 'INVALID_REASON'}`;
  };
  const snapshot = (subject) => JSON.stringify({ calls: subject.calls, trust: subject.trust, scope: subject.scopeLog,
    state: [...subject.hostState.entries()], close: subject.closeLog, requests: subject.requests,
    receipts: subject.receipts, requestChecks: subject.requestChecks, trustChecks: subject.trustChecks,
    bindings: subject.bindings, releases: subject.releases, accepted: [...subject.accepted.entries()],
    fresh: [...subject.fresh.entries()], reclaim: [...subject.reclaim.entries()], absence: [...subject.absence.entries()],
    tracker: subject.trackerLog, trustOutcomes: subject.trustOutcomes });
  const counts = (subject) => tempMethods.map((method) => subject.calls[method]);
  const guard = (operation) => { try { return operation(); } catch (error) { if (error.message !== rawMarker) fixtureErrors.push(error); throw error; } };
  const makeControl = () => {
    let resolve; const promise = new Promise((yes) => { resolve = yes; }); const tracked = track('gate', () => promise);
    const control = { promise, resolve, tracked, response: undefined }; controls.push(control); return control;
  };
  const observeEntryOrOwner = (owner, entered) => track('entry-or-owner', () => owner.promise.then(
    () => { entered.resolve({ kind: 'owner-settled-before-entry', outcomeKind: 'value' }); },
    () => { entered.resolve({ kind: 'owner-settled-before-entry', outcomeKind: 'error' }); },
  ));
  const reenter = (subject, label) => {
    if (subject.options.reentry !== label || subject.reentries.length !== 0) return;
    const before = snapshot(subject); const nested = close(subject); const noWork = before === snapshot(subject);
    subject.reentries.push(nested);
    track('busy-settlement', () => nested.promise.then(
      (result) => {
        const outerPending = subject.outer !== undefined && !subject.outer.settled;
        subject.settlementOrder.push('busy');
        subject.busy.push({ result: summary(result), outerPending, noWork });
        return result;
      },
      (error) => { subject.settlementOrder.push('busy-rejected'); throw error; },
    ));
  };
  const make = (options = {}) => {
    const subject = { options, calls: Object.fromEntries(methods.map((method) => [method, 0])), trust: [], scopeLog: [], closeLog: [],
      actionLog: [], events: [], requests: [], receipts: [], allocations: new Map(), processes: new Map(), hostState: new Map(),
      fresh: new Map(), accepted: new Map(), reclaim: new Map(), absence: new Map(), reentries: [], busy: [],
      requestChecks: [], trustChecks: [], trustOutcomes: [], trackerLog: [], settlementOrder: [], bindings: [], releases: [], manager: null };
    subjects.push(subject);
    const platform = process.platform === 'win32' ? 'windows' : 'linux';
    const inputAuthorization = authorization(true); const envelope = capabilityEnvelope(inputAuthorization);
    envelope.provenance.platform = platform; envelope.supportMatrix.platform = platform;
    for (const claim of ['resource_observation', 'request_shutdown', 'process_tree_terminate']) envelope.supportMatrix.claims[claim] = { state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] };
    if (options.capability) options.capability(envelope);
    const baseReceipt = (request) => ({ identity: u35bProcess(request), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 });
    const association = (candidate, context) => {
      const matching = subject.receipts.findLast((entry) => same(entry.receipt, candidate));
      if (matching) {
        const filesystem = ['allocateTemporaryRoot', ...tempMethods].includes(matching.method);
        const correctChannel = context.resolutionType === (filesystem ? 'filesystem' : 'observation');
        if (matching.method === 'observeTemporaryRoot') {
          const allocation = subject.allocations.get(matching.request.commandId);
          // This authenticates exact issued evidence, including truthful unsafe
          // facts. Only manager validation decides whether those facts are safe.
          const sound = correctChannel && allocation
            && same(matching.request.expectedIdentity, allocation.identity)
            && matching.request.resourceId === `command:${matching.request.commandId}:temporary`
            && matching.request.scopeId === `command:${matching.request.commandId}`
            && matching.request.expectedIdentitySha256 === u35bHash(allocation.identity)
            && matching.request.requestSha256 === recomputeRequestSha256(matching.request)
            && subject.fresh.get(matching.request.commandId) === matching.request.operationNonce
            && candidate.requestSha256 === matching.request.requestSha256 && subject.hostState.get(matching.request.commandId) === 'allocated';
          if (sound) subject.accepted.set(matching.request.commandId, u35bCopy(candidate)); return sound;
        }
        if (matching.method === 'verifyTemporaryAbsent') {
          const allocation = subject.allocations.get(matching.request.commandId);
          const sound = correctChannel && !!allocation && same(matching.request.expectedIdentity, allocation.identity)
            && matching.request.resourceId === `command:${matching.request.commandId}:temporary`
            && matching.request.scopeId === `command:${matching.request.commandId}`
            && matching.request.expectedIdentitySha256 === u35bHash(allocation.identity)
            && matching.request.requestSha256 === recomputeRequestSha256(matching.request)
            && candidate.requestSha256 === matching.request.requestSha256;
          if (sound) subject.absence.set(matching.request.commandId, u35bCopy(candidate)); return sound;
        }
        if (tempMethods.includes(matching.method)) {
          const allocation = subject.allocations.get(matching.request.commandId);
          return correctChannel && !!allocation && same(matching.request.expectedIdentity, allocation.identity)
            && matching.request.resourceId === `command:${matching.request.commandId}:temporary`
            && matching.request.scopeId === `command:${matching.request.commandId}`
            && matching.request.expectedIdentitySha256 === u35bHash(allocation.identity)
            && matching.request.requestSha256 === recomputeRequestSha256(matching.request)
            && candidate.requestSha256 === matching.request.requestSha256;
        }
        return correctChannel;
      }
      if (candidate.purpose === 'temporary_reclaim' && context.resolutionType === 'filesystem') {
        const entry = [...subject.accepted.entries()].find(([, receipt]) => receipt.manifest.manifest_sha256 === candidate.context.manifest_sha256);
        if (!entry) return false; const [commandId, receipt] = entry;
        return same(candidate.record, receipt.observation) && same(candidate.context, {
          manifest_sha256: receipt.manifest.manifest_sha256, canonical_root_identity: receipt.manifest.canonical_root_identity,
          child_id: receipt.identity.child_id, child_path: receipt.identity.task_directory.path }) && subject.fresh.has(commandId);
      }
      if (candidate.purpose === 'temporary_reclaim' && context.resolutionType === 'observation') {
        const commandId = candidate.resource.scopeId.slice('command:'.length); const receipt = subject.accepted.get(commandId);
        const allocation = subject.allocations.get(commandId);
        const sound = receipt && allocation && same(candidate.resource.identity, allocation.identity) && candidate.resource.boundGeneration === 1
          && candidate.resource.resourceId === `command:${commandId}:temporary` && candidate.resource.ownerId === 'owner-A'
          && candidate.ownerId === 'owner-A' && candidate.runId === 'run-3-1' && candidate.generation === 1
          && same(candidate.observation, { manifest: receipt.manifest, policyIndex: receipt.policyIndex, child_id: receipt.identity.child_id,
            intent: 'reclaim', observation: receipt.observation }) && candidate.decision.action === 'RECLAIM_EXACT';
        if (sound) subject.reclaim.set(commandId, u35bCopy(candidate.decision)); return sound;
      }
      if (candidate.purpose === 'temporary_absence' && context.resolutionType === 'observation') {
        const commandId = candidate.resource.scopeId.slice('command:'.length); const receipt = subject.absence.get(commandId); const allocation = subject.allocations.get(commandId);
        return !!receipt && !!allocation && same(candidate.resource.identity, allocation.identity) && candidate.resource.boundGeneration === 1
          && candidate.resource.resourceId === `command:${commandId}:temporary` && candidate.resource.ownerId === 'owner-A'
          && candidate.ownerId === 'owner-A' && candidate.runId === 'run-3-1' && candidate.generation === 1
          && same(candidate.observation, { identity: allocation.identity, generation: 1, absenceVerified: true, evidenceRefs: receipt.evidenceRefs })
          && subject.hostState.get(commandId) === 'removed';
      }
      if (candidate.purpose === 'process_recovery' && context.resolutionType === 'observation') {
        const identity = subject.processes.get(candidate.resource.scopeId.slice('command:'.length));
        return !!identity && same(candidate.resource.identity, identity) && same(candidate.observation.expected_identity, identity) && same(candidate.observation.observed_identity, identity);
      }
      return false;
    };
    const producer = (candidate, context) => guard(() => {
      if (!context.resolutionType) return same(candidate, envelope) && context.authorizationSha256 === u35bHash(inputAuthorization);
      const label = candidate.type || `${context.resolutionType}:${candidate.purpose}`; subject.trust.push(label);
      const producingReceipt = subject.receipts.findLast((entry) => same(entry.receipt, candidate));
      subject.events.push({ kind: 'trust', label, resourceId: candidate.resource?.resourceId || null,
        scopeId: candidate.resource?.scopeId || (producingReceipt ? `command:${producingReceipt.request.commandId}` : null) });
      const valid = Object.isFrozen(context) && Object.isFrozen(candidate) && context.runId === 'run-3-1' && context.harnessId === 'harness-A'
        && context.adapterId === 'adapter-A' && context.authorizationSha256 === u35bHash(inputAuthorization) && same(context.provenance, envelope.provenance);
      subject.trustChecks.push(valid); reenter(subject, label);
      if (options.deny === label) { subject.trustOutcomes.push({ label, outcome: 'denied' }); return false; }
      if (options.trustThrow === label) { subject.trustOutcomes.push({ label, outcome: 'threw' }); throw new Error(rawMarker); }
      const accepted = valid && association(candidate, context) === true;
      subject.trustOutcomes.push({ label, outcome: accepted ? 'accepted' : 'denied' });
      return accepted;
    });
    const commonKeys = ['type', 'commandId', 'resourceId', 'scopeId', 'expectedIdentity', 'expectedIdentitySha256', 'operationNonce', 'timeoutMs', 'provenance', 'authorizationSha256', 'requestSha256'];
    const additions = {
      observeTemporaryRoot: ['processAbsenceEvidenceRefs'],
      quarantineTemporaryRoot: ['observationRequestSha256', 'observationReceiptSha256', 'trackerDecisionSha256', 'parentDirectory', 'taskDirectory', 'quarantinePath'],
      removeTemporaryRoot: ['quarantineRequestSha256', 'quarantineReceiptSha256', 'parentDirectory', 'quarantinedDirectory'],
      verifyTemporaryAbsent: ['removalRequestSha256', 'removalReceiptSha256', 'parentDirectory', 'quarantinePath'],
    };
    const requestTypes = { observeTemporaryRoot: 'TaskResourceTemporaryObservationRequest1', quarantineTemporaryRoot: 'TaskResourceTemporaryQuarantineRequest1',
      removeTemporaryRoot: 'TaskResourceTemporaryRemovalRequest1', verifyTemporaryAbsent: 'TaskResourceTemporaryAbsenceRequest1' };
    const validateRequest = (method, request) => {
      if (!tempMethods.includes(method)) return;
      const original = subject.allocations.get(request.commandId).identity;
      const prior = (name) => subject.receipts.findLast((entry) => entry.method === name && entry.request.commandId === request.commandId);
      let links = true;
      if (method === 'observeTemporaryRoot') links = same(request.processAbsenceEvidenceRefs, prior('verifyProcessAbsent').receipt.evidenceRefs)
        && subject.scopeLog.some((entry) => entry.method === 'observe' && entry.resourceId === original.child_id);
      else if (method === 'quarantineTemporaryRoot') {
        const observation = prior('observeTemporaryRoot');
        links = request.observationRequestSha256 === observation.request.requestSha256 && request.observationReceiptSha256 === u35bHash(observation.receipt)
          && request.trackerDecisionSha256 === u35bHash(subject.reclaim.get(request.commandId)) && same(request.taskDirectory, original.task_directory)
          && path.dirname(request.quarantinePath) === original.confirmed_parent_directory.path && request.quarantinePath !== original.task_directory.path
          && path.normalize(request.quarantinePath) === request.quarantinePath;
      } else if (method === 'removeTemporaryRoot') {
        const quarantine = prior('quarantineTemporaryRoot');
        links = request.quarantineRequestSha256 === quarantine.request.requestSha256 && request.quarantineReceiptSha256 === u35bHash(quarantine.receipt)
          && same(request.quarantinedDirectory, quarantine.receipt.quarantinedDirectory);
      } else {
        const removal = prior('removeTemporaryRoot'); links = request.removalRequestSha256 === removal.request.requestSha256
          && request.removalReceiptSha256 === u35bHash(removal.receipt) && request.quarantinePath === removal.receipt.quarantinedDirectory.path;
      }
      subject.requestChecks.push(Object.isFrozen(request) && same(Object.keys(request).sort(), [...commonKeys, ...additions[method]].sort())
        && request.type === requestTypes[method] && request.resourceId === `command:${request.commandId}:temporary` && request.scopeId === `command:${request.commandId}`
        && same(request.expectedIdentity, original) && request.expectedIdentitySha256 === u35bHash(original) && request.requestSha256 === recomputeRequestSha256(request)
        && typeof request.operationNonce === 'string' && request.operationNonce.length > 0
        && subject.requests.filter((entry) => tempMethods.includes(entry.method) && entry.request.operationNonce === request.operationNonce).length === 1
        && request.timeoutMs === 30000 && request.authorizationSha256 === u35bHash(inputAuthorization)
        && request.provenance.ownerId === 'owner-A' && request.provenance.managerGeneration === 1
        && (method === 'observeTemporaryRoot' || same(request.parentDirectory, original.confirmed_parent_directory)) && links);
    };
    const handlers = {
      probeCapabilities: () => u35bCopy(envelope),
      allocateTemporaryRoot: (request) => { const allocation = u35bTemporary(request, options); subject.allocations.set(request.commandId, allocation);
        subject.hostState.set(request.commandId, 'allocated'); return { identity: allocation.identity, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }; },
      spawnManaged: (request) => { const receipt = baseReceipt(request); subject.processes.set(request.commandId, receipt.identity); return receipt; },
      requestGracefulStop: (request) => ({ disposition: 'COMPLETED', targetIdentitySha256: u35bHash(request.expectedIdentity), identityRevalidated: true, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }),
      observeProcess: (request) => request.type === 'TaskResourceProcessObservationRequest1' ? baseReceipt(request) : ({ ...baseReceipt(request),
        graceful: { requested: true, deadlineReached: false, exitObserved: options.waiting !== true }, exactTreeTerminationSupported: false }),
      terminateOwnedTree: (request) => ({ disposition: 'COMPLETED', targetIdentitySha256: u35bHash(request.expectedIdentity), identityRevalidated: true, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }),
      verifyProcessAbsent: (request) => ({ disposition: 'ABSENT_CONFIRMED', targetIdentitySha256: u35bHash(request.expectedIdentity),
        absence: { processAbsent: true, threadAbsent: true, portAbsent: true }, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }),
      observeTemporaryRoot: (request) => { const allocation = subject.allocations.get(request.commandId); subject.fresh.set(request.commandId, request.operationNonce);
        return { type: 'TaskResourceTemporaryObservation1', disposition: 'OBSERVED', identity: u35bCopy(allocation.identity), manifest: u35bCopy(allocation.manifest),
          policyIndex: u35bCopy(allocation.policyIndex), observation: u35bCopy(allocation.observation), evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }; },
      quarantineTemporaryRoot: (request) => { if (options.preActionRefusal !== 'quarantineTemporaryRoot') subject.hostState.set(request.commandId, 'quarantined');
        return { type: 'TaskResourceTemporaryQuarantine1', disposition: 'COMPLETED', targetIdentitySha256: request.expectedIdentitySha256,
          parentDirectory: u35bCopy(request.parentDirectory), quarantinedDirectory: { ...u35bCopy(request.taskDirectory), path: request.quarantinePath },
          identityRevalidated: true, parentRevalidated: true, destinationPreviouslyAbsent: true, originalEntryAbsent: true,
          evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }; },
      removeTemporaryRoot: (request) => { if (options.preActionRefusal !== 'removeTemporaryRoot') subject.hostState.set(request.commandId, 'removed');
        return { type: 'TaskResourceTemporaryRemoval1', disposition: 'COMPLETED', targetIdentitySha256: request.expectedIdentitySha256,
          parentDirectory: u35bCopy(request.parentDirectory), quarantinedDirectory: u35bCopy(request.quarantinedDirectory), identityRevalidated: true,
          parentRevalidated: true, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }; },
      verifyTemporaryAbsent: (request) => ({ type: 'TaskResourceTemporaryAbsence1', disposition: 'ABSENT_CONFIRMED', targetIdentitySha256: request.expectedIdentitySha256,
        parentDirectory: u35bCopy(request.parentDirectory), parentRevalidated: true, quarantinePath: request.quarantinePath,
        absence: { originalPathAbsent: true, quarantinePathAbsent: true }, evidenceRefs: [EVIDENCE_REF], requestSha256: request.requestSha256 }),
    };
    const platformAdapter = { type: 'TaskResourcePlatformAdapter2', adapterId: 'adapter-A' };
    for (const method of methods) platformAdapter[method] = (request) => guard(() => {
      subject.calls[method] += 1; subject.requests.push({ method, request }); subject.actionLog.push(`${method}:${request.commandId || 'root'}`);
      subject.events.push({ kind: 'adapter', label: method, scopeId: request.commandId ? `command:${request.commandId}` : null });
      validateRequest(method, request); reenter(subject, method);
      if (options.throwAt === method) throw new Error(rawMarker);
      if (options.rejectAt === method) { const rejected = Promise.reject(new Error(rawMarker)); track('adapter-rejection', () => rejected); return rejected; }
      let receipt = handlers[method](request);
      if (options.mutateAt === method) receipt = options.mutate(receipt, request, subject) || receipt;
      if (method !== 'probeCapabilities') subject.receipts.push({ method, request, receipt: u35bCopy(receipt) });
      if (options.gateAt === method) { options.control.response = receipt; options.entered.resolve(true); return options.control.promise; }
      return receipt;
    });
    subject.input = { runId: 'run-3-1', harness: { type: 'TaskResourceHarness1', harnessId: 'harness-A', trustedProducer: producer },
      dataRoot: instanceDataRoot(), platformAdapter, authorization: inputAuthorization, limits: { tracker: { maxScopes: 8, maxInputBytes: 32768 } } };
    subject.open = () => { active = subject; subject.manager = openTrackedManager(subject.input); return subject.manager; }; return subject;
  };
  const start = async (subject, commandId = 'u35b-A', temporary = true) => { active = subject;
    return value(await track('start', () => subject.manager.startCommand(commandInput({ commandId, temporaryRoot: temporary ? commandInput().temporaryRoot : null }))).observed); };
  const prestop = async (subject, resource) => {
    value(await track('stop-request', () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' })).observed);
    return value(await track('stop-confirm', () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' })).observed);
  };
  const cached = async (subject, first) => { const before = snapshot(subject); const second = await readClose(close(subject)); return { sameObject: first === second, noWork: snapshot(subject) === before }; };
  const install = () => {
    for (const method of trackerMethods) {
      const descriptor = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, method);
      savedTracker.push({ method, descriptor });
      Object.defineProperty(TaskResourceTracker.prototype, method, { ...descriptor, value: function (...args) {
        if (active) {
          active.trackerLog.push({ method, args });
          active.events.push({ kind: 'tracker', label: method, scopeId: args[0]?.scopeId || null });
        }
        return Reflect.apply(descriptor.value, this, args);
      } });
    }
    for (const method of scopeMethods) {
      const descriptor = Object.getOwnPropertyDescriptor(ResourceScope.prototype, method); saved.push({ method, descriptor });
      Object.defineProperty(ResourceScope.prototype, method, { ...descriptor, value: function (...args) {
        const subject = active; if (!subject) return Reflect.apply(descriptor.value, this, args);
        if (method === 'getResource') {
          const resource = Reflect.apply(descriptor.value, this, args);
          if (subject.options.drift && args[0] === 'command:u35b-A:temporary') {
            const changed = u35bCopy(resource); subject.options.drift(changed); return changed;
          }
          return resource;
        }
        const resourceId = typeof args[0] === 'string' ? args[0] : args[0]?.resourceId;
        const temporary = typeof resourceId === 'string' && resourceId.endsWith(':temporary');
        subject.scopeLog.push({ method, scopeId: this.scopeId, resourceId: resourceId || null });
        subject.events.push({ kind: 'scope', label: method, scopeId: this.scopeId, resourceId: resourceId || null });
        const label = method === 'close' ? (this.scopeId === 'manager-run-A' ? 'root-close' : 'child-close') : temporary ? `temporary-${method}` : method;
        reenter(subject, label); if (subject.options.scopeThrow === label) throw new Error(rawMarker);
        if (subject.options.scopeForge === label) {
          if (method === 'confirmRelease') return Object.freeze({ releaseConfirmed: true, identity: {}, boundGeneration: 2 });
          if (method === 'observe') return Object.freeze({ action: 'RECLAIM_EXACT', reasons: [], action_authorized: false,
            requires_same_parent_quarantine: subject.options.flag !== 'quarantine', requires_post_removal_absence_check: subject.options.flag !== 'absence' });
          return Object.freeze({ ownerId: 'owner-A', runId: 'run-3-1', scopeId: this.scopeId, generation: 1, status: 'CLOSED', reasons: [], decisions: [], order: [] });
        }
        const result = Reflect.apply(descriptor.value, this, args);
        if (method === 'bind' && temporary) subject.bindings.push(u35bCopy(result));
        if (method === 'confirmRelease' && temporary) subject.releases.push(u35bCopy(result));
        if (method === 'close') subject.closeLog.push({ scopeId: this.scopeId, status: result.status, order: result.order });
        return result;
      } });
    }
  };
  let seamAccepted = false;
  try {
    // The baseline RED is one aggregate assertion. Known exact-V2 rejection
    // explicitly leaves deeper scenarios UNEXECUTED; it is not a fixture error.
    const seam = make(); const opening = await track('v2-opening', () => seam.open()).observed;
    seamAccepted = opening.kind === 'value';
    record('adapterSeam', seamAccepted ? 'V2_ACCEPTED' : opening.error instanceof TaskResourceManagerError && opening.error.code === 'TASK_RESOURCE_MANAGER_HOLD'
      ? 'MISSING_V2_ADAPTER_SEAM' : 'UNEXPECTED_OPENING_FAILURE', 'V2_ACCEPTED');
    if (!seamAccepted && !(opening.error instanceof TaskResourceManagerError)) throw opening.error;
    if (seamAccepted) {
      install();
      record('openProbeOnly', methods.map((method) => seam.calls[method]), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      for (const method of methods) for (const malformed of ['missing', 'extra', 'accessor']) {
        const subject = make();
        if (malformed === 'missing') delete subject.input.platformAdapter[method];
        if (malformed === 'extra') subject.input.platformAdapter.unrecognized = () => { getterHits += 1; };
        if (malformed === 'accessor') Object.defineProperty(subject.input.platformAdapter, method, { enumerable: true, configurable: true, get() { getterHits += 1; return () => {}; } });
        const outcome = await track('malformed-open', () => subject.open()).observed;
        record(`shape-${method}-${malformed}`, { ...rejection(outcome), calls: methods.map((name) => subject.calls[name]) },
          { kind: 'error', managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD', calls: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      }
      // Windows/Linux fixtures here prove only the tracker/contracts bridge.
      // Native Linux manager/runtime acceptance remains Task 5.
      active = null;
      for (const platform of ['windows', 'linux']) {
        const request = { commandId: 'bridge', allocationId: 'bridge-allocation', creationNonce: 'bridge-nonce', temporaryRoot: platform === 'windows' ? 'C:\\u35b-parent' : '/u35b-parent',
          resourceIds: { commandSession: 'bridge-child' }, provenance: { platform, ownerId: 'owner-A', runId: 'run-3-1', sessionId: 'session-A', managerGeneration: 1 } };
        const fixture = u35bTemporary(request); const seen = [];
        const projection = { manifest: fixture.manifest, policyIndex: fixture.policyIndex, child_id: 'bridge-child', intent: 'reclaim', observation: fixture.observation };
        const tracker = new TaskResourceTracker({ ownerId: 'owner-A', runId: 'run-3-1', generation: 1,
          trustedFilesystemResolver: (candidate) => { seen.push('filesystem'); return candidate.purpose === 'temporary_reclaim' && same(candidate.record, fixture.observation)
            && same(candidate.context, { manifest_sha256: fixture.manifest.manifest_sha256, canonical_root_identity: fixture.manifest.canonical_root_identity,
              child_id: 'bridge-child', child_path: fixture.identity.task_directory.path }); },
          trustedObservationResolver: (candidate) => { seen.push(candidate.purpose); return candidate.purpose === 'temporary_reclaim'
            && same(candidate.resource.identity, fixture.identity) && same(candidate.observation, projection) && candidate.resource.boundGeneration === 1; } });
        const scope = tracker.openRootScope({ scopeId: 'bridge-root', purpose: 'contract_only' });
        scope.register({ resourceId: 'bridge-temp', type: 'temporary_allocation', purpose: 'contract_only', teardownCondition: 'allocation_absence_verified', evidenceRefs: [EVIDENCE_REF] });
        const bound = scope.bind('bridge-temp', { identity: fixture.identity, generation: 1, evidenceRefs: [EVIDENCE_REF] }); const decision = scope.observe('bridge-temp', projection);
        record(`contract-only-${platform}`, { bound: bound.state, action: decision.action, quarantine: decision.requires_same_parent_quarantine,
          absence: decision.requires_post_removal_absence_check, seen },
          { bound: 'ACTIVE', action: 'RECLAIM_EXACT', quarantine: true, absence: true, seen: ['filesystem', 'temporary_reclaim'] });
      }
      for (const initiallyStopped of [false, true]) {
        const subject = make(); subject.open(); const resource = await start(subject); if (initiallyStopped) await prestop(subject, resource);
        const first = await readClose(close(subject)); const final = initiallyStopped ? first : await readClose(close(subject));
        record(`happy-${initiallyStopped}`, { first: summary(first), final: summary(final), counts: counts(subject), cache: await cached(subject, final),
          childOrder: subject.closeLog[0]?.order, rootStatus: subject.closeLog[1]?.status, boundOnce: subject.bindings.length === 1,
          releasedOriginal: subject.releases.length === 1 && same(subject.releases[0].identity, subject.bindings[0].identity)
            && subject.releases[0].boundGeneration === 1 && subject.releases[0].releaseConfirmed === true },
          { first: initiallyStopped ? 'CLOSED/ALL_RESOURCES_RELEASED' : 'CLOSING/COMMAND_STOP_IN_PROGRESS', final: 'CLOSED/ALL_RESOURCES_RELEASED',
            counts: [1, 1, 1, 1], cache: { sameObject: true, noWork: true }, childOrder: ['command:u35b-A:process-tree', 'command:u35b-A:session', 'command:u35b-A:temporary'],
            rootStatus: 'CLOSED', boundOnce: true, releasedOriginal: true });
      }
      for (const order of ['temp-first', 'plain-first']) {
        const subject = make(); subject.open(); const firstResource = await start(subject, 'u35b-A', order === 'temp-first');
        const secondResource = await start(subject, 'u35b-B', order === 'plain-first'); await prestop(subject, firstResource); await prestop(subject, secondResource);
        const first = await readClose(close(subject)); const firstScopes = subject.closeLog.map((entry) => entry.scopeId); const second = await readClose(close(subject));
        record(`siblings-${order}`, { sequence: [summary(first), summary(second)], firstScopes, orders: subject.closeLog.slice(0, 2).map((entry) => entry.order), counts: counts(subject) },
          { sequence: ['CLOSING/COMMANDS_REMAINING', 'CLOSED/ALL_RESOURCES_RELEASED'], firstScopes: ['command:u35b-B'],
            orders: order === 'temp-first' ? [['command:u35b-B:process-tree', 'command:u35b-B:session'], ['command:u35b-A:process-tree', 'command:u35b-A:session', 'command:u35b-A:temporary']]
              : [['command:u35b-B:process-tree', 'command:u35b-B:session', 'command:u35b-B:temporary'], ['command:u35b-A:process-tree', 'command:u35b-A:session']], counts: [1, 1, 1, 1] });
      }
      const negative = async (label, options, reason, literalCounts) => {
        const subject = make(options); subject.open(); await start(subject, 'u35b-older', false); const resource = await start(subject); await prestop(subject, resource);
        const before = subject.actionLog.length; const eventStart = subject.events.length; const beforeFirstClose = snapshot(subject);
        const result = await readClose(close(subject));
        if (reason === 'TEMPORARY_STATE_INVALID') record(`${label}-global-no-work`, beforeFirstClose === snapshot(subject), true);
        const cache = await cached(subject, result); const after = snapshot(subject);
        if (options.authenticFault) {
          const receiptType = { observeTemporaryRoot: 'TaskResourceTemporaryObservation1', quarantineTemporaryRoot: 'TaskResourceTemporaryQuarantine1',
            removeTemporaryRoot: 'TaskResourceTemporaryRemoval1', verifyTemporaryAbsent: 'TaskResourceTemporaryAbsence1' }[options.mutateAt];
          // Zero callbacks is valid early rejection; every callback that does run
          // must authenticate these deliberately issued unsafe facts.
          record(`${label}-authentic-facts-not-denied`, subject.trustOutcomes.filter((entry) => entry.label === receiptType)
            .every((entry) => entry.outcome === 'accepted'), true);
        }
        const later = {
          TEMPORARY_OBSERVATION_REJECTED: ['quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent', 'filesystem:temporary_reclaim', 'observation:temporary_reclaim', 'TaskResourceTemporaryQuarantine1', 'TaskResourceTemporaryRemoval1', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence', 'scope:temporary-observe', 'scope:temporary-confirmRelease', 'scope:close'],
          TEMPORARY_RECLAIM_REJECTED: ['quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent', 'TaskResourceTemporaryQuarantine1', 'TaskResourceTemporaryRemoval1', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence', 'scope:temporary-confirmRelease', 'scope:close'],
          TEMPORARY_QUARANTINE_REJECTED: ['removeTemporaryRoot', 'verifyTemporaryAbsent', 'TaskResourceTemporaryRemoval1', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence', 'scope:temporary-confirmRelease', 'scope:close'],
          TEMPORARY_REMOVAL_REJECTED: ['verifyTemporaryAbsent', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence', 'scope:temporary-confirmRelease', 'scope:close'],
          TEMPORARY_ABSENCE_REJECTED: ['observation:temporary_absence', 'scope:temporary-confirmRelease', 'scope:close'],
          TEMPORARY_RELEASE_REJECTED: ['scope:close'],
          TEMPORARY_STATE_INVALID: ['observeTemporaryRoot', 'quarantineTemporaryRoot', 'removeTemporaryRoot', 'verifyTemporaryAbsent', 'TaskResourceTemporaryObservation1', 'filesystem:temporary_reclaim', 'observation:temporary_reclaim', 'TaskResourceTemporaryQuarantine1', 'TaskResourceTemporaryRemoval1', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence', 'scope:temporary-observe', 'scope:temporary-confirmRelease', 'scope:close'],
        }[reason];
        const literalZero = {
          TEMPORARY_OBSERVATION_REJECTED: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], TEMPORARY_RECLAIM_REJECTED: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          TEMPORARY_QUARANTINE_REJECTED: [0, 0, 0, 0, 0, 0, 0], TEMPORARY_REMOVAL_REJECTED: [0, 0, 0, 0, 0],
          TEMPORARY_ABSENCE_REJECTED: [0, 0, 0], TEMPORARY_RELEASE_REJECTED: [0], TEMPORARY_STATE_INVALID: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        }[reason];
        const events = subject.events.slice(eventStart);
        const eventLabel = (entry) => entry.kind !== 'scope' ? entry.label : entry.label === 'close' ? 'scope:close'
          : entry.resourceId?.endsWith(':temporary') ? `scope:temporary-${entry.label}` : `scope:${entry.label}`;
        record(`${label}-downstream-zero`, later.map((name) => events.filter((entry) => eventLabel(entry) === name).length), literalZero);
        record(`${label}-older-zero`, events.filter((entry) => entry.scopeId === 'command:u35b-older').length, 0);
        const admission = await track('closed-admission', () => subject.manager.startCommand(commandInput({ commandId: 'u35b-new' }))).observed;
        record(label, { result: summary(result), counts: counts(subject), cache, noOlderWork: subject.actionLog.slice(before).every((entry) => !entry.endsWith(':u35b-older')),
          noRelease: subject.releases.length === 0, admission: rejection(admission), admissionNoWork: snapshot(subject) === after },
          { result: `HOLD/${reason}`, counts: literalCounts, cache: { sameObject: true, noWork: true }, noOlderWork: true, noRelease: true,
            admission: { kind: 'error', managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' }, admissionNoWork: true }); return subject;
      };
      for (const [label, mutate] of [
        ['task-drift', (receipt) => { receipt.identity.task_directory[receipt.identity.platform === 'windows' ? 'windows_file_identity' : 'linux_file_identity'] = receipt.identity.platform === 'windows' ? { volume_serial_number: 'foreign', file_id: 'foreign' } : { device_id: 'foreign', inode: 99 }; }],
        ['parent-drift', (receipt) => { receipt.identity.confirmed_parent_directory.path = path.join(receipt.identity.canonical_root, 'foreign'); }],
        ['wrong-owner', (receipt) => { receipt.identity.owner_id = 'foreign-owner'; }], ['wrong-generation', (receipt) => { receipt.identity.lease_generation = 2; }],
        ['wrong-request', (receipt) => { receipt.requestSha256 = '9'.repeat(64); }], ['wrong-nonce', (receipt) => { receipt.identity.creation_nonce = 'foreign-nonce'; }],
        ['invalid-references', (receipt) => { receipt.evidenceRefs = ['raw-private-evidence']; }], ['duplicate-references', (receipt) => { receipt.evidenceRefs = [EVIDENCE_REF, EVIDENCE_REF]; }],
        ['oversized-references', (receipt) => { receipt.evidenceRefs = Array.from({ length: 600 }, (_, index) => `evidence:${index.toString(16).padStart(64, '0')}`); }],
      ]) {
        const subject = await negative(`observation-${label}`, { mutateAt: 'observeTemporaryRoot', mutate, authenticFault: label !== 'wrong-request' }, 'TEMPORARY_OBSERVATION_REJECTED', [1, 0, 0, 0]);
        if (['invalid-references', 'duplicate-references', 'oversized-references', 'wrong-request'].includes(label))
          record(`observation-${label}-pretrust`, subject.trust.filter((entry) => entry === 'TaskResourceTemporaryObservation1').length, 0);
      }
      for (const [label, options] of [
        ['missing-policy', { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { receipt.policyIndex = {}; } }],
        ['policy-own-hash', { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { receipt.policyIndex['u35b-quota'].values.soft_quota = 1; } }],
        ['wrong-manifest-digest', { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { receipt.manifest.manifest_sha256 = '8'.repeat(64); } }],
        ['sublease-path', { manifest: (manifest, request) => { manifest.child_sublease_map[request.resourceIds.commandSession].canonical_descendant = path.join(request.temporaryRoot, 'other'); } }],
        ['sublease-nonce', { manifest: (manifest, request) => { manifest.child_sublease_map[request.resourceIds.commandSession].nonce = 'other'; } }],
        ['nonempty-retention', { manifest: (manifest) => { manifest.retention_set = ['retained-artifact']; } }],
      ]) await negative(`reclaim-${label}`, options, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
      for (const [label, mutate] of [
        ['unrelated-policy-key', receipt => { receipt.policyIndex.unrelated = { private_marker: 'u7-policy-payload-must-not-enter-history' }; }],
        ['quota-values-extra', receipt => { receipt.policyIndex['u35b-quota'] = u35bPolicy('u35b-quota', 'quota',
          { soft_quota: 524288, hard_quota: 1048576, private_marker: 'u7-policy-payload-must-not-enter-history' }); }],
        ['watermark-values-extra', receipt => { receipt.policyIndex['u35b-watermark'] = u35bPolicy('u35b-watermark', 'watermark',
          { low_watermark: 4096, critical_watermark: 1024, private_marker: 'u7-policy-payload-must-not-enter-history' }); }],
        ['policy-record-extra', receipt => { receipt.policyIndex['u35b-quota'] = u35bPolicy('u35b-quota', 'quota',
          { soft_quota: 524288, hard_quota: 1048576 }, { private_marker: 'u7-policy-payload-must-not-enter-history' }); }],
      ]) {
        const subject = await negative(`reclaim-${label}`,
          { mutateAt: 'observeTemporaryRoot', mutate, authenticFault: true }, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
        record(`reclaim-${label}-before-tracker`, subject.scopeLog.filter(entry =>
          entry.method === 'observe' && entry.resourceId?.endsWith(':temporary')).length, 0);
        record(`reclaim-${label}-authentic-receipt`, subject.trustOutcomes.filter(entry =>
          entry.label === 'TaskResourceTemporaryObservation1' && entry.outcome === 'accepted').length, 1);
      }
      for (const [field, bad] of [['reparse_boundary', true], ['path_rebound', true], ['active_handles', 1], ['quiescent', false],
        ['retention_set_sealed', false], ['retention_set_hash', '7'.repeat(64)], ['teardown_condition_met', false]])
        await negative(`reclaim-${field}`, { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { receipt.observation[field] = bad; } }, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
      for (const [label, reason] of [['TaskResourceTemporaryObservation1', 'TEMPORARY_OBSERVATION_REJECTED'],
        ['filesystem:temporary_reclaim', 'TEMPORARY_RECLAIM_REJECTED'], ['observation:temporary_reclaim', 'TEMPORARY_RECLAIM_REJECTED']]) {
        const subject = await negative(`deny-${label}`, { deny: label }, reason, [1, 0, 0, 0]); record(`deny-${label}-entered`, subject.trust.filter((entry) => entry === label).length, 1);
      }
      await negative('observation-missing-manifest', { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { delete receipt.manifest; } }, 'TEMPORARY_OBSERVATION_REJECTED', [1, 0, 0, 0]);
      await negative('reclaim-missing-retention-field', { mutateAt: 'observeTemporaryRoot', mutate: (receipt) => { delete receipt.observation.retention_set_sealed; } }, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
      await negative('reclaim-missing-retention-set', { manifest: (manifest) => { delete manifest.retention_set; } }, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
      const replaySource = make(); replaySource.open(); const replayResource = await start(replaySource); await prestop(replaySource, replayResource);
      const replayClosed = await readClose(close(replaySource));
      const oldReceipt = u35bCopy(replaySource.receipts.find((entry) => entry.method === 'observeTemporaryRoot').receipt);
      record('replay-source-authenticated', { closed: summary(replayClosed), fullAccepted: replaySource.accepted.has('u35b-A'), reclaimed: replaySource.reclaim.has('u35b-A') },
        { closed: 'CLOSED/ALL_RESOURCES_RELEASED', fullAccepted: true, reclaimed: true });
      const replay = await negative('observation-valid-old-receipt-replay', { mutateAt: 'observeTemporaryRoot', mutate: () => u35bCopy(oldReceipt) }, 'TEMPORARY_OBSERVATION_REJECTED', [1, 0, 0, 0]);
      record('replay-is-old-request', oldReceipt.requestSha256 !== replay.requests.find((entry) => entry.method === 'observeTemporaryRoot').request.requestSha256, true);
      for (const [label, reason, literalCounts] of [
        ['TaskResourceTemporaryObservation1', 'TEMPORARY_OBSERVATION_REJECTED', [1, 0, 0, 0]],
        ['filesystem:temporary_reclaim', 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]],
        ['observation:temporary_reclaim', 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]],
        ['TaskResourceTemporaryQuarantine1', 'TEMPORARY_QUARANTINE_REJECTED', [1, 1, 0, 0]],
        ['TaskResourceTemporaryRemoval1', 'TEMPORARY_REMOVAL_REJECTED', [1, 1, 1, 0]],
        ['TaskResourceTemporaryAbsence1', 'TEMPORARY_ABSENCE_REJECTED', [1, 1, 1, 1]],
        ['observation:temporary_absence', 'TEMPORARY_RELEASE_REJECTED', [1, 1, 1, 1]],
      ]) {
        const subject = await negative(`trust-throw-${label}`, { trustThrow: label }, reason, literalCounts);
        record(`trust-throw-${label}-entered`, subject.trust.filter((entry) => entry === label).length, 1);
      }
      for (const flag of ['quarantine', 'absence']) await negative(`tracker-flag-${flag}`, { scopeForge: 'temporary-observe', flag }, 'TEMPORARY_RECLAIM_REJECTED', [1, 0, 0, 0]);
      for (const [method, reason, literalCounts] of [['observeTemporaryRoot', 'TEMPORARY_OBSERVATION_REJECTED', [1, 0, 0, 0]],
        ['quarantineTemporaryRoot', 'TEMPORARY_QUARANTINE_REJECTED', [1, 1, 0, 0]], ['removeTemporaryRoot', 'TEMPORARY_REMOVAL_REJECTED', [1, 1, 1, 0]],
        ['verifyTemporaryAbsent', 'TEMPORARY_ABSENCE_REJECTED', [1, 1, 1, 1]]]) {
        for (const failure of ['throw', 'reject', 'unsupported', 'malformed', 'wrong-request']) {
          const options = failure === 'throw' ? { throwAt: method } : failure === 'reject' ? { rejectAt: method } : { mutateAt: method,
            preActionRefusal: failure === 'unsupported' ? method : null, mutate: (receipt) => {
            if (failure === 'unsupported') receipt.disposition = 'UNSUPPORTED'; if (failure === 'malformed') delete receipt.evidenceRefs;
            if (failure === 'wrong-request') receipt.requestSha256 = '6'.repeat(64);
          } }; const subject = await negative(`${method}-${failure}`, options, reason, literalCounts);
          if (method === 'quarantineTemporaryRoot' || method === 'removeTemporaryRoot') {
            record(`${method}-${failure}-host-state`, subject.hostState.get('u35b-A'),
              method === 'quarantineTemporaryRoot' ? (['throw', 'reject', 'unsupported'].includes(failure) ? 'allocated' : 'quarantined')
                : (['throw', 'reject', 'unsupported'].includes(failure) ? 'quarantined' : 'removed'));
          }
        }
      }
      for (const [label, mutate] of [
        ['collision', (receipt) => { receipt.destinationPreviouslyAbsent = false; }], ['parent-not-revalidated', (receipt) => { receipt.parentRevalidated = false; }],
        ['original-present', (receipt) => { receipt.originalEntryAbsent = false; }], ['wrong-quarantine', (receipt) => { receipt.quarantinedDirectory.path = path.join(receipt.parentDirectory.path, 'foreign'); }],
        ['native-drift', (receipt) => { const key = Object.hasOwn(receipt.quarantinedDirectory, 'windows_file_identity') ? 'windows_file_identity' : 'linux_file_identity';
          receipt.quarantinedDirectory[key] = key === 'windows_file_identity' ? { volume_serial_number: 'foreign', file_id: 'foreign' } : { device_id: 'foreign', inode: 88 }; }],
      ]) {
        const subject = await negative(`quarantine-${label}`, { mutateAt: 'quarantineTemporaryRoot', mutate, authenticFault: true,
          preActionRefusal: label === 'collision' ? 'quarantineTemporaryRoot' : null }, 'TEMPORARY_QUARANTINE_REJECTED', [1, 1, 0, 0]);
        record(`quarantine-${label}-host-state`, subject.hostState.get('u35b-A'), label === 'collision' ? 'allocated' : 'quarantined');
      }
      for (const [label, mutate] of [['ambiguous-completion', (receipt) => { receipt.disposition = 'UNKNOWN'; }], ['identity-drift', (receipt) => { receipt.targetIdentitySha256 = '5'.repeat(64); }],
        ['wrong-target', (receipt) => { receipt.quarantinedDirectory.path = path.join(receipt.parentDirectory.path, 'foreign'); }]])
        await negative(`removal-${label}`, { mutateAt: 'removeTemporaryRoot', mutate, authenticFault: true }, 'TEMPORARY_REMOVAL_REJECTED', [1, 1, 1, 0]);
      for (const [label, mutate] of [['old-path-only', (receipt) => { receipt.absence.quarantinePathAbsent = false; }], ['foreign-original', (receipt) => { receipt.absence.originalPathAbsent = false; }],
        ['wrong-quarantine', (receipt) => { receipt.quarantinePath = path.join(receipt.parentDirectory.path, 'foreign'); }], ['parent-drift', (receipt) => { receipt.parentDirectory.path = path.join(receipt.parentDirectory.path, 'foreign'); }]])
        await negative(`absence-${label}`, { mutateAt: 'verifyTemporaryAbsent', mutate, authenticFault: true }, 'TEMPORARY_ABSENCE_REJECTED', [1, 1, 1, 1]);
      for (const [label, reason] of [['TaskResourceTemporaryQuarantine1', 'TEMPORARY_QUARANTINE_REJECTED'], ['TaskResourceTemporaryRemoval1', 'TEMPORARY_REMOVAL_REJECTED'],
        ['TaskResourceTemporaryAbsence1', 'TEMPORARY_ABSENCE_REJECTED'], ['observation:temporary_absence', 'TEMPORARY_RELEASE_REJECTED']]) {
        const literalCounts = label === 'TaskResourceTemporaryQuarantine1' ? [1, 1, 0, 0] : label === 'TaskResourceTemporaryRemoval1' ? [1, 1, 1, 0] : [1, 1, 1, 1];
        const subject = await negative(`trust-deny-${label}`, { deny: label }, reason, literalCounts); record(`trust-deny-${label}-entered`, subject.trust.filter((entry) => entry === label).length, 1);
      }
      for (const failure of ['throw', 'forge']) await negative(`release-${failure}`, failure === 'throw' ? { scopeThrow: 'temporary-confirmRelease' } : { scopeForge: 'temporary-confirmRelease' },
        'TEMPORARY_RELEASE_REJECTED', [1, 1, 1, 1]);
      for (const [label, reason] of [['child-close', 'COMMAND_SCOPE_CLOSE_REJECTED'], ['root-close', 'ROOT_SCOPE_CLOSE_REJECTED']]) for (const failure of ['throw', 'forge']) {
        const subject = make(failure === 'throw' ? { scopeThrow: label } : { scopeForge: label }); subject.open(); const resource = await start(subject); await prestop(subject, resource);
        Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', { ...verifierDescriptor, value: () => { forgedVerifierHits += 1; return { valid: true }; } });
        const result = await readClose(close(subject)); record(`${label}-${failure}`, { result: summary(result), cache: await cached(subject, result), counts: counts(subject) },
          { result: `HOLD/${reason}`, cache: { sameObject: true, noWork: true }, counts: [1, 1, 1, 1] });
        Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', verifierDescriptor);
      }
      for (const [label, drift] of [
        ['owner', (resource) => { resource.ownerId = 'foreign-owner'; }], ['generation', (resource) => { resource.boundGeneration = 2; }],
        ['parent', (resource) => { resource.parentResourceId = 'foreign-parent'; }], ['identity', (resource) => { resource.identity.creation_nonce = 'foreign-nonce'; }],
      ]) {
        const subject = await negative(`global-bound-${label}`, { drift }, 'TEMPORARY_STATE_INVALID', [0, 0, 0, 0]);
        record(`global-bound-${label}-session-zero`, subject.scopeLog.filter((entry) => entry.method === 'observe' && entry.resourceId === 'command:u35b-A:session').length, 0);
      }
      const capability = make({ capability: (envelope) => {
        envelope.supportMatrix.claims.temporary_lease.state = 'UNVERIFIED'; envelope.supportMatrix.overall_state = 'UNVERIFIED';
      } }); capability.open();
      const capabilityBefore = [capability.calls.allocateTemporaryRoot, capability.calls.spawnManaged];
      const capabilityStart = await track('capability-start', () => capability.manager.startCommand(commandInput({ commandId: 'u35b-A' }))).observed;
      record('temporary-capability-before-allocation', { outcome: rejection(capabilityStart), before: capabilityBefore,
        after: [capability.calls.allocateTemporaryRoot, capability.calls.spawnManaged] },
        { outcome: { kind: 'error', managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' }, before: [0, 0], after: [0, 0] });
      const deep = await negative('global-direct-child', { deep: true }, 'TEMPORARY_STATE_INVALID', [0, 0, 0, 0]);
      record('global-direct-child-no-session', deep.scopeLog.filter((entry) => entry.method === 'observe' && entry.resourceId === 'command:u35b-A:session').length, 0);
      for (const stage of ['allocateTemporaryRoot', 'spawnManaged', 'observeProcess', 'requestGracefulStop']) {
        const control = makeControl(); const entered = makeControl(); const subject = make({ gateAt: stage, control, entered }); subject.open(); let operation;
        if (stage === 'allocateTemporaryRoot' || stage === 'spawnManaged') operation = track('pending-start', () => subject.manager.startCommand(commandInput({ commandId: 'u35b-A' })));
        else { subject.options.gateAt = null; const resource = await start(subject); subject.options.gateAt = stage;
          operation = stage === 'observeProcess' ? track('pending-observe', () => subject.manager.observe(resource.resourceId))
            : track('pending-stop', () => subject.manager.stop(resource.resourceId, { reason: 'user_requested' })); }
        const entryFallback = observeEntryOrOwner(operation, entered);
        const entryEvidence = value(await entered.tracked.observed);
        record(`active-${stage}-entry`, entryEvidence === true ? { kind: 'entered' } : entryEvidence, { kind: 'entered' });
        if (entryEvidence !== true) {
          control.resolve(control.response);
          await operation.observed; await entryFallback.observed;
          continue;
        }
        const before = snapshot(subject); const result = await readClose(close(subject)); const noWork = before === snapshot(subject);
        const admission = await track('pending-admission', () => subject.manager.startCommand(commandInput({ commandId: 'u35b-new' }))).observed;
        control.resolve(control.response); const completed = await operation.observed;
        record(`active-${stage}`, { result: summary(result), noWork, counts: counts(subject), admission: rejection(admission), completedKind: completed.kind },
          { result: 'CLOSING/COMMAND_OPERATION_IN_PROGRESS', noWork: true, counts: [0, 0, 0, 0], admission: { kind: 'error', managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' },
            completedKind: stage === 'allocateTemporaryRoot' ? 'error' : 'value' });
      }
      const incomplete = make({ rejectAt: 'spawnManaged' }); incomplete.open();
      const incompleteStart = await track('incomplete-start', () => incomplete.manager.startCommand(commandInput({ commandId: 'u35b-older', temporaryRoot: null }))).observed;
      record('incomplete-start-rejected', rejection(incompleteStart), { kind: 'error', managerError: true, code: 'TASK_RESOURCE_MANAGER_HOLD' });
      incomplete.options.rejectAt = null; await start(incomplete); const beforeIncomplete = snapshot(incomplete); const incompleteResult = await readClose(close(incomplete));
      record('global-incomplete', { result: summary(incompleteResult), noWork: beforeIncomplete === snapshot(incomplete) }, { result: 'HOLD/COMMAND_START_INCOMPLETE', noWork: true });
      for (const label of [...tempMethods, 'TaskResourceTemporaryObservation1', 'filesystem:temporary_reclaim', 'observation:temporary_reclaim',
        'TaskResourceTemporaryQuarantine1', 'TaskResourceTemporaryRemoval1', 'TaskResourceTemporaryAbsence1', 'observation:temporary_absence',
        'temporary-observe', 'temporary-confirmRelease', 'child-close', 'root-close']) {
        const subject = make({ reentry: label }); subject.open(); const resource = await start(subject); await prestop(subject, resource);
        subject.outer = close(subject);
        const outerWitness = track('outer-settlement-witness', () => subject.outer.promise.then(
          () => { subject.settlementOrder.push('outer'); },
          () => { subject.settlementOrder.push('outer-rejected'); },
        ));
        const result = await readClose(subject.outer);
        for (const entry of subject.reentries) await readClose(entry);
        await outerWitness.observed;
        record(`reentry-${label}`, { result: summary(result), busy: subject.busy, order: subject.settlementOrder, counts: counts(subject) },
          { result: 'CLOSED/ALL_RESOURCES_RELEASED', busy: [{ result: 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS', outerPending: true, noWork: true }], order: ['busy', 'outer'], counts: [1, 1, 1, 1] });
      }
      for (const stage of tempMethods) {
        const control = makeControl(); const entered = makeControl(); const subject = make({ gateAt: stage, control, entered }); subject.open(); const resource = await start(subject); await prestop(subject, resource);
        const outer = close(subject); const entryFallback = observeEntryOrOwner(outer, entered);
        const entryEvidence = value(await entered.tracked.observed);
        record(`awaited-${stage}-entry`, entryEvidence === true ? { kind: 'entered' } : entryEvidence, { kind: 'entered' });
        if (entryEvidence !== true) {
          control.resolve(control.response);
          const ownerOutcome = await outer.observed;
          if (ownerOutcome.kind === 'value') publicResults.push(ownerOutcome.value);
          await entryFallback.observed;
          continue;
        }
        const before = snapshot(subject); const concurrent = await readClose(close(subject));
        const independent = !outer.settled; const noWork = before === snapshot(subject); control.resolve(control.response); const final = await readClose(outer);
        record(`awaited-${stage}`, { concurrent: summary(concurrent), independent, noWork, final: summary(final), cache: await cached(subject, final), counts: counts(subject) },
          { concurrent: 'CLOSING/CLOSE_ATTEMPT_IN_PROGRESS', independent: true, noWork: true, final: 'CLOSED/ALL_RESOURCES_RELEASED', cache: { sameObject: true, noWork: true }, counts: [1, 1, 1, 1] });
      }
      const publicMutation = make(); publicMutation.open(); await start(publicMutation);
      Object.defineProperty(TaskResourceManager.prototype, 'stop', { ...stopDescriptor, value: () => { forgedStopHits += 1; return { status: 'STOPPED' }; } });
      await readClose(close(publicMutation)); const mutationFinal = await readClose(close(publicMutation));
      record('public-prototype-cannot-forge', { result: summary(mutationFinal), forgedStopHits, forgedVerifierHits }, { result: 'CLOSED/ALL_RESOURCES_RELEASED', forgedStopHits: 0, forgedVerifierHits: 0 });
      record('complete-request-ledger', subjects.every((subject) => subject.requestChecks.every(Boolean)), true);
      record('complete-producer-context-ledger', subjects.every((subject) => subject.trustChecks.every(Boolean)), true);
      const ownKeysEqual = (object, keys) => {
        if (object === null || typeof object !== 'object') return false;
        const ownKeys = Reflect.ownKeys(object);
        return ownKeys.length === keys.length && ownKeys.every((key, index) => typeof key === 'string' && key === keys[index]);
      };
      const frozenDataDescriptors = (object, keys) => object !== null && typeof object === 'object'
        && keys.every((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable === false
            && descriptor.configurable === false && descriptor.enumerable === (key !== 'length');
        });
      // Private sentinels come exclusively from host fixtures and issued data.
      // No candidate public output participates in creating this rejection set.
      const privateStrings = new Set([rawMarker, DATA_ROOT, fixtureState.root, commandInput().cwd, commandInput().temporaryRoot,
        'authority:', 'evidence:', AUTHORITY_REF, EVIDENCE_REF, 'manifest',
        'TemporaryAllocationIdentity2', 'ProcessIdentity2', 'u35b-quota', 'u35b-watermark',
        'owner-A', 'run-3-1', 'session-A', 'manager-run-A', 'harness-A', 'adapter-A', 'producer-A']);
      const fixtureSeen = new Set();
      const collectFixtureMarkers = (candidate) => {
        if (typeof candidate === 'string') { if (candidate.length > 0) privateStrings.add(candidate); return; }
        if (candidate === null || typeof candidate !== 'object' || fixtureSeen.has(candidate)) return;
        fixtureSeen.add(candidate);
        for (const key of Reflect.ownKeys(candidate)) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (descriptor && Object.hasOwn(descriptor, 'value')) collectFixtureMarkers(descriptor.value);
        }
      };
      for (const subject of subjects) {
        for (const { request } of subject.requests) collectFixtureMarkers(request);
        for (const { receipt } of subject.receipts) collectFixtureMarkers(receipt);
        for (const allocation of subject.allocations.values()) collectFixtureMarkers(allocation);
      }
      const auditFrozenPrivateData = (root) => {
        const seen = new Set(); let clean = true;
        const scan = (candidate) => {
          if (typeof candidate === 'string' && [...privateStrings].some((marker) => candidate.includes(marker))) clean = false;
          if (typeof candidate === 'function' || typeof candidate === 'symbol') { clean = false; return; }
          if (typeof candidate === 'number' && [41002, 9001, 9002, 9003].includes(candidate)) clean = false;
          if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
          seen.add(candidate);
          if (!Object.isFrozen(candidate)) clean = false;
          for (const key of Reflect.ownKeys(candidate)) {
            if (typeof key !== 'string') clean = false;
            const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) { clean = false; continue; }
            if (descriptor.writable || descriptor.configurable) clean = false;
            scan(descriptor.value);
          }
        };
        scan(root); return clean;
      };
      record('all-results-frozen-and-sanitized', publicResults.length > 0 && publicResults.every((result) => {
        const decision = data(result, 'decision'); const reason = data(decision, 'reasons');
        const reasonValue = data(reason, '0');
        const contracts = {
          ALL_RESOURCES_RELEASED: ['CLOSED', 'CLOSE_COMPLETE'], CLOSE_ATTEMPT_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'],
          COMMAND_STOP_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'], COMMAND_OPERATION_IN_PROGRESS: ['CLOSING', 'WAIT_BOUNDED'], COMMANDS_REMAINING: ['CLOSING', 'WAIT_BOUNDED'],
          COMMAND_START_INCOMPLETE: ['HOLD', 'HOLD'], TEMPORARY_STATE_INVALID: ['HOLD', 'HOLD'],
          TEMPORARY_OBSERVATION_REJECTED: ['HOLD', 'HOLD'], TEMPORARY_RECLAIM_REJECTED: ['HOLD', 'HOLD'],
          TEMPORARY_QUARANTINE_REJECTED: ['HOLD', 'HOLD'], TEMPORARY_REMOVAL_REJECTED: ['HOLD', 'HOLD'],
          TEMPORARY_ABSENCE_REJECTED: ['HOLD', 'HOLD'], TEMPORARY_RELEASE_REJECTED: ['HOLD', 'HOLD'],
          COMMAND_SCOPE_CLOSE_REJECTED: ['HOLD', 'HOLD'], ROOT_SCOPE_CLOSE_REJECTED: ['HOLD', 'HOLD'],
        };
        const contract = typeof reasonValue === 'string' && Object.hasOwn(contracts, reasonValue) ? contracts[reasonValue] : undefined;
        return ownKeysEqual(result, ['status', 'decision']) && ownKeysEqual(decision, ['action', 'reasons', 'action_authorized'])
          && ownKeysEqual(reason, ['0', 'length']) && frozenDataDescriptors(result, ['status', 'decision'])
          && frozenDataDescriptors(decision, ['action', 'reasons', 'action_authorized']) && frozenDataDescriptors(reason, ['0', 'length'])
          && Object.getPrototypeOf(result) === Object.prototype && Object.getPrototypeOf(decision) === Object.prototype
          && Array.isArray(reason) && Object.getPrototypeOf(reason) === Array.prototype && data(reason, 'length') === 1 && typeof reasonValue === 'string'
          && contract !== undefined && data(result, 'status') === contract[0] && data(decision, 'action') === contract[1]
          && data(decision, 'action_authorized') === false && auditFrozenPrivateData(result);
      }), true);
    }
  } finally {
    for (const control of controls) if (!control.tracked.settled) control.resolve(control.response);
    await Promise.all(promises.map((entry) => entry.observed));
    Object.defineProperty(TaskResourceManager.prototype, 'stop', stopDescriptor);
    Object.defineProperty(TaskResourceTracker.prototype, 'verifyCloseResult', verifierDescriptor);
    for (const { method, descriptor } of saved) Object.defineProperty(ResourceScope.prototype, method, descriptor);
    for (const { method, descriptor } of savedTracker) Object.defineProperty(TaskResourceTracker.prototype, method, descriptor);
    active = null;
  }
  record('descriptors-restored', saved.every(({ method, descriptor }) => {
    const restored = Object.getOwnPropertyDescriptor(ResourceScope.prototype, method);
    return restored.value === descriptor.value && restored.configurable === descriptor.configurable && restored.enumerable === descriptor.enumerable && restored.writable === descriptor.writable;
  }) && Object.getOwnPropertyDescriptor(TaskResourceManager.prototype, 'stop').value === stopDescriptor.value
    && Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'verifyCloseResult').value === verifierDescriptor.value, true);
  record('promise-ledger-drained', promises.every((entry) => entry.settled), true);
  const allowedHoldLabels = ['v2-opening', 'malformed-open', 'closed-admission', 'pending-admission', 'pending-start', 'incomplete-start', 'capability-start'];
  record('promise-rejections-contained', promises.every((entry) => entry.outcome.kind === 'value'
    || (entry.label === 'adapter-rejection' && entry.outcome.error instanceof Error && entry.outcome.error.message === rawMarker)
    || (allowedHoldLabels.includes(entry.label) && entry.outcome.error instanceof TaskResourceManagerError
      && entry.outcome.error.code === 'TASK_RESOURCE_MANAGER_HOLD')), true);
  record('callback-promises-fulfilled', promises.filter((entry) => ['close', 'busy-settlement', 'stop-request', 'stop-confirm', 'start', 'pending-observe', 'pending-stop'].includes(entry.label))
    .every((entry) => entry.outcome.kind === 'value'), true);
  record('manager-descriptors-exact', [[TaskResourceManager.prototype, 'stop', stopDescriptor], [TaskResourceTracker.prototype, 'verifyCloseResult', verifierDescriptor]].every(([prototype, key, descriptor]) => {
    const restored = Object.getOwnPropertyDescriptor(prototype, key);
    return restored.value === descriptor.value && restored.enumerable === descriptor.enumerable
      && restored.configurable === descriptor.configurable && restored.writable === descriptor.writable;
  }), true);
  record('tracker-mutator-descriptors-exact', savedTracker.every(({ method, descriptor }) => {
    const restored = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, method);
    return restored.value === descriptor.value && restored.enumerable === descriptor.enumerable
      && restored.configurable === descriptor.configurable && restored.writable === descriptor.writable;
  }), true);
  record('getter-hits', getterHits, 0); record('fixture-errors', fixtureErrors.length, 0);
  record('aggregate-completion', seamAccepted ? 'ALL_V2_GROUPS_COMPLETED' : 'DEEPER_V2_GROUPS_UNEXECUTED', 'ALL_V2_GROUPS_COMPLETED');
  assert.deepStrictEqual(actual, expected, 'Unit 3-5B: exact V2 adapter seam and all independently specified temporary-close groups');
});

test('open rejects incoherent adapter version snapshots before probe and trust', () => {
  const { TaskResourceTracker } = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');
  const rootDescriptor = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'openRootScope');
  const actual = {};
  let current = null;
  try {
    Object.defineProperty(TaskResourceTracker.prototype, 'openRootScope', {
      ...rootDescriptor,
      value: function (...args) {
        if (current) current.rootCalls += 1;
        return Reflect.apply(rootDescriptor.value, this, args);
      },
    });
    for (const [label, shape, presentation] of [
      ['plain-v1', 'TaskResourcePlatformAdapter1', 'plain'],
      ['plain-v2', 'TaskResourcePlatformAdapter2', 'plain'],
      ['stable-proxy-v1', 'TaskResourcePlatformAdapter1', 'stable'],
      ['stable-proxy-v2', 'TaskResourcePlatformAdapter2', 'stable'],
      ['v1-shape-to-v2', 'TaskResourcePlatformAdapter1', 'changing'],
      ['v2-shape-to-v1', 'TaskResourcePlatformAdapter2', 'changing'],
    ]) {
      const fixture = validInput();
      const counters = { trustCalls: 0, rootCalls: 0 };
      current = counters;
      const producer = fixture.input.harness.trustedProducer;
      fixture.input.harness.trustedProducer = (candidate, context) => {
        counters.trustCalls += 1;
        return producer(candidate, context);
      };
      fixture.platformAdapter.type = shape;
      if (shape === 'TaskResourcePlatformAdapter2') {
        fixture.calls.observeTemporaryRoot = 0;
        fixture.platformAdapter.observeTemporaryRoot = () => { fixture.calls.observeTemporaryRoot += 1; };
      }
      if (presentation !== 'plain') {
        let typeSeen = false;
        fixture.input.platformAdapter = new Proxy(fixture.platformAdapter, {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (key !== 'type' || presentation === 'stable') return descriptor;
            const reported = typeSeen
              ? (shape === 'TaskResourcePlatformAdapter1' ? 'TaskResourcePlatformAdapter2' : 'TaskResourcePlatformAdapter1')
              : shape;
            typeSeen = true;
            return { ...descriptor, value: reported };
          },
        });
      }
      let outcome;
      try {
        const manager = TaskResourceManager.open(fixture.input);
        outcome = manager instanceof TaskResourceManager && Object.isFrozen(manager) ? 'OPENED' : 'INVALID_MANAGER';
      } catch (error) {
        outcome = error instanceof TaskResourceManagerError && error.code === 'TASK_RESOURCE_MANAGER_HOLD'
          ? 'CONTROLLED_HOLD' : 'UNEXPECTED_ERROR';
      }
      actual[label] = {
        outcome,
        probe: fixture.calls.probeCapabilities,
        trust: counters.trustCalls,
        root: counters.rootCalls,
        otherAdapterCalls: Object.entries(fixture.calls)
          .filter(([name]) => name !== 'probeCapabilities').reduce((sum, [, count]) => sum + count, 0),
      };
    }
  } finally {
    current = null;
    Object.defineProperty(TaskResourceTracker.prototype, 'openRootScope', rootDescriptor);
  }
  const restored = Object.getOwnPropertyDescriptor(TaskResourceTracker.prototype, 'openRootScope');
  actual.rootDescriptorRestored = restored.value === rootDescriptor.value
    && restored.configurable === rootDescriptor.configurable
    && restored.enumerable === rootDescriptor.enumerable && restored.writable === rootDescriptor.writable;
  assert.deepStrictEqual(actual, {
    'plain-v1': { outcome: 'OPENED', probe: 1, trust: 1, root: 1, otherAdapterCalls: 0 },
    'plain-v2': { outcome: 'OPENED', probe: 1, trust: 1, root: 1, otherAdapterCalls: 0 },
    'stable-proxy-v1': { outcome: 'OPENED', probe: 1, trust: 1, root: 1, otherAdapterCalls: 0 },
    'stable-proxy-v2': { outcome: 'OPENED', probe: 1, trust: 1, root: 1, otherAdapterCalls: 0 },
    'v1-shape-to-v2': { outcome: 'CONTROLLED_HOLD', probe: 0, trust: 0, root: 0, otherAdapterCalls: 0 },
    'v2-shape-to-v1': { outcome: 'CONTROLLED_HOLD', probe: 0, trust: 0, root: 0, otherAdapterCalls: 0 },
    rootDescriptorRestored: true,
  }, 'Unit 3-5B-R1: exact adapter version must match its validated method shape before probe');
});

// Retained as an unregistered historical tracer until a distinct Store RED
// packet admits it.  The preparation test above is intentionally Store-free.
// The producer below uses the actual manager holder. Store only receives data;
// the adapter callback aborts before any platform action or identity binding.
async function bootstrapStoreTracer(red = false) {
  const fs = require('fs');
  const os = require('os');
  const { RecoveryStore, RecoveryStoreError } = require('../skills/dw-collaboration/scripts/lib/recovery-store');
  const clone = value => JSON.parse(JSON.stringify(value));
  const runId = 'run-bootstrap-A';
  const expectedRefs = [AUTHORITY_REF, EVIDENCE_REF,
    ...['d', 'e', 'f'].map(letter => `evidence:${letter.repeat(64)}`)].sort();
  let producerCalls = 0;
  let captured;
  let holder;
  let firstAction = 0;
  const fixture = startFixture({
    envelopeMutator(envelope) {
      envelope.provenance.runId = runId;
      for (const [state, letter] of [['VERIFIED_DEGRADED', 'd'], ['UNVERIFIED', 'e'], ['FAILED', 'f']]) {
        envelope.supportMatrix.claims['observation_' + letter] = {
          state, evidence_refs: [`evidence:${letter.repeat(64)}`],
        };
      }
      envelope.supportMatrix.overall_state = 'FAILED';
    },
    trustedProducer(envelope, context) {
      producerCalls += 1;
      return !context.resolutionType && Object.isFrozen(envelope) && Object.isFrozen(context)
        && envelope.provenance.runId === runId && context.runId === runId
        && context.harnessId === 'harness-A' && context.adapterId === 'adapter-A'
        && context.authorizationSha256 === computeDetachedSha256(authorization(false))
        && canonicalizeDetachedSnapshot(context.requiredReferences) === canonicalizeDetachedSnapshot(expectedRefs);
    },
    allocation(request) {
      firstAction += 1;
      assert.strictEqual(firstAction, 1);
      captured = holder.consumeBootstrapSeed({ commandId: request.commandId, purpose: 'bootstrap_store_schema_red' });
      throw new Error('BOOTSTRAP_CAPTURE_COMPLETE_BEFORE_SIDE_EFFECT');
    },
    spawn() { throw new Error('bootstrap verification must never spawn'); },
  });
  fixture.input.runId = runId;
  holder = api.createBootstrapSeedVerificationHolder(fixture.input.harness.trustedProducer);
  const manager = fixture.manager();
  await expectHoldAsync(() => manager.startCommand(commandInput({ commandId: 'bootstrap',
    bootstrapVerificationHolder: holder, retryBudget: 2, repairBudget: 3 })));
  assert.strictEqual(firstAction, 1);
  assert.strictEqual(producerCalls, 1);
  assert.strictEqual(fixture.calls.spawnManaged, 0);
  const transaction = bootstrapTransactionFromSeed(captured);
  assert.strictEqual(transaction.originalProvenance.runId, runId);
  const declarations = transaction.trackerHistory.filter(event => event.kind === 'RESOURCE_REGISTERED');
  assert.strictEqual(declarations.length, 3);
  declarations.forEach(event => assert.deepStrictEqual(event.payload.declaration.evidenceRefs, expectedRefs));
  assert(transaction.trackerHistory.every(event => ['SCOPE_OPENED', 'RESOURCE_REGISTERED'].includes(event.kind)));
  const sideEffectsBeforeStore = { producerCalls, calls: clone(fixture.calls) };
  const tempParent = fs.realpathSync(os.tmpdir());
  const requested = process.env.DW_TRANSACTION_TEST_ROOT;
  if (red) {
    assert.strictEqual(process.argv.length, 5);
    assert.strictEqual(process.argv[1], path.join(path.resolve(__dirname, '..', '..', '..'),
      '.superpowers', 'sdd', 'development-workflow-5.3.0-plan', 's-bootstrap-launcher.cjs'));
    assert.strictEqual(process.argv[2], 'red');
    assert.strictEqual(process.argv[4], 'native-v1');
    assert(/^[0-9a-f-]{36}$/.test(process.argv[3]));
    assert.strictEqual(process.argv[3], process.env.DW_TASK_LAUNCH_NONCE);
    assert.strictEqual(path.basename(tempParent), 'dw-u36a-' + process.argv[3]);
    assert.strictEqual(requested, path.join(tempParent, 'manager-fixture'));
    assert.strictEqual(process.cwd(), path.resolve(__dirname, '..'));
  }
  const owned = new Map();
  const stores = [];
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino
    && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
  let root;
  let receipt;
  const failures = [];
  const bind = target => {
    assert(target === root || (path.relative(root, target) && !path.relative(root, target).startsWith('..')
      && !path.isAbsolute(path.relative(root, target))));
    const stat = fs.lstatSync(target, { bigint: true });
    assert(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()));
    if (owned.has(target)) assert(same(stat, owned.get(target)), 'never adopt a replacement');
    else owned.set(target, stat);
    // Register in the shared suite ledger as well: removal is owned by the
    // suite finalizer, not by this test alone.
    fixtureBind(target);
  };
  const open = (name = '', limits) => {
    const dataRoot = name ? path.join(root, name) : root;
    const store = RecoveryStore.open({ dataRoot, runId, writerId: 'bootstrap-writer-A', ...(limits ? { limits } : {}) });
    stores.push(store);
    for (const directory of [dataRoot, path.join(dataRoot, 'development-workflow'),
      path.join(dataRoot, 'development-workflow', 'recovery'),
      path.join(dataRoot, 'development-workflow', 'recovery', runId)]) bind(directory);
    return { store, dataRoot };
  };
  const disk = (subject, revision) => {
    const file = path.join(subject.dataRoot, 'development-workflow', 'recovery', runId, `pending-revision-${revision}.json`);
    bind(file);
    const bytes = fs.readFileSync(file, 'utf8');
    bind(file);
    return JSON.parse(bytes);
  };
  const save = (subject, tx, head = null) => {
    const result = subject.store.saveTransaction({ expectedRevision: head?.revision || 0,
      expectedContentSha256: head?.content_sha256 || null, transaction: tx });
    const base = { schema: 'RecoveryStoreTransaction2', schema_version: 2, run_id: runId,
      revision: (head?.revision || 0) + 1, previous_content_sha256: head?.content_sha256 || null, transaction: tx };
    const expected = { ...base, content_sha256: computeDetachedSha256(createDetachedJsonSnapshot(base).snapshot) };
    assert.deepStrictEqual(result, { persisted: true, runId, expectedRevision: base.revision - 1,
      expectedContentSha256: base.previous_content_sha256, revision: base.revision,
      previousContentSha256: base.previous_content_sha256, contentSha256: expected.content_sha256 });
    assert.deepStrictEqual(disk(subject, base.revision), expected);
    assert.deepStrictEqual(subject.store.loadTransaction(), expected);
    return expected;
  };
  const expectStoreHold = fn => assert.throws(fn, error => error instanceof RecoveryStoreError
    && error.name === 'RecoveryStoreError' && error.code === 'RECOVERY_STORE_HOLD');
  const resealHistory = tx => {
    let previous = null;
    for (const event of tx.trackerHistory) {
      event.previousEventSha256 = previous;
      const value = { ...event }; delete value.eventSha256;
      event.eventSha256 = computeDetachedSha256(createDetachedJsonSnapshot(value).snapshot);
      previous = event.eventSha256;
    }
  };
  try {
    root = createFixtureRoot();
    bind(root);
    assert.strictEqual(fs.realpathSync(root), root);
    const subject = open();
    assert.strictEqual(subject.store.loadTransaction(), null);
    if (red) {
      let saveTransactionCalls = 0;
      const call = subject.store.saveTransaction.bind(subject.store);
      expectStoreHold(() => {
        saveTransactionCalls += 1;
        call({ expectedRevision: 0, expectedContentSha256: null, transaction });
      });
      assert.strictEqual(saveTransactionCalls, 1);
      assert.strictEqual(subject.store.loadTransaction(), null);
      const directory = path.join(root, 'development-workflow', 'recovery', runId);
      assert.deepStrictEqual(fs.readdirSync(directory), ['writer-lease.json']);
      receipt = { event: 'BOOTSTRAP_STORE_SCHEMA_RED', phase: 'red', pid: process.pid,
        launchNonce: process.env.DW_TASK_LAUNCH_NONCE,
        storeSha256: require('crypto').createHash('sha256').update(fs.readFileSync(
          require.resolve('../skills/dw-collaboration/scripts/lib/recovery-store'))).digest('hex'),
        transactionSchema: transaction.schema, transactionSchemaVersion: transaction.schema_version,
        transactionCanonicalSha256: computeDetachedSha256(transaction), expectedRevision: 0,
        expectedContentSha256: null, preHeadRevision: null, preHeadContentSha256: null,
        postHeadRevision: null, postHeadContentSha256: null, saveTransactionCalls,
        errorName: 'RecoveryStoreError', errorCode: 'RECOVERY_STORE_HOLD' };
    } else {
      const { FailureLoopGuard } = require('../skills/dw-collaboration/scripts/lib/failure-loop-guard');
      const guardId = transaction.failureLoopState.guardId;
      const initialTransaction = clone(transaction);
      // This prefix is the actual manager Tracker's root event, not a fabricated history.
      initialTransaction.trackerHistory = initialTransaction.trackerHistory.slice(0, 1);
      assert.strictEqual(initialTransaction.trackerHistory[0].kind, 'SCOPE_OPENED');
      const initialGuard = transaction.failureLoopState;
      const guardAck = { persisted: true, runId, guardId, expectedRevision: 0,
        expectedStateSha256: null, revision: 1, previousStateSha256: null,
        stateSha256: initialGuard.stateSha256 };
      const expectedTrust = { purpose: 'failure_state_save_ack', runId, guardId,
        expectedRevision: 0, expectedStateSha256: null, stateRevision: 1,
        previousStateSha256: null, stateSha256: initialGuard.stateSha256, acknowledgement: guardAck };
      let first;
      let guardSaves = 0;
      let guardReads = 0;
      let guardTrustChecks = 0;
      const guard = new FailureLoopGuard({
        runId, guardId, retryBudget: initialGuard.retryBudget, repairBudget: initialGuard.repairBudget,
        store: {
          load(context) {
            guardReads += 1;
            assert.deepStrictEqual(context, { runId, guardId });
            const loaded = subject.store.loadTransaction();
            return loaded === null ? null : loaded.transaction.failureLoopState;
          },
          save(next, context) {
            guardSaves += 1;
            assert.strictEqual(guardSaves, 1);
            assert.deepStrictEqual(context, { runId, guardId, expectedRevision: 0, expectedStateSha256: null });
            assert.deepStrictEqual(next, initialGuard, 'real Guard must construct the same initial state as real holder');
            const tx = { ...initialTransaction, failureLoopState: next };
            // save() verifies the real Store receipt, disk envelope and public read-back
            // before translating its acknowledgement into the Guard acknowledgement.
            first = save(subject, tx);
            return { ...guardAck };
          },
        },
        evidenceResolver: () => false, classificationResolver: () => null, authorizationResolver: () => false,
        trustedStateResolver(context) {
          guardTrustChecks += 1;
          const actual = subject.store.loadTransaction();
          return canonicalizeDetachedSnapshot(context) === canonicalizeDetachedSnapshot(expectedTrust)
            && actual.revision === 1 && actual.content_sha256 === first.content_sha256
            && canonicalizeDetachedSnapshot(actual.transaction.failureLoopState) === canonicalizeDetachedSnapshot(initialGuard);
        },
      });
      assert.deepStrictEqual({ guardSaves, guardReads, guardTrustChecks }, { guardSaves: 1, guardReads: 2, guardTrustChecks: 1 });
      assert.strictEqual(guard.retryUsed, 0); assert.strictEqual(guard.repairUsed, 0);
      assert.strictEqual(first.transaction.trackerHistory.length, 1);
      const second = save(subject, transaction, first);
      assert.strictEqual(second.transaction.trackerHistory.length, 5);
      assert.deepStrictEqual(second.transaction.trackerHistory.slice(0, 1), first.transaction.trackerHistory);
      let restoreChecks = 0;
      const restoredGuard = new FailureLoopGuard({
        runId, guardId, retryBudget: initialGuard.retryBudget, repairBudget: initialGuard.repairBudget,
        store: {
          load(context) {
            assert.deepStrictEqual(context, { runId, guardId });
            return subject.store.loadTransaction().transaction.failureLoopState;
          },
          save() { throw new Error('restoring an initial Guard must not rewrite Store'); },
        },
        evidenceResolver: () => false, classificationResolver: () => null, authorizationResolver: () => false,
        trustedStateResolver(context) {
          restoreChecks += 1;
          const expected = { purpose: 'failure_state_load', runId, guardId, stateRevision: 1,
            previousStateSha256: null, stateSha256: initialGuard.stateSha256 };
          const actual = subject.store.loadTransaction();
          return canonicalizeDetachedSnapshot(context) === canonicalizeDetachedSnapshot(expected)
            && actual.content_sha256 === second.content_sha256
            && canonicalizeDetachedSnapshot(actual.transaction.failureLoopState) === canonicalizeDetachedSnapshot(initialGuard);
        },
      });
      assert.strictEqual(restoreChecks, 1);
      assert.strictEqual(restoredGuard.retryUsed, 0); assert.strictEqual(restoredGuard.repairUsed, 0);
      assert.deepStrictEqual(subject.store.loadTransaction(), second);
      assert(Object.isFrozen(subject.store.loadTransaction().transaction.originalCapabilityEnvelope.supportMatrix));
      // First-head rejection and rehashed history prevent continuity/hash checks
      // from accidentally substituting for each specific V3 admission check.
      const grammar = open('grammar');
      const mutations = [
        ['subset', tx => { tx.trackerHistory[2].payload.declaration.evidenceRefs = [AUTHORITY_REF]; }],
        ['substitution', tx => { tx.trackerHistory[2].payload.declaration.evidenceRefs = [AUTHORITY_REF, `evidence:${'a'.repeat(64)}`]; }],
        ['superset', tx => { tx.trackerHistory[2].payload.declaration.evidenceRefs.push(`evidence:${'a'.repeat(64)}`); tx.trackerHistory[2].payload.declaration.evidenceRefs.sort(); }],
        ['per-resource divergence', tx => { tx.trackerHistory[3].payload.declaration.evidenceRefs = [AUTHORITY_REF, EVIDENCE_REF]; }],
        ['adapter', tx => { tx.originalCapabilityEnvelope.supportMatrix.adapter_id = 'other'; }],
        ['platform', tx => { tx.originalCapabilityEnvelope.supportMatrix.platform = 'linux'; }],
        ['time', tx => { tx.originalCapabilityEnvelope.supportMatrix.observed_at = '2000-01-01T00:00:00Z'; }],
        ['provenance', tx => { tx.originalCapabilityEnvelope.provenance.ownerId = 'other'; }],
        ['matrix grammar', tx => { tx.originalCapabilityEnvelope.supportMatrix.claims.observation_d.evidence_refs = []; }],
        ['envelope extra', tx => { tx.originalCapabilityEnvelope.extra = true; }],
        ['envelope missing', tx => { delete tx.originalCapabilityEnvelope; }],
        ['version', tx => { tx.schema_version = 4; }],
        ['bound history', tx => { tx.trackerHistory[4].kind = 'RESOURCE_BOUND'; }],
        ['extra history', tx => { tx.trackerHistory[4].payload.extra = true; }],
        ['bound records', tx => { tx.records = [{}]; }],
      ];
      for (const [name, mutate] of mutations) {
        const candidate = clone(transaction); mutate(candidate); resealHistory(candidate);
        expectStoreHold(() => grammar.store.saveTransaction({ expectedRevision: 0,
          expectedContentSha256: null, transaction: candidate }));
        assert.strictEqual(grammar.store.loadTransaction(), null, name + ' must not publish');
      }
      for (const kind of ['getter', 'null-prototype', 'symbol', 'nonenumerable']) {
        let reads = 0;
        const candidate = clone(transaction);
        if (kind === 'getter') Object.defineProperty(candidate.originalCapabilityEnvelope, 'supportMatrix',
          { enumerable: true, get() { reads += 1; throw Error('getter executed'); } });
        if (kind === 'null-prototype') Object.setPrototypeOf(candidate.originalCapabilityEnvelope, null);
        if (kind === 'symbol') candidate.originalCapabilityEnvelope[Symbol('extra')] = true;
        if (kind === 'nonenumerable') Object.defineProperty(candidate.originalCapabilityEnvelope, 'extra', { value: true });
        expectStoreHold(() => grammar.store.saveTransaction({ expectedRevision: 0,
          expectedContentSha256: null, transaction: candidate }));
        assert.strictEqual(reads, 0); assert.strictEqual(grammar.store.loadTransaction(), null);
      }
      save(grammar, transaction);
      const holdHead = candidate => {
        expectStoreHold(() => subject.store.saveTransaction({ expectedRevision: 2,
          expectedContentSha256: second.content_sha256, transaction: candidate }));
        assert.deepStrictEqual(subject.store.loadTransaction(), second);
      };
      for (const expected of [
        { expectedRevision: 1, expectedContentSha256: first.content_sha256 },
        { expectedRevision: 2, expectedContentSha256: '0'.repeat(64) },
      ]) {
        expectStoreHold(() => subject.store.saveTransaction({ ...expected, transaction }));
        assert.deepStrictEqual(subject.store.loadTransaction(), second, 'failed CAS must retain head2');
      }
      const digest = (value, field) => {
        const base = { ...value }; delete base[field];
        value[field] = computeDetachedSha256(createDetachedJsonSnapshot(base).snapshot);
      };
      const extraBody = clone(transaction); extraBody.metadata = {}; holdHead(extraBody);
      const laterGuard = clone(transaction);
      laterGuard.failureLoopState.revision = 2;
      laterGuard.failureLoopState.previousStateSha256 = initialGuard.stateSha256;
      digest(laterGuard.failureLoopState, 'stateSha256'); holdHead(laterGuard);
      const changedGuard = clone(transaction);
      changedGuard.failureLoopState.retryBudget += 1;
      digest(changedGuard.failureLoopState, 'stateSha256'); holdHead(changedGuard);
      const changedAuthority = clone(transaction);
      changedAuthority.originalAuthorization.allowForceTermination = true;
      changedAuthority.originalProvenance.authorizationSha256 = computeDetachedSha256(changedAuthority.originalAuthorization);
      changedAuthority.originalCapabilityEnvelope.provenance = clone(changedAuthority.originalProvenance);
      holdHead(changedAuthority);
      const alternativeHistory = clone(transaction);
      for (const event of alternativeHistory.trackerHistory.slice(1)) {
        event.payload.scopeId = event.payload.scopeId.replace('command:bootstrap', 'command:alternative');
        if (event.payload.declaration) {
          const declaration = event.payload.declaration;
          declaration.resourceId = declaration.resourceId.replace('command:bootstrap', 'command:alternative');
          if (declaration.parentResourceId !== null) declaration.parentResourceId =
            declaration.parentResourceId.replace('command:bootstrap', 'command:alternative');
        }
      }
      resealHistory(alternativeHistory);
      save(open('alternative-history-control'), alternativeHistory);
      holdHead(alternativeHistory); // valid first-write history cannot replace committed history.
      const { validateRecoveryRecord2 } = require('../skills/dw-collaboration/scripts/lib/identity-support-v2');
      const original = transaction.originalProvenance;
      const boundRecord = {
        schema: 'RecoveryRecord2', schema_version: 2, resource_id: 'command:bootstrap:process-tree',
        resource_type: 'process_tree', run_id: runId, session_id: original.sessionId,
        lease_generation: original.managerGeneration,
        identity: processIdentityFor({ provenance: original, launchNonce: 'fixture-record-no-process-launched' }),
        current_phase: { phase: 'cleanup', state: 'ACTIVE' },
        last_valid_observation: { observed_at: original.observedAt,
          observation_ref: `observation:${'d'.repeat(64)}`, identity_ref: `identity:${'e'.repeat(64)}` },
        cleanup_authority_ref: AUTHORITY_REF, teardown_condition: 'identity_absence_verified', evidence_refs: [EVIDENCE_REF],
      };
      assert.strictEqual(validateRecoveryRecord2(boundRecord).valid, true, 'negative record itself must be valid Record2');
      const boundBootstrap = clone(transaction); boundBootstrap.records = [boundRecord]; holdHead(boundBootstrap);
      const v1 = open('v1');
      v1.store.savePending({ records: [boundRecord] });
      const v1Head = v1.store.loadPending();
      assert.deepStrictEqual(v1Head.records, [boundRecord]);
      const v1Envelope = { schema: 'RecoveryStorePending1', schema_version: 1, run_id: runId, ...v1Head };
      assert.deepStrictEqual(disk(v1, 1), v1Envelope);
      expectStoreHold(() => v1.store.loadTransaction());
      for (const version of [2, 3]) {
        const candidate = clone(transaction);
        if (version === 2) { candidate.schema = 'TaskResourceManagerBootstrap2'; candidate.schema_version = 2;
          delete candidate.originalCapabilityEnvelope; }
        expectStoreHold(() => v1.store.saveTransaction({ expectedRevision: v1Head.revision,
          expectedContentSha256: v1Head.content_sha256, transaction: candidate }));
        assert.deepStrictEqual(v1.store.loadPending(), v1Head);
        assert.deepStrictEqual(disk(v1, 1), v1Envelope);
      }
      const drift = clone(transaction);
      drift.originalCapabilityEnvelope.supportMatrix.claims.observation_d.state = 'VERIFIED_FULL';
      holdHead(drift); // still-valid matrix, same refs, fails envelope continuity.
      const rewind = clone(transaction); rewind.trackerHistory = rewind.trackerHistory.slice(0, 1); holdHead(rewind);
      const v2 = clone(transaction); v2.schema = 'TaskResourceManagerBootstrap2'; v2.schema_version = 2;
      delete v2.originalCapabilityEnvelope;
      holdHead(v2);
      const legacy = open('v2'); const v2Head = save(legacy, v2);
      expectStoreHold(() => legacy.store.saveTransaction({ expectedRevision: 1,
        expectedContentSha256: v2Head.content_sha256, transaction }));
      assert.deepStrictEqual(legacy.store.loadTransaction(), v2Head);
      expectStoreHold(() => legacy.store.loadPending());
      expectStoreHold(() => legacy.store.savePending({ records: [] }));
      assert.deepStrictEqual(legacy.store.loadTransaction(), v2Head);
      assert.deepStrictEqual(legacy.store.close(), { released: true, disposition: 'RELEASED' });
      const reopened = open('v2'); assert.deepStrictEqual(reopened.store.loadTransaction(), v2Head);
      const oldMeaning = clone(v2); oldMeaning.trackerHistory[2].payload.declaration.evidenceRefs = [AUTHORITY_REF, EVIDENCE_REF];
      resealHistory(oldMeaning); save(open('v2-old-meaning'), oldMeaning);
      expectStoreHold(() => subject.store.loadPending());
      expectStoreHold(() => subject.store.savePending({ records: [] }));
      assert.deepStrictEqual(subject.store.loadTransaction(), second);
      const limited = open('limited', { maxTotalBytes: Buffer.byteLength(canonicalizeDetachedSnapshot(transaction)) });
      expectStoreHold(() => limited.store.saveTransaction({ expectedRevision: 0,
        expectedContentSha256: null, transaction }));
      assert.strictEqual(limited.store.loadTransaction(), null);
      const scanLimited = open('scan-limited', { maxRevisionScan: 3 });
      const scanHead = save(scanLimited, transaction);
      expectStoreHold(() => scanLimited.store.saveTransaction({ expectedRevision: 1,
        expectedContentSha256: scanHead.content_sha256, transaction }));
      assert.deepStrictEqual(scanLimited.store.loadTransaction(), scanHead,
        'scan capacity must reserve temporary plus final publication entries');
      const aggregate = open('aggregate');
      const aggregateFirst = save(aggregate, initialTransaction);
      const aggregateSecond = save(aggregate, transaction, aggregateFirst);
      const aggregateDirectory = path.join(aggregate.dataRoot, 'development-workflow', 'recovery', runId);
      const retainedBytes = [1, 2].reduce((sum, revision) => sum + fs.statSync(
        path.join(aggregateDirectory, `pending-revision-${revision}.json`)).size, 0);
      const payloadBytes = Buffer.byteLength(canonicalizeDetachedSnapshot(transaction));
      assert.deepStrictEqual(aggregate.store.close(), { released: true, disposition: 'RELEASED' });
      const aggregateLimited = open('aggregate', { maxTotalBytes: retainedBytes + payloadBytes });
      assert.deepStrictEqual(aggregateLimited.store.loadTransaction(), aggregateSecond);
      expectStoreHold(() => aggregateLimited.store.saveTransaction({ expectedRevision: 2,
        expectedContentSha256: aggregateSecond.content_sha256, transaction }));
      assert.deepStrictEqual(aggregateLimited.store.loadTransaction(), aggregateSecond,
        'retained revisions and full proposed envelope must count toward aggregate bytes');
      assert.deepStrictEqual(aggregateLimited.store.close(), { released: true, disposition: 'RELEASED' });
      const sufficient = open('aggregate');
      save(sufficient, transaction, aggregateSecond);
      const foreign = open('foreign-to-store');
      const foreignFile = path.join(foreign.dataRoot, 'development-workflow', 'recovery', runId, 'foreign-evidence.txt');
      // Foreign to Store's revision grammar, explicitly created/bound to this test
      // fixture; Store cannot delete it, while verified test teardown owns it.
      fs.writeFileSync(foreignFile, 'fixture-owned-unrecognized-store-entry', 'utf8'); bind(foreignFile);
      expectStoreHold(() => foreign.store.loadTransaction());
      expectStoreHold(() => foreign.store.saveTransaction({ expectedRevision: 0,
        expectedContentSha256: null, transaction }));
      assert.strictEqual(fs.readFileSync(foreignFile, 'utf8'), 'fixture-owned-unrecognized-store-entry');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(foreignFile)).sort(), ['foreign-evidence.txt', 'writer-lease.json']);
      assert.deepStrictEqual(subject.store.close(), { released: true, disposition: 'RELEASED' });
      assert.deepStrictEqual(open().store.loadTransaction(), second);
    }
    assert.deepStrictEqual({ producerCalls, calls: fixture.calls }, sideEffectsBeforeStore,
      'Store must not call the producer or any platform adapter');
  } catch (error) { failures.push(error); }
  finally {
    let safe = true;
    for (const store of stores.slice().reverse()) {
      try { assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' }); }
      catch (error) { safe = false; failures.push(error); }
    }
    if (root !== undefined) {
      try {
        assert(safe, 'unknown Store lifecycle retains the fixture');
        assert.strictEqual(fs.realpathSync(root), root);
        assert.strictEqual(path.dirname(root), tempParent);
        // File-level removal is owned by the suite finalizer, which runs after
        // every test and before the summary line. Keeping it here would reject
        // the per-instance sub-roots that other tests created under this root.
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'bootstrap Store tracer or fixture cleanup failed');
  if (red) process.stdout.write(JSON.stringify(receipt) + '\n');
}

// Unit 3-6B first tracer. The manager already records pre-action pending in
// memory; this asserts that the same pending becomes durable and that STARTED is
// only published once that durable result exists. Every assertion is collected
// into one aggregate diff so a single run surfaces all deltas at once.
test('3-6B manager publishes STARTED only after a durable runtime transaction exists', async () => {
  const actual = {};
  const expected = {};
  const record = (label, value, literal) => { actual[label] = value; expected[label] = literal; };
  const { createInitialFailureLoopState } = require('../skills/dw-collaboration/scripts/lib/failure-loop-guard');
  const runId = 'run-3-1';
  const runDirectory = (root) => path.join(root, 'development-workflow', 'recovery', runId);
  const revisionsIn = (directory) => (fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => /^pending-revision-\d+\.json$/.test(name)) : []);

  // A3 (guard, not a RED): open() must stay probe-only, so its own instance root
  // must never appear merely because a manager was opened on it.
  const guardFixture = startFixture();
  guardFixture.manager();
  record('a3-open-is-probe-only', fs.existsSync(guardFixture.input.dataRoot), false);

  // A1/A2/A6: a real startCommand must leave a durable runtime transaction whose
  // failureLoopState is the real Guard state rather than its snapshot() projection.
  const fixture = startFixture();
  const dataRoot = fixture.input.dataRoot;
  record('a3-instance-root-absent-before-use', fs.existsSync(dataRoot), false);
  const manager = fixture.manager();
  let started = null;
  try { started = await manager.startCommand(commandInput({ commandId: 'u8-A' })); } catch (error) { record('a1-start-error', String(error && error.code), null); }
  record('a1-start-command-status', started && started.status, 'STARTED');

  const directory = runDirectory(dataRoot);
  const revisions = revisionsIn(directory);
  record('a1-durable-revision-present', revisions.length > 0, true);
  let transaction = null;
  if (revisions.length > 0) {
    // Numeric order, not lexicographic: 'pending-revision-10.json' sorts before
    // '...-9.json' as a string, which would silently read a stale revision once ten
    // of them exist — and the stale read presents as a product regression, not as
    // an obvious error.
    const newest = revisions
      .map((name) => Number(/^pending-revision-(\d+)\.json$/.exec(name)[1]))
      .sort((left, right) => left - right)
      .pop();
    transaction = JSON.parse(
      fs.readFileSync(path.join(directory, `pending-revision-${newest}.json`), 'utf8'),
    ).transaction;
  }
  const body = transaction && transaction.transaction ? transaction.transaction : transaction;
  record('a1-runtime-discriminator', body && body.schema, 'TaskResourceManagerRuntime1');
  const commands = body && Array.isArray(body.commands) ? body.commands : [];
  const actions = body && Array.isArray(body.actions) ? body.actions : [];
  record('a1-command-recorded', commands.some((entry) => entry.commandId === 'u8-A'), true);
  record('a1-allocate-intent-recorded', actions.some((entry) => entry.method === 'allocateTemporaryRoot' && entry.intent !== undefined), true);
  record('a1-spawn-confirmed-recorded', actions.some((entry) => entry.method === 'spawnManaged' && entry.outcome && entry.outcome.status === 'CONFIRMED'), true);

  // A2: the persisted guard payload must be the real state, never snapshot().
  // The expected key set is derived from a real Guard state, not hardcoded.
  const reference = createInitialFailureLoopState({ runId, guardId: 'u8-guard', retryBudget: 0, repairBudget: 0 });
  const realKeys = Object.keys(reference).sort();
  const guardState = body && body.failureLoopState;
  record('a2-guard-keys-are-real-state', guardState && Object.keys(guardState).sort().join(','), realKeys.join(','));
  record('a2-guard-not-snapshot-projection', Boolean(guardState && (Object.hasOwn(guardState, 'version') || Object.hasOwn(guardState, 'budgets'))), false);

  // A4: when the Store cannot be established, no adapter action may run and the
  // command must settle as a controlled HOLD. The blocking entry is created
  // through the same registered fs the launcher patches, so the injection is
  // attributable to the expected product behaviour rather than to the harness.
  const faultRoot = instanceDataRoot();
  fs.mkdirSync(faultRoot);
  fixtureBind(faultRoot);
  const faultPath = path.join(faultRoot, 'development-workflow');
  fs.writeFileSync(faultPath, 'u8-fault-occupies-the-store-directory-position', 'utf8');
  fixtureBind(faultPath);
  const faultFixture = startFixture({ dataRootOverride: faultRoot });
  let faultError = null;
  try { await faultFixture.manager().startCommand(commandInput({ commandId: 'u8-fault' })); } catch (error) { faultError = error; }
  const faultActions = faultFixture.calls.allocateTemporaryRoot + faultFixture.calls.spawnManaged
    + faultFixture.calls.observeProcess + faultFixture.calls.requestGracefulStop;
  record('a4-zero-adapter-actions', faultActions, 0);
  record('a4-controlled-hold', Boolean(faultError && faultError.code === 'TASK_RESOURCE_MANAGER_HOLD'), true);

  // A5: a second live manager on the same (dataRoot, runId) must hold at its first
  // persisting operation. The lease is joint in dataRoot and runId, so both are pinned.
  const secondFixture = startFixture({ dataRootOverride: dataRoot });
  let secondError = null;
  let secondStarted = null;
  try { secondStarted = await secondFixture.manager().startCommand(commandInput({ commandId: 'u8-second' })); } catch (error) { secondError = error; }
  record('a5-second-manager-holds', Boolean(secondError && secondError.code === 'TASK_RESOURCE_MANAGER_HOLD') || secondStarted === null, true);
  record('a5-second-manager-zero-actions', secondFixture.calls.allocateTemporaryRoot + secondFixture.calls.spawnManaged, 0);

  // A6: the durable artefacts survive a real close, and that close releases the
  // writer lease rather than leaving it for anyone to hand-delete.
  let closeResult = null;
  try { closeResult = await manager.close(); } catch (error) { record('a6-close-error', String(error && error.code), null); }
  const afterClose = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  record('a6-artifacts-survive-close', afterClose.some((name) => /^pending-revision-\d+\.json$/.test(name)), true);
  record('a6-lease-released-by-close', afterClose.includes('writer-lease.json'), false);
  record('a6-close-reported', Boolean(closeResult), true);

  // Negative fixtures for the runtime-chain rules. A validator whose reject
  // direction is never exercised is indistinguishable from a no-op, and the
  // accept direction is already covered by every green scenario above. Each
  // mutation is applied to the durable head this test just produced and must be
  // refused by the Store rather than silently written.
  const { RecoveryStore, RecoveryStoreError } = require('../skills/dw-collaboration/scripts/lib/recovery-store');
  const negative = RecoveryStore.open({ dataRoot, runId, writerId: 'u8-negative-writer' });
  const head = negative.loadTransaction();
  const expectRejected = (label, mutate) => {
    const candidate = JSON.parse(JSON.stringify(head.transaction));
    mutate(candidate);
    let rejected = false;
    try {
      negative.saveTransaction({
        expectedRevision: head.revision,
        expectedContentSha256: head.content_sha256,
        transaction: candidate,
      });
    } catch (error) {
      rejected = error instanceof RecoveryStoreError && error.code === 'RECOVERY_STORE_HOLD';
    }
    record(`n-${label}`, rejected, true);
  };
  expectRejected('nonce-mutated', (body) => { body.actions[0].nonce = 'f'.repeat(64); });
  expectRejected('predecessor-forward', (body) => { body.actions[body.actions.length - 1].predecessor = 9; });
  expectRejected('predecessor-self', (body) => { body.actions[0].predecessor = body.actions[0].sequence; });
  expectRejected('command-not-recorded', (body) => { body.actions[0].commandId = 'not-a-recorded-command'; });
  expectRejected('history-position-gap', (body) => {
    if (body.trackerHistory.length < 2) throw new Error('history too short to drop an event');
    body.trackerHistory = body.trackerHistory.filter((_event, index) => index !== 1);
  });
  expectRejected('guard-revision-skip', (body) => { body.failureLoopState.revision = body.failureLoopState.revision + 2; });
  const closedNegative = negative.close();
  record('n-negative-store-released', Boolean(closedNegative && closedNegative.released), true);

  assert.deepStrictEqual(actual, expected, 'Unit 3-6B: durable pre-action transaction and publication order');
});

test('Store V3 preserves real holder data, validates reference equality and isolates V2 chains', () => bootstrapStoreTracer());


const TASK_RESOURCE_TEST_FOCUS = process.env.DW_TASK_RESOURCE_TEST_FOCUS;
const M2_V2_CONTRACT_FOCUS = 'm2-v2-contract-v1';
const M2_V2_CONTRACT_TEST_NAMES = Object.freeze([
  'u8 fixture root is created once under the registered task temporary parent',
  'open creates a frozen manager only after provenance and reference trust validation',
  'open holds on unknown references, provenance mismatch, authorization hash mismatch, and invalid support matrix',
  'open holds when trusted producer rejects the otherwise valid envelope',
  'open rejects a RecoveryRecord2-shaped authorization before probing',
  'open does not call any future platform action during root creation',
  'open rejects getters, extra top-level fields, and illegal limits before probing',
  'C holder factory replaces public Seed1 export with a minimal frozen capability',
  'M2 grammar baseline retains exact normal V1 and bootstrap V1 admission',
  'M2 RED admits exact seven-key normal V2 null contract before start effects',
  'M2 RED admits exact seven-key normal V2 non-null contract without authority material',
  'M2 RED admits exact ten-key bootstrap V2 null and non-null contracts',
  'M2 exact-set rejects malformed normal and bootstrap V2 shapes before effects',
  'M2 descriptor and object rejections preserve the universal no-effect boundary',
  'M2 non-null contract grammar rejects exact-shape violations before effects',
  'M2 reflection traps reject normal and bootstrap V2 before effects',
  'M2 exhaustive V2 malformed contract and command specimens remain pre-effect holds',
]);

function selectTaskResourceTests() {
  if (TASK_RESOURCE_TEST_FOCUS === undefined) {
    return {
      selectedTests: tests,
      summaryLine: `task resource manager tests passed (${tests.length} tests).\n`,
    };
  }
  assert.strictEqual(TASK_RESOURCE_TEST_FOCUS, M2_V2_CONTRACT_FOCUS);
  const sentinelIndex = tests.findIndex(({ name }) => name === M2_V2_CONTRACT_TEST_NAMES.at(-1));
  assert.strictEqual(sentinelIndex, 16);
  assert.strictEqual(tests.length, 55);
  const selectedTests = tests.slice(0, 17);
  assert.strictEqual(selectedTests.length, 17);
  assert.deepStrictEqual(selectedTests.map(({ name }) => name), M2_V2_CONTRACT_TEST_NAMES);
  return {
    selectedTests,
    summaryLine: 'task resource manager focused M2 tests passed (17 tests).\n',
  };
}

(async () => {
  const { selectedTests, summaryLine } = selectTaskResourceTests();
  // Suite finalizer: leases are released through the real manager lifecycle
  // first, then the registered fixture tree is removed entry by entry, root
  // last. It runs before the summary line because the stream contract fixes
  // green-manager's frame sequence as ...|BOOTSTRAP_FIXTURE_REMOVED|SUMMARY|...
  const lifecycleFailures = [];
  let testFailure = null;
  try {
    for (const { name, fn } of selectedTests) await fn();
  } catch (error) { testFailure = error; }
  await closeTrackedManagers(lifecycleFailures);
  removeOwnedFixtureTree(lifecycleFailures);
  if (testFailure && lifecycleFailures.length) {
    throw new AggregateError([testFailure, ...lifecycleFailures], 'suite failure and fixture teardown both failed');
  }
  if (testFailure) throw testFailure;
  if (lifecycleFailures.length) {
    throw new AggregateError(lifecycleFailures, 'suite fixture teardown failed');
  }
  process.stdout.write(summaryLine);
})().catch((error) => {
  // AggregateError hides its causes behind .errors; print them so a teardown
  // failure is diagnosable from the captured stderr alone.
  if (error && Array.isArray(error.errors)) {
    process.stderr.write(`${error.message}\n`);
    error.errors.forEach((cause, index) => {
      process.stderr.write(`  [${index}] ${cause && cause.stack ? cause.stack : cause}\n`);
    });
  } else {
    process.stderr.write(`${error.stack || error}\n`);
  }
  process.exitCode = 1;
});
