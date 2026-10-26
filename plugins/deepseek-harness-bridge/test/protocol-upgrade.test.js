// Offline unit coverage for the explicit protocol 3 -> 4 migration module.
// Execution is NOT_RUN in the authoring environment (no shell capability here);
// every fixture is a synthetic temporary directory, never real bridge state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../src/concurrent-store.js';
import { BridgeError } from '../src/errors.js';
import { upgradeStore } from '../src/protocol-upgrade.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = char => char.repeat(64);
const sorted = values => [...values].sort();

// Builds the exact original protocol 3 on-disk layout; nothing is imported from
// parent constants so a format drift in current code cannot mask a fixture error.
async function makeV3Store(t, { tasks = 1, legacy = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-protocol-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(dataDir, 'tasks-v3'), { recursive: true });
  const storeId = randomUUID();
  const registry = { protocol: 3, storeId, revision: 4, tasks: {}, requests: {} };
  const snapshots = new Map();
  const taskIds = [];
  for (let index = 0; index < tasks; index++) {
    const taskId = randomUUID();
    taskIds.push(taskId);
    const snapshotsDir = join(dataDir, 'tasks-v3', taskId, 'snapshots');
    await mkdir(snapshotsDir, { recursive: true });
    const firstRequest = `attempt-a-${index}`;
    const secondRequest = `attempt-b-${index}`;
    const record = { schemaVersion: 3, taskId, sessionId: `bridge-${randomUUID()}`, workspace, access: 'read-only',
      attempts: [
        // Historical earlier attempt stays failed without confirmed cleanup.
        { number: 1, requestId: firstRequest, fingerprint: digest('a'), status: 'failed', cleanup: 'pending' },
        { number: 2, requestId: secondRequest, fingerprint: digest('b'), status: 'completed', cleanup: 'confirmed' },
      ] };
    const name = `${randomUUID()}.json`;
    const snapshotPath = join(snapshotsDir, name);
    const bytes = Buffer.from(JSON.stringify(record));
    await writeFile(snapshotPath, bytes);
    snapshots.set(snapshotPath, bytes);
    registry.tasks[taskId] = { snapshot: `tasks-v3/${taskId}/snapshots/${name}`, generation: 2,
      creatorId: randomUUID(), controlHash: digest('c'), lease: null };
    registry.requests[firstRequest] = { taskId, attempt: 1, fingerprint: digest('a') };
    registry.requests[secondRequest] = { taskId, attempt: 2, fingerprint: digest('b') };
  }
  const legacyRecords = new Map();
  const legacyIds = [];
  for (let index = 0; index < legacy; index++) {
    const taskId = randomUUID();
    legacyIds.push(taskId);
    const taskDir = join(dataDir, 'tasks', taskId);
    await mkdir(taskDir, { recursive: true });
    const record = { schemaVersion: 1, taskId, sessionId: `bridge-${randomUUID()}`, workspace, access: 'read-only',
      attempts: [{ number: 1, requestId: `legacy-${index}`, fingerprint: digest('d'), status: 'completed', cleanup: 'confirmed' }] };
    const path = join(taskDir, 'task.json');
    const bytes = Buffer.from(JSON.stringify(record));
    await writeFile(path, bytes);
    legacyRecords.set(path, bytes);
  }
  const heads = {
    protocol: Buffer.from(JSON.stringify({ protocol: 3, storeId })),
    registry: Buffer.from(JSON.stringify(registry)),
    owner: Buffer.from(JSON.stringify({ kind: 'bridge-protocol-guard', protocol: 3, storeId })),
  };
  await writeFile(join(dataDir, 'protocol.json'), heads.protocol);
  await writeFile(join(dataDir, 'registry.json'), heads.registry);
  await writeFile(join(dataDir, 'owner.lock'), heads.owner);
  return { root, dataDir, workspace, storeId, registry, heads, taskIds, legacyIds, snapshots, legacyRecords };
}

async function tree(root) {
  const files = new Map();
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else files.set(relative(root, path), await readFile(path));
    }
  }
  await walk(root);
  return files;
}

