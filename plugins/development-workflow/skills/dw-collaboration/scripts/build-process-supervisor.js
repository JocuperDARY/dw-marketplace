#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.join(__dirname, 'process-supervisor', 'DwProcessSupervisor.cs');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Building is explicit. SessionStart and MCP launches never compile or install files.
function buildSupervisor(outputDirectory) {
  if (process.platform !== 'win32') throw new Error('Windows supervisor is unsupported on this platform');
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    throw new Error('An absolute --output-dir is required');
  }
  const sourceSha256 = sha256(fs.readFileSync(source));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const directory = fs.realpathSync(outputDirectory);
  const executable = path.join(directory, `dw-process-supervisor-${sourceSha256.slice(0, 20)}.exe`);
  const manifest = `${executable}.json`;
  const readExisting = () => {
    const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (record.sourceSha256 !== sourceSha256 || record.executableSha256 !== sha256(fs.readFileSync(executable))) {
      throw new Error('Supervisor integrity check failed; choose a new output directory or restore the damaged build');
    }
    return { ...record, executable };
  };
  if (fs.existsSync(executable) || fs.existsSync(manifest)) {
    try { return readExisting(); } catch (error) {
      throw new Error(`Supervisor integrity check failed: ${error.code || error.message}`);
    }
  }
  const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map(arch =>
    path.join(windowsDirectory, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('Installed .NET Framework C# compiler is unavailable');

  const temporary = path.join(directory, `.dw-build-${crypto.randomUUID()}.exe`);
  const lock = `${executable}.lock`;
  const lockFd = fs.openSync(lock, 'wx');
  try {
    // A concurrent completed build may have appeared between discovery and locking.
    if (fs.existsSync(executable) || fs.existsSync(manifest)) return readExisting();
    const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu',
      `/out:${temporary}`, source], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`Supervisor compilation failed: ${result.error?.code || result.stdout || result.stderr}`);
    }
    const record = { schemaVersion: 1, sourceSha256, executableSha256: sha256(fs.readFileSync(temporary)) };
    // Never replace a binary already used by another session; source changes get a new name.
    fs.copyFileSync(temporary, executable, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(manifest, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    return { ...record, executable };
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(lockFd);
    fs.rmSync(lock, { force: true });
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') {
      throw new Error('Usage: node build-process-supervisor.js --output-dir <absolute private directory>');
    }
    console.log(JSON.stringify(buildSupervisor(process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildSupervisor };
