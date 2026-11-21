'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_NAME = 'DwTodoPlan1';
const SCHEMA_VERSION = 1;
const VALID_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'impossible', 'error']);
const VALID_ROLES = Object.freeze(['coordinator', 'author', 'verifier']);

const EXIT_CODES = Object.freeze({
  OK: 0,
  PLAN_COMPLETE: 0,
  CLAIMED: 0,
  NO_READY_TASK: 0,
  LOCK_RECOVERED: 0,
  PLAN_INCOMPLETE: 1,
  INVALID_ARGUMENT: 2,
  INVALID_SCHEMA: 2,
  NOT_FOUND: 2,
  DUPLICATE_ID: 2,
  DEPENDENCY_CYCLE: 2,
  DEPENDENCY_MISSING: 2,
  DEPENDENCY_IN_USE: 2,
  DEPENDENCY_UNMET: 2,
  REASON_REQUIRED: 2,
  INVALID_TRANSITION: 2,
  PLAN_EMPTY: 2,
  REQUEST_ID_CONFLICT: 2,
  WATCH_NON_TTY_FORBIDDEN: 2,
  REVISION_CONFLICT: 3,
  STATE_LOCKED: 3,
  LOCK_RECOVERY_MISMATCH: 3,
  TASK_ALREADY_CLAIMED: 3,
  NOT_TASK_OWNER: 3,
  ROLE_FORBIDDEN: 3,
  PATH_SECURITY_VIOLATION: 4,
  IO_ERROR: 4,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_PHASES = 100;
const MAX_TASKS = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HISTORY = 200;
const MAX_RECENT_REQUESTS = 128;
const DEFAULT_LOCK_WAIT_MS = 5000;

const LOCK_BACKOFF_MS = [5, 10, 15, 25];
const RENAME_RETRY_MS = [10, 20, 40, 80, 160];
const WIN_READ_RETRY_MS = [5, 10, 20, 40];

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

class TodoPlanError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'TodoPlanError';
    this.code = code;
    this.details = details;
    this.exitCode = Object.prototype.hasOwnProperty.call(EXIT_CODES, code)
      ? EXIT_CODES[code]
      : EXIT_CODES.IO_ERROR;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, TodoPlanError);
    }
  }
}

function sleepSync(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return;
  Atomics.wait(SLEEP_ARRAY, 0, 0, Math.floor(duration));
}

function hasOwn(obj, key) {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

function assertSafeValue(value, fieldPath = 'input', seen = new WeakSet()) {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'string') {
    if (CONTROL_CHAR_PATTERN.test(value)) {
      throw new TodoPlanError(
        'INVALID_ARGUMENT',
        `Control characters are not allowed in ${fieldPath}`,
        { field: fieldPath }
      );
    }
    return;
  }
  if (type !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  const ownKeys = Object.getOwnPropertyNames(value);
  for (let i = 0; i < ownKeys.length; i += 1) {
    const key = ownKeys[i];
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TodoPlanError(
        'INVALID_ARGUMENT',
        `Forbidden property key "${key}" in ${fieldPath}`,
        { field: fieldPath, key }
      );
    }
    if (CONTROL_CHAR_PATTERN.test(key)) {
      throw new TodoPlanError(
        'INVALID_ARGUMENT',
        `Control characters are not allowed in key at ${fieldPath}`,
        { field: fieldPath }
      );
    }
    if (Array.isArray(value) && key === 'length') continue;
    assertSafeValue(value[key], `${fieldPath}.${key}`, seen);
  }
}

function assertSafeOptions(options) {
  if (options === null || options === undefined) return;
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'Options must be an object');
  }
  const ownKeys = Object.getOwnPropertyNames(options);
  for (let i = 0; i < ownKeys.length; i += 1) {
    const key = ownKeys[i];
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TodoPlanError('INVALID_ARGUMENT', `Forbidden property key "${key}" in options`, {
        field: 'options',
        key,
      });
    }
    if (key === 'env' || key === 'renderers') continue;
    assertSafeValue(options[key], `options.${key}`);
  }
}

function assertValidId(id, label = 'id') {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `Invalid ${label}: must match ${ID_PATTERN.source}`,
      { field: label, value: id }
    );
  }
  return id;
}

function normalizeNonEmptyString(val, label, errorCode = 'INVALID_ARGUMENT') {
  if (typeof val !== 'string') {
    throw new TodoPlanError(errorCode, `${label} is required`, { field: label });
  }
  assertSafeValue(val, label);
  const trimmed = val.trim();
  if (!trimmed) {
    throw new TodoPlanError(errorCode, `${label} must be a non-empty string`, { field: label });
  }
  return trimmed;
}

function normalizeOptionalText(val, label = 'text') {
  if (val === undefined || val === null) return '';
  if (typeof val !== 'string') {
    throw new TodoPlanError('INVALID_ARGUMENT', `${label} must be a string`, { field: label });
  }
  assertSafeValue(val, label);
  return val.trim();
}

