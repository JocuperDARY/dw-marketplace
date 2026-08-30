#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contracts = require('../skills/dw-collaboration/scripts/lib/contracts');
const stateMachines = require('../skills/dw-collaboration/scripts/lib/state-machines');
const {
  ResourceTrackerError,
  TaskResourceTracker,
} = require('../skills/dw-collaboration/scripts/lib/task-resource-tracker');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const opaqueRef = (kind, value) => `${kind}:${hash(value)}`;
const schemaRoot = path.resolve(__dirname, '../skills/dw-collaboration/references/schemas');
const loadSchema = (name) => JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8'));
const schemaNames = [
  'ProcessIdentity2.schema.json',
  'HarnessSessionIdentity2.schema.json',
  'TemporaryAllocationIdentity2.schema.json',
  'RecoveryRecord2.schema.json',
  'SupportMatrix2.schema.json',
];
const schemaBundle = schemaNames.map(loadSchema);
const schemaRequirementsPath = path.resolve(__dirname, 'schema-validation-requirements.txt');
const compatiblePythonDescriptors = new Map();
const stableVersionPattern = /^\d+(?:\.\d+)*$/;
const compatibilityPythonErrorCodes = new Set([
  'PYTHON_SCHEMA_DEPENDENCY_MISSING',
  'PYTHON_SCHEMA_VERSION_UNSUPPORTED',
  'PYTHON_SCHEMA_API_MISSING',
  'PYTHON_SCHEMA_MALFORMED_OUTPUT',
]);

function pythonDescriptor(executable, prefixArgs = []) {
  return Object.freeze({ executable, prefixArgs: Object.freeze([...prefixArgs]) });
}

function pythonDiscoveryKey() {
  const overrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  return JSON.stringify({
    platform: process.platform,
    override: overrideIsSet ? process.env.DW_SCHEMA_PYTHON : null,
    path: process.env.PATH ?? '',
  });
}

function pythonCandidates() {
  if (Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON')) {
    return { override: true, candidates: [pythonDescriptor(process.env.DW_SCHEMA_PYTHON)] };
  }
  return {
    override: false,
    candidates: process.platform === 'win32'
      ? [pythonDescriptor('py', ['-3']), pythonDescriptor('python'), pythonDescriptor('python3')]
      : [pythonDescriptor('python3'), pythonDescriptor('python')],
  };
}

function pythonError(code, message, descriptor = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.descriptor = descriptor;
  return error;
}

function descriptorDisplay(descriptor) {
  return [descriptor.executable, ...descriptor.prefixArgs].map((part) => JSON.stringify(part)).join(' ');
}

function installCommand(descriptor) {
  return `${descriptorDisplay(descriptor)} -m pip install -r ${JSON.stringify(schemaRequirementsPath)}`;
}

function classifyPythonSpawn(result, descriptor, stage) {
  const errorCode = result.error?.code;
  if (errorCode === 'ENOBUFS') {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_OUTPUT_OVERFLOW', `${stage} exceeded the 65536-byte output limit`, descriptor) };
  }
  if (errorCode === 'ETIMEDOUT') {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_TIMEOUT', `${stage} exceeded the 10000ms timeout`, descriptor) };
  }
  if (result.error) {
    if (errorCode === 'ENOENT') {
      return { executed: false, error: pythonError('PYTHON_SCHEMA_NO_INTERPRETER', `${stage} could not execute ${descriptorDisplay(descriptor)}`, descriptor) };
    }
    return { executed: true, error: pythonError('PYTHON_SCHEMA_PROCESS_FAILURE', `${stage} failed to start: ${result.error.message}`, descriptor) };
  }
  if (result.signal) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_TERMINATED', `${stage} terminated by ${result.signal}`, descriptor) };
  }
  if (result.status === null) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_PROCESS_FAILURE', `${stage} returned a null status`, descriptor) };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return { executed: true, error: pythonError('PYTHON_SCHEMA_PROCESS_FAILURE', `${stage} exited with status ${result.status}${detail ? `: ${detail}` : ''}`, descriptor) };
  }
  return { executed: true, result };
}

function runPython(descriptor, args, input, stage) {
  const result = childProcess.spawnSync(descriptor.executable, [...descriptor.prefixArgs, ...args], {
    encoding: 'utf8',
    input,
    shell: false,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  return classifyPythonSpawn(result, descriptor, stage);
}

function parsePythonJson(stdout, descriptor, stage) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', `${stage} did not produce JSON: ${error.message}`, descriptor);
  }
}

function selectPythonResolutionError(probes) {
  let firstCompatibilityError = null;
  let firstExecutedError = null;
  for (const probe of probes) {
    if (!probe.executed) continue;
    firstExecutedError ??= probe.error;
    if (compatibilityPythonErrorCodes.has(probe.error?.code)) {
      firstCompatibilityError ??= probe.error;
    }
  }
  return firstCompatibilityError ?? firstExecutedError
    ?? pythonError('PYTHON_SCHEMA_NO_INTERPRETER', 'No configured Python interpreter could be executed');
}

function compareVersionSegments(left, right) {
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const leftSegment = Number(left[index] ?? 0);
    const rightSegment = Number(right[index] ?? 0);
    if (leftSegment !== rightSegment) return leftSegment < rightSegment ? -1 : 1;
  }
  return 0;
}

function stableVersionInRange(version, lowerBound, upperBound) {
  if (typeof version !== 'string' || !stableVersionPattern.test(version)) return false;
  const segments = version.split('.').map(Number);
  return compareVersionSegments(segments, lowerBound.split('.').map(Number)) >= 0
    && compareVersionSegments(segments, upperBound.split('.').map(Number)) < 0;
}

const pythonCompatibilityProbe = [
  'import json',
  'from importlib.metadata import PackageNotFoundError, version',
  'try:',
  '    jsonschema_version = version("jsonschema")',
  '    referencing_version = version("referencing")',
  'except PackageNotFoundError as error:',
  '    print(json.dumps({"kind": "missing_dependency", "package": getattr(error, "name", str(error))}))',
  '    raise SystemExit(0)',
  'try:',
  '    from jsonschema import Draft202012Validator',
  '    from referencing import Registry, Resource',
  '    required = [Draft202012Validator, Registry, Resource, Resource.from_contents, Registry.with_resource]',
  '    if not all(callable(value) for value in required):',
  '        raise TypeError("required Draft 2020-12 API surface is not callable")',
  '    registry = Registry().with_resource("urn:dw:python-probe", Resource.from_contents({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:dw:python-probe"}))',
  '    Draft202012Validator({"$schema": "https://json-schema.org/draft/2020-12/schema"}, registry=registry)',
  'except Exception as error:',
  '    print(json.dumps({"kind": "missing_api", "detail": f"{type(error).__name__}: {error}"}))',
  '    raise SystemExit(0)',
  'print(json.dumps({"kind": "compatible", "jsonschema": jsonschema_version, "referencing": referencing_version}))',
].join('\n');

function probePythonDescriptor(descriptor, prefixArgs = []) {
  const probeDescriptor = pythonDescriptor(descriptor.executable, [...descriptor.prefixArgs, ...prefixArgs]);
  const execution = runPython(probeDescriptor, ['-X', 'utf8', '-c', pythonCompatibilityProbe], undefined, 'Python compatibility probe');
  if (execution.error) return execution;
  let probe;
  try {
    probe = JSON.parse(execution.result.stdout);
  } catch (error) {
    return {
      executed: true,
      error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', `Python compatibility probe did not produce JSON: ${error.message}`, probeDescriptor),
    };
  }
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility probe returned a non-object', probeDescriptor) };
  }
  if (probe.kind === 'missing_dependency') {
    return {
      executed: true,
      error: pythonError(
        'PYTHON_SCHEMA_DEPENDENCY_MISSING',
        `Python compatibility probe is missing ${String(probe.package)}; install with ${installCommand(descriptor)}`,
        probeDescriptor,
      ),
    };
  }
  if (probe.kind === 'missing_api') {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_API_MISSING', `Python compatibility probe is incompatible: ${String(probe.detail)}`, probeDescriptor) };
  }
  if (probe.kind !== 'compatible' || typeof probe.jsonschema !== 'string' || typeof probe.referencing !== 'string') {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility probe returned an unrecognized payload', probeDescriptor) };
  }
  if (!stableVersionInRange(probe.jsonschema, '4.18.0', '5.0.0')
    || !stableVersionInRange(probe.referencing, '0.28.4', '1.0.0')) {
    return {
      executed: true,
      error: pythonError(
        'PYTHON_SCHEMA_VERSION_UNSUPPORTED',
        `Python compatibility probe requires jsonschema >=4.18.0,<5.0.0 and referencing >=0.28.4,<1.0.0; received jsonschema=${probe.jsonschema}, referencing=${probe.referencing}`,
        probeDescriptor,
      ),
    };
  }
  return { executed: true, descriptor: probeDescriptor };
}

function resolveCompatiblePythonDescriptor({ bypassCache = false } = {}) {
  const cacheKey = pythonDiscoveryKey();
  if (!bypassCache && compatiblePythonDescriptors.has(cacheKey)) return compatiblePythonDescriptors.get(cacheKey);

  const { override, candidates } = pythonCandidates();
  const probes = [];
  for (const candidate of candidates) {
    const probe = probePythonDescriptor(candidate);
    if (probe.descriptor) {
      if (!bypassCache) compatiblePythonDescriptors.set(cacheKey, probe.descriptor);
      return probe.descriptor;
    }
    probes.push(probe);
    if (override) throw probe.error;
  }
  throw selectPythonResolutionError(probes);
}

