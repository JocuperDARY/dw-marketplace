'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const scratchParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(scratchParent, 'dw-cu-'));
const checker = path.join(pluginRoot, 'skills/check-updates/scripts/check-updates.js');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const secret = 'fixture-secret-must-never-appear';

function audit(overrides = {}, args = []) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['npm', 'python', 'claude', 'codex', 'codegraph', 'openspec']) {
    fs.writeFileSync(path.join(bin, `${name}${process.platform === 'win32' ? '.cmd' : ''}`), 'fixture only');
  }
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { env: { TOKEN: secret } } } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '');
  fs.writeFileSync(path.join(home, '.codex/version.json'), JSON.stringify({ latest_version: '1.0.0', last_checked_at: overrides.cacheDate || new Date().toISOString() }));
  const preloader = path.join(home, 'external-command-fixture.cjs');
  fs.writeFileSync(preloader, `
    const path = require('path');
    const fixture = ${JSON.stringify(overrides)};
    require('os').homedir = () => ${JSON.stringify(home)};
    const fakeCommand = (command, args) => {
      const name = path.basename(command).replace(/\\.(cmd|exe)$/i, '');
      const target = name === 'cmd' ? path.basename(args[3]).replace(/\\.cmd$/i, '') : name;
      const result = { status: 0, stdout: '', stderr: '' };
      if (target === 'npm') {
        if (args.includes('outdated')) return { ...result, ...(fixture.remote || { stdout: '{}' }) };
        if (fixture.npmTimeout) return { ...result, status: null, error: { code: 'ETIMEDOUT' } };
        result.stdout = JSON.stringify({ dependencies: { '@openai/codex': { version: '1.0.0' } } });
      } else if (target === 'python') {
        if (fixture.pipTimeout) return { ...result, status: null, error: { code: 'ETIMEDOUT' } };
        result.stdout = 'Version: 1.0.0';
      } else {
        if (fixture.cliTimeout === target) return { ...result, status: null, error: { code: 'ETIMEDOUT' } };
        result.stdout = target + ' 1.0.0\\n' + (fixture.extraOutput || '');
        if (fixture.cliFailure === target) result.status = 7;
      }
      return result;
    };
    require('child_process').spawnSync = (command, args, options) => {
      if (args.some(value => String(value).endsWith('bounded-command-windows.ps1'))) {
        const request = JSON.parse(options.input);
        const native = fakeCommand(request.executable, request.args);
        return { status: 0, stdout: JSON.stringify({ status: native.error ? 'timed_out' : 'completed', cleanup: 'verified_absent', exitCode: native.status, stdout: native.stdout, stderr: native.stderr }), stderr: '' };
      }
      return fakeCommand(command, args);
    };
  `);
  const reportDirectory = overrides.reportDirectory || path.join(home, 'reports');
  const result = childProcess.spawnSync(process.execPath, ['--require', preloader, checker, '--report-directory', reportDirectory, ...args], {
    cwd: pluginRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: bin, npm_config_cache: path.join(home, 'npm-cache') },
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr);
  const files = fs.existsSync(reportDirectory) && fs.statSync(reportDirectory).isDirectory() ? fs.readdirSync(reportDirectory) : [];
  const report = files.length ? JSON.parse(fs.readFileSync(path.join(reportDirectory, files[0]), 'utf8')) : null;
  return { result, report, home, files };
}

test('CLI timeout is a warning in rows and summary, never a version', () => {
  const { report } = audit({ cliTimeout: 'codex' });
  const row = report.items.find(item => item.Category === 'Codex' && item.Component === 'Codex CLI');
  assert.strictEqual(row.Status, 'WARN');
  assert.strictEqual(report.summary.has_warn, true);
  assert(!report.items.some(item => item.Category === 'Codex' && item.Component === 'version cache' && item.Status === 'UPDATE'));
});

test('nonzero CLI exit stays a warning even when its output contains a version', () => {
  const { report } = audit({ cliFailure: 'claude' });
  assert.strictEqual(report.items.find(item => item.Component === 'Claude Code CLI').Status, 'WARN');
});

test('npm and pip timeouts remain warnings rather than package absence', () => {
  const { report } = audit({ npmTimeout: true, pipTimeout: true });
  assert.strictEqual(report.items.find(item => item.Component === 'npm globals').Status, 'WARN');
  assert.strictEqual(report.items.find(item => item.Component === 'openspec-mcp').Status, 'WARN');
});

test('external diagnostics and multiline version output never copy secrets into results', () => {
  const { report, result } = audit({ extraOutput: secret, remote: { status: 1, stdout: '{}', stderr: secret } });
  assert(!JSON.stringify(report).includes(secret));
  assert(!result.stdout.includes(secret));
  assert.strictEqual(report.items.find(item => item.Component === 'npm outdated').Status, 'WARN');
  assert.strictEqual(report.items.find(item => item.Component === 'Codex CLI').Detail, '1.0.0');
});

test('invalid and future cache timestamps warn', () => {
  for (const cacheDate of ['not-a-date', '2026-02-31T00:00:00Z', '2999-01-01T00:00:00Z']) {
    const { report } = audit({ cacheDate });
    assert.strictEqual(report.items.find(item => item.Component === 'version cache age').Status, 'WARN');
  }
});

