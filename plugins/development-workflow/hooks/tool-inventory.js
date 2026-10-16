#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SKILLS = 3000;
const MAX_SKILL_DEPTH = 4;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseSkill(filePath, source) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const metadata = frontmatter ? frontmatter[1] : '';
  const name = (metadata.match(/^name:\s*["']?([^\r\n"']+)/m) || [])[1]
    || path.basename(path.dirname(filePath));
  const description = (metadata.match(/^description:\s*["']?([^\r\n"']+)/m) || [])[1] || '';
  return { name: name.trim(), description: description.trim(), source };
}

function scanSkills(root, source, output, depth = 0) {
  if (!root || depth > MAX_SKILL_DEPTH || output.length >= MAX_SKILLS) return;
  let entries;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return;
    entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= MAX_SKILLS) break;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      const skill = parseSkill(absolute, source);
      if (skill) output.push(skill);
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      scanSkills(absolute, source, output, depth + 1);
    }
  }
}

function enabledPluginIds(home) {
  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};
  return Object.entries(settings.enabledPlugins || {})
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id)
    .sort();
}

function newestInstall(entries) {
  if (!Array.isArray(entries)) return entries && typeof entries === 'object' ? entries : null;
  return [...entries].sort((a, b) => String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true }))[0] || null;
}

function pluginInstallPaths(home, pluginIds) {
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {};
  const registry = installed.plugins || installed;
  const output = new Map();
  for (const pluginId of pluginIds) {
    const selected = newestInstall(registry[pluginId]);
    if (selected && selected.installPath && fs.existsSync(selected.installPath)) {
      output.set(pluginId, selected.installPath);
    }
  }
  return output;
}

function discoverMcpConfigurations(home, installs, projectDir = process.cwd()) {
  const configurations = [];
  function add(value, source, scope) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const name of Object.keys(value)) configurations.push({ name, source, scope, status: 'configured' });
  }
  const claude = readJson(path.join(home, '.claude.json')) || {};
  add(claude.mcpServers, 'claude-user-config', 'user');
  const requested = path.resolve(projectDir);
  const pathIdentity = directory => process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  for (const [directory, project] of Object.entries(claude.projects || {})) {
    if (pathIdentity(directory) === pathIdentity(requested)) add(project && project.mcpServers, 'claude-project-config', requested);
  }
  for (const [pluginId, installPath] of installs) {
    const config = readJson(path.join(installPath, '.mcp.json'));
    if (config) add(config.mcpServers || config, `plugin:${pluginId}`, 'enabled-plugin');
  }
  return configurations.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}

function discoverMcpServers(home, installs, projectDir = process.cwd()) {
  return [...new Set(discoverMcpConfigurations(home, installs, projectDir).map(item => item.name))].sort();
}

function collectInventory(options = {}) {
  const home = path.resolve(options.home || process.env.HOME || process.env.USERPROFILE || os.homedir());
  const pluginRoot = path.resolve(options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..'));
  const plugins = enabledPluginIds(home);
  const installs = pluginInstallPaths(home, plugins);
  const projectDir = path.resolve(options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const configuredMcpServers = discoverMcpConfigurations(home, installs, projectDir);
  const skills = [];
  scanSkills(path.join(home, '.claude', 'skills'), 'user', skills);
  scanSkills(path.join(pluginRoot, 'skills'), 'development-workflow', skills);
  for (const [pluginId, installPath] of installs) {
    scanSkills(path.join(installPath, 'skills'), pluginId, skills);
  }

  const deduplicated = new Map();
  for (const skill of skills) {
    const key = `${skill.source}\u0000${skill.name}`;
    if (!deduplicated.has(key)) deduplicated.set(key, skill);
  }
  return {
    generatedAt: new Date().toISOString(),
    sourcePolicy: 'discovered-only',
    evidenceKind: 'configured-filesystem-inventory',
    runtimeVerified: false,
    projectDir,
    enabledPlugins: plugins,
    mcpServers: [...new Set(configuredMcpServers.map(item => item.name))].sort(),
    configuredMcpServers,
    skills: [...deduplicated.values()].sort((a, b) => a.name.localeCompare(b.name)),
    limits: { maxSkills: MAX_SKILLS, maxDepth: MAX_SKILL_DEPTH },
  };
}

function formatMarkdown(inventory) {
  const lines = [
    '# DW capability inventory',
    '',
    `Generated: ${inventory.generatedAt}`,
    `Policy: ${inventory.sourcePolicy}; configured files only. Current-session availability and runtime behavior are unverified.`,
    '',
    `## Enabled plugins (${inventory.enabledPlugins.length})`,
    ...inventory.enabledPlugins.map(name => `- ${name}`),
    '',
    `## Configured MCP servers (${inventory.mcpServers.length}; not live-verified)`,
    ...inventory.mcpServers.map(name => `- ${name}`),
    '',
    `## Skills (${inventory.skills.length})`,
    ...inventory.skills.map(skill => `- ${skill.name} [${skill.source}]${skill.description ? ` — ${skill.description}` : ''}`),
    '',
  ];
  return lines.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const inventory = collectInventory({ home });
  const output = args.has('--json') ? `${JSON.stringify(inventory, null, 2)}\n` : formatMarkdown(inventory);
  if (args.has('--write-cache')) {
    const cacheDir = path.join(home, '.claude', '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'dw-capability-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(output);
}

if (require.main === module) main();

module.exports = {
  collectInventory,
  discoverMcpConfigurations,
  discoverMcpServers,
  enabledPluginIds,
  formatMarkdown,
  parseSkill,
  pluginInstallPaths,
  scanSkills,
};