function normalizeNullableString(val, label = 'value') {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') {
    throw new TodoPlanError('INVALID_ARGUMENT', `${label} must be a string or null`, { field: label });
  }
  assertSafeValue(val, label);
  const trimmed = val.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeIdArray(val, label = 'dependsOn') {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val)) {
    throw new TodoPlanError('INVALID_ARGUMENT', `${label} must be an array of IDs`, { field: label });
  }
  const result = [];
  const seen = new Set();
  for (let i = 0; i < val.length; i += 1) {
    const item = val[i];
    if (typeof item !== 'string') {
      throw new TodoPlanError('INVALID_ARGUMENT', `${label}[${i}] must be a string ID`, { field: label });
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    assertValidId(trimmed, `${label}[${i}]`);
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function normalizeEvidenceList(val) {
  if (val === undefined || val === null) return [];
  const items = Array.isArray(val) ? val : [val];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (typeof item !== 'string') {
      throw new TodoPlanError('INVALID_ARGUMENT', `evidence[${i}] must be a string`, { field: 'evidence' });
    }
    assertSafeValue(item, `evidence[${i}]`);
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function appendEvidence(task, evidence) {
  const items = normalizeEvidenceList(evidence);
  for (let i = 0; i < items.length; i += 1) {
    if (!task.evidence.includes(items[i])) {
      task.evidence.push(items[i]);
    }
  }
}

function normalizeRoleAndActor(options = {}) {
  const rawRole = options.role === undefined || options.role === null || options.role === ''
    ? 'coordinator'
    : options.role;
  if (typeof rawRole !== 'string' || !VALID_ROLES.includes(rawRole)) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `Invalid role "${rawRole}". Valid roles: ${VALID_ROLES.join(', ')}`,
      { role: rawRole }
    );
  }
  const actor = normalizeNullableString(options.actor, 'actor');
  if (rawRole === 'author' && !actor) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'Role "author" requires a non-empty actor (--actor)', {
      role: rawRole,
    });
  }
  return { role: rawRole, actor };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const pairs = [];
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (value[k] === undefined) continue;
    pairs.push(`${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  }
  return `{${pairs.join(',')}}`;
}

function computePayloadSha256(action, params) {
  const digest = crypto
    .createHash('sha256')
    .update(canonicalJson({ action, params }))
    .digest('hex');
  return digest;
}

function checkNoSymlinksAndResolve(absPath) {
  const parsed = path.parse(absPath);
  const rootPart = parsed.root;
  const rest = absPath.slice(rootPart.length);
  const segments = rest.split(path.sep).filter(Boolean);

  let current = rootPart;
  let deepestExisting = rootPart;
  let remaining = [];

  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        remaining = segments.slice(i);
        break;
      }
      throw new TodoPlanError('IO_ERROR', `Failed to inspect path "${current}": ${err.message}`, {
        path: current,
        causeCode: err.code,
      });
    }
    if (stat.isSymbolicLink()) {
      if (
        process.platform === 'darwin' &&
        i === 0 &&
        (current === '/var' || current === '/tmp' || current === '/etc')
      ) {
        deepestExisting = current;
        continue;
      }
      throw new TodoPlanError(
        'PATH_SECURITY_VIOLATION',
        `Symbolic link or reparse point is not allowed in path: ${current}`,
        { path: current, targetPath: absPath }
      );
    }
    deepestExisting = current;
  }

  let canonicalBase;
  try {
    canonicalBase = fs.realpathSync(deepestExisting);
  } catch (err) {
    throw new TodoPlanError(
      'IO_ERROR',
      `Failed to resolve canonical path "${deepestExisting}": ${err.message}`,
      { path: deepestExisting, causeCode: err.code }
    );
  }
  return remaining.length > 0 ? path.join(canonicalBase, ...remaining) : canonicalBase;
}

function assertContainedInRoot(canonicalTarget, canonicalRoot, rawLabel) {
  const normTarget = path.resolve(canonicalTarget);
  const normRoot = path.resolve(canonicalRoot);
  const cmpTarget = process.platform === 'win32' ? normTarget.toLowerCase() : normTarget;
  const cmpRoot = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  const rel = path.relative(cmpRoot, cmpTarget);
  const isOutside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (isOutside) {
    throw new TodoPlanError(
      'PATH_SECURITY_VIOLATION',
      `Path "${rawLabel}" escapes allowed root "${normRoot}"`,
      { targetPath: normTarget, root: normRoot }
    );
  }
}

function resolveCanonicalRoot(root) {
  if (root === undefined || root === null || root === '') return null;
  if (typeof root !== 'string') {
    throw new TodoPlanError('INVALID_ARGUMENT', 'root must be a string path', { field: 'root' });
  }
  assertSafeValue(root, 'root');
  const trimmed = root.trim();
  if (!trimmed) return null;
  const absRoot = path.resolve(trimmed);
  return checkNoSymlinksAndResolve(absRoot);
}

function resolvePlanPath(options = {}) {
  const opts = typeof options === 'string' ? { file: options } : (options || {});
  const env = opts.env !== undefined ? opts.env : process.env;
  const rawRole = opts.role || 'coordinator';

  let rawFile = null;
  let fromEnv = false;

  if (typeof opts.file === 'string' && opts.file.trim() !== '') {
    rawFile = opts.file.trim();
    fromEnv = false;
  } else if (env && typeof env.DW_TODO_PLAN_PATH === 'string' && env.DW_TODO_PLAN_PATH.trim() !== '') {
    rawFile = env.DW_TODO_PLAN_PATH.trim();
    fromEnv = true;
  } else {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      'Plan file path is required via --file or DW_TODO_PLAN_PATH',
      { field: 'file' }
    );
  }

  assertSafeValue(rawFile, 'file');

  const canonicalRoot = resolveCanonicalRoot(opts.root);
  const absTarget = path.resolve(rawFile);
  const canonicalTarget = checkNoSymlinksAndResolve(absTarget);

  if (canonicalRoot) {
    assertContainedInRoot(canonicalTarget, canonicalRoot, rawFile);
  }

  const warnings = [];
  if (
    !fromEnv &&
    !path.isAbsolute(rawFile) &&
    (Boolean(opts.shared) || rawRole === 'author' || rawRole === 'verifier')
  ) {
    warnings.push({
      code: 'SHARED_RELATIVE_PATH_WARNING',
      message: `Relative --file "${rawFile}" used in shared/worker context; prefer an absolute path or DW_TODO_PLAN_PATH to avoid divergent worktree copies`,
    });
  }

  return {
    rawPath: rawFile,
    resolvedPath: canonicalTarget,
    resolvedPlanPath: canonicalTarget,
    fromEnv,
    root: canonicalRoot,
    warnings,
  };
}

function resolveSidecarPath(arg1, arg2, arg3) {
  let rawPath;
  let baseDir;
  let root;

  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    rawPath = arg1.path ?? arg1.file ?? arg1.targetPath ?? arg1.sidecarPath ?? arg1.outPath;
    baseDir = arg1.baseDir || (arg1.planPath ? path.dirname(arg1.planPath) : process.cwd());
    root = arg1.root;
  } else if (typeof arg1 === 'string' && typeof arg2 === 'string') {
    baseDir = path.dirname(arg1);
    rawPath = arg2;
    root = typeof arg3 === 'string' ? arg3 : (arg3 && arg3.root);
  } else {
    rawPath = arg1;
    const opts = (arg2 && typeof arg2 === 'object') ? arg2 : {};
    baseDir = opts.baseDir || (opts.planPath ? path.dirname(opts.planPath) : process.cwd());
    root = opts.root;
  }

  const cleanTarget = normalizeNonEmptyString(rawPath, 'sidecarPath');
  const absTarget = path.isAbsolute(cleanTarget)
    ? path.resolve(cleanTarget)
    : path.resolve(baseDir || process.cwd(), cleanTarget);

  const canonicalRoot = resolveCanonicalRoot(root);
  const canonicalTarget = checkNoSymlinksAndResolve(absTarget);

  if (canonicalRoot) {
    assertContainedInRoot(canonicalTarget, canonicalRoot, cleanTarget);
  }

  return canonicalTarget;
}

function atomicWriteFile(targetPath, content) {
  const cleanTarget = normalizeNonEmptyString(targetPath, 'targetPath');
  const absTarget = path.resolve(cleanTarget);
  checkNoSymlinksAndResolve(absTarget);

  const dir = path.dirname(absTarget);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new TodoPlanError('IO_ERROR', `Failed to create directory "${dir}": ${err.message}`, {
      path: dir,
      causeCode: err.code,
    });
  }

  // Re-check target immediately before writing
  try {
    const st = fs.lstatSync(absTarget);
    if (st.isSymbolicLink()) {
      throw new TodoPlanError('PATH_SECURITY_VIOLATION', `Target path is a symbolic link: ${absTarget}`, {
        path: absTarget,
      });
    }
    if (st.isDirectory()) {
      throw new TodoPlanError('IO_ERROR', `Target path is a directory: ${absTarget}`, {
        path: absTarget,
      });
    }
  } catch (err) {
    if (err instanceof TodoPlanError) throw err;
    if (!err || err.code !== 'ENOENT') {
      throw new TodoPlanError('IO_ERROR', `Failed to stat "${absTarget}": ${err.message}`, {
        path: absTarget,
        causeCode: err && err.code,
      });
    }
  }

  const tmpPath = `${absTarget}.${crypto.randomUUID()}.tmp`;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  let fd = null;
  let renamed = false;

  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) {
        throw new Error('Short write while flushing temporary file');
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    let attempt = 0;
    while (true) {
      try {
        fs.renameSync(tmpPath, absTarget);
        renamed = true;
        break;
      } catch (err) {
        if (
          err &&
          (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY') &&
          attempt < RENAME_RETRY_MS.length
        ) {
          sleepSync(RENAME_RETRY_MS[attempt]);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof TodoPlanError) throw err;
    throw new TodoPlanError('IO_ERROR', `Failed to atomically write "${absTarget}": ${err.message}`, {
      path: absTarget,
      causeCode: err && err.code,
    });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // ignore close errors during cleanup
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        // ignore cleanup errors
      }
    }
  }
}

function createAtomicWriter() {
  const write = (targetPath, content) => atomicWriteFile(targetPath, content);
  write.write = write;
  write.writeFile = write;
  return write;
}

function readLockHolderBestEffort(lockPath) {
  try {
    const st = fs.lstatSync(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const text = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function withPlanLock(resolvedPlanPath, options, fn) {
  const lockWaitMs = options.lockWaitMs !== undefined && options.lockWaitMs !== null
    ? Number(options.lockWaitMs)
    : DEFAULT_LOCK_WAIT_MS;
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'lockWaitMs must be a non-negative finite number', {
      field: 'lockWaitMs',
      value: options.lockWaitMs,
    });
  }

  const lockPath = `${resolvedPlanPath}.lock`;
  const dir = path.dirname(resolvedPlanPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new TodoPlanError('IO_ERROR', `Failed to create plan directory "${dir}": ${err.message}`, {
      path: dir,
      causeCode: err.code,
    });
  }

  const myNonce = crypto.randomUUID();
  const holderPayload = {
    nonce: myNonce,
    pid: process.pid,
    actor: options.actor || null,
    acquiredAt: new Date().toISOString(),
  };

  const deadline = Date.now() + lockWaitMs;
  let attempt = 0;
  let acquired = false;

  while (!acquired) {
    try {
      const existingStat = fs.lstatSync(lockPath);
      if (existingStat.isSymbolicLink()) {
        throw new TodoPlanError('PATH_SECURITY_VIOLATION', `Lock path is a symbolic link: ${lockPath}`, {
          lockPath,
        });
      }
    } catch (err) {
      if (err instanceof TodoPlanError) throw err;
      // ENOENT is expected when unlocked
    }

    let fd = null;
    let createdByUs = false;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      createdByUs = true;
      const buf = Buffer.from(`${JSON.stringify(holderPayload, null, 2)}\n`, 'utf8');
      let offset = 0;
      while (offset < buf.length) {
        const written = fs.writeSync(fd, buf, offset, buf.length - offset);
        if (written <= 0) throw new Error('Short write on lock file');
        offset += written;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      acquired = true;
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          // ignore
        }
      }
      if (createdByUs) {
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {
          // best-effort cleanup of our own incomplete lock file
        }
      }
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.lstatSync(lockPath);
          if (st.isSymbolicLink()) {
            throw new TodoPlanError('PATH_SECURITY_VIOLATION', `Lock path is a symbolic link: ${lockPath}`, {
              lockPath,
            });
          }
        } catch (lstatErr) {
          if (lstatErr instanceof TodoPlanError) throw lstatErr;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          const holder = readLockHolderBestEffort(lockPath);
          throw new TodoPlanError(
            'STATE_LOCKED',
            `Plan is locked by another writer: ${lockPath}`,
            { lockPath, holder, waitedMs: lockWaitMs }
          );
        }
        const delay = LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)];
        sleepSync(Math.min(delay, remainingMs));
        attempt += 1;
        continue;
      }
      if (err instanceof TodoPlanError) throw err;
      throw new TodoPlanError('IO_ERROR', `Failed to acquire lock "${lockPath}": ${err.message}`, {
        lockPath,
        causeCode: err && err.code,
      });
    }
  }

  try {
    return fn();
  } finally {
    try {
      const st = fs.lstatSync(lockPath);
      if (!st.isSymbolicLink() && st.isFile()) {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (current && typeof current === 'object' && current.nonce === myNonce) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch (_) {
      // Never unlink if missing, corrupt, symlink, or owned by another nonce
    }
  }
}

function readPublishedPlan(planPath) {
  const cleanPath = normalizeNonEmptyString(planPath, 'planPath');
  const absPath = path.resolve(cleanPath);
  checkNoSymlinksAndResolve(absPath);

  let attempt = 0;
  while (true) {
    try {
      const st = fs.lstatSync(absPath);
      if (st.isSymbolicLink()) {
        throw new TodoPlanError('PATH_SECURITY_VIOLATION', `Plan path is a symbolic link: ${absPath}`, {
          path: absPath,
        });
      }
      if (!st.isFile()) {
        throw new TodoPlanError('INVALID_SCHEMA', `Plan path is not a regular file: ${absPath}`, {
          path: absPath,
        });
      }
      if (st.size > MAX_FILE_BYTES) {
        throw new TodoPlanError(
          'INVALID_SCHEMA',
          `Plan file size (${st.size} bytes) exceeds maximum allowed (${MAX_FILE_BYTES} bytes)`,
          { path: absPath, size: st.size, maxFileBytes: MAX_FILE_BYTES }
        );
      }

      const rawText = fs.readFileSync(absPath, 'utf8');
      if (Buffer.byteLength(rawText, 'utf8') > MAX_FILE_BYTES) {
        throw new TodoPlanError(
          'INVALID_SCHEMA',
          `Plan file content exceeds maximum allowed (${MAX_FILE_BYTES} bytes)`,
          { path: absPath, maxFileBytes: MAX_FILE_BYTES }
        );
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseErr) {
        throw new TodoPlanError('INVALID_SCHEMA', `Malformed JSON in plan file: ${parseErr.message}`, {
          path: absPath,
        });
      }

      assertSafeValue(parsed, 'plan');
      return parsed;
    } catch (err) {
      if (err instanceof TodoPlanError) throw err;
      if (
        process.platform === 'win32' &&
        err &&
        (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EBUSY') &&
        attempt < WIN_READ_RETRY_MS.length &&
        fs.existsSync(path.dirname(absPath))
      ) {
        sleepSync(WIN_READ_RETRY_MS[attempt]);
        attempt += 1;
        continue;
      }
      if (err && err.code === 'ENOENT') {
        throw new TodoPlanError('NOT_FOUND', `Plan file not found: ${absPath}`, { path: absPath });
      }
      throw new TodoPlanError('IO_ERROR', `Failed to read plan file "${absPath}": ${err.message}`, {
        path: absPath,
        causeCode: err && err.code,
      });
    }
  }
}

function derivePhaseStatus(phase) {
  const tasks = phase && Array.isArray(phase.tasks) ? phase.tasks : [];
  if (tasks.length === 0) return 'empty';
  if (tasks.every((t) => t.status === 'completed')) return 'completed';
  if (tasks.some((t) => t.status === 'error')) return 'error';
  if (tasks.some((t) => t.status === 'impossible')) return 'impossible';
  const hasInProgress = tasks.some((t) => t.status === 'in_progress');
  const hasCompleted = tasks.some((t) => t.status === 'completed');
  const hasPending = tasks.some((t) => t.status === 'pending');
  if (hasInProgress || (hasCompleted && hasPending)) return 'in_progress';
  return 'pending';
}

function detectCycle(nodes, getDeps, kind) {
  // 0 = unvisited, 1 = visiting, 2 = visited
  const color = new Map();
  const stack = [];

  for (let i = 0; i < nodes.length; i += 1) {
    color.set(nodes[i].id, 0);
  }

  function dfs(nodeId) {
    color.set(nodeId, 1);
    stack.push(nodeId);
    const deps = getDeps(nodeId);
    for (let i = 0; i < deps.length; i += 1) {
      const depId = deps[i];
      const state = color.get(depId);
      if (state === 1) {
        const cycleStart = stack.indexOf(depId);
        const cycle = stack.slice(cycleStart).concat(depId);
        throw new TodoPlanError(
          'DEPENDENCY_CYCLE',
          `Dependency cycle detected in ${kind}s: ${cycle.join(' -> ')}`,
          { kind, cycle }
        );
      }
      if (state === 0) {
        dfs(depId);
      }
    }
    stack.pop();
    color.set(nodeId, 2);
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const id = nodes[i].id;
    if (color.get(id) === 0) {
      dfs(id);
    }
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'Plan must be a JSON object');
  }
  assertSafeValue(plan, 'plan');

  if (plan.schema !== SCHEMA_NAME) {
    throw new TodoPlanError(
      'INVALID_SCHEMA',
      `Unsupported plan schema "${plan.schema}" (expected "${SCHEMA_NAME}")`,
      { schema: plan.schema }
    );
  }
  if (plan.schemaVersion !== SCHEMA_VERSION) {
    throw new TodoPlanError(
      'INVALID_SCHEMA',
      `Unsupported schemaVersion "${plan.schemaVersion}" (expected ${SCHEMA_VERSION})`,
      { schemaVersion: plan.schemaVersion }
    );
  }

  assertValidId(plan.planId, 'planId');
  normalizeNonEmptyString(plan.title, 'title', 'INVALID_SCHEMA');
  if (typeof plan.goal !== 'string') {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.goal must be a string');
  }
  if (!Number.isInteger(plan.revision) || plan.revision < 1) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.revision must be a positive integer');
  }
  if (typeof plan.createdAt !== 'string' || typeof plan.updatedAt !== 'string') {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.createdAt and plan.updatedAt must be ISO strings');
  }
  if (!Number.isInteger(plan.nextPhaseSeq) || plan.nextPhaseSeq < 1) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.nextPhaseSeq must be a positive integer');
  }
  if (!Number.isInteger(plan.nextTaskSeq) || plan.nextTaskSeq < 1) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.nextTaskSeq must be a positive integer');
  }
  if (!Number.isInteger(plan.maxHistoryEntries) || plan.maxHistoryEntries < 1) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.maxHistoryEntries must be a positive integer');
  }
  if (!Number.isInteger(plan.truncatedHistoryCount) || plan.truncatedHistoryCount < 0) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.truncatedHistoryCount must be a non-negative integer');
  }

  if (!plan.views || typeof plan.views !== 'object' || Array.isArray(plan.views)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.views must be an object');
  }
  if (plan.views.markdownPath !== null && typeof plan.views.markdownPath !== 'string') {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.views.markdownPath must be string or null');
  }
  if (plan.views.htmlPath !== null && typeof plan.views.htmlPath !== 'string') {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.views.htmlPath must be string or null');
  }

  if (!Array.isArray(plan.phases)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.phases must be an array');
  }
  if (plan.phases.length > MAX_PHASES) {
    throw new TodoPlanError('INVALID_SCHEMA', `Phase count exceeds maximum (${MAX_PHASES})`, {
      maxPhases: MAX_PHASES,
    });
  }
  if (!Array.isArray(plan.archived)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.archived must be an array');
  }
  if (!Array.isArray(plan.history)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.history must be an array');
  }
  if (!Array.isArray(plan.recentRequests)) {
    throw new TodoPlanError('INVALID_SCHEMA', 'plan.recentRequests must be an array');
  }
  for (let i = 0; i < plan.recentRequests.length; i += 1) {
    const reqEntry = plan.recentRequests[i];
    if (!reqEntry || typeof reqEntry !== 'object' || Array.isArray(reqEntry)) {
      throw new TodoPlanError('INVALID_SCHEMA', `recentRequests[${i}] must be an object`);
    }
    if (typeof reqEntry.requestId !== 'string' || !reqEntry.requestId.trim()) {
      throw new TodoPlanError('INVALID_SCHEMA', `recentRequests[${i}].requestId must be a non-empty string`);
    }
    if (typeof reqEntry.payloadSha256 !== 'string' || !reqEntry.payloadSha256.trim()) {
      throw new TodoPlanError('INVALID_SCHEMA', `recentRequests[${i}].payloadSha256 must be a non-empty string`);
    }
    if (!reqEntry.response || typeof reqEntry.response !== 'object' || Array.isArray(reqEntry.response)) {
      throw new TodoPlanError('INVALID_SCHEMA', `recentRequests[${i}].response must be an object`);
    }
  }

  const globalSeenIds = new Set();
  const activePhaseMap = new Map();
  const activeTaskMap = new Map();
  const allActiveTasks = [];

  for (let i = 0; i < plan.archived.length; i += 1) {
    const item = plan.archived[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TodoPlanError('INVALID_SCHEMA', `archived[${i}] must be an object`);
    }
    assertValidId(item.id, `archived[${i}].id`);
    if (globalSeenIds.has(item.id)) {
      throw new TodoPlanError('DUPLICATE_ID', `Duplicate ID "${item.id}" found in archived`, {
        id: item.id,
      });
    }
    globalSeenIds.add(item.id);
    if (Array.isArray(item.tasks)) {
      for (let j = 0; j < item.tasks.length; j += 1) {
        const archivedTask = item.tasks[j];
        if (archivedTask && typeof archivedTask === 'object' && typeof archivedTask.id === 'string') {
          assertValidId(archivedTask.id, `archived[${i}].tasks[${j}].id`);
          if (globalSeenIds.has(archivedTask.id)) {
            throw new TodoPlanError('DUPLICATE_ID', `Duplicate ID "${archivedTask.id}" found in archived phase`, {
              id: archivedTask.id,
            });
          }
          globalSeenIds.add(archivedTask.id);
        }
      }
    }
  }

  let totalTasks = 0;

  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      throw new TodoPlanError('INVALID_SCHEMA', `phases[${i}] must be an object`);
    }
    assertValidId(phase.id, `phases[${i}].id`);
    if (globalSeenIds.has(phase.id)) {
      throw new TodoPlanError('DUPLICATE_ID', `Duplicate ID "${phase.id}" across plan`, {
        id: phase.id,
      });
    }
    globalSeenIds.add(phase.id);
    activePhaseMap.set(phase.id, phase);

    normalizeNonEmptyString(phase.title, `phases[${i}].title`, 'INVALID_SCHEMA');
    if (typeof phase.goal !== 'string') {
      throw new TodoPlanError('INVALID_SCHEMA', `phases[${i}].goal must be a string`);
    }
    if (!Array.isArray(phase.dependsOn)) {
      throw new TodoPlanError('INVALID_SCHEMA', `phases[${i}].dependsOn must be an array`);
    }
    if (!Array.isArray(phase.tasks)) {
      throw new TodoPlanError('INVALID_SCHEMA', `phases[${i}].tasks must be an array`);
    }

    for (let j = 0; j < phase.tasks.length; j += 1) {
      totalTasks += 1;
      if (totalTasks > MAX_TASKS) {
        throw new TodoPlanError('INVALID_SCHEMA', `Task count exceeds maximum (${MAX_TASKS})`, {
          maxTasks: MAX_TASKS,
        });
      }
      const task = phase.tasks[j];
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new TodoPlanError('INVALID_SCHEMA', `phases[${i}].tasks[${j}] must be an object`);
      }
      assertValidId(task.id, `phases[${i}].tasks[${j}].id`);
      if (globalSeenIds.has(task.id)) {
        throw new TodoPlanError('DUPLICATE_ID', `Duplicate ID "${task.id}" across plan`, {
          id: task.id,
        });
      }
      globalSeenIds.add(task.id);
      activeTaskMap.set(task.id, task);
      allActiveTasks.push(task);

      normalizeNonEmptyString(task.title, `task ${task.id}.title`, 'INVALID_SCHEMA');
      if (typeof task.acceptance !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.acceptance must be a string`);
      }
      if (task.owner !== null && typeof task.owner !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.owner must be string or null`);
      }
      if (task.claimedAt !== null && typeof task.claimedAt !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.claimedAt must be string or null`);
      }
      if (!Array.isArray(task.dependsOn)) {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.dependsOn must be an array`);
      }
      if (!VALID_STATUSES.includes(task.status)) {
        throw new TodoPlanError('INVALID_SCHEMA', `Invalid status "${task.status}" on task ${task.id}`, {
          taskId: task.id,
          status: task.status,
        });
      }
      if (typeof task.statusUpdatedAt !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.statusUpdatedAt must be an ISO string`);
      }
      if (task.status === 'impossible' || task.status === 'error') {
        if (typeof task.statusReason !== 'string' || !task.statusReason.trim()) {
          throw new TodoPlanError(
            'REASON_REQUIRED',
            `Task ${task.id} with status "${task.status}" requires a non-empty statusReason`,
            { taskId: task.id, status: task.status }
          );
        }
      } else if (task.statusReason !== null && typeof task.statusReason !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.statusReason must be string or null`);
      }
      if (task.note !== null && typeof task.note !== 'string') {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.note must be string or null`);
      }
      if (!Array.isArray(task.evidence) || task.evidence.some((e) => typeof e !== 'string')) {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.evidence must be an array of strings`);
      }
      if (typeof task.origin !== 'string' || !task.origin.trim()) {
        throw new TodoPlanError('INVALID_SCHEMA', `task ${task.id}.origin must be a non-empty string`);
      }
    }

    phase.status = derivePhaseStatus(phase);
  }

  // Validate Phase DAG
  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    for (let j = 0; j < phase.dependsOn.length; j += 1) {
      const depId = phase.dependsOn[j];
      if (!activePhaseMap.has(depId)) {
        throw new TodoPlanError(
          'DEPENDENCY_MISSING',
          `Phase ${phase.id} depends on missing active phase "${depId}"`,
          { kind: 'phase', phaseId: phase.id, missingId: depId }
        );
      }
    }
  }
  detectCycle(plan.phases, (id) => activePhaseMap.get(id).dependsOn, 'phase');

  // Validate Task DAG
  for (let i = 0; i < allActiveTasks.length; i += 1) {
    const task = allActiveTasks[i];
    for (let j = 0; j < task.dependsOn.length; j += 1) {
      const depId = task.dependsOn[j];
      if (!activeTaskMap.has(depId)) {
        throw new TodoPlanError(
          'DEPENDENCY_MISSING',
          `Task ${task.id} depends on missing active task "${depId}"`,
          { kind: 'task', taskId: task.id, missingId: depId }
        );
      }
    }
  }
  detectCycle(allActiveTasks, (id) => activeTaskMap.get(id).dependsOn, 'task');

  return plan;
}

function getSummary(plan) {
  const phaseMap = new Map();
  const taskMap = new Map();

  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    const derivedStatus = derivePhaseStatus(phase);
    phaseMap.set(phase.id, { phase, status: derivedStatus });
    for (let j = 0; j < phase.tasks.length; j += 1) {
      taskMap.set(phase.tasks[j].id, { task: phase.tasks[j], phaseId: phase.id });
    }
  }

  let totalTasks = 0;
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let impossible = 0;
  let errorCount = 0;
  const emptyPhases = [];
  const inProgressTasks = [];
  const readyTasks = [];
  const issues = [];
  const upstreamBlocked = [];
  const dependencyWarnings = [];
  const phaseSummaries = [];

  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    const pStatus = phaseMap.get(phase.id).status;

    let pCompleted = 0;
    let pPending = 0;
    let pInProgress = 0;
    let pImpossible = 0;
    let pError = 0;
    let hasStartedOrCompleted = false;

    if (phase.tasks.length === 0) {
      emptyPhases.push({ id: phase.id, title: phase.title });
    }

    const phaseDepsCompleted = phase.dependsOn.every((depId) => {
      const entry = phaseMap.get(depId);
      return entry && entry.status === 'completed';
    });

    for (let j = 0; j < phase.tasks.length; j += 1) {
      const task = phase.tasks[j];
      totalTasks += 1;

      if (task.status === 'completed') {
        completed += 1;
        pCompleted += 1;
        hasStartedOrCompleted = true;
      } else if (task.status === 'in_progress') {
        inProgress += 1;
        pInProgress += 1;
        hasStartedOrCompleted = true;
        inProgressTasks.push({
          id: task.id,
          phaseId: phase.id,
          title: task.title,
          owner: task.owner,
          claimedAt: task.claimedAt,
          note: task.note,
          origin: task.origin,
        });
      } else if (task.status === 'pending') {
        pending += 1;
        pPending += 1;
        const taskDepsCompleted = task.dependsOn.every((depId) => {
          const entry = taskMap.get(depId);
          return entry && entry.task.status === 'completed';
        });
        if (phaseDepsCompleted && taskDepsCompleted) {
          readyTasks.push({
            id: task.id,
            phaseId: phase.id,
            title: task.title,
            owner: task.owner,
          });
        }
      } else if (task.status === 'impossible') {
        impossible += 1;
        pImpossible += 1;
        issues.push({
          id: task.id,
          phaseId: phase.id,
          title: task.title,
          status: task.status,
          statusReason: task.statusReason,
          owner: task.owner,
          evidence: [...task.evidence],
        });
      } else if (task.status === 'error') {
        errorCount += 1;
        pError += 1;
        issues.push({
          id: task.id,
          phaseId: phase.id,
          title: task.title,
          status: task.status,
          statusReason: task.statusReason,
          owner: task.owner,
          evidence: [...task.evidence],
        });
      }
    }

    if (hasStartedOrCompleted) {
      for (let d = 0; d < phase.dependsOn.length; d += 1) {
        const upPhaseId = phase.dependsOn[d];
        const upEntry = phaseMap.get(upPhaseId);
        if (upEntry && upEntry.status !== 'completed') {
          dependencyWarnings.push({
            code: 'UPSTREAM_PHASE_REOPENED',
            phaseId: phase.id,
            upstreamPhaseId: upPhaseId,
            upstreamStatus: upEntry.status,
            message: `Phase ${phase.id} already has in_progress/completed tasks while upstream phase ${upPhaseId} is "${upEntry.status}"`,
          });
        }
      }
    }

    phaseSummaries.push({
      id: phase.id,
      title: phase.title,
      goal: phase.goal,
      dependsOn: [...phase.dependsOn],
      status: pStatus,
      totalTasks: phase.tasks.length,
      completed: pCompleted,
      unfinished: pPending + pInProgress,
      pending: pPending,
      inProgress: pInProgress,
      impossible: pImpossible,
      error: pError,
    });
  }

  // Compute transitive upstreamBlocked for unfinished active tasks
  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    for (let j = 0; j < phase.tasks.length; j += 1) {
      const task = phase.tasks[j];
      if (task.status !== 'pending' && task.status !== 'in_progress') continue;

      const visitedTasks = new Set([task.id]);
      const visitedPhases = new Set();
      const blockedBy = [];
      const blockedKeys = new Set();

      const taskQueue = [...task.dependsOn];
      const phaseQueue = [...phase.dependsOn];

      while (taskQueue.length > 0 || phaseQueue.length > 0) {
        while (taskQueue.length > 0) {
          const upTaskId = taskQueue.shift();
          if (visitedTasks.has(upTaskId)) continue;
          visitedTasks.add(upTaskId);
          const upTaskEntry = taskMap.get(upTaskId);
          if (!upTaskEntry) continue;
          const upTask = upTaskEntry.task;

          if (upTask.status === 'error' || upTask.status === 'impossible') {
            const key = `task:${upTask.id}`;
            if (!blockedKeys.has(key)) {
              blockedKeys.add(key);
              blockedBy.push({
                kind: 'task',
                id: upTask.id,
                status: upTask.status,
                statusReason: upTask.statusReason,
              });
            }
          }

          for (let k = 0; k < upTask.dependsOn.length; k += 1) {
            if (!visitedTasks.has(upTask.dependsOn[k])) {
              taskQueue.push(upTask.dependsOn[k]);
            }
          }
          const upTaskPhaseEntry = phaseMap.get(upTaskEntry.phaseId);
          if (upTaskPhaseEntry) {
            for (let k = 0; k < upTaskPhaseEntry.phase.dependsOn.length; k += 1) {
              const pDep = upTaskPhaseEntry.phase.dependsOn[k];
              if (!visitedPhases.has(pDep)) {
                phaseQueue.push(pDep);
              }
            }
          }
        }

        while (phaseQueue.length > 0) {
          const upPhaseId = phaseQueue.shift();
          if (visitedPhases.has(upPhaseId)) continue;
          visitedPhases.add(upPhaseId);
          const upPhaseEntry = phaseMap.get(upPhaseId);
          if (!upPhaseEntry) continue;

          if (upPhaseEntry.status === 'error' || upPhaseEntry.status === 'impossible') {
            const key = `phase:${upPhaseId}`;
            if (!blockedKeys.has(key)) {
              blockedKeys.add(key);
              const representative = upPhaseEntry.phase.tasks.find(
                (t) => t.status === upPhaseEntry.status
              );
              blockedBy.push({
                kind: 'phase',
                id: upPhaseId,
                status: upPhaseEntry.status,
                statusReason: representative ? representative.statusReason : null,
              });
            }
          }

          for (let k = 0; k < upPhaseEntry.phase.dependsOn.length; k += 1) {
            const pDep = upPhaseEntry.phase.dependsOn[k];
            if (!visitedPhases.has(pDep)) {
              phaseQueue.push(pDep);
            }
          }
          for (let k = 0; k < upPhaseEntry.phase.tasks.length; k += 1) {
            const pt = upPhaseEntry.phase.tasks[k];
            for (let m = 0; m < pt.dependsOn.length; m += 1) {
              const tDep = pt.dependsOn[m];
              if (!visitedTasks.has(tDep)) {
                taskQueue.push(tDep);
              }
            }
          }
        }
      }

      if (blockedBy.length > 0) {
        upstreamBlocked.push({
          id: task.id,
          phaseId: phase.id,
          title: task.title,
          status: task.status,
          blockedBy,
        });
      }
    }
  }

  const unfinished = pending + inProgress;
  const completionRate = totalTasks === 0 ? 0 : Number((completed / totalTasks).toFixed(4));

  let isComplete = false;
  let completeGateCode = 'PLAN_INCOMPLETE';
  if (totalTasks === 0 || emptyPhases.length > 0) {
    isComplete = false;
    completeGateCode = 'PLAN_EMPTY';
  } else if (completed === totalTasks) {
    isComplete = true;
    completeGateCode = 'PLAN_COMPLETE';
  }

  return {
    planId: plan.planId,
    title: plan.title,
    goal: plan.goal,
    revision: plan.revision,
    updatedAt: plan.updatedAt,
    counts: {
      phases: plan.phases.length,
      emptyPhases: emptyPhases.length,
      totalTasks,
      completed,
      unfinished,
      pending,
      inProgress,
      impossible,
      error: errorCount,
      archived: plan.archived.length,
      completionRate,
    },
    isComplete,
    completeGateCode,
    inProgressTasks,
    readyTasks,
    upstreamBlocked,
    issues,
    emptyPhases,
    dependencyWarnings,
    phases: phaseSummaries,
  };
}

function checkComplete(plan) {
  const summary = getSummary(plan);
  if (summary.completeGateCode === 'PLAN_COMPLETE') {
    return { ok: true, exitCode: EXIT_CODES.PLAN_COMPLETE, code: 'PLAN_COMPLETE', summary };
  }
  if (summary.completeGateCode === 'PLAN_EMPTY') {
    return { ok: false, exitCode: EXIT_CODES.PLAN_EMPTY, code: 'PLAN_EMPTY', summary };
  }
  return { ok: false, exitCode: EXIT_CODES.PLAN_INCOMPLETE, code: 'PLAN_INCOMPLETE', summary };
}

function collectAllUsedIds(plan) {
  const used = new Set();
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    used.add(p.id);
    for (let j = 0; j < p.tasks.length; j += 1) {
      used.add(p.tasks[j].id);
    }
  }
  for (let i = 0; i < plan.archived.length; i += 1) {
    const a = plan.archived[i];
    if (a && typeof a.id === 'string') used.add(a.id);
    if (a && Array.isArray(a.tasks)) {
      for (let j = 0; j < a.tasks.length; j += 1) {
        if (a.tasks[j] && typeof a.tasks[j].id === 'string') {
          used.add(a.tasks[j].id);
        }
      }
    }
  }
  return used;
}

function allocatePhaseId(plan, requestedId) {
  const used = collectAllUsedIds(plan);
  if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
    const id = assertValidId(requestedId, 'id');
    if (used.has(id)) {
      throw new TodoPlanError('DUPLICATE_ID', `Phase ID "${id}" already exists in plan or archive`, {
        id,
      });
    }
    return id;
  }
  let seq = plan.nextPhaseSeq;
  while (used.has(`P${seq}`)) {
    seq += 1;
  }
  const newId = `P${seq}`;
  plan.nextPhaseSeq = seq + 1;
  return newId;
}

function allocateTaskId(plan, phaseId, requestedId) {
  const used = collectAllUsedIds(plan);
  if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
    const id = assertValidId(requestedId, 'id');
    if (used.has(id)) {
      throw new TodoPlanError('DUPLICATE_ID', `Task ID "${id}" already exists in plan or archive`, {
        id,
      });
    }
    return id;
  }
  let seq = plan.nextTaskSeq;
  while (used.has(`${phaseId}-T${seq}`)) {
    seq += 1;
  }
  const newId = `${phaseId}-T${seq}`;
  plan.nextTaskSeq = seq + 1;
  return newId;
}

function countActiveTasks(plan) {
  let total = 0;
  for (let i = 0; i < plan.phases.length; i += 1) {
    total += plan.phases[i].tasks.length;
  }
  return total;
}

function findPhase(plan, phaseId) {
  const id = normalizeNonEmptyString(phaseId, 'phaseId');
  for (let i = 0; i < plan.phases.length; i += 1) {
    if (plan.phases[i].id === id) {
      return { phase: plan.phases[i], index: i };
    }
  }
  throw new TodoPlanError('NOT_FOUND', `Phase "${id}" not found`, { phaseId: id });
}

function findTask(plan, taskId) {
  const id = normalizeNonEmptyString(taskId, 'taskId');
  for (let i = 0; i < plan.phases.length; i += 1) {
    const phase = plan.phases[i];
    for (let j = 0; j < phase.tasks.length; j += 1) {
      if (phase.tasks[j].id === id) {
        return { task: phase.tasks[j], phase, phaseIndex: i, taskIndex: j };
      }
    }
  }
  throw new TodoPlanError('NOT_FOUND', `Task "${id}" not found`, { taskId: id });
}

function assertDuringTaskExists(plan, duringTaskId, role, actor) {
  if (duringTaskId === undefined || duringTaskId === null || duringTaskId === '') return null;
  const id = normalizeNonEmptyString(duringTaskId, 'duringTaskId');
  const found = findTask(plan, id);
  if (role === 'author' && found.task.owner && found.task.owner !== actor) {
    throw new TodoPlanError(
      'NOT_TASK_OWNER',
      `Author "${actor}" cannot reference duringTaskId "${id}" owned by "${found.task.owner}"`,
      { taskId: id, owner: found.task.owner, actor }
    );
  }
  return id;
}

function assertCoordinatorOnly(role, action) {
  if (role !== 'coordinator') {
    throw new TodoPlanError(
      'ROLE_FORBIDDEN',
      `Role "${role}" is not permitted to perform "${action}"`,
      { role, action }
    );
  }
}

function assertAuthorOwnership(role, actor, task, action) {
  if (role === 'author' && task.owner && task.owner !== actor) {
    throw new TodoPlanError(
      'NOT_TASK_OWNER',
      `Author "${actor}" cannot perform "${action}" on task "${task.id}" owned by "${task.owner}"`,
      { taskId: task.id, owner: task.owner, actor, action }
    );
  }
}

function checkDependenciesMet(plan, phase, task) {
  const unmet = [];
  for (let i = 0; i < phase.dependsOn.length; i += 1) {
    const upPhaseId = phase.dependsOn[i];
    const upPhase = plan.phases.find((p) => p.id === upPhaseId);
    const upStatus = upPhase ? derivePhaseStatus(upPhase) : 'missing';
    if (upStatus !== 'completed') {
      unmet.push({ kind: 'phase', id: upPhaseId, status: upStatus });
    }
  }
  for (let i = 0; i < task.dependsOn.length; i += 1) {
    const upTaskId = task.dependsOn[i];
    let upStatus = 'missing';
    try {
      upStatus = findTask(plan, upTaskId).task.status;
    } catch (_) {
      upStatus = 'missing';
    }
    if (upStatus !== 'completed') {
      unmet.push({ kind: 'task', id: upTaskId, status: upStatus });
    }
  }
  return unmet;
}

function enforceDependencies(plan, phase, task, { allowUnmetDeps = false, reason } = {}) {
  const unmet = checkDependenciesMet(plan, phase, task);
  if (unmet.length === 0) {
    return { bypassed: false, unmet: [] };
  }
  if (!allowUnmetDeps) {
    throw new TodoPlanError(
      'DEPENDENCY_UNMET',
      `Task "${task.id}" has unmet dependencies: ${unmet.map((u) => `${u.kind}:${u.id}(${u.status})`).join(', ')}`,
      { taskId: task.id, unmet }
    );
  }
  normalizeNonEmptyString(reason, 'reason', 'REASON_REQUIRED');
  return { bypassed: true, unmet };
}

function appendHistory(plan, entry) {
  plan.history.push(entry);
  const maxEntries = Number.isInteger(plan.maxHistoryEntries) && plan.maxHistoryEntries > 0
    ? plan.maxHistoryEntries
    : DEFAULT_MAX_HISTORY;
  while (plan.history.length > maxEntries) {
    plan.history.shift();
    plan.truncatedHistoryCount = (plan.truncatedHistoryCount || 0) + 1;
  }
}

function recordRecentRequest(plan, requestId, payloadSha256, compactResponse) {
  if (!requestId) return;
  plan.recentRequests.push({
    requestId,
    payloadSha256,
    recordedAt: new Date().toISOString(),
    response: compactResponse,
  });
  while (plan.recentRequests.length > MAX_RECENT_REQUESTS) {
    plan.recentRequests.shift();
  }
}

function normalizeViewSetting(val) {
  if (val === undefined) return undefined;
  if (val === null || val === '' || val === 'none') return null;
  if (typeof val !== 'string') {
    throw new TodoPlanError('INVALID_ARGUMENT', 'View path must be a string, "none", or null');
  }
  assertSafeValue(val, 'viewPath');
  const trimmed = val.trim();
  return trimmed === '' || trimmed === 'none' ? null : trimmed;
}

function syncSidecarViews(plan, summary, resolvedPlanPath, options, warnings) {
  if (options.noSync === true) return;

  const mdTarget = options.syncMd === 'none'
    ? null
    : (normalizeViewSetting(options.syncMd) || plan.views.markdownPath);
  const htmlTarget = options.syncHtml === 'none'
    ? null
    : (normalizeViewSetting(options.syncHtml) || plan.views.htmlPath);

  if (!mdTarget && !htmlTarget) return;

  let renderers = options.renderers || null;
  if (!renderers) {
    try {
      renderers = require('./todo-plan-render');
    } catch (err) {
      if (mdTarget) {
        warnings.push({
          code: 'VIEW_SYNC_FAILED',
          target: 'markdown',
          path: mdTarget,
          message: `Renderer module unavailable: ${err.message}`,
        });
      }
      if (htmlTarget) {
        warnings.push({
          code: 'VIEW_SYNC_FAILED',
          target: 'html',
          path: htmlTarget,
          message: `Renderer module unavailable: ${err.message}`,
        });
      }
      return;
    }
  }

  const baseDir = path.dirname(resolvedPlanPath);
  const root = options.root;

  if (mdTarget) {
    try {
      const safeMdPath = resolveSidecarPath(mdTarget, { baseDir, root });
      const mdFn = renderers.markdown || renderers.renderMarkdown;
      if (typeof mdFn !== 'function') {
        throw new Error('Markdown renderer function not provided');
      }
      const mdContent = mdFn(plan, summary, { renderedAt: new Date().toISOString() });
      atomicWriteFile(safeMdPath, mdContent);
    } catch (err) {
      warnings.push({
        code: 'VIEW_SYNC_FAILED',
        target: 'markdown',
        path: mdTarget,
        message: err.message,
      });
    }
  }

  if (htmlTarget) {
    try {
      const safeHtmlPath = resolveSidecarPath(htmlTarget, { baseDir, root });
      const htmlFn = renderers.html || renderers.renderHtml;
      if (typeof htmlFn !== 'function') {
        throw new Error('HTML renderer function not provided');
      }
      const htmlContent = htmlFn(plan, summary, { renderedAt: new Date().toISOString() });
      atomicWriteFile(safeHtmlPath, htmlContent);
    } catch (err) {
      warnings.push({
        code: 'VIEW_SYNC_FAILED',
        target: 'html',
        path: htmlTarget,
        message: err.message,
      });
    }
  }
}

function buildCompactResponse(fullResponse) {
  const copy = { ...fullResponse };
  delete copy.plan;
  delete copy.summary;
  delete copy.resolvedPlanPath;
  delete copy.idempotentReplay;
  return deepClone(copy);
}

function extractRequestParams(action, options) {
  const excluded = new Set([
    'file',
    'root',
    'env',
    'renderers',
    'requestId',
    'lockWaitMs',
    'noSync',
    'shared',
  ]);
  if (action !== 'configure_views' && action !== 'init') {
    excluded.add('syncMd');
    excluded.add('syncHtml');
  }
  if (action === 'init') {
    excluded.add('force');
  }
  const params = {};
  const keys = Object.keys(options || {}).sort();
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (excluded.has(k) || options[k] === undefined) continue;
    params[k] = options[k];
  }
  return params;
}

// ---------------- Internal Mutation Helpers (operate on draft plan) ----------------

function opAddPhase(plan, opts, ctx) {
  assertCoordinatorOnly(ctx.role, 'add_phase');
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  if (plan.phases.length >= MAX_PHASES) {
    throw new TodoPlanError('INVALID_ARGUMENT', `Cannot exceed maxPhases (${MAX_PHASES})`, {
      maxPhases: MAX_PHASES,
    });
  }
  const title = normalizeNonEmptyString(opts.title, 'title');
  const goal = normalizeOptionalText(opts.goal, 'goal');
  const dependsOn = normalizeIdArray(opts.dependsOn, 'dependsOn');
  const id = allocatePhaseId(plan, opts.id);

  if (opts.before && opts.after) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'Cannot specify both "before" and "after"');
  }

  const phase = {
    id,
    title,
    goal,
    dependsOn,
    status: 'empty',
    tasks: [],
  };

  if (opts.before) {
    const { index } = findPhase(plan, opts.before);
    plan.phases.splice(index, 0, phase);
  } else if (opts.after) {
    const { index } = findPhase(plan, opts.after);
    plan.phases.splice(index + 1, 0, phase);
  } else {
    plan.phases.push(phase);
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'add_phase',
    phaseId: phase.id,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    summary: `Added phase ${phase.id}: ${phase.title}`,
  };
  return { mutated: true, extra: { phase: deepClone(phase) }, historyEntry };
}

function opUpdatePhase(plan, opts, ctx) {
  assertCoordinatorOnly(ctx.role, 'update_phase');
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { phase } = findPhase(plan, opts.phaseId ?? opts.id);

  if (opts.title !== undefined) {
    phase.title = normalizeNonEmptyString(opts.title, 'title');
  }
  if (opts.goal !== undefined) {
    phase.goal = normalizeOptionalText(opts.goal, 'goal');
  }
  if (opts.dependsOn !== undefined) {
    phase.dependsOn = normalizeIdArray(opts.dependsOn, 'dependsOn');
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'update_phase',
    phaseId: phase.id,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    summary: `Updated phase ${phase.id}`,
  };
  return { mutated: true, extra: { phase: deepClone(phase) }, historyEntry };
}

function opRemovePhase(plan, opts, ctx) {
  assertCoordinatorOnly(ctx.role, 'remove_phase');
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { phase, index } = findPhase(plan, opts.phaseId ?? opts.id);

  const removedTaskIds = new Set(phase.tasks.map((t) => t.id));
  const externalPhaseRefs = [];
  const externalTaskRefs = [];

  for (let i = 0; i < plan.phases.length; i += 1) {
    const other = plan.phases[i];
    if (other.id === phase.id) continue;
    if (other.dependsOn.includes(phase.id)) {
      externalPhaseRefs.push(other.id);
    }
    for (let j = 0; j < other.tasks.length; j += 1) {
      const t = other.tasks[j];
      const hit = t.dependsOn.filter((dep) => removedTaskIds.has(dep));
      if (hit.length > 0) {
        externalTaskRefs.push({ taskId: t.id, dependsOn: hit });
      }
    }
  }

  const purge = Boolean(opts.purge);
  const unlinkDeps = Boolean(opts.unlinkDeps);

  if (externalPhaseRefs.length > 0 || externalTaskRefs.length > 0) {
    if (!unlinkDeps) {
      throw new TodoPlanError(
        'DEPENDENCY_IN_USE',
        `Phase "${phase.id}" or its tasks are referenced by active dependencies`,
        { phaseId: phase.id, externalPhaseRefs, externalTaskRefs }
      );
    }
    for (let i = 0; i < plan.phases.length; i += 1) {
      const other = plan.phases[i];
      if (other.id === phase.id) continue;
      other.dependsOn = other.dependsOn.filter((dep) => dep !== phase.id);
      for (let j = 0; j < other.tasks.length; j += 1) {
        other.tasks[j].dependsOn = other.tasks[j].dependsOn.filter((dep) => !removedTaskIds.has(dep));
      }
    }
  }

  plan.phases.splice(index, 1);

  if (!purge) {
    plan.archived.push({
      kind: 'phase',
      id: phase.id,
      title: phase.title,
      goal: phase.goal,
      dependsOn: [...phase.dependsOn],
      tasks: deepClone(phase.tasks),
      archivedAt: ctx.now,
      action: 'remove_phase',
      reason,
      duringTaskId,
    });
  }

  const historyEntry = {
    at: ctx.now,
    action: 'remove_phase',
    phaseId: phase.id,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    purged: purge,
    unlinkedDeps: unlinkDeps,
    summary: `${purge ? 'Purged' : 'Archived'} phase ${phase.id}`,
  };
  return {
    mutated: true,
    extra: { removedPhaseId: phase.id, purged: purge },
    historyEntry,
  };
}

function opReorderPhases(plan, opts, ctx) {
  assertCoordinatorOnly(ctx.role, 'reorder_phases');
  const order = normalizeIdArray(opts.order, 'order');
  if (order.length !== plan.phases.length) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `order must contain all ${plan.phases.length} active phase IDs`,
      { expectedCount: plan.phases.length, actualCount: order.length }
    );
  }
  const byId = new Map(plan.phases.map((p) => [p.id, p]));
  const reordered = [];
  for (let i = 0; i < order.length; i += 1) {
    const p = byId.get(order[i]);
    if (!p) {
      throw new TodoPlanError('NOT_FOUND', `Phase "${order[i]}" not found in active phases`, {
        phaseId: order[i],
      });
    }
    reordered.push(p);
  }
  plan.phases = reordered;

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'reorder_phases',
    order,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Reordered phases: ${order.join(', ')}`,
  };
  return { mutated: true, extra: { order }, historyEntry };
}

function opAddTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot add tasks', {
      role: ctx.role,
      action: 'add_task',
    });
  }
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { phase } = findPhase(plan, opts.phaseId ?? opts.phase);

  if (countActiveTasks(plan) >= MAX_TASKS) {
    throw new TodoPlanError('INVALID_ARGUMENT', `Cannot exceed maxTasks (${MAX_TASKS})`, {
      maxTasks: MAX_TASKS,
    });
  }

  const title = normalizeNonEmptyString(opts.title, 'title');
  const acceptance = normalizeOptionalText(opts.acceptance, 'acceptance');
  const owner = normalizeNullableString(opts.owner, 'owner');
  if (ctx.role === 'author' && owner !== null && owner !== ctx.actor) {
    throw new TodoPlanError(
      'ROLE_FORBIDDEN',
      `Author "${ctx.actor}" cannot assign new task to "${owner}"`,
      { role: ctx.role, actor: ctx.actor, owner }
    );
  }
  const dependsOn = normalizeIdArray(opts.dependsOn, 'dependsOn');
  const id = allocateTaskId(plan, phase.id, opts.id);

  if (opts.before && opts.after) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'Cannot specify both "before" and "after"');
  }

  const task = {
    id,
    title,
    acceptance,
    owner,
    claimedAt: null,
    dependsOn,
    status: 'pending',
    statusUpdatedAt: ctx.now,
    statusReason: null,
    note: normalizeNullableString(opts.note, 'note'),
    evidence: normalizeEvidenceList(opts.evidence),
    origin: duringTaskId ? `added_during:${duringTaskId}` : 'initial',
  };

  if (opts.before) {
    const idx = phase.tasks.findIndex((t) => t.id === opts.before);
    if (idx === -1) {
      throw new TodoPlanError('NOT_FOUND', `Reference task "${opts.before}" not found in phase "${phase.id}"`, {
        taskId: opts.before,
        phaseId: phase.id,
      });
    }
    phase.tasks.splice(idx, 0, task);
  } else if (opts.after) {
    const idx = phase.tasks.findIndex((t) => t.id === opts.after);
    if (idx === -1) {
      throw new TodoPlanError('NOT_FOUND', `Reference task "${opts.after}" not found in phase "${phase.id}"`, {
        taskId: opts.after,
        phaseId: phase.id,
      });
    }
    phase.tasks.splice(idx + 1, 0, task);
  } else {
    phase.tasks.push(task);
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'add_task',
    phaseId: phase.id,
    taskId: task.id,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    summary: `Added task ${task.id} to ${phase.id}: ${task.title}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opUpdateTask(plan, opts, ctx) {
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { task, phase, taskIndex } = findTask(plan, opts.taskId ?? opts.id);

  if (ctx.role === 'verifier') {
    const forbiddenForVerifier =
      opts.title !== undefined ||
      opts.acceptance !== undefined ||
      opts.owner !== undefined ||
      opts.dependsOn !== undefined ||
      opts.moveToPhase !== undefined ||
      Boolean(opts.resetStatus);
    if (forbiddenForVerifier) {
      throw new TodoPlanError(
        'ROLE_FORBIDDEN',
        'Role "verifier" may only add evidence or note via update_task',
        { role: ctx.role, action: 'update_task', taskId: task.id }
      );
    }
  } else if (ctx.role === 'author') {
    assertAuthorOwnership(ctx.role, ctx.actor, task, 'update_task');
    if (opts.owner !== undefined) {
      const requestedOwner = normalizeNullableString(opts.owner, 'owner');
      if (requestedOwner !== null && requestedOwner !== ctx.actor) {
        throw new TodoPlanError(
          'ROLE_FORBIDDEN',
          `Author "${ctx.actor}" cannot assign task "${task.id}" to "${requestedOwner}"`,
          { role: ctx.role, actor: ctx.actor, requestedOwner }
        );
      }
    }
    if (opts.moveToPhase !== undefined && opts.moveToPhase !== null && opts.moveToPhase !== '') {
      throw new TodoPlanError(
        'ROLE_FORBIDDEN',
        `Author "${ctx.actor}" cannot move task "${task.id}" to another phase`,
        { role: ctx.role, actor: ctx.actor, action: 'update_task', taskId: task.id }
      );
    }
  }

  let targetPhase = phase;

  if (opts.title !== undefined) {
    task.title = normalizeNonEmptyString(opts.title, 'title');
  }
  if (opts.acceptance !== undefined) {
    task.acceptance = normalizeOptionalText(opts.acceptance, 'acceptance');
  }
  if (opts.owner !== undefined) {
    task.owner = normalizeNullableString(opts.owner, 'owner');
    if (!task.owner) task.claimedAt = null;
  }
  if (opts.dependsOn !== undefined) {
    task.dependsOn = normalizeIdArray(opts.dependsOn, 'dependsOn');
  }
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }
  if (opts.moveToPhase !== undefined && opts.moveToPhase !== null && opts.moveToPhase !== '') {
    const dest = findPhase(plan, opts.moveToPhase);
    if (dest.phase.id !== phase.id) {
      phase.tasks.splice(taskIndex, 1);
      dest.phase.tasks.push(task);
      targetPhase = dest.phase;
    }
  }
  let previousStatus = null;
  let previousStatusReason = null;
  const resetStatus = Boolean(opts.resetStatus);
  const explicitReason = normalizeNullableString(opts.reason, 'reason');
  if (resetStatus) {
    if (
      (task.status === 'completed' || task.status === 'impossible' || task.status === 'error') &&
      !explicitReason
    ) {
      throw new TodoPlanError(
        'REASON_REQUIRED',
        `Resetting task "${task.id}" from status "${task.status}" requires a non-empty reason`,
        { taskId: task.id, currentStatus: task.status, field: 'reason' }
      );
    }
    previousStatus = task.status;
    previousStatusReason = task.statusReason;
    task.status = 'pending';
    task.statusUpdatedAt = ctx.now;
    task.statusReason = null;
    task.claimedAt = null;
  }

  const historyEntry = {
    at: ctx.now,
    action: 'update_task',
    phaseId: targetPhase.id,
    taskId: task.id,
    prevStatus: previousStatus || undefined,
    nextStatus: resetStatus ? 'pending' : undefined,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason: explicitReason,
    previousStatusReason: previousStatusReason || undefined,
    summary: `Updated task ${task.id}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: targetPhase.id }, historyEntry };
}

function opSplitTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot split tasks', {
      role: ctx.role,
      action: 'split_task',
    });
  }
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const mode = opts.mode || 'chain';
  if (mode !== 'chain' && mode !== 'parallel') {
    throw new TodoPlanError('INVALID_ARGUMENT', `Invalid split mode "${mode}" (expected "chain" or "parallel")`, {
      mode,
    });
  }
  if (!Array.isArray(opts.into) || opts.into.length < 2) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'split_task requires at least 2 child items in "into"', {
      field: 'into',
    });
  }

  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { task, phase, taskIndex } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'split_task');

  if (countActiveTasks(plan) - 1 + opts.into.length > MAX_TASKS) {
    throw new TodoPlanError('INVALID_ARGUMENT', `Splitting task exceeds maxTasks (${MAX_TASKS})`, {
      maxTasks: MAX_TASKS,
    });
  }

  const normalizedItems = opts.into.map((item, idx) => {
    if (typeof item === 'string') {
      return { title: normalizeNonEmptyString(item, `into[${idx}]`) };
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return {
        id: item.id,
        title: normalizeNonEmptyString(item.title, `into[${idx}].title`),
        acceptance: item.acceptance !== undefined ? normalizeOptionalText(item.acceptance, `into[${idx}].acceptance`) : undefined,
        owner: item.owner !== undefined ? normalizeNullableString(item.owner, `into[${idx}].owner`) : undefined,
      };
    }
    throw new TodoPlanError('INVALID_ARGUMENT', `into[${idx}] must be a non-empty string or task object`, {
      field: 'into',
    });
  });

  if (ctx.role === 'author') {
    for (let i = 0; i < normalizedItems.length; i += 1) {
      const targetOwner = normalizedItems[i].owner !== undefined ? normalizedItems[i].owner : task.owner;
      if (targetOwner !== null && targetOwner !== ctx.actor) {
        throw new TodoPlanError(
          'ROLE_FORBIDDEN',
          `Author "${ctx.actor}" cannot assign split child task to "${targetOwner}"`,
          { role: ctx.role, actor: ctx.actor, owner: targetOwner }
        );
      }
    }
  }

  const used = collectAllUsedIds(plan);
  const children = [];

  for (let i = 0; i < normalizedItems.length; i += 1) {
    const item = normalizedItems[i];
    let childId;
    if (item.id !== undefined && item.id !== null && item.id !== '') {
      childId = assertValidId(item.id, `into[${i}].id`);
      if (used.has(childId)) {
        throw new TodoPlanError('DUPLICATE_ID', `Child task ID "${childId}" already exists`, { id: childId });
      }
    } else {
      let seq = plan.nextTaskSeq;
      while (used.has(`${phase.id}-T${seq}`)) {
        seq += 1;
      }
      childId = `${phase.id}-T${seq}`;
      plan.nextTaskSeq = seq + 1;
    }
    used.add(childId);

    let childDeps;
    if (mode === 'chain') {
      childDeps = i === 0 ? [...task.dependsOn] : [children[i - 1].id];
    } else {
      childDeps = [...task.dependsOn];
    }

    children.push({
      id: childId,
      title: item.title,
      acceptance: item.acceptance !== undefined ? item.acceptance : task.acceptance,
      owner: item.owner !== undefined ? item.owner : task.owner,
      claimedAt: null,
      dependsOn: childDeps,
      status: 'pending',
      statusUpdatedAt: ctx.now,
      statusReason: null,
      note: null,
      evidence: [],
      origin: `split_from:${task.id}`,
    });
  }

  const newIds = children.map((c) => c.id);
  const rebindIds = mode === 'chain' ? [newIds[newIds.length - 1]] : [...newIds];

  // Replace original task in phase
  phase.tasks.splice(taskIndex, 1, ...children);

  // Rebind downstream Task.dependsOn references
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    for (let j = 0; j < p.tasks.length; j += 1) {
      const t = p.tasks[j];
      if (!t.dependsOn.includes(task.id)) continue;
      const updated = [];
      for (let d = 0; d < t.dependsOn.length; d += 1) {
        if (t.dependsOn[d] === task.id) {
          for (let r = 0; r < rebindIds.length; r += 1) {
            if (!updated.includes(rebindIds[r])) updated.push(rebindIds[r]);
          }
        } else if (!updated.includes(t.dependsOn[d])) {
          updated.push(t.dependsOn[d]);
        }
      }
      t.dependsOn = updated;
    }
  }

  // Archive original task
  plan.archived.push({
    kind: 'task',
    ...deepClone(task),
    phaseId: phase.id,
    archivedAt: ctx.now,
    action: 'split',
    reason,
    splitMode: mode,
    splitInto: newIds,
    duringTaskId,
  });

  const historyEntry = {
    at: ctx.now,
    action: 'split_task',
    phaseId: phase.id,
    taskId: task.id,
    mode,
    splitInto: newIds,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    summary: `Split task ${task.id} (${mode}) into ${newIds.join(', ')}`,
  };
  return {
    mutated: true,
    extra: {
      archivedTaskId: task.id,
      phaseId: phase.id,
      mode,
      splitInto: newIds,
      tasks: deepClone(children),
    },
    historyEntry,
  };
}

function opRemoveTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot remove tasks', {
      role: ctx.role,
      action: 'remove_task',
    });
  }
  const purge = Boolean(opts.purge);
  const unlinkDeps = Boolean(opts.unlinkDeps);
  if (ctx.role === 'author' && purge) {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "author" cannot purge tasks', {
      role: ctx.role,
      action: 'remove_task',
    });
  }
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const duringTaskId = assertDuringTaskExists(plan, opts.duringTaskId ?? opts.during, ctx.role, ctx.actor);
  const { task, phase, taskIndex } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'remove_task');

  const referencedBy = [];
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    for (let j = 0; j < p.tasks.length; j += 1) {
      const other = p.tasks[j];
      if (other.id !== task.id && other.dependsOn.includes(task.id)) {
        referencedBy.push(other.id);
      }
    }
  }

  if (referencedBy.length > 0) {
    if (!unlinkDeps) {
      throw new TodoPlanError(
        'DEPENDENCY_IN_USE',
        `Task "${task.id}" is referenced by active task dependencies: ${referencedBy.join(', ')}`,
        { taskId: task.id, referencedBy }
      );
    }
    for (let i = 0; i < plan.phases.length; i += 1) {
      const p = plan.phases[i];
      for (let j = 0; j < p.tasks.length; j += 1) {
        p.tasks[j].dependsOn = p.tasks[j].dependsOn.filter((dep) => dep !== task.id);
      }
    }
  }

  phase.tasks.splice(taskIndex, 1);

  if (!purge) {
    plan.archived.push({
      kind: 'task',
      ...deepClone(task),
      phaseId: phase.id,
      archivedAt: ctx.now,
      action: 'remove_task',
      reason,
      duringTaskId,
    });
  }

  const historyEntry = {
    at: ctx.now,
    action: 'remove_task',
    phaseId: phase.id,
    taskId: task.id,
    actor: ctx.actor,
    role: ctx.role,
    duringTaskId,
    reason,
    purged: purge,
    unlinkedDeps: unlinkDeps,
    summary: `${purge ? 'Purged' : 'Archived'} task ${task.id}`,
  };
  return {
    mutated: true,
    extra: { removedTaskId: task.id, phaseId: phase.id, purged: purge },
    historyEntry,
  };
}

