import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BridgeError, boundedInteger, requireValue } from './errors.js';
import { resolveProfile } from './capabilities.js';
import { allocateStage, budgetSummary, runOrchestrated, validateSavedBudget } from './orchestration.js';
import { planExecution } from './planning.js';
import { assessDelivery, assessOutput, deliveryPrompt, formatPrompt, normalizeOutputFormat, normalizeReviewContract } from './delivery.js';
import { assessReport, normalizeReportContract, reportPrompt } from './report.js';
import { assessLifecycle, lifecyclePrompt, normalizeLifecycleContract } from './lifecycle.js';
import { summarizeUsage } from './usage.js';
import { optionalLimit, minimumLimit, deadlineAfter, deadlineTimer } from './limits.js';

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

function validateSavedAttempts(attempts) {
  requireValue(Array.isArray(attempts) && attempts.length >= 1,
    'INVALID_STATE', 'Saved tasks must contain at least one attempt.');
  const requests = new Set();
  for (const [index, attempt] of attempts.entries()) {
    requireValue(attempt && typeof attempt === 'object' && !Array.isArray(attempt) &&
      attempt.number === index + 1 && typeof attempt.requestId === 'string' && ID.test(attempt.requestId) &&
      !requests.has(attempt.requestId) && typeof attempt.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(attempt.fingerprint) &&
      typeof attempt.startedAt === 'string' && Number.isFinite(Date.parse(attempt.startedAt)) &&
      ['running', 'cancelling', 'completed', 'paused', 'failed', 'cancelled', 'timed_out', 'cleanup_failed', 'interrupted', 'state_write_failed'].includes(attempt.status) &&
      ['pending', 'confirmed', 'unverified'].includes(attempt.cleanup),
    'INVALID_STATE', 'The saved attempt identity or lifecycle fields are invalid.');
    requests.add(attempt.requestId);
  }
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
        let record;
        try { record = JSON.parse(await readFile(join(this.tasksDir, entry.name, 'task.json'), 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // Only an empty, unpublished directory is provably safe to remove.
          await rmdir(join(this.tasksDir, entry.name));
          continue;
        }
        requireValue(record && record.schemaVersion === 1 && record.taskId === entry.name, 'INVALID_STATE', 'The saved task record is invalid.');
        validateSavedAttempts(record.attempts);
        requireValue(record.planning?.executionMode === 'single-request' ? record.attempts.length === 1
          : record.planning?.limitsPolicy === 'explicit-v2' || record.attempts.length <= 16,
        'INVALID_STATE', 'Saved attempts exceed the task creation contract.');
        validateSavedBudget(record);
        if (record.reviewContract) normalizeReviewContract(record.reviewContract);
        if (record.reportContract) normalizeReportContract(record.reportContract);
        if (record.lifecycleContract !== undefined) normalizeLifecycleContract(record.lifecycleContract);
        requireValue([record.reportContract, record.reviewContract, record.lifecycleContract].filter(Boolean).length <= 1, 'INVALID_STATE', 'Conflicting saved delivery contracts.');
        normalizeOutputFormat(record.outputFormat, record.reviewContract, record.reportContract, record.lifecycleContract);
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

  submit(input, beforeLaunch = () => {}) {
    return this.serialize(async () => {
      const prompt = inputPrompt(input.prompt);
      const id = requestId(input.requestId);
      const workspace = await this.workspace(input.workspace);
      const access = input.access ?? 'read-only';
      const previous = this.requests.get(id);
      const legacy = previous && !this.records.get(previous.taskId).planning && input.executionMode === undefined && input.workload === undefined && input.reviewContract === undefined && input.reportContract === undefined && input.lifecycleContract === undefined && input.outputFormat === undefined;
      const compatibilityV1 = !!previous && this.records.get(previous.taskId).planning?.limitsPolicy !== 'explicit-v2';
      const planned = planExecution(input, { legacy: !!legacy, compatibilityV1 });
      const { effort, maxTokens, maxToolCalls, maxModelRequests, budget } = planned;
      requireValue(['read-only', 'workspace-write'].includes(access), 'INVALID_ARGUMENT', 'access must be read-only or workspace-write.');
      const timeoutMs = compatibilityV1 ? boundedInteger(input.timeoutMs, 300000, 1000, 1800000, 'timeoutMs') : optionalLimit(input.timeoutMs, 'timeoutMs');
      const maxRequestBytes = compatibilityV1 ? boundedInteger(input.maxRequestBytes, 262144, 1024, 1048576, 'maxRequestBytes') : optionalLimit(input.maxRequestBytes, 'maxRequestBytes');
      const profile = await this.resolveCapabilities(planned.capabilityProfile, undefined, { workspace, requestedWorkspace: input.workspace, access, nativePlugins: input.nativePlugins });
      requireValue(access === 'workspace-write' || profile.access === 'read-only', 'PROFILE_ACCESS', 'This capability profile requires workspace-write access.');
      const capabilityProfile = profile.id;
      const capabilityDigest = profile.digest;
      const planning = { executionMode: planned.executionMode, workload: planned.workload, warnings: planned.warnings, limitsPolicy: 'explicit-v2' };
      const fingerprint = hash({ prompt, workspace, access, effort, timeoutMs, maxTokens, maxToolCalls, maxModelRequests, maxRequestBytes, capabilityProfile, capabilityDigest, ...(budget ? { budget } : {}), ...(!legacy ? { executionMode: planned.executionMode, workload: planned.workload } : {}), ...(planned.reviewContract ? { reviewContract: planned.reviewContract } : {}), ...(planned.reportContract ? { reportContract: planned.reportContract } : {}), ...(planned.lifecycleContract ? { lifecycleContract: planned.lifecycleContract } : {}), ...(input.outputFormat !== undefined ? { outputFormat: planned.outputFormat } : {}) });
      const existing = this.existing(id, fingerprint);
      if (existing) return existing;
      this.assertAvailable();
      await beforeLaunch();
      requireValue(this.records.size < 1000, 'STORE_LIMIT', 'The bridge has reached its 1000-task retention limit; archive old state while stopped.');
      const record = { schemaVersion: 1, taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace,
        route: { provider: 'deepseek-official', model: 'deepseek-flash', effort }, access, maxTokens, maxToolCalls,
        maxModelRequests, maxRequestBytes, capabilityProfile, capabilityDigest,
        createdAt: new Date().toISOString(), planning, attempts: [] };
      if (input.nativePlugins !== undefined) record.nativePlugins = input.nativePlugins;
      if (planned.reviewContract) record.reviewContract = planned.reviewContract;
      if (planned.reportContract) record.reportContract = planned.reportContract;
      if (planned.lifecycleContract) record.lifecycleContract = planned.lifecycleContract;
      if (input.outputFormat !== undefined) record.outputFormat = planned.outputFormat;
      if (budget) record.orchestration = { authorized: budget, assignment: prompt, deadlineAt: deadlineAfter(budget.totalDurationMs, Date.parse(record.createdAt)), stages: [], recoveryPolicy: 'bounded-v1' };
      await mkdir(join(this.tasksDir, record.taskId), { mode: 0o700 });
      try { return await this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: false }); }
      catch (error) {
        try { await rmdir(join(this.tasksDir, record.taskId)); }
        catch { this.blocked = true; }
        throw error;
      }
    });
  }

  continue(input, beforeLaunch = () => {}) {
    return this.serialize(async () => {
      const record = this.record(input.taskId);
      const prompt = inputPrompt(input.prompt);
      const id = requestId(input.requestId);
      const previous = this.requests.get(id);
      // Replay uses the authorization that existed before that attempt, not a
      // later continuation's narrower timeout. Its fingerprint stays stable.
      const predecessor = previous?.taskId === record.taskId && previous.attempt > 1
        ? record.attempts[previous.attempt - 2] : record.attempts.at(-1);
      const timeoutMs = record.planning?.limitsPolicy === 'explicit-v2'
        ? minimumLimit(predecessor.timeoutMs, optionalLimit(input.timeoutMs, 'timeoutMs'))
        : boundedInteger(input.timeoutMs, 300000, 1000, 1800000, 'timeoutMs');
      const fingerprint = hash({ taskId: record.taskId, prompt, timeoutMs });
      const existing = this.existing(id, fingerprint);
      if (existing) return existing;
      this.assertAvailable();
      requireValue(record.planning?.executionMode !== 'single-request', 'NOT_RESUMABLE', 'A single-request authorization is spent; continuing requires a new explicitly authorized task.');
      if (record.planning?.limitsPolicy !== 'explicit-v2') requireValue(record.attempts.length < 16, 'ATTEMPT_LIMIT', 'This legacy task was created with a 16-attempt limit.');
      requireValue(record.attempts.at(-1).status === 'completed' || (record.orchestration && record.attempts.at(-1).status === 'paused'), 'NOT_RESUMABLE', 'Only a completed or safely paused orchestrated task can continue; failed execution needs explicit recovery.');
      if (record.orchestration) allocateStage(record, timeoutMs);
      requireValue(await this.workspace(record.workspace) === record.workspace, 'WORKSPACE_CHANGED', 'The task workspace identity changed.');
      await beforeLaunch();
      return this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: true });
    });
  }

  async begin(record, { id, fingerprint, prompt, timeoutMs, resume }) {
    const attempt = { number: record.attempts.length + 1, requestId: id, fingerprint, status: 'running',
      startedAt: new Date().toISOString(), timeoutMs, cleanup: 'pending', terminal: null };
    try { await this.persist({ ...record, attempts: [...record.attempts, attempt] }); }
    catch { this.blocked = true; throw new BridgeError('STATE_WRITE_FAILED', 'Task state could not be saved; no worker was launched.'); }
    record.attempts.push(attempt);
    this.records.set(record.taskId, record);
    this.requests.set(id, { taskId: record.taskId, attempt: attempt.number, fingerprint });
    const controller = new AbortController();
    const active = { taskId: record.taskId, controller, reason: null, promise: null };
    this.active = active;
    const receipt = this.summary(record, attempt);
    active.promise = this.execute(record, attempt, prompt, resume, active);
    return receipt;
  }

  async execute(record, attempt, prompt, resume, active) {
    const duration = record.orchestration ? record.orchestration.deadlineAt == null ? null : Math.max(1, record.orchestration.deadlineAt - Date.now()) : attempt.timeoutMs;
    const cancelTimer = deadlineTimer(() => { active.reason ??= 'timed_out'; active.controller.abort(); }, duration);
    const finished = clone(attempt);
    try {
      let output;
      try {
        const home = join(this.tasksDir, record.taskId, 'harness');
        const runner = args => {
          const orchestrated = !!record.orchestration;
          let deliverable = reportPrompt(args.prompt, record.reportContract, orchestrated);
          deliverable = deliveryPrompt(deliverable, record.reviewContract, orchestrated);
          deliverable = lifecyclePrompt(deliverable, record.lifecycleContract, orchestrated);
          return this.runner({ ...args, prompt: formatPrompt(deliverable, normalizeOutputFormat(record.outputFormat, record.reviewContract, record.reportContract, record.lifecycleContract), orchestrated) });
        };
        output = record.orchestration ? await runOrchestrated({ record, attempt, prompt, signal: active.controller.signal, home, runner,
          persist: () => this.persist(record), saveCheckpoint: async (number, text) => {
            const path = join(this.tasksDir, record.taskId, `checkpoint-${number}.json`);
            await atomicWrite(path, text);
            return path;
          }, savePartial: async (number, partial) => {
            const path = join(this.tasksDir, record.taskId, `partial-${number}.json`);
            await atomicWrite(path, JSON.stringify(partial));
            return path;
          } }) : await runner({ task: clone(record), prompt, resume, signal: active.controller.signal, home });
      } catch (error) {
        if (record.orchestration) throw error;
        output = { terminal: 'error', text: '', cleanup: 'unverified', error: { code: 'RUNNER_FAILED', message: 'Worker execution failed without a confirmed cleanup receipt.' } };
      }
      cancelTimer();
      finished.cleanup = output.cleanup === 'confirmed' ? 'confirmed' : 'unverified';
      finished.terminal = output.terminal ?? 'unknown';
      finished.toolCalls = output.toolCalls ?? null;
      finished.budget = output.budget ?? null;
      if (output.capabilities) finished.capabilities = output.capabilities;
      finished.error = output.error ?? null;
      finished.output = output.output ?? { kind: output.text?.trim() ? (output.terminal === 'completed' ? 'complete_text' : 'partial_text') : 'empty', modelTruncated: output.terminal === 'max-tokens', reasoningObserved: false };
      if (output.recovery) finished.recovery = output.recovery;
      finished.status = active.reason ?? (['completed', 'paused'].includes(finished.terminal) ? finished.terminal : 'failed');
      if (output.pauseReason) finished.pauseReason = output.pauseReason;
      const bytes = Buffer.from(typeof output.text === 'string' ? output.text : '', 'utf8');
      finished.outputTruncated = output.output?.storageTruncated === true || bytes.length > MAX_RESULT_BYTES;
      finished.output.storageTruncated = finished.outputTruncated;
      const text = bytes.subarray(0, MAX_RESULT_BYTES).toString('utf8');
      if (finished.outputTruncated && finished.status === 'completed') finished.status = 'failed';
      if (finished.outputTruncated && finished.output.kind === 'complete_text') finished.output.kind = 'partial_text';
      if (finished.cleanup !== 'confirmed') { finished.status = 'cleanup_failed'; this.blocked = true; }
      finished.outputValidation = assessOutput(text, normalizeOutputFormat(record.outputFormat, record.reviewContract, record.reportContract, record.lifecycleContract), { status: finished.status, orchestrated: !!record.orchestration });
      finished.deliveryValidation = assessDelivery(text, record.reviewContract, { status: finished.status, orchestrated: !!record.orchestration });
      finished.reportValidation = assessReport(text, record.reportContract, { status: finished.status, orchestrated: !!record.orchestration });
      finished.lifecycleValidation = assessLifecycle(text, record.lifecycleContract, { status: finished.status, orchestrated: !!record.orchestration });
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
      cancelTimer();
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
      maxModelRequests: Object.hasOwn(record, 'maxModelRequests') ? record.maxModelRequests : 16, maxRequestBytes: Object.hasOwn(record, 'maxRequestBytes') ? record.maxRequestBytes : 262144,
      capabilityProfile: record.capabilityProfile || 'files', capabilityDigest: record.capabilityDigest ?? null,
      ...(record.nativePlugins ? { nativePlugins: record.nativePlugins } : {}),
      planning: record.planning ?? { executionMode: 'legacy' },
      ...(record.outputFormat !== undefined ? { outputFormat: record.outputFormat } : {}),
      ...(record.reviewContract ? { reviewContract: record.reviewContract } : {}),
      ...(record.reportContract ? { reportContract: record.reportContract } : {}),
      ...(record.lifecycleContract ? { lifecycleContract: record.lifecycleContract } : {}),
      ...(record.orchestration ? { orchestration: budgetSummary(record.orchestration) } : {}),
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

  usage({ taskId } = {}) {
    const records = taskId ? [this.record(taskId)] : [...this.records.values()];
    return { ...summarizeUsage(records), activeTaskId: this.active?.taskId ?? null, blocked: this.blocked };
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
