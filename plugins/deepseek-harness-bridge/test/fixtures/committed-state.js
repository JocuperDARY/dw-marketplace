import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Corruption fixtures follow the committed immutable snapshot pointer.
export async function snapshotPath(dataDir, taskId) {
  const registry = JSON.parse(await readFile(join(dataDir, 'registry.json'), 'utf8'));
  return join(dataDir, ...registry.tasks[taskId].snapshot.split('/'));
}

export async function committedTask(dataDir, taskId) {
  return JSON.parse(await readFile(await snapshotPath(dataDir, taskId), 'utf8'));
}

export async function retainedLeases(dataDir) {
  const registry = JSON.parse(await readFile(join(dataDir, 'registry.json'), 'utf8'));
  return Object.entries(registry.tasks).filter(([, entry]) => entry.lease).map(([taskId]) => taskId);
}
