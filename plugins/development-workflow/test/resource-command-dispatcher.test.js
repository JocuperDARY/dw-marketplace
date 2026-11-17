'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ResourceCommandDispatcher } = require('../skills/dw-collaboration/scripts/lib/resource-command-dispatcher');
const { TaskResourceTracker } = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');

const policy = { maxConcurrent: 1, maxTasks: 20, maxWaitMs: 30000, backfillWindowMs: 10000,
  gpuOptimizationTarget: 0.85, allowGpuOptimization: false };
const profile = taskId => ({ version: 1, taskId, priority: 1, dependencies: [], authorizationRef: 'fixture',
  resources: { cpuCores: 1, ramBytes: 1, ioUnits: 1,
    gpu: { count: 0, vramSoftBytes: 0, vramHardBytes: 0, capabilities: [], deviceMode: 'none' } },
  duration: { expectedMs: 100, maxMs: 1000, confidence: 'fixture' }, preemptible: false, enqueuedAt: 0 });
const observation = () => ({ observed: true, nowMs: 1, cpuCores: 4, ramBytes: 100, ioUnits: 4,
  foregroundHealthy: true, externalLeasesProtected: true, thermalSafe: true, powerSafe: true, oomRisk: false,
  gpu: { count: 0, capabilities: [], physicalVramBytes: 0, driverVramBytes: 0, desktopVramBytes: 0,
    externalVramBytes: 0, foregroundReserveVramBytes: 0, safetyReserveVramBytes: 0,
    taskVramBytes: 0, usefulComputeUtilization: 0 } });
const terminal = () => ({ status: 0, reason: 'child_exit', outputComplete: true,
  cleanup: 'verified_absent', terminal: { cleanup: 'verified_absent' } });

function fixture(overrides = {}, policyOverrides = {}, authorizationResolver = () => true) {
  const tracker = new TaskResourceTracker({ ownerId: 'fixture', runId: 'fixture-run', generation: 1,
    trustedObservationResolver: () => true });
  const root = tracker.openRootScope({ scopeId: 'root', purpose: 'dispatcher fixture' });
  const entries = new Map();
  const calls = [];
  const base = {
    queueAuthority: () => tracker.queueAuthority(),
    async prepareCommand(command) {
      calls.push(`prepare:${command.commandId}`);
      const scope = root.openChild({ scopeId: command.commandId, ownerId: 'fixture', purpose: 'command fixture' });
      const id = `resource:${command.commandId}`;
      scope.register({ resourceId: id, type: 'artifact', purpose: 'fixture', teardownCondition: 'scope close',
        quota: { kind: 'fixture', value: 1 }, evidenceRefs: ['fixture:declaration'] });
      entries.set(command.commandId, { scope, id, bound: false, released: false });
      return { status: 'PREPARED', commandId: command.commandId,
        scopeBinding: { ownerId: 'fixture', runId: 'fixture-run', generation: 1, scopeId: command.commandId }, resourceIds: [id] };
    },
    async startPrepared(id) {
      calls.push(`start:${id}`);
      const e = entries.get(id);
      e.scope.bind(e.id, { identity: { kind: 'fixture', id }, generation: 1, evidenceRefs: ['fixture:bound'] });
      e.bound = true;
      return { status: 'STARTED', commandId: id };
    },
    async wait(id) { calls.push(`wait:${id}`); return terminal(); },
    async closeCommand(id) {
      calls.push(`close:${id}`);
      const e = entries.get(id);
      if (!e.released) {
        if (e.bound) e.scope.confirmRelease(e.id, { identity: { kind: 'fixture', id }, generation: 1,
          absenceVerified: true, evidenceRefs: ['fixture:absence'] });
        else e.scope.confirmNotAcquired(e.id, { type: 'TaskResourceNotAcquired1', commandId: id,
          scopeId: id, generation: 1, resourceIds: [e.id], startState: 'not_dispatched',
          cleanup: 'verified_absent', supervisorClosed: true, evidenceRefs: ['fixture:no-start'] });
        e.released = true;
      }
      return { status: 'CLOSED', commandId: id, closeResult: e.scope.close('fixture done') };
    },
    async cancelPrepared(id) { calls.push(`cancel:${id}`); return base.closeCommand(id); },
  };
  const host = { ...base, ...overrides };
  const dispatcher = new ResourceCommandDispatcher({ host, policy: { ...policy, ...policyOverrides }, authorizationResolver });
  return { dispatcher, host, base, entries, calls };
}