function validateDraft202012Fixtures(schema, fixtures, { isolatedDependencyProbe = false } = {}) {
  const descriptor = resolveCompatiblePythonDescriptor({ bypassCache: isolatedDependencyProbe });
  if (isolatedDependencyProbe) {
    const isolatedProbe = probePythonDescriptor(descriptor, ['-I', '-S']);
    assert(isolatedProbe.error, 'PYTHON_SCHEMA_DEPENDENCY_MISSING: isolated dependency probe unexpectedly succeeded');
    throw isolatedProbe.error;
  }
  const script = [
    'import json, sys',
    'from jsonschema import Draft202012Validator',
    'from referencing import Registry, Resource',
    'payload = json.load(sys.stdin)',
    'registry = Registry()',
    'for candidate in payload["schemas"]:',
    '    registry = registry.with_resource(candidate["$id"], Resource.from_contents(candidate))',
    'validator = Draft202012Validator(payload["schema"], registry=registry)',
    'print(json.dumps([validator.is_valid(item) for item in payload["fixtures"]]))',
  ].join('\n');
  const execution = runPython(
    descriptor,
    ['-X', 'utf8', '-c', script],
    JSON.stringify({ schema, fixtures, schemas: schemaBundle }),
    'Draft 2020-12 schema validation',
  );
  if (execution.error) throw execution.error;
  const output = parsePythonJson(execution.result.stdout, descriptor, 'Draft 2020-12 schema validation');
  if (!Array.isArray(output) || !output.every((value) => typeof value === 'boolean')) {
    throw pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Draft 2020-12 schema validation returned a non-boolean result array', descriptor);
  }
  return output;
}

test('schema validation reports an actionable isolated dependency failure', () => {
  const selectedDescriptor = resolveCompatiblePythonDescriptor();
  const expectedInstallCommand = installCommand(selectedDescriptor);
  assert.throws(
    () => validateDraft202012Fixtures(loadSchema('SupportMatrix2.schema.json'), [], { isolatedDependencyProbe: true }),
    (error) => {
      assert.strictEqual(error.code, 'PYTHON_SCHEMA_DEPENDENCY_MISSING');
      assert(error.message.includes(expectedInstallCommand));
      assert(!error.message.includes(`${descriptorDisplay(pythonDescriptor(selectedDescriptor.executable, [...selectedDescriptor.prefixArgs, '-I', '-S']))} -m pip install`));
      return true;
    },
  );
  assert.strictEqual(resolveCompatiblePythonDescriptor(), selectedDescriptor);
});

test('compatibility probe classifies malformed JSON without stopping discovery', () => {
  const originalSpawnSync = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({ status: 0, stdout: 'not JSON', stderr: '', signal: null });
    const probe = probePythonDescriptor(pythonDescriptor('synthetic-python'));
    assert.strictEqual(probe.executed, true);
    assert(probe.error);
    assert.strictEqual(probe.error.code, 'PYTHON_SCHEMA_MALFORMED_OUTPUT');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
});

test('Python resolution prefers the first compatibility error over process failures', () => {
  const processFailure = pythonError('PYTHON_SCHEMA_PROCESS_FAILURE', 'first candidate failed');
  const apiMissing = pythonError('PYTHON_SCHEMA_API_MISSING', 'second candidate is incompatible');
  const malformedOutput = pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'third candidate was malformed');
  assert.strictEqual(
    selectPythonResolutionError([
      { executed: true, error: processFailure },
      { executed: true, error: apiMissing },
      { executed: true, error: malformedOutput },
    ]),
    apiMissing,
  );
  assert.strictEqual(
    selectPythonResolutionError([
      { executed: true, error: malformedOutput },
      { executed: true, error: apiMissing },
    ]),
    malformedOutput,
  );
});

test('packages the exact schema validation requirements', () => {
  assert.strictEqual(
    fs.readFileSync(schemaRequirementsPath, 'utf8'),
    'jsonschema>=4.18,<5\nreferencing>=0.28.4,<1\n',
  );
});

function windowsProcess(overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: 'windows',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
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
    ...overrides,
  };
}

function linuxProcess(overrides = {}) {
  return {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    platform: 'linux',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    adapter_generation: 2,
    manager_generation: 7,
    pid: 41003,
    start_time: '2026-08-30T01:00:01Z',
    executable_path_sha256: hash('/usr/bin/node'),
    argv_sha256: hash('node worker.js'),
    parent_identity_sha256: hash('parent-linux'),
    launch_nonce: 'launch-linux-1',
    manager_run_id: 'manager-run-linux-1',
    linux_identity: {
      proc_start_ticks: 998877,
      boot_id_sha256: hash('boot-id-linux'),
    },
    ...overrides,
  };
}

function harnessSession(kind = 'agent_session', overrides = {}) {
  return {
    schema: 'HarnessSessionIdentity2',
    schema_version: 2,
    harness_kind: kind,
    session_id: 'session-A',
    owner_id: 'root-A',
    run_id: 'run-A',
    lease_generation: 2,
    adapter_generation: 2,
    harness_instance_id: `instance-${kind}-A`,
    launch_nonce: `launch-${kind}-A`,
    ...(kind === 'agent_session' ? { agent_id: 'agent-A' } : { thread_id: 'thread-A' }),
    ...overrides,
  };
}

function temporaryAllocation(overrides = {}) {
  return {
    schema: 'TemporaryAllocationIdentity2',
    schema_version: 2,
    platform: 'linux',
    allocation_id: 'temp-A',
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    child_id: 'child-A',
    manifest_sha256: hash('manifest-A'),
    canonical_root: '/tmp/dw/run-A',
    task_directory: {
      path: '/tmp/dw/run-A/task-A',
      linux_file_identity: { device_id: 'dev-2049', inode: 889901 },
    },
    confirmed_parent_directory: {
      path: '/tmp/dw/run-A',
      linux_file_identity: { device_id: 'dev-2049', inode: 889900 },
    },
    quota: { unit: 'bytes', limit: 1048576 },
    creation_nonce: 'creation-temp-A',
    linux_file_identity: {
      device_id: 'dev-2049',
      inode: 889900,
    },
    ...overrides,
  };
}

function legacyProcess(overrides = {}) {
  return {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
    ...overrides,
  };
}

function makeTracker() {
  return new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
  });
}

function resource(resourceId, type) {
  return {
    resourceId,
    type,
    purpose: 'identity routing test',
    teardownCondition: 'scope_close',
    quota: { kind: 'bounded-test', value: 1 },
    evidenceRefs: [`declare-${resourceId}`],
  };
}

function replayTracker(history) {
  return TaskResourceTracker.fromHistory({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    trustedHistoryResolver: () => true,
  }, history);
}

function assertEnvelopeHold(scope, tracker, resourceId, observation, expectedCode, rejectedMarker = null) {
  const before = scope.getResource(resourceId);
  const held = scope.bind(resourceId, observation);
  assert.strictEqual(Object.isFrozen(held), true);
  assert.strictEqual(held.valid, false);
  assert.strictEqual(held.disposition, 'HOLD');
  assert.strictEqual(held.action_authorized, false);
  assert.deepStrictEqual(held.errors, [{
    code: expectedCode,
    path: expectedCode === 'GENERATION_INVALID'
      ? '$.generation'
      : expectedCode === 'EVIDENCE_REFS_INVALID'
        ? '$.evidenceRefs'
        : '$.observation',
    message: expectedCode === 'CANONICAL_REJECTED'
      ? 'bind observation rejected by canonical JSON contract'
      : expectedCode === 'RESOURCE_OBSERVATION_INVALID'
        ? 'bind observation must be a non-array object'
        : expectedCode === 'GENERATION_INVALID'
          ? 'generation must be a positive safe integer'
          : 'evidenceRefs must contain non-empty strings',
  }]);

  const after = scope.getResource(resourceId);
  assert.strictEqual(after.state, 'HOLD');
  assert.strictEqual(after.releaseConfirmed, false);
  assert.deepStrictEqual(after.identity, before.identity);
  assert.strictEqual(after.boundGeneration, before.boundGeneration);
  assert.deepStrictEqual(after.evidenceRefs, before.evidenceRefs);
  assert.deepStrictEqual(after.decision, held);

  const history = tracker.exportHistory();
  const heldEvent = history.at(-1);
  assert.strictEqual(heldEvent.kind, 'RESOURCE_HELD');
  assert.deepStrictEqual(heldEvent.payload.evidenceRefs, []);
  assert.deepStrictEqual(heldEvent.payload.decision, held);
  if (rejectedMarker !== null) {
    assert.strictEqual(JSON.stringify(tracker.snapshot()).includes(rejectedMarker), false);
    assert.strictEqual(JSON.stringify(history).includes(rejectedMarker), false);
  }

  const replayed = replayTracker(history).snapshot().resources
    .find((item) => item.resourceId === resourceId);
  assert.strictEqual(replayed.state, 'HOLD');
  assert.deepStrictEqual(replayed.identity, before.identity);
  assert.deepStrictEqual(replayed.evidenceRefs, before.evidenceRefs);
  assert.deepStrictEqual(replayed.decision, held);

  const historyLength = history.length;
  const rebound = scope.bind(resourceId, {
    identity: before.identity,
    generation: before.boundGeneration,
    evidenceRefs: before.evidenceRefs.filter((item) => !item.startsWith('declare-')),
  });
  assert.strictEqual(rebound.state, 'HOLD');
  assert.strictEqual(tracker.exportHistory().length, historyLength);
}

test('exports the version-2 validation surface and controlled support states', () => {
  for (const name of [
    'validateProcessIdentity2',
    'validateHarnessSessionIdentity2',
    'validateTemporaryAllocationIdentity2',
    'validateRecoveryRecord2',
    'validateSupportMatrix2',
    'validateResourceIdentity2',
    'createResourceIdentity2',
    'createRecoveryRecord2',
  ]) assert.strictEqual(typeof contracts[name], 'function', `${name} must be exported`);
  assert.deepStrictEqual(contracts.SUPPORT_STATES2, [
    'VERIFIED_FULL',
    'VERIFIED_DEGRADED',
    'UNVERIFIED',
    'NOT_RUN',
    'FAILED',
  ]);
});

