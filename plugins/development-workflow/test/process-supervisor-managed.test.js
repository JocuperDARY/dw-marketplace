'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test, after } = require('node:test');
const { buildSupervisor } = require('../skills/dw-collaboration/scripts/build-process-supervisor');

if (process.platform !== 'win32') {
  console.log('SKIP_NOT_APPLICABLE:windows:managed native supervisor requires Windows');
  test('managed native supervisor requires Windows', { skip: true }, () => {});
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-managed-'));
  const executable = buildSupervisor(path.join(root, 'bin')).executable;
  const fixture = path.join(root, 'fixture.js');
  const session = '1'.repeat(32), binding = '2'.repeat(64);
  const owned = new Set();
  fs.writeFileSync(fixture, `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const [mode, marker] = process.argv.slice(2);
    setTimeout(() => process.exit(91), 14000).unref();
    if (mode === 'finite') { process.stdout.write('hello'); process.stderr.write('world'); }
    else if (mode === 'eof') { process.stdin.resume(); process.stdin.on('end', () => { console.log('eof'); setTimeout(() => process.exit(17), 100); }); }
    else if (mode === 'output') { const write = () => { while (process.stdout.write(Buffer.alloc(16384, 120))) {} }; process.stdout.on('drain', write); write(); }
    else if (mode === 'mixed-output') { process.stdout.write(Buffer.alloc(24000, 120)); process.stderr.write(Buffer.alloc(24000, 121)); setInterval(() => {}, 1000); }
    else if (mode === 'tree' || mode === 'exit-tree') {
      const child = spawn(process.execPath, [__filename, 'idle'], { detached: true, stdio: 'ignore' }); child.unref();
      fs.writeFileSync(marker, JSON.stringify([process.pid, child.pid]));
      if (mode === 'exit-tree') process.exit(23); else setInterval(() => {}, 1000);
    } else { setInterval(() => {}, 1000); }
  `);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, timeout = 7000) {
    const end = Date.now() + timeout;
    while (!check()) { assert(Date.now() < end, 'condition deadline exceeded'); await delay(15); }
  }
  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  const args = (mode, extra = [], marker = '') => ['--mode', 'managed', '--session', session, '--binding', binding,
    '--timeout-ms', '6000', '--max-output-bytes', '131072', '--retention-ms', '1000', '--grace-ms', '200',
    ...extra, '--', process.execPath, fixture, mode, marker];
  function start(mode, options = {}) {
    const cli = args(mode, options.extra, options.marker);
    if (options.maxOutputBytes) cli[cli.indexOf('--max-output-bytes') + 1] = String(options.maxOutputBytes);
    for (const [flag, value] of Object.entries(options.flags || {})) {
      const index = cli.indexOf(flag);
      if (index >= 0) cli[index + 1] = value;
      else cli.splice(cli.indexOf('--'), 0, flag, value);
    }
    if (options.childExecutable) cli[cli.indexOf('--') + 1] = options.childExecutable;
    const child = spawn(executable, cli, { windowsHide: true, cwd: root });
    owned.add(child); const records = []; let tail = '', stderr = '';
    if (options.capture !== false) child.stdout.on('data', data => {
      tail += data.toString('utf8'); assert(tail.length < 1024 * 1024);
      let end;
      while ((end = tail.indexOf('\n')) >= 0) {
        const record = JSON.parse(tail.slice(0, end)); tail = tail.slice(end + 1);
        assert.equal(record.v, 1); assert.equal(record.session, session); assert.equal(record.binding, binding);
        records.push(record);
      }
    });
    child.stderr.on('data', data => { stderr += data; assert(stderr.length < 65536); });
    child.stdin.on('error', () => {});
    const ceiling = setTimeout(() => child.kill(), 12000);
    const closed = once(child, 'close').then(([code, signal]) => {
      clearTimeout(ceiling); owned.delete(child); assert.equal(signal, null, stderr); return code;
    });
    closed.catch(() => {});
    let id = 0;
    const run = { child, records, closed, stderr: () => stderr,
      event: type => records.find(record => record.type === type),
      command(op, overrides = {}) {
        const command = { v: 1, session, binding, id: ++id, op,
          processHandleToken: run.event('started').identity.processHandleToken, ...overrides };
        child.stdin.write(`${JSON.stringify(command)}\n`); return command.id;
      },
      async wait(type) { await until(() => run.event(type)); return run.event(type); },
      async response(id) { await until(() => records.some(record => record.type === 'response' && record.id === id)); return records.find(record => record.type === 'response' && record.id === id); },
    };
    return run;
  }
  async function release(run) { const id = run.command('release'); const response = await run.response(id); assert.equal(response.state.cleanup, 'verified_absent'); assert.equal(await run.closed, 0); }
  after(() => {
    for (const child of owned) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('managed finite output has retained identity, monotonic output and terminal before release', async () => {
    const run = start('finite'); const started = await run.wait('started'); const terminal = await run.wait('terminal');
    assert.match(started.identity.creationTimeFiletime, /^\d+$/);
    assert.match(started.identity.parentCreationTimeFiletime, /^\d+$/);
    assert.match(started.identity.processHandleToken, /^[a-f0-9]{32}$/);
    assert.equal(started.identity.parentPid, process.pid); assert.equal(path.isAbsolute(started.identity.executablePath), true);
    assert.equal(started.atomicJobBinding, true); assert.equal(terminal.reason, 'child_exit'); assert.equal(terminal.cleanup, 'verified_absent');
    assert.equal(terminal.childExitCode, 0); assert.equal(terminal.outputComplete, true); assert.equal(terminal.outputBytes, 10);
    const outputs = run.records.filter(record => record.type === 'output');
    assert.deepEqual(outputs.map(record => record.seq), outputs.map((_, index) => index + 1));
    for (const [stream, expected] of [['stdout', 'hello'], ['stderr', 'world']])
      assert.equal(Buffer.concat(outputs.filter(record => record.stream === stream).map(record => Buffer.from(record.data, 'base64'))).toString(), expected);
    const response = await run.response(run.command('observe'));
    assert.deepEqual(response.identity, started.identity); assert.equal(response.state.cleanup, 'verified_absent');
    await release(run);
  });

  test('input EOF is acknowledged without terminating work still in progress', async () => {
    const run = start('eof'); await run.wait('started');
    const response = await run.response(run.command('inputEof')); assert.equal(response.state.gracefulRequested, false);
    const terminal = await run.wait('terminal'); assert.equal(terminal.childExitCode, 17); assert.equal(terminal.forced, false);
    await release(run);
  });

  test('timeout terminal retains identity and control until explicit release', async () => {
    const run = start('idle', { flags: { '--timeout-ms': '150', '--retention-ms': '3000' } });
    const started = await run.wait('started');
    const terminal = await run.wait('terminal');
    assert.equal(terminal.reason, 'timeout_elapsed');
    assert.equal(terminal.cleanup, 'verified_absent');
    const observed = await run.response(run.command('observe'));
    assert.deepEqual(observed.identity, started.identity);
    assert.equal(observed.state.cleanup, 'verified_absent');
    const stopped = await run.response(run.command('graceful'));
    assert.deepEqual(stopped.identity, started.identity);
    assert.equal(stopped.state.activeProcesses, 0);
    await release(run);
  });

  test('graceful EOF request and forced terminate act on the retained Job', async () => {
    const graceful = start('eof'); await graceful.wait('started');
    assert.equal((await graceful.response(graceful.command('graceful'))).state.gracefulRequested, true);
    assert.equal((await graceful.wait('terminal')).forced, false); await release(graceful);
    const forced = start('idle'); await forced.wait('started');
    const response = await forced.response(forced.command('terminate'));
    assert.equal(response.state.forced, true); assert.equal(response.state.cleanup, 'verified_absent');
    assert.equal((await forced.wait('terminal')).reason, 'terminated'); await release(forced);
  });

  test('mismatched capability, session, binding and replayed IDs reject without dispatch', async () => {
    for (const override of [{ processHandleToken: '0'.repeat(32) }, { session: '0'.repeat(32) }, { binding: '0'.repeat(64) }, { id: 1 }]) {
      const run = start('idle'); await run.wait('started'); await run.response(run.command('observe'));
      run.command('terminate', override); const terminal = await run.wait('terminal');
      assert.equal(terminal.reason, 'protocol_error'); assert.equal(terminal.cleanup, 'verified_absent');
      assert.equal(run.records.filter(record => record.type === 'response').length, 1); assert.equal(await run.closed, 0);
    }
  });

  test('unknown keys, duplicate keys and oversized control records fail closed', async () => {
    for (const invalid of ['{"v":1,"v":1}\n', `${' '.repeat(8193)}\n`, '{"unexpected":true}\n']) {
      const run = start('idle'); await run.wait('started'); run.child.stdin.write(invalid);
      assert.equal((await run.wait('terminal')).reason, 'protocol_error'); assert.equal(await run.closed, 0);
    }
  });

  test('managed flags are strict and terminal handles expire at the retention bound', async () => {
    for (const flags of [{ '--timeout-ms': '0' }, { '--max-output-bytes': '67108865' }, { '--retention-ms': '999' }, { '--receipt': path.join(root, 'forbidden') }]) {
      const invalid = start('idle', { flags }); assert.equal(await invalid.closed, 64); assert.equal(invalid.records.length, 0);
    }
    const run = start('finite'); await run.wait('terminal'); const ended = Date.now();
    assert.equal(await run.closed, 0); assert(Date.now() - ended < 2500);
  });

  test('missing executable reports never-created launch failure with native evidence', async () => {
    const run = start('idle', { childExecutable: path.join(root, 'missing.exe') });
    const failed = await run.wait('launchFailed');
    assert.equal(failed.startState, 'never_created'); assert.equal(failed.cleanup, 'verified_absent');
    assert.equal(failed.nativeError, 2); assert.equal(run.event('started'), undefined); assert.equal(await run.closed, 125);
  });

  test('shared raw output budget is capped and overflow stops the owned job', async () => {
    const run = start('mixed-output', { maxOutputBytes: 32768 });
    const terminal = await run.wait('terminal');
    assert.equal(terminal.reason, 'output_limit'); assert.equal(terminal.cleanup, 'verified_absent'); assert.equal(terminal.outputComplete, false);
    assert.equal(terminal.outputBytes, 32768);
    const outputs = run.records.filter(record => record.type === 'output');
    assert.equal(new Set(outputs.map(record => record.stream)).size, 2);
    assert.equal(outputs.reduce((sum, record) => sum + Buffer.from(record.data, 'base64').length, 0), 32768);
    await release(run);
  });

  test('natural root exit reclaims detached descendants before terminal', async () => {
    const marker = path.join(root, 'exit-tree.json'); const run = start('exit-tree', { marker });
    const terminal = await run.wait('terminal'); assert.equal(terminal.childExitCode, 23); assert.equal(terminal.cleanup, 'verified_absent');
    assert.equal(terminal.activeProcesses, 0); const pids = JSON.parse(fs.readFileSync(marker));
    await until(() => pids.every(pid => !alive(pid))); await release(run);
  });

  test('control EOF and the native hard deadline bound idle sessions', async () => {
    const eof = start('idle'); await eof.wait('started'); eof.child.stdin.end();
    assert.equal((await eof.wait('terminal')).reason, 'control_eof'); assert.equal(await eof.closed, 0);
    const timeoutArgs = args('idle').map((arg, index, all) => all[index - 1] === '--timeout-ms' ? '250' : arg);
    const child = spawn(executable, timeoutArgs, { windowsHide: true }); owned.add(child);
    let text = ''; child.stdout.on('data', data => { text += data; }); child.stdin.on('error', () => {});
    assert.equal((await once(child, 'close'))[0], 0); owned.delete(child);
    const terminal = text.trim().split('\n').map(JSON.parse).find(record => record.type === 'terminal');
    assert.equal(terminal.reason, 'timeout_elapsed'); assert.equal(terminal.cleanup, 'verified_absent');
  });

  test('blocked event consumer cannot prevent native deadline and owned-tree cleanup', async () => {
    const marker = path.join(root, 'blocked-tree.json');
    const code = `const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,[${JSON.stringify(fixture)},'idle'],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));process.stdout.write(Buffer.alloc(262144));setInterval(()=>{},1000);`;
    const cli = args('output').map((arg, index, all) => all[index - 1] === '--max-output-bytes' ? '67108864' : all[index - 1] === '--timeout-ms' ? '400' : arg);
    cli.splice(cli.indexOf('--') + 2, 3, '-e', code);
    const began = Date.now(); const child = spawn(executable, cli, { windowsHide: true }); owned.add(child); child.stdin.on('error', () => {});
    const [exit] = await once(child, 'exit'); assert.equal(exit, 0);
    assert(Date.now() - began >= 350, 'blocked consumer must not bypass the configured deadline');
    child.stdout.destroy(); child.stderr.destroy(); owned.delete(child);
    assert(fs.existsSync(marker)); await until(() => JSON.parse(fs.readFileSync(marker)).every(pid => !alive(pid)));
  });

  test('original controller death reclaims job even with inherited control input still open', async () => {
    const marker = path.join(root, 'parent-tree.json');
    const owner = spawn(process.execPath, ['-e', `
      const child=require('child_process').spawn(${JSON.stringify(executable)},${JSON.stringify(args('tree', [], marker))},
        {detached:true,windowsHide:true,stdio:['inherit','ignore','ignore']});
      console.log(child.pid);setInterval(()=>{},1000);setTimeout(()=>process.exit(92),10000);
    `], { windowsHide: true }); owned.add(owner);
    let supervisorPid; owner.stdout.on('data', data => { supervisorPid = Number(String(data).trim()); });
    await until(() => supervisorPid && fs.existsSync(marker)); const pids = [supervisorPid, ...JSON.parse(fs.readFileSync(marker))];
    const closed = once(owner, 'close'); owner.kill(); await closed; owned.delete(owner);
    await until(() => pids.every(pid => !alive(pid)));
  });
}
