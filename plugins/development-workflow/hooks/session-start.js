#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { outputHook } = require('./task-utils.js');
const { buildRulesContext, detectProjectLanguages, isWithin } = require('./session-rules.js');

const SESSION_CONTEXT_BUDGET = 96 * 1024;

function normalizePath(value) {
  try {
    return path.resolve(value);
  } catch {
    return process.cwd();
  }
}

function resolveProjectRoot(projectDir, home) {
  const requested = normalizePath(projectDir);
  const homeRoot = normalizePath(home || os.homedir());
  let gitRoot = '';
  try {
    gitRoot = childProcess.execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: requested, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true },
    ).trim();
  } catch {
    return { root: requested, git: false, boundaryFallback: false };
  }

  const resolvedGitRoot = normalizePath(gitRoot);
  const homeCapture = resolvedGitRoot.toLowerCase() === homeRoot.toLowerCase()
    && requested.toLowerCase() !== homeRoot.toLowerCase();
  if (homeCapture || !isWithin(resolvedGitRoot, requested)) {
    return { root: requested, git: false, boundaryFallback: true };
  }
  return { root: resolvedGitRoot, git: true, boundaryFallback: false };
}

function getGitSummary(project) {
  if (!project.git) return { branch: 'not-a-repository', dirtyFiles: null };
  try {
    const branch = childProcess.execFileSync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: project.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, windowsHide: true },
    ).trim();
    const status = childProcess.execFileSync(
      'git', ['status', '--porcelain'],
      { cwd: project.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true },
    );
    return { branch: branch || 'detached', dirtyFiles: status.split(/\r?\n/).filter(Boolean).length };
  } catch {
    return { branch: 'unavailable', dirtyFiles: null };
  }
}

function registeredHookHealth(pluginRoot) {
  const manifestPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const scripts = [];
    for (const groups of Object.values(manifest.hooks || {})) {
      for (const group of groups || []) {
        for (const hook of group.hooks || []) {
          const match = String(hook.command || '').match(/\/hooks\/([^"/]+\.js)/);
          if (match) scripts.push(match[1]);
        }
      }
    }
    const unique = [...new Set(scripts)];
    const missing = unique.filter(script => !fs.existsSync(path.join(pluginRoot, 'hooks', script)));
    return { registered: unique, missing, manifestValid: true };
  } catch (error) {
    return { registered: [], missing: [], manifestValid: false, error: error.message };
  }
}

function technologyLabel(languages) {
  const display = {
    common: null,
    typescript: 'TypeScript/JavaScript',
    web: 'Web',
    react: 'React',
    python: 'Python',
    rust: 'Rust',
    cpp: 'C/C++',
    golang: 'Go',
    java: 'Java',
    kotlin: 'Kotlin',
    swift: 'Swift',
    dart: 'Dart',
    csharp: 'C#',
    angular: 'Angular',
  };
  const values = languages.map(language => display[language] || language)
    .filter(Boolean);
  return values.length ? [...new Set(values)].join(' + ') : 'Unknown';
}

function buildSessionContext(options) {
  const pluginRoot = normalizePath(options.pluginRoot);
  const home = normalizePath(options.home);
  const requestedProject = normalizePath(options.projectDir);
  const project = resolveProjectRoot(requestedProject, home);
  const detection = detectProjectLanguages(project.root);
  const git = getGitSummary(project);
  const health = registeredHookHealth(pluginRoot);
  const rules = buildRulesContext({
    home,
    projectDir: project.root,
    maxBytes: 90 * 1024,
  });

  const dirty = git.dirtyFiles === null ? 'not measured' : String(git.dirtyFiles);
  const healthText = health.manifestValid
    ? `${health.registered.length} registered, ${health.missing.length} missing`
    : `manifest unreadable: ${health.error}`;
  const boundary = project.boundaryFallback
    ? '\nBoundary note: ignored a home-level repository and kept CLAUDE_PROJECT_DIR as the project boundary.'
    : '';
  const header = [
    '<dw-session>',
    `Project root: ${project.root}`,
    `Technology: ${technologyLabel(detection.languages)}`,
    `Git branch: ${git.branch}`,
    `Dirty files: ${dirty}`,
    `DW hook health: ${healthText}`,
    `Registered hooks: ${health.registered.join(', ') || 'none'}`,
    'Hook policy: advisory and read-only at session start; workflow enforcement remains in the DW skills.',
    boundary,
    '</dw-session>',
    '',
  ].filter(line => line !== '').join('\n');
  const context = `${header}${rules.context}`;
  if (Buffer.byteLength(context, 'utf8') > SESSION_CONTEXT_BUDGET) {
    throw new Error(`session context exceeded ${SESSION_CONTEXT_BUDGET} bytes`);
  }
  return { context, project, detection, git, health, rules };
}

function main() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  try {
    const result = buildSessionContext({ home, projectDir, pluginRoot });
    outputHook('SessionStart', result.context);
  } catch (error) {
    const fallback = [
      '<dw-session>',
      `Project root: ${normalizePath(projectDir)}`,
      `DW session initialization degraded: ${error.message}`,
      'No files were modified by this hook.',
      '</dw-session>',
    ].join('\n');
    outputHook('SessionStart', fallback);
  }
}

if (require.main === module) main();

module.exports = {
  SESSION_CONTEXT_BUDGET,
  buildSessionContext,
  getGitSummary,
  registeredHookHealth,
  resolveProjectRoot,
  technologyLabel,
};
