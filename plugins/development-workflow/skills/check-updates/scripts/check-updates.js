'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { discoverMcpConfigurations, enabledPluginIds, pluginInstallPaths } = require('../../../hooks/tool-inventory');

const argv = process.argv.slice(2);
const options = {
  noRemote: argv.includes('--no-remote'),
  noReport: argv.includes('--no-report'),
  projectPath: process.cwd(),
  timeoutSec: 20,
  reportDirectory: path.join(os.homedir(), '.claude', 'scripts'),
};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--project-path' && argv[i + 1]) options.projectPath = path.resolve(argv[++i]);
  if (argv[i] === '--command-timeout-sec' && argv[i + 1]) options.timeoutSec = Math.max(1, Math.min(600, Number(argv[++i]) || 20));
  if (argv[i] === '--report-directory' && argv[i + 1]) options.reportDirectory = path.resolve(argv[++i]);
}

const rows = [];
let hasUpdate = false;
let hasWarn = false;
let hasError = false;
const separator = '='.repeat(78);
function section(title) { console.log(`\n${separator}\n  ${title}\n${separator}`); }
function add(category, component, status, detail, data = {}) {
  const icon = { OK: '[OK]', UPDATE: '[UP]', WARN: '[!!]', INFO: '[..]', MISSING: '[--]', ERROR: '[ER]' }[status] || '[??]';
  console.log(`  ${icon.padEnd(5)} ${String(component).padEnd(38)} ${detail}`);
  rows.push({ Category: category, Component: component, Status: status, Detail: String(detail), ...data });
  if (status === 'UPDATE') hasUpdate = true;
  if (status === 'WARN') hasWarn = true;
  if (status === 'ERROR') hasError = true;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function countDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).length; } catch { return null; } }
const commandPaths = new Map();
function commandPath(name) {
  if (commandPaths.has(name)) return commandPaths.get(name);
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = [];
  for (const entry of pathEntries) {
    if (path.isAbsolute(name)) candidates.push(name);
    else if (process.platform === 'win32' && !path.extname(name)) {
      for (const extension of extensions) candidates.push(path.join(entry, `${name}${extension.toLowerCase()}`));
      candidates.push(path.join(entry, name));
    } else candidates.push(path.join(entry, name));
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { commandPaths.set(name, candidate); return candidate; } } catch { /* keep searching */ }
  }
  commandPaths.set(name, null);
  return null;
}
function run(name, args = []) {
  const executable = commandPath(name) || name;
  if (process.platform !== 'win32') {
    return { code: null, stdout: '', stderr: '', timedOut: false, reason: 'HOLD: owned descendant cleanup is unverified on this platform' };
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'bounded-command-windows.ps1')], {
    input: JSON.stringify({ executable, args, timeoutMs: options.timeoutSec * 1000, maxOutputBytes: 65536 }),
    encoding: 'utf8', timeout: options.timeoutSec * 1000 + 15000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0) return { code: null, stdout: '', stderr: '', timedOut: result.error?.code === 'ETIMEDOUT', reason: result.error?.code === 'ETIMEDOUT' ? 'HOLD: command backend timed out; cleanup unverified' : 'HOLD: command backend failed; cleanup unverified' };
  try {
    const value = JSON.parse(result.stdout);
    if (value.cleanup !== 'verified_absent' || !['completed', 'timed_out', 'output_limit', 'hold'].includes(value.status)) throw new Error();
    return { code: value.exitCode, stdout: String(value.stdout || ''), stderr: String(value.stderr || ''), timedOut: value.status === 'timed_out', reason: value.status === 'completed' ? null : value.status === 'timed_out' ? 'command timed out' : value.status === 'output_limit' ? 'command output limit exceeded' : 'HOLD: command unavailable; cleanup verified' };
  } catch { return { code: null, stdout: '', stderr: '', timedOut: false, reason: 'HOLD: command backend response invalid; cleanup unverified' }; }
}
function cliVersion(name) {
  if (!commandPath(name)) return { status: 'MISSING', version: null, detail: `${name} not found on PATH` };
  const r = run(name, ['--version']);
  if (r.reason || r.code !== 0) return { status: 'WARN', version: null, detail: r.reason || 'version command failed' };
  const version = safeVersion(r.stdout || r.stderr, name);
  return version ? { status: 'OK', version, detail: version } : { status: 'WARN', version: null, detail: 'version response invalid' };
}

