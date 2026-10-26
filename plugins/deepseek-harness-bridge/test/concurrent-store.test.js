import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ConcurrentStore, createAtomicStoreWriter } from '../src/concurrent-store.js';
import { TaskManager } from '../src/tasks.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-concurrent-store-'));
  const dataDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dataDir, workspace, first: new ConcurrentStore({ dataDir }), second: new ConcurrentStore({ dataDir }) };
}
const task = (workspace, requestId = 'request', access = 'read-only') => ({ schemaVersion: 3, taskId: randomUUID(),
  sessionId: `bridge-${randomUUID()}`, workspace, access, attempts: [{ number: 1, requestId,
    fingerprint: 'a'.repeat(64), status: 'running', cleanup: 'pending' }] });
const options = record => ({ requestId: record.attempts.at(-1).requestId, fingerprint: record.attempts.at(-1).fingerprint });
async function finish(store, record) {
  record.attempts.at(-1).status = 'completed'; record.attempts.at(-1).cleanup = 'confirmed';
  await store.persist(record); await store.release(record.taskId, { cleanup: 'confirmed' });
}

test('fresh observations leave both absent and legacy state unchanged', async t => {
  const { dataDir, workspace, first } = await fixture(t);
  assert.equal((await first.read()).records.length, 0);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  const old = task(workspace); old.schemaVersion = 1; old.attempts[0].status = 'running';
  const oldDir = join(dataDir, 'tasks', old.taskId); await mkdir(oldDir, { recursive: true });
  const text = JSON.stringify(old); await writeFile(join(oldDir, 'task.json'), text);
  const read = await first.read(); assert.deepEqual(read.legacyRecords, [old]);
  assert.equal(await readFile(join(oldDir, 'task.json'), 'utf8'), text);
  assert.deepEqual(await readdir(dataDir), ['tasks']);
});

test('protocol guard excludes old hosts and initialization never steals a legacy lock', async t => {
  const { dataDir, first } = await fixture(t);
  await mkdir(dataDir); await writeFile(join(dataDir, 'owner.lock'), '{"pid":7}');
  await assert.rejects(first.initialize(), { code: 'UPGRADE_REQUIRED' });
  assert.equal(await readFile(join(dataDir, 'owner.lock'), 'utf8'), '{"pid":7}');
  await rm(join(dataDir, 'owner.lock')); await first.initialize();
  const guard = JSON.parse(await readFile(join(dataDir, 'owner.lock'), 'utf8'));
  assert.equal(guard.protocol, 4); assert.equal(guard.kind, 'bridge-protocol-guard');
  await assert.rejects(writeFile(join(dataDir, 'owner.lock'), '', { flag: 'wx' }), { code: 'EEXIST' });
  await first.initialize(); assert.equal((await first.read()).revision, 0);
});

