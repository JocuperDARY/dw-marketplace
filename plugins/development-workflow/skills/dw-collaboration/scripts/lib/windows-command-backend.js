'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { buildSupervisor } = require('../build-process-supervisor');

const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const COMMAND_TIMEOUT = 5000;
const CLOSE_TIMEOUT = 2500;
const IDENTIFIERS = ['pid', 'creationTimeFiletime', 'processHandleToken', 'parentPid',
  'parentCreationTimeFiletime', 'executablePath'];
const OPS = new Set(['observe', 'graceful', 'terminate', 'inputEof', 'release']);
const REASONS = new Set(['child_exit', 'terminated', 'graceful', 'released', 'timeout_elapsed', 'parent_exit',
  'control_eof', 'protocol_error', 'output_limit', 'transport_backpressure', 'transport_error', 'supervisor_error']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fault(message, code = 'DW_WINDOWS_PROTOCOL') {
  const error = new Error(message); error.code = code; return error;
}
function check(condition, message) { if (!condition) throw fault(message); }
function absolute(value) { return typeof value === 'string' && path.win32.isAbsolute(value) && !value.includes('\0'); }
function samePath(left, right) { return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase(); }
function checkIdentity(value) {
  check(object(value) && Object.keys(value).length === IDENTIFIERS.length && IDENTIFIERS.every(key => own(value, key)), 'Invalid native identity fields');
  check(integer(value.pid, 1) && integer(value.parentPid, 1), 'Invalid native process ids');
  check(typeof value.creationTimeFiletime === 'string' && typeof value.parentCreationTimeFiletime === 'string' && /^[1-9][0-9]{0,19}$/.test(value.creationTimeFiletime) && /^[1-9][0-9]{0,19}$/.test(value.parentCreationTimeFiletime), 'Invalid native process creation time');
  check(typeof value.processHandleToken === 'string' && /^[0-9a-f]{32}$/.test(value.processHandleToken), 'Invalid retained process handle token');
  check(absolute(value.executablePath), 'Invalid native executable path');
}
function sameIdentity(left, right) { return IDENTIFIERS.every(key => left[key] === right[key]); }
function checkState(state, terminal = false) {
  check(object(state) && typeof state.rootExited === 'boolean' && integer(state.activeProcesses, 0), 'Invalid native state');
  check(state.childExitCode === null || integer(state.childExitCode, -2147483648, 4294967295), 'Invalid native exit code');
  check(['running', 'verified_absent', 'unknown'].includes(state.cleanup), 'Invalid cleanup state');
  check(typeof state.forced === 'boolean', 'Invalid forced state');
  if (!terminal) check(typeof state.gracefulRequested === 'boolean', 'Invalid graceful state');
  if (terminal) check(state.cleanup !== 'running', 'Terminal cannot still be running');
  if (state.cleanup === 'verified_absent') check(state.rootExited && state.activeProcesses === 0 && state.childExitCode !== null, 'Cleanup lacks root and job absence proof');
}

// The decoder is also used by boundary tests; it does not manufacture process evidence.
class ManagedProtocol {
  constructor(session, binding, maxOutputBytes, executable) {
    this.session = session; this.binding = binding; this.maxOutputBytes = maxOutputBytes;
    this.executable = executable; this.identity = null; this.terminal = null; this.launchFailed = null;
    this.outputBytes = 0; this.seq = 0; this.stdout = []; this.stderr = [];
    this.pending = new Map(); this.lastRequestId = 0;
  }
  expect(id, op) { check(integer(id, 1) && id > this.lastRequestId && OPS.has(op), 'Invalid outgoing command'); this.lastRequestId = id; this.pending.set(id, op); }
  accept(record) {
    check(object(record) && record.v === 1 && record.session === this.session && record.binding === this.binding, 'Native protocol fence mismatch');
    check(typeof record.type === 'string', 'Missing native record type');
    if (record.type === 'started') {
      check(!this.identity && !this.launchFailed && !this.terminal, 'Duplicate or late started record');
      checkIdentity(record.identity);
      check(samePath(record.identity.executablePath, this.executable), 'Native executable identity mismatch');
      check(record.atomicJobBinding === true, 'Native launch lacks atomic Job binding');
      this.identity = Object.freeze({ ...record.identity });
    } else if (record.type === 'launchFailed') {
      check(!this.identity && !this.launchFailed && !this.terminal, 'Duplicate or late launch failure');
      check(typeof record.reason === 'string' && record.reason.length > 0 && record.reason.length <= 512, 'Invalid launch failure reason');
      check(record.nativeError === null || integer(record.nativeError, 0, 4294967295), 'Invalid native launch error');
      check(['never_created', 'created_reclaimed', 'unknown'].includes(record.startState), 'Invalid launch failure state');
      check(['verified_absent', 'unknown'].includes(record.cleanup), 'Invalid launch failure cleanup');
      check(record.startState !== 'unknown' || record.cleanup === 'unknown', 'Unproved launch cleanup');
      this.launchFailed = Object.freeze({ ...record });
    } else {
      check(this.identity !== null && !this.launchFailed, 'Native record precedes started');
      if (record.type === 'output') {
        check(!this.terminal && (record.stream === 'stdout' || record.stream === 'stderr'), 'Invalid or late output record');
        check(integer(record.seq, 1) && record.seq === this.seq + 1, 'Native output sequence mismatch');
        check(typeof record.data === 'string' && record.data.length <= MAX_LINE && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data), 'Invalid native base64 output');
        const bytes = Buffer.from(record.data, 'base64');
        check(bytes.toString('base64') === record.data, 'Noncanonical native base64 output');
        check(this.outputBytes + bytes.length <= this.maxOutputBytes, 'Native output exceeds shared byte limit');
        this.seq = record.seq; this.outputBytes += bytes.length; this[record.stream].push(bytes);
      } else if (record.type === 'response') {
        check(integer(record.id, 1) && this.pending.get(record.id) === record.op, 'Unrequested or duplicate native response');
        checkIdentity(record.identity); check(sameIdentity(record.identity, this.identity), 'Native response identity mismatch');
        checkState(record.state); this.pending.delete(record.id);
      } else if (record.type === 'terminal') {
        check(!this.terminal, 'Duplicate native terminal');
        checkIdentity(record.identity); check(sameIdentity(record.identity, this.identity), 'Native terminal identity mismatch');
        checkState(record, true); check(REASONS.has(record.reason), 'Invalid native terminal reason');
        check(record.atomicJobBinding === true && typeof record.outputComplete === 'boolean', 'Invalid native terminal evidence');
        check(record.outputBytes === this.outputBytes, 'Native output count mismatch');
        this.terminal = Object.freeze({ ...record, identity: this.identity });
      } else throw fault('Unknown native record type');
    }
    return record;
  }
}

