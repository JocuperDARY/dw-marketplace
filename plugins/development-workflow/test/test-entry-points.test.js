'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npmEnvironment(env) {
  const result = { ...env };
  const pathKeys = Object.keys(result).filter(key => key.toLowerCase() === 'path');
  const inherited = pathKeys.length ? result[pathKeys[0]] : '';
  for (const key of pathKeys) delete result[key];
  // npm adds every ancestor's node_modules/.bin again on each nested run.
  // cmd.exe drops PATH once it exceeds its environment limit. This dependency-free
  // package only needs the original tools and the current Node installation.
  result.PATH = [...new Set([path.dirname(process.execPath), ...inherited.split(path.delimiter)
    .filter(entry => entry && !/(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$/i.test(entry))])].join(path.delimiter);
  return result;
}

function runNpm(script, env = process.env) {
  return childProcess.spawnSync(process.execPath, [npmCli, 'run', script], {
    cwd: pluginRoot,
    env: npmEnvironment(env),
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('complete test manifest retains entry-point behavior coverage', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'test', 'test-manifest.json'), 'utf8'));
  const completeFiles = manifest.suites.all.tests.flatMap((entry) => entry.args || []);
  assert(completeFiles.includes('test/test-entry-points.test.js'));
});

test('core entry point completes without an installed host harness', () => {
  const result = runNpm('test:core');
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass: \d+/);
  assert.match(result.stdout, /not-run: \d+/);
});

test('raw Windows platform entry point preserves the lifecycle guard', () => {
  if (process.platform !== 'win32') return;
  const env = { ...process.env };
  delete env.DW_PLATFORM_SANDBOX_ROOT;
  delete env.DW_PLATFORM_NATIVE_RUN_ID;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] += path.delimiter + Array.from({ length: 300 }, (_, index) =>
    path.join(pluginRoot, `nested-${index}`, 'node_modules', '.bin')).join(path.delimiter);
  assert(env[pathKey].length > 8191, 'fixture must reproduce nested npm PATH growth');
  const result = runNpm('test:platform:windows', env);
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /LIFECYCLE_NOT_RUN:windows/);
  assert.match(result.stdout, /NOT_RUN: DW_PLATFORM_SANDBOX_ROOT is required/);
  assert.doesNotMatch(result.stderr, /TEST_EXECUTION_ERROR:/);
});

test('synthetic host evidence data test names its non-live contract in output', () => {
  const result = childProcess.spawnSync(process.execPath, ['test/host-evidence-data.test.js'], {
    cwd: pluginRoot,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /synthetic host evidence data validator contract passed/);
  assert.doesNotMatch(result.stdout, /live harness/i);
});

if (process.exitCode) console.error('test entry point behavior failed');
else console.log('test entry point behavior passed');