test('a complete protocol 3 store upgrades in place and preserves historical bytes', async t => {
  const fixture = await makeV3Store(t, { tasks: 2, legacy: 1 });
  const canonical = await realpath(fixture.dataDir);
  const result = await upgradeStore({ dataDir: fixture.dataDir });

  assert.equal(result.alreadyUpgraded, false);
  assert.equal(result.protocol, 4);
  assert.equal(result.previousProtocol, 3);
  assert.equal(result.taskCount, 2);
  assert.equal(result.legacyTaskCount, 1);
  assert.equal(dirname(result.migrationDirectory), join(canonical, 'migrations'));
  assert.match(basename(result.migrationDirectory), UUID_RE);
  assert.equal(result.migrationId, basename(result.migrationDirectory));

  const manifest = JSON.parse(await readFile(join(canonical, 'protocol.json'), 'utf8'));
  assert.equal(manifest.protocol, 4);
  assert.equal(manifest.storeId, fixture.storeId);
  const guard = JSON.parse(await readFile(join(canonical, 'owner.lock'), 'utf8'));
  assert.equal(guard.kind, 'bridge-protocol-guard');
  assert.equal(guard.protocol, 4);
  assert.equal(guard.storeId, fixture.storeId);
  const registry = JSON.parse(await readFile(join(canonical, 'registry.json'), 'utf8'));
  assert.equal(registry.protocol, 4);
  assert.equal(registry.storeId, fixture.storeId);
  assert.equal(registry.revision, fixture.registry.revision + 1);
  assert.deepEqual(registry.tasks, fixture.registry.tasks);
  assert.deepEqual(registry.requests, fixture.registry.requests);

  // Task snapshots and read-only legacy evidence keep their exact original bytes.
  for (const [path, bytes] of fixture.snapshots) assert.deepEqual(await readFile(path), bytes);
  for (const [path, bytes] of fixture.legacyRecords) assert.deepEqual(await readFile(path), bytes);

  // Original protocol 3 head bytes are retained in the new migration directory.
  const migrationDirectory = join(canonical, 'migrations', result.migrationId);
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'protocol.json')), fixture.heads.protocol);
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'registry.json')), fixture.heads.registry);
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'owner.lock')), fixture.heads.owner);
  const intent = JSON.parse(await readFile(join(migrationDirectory, 'intent.json'), 'utf8'));
  assert.equal(intent.kind, 'bridge-protocol-upgrade-intent');
  assert.equal(intent.previousProtocol, 3);
  assert.equal(intent.targetProtocol, 4);
  assert.equal(intent.taskCount, 2);
  assert.equal(intent.legacyTaskCount, 1);
  const receipt = JSON.parse(await readFile(join(migrationDirectory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.kind, 'bridge-protocol-upgrade-receipt');
  assert.equal(receipt.protocol, 4);
  assert.equal(receipt.revision, fixture.registry.revision + 1);
  assert.equal(receipt.taskCount, 2);

  assert.deepEqual(sorted(await readdir(canonical)),
    ['migrations', 'owner.lock', 'protocol.json', 'registry.json', 'tasks', 'tasks-v3']);
  assert.deepEqual(await readdir(join(canonical, 'migrations')), [result.migrationId]);
  // The upgrade-owned registry lock is released; no residual lock blocks future writers.
  await assert.rejects(access(join(canonical, 'registry.lock')), { code: 'ENOENT' });
});

test('a current protocol 4 store is reported as already upgraded without rewriting', async t => {
  const fixture = await makeV3Store(t, { tasks: 1, legacy: 1 });
  const canonical = await realpath(fixture.dataDir);
  const first = await upgradeStore({ dataDir: fixture.dataDir });
  assert.equal(first.alreadyUpgraded, false);
  const before = await tree(canonical);

  const second = await upgradeStore({ dataDir: fixture.dataDir });
  assert.equal(second.alreadyUpgraded, true);
  assert.equal(second.protocol, 4);
  assert.equal(second.previousProtocol, 4);
  assert.equal(second.taskCount, 1);
  assert.equal(second.legacyTaskCount, 1);
  assert.equal(second.migrationDirectory, null);
  assert.equal(second.migrationId, undefined);
  assert.deepEqual(await tree(canonical), before);

  const plan = await upgradeStore({ dataDir: fixture.dataDir, dryRun: true });
  assert.equal(plan.alreadyUpgraded, true);
  assert.equal(plan.protocol, 4);
  assert.deepEqual(await tree(canonical), before);
  assert.deepEqual(await readdir(join(canonical, 'migrations')), [first.migrationId]);
});