function validate(options) {
  if (!object(options)) throw fault('Windows command options must be an object', 'DW_WINDOWS_OPTIONS');
  const value = { ...options, args: options.args === undefined ? [] : options.args,
    graceMs: options.graceMs === undefined ? 1000 : options.graceMs,
    maxOutputBytes: options.maxOutputBytes === undefined ? 8 * 1024 * 1024 : options.maxOutputBytes,
    retentionMs: options.retentionMs === undefined ? 30000 : options.retentionMs,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding };
  check(absolute(value.supervisorPath) && /\.exe$/i.test(value.supervisorPath), 'Absolute supervisor executable required');
  check(absolute(value.executable) && /\.exe$/i.test(value.executable), 'Absolute child executable required');
  check(Array.isArray(value.args) && value.args.length <= 4096 && value.args.every(arg => typeof arg === 'string' && !arg.includes('\0')) && value.args.reduce((size, arg) => size + arg.length, 0) <= 30000, 'Invalid child argument vector');
  check(absolute(value.cwd), 'Absolute cwd required');
  check(integer(value.timeoutMs, 1, 2147383647), 'Invalid finite timeoutMs');
  check(integer(value.graceMs, 0, 30000) && integer(value.maxOutputBytes, 1, MAX_OUTPUT) && integer(value.retentionMs, 1000, 300000), 'Invalid resource limits');
  check(value.binding === undefined || (typeof value.binding === 'string' && /^[0-9a-f]{64}$/.test(value.binding)), 'Invalid request binding');
  check(value.encoding === 'buffer' || (typeof value.encoding === 'string' && Buffer.isEncoding(value.encoding)), 'Invalid output encoding');
  check(value.env === undefined || (object(value.env) && Object.entries(value.env).every(([key, entry]) => key.length > 0 && !/[=\0]/.test(key) && typeof entry === 'string' && !entry.includes('\0'))), 'Invalid child environment');
  return value;
}

async function prepareWindowsCommandBackend(outputDirectory) {
  const result = buildSupervisor(outputDirectory);
  return Object.freeze({ ...result, supervisorPath: result.executable });
}