function safeVersion(value, label) {
  const text = String(value || '').trim().split(/\r?\n/, 1)[0];
  const escaped = label ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const prefix = escaped ? `(?:(?:${escaped}|codex-cli)\\s+v?)?` : 'v?';
  const match = text.match(new RegExp(`^${prefix}(\\d{1,5}\\.\\d{1,5}(?:\\.\\d{1,5})?)(?:\\s+\\([^\\r\\n]{0,80}\\))?$`, 'i'));
  return match ? match[1] : null;
}


function normalizeVersion(v) { const m = String(v || '').match(/\d+(?:\.\d+){0,2}/); return m ? m[0].split('.').map(Number) : null; }
function compareVersion(a, b) { const x = normalizeVersion(a) || [0], y = normalizeVersion(b) || [0]; for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
function npmGlobals() {
  if (!commandPath('npm')) return null;
  const r = run('npm', ['list', '-g', '--depth=0', '--json']);
  if (r.reason || r.code !== 0) { add('Local', 'npm globals', 'WARN', r.reason || 'global package inventory failed'); return null; }
  try { const value = JSON.parse(r.stdout); if (!value || typeof value !== 'object' || Array.isArray(value) || value.error) throw new Error(); return value; }
  catch { add('Local', 'npm globals', 'WARN', 'global package inventory response invalid'); return null; }
}
function npmVersion(deps, pkg) { return deps?.dependencies?.[pkg] ? safeVersion(deps.dependencies[pkg].version || deps.dependencies[pkg]) : null; }
function pipVersion(pkg) {
  if (!commandPath('python')) return { status: 'INFO', detail: 'python not found; pip package unchecked' };
  const r = run('python', ['-m', 'pip', 'show', pkg]);
  if (r.reason) return { status: 'WARN', detail: r.reason };
  if (r.code === 1) return { status: 'INFO', detail: 'pip package not found' };
  if (r.code !== 0) return { status: 'WARN', detail: 'pip inventory failed' };
  const line = r.stdout.split(/\r?\n/).find(v => v.startsWith('Version:'));
  const version = line ? safeVersion(line.slice(8).trim()) : null;
  return version ? { status: 'OK', detail: `pip package v${version}` } : { status: 'WARN', detail: 'pip version response invalid' };
}
function codexMcpNames() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  if (!exists(file)) return [];
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => { const m = l.match(/^\s*\[mcp_servers\.([^\.\]]+)/); return m && m[1]; }).filter(Boolean); }
  catch { add('Codex', 'MCP configuration', 'WARN', 'configuration could not be read'); return []; }
}
const versions = new Map();
function checkCli(category, name, label, pkg, deps) { const v = cliVersion(name); versions.set(name, v); const nv = npmVersion(deps, pkg); if (v.status === 'MISSING' && nv) add(category, label, 'INFO', `CLI absent; npm global v${nv}`); else add(category, label, v.status, v.detail); }
function checkRemote(deps) {
  section('7. Remote npm update check');
  if (options.noRemote) {
    add('Remote', 'npm outdated', 'INFO', 'skipped because --no-remote was specified');
    return;
  }
  if (!commandPath('npm')) {
    add('Remote', 'npm outdated', 'MISSING', 'npm not found');
    return;
  }
  const r = run('npm', ['outdated', '-g', '--json']);
  if (r.reason) {
    add('Remote', 'npm outdated', 'WARN', r.reason);
    return;
  }
  const raw = r.stdout.trim();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  } else if (r.code === 0 && !r.stderr.trim()) {
    // npm outdated exits zero with no output when all tracked packages are current.
    data = {};
  }
  const packages = ['@colbymchenry/codegraph', '@fission-ai/openspec', '@openai/codex'];
  const hasStderr = Boolean(r.stderr.trim());
  const registryError = !data || typeof data !== 'object' || Array.isArray(data) || data.error;
  const hasUnexpectedExit = r.code !== 0 && !(r.code === 1 && data && typeof data === 'object' && !Array.isArray(data) && !data.error && Object.keys(data).length > 0 && !hasStderr);
  const uncertain = registryError || hasStderr || hasUnexpectedExit;
  if (uncertain) {
    let detail = data && data.error ? 'registry returned an error' : !raw ? 'registry returned no output' : !data ? 'registry returned non-JSON output' : 'registry response was incomplete';
    if (hasStderr) detail += '; registry diagnostics omitted';
    add('Remote', 'npm outdated', 'WARN', detail);
    if (!data || data.error) return;
  }
  for (const pkg of packages) {
    const item = data[pkg];
    const latest = item && safeVersion(item.latest);
    if (latest) add('Remote', pkg, 'UPDATE', `installed ${safeVersion(item.current) || 'unknown'}; latest ${latest}`);
    else if (item) add('Remote', pkg, 'WARN', 'registry package version invalid');
    else if (uncertain) add('Remote', pkg, 'INFO', 'registry response uncertain; package status unavailable');
    else if (npmVersion(deps, pkg)) add('Remote', pkg, 'OK', `installed v${npmVersion(deps, pkg)}; not listed as outdated`);
    else add('Remote', pkg, 'MISSING', 'not installed globally');
  }
}

