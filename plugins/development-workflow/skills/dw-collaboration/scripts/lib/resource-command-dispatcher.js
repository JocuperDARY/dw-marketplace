'use strict';

const { createDetachedJsonSnapshot } = require('./canonical-json');
const { ResourceAwareQueue, validateProfile } = require('./resource-aware-queue');

const PRIVATE = new WeakMap();
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const detached = value => createDetachedJsonSnapshot(value).snapshot;

function observationSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  // Native wait results can carry an Error and optional undefined fields. Keep
  // the explicit receipt fields, not implementation objects or error stacks.
  return detached({ status: value.status ?? null, reason: value.reason ?? null,
    cleanup: value.cleanup ?? null, outputComplete: value.outputComplete === true,
    terminal: value.terminal ?? null, stdout: value.stdout ?? '', stderr: value.stderr ?? '',
    errorCode: value.error ? String(value.error.code || 'HOST_WAIT_FAILED') : null });
}

class ResourceCommandDispatcherError extends Error {
  constructor(code) { super(code); this.name = 'ResourceCommandDispatcherError'; this.code = code; }
}
const fail = code => { throw new ResourceCommandDispatcherError(code); };
const requireEntry = (state, taskId) => state.entries.get(taskId) || fail('DISPATCH_TASK_NOT_FOUND');

// No timers, automatic retries, persistence adoption, or executable selection live here.
// The host owns bounded command execution and the proof needed to close each scope.
class ResourceCommandDispatcher {
  constructor({ host, policy, authorizationResolver } = {}) {
    for (const method of ['prepareCommand', 'startPrepared', 'cancelPrepared', 'closeCommand', 'queueAuthority', 'wait']) {
      if (!host || typeof host[method] !== 'function') fail('DISPATCH_HOST_INVALID');
    }
    const queue = new ResourceAwareQueue({ policy, authorizationResolver, authority: host.queueAuthority() });
    PRIVATE.set(this, { host, queue, entries: new Map(), commands: new Set(), admissionBusy: false, dispatchBusy: false });
  }

  async prepare(profile, command) {
    const state = PRIVATE.get(this);
    if (state.admissionBusy || state.dispatchBusy) fail('DISPATCH_REENTRANT_OPERATION');
    state.admissionBusy = true;
    try {
      const input = detached(profile);
      const request = detached(command);
      if (!input || typeof input.taskId !== 'string' || !input.taskId.trim()
        || !request || typeof request.commandId !== 'string' || !request.commandId.trim()) fail('DISPATCH_INPUT_INVALID');
      if (validateProfile({ ...input, trackedResourceIds: ['preflight'],
        scopeBinding: { ownerId: 'preflight', runId: 'preflight', scopeId: 'preflight', generation: 1 } }).length) {
        fail('DISPATCH_PROFILE_INVALID');
      }
      if (state.entries.has(input.taskId) || state.commands.has(request.commandId)) fail('DISPATCH_DUPLICATE_ID');
      if (state.entries.size >= state.queue.policy.maxTasks) fail('DISPATCH_TASK_LIMIT_REACHED');
      const prepared = await state.host.prepareCommand(request);
      if (!prepared || prepared.status !== 'PREPARED' || prepared.commandId !== request.commandId) {
        fail('DISPATCH_PREPARE_NOT_CONFIRMED');
      }
      const entry = { taskId: input.taskId, commandId: request.commandId, phase: 'PREPARED',
        cancelRequested: false, attempted: false, error: null, closeError: null, observation: null,
        startPromise: null, observePromise: null, closePromise: null, queued: false };
      // Retain ownership before admission: even an invalid profile must close its prepared scope.
      state.entries.set(entry.taskId, entry);
      state.commands.add(entry.commandId);
      try {
        const admitted = state.queue.enqueue({ ...input,
          scopeBinding: prepared.scopeBinding, trackedResourceIds: prepared.resourceIds });
        entry.queued = true;
        if (admitted.state === 'blocked') await this._drain(entry, 'cancelled');
      } catch (error) {
        entry.error = error.code || 'DISPATCH_ADMISSION_FAILED';
        entry.phase = 'DRAINING';
        await this._closeUnqueued(entry);
      }
      return this.snapshot();
    } finally { state.admissionBusy = false; }
  }