function opReorderTasks(plan, opts, ctx) {
  assertCoordinatorOnly(ctx.role, 'reorder_tasks');
  const { phase } = findPhase(plan, opts.phaseId ?? opts.phase);
  const order = normalizeIdArray(opts.order, 'order');
  if (order.length !== phase.tasks.length) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `order must contain all ${phase.tasks.length} task IDs in phase "${phase.id}"`,
      { phaseId: phase.id, expectedCount: phase.tasks.length, actualCount: order.length }
    );
  }
  const byId = new Map(phase.tasks.map((t) => [t.id, t]));
  const reordered = [];
  for (let i = 0; i < order.length; i += 1) {
    const t = byId.get(order[i]);
    if (!t) {
      throw new TodoPlanError('NOT_FOUND', `Task "${order[i]}" not found in phase "${phase.id}"`, {
        phaseId: phase.id,
        taskId: order[i],
      });
    }
    reordered.push(t);
  }
  phase.tasks = reordered;

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'reorder_tasks',
    phaseId: phase.id,
    order,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Reordered tasks in ${phase.id}: ${order.join(', ')}`,
  };
  return { mutated: true, extra: { phaseId: phase.id, order }, historyEntry };
}

function pauseOtherInProgressForOwner(plan, excludeTaskId, effectiveOwner, now) {
  const autoPaused = [];
  const targetOwner = effectiveOwner || null;
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    for (let j = 0; j < p.tasks.length; j += 1) {
      const other = p.tasks[j];
      if (other.id === excludeTaskId) continue;
      if (other.status === 'in_progress' && (other.owner || null) === targetOwner) {
        other.status = 'pending';
        other.statusUpdatedAt = now;
        other.note = 'auto-paused by exclusive start';
        autoPaused.push(other.id);
      }
    }
  }
  return autoPaused;
}

function opStartTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot start tasks', {
      role: ctx.role,
      action: 'start',
    });
  }
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  const requestedOwner = normalizeNullableString(opts.owner, 'owner');
  const reassign = Boolean(opts.reassign);

  if (ctx.role === 'author') {
    if (reassign) {
      throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "author" cannot use --reassign', {
        role: ctx.role,
        action: 'start',
      });
    }
    if (requestedOwner && requestedOwner !== ctx.actor) {
      throw new TodoPlanError(
        'ROLE_FORBIDDEN',
        `Author "${ctx.actor}" cannot start task as owner "${requestedOwner}"`,
        { role: ctx.role, actor: ctx.actor, owner: requestedOwner }
      );
    }
    assertAuthorOwnership(ctx.role, ctx.actor, task, 'start');
  }

  const effectiveOwner = ctx.role === 'author'
    ? ctx.actor
    : (requestedOwner ?? ctx.actor ?? null);

  if (task.status === 'in_progress' && task.owner && task.owner !== effectiveOwner) {
    if (!reassign) {
      throw new TodoPlanError(
        'TASK_ALREADY_CLAIMED',
        `Task "${task.id}" is already in progress by "${task.owner}"`,
        { taskId: task.id, currentOwner: task.owner, requestedOwner: effectiveOwner }
      );
    }
    assertCoordinatorOnly(ctx.role, 'reassign');
    normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  } else if (reassign) {
    assertCoordinatorOnly(ctx.role, 'reassign');
    normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  }

  // Idempotent re-start check for same owner when already in_progress
  if (task.status === 'in_progress' && (task.owner || null) === (effectiveOwner || null) && !reassign) {
    let changed = false;
    let autoPausedTaskIds = [];
    if (opts.exclusive) {
      autoPausedTaskIds = pauseOtherInProgressForOwner(plan, task.id, effectiveOwner, ctx.now);
      if (autoPausedTaskIds.length > 0) changed = true;
    }
    if (opts.note !== undefined) {
      const nextNote = normalizeNullableString(opts.note, 'note');
      if (nextNote !== task.note) {
        task.note = nextNote;
        changed = true;
      }
    }
    if (opts.evidence !== undefined) {
      const beforeLen = task.evidence.length;
      appendEvidence(task, opts.evidence);
      if (task.evidence.length !== beforeLen) changed = true;
    }
    if (!changed) {
      return {
        mutated: false,
        code: 'OK',
        extra: { task: deepClone(task), phaseId: phase.id, autoPausedTaskIds: [] },
      };
    }
    const historyEntry = {
      at: ctx.now,
      action: 'start',
      phaseId: phase.id,
      taskId: task.id,
      actor: ctx.actor,
      role: ctx.role,
      autoPaused: autoPausedTaskIds.length ? autoPausedTaskIds : undefined,
      summary: `Updated in-progress task ${task.id}`,
    };
    return {
      mutated: true,
      code: 'OK',
      extra: { task: deepClone(task), phaseId: phase.id, autoPausedTaskIds },
      historyEntry,
    };
  }

  const depCheck = enforceDependencies(plan, phase, task, {
    allowUnmetDeps: Boolean(opts.allowUnmetDeps),
    reason: opts.reason,
  });

  const autoPausedTaskIds = opts.exclusive
    ? pauseOtherInProgressForOwner(plan, task.id, effectiveOwner, ctx.now)
    : [];

  const prevStatus = task.status;
  const prevReason = task.statusReason;

  task.status = 'in_progress';
  task.statusUpdatedAt = ctx.now;
  if (prevStatus === 'impossible' || prevStatus === 'error') {
    task.statusReason = null;
  }
  if (effectiveOwner !== null || reassign) {
    task.owner = effectiveOwner;
    task.claimedAt = effectiveOwner ? ctx.now : null;
  }
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'start',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'in_progress',
    previousStatusReason: prevReason || undefined,
    owner: task.owner,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    reassigned: reassign || undefined,
    bypassedUnmetDeps: depCheck.bypassed ? depCheck.unmet : undefined,
    autoPaused: autoPausedTaskIds.length ? autoPausedTaskIds : undefined,
    summary: `Started task ${task.id}${task.owner ? ` (owner: ${task.owner})` : ''}`,
  };
  return {
    mutated: true,
    code: 'OK',
    extra: { task: deepClone(task), phaseId: phase.id, autoPausedTaskIds },
    historyEntry,
  };
}

function opClaimNextTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot claim tasks', {
      role: ctx.role,
      action: 'claim_next',
    });
  }
  const requestedOwner = normalizeNullableString(opts.owner, 'owner');
  if (ctx.role === 'author') {
    if (requestedOwner && requestedOwner !== ctx.actor) {
      throw new TodoPlanError(
        'ROLE_FORBIDDEN',
        `Author "${ctx.actor}" cannot claim tasks for "${requestedOwner}"`,
        { role: ctx.role, actor: ctx.actor, owner: requestedOwner }
      );
    }
  }
  const effectiveOwner = ctx.role === 'author'
    ? ctx.actor
    : (requestedOwner ?? ctx.actor);
  if (!effectiveOwner) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'claim_next requires non-empty --owner or --actor', {
      field: 'owner',
    });
  }

  const filterPhaseId = normalizeNullableString(opts.phaseId ?? opts.phase, 'phaseId');
  if (filterPhaseId) {
    findPhase(plan, filterPhaseId);
  }

  const summary = getSummary(plan);
  const candidate = summary.readyTasks.find(
    (t) =>
      (!filterPhaseId || t.phaseId === filterPhaseId) &&
      (!t.owner || t.owner === effectiveOwner)
  );

  if (!candidate) {
    return {
      mutated: false,
      code: 'NO_READY_TASK',
      extra: { claimed: false, task: null },
    };
  }

  const { task, phase } = findTask(plan, candidate.id);
  const autoPausedTaskIds = opts.exclusive
    ? pauseOtherInProgressForOwner(plan, task.id, effectiveOwner, ctx.now)
    : [];

  const prevStatus = task.status;
  task.status = 'in_progress';
  task.owner = effectiveOwner;
  task.claimedAt = ctx.now;
  task.statusUpdatedAt = ctx.now;
  task.statusReason = null;
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }

  const historyEntry = {
    at: ctx.now,
    action: 'claim_next',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'in_progress',
    owner: effectiveOwner,
    actor: ctx.actor,
    role: ctx.role,
    autoPaused: autoPausedTaskIds.length ? autoPausedTaskIds : undefined,
    summary: `Claimed task ${task.id} for ${effectiveOwner}`,
  };
  return {
    mutated: true,
    code: 'CLAIMED',
    extra: { claimed: true, task: deepClone(task), phaseId: phase.id, autoPausedTaskIds },
    historyEntry,
  };
}

function opPauseTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot pause tasks', {
      role: ctx.role,
      action: 'pause',
    });
  }
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'pause');

  if (task.status !== 'in_progress') {
    throw new TodoPlanError(
      'INVALID_TRANSITION',
      `Cannot pause task "${task.id}" from status "${task.status}" (must be "in_progress")`,
      { taskId: task.id, currentStatus: task.status }
    );
  }

  task.status = 'pending';
  task.statusUpdatedAt = ctx.now;
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }

  const historyEntry = {
    at: ctx.now,
    action: 'pause',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus: 'in_progress',
    nextStatus: 'pending',
    actor: ctx.actor,
    role: ctx.role,
    note: task.note,
    summary: `Paused task ${task.id}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opCompleteTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot complete tasks', {
      role: ctx.role,
      action: 'complete',
    });
  }
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'complete');

  const depCheck = enforceDependencies(plan, phase, task, {
    allowUnmetDeps: Boolean(opts.allowUnmetDeps),
    reason: opts.reason,
  });

  const prevStatus = task.status;
  const prevReason = task.statusReason;

  task.status = 'completed';
  task.statusUpdatedAt = ctx.now;
  task.statusReason = null;
  if (ctx.role === 'author' && !task.owner) {
    task.owner = ctx.actor;
  }
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'complete',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'completed',
    previousStatusReason: prevReason || undefined,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    bypassedUnmetDeps: depCheck.bypassed ? depCheck.unmet : undefined,
    summary: `Completed task ${task.id}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opReopenTask(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot reopen tasks', {
      role: ctx.role,
      action: 'reopen',
    });
  }
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'reopen');

  if (task.status === 'pending' || task.status === 'in_progress') {
    throw new TodoPlanError(
      'INVALID_TRANSITION',
      `Cannot reopen task "${task.id}" from status "${task.status}" (must be completed, impossible, or error)`,
      { taskId: task.id, currentStatus: task.status }
    );
  }

  const prevStatus = task.status;
  const prevReason = task.statusReason;

  task.status = 'pending';
  task.statusUpdatedAt = ctx.now;
  task.statusReason = null;
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }

  const historyEntry = {
    at: ctx.now,
    action: 'reopen',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'pending',
    previousStatusReason: prevReason || undefined,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Reopened task ${task.id} from ${prevStatus}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opMarkImpossible(plan, opts, ctx) {
  if (ctx.role === 'verifier') {
    throw new TodoPlanError('ROLE_FORBIDDEN', 'Role "verifier" cannot mark tasks impossible', {
      role: ctx.role,
      action: 'mark_impossible',
    });
  }
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  assertAuthorOwnership(ctx.role, ctx.actor, task, 'mark_impossible');

  const prevStatus = task.status;
  const prevReason = task.statusReason;

  task.status = 'impossible';
  task.statusUpdatedAt = ctx.now;
  task.statusReason = reason;
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }

  const historyEntry = {
    at: ctx.now,
    action: 'mark_impossible',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'impossible',
    previousStatusReason: prevReason || undefined,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Marked task ${task.id} impossible: ${reason}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opMarkError(plan, opts, ctx) {
  const reason = normalizeNonEmptyString(opts.reason, 'reason', 'REASON_REQUIRED');
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  if (ctx.role === 'author') {
    assertAuthorOwnership(ctx.role, ctx.actor, task, 'mark_error');
  }

  const prevStatus = task.status;
  const prevReason = task.statusReason;

  task.status = 'error';
  task.statusUpdatedAt = ctx.now;
  task.statusReason = reason;
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }

  const historyEntry = {
    at: ctx.now,
    action: 'mark_error',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus,
    nextStatus: 'error',
    previousStatusReason: prevReason || undefined,
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Marked task ${task.id} error: ${reason}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function opSetTaskStatus(plan, opts, ctx) {
  const rawStatus = opts.status;
  if (ctx.role === 'verifier') {
    if (rawStatus === 'error') {
      return opMarkError(plan, opts, ctx);
    }
    if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
      // Allow verifier to attach note/evidence only
      return opUpdateTask(plan, { taskId: opts.taskId ?? opts.id, note: opts.note, evidence: opts.evidence, reason: opts.reason }, ctx);
    }
    throw new TodoPlanError(
      'ROLE_FORBIDDEN',
      `Role "verifier" cannot set task status to "${rawStatus}"`,
      { role: ctx.role, status: rawStatus, action: 'set_status' }
    );
  }

  if (typeof rawStatus !== 'string' || !VALID_STATUSES.includes(rawStatus)) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `Invalid status "${rawStatus}". Valid statuses: ${VALID_STATUSES.join(', ')}`,
      { status: rawStatus }
    );
  }

  if (rawStatus === 'in_progress') return opStartTask(plan, opts, ctx);
  if (rawStatus === 'completed') return opCompleteTask(plan, opts, ctx);
  if (rawStatus === 'impossible') return opMarkImpossible(plan, opts, ctx);
  if (rawStatus === 'error') return opMarkError(plan, opts, ctx);

  // rawStatus === 'pending'
  const { task, phase } = findTask(plan, opts.taskId ?? opts.id);
  if (task.status === 'in_progress') {
    return opPauseTask(plan, opts, ctx);
  }
  if (task.status === 'completed' || task.status === 'impossible' || task.status === 'error') {
    return opReopenTask(plan, opts, ctx);
  }

  assertAuthorOwnership(ctx.role, ctx.actor, task, 'set_status');
  if (opts.note !== undefined) {
    task.note = normalizeNullableString(opts.note, 'note');
  }
  if (opts.evidence !== undefined) {
    appendEvidence(task, opts.evidence);
  }

  const reason = normalizeNullableString(opts.reason, 'reason');
  const historyEntry = {
    at: ctx.now,
    action: 'set_status',
    phaseId: phase.id,
    taskId: task.id,
    prevStatus: 'pending',
    nextStatus: 'pending',
    actor: ctx.actor,
    role: ctx.role,
    reason,
    summary: `Updated pending task ${task.id}`,
  };
  return { mutated: true, extra: { task: deepClone(task), phaseId: phase.id }, historyEntry };
}

function dispatchPatchOp(plan, rawOp, defaults, ctx) {
  if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
    throw new TodoPlanError('INVALID_ARGUMENT', 'Each patch operation must be an object');
  }
  const opName = rawOp.op || rawOp.type;
  const opts = {
    ...rawOp,
    duringTaskId: rawOp.duringTaskId ?? rawOp.during ?? defaults.duringTaskId,
    reason: rawOp.reason !== undefined ? rawOp.reason : defaults.reason,
  };

  switch (opName) {
    case 'add_phase': return opAddPhase(plan, opts, ctx);
    case 'update_phase': return opUpdatePhase(plan, opts, ctx);
    case 'remove_phase': return opRemovePhase(plan, opts, ctx);
    case 'reorder_phases': return opReorderPhases(plan, opts, ctx);
    case 'add_task': return opAddTask(plan, opts, ctx);
    case 'update_task': return opUpdateTask(plan, opts, ctx);
    case 'split_task': return opSplitTask(plan, opts, ctx);
    case 'remove_task': return opRemoveTask(plan, opts, ctx);
    case 'reorder_tasks': return opReorderTasks(plan, opts, ctx);
    case 'start': return opStartTask(plan, opts, ctx);
    case 'pause': return opPauseTask(plan, opts, ctx);
    case 'complete': return opCompleteTask(plan, opts, ctx);
    case 'reopen': return opReopenTask(plan, opts, ctx);
    case 'mark_impossible': return opMarkImpossible(plan, opts, ctx);
    case 'mark_error': return opMarkError(plan, opts, ctx);
    case 'set_status': return opSetTaskStatus(plan, opts, ctx);
    default:
      throw new TodoPlanError('INVALID_ARGUMENT', `Unknown patch operation "${opName}"`, { op: opName });
  }
}

// ---------------- Locked Transaction Driver ----------------

function serializeAndCheckPlanSize(plan) {
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new TodoPlanError(
      'INVALID_ARGUMENT',
      `Serialized plan size (${bytes} bytes) exceeds maximum allowed (${MAX_FILE_BYTES} bytes)`,
      { size: bytes, maxFileBytes: MAX_FILE_BYTES }
    );
  }
  return serialized;
}

function validateConfiguredViewsPreCommit(views, resolvedPlanPath, root) {
  const baseDir = path.dirname(resolvedPlanPath);
  if (views.markdownPath) {
    resolveSidecarPath(views.markdownPath, { baseDir, root });
  }
  if (views.htmlPath) {
    resolveSidecarPath(views.htmlPath, { baseDir, root });
  }
}

function mutatePlan(action, options, mutator) {
  assertSafeOptions(options);
  const { role, actor } = normalizeRoleAndActor(options);
  const resolved = resolvePlanPath({
    file: options.file,
    env: options.env,
    root: options.root,
    actor,
    role,
    shared: options.shared,
  });
  const warnings = [...resolved.warnings];
  const requestId = normalizeNullableString(options.requestId, 'requestId');
  const payloadSha256 = requestId
    ? computePayloadSha256(action, extractRequestParams(action, options))
    : null;

  let expectedRevision = null;
  if (options.expectedRevision !== undefined && options.expectedRevision !== null && options.expectedRevision !== '') {
    expectedRevision = Number(options.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TodoPlanError('INVALID_ARGUMENT', 'expectedRevision must be a positive integer', {
        field: 'expectedRevision',
        value: options.expectedRevision,
      });
    }
  }

  return withPlanLock(resolved.resolvedPlanPath, { lockWaitMs: options.lockWaitMs, actor }, () => {
    const plan = readPublishedPlan(resolved.resolvedPlanPath);
    validatePlan(plan);

    if (requestId) {
      const existingReq = plan.recentRequests.find((r) => r.requestId === requestId);
      if (existingReq) {
        if (existingReq.payloadSha256 !== payloadSha256) {
          throw new TodoPlanError(
            'REQUEST_ID_CONFLICT',
            `requestId "${requestId}" was already used with a different payload`,
            { requestId }
          );
        }
        const summary = getSummary(plan);
        return {
          ...existingReq.response,
          resolvedPlanPath: resolved.resolvedPlanPath,
          idempotentReplay: true,
          summary,
          plan,
          warnings: [...warnings, ...(existingReq.response.warnings || [])],
        };
      }
    }

    if (expectedRevision !== null && plan.revision !== expectedRevision) {
      throw new TodoPlanError(
        'REVISION_CONFLICT',
        `Expected revision ${expectedRevision}, but plan is at revision ${plan.revision}`,
        { expectedRevision, actualRevision: plan.revision }
      );
    }

    const now = new Date().toISOString();
    const draft = deepClone(plan);
    const ctx = { role, actor, now, resolvedPlanPath: resolved.resolvedPlanPath, root: options.root };
    const result = mutator(draft, ctx);
    const code = result.code || 'OK';
    const exitCode = hasOwn(EXIT_CODES, code) ? EXIT_CODES[code] : 0;

    if (!result.mutated) {
      const summary = getSummary(plan);
      return {
        ok: true,
        code,
        exitCode,
        resolvedPlanPath: resolved.resolvedPlanPath,
        planId: plan.planId,
        revision: plan.revision,
        idempotentReplay: false,
        summary,
        plan,
        warnings,
        ...(result.extra || {}),
      };
    }

    validatePlan(draft);
    draft.revision += 1;
    draft.updatedAt = now;

    if (Array.isArray(result.historyEntries)) {
      for (let i = 0; i < result.historyEntries.length; i += 1) {
        appendHistory(draft, result.historyEntries[i]);
      }
    } else if (result.historyEntry) {
      appendHistory(draft, result.historyEntry);
    }

    const summary = getSummary(draft);
    const fullResponse = {
      ok: true,
      code,
      exitCode,
      resolvedPlanPath: resolved.resolvedPlanPath,
      planId: draft.planId,
      revision: draft.revision,
      idempotentReplay: false,
      summary,
      plan: draft,
      warnings,
      ...(result.extra || {}),
    };

    if (requestId) {
      recordRecentRequest(draft, requestId, payloadSha256, buildCompactResponse(fullResponse));
    }

    const serialized = serializeAndCheckPlanSize(draft);
    atomicWriteFile(resolved.resolvedPlanPath, serialized);
    syncSidecarViews(draft, summary, resolved.resolvedPlanPath, options, warnings);

    return fullResponse;
  });
}

// ---------------- Public High-Level API ----------------

function initPlan(options = {}) {
  assertSafeOptions(options);
  const { role, actor } = normalizeRoleAndActor(options);
  assertCoordinatorOnly(role, 'init');

  const resolved = resolvePlanPath({
    file: options.file,
    env: options.env,
    root: options.root,
    actor,
    role,
    shared: options.shared,
  });
  const warnings = [...resolved.warnings];
  const requestId = normalizeNullableString(options.requestId, 'requestId');
  const payloadSha256 = requestId
    ? computePayloadSha256('init', extractRequestParams('init', options))
    : null;

  return withPlanLock(resolved.resolvedPlanPath, { lockWaitMs: options.lockWaitMs, actor }, () => {
    let exists = false;
    try {
      const st = fs.lstatSync(resolved.resolvedPlanPath);
      if (st.isSymbolicLink()) {
        throw new TodoPlanError(
          'PATH_SECURITY_VIOLATION',
          `Plan path is a symbolic link: ${resolved.resolvedPlanPath}`,
          { path: resolved.resolvedPlanPath }
        );
      }
      exists = true;
    } catch (err) {
      if (err instanceof TodoPlanError) throw err;
      exists = false;
    }

    if (exists && requestId) {
      try {
        const existingPlan = readPublishedPlan(resolved.resolvedPlanPath);
        validatePlan(existingPlan);
        const match = existingPlan.recentRequests.find((r) => r.requestId === requestId);
        if (match) {
          if (match.payloadSha256 !== payloadSha256) {
            throw new TodoPlanError(
              'REQUEST_ID_CONFLICT',
              `requestId "${requestId}" was already used with a different payload`,
              { requestId }
            );
          }
          const summary = getSummary(existingPlan);
          return {
            ...match.response,
            resolvedPlanPath: resolved.resolvedPlanPath,
            idempotentReplay: true,
            summary,
            plan: existingPlan,
            warnings: [...warnings, ...(match.response.warnings || [])],
          };
        }
      } catch (err) {
        if (err instanceof TodoPlanError && (err.code === 'REQUEST_ID_CONFLICT' || err.code === 'PATH_SECURITY_VIOLATION')) {
          throw err;
        }
      }
    }

    if (exists && !options.force) {
      throw new TodoPlanError(
        'DUPLICATE_ID',
        `Plan file already exists at "${resolved.resolvedPlanPath}". Use --force to overwrite.`,
        { path: resolved.resolvedPlanPath }
      );
    }

    const now = new Date().toISOString();
    const title = normalizeNonEmptyString(options.title, 'title');
    const goal = normalizeOptionalText(options.goal, 'goal');
    const planId = options.planId !== undefined && options.planId !== null && options.planId !== ''
      ? assertValidId(options.planId, 'planId')
      : `plan-${crypto.randomUUID().slice(0, 8)}`;

    const maxHistoryEntries = options.maxHistoryEntries !== undefined
      ? Number(options.maxHistoryEntries)
      : DEFAULT_MAX_HISTORY;
    if (!Number.isInteger(maxHistoryEntries) || maxHistoryEntries < 1) {
      throw new TodoPlanError('INVALID_ARGUMENT', 'maxHistoryEntries must be a positive integer', {
        field: 'maxHistoryEntries',
      });
    }

    const rawViews = options.views && typeof options.views === 'object' ? options.views : {};
    const mdView = options.syncMd !== undefined
      ? normalizeViewSetting(options.syncMd)
      : (normalizeViewSetting(rawViews.markdownPath) ?? null);
    const htmlView = options.syncHtml !== undefined
      ? normalizeViewSetting(options.syncHtml)
      : (normalizeViewSetting(rawViews.htmlPath) ?? null);

    const plan = {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      planId,
      title,
      goal,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      nextPhaseSeq: 1,
      nextTaskSeq: 1,
      maxHistoryEntries,
      truncatedHistoryCount: 0,
      views: {
        markdownPath: mdView,
        htmlPath: htmlView,
      },
      phases: [],
      archived: [],
      history: [],
      recentRequests: [],
    };

    if (options.phases !== undefined) {
      if (!Array.isArray(options.phases)) {
        throw new TodoPlanError('INVALID_ARGUMENT', 'phases must be an array');
      }
      if (options.phases.length > MAX_PHASES) {
        throw new TodoPlanError('INVALID_ARGUMENT', `Phase count exceeds maximum (${MAX_PHASES})`);
      }
      for (let i = 0; i < options.phases.length; i += 1) {
        const pSpec = options.phases[i];
        if (!pSpec || typeof pSpec !== 'object' || Array.isArray(pSpec)) {
          throw new TodoPlanError('INVALID_ARGUMENT', `phases[${i}] must be an object`);
        }
        const phaseId = allocatePhaseId(plan, pSpec.id);
        const phase = {
          id: phaseId,
          title: normalizeNonEmptyString(pSpec.title, `phases[${i}].title`),
          goal: normalizeOptionalText(pSpec.goal, `phases[${i}].goal`),
          dependsOn: normalizeIdArray(pSpec.dependsOn, `phases[${i}].dependsOn`),
          status: 'empty',
          tasks: [],
        };
        plan.phases.push(phase);

        if (pSpec.tasks !== undefined) {
          if (!Array.isArray(pSpec.tasks)) {
            throw new TodoPlanError('INVALID_ARGUMENT', `phases[${i}].tasks must be an array`);
          }
          for (let j = 0; j < pSpec.tasks.length; j += 1) {
            const tSpec = pSpec.tasks[j];
            if (!tSpec || typeof tSpec !== 'object' || Array.isArray(tSpec)) {
              throw new TodoPlanError('INVALID_ARGUMENT', `phases[${i}].tasks[${j}] must be an object`);
            }
            if (countActiveTasks(plan) >= MAX_TASKS) {
              throw new TodoPlanError('INVALID_ARGUMENT', `Task count exceeds maximum (${MAX_TASKS})`);
            }
            const taskId = allocateTaskId(plan, phase.id, tSpec.id);
            const status = tSpec.status || 'pending';
            if (!VALID_STATUSES.includes(status)) {
              throw new TodoPlanError('INVALID_ARGUMENT', `Invalid status "${status}" on initial task`);
            }
            const statusReason = normalizeNullableString(tSpec.statusReason ?? tSpec.reason, 'statusReason');
            if ((status === 'error' || status === 'impossible') && !statusReason) {
              throw new TodoPlanError('REASON_REQUIRED', `Initial task "${taskId}" with status "${status}" requires statusReason`);
            }
            phase.tasks.push({
              id: taskId,
              title: normalizeNonEmptyString(tSpec.title, `phases[${i}].tasks[${j}].title`),
              acceptance: normalizeOptionalText(tSpec.acceptance, `phases[${i}].tasks[${j}].acceptance`),
              owner: normalizeNullableString(tSpec.owner, 'owner'),
              claimedAt: tSpec.owner && status === 'in_progress' ? now : null,
              dependsOn: normalizeIdArray(tSpec.dependsOn, `phases[${i}].tasks[${j}].dependsOn`),
              status,
              statusUpdatedAt: now,
              statusReason: (status === 'error' || status === 'impossible') ? statusReason : null,
              note: normalizeNullableString(tSpec.note, 'note'),
              evidence: normalizeEvidenceList(tSpec.evidence),
              origin: normalizeNullableString(tSpec.origin, 'origin') || 'initial',
            });
          }
        }
        phase.status = derivePhaseStatus(phase);
      }
    }

    appendHistory(plan, {
      at: now,
      action: 'init',
      actor,
      role,
      reason: null,
      summary: `Initialized plan ${plan.planId}: ${plan.title}`,
    });

    validatePlan(plan);
    validateConfiguredViewsPreCommit(plan.views, resolved.resolvedPlanPath, options.root);
    const summary = getSummary(plan);

    const fullResponse = {
      ok: true,
      code: 'OK',
      exitCode: EXIT_CODES.OK,
      resolvedPlanPath: resolved.resolvedPlanPath,
      planId: plan.planId,
      revision: plan.revision,
      idempotentReplay: false,
      summary,
      plan,
      warnings,
    };

    if (requestId) {
      recordRecentRequest(plan, requestId, payloadSha256, buildCompactResponse(fullResponse));
    }

    const serialized = serializeAndCheckPlanSize(plan);
    atomicWriteFile(resolved.resolvedPlanPath, serialized);
    syncSidecarViews(plan, summary, resolved.resolvedPlanPath, options, warnings);

    return fullResponse;
  });
}

function configureViews(options = {}) {
  return mutatePlan('configure_views', options, (draft, ctx) => {
    assertCoordinatorOnly(ctx.role, 'configure_views');
    const rawMd = options.syncMd !== undefined ? options.syncMd : options.markdownPath;
    const rawHtml = options.syncHtml !== undefined ? options.syncHtml : options.htmlPath;

    if (rawMd === undefined && rawHtml === undefined) {
      throw new TodoPlanError(
        'INVALID_ARGUMENT',
        'configure_views requires at least one of syncMd/markdownPath or syncHtml/htmlPath'
      );
    }

    if (rawMd !== undefined) {
      draft.views.markdownPath = normalizeViewSetting(rawMd);
    }
    if (rawHtml !== undefined) {
      draft.views.htmlPath = normalizeViewSetting(rawHtml);
    }

    validateConfiguredViewsPreCommit(draft.views, ctx.resolvedPlanPath, ctx.root);

    return {
      mutated: true,
      extra: { views: deepClone(draft.views) },
      historyEntry: {
        at: ctx.now,
        action: 'configure_views',
        actor: ctx.actor,
        role: ctx.role,
        views: deepClone(draft.views),
        summary: `Configured views (md=${draft.views.markdownPath || 'none'}, html=${draft.views.htmlPath || 'none'})`,
      },
    };
  });
}

function loadAndValidate(options = {}) {
  assertSafeOptions(options);
  const { role, actor } = normalizeRoleAndActor(options);
  const resolved = resolvePlanPath({
    file: options.file,
    env: options.env,
    root: options.root,
    actor,
    role,
    shared: options.shared,
  });
  const plan = readPublishedPlan(resolved.resolvedPlanPath);
  validatePlan(plan);
  const summary = getSummary(plan);
  return {
    ok: true,
    code: 'OK',
    exitCode: EXIT_CODES.OK,
    resolvedPlanPath: resolved.resolvedPlanPath,
    planId: plan.planId,
    revision: plan.revision,
    plan,
    summary,
    warnings: resolved.warnings,
  };
}

function statusPlan(options = {}) {
  return loadAndValidate(options);
}

function checkCompletePlan(options = {}) {
  const loaded = loadAndValidate(options);
  const gate = checkComplete(loaded.plan);
  return {
    ok: gate.ok,
    code: gate.code,
    exitCode: gate.exitCode,
    resolvedPlanPath: loaded.resolvedPlanPath,
    planId: loaded.planId,
    revision: loaded.revision,
    summary: gate.summary,
    plan: loaded.plan,
    warnings: loaded.warnings,
  };
}

function startTask(options = {}) {
  return mutatePlan('start', options, (draft, ctx) => opStartTask(draft, options, ctx));
}

function claimNextTask(options = {}) {
  return mutatePlan('claim_next', options, (draft, ctx) => opClaimNextTask(draft, options, ctx));
}

function pauseTask(options = {}) {
  return mutatePlan('pause', options, (draft, ctx) => opPauseTask(draft, options, ctx));
}

function completeTask(options = {}) {
  return mutatePlan('complete', options, (draft, ctx) => opCompleteTask(draft, options, ctx));
}

function reopenTask(options = {}) {
  return mutatePlan('reopen', options, (draft, ctx) => opReopenTask(draft, options, ctx));
}

function markImpossible(options = {}) {
  return mutatePlan('mark_impossible', options, (draft, ctx) => opMarkImpossible(draft, options, ctx));
}

function markError(options = {}) {
  return mutatePlan('mark_error', options, (draft, ctx) => opMarkError(draft, options, ctx));
}

function setTaskStatus(options = {}) {
  return mutatePlan('set_status', options, (draft, ctx) => opSetTaskStatus(draft, options, ctx));
}

function addPhase(options = {}) {
  return mutatePlan('add_phase', options, (draft, ctx) => opAddPhase(draft, options, ctx));
}

function updatePhase(options = {}) {
  return mutatePlan('update_phase', options, (draft, ctx) => opUpdatePhase(draft, options, ctx));
}

function removePhase(options = {}) {
  return mutatePlan('remove_phase', options, (draft, ctx) => opRemovePhase(draft, options, ctx));
}

function reorderPhases(options = {}) {
  return mutatePlan('reorder_phases', options, (draft, ctx) => opReorderPhases(draft, options, ctx));
}

function addTask(options = {}) {
  return mutatePlan('add_task', options, (draft, ctx) => opAddTask(draft, options, ctx));
}

function updateTask(options = {}) {
  return mutatePlan('update_task', options, (draft, ctx) => opUpdateTask(draft, options, ctx));
}

function splitTask(options = {}) {
  return mutatePlan('split_task', options, (draft, ctx) => opSplitTask(draft, options, ctx));
}

function removeTask(options = {}) {
  return mutatePlan('remove_task', options, (draft, ctx) => opRemoveTask(draft, options, ctx));
}

function reorderTasks(options = {}) {
  return mutatePlan('reorder_tasks', options, (draft, ctx) => opReorderTasks(draft, options, ctx));
}

function applyPatch(options = {}) {
  return mutatePlan('apply_patch', options, (draft, ctx) => {
    if (!Array.isArray(options.ops) || options.ops.length === 0) {
      throw new TodoPlanError('INVALID_ARGUMENT', 'apply_patch requires a non-empty ops array', {
        field: 'ops',
      });
    }
    const defaults = {
      duringTaskId: options.duringTaskId ?? options.during,
      reason: options.reason,
    };
    const results = [];
    const historyEntries = [];
    let anyMutated = false;

    for (let i = 0; i < options.ops.length; i += 1) {
      const res = dispatchPatchOp(draft, options.ops[i], defaults, ctx);
      if (res.mutated) anyMutated = true;
      if (res.historyEntry) historyEntries.push(res.historyEntry);
      results.push({
        index: i,
        op: options.ops[i].op || options.ops[i].type,
        ...(res.extra || {}),
      });
    }

    return {
      mutated: anyMutated,
      extra: { appliedCount: options.ops.length, results },
      historyEntries,
    };
  });
}

function recoverLock(options = {}) {
  assertSafeOptions(options);
  const { role, actor } = normalizeRoleAndActor(options);
  assertCoordinatorOnly(role, 'recover_lock');

  const expectedNonce = normalizeNonEmptyString(options.expectedNonce, 'expectedNonce');
  const resolved = resolvePlanPath({
    file: options.file,
    env: options.env,
    root: options.root,
    actor,
    role,
    shared: options.shared,
  });

  const lockPath = `${resolved.resolvedPlanPath}.lock`;
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new TodoPlanError('NOT_FOUND', `Lock file not found: ${lockPath}`, { lockPath });
    }
    throw new TodoPlanError('IO_ERROR', `Failed to stat lock file "${lockPath}": ${err.message}`, {
      lockPath,
      causeCode: err && err.code,
    });
  }

  if (stat.isSymbolicLink()) {
    throw new TodoPlanError('PATH_SECURITY_VIOLATION', `Lock path is a symbolic link: ${lockPath}`, {
      lockPath,
    });
  }

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    throw new TodoPlanError(
      'LOCK_RECOVERY_MISMATCH',
      `Lock file "${lockPath}" is unreadable or invalid JSON; cannot match expectedNonce`,
      { lockPath }
    );
  }

  if (!lock || typeof lock !== 'object' || lock.nonce !== expectedNonce) {
    throw new TodoPlanError(
      'LOCK_RECOVERY_MISMATCH',
      'Lock nonce does not match expectedNonce',
      { lockPath, actualNonce: lock && typeof lock.nonce === 'string' ? lock.nonce : null }
    );
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    throw new TodoPlanError('IO_ERROR', `Failed to remove lock file "${lockPath}": ${err.message}`, {
      lockPath,
      causeCode: err && err.code,
    });
  }

  return {
    ok: true,
    code: 'LOCK_RECOVERED',
    exitCode: EXIT_CODES.LOCK_RECOVERED,
    recoveredHolder: lock,
    resolvedPlanPath: resolved.resolvedPlanPath,
    warnings: resolved.warnings,
  };
}

module.exports = {
  TodoPlanError,
  EXIT_CODES,
  VALID_STATUSES,
  VALID_ROLES,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  sleepSync,
  resolvePlanPath,
  resolveSidecarPath,
  createAtomicWriter,
  atomicWriteFile,
  readPublishedPlan,
  validatePlan,
  derivePhaseStatus,
  getSummary,
  checkComplete,
  initPlan,
  configureViews,
  loadAndValidate,
  startTask,
  claimNextTask,
  pauseTask,
  completeTask,
  reopenTask,
  markImpossible,
  markError,
  setTaskStatus,
  addPhase,
  updatePhase,
  removePhase,
  reorderPhases,
  addTask,
  updateTask,
  splitTask,
  removeTask,
  reorderTasks,
  applyPatch,
  statusPlan,
  checkCompletePlan,
  recoverLock,
};
