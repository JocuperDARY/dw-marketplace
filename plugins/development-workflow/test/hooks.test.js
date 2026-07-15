#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const checkoutRoot = path.resolve(pluginRoot, '..', '..');
const checkoutPluginRoot = path.join(checkoutRoot, 'plugins', 'development-workflow');
const isRepositoryCheckout = fs.existsSync(checkoutPluginRoot)
  && fs.realpathSync(checkoutPluginRoot) === fs.realpathSync(pluginRoot);
const repoRoot = isRepositoryCheckout ? checkoutRoot : pluginRoot;
const node = process.execPath;
const tempHomes = [];

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
    timeout: options.timeout || 20000,
    windowsHide: true,
  });
}

function parseHook(stdout) {
  assert(stdout.trim(), 'expected hook to write JSON to stdout');
  const parsed = JSON.parse(stdout);
  assert(parsed.hookSpecificOutput, 'expected hookSpecificOutput');
  return parsed.hookSpecificOutput;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-hooks-'));
  tempHomes.push(home);
  return home;
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function primaryWorkflowRoutes(context) {
  const blocks = context.split(/\r?\n\r?\n---\r?\n\r?\n/);
  const skillPattern = /development-workflow:(?:development-workflow|check-updates|dw-[a-z-]+)/g;
  const primary = [];
  for (const block of blocks) {
    const skills = [...new Set(block.match(skillPattern) || [])];
    if (!skills.length) continue;
    const heading = (block.match(/^## L[12][^\r\n]*/m) || [])[0];
    assert(heading, `workflow skill references require a primary route heading:\n${block}`);
    assert.match(
      heading,
      /^## (?:L1 direct skill route|L2 weak skill route|L2 task route:|L2 possible task route:)/,
      `unknown primary workflow heading: ${heading}`,
    );
    primary.push({ heading, skills, block });
  }
  return primary;
}

function powershellExecutable() {
  if (process.platform !== 'win32') return null;
  return path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function checkUpdatesScript() {
  return path.join(
    pluginRoot,
    'skills',
    'check-updates',
    'scripts',
    'check-updates.ps1',
  );
}

function writeCheckUpdateCliStubs(bin, npmMode) {
  for (const [name, version] of [
    ['claude', 'claude 1.0.0'],
    ['codegraph', 'codegraph 1.0.0'],
    ['openspec', 'openspec 1.0.0'],
    ['codex', 'codex 1.0.0'],
  ]) {
    writeFile(path.join(bin, `${name}.cmd`), `@echo off\r\necho ${version}\r\nexit /b 0\r\n`);
  }
  writeFile(path.join(bin, 'python.cmd'), '@echo off\r\nexit /b 0\r\n');

  const dependencies = JSON.stringify({
    dependencies: {
      '@colbymchenry/codegraph': { version: '1.0.0' },
      '@fission-ai/openspec': { version: '1.0.0' },
      '@openai/codex': { version: '1.0.0' },
    },
  });
  const outdated = JSON.stringify({
    '@openai/codex': {
      current: '1.0.0',
      wanted: '1.1.0',
      latest: '2.0.0',
    },
  });
  const npm = [
    '@echo off',
    'if /I "%1"=="list" (',
    `  echo ${dependencies}`,
    '  exit /b 0',
    ')',
    'if /I "%1"=="outdated" (',
    `  if /I "${npmMode}"=="empty" exit /b 0`,
    `  if /I "${npmMode}"=="empty-error" exit /b 1`,
    `  if /I "${npmMode}"=="outdated" (echo ${outdated} & exit /b 1)`,
    `  if /I "${npmMode}"=="empty-object" (echo {} & exit /b 1)`,
    `  if /I "${npmMode}"=="outdated-stderr" (echo ${outdated} & echo npm WARN registry degraded 1>&2 & exit /b 1)`,
    `  if /I "${npmMode}"=="error-json" (echo {"error":{"code":"EAI_AGAIN","summary":"network unavailable"}} & exit /b 1)`,
    `  if /I "${npmMode}"=="error-json-zero" (echo {"error":{"code":"EAI_AGAIN","summary":"network unavailable"}} & exit /b 0)`,
    `  if /I "${npmMode}"=="malformed" (echo {not-json & exit /b 1)`,
    `  if /I "${npmMode}"=="stderr" (echo npm ERR! network unavailable 1>&2 & exit /b 1)`,
    `  if /I "${npmMode}"=="stderr-zero" (echo npm ERR! network unavailable 1>&2 & exit /b 0)`,
    ')',
    'exit /b 0',
    '',
  ].join('\r\n');
  writeFile(path.join(bin, 'npm.cmd'), npm);
}

function runCheckUpdatesWithFakeNpm(npmMode, options = {}) {
  const home = makeHome();
  const bin = path.join(home, 'bin');
  writeCheckUpdateCliStubs(bin, npmMode);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', checkUpdatesScript(),
    '-CommandTimeoutSec', '3',
  ];
  if (options.noReport !== false) args.push('-NoReport');
  if (options.reportDirectory) args.push('-ReportDirectory', options.reportDirectory);
  return childProcess.spawnSync(options.powershell || powershellExecutable(), args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
}

let cachedPowerShellRuntimes;
function powerShellRuntimes() {
  if (cachedPowerShellRuntimes) return cachedPowerShellRuntimes;
  const runtimes = [];
  const windowsPowerShell = powershellExecutable();
  if (windowsPowerShell && fs.existsSync(windowsPowerShell)) {
    runtimes.push({ name: 'Windows PowerShell 5.1', command: windowsPowerShell });
  }
  const pwshProbe = childProcess.spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (!pwshProbe.error && pwshProbe.status === 0) {
    runtimes.push({ name: 'PowerShell 7', command: 'pwsh' });
  } else {
    skipTest('PowerShell 7 is not installed; fake npm matrix ran on Windows PowerShell only');
  }
  cachedPowerShellRuntimes = runtimes;
  return runtimes;
}

function skipTest(reason) {
  console.log(`# SKIP ${reason}`);
}

function copyPackagedPlugin(destination) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  writeFile(path.join(destination, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const listed of packageJson.files) {
    const relative = listed.replace(/[\\/]$/, '');
    const source = path.join(pluginRoot, relative);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(destination, relative), { recursive: true });
  }
}

function parseRegisteredCommand(command, packagedRoot) {
  const expanded = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, packagedRoot);
  const match = expanded.match(/^node\s+"([^"]+\.js)"$/);
  assert(match, `unsupported registered command shape: ${command}`);
  const target = path.resolve(match[1]);
  assert(target.startsWith(path.resolve(packagedRoot) + path.sep), `hook target escaped package: ${target}`);
  return target;
}

function selectedRegisteredHooks(manifest, eventName, toolName) {
  return (manifest.hooks[eventName] || []).flatMap((registration) => {
    if (!registration.matcher) return registration.hooks || [];
    const matches = new RegExp(`^(?:${registration.matcher})$`).test(toolName || '');
    return matches ? (registration.hooks || []) : [];
  });
}

function remoteUpdateSection(stdout) {
  const start = stdout.indexOf('7. Remote npm update check');
  assert(start >= 0, 'expected remote npm update section');
  const end = stdout.indexOf('8. Summary', start);
  return stdout.slice(start, end >= 0 ? end : undefined);
}

function probeMarkerProcesses(marker) {
  return childProcess.spawnSync(powershellExecutable(), [
    '-NoProfile',
    '-Command',
    `$marker='${marker}'; @(
      Get-CimInstance Win32_Process -OperationTimeoutSec 3 | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -like "*$marker*"
      }
    ).Count`,
  ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
}

function cleanupMarkerProcesses(marker) {
  return childProcess.spawnSync(powershellExecutable(), [
    '-NoProfile',
    '-Command',
    `$marker='${marker}'; Get-CimInstance Win32_Process -OperationTimeoutSec 3 | Where-Object {
      $_.ProcessId -ne $PID -and $_.CommandLine -like "*$marker*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
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

test('skill-router routes update checks to check-updates skill', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '帮我检查更新，尤其看一下 codegraph、openspec 和 codex 工具',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.additionalContext, /development-workflow:check-updates/);
});

test('skill-router does not treat ordinary codegraph usage as update check', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '帮我理解这个项目，优先用 codegraph 看调用链',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.doesNotMatch(out.additionalContext, /development-workflow:check-updates/);
  assert.match(out.additionalContext, /dw-tooling|codegraph_explore/);
});

test('skill-router prefers a specific RAG keyword over generic async routing', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请检查异步 embedding 的 RAG 检索管线',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.additionalContext, /## RAG系统/);
  assert.doesNotMatch(out.additionalContext, /## 消息队列/);
});

test('skill-router keeps security guidance as an overlay for mixed RAG prompts', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '审查 RAG prompt injection 风险',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.match(out.additionalContext, /## RAG系统/);
  assert.match(out.additionalContext, /## LLM安全/);
});

test('skill-router does not diagnose ordinary data-output feature requests', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '实现一个数据导出功能，并返回结果文件',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.doesNotMatch(out.additionalContext, /development-workflow:dw-diagnosis/);
  assert.match(out.additionalContext, /development-workflow:dw-planning|development-workflow:dw-implementation/);
});

test('skill-router does not route embedded English keyword substrings', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Please specialize the decoder catalog entry.',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.doesNotMatch(
    out.additionalContext || '',
    /L1 direct skill route|L2 task route: (?:理解\/探索|部署\/运维)/,
  );
});

test('skill-router does not treat reading documentation as workflow wrap-up', () => {
  const result = runHook('skill-router.js', {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请阅读 API 文档并解释用法',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const out = parseHook(result.stdout);
  assert.doesNotMatch(out.additionalContext || '', /development-workflow:dw-wrapup/);
});

test('skill-router selects at most one primary workflow for bilingual ambiguous prompts', () => {
  const cases = [
    {
      prompt: 'Please perform a code review before release.',
      expectedRouteGroups: [['development-workflow:dw-verification']],
      forbidden: ['development-workflow:dw-implementation'],
    },
    {
      prompt: 'Optimize memory allocation for this hot path.',
      expectedRouteGroups: [['development-workflow:dw-optimization']],
      forbidden: ['development-workflow:dw-wrapup'],
    },
    {
      prompt: 'Run a baseline benchmark for the parser.',
      expectedRouteGroups: [['development-workflow:dw-optimization']],
      forbidden: ['development-workflow:dw-wrapup'],
    },
    {
      prompt: 'Implement consistent log formatting.',
      expectedRouteGroups: [[
        'development-workflow:dw-planning',
        'development-workflow:dw-implementation',
      ]],
      forbidden: ['development-workflow:dw-debugging'],
    },
    {
      prompt: 'Update environment variables in the local config.',
      forbidden: ['development-workflow:dw-wrapup'],
    },
    {
      prompt: 'Deploy to the production environment.',
      expectedRouteGroups: [['development-workflow:dw-wrapup']],
    },
    {
      prompt: '制作卡片组件并添加到页面。',
      expectedRouteGroups: [
        ['development-workflow:dw-planning', 'development-workflow:dw-implementation'],
        ['development-workflow:dw-planning'],
        ['development-workflow:dw-implementation'],
      ],
      forbidden: ['development-workflow:dw-optimization'],
    },
    {
      prompt: '请阅读 API 文档并解释用法。',
      forbidden: ['development-workflow:dw-wrapup'],
    },
    {
      prompt: 'Please fix this bug.',
      expectedRouteGroups: [
        ['development-workflow:dw-diagnosis'],
        ['development-workflow:dw-diagnosis', 'development-workflow:dw-debugging'],
      ],
    },
    {
      prompt: 'Prepare the commit and update docs.',
      expectedRouteGroups: [['development-workflow:dw-wrapup']],
    },
  ];

  for (const routeCase of cases) {
    const result = runHook('skill-router.js', {
      hook_event_name: 'UserPromptSubmit',
      prompt: routeCase.prompt,
    });
    assert.strictEqual(result.status, 0, `${routeCase.prompt}\n${result.stderr}`);
    const context = parseHook(result.stdout).additionalContext || '';
    const routes = primaryWorkflowRoutes(context);
    assert(
      routes.length <= 1,
      `${routeCase.prompt} selected multiple primary routes: ${routes.map(route => route.heading).join(' | ')}`,
    );
    if (routeCase.expectedRouteGroups) {
      assert(
        routes.length === 1 && routeCase.expectedRouteGroups.some((group) => (
          group.length === routes[0].skills.length
          && group.every((skill) => routes[0].skills.includes(skill))
        )),
        `${routeCase.prompt} selected unexpected route group ${JSON.stringify(routes[0]?.skills || [])}\n${context}`,
      );
    }
    for (const skill of routeCase.forbidden || []) {
      assert.doesNotMatch(
        context,
        new RegExp(escapeRegExp(skill)),
        `${routeCase.prompt} must not route to ${skill}`,
      );
    }
  }
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
  assert.match(out.additionalContext, /L4 active capability fallback/);
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
  assert.match(out.additionalContext, /Skill:check-updates/);
});

test('development-workflow package includes check-updates skill assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const skillPath = path.join(pluginRoot, 'skills', 'check-updates', 'SKILL.md');
  const scriptPath = path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1');

  assert(packageJson.files.includes('skills/check-updates/'));
  assert.match(pluginJson.description, /11个 Skill（1个总纲 \+ 10个子 Skill）/);
  assert.match(hub, /check-updates/);
  assert(fs.existsSync(skillPath), 'expected check-updates skill');
  assert(fs.existsSync(scriptPath), 'expected check-updates script');
});

test('check-updates defaults to remote checking and has explicit local-only opt-out', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'check-updates', 'SKILL.md'), 'utf8');
  const script = fs.readFileSync(path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1'), 'utf8');

  assert.match(skill, /默认.*联网|默认.*远程/);
  assert.match(skill, /-NoRemote/);
  assert.doesNotMatch(skill, /默认模式只做本地检查/);
  assert.match(script, /\[switch\]\$NoRemote/);
  assert.match(script, /if \(\$NoRemote\)/);
  assert.doesNotMatch(script, /if \(-not \$CheckRemote\)/);
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

test('hook self-check covers every JavaScript command in hooks.json', () => {
  const manifest = fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8');
  const taskUtils = fs.readFileSync(path.join(pluginRoot, 'hooks', 'task-utils.js'), 'utf8');
  const scripts = new Set([...manifest.matchAll(/hooks[\\/]([^"\s]+\.js)/g)].map(match => match[1]));
  assert(scripts.size > 0, 'expected JavaScript hook commands');
  for (const script of scripts) {
    assert(taskUtils.includes(`'${script}'`), `verifyHookScripts is missing ${script}`);
  }
});

test('every registered JavaScript hook executes with an event-appropriate payload', () => {
  const home = makeHome();
  const packagedRoot = path.join(home, 'packaged-plugin');
  copyPackagedPlugin(packagedRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(packagedRoot, 'hooks', 'hooks.json'), 'utf8'));
  const project = path.join(home, 'project');
  mkdirp(path.join(project, '.git'));
  writeFile(path.join(project, 'package.json'), '{}\n');

  const scriptNames = (eventName, toolName) => selectedRegisteredHooks(manifest, eventName, toolName)
    .map((hook) => path.basename(parseRegisteredCommand(hook.command, packagedRoot)));
  assert.deepStrictEqual(scriptNames('PreToolUse', 'Edit'), ['tool-routing.js']);
  assert.deepStrictEqual(scriptNames('PreToolUse', 'Task'), ['subagent-context.js']);
  assert.deepStrictEqual(scriptNames('PreToolUse', 'Read'), []);
  assert.deepStrictEqual(scriptNames('PostToolUse', 'Edit'), ['post-code-check.js']);
  assert.deepStrictEqual(scriptNames('PostToolUse', 'Bash'), []);

  for (const [eventName, registrations] of Object.entries(manifest.hooks)) {
    for (const registration of registrations) {
      for (const hook of registration.hooks || []) {
        if (hook.type !== 'command' || !/\.js(?:"|\s|$)/.test(hook.command)) continue;
        const target = parseRegisteredCommand(hook.command, packagedRoot);
        const script = path.basename(target);
        let payload = { hook_event_name: eventName };
        if (eventName === 'UserPromptSubmit') {
          payload.prompt = 'Continue the current workflow.';
        } else if (eventName === 'PreToolUse' && script === 'tool-routing.js') {
          payload = {
            hook_event_name: eventName,
            tool_name: 'Edit',
            tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' },
          };
        } else if (eventName === 'PreToolUse') {
          payload = {
            hook_event_name: eventName,
            tool_name: 'Task',
            tool_input: { description: 'Worker', subagent_type: 'worker', prompt: 'Inspect only.' },
          };
        } else if (eventName === 'PostToolUse') {
          payload = {
            hook_event_name: eventName,
            tool_name: 'Edit',
            tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' },
          };
        }

        const result = childProcess.spawnSync(node, [target], {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          cwd: project,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: packagedRoot,
            CLAUDE_PROJECT_DIR: project,
            HOME: home,
            USERPROFILE: home,
          },
          timeout: ((hook.timeout || 10) + 5) * 1000,
          windowsHide: true,
        });
        assert.strictEqual(result.error, undefined, `${eventName}/${script} timed out: ${result.error}`);
        assert.strictEqual(result.status, 0, `${eventName}/${script}: ${result.stderr}`);
        if (result.stdout.trim()) {
          const parsed = JSON.parse(result.stdout);
          assert(parsed.hookSpecificOutput, `${eventName}/${script} returned invalid hook JSON`);
          assert.strictEqual(parsed.hookSpecificOutput.hookEventName, eventName);
          if (script === 'tool-inventory.js') {
            assert.match(parsed.hookSpecificOutput.additionalContext, /Skill:development-workflow/);
            assert.match(parsed.hookSpecificOutput.additionalContext, /Skill:check-updates/);
          }
        }
      }
    }
  }
});

test('published package can run its own npm test without repository-only files', () => {
  if (process.env.DW_PACKAGE_TEST) {
    skipTest('nested package test does not recursively repack itself');
    return;
  }

  const home = makeHome();
  const packagedRoot = path.join(home, 'packaged-plugin');
  copyPackagedPlugin(packagedRoot);
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test'];
  const result = childProcess.spawnSync(npmCommand, npmArgs, {
    cwd: packagedRoot,
    env: { ...process.env, DW_PACKAGE_TEST: '1' },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  assert.strictEqual(result.error, undefined, `packaged npm test timed out: ${result.error}`);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\d+\/\d+ tests passed/);
});

function readSkillDirectories() {
  const skillsRoot = path.join(pluginRoot, 'skills');
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      file: path.join(skillsRoot, entry.name, 'SKILL.md'),
    }))
    .filter(entry => fs.existsSync(entry.file));
}

function parseSkillFrontmatter(content, file) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `expected YAML frontmatter in ${file}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

test('all skills expose concise trigger-only discovery metadata', () => {
  const skills = readSkillDirectories();
  assert.strictEqual(skills.length, 11, `expected 11 skills, found ${skills.length}`);

  for (const skill of skills) {
    const content = fs.readFileSync(skill.file, 'utf8');
    const frontmatter = parseSkillFrontmatter(content, skill.file);
    assert.strictEqual(frontmatter.name, skill.name, `name must match directory for ${skill.name}`);
    assert.match(frontmatter.description || '', /^Use when\b/,
      `${skill.name} description must start with "Use when"`);
    assert((frontmatter.description || '').length <= 500,
      `${skill.name} description should stay under 500 characters`);
    assert.doesNotMatch(frontmatter.description || '', /触发词|本技能(会|将)|流程[:：]/,
      `${skill.name} description should contain triggers, not a workflow summary`);
  }
});

test('skill cross-references resolve to files inside the plugin', () => {
  for (const skill of readSkillDirectories()) {
    const content = fs.readFileSync(skill.file, 'utf8');
    const links = [...content.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)];
    for (const [, target] of links) {
      assert(!target.includes('\\'), `${skill.name} uses a Windows-style link: ${target}`);
      const resolved = path.resolve(path.dirname(skill.file), target);
      assert(resolved.startsWith(pluginRoot + path.sep),
        `${skill.name} link escapes plugin root: ${target}`);
      assert(fs.existsSync(resolved), `${skill.name} has a broken link: ${target}`);
    }
  }
});

test('workflow guidance is runtime-neutral and scales gates with change risk', () => {
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const rule = fs.readFileSync(path.join(pluginRoot, 'rules', 'development-workflow.md'), 'utf8');
  const planning = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-planning', 'SKILL.md'), 'utf8');
  const implementation = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-implementation', 'SKILL.md'), 'utf8');
  const verification = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-verification', 'SKILL.md'), 'utf8');

  assert.match(hub, /Edit.*apply_patch|apply_patch.*Edit/,
    'hub should name both Claude and Codex structured edit mechanisms');
  assert.match(hub, /风险|影响面/);
  assert.doesNotMatch(hub, /覆盖率[≥>]80%|90% 的情况/,
    'hub should not impose unsupported universal thresholds');
  assert.match(hub, /阶段路由模型|可选路径/);
  assert.match(hub, /文档[\/与]配置|配置变更/);
  assert.doesNotMatch(
    hub,
    /前一阶段未通过准出，绝不进入下一阶段|连续 3 个循环|TDD循环|文档\+memory/,
    'hub should not impose a single linear lifecycle on every task',
  );
  assert.match(planning, /风险|可逆|歧义/);
  assert.match(implementation, /适用.*闸门|按.*风险|风险.*选择/);
  assert.match(verification, /项目.*命令|仓库.*命令/);
  assert.match(rule, /Edit.*apply_patch|apply_patch.*Edit/,
    'always-loaded rule should be runtime-neutral');
  assert.match(rule, /风险|影响面|\bRisk\b|\bimpact\b/i);
  assert.match(rule, /子进程|开发服务器|child processes|development servers/i);
  assert.doesNotMatch(rule, /80%\+|Maximize tool usage|GitHub code search first|SYNOPSIS\.md/);
});

test('published guidance has no stale fixed lifecycle or unavailable capability mandates', () => {
  const implementation = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-implementation', 'SKILL.md'), 'utf8');
  const verification = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-verification', 'SKILL.md'), 'utf8');
  const wrapup = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-wrapup', 'SKILL.md'), 'utf8');
  const reference = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-reference', 'SKILL.md'), 'utf8');
  const debugging = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-debugging', 'SKILL.md'), 'utf8');
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const router = fs.readFileSync(path.join(pluginRoot, 'hooks', 'skill-router.js'), 'utf8');
  const rag = fs.readFileSync(path.join(pluginRoot, 'rules', 'ai-rag-system.md'), 'utf8');
  const testing = fs.readFileSync(path.join(pluginRoot, 'rules', 'testing-methodology.md'), 'utf8');

  assert.doesNotMatch(
    [implementation, verification, wrapup, reference, debugging].join('\n'),
    /阶段(?:三|四|五|六|七)|回到阶段(?:二|三)|<\s*50\s*行/,
    'sub-skills must not impose fixed stage numbers or a fixed reproducer size',
  );
  assert.doesNotMatch(
    [implementation, verification, wrapup, reference, debugging].join('\n'),
    /必须[^\n]*(?:知识|记忆|memory)[^\n]*(?:持久|更新|写入)|强制[^\n]*(?:知识|记忆|memory)/i,
    'knowledge persistence must remain conditional',
  );
  assert.doesNotMatch(testing, /覆盖率\s*(?:>=|≥)\s*80%|70\s*\/\s*20\s*\/\s*10/);
  assert.doesNotMatch(rag, /[<>]\s*1M|70\s*\/\s*20\s*\/\s*10/i);
  assert.doesNotMatch(
    `${rag}\n${testing}`,
    /mcp__|Skill:/,
    'domain rules must describe capabilities without requiring external tool identifiers',
  );
  assert.doesNotMatch(
    `${hub}\n${router}`,
    /mcp__context7__|mcp__tavily__|requesting-code-review/,
    'workflow guidance must discover optional capabilities at runtime',
  );
});

test('contributor and package manifests expose the real skill and test surface', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert(packageJson.files.includes('test/'), 'published package must include the test runner used by npm test');
  if (!isRepositoryCheckout) {
    skipTest('repository contributor guidance is not part of the published package');
    return;
  }
  const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /1 core hub \+ 10 sub-skills/);
});

test('tooling and wrap-up require owned child processes to be reclaimed', () => {
  const tooling = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-tooling', 'SKILL.md'), 'utf8');
  const wrapup = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-wrapup', 'SKILL.md'), 'utf8');

  assert.match(tooling, /子进程/);
  assert.match(tooling, /进程标识|PID/);
  assert.match(tooling, /回收|终止|停止/);
  assert.match(wrapup, /子进程|开发服务器/);
  assert.match(wrapup, /回收|终止|停止/);
});

test('performance guidance requires local evidence instead of timeless rankings', () => {
  const optimization = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-optimization', 'SKILL.md'), 'utf8');
  assert.match(optimization, /本地.*基准|代表性.*基准|工作负载.*基准/);
  assert.doesNotMatch(optimization, /唯一可扩展选项|最快 2-3x|推理可达 150x/);
});

test('check-updates bounds external commands and reclaims timed-out processes', () => {
  const script = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1'),
    'utf8',
  );
  assert.match(script, /CommandTimeoutSec/);
  assert.match(script, /function Invoke-ExternalCommand/);
  assert.match(script, /function Stop-OwnedProcessTree/);
  assert.match(script, /Get-CimInstance Win32_Process[^\r\n]*-OperationTimeoutSec/);
  assert((script.match(/Stop-OwnedProcessTree/g) || []).length >= 3,
    'timeout and finally paths should reclaim the owned process tree');
  assert.match(script, /WaitForExit/);
  assert.match(script, /finally/);
  assert.match(script, /Kill\(\$true\)|Stop-Process/);
  assert.doesNotMatch(
    script,
    /& \$Name --version|^\s*npm\s+(list|outdated)\b|^\s*python\s+-m\s+pip\s+show\b/m,
  );
});

test('check-updates reports registry failures before printing the final summary', () => {
  const script = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1'),
    'utf8',
  );
  assert.match(script, /\$registryFailed\s*=/);
  assert.match(script, /if \(\$registryFailed\)/);
  assert(
    script.indexOf('Add-Status "Report" "write report"') < script.indexOf('Write-Section "8. Summary"'),
    'report-write warnings must be recorded before the final console summary',
  );
});

test('check-updates classifies fake npm responses without confirming uncertain packages', () => {
  if (process.platform !== 'win32') {
    skipTest('fake npm .cmd fixtures require Windows');
    return;
  }

  const cases = [
    { mode: 'empty', expect: /\[OK\]\s+@openai\/codex\b/, uncertain: false, warn: false },
    { mode: 'outdated', expect: /\[UP\]\s+@openai\/codex\b/, uncertain: false, warn: false },
    { mode: 'outdated-stderr', expect: /\[UP\]\s+@openai\/codex\b/, uncertain: true, warn: true },
    { mode: 'empty-error', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'empty-object', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'error-json', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'error-json-zero', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'malformed', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'stderr', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
    { mode: 'stderr-zero', expect: /\[!!\]\s+npm outdated\b/, uncertain: true, warn: true },
  ];

  for (const runtime of powerShellRuntimes()) {
    for (const npmCase of cases) {
      const label = `${runtime.name}/${npmCase.mode}`;
      const result = runCheckUpdatesWithFakeNpm(npmCase.mode, { powershell: runtime.command });
      assert.strictEqual(result.error, undefined, `${label} timed out: ${result.error}`);
      assert.strictEqual(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
      const remote = remoteUpdateSection(result.stdout);
      assert.match(remote, npmCase.expect, `${label}: ${remote}`);
      if (npmCase.warn) {
        assert.match(remote, /\[!!\]\s+npm outdated\b/, `${label} must report uncertainty`);
      } else {
        assert.doesNotMatch(remote, /\[!!\]\s+npm outdated\b/, `${label} must not report a false warning`);
      }
      if (npmCase.uncertain) {
        assert.doesNotMatch(
          remote,
          /\[OK\]\s+@(?:colbymchenry\/codegraph|fission-ai\/openspec|openai\/codex)\b/,
          `${label} must not confirm packages after an uncertain registry result`,
        );
      }
    }
  }
});

test('check-updates records report-write failure before its final summary', () => {
  if (process.platform !== 'win32') {
    skipTest('report failure fixture requires Windows');
    return;
  }

  const reportParent = makeHome();
  const blockedTarget = path.join(reportParent, 'not-a-directory');
  writeFile(blockedTarget, 'block directory creation\n');
  const result = runCheckUpdatesWithFakeNpm('empty', {
    noReport: false,
    reportDirectory: blockedTarget,
  });
  assert.strictEqual(result.error, undefined, `report failure test timed out: ${result.error}`);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const warningIndex = result.stdout.indexOf('write report');
  const summaryIndex = result.stdout.indexOf('8. Summary');
  assert(warningIndex >= 0, `expected report warning:\n${result.stdout}`);
  assert(summaryIndex > warningIndex, 'report warning must be recorded before the final summary');
  assert.match(result.stdout.slice(summaryIndex), /warnings need attention/i);
});

test('check-updates kills the owned process tree after a CLI timeout on Windows', () => {
  if (process.platform !== 'win32') {
    skipTest('Windows process-tree regression requires Windows');
    return;
  }

  const home = makeHome();
  const bin = path.join(home, 'bin');
  const marker = `dw-owned-timeout-${process.pid}-${Date.now()}`;
  writeFile(path.join(bin, 'claude.cmd'), '@echo claude 1.0.0\r\n');
  writeFile(path.join(bin, 'codegraph.cmd'), '@echo codegraph 1.0.0\r\n');
  writeFile(path.join(bin, 'openspec.cmd'), '@echo openspec 1.0.0\r\n');
  writeFile(path.join(bin, 'npm.cmd'), '@echo {"dependencies":{}}\r\n');
  writeFile(path.join(bin, 'python.cmd'), '@echo off\r\n');
  writeFile(
    path.join(bin, 'codex.cmd'),
    `@echo off\r\npowershell.exe -NoProfile -Command "Start-Sleep -Seconds 30" ${marker}\r\n`,
  );

  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };
  let result;
  let probe;
  let cleanup;
  try {
    result = childProcess.spawnSync(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-NoRemote',
      '-NoReport',
      '-CommandTimeoutSec', '1',
    ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    probe = probeMarkerProcesses(marker);
  } finally {
    cleanup = cleanupMarkerProcesses(marker);
  }

  assert.strictEqual(cleanup.status, 0, cleanup.stderr);
  assert.strictEqual(result.error, undefined, `check-updates timed out: ${result.error}`);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /timed out/);
  assert.strictEqual(probe.status, 0, probe.stderr);
  assert.strictEqual(probe.stdout.trim(), '0', `owned process still running: ${marker}`);
});

test('check-updates reclaims a child after its CLI parent exits normally on Windows', () => {
  if (process.platform !== 'win32') {
    skipTest('detached-child regression requires Windows');
    return;
  }

  const home = makeHome();
  const bin = path.join(home, 'bin');
  const marker = `dw-owned-detached-${process.pid}-${Date.now()}`;
  writeFile(path.join(bin, 'claude.cmd'), '@echo claude 1.0.0\r\n');
  writeFile(path.join(bin, 'codegraph.cmd'), '@echo codegraph 1.0.0\r\n');
  writeFile(path.join(bin, 'openspec.cmd'), '@echo openspec 1.0.0\r\n');
  writeFile(path.join(bin, 'npm.cmd'), '@echo {"dependencies":{}}\r\n');
  writeFile(path.join(bin, 'python.cmd'), '@echo off\r\n');
  writeFile(
    path.join(bin, 'codex.cmd'),
    `@echo off\r\nstart "" /b powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120" ${marker}\r\necho codex 1.0.0\r\nexit /b 0\r\n`,
  );

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };
  let result;
  let probe;
  let cleanup;
  try {
    result = childProcess.spawnSync(powershellExecutable(), [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', checkUpdatesScript(),
      '-NoRemote',
      '-NoReport',
      '-CommandTimeoutSec', '3',
    ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    probe = probeMarkerProcesses(marker);
  } finally {
    cleanup = cleanupMarkerProcesses(marker);
  }

  assert.strictEqual(cleanup.status, 0, cleanup.stderr);
  assert.strictEqual(result.error, undefined, `check-updates timed out: ${result.error}`);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.strictEqual(probe.status, 0, probe.stderr);
  assert.strictEqual(probe.stdout.trim(), '0', `detached child still running: ${marker}`);
});

test('domain routing instructions reference existing plugin assets', () => {
  const domainsPath = path.join(pluginRoot, 'skills', 'dw-domains', 'domains.json');
  const domains = JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  for (const domain of domains.domains) {
    const instructions = [domain.text, ...(domain.instructions || [])].filter(Boolean);
    for (const instruction of instructions) {
      const references = [...instruction.matchAll(/\bRead\s+([^\s`)]+)/g)];
      for (const [, reference] of references) {
        const target = path.resolve(pluginRoot, reference);
        assert(target.startsWith(pluginRoot + path.sep),
          `${domain.name} reference escapes plugin root: ${reference}`);
        assert(fs.existsSync(target), `${domain.name} has a broken reference: ${reference}`);
      }
    }
  }
});

test('development-workflow manifests and README agree on version and skill count', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const pluginJson = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.strictEqual(packageJson.version, pluginJson.version);
  assert.strictEqual(packageJson.description, pluginJson.description);
  assert.match(packageJson.description, /11个 Skill（1个总纲 \+ 10个子 Skill）/);
  if (!isRepositoryCheckout) {
    skipTest('marketplace and README are not part of the published package');
    return;
  }
  const marketplace = JSON.parse(fs.readFileSync(
    path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
    'utf8',
  ));
  const marketplaceEntry = marketplace.plugins.find(plugin => plugin.name === 'development-workflow');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  assert(marketplaceEntry, 'expected development-workflow marketplace entry');
  assert.strictEqual(packageJson.version, marketplaceEntry.version);
  assert.strictEqual(packageJson.description, marketplaceEntry.description);
  assert.match(readme, new RegExp(`development-workflow.*${packageJson.version}`));
  assert.match(readme, /11个 Skill（1个总纲 \+ 10个子 Skill）/);
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

for (const home of tempHomes) {
  fs.rmSync(home, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`${passed}/${tests.length} tests passed`);
} else {
  console.log(`${passed}/${tests.length} tests passed`);
}
