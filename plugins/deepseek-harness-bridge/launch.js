#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localConfig, configurationDirectory } from './src/local-config.js';

const execute = promisify(execFile);

export async function loadCredential(env = process.env) {
  if (env.DEEPSEEK_API_KEY?.trim() || process.platform !== 'win32') return;
  const credentialPath = join(configurationDirectory(env), 'api-key.dpapi');
  try { await access(credentialPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // The path travels through an environment variable, never interpolated into PowerShell code.
  const script = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=ConvertTo-SecureString ([IO.File]::ReadAllText($env:DSH_BRIDGE_CREDENTIAL_PATH)); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $s.Dispose()}";
  try {
    const { stdout } = await execute(join(env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...env, DSH_BRIDGE_CREDENTIAL_PATH: credentialPath }, windowsHide: true, timeout: 10000, maxBuffer: 16384 });
    if (!stdout.trim()) throw new Error('Empty credential');
    env.DEEPSEEK_API_KEY = stdout.trim();
  } catch { throw new Error('Cannot decrypt the local API key. Run scripts/set-api-key.ps1 as the current Windows user.'); }
}

export async function launch(args = process.argv.slice(2)) {
  const config = await localConfig();
  if (config.nodePath && resolve(config.nodePath).toLowerCase() !== resolve(process.execPath).toLowerCase()) {
    if (!isAbsolute(config.nodePath) || process.env.DSH_BRIDGE_REEXEC === '1') throw new Error('Invalid configured Node runtime.');
    const child = spawn(config.nodePath, [fileURLToPath(import.meta.url), ...args], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, DSH_BRIDGE_REEXEC: '1' },
    });
    const stop = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try { await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; done(); }); }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    return;
  }
  if (config.dataDir) {
    if (!isAbsolute(config.dataDir)) throw new Error('Configured dataDir must be absolute.');
    process.env.DSH_BRIDGE_DATA_DIR ||= config.dataDir;
  }
  await loadCredential();
  const { main } = await import('./index.js');
  await main(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launch().catch(() => { process.stderr.write('DeepSeek bridge startup failed. Check Node, local config and the encrypted credential.\n'); process.exitCode = 1; });
}
