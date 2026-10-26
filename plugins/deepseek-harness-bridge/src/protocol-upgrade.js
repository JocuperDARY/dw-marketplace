// Explicit offline Bridge protocol 3 -> protocol 4 migration.
//
// This module is deliberately not wired into startup paths: an operator runs it
// while every protocol 3 host is stopped. Task records and their paths stay at
// schema version 3 inside tasks-v3 (lossless historical compatibility); only the
// three control heads move to protocol 4, with the manifest published last.
//
// The validated protocol 3 shapes are the on-disk format this module reads:
//   protocol.json  { protocol: 3, storeId: <uuid> }
//   owner.lock     { kind: 'bridge-protocol-guard', protocol: 3, storeId: <uuid> }
//   registry.json  { protocol: 3, storeId, revision, tasks: {}, requests: {} }
//   tasks-v3/<taskId>/snapshots/<uuid>.json  schemaVersion 3 task records
//   tasks/<taskId>/task.json                 read-only schemaVersion 1 records
// Unknown extra properties are preserved verbatim when a head is republished.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from './concurrent-store.js';
import { BridgeError, requireValue } from './errors.js';

const SOURCE_PROTOCOL = 3;
const TARGET_PROTOCOL = 4;
const GUARD_KIND = 'bridge-protocol-guard';
const LOCK_KIND = 'bridge-protocol-upgrade-lock';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIVE = new Set(['running', 'cancelling']);
const TERMINAL = new Set(['completed', 'paused', 'failed', 'cancelled', 'timed_out', 'cleanup_failed', 'interrupted', 'state_write_failed']);
const CLEANUP = new Set(['pending', 'confirmed', 'unverified']);
const ACCESS = new Set(['read-only', 'workspace-write']);
const LOCK_POLL_MS = 10;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = (condition, code, message) => { if (!condition) throw new BridgeError(code, message); };
const recovery = message => new BridgeError('RECOVERY_REQUIRED', message);
const unsafePath = () => new BridgeError('UNSAFE_PATH', 'A bridge state path is a symbolic link or junction; explicit reconciliation is required.');

// lstat only: a link or junction must never be followed into a synthetic store.
async function entry(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkedEntry(path) {
  const info = await entry(path);
  if (info?.isSymbolicLink()) throw unsafePath();
  return info;
}

async function readControlFile(path, label) {
  const info = await checkedEntry(path);
  if (info === null) throw recovery(`The ${label} is missing; the store is not a complete protocol 3 store.`);
  invalid(info.isFile(), 'RECOVERY_REQUIRED', `The ${label} is not a regular file; explicit reconciliation is required.`);
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    invalid(opened.isFile(), 'RECOVERY_REQUIRED', `The ${label} is not a regular file; explicit reconciliation is required.`);
    const bytes = await handle.readFile();
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw recovery(`The ${label} is not valid JSON; explicit reconciliation is required.`); }
    return { bytes, value };
  } finally { await handle.close(); }
}

async function canonicalDataDir(dataDir) {
  const resolved = resolve(dataDir);
  const info = await checkedEntry(resolved);
  requireValue(info !== null, 'UPGRADE_REQUIRED', 'No bridge protocol store exists at the requested directory.');
  invalid(info.isDirectory(), 'RECOVERY_REQUIRED', 'The bridge data directory is not a directory; explicit reconciliation is required.');
  return realpath(resolved);
}

async function readHeads(dataDir) {
  const manifest = await readControlFile(join(dataDir, 'protocol.json'), 'protocol manifest');
  const guard = await readControlFile(join(dataDir, 'owner.lock'), 'ownership guard');
  const registry = await readControlFile(join(dataDir, 'registry.json'), 'registry');
  return { manifest, guard, registry };
}

async function openStore(dataDir) {
  const manifest = await checkedEntry(join(dataDir, 'protocol.json'));
  if (manifest === null) {
    let partial = false;
    for (const name of ['owner.lock', 'registry.json']) if (await checkedEntry(join(dataDir, name)) !== null) partial = true;
    if (!partial) throw new BridgeError('UPGRADE_REQUIRED', 'No bridge protocol store exists at the requested directory.');
    throw recovery('The protocol manifest is missing while other protocol heads remain; the store is partial and requires explicit reconciliation.');
  }
  return readHeads(dataDir);
}

