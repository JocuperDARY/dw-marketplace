'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { validateRecoveryRecord2 } = require('./identity-support-v2');
const {
  canonicalizeDetachedSnapshot,
  computeDetachedContentSha256,
  createDetachedJsonSnapshot,
} = require('./canonical-json');

const ENVELOPE_SCHEMA = 'RecoveryStorePending1';
const ENVELOPE_VERSION = 1;
const LEASE_SCHEMA = 'RecoveryStoreLease1';
const LEASE_FILENAME = 'writer-lease.json';
const REVISION_PATTERN = /^pending-revision-([1-9]\d*)\.json$/;
const MAX_LEASE_BYTES = 4096;
const DEFAULT_LIMITS = Object.freeze({
  maxRecords: 128,
  maxItemBytes: 32768,
  maxTotalBytes: 1024 * 1024,
  maxRevisionScan: 256,
});

class RecoveryStoreError extends Error {
  constructor(code = 'RECOVERY_STORE_HOLD') {
    super(code);
    this.name = 'RecoveryStoreError';
    this.code = code;
  }
}

function hold() {
  return new RecoveryStoreError();
}

class RevalidationMismatchError extends Error {}

class RevalidationObservationError extends Error {}

function revalidationMismatch() {
  return new RevalidationMismatchError();
}

function revalidationObservation() {
  return new RevalidationObservationError();
}

