import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { registerModulePins } from './module-pins.js';

// A separate JS environment reads only the installed manager's catalog API.
// Its DSH_HOME can point at the user's skill policy without changing SDK home.
registerModulePins([[pathToFileURL(workerData.path).href, workerData.sha256]]);
const manager = await import(pathToFileURL(workerData.path).href);
parentPort.on('message', async ({ id, method, candidate, cwd }) => {
  try {
    const result = method === 'list' ? await manager.listProviderCandidates({ cwd })
      : method === 'get' ? await manager.getProviderSkill(candidate, { cwd }) : undefined;
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, error: 'Native Skills Manager catalog operation failed; no fallback content was silently substituted.' });
  }
});