const deps = npmGlobals();
const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json'));
const mcpConfigurations = discoverMcpConfigurations(os.homedir(), pluginInstallPaths(os.homedir(), enabledPluginIds(os.homedir())), options.projectPath);
const claudeMcp = new Set(mcpConfigurations.map(item => item.name));
const codexMcp = codexMcpNames();
section('1. Claude Code and plugins');
checkCli('Claude', 'claude', 'Claude Code CLI', '@anthropic-ai/claude-code', deps);
if (settings) add('Claude', 'enabledPlugins', 'INFO', `${Object.keys(settings.enabledPlugins || {}).length} configured`); else add('Claude', 'settings.json', 'WARN', 'not found or invalid JSON');
const cacheCount = countDirs(path.join(os.homedir(), '.claude', 'plugins', 'cache')); add('Claude', 'plugin cache', 'INFO', cacheCount == null ? 'not found' : `${cacheCount} marketplace cache directories`);
section('2. MCP servers'); if (claudeMcp.size) { add('MCP', 'Claude MCP servers', 'INFO', `${claudeMcp.size} configured; live availability unchecked`); for (const n of [...claudeMcp].sort()) add('MCP', n, 'INFO', 'configured; live availability unchecked'); } else add('MCP', 'Claude MCP servers', 'INFO', 'no configured entries found in supported local sources');
section('3. CodeGraph'); checkCli('CodeGraph', 'codegraph', 'CodeGraph CLI', '@colbymchenry/codegraph', deps); add('CodeGraph', 'Claude MCP registration', claudeMcp.has('codegraph') ? 'OK' : 'WARN', claudeMcp.has('codegraph') ? 'codegraph configured' : 'codegraph not found in Claude MCP config'); add('CodeGraph', 'Codex MCP registration', codexMcp.includes('codegraph') ? 'OK' : 'INFO', codexMcp.includes('codegraph') ? 'codegraph configured' : 'not registered in Codex config'); add('CodeGraph', 'project index', exists(path.join(options.projectPath, '.codegraph')) ? 'OK' : 'INFO', exists(path.join(options.projectPath, '.codegraph')) ? '.codegraph exists in project' : 'current project is not indexed'); add('CodeGraph', 'global index directory', exists(path.join(os.homedir(), '.claude', '.codegraph')) ? 'OK' : 'INFO', exists(path.join(os.homedir(), '.claude', '.codegraph')) ? 'global index exists' : 'not found');
section('4. OpenSpec'); checkCli('OpenSpec', 'openspec', 'OpenSpec CLI', '@fission-ai/openspec', deps); const specRoot = path.join(options.projectPath, 'openspec'); if (exists(specRoot)) add('OpenSpec', 'project directory', 'OK', `openspec/ exists; specs=${countDirs(path.join(specRoot, 'specs')) || 0}, changes=${countDirs(path.join(specRoot, 'changes')) || 0}`); else add('OpenSpec', 'project directory', 'INFO', 'current project has no openspec/ directory'); const omcp = pipVersion('openspec-mcp'); add('OpenSpec', 'openspec-mcp', omcp.status, omcp.detail); add('OpenSpec', 'Claude MCP registration', 'INFO', claudeMcp.has('openspec') ? 'openspec configured; live availability unchecked' : 'not found in supported local config'); add('OpenSpec', 'Codex MCP registration', 'INFO', codexMcp.some(n => n.includes('openspec')) ? 'openspec configured; live availability unchecked' : 'not found in supported local config');
section('5. Codex');
checkCli('Codex', 'codex', 'Codex CLI', '@openai/codex', deps);
const cconfig = path.join(os.homedir(), '.codex', 'config.toml');
add('Codex', 'config.toml', exists(cconfig) ? 'OK' : 'WARN', exists(cconfig) ? 'exists; sensitive values not printed' : 'not found');
const cv = readJson(path.join(os.homedir(), '.codex', 'version.json'));
if (cv) {
  const installed = versions.get('codex').version;
  const latest = safeVersion(cv.latest_version);
  if (installed && latest) add('Codex', 'version cache', compareVersion(installed, latest) < 0 ? 'UPDATE' : 'OK', `installed ${installed}; cached latest ${latest}`);
  else add('Codex', 'version cache', 'INFO', 'version comparison unavailable');
  const rawCheckedAt = cv.last_checked_at;
  let checkedAt = typeof rawCheckedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(rawCheckedAt) ? Date.parse(rawCheckedAt) : NaN;
  if (Number.isFinite(checkedAt) && new Date(checkedAt).toISOString().slice(0, 19) !== rawCheckedAt.slice(0, 19)) checkedAt = NaN;
  const age = (Date.now() - checkedAt) / 86400000;
  add('Codex', 'version cache age', !Number.isFinite(age) || age < 0 || age > 7 ? 'WARN' : 'OK', Number.isFinite(age) && age >= 0 ? `last checked ${age.toFixed(1)} days ago` : 'last_checked_at invalid or in the future');
} else add('Codex', 'version.json', 'INFO', 'not found or invalid JSON');
add('Codex', 'MCP servers', 'INFO', codexMcp.length ? `${codexMcp.length} configured; live availability unchecked` : 'none configured');
const codexSkills = countDirs(path.join(os.homedir(), '.codex', 'skills'));
add('Codex', 'skills', 'INFO', codexSkills == null ? 'skills directory not found' : `${codexSkills} installed`);
const codexRules = countDirs(path.join(os.homedir(), '.codex', 'rules'));
if (codexRules != null) add('Codex', 'rules', 'INFO', `${codexRules} installed`);
section('6. Skills'); for (const [label, dir, detail] of [['CC Switch skills', path.join(os.homedir(), '.cc-switch', 'skills'), 'update via CC Switch workflow'], ['Claude local skills', path.join(os.homedir(), '.claude', 'skills'), ''], ['Codex skills', path.join(os.homedir(), '.codex', 'skills'), '']]) { const n=countDirs(dir); add('Skills', label, 'INFO', n == null ? 'not found' : `${n} installed${detail ? `; ${detail}` : ''}`); }
checkRemote(deps);
const summary = { generated_at: new Date().toISOString(), project_path: options.projectPath, check_remote: !options.noRemote, no_remote: options.noRemote, has_update: hasUpdate, has_warn: hasWarn, has_error: hasError, item_count: rows.length };
let reportMessage = 'Report file skipped because --no-report was specified';
if (!options.noReport) {
  try {
    fs.mkdirSync(options.reportDirectory, { recursive: true });
    const report = path.join(options.reportDirectory, `update-report-${crypto.randomUUID()}.json`);
    fs.writeFileSync(report, JSON.stringify({ summary, items: rows }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    reportMessage = `Report saved: ${report}`;
  } catch {
    reportMessage = 'Report was not saved';
    add('Report', 'write report', 'WARN', 'report destination unavailable');
  }
}
summary.has_warn = hasWarn;
summary.item_count = rows.length;
section('8. Summary'); console.log(hasError ? '  Errors found; inspect ERROR rows.' : hasUpdate ? '  Updates available.' : hasWarn ? '  No confirmed updates, but warnings need attention.' : '  No confirmed updates in this check.'); console.log(`\n  ${reportMessage}`);
process.exitCode = 0;
