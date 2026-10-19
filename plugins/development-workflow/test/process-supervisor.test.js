'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { test, after } = require('node:test');
const { buildSupervisor } = require('../skills/dw-collaboration/scripts/build-process-supervisor');

if (process.platform !== 'win32') {
  console.log('SKIP_NOT_APPLICABLE: Windows process supervisor requires Windows');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-supervisor-'));
  const fixture = path.join(root, 'fixture.js');
  const children = new Set();
  const binary = buildSupervisor(path.join(root, 'bin')).executable;
  fs.writeFileSync(fixture, `
    const fs = require('fs');
    const { spawn } = require('child_process');
    const [mode, marker] = process.argv.slice(2);
    const ceiling = setTimeout(() => process.exit(90), 15000); ceiling.unref();
    if (mode === 'echo') {
      process.stdin.pipe(process.stdout);
    } else if (mode === 'args') {
      process.stdout.write(JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), env: process.env.DW_FIXTURE_VALUE }));
    } else if (mode === 'graceful') {
      process.stdin.resume();
      process.stdin.on('end', () => { fs.writeFileSync(marker, 'graceful'); process.exit(0); });
      console.log('ready');
    } else if (mode === 'tree' || mode === 'exit-tree') {
      const child = spawn(process.execPath, [__filename, 'stubborn'], { detached: true, stdio: 'ignore' });
      child.unref();
      fs.writeFileSync(marker, JSON.stringify({ root: process.pid, child: child.pid }));
      if (mode === 'exit-tree') process.exit(23);
      process.stdin.resume(); setInterval(() => {}, 1000); console.log('ready');
    } else if (mode === 'output') {
      function write() { while (process.stdout.write(Buffer.alloc(65536, 120))) {} }
      process.stdout.on('drain', write); write();
    } else {
      process.stdin.resume(); setInterval(() => {}, 1000); console.log('ready');
    }
  `);

  after(() => {
    for (const child of children) child.kill();
    // This root is uniquely allocated by this test, never supplied by the caller.
    fs.rmSync(root, { recursive: true, force: true });
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) { assert(Date.now() < deadline, 'condition deadline exceeded'); await delay(20); }
  }
  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  function start(args, options = {}) {
    const child = spawn(binary, ['--grace-ms', '150', ...args], {
      cwd: root, windowsHide: true, env: { ...process.env, DW_FIXTURE_VALUE: 'preserved' },
    });
    children.add(child);
    let stdout = Buffer.alloc(0), stderr = '';
    if (options.capture !== false) child.stdout.on('data', data => {
      assert(stdout.length + data.length <= 2 * 1024 * 1024, 'test output cap');
      stdout = Buffer.concat([stdout, data]);
    });
    child.stderr.on('data', data => { stderr += data; assert(stderr.length < 256 * 1024); });
    child.stdin.on('error', () => {});
    const deadline = setTimeout(() => child.kill(), 10000);
    const closed = once(child, 'close').then(([code, signal]) => {
      clearTimeout(deadline); children.delete(child); assert.equal(signal, null, stderr); return code;
    });
    // Tests await closed explicitly; avoid a race with rejection reporting during setup.
    closed.catch(() => {});
    return { child, closed, stdout: () => stdout, stderr: () => stderr,
      report: () => JSON.parse(stderr.split(/\r?\n/).find(line => line.startsWith('DW_PROCESS_SUPERVISOR ')).slice(22)) };
  }
  const command = (mode, ...args) => ['--', process.execPath, fixture, mode, ...args];
  async function assertGone(pids) { await until(() => pids.every(pid => !alive(pid))); }

  test('build is reusable and detects a damaged cached binary', () => {
    assert.equal(buildSupervisor(path.join(root, 'bin')).executable, binary);
    const second = buildSupervisor(path.join(root, 'damaged')).executable;
    fs.appendFileSync(second, 'damage');
    assert.throws(() => buildSupervisor(path.join(root, 'damaged')), /integrity/i);
  });

  test('preserves binary stdio without supervisor text on stdout', async () => {
    const input = Buffer.from(Array.from({ length: 300000 }, (_, index) => index % 256));
    const run = start(command('echo'));
    run.child.stdin.end(input);
    assert.equal(await run.closed, 0, run.stderr());
    assert.deepEqual(run.stdout(), input);
    assert.equal(run.report().cleanup, 'verified_absent');
  });

  test('preserves argv, cwd and environment including empty/quoted/unicode arguments', async () => {
    const args = ['', 'space here', 'a"b', 'C:\\end\\', '中文 & % ! ()', 'line\nnext'];
    const direct = spawnSync(process.execPath, [fixture, 'args', ...args], {
      cwd: root, env: { ...process.env, DW_FIXTURE_VALUE: 'preserved' }, windowsHide: true,
    });
    const run = start(command('args', ...args));
    assert.equal(await run.closed, direct.status, run.stderr());
    assert.deepEqual(run.stdout(), direct.stdout);
  });

  test('EOF gives the server a graceful close window', async () => {
    const marker = path.join(root, 'graceful.txt');
    const run = start(['--grace-ms', '1500', ...command('graceful', marker)]);
    await until(() => run.stdout().includes('ready'));
    run.child.stdin.end();
    assert.equal(await run.closed, 0, run.stderr());
    assert.equal(fs.readFileSync(marker, 'utf8'), 'graceful');
    assert.equal(run.report().forced, false);
  });

  test('a graceful nonzero exit after EOF keeps its exit status', async () => {
    const run = start(['--grace-ms', '1500', '--', process.execPath, '-e',
      'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.exit(19),60))']);
    run.child.stdin.end();
    assert.equal(await run.closed, 19, run.stderr());
    assert.equal(run.report().forced, false);
  });

  test('command mode forwards EOF without cancelling a finite command still doing work', async () => {
    const run = start(['--mode', 'command', '--timeout-ms', '3000', '--', process.execPath, '-e',
      'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{console.log("done");process.exit(21)},400))']);
    run.child.stdin.end();
    assert.equal(await run.closed, 21, run.stderr());
    assert.equal(run.stdout().toString().trim(), 'done');
    assert.equal(run.report().reason, 'child_exit');
    assert.equal(run.report().forced, false);
  });

  test('EOF reclaims an uncooperative tree, while a quiet connected sibling survives', async () => {
    const marker = path.join(root, 'tree.json');
    const sibling = start(command('stubborn'));
    const run = start(command('tree', marker));
    await until(() => fs.existsSync(marker) && sibling.stdout().includes('ready'));
    const pids = Object.values(JSON.parse(fs.readFileSync(marker)));
    await delay(450);
    assert(alive(sibling.child.pid), 'quiet connected session must survive');
    run.child.stdin.end();
    assert.equal(await run.closed, 0, run.stderr());
    assert.equal(run.report().forced, true);
    assert.equal(run.report().activeProcesses, 0);
    assert.equal(run.report().childExitCode, 125, 'verified cleanup includes root-handle completion');
    await assertGone(pids);
    assert(alive(sibling.child.pid), 'cleanup crossed session boundary');
    sibling.child.stdin.end();
    assert.equal(await sibling.closed, 0);
  });

  test('root exit preserves its status and reclaims detached descendants', async () => {
    const marker = path.join(root, 'exit-tree.json');
    const run = start(command('exit-tree', marker));
    assert.equal(await run.closed, 23, run.stderr());
    assert.equal(run.report().reason, 'child_exit');
    assert.equal(run.report().cleanup, 'verified_absent');
    await assertGone(Object.values(JSON.parse(fs.readFileSync(marker))));
  });

  test('explicit lifetime timeout is bounded and verified', async () => {
    const run = start(['--timeout-ms', '250', ...command('stubborn')]);
    assert.equal(await run.closed, 124, run.stderr());
    assert.equal(run.report().reason, 'timeout_elapsed');
    assert.equal(run.report().cleanup, 'verified_absent');
  });

  test('abrupt supervisor death closes its private job and all descendants', async () => {
    const marker = path.join(root, 'crash-tree.json');
    const run = start(command('tree', marker));
    await until(() => fs.existsSync(marker));
    const pids = Object.values(JSON.parse(fs.readFileSync(marker)));
    run.child.kill();
    await run.closed.catch(() => {});
    await assertGone(pids);
  });

  test('original parent death is detected even when stdin remains open', async () => {
    const marker = path.join(root, 'parent-tree.json');
    const receipt = path.join(root, 'parent-receipt.json');
    const owner = spawn(process.execPath, ['-e', `
      const child = require('child_process').spawn(${JSON.stringify(binary)},
        ${JSON.stringify(['--grace-ms', '150', '--receipt', receipt, ...command('tree', marker)])},
        { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true, detached: true });
      console.log(child.pid); setInterval(() => {}, 1000);
      // Independent ceiling also applies if the outer test/manifest runner is killed.
      setTimeout(() => process.exit(91), 10000);
    `], { windowsHide: true });
    children.add(owner);
    let supervisorPid;
    owner.stdout.on('data', value => { supervisorPid = Number(String(value).trim()); });
    const ownerClosed = once(owner, 'close');
    await until(() => supervisorPid && fs.existsSync(marker));
    const pids = [supervisorPid, ...Object.values(JSON.parse(fs.readFileSync(marker)))];
    owner.kill(); await ownerClosed; children.delete(owner);
    await assertGone(pids);
    const report = JSON.parse(fs.readFileSync(receipt));
    assert.equal(report.reason, 'parent_exit');
    assert.equal(report.cleanup, 'verified_absent');
  });

  test('blocked output cannot prevent timeout teardown', async () => {
    const run = start(['--timeout-ms', '250', ...command('output')], { capture: false });
    const [code] = await once(run.child, 'exit');
    run.child.stdout.destroy();
    assert.equal(code, 124, run.stderr());
    await run.closed;
    assert.equal(run.report().cleanup, 'verified_absent');
  });

  test('transport failure tears down the owned job', async () => {
    const run = start(command('output'), { capture: false });
    run.child.stdout.destroy();
    assert.equal(await run.closed, 74, run.stderr());
    assert.equal(run.report().reason, 'transport_error');
    assert.equal(run.report().cleanup, 'verified_absent');
  });

  test('invalid launches and occupied receipts fail without replacing files or retrying', async () => {
    for (const executable of ['node.exe', path.join(root, 'missing.exe')]) {
      const run = start(['--', executable]);
      assert.notEqual(await run.closed, 0);
      assert.equal(run.report().childPid, null);
    }
    const receipt = path.join(root, 'existing.json');
    fs.writeFileSync(receipt, 'keep');
    const run = start(['--receipt', receipt, ...command('stubborn')]);
    assert.notEqual(await run.closed, 0);
    assert.equal(fs.readFileSync(receipt, 'utf8'), 'keep');
    assert.equal(run.report().childPid, null);
  });

  test('batch shims preserve ordinary arguments and reject ambiguous shell expansions', async () => {
    const shim = path.join(root, 'shim folder (fixture)', 'test.cmd');
    fs.mkdirSync(path.dirname(shim));
    fs.writeFileSync(shim, '@echo off\r\necho %~1\r\nexit /b 7\r\n');
    const run = start(['--', shim, 'space here']);
    assert.equal(await run.closed, 7, run.stderr());
    assert.equal(run.stdout().toString().trim(), 'space here');
    const invalid = start(['--', shim, '%PATH%']);
    assert.notEqual(await invalid.closed, 0);
    assert.equal(invalid.report().childPid, null);
  });

  test('explicit cmd launches retain the host argv quoting behavior', async () => {
    const cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
    const args = ['/d', '/s', '/c', 'echo', 'ordinary'];
    const direct = spawnSync(cmd, args, { windowsHide: true });
    const run = start(['--', cmd, ...args]);
    assert.equal(await run.closed, direct.status, run.stderr());
    assert.deepEqual(run.stdout(), direct.stdout);
  });

  test('records paired launch overhead without imposing a machine-dependent threshold', async () => {
    const directMs = [], supervisedMs = [], workingSets = [];
    for (let sample = 0; sample < 5; sample += 1) {
      let started = performance.now();
      const direct = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, timeout: 5000 });
      assert.equal(direct.status, 0);
      directMs.push(performance.now() - started);
      started = performance.now();
      const run = start(['--', process.execPath, '-e', 'process.exit(0)']);
      assert.equal(await run.closed, 0);
      supervisedMs.push(performance.now() - started);
      workingSets.push(run.report().workingSetBytes);
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log('SUPERVISOR_BENCHMARK ' + JSON.stringify({ samples: 5,
      directMedianMs: Math.round(median(directMs)), supervisedMedianMs: Math.round(median(supervisedMs)),
      supervisorMedianWorkingSetBytes: median(workingSets),
    }));
  });
}