  async dispatch(observation) {
    const state = PRIVATE.get(this);
    if (state.dispatchBusy || state.admissionBusy) fail('DISPATCH_REENTRANT_OPERATION');
    state.dispatchBusy = true;
    try {
      const decision = state.queue.schedule(observation);
      let failed = false;
      for (const taskId of decision.start) {
        const entry = requireEntry(state, taskId);
        if (failed || entry.cancelRequested) {
          await this._drain(entry, 'cancelled');
          continue;
        }
        entry.phase = 'STARTING';
        entry.attempted = true;
        entry.startPromise = Promise.resolve().then(() => state.host.startPrepared(entry.commandId));
        try {
          const result = await entry.startPromise;
          if (!result || result.status !== 'STARTED' || result.commandId !== entry.commandId) {
            fail('DISPATCH_START_NOT_CONFIRMED');
          }
          entry.phase = 'RUNNING';
        } catch (error) {
          entry.error = error.code || 'DISPATCH_START_FAILED';
          failed = true;
        } finally { entry.startPromise = null; }
        if (failed || entry.cancelRequested) await this._drain(entry, entry.cancelRequested ? 'cancelled' : 'failed');
      }
      return { decision, ...this.snapshot() };
    } finally { state.dispatchBusy = false; }
  }

  async observe(taskId) {
    const state = PRIVATE.get(this);
    const entry = requireEntry(state, taskId);
    if (entry.observePromise) return entry.observePromise;
    if (TERMINAL.has(entry.phase) || entry.phase === 'DRAINING') return this.snapshot();
    if (entry.phase !== 'RUNNING') fail('DISPATCH_TASK_NOT_RUNNING');
    entry.observePromise = Promise.resolve().then(async () => {
      let outcome = 'failed';
      try {
        const observation = await state.host.wait(entry.commandId);
        // A late wait cannot overwrite cancellation or a proved terminal outcome.
        if (!entry.cancelRequested && entry.phase === 'RUNNING') {
          entry.observation = observationSnapshot(observation);
          outcome = observation && observation.status === 0 && observation.reason === 'child_exit'
            && observation.terminal && !observation.error && observation.outputComplete === true
            && observation.cleanup === 'verified_absent' ? 'completed' : 'failed';
        }
      } catch (error) { entry.error = error.code || 'DISPATCH_OBSERVATION_FAILED'; }
      if (entry.phase === 'RUNNING') await this._drain(entry, entry.cancelRequested ? 'cancelled' : outcome);
      return this.snapshot();
    });
    try { return await entry.observePromise; } finally { entry.observePromise = null; }
  }

  async cancel(taskId) {
    const entry = requireEntry(PRIVATE.get(this), taskId);
    if (TERMINAL.has(entry.phase)) return this.snapshot();
    entry.cancelRequested = true;
    if (entry.startPromise) { try { await entry.startPromise; } catch (_) { /* Close must reconcile any partial start. */ } }
    if (entry.queued) await this._drain(entry, 'cancelled');
    else await this._closeUnqueued(entry);
    return this.snapshot();
  }

  async close(taskId) {
    const entry = requireEntry(PRIVATE.get(this), taskId);
    if (TERMINAL.has(entry.phase)) return this.snapshot();
    if (entry.phase !== 'DRAINING') fail('DISPATCH_TASK_NOT_DRAINING');
    if (!entry.queued) await this._closeUnqueued(entry);
    else await this._drain(entry, 'failed');
    return this.snapshot();
  }

  async _closeUnqueued(entry) {
    const state = PRIVATE.get(this);
    try {
      const result = await state.host.cancelPrepared(entry.commandId);
      if (result && result.status === 'CLOSED' && result.commandId === entry.commandId) entry.phase = 'cancelled';
      else entry.error = 'DISPATCH_CLOSE_NOT_CONFIRMED';
    } catch (error) { entry.error = error.code || 'DISPATCH_CLOSE_FAILED'; }
  }

  async _drain(entry, outcome) {
    const state = PRIVATE.get(this);
    if (TERMINAL.has(entry.phase)) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = Promise.resolve().then(async () => {
      if (entry.phase !== 'DRAINING') {
        state.queue.beginDrain(entry.taskId, outcome);
        entry.phase = 'DRAINING';
      }
      try {
        const result = await (entry.attempted ? state.host.closeCommand(entry.commandId)
          : state.host.cancelPrepared(entry.commandId));
        if (result && result.status === 'CLOSED' && result.commandId === entry.commandId) {
          const task = state.queue.confirmReleased(entry.taskId, result.closeResult);
          if (task.releaseVerified) { entry.phase = task.state; entry.closeError = null; return; }
        }
        entry.closeError = 'DISPATCH_CLOSE_NOT_CONFIRMED';
      } catch (error) { entry.closeError = error.code || 'DISPATCH_CLOSE_FAILED'; }
    });
    try { await entry.closePromise; } finally { entry.closePromise = null; }
  }

  snapshot() {
    const state = PRIVATE.get(this);
    return detached({ queue: state.queue.snapshot(), commands: Array.from(state.entries.values(), entry => ({
      taskId: entry.taskId, commandId: entry.commandId, phase: entry.phase,
      attempted: entry.attempted, cancelRequested: entry.cancelRequested,
      error: entry.error, closeError: entry.closeError, observation: entry.observation,
    })) });
  }
}

module.exports = { ResourceCommandDispatcher, ResourceCommandDispatcherError };
