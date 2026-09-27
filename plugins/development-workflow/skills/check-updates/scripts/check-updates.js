'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
function commandPath(name) {
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
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep searching */ }
  }
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(resolver, [name], { encoding: 'utf8', timeout: options.timeoutSec * 1000, windowsHide: true });
  return result.status === 0 ? String(result.stdout).split(/\r?\n/).find(Boolean) : null;
}
function run(name, args = []) {
  const executable = commandPath(name) || name;
  const isWindowsCmd = process.platform === 'win32' && /.cmd$/i.test(executable);
  const command = isWindowsCmd ? (process.env.ComSpec || 'cmd.exe') : executable;
  const commandArgs = isWindowsCmd ? ['/d', '/c', 'call', executable, ...args] : args;
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: options.timeoutSec * 1000, windowsHide: true, shell: false });
  if (result.error && result.error.code === 'ETIMEDOUT') return { timedOut: true, code: null, stdout: '', stderr: 'command timed out' };
  return { timedOut: false, code: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), error: result.error };
}
function cliVersion(name) {
  if (!commandPath(name)) return null;
  const r = run(name, ['--version']);
  if (r.timedOut) return 'WARN: command timed out';
  const text = (r.stdout || r.stderr).trim().split(String.fromCharCode(13, 10))[0] || '';
  return text && !/[0-9]+[.][0-9]+(?:[.][0-9]+)?/.test(text)
    ? 'WARN: command timed out or returned no version'
    : (text || null);
}


function normalizeVersion(v) { const m = String(v || '').match(/\d+(?:\.\d+){0,2}/); return m ? m[0].split('.').map(Number) : null; }
function compareVersion(a, b) { const x = normalizeVersion(a) || [0], y = normalizeVersion(b) || [0]; for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
function npmGlobals() { if (!commandPath('npm')) return null; const r = run('npm', ['list', '-g', '--depth=0', '--json']); try { return JSON.parse(r.stdout); } catch { return {}; } }
function npmVersion(deps, pkg) { return deps && deps.dependencies && deps.dependencies[pkg] ? String(deps.dependencies[pkg].version || deps.dependencies[pkg]) : null; }
function pipVersion(pkg) { if (!commandPath('python')) return null; const r = run('python', ['-m', 'pip', 'show', pkg]); const line = r.stdout.split(/\r?\n/).find(v => v.startsWith('Version:')); return line ? line.slice('Version:'.length).trim() : null; }
function mcpNames(settings) { const names = new Set(Object.keys((settings && settings.mcpServers) || {})); const dirs = path.join(os.homedir(), '.claude', 'mcp-configs'); if (exists(dirs)) for (const e of fs.readdirSync(dirs)) names.add(e.replace(/\.(json|jsonc)$/i, '')); return names; }
function codexMcpNames() { const file = path.join(os.homedir(), '.codex', 'config.toml'); if (!exists(file)) return []; return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => { const m = l.match(/^\s*\[mcp_servers\.([^\.\]]+)/); return m && m[1]; }).filter(Boolean); }
function checkCli(category, name, label, pkg, deps) { const v = cliVersion(name); const nv = npmVersion(deps, pkg); if (v) add(category, label, 'OK', v); else if (nv) add(category, label, 'INFO', `CLI absent; npm global v${nv}`); else add(category, label, 'MISSING', `${name} not found on PATH`); }
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
  if (r.timedOut) {
    add('Remote', 'npm outdated', 'WARN', 'registry check timed out');
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
    if (hasStderr) detail += `; ${r.stderr.trim().split(/\r?\n/)[0]}`;
    add('Remote', 'npm outdated', 'WARN', detail);
    if (!data || data.error) return;
  }
  for (const pkg of packages) {
    const item = data[pkg];
    if (item && item.latest) add('Remote', pkg, 'UPDATE', `installed ${item.current || 'unknown'}; latest ${item.latest}`);
    else if (uncertain) add('Remote', pkg, 'INFO', 'registry response uncertain; package status unavailable');
    else if (npmVersion(deps, pkg)) add('Remote', pkg, 'OK', `installed v${npmVersion(deps, pkg)}; not listed as outdated`);
    else add('Remote', pkg, 'MISSING', 'not installed globally');
  }
}

