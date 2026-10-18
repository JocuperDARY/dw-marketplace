import { TaskManager } from './tasks.js';
import { requireValue } from './errors.js';

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
    const manager = await this.transition(async () => {
      requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
      requireValue(!this.releaseFailed, 'RECOVERY_REQUIRED', 'Task ownership release failed; reconcile the saved state.');
      this.manager ??= await new TaskManager(this.options).open();
      this.users++;
      return this.manager;
    });
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
    return this.transition(async () => {
      if (this.manager) await this.manager.close();
      this.manager = null;
    });
  }
}