test('prepared scopes dispatch once and release capacity only after a genuine close token', async () => {
  const f = fixture();
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.prepare(profile('two'), { commandId: 'two' });
  assert.equal(f.entries.get('one').bound, false);
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, ['one']);
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, []);
  assert.equal((await f.dispatcher.observe('one')).queue.tasks.one.state, 'completed');
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, ['two']);
  await f.dispatcher.observe('two');
  assert.equal(f.calls.filter(x => x === 'start:one').length, 1);
  assert.equal(f.dispatcher.snapshot().queue.tasks.two.releaseVerified, true);
  assert.equal(f.dispatcher.host, undefined);
  assert.equal(f.dispatcher.queue, undefined);
});

test('forged close and CLOSING retain draining capacity, explicit close settles once', async () => {
  const f = fixture();
  let closes = 0;
  f.host.closeCommand = async id => {
    closes += 1;
    if (closes === 1) return { status: 'CLOSED', commandId: id, closeResult: { status: 'CLOSED' } };
    if (closes === 2) return { status: 'CLOSING', commandId: id };
    return f.base.closeCommand(id);
  };
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.prepare(profile('two'), { commandId: 'two' });
  await f.dispatcher.dispatch(observation());
  assert.equal((await f.dispatcher.observe('one')).queue.tasks.one.state, 'draining');
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, []);
  assert.equal((await f.dispatcher.close('one')).queue.tasks.one.state, 'draining');
  assert.equal((await f.dispatcher.close('one')).queue.tasks.one.state, 'completed');
  await f.dispatcher.close('one');
  assert.equal(closes, 3);
});

test('batch partial failure drains failed and undispatched members without retry or slot fabrication', async () => {
  const f = fixture({}, { maxConcurrent: 3 });
  f.host.startPrepared = async id => {
    if (id === 'two') { f.calls.push('start:two'); throw new Error('injected'); }
    return f.base.startPrepared(id);
  };
  for (const [index, id] of ['one', 'two', 'three'].entries()) {
    await f.dispatcher.prepare({ ...profile(id), priority: 3 - index }, { commandId: id });
  }
  const result = await f.dispatcher.dispatch(observation());
  assert.equal(result.queue.tasks.one.state, 'running');
  assert.equal(result.queue.tasks.two.state, 'failed');
  assert.equal(result.queue.tasks.three.state, 'cancelled');
  assert(!f.calls.includes('start:three'));
  assert(f.calls.includes('cancel:three'));
  assert.equal(f.calls.filter(x => x === 'start:two').length, 1);
  await f.dispatcher.observe('one');
});

test('unknown start failure remains draining until the host proves closure', async () => {
  const f = fixture({ startPrepared: async () => { throw new Error('unknown start'); },
    closeCommand: async id => ({ status: 'HOLD', commandId: id }) });
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.prepare(profile('two'), { commandId: 'two' });
  const result = await f.dispatcher.dispatch(observation());
  assert.equal(result.queue.tasks.one.state, 'draining');
  assert.equal(result.queue.tasks.one.releaseVerified, false);
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, []);
});

test('cancellation before dispatch closes the prepared scope without calling start', async () => {
  const f = fixture();
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  assert.equal((await f.dispatcher.cancel('one')).queue.tasks.one.state, 'cancelled');
  assert(!f.calls.includes('start:one'));
  assert.deepEqual((await f.dispatcher.dispatch(observation())).decision.start, []);
});

test('late duplicated observation cannot undo cancellation or consume close twice', async () => {
  const f = fixture();
  let releaseWait;
  f.host.wait = () => new Promise(resolve => { releaseWait = resolve; f.calls.push('waiting'); });
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.dispatch(observation());
  const first = f.dispatcher.observe('one');
  const second = f.dispatcher.observe('one');
  await Promise.resolve();
  await f.dispatcher.cancel('one');
  releaseWait(terminal());
  await Promise.all([first, second]);
  assert.equal(f.dispatcher.snapshot().queue.tasks.one.state, 'cancelled');
  assert.equal(f.calls.filter(x => x === 'waiting').length, 1);
  assert.equal(f.calls.filter(x => x === 'close:one').length, 1);
});

