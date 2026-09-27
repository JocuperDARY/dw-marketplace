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

function processObservationUnavailable(result) {
  if (!result) return true;
  const text = `${result.error ? result.error.message : ''}\n${result.stdout || ''}\n${result.stderr || ''}`;
  return Boolean(result.error && ['EACCES', 'EPERM'].includes(result.error.code))
    || (result.status !== 0 && /access[\s-]?is[\s-]?denied|accessdenied|permission[\s-]?denied|not[\s-]?authorized|80041003/i.test(text));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('development-workflow package includes check-updates skill assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const skillPath = path.join(pluginRoot, 'skills', 'check-updates', 'SKILL.md');
  const scriptPath = path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.ps1');
  const commonJsPath = path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.js');

  assert(packageJson.files.includes('skills/check-updates/'));
  assert.match(pluginJson.description, /13个 Skill（1个总纲 \+ 12个子 Skill）/);
  assert.match(hub, /check-updates/);
  assert(fs.existsSync(skillPath), 'expected check-updates skill');
  assert(fs.existsSync(scriptPath), 'expected check-updates compatibility wrapper');
  assert(fs.existsSync(commonJsPath), 'expected check-updates CommonJS implementation');
});

test('check-updates defaults to remote checking and has explicit local-only opt-out', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'check-updates', 'SKILL.md'), 'utf8');
  const script = fs.readFileSync(path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.js'), 'utf8');

  assert.match(skill, /默认.*联网|默认.*远程/);
  assert.match(skill, /-NoRemote/);
  assert.match(skill, /check-updates\.js/);
  assert.doesNotMatch(skill, /默认模式只做本地检查/);
  assert.match(script, /noRemote/);
  assert.match(script, /--no-remote/);
  assert.doesNotMatch(script, /shell:\s*true/);
});test('task-utils does not export an automatic git commit helper', () => {
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

test('published package can run its own npm test without repository-only files', () => {
  if (process.env.DW_PACKAGE_TEST) {
    skipTest('nested package test does not recursively repack itself');
    return;
  }

  const home = makeHome();
  const packagedRoot = path.join(home, 'packaged-plugin');
  const platformSandboxRoot = path.join(home, 'platform-sandbox');
  copyPackagedPlugin(packagedRoot);
  mkdirp(platformSandboxRoot);
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test'];
  const result = childProcess.spawnSync(npmCommand, npmArgs, {
    cwd: packagedRoot,
    env: {
      ...process.env,
      DW_PACKAGE_TEST: '1',
      DW_PLATFORM_SANDBOX_ROOT: platformSandboxRoot,
      DW_PLATFORM_NATIVE_RUN_ID: 'package-copy-test',
    },
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
  assert.strictEqual(skills.length, 13, `expected 13 skills, found ${skills.length}`);

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

test('collaboration integration exposes one canonical discovery path', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const tooling = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-tooling', 'SKILL.md'), 'utf8');
  const domains = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, 'skills', 'dw-domains', 'domains.json'),
    'utf8',
  ));
  const agentRule = fs.readFileSync(path.join(pluginRoot, 'rules', 'ai-agent-dev.md'), 'utf8');
  const workflowRule = fs.readFileSync(path.join(pluginRoot, 'rules', 'development-workflow.md'), 'utf8');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const expectedScript = 'npm run test:all';

  assert(packageJson.files.includes('skills/dw-collaboration/'));
  assert(packageJson.files.includes('test/'));
  assert.strictEqual(packageJson.scripts.test, expectedScript);
  assert.strictEqual(packageJson.scripts.validate, expectedScript);
  for (const script of ['test:core', 'test:platform:windows', 'test:platform:linux', 'test:hooks', 'test:package', 'test:all']) {
    assert.strictEqual(typeof packageJson.scripts[script], 'string', `missing ${script}`);
  }
  assert.match(hub, /\.\.\/dw-collaboration\/SKILL\.md/);
  assert.match(tooling, /\.\.\/dw-collaboration\/SKILL\.md/);
  assert.match(tooling, /子代理|child|协作/);
  assert.match(tooling, /消息|messag|资源.*账本|生命周期|evidence/i);

  const agentDomain = domains.domains.find(domain => domain.name === 'Agent开发');
  assert(agentDomain, 'expected Agent development domain');
  assert.match(agentDomain.text, /Read rules\/ai-agent-dev\.md/);
  assert.match(agentRule, /\.\.\/skills\/dw-collaboration\/SKILL\.md/);
  assert.match(workflowRule, /\.\.\/skills\/dw-collaboration\/SKILL\.md/);
  assert.deepStrictEqual(Object.keys(hooks.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  assert(!fs.existsSync(path.join(pluginRoot, 'hooks', 'subagent-context.js')),
    'deleted subagent-context.js must stay absent');

  if (!isRepositoryCheckout) {
    skipTest('repository allowlist and contributor guidance are not in the published package');
    return;
  }

  const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(agents, /SessionStart, UserPromptSubmit/);
  assert.doesNotMatch(agents, /PreToolUse|PostToolUse/);

  const requiredPaths = [
    'plugins/development-workflow/skills/dw-collaboration/SKILL.md',
    'plugins/development-workflow/skills/dw-collaboration/references/evidence-and-artifacts.md',
    'plugins/development-workflow/skills/dw-collaboration/references/state-machines.md',
    'plugins/development-workflow/skills/dw-collaboration/references/resource-lifecycle.md',
    'plugins/development-workflow/skills/dw-collaboration/references/runtime-adapters.md',
    'plugins/development-workflow/skills/dw-collaboration/references/schemas/CapabilityMatrix1.schema.json',
    'plugins/development-workflow/skills/dw-collaboration/references/schemas/CollaborationPlan1.schema.json',
    'plugins/development-workflow/skills/dw-collaboration/references/schemas/ResourceLedger1.schema.json',
    'plugins/development-workflow/skills/dw-collaboration/references/schemas/ExecutionReceipt1.schema.json',
    'plugins/development-workflow/skills/dw-collaboration/scripts/validate-artifact.js',
    'plugins/development-workflow/skills/dw-collaboration/scripts/lib/canonical-json.js',
    'plugins/development-workflow/skills/dw-collaboration/scripts/lib/contracts.js',
    'plugins/development-workflow/skills/dw-collaboration/scripts/lib/state-machines.js',
    'plugins/development-workflow/test/collaboration-contract.test.js',
    'plugins/development-workflow/test/collaboration-behavior.test.js',
    'plugins/development-workflow/test/collaboration-platform.test.js',
    'plugins/development-workflow/test/collaboration-receipt.test.js',
    'plugins/development-workflow/test/collaboration-state.test.js',
    'plugins/development-workflow/test/fixtures/collaboration/baseline-observations.json',
    'plugins/development-workflow/test/fixtures/collaboration/capability-invalid.json',
    'plugins/development-workflow/test/fixtures/collaboration/capability-valid.json',
    'plugins/development-workflow/test/fixtures/collaboration/plan-cyclic.json',
    'plugins/development-workflow/test/fixtures/collaboration/plan-incomplete-packet.json',
    'plugins/development-workflow/test/fixtures/collaboration/plan-shared-write.json',
    'plugins/development-workflow/test/fixtures/collaboration/plan-valid.json',
    'plugins/development-workflow/test/fixtures/collaboration/platform-invalid.json',
    'plugins/development-workflow/test/fixtures/collaboration/pressure-scenarios.json',
    'plugins/development-workflow/test/fixtures/collaboration/receipt-invalid.json',
    'plugins/development-workflow/test/fixtures/collaboration/state-invalid.json',
  ];
  for (const relativePath of requiredPaths) {
    assert(
      relativePath.startsWith('plugins/development-workflow/skills/dw-collaboration/')
        || /^plugins\/development-workflow\/test\/collaboration-(?:contract|behavior|platform|receipt|state)\.test\.js$/.test(relativePath)
        || relativePath.startsWith('plugins/development-workflow/test/fixtures/collaboration/'),
      `path is outside the explicit Plan B allowlist: ${relativePath}`,
    );
    assert(fs.existsSync(path.join(repoRoot, ...relativePath.split('/'))),
      `required Plan B path is missing: ${relativePath}`);
    const ignored = childProcess.spawnSync(
      'git',
      ['check-ignore', '--no-index', '--quiet', '--', relativePath],
      { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
    );
    assert.strictEqual(ignored.error, undefined, `git check-ignore failed: ${ignored.error}`);
    assert.strictEqual(ignored.status, 1, `required Plan B path is ignored: ${relativePath}`);
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
  assert.match(agents, /1 core hub \+ 12 sub-skills/);
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

test('dw-handoff re-examines the task and keeps TODO reconciliation authoritative', () => {
  const handoff = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-handoff', 'SKILL.md'), 'utf8');
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const router = fs.readFileSync(path.join(pluginRoot, 'hooks', 'skill-router.js'), 'utf8');

  assert.match(hub, /\[dw-handoff\]\(\.\.\/dw-handoff\/SKILL\.md\)/, 'hub navigation must register dw-handoff');
  assert.match(router, /dw-handoff/, 'router must offer dw-handoff for explicit handoff intent');
  assert.match(handoff, /最初的目标是什么/);
  assert.match(handoff, /从什么起点开始/);
  assert.match(handoff, /做了什么、效果如何/);
  assert.match(handoff, /最后的结果怎么样/);
  assert.match(handoff, /未来计划做什么/);
  assert.match(handoff, /TODO[^\n]*对账|对账[^\n]*TODO/);
  assert.match(handoff, /新增\s*\/\s*修改\s*\/\s*删除/);
  assert.match(handoff, /参考内容清单/);
  assert.match(handoff, /网页链接/);
  assert.match(handoff, /上下文记忆/);
  assert.match(handoff, /计划/);
  assert.match(handoff, /未完成目标/);
  assert.match(handoff, /引用频[次率]/);
  assert.match(handoff, /未验证/);
  assert.match(handoff, /放弃/);
  assert.match(handoff, /授权/);
  assert.match(handoff, /脱敏|敏感信息/);
  assert.match(handoff, /建议技能|suggested skills/i);
  assert.match(handoff, /临时目录/);
});



test('important-file changes require records, version retention, and approval', () => {
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  const implementation = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-implementation', 'SKILL.md'), 'utf8');
  const wrapup = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-wrapup', 'SKILL.md'), 'utf8');
  const rule = fs.readFileSync(path.join(pluginRoot, 'rules', 'development-workflow.md'), 'utf8');

  assert.match(hub, /铁律 B6/);
  assert.match(hub, /重要文件增删治理/);
  assert.match(hub, /被删内容原文/);
  assert.match(hub, /耐久落点/);
  assert.match(hub, /旧版本/);
  assert.match(hub, /失去全部价值|仅剩占用空间/);
  assert.match(hub, /2[–-]4 个子 agent/);
  assert.match(hub, /新对话/);
  assert.match(hub, /2[–-]4 次/);
  assert.match(implementation, /B6/);
  assert.match(wrapup, /B6/);
  assert.match(rule, /Trace important changes/);
  assert.match(rule, /When this workflow is active/);

  if (!isRepositoryCheckout) {
    skipTest('README is not part of the published package');
    return;
  }
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /铁律 B6/);
});



test('development-workflow rule keeps B6 trace as its own invariant', () => {
  const rule = fs.readFileSync(path.join(pluginRoot, 'rules', 'development-workflow.md'), 'utf8');
  assert.match(rule, /\n8\. \*\*Trace important changes\.\*\*/);
});

test('performance guidance requires local evidence instead of timeless rankings', () => {
  const optimization = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-optimization', 'SKILL.md'), 'utf8');
  assert.match(optimization, /本地.*基准|代表性.*基准|工作负载.*基准/);
  assert.doesNotMatch(optimization, /唯一可扩展选项|最快 2-3x|推理可达 150x/);
});

test('check-updates bounds external commands and preserves timeout/report evidence', () => {
  const script = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.js'),
    'utf8',
  );
  assert.match(script, /timeoutSec/);
  assert.match(script, /spawnSync/);
  assert.match(script, /timedOut/);
  assert.match(script, /shell:\s*false/);
  assert.match(script, /Report was not saved/);
});test('check-updates reports registry failures before printing the final summary', () => {
  const script = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.js'),
    'utf8',
  );
  assert.match(script, /checkRemote/);
  assert(
    script.indexOf("add('Report', 'write report'") < script.indexOf("section('8. Summary')"),
    'report-write warnings must be recorded before the final console summary',
  );
});test('check-updates classifies fake npm responses without confirming uncertain packages', () => {
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

  if (processObservationUnavailable(cleanup) || processObservationUnavailable(probe)) {
    skipTest('HOLD: Win32_Process observation or cleanup is unavailable under the current permission boundary');
    return;
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

  if (processObservationUnavailable(cleanup) || processObservationUnavailable(probe)) {
    skipTest('HOLD: Win32_Process observation or cleanup is unavailable under the current permission boundary');
    return;
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
  const testManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'test', 'test-manifest.json'), 'utf8'));
  const pluginJson = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.strictEqual(packageJson.version, '5.4.0');
  assert.strictEqual(packageJson.version, pluginJson.version);
  assert.strictEqual(packageJson.description, pluginJson.description);
  assert.match(packageJson.description, /13个 Skill（1个总纲 \+ 12个子 Skill）/);
  const coreSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'development-workflow', 'SKILL.md'), 'utf8');
  assert.match(coreSkill, /### 中文说明写法/);
  assert.match(coreSkill, /先说明当前状态/);
  assert.match(coreSkill, /具体的动词、条件和结果/);
  assert.match(coreSkill, /HOLD、FAIL、NOT_RUN、UNVERIFIED/);
  assert.match(coreSkill, /额度配置保持当前值/);
  assert.match(coreSkill, /shell 命令、JSON\/schema\/manifest/);
  const completeTestFiles = testManifest.suites.all.tests.flatMap((test) => test.args || []);
  for (const testFile of [
    'test/resource-control.test.js',
    'test/failure-loop-guard-hardening.test.js',
    'test/resource-aware-queue.test.js',
  ]) {
    assert(completeTestFiles.includes(testFile), `${testFile} must remain in the complete test suite`);
  }
  for (const relative of [
    'skills/dw-collaboration/scripts/lib/task-resource-tracker.js',
    'skills/dw-collaboration/scripts/lib/failure-loop-guard.js',
    'skills/dw-collaboration/scripts/lib/resource-aware-queue.js',
    'skills/dw-collaboration/references/resource-control.md',
    'test/resource-control.test.js',
    'test/failure-loop-guard-hardening.test.js',
    'test/resource-aware-queue.test.js',
  ]) {
    assert(fs.existsSync(path.join(pluginRoot, relative)), `expected packaged asset: ${relative}`);
  }
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
  assert.strictEqual(marketplaceEntry.version, '5.4.0');
  assert.strictEqual(packageJson.version, marketplaceEntry.version);
  assert.strictEqual(packageJson.description, marketplaceEntry.description);
  assert.match(readme, new RegExp(`development-workflow.*${packageJson.version}`));
  assert.match(readme, /13个 Skill（1个总纲 \+ 12个子 Skill）/);
});

test('documentation states evidence boundaries and manager entry points', () => {
  if (!isRepositoryCheckout) {
    skipTest('marketplace README is not part of the published package');
    return;
  }
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const hub = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-collaboration', 'SKILL.md'), 'utf8');
  const handoff = fs.readFileSync(path.join(pluginRoot, 'skills', 'dw-handoff', 'SKILL.md'), 'utf8');
  const checker = fs.readFileSync(path.join(pluginRoot, 'skills', 'check-updates', 'scripts', 'check-updates.js'), 'utf8');
  for (const status of ['IMPLEMENTED', 'PASS_STATIC', 'PASS_FOCUSED', 'VERIFIED', 'VERIFIED_DEGRADED', 'UNVERIFIED', 'NOT_RUN', 'FAIL', 'HOLD']) {
    assert(readme.includes(`\`${status}\``) || handoff.includes(`\`${status}\``), `missing evidence status ${status}`);
  }
  assert.match(readme, /5\.3 实现平台资源管理；真实 Claude、Codex 或 Grok Build 组合的运行效果仍需对应环境验证/);
  assert.match(hub, /TaskResourceManager/);
  assert.match(checker, /spawnSync/);
});
const retainedContractTests = new Set([
  'development-workflow package includes check-updates skill assets',
  'documentation states evidence boundaries and manager entry points',
  'check-updates defaults to remote checking and has explicit local-only opt-out',
  'task-utils does not export an automatic git commit helper',
  'hook self-check covers every JavaScript command in hooks.json',
  'published package can run its own npm test without repository-only files',
  'all skills expose concise trigger-only discovery metadata',
  'skill cross-references resolve to files inside the plugin',
  'collaboration integration exposes one canonical discovery path',
  'workflow guidance is runtime-neutral and scales gates with change risk',
  'published guidance has no stale fixed lifecycle or unavailable capability mandates',
  'contributor and package manifests expose the real skill and test surface',
  'tooling and wrap-up require owned child processes to be reclaimed',
  'dw-handoff re-examines the task and keeps TODO reconciliation authoritative',
  'important-file changes require records, version retention, and approval',
  'development-workflow rule keeps B6 trace as its own invariant',
  'performance guidance requires local evidence instead of timeless rankings',
  'check-updates bounds external commands and preserves timeout/report evidence',
  'check-updates reports registry failures before printing the final summary',
  'check-updates classifies fake npm responses without confirming uncertain packages',
  'check-updates records report-write failure before its final summary',
  'check-updates kills the owned process tree after a CLI timeout on Windows',
  'check-updates reclaims a child after its CLI parent exits normally on Windows',
  'domain routing instructions reference existing plugin assets',
  'development-workflow manifests and README agree on version and skill count',
]);
const selectedTests = tests.filter(({ name }) => retainedContractTests.has(name));
assert.strictEqual(
  selectedTests.length,
  retainedContractTests.size,
  'every retained contract test name must resolve to a test implementation',
);

let passed = 0;
for (const { name, fn } of selectedTests) {
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
  console.error(`${passed}/${selectedTests.length} tests passed`);
} else {
  console.log(`${passed}/${selectedTests.length} tests passed`);
}
