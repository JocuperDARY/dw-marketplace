import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BridgeError, boundedInteger, requireValue } from './errors.js';
import { resolveProfile } from './capabilities.js';
import { allocateStage, budgetSummary, runOrchestrated, validateSavedBudget } from './orchestration.js';
import { canonicalStatePath, inputPrompt, requestId, resolveWorkspace, normalizeSubmission, previewSubmission } from './submission-plan.js';
import { assessDelivery, assessOutput, deliveryPrompt, formatPrompt, normalizeOutputFormat, normalizeReviewContract } from './delivery.js';
import { assessReport, normalizeReportContract, reportPrompt } from './report.js';
import { assessLifecycle, lifecyclePrompt, normalizeLifecycleContract } from './lifecycle.js';
import { summarizeUsage } from './usage.js';
import { optionalLimit, minimumLimit, deadlineAfter, deadlineTimer } from './limits.js';
import { ConcurrentStore, atomicWrite } from './concurrent-store.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const MAX_RESULT_BYTES = 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
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

function validateSavedRecord(record) {
  try {
    validateSavedAttempts(record.attempts);
    requireValue(record.planning?.executionMode === 'single-request' ? record.attempts.length === 1
      : record.planning?.limitsPolicy === 'explicit-v2' || record.attempts.length <= 16,
    'INVALID_STATE', 'Saved attempts exceed the task creation contract.');
    validateSavedBudget(record);
    if (record.reviewContract) normalizeReviewContract(record.reviewContract);
    if (record.reportContract) normalizeReportContract(record.reportContract);
    if (record.lifecycleContract !== undefined) normalizeLifecycleContract(record.lifecycleContract);
    requireValue([record.reportContract, record.reviewContract, record.lifecycleContract].filter(Boolean).length <= 1,
      'INVALID_STATE', 'Conflicting saved delivery contracts.');
    normalizeOutputFormat(record.outputFormat, record.reviewContract, record.reportContract, record.lifecycleContract);
  } catch {
    throw new BridgeError('INVALID_STATE', 'A saved task violates its lifecycle, delivery or budget contract; reconcile the saved state before writing.');
  }
}

export class TaskManager {
  constructor({ dataDir, runner, resolveCapabilities = resolveProfile, ownerId }) {
    this.dataDir = dataDir;
    this.runner = runner;
    this.resolveCapabilities = resolveCapabilities;
    this.records = new Map();
    this.requests = new Map();
    this.store = new ConcurrentStore({ dataDir, ownerId });
    this.dataDir = this.store.dataDir;
    this.active = new Map();
    this.localFailures = new Map();
    this.ownedTaskIds = new Set();
    this.blocked = false;
    this.closed = false;
    this.mutations = Promise.resolve();
  }

  async open() {
    requireValue(isAbsolute(this.dataDir), 'INVALID_CONFIG', 'The bridge data directory must be absolute.');
    this.dataDir = await canonicalStatePath(this.dataDir);
    this.tasksDir = join(this.dataDir, 'tasks-v3');
    await this.refresh();
    return this;
  }

  async refresh() {
    const snapshot = await this.store.read();
    const records = [...snapshot.records, ...snapshot.legacyRecords];
    const loaded = new Map();
    for (const record of records) {
      validateSavedRecord(record);
      loaded.set(record.taskId, record);
    }
    this.records = loaded;
    this.requests = new Map(Object.entries(snapshot.requests));
    this.snapshot = snapshot;
    return snapshot;
  }