const deps = npmGlobals();
const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json'));
const claudeMcp = mcpNames(settings);
const codexMcp = codexMcpNames();
section('1. Claude Code and plugins');
const claude = cliVersion('claude'); if (claude) add('Claude', 'Claude Code CLI', 'OK', claude); else add('Claude', 'Claude Code CLI', 'MISSING', 'claude not found on PATH');
if (settings) add('Claude', 'enabledPlugins', 'INFO', `${Object.keys(settings.enabledPlugins || {}).length} configured`); else add('Claude', 'settings.json', 'WARN', 'not found or invalid JSON');
const cacheCount = countDirs(path.join(os.homedir(), '.claude', 'plugins', 'cache')); add('Claude', 'plugin cache', 'INFO', cacheCount == null ? 'not found' : `${cacheCount} marketplace cache directories`);
section('2. MCP servers'); if (claudeMcp.size) { add('MCP', 'Claude MCP servers', 'OK', `${claudeMcp.size} configured`); for (const n of [...claudeMcp].sort()) add('MCP', n, 'INFO', 'configured; command details omitted'); } else add('MCP', 'Claude MCP servers', 'WARN', 'none found in settings or mcp-configs');
section('3. CodeGraph'); checkCli('CodeGraph', 'codegraph', 'CodeGraph CLI', '@colbymchenry/codegraph', deps); add('CodeGraph', 'Claude MCP registration', claudeMcp.has('codegraph') ? 'OK' : 'WARN', claudeMcp.has('codegraph') ? 'codegraph configured' : 'codegraph not found in Claude MCP config'); add('CodeGraph', 'Codex MCP registration', codexMcp.includes('codegraph') ? 'OK' : 'INFO', codexMcp.includes('codegraph') ? 'codegraph configured' : 'not registered in Codex config'); add('CodeGraph', 'project index', exists(path.join(options.projectPath, '.codegraph')) ? 'OK' : 'INFO', exists(path.join(options.projectPath, '.codegraph')) ? '.codegraph exists in project' : 'current project is not indexed'); add('CodeGraph', 'global index directory', exists(path.join(os.homedir(), '.claude', '.codegraph')) ? 'OK' : 'INFO', exists(path.join(os.homedir(), '.claude', '.codegraph')) ? 'global index exists' : 'not found');
section('4. OpenSpec'); checkCli('OpenSpec', 'openspec', 'OpenSpec CLI', '@fission-ai/openspec', deps); const specRoot = path.join(options.projectPath, 'openspec'); if (exists(specRoot)) add('OpenSpec', 'project directory', 'OK', `openspec/ exists; specs=${countDirs(path.join(specRoot, 'specs')) || 0}, changes=${countDirs(path.join(specRoot, 'changes')) || 0}`); else add('OpenSpec', 'project directory', 'INFO', 'current project has no openspec/ directory'); const omcp = pipVersion('openspec-mcp'); add('OpenSpec', 'openspec-mcp', omcp ? 'OK' : 'INFO', omcp ? `pip package v${omcp}` : 'pip package not found'); add('OpenSpec', 'Claude MCP registration', claudeMcp.has('openspec') ? 'OK' : 'INFO', claudeMcp.has('openspec') ? 'openspec configured' : 'not registered in Claude MCP config'); add('OpenSpec', 'Codex MCP registration', codexMcp.some(n => n.includes('openspec')) ? 'OK' : 'INFO', codexMcp.some(n => n.includes('openspec')) ? 'openspec configured' : 'not registered in Codex config');
section('5. Codex'); checkCli('Codex', 'codex', 'Codex CLI', '@openai/codex', deps); const cconfig=path.join(os.homedir(), '.codex', 'config.toml'); add('Codex', 'config.toml', exists(cconfig) ? 'OK' : 'WARN', exists(cconfig) ? 'exists; sensitive values not printed' : 'not found'); const cv=readJson(path.join(os.homedir(), '.codex', 'version.json')); if (cv) { const installed=cliVersion('codex'); const latest=cv.latest_version; if (installed && latest) add('Codex', 'version cache', compareVersion(installed, latest) < 0 ? 'UPDATE' : 'OK', `installed ${installed}; cached latest ${latest}`); else add('Codex', 'version cache', 'INFO', 'version.json exists'); if (cv.last_checked_at) { const age=(Date.now()-Date.parse(cv.last_checked_at))/86400000; add('Codex', 'version cache age', Number.isFinite(age) && age > 7 ? 'WARN' : 'OK', Number.isFinite(age) ? `last checked ${age.toFixed(1)} days ago` : 'last_checked_at could not be parsed'); } } else add('Codex', 'version.json', 'INFO', 'not found'); add('Codex', 'MCP servers', codexMcp.length ? 'OK' : 'INFO', codexMcp.length ? codexMcp.join(', ') : 'none configured'); const codexSkills=countDirs(path.join(os.homedir(), '.codex', 'skills')); add('Codex', 'skills', 'INFO', codexSkills == null ? 'skills directory not found' : `${codexSkills} installed`); const codexRules=countDirs(path.join(os.homedir(), '.codex', 'rules')); if (codexRules != null) add('Codex', 'rules', 'INFO', `${codexRules} installed`);
section('6. Skills'); for (const [label, dir, detail] of [['CC Switch skills', path.join(os.homedir(), '.cc-switch', 'skills'), 'update via CC Switch workflow'], ['Claude local skills', path.join(os.homedir(), '.claude', 'skills'), ''], ['Codex skills', path.join(os.homedir(), '.codex', 'skills'), '']]) { const n=countDirs(dir); add('Skills', label, 'INFO', n == null ? 'not found' : `${n} installed${detail ? `; ${detail}` : ''}`); }
checkRemote(deps);
const summary={generated_at:new Date().toISOString(),project_path:options.projectPath,check_remote:!options.noRemote,no_remote:options.noRemote,has_update:hasUpdate,has_warn:hasWarn,has_error:hasError,item_count:rows.length};
let reportMessage='Report file skipped because --no-report was specified'; if (!options.noReport) { try { fs.mkdirSync(options.reportDirectory,{recursive:true}); const report=path.join(options.reportDirectory,`update-report-${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,15)}.json`); fs.writeFileSync(report,JSON.stringify({summary,items:rows},null,2)+'\n',{encoding:'utf8'}); reportMessage=`Report saved: ${report}`; } catch (e) { hasWarn=true; summary.has_warn=true; reportMessage='Report was not saved'; add('Report','write report','WARN',e.message); } }
section('8. Summary'); console.log(hasError ? '  Errors found; inspect ERROR rows.' : hasUpdate ? '  Updates available.' : hasWarn ? '  No confirmed updates, but warnings need attention.' : '  No confirmed updates in this check.'); console.log(`\n  ${reportMessage}`);
process.exitCode = 0;
