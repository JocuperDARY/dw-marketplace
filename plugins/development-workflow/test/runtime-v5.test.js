#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const node = process.execPath;
const temporaryRoots = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-v5-'));
  temporaryRoots.push(root);
  return root;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runScript(script, input, options = {}) {
  const home = options.home || makeTempRoot();
  const projectDir = options.projectDir || pluginRoot;
  return childProcess.spawnSync(node, [path.join(pluginRoot, 'hooks', script), ...(options.args || [])], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    cwd: projectDir,
    timeout: options.timeout || 10000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PROJECT_DIR: projectDir,
    },
  });
}

function parseHook(result) {
  assert.strictEqual(result.status, 0, result.stderr);
  assert(result.stdout.trim(), 'expected hook JSON output');
  const parsed = JSON.parse(result.stdout);
  assert(parsed.hookSpecificOutput, 'expected hookSpecificOutput');
  return parsed.hookSpecificOutput;
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  function walk(current, relative) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const rel = path.join(relative, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        rows.push(`link:${rel}:${fs.readlinkSync(absolute)}`);
      } else if (stat.isDirectory()) {
        rows.push(`dir:${rel}`);
        walk(absolute, rel);
      } else if (stat.isFile()) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        rows.push(`file:${rel}:${hash}`);
      }
    }
  }
  walk(root, '');
  return rows;
}

function seedRules(home) {
  const store = path.join(home, '.claude', 'rules-store');
  writeFile(path.join(store, 'common', 'safety.md'), '# COMMON-SAFETY\nKeep changes reversible.\n');
  writeFile(path.join(store, 'typescript', 'style.md'), '# TS-STYLE\nUse strict types.\n');
  writeFile(path.join(store, 'react', 'patterns.md'), '# REACT-PATTERN\nPrefer accessible components.\n');
  writeFile(path.join(store, 'web', 'security.md'), '# WEB-SECURITY\nEscape untrusted content.\n');
  writeFile(path.join(store, 'python', 'style.md'), '# PYTHON-STYLE\nUse type hints.\n');
  return store;
}

test('manifest registers only the two deliberate v5 hooks', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const registrations = Object.entries(manifest.hooks).flatMap(([event, groups]) => (
    groups.flatMap(group => group.hooks.map(hook => ({ event, matcher: group.matcher, command: hook.command })))
  ));
  assert.deepStrictEqual(registrations, [
    {
      event: 'SessionStart',
      matcher: '',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js"',
    },
    {
      event: 'UserPromptSubmit',
      matcher: '',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/skill-router.js"',
    },
  ]);
});

test('SessionStart selects relevant rules without mutating the rules library', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const store = seedRules(home);
  writeFile(path.join(project, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0' },
    devDependencies: { typescript: '^5.0.0', vite: '^7.0.0' },
  }));
  writeFile(path.join(project, 'src', 'App.tsx'), 'export function App() { return <main />; }\n');

  const before = snapshotTree(path.join(home, '.claude'));
  const result = runScript('session-start.js', { hook_event_name: 'SessionStart' }, { home, projectDir: project });
  const output = parseHook(result);
  const after = snapshotTree(path.join(home, '.claude'));

  assert.deepStrictEqual(after, before, 'SessionStart must be read-only over ~/.claude');
  assert.match(output.additionalContext, /COMMON-SAFETY/);
  assert.match(output.additionalContext, /TS-STYLE/);
  assert.match(output.additionalContext, /REACT-PATTERN/);
  assert.match(output.additionalContext, /WEB-SECURITY/);
  assert.doesNotMatch(output.additionalContext, /PYTHON-STYLE/);
  assert(fs.existsSync(store), 'rules store must remain intact');
});

test('active rules are acknowledged but never duplicated into hook context', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(project, 'index.ts'), 'export const value = 1;\n');
  writeFile(path.join(home, '.claude', 'rules', 'typescript', 'active.md'), '# ACTIVE-RULE-SENTINEL\n');
  writeFile(path.join(home, '.claude', 'rules-store', 'typescript', 'stored.md'), '# STALE-STORED-SENTINEL\n');
  const output = parseHook(runScript('session-start.js', { hook_event_name: 'SessionStart' }, { home, projectDir: project }));
  assert.match(output.additionalContext, /active: typescript\/active\.md/);
  assert.doesNotMatch(output.additionalContext, /ACTIVE-RULE-SENTINEL/);
  assert.doesNotMatch(output.additionalContext, /STALE-STORED-SENTINEL/);
});

