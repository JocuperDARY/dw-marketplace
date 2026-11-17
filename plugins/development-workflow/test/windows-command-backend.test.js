'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { ManagedProtocol, startWindowsCommand, runWindowsCommand, prepareWindowsCommandBackend } = require('../skills/dw-collaboration/scripts/lib/windows-command-backend');

const session = 'a'.repeat(32), binding = 'b'.repeat(64);
const identity = Object.freeze({ pid: 123, creationTimeFiletime: '133000000000000000',
  processHandleToken: 'c'.repeat(32), parentPid: 122, parentCreationTimeFiletime: '132999999999999999',
  executablePath: 'C:\\fixture\\node.exe' });
const envelope = value => ({ v: 1, session, binding, ...value });
const start = () => envelope({ type: 'started', identity, atomicJobBinding: true });
const terminal = extra => envelope({ type: 'terminal', identity, reason: 'child_exit', cleanup: 'verified_absent',
  rootExited: true, activeProcesses: 0, childExitCode: 7, forced: false, outputComplete: true,
  outputBytes: 0, atomicJobBinding: true, ...extra });
const decoder = max => new ManagedProtocol(session, binding, max || 100, identity.executablePath);

// These records exercise only the decoder. They are never evidence of host cleanup.
test('decoder fences session and binding before accepting a started record', () => {
  for (const mutation of [{ session: 'd'.repeat(32) }, { binding: 'd'.repeat(64) }, { v: 2 },
    { atomicJobBinding: false }, { identity: { ...identity, executablePath: 'C:\\other.exe' } }]) {
    assert.throws(() => decoder().accept({ ...start(), ...mutation }), /native|Native|Job/);
  }
});
test('decoder rejects identity drift and unrequested or duplicate responses', () => {
  const d = decoder(); d.accept(start()); d.expect(1, 'observe');
  const response = envelope({ type: 'response', id: 1, op: 'observe', identity,
    state: { rootExited: false, activeProcesses: 1, childExitCode: null, cleanup: 'running', gracefulRequested: false, forced: false } });
  assert.throws(() => d.accept({ ...response, identity: { ...identity, processHandleToken: 'd'.repeat(32) } }), /identity mismatch/);
  d.accept(response);
  assert.throws(() => d.accept(response), /Unrequested/);
  assert.throws(() => d.expect(1, 'observe'), /outgoing/);
});
test('decoder requires root and job proof before accepting verified absence', () => {
  for (const change of [{ rootExited: false }, { activeProcesses: 1 }, { childExitCode: null }, { atomicJobBinding: false }]) {
    const d = decoder(); d.accept(start()); assert.throws(() => d.accept(terminal(change)), /proof|evidence/);
  }
  const d = decoder(); d.accept(start()); d.accept(terminal()); assert.equal(d.terminal.childExitCode, 7);
  assert.throws(() => d.accept(terminal()), /Duplicate/);
});
test('decoder enforces global output ordering, canonical base64, shared byte budget and terminal total', () => {
  const d = decoder(3); d.accept(start());
  const out = (seq, stream, data) => envelope({ type: 'output', seq, stream, data });
  d.accept(out(1, 'stdout', 'YQ=='));
  assert.throws(() => d.accept(out(3, 'stderr', 'Yg==')), /sequence/);
  assert.throws(() => d.accept(out(2, 'stderr', 'YR==')), /canonical/);
  d.accept(out(2, 'stderr', 'YmM='));
  assert.throws(() => d.accept(out(3, 'stderr', 'ZA==')), /byte limit/);
  assert.throws(() => d.accept(terminal({ outputBytes: 2 })), /count mismatch/);
  d.accept(terminal({ outputBytes: 3 }));
  assert.equal(Buffer.concat(d.stdout).toString(), 'a');
  assert.equal(Buffer.concat(d.stderr).toString(), 'bc');
  assert.throws(() => d.accept(out(3, 'stdout', '')), /late/);
});
test('decoder rejects output before start and a late start after native launch failure', () => {
  const d = decoder();
  assert.throws(() => d.accept(envelope({ type: 'output', stream: 'stdout', seq: 1, data: '' })), /precedes/);
  d.accept(envelope({ type: 'launchFailed', reason: 'create_failed', nativeError: 2, startState: 'never_created', cleanup: 'verified_absent' }));
  assert.throws(() => d.accept(start()), /late/);
});
test('invalid launch options reject before any process is created', async () => {
  const base = { supervisorPath: 'C:\\no-supervisor.exe', executable: 'C:\\no-child.exe', cwd: 'C:\\fixture', timeoutMs: 1000 };
  for (const change of [{ executable: 'node' }, { supervisorPath: 'wrapper.cmd' }, { timeoutMs: Infinity },
    { timeoutMs: 0 }, { args: ['bad\0arg'] }, { env: { BAD: 1 } }, { maxOutputBytes: 67108865 },
    { graceMs: -1 }, { retentionMs: 10 }, { binding: 'x'.repeat(64) }, { cwd: '.' }]) {
    await assert.rejects(startWindowsCommand({ ...base, ...change }), /Invalid|Absolute/);
  }
});

