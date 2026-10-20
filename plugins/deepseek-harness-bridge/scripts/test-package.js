import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// npm supplies its own CLI path; no shell command or guessed global installation.
assert.ok(process.env.npm_execpath, 'Run this check through npm run test:package');
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'dsh-package-check-'));
try {
  const { stdout } = await promisify(execFile)(process.execPath, [
    process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--offline',
    '--cache', join(temporary, 'cache'), '--pack-destination', temporary,
  ], { cwd: packageRoot, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  const [archive] = JSON.parse(stdout);
  const paths = new Set(archive.files.map(file => file.path));
  for (const path of ['plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json', 'launch.js',
    'scripts/Invoke-BridgeProcess.ps1', 'src/runtime-support.js', 'src/execution-guidance.js', 'docs/execution-efficiency.md']) {
    assert.ok(paths.has(path), `Actual npm archive is missing ${path}`);
  }
  console.log(`Archive verified: ${archive.filename}, ${archive.entryCount} entries`);
} finally {
  // Delete only this newly-created direct child of the OS temporary directory.
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(temporary.startsWith(join(tmpdir(), 'dsh-package-check-')));
  await rm(temporary, { recursive: true, force: true });
}
