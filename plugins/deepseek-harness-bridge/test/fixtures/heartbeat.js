import { readFile } from 'node:fs/promises';

// The synthetic writer truncates/replaces this file on each beat. An existing
// but empty/partial read is not an observed child identity.
export async function readHeartbeat(path, read = readFile) {
  const raw = await read(path, 'utf8');
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(raw);
  if (!match) return null;
  const pid = Number(match[1]); const timestamp = Number(match[2]);
  return Number.isSafeInteger(pid) && Number.isSafeInteger(timestamp) ? { raw, pid, timestamp } : null;
}
