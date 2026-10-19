import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { registerModulePins } from './module-pins.js';
import { readdir } from 'node:fs/promises';

// A separate JS environment reads only the installed manager's catalog API.
// Its DSH_HOME can point at the user's skill policy without changing SDK home.
registerModulePins([[pathToFileURL(workerData.path).href, workerData.sha256]]);
const manager = await import(pathToFileURL(workerData.path).href);
parentPort.on('message', async ({ id, method, candidate, cwd }) => {
  try {
    if (method === 'get') {
      parentPort.postMessage({ id, result: await manager.getProviderSkill(candidate, { cwd }) });
      return;
    }
    if (method !== 'list') throw new Error('Unknown catalog method.');
    const candidates = await manager.listProviderCandidates({ cwd });
    const policy = await manager.readManagerState();
    const definitions = [...manager.userRoots(), ...await manager.projectRoots([cwd])];
    const roots = await Promise.all(definitions.map(async ({ key, path, native }) => {
      if (policy.state?.sources?.[key] === false) return { key, path, native: native === true, state: 'disabled' };
      try {
        const entries = await readdir(path);
        return { key, path, native: native === true, state: entries.length ? 'present' : 'empty' };
      } catch (error) {
        return { key, path, native: native === true, state: error.code === 'ENOENT' ? 'absent' : 'unavailable' };
      }
    }));
    const completeBySource = Object.fromEntries(['native', 'supplemental'].map(source => [source,
      policy.writable !== false && !roots.some(root => root.native === (source === 'native') && root.state === 'unavailable')]));
    const complete = Object.values(completeBySource).every(Boolean);
    const diagnostics = { state: !complete ? 'incomplete' : candidates.length ? 'available' : 'empty',
      completeBySource,
      count: candidates.length, policyReadable: policy.writable !== false, roots,
      countsBySource: Object.fromEntries([...new Set(candidates.map(skill => skill.source))]
        .map(source => [source, candidates.filter(skill => skill.source === source).length])),
      observation: 'root_access_and_manager_candidates; nested scan diagnostics are not exported by the manager provider' };
    // The manager catalog API completed. Root availability is category-specific;
    // bridge_skill_search applies it after native/supplemental selection instead
    // of making an inaccessible supplemental source invalidate native discovery.
    parentPort.postMessage({ id, result: { candidates, complete: policy.writable !== false }, diagnostics });
  } catch {
    parentPort.postMessage({ id, error: 'Native Skills Manager catalog operation failed; no fallback content was silently substituted.' });
  }
});
