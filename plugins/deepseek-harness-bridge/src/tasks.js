import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BridgeError, boundedInteger, requireValue } from './errors.js';
import { resolveProfile } from './capabilities.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const MAX_RESULT_BYTES = 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const inside = (root, child) => { const p = relative(root, child); return p === '' || (!p.startsWith(`..${sep}`) && p !== '..' && !isAbsolute(p)); };

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function inputPrompt(value) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 65536,
    'INVALID_ARGUMENT', 'prompt must be nonempty and at most 64 KiB.');
  return value;
}

function requestId(value) {
  requireValue(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', 'requestId must contain 1–80 letters, digits, dots, underscores or hyphens.');
  return value;
}

export class TaskManager {
  constructor({ dataDir, runner, resolveCapabilities = resolveProfile }) {
    this.dataDir = dataDir;
    this.runner = runner;
    this.resolveCapabilities = resolveCapabilities;
    this.records = new Map();
    this.requests = new Map();
    this.active = null;
    this.blocked = false;
    this.closed = false;
    this.mutations = Promise.resolve();
  }

  async open() {
    requireValue(isAbsolute(this.dataDir), 'INVALID_CONFIG', 'The bridge data directory must be absolute.');
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = await realpath(this.dataDir);
    try { this.lock = await open(join(this.dataDir, 'owner.lock'), 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new BridgeError('STATE_LOCKED', 'Another bridge owns this data directory, or a previous exit needs operator reconciliation. The lock is never stolen automatically.');
      throw error;
    }
    try {
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() }));
      this.tasksDir = join(this.dataDir, 'tasks');
      await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(this.tasksDir, { withFileTypes: true })) {
        requireValue(entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name), 'INVALID_STATE', 'Unexpected task entry in bridge state.');
        const record = JSON.parse(await readFile(join(this.tasksDir, entry.name, 'task.json'), 'utf8'));
        requireValue(record.schemaVersion === 1 && record.taskId === entry.name && Array.isArray(record.attempts), 'INVALID_STATE', 'The saved task record is invalid.');
        this.records.set(record.taskId, record);
        for (const attempt of record.attempts) {
          requireValue(!this.requests.has(attempt.requestId), 'INVALID_STATE', 'Duplicate request ID in saved state.');
          this.requests.set(attempt.requestId, { taskId: record.taskId, attempt: attempt.number, fingerprint: attempt.fingerprint });
          if (['running', 'cancelling'].includes(attempt.status)) {
            attempt.status = 'interrupted';
            attempt.cleanup = 'unverified';
            this.blocked = true;
            await this.persist(record);
          }
          if (attempt.cleanup === 'unverified') this.blocked = true;
        }
      }
    } catch {
      this.blocked = true;
      await this.lock.close();
      this.lock = null;
      throw new BridgeError('INVALID_STATE', 'Cannot safely load the saved state; the ownership lock is retained for operator reconciliation.');
    }
    return this;
  }

  serialize(operation) {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  async workspace(value) {
    requireValue(typeof value === 'string' && isAbsolute(value), 'INVALID_ARGUMENT', 'workspace must be an absolute existing directory.');
    let resolved;
    try { resolved = await realpath(value); requireValue((await stat(resolved)).isDirectory(), 'INVALID_ARGUMENT', 'workspace must be a directory.'); }
    catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('INVALID_ARGUMENT', 'workspace is not an accessible directory.'); }
    requireValue(!inside(resolved, this.dataDir) && !inside(this.dataDir, resolved), 'INVALID_ARGUMENT', 'Task workspace and bridge state must not contain one another.');
    return resolved;
  }

  assertAvailable() {
    requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
    requireValue(!this.blocked, 'RECOVERY_REQUIRED', 'Previous cleanup or state persistence is unverified. Reconcile it before starting work.');
    requireValue(!this.active, 'BUSY', 'One Flash worker is already active. Wait or cancel it before submitting another task.');
  }

  existing(id, fingerprint) {
    const receipt = this.requests.get(id);
    if (!receipt) return null;
    requireValue(receipt.fingerprint === fingerprint, 'REQUEST_CONFLICT', 'This requestId was already used for different input.');
    return { ...this.status({ taskId: receipt.taskId, attempt: receipt.attempt }), duplicate: true };
  }

  submit(input) {
    return this.serialize(async () => {
      const prompt = inputPrompt(input.prompt);
      const id = requestId(input.requestId);
      const workspace = await this.workspace(input.workspace);
      const access = input.access ?? 'read-only';
      const effort = input.effort ?? 'high';
      requireValue(['read-only', 'workspace-write'].includes(access), 'INVALID_ARGUMENT', 'access must be read-only or workspace-write.');
      requireValue(['high', 'max'].includes(effort), 'INVALID_ARGUMENT', 'effort must be high or max.');
      const timeoutMs = boundedInteger(input.timeoutMs, 300000, 1000, 1800000, 'timeoutMs');
      const maxTokens = boundedInteger(input.maxTokens, 8192, 256, 32768, 'maxTokens');
      const maxToolCalls = boundedInteger(input.maxToolCalls, 32, 0, 128, 'maxToolCalls');
      const maxModelRequests = boundedInteger(input.maxModelRequests, 16, 1, 128, 'maxModelRequests');
      const maxRequestBytes = boundedInteger(input.maxRequestBytes, 262144, 1024, 1048576, 'maxRequestBytes');
      const profile = await this.resolveCapabilities(input.capabilityProfile || 'files');
      requireValue(access === 'workspace-write' || profile.access === 'read-only', 'PROFILE_ACCESS', 'This capability profile requires workspace-write access.');
      const capabilityProfile = profile.id;
      const capabilityDigest = profile.digest;
      const fingerprint = hash({ prompt, workspace, access, effort, timeoutMs, maxTokens, maxToolCalls, maxModelRequests, maxRequestBytes, capabilityProfile, capabilityDigest });
      const existing = this.existing(id, fingerprint);
      if (existing) return existing;
      this.assertAvailable();
      requireValue(this.records.size < 1000, 'STORE_LIMIT', 'The bridge has reached its 1000-task retention limit; archive old state while stopped.');
      const record = { schemaVersion: 1, taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace,
        route: { provider: 'deepseek-official', model: 'deepseek-flash', effort }, access, maxTokens, maxToolCalls,
        maxModelRequests, maxRequestBytes, capabilityProfile, capabilityDigest,
        createdAt: new Date().toISOString(), attempts: [] };
      await mkdir(join(this.tasksDir, record.taskId), { mode: 0o700 });
      this.records.set(record.taskId, record);
      return this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: false });
    });
  }

  continue(input) {
    return this.serialize(async () => {
      const record = this.record(input.taskId);
      const prompt = inputPrompt(input.prompt);
      const id = requestId(input.requestId);
      const timeoutMs = boundedInteger(input.timeoutMs, 300000, 1000, 1800000, 'timeoutMs');
      const fingerprint = hash({ taskId: record.taskId, prompt, timeoutMs });
      const existing = this.existing(id, fingerprint);
      if (existing) return existing;
      this.assertAvailable();
      requireValue(record.attempts.length < 16, 'ATTEMPT_LIMIT', 'A task supports at most 16 attempts.');
      requireValue(record.attempts.at(-1).status === 'completed', 'NOT_RESUMABLE', 'Only a completed task can be continued; interrupted or failed execution needs a new task with explicit context.');
      requireValue(await this.workspace(record.workspace) === record.workspace, 'WORKSPACE_CHANGED', 'The task workspace identity changed.');
      return this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: true });
    });
  }

  async begin(record, { id, fingerprint, prompt, timeoutMs, resume }) {
    const attempt = { number: record.attempts.length + 1, requestId: id, fingerprint, status: 'running',
      startedAt: new Date().toISOString(), timeoutMs, cleanup: 'pending', terminal: null };
    record.attempts.push(attempt);
    this.requests.set(id, { taskId: record.taskId, attempt: attempt.number, fingerprint });
    try { await this.persist(record); }
    catch { this.blocked = true; throw new BridgeError('STATE_WRITE_FAILED', 'Task state could not be saved; no worker was launched.'); }
    const controller = new AbortController();
    const active = { taskId: record.taskId, controller, reason: null, promise: null };
    this.active = active;
    const receipt = this.summary(record, attempt);
    active.promise = this.execute(record, attempt, prompt, resume, active);
    return receipt;
  }

  async execute(record, attempt, prompt, resume, active) {
    const timer = setTimeout(() => { active.reason ??= 'timed_out'; active.controller.abort(); }, attempt.timeoutMs);
    const finished = clone(attempt);
    try {
      let output;
      try {
        output = await this.runner({ task: clone(record), prompt, resume, signal: active.controller.signal,
          home: join(this.tasksDir, record.taskId, 'harness') });
      } catch { output = { terminal: 'error', text: '', cleanup: 'unverified', error: { code: 'RUNNER_FAILED', message: 'Worker execution failed without a confirmed cleanup receipt.' } }; }
      clearTimeout(timer);
      finished.cleanup = output.cleanup === 'confirmed' ? 'confirmed' : 'unverified';
      finished.terminal = output.terminal ?? 'unknown';
      finished.toolCalls = output.toolCalls ?? null;
      finished.budget = output.budget ?? null;
      finished.error = output.error ?? null;
      finished.status = active.reason ?? (finished.terminal === 'completed' ? 'completed' : 'failed');
      const bytes = Buffer.from(typeof output.text === 'string' ? output.text : '', 'utf8');
      finished.outputTruncated = bytes.length > MAX_RESULT_BYTES;
      const text = bytes.subarray(0, MAX_RESULT_BYTES).toString('utf8');
      if (finished.outputTruncated && finished.status === 'completed') finished.status = 'failed';
      if (finished.cleanup !== 'confirmed') { finished.status = 'cleanup_failed'; this.blocked = true; }
      await this.saveResult(record, finished, text);
      finished.outputBytes = Buffer.byteLength(text);
      finished.finishedAt = new Date().toISOString();
      await this.persist({ ...record, attempts: record.attempts.map(value => value === attempt ? finished : value) });
      // Readers see a terminal state only after both complete files are published.
      Object.assign(attempt, finished);
    } catch {
      this.blocked = true;
      Object.assign(attempt, finished);
      attempt.status = 'state_write_failed';
      attempt.error = { code: 'STATE_WRITE_FAILED', message: 'The result could not be saved. Ownership is retained for reconciliation.' };
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.active = null;
    }
    return this.summary(record, attempt);
  }

  record(taskId) {
    const record = this.records.get(taskId);
    requireValue(record, 'TASK_NOT_FOUND', 'No task with that ID exists in this bridge state.');
    return record;
  }

  summary(record, attempt) {
    const { fingerprint, ...publicAttempt } = attempt;
    return clone({ taskId: record.taskId, sessionId: record.sessionId, route: record.route, workspace: record.workspace,
      access: record.access, maxTokensPerRequest: record.maxTokens, maxToolCalls: record.maxToolCalls,
      maxModelRequests: record.maxModelRequests ?? 16, maxRequestBytes: record.maxRequestBytes ?? 262144,
      capabilityProfile: record.capabilityProfile || 'files', capabilityDigest: record.capabilityDigest ?? null,
      ...publicAttempt, parentAcceptance: 'not_assessed' });
  }

  status({ taskId, attempt }) {
    const record = this.record(taskId);
    const number = boundedInteger(attempt, record.attempts.length, 1, record.attempts.length, 'attempt');
    return this.summary(record, record.attempts[number - 1]);
  }

  list() {
    const recent = [...this.records.values()].sort((a, b) =>
      b.attempts.at(-1).startedAt.localeCompare(a.attempts.at(-1).startedAt) || b.taskId.localeCompare(a.taskId));
    return { tasks: recent.slice(0, 50).map(record => this.summary(record, record.attempts.at(-1))),
      total: this.records.size, blocked: this.blocked, activeTaskId: this.active?.taskId ?? null };
  }

  async wait({ taskId, timeoutMs = 10000 }) {
    boundedInteger(timeoutMs, 10000, 0, 30000, 'timeoutMs');
    this.record(taskId);
    if (this.active?.taskId === taskId && timeoutMs > 0) {
      let timer;
      try { await Promise.race([this.active.promise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
    }
    return this.status({ taskId });
  }

  async result({ taskId, attempt, offset = 0, limit = 16000 }) {
    const status = this.status({ taskId, attempt });
    requireValue(!['running', 'cancelling'].includes(status.status), 'NOT_FINISHED', 'The task is still running.');
    boundedInteger(offset, 0, 0, MAX_RESULT_BYTES, 'offset');
    boundedInteger(limit, 16000, 1, 32000, 'limit');
    let text;
    try { text = await readFile(join(this.tasksDir, taskId, `result-${status.number}.txt`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { ...status, text: '', resultAvailable: false }; throw error; }
    return { ...status, text: text.slice(offset, offset + limit), resultAvailable: true, offset,
      nextOffset: offset + limit < text.length ? offset + limit : null };
  }

  async cancel({ taskId }) {
    await this.mutations;
    this.record(taskId);
    if (this.active?.taskId === taskId) {
      const active = this.active;
      active.reason ??= 'cancelled';
      active.controller.abort();
      await active.promise;
    }
    return this.status({ taskId });
  }

  saveResult(record, attempt, text) { return atomicWrite(join(this.tasksDir, record.taskId, `result-${attempt.number}.txt`), text); }

  persist(record) { return atomicWrite(join(this.tasksDir, record.taskId, 'task.json'), `${JSON.stringify(record, null, 2)}\n`); }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.mutations;
      if (this.active) await this.cancel({ taskId: this.active.taskId });
      if (this.lock) {
        await this.lock.close();
        this.lock = null;
        if (!this.blocked) await unlink(join(this.dataDir, 'owner.lock'));
      }
    })();
    return this.closePromise;
  }
}
