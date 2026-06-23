#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const node = process.execPath;

function runHook(script, input, options = {}) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PROJECT_DIR: options.projectDir || repoRoot,
    HOME: options.home || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    USERPROFILE: options.home || process.env.USERPROFILE || process.env.HOME || os.homedir(),
  };
  return childProcess.spawnSync(node, [path.join(pluginRoot, 'hooks', script)], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    env,
    cwd: options.cwd || repoRoot,
  });
}

function parseHook(stdout) {
  assert(stdout.trim(), 'expected hook to write JSON to stdout');
  const parsed = JSON.parse(stdout);
  assert(parsed.hookSpecificOutput, 'expected hookSpecificOutput');
  return parsed.hookSpecificOutput;
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw-hooks-'));
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

function writeSkill(dir, name, description) {
  writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('skill-router reads official UserPromptSubmit prompt field and routes debugging intent', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请修复这个 bug，先检查根因',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.strictEqual(out.hookEventName, 'UserPromptSubmit');
  assert.match(out.additionalContext, /dw-diagnosis/);
  assert.match(out.additionalContext, /dw-debugging/);
});

test('skill-router does not inject fallback for short English chatter', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'test',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), '');
});

test('skill-router injects active-tool fallback for real but unmatched Chinese prompts', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '继续',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.additionalContext, /L4 主动工具协议 fallback/);
});

test('tool-routing reads official tool_input and asks before large edits', () => {
  const result = runHook('tool-routing.js', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/app.js',
      new_string: Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join('\n'),
    },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  assert.strictEqual(out.permissionDecision, 'ask');
  assert.match(out.additionalContext, /TDD/);
  assert.match(out.permissionDecisionReason, /operational guideline/i);
});

test('post-code-check creates review marker from official tool_input', () => {
  const home = makeHome();
  const result = runHook('post-code-check.js', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: {
      file_path: 'src/app.js',
      new_string: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'),
    },
  }, { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const marker = path.join(home, '.claude', '.cache', 'dw-review-needed.json');
  assert(fs.existsSync(marker), 'expected review marker');
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepStrictEqual(parsed.files, ['app.js']);
  assert.strictEqual(parsed.count, 1);
});

test('MultiEdit inputs are checked before and after code edits', () => {
  const home = makeHome();
  const edits = [{
    old_string: 'old',
    new_string: Array.from({ length: 52 }, (_, i) => `line ${i + 1}`).join('\n'),
  }];

  const pre = runHook('tool-routing.js', {
    hook_event_name: 'PreToolUse',
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: 'src/app.ts',
      edits,
    },
  }, { home });
  assert.strictEqual(pre.status, 0, pre.stderr);
  assert.strictEqual(parseHook(pre.stdout).permissionDecision, 'ask');

  const post = runHook('post-code-check.js', {
    hook_event_name: 'PostToolUse',
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: 'src/app.ts',
      edits,
    },
  }, { home });
  assert.strictEqual(post.status, 0, post.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.cache', 'dw-review-needed.json'), 'utf8'));
  assert.deepStrictEqual(marker.files, ['app.ts']);
});