test('requires task binding, adapter generations, nonces, and platform directory identities', () => {
  for (const field of ['owner_id', 'run_id', 'session_id', 'lease_generation', 'adapter_generation', 'manager_generation']) {
    const identity = windowsProcess();
    delete identity[field];
    assert.strictEqual(contracts.validateProcessIdentity2(identity).valid, false, `process ${field}`);
  }
  for (const field of ['launch_nonce', 'adapter_generation', 'agent_id']) {
    const identity = harnessSession();
    delete identity[field];
    assert.strictEqual(contracts.validateHarnessSessionIdentity2(identity).valid, false, `harness ${field}`);
  }
  const wrongHarnessKind = harnessSession('runtime_thread', { agent_id: 'agent-A' });
  delete wrongHarnessKind.thread_id;
  assert.strictEqual(contracts.validateHarnessSessionIdentity2(wrongHarnessKind).valid, false);
  for (const field of ['task_directory', 'confirmed_parent_directory', 'quota', 'creation_nonce']) {
    const identity = temporaryAllocation();
    delete identity[field];
    assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(identity).valid, false, `temporary ${field}`);
  }
  const missingParentFileIdentity = temporaryAllocation();
  delete missingParentFileIdentity.confirmed_parent_directory.linux_file_identity;
  assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(missingParentFileIdentity).valid, false);
});

test('process identities reject cross-type and mixed-platform shapes', () => {
  assert.strictEqual(contracts.validateProcessIdentity2(windowsProcess()).valid, true);
  assert.strictEqual(contracts.validateProcessIdentity2(linuxProcess()).valid, true);

  const crossType = contracts.validateProcessIdentity2(harnessSession());
  assert.strictEqual(crossType.valid, false);
  assert.strictEqual(crossType.disposition, 'HOLD');
  assert.strictEqual(crossType.action_authorized, false);
  assert(crossType.errors.some((error) => error.code === 'IDENTITY_SCHEMA_MISMATCH'));

  const missingWindows = clone(windowsProcess());
  delete missingWindows.windows_identity;
  const missingResult = contracts.validateProcessIdentity2(missingWindows);
  assert.strictEqual(missingResult.valid, false);
  assert(missingResult.errors.some((error) => error.code === 'PROCESS_PLATFORM_FIELDS_MISSING'));

  const mixed = windowsProcess({ linux_identity: linuxProcess().linux_identity });
  const mixedResult = contracts.validateProcessIdentity2(mixed);
  assert.strictEqual(mixedResult.valid, false);
  assert(mixedResult.errors.some((error) => error.code === 'PROCESS_PLATFORM_MIXED'));
});

test('harness sessions need no PID and only attach real optional OS identity', () => {
  const session = harnessSession();
  const result = contracts.validateHarnessSessionIdentity2(session);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(Object.hasOwn(session, 'pid'), false);

  const fabricated = contracts.validateHarnessSessionIdentity2(harnessSession('runtime_thread', { pid: 41002 }));
  assert.strictEqual(fabricated.valid, false);
  assert(fabricated.errors.some((error) => error.code === 'IDENTITY_ADDITIONAL_PROPERTY'));

  assert.strictEqual(contracts.validateHarnessSessionIdentity2(
    harnessSession('runtime_thread', { process_identity: windowsProcess() }),
  ).valid, true);
  assert.strictEqual(contracts.validateHarnessSessionIdentity2(
    harnessSession('runtime_thread', { process_identity: temporaryAllocation() }),
  ).valid, false);
});

test('temporary allocation identity requires platform-specific file identity', () => {
  assert.strictEqual(contracts.validateTemporaryAllocationIdentity2(temporaryAllocation()).valid, true);
  const missing = clone(temporaryAllocation());
  delete missing.linux_file_identity;
  const missingResult = contracts.validateTemporaryAllocationIdentity2(missing);
  assert.strictEqual(missingResult.valid, false);
  assert(missingResult.errors.some((error) => error.code === 'TEMPORARY_PLATFORM_FIELDS_MISSING'));

  const mixed = temporaryAllocation({
    windows_file_identity: { volume_serial_number: 'A1B2-C3D4', file_id: '0011223344556677' },
  });
  assert(contracts.validateTemporaryAllocationIdentity2(mixed).errors
    .some((error) => error.code === 'TEMPORARY_PLATFORM_MIXED'));
});

test('tracker routes v2 identities by resource type while retaining v1 compatibility', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  scope.register(resource('agent-A', 'agent_session'));
  assert.strictEqual(scope.bind('agent-A', {
    identity: harnessSession(), generation: 2, evidenceRefs: ['harness-observed'],
  }).state, 'ACTIVE');

  scope.register(resource('process-A', 'process_tree'));
  const wrongType = scope.bind('process-A', {
    identity: harnessSession(), generation: 2, evidenceRefs: ['wrong-type'],
  });
  assert.strictEqual(wrongType.disposition, 'HOLD');
  assert.strictEqual(wrongType.action_authorized, false);
  assert(Array.isArray(wrongType.errors) && wrongType.errors.length > 0);
  assert.strictEqual(scope.getResource('process-A').state, 'HOLD');
  assert.strictEqual(scope.getResource('process-A').identity, null);

  const validProcessTracker = makeTracker();
  const validProcessScope = validProcessTracker.openRootScope({ scopeId: 'root', purpose: 'test' });
  validProcessScope.register(resource('process-A', 'process_tree'));
  assert.strictEqual(validProcessScope.bind('process-A', {
    identity: windowsProcess(), generation: 2, evidenceRefs: ['process-observed'],
  }).state, 'ACTIVE');

  scope.register(resource('temp-A', 'temporary_allocation'));
  assert.strictEqual(scope.bind('temp-A', {
    identity: temporaryAllocation(), generation: 2, evidenceRefs: ['temp-observed'],
  }).state, 'ACTIVE');

  const legacy = {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
  };
  assert.strictEqual(stateMachines.validateProcessIdentity(legacy).valid, true);
  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy', purpose: 'v1 compatibility' });
  legacyScope.register(resource('legacy-process', 'process_tree'));
  assert.strictEqual(legacyScope.bind('legacy-process', {
    identity: legacy, generation: 2, evidenceRefs: ['legacy-observed'],
  }).state, 'ACTIVE');
});