test('an active execution lease blocks the upgrade before any durable write', async t => {
  const fixture = await makeV3Store(t, { tasks: 1 });
  const canonical = await realpath(fixture.dataDir);
  const [taskId] = fixture.taskIds;
  const registry = JSON.parse(await readFile(join(canonical, 'registry.json'), 'utf8'));
  const lease = { nonce: randomUUID(), ownerId: randomUUID(), attempt: 2, workspace: fixture.workspace, access: 'read-only' };
  registry.tasks[taskId].lease = lease;
  await writeFile(join(canonical, 'registry.json'), JSON.stringify(registry));
  await writeFile(join(canonical, 'tasks-v3', taskId, 'lease.lock'),
    JSON.stringify({ protocol: 3, storeId: fixture.storeId, taskId, ...lease }));

  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir }), { code: 'TASK_BUSY' });
  assert.equal(JSON.parse(await readFile(join(canonical, 'protocol.json'), 'utf8')).protocol, 3);
  assert.equal(JSON.parse(await readFile(join(canonical, 'owner.lock'), 'utf8')).protocol, 3);
  assert.deepEqual(sorted(await readdir(canonical)), ['owner.lock', 'protocol.json', 'registry.json', 'tasks-v3']);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });
  await assert.rejects(access(join(canonical, 'registry.lock')), { code: 'ENOENT' });
});

test('a foreign registry lock is waited on and never stolen', async t => {
  const fixture = await makeV3Store(t, { tasks: 1 });
  const canonical = await realpath(fixture.dataDir);
  const foreign = JSON.stringify({ nonce: 'foreign-nonce', pid: 4242 });
  await writeFile(join(canonical, 'registry.lock'), foreign);

  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir, lockWaitMs: 25 }), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(join(canonical, 'registry.lock'), 'utf8'), foreign);
  assert.equal(JSON.parse(await readFile(join(canonical, 'protocol.json'), 'utf8')).protocol, 3);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });

  // A dry run never touches locks and still reports the v3 plan.
  const plan = await upgradeStore({ dataDir: fixture.dataDir, dryRun: true, lockWaitMs: 0 });
  assert.equal(plan.protocol, 3);
  assert.equal(plan.targetProtocol, 4);
  assert.equal(await readFile(join(canonical, 'registry.lock'), 'utf8'), foreign);
});

test('a mismatched ownership guard is rejected before modification', async t => {
  const fixture = await makeV3Store(t, { tasks: 1 });
  const canonical = await realpath(fixture.dataDir);

  await writeFile(join(canonical, 'owner.lock'),
    JSON.stringify({ kind: 'bridge-protocol-guard', protocol: 3, storeId: randomUUID() }));
  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir }), { code: 'RECOVERY_REQUIRED' });

  await writeFile(join(canonical, 'owner.lock'),
    JSON.stringify({ kind: 'bridge-protocol-guard', protocol: 4, storeId: fixture.storeId }));
  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir }), { code: 'RECOVERY_REQUIRED' });

  assert.equal(JSON.parse(await readFile(join(canonical, 'protocol.json'), 'utf8')).protocol, 3);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });
  await assert.rejects(access(join(canonical, 'registry.lock')), { code: 'ENOENT' });
});

test('a dry run validates the store and reports retained task counts without writing', async t => {
  const fixture = await makeV3Store(t, { tasks: 2, legacy: 1 });
  const canonical = await realpath(fixture.dataDir);
  const before = await tree(canonical);

  const plan = await upgradeStore({ dataDir: fixture.dataDir, dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.alreadyUpgraded, false);
  assert.equal(plan.protocol, 3);
  assert.equal(plan.previousProtocol, 3);
  assert.equal(plan.targetProtocol, 4);
  assert.equal(plan.taskCount, 2);
  assert.equal(plan.legacyTaskCount, 1);
  assert.equal(plan.migrationDirectory, null);

  assert.deepEqual(await tree(canonical), before);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });
  await assert.rejects(access(join(canonical, 'registry.lock')), { code: 'ENOENT' });

  // A later real upgrade still sees exactly the same retained tasks.
  const upgraded = await upgradeStore({ dataDir: fixture.dataDir });
  assert.equal(upgraded.taskCount, plan.taskCount);
  assert.equal(upgraded.legacyTaskCount, plan.legacyTaskCount);
});

