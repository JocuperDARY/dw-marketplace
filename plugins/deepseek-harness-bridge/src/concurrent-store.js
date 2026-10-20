import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rename, lstat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { BridgeError, requireValue } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LIVE = new Set(['running', 'cancelling']);
const TERMINAL = new Set(['completed', 'paused', 'failed', 'cancelled', 'timed_out', 'cleanup_failed', 'interrupted', 'state_write_failed']);
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);
const invalid = condition => requireValue(condition, 'INVALID_STATE', 'The concurrent task store is invalid; reconcile it before writing.');
const missing = error => error?.code === 'ENOENT';
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RENAME_RETRY_WINDOW_MS = 500;

export function hashControlToken(token) {
  requireValue(typeof token === 'string' && TOKEN.test(token), 'NOT_OWNER', 'A valid task control capability is required.');
  return createHash('sha256').update(token).digest('hex');
}

/** Only mutable pointer rename retries; transactions, execution and immutable owners never replay. */
export function createAtomicStoreWriter({ openFile = open, renameFile = rename, linkFile = link, unlinkFile = unlink,
  wait = delay, now = () => performance.now(), platform = process.platform } = {}) {
  return async (path, content, { immutable = false } = {}) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let owned = false; let failure;
    try {
      const handle = await openFile(temporary, 'wx', 0o600); owned = true;
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      // Linking a completed inode publishes an immutable file without replacing an owner.
      if (immutable) await linkFile(temporary, path);
      else {
        const deadline = now() + RENAME_RETRY_WINDOW_MS;
        for (let attempt = 0; ; attempt++) {
          try { await renameFile(temporary, path); break; }
          catch (error) {
            const waitMs = RENAME_RETRY_DELAYS_MS[attempt];
            if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)
              || waitMs == null || now() + waitMs >= deadline) throw error;
            await wait(waitMs);
            if (now() >= deadline) throw error;
          }
        }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      if (owned) try { await unlinkFile(temporary); }
      catch (error) {
        if (!missing(error)) {
          if (failure) throw new AggregateError([failure, error], 'Store publication and owned temporary cleanup failed.', { cause: failure });
          throw error;
        }
      }
    }
  };
}

export const atomicWrite = createAtomicStoreWriter();

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  invalid(info.isDirectory() && !info.isSymbolicLink());
}

async function json(path) {
  const info = await lstat(path);
  invalid(info.isFile() && !info.isSymbolicLink());
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) invalid(false); throw error; }
}

// Real paths normalize aliases; Windows comparisons must also fold case and separators.
function workspaceKey(path) {
  return process.platform === 'win32' || win32.isAbsolute(path)
    ? win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase() : resolve(path);
}
function overlaps(a, b) {
  a = workspaceKey(a); b = workspaceKey(b);
  const separator = process.platform === 'win32' || win32.isAbsolute(a) ? '\\' : sep;
  return a === b || a.startsWith(`${b}${separator}`) || b.startsWith(`${a}${separator}`);
}

function validateRecord(record, id, legacy = false) {
  invalid(plain(record) && record.taskId === id && UUID.test(id) && record.schemaVersion === (legacy ? 1 : 3));
  invalid(typeof record.workspace === 'string' && isAbsolute(record.workspace) && ['read-only', 'workspace-write'].includes(record.access));
  invalid(Array.isArray(record.attempts) && record.attempts.length > 0);
  const requests = new Set();
  for (const [index, attempt] of record.attempts.entries()) {
    invalid(plain(attempt) && attempt.number === index + 1 && ID.test(attempt.requestId) && HASH.test(attempt.fingerprint)
      && !requests.has(attempt.requestId) && (LIVE.has(attempt.status) || TERMINAL.has(attempt.status))
      && ['pending', 'confirmed', 'unverified'].includes(attempt.cleanup));
    requests.add(attempt.requestId);
  }
}

