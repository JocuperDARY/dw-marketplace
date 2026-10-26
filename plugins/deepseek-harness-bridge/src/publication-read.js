import { setTimeout as delay } from 'node:timers/promises';

const waits = [5, 10, 20];
const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

// Windows observations can briefly miss a mutable pointer during replacement.
// Retry only that read, never parsing errors, writes, leases or model work.
// Callers retain their path/link/schema validation on every attempt.
export async function readPublished(operation, { platform = process.platform, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (platform !== 'win32' || error.code !== 'ENOENT' || attempt >= waits.length) throw error;
      await wait(waits[attempt]);
    }
  }
}

// The pinned SDK's context provider is synchronous. A rare miss can wait at
// most 35 ms here; the normal path does not block or allocate a wait buffer.
export function readPublishedSync(operation, { platform = process.platform, wait = pause } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (platform !== 'win32' || error.code !== 'ENOENT' || attempt >= waits.length) throw error;
      wait(waits[attempt]);
    }
  }
}