test('tracker binds harness task identity and holds every ambiguous v2 path without legacy fallback', () => {
  for (const [label, overrides] of [
    ['owner', { owner_id: 'other-root' }],
    ['run', { run_id: 'other-run' }],
    ['lease generation', { lease_generation: 3 }],
    ['adapter generation', { adapter_generation: 3 }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `root-${label.replace(/\s/g, '-')}`, purpose: 'binding' });
    scope.register(resource(`agent-${label}`, 'agent_session'));
    const held = scope.bind(`agent-${label}`, {
      identity: harnessSession('agent_session', overrides), generation: 2, evidenceRefs: [`binding-${label}`],
    });
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert.strictEqual(scope.getResource(`agent-${label}`).state, 'HOLD', label);
  }

  for (const [label, identity] of [
    ['malformed schema', { ...windowsProcess(), schema: 'ProcessIdentity3' }],
    ['wrong schema', { ...windowsProcess(), schema: 'HarnessSessionIdentity2' }],
    ['mixed legacy v2', { ...windowsProcess(), native_handle: 'legacy-handle' }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `root-${label.replace(/\s/g, '-')}`, purpose: 'routing' });
    scope.register(resource(`process-${label}`, 'process_tree'));
    const held = scope.bind(`process-${label}`, {
      identity, generation: 2, evidenceRefs: [`routing-${label}`],
    });
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert.strictEqual(scope.getResource(`process-${label}`).state, 'HOLD', label);
  }

  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-invalid', purpose: 'legacy behavior' });
  legacyScope.register(resource('legacy-invalid', 'process_tree'));
  assert.throws(
    () => legacyScope.bind('legacy-invalid', {
      identity: { pid: 1 }, generation: 2, evidenceRefs: ['legacy-invalid'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'PROCESS_IDENTITY_INVALID',
  );
});

test('tracker returns replayable structured holds for rejected version-2 rebinds and preserves legacy drift exceptions', () => {
  const incompleteProcess = windowsProcess();
  delete incompleteProcess.launch_nonce;
  const rebindCases = [
    ['changed valid identity', windowsProcess({ pid: 41004 })],
    ['incomplete identity', incompleteProcess],
    ['wrong identity type', harnessSession()],
    ['wrong identity schema', windowsProcess({ schema: 'ProcessIdentity3' })],
  ];

  for (const [label, identity] of rebindCases) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `versioned-rebind-${label.replace(/\s/g, '-')}`, purpose: 'rebind' });
    const resourceId = `versioned-rebind-${label.replace(/\s/g, '-')}`;
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, { identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`] });
    const bound = scope.getResource(resourceId);

    const held = scope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-rebind`],
    });
    assert.strictEqual(held.valid, false, label);
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert(Array.isArray(held.errors) && held.errors.length > 0, label);

    const after = scope.getResource(resourceId);
    assert.notStrictEqual(after.state, 'ACTIVE', label);
    assert.deepStrictEqual(after.identity, bound.identity, label);
    const history = tracker.exportHistory();
    const heldEvent = history.at(-1);
    assert.strictEqual(heldEvent.kind, 'RESOURCE_HELD', label);
    assert.deepStrictEqual(heldEvent.payload.decision, held, label);

    const replay = TaskResourceTracker.fromHistory({
      ownerId: 'root-A',
      runId: 'run-A',
      generation: 2,
      trustedObservationResolver: () => true,
      trustedFilesystemResolver: () => true,
      trustedHistoryResolver: () => true,
    }, history);
    const replayed = replay.snapshot().resources.find((item) => item.resourceId === resourceId);
    assert.strictEqual(replayed.state, 'HOLD', label);
    assert.deepStrictEqual(replayed.identity, bound.identity, label);
    assert.deepStrictEqual(replayed.decision, held, label);
  }

  const legacy = {
    pid: 41001,
    native_handle: 'handle-41001',
    start_time: '2026-08-29T00:00:00Z',
    exe_path_hash: hash('node.exe'),
    argv_hash: hash('legacy-resource-control-test'),
    parent_identity_hash: hash('legacy-parent'),
    nonce: 'legacy-launch-nonce',
    native_process_manager_run_id: 'legacy-native-run',
  };
  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-rebind', purpose: 'legacy rebind' });
  legacyScope.register(resource('legacy-rebind', 'process_tree'));
  legacyScope.bind('legacy-rebind', { identity: legacy, generation: 2, evidenceRefs: ['legacy-initial'] });
  assert.throws(
    () => legacyScope.bind('legacy-rebind', {
      identity: { ...legacy, pid: 41002 }, generation: 2, evidenceRefs: ['legacy-changed'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'RESOURCE_IDENTITY_DRIFT',
  );
});

test('tracker holds non-canonical rebinds after a version-2 bind without retaining rejected identities', () => {
  const cyclic = { schema: 'ProcessIdentity2', rejected_marker: 'cyclic-rejected-input' };
  cyclic.self = cyclic;
  const nullPrototype = Object.create(null);
  Object.assign(nullPrototype, {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    rejected_marker: 'null-prototype-rejected-input',
  });
  let accessorReads = 0;
  const accessor = { schema: 'ProcessIdentity2', schema_version: 2 };
  Object.defineProperty(accessor, 'rejected_marker', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'accessor-rejected-input';
    },
  });
  const nonStandardPrototype = Object.create({ inherited: true });
  Object.assign(nonStandardPrototype, {
    schema: 'ProcessIdentity2',
    schema_version: 2,
    rejected_marker: 'non-standard-prototype-rejected-input',
  });

  for (const [label, identity, rejectedMarker] of [
    ['cyclic', cyclic, 'cyclic-rejected-input'],
    ['null prototype', nullPrototype, 'null-prototype-rejected-input'],
    ['accessor', accessor, 'accessor-rejected-input'],
    ['non-standard prototype', nonStandardPrototype, 'non-standard-prototype-rejected-input'],
  ]) {
    const tracker = makeTracker();
    const scopeId = `non-canonical-versioned-${label.replace(/\s/g, '-')}`;
    const resourceId = `non-canonical-versioned-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId, purpose: 'non-canonical versioned rebind' });
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    const bound = scope.getResource(resourceId);

    let held;
    assert.doesNotThrow(() => {
      held = scope.bind(resourceId, {
        identity, generation: 2, evidenceRefs: [`${label}-rebind`],
      });
    }, label);
    assert.strictEqual(Object.isFrozen(held), true, label);
    assert.strictEqual(held.valid, false, label);
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert(held.errors.some((error) => (
      typeof error.code === 'string' && error.code !== ''
      && typeof error.path === 'string' && error.path !== ''
      && typeof error.message === 'string' && error.message !== ''
    )), label);

    const after = scope.getResource(resourceId);
    assert.strictEqual(after.state, 'HOLD', label);
    assert.deepStrictEqual(after.identity, bound.identity, label);
    const history = tracker.exportHistory();
    assert.strictEqual(history.at(-1).kind, 'RESOURCE_HELD', label);
    assert.deepStrictEqual(history.at(-1).payload.decision, held, label);
    assert.strictEqual(JSON.stringify(tracker.snapshot()).includes(rejectedMarker), false, label);
    assert.strictEqual(JSON.stringify(history).includes(rejectedMarker), false, label);
    const historyLength = history.length;
    assert.strictEqual(scope.bind(resourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    }).state, 'HOLD', label);
    assert.strictEqual(tracker.exportHistory().length, historyLength, label);

    const replay = TaskResourceTracker.fromHistory({
      ownerId: 'root-A',
      runId: 'run-A',
      generation: 2,
      trustedObservationResolver: () => true,
      trustedFilesystemResolver: () => true,
      trustedHistoryResolver: () => true,
    }, history);
    const replayed = replay.snapshot().resources.find((item) => item.resourceId === resourceId);
    assert.strictEqual(replayed.state, 'HOLD', label);
    assert.deepStrictEqual(replayed.identity, bound.identity, label);
    assert.deepStrictEqual(replayed.decision, held, label);
  }
  assert.strictEqual(accessorReads, 0);
});

test('tracker snapshots the complete bind observation before reading fields', () => {
  for (const [label, buildObservation] of [
    ['cyclic identity getter', (counts) => {
      const observation = { generation: 2, evidenceRefs: ['rejected-new-evidence'] };
      Object.defineProperty(observation, 'identity', {
        enumerable: true,
        get() {
          counts.identity += 1;
          const identity = { rejected_marker: 'outer-getter-cycle' };
          identity.self = identity;
          return identity;
        },
      });
      return observation;
    }],
    ['caller error identity getter', (counts) => {
      const observation = { generation: 2, evidenceRefs: ['rejected-new-evidence'] };
      Object.defineProperty(observation, 'identity', {
        enumerable: true,
        get() {
          counts.identity += 1;
          throw new contracts.ContractError('CALLER_CONSTRUCTED', '$.caller', 'caller message');
        },
      });
      return observation;
    }],
    ['unused extension accessor', (counts) => {
      const observation = {
        identity: windowsProcess(),
        generation: 2,
        evidenceRefs: ['rejected-new-evidence'],
      };
      Object.defineProperty(observation, 'unused_extension', {
        enumerable: true,
        get() {
          counts.extension += 1;
          return 'outer-unused-accessor';
        },
      });
      return observation;
    }],
    ['unused extension cycle', () => {
      const extension = { rejected_marker: 'outer-unused-cycle' };
      extension.self = extension;
      return {
        identity: windowsProcess(),
        generation: 2,
        evidenceRefs: ['rejected-new-evidence'],
        unused_extension: extension,
      };
    }],
  ]) {
    const counts = { identity: 0, extension: 0 };
    const tracker = makeTracker();
    const resourceId = `observation-snapshot-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId: resourceId, purpose: 'observation snapshot' });
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    assertEnvelopeHold(
      scope,
      tracker,
      resourceId,
      buildObservation(counts),
      'CANONICAL_REJECTED',
      label.includes('cycle') ? 'outer-' : 'caller message',
    );
    assert.deepStrictEqual(counts, { identity: 0, extension: 0 }, label);
    const serialized = JSON.stringify(tracker.exportHistory());
    assert.strictEqual(serialized.includes('CALLER_CONSTRUCTED'), false, label);
    assert.strictEqual(serialized.includes('caller message'), false, label);
    assert.strictEqual(serialized.includes('rejected-new-evidence'), false, label);
  }

  for (const getBehavior of ['cycle', 'throw']) {
    let getCount = 0;
    const identity = windowsProcess();
    const target = { identity, generation: 2, evidenceRefs: ['proxy-data-bind'] };
    const observation = new Proxy(target, {
      get(object, key, receiver) {
        if (key === 'identity') {
          getCount += 1;
          if (getBehavior === 'throw') throw new Error('proxy get must not run');
          const cycle = {};
          cycle.self = cycle;
          return cycle;
        }
        return Reflect.get(object, key, receiver);
      },
    });
    const tracker = makeTracker();
    const resourceId = `proxy-data-${getBehavior}`;
    const scope = tracker.openRootScope({ scopeId: resourceId, purpose: 'proxy descriptor snapshot' });
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, { identity, generation: 2, evidenceRefs: ['proxy-data-bind'] });
    const historyLength = tracker.exportHistory().length;
    const result = scope.bind(resourceId, observation);
    assert.strictEqual(result.state, 'ACTIVE');
    assert.strictEqual(getCount, 0);
    assert.strictEqual(tracker.exportHistory().length, historyLength);
  }
});

