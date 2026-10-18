import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { localConfig } from './local-config.js';
import { requireValue } from './errors.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL = /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/;
const PACKAGE = /^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/;
const KNOWN = {
  '@nanmicoder/dsh-agent-teams': ['delegation', 'Nested teams need a separate shared concurrency/request budget; keep orchestration in Codex until an adapter is verified.'],
  'dsh-mnemon': ['memory', 'Select only a reviewed headless memory source and scoped retrieval tools; do not import all historical memory.'],
  'dsh-ops': ['file-and-shell-tools', 'Prefer its concise file tools after validating path policy; shell/background tools require a separately reviewed write profile.'],
  'dsh-univer-office': ['office', 'Use only for an Office assignment and after verifying the required host services; desktop UI installation is insufficient.'],
  'cc-safety-net': ['guard', 'A supplementary command guard; it does not grant shell access.'],
  '@michengai/dsh-skills-manager': ['skills', 'Select task-relevant SKILL.md files in a local capability profile; avoid loading the whole catalog.'],
  'dsh-context': ['observability', 'Desktop context inspection; the bridge reports request/usage receipts without loading its UI.'],
  'dsh-cost-meter': ['observability', 'Accounting is not a spend limit; use the bridge request/token/time gates.'],
  'billion-context': ['context-management', 'Extra summarization may issue model calls; use small explicit context unless the adapter is budget-verified.'],
  'dsh-automation': ['automation', 'Scheduled background activity is outside a bounded worker task.'],
  '@michengai/dsh-archive-manager': ['archive-ui', 'Keep archive management in the desktop host.'],
  'dsh-whale-widget': ['desktop-ui', 'No worker capability is required for the desktop widget.'],
};

async function boundedFile(path, limit) {
  const info = await stat(path);
  requireValue(info.isFile() && info.size <= limit, 'INVALID_PROFILE', 'A capability file is missing, invalid or too large.');
  const bytes = await readFile(path);
  requireValue(bytes.length <= limit, 'INVALID_PROFILE', 'A capability file exceeds its size limit.');
  return bytes;
}

export async function installedInventory(config) {
  config ??= await localConfig();
  const dshHome = config.inventoryHome || join(homedir(), '.dsh');
  requireValue(isAbsolute(dshHome), 'INVALID_CONFIG', 'inventoryHome must be absolute.');
  const profiles = [];
  // Read package metadata only. Never evaluate Cordis YAML, load plugin code, or open credentials.
  for (const id of ['desktop', 'web']) {
    const root = join(dshHome, 'profiles', id);
    let manifest;
    try { manifest = JSON.parse(await boundedFile(join(root, 'package.json'), 1024 * 1024)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const names = Object.keys(manifest.dependencies || {});
    requireValue(names.length <= 128, 'INVALID_CONFIG', 'Too many profile packages to inspect.');
    const packages = [];
    for (const name of names) {
      if (!PACKAGE.test(name)) continue;
      let pkg;
      try { pkg = JSON.parse(await boundedFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 1024 * 1024)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const [category, guidance] = KNOWN[name] || ['unclassified', 'Inspect the package contract before creating a worker capability profile.'];
      packages.push({ name, version: typeof pkg?.version === 'string' ? pkg.version.slice(0, 100) : null,
        installed: !!pkg, declaredBundle: manifest.dsh?.profile?.bundles?.includes(name) === true,
        activation: 'not_verified', workerLoaded: false, category, guidance });
    }
    profiles.push({ id, packages });
  }
  return { profiles, evidence: 'package_metadata_only', credentialsRead: false };
}

export async function resolveProfile(id = 'files', config) {
  config ??= await localConfig();
  requireValue(typeof id === 'string' && ID.test(id), 'INVALID_PROFILE', 'Invalid capability profile ID.');
  const configured = config.capabilityProfiles ?? [];
  requireValue(Array.isArray(configured) && configured.length <= 16, 'INVALID_PROFILE', 'At most 16 capability profiles may be configured.');
  const ids = configured.map(value => value?.id);
  requireValue(ids.every(value => typeof value === 'string' && ID.test(value) && !['files', 'inference-only'].includes(value)) && new Set(ids).size === ids.length,
    'INVALID_PROFILE', 'Configured capability IDs must be unique and cannot shadow built-in profiles.');
  if (id === 'files' || id === 'inference-only') {
    return { id, digest: digest(`builtin-v1:${id}`), fileTools: id === 'files', modules: [], tools: [], skills: [], access: 'read-only' };
  }
  requireValue(Array.isArray(config.capabilityProfiles) && config.capabilityProfiles.length <= 16,
    'INVALID_PROFILE', 'Configure reviewed capabilityProfiles in the local config before selecting one.');
  const profile = config.capabilityProfiles.find(value => value.id === id);
  requireValue(profile && ['read-only', 'workspace-write'].includes(profile.access), 'INVALID_PROFILE', 'Unknown or invalid capability profile.');
  const modules = profile.modules || [];
  const skills = profile.skills || [];
  requireValue(Array.isArray(modules) && modules.length <= 8 && Array.isArray(skills) && skills.length <= 4,
    'INVALID_PROFILE', 'A profile supports at most 8 reviewed modules and 4 skills.');
  const tools = [];
  const resolvedModules = [];
  const resolvedSkills = [];
  for (const [entries, result, limit] of [[modules, resolvedModules, 4 * 1024 * 1024], [skills, resolvedSkills, 8192]]) {
    for (const entry of entries) {
      requireValue(entry && isAbsolute(entry.path || '') && /^[0-9a-f]{64}$/.test(entry.sha256 || ''), 'INVALID_PROFILE', 'Each capability file needs an absolute path and a pinned sha256.');
      const bytes = await boundedFile(entry.path, limit);
      requireValue(digest(bytes) === entry.sha256, 'CAPABILITY_CHANGED', 'A pinned capability file changed; review and update its hash before use.');
      if (entries === modules) {
        requireValue(Array.isArray(entry.tools) && entry.tools.length <= 32 && entry.tools.every(value => TOOL.test(value) && !value.startsWith('bridge_')),
          'INVALID_PROFILE', 'Each module must declare its exact tool names.');
        tools.push(...entry.tools);
        resolvedModules.push({ path: await realpath(entry.path), sha256: entry.sha256, tools: entry.tools, config: entry.config || {} });
      } else result.push({ path: entry.path, sha256: entry.sha256, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    }
  }
  requireValue(new Set(tools).size === tools.length && tools.length <= 32, 'INVALID_PROFILE', 'Capability tool names must be unique (maximum 32).');
  return { id, digest: digest(JSON.stringify(profile)), fileTools: profile.fileTools !== false,
    access: profile.access, modules: resolvedModules, tools: tools.sort(), skills: resolvedSkills };
}

export async function capabilities(config) {
  config ??= await localConfig();
  const ids = ['files', 'inference-only', ...(config.capabilityProfiles || []).map(profile => profile.id)];
  const profiles = [];
  for (const id of ids) {
    const profile = await resolveProfile(id, config);
    profiles.push({ id, digest: profile.digest, fileTools: profile.fileTools, access: profile.access,
      tools: profile.tools, skills: profile.skills.map(skill => ({ path: skill.path, sha256: skill.sha256 })),
      moduleCount: profile.modules.length, runtimeVerified: false });
  }
  return { ...(await installedInventory(config)), capabilityProfiles: profiles,
    selection: 'Pass capabilityProfile to dsh_submit. Installed plugins are not enabled automatically; exact runtime tools are checked before prompting.' };
}
