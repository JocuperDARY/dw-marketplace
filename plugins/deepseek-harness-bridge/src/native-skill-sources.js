import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';

const packageName = '@deepseek-ai/dsh-agent-preset';
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

// The desktop composition declares this package's skills as customSkillDirs.
// Resolve package metadata without evaluating the desktop's Cordis YAML.
export async function presetSkillRoot(managerCore) {
  let metadata;
  let origin = 'bridge-sdk';
  let installedPreset = managerCore ? 'not_resolved' : 'not_selected';
  if (managerCore) {
    try {
      metadata = createRequire(managerCore).resolve(`${packageName}/package.json`);
      origin = 'installed-profile';
      installedPreset = 'resolved';
    } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  metadata ??= createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(await readFile(metadata, 'utf8'));
  if (pkg.name !== packageName) throw new Error('Unexpected native preset skill package.');
  return { path: join(dirname(metadata), 'skills'), package: pkg.name, version: pkg.version, origin, installedPreset };
}

export async function createPresetSkillProvider(root, report = () => {}) {
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('Native preset skill root is not a directory.');
  const checked = async path => {
    path = resolve(path);
    if (!inside(canonicalRoot, path) || await realpath(root) !== canonicalRoot) throw new Error('Native preset skill source identity changed.');
    const parts = relative(canonicalRoot, path).split(sep).filter(Boolean);
    let current = canonicalRoot;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Native preset skill links are not allowed.');
    }
    if (!inside(canonicalRoot, await realpath(path))) throw new Error('Native preset skill escaped its package root.');
    return { displayPath: path };
  };
  // Use the official parser on an allowlisted read-only filesystem. This does
  // not expose an arbitrary host filesystem operation to the model.
  const fs = {
    resolve: checked,
    processPath: target => target.displayPath,
    stat: async target => {
      const info = await stat((await checked(target.displayPath)).displayPath);
      return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' };
    },
    listDir: async target => {
      const safe = await checked(target.displayPath);
      const entries = await readdir(safe.displayPath, { withFileTypes: true });
      return entries.filter(entry => !entry.isSymbolicLink()).map(entry => ({ name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { displayPath: join(safe.displayPath, entry.name) } }));
    },
    readText: async (target, signal) => readFile((await checked(target.displayPath)).displayPath, { encoding: 'utf8', signal }),
  };
  let parseWarnings = 0;
  const provider = new FileSystemSkillProvider({ get: key => key === 'fs' ? fs : undefined,
    logger: { warn() { parseWarnings++; } } },
    { signal: new AbortController().signal, invalidate() {} },
    { providerName: 'bridge-dsh-preset-skills', includeDefaultRoots: false, customSkillDirs: [canonicalRoot], watch: false });
  const listed = new Map();
  return {
    name: provider.name,
    async list(options) {
      try {
        parseWarnings = 0;
        await checked(canonicalRoot);
        const result = await provider.list(options);
        const candidates = Array.isArray(result) ? result : result.candidates;
        listed.clear();
        for (const candidate of candidates) listed.set(candidate.name, candidate);
        report({ state: parseWarnings ? 'incomplete' : candidates.length ? 'available' : 'empty',
          path: canonicalRoot, count: candidates.length, parseWarnings });
        return parseWarnings ? { candidates, complete: false } : result;
      } catch (error) {
        listed.clear();
        report({ state: 'unavailable', path: canonicalRoot, count: null });
        throw error;
      }
    },
    async get(candidate, options) {
      const discovered = listed.get(candidate.name);
      if (!discovered || candidate.path !== discovered.path || candidate.locator?.path !== discovered.locator.path) return undefined;
      await checked(discovered.locator.path);
      return provider.get(discovered, options);
    },
    dispose: () => provider.dispose(),
  };
}