function validateGuard(heads) {
  const manifest = heads.manifest.value;
  const guard = heads.guard.value;
  invalid(plain(manifest) && manifest.protocol === SOURCE_PROTOCOL && UUID.test(manifest.storeId),
    'RECOVERY_REQUIRED', 'The protocol 3 manifest is incomplete; explicit reconciliation is required.');
  invalid(plain(guard) && guard.kind === GUARD_KIND, 'RECOVERY_REQUIRED',
    'The ownership guard is not a bridge protocol guard; it was preserved.');
  invalid(guard.protocol === SOURCE_PROTOCOL, 'RECOVERY_REQUIRED',
    'The ownership guard protocol does not match the protocol 3 manifest; it was preserved.');
  invalid(guard.storeId === manifest.storeId, 'RECOVERY_REQUIRED',
    'The ownership guard store identity does not match the manifest; it was preserved.');
  return manifest.storeId;
}

function validateRegistryShape(registryValue, storeId) {
  invalid(plain(registryValue) && registryValue.protocol === SOURCE_PROTOCOL,
    'RECOVERY_REQUIRED', 'The registry is not a protocol 3 registry; explicit reconciliation is required.');
  invalid(registryValue.storeId === storeId, 'RECOVERY_REQUIRED',
    'The registry store identity does not match the manifest; explicit reconciliation is required.');
  invalid(Number.isSafeInteger(registryValue.revision) && registryValue.revision >= 0,
    'RECOVERY_REQUIRED', 'The registry revision is invalid; explicit reconciliation is required.');
  invalid(plain(registryValue.tasks) && plain(registryValue.requests),
    'RECOVERY_REQUIRED', 'The registry entries are malformed; explicit reconciliation is required.');
}

function validateAttempt(attempt, index, seen) {
  invalid(plain(attempt) && attempt.number === index + 1 && ID.test(attempt.requestId) && HASH.test(attempt.fingerprint)
    && (LIVE.has(attempt.status) || TERMINAL.has(attempt.status)) && CLEANUP.has(attempt.cleanup)
    && !seen.has(attempt.requestId),
  'RECOVERY_REQUIRED', 'A task snapshot attempt is malformed; explicit reconciliation is required.');
  seen.add(attempt.requestId);
}

async function validateTaskSnapshot(dataDir, taskId, entryValue, requests) {
  invalid(plain(entryValue) && UUID.test(taskId), 'RECOVERY_REQUIRED', 'A registry task entry is malformed; explicit reconciliation is required.');
  invalid(HASH.test(entryValue.controlHash) && UUID.test(entryValue.creatorId)
    && Number.isSafeInteger(entryValue.generation) && entryValue.generation >= 1,
  'RECOVERY_REQUIRED', 'A registry task entry is malformed; explicit reconciliation is required.');
  // Any recorded or residual execution lease means the task is not finished.
  invalid(entryValue.lease === undefined || entryValue.lease === null, 'TASK_BUSY',
    'A task still holds an execution lease; finish the task and confirm cleanup before upgrading.');
  invalid(typeof entryValue.snapshot === 'string', 'RECOVERY_REQUIRED',
    'A registry task snapshot path is malformed; explicit reconciliation is required.');
  const parts = entryValue.snapshot.split('/');
  invalid(parts.length === 4 && parts[0] === 'tasks-v3' && parts[1] === taskId && parts[2] === 'snapshots'
    && SNAPSHOT_NAME.test(parts[3]),
  'RECOVERY_REQUIRED', 'A registry task snapshot path is malformed; explicit reconciliation is required.');
  for (let count = 1; count < parts.length; count++) {
    const ancestor = await checkedEntry(join(dataDir, ...parts.slice(0, count)));
    invalid(ancestor?.isDirectory(), 'RECOVERY_REQUIRED', 'A snapshot directory is missing or unsafe.');
  }
  const record = (await readControlFile(join(dataDir, ...parts), 'task snapshot')).value;
  invalid(plain(record) && record.taskId === taskId && record.schemaVersion === SOURCE_PROTOCOL,
    'RECOVERY_REQUIRED', 'A task snapshot is not a schema version 3 record for its registry entry.');
  invalid(typeof record.workspace === 'string' && isAbsolute(record.workspace) && ACCESS.has(record.access),
    'RECOVERY_REQUIRED', 'A task snapshot workspace or access mode is malformed; explicit reconciliation is required.');
  invalid(Array.isArray(record.attempts) && record.attempts.length > 0, 'RECOVERY_REQUIRED',
    'A task snapshot has no attempts; explicit reconciliation is required.');
  const seen = new Set();
  for (const [index, attempt] of record.attempts.entries()) {
    validateAttempt(attempt, index, seen);
    const receipt = own(requests, attempt.requestId) ? requests[attempt.requestId] : null;
    invalid(plain(receipt) && receipt.taskId === taskId && receipt.attempt === attempt.number
      && receipt.fingerprint === attempt.fingerprint,
    'RECOVERY_REQUIRED', 'A task attempt does not match its registry request receipt.');
  }
  const latest = record.attempts.at(-1);
  // Historical earlier attempts may remain failed; only the committed snapshot decides readiness.
  invalid(TERMINAL.has(latest.status) && latest.cleanup === 'confirmed', 'RECOVERY_REQUIRED',
    'A task has not reached a terminal snapshot with confirmed cleanup; finish it before upgrading.');
}