test('cancel during a pending start waits and prevents the rest of the selected batch from starting', async () => {
  const f = fixture({}, { maxConcurrent: 2 });
  let releaseStart;
  f.host.startPrepared = id => new Promise(resolve => { releaseStart = async () => resolve(await f.base.startPrepared(id)); });
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.prepare(profile('two'), { commandId: 'two' });
  const dispatching = f.dispatcher.dispatch(observation());
  await Promise.resolve();
  const cancellingOne = f.dispatcher.cancel('one');
  const cancellingTwo = f.dispatcher.cancel('two');
  await releaseStart();
  await Promise.all([dispatching, cancellingOne, cancellingTwo]);
  assert.equal(f.dispatcher.snapshot().queue.tasks.one.state, 'cancelled');
  assert.equal(f.dispatcher.snapshot().queue.tasks.two.state, 'cancelled');
  assert(!f.calls.includes('start:two'));
});

test('duplicate IDs, forged authority, and reentrant dispatch cannot create duplicate starts', async () => {
  assert.throws(() => new ResourceCommandDispatcher({ host: {
    prepareCommand() {}, startPrepared() {}, closeCommand() {}, cancelPrepared() {}, wait() {},
    queueAuthority: () => ({ hasOpenScope: () => true, claimTaskScope: () => true, consumeTaskCloseResult: () => true }),
  }, policy, authorizationResolver: () => true }), /TRACKER_REQUIRED/);
  const f = fixture();
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await assert.rejects(f.dispatcher.prepare(profile('one'), { commandId: 'two' }), /DISPATCH_DUPLICATE_ID/);
  await assert.rejects(f.dispatcher.prepare(profile('two'), { commandId: 'one' }), /DISPATCH_DUPLICATE_ID/);
  f.host.startPrepared = async id => {
    await assert.rejects(f.dispatcher.dispatch(observation()), /DISPATCH_REENTRANT_OPERATION/);
    return f.base.startPrepared(id);
  };
  const copied = f.dispatcher.snapshot();
  assert.throws(() => { copied.queue.tasks.one.profile.authorizationRef = 'mutated'; }, TypeError);
  assert.equal(f.dispatcher.snapshot().queue.tasks.one.profile.authorizationRef, 'fixture');
  await f.dispatcher.dispatch(observation());
  await f.dispatcher.observe('one');
});

test('invalid profile is rejected before preparation and a nonzero exit is failed', async () => {
  const f = fixture();
  await assert.rejects(f.dispatcher.prepare({ ...profile('bad'), resources: {} }, { commandId: 'bad' }), /DISPATCH_PROFILE_INVALID/);
  assert.equal(f.entries.has('bad'), false);
  f.host.wait = async () => ({ ...terminal(), status: 23 });
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.dispatch(observation());
  assert.equal((await f.dispatcher.observe('one')).queue.tasks.one.state, 'failed');
});

test('authorization rejection closes only the prepared declaration and never starts work', async () => {
  const f = fixture({}, {}, () => false);
  const result = await f.dispatcher.prepare(profile('denied'), { commandId: 'denied' });
  assert.equal(result.queue.tasks.denied.state, 'cancelled');
  assert.equal(result.queue.tasks.denied.releaseVerified, true);
  assert(!f.calls.includes('start:denied'));
});

test('exit zero with missing output, unknown cleanup, or a host error remains failed after release', async () => {
  for (const change of [{ outputComplete: false }, { cleanup: 'unknown' }, { error: new Error('host failed') }]) {
    const f = fixture({ wait: async () => ({ ...terminal(), ...change }) });
    await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
    await f.dispatcher.dispatch(observation());
    const result = await f.dispatcher.observe('one');
    assert.equal(result.queue.tasks.one.state, 'failed');
    assert.equal(result.queue.tasks.one.releaseVerified, true);
    if (change.error) assert.equal(result.commands[0].observation.errorCode, 'HOST_WAIT_FAILED');
  }
});

