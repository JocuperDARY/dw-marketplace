#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RecoveryStore, RecoveryStoreError } = require('../skills/dw-collaboration/scripts/lib/recovery-store');

const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const opaqueRef = (kind, value) => `${kind}:${hash(value)}`;

function recoveryRecord(resourceId, runId = 'run-roundtrip') {
  return {
    schema: 'RecoveryRecord2',
    schema_version: 2,
    resource_id: resourceId,
    resource_type: 'process_tree',
    run_id: runId,
    session_id: `session-${runId}`,
    lease_generation: 2,
    identity: {
      schema: 'ProcessIdentity2',
      schema_version: 2,
      platform: 'windows',
      owner_id: 'root-A',
      run_id: runId,
      session_id: `session-${runId}`,
      lease_generation: 2,
      adapter_generation: 2,
      manager_generation: 7,
      pid: 41002,
      start_time: '2026-08-30T01:00:00Z',
      executable_path_sha256: hash('C:\\Program Files\\nodejs\\node.exe'),
      argv_sha256: hash('node worker.js'),
      parent_identity_sha256: hash('parent-windows'),
      launch_nonce: 'launch-windows-1',
      manager_run_id: 'manager-run-windows-1',
      windows_identity: {
        process_creation_time_filetime: '134167428000000000',
        process_handle: '0x0000000000001234',
      },
    },
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T02:00:00Z',
      observation_ref: opaqueRef('observation', resourceId),
      identity_ref: opaqueRef('identity', resourceId),
    },
    cleanup_authority_ref: opaqueRef('authority', resourceId),
    teardown_condition: 'identity_absence_verified',
    evidence_refs: [opaqueRef('evidence', resourceId)],
  };
}

function assertOwnedTempRoot(root) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const resolvedRoot = fs.realpathSync(root);
  const relative = path.relative(tempRoot, resolvedRoot);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'test root must be an exact os.tmpdir descendant');
}

function expectStoreHold(fn) {
  assert.throws(fn, (error) => (
    error instanceof RecoveryStoreError
    && error.code === 'RECOVERY_STORE_HOLD'
    && !/not-json-payload|sensitive-test-value/.test(String(error))
  ));
}

function runDirectory(dataRoot, runId) {
  return path.join(dataRoot, 'development-workflow', 'recovery', runId);
}

function createOutsideDirectoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

const scenarioFailures = [];

