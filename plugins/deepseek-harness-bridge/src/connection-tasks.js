import { TaskManager } from './tasks.js';
import { requireValue } from './errors.js';
import { previewSubmission } from './submission-plan.js';
import { normalizeHistory } from './history.js';

// Keep the connection identity across idle periods. Only registry commits and
// individual task attempts take locks; observing another chat never acquires one.
export class ConnectionTasks {
  constructor(options) {
    this.options = options;
    this.manager = null;
    this.opening = null;
    this.closed = false;
    this.closing = null;
  }

  async use(method, ...args) {
    requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
    if (this.manager) return this.manager[method](...args);
    this.opening ??= (async () => {
      const manager = new TaskManager(this.options);
      await manager.open();
      this.manager = manager;
      return manager;
    })().catch(error => {
      this.opening = null;
      throw error;
    });
    const manager = await this.opening;
    requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
    return manager[method](...args);
  }

  plan(input) {
    requireValue(!this.closed, 'CLOSED', 'The bridge is closing.');
    return previewSubmission(input, this.options);
  }

  submit(...args) { return this.use('submit', ...args); }
  continue(...args) { return this.use('continue', ...args); }
  status(...args) { return this.use('status', ...args); }
  list(input = {}) {
    const { cursor } = normalizeHistory(input);
    requireValue(!cursor || this.manager, 'HISTORY_CURSOR_UNAVAILABLE', 'History cursors belong to the connection that captured them. Start a fresh query without cursor.');
    return this.use('list', input);
  }
  usage(...args) { return this.use('usage', ...args); }
  wait(...args) { return this.use('wait', ...args); }
  result(...args) { return this.use('result', ...args); }
  checkResult(...args) { return this.use('checkResult', ...args); }
  cancel(...args) { return this.use('cancel', ...args); }

  close() {
    this.closed = true;
    return this.closing ??= (async () => {
      // A failed read-only open owns neither a worker nor a task lease.
      const manager = this.manager ?? await this.opening?.catch(() => null);
      await manager?.close();
    })();
  }
}
