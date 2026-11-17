#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROUTES, SKILL_IDS } = require('../../../hooks/skill-router.js');
const DEFAULT_ROOT = path.resolve(__dirname, '../../..');
const COVERAGE_CATALOG = 'skills/dw-tooling/references/automation-coverage.json';
// Include native and other source languages when new implementations are added.
// Data, documentation and compiled binaries are not production source files.
const SOURCE_EXTENSION = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|ps1|psm1|cs|fs|fsx|py|sh|bash|c|cc|cpp|cxx|h|hpp|hxx|java|go|rs|rb|pl|php|swift|kt|kts|dart)$/i;

function isProductionSource(file) {
  return /^(?:hooks\/|skills\/[^/]+\/scripts\/).+/.test(file) && SOURCE_EXTENSION.test(file);
}

function isCanonicalRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\0]/.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = {};
  for (const line of (match ? match[1] : '').split(/\r?\n/)) {
    const field = line.match(/^([a-z][a-z-]*):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

function markdownTargets(content) {
  const prose = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  return [...prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)]
    .map(match => match[1].trim().replace(/^<(.*)>$/, '$1'))
    .filter(target => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target))
    .map(target => target.split('#')[0]).filter(Boolean);
}

function checkSkillStructure({ pluginRoot = DEFAULT_ROOT, routes = ROUTES, skillIds = SKILL_IDS } = {}) {
  const root = fs.realpathSync(pluginRoot);
  const issues = [];
  const files = [];
  const add = (code, file, detail) => issues.push({ code, file, detail });
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  function read(file) {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); }
    catch (error) { add('FILE_UNREADABLE', file, error.code || 'read_failed'); return null; }
  }
  function json(file) {
    const text = read(file);
    if (text === null) return null;
    try { return JSON.parse(text); }
    catch { add('JSON_INVALID', file, 'Expected valid JSON'); return null; }
  }
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { add('DIRECTORY_UNREADABLE', relative(directory), error.code || 'read_failed'); return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) add('SYMLINK_NOT_INSPECTED', relative(target), 'Linked assets are not inspected');
      else if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(relative(target));
    }
  }
  for (const directory of ['skills', 'hooks', 'rules', 'test']) {
    const target = path.join(root, directory);
    if (!fs.existsSync(target)) continue;
    if (fs.lstatSync(target).isSymbolicLink()) add('SYMLINK_NOT_INSPECTED', directory, 'Linked asset root');
    else walk(target);
  }
  const packageJson = json('package.json');
  const manifest = json('test/test-manifest.json');
  const hooks = json('hooks/hooks.json');
  const declarations = Array.isArray(packageJson && packageJson.files) ? packageJson.files : [];
  // The allowlist is checked here; the package suite checks npm's actual archive selection.
  function requirePackaged(file) {
    const included = declarations.some(entry => typeof entry === 'string' && (
      file === entry.replace(/\/$/, '') || file.startsWith(`${entry.replace(/\/$/, '')}/`)
    ));
    if (!included) add('ASSET_NOT_PACKAGED', file, 'Missing from package.json files declarations');
  }
  const skillFiles = files.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file));
  const skills = skillFiles.map(file => file.split('/')[1]).sort();
  for (const file of skillFiles) {
    const fields = frontmatter(read(file) || '');
    if (fields.name !== file.split('/')[1]) add('SKILL_NAME_MISMATCH', file, 'Frontmatter name must match its directory');
    if (!fields.description) add('SKILL_DESCRIPTION_MISSING', file, 'Discovery description is required');
    requirePackaged(file);
  }
  const registered = Array.isArray(skillIds) ? skillIds : [];
  for (const name of registered) {
    if (!skills.includes(name)) add('REGISTERED_SKILL_MISSING', 'hooks/skill-router.js', String(name));
  }
  for (const name of skills) {
    if (!registered.includes(name)) add('SKILL_NOT_REGISTERED', `skills/${name}/SKILL.md`, 'Missing explicit-call registration');
  }
  if (new Set(registered).size !== registered.length) add('DUPLICATE_SKILL_ID', 'hooks/skill-router.js', 'Skill IDs must be unique');
  for (const file of files.filter(file => file.endsWith('.md'))) {
    for (const target of markdownTargets(read(file) || '')) {
      const resolved = path.resolve(root, path.dirname(file), target);
      if (!inside(root, resolved)) add('LINK_OUTSIDE_PLUGIN', file, target);
      else if (!fs.existsSync(resolved)) add('LINK_MISSING', file, target);
      else if (!inside(root, fs.realpathSync(resolved))) add('LINK_OUTSIDE_PLUGIN', file, target);
      // A valid source link can still break after installation if its target is
      // omitted. Check tracked asset paths, excluding npm's automatic root files.
      else if (files.includes(relative(resolved))) requirePackaged(relative(resolved));
    }
  }
  const hub = 'skills/development-workflow/SKILL.md';
  const hubTargets = new Set(markdownTargets(read(hub) || '').map(target => path.resolve(root, path.dirname(hub), target)));
  for (const name of skills.filter(name => name !== 'development-workflow')) {
    if (!hubTargets.has(path.join(root, 'skills', name, 'SKILL.md'))) add('SKILL_NOT_IN_HUB', hub, name);
  }
  const routeIds = new Set();
  for (const route of routes || []) {
    if (routeIds.has(route.id)) add('DUPLICATE_ROUTE_ID', 'hooks/skill-router.js', route.id);
    routeIds.add(route.id);
    const named = [...String(route.context || '').matchAll(/development-workflow:([a-z0-9-]+)/g)].map(match => match[1]);
    const targets = Array.isArray(route.skills) ? route.skills : named;
    if (!targets.length) add('ROUTE_TARGET_MISSING', 'hooks/skill-router.js', `${route.id}: no declared target`);
    if (Array.isArray(route.skills) && (named.some(name => !targets.includes(name)) || targets.some(name => !named.includes(name)))) {
      add('ROUTE_TARGET_MISMATCH', 'hooks/skill-router.js', route.id);
    }
    for (const name of new Set([...targets, ...named])) {
      if (!skills.includes(name)) add('ROUTE_TARGET_MISSING', 'hooks/skill-router.js', `${route.id}: ${name}`);
    }
  }
  for (const groups of Object.values((hooks && hooks.hooks) || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group.hooks || []) {
        for (const match of String(hook.command || '').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}[\\/](hooks[\\/][a-z0-9._-]+\.js)/gi)) {
          const file = match[1].replace(/\\/g, '/');
          if (!files.includes(file)) add('HOOK_MISSING', 'hooks/hooks.json', file);
          requirePackaged(file);
        }
      }
    }
  }
  const all = manifest && manifest.suites && manifest.suites.all;
  if (!all || !Array.isArray(all.tests)) add('ALL_SUITE_MISSING', 'test/test-manifest.json', 'An explicit complete suite is required');
  const registeredTests = new Set((all && Array.isArray(all.tests) ? all.tests : []).flatMap(test => test && Array.isArray(test.args) ? test.args : []).filter(arg => typeof arg === 'string' && arg.endsWith('.test.js')));
  const testFiles = files.filter(file => /^test\/[^/]+\.test\.js$/.test(file));
  for (const file of testFiles) {
    if (!registeredTests.has(file)) add('TEST_NOT_REGISTERED', file, 'Missing from the all suite');
    requirePackaged(file);
  }
  for (const file of registeredTests) {
    if (!testFiles.includes(file)) add('REGISTERED_TEST_MISSING', 'test/test-manifest.json', file);
  }
  const scripts = files.filter(file => /^(?:hooks\/|skills\/[^/]+\/scripts\/).+\.(?:js|ps1)$/.test(file));
  const runtimeSources = files.filter(isProductionSource).sort();
  runtimeSources.forEach(requirePackaged);
  requirePackaged(COVERAGE_CATALOG);
  const coverage = json(COVERAGE_CATALOG);
  const validCatalog = coverage && typeof coverage === 'object' && !Array.isArray(coverage)
    && coverage.schemaVersion === 1 && Array.isArray(coverage.entries);
  if (!validCatalog) add('COVERAGE_CATALOG_INVALID', COVERAGE_CATALOG, 'Expected schemaVersion 1 and an entries array');
  const covered = new Set();
  const enforcementModes = new Set(['advisory', 'validation', 'opt-in-runtime']);
  for (const [index, entry] of (validCatalog ? coverage.entries : []).entries()) {
    const label = `entries[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: expected an object`);
      continue;
    }
    if (!isCanonicalRelativePath(entry.path)) {
      add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: expected a canonical relative source path`);
    } else {
      if (covered.has(entry.path)) add('COVERAGE_SOURCE_DUPLICATE', COVERAGE_CATALOG, entry.path);
      covered.add(entry.path);
      if (!runtimeSources.includes(entry.path)) add('COVERAGE_SOURCE_MISSING', COVERAGE_CATALOG, entry.path);
    }
    if (typeof entry.owner !== 'string' || !skills.includes(entry.owner) || !registered.includes(entry.owner)) {
      add('COVERAGE_OWNER_MISSING', COVERAGE_CATALOG, `${label}: owner must name a shipped, registered skill`);
    }
    if (!enforcementModes.has(entry.enforcement)) add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: unknown enforcement`);
    if (typeof entry.limits !== 'string' || !entry.limits.trim()) add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: limits are required`);
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
      add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: at least one registered test is required`);
      continue;
    }
    for (const test of entry.tests) {
      if (!isCanonicalRelativePath(test)) {
        add('COVERAGE_ENTRY_INVALID', COVERAGE_CATALOG, `${label}: invalid test path`);
        continue;
      }
      if (!testFiles.includes(test)) add('COVERAGE_TEST_MISSING', COVERAGE_CATALOG, `${label}: ${test}`);
      if (!registeredTests.has(test)) add('COVERAGE_TEST_NOT_REGISTERED', COVERAGE_CATALOG, `${label}: ${test}`);
    }
  }
  for (const file of runtimeSources) {
    if (!covered.has(file)) add('SOURCE_NOT_CATALOGED', file, 'Missing implementation/owner/test mapping');
  }
  return {
    ok: issues.length === 0,
    scope: 'Read-only metadata, links, declared package assets, routing targets, source coverage and test registration; not executed test coverage, runtime or host acceptance',
    skills, scripts, runtimeSources, testFiles, issues,
  };
}

if (require.main === module) {
  if (process.argv.slice(2).some(arg => arg !== '--json')) {
    console.error('Usage: node check-skill-structure.js [--json]');
    process.exitCode = 2;
  } else {
    const result = checkSkillStructure();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.skills.length} skills, ${result.scripts.length} scripts, ${result.runtimeSources.length} runtime sources, ${result.testFiles.length} test files`);
      result.issues.forEach(issue => console.log(`${issue.code}: ${issue.file}: ${issue.detail}`));
      console.log(result.scope);
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}

module.exports = { checkSkillStructure, frontmatter, markdownTargets };