async function inspectLegacy(dataDir, requests) {
  const legacyDir = join(dataDir, 'tasks');
  const info = await checkedEntry(legacyDir);
  if (info === null) return { count: 0, records: [] };
  invalid(info.isDirectory(), 'RECOVERY_REQUIRED', 'The read-only legacy task directory is not a directory.');
  const records = [];
  for (const item of await readdir(legacyDir, { withFileTypes: true })) {
    invalid(!item.isSymbolicLink() && item.isDirectory() && UUID.test(item.name), 'RECOVERY_REQUIRED',
      'The read-only legacy task directory contains an unexpected entry.');
    const taskDir = join(legacyDir, item.name);
    const taskInfo = await checkedEntry(taskDir);
    invalid(taskInfo?.isDirectory(), 'RECOVERY_REQUIRED', 'A legacy task entry is not a directory.');
    const recordInfo = await checkedEntry(join(taskDir, 'task.json'));
    if (recordInfo === null) {
      // An empty unpublished old directory stays untouched, as it does for observations.
      const contents = await readdir(taskDir);
      invalid(contents.length === 0, 'RECOVERY_REQUIRED', 'A legacy task directory is missing its task record.');
      continue;
    }
    const record = (await readControlFile(join(taskDir, 'task.json'), 'legacy task record')).value;
    invalid(plain(record) && record.taskId === item.name && record.schemaVersion === 1,
      'RECOVERY_REQUIRED', 'A legacy task record is malformed; explicit reconciliation is required.');
    invalid(Array.isArray(record.attempts) && record.attempts.length > 0, 'RECOVERY_REQUIRED',
      'A legacy task record has no attempts; explicit reconciliation is required.');
    const seen = new Set();
    for (const [index, attempt] of record.attempts.entries()) {
      validateAttempt(attempt, index, seen);
      // A live or unreconciled legacy attempt may still own a workspace.
      invalid(!LIVE.has(attempt.status) && attempt.cleanup !== 'unverified', 'TASK_BUSY',
        'A read-only legacy attempt is still active or has unconfirmed cleanup; finish it before upgrading.');
      invalid(!own(requests, attempt.requestId), 'RECOVERY_REQUIRED',
        'A legacy request identity collides with the current registry; explicit reconciliation is required.');
    }
    records.push(record);
  }
  return { count: records.length, records };
}

async function inspectTasksDirectory(dataDir) {
  const tasksDir = join(dataDir, 'tasks-v3');
  const info = await checkedEntry(tasksDir);
  invalid(info !== null && info.isDirectory(), 'RECOVERY_REQUIRED',
    'The protocol 3 task store directory is missing or unsafe; explicit reconciliation is required.');
  for (const item of await readdir(tasksDir, { withFileTypes: true })) {
    invalid(!item.isSymbolicLink() && item.isDirectory() && UUID.test(item.name), 'RECOVERY_REQUIRED',
      'The protocol 3 task store contains an unexpected entry.');
    const taskDir = join(tasksDir, item.name);
    const taskInfo = await checkedEntry(taskDir);
    invalid(taskInfo?.isDirectory(), 'RECOVERY_REQUIRED', 'A protocol 3 task entry is not a directory.');
    invalid((await checkedEntry(join(taskDir, 'lease.lock'))) === null, 'TASK_BUSY',
      'A residual task lease exists; finish the task and confirm cleanup before upgrading.');
  }
}