test('an interrupted protocol initialization is fail closed', async t => {
  const { dataDir } = await fixture(t); const first = new ConcurrentStore({ dataDir, registryWaitMs: 25 }); await mkdir(dataDir);
  await writeFile(join(dataDir, 'owner.lock'), JSON.stringify({ protocol: 4, kind: 'bridge-protocol-guard', storeId: randomUUID() }));
  await assert.rejects(first.initialize(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await readdir(dataDir), ['owner.lock']);
  await assert.rejects(first.read(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await readdir(dataDir), ['owner.lock'], 'Observations cannot repair a partial initialization');
});

test('an observer waits for a concurrent first manifest without reserving or repairing state', async t => {
  const { dataDir, second } = await fixture(t); let release; let published;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { published = resolve; });
  const writer = createAtomicStoreWriter();
  const first = new ConcurrentStore({ dataDir, writer: async (path, bytes, options) => {
    await writer(path, bytes, options);
    if (path.endsWith('owner.lock')) { published(); await barrier; }
  } });
  const initializing = first.initialize(); await reached;
  let observed = false;
  const observation = second.read().then(value => { observed = true; return value; });
  try { await delay(50); assert.equal(observed, false); assert.deepEqual(await readdir(dataDir), ['owner.lock']); }
  finally { release(); }
  await initializing;
  const result = await observation; assert.equal(result.records.length, 0); assert.equal(result.leases.length, 0);
});

test('simultaneous first initialization publishes exactly one protocol and both admissions succeed', async t => {
  const { workspace, first, second } = await fixture(t);
  const one = task(workspace, 'first'), two = task(workspace, 'second');
  const results = await Promise.all([first.admit(one, options(one)), second.admit(two, options(two))]);
  assert.ok(results.every(result => !result.duplicate)); assert.equal((await first.read()).leases.length, 2);
  await finish(first, one); await finish(second, two);
});

test('legacy request IDs remain globally idempotent without claiming legacy ownership', async t => {
  const { workspace, dataDir, first } = await fixture(t);
  const old = task(workspace, 'old'); old.schemaVersion = 1; old.attempts[0].status = 'completed'; old.attempts[0].cleanup = 'confirmed';
  const path = join(dataDir, 'tasks', old.taskId); await mkdir(path, { recursive: true }); await writeFile(join(path, 'task.json'), JSON.stringify(old));
  assert.equal((await first.read()).requests.old.taskId, old.taskId);
  const replay = await first.admit(task(workspace, 'old'), { requestId: 'old', fingerprint: 'a'.repeat(64) });
  assert.equal(replay.duplicate, true); assert.equal(replay.record.taskId, old.taskId); assert.equal(replay.controlToken, undefined);
  await assert.rejects(first.admit(task(workspace, 'old'), { requestId: 'old', fingerprint: 'b'.repeat(64) }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(first.authorize(old.taskId), { code: 'LEGACY_READ_ONLY' });
});

test('request IDs matching Object prototype names still receive ordinary idempotency', async t => {
  const { workspace, first } = await fixture(t); const record = task(workspace, 'constructor');
  const original = await first.admit(record, options(record)); assert.equal(original.duplicate, false);
  assert.equal((await first.admit(record, options(record))).duplicate, true); await finish(first, record);
});

test('independent roots coexist, observations preserve live state and snapshots are immutable', async t => {
  const { workspace, first, second, dataDir } = await fixture(t); await first.initialize();
  const one = task(workspace, 'one'), two = task(workspace, 'two');
  await Promise.all([first.admit(one, options(one)), second.admit(two, options(two))]);
  const read = await second.read(); assert.equal(read.leases.length, 2); assert.equal(read.records.length, 2);
  assert.ok(read.records.every(record => record.attempts[0].status === 'running'));
  const snapshots = join(dataDir, 'tasks-v3', one.taskId, 'snapshots');
  const original = await readdir(snapshots); const originalText = await readFile(join(snapshots, original[0]), 'utf8');
  one.marker = 'next generation'; await first.persist(one);
  assert.equal((await readdir(snapshots)).length, 2);
  assert.equal(await readFile(join(snapshots, original[0]), 'utf8'), originalText);
  await finish(first, one); await finish(second, two);
});

test('global idempotency under competing connections never creates a second lease or leaks control', async t => {
  const { workspace, first, second } = await fixture(t); await first.initialize();
  const record = task(workspace, 'same');
  const [a, b] = await Promise.all([first.admit(record, options(record)), second.admit({ ...record, taskId: randomUUID() }, options(record))]);
  assert.equal([a, b].filter(receipt => receipt.duplicate).length, 1);
  assert.equal([a, b].filter(receipt => receipt.controlToken).length, 1);
  const read = await first.read(); assert.equal(read.records.length, 1); assert.equal(read.leases.length, 1);
  await assert.rejects(second.admit(task(workspace, 'same'), { requestId: 'same', fingerprint: 'b'.repeat(64) }), { code: 'REQUEST_CONFLICT' });
});

test('only explicit task control authorizes another connection; cancellation targets one lease', async t => {
  const { workspace, first, second } = await fixture(t); await first.initialize();
  const one = task(workspace, 'one'), two = task(workspace, 'two');
  const receipt = await first.admit(one, options(one)); await second.admit(two, options(two));
  await assert.rejects(second.requestCancel(one.taskId), { code: 'NOT_OWNER' });
  await second.requestCancel(one.taskId, { controlToken: receipt.controlToken });
  assert.equal(await first.cancellationRequested(one.taskId), true);
  assert.equal(await second.cancellationRequested(two.taskId), false);
  const view = JSON.stringify(await second.read());
  assert.equal(view.includes(receipt.controlToken), false); assert.equal(view.includes('controlHash'), false);
  await finish(first, one); assert.equal((await first.read()).leases.length, 1);
  await assert.rejects(second.requestCancel(one.taskId), { code: 'NOT_OWNER' });
  assert.equal((await second.requestCancel(one.taskId, { controlToken: receipt.controlToken })).requested, false);
});

test('continuation needs current prior attempt, capability, and a new exclusive task lease', async t => {
  const { workspace, first, second } = await fixture(t); await first.initialize();
  const record = task(workspace, 'initial'); const receipt = await first.admit(record, options(record));
  await finish(first, record);
  const before = await first.read();
  const continued = structuredClone(record); continued.attempts.push({ number: 2, requestId: 'continued', fingerprint: 'b'.repeat(64), status: 'running', cleanup: 'pending' });
  await assert.rejects(second.admit(continued, options(continued)), { code: 'NOT_OWNER' });
  await second.admit(continued, { ...options(continued), controlToken: receipt.controlToken, expectedRevision: before.recordRevisions[record.taskId] });
  assert.equal(await second.cancellationRequested(record.taskId), false);
  await assert.rejects(first.admit({ ...continued, attempts: [...continued.attempts.slice(0, 1), { ...continued.attempts[1], requestId: 'third' }] }, { requestId: 'third', fingerprint: 'c'.repeat(64) }), { code: 'TASK_BUSY' });
  await finish(second, continued);
  const stale = structuredClone(continued); stale.attempts.push({ number: 3, requestId: 'stale', fingerprint: 'c'.repeat(64), status: 'running', cleanup: 'pending' });
  await assert.rejects(second.admit(stale, { ...options(stale), expectedRevision: before.recordRevisions[record.taskId] }), { code: 'STALE_STATE' });
});

test('unconfirmed cleanup retains both execution lease and overlapping workspace exclusion', async t => {
  const { workspace, root, first, second } = await fixture(t); await first.initialize();
  const nested = join(workspace, 'nested'); await mkdir(nested);
  const record = task(workspace, 'writer', 'workspace-write'); await first.admit(record, options(record));
  record.attempts[0].status = 'cleanup_failed'; record.attempts[0].cleanup = 'unverified'; await first.persist(record);
  assert.equal((await first.release(record.taskId, { cleanup: 'unverified' })).released, false);
  await assert.rejects(second.admit(task(nested, 'reader'), { requestId: 'reader', fingerprint: 'a'.repeat(64) }), { code: 'WORKSPACE_BUSY' });
  const other = join(root, 'other'); await mkdir(other); const independent = task(other, 'independent');
  await second.admit(independent, options(independent)); assert.equal((await second.read()).leases.length, 2);
});

test('stale registry locks do not block observation and are never automatically removed', async t => {
  const { workspace, first, dataDir } = await fixture(t); await first.initialize();
  const record = task(workspace); await first.admit(record, options(record));
  const lock = join(dataDir, 'registry.lock'); const text = '{"nonce":"other-owner"}'; await writeFile(lock, text);
  const read = await first.read(); assert.equal(read.records[0].attempts[0].status, 'running');
  const impatient = new ConcurrentStore({ dataDir, registryWaitMs: 20 });
  await assert.rejects(impatient.admit(task(workspace, 'blocked'), { requestId: 'blocked', fingerprint: 'a'.repeat(64) }), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), text);
});

test('tampered lease nonce and registry paths fail closed', async t => {
  const { workspace, first, dataDir } = await fixture(t); await first.initialize();
  const record = task(workspace); await first.admit(record, options(record));
  const leasePath = join(first.taskDirectory(record.taskId), 'lease.lock');
  const lease = JSON.parse(await readFile(leasePath, 'utf8')); lease.nonce = randomUUID();
  await writeFile(leasePath, JSON.stringify(lease));
  await assert.rejects(first.persist(record), { code: 'NOT_OWNER' });
  await assert.rejects(first.release(record.taskId, { cleanup: 'confirmed' }), { code: 'NOT_OWNER' });
  const registryPath = join(dataDir, 'registry.json'); const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.tasks[record.taskId].snapshot = '../outside.json'; await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(first.read(), { code: 'INVALID_STATE' });
});

test('separate host processes can hold two simultaneous independent root leases', { timeout: 15000 }, async t => {
  const { workspace, dataDir, first } = await fixture(t); await first.initialize();
  const source = `import { ConcurrentStore } from ${JSON.stringify(new URL('../src/concurrent-store.js', import.meta.url).href)};
const record = JSON.parse(process.argv[2]); const store = new ConcurrentStore({dataDir: process.argv[1]});
const admitted = await store.admit(record, {requestId:record.attempts[0].requestId,fingerprint:record.attempts[0].fingerprint});
process.stdout.write(JSON.stringify({taskId:admitted.record.taskId})+'\\n');
await new Promise(resolve=>process.stdin.once('data',resolve));process.stdin.pause();
record.attempts[0].status='completed';record.attempts[0].cleanup='confirmed';await store.persist(record);await store.release(record.taskId,{cleanup:'confirmed'});`;
  const children = ['process-one', 'process-two'].map(id => spawn(process.execPath, ['--input-type=module', '-e', source, dataDir, JSON.stringify(task(workspace, id))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  t.after(() => { for (const child of children) { child.stdin.end(); if (child.exitCode == null) child.kill(); } });
  const exits = children.map(child => once(child, 'exit'));
  await Promise.all(children.map(child => new Promise((resolve, reject) => { let text = ''; child.stdout.on('data', data => { text += data; if (text.includes('\n')) resolve(); }); child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(new Error('child admission failed')); }); })));
  assert.equal((await first.read()).leases.length, 2);
  for (const child of children) child.stdin.end('finish\n');
  assert.deepEqual(await Promise.all(exits), [[0, null], [0, null]]);
  assert.equal((await first.read()).leases.length, 0);
});

const filesystemError = code => Object.assign(new Error(`fixture ${code}`), { code, syscall: 'rename' });
for (const persistent of [false, true]) {
  test(`terminal registry publication ${persistent ? 'retains quarantine after persistent' : 'recovers from one transient'} Windows sharing failure`, async t => {
    const f = await fixture(t); let armed = false; let attempts = 0; let elapsed = 0; let calls = 0;
    let nativeSharingFailures = 0;
    const waits = []; const expectedWaits = []; const publications = []; const sourceAttempts = new Map();
    const manager = await new TaskManager({ dataDir: f.dataDir,
      runner: async () => { calls++; armed = true; return { terminal: 'completed', text: 'done', cleanup: 'confirmed' }; },
      resolveCapabilities: async id => ({ id, digest: 'offline', access: 'read-only' }) }).open();
    t.after(() => manager.close());
    const writer = createAtomicStoreWriter({ platform: 'win32', now: () => elapsed,
      // Real bounded waits let incidental Windows readers release their handles;
      // an immediate fake wait would turn that contention into a tight retry loop.
      wait: async ms => { waits.push(ms); elapsed += ms; await delay(ms); },
      renameFile: async (source, destination) => {
        if (armed && destination === join(f.dataDir, 'registry.json')) {
          attempts++;
          const sourceAttempt = (sourceAttempts.get(source) ?? 0) + 1;
          sourceAttempts.set(source, sourceAttempt);
          const nextWait = [10, 20, 40, 80, 160][sourceAttempt - 1];
          if (persistent || attempts === 1) {
            if (nextWait !== undefined) expectedWaits.push(nextWait);
            throw filesystemError('EPERM');
          }
          try { await rename(source, destination); }
          catch (error) {
            if (['EPERM', 'EBUSY'].includes(error.code)) {
              nativeSharingFailures++;
              if (nextWait !== undefined) expectedWaits.push(nextWait);
            }
            throw error;
          }
          return;
        }
        await rename(source, destination);
      } });
    manager.store.writer = async (path, content, options) => {
      if (armed && path === join(f.dataDir, 'registry.json')) publications.push(JSON.parse(content).revision);
      return writer(path, content, options);
    };
    const receipt = await manager.submit({ requestId: `sharing-${persistent}`, prompt: 'offline', workspace: f.workspace,
      executionMode: 'single-request', capabilityProfile: 'inference-only' });
    const status = await manager.wait({ taskId: receipt.taskId });
    assert.equal(calls, 1, 'filesystem retries never repeat the worker');
    const view = await f.second.read();
    if (persistent) {
      assert.equal(status.status, 'state_write_failed'); assert.equal(status.cleanup, 'confirmed');
      assert.equal(status.durability, 'unconfirmed'); assert.equal(view.records[0].attempts[0].status, 'running');
      assert.equal(view.leases.length, 1); assert.equal(attempts, 12);
      assert.deepEqual(waits, [10, 20, 40, 80, 160, 10, 20, 40, 80, 160]);
      const attempted = task(f.workspace, 'blocked-write', 'workspace-write');
      await assert.rejects(f.second.admit(attempted, options(attempted)), { code: 'WORKSPACE_BUSY' });
    } else {
      assert.equal(status.status, 'completed'); assert.equal(status.cleanup, 'confirmed'); assert.equal(view.leases.length, 0);
      assert.deepEqual(publications, [2, 3], 'exactly one terminal commit and one lease-release commit');
      assert.equal(sourceAttempts.size, 2, 'retries retain the same temporary file for each logical publication');
      assert.equal(attempts, 3 + nativeSharingFailures, 'one injected failure, two publications, and only observed native sharing retries');
      assert.deepEqual(waits, expectedWaits, 'every retry delay is explained by its source-local failure ordinal');
    }
    assert.equal((await readdir(f.dataDir)).some(name => name.endsWith('.tmp')), false);
  });
}

test('atomic store publication never retries other errors or immutable link failures', async t => {
  const f = await fixture(t); const target = join(f.root, 'published.json');
  await writeFile(target, 'old');
  for (const [platform, code] of [['win32', 'EIO'], ['win32', 'EACCES'], ['linux', 'EPERM']]) {
    let attempts = 0; const failure = filesystemError(code);
    const writer = createAtomicStoreWriter({ platform, wait: async () => assert.fail('unexpected retry'),
      renameFile: async () => { attempts++; throw failure; } });
    await assert.rejects(writer(target, 'new'), error => error === failure); assert.equal(attempts, 1);
    assert.equal(await readFile(target, 'utf8'), 'old');
  }
  let links = 0; const failure = filesystemError('EPERM');
  const immutableWriter = createAtomicStoreWriter({ platform: 'win32', wait: async () => assert.fail('immutable publication must not retry'),
    linkFile: async () => { links++; throw failure; }, renameFile: async () => assert.fail('immutable publication must not rename') });
  await assert.rejects(immutableWriter(target, 'new', { immutable: true }), error => error === failure); assert.equal(links, 1);
});

test('atomic store rename retries EBUSY but an overslept deadline prevents another attempt', async t => {
  const f = await fixture(t); const target = join(f.root, 'published.json'); await writeFile(target, 'old');
  let attempts = 0; let elapsed = 0;
  const recover = createAtomicStoreWriter({ platform: 'win32', now: () => elapsed, wait: async ms => { elapsed += ms; },
    renameFile: async (source, destination) => { attempts++; if (attempts === 1) throw filesystemError('EBUSY'); await rename(source, destination); } });
  await recover(target, 'complete'); assert.equal(attempts, 2); assert.equal(await readFile(target, 'utf8'), 'complete');
  attempts = 0; elapsed = 0; const failure = filesystemError('EBUSY');
  const expired = createAtomicStoreWriter({ platform: 'win32', now: () => elapsed, wait: async () => { elapsed = 501; },
    renameFile: async () => { attempts++; throw failure; } });
  await assert.rejects(expired(target, 'replacement'), error => error === failure);
  assert.equal(attempts, 1); assert.equal(await readFile(target, 'utf8'), 'complete');
});

test('atomic store temporary cleanup preserves ownership and the original failure', async t => {
  const f = await fixture(t); const target = join(f.root, 'published.json');
  const unowned = filesystemError('EEXIST');
  const unopened = createAtomicStoreWriter({ openFile: async () => { throw unowned; },
    unlinkFile: async () => assert.fail('must not remove an unowned temporary') });
  await assert.rejects(unopened(target, 'new'), error => error === unowned);
  const publication = filesystemError('EIO'), cleanup = filesystemError('EBUSY');
  const writer = createAtomicStoreWriter({ renameFile: async () => { throw publication; }, unlinkFile: async () => { throw cleanup; } });
  await assert.rejects(writer(target, 'new'), error => error instanceof AggregateError
    && error.cause === publication && error.errors[0] === publication && error.errors[1] === cleanup);
});