if (process.platform === 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-managed-client-'));
  const fixture = path.join(root, 'fixture.js');
  fs.writeFileSync(fixture, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const [mode, marker] = process.argv.slice(2);
    setTimeout(() => process.exit(91), 12000).unref();
    if (mode === 'args') {
      process.stdout.write(JSON.stringify({args: process.argv.slice(3), cwd: process.cwd(), value: process.env.DW_TEST_VALUE}));
      process.stderr.write('stderr kept'); process.exitCode = 19;
    } else if (mode === 'eof') {
      process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => { console.log('after eof'); process.exit(17); }, 150));
    } else if (mode === 'flood') {
      process.stdout.write(Buffer.alloc(65536, 120)); process.stderr.write(Buffer.alloc(65536, 121)); setInterval(() => {}, 1000);
    } else if (mode === 'tree' || mode === 'exit-tree') {
      const p = spawn(process.execPath, [__filename, 'stubborn'], { detached: true, stdio: 'ignore' }); p.unref();
      fs.writeFileSync(marker, JSON.stringify({root: process.pid, child: p.pid}));
      if (mode === 'exit-tree') process.exit(23); else setInterval(() => {}, 1000);
    } else setInterval(() => {}, 1000);
  `);
  let prepared;
  const open = new Set();
  let allClosed = true;
  async function options(mode, ...args) {
    prepared ||= await prepareWindowsCommandBackend(path.join(root, 'bin'));
    return { supervisorPath: prepared.supervisorPath, executable: process.execPath, args: [fixture, mode, ...args],
      cwd: root, env: { ...process.env, DW_TEST_VALUE: '中文 & spaces' }, timeoutMs: 5000, graceMs: 100, retentionMs: 10000 };
  }
  async function managed(opts) { const s = await startWindowsCommand(opts); open.add(s); return s; }
  async function close(s) { const proof = await s.release(); open.delete(s); allClosed &&= proof.supervisorClosed; assert.equal(proof.supervisorClosed, true); return proof; }
  async function run(opts) { const result = await runWindowsCommand(opts); allClosed &&= result.supervisorClosed; return result; }
  after(async () => {
    for (const s of open) { try { const proof = await s.release(); allClosed &&= proof.supervisorClosed; } catch { allClosed = false; } }
    if (allClosed) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`Preserved native fixture after unproved supervisor closure: ${root}`);
  });
  test('real managed command preserves argv cwd environment output and ordinary nonzero exit', async () => {
    const args = ['', 'space here', 'a"b', 'C:\\end\\', '中文 & % ! ()', 'line\nnext'];
    const result = await run(await options('args', ...args));
    assert.equal(result.error, null); assert.equal(result.status, 19); assert.equal(result.cleanup, 'verified_absent');
    assert.equal(result.supervisorClosed, true); assert.equal(result.stderr, 'stderr kept');
    assert.deepEqual(JSON.parse(result.stdout), {args, cwd: root, value: '中文 & spaces'});
  });
  test('real input EOF does not cancel a finite child still completing work', async () => {
    const result = await run(await options('eof'));
    assert.equal(result.error, null); assert.equal(result.status, 17); assert.equal(result.stdout.trim(), 'after eof');
    assert.equal(result.terminal.forced, false); assert.equal(result.cleanup, 'verified_absent');
  });
  test('real retained sessions fence quiet siblings while terminating an owned tree', async () => {
    const sibling = await managed(await options('stubborn'));
    const marker = path.join(root, 'tree.json');
    const tree = await managed(await options('tree', marker));
    const observed = await tree.observe();
    assert.equal(observed.session, tree.session); assert.equal(observed.binding, tree.binding);
    assert.equal(observed.identity.processHandleToken, tree.identity.processHandleToken);
    await tree.terminate();
    const result = await tree.wait(); assert.equal(result.cleanup, 'verified_absent'); assert.equal(result.terminal.activeProcesses, 0);
    assert.equal((await sibling.observe()).state.rootExited, false);
    await close(tree); await sibling.terminate(); assert.equal((await sibling.wait()).cleanup, 'verified_absent'); await close(sibling);
  });
  test('real release while running reclaims child and confirms supervisor closure', async () => {
    const active = await managed(await options('stubborn'));
    const proof = await close(active);
    assert.equal(proof.cleanup, 'verified_absent');
    assert.equal(proof.response.op, 'release');
    assert.equal((await active.wait()).reason, 'released');
  });
  test('real graceful request remains fenced and stops an uncooperative child after grace', async () => {
    const active = await managed(await options('stubborn'));
    const response = await active.gracefulStop();
    assert.equal(response.op, 'graceful'); assert.equal(response.state.gracefulRequested, true);
    const result = await active.wait();
    assert.equal(result.reason, 'graceful'); assert.equal(result.cleanup, 'verified_absent');
    await close(active);
  });
  test('real root exit reclaims detached descendants while preserving root exit code', async () => {
    const result = await run(await options('exit-tree', path.join(root, 'exit-tree.json')));
    assert.equal(result.status, 23); assert.equal(result.cleanup, 'verified_absent'); assert.equal(result.terminal.activeProcesses, 0);
  });
  test('real native timeout and shared output cap report execution errors with cleanup proof', async () => {
    const timeout = await run({ ...await options('stubborn'), timeoutMs: 200 });
    assert.equal(timeout.reason, 'timeout_elapsed'); assert(timeout.error); assert.equal(timeout.cleanup, 'verified_absent');
    const output = await run({ ...await options('flood'), maxOutputBytes: 1024 });
    assert.equal(output.reason, 'output_limit'); assert(output.error); assert.equal(output.outputComplete, false);
    assert.equal(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr), 1024);
    assert.equal(output.cleanup, 'verified_absent');
  });
  test('a real nonprotocol executable closing cannot provide fabricated cleanup proof', async () => {
    const result = await run({ ...await options('args'), supervisorPath: process.execPath });
    assert(result.error); assert.equal(result.terminal, null); assert.equal(result.cleanup, 'unknown');
    assert.equal(result.supervisorClosed, true); assert.equal(result.outputComplete, false);
  });
  test('real launch failure reports native facts without invented identity', async () => {
    const result = await run({ ...await options('args'), executable: path.join(root, 'missing.exe'), args: [] });
    assert(result.error); assert.equal(result.terminal, null); assert(result.launchFailed, result.error.stack); assert.equal(result.launchFailed.startState, 'never_created');
    assert.equal(result.supervisorClosed, true);
  });
} else {
  test('Windows native integration is explicitly not applicable on this platform', { skip: 'requires Windows native Job Objects' }, () => {});
}
