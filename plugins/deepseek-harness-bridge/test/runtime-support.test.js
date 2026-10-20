import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRuntimeSupport, RUNTIME_SUPPORT_HELPER } from '../src/runtime-support.js';

const exec = promisify(execFile);
const base = dirname(fileURLToPath(import.meta.url));
const helper = join(base, '../scripts/Invoke-BridgeProcess.ps1');
const child = join(base, 'fixtures/runtime-child.js');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windows = { skip: process.platform !== 'win32', timeout: 30000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-runtime-'));
  t.after(async () => {
    if (t.passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained runtime failure evidence: ${root}`);
  });
  return root;
}
async function invoke(root, { args = ['echo'], output = 'artifacts/run-001', exe = process.execPath, cwd = root, shell = 'powershell.exe' } = {}) {
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${quote(helper)}; Invoke-BridgeProcess -FilePath ${quote(exe)} -WorkingDirectory ${quote(cwd)} -OutputDirectory ${quote(output)} -ArgumentList @(${[child, ...args].map(quote).join(',')}) | ConvertTo-Json -Compress`;
  const result = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
}

test('runtime support stages helper hash and process-only manifest in an empty workspace', async t => {
  const root = await fixture(t);
  const workspace = join(root, 'new');
  const state = join(root, 'state');
  await mkdir(workspace); await mkdir(state); await writeFile(join(state, 'sentinel'), 'unchanged');
  const result = await stageRuntimeSupport(workspace, { nodePath: 'test-node', nodeVersion: '24.test' });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.deepEqual(await readdir(workspace), ['.bridge-runtime']);
  assert.equal(manifest.helper.relativePath, RUNTIME_SUPPORT_HELPER);
  assert.equal(manifest.helper.sha256, createHash('sha256').update(await readFile(result.helperPath)).digest('hex'));
  assert.equal(manifest.node.path, 'test-node');
  assert.equal(manifest.node.version, '24.test');
  assert.equal(manifest.node.childProcessVerified, false);
  assert.equal(manifest.node.evidence, 'current-bridge-process-only');
  assert.equal(await readFile(join(state, 'sentinel'), 'utf8'), 'unchanged');
  await assert.rejects(stageRuntimeSupport(workspace), { code: 'RUNTIME_SUPPORT_EXISTS' });
  await assert.rejects(stageRuntimeSupport(join(root, 'missing')), { code: 'ENOENT' });
});

test('runtime staging refuses occupied workspace and junction ancestry', windows, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'sentinel'), 'preserve');
  await assert.rejects(stageRuntimeSupport(root), { code: 'RUNTIME_SUPPORT_EXISTS' });
  const target = join(root, 'target'); await mkdir(target);
  const link = join(root, 'link'); await symlink(target, link, 'junction');
  await assert.rejects(stageRuntimeSupport(link), { code: 'RUNTIME_SUPPORT_REPARSE' });
  assert.deepEqual(await readdir(target), []);
});

test('real PowerShell preserves argv, cwd, stream bytes and nonzero exit', windows, async t => {
  const root = await fixture(t);
  const values = ['', 'a b', 'a"b', 'trailing slash\\', 'quoted end \\', '中文', '& | ; $() ` < > %PATH%', 'back\\\\"quote'];
  const receipt = await invoke(root, { args: ['echo', ...values] });
  assert.equal(receipt.exitCode, 7);
  assert.deepEqual(JSON.parse(await readFile(receipt.stdoutPath, 'utf8')), { args: values, cwd: root });
  assert.equal(await readFile(receipt.stderrPath, 'utf8'), 'stderr-中文');
  assert.equal(receipt.stdoutPath, join(root, 'artifacts/run-001/stdout.log'));
  assert.deepEqual(Object.keys(receipt).sort(), ['endedAt', 'exitCode', 'startedAt', 'stderrPath', 'stdoutPath']);
  assert.ok(Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt));
});

