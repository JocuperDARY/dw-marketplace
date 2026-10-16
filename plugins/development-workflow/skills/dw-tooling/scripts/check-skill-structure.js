#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROUTES, SKILL_IDS } = require('../../../hooks/skill-router.js');
const DEFAULT_ROOT = path.resolve(__dirname, '../../..');

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
  const registeredTests = new Set((all && Array.isArray(all.tests) ? all.tests : []).flatMap(test => test.args || []).filter(arg => typeof arg === 'string' && arg.endsWith('.test.js')));
  const testFiles = files.filter(file => /^test\/[^/]+\.test\.js$/.test(file));
  for (const file of testFiles) {
    if (!registeredTests.has(file)) add('TEST_NOT_REGISTERED', file, 'Missing from the all suite');
    requirePackaged(file);
  }
  for (const file of registeredTests) {
    if (!testFiles.includes(file)) add('REGISTERED_TEST_MISSING', 'test/test-manifest.json', file);
  }
  const scripts = files.filter(file => /^(?:hooks\/|skills\/[^/]+\/scripts\/).+\.(?:js|ps1)$/.test(file));
  scripts.forEach(requirePackaged);
  return {
    ok: issues.length === 0,
    scope: 'Read-only metadata, links, declared package assets, routing targets and test registration; not runtime or host acceptance',
    skills, scripts, testFiles, issues,
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
      console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.skills.length} skills, ${result.scripts.length} scripts, ${result.testFiles.length} test files`);
      result.issues.forEach(issue => console.log(`${issue.code}: ${issue.file}: ${issue.detail}`));
      console.log(result.scope);
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}

module.exports = { checkSkillStructure, frontmatter, markdownTargets };