async function validateV3Store(dataDir, heads) {
  const storeId = validateGuard(heads);
  validateRegistryShape(heads.registry.value, storeId);
  const registry = heads.registry.value;
  await inspectTasksDirectory(dataDir);
  for (const [taskId, taskEntry] of Object.entries(registry.tasks)) {
    await validateTaskSnapshot(dataDir, taskId, taskEntry, registry.requests);
  }
  for (const [requestId, receipt] of Object.entries(registry.requests)) {
    invalid(ID.test(requestId) && plain(receipt) && HASH.test(receipt.fingerprint)
      && own(registry.tasks, receipt.taskId) && Number.isSafeInteger(receipt.attempt) && receipt.attempt >= 1,
    'RECOVERY_REQUIRED', 'A registry request receipt is malformed; explicit reconciliation is required.');
  }
  const legacy = await inspectLegacy(dataDir, registry.requests);
  return { storeId, revision: registry.revision, taskCount: Object.keys(registry.tasks).length, legacyTaskCount: legacy.count };
}

async function countLegacy(dataDir) {
  const legacyDir = join(dataDir, 'tasks');
  const info = await checkedEntry(legacyDir);
  if (info === null) return 0;
  invalid(info.isDirectory(), 'RECOVERY_REQUIRED', 'The read-only legacy task directory is not a directory.');
  let count = 0;
  for (const item of await readdir(legacyDir, { withFileTypes: true })) {
    invalid(!item.isSymbolicLink() && item.isDirectory() && UUID.test(item.name), 'RECOVERY_REQUIRED',
      'The read-only legacy task directory contains an unexpected entry.');
    const taskInfo = await checkedEntry(join(legacyDir, item.name));
    invalid(taskInfo?.isDirectory(), 'RECOVERY_REQUIRED', 'A legacy task entry is not a directory.');
    if (await checkedEntry(join(legacyDir, item.name, 'task.json')) !== null) count++;
  }
  return count;
}

async function inspectCurrentProtocol(dataDir, heads) {
  const manifest = heads.manifest.value;
  const guard = heads.guard.value;
  const registry = heads.registry.value;
  invalid(plain(manifest) && manifest.protocol === TARGET_PROTOCOL && UUID.test(manifest.storeId), 'RECOVERY_REQUIRED',
    'The protocol 4 manifest is incomplete; explicit reconciliation is required.');
  invalid(plain(guard) && guard.kind === GUARD_KIND && guard.protocol === TARGET_PROTOCOL
    && guard.storeId === manifest.storeId, 'RECOVERY_REQUIRED',
  'The protocol 4 ownership guard does not match the manifest; it was preserved.');
  invalid(plain(registry) && registry.protocol === TARGET_PROTOCOL && registry.storeId === manifest.storeId
    && Number.isSafeInteger(registry.revision) && registry.revision >= 0
    && plain(registry.tasks) && plain(registry.requests), 'RECOVERY_REQUIRED',
  'The protocol 4 registry does not match the manifest; explicit reconciliation is required.');
  return { storeId: manifest.storeId, taskCount: Object.keys(registry.tasks).length, legacyTaskCount: await countLegacy(dataDir) };
}

async function inspectMigrations(dataDir) {
  const migrationsDir = join(dataDir, 'migrations');
  const info = await checkedEntry(migrationsDir);
  if (info === null) return [];
  invalid(info.isDirectory(), 'RECOVERY_REQUIRED', 'The migration directory is not a directory; explicit reconciliation is required.');
  const complete = [];
  for (const item of await readdir(migrationsDir, { withFileTypes: true })) {
    invalid(!item.isSymbolicLink() && item.isDirectory() && UUID.test(item.name), 'RECOVERY_REQUIRED',
      'The migration directory contains an unexpected entry; explicit reconciliation is required.');
    const migrationDirectory = join(migrationsDir, item.name);
    const directoryInfo = await checkedEntry(migrationDirectory);
    invalid(directoryInfo?.isDirectory(), 'RECOVERY_REQUIRED', 'A migration entry is not a directory.');
    const receipt = await checkedEntry(join(migrationDirectory, 'receipt.json'));
    const intent = await checkedEntry(join(migrationDirectory, 'intent.json'));
    const backup = await checkedEntry(join(migrationDirectory, 'backup'));
    invalid(!(receipt === null && (intent !== null || backup !== null)), 'RECOVERY_REQUIRED',
      'An interrupted protocol migration requires explicit reconciliation; it is never retried or rolled back automatically.');
    complete.push(item.name);
  }
  return complete;
}