async function startWindowsCommand(options) {
  const opts = validate(options);
  if (process.platform !== 'win32') throw fault('Windows managed commands require Windows', 'DW_WINDOWS_UNSUPPORTED');
  const session = randomBytes(16).toString('hex');
  const binding = opts.binding || randomBytes(32).toString('hex');
  const decoder = new ManagedProtocol(session, binding, opts.maxOutputBytes, opts.executable);
  const child = spawn(opts.supervisorPath, ['--mode', 'managed', '--session', session, '--binding', binding,
    '--timeout-ms', String(opts.timeoutMs), '--max-output-bytes', String(opts.maxOutputBytes),
    '--retention-ms', String(opts.retentionMs), '--grace-ms', String(opts.graceMs), '--', opts.executable, ...opts.args],
  { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure = null, closed = false, released = false, releasing = null, terminalDone = false, startedDone = false;
  let nextId = 0, buffer = Buffer.alloc(0), diagnosticBytes = 0, shutdownTimer = null, forceTimer = null, commandTimers = new Map();
  let resolveStarted, resolveTerminal, resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const terminalReady = new Promise(resolve => { resolveTerminal = resolve; });
  const closedReady = new Promise(resolve => { resolveClosed = resolve; });
  const pending = new Map();
  function finishStarted() { if (!startedDone) { startedDone = true; resolveStarted(); } }
  function finishTerminal() { if (!terminalDone) { terminalDone = true; resolveTerminal(); } }
  function clearCommand(id) { clearTimeout(commandTimers.get(id)); commandTimers.delete(id); }
  function settlePending(error) { for (const [id, request] of pending) { clearCommand(id); request.reject(error); } pending.clear(); }
  function fail(error) {
    if (failure) return;
    failure = error; clearTimeout(executionTimer); settlePending(error); finishStarted(); finishTerminal();
    // EOF asks the retained native Job owner to reclaim its tree. Only this exact
    // ChildProcess may be killed if it fails to close; absence remains unknown.
    child.stdin.end();
    forceTimer = setTimeout(() => { if (!closed) child.kill(); }, CLOSE_TIMEOUT);
    shutdownTimer = setTimeout(() => {
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); resolveClosed(false); }
    }, CLOSE_TIMEOUT * 2);
  }
  const executionTimer = setTimeout(() => fail(fault('Native terminal deadline exceeded', 'DW_WINDOWS_DEADLINE')),
    opts.timeoutMs + opts.graceMs + 10000);
  const onError = error => fail(error);
  const onInputError = error => { if (!released && !closed) fail(error); };
  const onDiagnostic = data => {
    diagnosticBytes += data.length;
    if (diagnosticBytes > 65536) fail(fault('Native diagnostic limit exceeded'));
  };
  const onProtocol = data => {
    if (failure) return;
    try {
      buffer = Buffer.concat([buffer, data]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        check(end > 0 && end <= MAX_LINE, 'Invalid native record length');
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        const record = decoder.accept(JSON.parse(line.toString('utf8')));
        if (record.type === 'started') finishStarted();
        else if (record.type === 'launchFailed') {
          const error = fault(`Native launch failed: ${record.reason}`, 'DW_WINDOWS_LAUNCH');
          error.launchFailed = decoder.launchFailed; fail(error);
        } else if (record.type === 'terminal') { clearTimeout(executionTimer); finishTerminal(); }
        else if (record.type === 'response') {
          const request = pending.get(record.id); check(request !== undefined, 'Missing response waiter');
          pending.delete(record.id); clearCommand(record.id); request.resolve(record);
        }
      }
      check(buffer.length <= MAX_LINE, 'Native partial record exceeds byte limit');
    } catch (error) { fail(error); }
  };
  const onClose = () => {
    closed = true; clearTimeout(executionTimer); clearTimeout(forceTimer); clearTimeout(shutdownTimer);
    if (!failure && (buffer.length !== 0 || !decoder.terminal)) fail(fault('Native protocol closed without complete terminal'));
    settlePending(fault('Native supervisor closed', 'DW_WINDOWS_CLOSED')); finishStarted(); finishTerminal(); resolveClosed(true);
    clearTimeout(forceTimer); clearTimeout(shutdownTimer); detach();
  };
  function detach() {
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
    child.stdin.removeListener('error', onInputError);
    child.stdout.removeListener('data', onProtocol);
    child.stderr.removeListener('data', onDiagnostic);
  }
  child.on('error', onError); child.stdin.on('error', onInputError);
  child.stderr.on('data', onDiagnostic); child.stdout.on('data', onProtocol); child.once('close', onClose);
  function command(op) {
    if (failure) return Promise.reject(failure);
    if (closed || released) return Promise.reject(fault('Native session is closed', 'DW_WINDOWS_CLOSED'));
    if (pending.size >= 16) return Promise.reject(fault('Too many pending native commands'));
    const id = ++nextId; decoder.expect(id, op);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      commandTimers.set(id, setTimeout(() => fail(fault(`Native ${op} command timed out`, 'DW_WINDOWS_DEADLINE')), COMMAND_TIMEOUT));
      child.stdin.write(`${JSON.stringify({ v: 1, session, binding, id, op, processHandleToken: decoder.identity.processHandleToken })}\n`, error => { if (error) fail(error); });
    });
  }
  function result() {
    const terminal = failure ? null : decoder.terminal;
    const reason = failure ? (failure.code || 'native_failure') : terminal.reason;
    const normal = terminal && terminal.outputComplete && terminal.cleanup === 'verified_absent' && ['child_exit', 'terminated', 'graceful', 'released'].includes(reason);
    const error = failure || (!normal ? fault(`Native command ended: ${reason}`, 'DW_WINDOWS_EXECUTION') : null);
    const output = chunks => { const bytes = Buffer.concat(chunks); return opts.encoding === 'buffer' ? bytes : bytes.toString(opts.encoding); };
    return { status: terminal ? terminal.childExitCode : null, signal: null, error,
      stdout: output(decoder.stdout), stderr: output(decoder.stderr),
      cleanup: terminal ? terminal.cleanup : 'unknown', reason,
      outputComplete: !!terminal && terminal.outputComplete, terminal,
      launchFailed: decoder.launchFailed || undefined };
  }
  async function release() {
    if (releasing) return releasing;
    releasing = (async () => {
      let response = null, error = null;
      if (!failure && !closed) {
        try { response = await command('release'); } catch (caught) { error = caught; }
      }
      released = true; child.stdin.end();
      if (!closed && !shutdownTimer) {
        forceTimer = setTimeout(() => { if (!closed) child.kill(); }, CLOSE_TIMEOUT);
        shutdownTimer = setTimeout(() => { if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); resolveClosed(false); } }, CLOSE_TIMEOUT * 2);
      }
      const supervisorClosed = await closedReady;
      clearTimeout(forceTimer); clearTimeout(shutdownTimer); clearTimeout(executionTimer);
      if (!supervisorClosed) {
        if (!failure) failure = fault('Native supervisor did not close', 'DW_WINDOWS_CLOSE');
        child.stdout.removeListener('data', onProtocol); child.stderr.removeListener('data', onDiagnostic);
      }
      settlePending(failure || fault('Native session released', 'DW_WINDOWS_CLOSED'));
      return { supervisorClosed, cleanup: result().cleanup, response, error: error || failure };
    })();
    return releasing;
  }
  await started;
  if (failure || !decoder.identity) {
    const close = await release();
    const error = failure || fault('Native launch has no identity');
    error.cleanup = 'unknown'; error.supervisorClosed = close.supervisorClosed;
    if (decoder.launchFailed) { error.launchFailed = decoder.launchFailed; error.cleanup = decoder.launchFailed.cleanup; }
    throw error;
  }
  return Object.freeze({ session, binding, identity: decoder.identity,
    observe: () => command('observe'), gracefulStop: () => command('graceful'),
    terminate: () => command('terminate'), closeInput: () => command('inputEof'),
    wait: async () => { await terminalReady; return result(); }, release });
}

async function runWindowsCommand(options) {
  let session;
  try {
    session = await startWindowsCommand(options);
    await session.closeInput();
    await session.wait();
    const release = await session.release();
    const result = await session.wait();
    return { ...result, supervisorClosed: release.supervisorClosed, releaseError: release.error };
  } catch (error) {
    const release = session ? await session.release() : null;
    if (session) {
      const result = await session.wait();
      return { ...result, error: result.error || error, supervisorClosed: release.supervisorClosed, releaseError: release.error };
    }
    return { status: null, signal: null, error, stdout: '', stderr: '', cleanup: error.cleanup || 'unknown',
      reason: error.code || 'native_failure', outputComplete: false, terminal: null,
      launchFailed: error.launchFailed, supervisorClosed: release ? release.supervisorClosed : !!error.supervisorClosed };
  }
}

module.exports = { prepareWindowsCommandBackend, startWindowsCommand, runWindowsCommand, ManagedProtocol };