test('real PowerShell drains concurrent stdout and stderr beyond pipe buffers', windows, async t => {
  const root = await fixture(t);
  const receipt = await invoke(root, { args: ['large'] });
  assert.equal(receipt.exitCode, 0);
  for (const path of [receipt.stdoutPath, receipt.stderrPath]) assert.equal((await stat(path)).size, 2 * 1024 * 1024);
});

test('missing executable rejects without fabricating a receipt', windows, async t => {
  const root = await fixture(t);
  await assert.rejects(invoke(root, { exe: join(root, 'missing.exe') }), error => {
    assert.match(error.stderr, /no successful receipt/);
    assert.equal(error.stdout.trim(), '');
    return true;
  });
});

test('existing, traversal, rooted and junction output directories are rejected without overwrite', windows, async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'existing')); await writeFile(join(root, 'existing/sentinel'), 'preserve');
  const target = join(root, 'target'); await mkdir(target);
  await symlink(target, join(root, 'linked'), 'junction');
  for (const output of ['existing', '../escape', 'artifacts/../escape', join(root, 'absolute'), 'linked/new']) {
    await assert.rejects(invoke(root, { output }));
  }
  assert.equal(await readFile(join(root, 'existing/sentinel'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(stat(join(root, 'absolute')), { code: 'ENOENT' });
});

test('PowerShell 7 ArgumentList preserves Windows argv and streams', windows, async t => {
  const root = await fixture(t);
  const values = ['', 'space value', 'quote"value', 'ends with \\', '中文', '&;|$()`'];
  let shell;
  try {
    shell = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command pwsh.exe -ErrorAction Stop).Source'], { windowsHide: true })).stdout.trim();
  } catch { t.skip('PowerShell 7 is not installed'); return; }
  const receipt = await invoke(root, { args: ['echo', ...values], shell });
  assert.equal(receipt.exitCode, 7);
  assert.deepEqual(JSON.parse(await readFile(receipt.stdoutPath, 'utf8')), { args: values, cwd: root });
  assert.equal(await readFile(receipt.stderrPath, 'utf8'), 'stderr-中文');
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  for (const mode of ['write', 'flush', 'dispose', 'cancel', 'cancel-early-receipt']) {
    const earlyReceipt = mode === 'cancel-early-receipt';
    test(`${shell} ${mode} ${earlyReceipt ? 'control retains earlier receipt' : 'failure produces no receipt'} and releases its child and log handles`, windows, async t => {
      const root = await fixture(t);
      try { await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true }); }
      catch (error) { if (error.code === 'ENOENT') return t.skip(`${shell} is not installed`); throw error; }
      const result = await exec(shell, ['-NoProfile', '-NonInteractive', '-File', join(base, 'fixtures/runtime-process-harness.ps1'),
        '-Helper', helper, '-Node', process.execPath, '-Child', child, '-Root', root, '-Mode', mode],
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
      const observation = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
      t.diagnostic(JSON.stringify(observation));
      assert.equal(observation.receiptCount, earlyReceipt ? 1 : 0, JSON.stringify(observation));
      assert.ok(observation.failure, JSON.stringify(observation));
      assert.ok(Number(observation.childPid) > 0);
      assert.match(observation.childStartTicks, /^\d+$/);
      assert.equal(observation.childExited, true, JSON.stringify(observation));
      assert.deepEqual(observation.releasedLogs, ['stdout.log', 'stderr.log']);
      if (mode.startsWith('cancel') || mode === 'write') assert.equal(observation.completed, false);
      if (mode === 'write') assert.ok(observation.stdoutBytes > 0 && observation.stdoutBytes < 2 * 1024 * 1024);
      if (mode.startsWith('cancel')) {
        assert.match(observation.failure, /PipelineStoppedException$/);
        assert.ok(observation.stdoutBytes > 0 && observation.stderrBytes > 0);
      }
    });
  }
}