export class ConcurrentStore {
  constructor({ dataDir, ownerId = randomUUID(), registryWaitMs = 5000, writer = atomicWrite } = {}) {
    requireValue(typeof dataDir === 'string' && isAbsolute(dataDir), 'INVALID_CONFIG', 'The bridge data directory must be absolute.');
    requireValue(typeof ownerId === 'string' && UUID.test(ownerId), 'INVALID_CONFIG', 'The store owner identity is invalid.');
    requireValue(Number.isSafeInteger(registryWaitMs) && registryWaitMs >= 0, 'INVALID_CONFIG', 'The registry wait must be a nonnegative duration.');
    requireValue(typeof writer === 'function', 'INVALID_CONFIG', 'The store publication writer must be a function.');
    this.dataDir = resolve(dataDir); this.ownerId = ownerId; this.registryWaitMs = registryWaitMs; this.writer = writer;
    this.owned = new Map();
  }

  taskDirectory(taskId, { legacy = false } = {}) {
    requireValue(typeof taskId === 'string' && UUID.test(taskId), 'INVALID_ARGUMENT', 'The task ID is invalid.');
    return join(this.dataDir, legacy ? 'tasks' : 'tasks-v3', taskId);
  }

  async protocol() {
    let manifest, guard;
    try { manifest = await json(join(this.dataDir, 'protocol.json')); }
    catch (error) {
      if (!missing(error)) throw error;
      let oldGuard;
      try { oldGuard = await json(join(this.dataDir, 'owner.lock')); }
      catch (lockError) { if (missing(lockError)) return null; throw lockError; }
      if (oldGuard.protocol !== 3) return null;
      throw new BridgeError('RECOVERY_REQUIRED', 'An existing ownership guard has no complete protocol manifest.');
    }
    try { guard = await json(join(this.dataDir, 'owner.lock')); }
    catch { throw new BridgeError('RECOVERY_REQUIRED', 'The concurrent protocol ownership guard is unavailable.'); }
    invalid(manifest.protocol === 3 && UUID.test(manifest.storeId) && guard.protocol === 3
      && guard.kind === 'bridge-protocol-guard' && guard.storeId === manifest.storeId);
    return manifest;
  }

  async initialize() {
    await directory(this.dataDir, true); this.dataDir = await realpath(this.dataDir);
    let guard;
    try { guard = await json(join(this.dataDir, 'owner.lock')); }
    catch (error) { if (!missing(error)) throw new BridgeError('UPGRADE_REQUIRED', 'The existing owner lock must be reconciled while old bridge hosts are stopped.'); }
    if (guard) {
      requireValue(guard.protocol === 3 && guard.kind === 'bridge-protocol-guard' && UUID.test(guard.storeId), 'UPGRADE_REQUIRED', 'An old bridge owns this store; stop and reconcile old hosts before upgrading.');
      await this.waitForInitialization(guard); return this;
    }
    // Never repair a partial upgrade implicitly, and never replace an old host's lock.
    for (const name of ['protocol.json', 'registry.json', 'tasks-v3']) {
      try {
        await lstat(join(this.dataDir, name));
        const concurrentGuard = await json(join(this.dataDir, 'owner.lock')).catch(() => null);
        if (concurrentGuard?.protocol === 3 && concurrentGuard.kind === 'bridge-protocol-guard') {
          await this.waitForInitialization(concurrentGuard); return this;
        }
        throw new BridgeError('RECOVERY_REQUIRED', 'A partial concurrent-store upgrade requires explicit reconciliation.');
      }
      catch (error) { if (!missing(error)) throw error; }
    }
    const storeId = randomUUID();
    try { await this.writer(join(this.dataDir, 'owner.lock'), JSON.stringify({ kind: 'bridge-protocol-guard', protocol: 3, storeId }), { immutable: true }); }
    catch (error) {
      if (error.code === 'EEXIST') {
        const concurrentGuard = await json(join(this.dataDir, 'owner.lock'));
        requireValue(concurrentGuard.protocol === 3 && concurrentGuard.kind === 'bridge-protocol-guard', 'UPGRADE_REQUIRED', 'An old host has acquired ownership; its lock was preserved.');
        await this.waitForInitialization(concurrentGuard); return this;
      }
      throw error;
    }
    await directory(join(this.dataDir, 'tasks-v3'), true);
    await this.writer(join(this.dataDir, 'registry.json'), JSON.stringify({ protocol: 3, storeId, revision: 0, tasks: {}, requests: {} }));
    // The manifest is the final initialization commit. Missing manifest always fails closed.
    await this.writer(join(this.dataDir, 'protocol.json'), JSON.stringify({ protocol: 3, storeId }));
    return this;
  }