test('concurrent SessionStart runs are deterministic and read-only', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  seedRules(home);
  writeFile(path.join(project, 'src', 'index.ts'), 'export const value: number = 1;\n');
  const before = snapshotTree(path.join(home, '.claude'));
  const children = Array.from({ length: 8 }, () => childProcess.spawn(node, [path.join(pluginRoot, 'hooks', 'session-start.js')], {
    cwd: project,
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(JSON.parse(stdout).hookSpecificOutput.additionalContext);
    });
  }))).then(outputs => {
    assert(outputs.every(output => output === outputs[0]), 'concurrent outputs must match');
    assert.deepStrictEqual(snapshotTree(path.join(home, '.claude')), before);
  });
});

test('rules migration defaults to a byte-for-byte read-only dry run', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(home, '.claude', 'rules', 'typescript', 'style.md'), '# ACTIVE-TS\n');
  const before = snapshotTree(path.join(home, '.claude'));
  const result = runScript('rules-migrate.js', undefined, { home, projectDir: project, args: ['--dry-run'] });
  assert.strictEqual(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.strictEqual(plan.mode, 'dry-run');
  assert.strictEqual(plan.safeToApply, true);
  assert.deepStrictEqual(plan.candidates.map(item => item.language), ['typescript']);
  assert.deepStrictEqual(snapshotTree(path.join(home, '.claude')), before);
});

test('rules migration fails closed on divergent rules-store content', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(home, '.claude', 'rules', 'typescript', 'style.md'), '# ACTIVE-TS\n');
  writeFile(path.join(home, '.claude', 'rules-store', 'typescript', 'style.md'), '# DIFFERENT-TS\n');
  const before = snapshotTree(path.join(home, '.claude'));
  const result = runScript('rules-migrate.js', undefined, { home, projectDir: project, args: ['--apply'] });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /conflicts/i);
  assert.deepStrictEqual(snapshotTree(path.join(home, '.claude')), before);
});

test('explicit rules migration verifies copies and archives originals for rollback', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(project, 'index.ts'), 'export const value = 1;\n');
  writeFile(path.join(home, '.claude', 'rules', 'typescript', 'style.md'), '# MIGRATED-TS\n');
  const result = runScript('rules-migrate.js', undefined, { home, projectDir: project, args: ['--apply'] });
  assert.strictEqual(result.status, 0, result.stderr);
  const applied = JSON.parse(result.stdout);
  assert.strictEqual(applied.mode, 'apply');
  assert.strictEqual(applied.applied.length, 1);
  assert(!fs.existsSync(path.join(home, '.claude', 'rules', 'typescript')));
  assert.strictEqual(
    fs.readFileSync(path.join(home, '.claude', 'rules-store', 'typescript', 'style.md'), 'utf8'),
    '# MIGRATED-TS\n',
  );
  assert(fs.existsSync(applied.manifest));
  assert.strictEqual(
    fs.readFileSync(path.join(path.dirname(applied.manifest), 'typescript', 'style.md'), 'utf8'),
    '# MIGRATED-TS\n',
  );
  const session = parseHook(runScript('session-start.js', { hook_event_name: 'SessionStart' }, { home, projectDir: project }));
  assert.match(session.additionalContext, /MIGRATED-TS/);
});

test('rule loading rejects symlinks and respects the 96 KiB context budget', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const store = seedRules(home);
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(project, 'index.ts'), 'export const x = 1;\n');
  writeFile(path.join(root, 'outside.md'), 'OUTSIDE-SENTINEL\n');
  try {
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(store, 'typescript', 'escape.md'));
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  writeFile(path.join(store, 'typescript', 'large.md'), `LARGE-RULE\n${'x'.repeat(160 * 1024)}`);

  const output = parseHook(runScript('session-start.js', { hook_event_name: 'SessionStart' }, { home, projectDir: project }));
  assert(Buffer.byteLength(output.additionalContext, 'utf8') <= 96 * 1024);
  assert.doesNotMatch(output.additionalContext, /OUTSIDE-SENTINEL/);
  assert.match(output.additionalContext, /truncated|deferred|budget/i);
});