test('reentrant cancellation during close shares one close transaction', async () => {
  const f = fixture();
  let reentrant;
  f.host.closeCommand = async id => {
    reentrant = f.dispatcher.cancel(id);
    return f.base.closeCommand(id);
  };
  await f.dispatcher.prepare(profile('one'), { commandId: 'one' });
  await f.dispatcher.dispatch(observation());
  await f.dispatcher.cancel('one');
  await reentrant;
  assert.equal(f.calls.filter(value => value === 'close:one').length, 1);
  assert.equal(f.dispatcher.snapshot().queue.tasks.one.state, 'cancelled');
});

test('real Windows queue dispatch closes native handles before releasing its slot, including no-start',
  { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 30000 }, async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { buildSupervisor } = require('../skills/dw-collaboration/scripts/build-process-supervisor');
    const { createWindowsCommandHost } = require('../skills/dw-collaboration/scripts/lib/windows-command-adapter');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dispatcher-'));
    let host;
    let cleanupVerified = false;
    try {
      const prepared = buildSupervisor(path.join(root, 'native'));
      host = await createWindowsCommandHost({ runId: 'dispatcher-native', harnessId: 'fixture', producerId: 'fixture',
        ownerId: 'fixture', sessionId: 'native-session', managerRunId: 'native-manager', managerGeneration: 1,
        adapterId: 'windows-command', adapterGeneration: 1, hardDeadlineAuthorized: true,
        authorization: { type: 'TaskResourceAuthorization1', cleanupAuthorityRef: `authority:${'b'.repeat(64)}`,
          allowForceTermination: true }, supervisorPath: prepared.executable, preparedBackend: prepared,
        dataRoot: path.join(root, 'data'), bounds: { maxTimeoutMs: 3000, graceMs: 50,
          maxOutputBytes: 65536, retentionMs: 5000, maxCommands: 3 } });
      const dispatcher = new ResourceCommandDispatcher({ host, policy, authorizationResolver: () => true });
      const command = id => ({ commandId: id, executable: process.execPath,
        args: ['-e', `console.log('${id}');`], cwd: root, timeoutMs: 2000, temporaryRoot: null });
      const settle = async id => {
        for (let step = 0; step < 30 && dispatcher.snapshot().queue.tasks[id].state === 'draining'; step += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
          await dispatcher.close(id);
        }
        assert.equal(dispatcher.snapshot().queue.tasks[id].releaseVerified, true,
          JSON.stringify(dispatcher.snapshot()));
      };
      await dispatcher.prepare(profile('first'), command('first'));
      await dispatcher.prepare(profile('second'), command('second'));
      assert.deepEqual((await dispatcher.dispatch(observation())).decision.start, ['first']);
      assert.deepEqual((await dispatcher.dispatch(observation())).decision.start, []);
      await dispatcher.observe('first');
      await settle('first');
      assert.equal(dispatcher.snapshot().queue.tasks.first.state, 'completed', JSON.stringify(dispatcher.snapshot()));
      assert.deepEqual((await dispatcher.dispatch(observation())).decision.start, ['second']);
      await dispatcher.observe('second');
      await settle('second');
      const noStart = { ...command('missing'), executable: path.join(root, 'missing.exe') };
      await dispatcher.prepare(profile('missing'), noStart);
      await dispatcher.dispatch(observation());
      await settle('missing');
      assert.equal(dispatcher.snapshot().queue.tasks.missing.state, 'failed');
      assert.equal(dispatcher.snapshot().commands.find(value => value.taskId === 'missing').attempted, true);
      let closed;
      for (let step = 0; step < 30; step += 1) {
        closed = await host.close();
        if (closed.status !== 'CLOSING') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(closed.status, 'CLOSED', JSON.stringify(closed));
      assert(closed.releases.every(value => value.supervisorClosed && value.cleanup === 'verified_absent'));
      console.log('LIFECYCLE_RAN:windows-dispatcher');
    } finally {
      if (host) {
        const disposed = await host.dispose();
        cleanupVerified = disposed.releases.every(value => value.supervisorClosed && value.cleanup === 'verified_absent');
      } else cleanupVerified = true;
      assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
      if (cleanupVerified) fs.rmSync(root, { recursive: true });
      else console.error(`DISPATCHER_FIXTURE_RETAINED:${root}`);
    }
  });
