#!/usr/bin/env node
'use strict';

// Synthetic integration only: the real manager/tracker run against an in-memory
// recovery store and a fake adapter. No process is spawned, signalled or removed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { createDetachedJsonSnapshot, computeDetachedSha256 } = require('../skills/dw-collaboration/scripts/lib/canonical-json');
const copy = (value) => createDetachedJsonSnapshot(value).snapshot;
const hash = (value) => computeDetachedSha256(copy(value));
const evidenceRef = `evidence:${'e'.repeat(64)}`;
const authorityRef = `authority:${'a'.repeat(64)}`;
const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture(options = {}) {
  const stores = [];
  const managerPath = require.resolve('../skills/dw-collaboration/scripts/lib/task-resource-manager');
  class FakeRecoveryStore {
    static open() { const store = new FakeRecoveryStore(); stores.push(store); return store; }
    constructor() { this.head = null; this.closeCalls = 0; }
    saveTransaction(input) {
      assert.strictEqual(input.expectedRevision, this.head?.revision || 0);
      assert.strictEqual(input.expectedContentSha256, this.head?.content_sha256 || null);
      if (options.rejectFinalSave && input.transaction.close.phase === 'CLOSED') throw new Error('synthetic final write failure');
      const revision = input.expectedRevision + 1;
      const contentSha256 = hash(input.transaction);
      this.head = copy({ revision, content_sha256: contentSha256, transaction: input.transaction });
      return { persisted: true, runId: 'audit-run', expectedRevision: input.expectedRevision,
        expectedContentSha256: input.expectedContentSha256, revision,
        previousContentSha256: input.expectedContentSha256, contentSha256 };
    }
    loadTransaction() { return this.head; }
    close() {
      this.closeCalls += 1;
      if (options.throwRelease) throw new Error('synthetic release failure');
      return options.rejectRelease ? { released: false, disposition: 'HOLD' } : { released: true, disposition: 'RELEASED' };
    }
  }
  const loaded = new Module(managerPath, module);
  loaded.filename = managerPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(managerPath));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (name) => name === './recovery-store' ? { RecoveryStore: FakeRecoveryStore } : originalRequire(name);
  loaded._compile(fs.readFileSync(managerPath, 'utf8'), managerPath);
  const authorization = { type: 'TaskResourceAuthorization1', cleanupAuthorityRef: authorityRef, allowForceTermination: false };
  const provenance = { type: 'TaskResourceProvenance1', runId: 'audit-run', harnessId: 'fake-harness', producerId: 'fake-producer',
    ownerId: 'fake-owner', sessionId: 'fake-session', managerRunId: 'fake-manager', managerGeneration: 1,
    adapterId: 'fake-adapter', adapterGeneration: 1, platform: 'windows', observedAt: '2026-10-16T00:00:00Z',
    authorizationSha256: hash(authorization) };
  const claims = Object.fromEntries(['process_identity', 'resource_observation', 'request_shutdown'].map((name) => [name,
    { state: 'VERIFIED_FULL', evidence_refs: [evidenceRef] }]));
  const calls = [];
  const adapter = { type: 'TaskResourcePlatformAdapter1', adapterId: 'fake-adapter',
    probeCapabilities: () => ({ type: 'TaskResourceCapabilityEnvelope1', provenance,
      supportMatrix: { schema: 'SupportMatrix2', schema_version: 2, adapter_id: 'fake-adapter', platform: 'windows',
        observed_at: provenance.observedAt, overall_state: 'VERIFIED_FULL', claims } }),
    spawnManaged: (request) => {
      calls.push(['spawn', request.commandId]);
      const identity = { schema: 'ProcessIdentity2', schema_version: 2, platform: 'windows', owner_id: provenance.ownerId,
        run_id: provenance.runId, session_id: provenance.sessionId, lease_generation: 1, adapter_generation: 1,
        manager_generation: 1, pid: 1234, start_time: provenance.observedAt, executable_path_sha256: 'b'.repeat(64),
        argv_sha256: 'c'.repeat(64), parent_identity_sha256: 'd'.repeat(64), launch_nonce: request.launchNonce,
        manager_run_id: provenance.managerRunId,
        windows_identity: { process_creation_time_filetime: '1234567890', process_handle: 'fake-handle' } };
      const receipt = { identity, evidenceRefs: [evidenceRef], requestSha256: request.requestSha256 };
      return options.spawn ? options.spawn(receipt) : receipt;
    },
    requestGracefulStop: (request) => ({ disposition: 'COMPLETED', targetIdentitySha256: hash(request.expectedIdentity),
      identityRevalidated: true, evidenceRefs: [evidenceRef], requestSha256: request.requestSha256 }),
    observeProcess: (request) => ({ identity: request.expectedIdentity,
      graceful: { requested: true, deadlineReached: false, exitObserved: true }, exactTreeTerminationSupported: false,
      evidenceRefs: [evidenceRef], requestSha256: request.requestSha256 }),
    verifyProcessAbsent: (request) => ({ disposition: 'ABSENT_CONFIRMED', targetIdentitySha256: request.expectedIdentitySha256,
      absence: { processAbsent: true, threadAbsent: true, portAbsent: true }, evidenceRefs: [evidenceRef], requestSha256: request.requestSha256 }),
    terminateOwnedTree: () => { throw new Error('force must never run'); },
    allocateTemporaryRoot: () => { throw new Error('allocation must never run'); },
    quarantineTemporaryRoot: () => { throw new Error('quarantine must never run'); },
    removeTemporaryRoot: () => { throw new Error('removal must never run'); },
    verifyTemporaryAbsent: () => { throw new Error('temporary absence must never run'); },
  };
  const manager = loaded.exports.TaskResourceManager.open({ runId: provenance.runId,
    harness: { type: 'TaskResourceHarness1', harnessId: provenance.harnessId, trustedProducer: () => true },
    dataRoot: path.resolve(__dirname, 'synthetic-unused-data-root'), platformAdapter: adapter, authorization,
    limits: { tracker: { maxScopes: 8 } } });
  const command = (commandId) => ({ commandId, executable: 'synthetic-executable', args: [], cwd: __dirname,
    timeoutMs: 1000, temporaryRoot: null });
  const close = async () => {
    for (let count = 0; count < 8; count += 1) {
      const result = await manager.close();
      if (result.status !== 'CLOSING') return result;
    }
    throw new Error('synthetic close did not converge');
  };
  return { manager, command, stores, calls, close };
}

