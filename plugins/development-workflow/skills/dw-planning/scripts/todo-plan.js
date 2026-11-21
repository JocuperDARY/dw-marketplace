#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/todo-plan-store');
const render = require('./lib/todo-plan-render');

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--no-sync',
  '--stdin',
  '--help',
  '-h',
  '--no-color',
  '--force',
  '--exclusive',
  '--reassign',
  '--allow-unmet-deps',
  '--unlink-deps',
  '--purge',
  '--reset-status',
  '--chain',
  '--parallel',
  '--watch',
  '--allow-non-tty',
  '--shared',
]);

const REPEATABLE_FLAGS = new Set([
  '--evidence',
  '--into',
  '--depends-on',
  '--order',
]);

const VALUE_FLAGS = new Set([
  '--file',
  '--root',
  '--expected-revision',
  '--request-id',
  '--actor',
  '--role',
  '--lock-wait-ms',
  '--sync-md',
  '--sync-html',
  '--title',
  '--goal',
  '--plan-id',
  '--id',
  '--phase',
  '--acceptance',
  '--owner',
  '--status',
  '--reason',
  '--note',
  '--before',
  '--after',
  '--during',
  '--move-to-phase',
  '--format',
  '--out',
  '--max-seconds',
  '--max-events',
  '--expected-nonce',
]);

const VALID_RENDER_FORMATS = new Set(['terminal', 'text', 'brief', 'markdown', 'md', 'html']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function makeError(code, message, details) {
  if (typeof store.TodoPlanError === 'function') {
    return new store.TodoPlanError(code, message, details);
  }
  const err = new Error(message);
  err.code = code;
  err.details = details || null;
  err.exitCode = (store.EXIT_CODES && store.EXIT_CODES[code] !== undefined) ? store.EXIT_CODES[code] : 2;
  return err;
}

function assertNoDangerousKeys(value, seen = new Set()) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoDangerousKeys(item, seen);
    }
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw makeError('INVALID_ARGUMENT', `Forbidden key "${key}" in JSON input`, { key });
    }
    assertNoDangerousKeys(value[key], seen);
  }
}

function readStdinJson(io = {}) {
  let raw;
  try {
    if (io.stdinText !== undefined) {
      raw = String(io.stdinText);
    } else if (typeof io.stdin === 'string') {
      raw = io.stdin;
    } else {
      raw = fs.readFileSync(0, 'utf8');
    }
  } catch (err) {
    throw makeError('IO_ERROR', `Failed to read stdin: ${err.message}`);
  }
  const cleaned = raw.replace(/^\uFEFF/, '');
  if (!cleaned.trim()) {
    throw makeError('INVALID_ARGUMENT', 'Expected JSON payload on stdin, received empty input');
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw makeError('INVALID_ARGUMENT', `Invalid JSON on stdin: ${err.message}`);
  }
  assertNoDangerousKeys(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeError('INVALID_ARGUMENT', 'Stdin JSON payload must be a JSON object');
  }
  return parsed;
}

function parseNonNegInt(raw, flagName) {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    throw makeError('INVALID_ARGUMENT', `Option ${flagName} expects a non-negative integer, got "${raw}"`);
  }
  const num = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(num)) {
    throw makeError('INVALID_ARGUMENT', `Option ${flagName} integer out of range: "${raw}"`);
  }
  return num;
}

function parsePositiveNumber(raw, flagName) {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (str === '') {
    throw makeError('INVALID_ARGUMENT', `Option ${flagName} expects a positive number`);
  }
  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) {
    throw makeError('INVALID_ARGUMENT', `Option ${flagName} expects a positive number, got "${raw}"`);
  }
  return num;
}

