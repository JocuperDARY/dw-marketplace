'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = (script) => process.platform === 'win32'
  ? ['/d', '/s', '/c', `npm run ${script}`]
  : ['run', script];

function runNpm(script) {
  return childProcess.spawnSync(npm, npmArgs(script), {
    cwd: pluginRoot,
    encoding: 'utf8',
    timeout: 120000,
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

test('core entry point completes without an installed host harness', () => {
  const result = runNpm('test:core');
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass: \d+/);
  assert.match(result.stdout, /not-run: \d+/);
});

test('raw Windows platform entry point preserves the lifecycle guard', () => {
  if (process.platform !== 'win32') return;
  const result = runNpm('test:platform:windows');
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /LIFECYCLE_NOT_RUN:windows/);
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