test('CLOSED requires a persisted and verified final tracker close', async () => {
  const subject = fixture();
  await subject.manager.startCommand(subject.command('complete'));
  assert.strictEqual((await subject.close()).status, 'CLOSED');
  const body = subject.stores[0].head.transaction;
  assert.deepStrictEqual(body.close, { admission: true, phase: 'CLOSED', reason: 'TRACKER_CLOSED_WRITER_RELEASE_PENDING', trackerClose: 'VERIFIED' });
  assert(body.trackerHistory.some((event) => event.kind === 'SCOPE_CLOSE_EVALUATED'
    && event.payload.scopeId === 'fake-manager' && event.payload.result.status === 'CLOSED'));
});

for (const options of [{ rejectRelease: true }, { throwRelease: true }]) {
  test(`unverified writer release cannot publish CLOSED: ${Object.keys(options)[0]}`, async () => {
    const subject = fixture(options);
    await subject.manager.startCommand(subject.command('release'));
    const result = await subject.close();
    assert.strictEqual(result.status, 'HOLD');
    assert(result.decision.reasons.includes('RECOVERY_STORE_RELEASE_UNVERIFIED'));
    assert.strictEqual(subject.stores[0].head.transaction.close.reason, 'TRACKER_CLOSED_WRITER_RELEASE_PENDING',
      'the durable tracker fact must not claim writer release');
    assert.strictEqual(await subject.manager.close(), result, 'terminal HOLD must remain stable');
    assert.strictEqual(subject.stores[0].closeCalls, 1, 'a retained lease is not blindly retried');
  });
}

test('failed final persistence retains the writer and reports HOLD', async () => {
  const subject = fixture({ rejectFinalSave: true });
  await subject.manager.startCommand(subject.command('persist'));
  const result = await subject.close();
  assert.strictEqual(result.status, 'HOLD');
  assert(result.decision.reasons.includes('CLOSE_PERSISTENCE_UNVERIFIED'));
  assert.strictEqual(subject.stores[0].closeCalls, 0, 'unrecorded completion retains its writer lease');
});

test('one pending manager operation rejects another before its adapter action', async () => {
  const releases = [];
  const subject = fixture({ spawn: (receipt) => new Promise((resolve) => { releases.push(() => resolve(receipt)); }) });
  const first = subject.manager.startCommand(subject.command('first'));
  const second = subject.manager.startCommand(subject.command('second'));
  const secondOutcome = second.then(() => 'fulfilled', (error) => error.code);
  try {
    await Promise.resolve();
    assert.deepStrictEqual(subject.calls, [['spawn', 'first']]);
  } finally {
    releases.forEach((release) => release());
    await Promise.allSettled([first, second]);
  }
  assert.strictEqual(await secondOutcome, 'TASK_RESOURCE_MANAGER_HOLD');
  assert.strictEqual((await first).status, 'STARTED');
  assert.strictEqual((await subject.close()).status, 'CLOSED');
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures += 1; process.stderr.write(`FAIL ${name}: ${error.stack}\n`); }
  }
  process.stdout.write(`collaboration safety regressions: ${tests.length - failures}/${tests.length} passed\n`);
  process.exitCode = failures ? 1 : 0;
})();
