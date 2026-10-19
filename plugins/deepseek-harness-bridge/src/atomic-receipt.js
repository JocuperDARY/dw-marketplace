import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RETRY_WINDOW_MS = 500;

/** Internal dependency injection keeps transient Windows failures deterministic in tests. */
export function createAtomicReceiptWriter({ openFile = open, renameFile = rename, unlinkFile = unlink,
  wait = delay, now = () => performance.now(), platform = process.platform } = {}) {
  return async (path, content) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let owned = false;
    let failure;
    try {
      const handle = await openFile(temporary, 'wx', 0o600);
      owned = true;
      try { await handle.writeFile(content); }
      finally { await handle.close(); }
      const deadline = now() + RETRY_WINDOW_MS;
      for (let attempt = 0; ; attempt++) {
        try { await renameFile(temporary, path); break; }
        catch (error) {
          const waitMs = RETRY_DELAYS_MS[attempt];
          if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)
            || waitMs == null || now() + waitMs >= deadline) throw error;
          await wait(waitMs);
          if (now() >= deadline) throw error;
        }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      if (owned) try { await unlinkFile(temporary); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          if (failure) throw new AggregateError([failure, error], 'Receipt publication and owned temporary cleanup failed.', { cause: failure });
          throw error;
        }
      }
    }
  };
}

// Callers retain their own publication serializer. This helper only publishes
// a complete file atomically; it never deletes a target or changes task locks.
export const writeAtomicReceipt = createAtomicReceiptWriter();