test('a failed registry publication preserves backups and fails closed', async t => {
  const fixture = await makeV3Store(t, { tasks: 1, legacy: 1 });
  const canonical = await realpath(fixture.dataDir);
  const registryPath = join(canonical, 'registry.json');
  const writer = async (path, content, options) => {
    if (resolve(path) === resolve(registryPath)) throw new Error('synthetic publication failure');
    return atomicWrite(path, content, options);
  };

  const failure = await upgradeStore({ dataDir: fixture.dataDir, writer }).then(() => null, error => error);
  assert.ok(failure instanceof BridgeError);
  assert.equal(failure.code, 'RECOVERY_REQUIRED');
  assert.equal(String(failure.message).includes('synthetic'), false);

  // Guard published first; registry and manifest remain the untouched protocol 3 bytes.
  const guard = JSON.parse(await readFile(join(canonical, 'owner.lock'), 'utf8'));
  assert.equal(guard.protocol, 4);
  assert.equal(guard.storeId, fixture.storeId);
  assert.deepEqual(await readFile(registryPath), fixture.heads.registry);
  assert.deepEqual(await readFile(join(canonical, 'protocol.json')), fixture.heads.protocol);

  const [migrationId] = await readdir(join(canonical, 'migrations'));
  assert.match(migrationId, UUID_RE);
  const migrationDirectory = join(canonical, 'migrations', migrationId);
  const intent = JSON.parse(await readFile(join(migrationDirectory, 'intent.json'), 'utf8'));
  assert.equal(intent.kind, 'bridge-protocol-upgrade-intent');
  assert.equal(intent.previousProtocol, 3);
  assert.equal(intent.targetProtocol, 4);
  // The intent record was durable before any head changed, and no receipt pretends success.
  await assert.rejects(access(join(migrationDirectory, 'receipt.json')), { code: 'ENOENT' });
  // Byte-for-byte backups of all three protocol 3 heads survive the failure.
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'protocol.json')), fixture.heads.protocol);
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'registry.json')), fixture.heads.registry);
  assert.deepEqual(await readFile(join(migrationDirectory, 'backup', 'owner.lock')), fixture.heads.owner);
  for (const [path, bytes] of fixture.snapshots) assert.deepEqual(await readFile(path), bytes);
  for (const [path, bytes] of fixture.legacyRecords) assert.deepEqual(await readFile(path), bytes);
  // The upgrade-owned lock is released on failure; only a foreign lock would survive.
  await assert.rejects(access(join(canonical, 'registry.lock')), { code: 'ENOENT' });

  // Fail closed: no automatic retry or rollback, and no further durable change.
  const after = await tree(canonical);
  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir }), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await tree(canonical), after);
});

test('symbolic link or junction state paths are rejected', async t => {
  const fixture = await makeV3Store(t, { tasks: 1 });
  const canonical = await realpath(fixture.dataDir);
  const outside = join(fixture.root, 'outside');
  await mkdir(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try { await symlink(outside, join(fixture.root, 'probe-link'), linkType); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
      t.skip(`symbolic link creation is unsupported on this platform (${error.code})`);
      return;
    }
    throw error;
  }

  // The data directory itself cannot be reached through a link or junction.
  const stateLink = join(fixture.root, 'state-link');
  await symlink(canonical, stateLink, linkType);
  await assert.rejects(upgradeStore({ dataDir: stateLink }), { code: 'UNSAFE_PATH' });

  // A linked task directory inside the store fails closed before any write.
  await rename(join(canonical, 'tasks-v3'), join(canonical, 'tasks-v3-real'));
  await symlink(join(canonical, 'tasks-v3-real'), join(canonical, 'tasks-v3'), linkType);
  await assert.rejects(upgradeStore({ dataDir: fixture.dataDir }), { code: 'UNSAFE_PATH' });

  assert.deepEqual(await readFile(join(canonical, 'protocol.json')), fixture.heads.protocol);
  assert.deepEqual(await readFile(join(canonical, 'registry.json')), fixture.heads.registry);
  assert.deepEqual(await readFile(join(canonical, 'owner.lock')), fixture.heads.owner);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });
});

test('snapshot directory junction is rejected before migration reads external task contents', async t => {
  const fixture = await makeV3Store(t, { tasks: 1 });
  const canonical = await realpath(fixture.dataDir);
  const id = Object.keys(fixture.registry.tasks)[0];
  const snapshots = join(canonical, 'tasks-v3', id, 'snapshots');
  const external = join(fixture.root, 'external-snapshots');
  await rename(snapshots, external);
  try { await symlink(external, snapshots, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) { t.skip('Links unavailable'); return; } throw error; }
  await assert.rejects(upgradeStore({ dataDir: canonical, dryRun: true }), { code: 'UNSAFE_PATH' });
  await assert.rejects(upgradeStore({ dataDir: canonical }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await readFile(join(canonical, 'protocol.json')), fixture.heads.protocol);
  await assert.rejects(access(join(canonical, 'migrations')), { code: 'ENOENT' });
});
