'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

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

function run(suite, env = process.env) {
  return childProcess.spawnSync(node, [runner, '--manifest', manifestPath, '--suite', suite], {
    encoding: 'utf8',
    env,
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

  test('suite runs cannot silently inherit a narrowed manager focus or transaction root', () => {
    const manifest = { suites: { all: { tests: [{
      name: 'unfocused fixture', command: node,
      args: ['-e', "if (process.env.DW_TASK_RESOURCE_TEST_FOCUS || process.env.DW_TRANSACTION_TEST_ROOT) process.exit(1); console.log('complete fixture selected')"],
    }] } } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run('all', { ...process.env, DW_TASK_RESOURCE_TEST_FOCUS: 'm2-v2-contract-v1', DW_TRANSACTION_TEST_ROOT: 'unexpected-override' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /complete fixture selected/);
  });
  function mockedRunner(outcomes) {
    const messages = [];
    let launches = 0;
    const manifest = { suites: { all: { tests: [
      { name: 'first', command: 'fixture-first' },
      { name: 'second', command: 'fixture-second' },
      { name: 'third', command: 'fixture-third' },
    ] } } };
    const fakeProcess = { argv: ['node', runner, '--manifest', 'fixture.json', '--suite', 'all'],
      env: {}, stdout: { write: text => messages.push(text) } };
    vm.runInNewContext(fs.readFileSync(runner, 'utf8'), {
      require: name => name === 'child_process' ? { spawnSync: () => {
        const result = outcomes[launches++];
        if (result instanceof Error) throw result;
        return result;
      } } : name === 'fs' ? { readFileSync: () => JSON.stringify(manifest) } : require(name),
      process: fakeProcess,
      console: { log: text => messages.push(text), error: text => messages.push(text) },
    }, { filename: runner });
    return { launches, output: messages.join('\n'), exitCode: fakeProcess.exitCode };
  }

  for (const code of ['ETIMEDOUT', 'ENOBUFS', 'ENOENT']) {
    test('execution error ' + code + ' stops subsequent suite launches with cleanup unknown', () => {
      const result = mockedRunner([{ error: Object.assign(new Error(code), { code }), status: null }]);
      assert.strictEqual(result.launches, 1);
      assert.strictEqual(result.exitCode, 1);
      assert.match(result.output, new RegExp('TEST_EXECUTION_ERROR:' + code));
      assert.match(result.output, /DESCENDANT_CLEANUP:UNKNOWN/);
      assert.match(result.output, /not-run: 2/);
      assert.match(result.output, /fail: 1/);
    });
  }
  test('a synchronous launch exception also stops subsequent launches', () => {
    const result = mockedRunner([Object.assign(new Error('launch failed'), { code: 'EACCES' })]);
    assert.strictEqual(result.launches, 1);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /DESCENDANT_CLEANUP:UNKNOWN/);
    assert.match(result.output, /not-run: 2/);
  });
  test('an interrupted child without an exit status stops the suite', () => {
    const result = mockedRunner([{ status: null, signal: 'SIGTERM' }]);
    assert.strictEqual(result.launches, 1);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /TEST_EXECUTION_ERROR:SIGTERM/);
    assert.match(result.output, /DESCENDANT_CLEANUP:UNKNOWN/);
    assert.match(result.output, /not-run: 2/);
  });
  test('a later execution error preserves earlier passes and counts only remaining tests', () => {
    const result = mockedRunner([{ status: 0 }, { status: null, error: { code: 'ETIMEDOUT' } }]);
    assert.strictEqual(result.launches, 2);
    assert.match(result.output, /pass: 1/);
    assert.match(result.output, /fail: 1/);
    assert.match(result.output, /not-run: 1/);
  });
  test('an ordinary failing exit retains the subsequent suite launches', () => {
    const result = mockedRunner([{ status: 1 }, { status: 0 }, { status: 0 }]);
    assert.strictEqual(result.launches, 3);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.output, /not-run: 0/);
    assert.match(result.output, /pass: 2/);
    assert.doesNotMatch(result.output, /DESCENDANT_CLEANUP/);
  });

  function hookObservationFixture(probeResult) {
    const file = path.join(__dirname, 'hooks.test.js');
    const source = fs.readFileSync(file, 'utf8').split('const retainedContractTests =')[0];
    const commands = [];
    const skips = [];
    const context = { require: name => name === 'child_process' ? {
      spawnSync: (command, args) => {
        commands.push([command, args]);
        if (probeResult instanceof Error) throw probeResult;
        return probeResult;
      },
    } : require(name), __dirname, process, console };
    const api = vm.runInNewContext(source + '\n;({ observeMarkerProcesses, assertOwnedProcessResult, setSkip: fn => { skipTest = fn; } })', context);
    api.setSkip(message => skips.push(message));
    return { ...api, commands, skips };
  }
  test('marker observations never terminate processes and residual matches remain cleanup unknown', () => {
    const fixture = hookObservationFixture({ status: 0, stdout: '1', stderr: '' });
    const probe = fixture.observeMarkerProcesses('fixture-marker');
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 0 }, probe, 'fixture-marker'), /CLEANUP_UNKNOWN/);
    assert.strictEqual(fixture.commands.length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.commands), /Stop-Process|taskkill|TerminateProcess/i);
  });
  test('failed execution is not hidden by unavailable process observation', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'Access is denied' });
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 9, stderr: 'original fixture failure' },
      fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker'), /original fixture failure/);
    assert.strictEqual(fixture.skips.length, 0);
  });
  test('observation exceptions cannot mask execution failures and do not trigger cleanup', () => {
    const fixture = hookObservationFixture(new Error('observation failed'));
    const probe = fixture.observeMarkerProcesses('fixture-marker');
    assert.throws(() => fixture.assertOwnedProcessResult({ error: new Error('original execution error') }, probe,
      'fixture-marker'), /original execution error/);
    assert.strictEqual(fixture.commands.length, 1);
  });
  test('unavailable observation only skips after successful execution with cleanup unknown', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'Access is denied' });
    fixture.assertOwnedProcessResult({ status: 0 }, fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker');
    assert.match(fixture.skips[0], /CLEANUP_UNKNOWN/);
  });
  test('failed observation after successful execution remains cleanup unknown', () => {
    const fixture = hookObservationFixture({ status: 1, stderr: 'CIM provider unavailable' });
    assert.throws(() => fixture.assertOwnedProcessResult({ status: 0 },
      fixture.observeMarkerProcesses('fixture-marker'), 'fixture-marker'), /CLEANUP_UNKNOWN/);
    assert.strictEqual(fixture.skips.length, 0);
  });

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) console.error('test runner behavior failed');
else console.log('test runner behavior passed');