function freeze(value) {
  return Object.freeze(value);
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function strictDescendant(parent, target) {
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fileIdentity(stat) {
  return freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

function sameFileIdentity(left, right) {
  return left !== null && right !== null && left.device === right.device && left.inode === right.inode;
}

function normalizeLimits(limits) {
  if (limits !== undefined && !isPlainObject(limits)) throw hold();
  const source = limits || {};
  if (Object.keys(source).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw hold();
  const normalized = {
    maxRecords: Object.hasOwn(source, 'maxRecords') ? source.maxRecords : DEFAULT_LIMITS.maxRecords,
    maxItemBytes: Object.hasOwn(source, 'maxItemBytes') ? source.maxItemBytes : DEFAULT_LIMITS.maxItemBytes,
    maxTotalBytes: Object.hasOwn(source, 'maxTotalBytes') ? source.maxTotalBytes : DEFAULT_LIMITS.maxTotalBytes,
    maxRevisionScan: Object.hasOwn(source, 'maxRevisionScan') ? source.maxRevisionScan : DEFAULT_LIMITS.maxRevisionScan,
  };
  if (Object.values(normalized).some((value) => !validLimit(value))) throw hold();
  return freeze(normalized);
}

function ensureChildDirectory(canonicalRoot, parent, name) {
  const target = path.join(parent, name);
  if (!strictDescendant(parent, target)) throw hold();
  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw hold();
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw hold();
  const realTarget = fs.realpathSync(target);
  if (!strictDescendant(canonicalRoot, realTarget) || !strictDescendant(parent, realTarget)) throw hold();
  return realTarget;
}

function openDataRoot(dataRoot, runId) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || !isSafeIdentifier(runId)) throw hold();
  const normalized = path.normalize(dataRoot);
  if (normalized !== dataRoot || normalized === path.parse(normalized).root) throw hold();
  try {
    if (fs.existsSync(normalized)) {
      const existing = fs.lstatSync(normalized);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw hold();
    } else {
      fs.mkdirSync(normalized, { recursive: true });
    }
    const root = fs.realpathSync(normalized);
    if (!samePath(root, normalized) || !fs.lstatSync(root).isDirectory()) throw hold();
    const namespace = ensureChildDirectory(root, root, 'development-workflow');
    const recovery = ensureChildDirectory(root, namespace, 'recovery');
    return ensureChildDirectory(root, recovery, runId);
  } catch (error) {
    if (error instanceof RecoveryStoreError) throw error;
    throw hold();
  }
}

function detachedSnapshot(value) {
  try {
    return createDetachedJsonSnapshot(value).snapshot;
  } catch (_) {
    throw hold();
  }
}

function validateRecordSet(records, limits, runId) {
  if (!Array.isArray(records) || records.length > limits.maxRecords) throw hold();
  let totalBytes = 0;
  for (const record of records) {
    if (record.run_id !== runId) throw hold();
    const validation = validateRecoveryRecord2(record);
    if (!validation.valid) throw hold();
    let bytes;
    try {
      bytes = Buffer.byteLength(canonicalizeDetachedSnapshot(record), 'utf8');
    } catch (_) {
      throw hold();
    }
    if (bytes > limits.maxItemBytes) throw hold();
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw hold();
  }
}

function envelopeSnapshot(envelope, limits, runId) {
  if (!exactKeys(envelope, ['schema', 'schema_version', 'run_id', 'revision', 'records', 'content_sha256'])
    || envelope.schema !== ENVELOPE_SCHEMA || envelope.schema_version !== ENVELOPE_VERSION
    || envelope.run_id !== runId || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
    || typeof envelope.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.content_sha256)) throw hold();
  validateRecordSet(envelope.records, limits, runId);
  try {
    if (computeDetachedContentSha256(envelope) !== envelope.content_sha256) throw hold();
  } catch (_) {
    throw hold();
  }
  return envelope;
}

class RecoveryStore {
  static open(options) {
    const input = detachedSnapshot(options);
    if (!exactKeys(input, ['dataRoot', 'runId', 'writerId', 'limits']) && !exactKeys(input, ['dataRoot', 'runId', 'writerId'])) throw hold();
    if (!isSafeIdentifier(input.writerId)) throw hold();
    const limits = normalizeLimits(input.limits);
    const runDirectory = openDataRoot(input.dataRoot, input.runId);
    const store = new RecoveryStore(runDirectory, input.runId, input.writerId, limits);
    store.#acquireLease();
    return store;
  }

  #runDirectory;

  #runRealPath;

  #runIdentity;

  #runId;

  #writerId;

  #limits;

  #leaseNonce;

  #leaseContent;

  #leaseIdentity = null;

  #state = 'ACTIVE';

  #releaseResult = null;

  #deferredTemp = null;

  constructor(runDirectory, runId, writerId, limits) {
    this.#runDirectory = runDirectory;
    this.#runRealPath = runDirectory;
    this.#runId = runId;
    this.#writerId = writerId;
    this.#limits = limits;
    this.#leaseNonce = crypto.randomBytes(32).toString('hex');
    try {
      const stat = fs.lstatSync(runDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw hold();
      this.#runIdentity = fileIdentity(stat);
    } catch (_) {
      throw hold();
    }
  }

  #leasePath() {
    return path.join(this.#runDirectory, LEASE_FILENAME);
  }

  #assertRunDirectory() {
    try {
      const stat = fs.lstatSync(this.#runDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileIdentity(fileIdentity(stat), this.#runIdentity)) throw revalidationMismatch();
      if (!samePath(fs.realpathSync(this.#runDirectory), this.#runRealPath)) throw revalidationMismatch();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) throw error;
      throw revalidationObservation();
    }
  }

  #readBoundedFile(filePath, maximumBytes, classifyRevalidation = false) {
    let descriptor;
    try {
      const initial = fs.lstatSync(filePath);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maximumBytes) throw hold();
      descriptor = fs.openSync(filePath, 'r');
      const current = fs.fstatSync(descriptor);
      if (!current.isFile() || current.size > maximumBytes || !sameFileIdentity(fileIdentity(initial), fileIdentity(current))) throw hold();
      const buffer = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
        if (!Number.isSafeInteger(read) || read <= 0) throw hold();
        offset += read;
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
      return freeze({ content: buffer.toString('utf8'), identity: fileIdentity(initial) });
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* preserve controlled HOLD */ }
      }
      if (classifyRevalidation) {
        if (error instanceof RevalidationMismatchError) throw error;
        if (error instanceof RecoveryStoreError) throw revalidationMismatch();
        throw revalidationObservation();
      }
      throw hold();
    }
  }

  #assertLease() {
    const loaded = this.#readBoundedFile(this.#leasePath(), MAX_LEASE_BYTES, true);
    if (!sameFileIdentity(loaded.identity, this.#leaseIdentity) || loaded.content !== this.#leaseContent) throw revalidationMismatch();
    try {
      if (!this.#leaseMatches(JSON.parse(loaded.content))) throw revalidationMismatch();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) throw error;
      throw revalidationMismatch();
    }
  }

  #fence() {
    if (this.#state !== 'RELEASED') this.#state = 'FENCED';
  }

  #revalidateOperation() {
    if (this.#state !== 'ACTIVE' && this.#state !== 'CLOSE_PENDING') throw hold();
    try {
      this.#assertRunDirectory();
      this.#assertLease();
    } catch (error) {
      if (error instanceof RevalidationMismatchError) this.#fence();
      throw hold();
    }
  }

  #acquireLease() {
    const lease = freeze({ schema: LEASE_SCHEMA, schema_version: 1, run_id: this.#runId, writer_id: this.#writerId, nonce: this.#leaseNonce });
    const content = canonicalizeDetachedSnapshot(lease);
    const leasePath = this.#leasePath();
    let descriptor;
    let createdIdentity = null;
    try {
      descriptor = fs.openSync(leasePath, 'wx', 0o600);
      createdIdentity = fileIdentity(fs.fstatSync(descriptor));
      const leaseStat = fs.lstatSync(leasePath);
      if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || !sameFileIdentity(createdIdentity, fileIdentity(leaseStat))) throw hold();
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const loaded = this.#readBoundedFile(leasePath, MAX_LEASE_BYTES);
      if (!sameFileIdentity(loaded.identity, createdIdentity) || loaded.content !== content || !this.#leaseMatches(JSON.parse(loaded.content))) throw hold();
      this.#leaseContent = content;
      this.#leaseIdentity = loaded.identity;
    } catch (_) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* cleanup is identity-bound below */ }
      }
      if (createdIdentity !== null) {
        try { this.#removeTrackedFile(leasePath, createdIdentity); } catch (_) { /* preserve foreign or unverified state */ }
      }
      throw hold();
    }
  }

  #leaseMatches(lease) {
    return exactKeys(lease, ['schema', 'schema_version', 'run_id', 'writer_id', 'nonce'])
      && lease.schema === LEASE_SCHEMA && lease.schema_version === 1 && lease.run_id === this.#runId
      && lease.writer_id === this.#writerId && lease.nonce === this.#leaseNonce;
  }

  #removeTrackedFile(filePath, identity, expectedContent) {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentity(fileIdentity(stat), identity)) throw hold();
      if (expectedContent !== undefined) {
        const loaded = this.#readBoundedFile(filePath, this.#limits.maxTotalBytes);
        if (!sameFileIdentity(loaded.identity, identity) || loaded.content !== expectedContent) throw hold();
      }
      fs.unlinkSync(filePath);
    } catch (_) {
      throw hold();
    }
  }

  #assertOpen() {
    if (this.#state !== 'ACTIVE') throw hold();
  }

  #revisionFiles() {
    let directory;
    let closed = false;
    const names = [];
    try {
      directory = fs.opendirSync(this.#runDirectory);
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (names.length >= this.#limits.maxRevisionScan) throw hold();
        names.push(entry.name);
      }
      directory.closeSync();
      closed = true;
    } catch (_) {
      if (directory !== undefined && !closed) {
        try { directory.closeSync(); } catch (_) { /* preserve controlled HOLD */ }
      }
      throw hold();
    }
    const revisions = [];
    for (const name of names) {
      const match = REVISION_PATTERN.exec(name);
      if (!match) continue;
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision)) throw hold();
      revisions.push({ name, revision, path: path.join(this.#runDirectory, name) });
    }
    if (revisions.length > this.#limits.maxRevisionScan) throw hold();
    revisions.sort((left, right) => left.revision - right.revision || left.name.localeCompare(right.name));
    for (let index = 1; index < revisions.length; index += 1) {
      if (revisions[index - 1].revision === revisions[index].revision) throw hold();
    }
    return revisions;
  }

  #readRevision(entry) {
    const loaded = this.#readBoundedFile(entry.path, this.#limits.maxTotalBytes);
    let parsed;
    try {
      parsed = detachedSnapshot(JSON.parse(loaded.content));
    } catch (_) {
      throw hold();
    }
    const snapshot = envelopeSnapshot(parsed, this.#limits, this.#runId);
    if (snapshot.revision !== entry.revision) throw hold();
    return snapshot;
  }

  #scanCurrent() {
    const files = this.#revisionFiles();
    if (files.length === 0) return null;
    const revisions = files.map((entry) => this.#readRevision(entry));
    return revisions[revisions.length - 1];
  }

  #createEnvelope(records, revision) {
    const base = freeze({
      schema: ENVELOPE_SCHEMA,
      schema_version: ENVELOPE_VERSION,
      run_id: this.#runId,
      revision,
      records,
      content_sha256: '0'.repeat(64),
    });
    return freeze({ ...base, content_sha256: computeDetachedContentSha256(base) });
  }

  savePending(payload) {
    const input = detachedSnapshot(payload);
    if (this.#state !== 'ACTIVE') throw hold();
    this.#revalidateOperation();
    if (!exactKeys(input, ['records'])) throw hold();
    validateRecordSet(input.records, this.#limits, this.#runId);
    const current = this.#scanCurrent();
    const revision = current === null ? 1 : current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw hold();
    let snapshot;
    let content;
    try {
      snapshot = this.#createEnvelope(input.records, revision);
      content = canonicalizeDetachedSnapshot(snapshot);
      if (Buffer.byteLength(content, 'utf8') > this.#limits.maxTotalBytes) throw hold();
    } catch (_) {
      throw hold();
    }
    const revisionPath = path.join(this.#runDirectory, `pending-revision-${revision}.json`);
    let tempPath;
    let descriptor;
    let tempIdentity = null;
    let committed = false;
    let verifiedContent;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        tempPath = path.join(this.#runDirectory, `.pending-${crypto.randomBytes(24).toString('hex')}.tmp`);
        try {
          descriptor = fs.openSync(tempPath, 'wx', 0o600);
          tempIdentity = fileIdentity(fs.fstatSync(descriptor));
          const tempStat = fs.lstatSync(tempPath);
          if (!tempStat.isFile() || tempStat.isSymbolicLink() || !sameFileIdentity(tempIdentity, fileIdentity(tempStat))) throw hold();
          break;
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
      }
      if (descriptor === undefined || tempIdentity === null) throw hold();
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const verifiedTemp = this.#readBoundedFile(tempPath, this.#limits.maxTotalBytes);
      if (!sameFileIdentity(verifiedTemp.identity, tempIdentity) || verifiedTemp.content !== content) throw hold();
      let verifiedSnapshot;
      try {
        verifiedSnapshot = envelopeSnapshot(detachedSnapshot(JSON.parse(verifiedTemp.content)), this.#limits, this.#runId);
      } catch (_) {
        throw hold();
      }
      if (verifiedSnapshot.revision !== revision || verifiedSnapshot.content_sha256 !== snapshot.content_sha256) throw hold();
      verifiedContent = verifiedTemp.content;
      this.#revalidateOperation();
      fs.linkSync(tempPath, revisionPath);
      committed = true;
      try {
        this.#removeTrackedFile(tempPath, tempIdentity, content);
        tempPath = undefined;
      } catch (_) {
        if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
        this.#deferredTemp = freeze({ path: tempPath, identity: tempIdentity, content: verifiedContent });
      }
      return freeze({ revision, content_sha256: verifiedSnapshot.content_sha256 });
    } catch (_) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* tracked cleanup below */ }
      }
      if (!committed && tempPath !== undefined && tempIdentity !== null) {
        try {
          this.#removeTrackedFile(tempPath, tempIdentity, verifiedContent);
        } catch (_) {
          if (this.#state === 'ACTIVE') this.#state = 'CLOSE_PENDING';
          this.#deferredTemp = verifiedContent === undefined
            ? freeze({ path: tempPath, identity: tempIdentity })
            : freeze({ path: tempPath, identity: tempIdentity, content: verifiedContent });
        }
      }
      throw hold();
    }
  }

  loadPending() {
    this.#assertOpen();
    this.#revalidateOperation();
    const current = this.#scanCurrent();
    if (current === null) return null;
    return freeze({ revision: current.revision, records: current.records, content_sha256: current.content_sha256 });
  }

  close() {
    if (this.#state === 'RELEASED') return this.#releaseResult;
    if (this.#state === 'FENCED') return freeze({ released: false, disposition: 'HOLD' });
    try {
      this.#revalidateOperation();
      if (this.#deferredTemp !== null) {
        this.#removeTrackedFile(this.#deferredTemp.path, this.#deferredTemp.identity, this.#deferredTemp.content);
        this.#deferredTemp = null;
        this.#state = 'ACTIVE';
      }
      this.#revalidateOperation();
      fs.unlinkSync(this.#leasePath());
      this.#state = 'RELEASED';
      this.#releaseResult = freeze({ released: true, disposition: 'RELEASED' });
      return this.#releaseResult;
    } catch (_) {
      return freeze({ released: false, disposition: 'HOLD' });
    }
  }
}

module.exports = { RecoveryStore, RecoveryStoreError };
