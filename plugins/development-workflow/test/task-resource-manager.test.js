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

function supportMatrix() {
  return {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'adapter-A',
    platform: 'windows',
    observed_at: '2026-09-04T01:02:03Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      process_identity: { state: 'VERIFIED_FULL', evidence_refs: [EVIDENCE_REF] },
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
    supportMatrix: supportMatrix(),
  };
  return {
    ...envelope,
    ...overrides,
    provenance: { ...provenance, ...(overrides.provenance || {}) },
    supportMatrix: overrides.supportMatrix || envelope.supportMatrix,
  };
}

function validInput({ envelopeMutator, trustedProducer, limits } = {}) {
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
    spawnManaged: () => { calls.spawnManaged += 1; },
    observeProcess: () => { calls.observeProcess += 1; },
    requestGracefulStop: () => { calls.requestGracefulStop += 1; },
    terminateOwnedTree: () => { calls.terminateOwnedTree += 1; },
    verifyProcessAbsent: () => { calls.verifyProcessAbsent += 1; },
    allocateTemporaryRoot: () => { calls.allocateTemporaryRoot += 1; },
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

for (const { name, fn } of tests) fn();
process.stdout.write(`task resource manager tests passed (${tests.length} tests).\n`);