  serialize(operation) {
    const pending = this.mutations.then(operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  workspace(value) { return resolveWorkspace(value, this.dataDir); }

  plan(input) {
    this.assertAvailable();
    return previewSubmission(input, { dataDir: this.dataDir, resolveCapabilities: this.resolveCapabilities });
  }

  assertAvailable() {
    requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
  }

  existing(id, fingerprint) {
    const receipt = this.requests.get(id);
    if (!receipt) return null;
    requireValue(receipt.fingerprint === fingerprint, 'REQUEST_CONFLICT', 'This requestId was already used for different input.');
    const record = this.records.get(receipt.taskId);
    return { ...this.observedSummary(record, record.attempts[receipt.attempt - 1]), duplicate: true };
  }

  submit(input, beforeLaunch = () => {}) {
    return this.serialize(async () => {
      this.assertAvailable();
      await this.refresh();
      const prompt = inputPrompt(input.prompt);
      const id = requestId(input.requestId);
      const workspace = await this.workspace(input.workspace);
      const previous = this.requests.get(id);
      const legacy = previous && !this.records.get(previous.taskId).planning && input.executionMode === undefined && input.workload === undefined && input.reviewContract === undefined && input.reportContract === undefined && input.lifecycleContract === undefined && input.outputFormat === undefined;
      const compatibilityV1 = !!previous && this.records.get(previous.taskId).planning?.limitsPolicy !== 'explicit-v2';
      const { planned, access, timeoutMs, maxRequestBytes } = normalizeSubmission(input, { legacy: !!legacy, compatibilityV1, validateDeadlines: !previous });
      const { effort, maxTokens, maxToolCalls, maxModelRequests, budget } = planned;
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
      const record = { schemaVersion: 3, taskId: randomUUID(), sessionId: `bridge-${randomUUID()}`, workspace,
        route: { provider: 'deepseek-official', model: 'deepseek-flash', effort }, access, maxTokens, maxToolCalls,
        maxModelRequests, maxRequestBytes, capabilityProfile, capabilityDigest,
        createdAt: new Date().toISOString(), planning, attempts: [] };
      if (input.nativePlugins !== undefined) record.nativePlugins = input.nativePlugins;
      if (input.parentLabel !== undefined) record.parentLabel = input.parentLabel;
      if (planned.reviewContract) record.reviewContract = planned.reviewContract;
      if (planned.reportContract) record.reportContract = planned.reportContract;
      if (planned.lifecycleContract) record.lifecycleContract = planned.lifecycleContract;
      if (input.outputFormat !== undefined) record.outputFormat = planned.outputFormat;
      if (budget) record.orchestration = { authorized: budget, assignment: prompt, deadlineAt: deadlineAfter(budget.totalDurationMs, Date.parse(record.createdAt)), stages: [], recoveryPolicy: 'bounded-v1' };
      return this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: false });
    });
  }

  continue(input, beforeLaunch = () => {}) {
    return this.serialize(async () => {
      this.assertAvailable();
      await this.refresh();
      const record = this.cachedRecord(input.taskId);
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
      requireValue(record.schemaVersion === 3, 'LEGACY_TASK_READ_ONLY', 'Historical tasks are read-only; create a new task to authorize new work.');
      await this.store.authorize(record.taskId, input.controlToken);
      requireValue(!['running', 'cancelling'].includes(record.attempts.at(-1).status), 'TASK_BUSY', 'This task already has an active attempt.');
      requireValue(record.planning?.executionMode !== 'single-request', 'NOT_RESUMABLE', 'A single-request authorization is spent; continuing requires a new explicitly authorized task.');
      if (record.planning?.limitsPolicy !== 'explicit-v2') requireValue(record.attempts.length < 16, 'ATTEMPT_LIMIT', 'This legacy task was created with a 16-attempt limit.');
      requireValue(record.attempts.at(-1).status === 'completed' || (record.orchestration && record.attempts.at(-1).status === 'paused'), 'NOT_RESUMABLE', 'Only a completed or safely paused orchestrated task can continue; failed execution needs explicit recovery.');
      if (record.orchestration) allocateStage(record, timeoutMs);
      requireValue(await this.workspace(record.workspace) === record.workspace, 'WORKSPACE_CHANGED', 'The task workspace identity changed.');
      await beforeLaunch();
      return this.begin(record, { id, fingerprint, prompt, timeoutMs, resume: true,
        controlToken: input.controlToken, expectedRevision: this.snapshot.recordRevisions[record.taskId] });
    });
  }

  async begin(record, { id, fingerprint, prompt, timeoutMs, resume, controlToken, expectedRevision }) {
    const attempt = { number: record.attempts.length + 1, requestId: id, fingerprint, status: 'running',
      startedAt: new Date().toISOString(), timeoutMs, cleanup: 'pending', terminal: null };
    let admission;
    try {
      admission = await this.store.admit({ ...record, attempts: [...record.attempts, attempt] },
        { requestId: id, fingerprint, controlToken, expectedRevision });
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('STATE_WRITE_FAILED', 'Task admission could not be committed; no worker was launched. Any retained lease requires reconciliation.');
    }
    if (admission.duplicate) {
      const number = admission.attempt?.number ?? admission.attempt;
      return { ...this.summary(admission.record, admission.record.attempts[(number ?? admission.record.attempts.length) - 1]), duplicate: true };
    }
    record = admission.record;
    const currentAttempt = record.attempts.at(-1);
    this.records.set(record.taskId, record);
    this.requests.set(id, { taskId: record.taskId, attempt: currentAttempt.number, fingerprint });
    this.ownedTaskIds.add(record.taskId);
    const controller = new AbortController();
    const active = { taskId: record.taskId, controller, reason: null, promise: null, polling: false, pollTimer: null };
    this.active.set(record.taskId, active);
    const receipt = { ...this.summary(record, currentAttempt), ...(admission.controlToken ? { controlToken: admission.controlToken } : {}) };
    active.pollTimer = setInterval(() => { void this.pollCancellation(active); }, 50);
    active.promise = this.execute(record, currentAttempt, prompt, resume, active);
    return receipt;
  }