test('project root never escapes CLAUDE_PROJECT_DIR into a home-level repository', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(home, 'work', 'plain-project');
  fs.mkdirSync(path.join(home, '.git'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const output = parseHook(runScript('session-start.js', { hook_event_name: 'SessionStart' }, { home, projectDir: project }));
  assert.match(output.additionalContext, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output.additionalContext, /ALL SYSTEMS ACTIVE/);
  assert.doesNotMatch(output.additionalContext, /mcp__codegraph|mcp__context7|mcp__memory/);
});

test('skill router is quiet for ambiguous prompts and routes explicit repair intent', () => {
  const quiet = runScript('skill-router.js', { hook_event_name: 'UserPromptSubmit', prompt: '请解释一下这个概念' });
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.strictEqual(quiet.stdout, '');

  const routed = parseHook(runScript('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请修复这个 bug，先做根因分析',
  }));
  assert.match(routed.additionalContext, /dw-diagnosis/);
  assert.match(routed.additionalContext, /dw-debugging/);
  assert(Buffer.byteLength(routed.additionalContext, 'utf8') < 1024);
});

test('skill router corpus has high precision across positive, negative, negated, and quoted intents', () => {
  const { routePrompt } = require('../hooks/skill-router.js');
  const cases = [
    ['请修复登录模块并定位根因', 'repair'],
    ['Please fix the failing parser after diagnosing it', 'repair'],
    ['检查全局工具更新', 'check-updates'],
    ['check for updates to the environment', 'check-updates'],
    ['请给出迁移方案和回退方案', 'planning'],
    ['write a technical design for this migration', 'planning'],
    ['帮我优化这个慢查询', 'optimization'],
    ['benchmark and optimize this parser', 'optimization'],
    ['请做最终验证', 'verification'],
    ['perform a code review', 'verification'],
    ['按计划实现该功能', 'implementation'],
    ['implement this feature', 'implementation'],
    ['请整理交付并收尾', 'wrapup'],
    ['prepare the commit', 'wrapup'],
    ['请解释一下这个概念', null],
    ['不要修复，只解释现象', null],
    ['do not fix this; explain the behavior', null],
    ['字符串 "fix" 是什么意思', null],
    ['帮我理解 codegraph 的调用链', null],
    ['这篇论文审查了哪些数据', null],
    ['性能是什么意思', null],
    ['我计划明天看文档', null],
  ];
  for (const [prompt, expected] of cases) {
    const route = routePrompt(prompt);
    assert.strictEqual(route && route.id, expected, prompt);
  }
});

test('tool inventory reports only discovered capabilities and writes no cache by default', () => {
  const root = makeTempRoot();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'sample@local': true, 'disabled@local': false },
  }));
  writeFile(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'actual-mcp': { command: 'example' } },
  }));
  writeFile(path.join(home, '.claude', 'skills', 'only-real', 'SKILL.md'), '---\nname: only-real\ndescription: real\n---\n');

  const result = runScript('tool-inventory.js', undefined, { home, projectDir: project, args: ['--json'] });
  assert.strictEqual(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert(inventory.skills.some(skill => skill.name === 'only-real'));
  assert(inventory.mcpServers.includes('actual-mcp'));
  assert.deepStrictEqual(inventory.enabledPlugins, ['sample@local']);
  assert(!JSON.stringify(inventory).includes('mcp__tavily__tavily_search'));
  assert(!fs.existsSync(path.join(home, '.claude', '.cache')), 'on-demand inventory must not create cache files');
});

(async () => {
  let passed = 0;
  try {
    for (const { name, fn } of tests) {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    }
    console.log(`${passed}/${tests.length} tests passed`);
  } catch (error) {
    console.error(`not ok - ${tests[passed] ? tests[passed].name : 'unknown test'}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    for (const root of temporaryRoots) {
      const resolved = path.resolve(root);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
})();
