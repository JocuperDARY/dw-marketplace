'use strict';

const fs = require('fs');
const path = require('path');
const { TaskResourceManager } = require('./task-resource-manager');
const { createDetachedJsonSnapshot, computeDetachedSha256 } = require('./canonical-json');
const { validateResourceIdentity2 } = require('./identity-support-v2');
const { startWindowsCommand } = require('./windows-command-backend');
const snapshot = value => createDetachedJsonSnapshot(value).snapshot;
const hash = value => computeDetachedSha256(snapshot(value));
const same = (a, b) => hash(a) === hash(b);
function fail() { throw new Error('WINDOWS_COMMAND_HOST_HOLD'); }
function positive(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail();
  return value;
}
function executablePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)
      || path.extname(value).toLowerCase() !== '.exe' || !fs.statSync(value).isFile()) fail();
  return fs.realpathSync(value);
}

// Commands only: no temporary allocation or M2 shutdown-protocol promises.
// The explicit force and deadline grants also cover the native supervisor's
// autonomous timeout enforcement, which is independent of manager.stop().
async function createWindowsCommandHost(options) {
  if (process.platform !== 'win32') fail();
  const input = snapshot(options);
  const authorization = input.authorization;
  if (!authorization || Object.keys(authorization).sort().join(',') !== 'allowForceTermination,cleanupAuthorityRef,type' || authorization.type !== 'TaskResourceAuthorization1'
      || authorization.allowForceTermination !== true
      || !/^authority:[a-f0-9]{64}$/.test(authorization.cleanupAuthorityRef)
      || input.hardDeadlineAuthorized !== true) fail();
  for (const key of ['runId', 'harnessId', 'producerId', 'ownerId', 'sessionId', 'managerRunId', 'adapterId']) {
    if (typeof input[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input[key])) fail();
  }
  positive(input.managerGeneration, Number.MAX_SAFE_INTEGER);
  if (input.adapterGeneration !== input.managerGeneration) fail();
  if (typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)
      || path.resolve(input.dataRoot) === path.parse(input.dataRoot).root) fail();
  const bounds = input.bounds;
  if (!bounds) fail();
  positive(bounds.maxTimeoutMs, 2147383647);
  positive(bounds.graceMs, 30000);
  positive(bounds.maxOutputBytes, 64 * 1024 * 1024);
  positive(bounds.retentionMs, 30000); if (bounds.retentionMs < 1000) fail();
  positive(bounds.maxCommands, 256);
  const supervisorPath = executablePath(input.supervisorPath);
  const digestBytes = bytes => require('crypto').createHash('sha256').update(bytes).digest('hex');
  const prepared = input.preparedBackend;
  const nativeSource = path.join(__dirname, '..', 'process-supervisor');
  const sourceSha256 = digestBytes(Buffer.concat(['DwProcessSupervisor.cs', 'DwProcessSupervisor.Managed.cs']
    .map(name => fs.readFileSync(path.join(nativeSource, name)))));
  const binarySha256 = digestBytes(fs.readFileSync(supervisorPath));
  const manifest = JSON.parse(fs.readFileSync(`${supervisorPath}.json`, 'utf8'));
  if (!prepared || prepared.schemaVersion !== 1 || prepared.sourceSha256 !== sourceSha256
      || prepared.executableSha256 !== binarySha256 || !same(manifest, {
        schemaVersion: 1, sourceSha256, executableSha256: binarySha256 })
      || executablePath(prepared.executable) !== supervisorPath) fail();
  const provenance = snapshot({
    type: 'TaskResourceProvenance1', runId: input.runId, harnessId: input.harnessId,
    producerId: input.producerId, ownerId: input.ownerId, sessionId: input.sessionId,
    managerRunId: input.managerRunId, managerGeneration: input.managerGeneration,
    adapterId: input.adapterId, adapterGeneration: input.adapterGeneration,
    platform: 'windows', observedAt: new Date().toISOString(),
    authorizationSha256: hash(authorization),
  });
  const shortProvenance = snapshot(Object.fromEntries([
    'ownerId', 'runId', 'sessionId', 'managerRunId', 'managerGeneration', 'adapterGeneration', 'platform',
  ].map(key => [key, provenance[key]])));
  // One explicit, inert, bounded capability probe precedes manager admission.
  // Business commands never serve as capability probes.
  const probeBinding = hash({ provenance, kind: 'windows-command-capability-probe' });
  let probeSession;
  let probeEvidence;
  try {
    probeSession = await startWindowsCommand({ supervisorPath, executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'], cwd: path.dirname(supervisorPath),
      timeoutMs: Math.min(bounds.maxTimeoutMs, 2000), graceMs: bounds.graceMs,
      maxOutputBytes: 4096, retentionMs: bounds.retentionMs, binding: probeBinding });
    const observed = await probeSession.observe();
    const eof = await probeSession.closeInput();
    const graceful = await probeSession.gracefulStop();
    const terminated = await probeSession.terminate();
    const terminal = await probeSession.wait();
    const released = await probeSession.release();
    if (!observed.state || observed.state.activeProcesses < 1 || observed.state.rootExited
        || graceful.state.gracefulRequested !== true || terminated.state.forced !== true
        || !terminal.terminal || terminal.cleanup !== 'verified_absent'
        || !terminal.outputComplete || !released.supervisorClosed || released.error
        || released.cleanup !== 'verified_absent') fail();
    probeEvidence = { identity: probeSession.identity, observed, eof, graceful, terminated,
      terminal: terminal.terminal, released: released.response };
  } catch (error) {
    if (probeSession) await probeSession.release().catch(() => {});
    throw error;
  }
  const capabilityRef = `evidence:${hash({ provenance, supervisorPath,
    probeEvidence, supervisorSha256: require('crypto').createHash('sha256').update(fs.readFileSync(supervisorPath)).digest('hex'), bounds })}`;
  const claims = Object.fromEntries(['process_identity', 'resource_observation', 'request_shutdown',
    'process_tree_terminate'].map(key => [key, { state: 'VERIFIED_FULL', evidence_refs: [capabilityRef] }]));
  claims.temporary_lease = { state: 'NOT_RUN', evidence_refs: [] };
  const envelope = snapshot({ type: 'TaskResourceCapabilityEnvelope1', provenance,
    supportMatrix: { schema: 'SupportMatrix2', schema_version: 2, adapter_id: input.adapterId,
      platform: 'windows', observed_at: provenance.observedAt, overall_state: 'UNVERIFIED', claims } });
  const requiredReferences = [authorization.cleanupAuthorityRef, capabilityRef].sort();
  const commands = new Map();
  const pendingStarts = new Set();
  const pendingCommandIds = new Set();
  const requests = new Set();
  const receipts = new Map();
  let launches = 0;
  let actionCount = 0;
  let closed = false;
  const contextMatches = context => context && context.runId === input.runId
    && context.harnessId === input.harnessId && context.adapterId === input.adapterId
    && context.authorizationSha256 === provenance.authorizationSha256
    && same(context.requiredReferences, requiredReferences);
  function trustedProducer(candidate, context) {
    try {
      if (!contextMatches(context)) return false;
      if (!context.resolutionType) return same(candidate, envelope);
      if (context.resolutionType !== 'observation' || !same(context.provenance, provenance)) return false;
      if (receipts.has(hash(candidate))) return true;
      if (candidate.purpose !== 'process_recovery' || candidate.ownerId !== input.ownerId
          || candidate.runId !== input.runId || candidate.generation !== input.managerGeneration) return false;
      for (const record of commands.values()) {
        const resource = candidate.resource;
        if (!resource || ![record.request.resourceIds.processTree, record.request.resourceIds.commandSession].includes(resource.resourceId)
            || resource.ownerId !== input.ownerId || resource.generation !== input.managerGeneration
            || resource.boundGeneration !== input.managerGeneration || resource.scopeId !== 'command:' + record.request.commandId
            || resource.type !== (resource.resourceId === record.request.resourceIds.processTree ? 'process_tree' : 'command_session')
            || resource.parentResourceId !== (resource.type === 'process_tree' ? record.request.resourceIds.commandSession : null)
            || !same(resource.identity, record.identity)) continue;
        const observation = candidate.observation;
        for (const evidence of record.observations) {
          const scope = { kind: 'scope', value: resource.scopeId };
          const expected = {
            duplicate_run_lock: false, owner_status: 'owned', orphaned: false,
            expected_identity: record.identity, observed_identity: record.identity,
            expected_generation: input.managerGeneration, observed_generation: input.managerGeneration,
            expected_scope: scope, observed_scope: scope,
            graceful: evidence.graceful, exact_tree_termination_supported: evidence.exact,
            absence: evidence.absence, evidence_refs: evidence.refs,
          };
          if (record.scopeId && record.scopeId !== resource.scopeId) continue;
          if (same(observation, expected)) return true;
        }
      }
      return false;
    } catch (_) { return false; }
  }
  function commandValid(command) {
    if (!command || command.temporaryRoot !== null || Object.hasOwn(command, 'gracefulShutdown')) fail();
    positive(command.timeoutMs, bounds.maxTimeoutMs);
    executablePath(command.executable);
    if (!Array.isArray(command.args) || command.args.some(x => typeof x !== 'string' || /[\0\r\n]/.test(x))
        || typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd)
        || !fs.statSync(command.cwd).isDirectory()) fail();
  }
  function requestValid(request, repeat = false) {
    const base = ['type', 'requestSha256', 'commandId', 'resourceIds', 'spawnRequestSha256',
      'launchNonce', 'expectedIdentity', 'expectedGeneration', 'expectedScope', 'provenance'];
    const extras = {
      TaskResourceProcessObservationRequest1: [],
      TaskResourceGracefulStopRequest1: ['actionTimeoutMs', 'reasonCode'],
      TaskResourceStopObservationRequest1: ['actionTimeoutMs', 'boundedWaitMs', 'gracefulRequestSha256'],
      TaskResourceTerminateOwnedTreeRequest1: ['actionTimeoutMs', 'gracefulRequestSha256',
        'observationRequestSha256', 'confirmedIdentity', 'forceAuthorization', 'reasonCode'],
      TaskResourceProcessAbsenceVerificationRequest1: ['actionTimeoutMs', 'expectedIdentitySha256',
        'gracefulRequestSha256', 'terminalAction', 'terminalActionRequestSha256'],
    };
    if (request.type !== 'TaskResourceSpawnRequest1') {
      if (!Object.hasOwn(extras, request.type)
          || Object.keys(request).sort().join(',') !== [...base, ...extras[request.type]].sort().join(',')) fail();
    }
    const { requestSha256, ...payload } = request;
    if (closed || actionCount >= 4096 || requests.size >= 4096 || requestSha256 !== hash(payload) || (!repeat && requests.has(requestSha256))) fail();
    requests.add(requestSha256);
    actionCount += 1;
  }
  function existing(request, repeat = false) {
    requestValid(request, repeat);
    const record = commands.get(request.commandId);
    if (!record || request.spawnRequestSha256 !== record.request.requestSha256
        || request.launchNonce !== record.identity.launch_nonce
        || !same(request.provenance, shortProvenance)
        || !same(request.expectedIdentity, record.identity)
        || !same(request.resourceIds, record.request.resourceIds)
        || request.expectedGeneration !== input.managerGeneration
        || !request.expectedScope || request.expectedScope.kind !== 'scope'
        || request.expectedScope.value !== 'command:' + request.commandId) fail();
    if (record.scopeId && record.scopeId !== request.expectedScope.value) fail();
    record.scopeId = request.expectedScope.value;
    return record;
  }
  function nativeState(record, response) {
    if (response.session !== record.session.session || response.binding !== record.request.requestSha256
        || !same(response.identity, record.session.identity) || !response.state) fail();
    return response.state;
  }
  function receipt(record, request, native, fields) {
    const ref = `evidence:${hash({ requestSha256: request.requestSha256, native })}`;
    const result = snapshot({ ...fields, evidenceRefs: [ref], requestSha256: request.requestSha256 });
    // Keep the native digest, request and exact receipt together in private memory.
    receipts.set(hash(result), { nativeSha256: hash(native), request: snapshot(request), result });
    return result;
  }
  function remember(record, result, graceful, exact, absent = false) {
    record.observations.push({ graceful, exact, absence: {
      process_absent: absent, thread_absent: absent, port_absent: absent,
    }, refs: result.evidenceRefs });
  }
  function requireGraceful(record, request) {
    if (!record.graceful || request.gracefulRequestSha256 !== record.graceful.requestSha256) fail();
  }
  const unsupported = () => { fail(); };
  const platformAdapter = Object.freeze({
    type: 'TaskResourcePlatformAdapter1', adapterId: input.adapterId,
    probeCapabilities(context) {
      if (!same(context, { type: 'TaskResourceCapabilityProbe1', runId: input.runId,
        harnessId: input.harnessId, adapterId: input.adapterId })) fail();
      return envelope;
    },
    async spawnManaged(request) {
      request = snapshot(request);
      requestValid(request);
      if (request.type !== 'TaskResourceSpawnRequest1' || Object.keys(request).sort().join(',') !== 'allocationId,args,commandId,creationNonce,cwd,executable,launchNonce,provenance,requestSha256,resourceIds,temporaryAllocationIdentity,temporaryRoot,timeoutMs,type' || !same(request.provenance, shortProvenance)
          || request.temporaryAllocationIdentity !== null || request.allocationId !== null
          || request.creationNonce !== null || commands.has(request.commandId) || pendingCommandIds.has(request.commandId) || launches >= bounds.maxCommands) fail();
      commandValid(request);
      if (!same(request.resourceIds, { temporaryAllocation: null,
        commandSession: `command:${request.commandId}:session`, processTree: `command:${request.commandId}:process-tree` })) fail();
      pendingCommandIds.add(request.commandId);
      launches += 1;
      const launching = startWindowsCommand({ supervisorPath, executable: request.executable,
        args: request.args, cwd: request.cwd, timeoutMs: request.timeoutMs, graceMs: bounds.graceMs,
        maxOutputBytes: bounds.maxOutputBytes, retentionMs: bounds.retentionMs, binding: request.requestSha256 });
      pendingStarts.add(launching);
      let session;
      try { session = await launching; } finally { pendingStarts.delete(launching); pendingCommandIds.delete(request.commandId); }
      const record = { session, request: snapshot(request), identity: null, observations: [], scopeId: null };
      commands.set(request.commandId, record);
      if (closed) { await releaseRecord(record); fail(); }
      const native = session.identity;
      const identity = snapshot({ schema: 'ProcessIdentity2', schema_version: 2, platform: 'windows',
        owner_id: input.ownerId, run_id: input.runId, session_id: input.sessionId,
        lease_generation: input.managerGeneration, adapter_generation: input.adapterGeneration,
        manager_generation: input.managerGeneration, pid: native.pid,
        start_time: new Date(Number((BigInt(native.creationTimeFiletime) - 116444736000000000n) / 10000n)).toISOString(),
        executable_path_sha256: hash(native.executablePath), argv_sha256: hash(request.args),
        parent_identity_sha256: hash({ pid: native.parentPid, creationTimeFiletime: native.parentCreationTimeFiletime }),
        launch_nonce: request.launchNonce, manager_run_id: input.managerRunId,
        windows_identity: { process_creation_time_filetime: native.creationTimeFiletime, process_handle: native.processHandleToken } });
      record.identity = identity;
      // Retain failed identity admission for bounded disposal; do not fabricate a start receipt.
      commands.set(request.commandId, record);
      if (!validateResourceIdentity2('process_tree', identity).valid
          || path.resolve(native.executablePath).toLowerCase() !== path.resolve(request.executable).toLowerCase()) fail();
      return receipt(record, request, { session: session.session, binding: session.binding, identity: native }, { identity });
    },
    async observeProcess(request) {
      request = snapshot(request);
      const record = existing(request, true);
      if (!['TaskResourceProcessObservationRequest1', 'TaskResourceStopObservationRequest1'].includes(request.type)) fail();
      const stopping = request.type === 'TaskResourceStopObservationRequest1';
      if (stopping) requireGraceful(record, request);
      const native = await record.session.observe();
      const state = nativeState(record, native);
      const graceful = { requested: true, deadlineReached: Date.now() >= record.graceDeadline,
        exitObserved: state.rootExited === true && state.activeProcesses === 0 && state.cleanup === 'verified_absent' };
      const result = receipt(record, request, native, stopping
        ? { identity: record.identity, graceful, exactTreeTerminationSupported: true }
        : { identity: record.identity });
      if (stopping) {
        record.stopObservation = result;
        remember(record, result, { requested: true, deadline_reached: graceful.deadlineReached,
          exit_observed: graceful.exitObserved }, true);
      }
      return result;
    },
    async requestGracefulStop(request) {
      request = snapshot(request);
      const record = existing(request);
      if (request.type !== 'TaskResourceGracefulStopRequest1' || record.graceful) fail();
      const native = await record.session.gracefulStop();
      nativeState(record, native);
      record.graceDeadline = Date.now() + bounds.graceMs;
      record.graceful = receipt(record, request, native, { disposition: 'COMPLETED',
        targetIdentitySha256: hash(record.identity), identityRevalidated: true });
      return record.graceful;
    },
    async terminateOwnedTree(request) {
      request = snapshot(request);
      const record = existing(request);
      requireGraceful(record, request);
      if (request.type !== 'TaskResourceTerminateOwnedTreeRequest1'
          || !record.stopObservation || request.observationRequestSha256 !== record.stopObservation.requestSha256
          || !same(request.confirmedIdentity, record.identity) || Date.now() < record.graceDeadline
          || !same(request.forceAuthorization, { allowedAtOpen: true, authorizationSha256: provenance.authorizationSha256 })) fail();
      const native = await record.session.terminate();
      nativeState(record, native);
      record.termination = receipt(record, request, native, { disposition: 'COMPLETED',
        targetIdentitySha256: hash(record.identity), identityRevalidated: true });
      return record.termination;
    },
    async verifyProcessAbsent(request) {
      request = snapshot(request);
      const record = existing(request, true);
      requireGraceful(record, request);
      const terminal = request.terminalAction === 'graceful_exit' ? record.stopObservation
        : request.terminalAction === 'force_termination' ? record.termination : null;
      if (request.type !== 'TaskResourceProcessAbsenceVerificationRequest1' || !terminal
          || request.terminalActionRequestSha256 !== terminal.requestSha256
          || request.expectedIdentitySha256 !== hash(record.identity)) fail();
      const native = await record.session.observe();
      const state = nativeState(record, native);
      const absent = state.rootExited === true && state.activeProcesses === 0 && state.cleanup === 'verified_absent';
      const result = receipt(record, request, native, { disposition: absent ? 'ABSENT_CONFIRMED' : 'COMPLETED',
        targetIdentitySha256: hash(record.identity), absence: { processAbsent: absent, threadAbsent: absent, portAbsent: absent } });
      if (absent) remember(record, result, { requested: true, deadline_reached: false, exit_observed: true }, false, true);
      return result;
    },
    allocateTemporaryRoot: unsupported, quarantineTemporaryRoot: unsupported,
    removeTemporaryRoot: unsupported, verifyTemporaryAbsent: unsupported,
  });
  const manager = TaskResourceManager.open({ runId: input.runId, dataRoot: input.dataRoot,
    harness: { type: 'TaskResourceHarness1', harnessId: input.harnessId, trustedProducer },
    platformAdapter, authorization, limits: input.limits || {} });
  async function releaseRecord(record) {
    if (record.releasePromise) return record.releasePromise;
    record.releasePromise = (async () => {
      try {
        const released = await record.session.release();
        record.releaseResult = snapshot({ supervisorClosed: released.supervisorClosed === true,
          cleanup: released.cleanup, response: released.response || null,
          errorCode: released.error ? String(released.error.code || 'NATIVE_RELEASE_FAILED') : null });
      } catch (_) {
        record.releaseResult = snapshot({ supervisorClosed: false, cleanup: 'unknown', response: null,
          errorCode: 'NATIVE_RELEASE_FAILED' });
      }
      return record.releaseResult;
    })();
    return record.releasePromise;
  }
  async function close() {
    const result = await manager.close();
    if (result.status === 'CLOSED') {
      closed = true;
      const releases = await Promise.all([...commands.values()].map(releaseRecord));
      return snapshot({ status: releases.every(value => value.supervisorClosed && value.cleanup === 'verified_absent'
        && value.errorCode === null) ? 'CLOSED' : 'HOLD', manager: result, releases });
    }
    return snapshot({ status: result.status, manager: result, releases: [] });
  }
  return Object.freeze({ manager, platformAdapter, trustedProducer,
    startCommand(command) {
      if (!command || Object.keys(command).sort().join(',') !== 'args,commandId,cwd,executable,temporaryRoot,timeoutMs') fail();
      commandValid(command); return manager.startCommand(command);
    },
    observe: resourceId => manager.observe(resourceId),
    stop: (resourceId, options) => manager.stop(resourceId, options),
    wait: commandId => { const record = commands.get(commandId); if (!record) fail(); return record.session.wait(); },
    close,
    async dispose() {
      closed = true;
      await Promise.allSettled([...pendingStarts]);
      const results = [];
      for (const record of commands.values()) {
        if (!record.releaseResult && !record.releasePromise) {
          try { await record.session.terminate(); } catch (_) { /* Release must run even after a rejected termination. */ }
        }
        results.push(await releaseRecord(record));
      }
      // This is emergency native teardown only; it makes no tracker-close claim.
      return snapshot({ status: 'HOLD', releases: results });
    },
  });
}
module.exports = { createWindowsCommandHost };
