import { TaskManager } from './tasks.js';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, requireValue } from './errors.js';

const OBSERVATIONS = new Set(['status', 'list', 'wait', 'result']);

// Tool discovery must not take the exclusive task-store lock. Desktop hosts
// may open a discovery connection and several conversation connections at once.
export class ConnectionTasks {
  constructor(options) {
    this.options = options;
    this.manager = null;
    this.users = 0;
    this.closed = false;
    this.releaseFailed = false;
    this.transitions = Promise.resolve();
    this.watched = new WeakSet();
    this.closing = new AbortController();
  }

  transition(operation) {
    const pending = this.transitions.then(operation);
    this.transitions = pending.catch(() => {});
    return pending;
  }

  async releaseIdle() {
    if (!this.manager || this.users || this.manager.active || this.manager.blocked) return;
    try {
      await this.manager.close();
      this.manager = null;
    } catch (error) {
      this.releaseFailed = true;
      throw error;
    }
  }

  watch(manager) {
    const pending = manager.active?.promise;
    if (!pending || this.watched.has(pending)) return;
    this.watched.add(pending);
    // Completion releases the lease even when the parent never polls again.
    pending.then(() => this.transition(() => this.releaseIdle()))
      .catch(() => { this.releaseFailed = true; });
  }

  async use(method, ...args) {
    const startedAt = Date.now();
    const waitMs = method === 'wait' ? args[0]?.timeoutMs ?? 10000 : Infinity;
    const allowance = OBSERVATIONS.has(method) ? Math.min(this.options.observationWaitMs ?? 1500, waitMs) : 0;
    let manager;
    let backoff = 25;
    while (!manager) {
      try {
        manager = await this.transition(async () => {
          requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
          requireValue(!this.releaseFailed, 'RECOVERY_REQUIRED', 'Task ownership release failed; reconcile the saved state.');
          this.manager ??= await new TaskManager(this.options).open();
          this.users++;
          return this.manager;
        });
      } catch (error) {
        if (error.code !== 'STATE_LOCKED' || !OBSERVATIONS.has(method)) throw error;
        const remaining = allowance - (Date.now() - startedAt);
        if (remaining <= 0) throw new BridgeError('STATE_LOCKED', 'Ownership remains unavailable after a bounded read wait. Retry this observation only; if it persists, reconcile the owner. No worker was launched and no lock was removed.', { retryable: true, operation: 'observation', retryAfterMs: 1000 });
        // Never sleep inside the transition queue: shutdown and an existing owner
        // must be able to release their lease while this connection is waiting.
        try { await delay(Math.min(backoff, remaining), undefined, { signal: this.closing.signal }); }
        catch { throw new BridgeError('CLOSED', 'The bridge is closing.'); }
        backoff = Math.min(200, backoff * 2);
      }
    }
    if (method === 'wait') args[0] = { ...args[0], timeoutMs: Math.max(0, waitMs - (Date.now() - startedAt)) };
    try { return await manager[method](...args); }
    finally {
      this.watch(manager);
      await this.transition(async () => { this.users--; await this.releaseIdle(); });
    }
  }

  submit(...args) { return this.use('submit', ...args); }
  continue(...args) { return this.use('continue', ...args); }
  status(...args) { return this.use('status', ...args); }
  list(...args) { return this.use('list', ...args); }
  wait(...args) { return this.use('wait', ...args); }
  result(...args) { return this.use('result', ...args); }
  cancel(...args) { return this.use('cancel', ...args); }

  close() {
    this.closed = true;
    this.closing.abort();
    return this.transition(async () => {
      if (this.manager) await this.manager.close();
      this.manager = null;
    });
  }
}