function collectScenario(name, fn) {
  try {
    fn();
  } catch (error) {
    scenarioFailures.push(`${name}: ${error && error.message ? error.message : String(error)}`);
  }
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-recovery-store-'));

try {
  assertOwnedTempRoot(testRoot);

  const invalidLimitsRoot = path.join(testRoot, 'invalid-limits');
  expectStoreHold(() => RecoveryStore.open({
    dataRoot: invalidLimitsRoot,
    runId: 'run-invalid-limits',
    writerId: 'writer-A',
    limits: { maxRecords: 0 },
  }));
  assert.strictEqual(fs.existsSync(invalidLimitsRoot), false, 'invalid limits must hold before creating a run or lease');

  for (const linkComponent of ['development-workflow', 'recovery']) {
    const containmentRoot = path.join(testRoot, `containment-${linkComponent}`);
    const outside = path.join(testRoot, `outside-${linkComponent}`);
    fs.mkdirSync(containmentRoot);
    fs.mkdirSync(outside);
    if (linkComponent === 'development-workflow') {
      createOutsideDirectoryLink(outside, path.join(containmentRoot, 'development-workflow'));
    } else {
      fs.mkdirSync(path.join(containmentRoot, 'development-workflow'));
      createOutsideDirectoryLink(outside, path.join(containmentRoot, 'development-workflow', 'recovery'));
    }
    expectStoreHold(() => RecoveryStore.open({ dataRoot: containmentRoot, runId: 'run-contained', writerId: 'writer-A' }));
    assert.strictEqual(fs.existsSync(path.join(outside, 'run-contained')), false, 'a linked namespace must not receive recovery state');
  }

  const roundtrip = RecoveryStore.open({ dataRoot: testRoot, runId: 'run-roundtrip', writerId: 'writer-A' });
  for (const field of ['runDirectory', 'runId', 'writerId', 'limits', 'leaseNonce']) {
    assert.strictEqual(Object.hasOwn(roundtrip, field), false, `${field} must not expose mutable authority`);
  }
  const source = recoveryRecord('resource-A');
  const saved = roundtrip.savePending({ records: [source] });
  source.resource_id = 'mutated-source';
  const loaded = roundtrip.loadPending();
  assert.strictEqual(saved.revision, 1);
  assert.strictEqual(loaded.revision, 1);
  assert.strictEqual(loaded.records[0].resource_id, 'resource-A');
  assert.notStrictEqual(loaded.records[0], source);
  assert(Object.isFrozen(loaded));
  assert(Object.isFrozen(loaded.records));
  assert(Object.isFrozen(loaded.records[0]));

  const beforeExtraSaveKeys = fs.readdirSync(runDirectory(testRoot, 'run-roundtrip')).sort();
  expectStoreHold(() => roundtrip.savePending({ records: [], extra: true }));
  assert.deepStrictEqual(
    fs.readdirSync(runDirectory(testRoot, 'run-roundtrip')).sort(),
    beforeExtraSaveKeys,
    'savePending must reject payloads with keys beyond records',
  );

  expectStoreHold(() => RecoveryStore.open({ dataRoot: testRoot, runId: 'run-roundtrip', writerId: 'writer-B' }));
  const beforeInvalid = fs.readdirSync(runDirectory(testRoot, 'run-roundtrip')).sort();
  const sensitive = recoveryRecord('resource-sensitive');
  sensitive.model_reply = 'sensitive-test-value';
  expectStoreHold(() => roundtrip.savePending({ records: [sensitive] }));
  assert.deepStrictEqual(
    fs.readdirSync(runDirectory(testRoot, 'run-roundtrip')).sort(),
    beforeInvalid,
    'invalid records must be rejected before a revision or temporary publish file exists',
  );

  const redirectedRoot = path.join(testRoot, 'redirected-authority');
  fs.mkdirSync(redirectedRoot);
  roundtrip.runDirectory = redirectedRoot;
  roundtrip.runId = 'run-redirected';
  roundtrip.writerId = 'writer-redirected';
  roundtrip.limits = { maxRecords: 1, maxItemBytes: 1, maxTotalBytes: 1, maxRevisionScan: 1 };
  roundtrip.leaseNonce = 'redirected-nonce';
  const savedAfterShadowing = roundtrip.savePending({ records: [recoveryRecord('resource-B')] });
  assert.strictEqual(savedAfterShadowing.revision, 2, 'shadowed public fields must not redirect an open store');
  assert.strictEqual(fs.readdirSync(redirectedRoot).length, 0, 'authority shadowing must not create redirected state');
  const releasedRoundtrip = roundtrip.close();
  assert.deepStrictEqual(releasedRoundtrip, { released: true, disposition: 'RELEASED' });
  assert.deepStrictEqual(roundtrip.close(), releasedRoundtrip, 'a successful exact close must be idempotent');

  const laterWriter = RecoveryStore.open({ dataRoot: testRoot, runId: 'run-roundtrip', writerId: 'writer-B' });
  laterWriter.close();

  const distinctRun = RecoveryStore.open({ dataRoot: testRoot, runId: 'run-distinct', writerId: 'writer-A' });
  distinctRun.close();
  assert.strictEqual(fs.existsSync(runDirectory(testRoot, 'run-distinct')), true, 'a distinct new run must open below an existing data root');

  const bounded = RecoveryStore.open({
    dataRoot: testRoot,
    runId: 'run-bounded-scan',
    writerId: 'writer-A',
    limits: { maxRevisionScan: 2 },
  });
  const boundedDirectory = runDirectory(testRoot, 'run-bounded-scan');
  for (const name of ['owned-junk-a', 'owned-junk-b', 'owned-junk-c']) {
    fs.writeFileSync(path.join(boundedDirectory, name), 'test-owned-junk', 'utf8');
  }
  expectStoreHold(() => bounded.loadPending());
  bounded.close();

  const replacedLease = RecoveryStore.open({ dataRoot: testRoot, runId: 'run-replaced-lease', writerId: 'writer-A' });
  const replacedLeasePath = path.join(runDirectory(testRoot, 'run-replaced-lease'), 'writer-lease.json');
  const foreignLease = {
    schema: 'RecoveryStoreLease1',
    schema_version: 1,
    run_id: 'run-replaced-lease',
    writer_id: 'writer-B',
    nonce: 'foreign-nonce',
  };
  fs.writeFileSync(replacedLeasePath, JSON.stringify(foreignLease), 'utf8');
  assert.deepStrictEqual(replacedLease.close(), { released: false, disposition: 'HOLD' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(replacedLeasePath, 'utf8')), foreignLease, 'close must not delete a replaced lease');

  const corrupt = RecoveryStore.open({ dataRoot: testRoot, runId: 'run-corrupt', writerId: 'writer-A' });
  corrupt.savePending({ records: [recoveryRecord('resource-corrupt', 'run-corrupt')] });
  const corruptDirectory = runDirectory(testRoot, 'run-corrupt');
  fs.writeFileSync(path.join(corruptDirectory, 'pending-revision-999.json'), '{"not-json-payload"');
  expectStoreHold(() => corrupt.loadPending());
  corrupt.close();

  collectScenario('A lease replacement permanently fences the old store', () => {
    const runId = 'run-fenced';
    const fenced = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const originalLease = fs.readFileSync(leasePath, 'utf8');
    const foreignLease = JSON.stringify({
      schema: 'RecoveryStoreLease1',
      schema_version: 1,
      run_id: runId,
      writer_id: 'writer-B',
      nonce: 'foreign-nonce-r2',
    });
    fs.writeFileSync(leasePath, foreignLease, 'utf8');
    expectStoreHold(() => fenced.savePending({ records: [] }));
    expectStoreHold(() => fenced.loadPending());
    assert.deepStrictEqual(fenced.close(), { released: false, disposition: 'HOLD' });
    assert.strictEqual(fs.readFileSync(leasePath, 'utf8'), foreignLease, 'foreign lease must remain after a fenced close');
    fs.writeFileSync(leasePath, originalLease, 'utf8');
    expectStoreHold(() => fenced.savePending({ records: [] }));
    expectStoreHold(() => fenced.loadPending());
    assert.deepStrictEqual(fenced.close(), { released: false, disposition: 'HOLD' }, 'restoring foreign lease bytes must not revive a fenced store');
  });

  collectScenario('B records must bind to the current store run ID', () => {
    const runId = 'run-record-binding';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const directory = runDirectory(testRoot, runId);
    const before = fs.readdirSync(directory).sort();
    expectStoreHold(() => store.savePending({ records: [recoveryRecord('resource-foreign-run', 'run-other')] }));
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), before, 'foreign-run records must not publish a revision or temporary file');
    store.close();
  });

  collectScenario('C detached snapshots keep validation and publication on the same value', () => {
    const runId = 'run-detached-snapshot';
    const backing = recoveryRecord('resource-detached', runId);
    let identityRead = false;
    const mutatingRecord = new Proxy(backing, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'identity') identityRead = true;
        return value;
      },
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === 'identity' && identityRead && descriptor) {
          return { ...descriptor, value: { ...descriptor.value, owner_id: 'secret value' } };
        }
        return descriptor;
      },
    });
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const savedProxy = store.savePending({ records: [mutatingRecord] });
    const loadedProxy = store.loadPending();
    assert.strictEqual(savedProxy.revision, 1);
    assert.strictEqual(loadedProxy.records[0].identity.owner_id, 'root-A', 'a post-validation descriptor change must not reach the published revision');
    const beforeSensitive = fs.readdirSync(runDirectory(testRoot, runId)).sort();
    const directlySensitive = recoveryRecord('resource-sensitive-allowed-field', runId);
    directlySensitive.identity.owner_id = 'secret value';
    expectStoreHold(() => store.savePending({ records: [directlySensitive] }));
    assert.deepStrictEqual(fs.readdirSync(runDirectory(testRoot, runId)).sort(), beforeSensitive, 'sensitive values in allowed fields must still hold before publication');
    store.close();
  });

  collectScenario('D directory scanning is incremental and bounded at the fs boundary', () => {
    const runId = 'run-incremental-scan';
    const store = RecoveryStore.open({
      dataRoot: testRoot,
      runId,
      writerId: 'writer-A',
      limits: { maxRevisionScan: 2 },
    });
    const directory = runDirectory(testRoot, runId);
    for (const name of ['scan-junk-a', 'scan-junk-b', 'scan-junk-c']) {
      fs.writeFileSync(path.join(directory, name), 'owned-junk', 'utf8');
    }
    const originalReaddir = fs.readdirSync;
    const originalOpendir = fs.opendirSync;
    let readdirCalls = 0;
    let readCalls = 0;
    fs.readdirSync = () => {
      readdirCalls += 1;
      throw new Error('readdirSync must not be used for recovery scanning');
    };
    fs.opendirSync = (...args) => {
      const directoryHandle = originalOpendir(...args);
      const originalRead = directoryHandle.readSync.bind(directoryHandle);
      directoryHandle.readSync = () => {
        readCalls += 1;
        return originalRead();
      };
      return directoryHandle;
    };
    try {
      expectStoreHold(() => store.loadPending());
    } finally {
      fs.readdirSync = originalReaddir;
      fs.opendirSync = originalOpendir;
    }
    assert.strictEqual(readdirCalls, 0, 'recovery scanning must not enumerate an unbounded array');
    assert(readCalls > 0 && readCalls <= 3, 'recovery scanning must stop at maxRevisionScan + 1 entries');
    store.close();
  });

  collectScenario('E close rejects an oversized foreign lease without full-file reading', () => {
    const runId = 'run-oversized-lease';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const foreignLease = `${'{"foreign":"'}${'x'.repeat(4097)}${'"}'}`;
    fs.writeFileSync(leasePath, foreignLease, 'utf8');
    const originalReadFile = fs.readFileSync;
    let leaseReadCalls = 0;
    fs.readFileSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(leasePath)) {
        leaseReadCalls += 1;
        throw new Error('oversized foreign lease must not be read in full');
      }
      return originalReadFile(target, ...args);
    };
    let closeResult;
    try {
      closeResult = store.close();
    } finally {
      fs.readFileSync = originalReadFile;
    }
    assert.deepStrictEqual(closeResult, { released: false, disposition: 'HOLD' });
    assert.strictEqual(leaseReadCalls, 0, 'oversized foreign leases must be rejected before readFileSync');
    assert.strictEqual(fs.readFileSync(leasePath, 'utf8'), foreignLease, 'oversized foreign lease must not be deleted');
  });

  collectScenario('F failed lease creation removes only the just-created partial lease', () => {
    const runId = 'run-lease-write-failure';
    const directory = runDirectory(testRoot, runId);
    const leasePath = path.join(directory, 'writer-lease.json');
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const originalClose = fs.closeSync;
    const leaseDescriptors = new Set();
    const closedDescriptors = new Set();
    let failedWrite = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (path.resolve(String(target)) === path.resolve(leasePath)) leaseDescriptors.add(descriptor);
      return descriptor;
    };
    fs.writeFileSync = (target, ...args) => {
      if (!failedWrite && leaseDescriptors.has(target)) {
        failedWrite = true;
        const error = new Error('injected lease write failure');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite(target, ...args);
    };
    fs.closeSync = (descriptor, ...args) => {
      if (leaseDescriptors.has(descriptor)) closedDescriptors.add(descriptor);
      return originalClose(descriptor, ...args);
    };
    try {
      expectStoreHold(() => RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' }));
    } finally {
      fs.openSync = originalOpen;
      fs.writeFileSync = originalWrite;
      fs.closeSync = originalClose;
    }
    assert.strictEqual(failedWrite, true, 'the lease write failure injection must execute');
    assert.strictEqual(fs.existsSync(leasePath), false, 'a failed lease write must not leave empty or partial lease state');
    assert.strictEqual(closedDescriptors.size, leaseDescriptors.size, 'every test-created lease descriptor must be closed');
  });

  collectScenario('G post-link temporary cleanup defers to close without losing the saved revision', () => {
    const runId = 'run-post-link-cleanup';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const directory = runDirectory(testRoot, runId);
    const originalUnlink = fs.unlinkSync;
    let pendingUnlinkFailures = 0;
    fs.unlinkSync = (target, ...args) => {
      if (path.basename(String(target)).startsWith('.pending-') && pendingUnlinkFailures === 0) {
        pendingUnlinkFailures += 1;
        const error = new Error('injected post-link cleanup failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(target, ...args);
    };
    let savedAfterLink;
    try {
      savedAfterLink = store.savePending({ records: [recoveryRecord('resource-post-link', runId)] });
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(savedAfterLink.revision, 1, 'link success is the publication commit point even if temporary cleanup is deferred');
    assert.strictEqual(pendingUnlinkFailures, 1, 'the post-link cleanup failure injection must execute');
    assert(fs.readdirSync(directory).some((name) => name.startsWith('.pending-')), 'failed post-link cleanup must remain for close');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
    assert.strictEqual(fs.readdirSync(directory).some((name) => name.startsWith('.pending-') || name === 'writer-lease.json'), false, 'close must remove deferred temporary state before releasing the lease');
  });

  collectScenario('R3B B1 a transient active lease observation failure keeps the store closable', () => {
    const runId = 'run-r3b-active-observation';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const originalLstat = fs.lstatSync;
    let observationFailures = 0;
    fs.lstatSync = (target, ...args) => {
      if (observationFailures === 0 && path.resolve(String(target)) === path.resolve(leasePath)) {
        observationFailures += 1;
        const error = new Error('injected active lease observation failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLstat(target, ...args);
    };
    let firstClose;
    try {
      firstClose = store.close();
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.strictEqual(observationFailures, 1, 'the active lease observation fault must execute');
    assert.deepStrictEqual(firstClose, { released: false, disposition: 'HOLD' });
    assert.strictEqual(fs.existsSync(leasePath), true, 'a transient observation failure must preserve the owned lease');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
    assert.strictEqual(fs.existsSync(leasePath), false, 'the restored observation path must release the lease');
  });

  collectScenario('R3B B2 a transient close-pending lease observation failure preserves deferred cleanup', () => {
    const runId = 'run-r3b-close-pending-observation';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const directory = runDirectory(testRoot, runId);
    const leasePath = path.join(directory, 'writer-lease.json');
    const originalUnlink = fs.unlinkSync;
    let temporaryUnlinkFailures = 0;
    fs.unlinkSync = (target, ...args) => {
      if (temporaryUnlinkFailures === 0 && path.basename(String(target)).startsWith('.pending-')) {
        temporaryUnlinkFailures += 1;
        const error = new Error('injected post-link temporary cleanup failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(target, ...args);
    };
    try {
      store.savePending({ records: [recoveryRecord('resource-r3b-close-pending', runId)] });
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(temporaryUnlinkFailures, 1, 'the post-link temporary cleanup fault must execute');
    assert(fs.readdirSync(directory).some((name) => name.startsWith('.pending-')), 'the first cleanup failure must leave an owned temporary file');
    expectStoreHold(() => store.savePending({ records: [recoveryRecord('resource-r3b-close-pending-rejected', runId)] }));
    expectStoreHold(() => store.loadPending());
    assert.strictEqual(fs.existsSync(leasePath), true, 'close-pending stores must preserve their owned lease before retrying close');
    assert(fs.readdirSync(directory).some((name) => name.startsWith('.pending-')), 'close-pending stores must preserve deferred temporary cleanup before retrying close');
    const originalLstat = fs.lstatSync;
    let observationFailures = 0;
    fs.lstatSync = (target, ...args) => {
      if (observationFailures === 0 && path.resolve(String(target)) === path.resolve(leasePath)) {
        observationFailures += 1;
        const error = new Error('injected close-pending lease observation failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLstat(target, ...args);
    };
    let firstClose;
    try {
      firstClose = store.close();
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.strictEqual(observationFailures, 1, 'the close-pending lease observation fault must execute');
    assert.deepStrictEqual(firstClose, { released: false, disposition: 'HOLD' });
    assert.strictEqual(fs.existsSync(leasePath), true, 'a transient close-pending observation failure must preserve the owned lease');
    assert(fs.readdirSync(directory).some((name) => name.startsWith('.pending-')), 'a transient close-pending observation failure must preserve deferred temporary cleanup');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
    assert.strictEqual(fs.readdirSync(directory).some((name) => name.startsWith('.pending-') || name === 'writer-lease.json'), false, 'the restored observation path must clean the temporary file and release the lease');
  });

  collectScenario('R4 A pre-link temporary cleanup failure becomes close-pending and is recovered by close', () => {
    const runId = 'run-r4-pre-link-cleanup';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const directory = runDirectory(testRoot, runId);
    const revisionPath = path.join(directory, 'pending-revision-1.json');
    const leasePath = path.join(directory, 'writer-lease.json');
    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    let linkFailures = 0;
    let temporaryUnlinkFailures = 0;
    fs.linkSync = (existingPath, newPath, ...args) => {
      if (path.resolve(String(newPath)) === path.resolve(revisionPath) && linkFailures === 0) {
        linkFailures += 1;
        const error = new Error('injected pre-link publication failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLink(existingPath, newPath, ...args);
    };
    fs.unlinkSync = (target, ...args) => {
      if (linkFailures === 1 && temporaryUnlinkFailures === 0 && path.basename(String(target)).startsWith('.pending-')) {
        temporaryUnlinkFailures += 1;
        const error = new Error('injected pre-link temporary cleanup failure');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(target, ...args);
    };
    try {
      expectStoreHold(() => store.savePending({ records: [recoveryRecord('resource-r4-pre-link-cleanup', runId)] }));
    } finally {
      fs.linkSync = originalLink;
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(linkFailures, 1, 'the pre-link publication fault must execute');
    assert.strictEqual(temporaryUnlinkFailures, 1, 'the pre-link temporary cleanup fault must execute');
    assert.strictEqual(fs.existsSync(revisionPath), false, 'a failed publication must not create a revision');
    assert(fs.readdirSync(directory).some((name) => name.startsWith('.pending-')), 'a failed pre-link cleanup must leave the owned temporary file for close');
    expectStoreHold(() => store.savePending({ records: [recoveryRecord('resource-r4-pre-link-rejected-save', runId)] }));
    expectStoreHold(() => store.loadPending());
    assert.strictEqual(fs.existsSync(leasePath), true, 'a close-pending store must retain its owned lease before close');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
    assert.strictEqual(fs.readdirSync(directory).some((name) => name.startsWith('.pending-') || name === 'writer-lease.json'), false, 'close must remove deferred pre-link temporary state before releasing the lease');
  });

  collectScenario('R4 B a new writer lease after the old lease unlink does not change the old close result', () => {
    const runId = 'run-r4-lease-handoff';
    const storeA = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const originalUnlink = fs.unlinkSync;
    let storeB = null;
    let replacementLeaseCreated = false;
    fs.unlinkSync = (target, ...args) => {
      const result = originalUnlink(target, ...args);
      if (!replacementLeaseCreated && path.resolve(String(target)) === path.resolve(leasePath)) {
        replacementLeaseCreated = true;
        storeB = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-B' });
      }
      return result;
    };
    let closeA;
    try {
      closeA = storeA.close();
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.strictEqual(replacementLeaseCreated, true, 'the replacement writer must acquire its lease immediately after writer A removes its own lease');
    assert.deepStrictEqual(closeA, { released: true, disposition: 'RELEASED' });
    assert.strictEqual(fs.existsSync(leasePath), true, 'writer A must not delete or reject the replacement writer lease');
    assert.deepStrictEqual(storeB.close(), { released: true, disposition: 'RELEASED' });
  });

  collectScenario('R3C a linked revision returns without reading the revision path again', () => {
    const runId = 'run-r3c-link-commit';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const revisionPath = path.join(runDirectory(testRoot, runId), 'pending-revision-1.json');
    const originalLink = fs.linkSync;
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let guardArmed = false;
    let postLinkRevisionObservations = 0;
    const failRevisionObservation = (target) => {
      if (guardArmed && path.resolve(String(target)) === path.resolve(revisionPath)) {
        postLinkRevisionObservations += 1;
        const error = new Error('a linked revision must not be read before savePending returns');
        error.code = 'EIO';
        throw error;
      }
    };
    fs.linkSync = (existingPath, newPath, ...args) => {
      const result = originalLink(existingPath, newPath, ...args);
      if (path.resolve(String(newPath)) === path.resolve(revisionPath)) guardArmed = true;
      return result;
    };
    fs.lstatSync = (target, ...args) => {
      failRevisionObservation(target);
      return originalLstat(target, ...args);
    };
    fs.openSync = (target, ...args) => {
      failRevisionObservation(target);
      return originalOpen(target, ...args);
    };
    fs.readSync = (descriptor, ...args) => originalRead(descriptor, ...args);
    let saved;
    try {
      saved = store.savePending({ records: [recoveryRecord('resource-r3c-link-commit', runId)] });
    } finally {
      fs.linkSync = originalLink;
      fs.lstatSync = originalLstat;
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
    }
    assert.strictEqual(guardArmed, true, 'the revision link must succeed before the post-link observation guard is armed');
    assert.strictEqual(postLinkRevisionObservations, 0, 'savePending must not observe the revision path after a successful link');
    assert.strictEqual(saved.revision, 1);
    const loaded = store.loadPending();
    assert.strictEqual(loaded.revision, saved.revision);
    assert.strictEqual(loaded.content_sha256, saved.content_sha256);
    assert.strictEqual(fs.readdirSync(runDirectory(testRoot, runId)).some((name) => name.startsWith('.pending-')), false, 'a successful link must not leave a temporary publish file');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
  });

  collectScenario('R3A A1 partial lease writes are identity-cleaned', () => {
    const runId = 'run-r3a-partial-lease';
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const originalOpen = fs.openSync;
    const originalWriteFile = fs.writeFileSync;
    const originalWrite = fs.writeSync;
    const originalClose = fs.closeSync;
    const leaseDescriptors = new Set();
    const closedDescriptors = new Set();
    let partialWrite = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (path.resolve(String(target)) === path.resolve(leasePath)) leaseDescriptors.add(descriptor);
      return descriptor;
    };
    fs.writeFileSync = (target, ...args) => {
      if (!partialWrite && leaseDescriptors.has(target)) {
        partialWrite = true;
        originalWrite(target, Buffer.from('part', 'utf8'), 0, 4, null);
        const error = new Error('injected partial lease write failure');
        error.code = 'EIO';
        throw error;
      }
      return originalWriteFile(target, ...args);
    };
    fs.closeSync = (descriptor, ...args) => {
      if (leaseDescriptors.has(descriptor)) closedDescriptors.add(descriptor);
      return originalClose(descriptor, ...args);
    };
    try {
      expectStoreHold(() => RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' }));
    } finally {
      fs.openSync = originalOpen;
      fs.writeFileSync = originalWriteFile;
      fs.closeSync = originalClose;
    }
    assert.strictEqual(partialWrite, true, 'the partial lease write fault must execute');
    assert.strictEqual(fs.existsSync(leasePath), false, 'partial lease writes must leave no lease');
    assert.strictEqual(closedDescriptors.size, leaseDescriptors.size, 'partial lease write descriptors must close');
  });

  collectScenario('R3A A2 lease path-bind failure removes the descriptor-owned lease', () => {
    const runId = 'run-r3a-lease-path-bind';
    const leasePath = path.join(runDirectory(testRoot, runId), 'writer-lease.json');
    const originalOpen = fs.openSync;
    const originalLstat = fs.lstatSync;
    const originalClose = fs.closeSync;
    const leaseDescriptors = new Set();
    const closedDescriptors = new Set();
    let injectedLstat = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (path.resolve(String(target)) === path.resolve(leasePath)) leaseDescriptors.add(descriptor);
      return descriptor;
    };
    fs.lstatSync = (target, ...args) => {
      if (!injectedLstat && leaseDescriptors.size > 0 && path.resolve(String(target)) === path.resolve(leasePath)) {
        injectedLstat = true;
        const error = new Error('injected lease path bind failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLstat(target, ...args);
    };
    fs.closeSync = (descriptor, ...args) => {
      if (leaseDescriptors.has(descriptor)) closedDescriptors.add(descriptor);
      return originalClose(descriptor, ...args);
    };
    try {
      expectStoreHold(() => RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' }));
    } finally {
      fs.openSync = originalOpen;
      fs.lstatSync = originalLstat;
      fs.closeSync = originalClose;
    }
    assert.strictEqual(injectedLstat, true, 'the lease path-bind fault must execute');
    assert.strictEqual(fs.existsSync(leasePath), false, 'failed lease path binding must not orphan a lease');
    assert.strictEqual(closedDescriptors.size, leaseDescriptors.size, 'lease path-bind descriptors must close');
  });

  collectScenario('R3A A3 temp path-bind failure removes the descriptor-owned temporary file', () => {
    const runId = 'run-r3a-temp-path-bind';
    const store = RecoveryStore.open({ dataRoot: testRoot, runId, writerId: 'writer-A' });
    const directory = runDirectory(testRoot, runId);
    const originalOpen = fs.openSync;
    const originalLstat = fs.lstatSync;
    const originalClose = fs.closeSync;
    const tempDescriptors = new Set();
    const closedDescriptors = new Set();
    let tempPath = null;
    let injectedLstat = false;
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      if (path.basename(String(target)).startsWith('.pending-')) {
        tempPath = path.resolve(String(target));
        tempDescriptors.add(descriptor);
      }
      return descriptor;
    };
    fs.lstatSync = (target, ...args) => {
      if (!injectedLstat && tempPath !== null && path.resolve(String(target)) === tempPath) {
        injectedLstat = true;
        const error = new Error('injected temp path bind failure');
        error.code = 'EIO';
        throw error;
      }
      return originalLstat(target, ...args);
    };
    fs.closeSync = (descriptor, ...args) => {
      if (tempDescriptors.has(descriptor)) closedDescriptors.add(descriptor);
      return originalClose(descriptor, ...args);
    };
    try {
      expectStoreHold(() => store.savePending({ records: [recoveryRecord('resource-r3a-temp', runId)] }));
    } finally {
      fs.openSync = originalOpen;
      fs.lstatSync = originalLstat;
      fs.closeSync = originalClose;
    }
    assert.strictEqual(injectedLstat, true, 'the temp path-bind fault must execute');
    assert.strictEqual(closedDescriptors.size, tempDescriptors.size, 'temp path-bind descriptors must close');
    assert.strictEqual(fs.readdirSync(directory).some((name) => name.startsWith('.pending-') || name.startsWith('pending-revision-')), false, 'failed temp path binding must not leave a temporary file or revision');
    assert.deepStrictEqual(store.close(), { released: true, disposition: 'RELEASED' });
  });
} finally {
  try {
    assertOwnedTempRoot(testRoot);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

assert.strictEqual(fs.existsSync(testRoot), false, 'test-owned temporary root must be absent after cleanup');
if (scenarioFailures.length > 0) {
  throw new Error(`RecoveryStore R2 scenarios failed:\n${scenarioFailures.join('\n')}`);
}
process.stdout.write('recovery store tests passed.\n');
