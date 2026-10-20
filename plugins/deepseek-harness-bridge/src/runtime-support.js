import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.js';

export const RUNTIME_SUPPORT_DIRECTORY = '.bridge-runtime';
export const RUNTIME_SUPPORT_HELPER = '.bridge-runtime/Invoke-BridgeProcess.ps1';
const sourceHelper = fileURLToPath(new URL('../scripts/Invoke-BridgeProcess.ps1', import.meta.url));

/** Only call after NEW workspace verification, before placing any other files. */
export async function stageRuntimeSupport(workspace, { nodePath = process.execPath, nodeVersion = process.versions.node } = {}) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace) {
    throw new BridgeError('RUNTIME_SUPPORT_WORKSPACE', 'Runtime support requires an absolute canonical new workspace.');
  }
  let cursor = workspace;
  while (true) {
    const entry = await lstat(cursor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new BridgeError('RUNTIME_SUPPORT_REPARSE', 'Runtime support refuses reparse points and non-directory ancestors.');
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  if ((await realpath(workspace)).toLowerCase() !== workspace.toLowerCase()) throw new BridgeError('RUNTIME_SUPPORT_WORKSPACE', 'Runtime support requires a canonical workspace.');
  if ((await readdir(workspace)).length !== 0) throw new BridgeError('RUNTIME_SUPPORT_EXISTS', 'Runtime support requires an empty new workspace.');
  const directory = join(workspace, RUNTIME_SUPPORT_DIRECTORY);
  // Deliberately non-recursive and exclusive: never merge or replace support.
  await mkdir(directory);
  const helperPath = join(workspace, RUNTIME_SUPPORT_HELPER);
  await copyFile(sourceHelper, helperPath, constants.COPYFILE_EXCL);
  const manifest = {
    format: 'dsh-bridge-runtime-support', version: 1,
    helper: { relativePath: RUNTIME_SUPPORT_HELPER, sha256: createHash('sha256').update(await readFile(helperPath)).digest('hex') },
    node: { path: nodePath, version: nodeVersion, evidence: 'current-bridge-process-only', childProcessVerified: false },
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { directory, helperPath, manifestPath: join(directory, 'manifest.json'), manifest };
}
