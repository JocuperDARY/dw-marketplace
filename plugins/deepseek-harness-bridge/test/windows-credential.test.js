import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredential } from '../launch.js';

test('Windows helper saves a DPAPI credential with inherited PS7 module paths, and launcher decrypts without printing it',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-key-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const keyDir = join(root, 'credential');
    const scriptPath = fileURLToPath(new URL('../scripts/set-api-key.ps1', import.meta.url));
    const windowsRoot = process.env.SYSTEMROOT || 'C:\\Windows';
    const program = 'function Read-Host { param($Prompt, [switch]$AsSecureString); if ($AsSecureString) { ConvertTo-SecureString "offline-fixture-key" -AsPlainText -Force } else { "" } }; & $env:BRIDGE_KEY_SCRIPT';
    const env = { ...process.env, BRIDGE_KEY_SCRIPT: scriptPath, BRIDGE_KEY_DIRECTORY: keyDir, DSH_BRIDGE_CONFIG_DIR: keyDir };
    delete env.DEEPSEEK_API_KEY;
    const { stdout } = await promisify(execFile)(join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', program], { env, windowsHide: true, timeout: 15000 });
    assert.ok(stdout.includes('Saved an encrypted credential'));
    assert.ok(!stdout.includes('offline-fixture-key'));
    assert.ok(!(await readFile(join(keyDir, 'api-key.dpapi'), 'utf8')).includes('offline-fixture-key'));
    await loadCredential(env);
    assert.equal(env.DEEPSEEK_API_KEY, 'offline-fixture-key');
  });
