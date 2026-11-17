'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { createWindowsCommandHost } = require('../skills/dw-collaboration/scripts/lib/windows-command-adapter');
const { buildSupervisor } = require('../skills/dw-collaboration/scripts/build-process-supervisor');
const { computeDetachedSha256 } = require('../skills/dw-collaboration/scripts/lib/canonical-json');

if (process.platform !== 'win32') {
  console.log('SKIP_NOT_APPLICABLE:windows-command-adapter');
  test('Windows native manager loop', { skip: 'Windows only' }, () => {});
}
else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-command-adapter-'));
  const prepared = buildSupervisor(path.join(root, 'native'));
  const hosts = [];
  let count = 0;
  function options() {
    const id = ++count;
    return { runId: `adapter-run-${id}`, harnessId: 'test-harness', producerId: 'test-producer',
      ownerId: 'test-owner', sessionId: `session-${id}`, managerRunId: `manager-${id}`,
      managerGeneration: 1, adapterId: 'windows-command', adapterGeneration: 1,
      authorization: { type: 'TaskResourceAuthorization1', cleanupAuthorityRef: `authority:${'b'.repeat(64)}`, allowForceTermination: true },
      hardDeadlineAuthorized: true, supervisorPath: prepared.executable, preparedBackend: prepared, dataRoot: path.join(root, `data-${id}`),
      bounds: { maxTimeoutMs: 5000, graceMs: 150, maxOutputBytes: 1048576, retentionMs: 30000, maxCommands: 2 } };
  }
  async function host() { const result = await createWindowsCommandHost(options()); hosts.push(result); return result; }
  function command(id, source, timeoutMs = 3000) {
    return { commandId: id, executable: process.execPath, args: ['-e', source], cwd: root, timeoutMs, temporaryRoot: null };
  }
  async function close(h) {
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
      result = await h.close();
      if (result.manager.status !== 'CLOSING') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(result.manager.status, 'CLOSED', JSON.stringify(result));
    assert(result.releases.every(x => x.supervisorClosed && x.cleanup === 'verified_absent'));
    return result;
  }
  after(async () => {
    for (const h of hosts) await h.dispose();
    // Remove only the fixture root created above, after native sessions have closed.
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  test('authorization and unsupported V1 inputs reject before manager admission', async () => {
    for (const change of [{ hardDeadlineAuthorized: false }, { authorization: { ...options().authorization, allowForceTermination: false } }]) {
      await assert.rejects(createWindowsCommandHost({ ...options(), ...change }));
    }
    const h = await host();
    assert.throws(() => h.startCommand({ ...command('temp', ''), temporaryRoot: root }));
    assert.throws(() => h.startCommand({ ...command('m2', ''), gracefulShutdown: null }));
    assert.throws(() => h.startCommand({ ...command('long', ''), timeoutMs: 5001 }));
    assert.throws(() => h.startCommand({ ...command('shim', ''), executable: path.join(root, 'shim.cmd') }));
    const result = await close(h);
    assert.deepEqual(result.releases, []);
  });
  test('real native success and fast nonzero exit close the manager and retained handles', async () => {
    for (const code of [0, 23]) {
      const h = await host();
      const started = await h.startCommand(command(`exit${code}`, `console.log('hello'); process.exit(${code})`));
      assert.equal(started.status, 'STARTED');
      const observed = await h.observe(started.resourceId);
      assert.notEqual(observed.status, 'HOLD');
      const result = await h.wait(`exit${code}`);
      assert.equal(result.status, code);
      assert.equal(result.stdout.trim(), 'hello');
      assert.equal(result.cleanup, 'verified_absent');
      await close(h);
    }
  });
  test('timeout and explicit stop preserve bounded cleanup then close resources', async () => {
    const timed = await host();
    await timed.startCommand(command('timeout', 'setInterval(()=>{},1000)', 400));
    const result = await timed.wait('timeout');
    assert.equal(result.reason, 'timeout_elapsed');
    assert.equal(result.cleanup, 'verified_absent');
    await close(timed);
    const stopped = await host();
    const start = await stopped.startCommand(command('force', 'setInterval(()=>{},1000)', 5000));
    const first = await stopped.stop(start.resourceId, { reason: 'user_requested' });
    assert.equal(first.status, 'STOP_REQUESTED');
    await new Promise(resolve => setTimeout(resolve, 220));
    const second = await stopped.stop(start.resourceId, { reason: 'user_requested' });
    assert(['STOPPED', 'WAITING'].includes(second.status), JSON.stringify(second));
    await stopped.wait('force');
    await close(stopped);
  });
  test('native launch failure remains manager HOLD without false tracker closure', async () => {
    const h = await host();
    const invalidExe = path.join(root, 'invalid.exe');
    fs.writeFileSync(invalidExe, 'not an executable');
    await assert.rejects(h.startCommand({ ...command('failed', ''), executable: invalidExe }));
    const result = await h.close();
    assert.equal(result.manager.status, 'HOLD');
    assert(result.manager.decision.reasons.includes('COMMAND_START_INCOMPLETE'));
    assert.deepEqual(result.releases, []);
  });
  test('disposal waits for an in-flight native start and releases its retained session', async () => {
    const h = await host();
    const starting = h.startCommand(command('race', 'setInterval(()=>{},1000)'));
    const disposing = h.dispose();
    await assert.rejects(starting);
    const result = await disposing;
    assert.equal(result.status, 'HOLD');
    assert.equal(result.releases.length, 1);
    assert(result.releases.every(x => x.supervisorClosed && x.cleanup === 'verified_absent'));
    assert.equal((await h.close()).manager.status, 'HOLD');
  });
  test('real native receipt rejects identity/evidence/run tampering', async () => {
    const h = await host();
    const dataRoot = path.join(root, `data-${count}`);
    await h.startCommand(command('proof', 'process.exit(0)'));
    const runtimes = [];
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (value.schema === 'TaskResourceManagerRuntime1') runtimes.push(value);
      else for (const child of Object.values(value)) visit(child);
    }
    for (const relative of fs.readdirSync(dataRoot, { recursive: true })) {
      if (relative.endsWith('.json')) visit(JSON.parse(fs.readFileSync(path.join(dataRoot, relative), 'utf8')));
    }
    const runtime = runtimes.sort((a, b) => b.trackerHistory.length - a.trackerHistory.length)[0];
    assert(runtime);
    const bound = runtime.trackerHistory.find(event => event.kind === 'RESOURCE_BOUND');
    const receipt = { identity: bound.payload.observation.identity,
      evidenceRefs: bound.payload.observation.evidenceRefs,
      requestSha256: runtime.actions.find(action => action.method === 'spawnManaged').requestSha256 };
    const p = runtime.originalProvenance;
    const context = { runId: p.runId, harnessId: p.harnessId, adapterId: p.adapterId,
      authorizationSha256: p.authorizationSha256, resolutionType: 'observation', provenance: p,
      requiredReferences: [runtime.originalAuthorization.cleanupAuthorityRef,
        ...runtime.originalCapabilityEnvelope.supportMatrix.claims.process_identity.evidence_refs].sort() };
    assert(h.trustedProducer(receipt, context));
    assert(!h.trustedProducer({ ...receipt, identity: { ...receipt.identity, pid: receipt.identity.pid + 1 } }, context));
    assert(!h.trustedProducer({ ...receipt, evidenceRefs: [`evidence:${'e'.repeat(64)}`] }, context));
    assert(!h.trustedProducer(receipt, { ...context, runId: 'other-run' }));
    await h.wait('proof');
    await close(h);
    runtimes.length = 0;
    for (const relative of fs.readdirSync(dataRoot, { recursive: true })) {
      if (relative.endsWith('.json')) visit(JSON.parse(fs.readFileSync(path.join(dataRoot, relative), 'utf8')));
    }
    const final = runtimes.sort((a, b) => b.trackerHistory.length - a.trackerHistory.length)[0];
    const event = final.trackerHistory.filter(item => item.kind === 'RESOURCE_OBSERVED'
      && item.payload.resourceId === 'command:proof:process-tree').at(-1);
    assert(event && event.payload.observation.absence.process_absent);
    const derived = { purpose: 'process_recovery', ownerId: p.ownerId, runId: p.runId,
      generation: p.managerGeneration, observation: event.payload.observation,
      resource: { resourceId: event.payload.resourceId, ownerId: p.ownerId,
        generation: p.managerGeneration, boundGeneration: p.managerGeneration,
        identity: receipt.identity, scopeId: event.payload.scopeId,
        type: 'process_tree', parentResourceId: 'command:proof:session' } };
    assert(h.trustedProducer(derived, context));
    assert(!h.trustedProducer({ ...derived, observation: { ...derived.observation,
      absence: { ...derived.observation.absence, process_absent: false } } }, context));
    assert(!h.trustedProducer({ ...derived, resource: { ...derived.resource, scopeId: 'wrong-scope' } }, context));
    assert(!h.trustedProducer({ ...derived, resource: { ...derived.resource, parentResourceId: 'wrong-parent' } }, context));
  });
  test('producer rejects wrong-run, altered identity, evidence-only and replayed requests', async () => {
    const h = await host();
    const adapter = h.platformAdapter;
    const opts = { authorization: { cleanupAuthorityRef: `authority:${'b'.repeat(64)}` } };
    // Retrieve only the factory's own probe using the actual host identifiers.
    // Inspecting the public envelope cannot grant another run trust.
    const probe = { type: 'TaskResourceCapabilityProbe1', runId: `adapter-run-${count}`,
      harnessId: 'test-harness', adapterId: 'windows-command' };
    const envelope = adapter.probeCapabilities(probe);
    const context = { runId: envelope.provenance.runId, harnessId: 'test-harness', adapterId: 'windows-command',
      authorizationSha256: envelope.provenance.authorizationSha256,
      requiredReferences: [opts.authorization.cleanupAuthorityRef, ...envelope.supportMatrix.claims.process_identity.evidence_refs].sort() };
    assert(h.trustedProducer(envelope, context));
    assert(!h.trustedProducer(envelope, { ...context, runId: 'wrong-run' }));
    assert(!h.trustedProducer({ ...envelope, provenance: { ...envelope.provenance, ownerId: 'tampered' } }, context));
    assert(!h.trustedProducer({ evidenceRefs: context.requiredReferences }, { ...context, resolutionType: 'observation', provenance: envelope.provenance }));
    assert(!h.trustedProducer({}, { ...context, resolutionType: 'filesystem', provenance: envelope.provenance }));
    const invalid = { type: 'TaskResourceSpawnRequest2', provenance: envelope.provenance };
    invalid.requestSha256 = computeDetachedSha256(invalid);
    await assert.rejects(adapter.spawnManaged(invalid));
    await assert.rejects(adapter.spawnManaged(invalid));
    await close(h);
  });
}