  async waitForInitialization(guard) {
    const started = Date.now();
    while (true) {
      try {
        const manifest = await this.protocol();
        invalid(manifest?.storeId === guard.storeId); await this.registry(); return;
      } catch (error) {
        if (error.code !== 'RECOVERY_REQUIRED' && !missing(error)) throw error;
        if (Date.now() - started >= this.registryWaitMs) throw new BridgeError('RECOVERY_REQUIRED', 'Protocol initialization did not publish a complete manifest; its guard was preserved.');
        await delay(Math.min(25, Math.max(1, this.registryWaitMs - (Date.now() - started))));
      }
    }
  }

  async registry() {
    const manifest = await this.protocol();
    if (!manifest) return null;
    await directory(join(this.dataDir, 'tasks-v3'));
    const registry = await json(join(this.dataDir, 'registry.json'));
    invalid(registry.protocol === 3 && registry.storeId === manifest.storeId && Number.isSafeInteger(registry.revision)
      && registry.revision >= 0 && plain(registry.tasks) && plain(registry.requests));
    for (const [id, entry] of Object.entries(registry.tasks)) {
      invalid(UUID.test(id) && plain(entry) && HASH.test(entry.controlHash) && UUID.test(entry.creatorId)
        && Number.isSafeInteger(entry.generation) && entry.generation >= 1
        && typeof entry.snapshot === 'string' && new RegExp(`^tasks-v3/${id}/snapshots/[0-9a-f-]{36}\\.json$`).test(entry.snapshot));
      if (entry.lease) invalid(plain(entry.lease) && UUID.test(entry.lease.nonce) && UUID.test(entry.lease.ownerId)
        && Number.isSafeInteger(entry.lease.attempt) && entry.lease.attempt >= 1
        && typeof entry.lease.workspace === 'string' && isAbsolute(entry.lease.workspace)
        && ['read-only', 'workspace-write'].includes(entry.lease.access));
    }
    for (const [id, receipt] of Object.entries(registry.requests)) {
      invalid(ID.test(id) && plain(receipt) && HASH.test(receipt.fingerprint) && own(registry.tasks, receipt.taskId)
        && Number.isSafeInteger(receipt.attempt) && receipt.attempt >= 1);
    }
    return registry;
  }

  async snapshot(registry, taskId) {
    const entry = registry.tasks[taskId];
    requireValue(entry, 'TASK_NOT_FOUND', 'No task with that ID exists in this bridge state.');
    await directory(this.taskDirectory(taskId)); await directory(join(this.taskDirectory(taskId), 'snapshots'));
    const record = await json(join(this.dataDir, ...entry.snapshot.split('/')));
    validateRecord(record, taskId);
    for (const attempt of record.attempts) {
      const receipt = own(registry.requests, attempt.requestId) ? registry.requests[attempt.requestId] : null;
      invalid(receipt?.taskId === taskId && receipt.attempt === attempt.number && receipt.fingerprint === attempt.fingerprint);
    }
    if (entry.lease) invalid(record.workspace === entry.lease.workspace && record.access === entry.lease.access
      && record.attempts.at(-1).number === entry.lease.attempt);
    return record;
  }