  async pollCancellation(active) {
    if (active.polling || active.controller.signal.aborted || this.active.get(active.taskId) !== active) return;
    active.polling = true;
    try {
      if (await this.store.cancellationRequested(active.taskId)) {
        active.reason ??= 'cancelled';
        active.controller.abort();
      }
    } catch {
      // Losing durable control visibility makes continued execution unsafe. Only
      // this task is stopped; its cleanup and retained lease remain accountable.
      active.reason ??= 'failed';
      active.controller.abort();
    } finally { active.polling = false; }
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
          const task = clone(args.task);
          for (const key of ['controlToken', 'controlTokenHash', 'ownerId', 'ownerConnectionId', 'lease', 'leaseNonce']) delete task[key];
          return this.runner({ ...args, task, prompt: formatPrompt(deliverable, normalizeOutputFormat(record.outputFormat, record.reviewContract, record.reportContract, record.lifecycleContract), orchestrated) });
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
      if (finished.cleanup !== 'confirmed') finished.status = 'cleanup_failed';
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
      if (finished.cleanup === 'confirmed') await this.store.release(record.taskId, { cleanup: 'confirmed' });
    } catch (error) {
      active.failure = error;
      Object.assign(attempt, finished);
      attempt.status = 'state_write_failed';
      attempt.error = { code: 'STATE_WRITE_FAILED', message: 'The result could not be saved. Ownership is retained for reconciliation.',
        ...(typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? { causeCode: error.code } : {}) };
      attempt.finishedAt = new Date().toISOString();
      try { await this.persist(record); }
      catch {
        // A committed running snapshot is preserved when the disk cannot record
        // failure. The executing connection can still report what it knows,
        // explicitly distinguishing its local receipt from durable evidence.
        this.localFailures.set(record.taskId, { record: clone(record), attempt: clone(attempt) });
      }
    } finally {
      cancelTimer();
      clearInterval(active.pollTimer);
      if (this.active.get(record.taskId) === active) this.active.delete(record.taskId);
    }
    return this.summary(record, attempt);
  }

  cachedRecord(taskId) {
    const record = this.records.get(taskId);
    requireValue(record, 'TASK_NOT_FOUND', 'No task with that ID exists in this bridge state.');
    return record;
  }

  async record(taskId) { await this.refresh(); return this.cachedRecord(taskId); }

  observedSummary(record, attempt) {
    const local = this.localFailures.get(record.taskId);
    if (local?.attempt.number === attempt.number) return { ...this.summary(local.record, local.attempt),
      durability: 'unconfirmed', committedStatus: attempt.status };
    const lease = this.snapshot?.leases?.find(value => value.taskId === record.taskId && value.attempt === attempt.number);
    const leasePending = lease && attempt.cleanup === 'confirmed'
      && ['completed', 'paused', 'failed', 'cancelled', 'timed_out'].includes(attempt.status);
    return { ...this.summary(record, attempt), ...(leasePending ? { leasePending: true } : {}) };
  }

  summary(record, attempt) {
    const { fingerprint, ...publicAttempt } = attempt;
    return clone({ taskId: record.taskId, sessionId: record.sessionId, route: record.route, workspace: record.workspace,
      access: record.access, maxTokensPerRequest: record.maxTokens, maxToolCalls: record.maxToolCalls,
      maxModelRequests: Object.hasOwn(record, 'maxModelRequests') ? record.maxModelRequests : 16, maxRequestBytes: Object.hasOwn(record, 'maxRequestBytes') ? record.maxRequestBytes : 262144,
      capabilityProfile: record.capabilityProfile || 'files', capabilityDigest: record.capabilityDigest ?? null,
      ...(record.nativePlugins ? { nativePlugins: record.nativePlugins } : {}),
      ...(record.parentLabel !== undefined ? { parentLabel: record.parentLabel } : {}),
      ...(record.schemaVersion !== 3 ? { readOnly: true } : {}),
      planning: record.planning ?? { executionMode: 'legacy' },
      ...(record.outputFormat !== undefined ? { outputFormat: record.outputFormat } : {}),
      ...(record.reviewContract ? { reviewContract: record.reviewContract } : {}),
      ...(record.reportContract ? { reportContract: record.reportContract } : {}),
      ...(record.lifecycleContract ? { lifecycleContract: record.lifecycleContract } : {}),
      ...(record.orchestration ? { orchestration: budgetSummary(record.orchestration) } : {}),
      ...publicAttempt, parentAcceptance: 'not_assessed' });
  }

  async status({ taskId, attempt }) {
    const record = await this.record(taskId);
    const number = boundedInteger(attempt, record.attempts.length, 1, record.attempts.length, 'attempt');
    return this.observedSummary(record, record.attempts[number - 1]);
  }

  scopedRecords(scope) {
    requireValue(['connection', 'store'].includes(scope), 'INVALID_ARGUMENT', 'scope must be connection or store.');
    return [...this.records.values()].filter(record => scope === 'store' || this.ownedTaskIds.has(record.taskId));
  }

  activeSummary(records) {
    const ids = new Set(records.map(record => record.taskId));
    const activeTaskIds = (this.snapshot.leases ?? []).filter(lease => ids.has(lease.taskId) && !this.localFailures.has(lease.taskId)
      && ['running', 'cancelling'].includes(this.records.get(lease.taskId).attempts.at(-1).status)).map(lease => lease.taskId);
    return { activeTaskIds, activeTaskId: activeTaskIds.length === 1 ? activeTaskIds[0] : null };
  }

  async list({ scope = 'connection' } = {}) {
    await this.refresh();
    const records = this.scopedRecords(scope);
    const recent = records.sort((a, b) =>
      b.attempts.at(-1).startedAt.localeCompare(a.attempts.at(-1).startedAt) || b.taskId.localeCompare(a.taskId));
    return { tasks: recent.slice(0, 50).map(record => this.observedSummary(record, record.attempts.at(-1))),
      total: records.length, blocked: false, ...this.activeSummary(records) };
  }

  async usage({ taskId, scope = 'connection' } = {}) {
    await this.refresh();
    const scoped = this.scopedRecords(scope);
    const records = taskId ? [this.cachedRecord(taskId)] : scoped;
    return { ...summarizeUsage(records), ...this.activeSummary(records), blocked: false };
  }

  async wait({ taskId, attempt, timeoutMs = 10000 }) {
    boundedInteger(timeoutMs, 10000, 0, 30000, 'timeoutMs');
    let status = await this.status({ taskId, attempt });
    const deadline = Date.now() + timeoutMs;
    while ((['running', 'cancelling'].includes(status.status) || status.leasePending) && Date.now() < deadline) {
      const active = this.active.get(taskId);
      let timer;
      try { await Promise.race([...(active ? [active.promise] : []), new Promise(resolve => { timer = setTimeout(resolve, Math.min(50, deadline - Date.now())); })]); }
      finally { clearTimeout(timer); }
      status = await this.status({ taskId, attempt });
    }
    return status;
  }

  async result({ taskId, attempt, offset = 0, limit = 16000 }) {
    const status = await this.status({ taskId, attempt });
    requireValue(!['running', 'cancelling'].includes(status.status), 'NOT_FINISHED', 'The task is still running.');
    boundedInteger(offset, 0, 0, MAX_RESULT_BYTES, 'offset');
    boundedInteger(limit, 16000, 1, 32000, 'limit');
    let text;
    const record = this.cachedRecord(taskId);
    try { text = await readFile(join(this.store.taskDirectory(taskId, { legacy: record.schemaVersion !== 3 }), `result-${status.number}.txt`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { ...status, text: '', resultAvailable: false }; throw error; }
    return { ...status, text: text.slice(offset, offset + limit), resultAvailable: true, offset,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      resultPage: { unit: 'utf16-code-units', totalCharacters: text.length,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex') } };
  }

  async cancel({ taskId, controlToken, timeoutMs = 10000 }) {
    boundedInteger(timeoutMs, 10000, 0, 30000, 'timeoutMs');
    await this.mutations;
    const record = await this.record(taskId);
    requireValue(record.schemaVersion === 3, 'LEGACY_TASK_READ_ONLY', 'Historical tasks are read-only; their owners must reconcile them separately.');
    const receipt = await this.store.requestCancel(taskId, { controlToken });
    const active = this.active.get(taskId);
    if (active && receipt.requested) await this.pollCancellation(active);
    const status = await this.wait({ taskId, attempt: receipt.attempt, timeoutMs });
    return { ...status, ...(receipt.requested && ['running', 'cancelling'].includes(status.status) ? { cancelRequested: true } : {}) };
  }

  saveResult(record, attempt, text) { return atomicWrite(join(this.tasksDir, record.taskId, `result-${attempt.number}.txt`), text); }

  persist(record) { return this.store.persist(record); }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.mutations;
      const owned = [...this.active.values()];
      for (const active of owned) { active.reason ??= 'cancelled'; active.controller.abort(); }
      await Promise.all(owned.map(active => active.promise));
    })();
    return this.closePromise;
  }
}