test('tracker maps malformed observation envelopes to stable v2 holds without accepting new evidence', () => {
  const cases = [
    ['missing generation', { identity: windowsProcess(), evidenceRefs: ['rejected-marker-generation'] }, 'GENERATION_INVALID'],
    ['invalid generation', { identity: windowsProcess(), generation: 0, evidenceRefs: ['rejected-marker-generation-invalid'] }, 'GENERATION_INVALID'],
    ['missing evidence', { identity: windowsProcess(), generation: 2 }, 'EVIDENCE_REFS_INVALID'],
    ['invalid evidence', { identity: windowsProcess(), generation: 2, evidenceRefs: [] }, 'EVIDENCE_REFS_INVALID'],
    ['missing identity', { generation: 2, evidenceRefs: ['rejected-marker-missing-identity'] }, 'CANONICAL_REJECTED'],
    ['scalar', 'rejected-marker-scalar', 'RESOURCE_OBSERVATION_INVALID'],
    ['null', null, 'RESOURCE_OBSERVATION_INVALID'],
    ['array', ['rejected-marker-array'], 'RESOURCE_OBSERVATION_INVALID'],
  ];
  for (const [label, observation, code] of cases) {
    const tracker = makeTracker();
    const resourceId = `envelope-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId: resourceId, purpose: 'malformed envelope' });
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    assertEnvelopeHold(scope, tracker, resourceId, observation, code, 'rejected-marker');
  }
});

test('tracker preserves controlled exception behavior without an existing v2 binding', () => {
  const canonicalFailure = {
    identity: windowsProcess(),
    generation: 2,
    evidenceRefs: ['first-canonical-failure'],
  };
  Object.defineProperty(canonicalFailure, 'unused_extension', {
    enumerable: true,
    get() {
      throw new contracts.ContractError('CALLER_CONSTRUCTED', '$.caller', 'caller message');
    },
  });
  const cases = [
    ['omitted', undefined, ResourceTrackerError, 'GENERATION_INVALID'],
    ['invalid generation', { identity: windowsProcess(), generation: 0, evidenceRefs: ['first-generation'] }, ResourceTrackerError, 'GENERATION_INVALID'],
    ['missing evidence', { identity: windowsProcess(), generation: 2 }, ResourceTrackerError, 'EVIDENCE_REFS_INVALID'],
    ['missing identity', { generation: 2, evidenceRefs: ['first-missing-identity'] }, contracts.ContractError, 'CANONICAL_REJECTED'],
    ['canonical failure', canonicalFailure, contracts.ContractError, 'CANONICAL_REJECTED'],
    ['scalar', 'first-scalar', ResourceTrackerError, 'RESOURCE_OBSERVATION_INVALID'],
  ];
  for (const [label, observation, ErrorType, code] of cases) {
    const tracker = makeTracker();
    const resourceId = `first-envelope-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId: resourceId, purpose: 'first malformed envelope' });
    scope.register(resource(resourceId, 'process_tree'));
    const before = tracker.exportHistory();
    assert.throws(
      () => scope.bind(resourceId, observation),
      (error) => error instanceof ErrorType
        && error.code === code
        && (code !== 'CANONICAL_REJECTED'
          || (error.path === '$.observation'
            && error.message === 'bind observation rejected by canonical JSON contract')),
      label,
    );
    assert.strictEqual(scope.getResource(resourceId).state, 'DECLARED', label);
    assert.deepStrictEqual(tracker.exportHistory(), before, label);
  }

  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'legacy-envelope', purpose: 'legacy envelope' });
  scope.register(resource('legacy-envelope', 'process_tree'));
  scope.bind('legacy-envelope', {
    identity: legacyProcess({ owner_id: 'root-A', platform: 'windows' }),
    generation: 2,
    evidenceRefs: ['legacy-envelope-initial'],
  });
  const before = scope.getResource('legacy-envelope');
  const history = tracker.exportHistory();
  assert.throws(
    () => scope.bind('legacy-envelope', { generation: 2, evidenceRefs: ['legacy-rejected'] }),
    (error) => error instanceof contracts.ContractError && error.code === 'CANONICAL_REJECTED',
  );
  assert.deepStrictEqual(scope.getResource('legacy-envelope'), before);
  assert.deepStrictEqual(tracker.exportHistory(), history);
});

test('tracker propagates hold capacity failure and preserves the active checkpoint', () => {
  const tracker = new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    limits: { maxHistoryEvents: 3 },
  });
  const scope = tracker.openRootScope({ scopeId: 'capacity-envelope', purpose: 'capacity envelope' });
  scope.register(resource('capacity-envelope', 'process_tree'));
  scope.bind('capacity-envelope', {
    identity: windowsProcess(), generation: 2, evidenceRefs: ['capacity-initial'],
  });
  const before = scope.getResource('capacity-envelope');
  const history = tracker.exportHistory();
  assert.throws(
    () => scope.bind('capacity-envelope', {
      generation: 2,
      evidenceRefs: ['capacity-rejected'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'TRACKER_HISTORY_LIMIT_REACHED',
  );
  assert.deepStrictEqual(scope.getResource('capacity-envelope'), before);
  assert.deepStrictEqual(tracker.exportHistory(), history);
});

test('tracker preserves complete legacy process identities with overlapping version-2 metadata', () => {
  for (const [label, overrides] of [
    ['owner id', { owner_id: 'root-A' }],
    ['platform', { platform: 'windows' }],
    ['owner id and platform', { owner_id: 'root-A', platform: 'windows' }],
  ]) {
    const identity = legacyProcess(overrides);
    assert.strictEqual(stateMachines.validateProcessIdentity(identity).valid, true, label);
    const tracker = makeTracker();
    const scopeId = `legacy-overlap-${label.replace(/\s/g, '-')}`;
    const resourceId = `legacy-overlap-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId, purpose: 'legacy metadata compatibility' });
    scope.register(resource(resourceId, 'process_tree'));
    assert.strictEqual(scope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-initial`],
    }).state, 'ACTIVE', label);
    assert.throws(
      () => scope.bind(resourceId, {
        identity: { ...identity, pid: identity.pid + 1 }, generation: 2, evidenceRefs: [`${label}-changed`],
      }),
      (error) => error instanceof ResourceTrackerError && error.code === 'RESOURCE_IDENTITY_DRIFT',
      label,
    );
  }
});

for (const [label, identity] of [
  ['empty object', {}],
  ['null', null],
  ['array', []],
]) {
  test(`tracker holds malformed ${label} rebinds after a version-2 bind`, () => {
    const tracker = makeTracker();
    const scopeId = `malformed-versioned-${label.replace(/\s/g, '-')}`;
    const resourceId = `malformed-versioned-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId, purpose: 'malformed versioned rebind' });
    scope.register(resource(resourceId, 'process_tree'));
    scope.bind(resourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    const bound = scope.getResource(resourceId);

    const held = scope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-rebind`],
    });
    assert.strictEqual(held.valid, false, label);
    assert.strictEqual(held.disposition, 'HOLD', label);
    assert.strictEqual(held.action_authorized, false, label);
    assert(Array.isArray(held.errors) && held.errors.length > 0, label);

    const after = scope.getResource(resourceId);
    assert.notStrictEqual(after.state, 'ACTIVE', label);
    assert.deepStrictEqual(after.identity, bound.identity, label);
    const history = tracker.exportHistory();
    const heldEvent = history.at(-1);
    assert.strictEqual(heldEvent.kind, 'RESOURCE_HELD', label);
    assert.deepStrictEqual(heldEvent.payload.decision, held, label);

    const replay = TaskResourceTracker.fromHistory({
      ownerId: 'root-A',
      runId: 'run-A',
      generation: 2,
      trustedObservationResolver: () => true,
      trustedFilesystemResolver: () => true,
      trustedHistoryResolver: () => true,
    }, history);
    const replayed = replay.snapshot().resources.find((item) => item.resourceId === resourceId);
    assert.strictEqual(replayed.state, 'HOLD', label);
    assert.deepStrictEqual(replayed.identity, bound.identity, label);
    assert.deepStrictEqual(replayed.decision, held, label);
  });
}