  async legacy() {
    const path = join(this.dataDir, 'tasks');
    try { await directory(path); } catch (error) { if (missing(error)) return []; throw error; }
    const records = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      invalid(entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name));
      let record;
      try { record = await json(join(path, entry.name, 'task.json')); }
      catch (error) {
        // An empty unpublished old directory remains untouched by observations.
        if (missing(error) && (await readdir(join(path, entry.name))).length === 0) continue;
        if (missing(error)) invalid(false);
        throw error;
      }
      validateRecord(record, entry.name, true); records.push(record);
    }
    return records;
  }

  async read() {
    const registry = await this.registry(); const legacyRecords = await this.legacy();
    const requests = registry ? clone(registry.requests) : {};
    for (const record of legacyRecords) for (const attempt of record.attempts) {
      invalid(!own(requests, attempt.requestId));
      requests[attempt.requestId] = { taskId: record.taskId, attempt: attempt.number, fingerprint: attempt.fingerprint };
    }
    if (!registry) return { revision: 0, records: [], legacyRecords, requests, recordRevisions: {}, leases: [] };
    const records = await Promise.all(Object.keys(registry.tasks).map(id => this.snapshot(registry, id)));
    return { revision: registry.revision, records, legacyRecords, requests,
      recordRevisions: Object.fromEntries(Object.entries(registry.tasks).map(([id, entry]) => [id, entry.generation])),
      leases: Object.entries(registry.tasks).filter(([, entry]) => entry.lease).map(([taskId, entry]) => ({ taskId,
        ownerId: entry.lease.ownerId, attempt: entry.lease.attempt, workspace: entry.lease.workspace, access: entry.lease.access })) };
  }

  async readTask(taskId) {
    this.taskDirectory(taskId);
    const registry = await this.registry();
    if (registry && own(registry.tasks, taskId)) return this.snapshot(registry, taskId);
    const record = (await this.legacy()).find(record => record.taskId === taskId);
    requireValue(record, 'TASK_NOT_FOUND', 'No task with that ID exists in this bridge state.');
    return record;
  }

  async transaction(operation) {
    await this.initialize();
    const lockPath = join(this.dataDir, 'registry.lock');
    const nonce = randomUUID(); const started = Date.now(); let handle;
    while (!handle) {
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - started >= this.registryWaitMs) throw new BridgeError('STATE_LOCKED', 'The short registry transaction lock remains owned; it was not removed.');
        await delay(Math.min(25, Math.max(1, this.registryWaitMs - (Date.now() - started))));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ nonce, ownerId: this.ownerId, pid: process.pid })); await handle.sync();
      const registry = await this.registry();
      const result = await operation(registry);
      if (result.commit) {
        registry.revision++;
        await this.writer(join(this.dataDir, 'registry.json'), JSON.stringify(registry));
      }
      return result.value;
    } finally {
      await handle.close();
      const lock = await json(lockPath);
      requireValue(lock.nonce === nonce && lock.ownerId === this.ownerId, 'RECOVERY_REQUIRED', 'Registry lock ownership changed; the foreign lock was preserved.');
      await unlink(lockPath);
    }
  }

  async authorized(registry, taskId, controlToken) {
    const entry = registry.tasks[taskId];
    if (!entry) {
      const legacy = (await this.legacy()).some(record => record.taskId === taskId);
      throw new BridgeError(legacy ? 'LEGACY_READ_ONLY' : 'TASK_NOT_FOUND', legacy ? 'Legacy tasks require explicit offline ownership migration.' : 'No task with that ID exists in this bridge state.');
    }
    const token = controlToken ?? this.owned.get(taskId)?.controlToken;
    const digest = hashControlToken(token);
    requireValue(timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(entry.controlHash, 'hex')), 'NOT_OWNER', 'This connection does not own the task control capability.');
    return entry;
  }

  async authorize(taskId, controlToken) {
    const registry = await this.registry();
    requireValue(registry, 'TASK_NOT_FOUND', 'No concurrent task store exists.');
    await this.authorized(registry, taskId, controlToken); return true;
  }

  async writeSnapshot(registry, record) {
    const taskDir = this.taskDirectory(record.taskId);
    await directory(taskDir); await directory(join(taskDir, 'snapshots'), true);
    const name = `${randomUUID()}.json`;
    await this.writer(join(taskDir, 'snapshots', name), JSON.stringify(record), { immutable: true });
    return `tasks-v3/${record.taskId}/snapshots/${name}`;
  }

  async admit(record, { requestId, fingerprint, controlToken, expectedRevision } = {}) {
    requireValue(ID.test(requestId) && HASH.test(fingerprint), 'INVALID_ARGUMENT', 'The request identity is invalid.');
    validateRecord(record, record.taskId);
    return this.transaction(async registry => {
      const legacyRecords = await this.legacy();
      const legacy = legacyRecords.find(old => old.attempts.some(attempt => attempt.requestId === requestId));
      if (legacy) {
        const attempt = legacy.attempts.find(attempt => attempt.requestId === requestId);
        requireValue(attempt.fingerprint === fingerprint, 'REQUEST_CONFLICT', 'This requestId was already used for different input.');
        return { commit: false, value: { record: legacy, attempt: attempt.number, duplicate: true } };
      }
      const prior = own(registry.requests, requestId) ? registry.requests[requestId] : null;
      if (prior) {
        requireValue(prior.fingerprint === fingerprint, 'REQUEST_CONFLICT', 'This requestId was already used for different input.');
        return { commit: false, value: { record: await this.snapshot(registry, prior.taskId), attempt: prior.attempt, duplicate: true } };
      }
      const previous = registry.tasks[record.taskId];
      let token = controlToken ?? this.owned.get(record.taskId)?.controlToken;
      if (previous) {
        await this.authorized(registry, record.taskId, controlToken);
        requireValue(!previous.lease, 'TASK_BUSY', 'This task has an active or unreconciled execution lease.');
        requireValue(expectedRevision === undefined || expectedRevision === previous.generation, 'STALE_STATE', 'The committed task generation changed.');
        const current = await this.snapshot(registry, record.taskId);
        requireValue(TERMINAL.has(current.attempts.at(-1).status) && current.attempts.at(-1).cleanup === 'confirmed', 'RECOVERY_REQUIRED', 'The previous attempt has not confirmed cleanup.');
        requireValue(record.attempts.length === current.attempts.length + 1
          && JSON.stringify(record.attempts.slice(0, -1)) === JSON.stringify(current.attempts)
          && record.workspace === current.workspace && record.access === current.access, 'STALE_STATE', 'Continuation must append to the current committed task without changing workspace or access.');
      } else {
        requireValue(!(await this.legacy()).some(old => old.taskId === record.taskId), 'LEGACY_READ_ONLY', 'Legacy tasks require explicit offline ownership migration.');
        requireValue(record.attempts.length === 1, 'INVALID_ARGUMENT', 'A new task starts at its first attempt.');
        token = randomBytes(32).toString('base64url');
      }
      const attempt = record.attempts.at(-1);
      requireValue(attempt.status === 'running' && attempt.cleanup === 'pending' && attempt.requestId === requestId
        && attempt.fingerprint === fingerprint, 'INVALID_ARGUMENT', 'Admission needs its matching pending running attempt.');
      const resolvedWorkspace = await realpath(record.workspace); await directory(resolvedWorkspace);
      requireValue(workspaceKey(resolvedWorkspace) === workspaceKey(record.workspace), 'WORKSPACE_CHANGED', 'The workspace identity changed before admission.');
      requireValue(!overlaps(resolvedWorkspace, this.dataDir), 'INVALID_ARGUMENT', 'Task workspace and bridge state must not contain one another.');
      const claims = Object.values(registry.tasks).flatMap(entry => entry.lease ? [entry.lease] : []);
      for (const old of await this.legacy()) if (old.attempts.some(value => LIVE.has(value.status) || value.cleanup === 'unverified')) claims.push({ workspace: old.workspace, access: old.access });
      requireValue(!claims.some(claim => overlaps(claim.workspace, resolvedWorkspace)
        && (claim.access === 'workspace-write' || record.access === 'workspace-write')), 'WORKSPACE_BUSY', 'An overlapping workspace is held by a writing or unreconciled task.');
      const taskDir = this.taskDirectory(record.taskId);
      if (!previous) await directory(taskDir, true);
      else await directory(taskDir);
      const lease = { nonce: randomUUID(), ownerId: this.ownerId, attempt: attempt.number, workspace: record.workspace, access: record.access };
      try { await this.writer(join(taskDir, 'lease.lock'), JSON.stringify({ protocol: 3, storeId: registry.storeId, taskId: record.taskId, ...lease }), { immutable: true }); }
      catch (error) { if (error.code === 'EEXIST') throw new BridgeError('TASK_BUSY', 'An execution lease already exists; it was preserved.'); throw error; }
      // A failure from this point retains the lease: admission/spending must not be guessed.
      const snapshot = await this.writeSnapshot(registry, record);
      registry.tasks[record.taskId] = { snapshot, generation: (previous?.generation ?? 0) + 1,
        creatorId: previous?.creatorId ?? this.ownerId, controlHash: previous?.controlHash ?? hashControlToken(token), lease };
      registry.requests[requestId] = { taskId: record.taskId, attempt: attempt.number, fingerprint };
      this.owned.set(record.taskId, { controlToken: token, lease: clone(lease) });
      return { commit: true, value: { record: clone(record), attempt: attempt.number, duplicate: false, ...(!previous ? { controlToken: token } : {}) } };
    });
  }

  async ownLease(registry, taskId) {
    const local = this.owned.get(taskId); const entry = await this.authorized(registry, taskId);
    requireValue(local?.lease && entry.lease && entry.lease.nonce === local.lease.nonce
      && entry.lease.ownerId === this.ownerId, 'NOT_OWNER', 'This connection does not own the active task lease.');
    const persisted = await json(join(this.taskDirectory(taskId), 'lease.lock'));
    requireValue(persisted.nonce === local.lease.nonce && persisted.ownerId === this.ownerId && persisted.storeId === registry.storeId
      && persisted.taskId === taskId && persisted.attempt === entry.lease.attempt, 'NOT_OWNER', 'The execution lease changed; it was preserved.');
    return entry;
  }

  async persist(record) {
    validateRecord(record, record.taskId);
    return this.transaction(async registry => {
      const entry = await this.ownLease(registry, record.taskId);
      requireValue(record.attempts.at(-1).number === entry.lease.attempt && record.workspace === entry.lease.workspace
        && record.access === entry.lease.access, 'STALE_STATE', 'The task no longer matches its execution lease.');
      entry.snapshot = await this.writeSnapshot(registry, record); entry.generation++;
      return { commit: true, value: clone(record) };
    });
  }

  async release(taskId, { cleanup } = {}) {
    return this.transaction(async registry => {
      const entry = await this.ownLease(registry, taskId);
      if (cleanup !== 'confirmed') return { commit: false, value: { released: false } };
      const record = await this.snapshot(registry, taskId);
      requireValue(TERMINAL.has(record.attempts.at(-1).status) && record.attempts.at(-1).cleanup === 'confirmed', 'RECOVERY_REQUIRED', 'A confirmed terminal snapshot must be committed before releasing ownership.');
      // Removal precedes clearing the registry claim; a crash leaves conservative exclusion.
      await unlink(join(this.taskDirectory(taskId), 'lease.lock'));
      entry.lease = null; this.owned.get(taskId).lease = null;
      return { commit: true, value: { released: true } };
    });
  }

  async requestCancel(taskId, { controlToken } = {}) {
    return this.transaction(async registry => {
      const entry = await this.authorized(registry, taskId, controlToken);
      if (!entry.lease) {
        const record = await this.snapshot(registry, taskId);
        return { commit: false, value: { requested: false, attempt: record.attempts.at(-1).number } };
      }
      await directory(this.taskDirectory(taskId));
      const dir = join(this.taskDirectory(taskId), 'cancel-requests'); await directory(dir, true);
      const path = join(dir, `${entry.lease.nonce}.json`);
      const request = { protocol: 3, storeId: registry.storeId, taskId, attempt: entry.lease.attempt, leaseNonce: entry.lease.nonce };
      try { await this.writer(path, JSON.stringify(request), { immutable: true }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; invalid(JSON.stringify(await json(path)) === JSON.stringify(request)); }
      return { commit: false, value: { requested: true, attempt: entry.lease.attempt } };
    });
  }

  async cancellationRequested(taskId) {
    const registry = await this.registry();
    requireValue(registry, 'TASK_NOT_FOUND', 'No concurrent task store exists.');
    const entry = await this.ownLease(registry, taskId);
    await directory(this.taskDirectory(taskId));
    try { await directory(join(this.taskDirectory(taskId), 'cancel-requests')); }
    catch (error) { if (missing(error)) return false; throw error; }
    let request;
    try { request = await json(join(this.taskDirectory(taskId), 'cancel-requests', `${entry.lease.nonce}.json`)); }
    catch (error) { if (missing(error)) return false; throw error; }
    invalid(request.protocol === 3 && request.storeId === registry.storeId && request.taskId === taskId
      && request.attempt === entry.lease.attempt && request.leaseNonce === entry.lease.nonce);
    return true;
  }
}