function parseCsvList(values) {
  if (!Array.isArray(values)) return undefined;
  const out = [];
  for (const val of values) {
    const str = String(val);
    if (str.trim() === '') continue;
    for (const part of str.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function parseIntoList(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (values.length === 1) {
    const single = String(values[0]).trim();
    if (single.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(single);
      } catch (err) {
        throw makeError('INVALID_ARGUMENT', `Invalid JSON array for --into: ${err.message}`);
      }
      assertNoDangerousKeys(parsed);
      if (!Array.isArray(parsed)) {
        throw makeError('INVALID_ARGUMENT', '--into JSON value must be an array');
      }
      return parsed;
    }
    if (single.includes(',')) {
      return single.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return single ? [single] : [];
  }
  return values.map((v) => String(v).trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const positionals = [];
  const flags = Object.create(null);
  const provided = new Set();
  let endOfOptions = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (endOfOptions) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    let flagName = token;
    let inlineVal;
    let hasInline = false;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0) {
      flagName = token.slice(0, eqIdx);
      inlineVal = token.slice(eqIdx + 1);
      hasInline = true;
    }

    if (BOOLEAN_FLAGS.has(flagName)) {
      if (hasInline) {
        const lower = inlineVal.toLowerCase();
        if (lower === 'true' || lower === '1') {
          flags[flagName] = true;
        } else if (lower === 'false' || lower === '0') {
          flags[flagName] = false;
        } else {
          throw makeError('INVALID_ARGUMENT', `Boolean option ${flagName} does not accept value "${inlineVal}"`);
        }
      } else {
        flags[flagName] = true;
      }
      provided.add(flagName);
      continue;
    }

    if (REPEATABLE_FLAGS.has(flagName)) {
      let val;
      if (hasInline) {
        val = inlineVal;
      } else {
        if (i + 1 >= args.length) {
          throw makeError('INVALID_ARGUMENT', `Missing value for option ${flagName}`);
        }
        i += 1;
        val = String(args[i]);
      }
      if (!flags[flagName]) flags[flagName] = [];
      flags[flagName].push(val);
      provided.add(flagName);

      // Allow `split-task <taskId> --into "Part A" "Part B" --chain` syntax.
      if (flagName === '--into' && !hasInline && positionals[0] === 'split-task' && positionals.length >= 2) {
        while (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
          i += 1;
          flags[flagName].push(String(args[i]));
        }
      }
      continue;
    }

    if (VALUE_FLAGS.has(flagName)) {
      let val;
      if (hasInline) {
        val = inlineVal;
      } else {
        if (i + 1 >= args.length) {
          throw makeError('INVALID_ARGUMENT', `Missing value for option ${flagName}`);
        }
        i += 1;
        val = String(args[i]);
      }
      flags[flagName] = val;
      provided.add(flagName);
      continue;
    }

    throw makeError('INVALID_ARGUMENT', `Unknown option: ${flagName}`);
  }

  return {
    command: positionals[0] || null,
    rest: positionals.slice(1),
    flags,
    provided,
  };
}

function getHelpText() {
  return [
    'Usage: todo-plan.js <subcommand> [args] [options]',
    '',
    'Subcommands:',
    '  init                Initialize a new DwTodoPlan1 file',
    '  configure-views     Configure sidecar Markdown/HTML view paths (or "none")',
    '  validate            Validate an existing plan JSON file',
    '  start <taskId>      Start a task (pending -> in_progress)',
    '  claim-next          Atomically claim the next ready task',
    '  pause <taskId>      Pause an in_progress task back to pending',
    '  complete <taskId>   Mark a task as completed',
    '  reopen <taskId>     Reopen a completed/impossible/error task to pending',
    '  mark-impossible <id> Mark a task as impossible (requires --reason)',
    '  mark-error <id>     Mark a task as error (requires --reason)',
    '  set-status [id]     Set task status directly (--status ...)',
    '  add-phase           Add a phase',
    '  update-phase <id>   Update phase metadata/dependencies',
    '  remove-phase <id>   Archive (or --purge) a phase',
    '  reorder-phases      Reorder phases (--order P2,P1)',
    '  add-task            Add a task to a phase',
    '  update-task [id]    Update task metadata, phase, evidence, or note',
    '  split-task <id>     Split a task into >=2 child tasks (--chain|--parallel)',
    '  remove-task <id>    Archive (or --purge) a task',
    '  reorder-tasks       Reorder tasks inside a phase (--phase P1 --order ...)',
    '  apply               Apply atomic batch operations from --stdin',
    '  status              Show plan status summary',
    '  check-complete      Gate check (exit 0 complete, 1 incomplete, 2 empty)',
    '  render              Render terminal|text|brief|markdown|html (supports --out, --watch)',
    '  recover-lock        Recover stale .lock file with --expected-nonce',
    '',
    'Global options:',
    '  --file <path>               Plan JSON path (fallback: DW_TODO_PLAN_PATH)',
    '  --root <dir>                Restrict plan and view paths inside root directory',
    '  --json                      Emit structured JSON output on stdout',
    '  --expected-revision <n>     Optimistic concurrency revision guard',
    '  --request-id <id>           Idempotency key for safe retries',
    '  --actor <id>                Actor identifier for audit/ownership',
    '  --role <role>               coordinator | author | verifier',
    '  --lock-wait-ms <n>          Lock wait timeout in milliseconds',
    '  --no-sync                   Skip automatic sidecar Markdown/HTML sync',
    '  --sync-md <path|none>       Override Markdown sidecar path',
    '  --sync-html <path|none>     Override HTML sidecar path',
    '  --stdin                     Read JSON payload from stdin',
    '  --no-color                  Disable ANSI color codes',
    '  -h, --help                  Show this help message',
  ].join('\n') + '\n';
}

function buildRenderers() {
  return {
    markdown: (p, s, opts) => render.renderMarkdown(p, s, opts),
    html: (p, s, opts) => render.renderHtml(p, s, opts),
  };
}

function resolveSidecarTarget(rawOut, resolvedPlanPath, root) {
  const resolved = store.resolveSidecarPath(rawOut, {
    planPath: resolvedPlanPath,
    baseDir: process.cwd(),
    root,
  });
  if (typeof resolved === 'string') {
    return resolved;
  }
  if (resolved && typeof resolved.resolvedPath === 'string') {
    return resolved.resolvedPath;
  }
  if (resolved && typeof resolved.resolvedPlanPath === 'string') {
    return resolved.resolvedPlanPath;
  }
  throw makeError('PATH_SECURITY_VIOLATION', `Could not resolve output path: ${rawOut}`);
}

function formatHumanResult(command, res, noColor) {
  if (command === 'status' && res && res.plan) {
    return render.renderTerminal(res.plan, res.summary, { noColor });
  }
  const lines = [];
  const code = res && res.code ? res.code : 'OK';
  const rev = res && res.revision !== undefined ? ` rev=#${res.revision}` : '';
  const replay = res && res.idempotentReplay ? ' (idempotent replay)' : '';
  lines.push(`[${code}]${rev}${replay}${res && res.resolvedPlanPath ? ` ${res.resolvedPlanPath}` : ''}`);
  if (command === 'claim-next') {
    if (res && res.claimed && res.task) {
      lines.push(`Claimed: ${res.task.id} ${res.task.title}${res.task.owner ? ` (@${res.task.owner})` : ''}`);
    } else {
      lines.push('No ready task available.');
    }
  } else if (command === 'check-complete' && res && res.summary && res.summary.counts) {
    const c = res.summary.counts;
    lines.push(`Progress: ${c.completed}/${c.totalTasks} completed (unfinished=${c.unfinished}, impossible=${c.impossible}, error=${c.error}, emptyPhases=${c.emptyPhases})`);
  } else if (res && res.summary && res.summary.counts) {
    const c = res.summary.counts;
    lines.push(`Tasks: ${c.completed}/${c.totalTasks} completed, ${c.inProgress} in_progress, ${c.error} error, ${c.impossible} impossible`);
  }
  if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
    for (const w of res.warnings) {
      lines.push(`Warning [${w.code || 'WARNING'}]: ${w.message || JSON.stringify(w)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function normalizeJsonPayload(res, extras = {}) {
  const base = res && typeof res === 'object' ? { ...res } : {};
  const exitCode = typeof base.exitCode === 'number' ? base.exitCode : 0;
  const code = base.code || 'OK';
  const ok = base.ok !== undefined ? Boolean(base.ok) : exitCode === 0;
  const warnings = Array.isArray(base.warnings) ? base.warnings : [];
  return {
    ok,
    code,
    exitCode,
    resolvedPlanPath: base.resolvedPlanPath || null,
    planId: base.planId || (base.plan && base.plan.planId) || (base.summary && base.summary.planId) || null,
    revision: base.revision !== undefined ? base.revision : ((base.plan && base.plan.revision) ?? null),
    idempotentReplay: Boolean(base.idempotentReplay),
    summary: base.summary || null,
    warnings,
    ...base,
    ...extras,
  };
}

function requirePositional(rest, index, name) {
  if (!rest[index]) {
    throw makeError('INVALID_ARGUMENT', `Missing required argument: <${name}>`);
  }
  return rest[index];
}

async function runWatchRender({ format, outPath, allowNonTty, maxSeconds, maxEvents, noColor, commonOpts, jsonMode, io }) {
  const isTTY = io && io.isTTY !== undefined ? Boolean(io.isTTY) : Boolean(process.stdout.isTTY);
  const hasBound = (typeof maxSeconds === 'number' && maxSeconds > 0) || (typeof maxEvents === 'number' && maxEvents > 0);
  if (!isTTY && !(allowNonTty && hasBound)) {
    throw makeError(
      'WATCH_NON_TTY_FORBIDDEN',
      'Refusing to start render --watch in non-TTY mode without --allow-non-tty and (--max-seconds or --max-events)'
    );
  }

  const writeOut = (text) => {
    if (io && typeof io.writeStdout === 'function') {
      io.writeStdout(text);
    } else if (io && io.stdout && typeof io.stdout.write === 'function') {
      io.stdout.write(text);
    } else if (io && io.captureOnly) {
      // captured by caller via returned stdout
    } else {
      process.stdout.write(text);
    }
  };
  const writeErr = (text) => {
    if (io && typeof io.writeStderr === 'function') {
      io.writeStderr(text);
    } else if (io && io.stderr && typeof io.stderr.write === 'function') {
      io.stderr.write(text);
    } else if (io && io.captureOnly) {
      // captured by caller via returned stderr
    } else {
      process.stderr.write(text);
    }
  };

  let capturedStdout = '';
  let capturedStderr = '';
  const emitOut = (text) => {
    capturedStdout += text;
    writeOut(text);
  };
  const emitErr = (text) => {
    capturedStderr += text;
    writeErr(text);
  };

  const resolvedInfo = store.resolvePlanPath({
    file: commonOpts.file,
    env: commonOpts.env,
    root: commonOpts.root,
    actor: commonOpts.actor,
    role: commonOpts.role,
    shared: commonOpts.shared,
  });
  const resolvedPlanPath = resolvedInfo.resolvedPlanPath || resolvedInfo.resolvedPath;
  const resolvedOut = outPath ? resolveSidecarTarget(outPath, resolvedPlanPath, commonOpts.root) : null;

  let events = 0;
  let lastGoodFrame = null;
  let lastResult = null;

  const renderFrame = (isInitial) => {
    try {
      const loaded = store.loadAndValidate(commonOpts);
      const rendered = render.renderPlan(format, loaded.plan, loaded.summary, { noColor });
      lastGoodFrame = rendered;
      lastResult = loaded;
      events += 1;

      if (resolvedOut) {
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        store.atomicWriteFile(resolvedOut, rendered);
        if (jsonMode) {
          emitOut(`${JSON.stringify(normalizeJsonPayload(loaded, { format, outPath: resolvedOut, event: events }))}\n`);
        } else {
          emitOut(`[watch #${events}] Rendered ${format} -> ${resolvedOut} (rev #${loaded.plan.revision})\n`);
        }
      } else if (jsonMode) {
        emitOut(`${JSON.stringify(normalizeJsonPayload(loaded, { format, content: rendered, event: events }))}\n`);
      } else {
        if (isTTY && format === 'terminal') {
          emitOut('\x1b[2J\x1b[H');
        }
        emitOut(rendered);
      }
      return true;
    } catch (err) {
      if (isInitial) {
        throw err;
      }
      const notice = `STALE / RETRY: ${err.message}\n`;
      emitErr(notice);
      if (!resolvedOut && !jsonMode && lastGoodFrame !== null && isTTY && format === 'terminal') {
        emitOut(`\x1b[2J\x1b[H${lastGoodFrame}\n${notice}`);
      }
      return false;
    }
  };

  renderFrame(true);
  if (typeof maxEvents === 'number' && maxEvents > 0 && events >= maxEvents) {
    const payload = normalizeJsonPayload(lastResult, {
      format,
      outPath: resolvedOut,
      events,
      watched: true,
    });
    return { exitCode: 0, payload, stdout: capturedStdout, stderr: capturedStderr, streamed: true };
  }

  const watchDir = path.dirname(resolvedPlanPath);
  const targetBase = path.basename(resolvedPlanPath);
  const isWin = process.platform === 'win32';

  await new Promise((resolve) => {
    let finished = false;
    let watcher = null;
    let debounceTimer = null;
    let maxTimer = null;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (maxTimer) {
        clearTimeout(maxTimer);
        maxTimer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch (_) {
          // ignore close errors during teardown
        }
        watcher = null;
      }
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (process.stdout && typeof process.stdout.removeListener === 'function') {
        process.stdout.removeListener('error', onStdoutError);
      }
      resolve();
    };

    const onSignal = () => cleanup();
    const onStdoutError = (err) => {
      if (err && err.code === 'EPIPE') {
        cleanup();
      }
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (process.stdout && typeof process.stdout.on === 'function') {
      process.stdout.on('error', onStdoutError);
    }

    if (typeof maxSeconds === 'number' && maxSeconds > 0) {
      maxTimer = setTimeout(cleanup, Math.ceil(maxSeconds * 1000));
    }

    try {
      watcher = fs.watch(watchDir, (_eventType, filename) => {
        if (finished) return;
        if (filename) {
          const nameStr = String(filename);
          const matches = isWin
            ? nameStr.toLowerCase() === targetBase.toLowerCase()
            : nameStr === targetBase;
          if (!matches) return;
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (finished) return;
          renderFrame(false);
          if (typeof maxEvents === 'number' && maxEvents > 0 && events >= maxEvents) {
            cleanup();
          }
        }, 60);
      });
      watcher.on('error', (err) => {
        emitErr(`STALE / RETRY: watcher error: ${err.message}\n`);
      });
    } catch (err) {
      emitErr(`STALE / RETRY: unable to start watcher: ${err.message}\n`);
      cleanup();
    }
  });

  const payload = normalizeJsonPayload(lastResult, {
    format,
    outPath: resolvedOut,
    events,
    watched: true,
  });
  return { exitCode: 0, payload, stdout: capturedStdout, stderr: capturedStderr, streamed: true };
}