test('tracker classifies complete resource-specific v2 intent without narrowing legacy process validation', () => {
  const tracker = makeTracker();
  const scope = tracker.openRootScope({ scopeId: 'v2-bound-v1-rebind', purpose: 'classification' });
  scope.register(resource('v2-bound-v1-rebind', 'process_tree'));
  scope.bind('v2-bound-v1-rebind', {
    identity: windowsProcess(), generation: 2, evidenceRefs: ['v2-initial'],
  });
  const bound = scope.getResource('v2-bound-v1-rebind');
  const held = scope.bind('v2-bound-v1-rebind', {
    identity: legacyProcess(), generation: 2, evidenceRefs: ['pure-v1-rebind'],
  });
  assert.strictEqual(held.valid, false);
  assert.strictEqual(held.disposition, 'HOLD');
  assert.strictEqual(held.action_authorized, false);
  assert(held.errors.length > 0);
  const after = scope.getResource('v2-bound-v1-rebind');
  assert.strictEqual(after.state, 'HOLD');
  assert.deepStrictEqual(after.identity, bound.identity);
  const history = tracker.exportHistory();
  assert.strictEqual(history.at(-1).kind, 'RESOURCE_HELD');
  assert.deepStrictEqual(history.at(-1).payload.decision, held);
  const replay = TaskResourceTracker.fromHistory({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    trustedHistoryResolver: () => true,
  }, history);
  const replayed = replay.snapshot().resources.find((item) => item.resourceId === 'v2-bound-v1-rebind');
  assert.strictEqual(replayed.state, 'HOLD');
  assert.deepStrictEqual(replayed.identity, bound.identity);
  assert.deepStrictEqual(replayed.decision, held);

  for (const [label, identity] of [
    ['windows identity only', { windows_identity: windowsProcess().windows_identity }],
    ['process hash only', { executable_path_sha256: windowsProcess().executable_path_sha256 }],
  ]) {
    const firstTracker = makeTracker();
    const firstScope = firstTracker.openRootScope({ scopeId: `first-${label.replace(/\s/g, '-')}`, purpose: 'classification' });
    const firstResourceId = `first-${label.replace(/\s/g, '-')}`;
    firstScope.register(resource(firstResourceId, 'process_tree'));
    const firstHold = firstScope.bind(firstResourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-first`],
    });
    assert.strictEqual(firstHold.disposition, 'HOLD', `${label} first bind`);
    assert.strictEqual(firstHold.action_authorized, false, `${label} first bind`);

    const rebindTracker = makeTracker();
    const rebindScope = rebindTracker.openRootScope({ scopeId: `rebind-${label.replace(/\s/g, '-')}`, purpose: 'classification' });
    const rebindResourceId = `rebind-${label.replace(/\s/g, '-')}`;
    rebindScope.register(resource(rebindResourceId, 'process_tree'));
    rebindScope.bind(rebindResourceId, {
      identity: windowsProcess(), generation: 2, evidenceRefs: [`${label}-initial`],
    });
    const rebindHold = rebindScope.bind(rebindResourceId, {
      identity, generation: 2, evidenceRefs: [`${label}-rebind`],
    });
    assert.strictEqual(rebindHold.disposition, 'HOLD', `${label} rebind`);
    assert.strictEqual(rebindHold.action_authorized, false, `${label} rebind`);
  }

  for (const [resourceType, identity] of [
    ['agent_session', { process_identity: windowsProcess() }],
    ['temporary_allocation', { quota: { unit: 'bytes', limit: 1 } }],
  ]) {
    const strictTracker = makeTracker();
    const strictScope = strictTracker.openRootScope({ scopeId: `exclusive-${resourceType}`, purpose: 'classification' });
    const resourceId = `exclusive-${resourceType}`;
    strictScope.register(resource(resourceId, resourceType));
    const strictHold = strictScope.bind(resourceId, {
      identity, generation: 2, evidenceRefs: [`exclusive-${resourceType}`],
    });
    assert.strictEqual(strictHold.disposition, 'HOLD', resourceType);
    assert.strictEqual(strictHold.action_authorized, false, resourceType);
  }

  const legacyTracker = makeTracker();
  const legacyScope = legacyTracker.openRootScope({ scopeId: 'legacy-observation-id', purpose: 'legacy compatibility' });
  legacyScope.register(resource('legacy-observation-id', 'process_tree'));
  const legacy = legacyProcess({ observation_id: 'harmless-observation' });
  assert.strictEqual(legacyScope.bind('legacy-observation-id', {
    identity: legacy, generation: 2, evidenceRefs: ['legacy-extra-first'],
  }).state, 'ACTIVE');
  assert.throws(
    () => legacyScope.bind('legacy-observation-id', {
      identity: { ...legacy, pid: 41002 }, generation: 2, evidenceRefs: ['legacy-extra-rebind'],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'RESOURCE_IDENTITY_DRIFT',
  );
});

test('tracker holds versioned generation, nonce, and confirmed parent identity drift', () => {
  const processTracker = makeTracker();
  const processScope = processTracker.openRootScope({ scopeId: 'process-drift', purpose: 'drift' });
  processScope.register(resource('process-drift', 'process_tree'));
  processScope.bind('process-drift', { identity: windowsProcess(), generation: 2, evidenceRefs: ['process-bind'] });
  const processHold = processScope.bind('process-drift', {
    identity: windowsProcess({ adapter_generation: 3 }), generation: 2, evidenceRefs: ['generation-drift'],
  });
  assert.strictEqual(processHold.disposition, 'HOLD');
  assert.strictEqual(processHold.action_authorized, false);

  const nonceTracker = makeTracker();
  const nonceScope = nonceTracker.openRootScope({ scopeId: 'nonce-drift', purpose: 'drift' });
  nonceScope.register(resource('nonce-drift', 'agent_session'));
  nonceScope.bind('nonce-drift', { identity: harnessSession(), generation: 2, evidenceRefs: ['nonce-bind'] });
  const nonceHold = nonceScope.bind('nonce-drift', {
    identity: harnessSession('agent_session', { launch_nonce: 'changed-nonce' }), generation: 2, evidenceRefs: ['nonce-drift'],
  });
  assert.strictEqual(nonceHold.disposition, 'HOLD');
  assert.strictEqual(nonceHold.action_authorized, false);

  const parentTracker = makeTracker();
  const parentScope = parentTracker.openRootScope({ scopeId: 'parent-drift', purpose: 'drift' });
  parentScope.register(resource('parent-drift', 'temporary_allocation'));
  parentScope.bind('parent-drift', { identity: temporaryAllocation(), generation: 2, evidenceRefs: ['parent-bind'] });
  const changedParent = temporaryAllocation();
  changedParent.confirmed_parent_directory.linux_file_identity.inode += 1;
  const parentHold = parentScope.bind('parent-drift', {
    identity: changedParent, generation: 2, evidenceRefs: ['parent-drift'],
  });
  assert.strictEqual(parentHold.disposition, 'HOLD');
  assert.strictEqual(parentHold.action_authorized, false);
});

test('recovery records reject prompt, reply, command output, and credential material', () => {
  const valid = {
    schema: 'RecoveryRecord2',
    schema_version: 2,
    resource_id: 'process-A',
    resource_type: 'process_tree',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    identity: windowsProcess(),
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z',
      observation_ref: opaqueRef('observation', 'host-observation-A'),
      identity_ref: opaqueRef('identity', 'process-A'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'cleanup-authority-A'),
    teardown_condition: 'identity_absence_verified',
    evidence_refs: [opaqueRef('evidence', 'host-observation-A')],
  };
  assert.strictEqual(contracts.validateRecoveryRecord2(valid).valid, true);

  for (const [field, value] of [
    ['user_prompt', 'delete everything'],
    ['model_reply', 'done'],
    ['command_output', 'stdout text'],
    ['api_key', 'key-value'],
    ['access_token', 'token-value'],
    ['credential', 'credential-value'],
    ['secret', 'secret-value'],
  ]) {
    const result = contracts.validateRecoveryRecord2({ ...clone(valid), [field]: value });
    assert.strictEqual(result.valid, false, field);
    assert.strictEqual(result.disposition, 'HOLD', field);
    assert.strictEqual(result.action_authorized, false, field);
    assert(result.errors.some((error) => error.code === 'RECOVERY_SENSITIVE_CONTENT'), field);
  }
  const sensitiveValue = clone(valid);
  sensitiveValue.evidence_refs = ['access_token=do-not-store'];
  assert.strictEqual(contracts.validateRecoveryRecord2(sensitiveValue).valid, false);

  for (const nakedSecret of [
    'sk-proj-1234567890abcdef',
    'ghp_1234567890abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    'bareCredentialValue123456',
  ]) {
    const exposed = clone(valid);
    exposed.evidence_refs = [nakedSecret];
    assert.strictEqual(contracts.validateRecoveryRecord2(exposed).valid, false, nakedSecret);
  }
});

test('recovery records bind phase, observation, resource type, and outer task identity', () => {
  const identities = [
    ['process_tree', windowsProcess()],
    ['command_session', windowsProcess()],
    ['agent_session', harnessSession('agent_session')],
    ['runtime_thread', harnessSession('runtime_thread')],
    ['temporary_allocation', temporaryAllocation()],
  ];
  const base = {
    schema: 'RecoveryRecord2', schema_version: 2, resource_id: 'resource-A', resource_type: 'process_tree',
    run_id: 'run-A', session_id: 'session-A', lease_generation: 2, identity: windowsProcess(),
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z', observation_ref: opaqueRef('observation', 'obs-A'),
      identity_ref: opaqueRef('identity', 'identity-A'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'authority-A'),
    teardown_condition: 'identity_absence_verified', evidence_refs: [opaqueRef('evidence', 'evidence-A')],
  };
  for (const [resourceType, identity] of identities) {
    const record = {
      ...clone(base),
      resource_type: resourceType,
      run_id: identity.run_id,
      session_id: identity.session_id,
      lease_generation: identity.lease_generation,
      identity: clone(identity),
    };
    assert.strictEqual(contracts.validateRecoveryRecord2(record).valid, true, resourceType);
    const wrongType = { ...clone(record), resource_type: resourceType === 'agent_session' ? 'process_tree' : 'agent_session' };
    assert.strictEqual(contracts.validateRecoveryRecord2(wrongType).valid, false, `${resourceType} cross type`);
    for (const field of ['run_id', 'session_id', 'lease_generation']) {
      const mismatch = clone(record);
      mismatch[field] = field === 'lease_generation' ? 3 : `other-${field}`;
      const result = contracts.validateRecoveryRecord2(mismatch);
      assert.strictEqual(result.valid, false, `${resourceType} ${field}`);
      assert(result.errors.some((error) => error.code === 'RECOVERY_IDENTITY_BINDING_MISMATCH'));
    }
  }
  for (const field of ['current_phase', 'last_valid_observation']) {
    const missing = clone(base);
    delete missing[field];
    assert.strictEqual(contracts.validateRecoveryRecord2(missing).valid, false, field);
  }
});

test('support matrices require opaque evidence references without changing state aggregation', () => {
  const validEvidenceRef = 'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const full = {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'windows-local-A',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      process_identity: { state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef] },
    },
  };
  const fullResult = contracts.validateSupportMatrix2(full);
  assert.strictEqual(fullResult.valid, true);
  assert.strictEqual(fullResult.effective_state, 'VERIFIED_FULL');

  for (const evidenceRef of [
    'NOT_RUN: process termination was not executed',
    'skipped by platform gate',
    'evidence:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'observation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
    'prefix evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa suffix',
    42,
  ]) {
    const invalidEvidence = clone(full);
    invalidEvidence.claims.process_identity.evidence_refs = [evidenceRef];
    const invalidEvidenceResult = contracts.validateSupportMatrix2(invalidEvidence);
    assert.strictEqual(invalidEvidenceResult.valid, false, String(evidenceRef));
    assert.strictEqual(invalidEvidenceResult.effective_state, 'UNVERIFIED', String(evidenceRef));
    assert.strictEqual(invalidEvidenceResult.action_authorized, false, String(evidenceRef));
  }

  const duplicateEvidence = clone(full);
  duplicateEvidence.claims.process_identity.evidence_refs = [validEvidenceRef, validEvidenceRef];
  const duplicateEvidenceResult = contracts.validateSupportMatrix2(duplicateEvidence);
  assert.strictEqual(duplicateEvidenceResult.valid, false);
  assert.strictEqual(duplicateEvidenceResult.effective_state, 'UNVERIFIED');

  const skippedAsFull = clone(full);
  skippedAsFull.claims.process_tree_terminate = { state: 'NOT_RUN', evidence_refs: [] };
  const skippedResult = contracts.validateSupportMatrix2(skippedAsFull);
  assert.strictEqual(skippedResult.valid, false);
  assert.strictEqual(skippedResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(skippedResult.action_authorized, false);
  assert(skippedResult.errors.some((error) => error.code === 'SUPPORT_FULL_WITH_INCOMPLETE_CLAIM'));

  const skipped = clone(full);
  skipped.overall_state = 'NOT_RUN';
  skipped.claims = { process_tree_terminate: { state: 'NOT_RUN', evidence_refs: [] } };
  assert.strictEqual(contracts.validateSupportMatrix2(skipped).valid, true);

  const uncontrolled = clone(full);
  uncontrolled.overall_state = 'SKIPPED';
  assert(contracts.validateSupportMatrix2(uncontrolled).errors
    .some((error) => error.code === 'SUPPORT_STATE_INVALID'));

  const incompleteNotRun = clone(skipped);
  delete incompleteNotRun.claims.process_tree_terminate.evidence_refs;
  const incompleteResult = contracts.validateSupportMatrix2(incompleteNotRun);
  assert.strictEqual(incompleteResult.valid, false);
  assert.strictEqual(incompleteResult.disposition, 'HOLD');
  assert.strictEqual(incompleteResult.action_authorized, false);

  const emptyFullEvidence = clone(full);
  emptyFullEvidence.claims.process_identity.evidence_refs = [];
  const emptyFullResult = contracts.validateSupportMatrix2(emptyFullEvidence);
  assert.strictEqual(emptyFullResult.valid, false);
  assert.strictEqual(emptyFullResult.effective_state, 'UNVERIFIED');

  const notRunEvidence = clone(skipped);
  notRunEvidence.claims.process_tree_terminate.evidence_refs = [validEvidenceRef];
  const notRunEvidenceResult = contracts.validateSupportMatrix2(notRunEvidence);
  assert.strictEqual(notRunEvidenceResult.valid, false);
  assert.strictEqual(notRunEvidenceResult.effective_state, 'UNVERIFIED');

  const legacyArray = {
    ...clone(full),
    claims: [
      { capability_id: 'process_identity', state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef] },
      { capability_id: 'process_tree_terminate', state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef] },
    ],
  };
  const legacyArrayResult = contracts.validateSupportMatrix2(legacyArray);
  assert.strictEqual(legacyArrayResult.valid, false);
  assert.strictEqual(legacyArrayResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(legacyArrayResult.action_authorized, false);

  const distinctCapabilities = clone(full);
  distinctCapabilities.claims.process_tree_terminate = {
    state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef],
  };
  const distinctCapabilitiesResult = contracts.validateSupportMatrix2(distinctCapabilities);
  assert.strictEqual(distinctCapabilitiesResult.valid, true);
  assert.strictEqual(distinctCapabilitiesResult.effective_state, 'VERIFIED_FULL');

  const invalidKey = clone(full);
  invalidKey.claims.constructor = { state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef] };
  const invalidKeyResult = contracts.validateSupportMatrix2(invalidKey);
  assert.strictEqual(invalidKeyResult.valid, false);
  assert.strictEqual(invalidKeyResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(invalidKeyResult.action_authorized, false);
});

test('schema contracts encode the same critical identity, recovery, and support rules', () => {
  const processSchema = loadSchema('ProcessIdentity2.schema.json');
  for (const field of ['owner_id', 'run_id', 'session_id', 'lease_generation', 'adapter_generation', 'manager_generation']) {
    assert(processSchema.$defs.common.required.includes(field), field);
  }
  const harnessSchema = loadSchema('HarnessSessionIdentity2.schema.json');
  for (const field of ['launch_nonce', 'adapter_generation']) assert(harnessSchema.required.includes(field), field);
  assert(Array.isArray(harnessSchema.oneOf) && harnessSchema.oneOf.length === 2);
  const temporarySchema = loadSchema('TemporaryAllocationIdentity2.schema.json');
  for (const field of ['task_directory', 'confirmed_parent_directory', 'quota', 'creation_nonce']) {
    assert(temporarySchema.$defs.common.required.includes(field), field);
  }
  const recoverySchema = loadSchema('RecoveryRecord2.schema.json');
  assert(recoverySchema.required.includes('current_phase'));
  assert(recoverySchema.required.includes('last_valid_observation'));
  assert(Array.isArray(recoverySchema.allOf) && recoverySchema.allOf.length === 5);
  const supportSchema = loadSchema('SupportMatrix2.schema.json');
  assert(Array.isArray(supportSchema.allOf) && supportSchema.allOf.length >= 2);
  assert.strictEqual(supportSchema.properties.claims.type, 'object');
  assert.strictEqual(supportSchema.properties.claims.minProperties, 1);
  assert.strictEqual(typeof supportSchema.properties.claims.propertyNames, 'object');
  assert.strictEqual(supportSchema.properties.claims['x-uniqueBy'], undefined);

  const validEvidenceRef = 'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const supportFixture = {
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'windows-local-A',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      process_identity: { state: 'VERIFIED_FULL', evidence_refs: [validEvidenceRef] },
    },
  };
  const schemaFixtures = [
    supportFixture,
    ...[
      'NOT_RUN: process termination was not executed',
      'skipped by platform gate',
      'evidence:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'observation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      'prefix evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa suffix',
      42,
    ].map((evidenceRef) => {
      const fixture = clone(supportFixture);
      fixture.claims.process_identity.evidence_refs = [evidenceRef];
      return fixture;
    }),
  ];
  const schemaResults = validateDraft202012Fixtures(supportSchema, schemaFixtures);
  assert.deepStrictEqual(schemaResults, [true, false, false, false, false, false, false, false, false]);
  assert.deepStrictEqual(
    schemaFixtures.map((fixture) => contracts.validateSupportMatrix2(fixture).valid),
    schemaResults,
  );
});

test('schema scalar constraints match the bounded runtime identity validators', () => {
  const schemas = Object.fromEntries(schemaBundle.map((schema) => [schema.title, schema]));
  const safeInteger = 9007199254740991;
  const sha = 'a'.repeat(64);
  const supportMatrix = () => ({
    schema: 'SupportMatrix2', schema_version: 2, adapter_id: 'windows-local-A', platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z', overall_state: 'VERIFIED_FULL',
    claims: { process_identity: { state: 'VERIFIED_FULL', evidence_refs: [`evidence:${sha}`] } },
  });
  const recoveryRecord = () => ({
    schema: 'RecoveryRecord2', schema_version: 2, resource_id: 'resource-A', resource_type: 'process_tree',
    run_id: 'run-A', session_id: 'session-A', lease_generation: 2, identity: windowsProcess(),
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z', observation_ref: `observation:${sha}`, identity_ref: `identity:${sha}`,
    },
    cleanup_authority_ref: `authority:${sha}`, teardown_condition: 'identity_absence_verified', evidence_refs: [`evidence:${sha}`],
  });
  const assertParity = (label, schema, runtimeValidator, fixtures, expected) => {
    assert.deepStrictEqual(fixtures.map((fixture) => runtimeValidator(fixture).valid), expected, `${label} runtime`);
    assert.deepStrictEqual(validateDraft202012Fixtures(schema, fixtures), expected, `${label} schema`);
  };

  const externalHarness = harnessSession('agent_session', { process_identity: windowsProcess() });
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.HarnessSessionIdentity2, [externalHarness]), [true]);
  const externalRecovery = recoveryRecord();
  externalRecovery.resource_type = 'agent_session';
  externalRecovery.identity = externalHarness;
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.RecoveryRecord2, [externalRecovery]), [true]);

  const temporaryAllocationRecovery = recoveryRecord();
  temporaryAllocationRecovery.resource_type = 'temporary_allocation';
  temporaryAllocationRecovery.identity = temporaryAllocation();
  const incompleteTemporaryAllocationRecovery = clone(temporaryAllocationRecovery);
  delete incompleteTemporaryAllocationRecovery.identity.task_directory;
  assertParity(
    'temporary allocation recovery identity',
    schemas.RecoveryRecord2,
    contracts.validateRecoveryRecord2,
    [temporaryAllocationRecovery, incompleteTemporaryAllocationRecovery],
    [true, false],
  );

  const trimmedStringValues = [
    ['ASCII whitespace', ' \t\n', false],
    ['NBSP', '\u00a0', false],
    ['BOM', '\ufeff', false],
    ['non-whitespace control', '\u0000', true],
    ['ordinary text', 'value', true],
  ];
  const stringTargets = [
    ['process owner', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => windowsProcess({ owner_id: value })],
    ['harness session', schemas.HarnessSessionIdentity2, contracts.validateHarnessSessionIdentity2, (value) => harnessSession('agent_session', { session_id: value })],
    ['temporary allocation', schemas.TemporaryAllocationIdentity2, contracts.validateTemporaryAllocationIdentity2, (value) => temporaryAllocation({ allocation_id: value })],
    ['recovery resource', schemas.RecoveryRecord2, contracts.validateRecoveryRecord2, (value) => ({ ...recoveryRecord(), resource_id: value })],
    ['support adapter', schemas.SupportMatrix2, contracts.validateSupportMatrix2, (value) => ({ ...supportMatrix(), adapter_id: value })],
  ];
  for (const [target, schema, validator, fixtureFor] of stringTargets) {
    assertParity(`${target} JS trim strings`, schema, validator, trimmedStringValues.map(([, value]) => fixtureFor(value)), trimmedStringValues.map(([, , valid]) => valid));
  }

  const positiveSafeIntegerValues = [
    ['one', 1, true], ['maximum safe integer', safeInteger, true], ['first unsafe integer', safeInteger + 1, false],
    ['zero', 0, false], ['negative', -1, false], ['fractional', 1.5, false],
  ];
  const positiveIntegerTargets = [
    ['process pid', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => windowsProcess({ pid: value })],
    ['process generation', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => windowsProcess({ lease_generation: value })],
    ['Linux process ticks', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => linuxProcess({ linux_identity: { proc_start_ticks: value, boot_id_sha256: sha } })],
    ['harness generation', schemas.HarnessSessionIdentity2, contracts.validateHarnessSessionIdentity2, (value) => harnessSession('agent_session', { lease_generation: value })],
    ['temporary generation', schemas.TemporaryAllocationIdentity2, contracts.validateTemporaryAllocationIdentity2, (value) => temporaryAllocation({ lease_generation: value })],
    ['temporary quota', schemas.TemporaryAllocationIdentity2, contracts.validateTemporaryAllocationIdentity2, (value) => ({ ...temporaryAllocation(), quota: { unit: 'bytes', limit: value } })],
    ['temporary inode', schemas.TemporaryAllocationIdentity2, contracts.validateTemporaryAllocationIdentity2, (value) => ({ ...temporaryAllocation(), linux_file_identity: { device_id: 'dev-2049', inode: value } })],
    ['recovery generation', schemas.RecoveryRecord2, contracts.validateRecoveryRecord2, (value) => {
      const record = recoveryRecord();
      record.lease_generation = value;
      record.identity.lease_generation = value;
      return record;
    }],
  ];
  for (const [target, schema, validator, fixtureFor] of positiveIntegerTargets) {
    assertParity(`${target} safe integer boundaries`, schema, validator, positiveSafeIntegerValues.map(([, value]) => fixtureFor(value)), positiveSafeIntegerValues.map(([, , valid]) => valid));
  }

  const exactShaValues = [
    ['exact lowercase SHA-256', sha, true], ['short SHA-256', sha.slice(1), false], ['long SHA-256', `${sha}a`, false],
    ['uppercase SHA-256', sha.toUpperCase(), false], ['terminal LF', `${sha}\n`, false], ['terminal CR', `${sha}\r`, false],
    ['terminal line separator', `${sha}\u2028`, false], ['terminal paragraph separator', `${sha}\u2029`, false],
    ['surrounding text', `prefix${sha}suffix`, false],
  ];
  assertParity('process SHA-256', schemas.ProcessIdentity2, contracts.validateProcessIdentity2,
    exactShaValues.map(([, value]) => windowsProcess({ executable_path_sha256: value })), exactShaValues.map(([, , valid]) => valid));
  assertParity('temporary manifest SHA-256', schemas.TemporaryAllocationIdentity2, contracts.validateTemporaryAllocationIdentity2,
    exactShaValues.map(([, value]) => temporaryAllocation({ manifest_sha256: value })), exactShaValues.map(([, , valid]) => valid));

  const referenceTargets = [
    ['observation reference', 'observation', 'evidence', (record, value) => { record.last_valid_observation.observation_ref = value; }],
    ['identity reference', 'identity', 'evidence', (record, value) => { record.last_valid_observation.identity_ref = value; }],
    ['authority reference', 'authority', 'evidence', (record, value) => { record.cleanup_authority_ref = value; }],
    ['evidence reference', 'evidence', 'authority', (record, value) => { record.evidence_refs = [value]; }],
  ];
  for (const [target, prefix, wrongPrefix, setReference] of referenceTargets) {
    const referenceValues = [
      [`${prefix} exact`, `${prefix}:${sha}`, true], [`${prefix} short`, `${prefix}:${sha.slice(1)}`, false],
      [`${prefix} uppercase`, `${prefix}:${sha.toUpperCase()}`, false], ['wrong typed prefix', `${wrongPrefix}:${sha}`, false],
      ['terminal LF', `${prefix}:${sha}\n`, false], ['terminal CR', `${prefix}:${sha}\r`, false],
      ['terminal line separator', `${prefix}:${sha}\u2028`, false], ['terminal paragraph separator', `${prefix}:${sha}\u2029`, false],
      ['surrounding text', `prefix ${prefix}:${sha} suffix`, false],
    ];
    assertParity(target, schemas.RecoveryRecord2, contracts.validateRecoveryRecord2, referenceValues.map(([, value]) => {
      const record = recoveryRecord(); setReference(record, value); return record;
    }), referenceValues.map(([, , valid]) => valid));
  }

  const filetimeValues = [
    ['decimal', '134167428000000000', true], ['empty', '', false], ['letters', '12x', false],
    ['terminal LF', '123\n', false], ['terminal CR', '123\r', false], ['terminal line separator', '123\u2028', false], ['terminal paragraph separator', '123\u2029', false],
  ];
  assertParity('Windows FILETIME', schemas.ProcessIdentity2, contracts.validateProcessIdentity2,
    filetimeValues.map(([, value]) => windowsProcess({ windows_identity: { process_creation_time_filetime: value, process_handle: '0x1' } })), filetimeValues.map(([, , valid]) => valid));

  const capabilityValues = [
    ['valid', 'process_tree_terminate', true], ['letter first', 'A1_', true], ['numeric first', '1process', false], ['dash', 'process-tree', false],
    ['constructor', 'constructor', false], ['prototype', 'prototype', false], ['terminal LF', 'process_tree\n', false], ['terminal CR', 'process_tree\r', false],
    ['terminal line separator', 'process_tree\u2028', false], ['terminal paragraph separator', 'process_tree\u2029', false],
  ];
  assertParity('support capability IDs', schemas.SupportMatrix2, contracts.validateSupportMatrix2, capabilityValues.map(([, capability]) => {
    const matrix = supportMatrix(); matrix.claims = {}; matrix.claims[capability] = { state: 'VERIFIED_FULL', evidence_refs: [`evidence:${sha}`] }; return matrix;
  }), capabilityValues.map(([, , valid]) => valid));

  const timestampValues = [
    ['UTC seconds', '2026-08-30T02:00:00Z', true], ['UTC fractional seconds', '2026-08-30T02:00:00.123Z', true],
    ['offset forbidden', '2026-08-30T02:00:00+00:00', false], ['missing seconds', '2026-08-30T02:00Z', false],
    ['terminal LF', '2026-08-30T02:00:00Z\n', false], ['terminal CR', '2026-08-30T02:00:00Z\r', false],
    ['terminal line separator', '2026-08-30T02:00:00Z\u2028', false], ['terminal paragraph separator', '2026-08-30T02:00:00Z\u2029', false],
  ];
  const timestampTargets = [
    ['process start_time', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => windowsProcess({ start_time: value })],
    ['recovery observed_at', schemas.RecoveryRecord2, contracts.validateRecoveryRecord2, (value) => ({ ...recoveryRecord(), last_valid_observation: { observed_at: value, observation_ref: `observation:${sha}`, identity_ref: `identity:${sha}` } })],
    ['support observed_at', schemas.SupportMatrix2, contracts.validateSupportMatrix2, (value) => ({ ...supportMatrix(), observed_at: value })],
  ];
  for (const [target, schema, validator, fixtureFor] of timestampTargets) {
    assertParity(`${target} lexical UTC`, schema, validator, timestampValues.map(([, value]) => fixtureFor(value)), timestampValues.map(([, , valid]) => valid));
  }

  const terminalEvidence = supportMatrix();
  terminalEvidence.claims.process_identity.evidence_refs = [`evidence:${sha}\n`];
  const terminalEvidenceResult = contracts.validateSupportMatrix2(terminalEvidence);
  assert.strictEqual(terminalEvidenceResult.valid, false);
  assert(terminalEvidenceResult.errors.some((item) => item.code === 'SUPPORT_EVIDENCE_REFERENCE_INVALID'));
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.SupportMatrix2, [terminalEvidence]), [false]);
});

test('version-2 factories own schema fields and reject legacy identity input', () => {
  const processFields = windowsProcess();
  delete processFields.schema;
  delete processFields.schema_version;
  const createdProcess = contracts.createResourceIdentity2('process_tree', processFields);
  assert.strictEqual(createdProcess.schema, 'ProcessIdentity2');
  assert.strictEqual(createdProcess.schema_version, 2);
  assert(Object.isFrozen(createdProcess));

  const harnessFields = harnessSession();
  delete harnessFields.schema;
  delete harnessFields.schema_version;
  delete harnessFields.harness_kind;
  assert.strictEqual(contracts.createResourceIdentity2('agent_session', harnessFields).schema_version, 2);

  const recoveryFields = {
    resource_id: 'process-A', resource_type: 'process_tree', run_id: 'run-A', session_id: 'session-A',
    lease_generation: 2, identity: createdProcess, current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T01:30:00Z', observation_ref: opaqueRef('observation', 'factory-observation'),
      identity_ref: opaqueRef('identity', 'factory-identity'),
    },
    cleanup_authority_ref: opaqueRef('authority', 'factory-authority'),
    teardown_condition: 'identity_absence_verified', evidence_refs: [opaqueRef('evidence', 'factory-evidence')],
  };
  assert.strictEqual(contracts.createRecoveryRecord2(recoveryFields).schema_version, 2);
  assert.throws(() => contracts.createResourceIdentity2('process_tree', {
    pid: 1, native_handle: 'legacy', start_time: '2026-08-30T01:00:00Z',
    exe_path_hash: hash('legacy'), argv_hash: hash('legacy'), parent_identity_hash: hash('legacy'),
    nonce: 'legacy', native_process_manager_run_id: 'legacy',
  }), /IDENTITY_V2_BUILD_REJECTED/);
  assert.throws(() => contracts.createRecoveryRecord2({ ...recoveryFields, identity: {
    pid: 1, native_handle: 'legacy', start_time: '2026-08-30T01:00:00Z',
    exe_path_hash: hash('legacy'), argv_hash: hash('legacy'), parent_identity_hash: hash('legacy'),
    nonce: 'legacy', native_process_manager_run_id: 'legacy',
  } }), /RECOVERY_V2_BUILD_REJECTED/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failed > 0) process.exitCode = 1;
else process.stdout.write(`${tests.length} identity/support v2 tests passed.\n`);