test('tool-inventory includes plugin-local skills when installed cache is empty', () => {
  const home = makeHome();
  const result = runHook('tool-inventory.js', {
    hook_event_name: 'SessionStart',
  }, { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.additionalContext, /Skill:development-workflow/);
  assert.match(out.additionalContext, /Skill:dw-diagnosis/);
});

test('SessionStart hooks emit context on every session start instead of a global 5 minute skip', () => {
  const home = makeHome();
  const first = runHook('session-start.js', { hook_event_name: 'SessionStart' }, { home });
  const second = runHook('session-start.js', { hook_event_name: 'SessionStart' }, { home });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(parseHook(first.stdout).additionalContext, /dw-session/);
  assert.match(parseHook(second.stdout).additionalContext, /dw-session/);
});

test('tool-inventory reuses cache but still emits context on every SessionStart', () => {
  const home = makeHome();
  const first = runHook('tool-inventory.js', { hook_event_name: 'SessionStart' }, { home });
  const second = runHook('tool-inventory.js', { hook_event_name: 'SessionStart' }, { home });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(parseHook(first.stdout).additionalContext, /tool-proact-tool-inventory/);
  assert.match(parseHook(second.stdout).additionalContext, /tool-proact-tool-inventory/);
});

test('tool-inventory discovers active plugin versions by semver, not lexicographic order', () => {
  const home = makeHome();
  const base = path.join(home, '.claude', 'plugins', 'cache', 'test-market', 'sample-plugin');
  writeSkill(path.join(base, '2.0.0', 'skills', 'old-skill'), 'old-skill', 'Old skill');
  writeSkill(path.join(base, '10.0.0', 'skills', 'new-skill'), 'new-skill', 'New skill');
  const result = runHook('tool-inventory.js', {
    hook_event_name: 'SessionStart',
  }, { home });
  assert.strictEqual(result.status, 0, result.stderr);
  parseHook(result.stdout);
  const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.cache', 'tool-inventory.json'), 'utf8'));
  const names = Object.values(cache.categories)
    .flatMap(category => category.items)
    .map(item => item.name);
  assert(names.includes('new-skill'), `expected new-skill in ${names.join(', ')}`);
  assert(!names.includes('old-skill'), `did not expect old-skill in ${names.join(', ')}`);
});

test('prune-rules deploys DW rules and keeps hook stdout clean', () => {
  const home = makeHome();
  const project = path.join(home, 'repo');
  mkdirp(path.join(project, '.git'));
  writeFile(path.join(project, 'package.json'), JSON.stringify({ dependencies: { react: 'latest' } }));
  writeFile(path.join(home, '.claude', 'rules', 'python', 'python.md'), '# Python rule\n');
  writeFile(path.join(home, '.claude', 'rules', 'typescript', 'typescript.md'), '# TypeScript rule\n');
  writeFile(path.join(home, '.claude', 'rules', 'common', 'common.md'), '# Common rule\n');

  const result = runHook('prune-rules.js', {
    hook_event_name: 'SessionStart',
  }, { home, projectDir: project, cwd: project });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), '', 'prune-rules must not write hook-breaking stdout');
  assert(fs.existsSync(path.join(home, '.claude', 'rules', 'dw', 'development-workflow.md')));
  assert(fs.existsSync(path.join(home, '.claude', 'rules', 'lazy-rules.md')));
  assert(fs.existsSync(path.join(home, '.claude', 'rules-store', 'python', 'python.md')));
});

test('subagent-context supports official Task tool_input shape', () => {
  const home = makeHome();
  const project = path.join(home, 'repo');
  mkdirp(path.join(project, '.git'));
  const taskDir = path.join(project, '.tool-proact', 'tasks', '2026-06-23-demo');
  writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
    id: 'demo',
    title: 'Demo Task',
    status: 'active',
    strategy: 'TDD',
    currentPhase: 'implementation',
    nextAction: 'dispatch worker',
  }));
  writeFile(path.join(taskDir, 'plan.md'), '# Plan\nImplement the worker slice.\n');
  const result = runHook('subagent-context.js', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_input: {
      description: 'Implementer',
      subagent_type: 'worker',
      prompt: 'Build the feature.',
    },
  }, { home, projectDir: project, cwd: project });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  assert(out.updatedInput, 'expected updatedInput for Task prompt');
  assert.match(out.updatedInput.prompt, /dw-injected-context/);
  assert.match(out.updatedInput.prompt, /Demo Task/);
});

test('subagent-context maps Task reviewer descriptions to review-scoped context', () => {
  const home = makeHome();
  const project = path.join(home, 'repo');
  mkdirp(path.join(project, '.git'));
  const taskDir = path.join(project, '.tool-proact', 'tasks', '2026-06-23-review');
  writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
    id: 'review-demo',
    title: 'Review Demo',
    status: 'active',
    strategy: 'review',
    currentPhase: 'verification',
  }));
  writeFile(path.join(taskDir, 'context.jsonl'), [
    JSON.stringify({ file: 'review-notes.md', roles: ['review'], reason: 'review-only' }),
    JSON.stringify({ file: 'implement-notes.md', roles: ['implement'], reason: 'implement-only' }),
  ].join('\n') + '\n');
  writeFile(path.join(project, 'review-notes.md'), 'REVIEW_ONLY_CONTEXT\n');
  writeFile(path.join(project, 'implement-notes.md'), 'IMPLEMENT_ONLY_CONTEXT\n');

  const result = runHook('subagent-context.js', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_input: {
      description: 'Reviewer',
      subagent_type: 'worker',
      prompt: 'Review the change.',
    },
  }, { home, projectDir: project, cwd: project });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.updatedInput.prompt, /Agent role: review/);
  assert.match(out.updatedInput.prompt, /REVIEW_ONLY_CONTEXT/);
  assert.doesNotMatch(out.updatedInput.prompt, /IMPLEMENT_ONLY_CONTEXT/);
});

test('task-utils does not export an automatic git commit helper', () => {
  const utils = require('../hooks/task-utils.js');
  assert.strictEqual(utils.autoCommitTask, undefined);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  console.error(`${passed}/${tests.length} tests passed`);
} else {
  console.log(`${passed}/${tests.length} tests passed`);
}