async function runCli(argv, io = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const jsonRequested = args.includes('--json') || args.some((a) => String(a).startsWith('--json=true'));

  try {
    const { command, rest, flags, provided } = parseArgs(args);
    const env = io.env || process.env;
    const jsonMode = Boolean(flags['--json']);
    const noColor = Boolean(flags['--no-color']) || (env && env.NO_COLOR !== undefined && env.NO_COLOR !== '');

    if (!command || command === 'help' || flags['--help'] || flags['-h']) {
      const helpText = getHelpText();
      const payload = { ok: true, code: 'OK', exitCode: 0, help: helpText };
      const stdout = jsonMode ? `${JSON.stringify(payload, null, 2)}\n` : helpText;
      return { exitCode: 0, payload, stdout, stderr: '' };
    }

    const commonOpts = {
      file: flags['--file'],
      root: flags['--root'],
      env: io.env || process.env,
      expectedRevision: provided.has('--expected-revision')
        ? parseNonNegInt(flags['--expected-revision'], '--expected-revision')
        : undefined,
      requestId: flags['--request-id'],
      actor: flags['--actor'],
      role: flags['--role'],
      lockWaitMs: provided.has('--lock-wait-ms')
        ? parseNonNegInt(flags['--lock-wait-ms'], '--lock-wait-ms')
        : undefined,
      noSync: Boolean(flags['--no-sync']),
      syncMd: flags['--sync-md'],
      syncHtml: flags['--sync-html'],
      shared: Boolean(flags['--shared']),
      renderers: buildRenderers(),
    };

    const stdinData = flags['--stdin'] ? readStdinJson(io) : null;
    if (stdinData) {
      if (commonOpts.expectedRevision === undefined && stdinData.expectedRevision !== undefined) {
        commonOpts.expectedRevision = stdinData.expectedRevision;
      }
      if (commonOpts.requestId === undefined && stdinData.requestId !== undefined) {
        commonOpts.requestId = stdinData.requestId;
      }
    }

    const dependsOn = provided.has('--depends-on') ? parseCsvList(flags['--depends-on']) : undefined;
    const evidence = provided.has('--evidence') ? flags['--evidence'] : undefined;

    let res;
    switch (command) {
      case 'init': {
        const s = stdinData || {};
        res = store.initPlan({
          ...commonOpts,
          planId: flags['--plan-id'] !== undefined ? flags['--plan-id'] : s.planId,
          title: flags['--title'] !== undefined ? flags['--title'] : s.title,
          goal: flags['--goal'] !== undefined ? flags['--goal'] : s.goal,
          force: Boolean(flags['--force'] || s.force),
          phases: s.phases,
          views: s.views,
          syncMd: flags['--sync-md'] !== undefined ? flags['--sync-md'] : (s.syncMd !== undefined ? s.syncMd : (s.views && s.views.markdownPath)),
          syncHtml: flags['--sync-html'] !== undefined ? flags['--sync-html'] : (s.syncHtml !== undefined ? s.syncHtml : (s.views && s.views.htmlPath)),
        });
        break;
      }

      case 'configure-views': {
        const opts = { ...commonOpts };
        if (provided.has('--sync-md')) {
          opts.syncMd = flags['--sync-md'];
          opts.markdownPath = flags['--sync-md'];
        }
        if (provided.has('--sync-html')) {
          opts.syncHtml = flags['--sync-html'];
          opts.htmlPath = flags['--sync-html'];
        }
        res = store.configureViews(opts);
        break;
      }

      case 'validate': {
        res = store.loadAndValidate(commonOpts);
        break;
      }

      case 'start': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.startTask({
          ...commonOpts,
          taskId,
          owner: flags['--owner'],
          exclusive: Boolean(flags['--exclusive']),
          reassign: Boolean(flags['--reassign']),
          allowUnmetDeps: Boolean(flags['--allow-unmet-deps']),
          reason: flags['--reason'],
          note: flags['--note'],
        });
        break;
      }

      case 'claim-next': {
        res = store.claimNextTask({
          ...commonOpts,
          owner: flags['--owner'],
          phaseId: flags['--phase'],
        });
        break;
      }

      case 'pause': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.pauseTask({
          ...commonOpts,
          taskId,
          note: flags['--note'],
        });
        break;
      }

      case 'complete': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.completeTask({
          ...commonOpts,
          taskId,
          evidence,
          note: flags['--note'],
          allowUnmetDeps: Boolean(flags['--allow-unmet-deps']),
          reason: flags['--reason'],
        });
        break;
      }

      case 'reopen': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.reopenTask({
          ...commonOpts,
          taskId,
          reason: flags['--reason'],
          note: flags['--note'],
        });
        break;
      }

      case 'mark-impossible': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.markImpossible({
          ...commonOpts,
          taskId,
          reason: flags['--reason'],
          evidence,
        });
        break;
      }

      case 'mark-error': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.markError({
          ...commonOpts,
          taskId,
          reason: flags['--reason'],
          evidence,
        });
        break;
      }

      case 'set-status': {
        const s = stdinData || {};
        const taskId = rest[0] || s.taskId || s.id;
        if (!taskId) {
          throw makeError('INVALID_ARGUMENT', 'Missing required <taskId> for set-status');
        }
        res = store.setTaskStatus({
          ...commonOpts,
          taskId,
          status: flags['--status'] !== undefined ? flags['--status'] : s.status,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
          note: flags['--note'] !== undefined ? flags['--note'] : s.note,
          evidence: evidence !== undefined ? evidence : s.evidence,
          owner: flags['--owner'] !== undefined ? flags['--owner'] : s.owner,
          exclusive: Boolean(flags['--exclusive'] || s.exclusive),
          reassign: Boolean(flags['--reassign'] || s.reassign),
          allowUnmetDeps: Boolean(flags['--allow-unmet-deps'] || s.allowUnmetDeps),
        });
        break;
      }

      case 'add-phase': {
        const s = stdinData || {};
        res = store.addPhase({
          ...commonOpts,
          id: flags['--id'] !== undefined ? flags['--id'] : s.id,
          title: flags['--title'] !== undefined ? flags['--title'] : s.title,
          goal: flags['--goal'] !== undefined ? flags['--goal'] : s.goal,
          dependsOn: dependsOn !== undefined ? dependsOn : s.dependsOn,
          before: flags['--before'] !== undefined ? flags['--before'] : s.before,
          after: flags['--after'] !== undefined ? flags['--after'] : s.after,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
          tasks: s.tasks,
        });
        break;
      }

      case 'update-phase': {
        const s = stdinData || {};
        const phaseId = rest[0] || s.phaseId || s.id;
        if (!phaseId) {
          throw makeError('INVALID_ARGUMENT', 'Missing required <phaseId> for update-phase');
        }
        res = store.updatePhase({
          ...commonOpts,
          phaseId,
          title: provided.has('--title') ? flags['--title'] : s.title,
          goal: provided.has('--goal') ? flags['--goal'] : s.goal,
          dependsOn: dependsOn !== undefined ? dependsOn : s.dependsOn,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
        });
        break;
      }

      case 'remove-phase': {
        const phaseId = requirePositional(rest, 0, 'phaseId');
        res = store.removePhase({
          ...commonOpts,
          phaseId,
          reason: flags['--reason'],
          duringTaskId: flags['--during'],
          unlinkDeps: Boolean(flags['--unlink-deps']),
          purge: Boolean(flags['--purge']),
        });
        break;
      }

      case 'reorder-phases': {
        const order = provided.has('--order') ? parseCsvList(flags['--order']) : (stdinData && stdinData.order);
        res = store.reorderPhases({
          ...commonOpts,
          order,
          reason: flags['--reason'],
        });
        break;
      }

      case 'add-task': {
        const s = stdinData || {};
        res = store.addTask({
          ...commonOpts,
          id: flags['--id'] !== undefined ? flags['--id'] : s.id,
          phaseId: flags['--phase'] !== undefined ? flags['--phase'] : s.phaseId,
          title: flags['--title'] !== undefined ? flags['--title'] : s.title,
          acceptance: flags['--acceptance'] !== undefined ? flags['--acceptance'] : s.acceptance,
          owner: flags['--owner'] !== undefined ? flags['--owner'] : s.owner,
          dependsOn: dependsOn !== undefined ? dependsOn : s.dependsOn,
          before: flags['--before'] !== undefined ? flags['--before'] : s.before,
          after: flags['--after'] !== undefined ? flags['--after'] : s.after,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
        });
        break;
      }

      case 'update-task': {
        const s = stdinData || {};
        const taskId = rest[0] || s.taskId || s.id;
        if (!taskId) {
          throw makeError('INVALID_ARGUMENT', 'Missing required <taskId> for update-task');
        }
        res = store.updateTask({
          ...commonOpts,
          taskId,
          title: provided.has('--title') ? flags['--title'] : s.title,
          acceptance: provided.has('--acceptance') ? flags['--acceptance'] : s.acceptance,
          owner: provided.has('--owner') ? flags['--owner'] : s.owner,
          dependsOn: dependsOn !== undefined ? dependsOn : s.dependsOn,
          moveToPhase: flags['--move-to-phase'] !== undefined ? flags['--move-to-phase'] : s.moveToPhase,
          resetStatus: Boolean(flags['--reset-status'] || s.resetStatus),
          evidence: evidence !== undefined ? evidence : s.evidence,
          note: provided.has('--note') ? flags['--note'] : s.note,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
        });
        break;
      }

      case 'split-task': {
        const s = stdinData || {};
        const taskId = rest[0] || s.taskId || s.id;
        if (!taskId) {
          throw makeError('INVALID_ARGUMENT', 'Missing required <taskId> for split-task');
        }
        if (flags['--chain'] && flags['--parallel']) {
          throw makeError('INVALID_ARGUMENT', 'Cannot specify both --chain and --parallel for split-task');
        }
        const into = provided.has('--into') ? parseIntoList(flags['--into']) : s.into;
        const mode = flags['--parallel'] ? 'parallel' : (flags['--chain'] ? 'chain' : (s.mode || 'chain'));
        res = store.splitTask({
          ...commonOpts,
          taskId,
          into,
          mode,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
        });
        break;
      }

      case 'remove-task': {
        const taskId = requirePositional(rest, 0, 'taskId');
        res = store.removeTask({
          ...commonOpts,
          taskId,
          reason: flags['--reason'],
          duringTaskId: flags['--during'],
          unlinkDeps: Boolean(flags['--unlink-deps']),
          purge: Boolean(flags['--purge']),
        });
        break;
      }

      case 'reorder-tasks': {
        const order = provided.has('--order') ? parseCsvList(flags['--order']) : (stdinData && stdinData.order);
        res = store.reorderTasks({
          ...commonOpts,
          phaseId: flags['--phase'] !== undefined ? flags['--phase'] : (stdinData && stdinData.phaseId),
          order,
          reason: flags['--reason'],
        });
        break;
      }

      case 'apply': {
        const s = stdinData || readStdinJson(io);
        res = store.applyPatch({
          ...commonOpts,
          ops: s.ops,
          duringTaskId: flags['--during'] !== undefined ? flags['--during'] : s.duringTaskId,
          reason: flags['--reason'] !== undefined ? flags['--reason'] : s.reason,
          expectedRevision: commonOpts.expectedRevision !== undefined ? commonOpts.expectedRevision : s.expectedRevision,
          requestId: commonOpts.requestId !== undefined ? commonOpts.requestId : s.requestId,
        });
        break;
      }

      case 'status': {
        res = store.statusPlan(commonOpts);
        break;
      }

      case 'check-complete': {
        res = store.checkCompletePlan(commonOpts);
        break;
      }

      case 'render': {
        const format = String(flags['--format'] || 'terminal').trim().toLowerCase();
        if (!VALID_RENDER_FORMATS.has(format)) {
          throw makeError('INVALID_ARGUMENT', `Unsupported render format: ${format}`);
        }
        const maxSeconds = provided.has('--max-seconds')
          ? parsePositiveNumber(flags['--max-seconds'], '--max-seconds')
          : undefined;
        const maxEvents = provided.has('--max-events')
          ? parseNonNegInt(flags['--max-events'], '--max-events')
          : undefined;
        if (provided.has('--max-events') && maxEvents <= 0) {
          throw makeError('INVALID_ARGUMENT', '--max-events must be a positive integer');
        }

        if (flags['--watch']) {
          return await runWatchRender({
            format,
            outPath: flags['--out'],
            allowNonTty: Boolean(flags['--allow-non-tty']),
            maxSeconds,
            maxEvents,
            noColor,
            commonOpts,
            jsonMode,
            io,
          });
        }

        const loaded = store.loadAndValidate(commonOpts);
        const output = render.renderPlan(format, loaded.plan, loaded.summary, { noColor });
        if (flags['--out']) {
          const outResolved = resolveSidecarTarget(flags['--out'], loaded.resolvedPlanPath, commonOpts.root);
          fs.mkdirSync(path.dirname(outResolved), { recursive: true });
          store.atomicWriteFile(outResolved, output);
          const payload = normalizeJsonPayload(loaded, { format, outPath: outResolved });
          const stdout = jsonMode
            ? `${JSON.stringify(payload, null, 2)}\n`
            : `Rendered ${format} to ${outResolved}\n`;
          return { exitCode: payload.exitCode, payload, stdout, stderr: '' };
        }

        const payload = normalizeJsonPayload(loaded, { format, content: output });
        const stdout = jsonMode ? `${JSON.stringify(payload, null, 2)}\n` : output;
        return { exitCode: payload.exitCode, payload, stdout, stderr: '' };
      }

      case 'recover-lock': {
        res = store.recoverLock({
          ...commonOpts,
          expectedNonce: flags['--expected-nonce'],
        });
        break;
      }

      default:
        throw makeError('INVALID_ARGUMENT', `Unknown subcommand: ${command}`);
    }

    const payload = normalizeJsonPayload(res);
    const stdout = jsonMode
      ? `${JSON.stringify(payload, null, 2)}\n`
      : formatHumanResult(command, payload, noColor);
    return {
      exitCode: payload.exitCode,
      payload,
      stdout,
      stderr: '',
    };
  } catch (err) {
    const code = (err && err.code) || 'IO_ERROR';
    const exitCode = (err && typeof err.exitCode === 'number')
      ? err.exitCode
      : ((store.EXIT_CODES && store.EXIT_CODES[code] !== undefined) ? store.EXIT_CODES[code] : 4);
    const payload = {
      ok: false,
      code,
      exitCode,
      error: (err && err.message) || String(err),
      details: (err && err.details) || null,
      warnings: (err && Array.isArray(err.warnings)) ? err.warnings : [],
    };
    if (jsonRequested) {
      return {
        exitCode,
        payload,
        stdout: `${JSON.stringify(payload, null, 2)}\n`,
        stderr: '',
      };
    }
    return {
      exitCode,
      payload,
      stdout: '',
      stderr: `Error [${code}]: ${payload.error}\n`,
    };
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (!result.streamed) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      process.exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
    })
    .catch((err) => {
      process.stderr.write(`Fatal error: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 4;
    });
}

module.exports = {
  ...store,
  ...render,
  runCli,
  parseArgs,
};