test('registry version fields are validated before reaching output', () => {
  const { report, result } = audit({ remote: { status: 1, stdout: JSON.stringify({ '@openai/codex': { current: '1.0.0', latest: `2.0.0 ${secret}` } }) } });
  assert.strictEqual(report.items.find(item => item.Category === 'Remote' && item.Component === '@openai/codex').Status, 'WARN');
  assert(!result.stdout.includes(secret));
  assert(!JSON.stringify(report).includes(secret));
});

test('MCP configuration comes from supported configuration inventory without live claims', () => {
  const { report } = audit();
  const row = report.items.find(item => item.Category === 'MCP' && item.Component === 'codegraph');
  assert(row);
  assert.strictEqual(row.Status, 'INFO');
  assert(!JSON.stringify(report).includes(secret));
});

test('local no-report mode creates no report directory and reports no registry query', () => {
  const { report, files, result } = audit({}, ['--no-remote', '--no-report']);
  assert.strictEqual(report, null);
  assert.deepStrictEqual(files, []);
  assert(!result.stdout.includes('registry diagnostics omitted'));
});

test('reports use exclusive unique files and internally consistent row counts', () => {
  const reportDirectory = path.join(root, 'shared-reports');
  audit({ reportDirectory });
  audit({ reportDirectory });
  const names = fs.readdirSync(reportDirectory);
  assert.strictEqual(names.length, 2);
  for (const name of names) {
    const report = JSON.parse(fs.readFileSync(path.join(reportDirectory, name), 'utf8'));
    assert.strictEqual(report.summary.item_count, report.items.length);
  }
});

test('report write failure warns without printing raw filesystem diagnostics', () => {
  const reportDirectory = path.join(root, 'blocked-reports');
  fs.writeFileSync(reportDirectory, 'fixture');
  const { result } = audit({ reportDirectory }, ['--no-remote']);
  assert(result.stdout.includes('Report was not saved'));
  assert(!result.stdout.includes('EEXIST'));
});

function runBackend(args, timeoutMs = 3000, executable = process.execPath) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = childProcess.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(pluginRoot, 'skills/check-updates/scripts/bounded-command-windows.ps1')], {
    input: JSON.stringify({ executable, args, timeoutMs, maxOutputBytes: 4096 }),
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
    encoding: 'utf8', timeout: timeoutMs + 15000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Windows bounded backend captures output and proves an empty job', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows Job Object requires Windows'); return; }
  const result = runBackend(['-e', 'process.stdout.write("fixture-output")']);
  assert.strictEqual(result.status, 'completed', JSON.stringify(result));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout, 'fixture-output');
  assert.strictEqual(result.cleanup, 'verified_absent');
  assert.strictEqual(result.activeProcesses, 0);
  assert.strictEqual(result.atomicJobBinding, true);
});

test('Windows bounded backend times out and reclaims the owned job', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows Job Object requires Windows'); return; }
  const result = runBackend(['-e', 'setInterval(()=>{},1000)'], 100);
  assert.strictEqual(result.status, 'timed_out', JSON.stringify(result));
  assert.strictEqual(result.cleanup, 'verified_absent');
  assert.strictEqual(result.activeProcesses, 0);
});

test('Windows bounded backend reclaims descendants after their parent exits', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows Job Object requires Windows'); return; }
  const result = runBackend(['-e', 'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}).unref();process.stdout.write("parent-done")']);
  assert.strictEqual(result.status, 'completed', JSON.stringify(result));
  assert.strictEqual(result.stdout, 'parent-done');
  assert.strictEqual(result.cleanup, 'verified_absent');
  assert.strictEqual(result.activeProcesses, 0);
});

test('Windows bounded backend limits retained output bytes', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows Job Object requires Windows'); return; }
  const result = runBackend(['-e', 'process.stdout.write("x".repeat(8192))']);
  assert.strictEqual(result.status, 'output_limit', JSON.stringify(result));
  assert.strictEqual(Buffer.byteLength(result.stdout), 4096);
  assert.strictEqual(result.cleanup, 'verified_absent');
});

test('Windows command shim paths with spaces preserve ordinary arguments', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows command shims require Windows'); return; }
  const dir = path.join(root, 'shim folder (fixture)');
  fs.mkdirSync(dir);
  const shim = path.join(dir, 'npm.cmd');
  fs.writeFileSync(shim, '@echo off\r\nif /I "%1"=="list" (echo fixture-args-ok & exit /b 0)\r\nexit /b 7\r\n');
  const result = runBackend(['list', '-g', '--json'], 3000, shim);
  assert.strictEqual(result.status, 'completed', JSON.stringify(result));
  assert.strictEqual(result.exitCode, 0, JSON.stringify(result));
  assert.strictEqual(result.stdout.trim(), 'fixture-args-ok');
  assert.strictEqual(result.activeProcesses, 0);
});