async function acquireRegistryLock(dataDir, lockWaitMs) {
  const path = join(dataDir, 'registry.lock');
  const nonce = randomUUID();
  const started = Date.now();
  for (;;) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A foreign lock is never inspected for age or PID and never removed.
      if (Date.now() - started >= lockWaitMs) throw new BridgeError('STATE_LOCKED',
        'The registry transaction lock remains owned; it was not removed.');
      await delay(Math.min(LOCK_POLL_MS, Math.max(1, lockWaitMs - (Date.now() - started))));
      continue;
    }
    let written = false;
    try {
      await handle.writeFile(JSON.stringify({ kind: LOCK_KIND, nonce, pid: process.pid }));
      await handle.sync();
      written = true;
    } finally {
      await handle.close();
      if (!written) { try { await unlink(path); } catch { /* an unreadable own lock fails closed below */ } }
    }
    return { nonce, pid: process.pid };
  }
}

async function releaseRegistryLock(dataDir, lock) {
  const path = join(dataDir, 'registry.lock');
  const current = await readControlFile(path, 'registry lock');
  invalid(plain(current.value) && current.value.nonce === lock.nonce && current.value.pid === lock.pid,
    'RECOVERY_REQUIRED', 'Registry lock ownership changed; the foreign lock was preserved.');
  await unlink(path);
}

async function ensureDirectory(path, label) {
  const info = await checkedEntry(path);
  if (info === null) { await mkdir(path, { mode: 0o700 }); return; }
  invalid(info.isDirectory(), 'RECOVERY_REQUIRED', `The ${label} is not a directory; explicit reconciliation is required.`);
}

async function prepareMigration(dataDir, writer, heads, state, lock) {
  const migrationsDir = join(dataDir, 'migrations');
  await ensureDirectory(migrationsDir, 'migration directory');
  const migrationId = randomUUID();
  const migrationDirectory = join(migrationsDir, migrationId);
  await mkdir(migrationDirectory, { mode: 0o700 });
  const directoryInfo = await checkedEntry(migrationDirectory);
  invalid(directoryInfo?.isDirectory(), 'RECOVERY_REQUIRED', 'The new migration directory is unsafe; explicit reconciliation is required.');
  const backupDir = join(migrationDirectory, 'backup');
  await mkdir(backupDir, { mode: 0o700 });
  invalid((await checkedEntry(backupDir))?.isDirectory(), 'RECOVERY_REQUIRED',
    'The migration backup directory is unsafe; explicit reconciliation is required.');
  const backups = [];
  for (const [name, head] of [['protocol.json', heads.manifest], ['registry.json', heads.registry], ['owner.lock', heads.guard]]) {
    // Byte-for-byte copies of the protocol 3 heads, published before any head changes.
    await writer(join(backupDir, name), head.bytes, { immutable: true });
    backups.push({ name, sha256: sha256(head.bytes), bytes: head.bytes.length });
  }
  const intent = {
    kind: 'bridge-protocol-upgrade-intent', migrationId, storeId: state.storeId,
    previousProtocol: SOURCE_PROTOCOL, targetProtocol: TARGET_PROTOCOL,
    previousRevision: state.revision, nextRevision: state.revision + 1,
    taskCount: state.taskCount, legacyTaskCount: state.legacyTaskCount, backups,
    pid: process.pid, lockNonce: lock.nonce, createdAt: new Date().toISOString(),
  };
  await writer(join(migrationDirectory, 'intent.json'), Buffer.from(JSON.stringify(intent)), { immutable: true });
  return { migrationId, migrationDirectory, backups, intent };
}

async function publishUpgrade(dataDir, writer, heads) {
  const guard = { ...heads.guard.value, protocol: TARGET_PROTOCOL };
  const registry = { ...heads.registry.value, protocol: TARGET_PROTOCOL, revision: heads.registry.value.revision + 1 };
  const manifest = { ...heads.manifest.value, protocol: TARGET_PROTOCOL };
  // Guard first, registry second, manifest last: the manifest is the commit point.
  await writer(join(dataDir, 'owner.lock'), JSON.stringify(guard));
  await writer(join(dataDir, 'registry.json'), JSON.stringify(registry));
  await writer(join(dataDir, 'protocol.json'), JSON.stringify(manifest));
  return { guard, registry, manifest };
}

async function writeReceipt(writer, prepared, state, published) {
  const receipt = {
    kind: 'bridge-protocol-upgrade-receipt', migrationId: prepared.migrationId, storeId: state.storeId,
    previousProtocol: SOURCE_PROTOCOL, protocol: TARGET_PROTOCOL,
    previousRevision: state.revision, revision: published.registry.revision,
    taskCount: state.taskCount, legacyTaskCount: state.legacyTaskCount,
    backups: prepared.backups.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    pid: process.pid, committedAt: new Date().toISOString(),
  };
  await writer(join(prepared.migrationDirectory, 'receipt.json'), Buffer.from(JSON.stringify(receipt)), { immutable: true });
  return receipt;
}

