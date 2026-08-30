'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = path.join(__dirname, 'test-runner.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-runner-'));
const manifestPath = path.join(root, 'manifest.json');
const node = process.execPath;

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

function run(suite) {
  return childProcess.spawnSync(node, [runner, '--manifest', manifestPath, '--suite', suite], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

fs.writeFileSync(manifestPath, JSON.stringify({
  suites: {
    core: {
      tests: [
        { name: 'core passes', command: node, args: ['-e', "console.log('core complete')"] },
        { name: 'inapplicable platform evidence', command: node, args: ['-e', "console.log('SKIP_NOT_APPLICABLE:windows:host is linux')"] },
      ],
    },
    'platform:windows': {
      requiredLifecycle: 'windows',
      tests: [
        { name: 'windows lifecycle skipped', command: node, args: ['-e', "console.log('SKIP_NOT_APPLICABLE:windows:no registered sandbox')"] },
      ],
    },
    hooks: {
      tests: [{ name: 'hook passes', command: node, args: ['-e', "console.log('hook complete')"] }],
    },
    all: {
      tests: [
        { name: 'core passes', command: node, args: ['-e', "console.log('core complete')"] },
        { name: 'inapplicable platform evidence', command: node, args: ['-e', "console.log('SKIP_NOT_APPLICABLE:windows:host is linux')"] },
        { name: 'windows lifecycle skipped', command: node, args: ['-e', "console.log('SKIP_NOT_APPLICABLE:windows:no registered sandbox')"] },
        { name: 'hook passes', command: node, args: ['-e', "console.log('hook complete')"] }],
    },
  },
}, null, 2));

try {
  test('core reports skips separately and marks unselected tests not-run', () => {
    const result = run('core');
    assert.strictEqual(result.error, undefined, result.error && result.error.message);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pass: 1/);
    assert.match(result.stdout, /fail: 0/);
    assert.match(result.stdout, /skip: 1/);
    assert.match(result.stdout, /not-run: 2/);
    assert.doesNotMatch(result.stdout, /pass: 2/);
  });

  test('a designated platform suite fails when its lifecycle evidence only skips', () => {
    const result = run('platform:windows');
    assert.strictEqual(result.error, undefined, result.error && result.error.message);
    assert.strictEqual(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /skip: 1/);
    assert.match(result.stdout, /not-run: 3/);
    assert.match(result.stderr, /LIFECYCLE_NOT_RUN:windows/);
  });

  test('a designated platform suite counts applicable lifecycle evidence as a pass', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.suites['platform:windows'].tests[0].args = [
      '-e',
      "console.log('SKIP_NOT_APPLICABLE:linux:host is win32');console.log('LIFECYCLE_RAN:windows')",
    ];
    manifest.suites.all.tests[2].args = manifest.suites['platform:windows'].tests[0].args;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = run('platform:windows');
    assert.strictEqual(result.error, undefined, result.error && result.error.message);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pass: 1/);
    assert.match(result.stdout, /skip: 1/);
    assert.match(result.stdout, /fail: 0/);
    assert.match(result.stdout, /not-run: 3/);
  });

  test('the complete suite reports no tests as not-run when it covers every test identity', () => {
    const result = run('all');
    assert.strictEqual(result.error, undefined, result.error && result.error.message);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pass: 3/);
    assert.match(result.stdout, /skip: 2/);
    assert.match(result.stdout, /not-run: 0/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) console.error('test runner behavior failed');
else console.log('test runner behavior passed');