test('Windows command shims preserve nonzero exit from nested batch branches', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows command shims require Windows'); return; }
  const shim = path.join(root, 'nested-exit.cmd');
  fs.writeFileSync(shim, [
    '@echo off',
    'if /I "%1"=="outdated" (',
    '  if /I "empty-error"=="empty" exit /b 0',
    '  if /I "empty-error"=="empty-error" exit /b 1',
    '  if /I "empty-error"=="outdated" (echo fixture-branch & exit /b 1)',
    ')', 'exit /b 0', '',
  ].join('\r\n'));
  const result = runBackend(['outdated', '-g', '--json'], 3000, shim);
  assert.strictEqual(result.status, 'completed', JSON.stringify(result));
  assert.strictEqual(result.exitCode, 1, JSON.stringify(result));
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.cleanup, 'verified_absent');
});

test('Windows CALL rejects caret paths before a second parse can select another shim', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows command shims require Windows'); return; }
  const intendedDirectory = path.join(root, 'caret^name');
  const shadowDirectory = path.join(root, 'caret^^name');
  fs.mkdirSync(intendedDirectory);
  fs.mkdirSync(shadowDirectory);
  fs.writeFileSync(path.join(intendedDirectory, 'fixture.cmd'), '@echo off\r\necho intended\r\n');
  fs.writeFileSync(path.join(shadowDirectory, 'fixture.cmd'), '@echo off\r\necho shadow-double\r\n');
  const result = runBackend([], 3000, path.join(intendedDirectory, 'fixture.cmd'));
  assert.strictEqual(result.status, 'hold', JSON.stringify(result));
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(result.atomicJobBinding, false);
  assert.strictEqual(result.cleanup, 'verified_absent');
});

test('an abrupt Windows backend exit after atomic creation reclaims its suspended child', () => {
  if (process.platform !== 'win32') { console.log('# SKIP Windows Job Object requires Windows'); return; }
  const original = fs.readFileSync(path.join(pluginRoot, 'skills/check-updates/scripts/bounded-command-windows.ps1'), 'utf8');
  const receipt = path.join(root, 'crash-created-pid.txt');
  const signal = path.join(root, 'crash-observer-ready.txt');
  const source = path.join(root, 'crash-backend.ps1');
  const anchor = 'result.atomicJobBinding = true;';
  assert.strictEqual(original.split(anchor).length, 2, 'fault injection point must be unique');
  fs.writeFileSync(source, original.replace(anchor, `${anchor}
            File.WriteAllText(${JSON.stringify(receipt)}, process.pid.ToString());
            for (int count = 0; count < 1000 && !File.Exists(${JSON.stringify(signal)}); count++) Thread.Sleep(10);
            Environment.Exit(86);`));
  const requestFile = path.join(root, 'crash-request.json');
  fs.writeFileSync(requestFile, JSON.stringify({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 3000, maxOutputBytes: 4096 }));
  const observer = path.join(root, 'crash-observer.ps1');
  const psQuote = value => `'${value.replace(/'/g, "''")}'`;
  fs.writeFileSync(observer, `
$ErrorActionPreference = 'Stop'
$backend = New-Object Diagnostics.Process
$backend.StartInfo.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$backend.StartInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ${psQuote(source)} + '"'
$backend.StartInfo.UseShellExecute = $false
$backend.StartInfo.CreateNoWindow = $true
$backend.StartInfo.RedirectStandardInput = $true
$backend.StartInfo.RedirectStandardOutput = $true
$backend.StartInfo.RedirectStandardError = $true
$owned = $null
try {
  $null = $backend.Start()
  $backend.StandardInput.Write([IO.File]::ReadAllText(${psQuote(requestFile)}))
  $backend.StandardInput.Close()
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists(${psQuote(receipt)}) -and -not $backend.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
  if (-not [IO.File]::Exists(${psQuote(receipt)})) { throw 'child creation receipt missing' }
  $createdPid = [int][IO.File]::ReadAllText(${psQuote(receipt)})
  $owned = [Diagnostics.Process]::GetProcessById($createdPid)
  $null = $owned.Handle # Bind the still-suspended, created child before allowing the fault.
  [IO.File]::WriteAllText(${psQuote(signal)}, 'observer-bound')
  if (-not $backend.WaitForExit(5000)) { throw 'faulting backend did not exit' }
  $absent = $owned.WaitForExit(5000)
  @{ backendExit = $backend.ExitCode; memberAbsent = $absent; observedBeforeCrash = $true } | ConvertTo-Json -Compress
} finally {
  if (-not $backend.HasExited) { $backend.Kill(); $null = $backend.WaitForExit(5000) }
  if ($owned) { $owned.Dispose() }
  $backend.Dispose()
}
`);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = childProcess.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', observer], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
    encoding: 'utf8', timeout: 25000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.strictEqual(evidence.backendExit, 86);
  assert.strictEqual(evidence.observedBeforeCrash, true);
  assert.strictEqual(evidence.memberAbsent, true);
});

let passed = 0;
try {
  for (const { name, fn } of tests) {
    try { fn(); passed += 1; console.log(`ok - ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`not ok - ${name}\n${error.stack}`); }
  }
} finally {
  assert(path.resolve(root).startsWith(scratchParent + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed}/${tests.length} check-updates behavior tests passed`);