async function run({ dataDir, dryRun, writer, lockWaitMs }) {
  requireValue(typeof dataDir === 'string' && isAbsolute(dataDir), 'INVALID_CONFIG', 'The bridge data directory must be an absolute path.');
  requireValue(typeof dryRun === 'boolean', 'INVALID_ARGUMENT', 'dryRun must be a boolean.');
  requireValue(typeof writer === 'function', 'INVALID_CONFIG', 'The store publication writer must be a function.');
  requireValue(Number.isSafeInteger(lockWaitMs) && lockWaitMs >= 0, 'INVALID_CONFIG', 'The registry lock wait must be a nonnegative duration.');

  const root = await canonicalDataDir(dataDir);
  let heads = await openStore(root);
  const protocol = heads.manifest.value?.protocol;
  if (protocol === TARGET_PROTOCOL) {
    const current = await inspectCurrentProtocol(root, heads);
    return { alreadyUpgraded: true, protocol: TARGET_PROTOCOL, previousProtocol: TARGET_PROTOCOL,
      taskCount: current.taskCount, legacyTaskCount: current.legacyTaskCount, migrationDirectory: null };
  }
  invalid(protocol === SOURCE_PROTOCOL, 'RECOVERY_REQUIRED',
    'The store protocol is not a supported upgrade source; explicit reconciliation is required.');
  const planned = await validateV3Store(root, heads);
  await inspectMigrations(root);
  if (dryRun) {
    return { dryRun: true, alreadyUpgraded: false, protocol: SOURCE_PROTOCOL, previousProtocol: SOURCE_PROTOCOL,
      targetProtocol: TARGET_PROTOCOL, taskCount: planned.taskCount, legacyTaskCount: planned.legacyTaskCount,
      migrationDirectory: null };
  }

  const lock = await acquireRegistryLock(root, lockWaitMs);
  let failure = null;
  try {
    // Every condition is revalidated under the lock before any durable write.
    heads = await openStore(root);
    if (heads.manifest.value.protocol === TARGET_PROTOCOL) {
      const current = await inspectCurrentProtocol(root, heads);
      return { alreadyUpgraded: true, protocol: TARGET_PROTOCOL, previousProtocol: TARGET_PROTOCOL,
        taskCount: current.taskCount, legacyTaskCount: current.legacyTaskCount, migrationDirectory: null };
    }
    const state = await validateV3Store(root, heads);
    await inspectMigrations(root);
    const prepared = await prepareMigration(root, writer, heads, state, lock);
    const published = await publishUpgrade(root, writer, heads);
    await writeReceipt(writer, prepared, state, published);
    return { alreadyUpgraded: false, protocol: TARGET_PROTOCOL, previousProtocol: SOURCE_PROTOCOL,
      taskCount: state.taskCount, legacyTaskCount: state.legacyTaskCount,
      migrationDirectory: prepared.migrationDirectory, migrationId: prepared.migrationId };
  } catch (error) { failure = error; throw error; }
  finally {
    // Only our own matching lock is released; a replaced lock stays in place.
    try { await releaseRegistryLock(root, lock); }
    catch (error) { if (!failure) throw error; }
  }
}

// Explicit, operator-invoked protocol 3 -> 4 upgrade.
// Returns protocol 4 / previousProtocol 3 / taskCount / legacyTaskCount /
// migrationDirectory / migrationId for a real upgrade, a protocol 3 plan with
// targetProtocol 4 for a dry run, and alreadyUpgraded: true (no rewrite) for a
// store that is already protocol 4. Codes: INVALID_CONFIG/INVALID_ARGUMENT for
// bad arguments, UPGRADE_REQUIRED/STATE_LOCKED/TASK_BUSY/RECOVERY_REQUIRED/
// UNSAFE_PATH for store conditions; no message contains file contents or paths.
export async function upgradeStore({ dataDir, dryRun = false, writer = atomicWrite, lockWaitMs = 5000 } = {}) {
  try { return await run({ dataDir, dryRun, writer, lockWaitMs }); }
  catch (error) {
    // Unexpected filesystem detail stays internal; callers receive a stable safe code.
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('RECOVERY_REQUIRED', 'The protocol upgrade failed closed; preserved state requires explicit reconciliation.');
  }
}
