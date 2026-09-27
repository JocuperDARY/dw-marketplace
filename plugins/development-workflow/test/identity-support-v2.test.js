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
const {
  computeDetachedSha256,
  createDetachedJsonSnapshot,
} = require('../skills/dw-collaboration/scripts/lib/canonical-json');

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
const compatibilityPythonErrorCodes = [
  'PYTHON_SCHEMA_DEPENDENCY_MISSING',
  'PYTHON_SCHEMA_VERSION_UNSUPPORTED',
  'PYTHON_SCHEMA_API_MISSING',
  'PYTHON_SCHEMA_MALFORMED_OUTPUT',
];

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
    const override = process.env.DW_SCHEMA_PYTHON;
    return { override: true, candidates: override === '' ? [] : [pythonDescriptor(override)] };
  }
  return {
    override: false,
    candidates: process.platform === 'win32'
      ? [pythonDescriptor('py', ['-3']), pythonDescriptor('python'), pythonDescriptor('python3')]
      : [pythonDescriptor('python3'), pythonDescriptor('python')],
  };
}

function pythonError(code, message, descriptor = null, remediation = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.descriptor = descriptor;
  if (remediation) error.remediation = remediation;
  return error;
}

function descriptorDisplay(descriptor) {
  return [descriptor.executable, ...descriptor.prefixArgs].map((part) => JSON.stringify(part)).join(' ');
}

function installCommand(descriptor) {
  const remediation = {
    executable: descriptor.executable,
    args: [...descriptor.prefixArgs, '-m', 'pip', 'install', '-r', schemaRequirementsPath],
  };
  return `executable ${JSON.stringify(remediation.executable)} with arguments ${remediation.args.map((arg) => JSON.stringify(arg)).join(' ')}`;
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

function runPython(descriptor, args, input, stage, diagnosticDescriptor = descriptor) {
  const result = childProcess.spawnSync(descriptor.executable, [...descriptor.prefixArgs, ...args], {
    encoding: 'utf8',
    input,
    shell: false,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  return classifyPythonSpawn(result, diagnosticDescriptor, stage);
}

function parsePythonJson(stdout, descriptor, stage) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', `${stage} did not produce JSON: ${error.message}`, descriptor);
  }
}

function selectPythonResolutionError(probes) {
  let firstExecutedError = null;
  for (const probe of probes) {
    if (!probe.executed) continue;
    firstExecutedError ??= probe.error;
  }
  for (const code of compatibilityPythonErrorCodes) {
    for (const probe of probes) {
      if (probe.executed && probe.error?.code === code) return probe.error;
    }
  }
  return firstExecutedError
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

const pythonMetadataProbe = [
  'import json',
  'from importlib.metadata import PackageNotFoundError, version',
  'try:',
  '    jsonschema_version = version("jsonschema")',
  '    referencing_version = version("referencing")',
  'except PackageNotFoundError as error:',
  '    print(json.dumps({"kind": "missing_dependency", "package": getattr(error, "name", str(error))}))',
  '    raise SystemExit(0)',
  'print(json.dumps({"kind": "compatible", "jsonschema": jsonschema_version, "referencing": referencing_version}))',
].join('\n');

const pythonExternalRefBehaviorProbe = [
  'import json',
  'try:',
  '    from jsonschema import Draft202012Validator',
  '    from referencing import Registry, Resource',
  '    resource = Resource.from_contents({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:dw:python-probe:integer", "type": "integer"})',
  '    registry = Registry().with_resource("urn:dw:python-probe:integer", resource)',
  '    validator = Draft202012Validator({"$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": "urn:dw:python-probe:integer"}, registry=registry)',
  '    print(json.dumps({"kind": "external_ref_behavior", "external_ref_valid": validator.is_valid(7), "external_ref_invalid": validator.is_valid("not-an-integer")}))',
  'except Exception as error:',
  '    print(json.dumps({"kind": "missing_api", "detail": f"{type(error).__name__}: {error}"}))',
].join('\n');

function dependencyRemediation(descriptor) {
  return {
    executable: descriptor.executable,
    args: [...descriptor.prefixArgs, '-m', 'pip', 'install', '-r', schemaRequirementsPath],
  };
}

function probePythonDescriptor(descriptor, prefixArgs = []) {
  const probeDescriptor = pythonDescriptor(descriptor.executable, [...descriptor.prefixArgs, ...prefixArgs]);
  const execution = runPython(
    probeDescriptor,
    ['-X', 'utf8', '-c', pythonMetadataProbe],
    undefined,
    'Python compatibility metadata probe',
    descriptor,
  );
  if (execution.error) return execution;
  let probe;
  try {
    probe = JSON.parse(execution.result.stdout);
  } catch (error) {
    return {
      executed: true,
      error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', `Python compatibility metadata probe did not produce JSON: ${error.message}`, descriptor),
    };
  }
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility metadata probe returned a non-object', descriptor) };
  }
  if (probe.kind === 'missing_dependency') {
    if (typeof probe.package !== 'string' || probe.package.length === 0) {
      return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility metadata probe payload lacks a valid package field', descriptor) };
    }
    return {
      executed: true,
      error: pythonError(
        'PYTHON_SCHEMA_DEPENDENCY_MISSING',
        `Python compatibility metadata probe is missing ${String(probe.package)}; install dependencies using ${installCommand(descriptor)}`,
        descriptor,
        dependencyRemediation(descriptor),
      ),
    };
  }
  if (probe.kind !== 'compatible' || typeof probe.jsonschema !== 'string' || typeof probe.referencing !== 'string') {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility metadata probe returned an unrecognized payload', descriptor) };
  }
  if (!stableVersionInRange(probe.jsonschema, '4.18.0', '5.0.0')
    || !stableVersionInRange(probe.referencing, '0.28.4', '1.0.0')) {
    return {
      executed: true,
      error: pythonError(
        'PYTHON_SCHEMA_VERSION_UNSUPPORTED',
        `Python compatibility metadata probe requires jsonschema >=4.18.0,<5.0.0 and referencing >=0.28.4,<1.0.0; received jsonschema=${probe.jsonschema}, referencing=${probe.referencing}`,
        descriptor,
      ),
    };
  }
  const behaviorExecution = runPython(
    probeDescriptor,
    ['-X', 'utf8', '-c', pythonExternalRefBehaviorProbe],
    undefined,
    'Python compatibility API behavior probe',
    descriptor,
  );
  if (behaviorExecution.error) return behaviorExecution;
  let behavior;
  try {
    behavior = JSON.parse(behaviorExecution.result.stdout);
  } catch (error) {
    return {
      executed: true,
      error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', `Python compatibility API behavior probe did not produce JSON: ${error.message}`, descriptor),
    };
  }
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility API behavior probe returned a non-object', descriptor) };
  }
  if (behavior.kind === 'missing_api') {
    if (typeof behavior.detail !== 'string' || behavior.detail.length === 0) {
      return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility API behavior probe payload lacks a valid detail field', descriptor) };
    }
    return { executed: true, error: pythonError('PYTHON_SCHEMA_API_MISSING', `Python compatibility API behavior probe is incompatible: ${String(behavior.detail)}`, descriptor) };
  }
  if (behavior.kind !== 'external_ref_behavior'
    || behavior.external_ref_valid !== true
    || behavior.external_ref_invalid !== false) {
    return { executed: true, error: pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'Python compatibility API behavior probe returned an unrecognized payload', descriptor) };
  }
  return { executed: true, descriptor };
}

function resolveCompatiblePythonDescriptor({ bypassCache = false } = {}) {
  const cacheKey = pythonDiscoveryKey();
  if (!bypassCache && compatiblePythonDescriptors.has(cacheKey)) return compatiblePythonDescriptors.get(cacheKey);

  const { override, candidates } = pythonCandidates();
  if (override && candidates.length === 0) {
    throw pythonError('PYTHON_SCHEMA_NO_INTERPRETER', 'DW_SCHEMA_PYTHON is set to an empty executable and will not fall back');
  }
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

test('Python resolution ranks API failures above malformed output and process failures', () => {
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
    apiMissing,
  );
});

test('unsupported metadata stops before the dependency API probe', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalOverrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  const originalOverride = process.env.DW_SCHEMA_PYTHON;
  const originalCacheEntries = [...compatiblePythonDescriptors.entries()];
  const calls = [];
  try {
    process.env.DW_SCHEMA_PYTHON = 'metadata-python';
    compatiblePythonDescriptors.clear();
    childProcess.spawnSync = (executable, args, options) => {
      calls.push({ executable, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'compatible', jsonschema: '5.0.0', referencing: '0.28.4' }),
        stderr: '',
        signal: null,
      };
    };

    assert.throws(
      () => resolveCompatiblePythonDescriptor(),
      (error) => error.code === 'PYTHON_SCHEMA_VERSION_UNSUPPORTED',
    );
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].executable, 'metadata-python');
    assert.deepStrictEqual(calls[0].args.slice(0, 3), ['-X', 'utf8', '-c']);
    assert.deepStrictEqual(calls[0].options, {
      encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
    });
    assert.strictEqual(calls[0].args[3].includes('from jsonschema'), false);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    compatiblePythonDescriptors.clear();
    for (const [key, value] of originalCacheEntries) compatiblePythonDescriptors.set(key, value);
    if (originalOverrideIsSet) process.env.DW_SCHEMA_PYTHON = originalOverride;
    else delete process.env.DW_SCHEMA_PYTHON;
  }
});

test('compatible metadata without external-ref behavior evidence is rejected', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];
  try {
    childProcess.spawnSync = (executable, args, options) => {
      calls.push({ executable, args, options });
      assert.strictEqual(executable, 'evidence-python');
      assert.deepStrictEqual(args.slice(0, 3), ['-X', 'utf8', '-c']);
      assert.deepStrictEqual(options, {
        encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
      });
      if (calls.length === 1) {
        return {
          status: 0,
          stdout: JSON.stringify({ kind: 'compatible', jsonschema: '4.18.0', referencing: '0.28.4' }),
          stderr: '',
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'external_ref_behavior', external_ref_valid: 'true', external_ref_invalid: false }),
        stderr: '',
        signal: null,
      };
    };

    const probe = probePythonDescriptor(pythonDescriptor('evidence-python'));
    assert.strictEqual(probe.executed, true);
    assert(probe.error);
    assert.strictEqual(probe.error.code, 'PYTHON_SCHEMA_MALFORMED_OUTPUT');
    assert.strictEqual(calls.length, 2);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
});

test('Python resolution ranks actionable failures before candidate order', () => {
  const processFailure = pythonError('PYTHON_SCHEMA_PROCESS_FAILURE', 'ordinary process failure');
  const malformedOutput = pythonError('PYTHON_SCHEMA_MALFORMED_OUTPUT', 'malformed output');
  const apiMissingFirst = pythonError('PYTHON_SCHEMA_API_MISSING', 'first API failure');
  const apiMissingSecond = pythonError('PYTHON_SCHEMA_API_MISSING', 'second API failure');
  const versionUnsupported = pythonError('PYTHON_SCHEMA_VERSION_UNSUPPORTED', 'unsupported version');
  const dependencyMissing = pythonError('PYTHON_SCHEMA_DEPENDENCY_MISSING', 'missing dependency');

  assert.strictEqual(
    selectPythonResolutionError([
      { executed: true, error: processFailure },
      { executed: true, error: malformedOutput },
      { executed: true, error: apiMissingFirst },
      { executed: true, error: versionUnsupported },
      { executed: true, error: dependencyMissing },
    ]),
    dependencyMissing,
  );
  assert.strictEqual(
    selectPythonResolutionError([
      { executed: true, error: apiMissingFirst },
      { executed: true, error: apiMissingSecond },
    ]),
    apiMissingFirst,
  );
});

test('isolated probe errors retain the base descriptor for remediation', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalOverrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  const originalOverride = process.env.DW_SCHEMA_PYTHON;
  const originalCacheEntries = [...compatiblePythonDescriptors.entries()];
  const calls = [];
  try {
    process.env.DW_SCHEMA_PYTHON = 'base-python';
    compatiblePythonDescriptors.clear();
    childProcess.spawnSync = (executable, args, options) => {
      calls.push({ executable, args, options });
      assert.strictEqual(executable, 'base-python');
      assert.deepStrictEqual(options, {
        encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
      });
      if (args.includes('-I') && args.includes('-S')) {
        return {
          status: 0,
          stdout: JSON.stringify({ kind: 'missing_dependency', package: 'referencing' }),
          stderr: '',
          signal: null,
        };
      }
      if (calls.filter((call) => !call.args.includes('-I') && !call.args.includes('-S')).length === 1) {
        return {
          status: 0,
          stdout: JSON.stringify({ kind: 'compatible', jsonschema: '4.18.0', referencing: '0.28.4' }),
          stderr: '',
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'external_ref_behavior', external_ref_valid: true, external_ref_invalid: false }),
        stderr: '',
        signal: null,
      };
    };

    let captured;
    assert.throws(
      () => validateDraft202012Fixtures(loadSchema('SupportMatrix2.schema.json'), [], { isolatedDependencyProbe: true }),
      (error) => {
        captured = error;
        return error.code === 'PYTHON_SCHEMA_DEPENDENCY_MISSING';
      },
    );
    assert.deepStrictEqual(captured.descriptor, pythonDescriptor('base-python'));
    assert.deepStrictEqual(captured.remediation, {
      executable: 'base-python', args: ['-m', 'pip', 'install', '-r', schemaRequirementsPath],
    });
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls.filter((call) => call.args.includes('-I') && call.args.includes('-S')).length, 1);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    compatiblePythonDescriptors.clear();
    for (const [key, value] of originalCacheEntries) compatiblePythonDescriptors.set(key, value);
    if (originalOverrideIsSet) process.env.DW_SCHEMA_PYTHON = originalOverride;
    else delete process.env.DW_SCHEMA_PYTHON;
  }
});

test('dependency remediation is structured and describes executable and arguments separately', () => {
  const originalSpawnSync = childProcess.spawnSync;
  try {
    childProcess.spawnSync = (executable, args, options) => {
      assert.strictEqual(executable, 'remediation-python');
      assert.deepStrictEqual(args.slice(0, 3), ['-X', 'utf8', '-c']);
      assert.deepStrictEqual(options, {
        encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
      });
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'missing_dependency', package: 'jsonschema' }),
        stderr: '',
        signal: null,
      };
    };

    const probe = probePythonDescriptor(pythonDescriptor('remediation-python'));
    assert(probe.error);
    assert.strictEqual(probe.error.code, 'PYTHON_SCHEMA_DEPENDENCY_MISSING');
    assert.deepStrictEqual(probe.error.remediation, {
      executable: 'remediation-python', args: ['-m', 'pip', 'install', '-r', schemaRequirementsPath],
    });
    assert.match(probe.error.message, /executable/i);
    assert.match(probe.error.message, /arguments/i);
    assert.strictEqual(probe.error.message.includes('remediation-python -m pip install'), false);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
});

test('candidate discovery skips malformed output and selects the later behavior-proven interpreter', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalOverrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  const originalOverride = process.env.DW_SCHEMA_PYTHON;
  const originalCacheEntries = [...compatiblePythonDescriptors.entries()];
  const calls = [];
  const expectedCandidates = process.platform === 'win32'
    ? [
      { executable: 'py', prefixArgs: ['-3'] },
      { executable: 'python', prefixArgs: [] },
      { executable: 'python', prefixArgs: [] },
    ]
    : [
      { executable: 'python3', prefixArgs: [] },
      { executable: 'python', prefixArgs: [] },
      { executable: 'python', prefixArgs: [] },
    ];
  try {
    delete process.env.DW_SCHEMA_PYTHON;
    compatiblePythonDescriptors.clear();
    childProcess.spawnSync = (executable, args, options) => {
      calls.push({ executable, args, options });
      const expectedCandidate = expectedCandidates[calls.length - 1];
      assert(expectedCandidate, 'candidate discovery made an unexpected extra probe');
      assert.strictEqual(executable, expectedCandidate.executable);
      assert.deepStrictEqual(args.slice(0, expectedCandidate.prefixArgs.length), expectedCandidate.prefixArgs);
      assert.deepStrictEqual(
        args.slice(expectedCandidate.prefixArgs.length, expectedCandidate.prefixArgs.length + 3),
        ['-X', 'utf8', '-c'],
      );
      assert.deepStrictEqual(options, {
        encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
      });
      if (calls.length === 1) {
        return { status: 0, stdout: 'not JSON', stderr: '', signal: null };
      }
      if (calls.length === 2) {
        return {
          status: 0,
          stdout: JSON.stringify({ kind: 'compatible', jsonschema: '4.18.0', referencing: '0.28.4' }),
          stderr: '',
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'external_ref_behavior', external_ref_valid: true, external_ref_invalid: false }),
        stderr: '',
        signal: null,
      };
    };

    assert.deepStrictEqual(resolveCompatiblePythonDescriptor(), pythonDescriptor('python'));
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(calls.map((call) => ({
      executable: call.executable,
      prefixArgs: call.args.slice(0, expectedCandidates[calls.indexOf(call)].prefixArgs.length),
    })), expectedCandidates);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    compatiblePythonDescriptors.clear();
    for (const [key, value] of originalCacheEntries) compatiblePythonDescriptors.set(key, value);
    if (originalOverrideIsSet) process.env.DW_SCHEMA_PYTHON = originalOverride;
    else delete process.env.DW_SCHEMA_PYTHON;
  }
});

test('bypass discovery begins empty while the following ordinary discovery owns its cache', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalOverrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  const originalOverride = process.env.DW_SCHEMA_PYTHON;
  const originalCacheEntries = [...compatiblePythonDescriptors.entries()];
  const calls = [];
  try {
    process.env.DW_SCHEMA_PYTHON = 'cache-python';
    compatiblePythonDescriptors.clear();
    childProcess.spawnSync = (executable, args, options) => {
      calls.push({ executable, args, options });
      assert.strictEqual(executable, 'cache-python');
      assert.deepStrictEqual(args.slice(0, 3), ['-X', 'utf8', '-c']);
      assert.deepStrictEqual(options, {
        encoding: 'utf8', input: undefined, shell: false, timeout: 10000, maxBuffer: 65536, windowsHide: true,
      });
      if (calls.length === 1 || calls.length === 3) {
        return {
          status: 0,
          stdout: JSON.stringify({ kind: 'compatible', jsonschema: '4.18.0', referencing: '0.28.4' }),
          stderr: '',
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ kind: 'external_ref_behavior', external_ref_valid: true, external_ref_invalid: false }),
        stderr: '',
        signal: null,
      };
    };

    assert.deepStrictEqual(resolveCompatiblePythonDescriptor({ bypassCache: true }), pythonDescriptor('cache-python'));
    assert.deepStrictEqual(resolveCompatiblePythonDescriptor(), pythonDescriptor('cache-python'));
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(resolveCompatiblePythonDescriptor(), pythonDescriptor('cache-python'));
    assert.strictEqual(calls.length, 4);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    compatiblePythonDescriptors.clear();
    for (const [key, value] of originalCacheEntries) compatiblePythonDescriptors.set(key, value);
    if (originalOverrideIsSet) process.env.DW_SCHEMA_PYTHON = originalOverride;
    else delete process.env.DW_SCHEMA_PYTHON;
  }
});

test('an empty DW_SCHEMA_PYTHON override remains authoritative and returns a stable schema error', () => {
  const originalOverrideIsSet = Object.hasOwn(process.env, 'DW_SCHEMA_PYTHON');
  const originalOverride = process.env.DW_SCHEMA_PYTHON;
  const originalCacheEntries = [...compatiblePythonDescriptors.entries()];
  try {
    process.env.DW_SCHEMA_PYTHON = '';
    compatiblePythonDescriptors.clear();
    assert.throws(
      () => resolveCompatiblePythonDescriptor(),
      (error) => error.code === 'PYTHON_SCHEMA_NO_INTERPRETER'
        && !/The "file" argument must be of type string/.test(error.message),
    );
  } finally {
    compatiblePythonDescriptors.clear();
    for (const [key, value] of originalCacheEntries) compatiblePythonDescriptors.set(key, value);
    if (originalOverrideIsSet) process.env.DW_SCHEMA_PYTHON = originalOverride;
    else delete process.env.DW_SCHEMA_PYTHON;
  }
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
      process_group_id: 41003,
      os_session_id: 41003,
      executable_device_id: 'dev-2049',
      executable_inode: 889902,
    },
    ...overrides,
  };
}

function harnessSession(kind = 'agent_session', overrides = {}) {
  return {
    schema: 'HarnessSessionIdentity2',
    schema_version: 2,
    harness: 'codex',
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

function completeLinuxProcess2(overrides = {}) {
  const { linux_identity: linuxIdentityOverrides = {}, ...identityOverrides } = overrides;
  const identity = linuxProcess(identityOverrides);
  return {
    ...identity,
    linux_identity: {
      ...identity.linux_identity,
      process_group_id: 41003,
      os_session_id: 41003,
      executable_device_id: 'dev-2049',
      executable_inode: 889902,
      ...linuxIdentityOverrides,
    },
  };
}

function completeHarnessSession2(kind = 'agent_session', overrides = {}) {
  const { harness: _ignoredHarness, ...identityOverrides } = overrides;
  return { ...harnessSession(kind, identityOverrides), harness: 'codex' };
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

const canonicalSnapshotHash = (value) => computeDetachedSha256(createDetachedJsonSnapshot(value).snapshot);

function stageAPolicyReceipt(policyId, kind, values) {
  const receipt = {
    policy_id: policyId,
    kind,
    source_kind: 'synthetic_test_fixture',
    observed_at: '2026-08-30T02:00:00Z',
    values,
    evidence_refs: [`${policyId}-evidence`],
    source_sha256: '0'.repeat(64),
  };
  const preimage = clone(receipt);
  delete preimage.source_sha256;
  receipt.source_sha256 = canonicalSnapshotHash(preimage);
  return receipt;
}

function stageATemporaryManifest(overrides = {}) {
  const canonicalRoot = overrides.canonical_root_identity?.canonical_path ?? '/tmp/dw/run-A';
  const childPath = overrides.child_path ?? `${canonicalRoot}/task-A`;
  const childId = overrides.child_id ?? 'child-A';
  const manifest = {
    owner_id: 'root-A',
    run_id: 'run-A',
    session_id: 'session-A',
    lease_generation: 2,
    canonical_root_identity: {
      canonical_path: canonicalRoot,
      path_identity_hash: hash(`${canonicalRoot}:identity`),
      parent_identity_hash: hash(`${canonicalRoot}:parent`),
      platform: 'linux',
    },
    created_at: '2026-08-30T02:00:00Z',
    quota_profile_ref: 'stage-a-quota',
    watermark_policy_ref: 'stage-a-watermark',
    child_sublease_map: {
      [childId]: {
        owner_id: childId,
        canonical_descendant: childPath,
        nonce: 'stage-a-child-nonce',
        lease_generation: 2,
        soft_quota: 64,
        hard_quota: 128,
        teardown_condition: 'task_complete',
      },
    },
    retention_set: [],
    state: 'ACTIVE',
    manifest_sha256: '0'.repeat(64),
    ...overrides,
  };
  manifest.manifest_sha256 = contracts.computeTemporaryManifestSha256(manifest);
  return manifest;
}

function completeTemporaryAllocation2(manifest, overrides = {}) {
  const { canonical_root_identity: _ignoredCanonicalRootIdentity, child_sublease: _ignoredChildSublease, ...identityOverrides } = overrides;
  const childId = identityOverrides.child_id ?? 'child-A';
  const childSublease = manifest.child_sublease_map[childId];
  const taskDirectoryPath = identityOverrides.task_directory?.path ?? childSublease.canonical_descendant;
  return temporaryAllocation({
    owner_id: manifest.owner_id,
    run_id: manifest.run_id,
    session_id: manifest.session_id,
    lease_generation: manifest.lease_generation,
    child_id: childId,
    manifest_sha256: manifest.manifest_sha256,
    canonical_root: manifest.canonical_root_identity.canonical_path,
    task_directory: {
      path: taskDirectoryPath,
      linux_file_identity: { device_id: 'dev-2049', inode: 889901 },
    },
    confirmed_parent_directory: {
      path: manifest.canonical_root_identity.canonical_path,
      linux_file_identity: { device_id: 'dev-2049', inode: 889900 },
    },
    linux_file_identity: { device_id: 'dev-2049', inode: 889900 },
    creation_nonce: childSublease.nonce,
    ...identityOverrides,
  });
}

function stageATemporaryObservation(manifest, childId = 'child-A') {
  const child = manifest.child_sublease_map[childId];
  return {
    owner_id: manifest.owner_id,
    run_id: manifest.run_id,
    session_id: manifest.session_id,
    lease_generation: manifest.lease_generation,
    canonical_root_identity: clone(manifest.canonical_root_identity),
    child_path: child.canonical_descendant,
    usage: 32,
    available: 200,
    ttl_expired: true,
    active_handles: 0,
    quiescent: true,
    identity_observed: true,
    reparse_boundary: false,
    path_rebound: false,
    retention_set_sealed: true,
    retention_set_hash: canonicalSnapshotHash(manifest.retention_set),
    teardown_condition_met: true,
    precheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
    postcheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
  };
}

function stageATemporaryFixture() {
  const manifest = stageATemporaryManifest();
  return {
    manifest,
    identity: completeTemporaryAllocation2(manifest),
    observation: stageATemporaryObservation(manifest),
    policyIndex: {
      'stage-a-quota': stageAPolicyReceipt('stage-a-quota', 'quota', { soft_quota: 64, hard_quota: 128, unit: 'bytes' }),
      'stage-a-watermark': stageAPolicyReceipt('stage-a-watermark', 'watermark', { low_watermark: 100, critical_watermark: 50, unit: 'bytes_available' }),
    },
  };
}

function makeStageATemporaryTracker() {
  return new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: ({ purpose }) => purpose === 'temporary_reclaim' || purpose === 'temporary_absence',
    trustedFilesystemResolver: ({ purpose }) => purpose === 'temporary_reclaim',
  });
}

function completeRecoveryRecord2(resourceType, identity) {
  return {
    schema: 'RecoveryRecord2',
    schema_version: 2,
    resource_id: `stage-a-${resourceType}`,
    resource_type: resourceType,
    run_id: identity.run_id,
    session_id: identity.session_id,
    lease_generation: identity.lease_generation,
    identity,
    current_phase: { phase: 'cleanup', state: 'ACTIVE' },
    last_valid_observation: {
      observed_at: '2026-08-30T02:00:00Z',
      observation_ref: opaqueRef('observation', `stage-a-${resourceType}`),
      identity_ref: opaqueRef('identity', `stage-a-${resourceType}`),
    },
    cleanup_authority_ref: opaqueRef('authority', `stage-a-${resourceType}`),
    teardown_condition: resourceType === 'temporary_allocation'
      ? 'allocation_absence_verified'
      : ['agent_session', 'runtime_thread'].includes(resourceType)
        ? 'harness_closed'
        : 'identity_absence_verified',
    evidence_refs: [opaqueRef('evidence', `stage-a-${resourceType}`)],
  };
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

test('tracker contains rejected v2 bind evidence while preserving HOLD action through public projections', () => {
  for (const [label, prebind] of [
    ['first bind', false],
    ['rebind', true],
  ]) {
    const tracker = makeTracker();
    const resourceId = `contained-v2-${label.replace(/\s/g, '-')}`;
    const rejectedEvidence = `rejected-v2-evidence-${label.replace(/\s/g, '-')}`;
    const scope = tracker.openRootScope({ scopeId: resourceId, purpose: 'contained invalid v2 bind' });
    scope.register(resource(resourceId, 'process_tree'));
    if (prebind) {
      scope.bind(resourceId, {
        identity: windowsProcess(), generation: 2, evidenceRefs: [`${resourceId}-initial`],
      });
    }
    const invalidIdentity = windowsProcess();
    delete invalidIdentity.launch_nonce;
    const held = scope.bind(resourceId, {
      identity: invalidIdentity, generation: 2, evidenceRefs: [rejectedEvidence],
    });

    assert.strictEqual(held.action, 'HOLD', label);
    assert.strictEqual(held.disposition, 'HOLD', label);
    const resourceAfterBind = scope.getResource(resourceId);
    assert.strictEqual(resourceAfterBind.state, 'HOLD', label);
    assert.deepStrictEqual(resourceAfterBind.decision, held, label);
    assert.strictEqual(resourceAfterBind.evidenceRefs.includes(rejectedEvidence), false, label);

    const close = scope.close('invalid v2 bind evidence containment');
    assert.strictEqual(close.status, 'HOLD', label);
    assert.deepStrictEqual(close.decisions, [{
      resourceId,
      action: 'HOLD',
      releaseConfirmed: false,
    }], label);

    const snapshot = tracker.snapshot();
    const history = tracker.exportHistory();
    const ledger = tracker.exportLedgerProjection();
    const heldEvent = history.findLast((event) => event.kind === 'RESOURCE_HELD');
    assert.deepStrictEqual(heldEvent.payload.evidenceRefs, [], label);
    assert.deepStrictEqual(heldEvent.payload.decision, held, label);
    assert.strictEqual(ledger.hints.find((hint) => hint.trackerEventKind === 'RESOURCE_HELD').decisionAction, 'HOLD', label);
    for (const projection of [snapshot, history, ledger]) {
      assert.strictEqual(JSON.stringify(projection).includes(rejectedEvidence), false, label);
    }

    const replayed = replayTracker(history);
    const replayedSnapshot = replayed.snapshot();
    const replayedResource = replayedSnapshot.resources.find((item) => item.resourceId === resourceId);
    assert.strictEqual(replayedResource.state, 'HOLD', label);
    assert.deepStrictEqual(replayedResource.decision, held, label);
    assert.strictEqual(JSON.stringify(replayedSnapshot).includes(rejectedEvidence), false, label);
  }

  const inputLimitedTracker = new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    limits: { maxInputBytes: 1024 },
  });
  const inputLimitedScope = inputLimitedTracker.openRootScope({
    scopeId: 'contained-v2-input-limit',
    purpose: 'contained invalid v2 bind input limit',
  });
  inputLimitedScope.register(resource('contained-v2-input-limit', 'process_tree'));
  const oversizedInvalidIdentity = windowsProcess();
  delete oversizedInvalidIdentity.launch_nonce;
  assert.throws(
    () => inputLimitedScope.bind('contained-v2-input-limit', {
      identity: oversizedInvalidIdentity,
      generation: 2,
      evidenceRefs: [`rejected-v2-input-${'x'.repeat(2048)}`],
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'TRACKER_INPUT_LIMIT_REACHED',
  );

  const duplicateInputLimitedTracker = new TaskResourceTracker({
    ownerId: 'root-A',
    runId: 'run-A',
    generation: 2,
    trustedObservationResolver: () => true,
    trustedFilesystemResolver: () => true,
    limits: { maxInputBytes: 1024 },
  });
  const duplicateInputLimitedScope = duplicateInputLimitedTracker.openRootScope({
    scopeId: 'contained-v2-duplicate-input-limit',
    purpose: 'contained invalid v2 duplicate bind input limit',
  });
  duplicateInputLimitedScope.register(resource('contained-v2-duplicate-input-limit', 'process_tree'));
  const duplicateInvalidIdentity = windowsProcess();
  delete duplicateInvalidIdentity.launch_nonce;
  const duplicateEvidenceRef = 'rejected-v2-duplicate-input';
  const duplicateEvidenceRefs = Array.from({ length: 64 }, () => duplicateEvidenceRef);
  assert(duplicateEvidenceRefs.length > Array.from(new Set(duplicateEvidenceRefs)).length);
  assert.throws(
    () => duplicateInputLimitedScope.bind('contained-v2-duplicate-input-limit', {
      identity: duplicateInvalidIdentity,
      generation: 2,
      evidenceRefs: duplicateEvidenceRefs,
    }),
    (error) => error instanceof ResourceTrackerError && error.code === 'TRACKER_INPUT_LIMIT_REACHED',
  );
});

test('tracker enforces maxInputBytes on complete canonical bind observations before HOLD', () => {
  const acceptedOversizedInputs = [];
  const cases = [
    {
      label: 'invalid identity body',
      resourceId: 'oversized-invalid-v2-identity',
      prebind: false,
      observation() {
        const identity = windowsProcess();
        delete identity.launch_nonce;
        identity.rejected_padding = 'x'.repeat(8192);
        return { identity, generation: 2, evidenceRefs: ['oversized-invalid-v2-identity'] };
      },
    },
    {
      label: 'missing identity envelope',
      resourceId: 'oversized-missing-v2-identity',
      prebind: true,
      observation() {
        return {
          generation: 2,
          evidenceRefs: ['oversized-missing-v2-identity'],
          rejected_padding: 'x'.repeat(8192),
        };
      },
    },
  ];

  for (const scenario of cases) {
    const tracker = new TaskResourceTracker({
      ownerId: 'root-A',
      runId: 'run-A',
      generation: 2,
      trustedObservationResolver: () => true,
      trustedFilesystemResolver: () => true,
      limits: { maxInputBytes: 4096 },
    });
    const scope = tracker.openRootScope({
      scopeId: scenario.resourceId,
      purpose: 'complete bind observation input limit',
    });
    scope.register(resource(scenario.resourceId, 'process_tree'));
    if (scenario.prebind) {
      scope.bind(scenario.resourceId, {
        identity: windowsProcess(), generation: 2, evidenceRefs: [`${scenario.resourceId}-initial`],
      });
    }
    try {
      scope.bind(scenario.resourceId, scenario.observation());
      acceptedOversizedInputs.push(scenario.label);
    } catch (error) {
      assert(error instanceof ResourceTrackerError, scenario.label);
      assert.strictEqual(error.code, 'TRACKER_INPUT_LIMIT_REACHED', scenario.label);
    }
  }

  assert.deepStrictEqual(acceptedOversizedInputs, []);
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
      teardown_condition: resourceType === 'temporary_allocation'
        ? 'allocation_absence_verified'
        : ['agent_session', 'runtime_thread'].includes(resourceType)
          ? 'harness_closed'
          : 'identity_absence_verified',
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

test('support matrix errors redact untrusted capability IDs before returning diagnostics', () => {
  const secret = 'sk-proj-1234567890abcdef';
  const matrixFor = (capabilityId, claim = {
    state: 'VERIFIED_FULL',
    evidence_refs: ['evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  }) => ({
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'windows-local-A',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: 'VERIFIED_FULL',
    claims: {
      [capabilityId]: claim,
    },
  });

  for (const capabilityId of [
    'constructor',
    'prototype',
    'line\nbreak',
    `api_key_${secret}`,
  ]) {
    const checked = contracts.validateSupportMatrix2(matrixFor(capabilityId));
    assert.strictEqual(checked.valid, false, capabilityId);
    assert(checked.errors.some((item) => (
      item.code === 'SUPPORT_CAPABILITY_INVALID'
        && item.path === '$.claims.<redacted-key>'
    )), capabilityId);
    const serializedErrors = JSON.stringify(checked.errors);
    assert.strictEqual(serializedErrors.includes(capabilityId), false, capabilityId);
    assert.strictEqual(serializedErrors.includes(secret), false, capabilityId);
  }

  const longCapabilityId = 'x'.repeat(65);
  const longCapability = contracts.validateSupportMatrix2(matrixFor(longCapabilityId, {
    state: 'UNKNOWN',
    evidence_refs: ['evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  }));
  assert.strictEqual(longCapability.errors.some((item) => item.code === 'SUPPORT_CAPABILITY_INVALID'), false);
  assert(longCapability.errors.some((item) => (
    item.code === 'SUPPORT_STATE_INVALID'
      && item.path === '$.claims.<redacted-key>.state'
  )));
  assert.strictEqual(JSON.stringify(longCapability.errors).includes(longCapabilityId), false);

  const validCapability = contracts.validateSupportMatrix2(matrixFor('process_identity', {
    state: 'UNKNOWN',
    evidence_refs: ['evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  }));
  assert(validCapability.errors.some((item) => (
    item.code === 'SUPPORT_STATE_INVALID'
      && item.path === '$.claims.process_identity.state'
  )));
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
  externalRecovery.teardown_condition = 'harness_closed';
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.RecoveryRecord2, [externalRecovery]), [true]);

  const temporaryAllocationRecovery = recoveryRecord();
  temporaryAllocationRecovery.resource_type = 'temporary_allocation';
  temporaryAllocationRecovery.identity = temporaryAllocation();
  temporaryAllocationRecovery.teardown_condition = 'allocation_absence_verified';
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
    ['Linux process ticks', schemas.ProcessIdentity2, contracts.validateProcessIdentity2, (value) => linuxProcess({ linux_identity: { ...linuxProcess().linux_identity, proc_start_ticks: value } })],
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

test('stage A v2 process recovery compares complete Windows and Linux identities without native handles', () => {
  const decisionFor = (identity, observed, extras = {}) => contracts.decideProcessRecovery2({
      duplicate_run_lock: false,
      owner_status: 'owned',
      expected_identity: identity,
      observed_identity: observed,
      expected_generation: 2,
      observed_generation: 2,
      expected_scope: { kind: 'scope', value: 'root' },
      observed_scope: { kind: 'scope', value: 'root' },
      graceful: { requested: true, exit_observed: false, deadline_reached: true },
      exact_tree_termination_supported: true,
      ...extras,
  });
  const schemas = Object.fromEntries(schemaBundle.map((schema) => [schema.title, schema]));
  const assertProcessSchemaValid = (identity, label) => {
    assert.strictEqual(contracts.validateProcessIdentity2(identity).valid, true, `${label} runtime`);
    assert.deepStrictEqual(validateDraft202012Fixtures(schemas.ProcessIdentity2, [identity]), [true], `${label} schema`);
  };

  const windows = windowsProcess();
  const linux = completeLinuxProcess2();
  for (const [label, expected, observed] of [
    ['Windows exact', windows, clone(windows)],
    ['Linux exact', linux, clone(linux)],
  ]) {
    assertProcessSchemaValid(expected, `${label} expected`);
    assertProcessSchemaValid(observed, `${label} observed`);
    assert.strictEqual(Object.hasOwn(expected, 'native_handle'), false, `${label} input`);
    assert.strictEqual(Object.hasOwn(observed, 'native_handle'), false, `${label} observation`);
    assert.strictEqual(Object.hasOwn(expected.windows_identity || {}, 'process_handle'), expected.platform === 'windows', label);
    const result = decisionFor(expected, observed);
    assert.strictEqual(result.action, 'TERMINATE_EXACT_TREE', label);
    assert.strictEqual(result.identity_confidence, 'MATCH', label);
    assert.strictEqual(result.action_authorized, false, label);
    assert.strictEqual(Object.hasOwn(result, 'native_handle'), false, `${label} result`);
  }

  const substitutions = (platform) => [
    ['owner_id', 'root-B'], ['run_id', 'run-B'], ['session_id', 'session-B'],
    ['lease_generation', 3], ['adapter_generation', 3], ['manager_generation', 8], ['pid', 41004],
    ['start_time', '2026-08-30T01:00:02Z'], ['executable_path_sha256', hash(`${platform}:executable-B`)],
    ['argv_sha256', hash(`${platform}:argv-B`)], ['parent_identity_sha256', hash(`${platform}:parent-B`)],
    ['launch_nonce', `${platform}-launch-B`], ['manager_run_id', `${platform}-manager-B`],
  ];
  const platformSubstitutions = {
    windows: [
      ['windows_identity.process_creation_time_filetime', '134167428000000001'],
      ['windows_identity.process_handle', '0x0000000000009876'],
    ],
    linux: [
      ['linux_identity.proc_start_ticks', 998878], ['linux_identity.boot_id_sha256', hash('boot-id-linux-B')],
      ['linux_identity.process_group_id', 41004], ['linux_identity.os_session_id', 41004],
      ['linux_identity.executable_device_id', 'dev-2050'], ['linux_identity.executable_inode', 889903],
    ],
  };
  const setField = (identity, field, value) => {
    const [parent, child] = field.split('.');
    if (child === undefined) identity[parent] = value;
    else identity[parent][child] = value;
  };
  for (const [label, expected] of [['Windows', windows], ['Linux', linux]]) {
    for (const [field, value] of [...substitutions(expected.platform), ...platformSubstitutions[expected.platform]]) {
      const observed = clone(expected);
      setField(observed, field, value);
      assertProcessSchemaValid(observed, `${label} ${field}`);
      const result = decisionFor(expected, observed);
      assert.strictEqual(result.action, 'HOLD', `${label} ${field}`);
      assert(result.reasons.includes('IDENTITY_MISMATCH'), `${label} ${field}`);
      assert.strictEqual(result.action_authorized, false, `${label} ${field}`);
      assert.strictEqual(Object.hasOwn(result, 'native_handle'), false, `${label} ${field} result`);
    }
  }
  const absence = decisionFor(windows, clone(windows), {
    absence: { process_absent: true, thread_absent: true, port_absent: true },
  });
  assert.strictEqual(absence.action, 'OBSERVE_ONLY');
  assert.strictEqual(absence.action_authorized, false);
  assert.strictEqual(absence.downstream_release_allowed, true);
  assert.strictEqual(Object.hasOwn(absence, 'native_handle'), false);
});

test('stage A v2 harness resources use their closed proof without process recovery', () => {
  for (const [type, identity, observation] of [
    ['agent_session', completeHarnessSession2('agent_session'), { child_closed: true }],
    ['runtime_thread', completeHarnessSession2('runtime_thread'), { absence: { thread_absent: true } }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `harness-${type}`, purpose: 'v2 harness closure' });
    scope.register(resource(`harness-${type}`, type));
    const bound = scope.bind(`harness-${type}`, { identity, generation: 2, evidenceRefs: [`${type}-bind`] });
    assert.strictEqual(bound.state, 'ACTIVE', type);
    const decision = scope.observe(`harness-${type}`, {
      expected_identity: identity,
      observed_identity: clone(identity),
      expected_generation: 2,
      observed_generation: 2,
      expected_scope: { kind: 'scope', value: `harness-${type}` },
      observed_scope: { kind: 'scope', value: `harness-${type}` },
      ...observation,
    });
    assert.strictEqual(decision.action, 'OBSERVE_ONLY', type);
    assert.strictEqual(decision.downstream_release_allowed, true, type);
    assert.strictEqual(decision.action_authorized, false, type);
  }

  for (const [label, type, identity, observation] of [
    ['agent without proof', 'agent_session', completeHarnessSession2('agent_session'), {}],
    ['agent with runtime proof', 'agent_session', completeHarnessSession2('agent_session'), { absence: { thread_absent: true } }],
    ['runtime without proof', 'runtime_thread', completeHarnessSession2('runtime_thread'), {}],
    ['runtime with agent proof', 'runtime_thread', completeHarnessSession2('runtime_thread'), { child_closed: true }],
  ]) {
    const tracker = makeTracker();
    const scope = tracker.openRootScope({ scopeId: `harness-negative-${label.replace(/\s/g, '-')}`, purpose: 'v2 harness proof isolation' });
    const resourceId = `harness-negative-${type}-${label.replace(/\s/g, '-')}`;
    scope.register(resource(resourceId, type));
    assert.strictEqual(scope.bind(resourceId, { identity, generation: 2, evidenceRefs: [`${resourceId}-bind`] }).state, 'ACTIVE', label);
    const decision = scope.observe(resourceId, {
      expected_identity: identity,
      observed_identity: clone(identity),
      expected_generation: 2,
      observed_generation: 2,
      expected_scope: { kind: 'scope', value: `harness-negative-${label.replace(/\s/g, '-')}` },
      observed_scope: { kind: 'scope', value: `harness-negative-${label.replace(/\s/g, '-')}` },
      ...observation,
    });
    assert.strictEqual(decision.action, 'OBSERVE_ONLY', label);
    assert.strictEqual(decision.downstream_release_allowed, false, label);
    assert.strictEqual(decision.action_authorized, false, label);
  }
});

test('stage A v2 temporary allocation reclaim binds every manifest identity field and post-removal observation', () => {
  const nominal = stageATemporaryFixture();
  const tracker = makeStageATemporaryTracker();
  const scope = tracker.openRootScope({ scopeId: 'temporary-nominal', purpose: 'v2 temporary reclaim' });
  scope.register(resource('temporary-nominal', 'temporary_allocation'));
  assert.strictEqual(scope.bind('temporary-nominal', {
    identity: nominal.identity, generation: 2, evidenceRefs: ['temporary-nominal-bind'],
  }).state, 'ACTIVE');
  const reclaim = scope.observe('temporary-nominal', {
    manifest: nominal.manifest,
    child_id: 'child-A',
    intent: 'reclaim',
    observation: nominal.observation,
    policyIndex: nominal.policyIndex,
  });
  assert.strictEqual(reclaim.action, 'RECLAIM_EXACT');
  assert.deepStrictEqual(reclaim.reasons, ['RECLAIM_PRECONDITIONS_VERIFIED']);
  assert.strictEqual(reclaim.requires_same_parent_quarantine, true);
  assert.strictEqual(reclaim.requires_post_removal_absence_check, true);
  for (const forbiddenReason of [
    'TEMP_MANIFEST_INVALID', 'POLICY_NOT_OBSERVABLE', 'LEASE_IDENTITY_MISMATCH',
    'RECLAIM_PRECONDITION_MISSING', 'RECLAIM_TRUST_NOT_PROVEN', 'OBSERVATION_TRUST_NOT_PROVEN',
  ]) assert.strictEqual(reclaim.reasons.includes(forbiddenReason), false, forbiddenReason);
  const confirmed = scope.confirmRelease('temporary-nominal', {
    identity: nominal.identity,
    generation: 2,
    absenceVerified: true,
    evidenceRefs: ['temporary-nominal-absence'],
  });
  assert.strictEqual(confirmed.releaseConfirmed, true);
  assert.deepStrictEqual(confirmed.identity, nominal.identity);
  assert(confirmed.evidenceRefs.includes('temporary-nominal-bind'));
  assert(confirmed.evidenceRefs.includes('temporary-nominal-absence'));

  const observeDrift = (label, mutateManifest) => {
    const base = stageATemporaryFixture();
    const manifest = clone(base.manifest);
    const childId = mutateManifest(manifest) ?? 'child-A';
    manifest.manifest_sha256 = contracts.computeTemporaryManifestSha256(manifest);
    const identity = clone(base.identity);
    if (label !== 'hash-drift') identity.manifest_sha256 = manifest.manifest_sha256;
    const observation = stageATemporaryObservation(manifest, childId);
    const driftTracker = makeStageATemporaryTracker();
    const driftScope = driftTracker.openRootScope({ scopeId: `temporary-${label}`, purpose: 'v2 temporary drift' });
    driftScope.register(resource(`temporary-${label}`, 'temporary_allocation'));
    assert.strictEqual(driftScope.bind(`temporary-${label}`, {
      identity, generation: 2, evidenceRefs: [`temporary-${label}-bind`],
    }).state, 'ACTIVE', label);
    const held = driftScope.observe(`temporary-${label}`, {
      manifest,
      child_id: childId,
      intent: 'reclaim',
      observation,
      policyIndex: base.policyIndex,
    });
    assert.strictEqual(held.action, 'HOLD', label);
    assert.deepStrictEqual(held.reasons, ['TEMP_BOUND_IDENTITY_MISMATCH'], label);
  };

  observeDrift('hash-drift', (manifest) => { manifest.created_at = '2026-08-30T02:00:01Z'; });
  observeDrift('owner-drift', (manifest) => { manifest.owner_id = 'other-owner'; });
  observeDrift('run-drift', (manifest) => { manifest.run_id = 'other-run'; });
  observeDrift('session-drift', (manifest) => { manifest.session_id = 'other-session'; });
  observeDrift('generation-drift', (manifest) => {
    manifest.lease_generation = 3;
    manifest.child_sublease_map['child-A'].lease_generation = 3;
  });
  observeDrift('root-drift', (manifest) => {
    manifest.canonical_root_identity = {
      canonical_path: '/tmp/dw/run-B',
      path_identity_hash: hash('/tmp/dw/run-B:identity'),
      parent_identity_hash: hash('/tmp/dw/run-B:parent'),
      platform: 'linux',
    };
    manifest.child_sublease_map['child-A'].canonical_descendant = '/tmp/dw/run-B/task-A';
  });
  observeDrift('child-drift', (manifest) => {
    const child = manifest.child_sublease_map['child-A'];
    delete manifest.child_sublease_map['child-A'];
    manifest.child_sublease_map['child-B'] = { ...child, owner_id: 'child-B' };
    return 'child-B';
  });
  observeDrift('sublease-drift', (manifest) => { manifest.child_sublease_map['child-A'].nonce = 'changed-child-nonce'; });
  observeDrift('task-path-drift', (manifest) => { manifest.child_sublease_map['child-A'].canonical_descendant = '/tmp/dw/run-A/task-B'; });

  for (const [label, releaseObservation] of [
    ['post-removal-identity-drift', (fixture) => ({ ...fixture, identity: { ...fixture.identity, creation_nonce: 'changed-nonce' } })],
    ['post-removal-generation-drift', (fixture) => ({ ...fixture, generation: 3 })],
  ]) {
    const fixture = stageATemporaryFixture();
    const releaseTracker = makeStageATemporaryTracker();
    const releaseScope = releaseTracker.openRootScope({ scopeId: `temporary-${label}`, purpose: 'v2 release drift' });
    releaseScope.register(resource(`temporary-${label}`, 'temporary_allocation'));
    releaseScope.bind(`temporary-${label}`, { identity: fixture.identity, generation: 2, evidenceRefs: [`${label}-bind`] });
    assert.strictEqual(releaseScope.observe(`temporary-${label}`, {
      manifest: fixture.manifest, child_id: 'child-A', intent: 'reclaim', observation: fixture.observation, policyIndex: fixture.policyIndex,
    }).action, 'RECLAIM_EXACT', label);
    assert.throws(() => releaseScope.confirmRelease(`temporary-${label}`, {
      ...releaseObservation({ identity: fixture.identity, generation: 2, absenceVerified: true, evidenceRefs: [`${label}-absence`] }),
    }), /RESOURCE_IDENTITY_DRIFT/, label);
  }
});

test('stage A v2 Linux process and harness identity fields are mandatory and schema-parity ready', () => {
  const schemas = Object.fromEntries(schemaBundle.map((schema) => [schema.title, schema]));
  const validLinux = completeLinuxProcess2();
  const linuxFixtures = [validLinux];
  for (const field of ['proc_start_ticks', 'boot_id_sha256', 'process_group_id', 'os_session_id', 'executable_device_id', 'executable_inode']) {
    const invalid = clone(validLinux);
    delete invalid.linux_identity[field];
    linuxFixtures.push(invalid);
  }
  assert.deepStrictEqual(linuxFixtures.map((identity) => contracts.validateProcessIdentity2(identity).valid), [true, false, false, false, false, false, false]);
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.ProcessIdentity2, linuxFixtures), [true, false, false, false, false, false, false]);

  const harnessFixtures = ['agent_session', 'runtime_thread'].flatMap((resourceType) => {
    const valid = completeHarnessSession2(resourceType);
    const missingHarness = clone(valid);
    delete missingHarness.harness;
    return [valid, missingHarness];
  });
  assert.deepStrictEqual(harnessFixtures.map((identity) => contracts.validateHarnessSessionIdentity2(identity).valid), [true, false, true, false]);
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.HarnessSessionIdentity2, harnessFixtures), [true, false, true, false]);

  const validRecovery = completeRecoveryRecord2('process_tree', validLinux);
  const missingRecoveryLinuxField = clone(validRecovery);
  delete missingRecoveryLinuxField.identity.linux_identity.executable_inode;
  const harnessRecoveryFixtures = ['agent_session', 'runtime_thread'].flatMap((resourceType) => {
    const valid = completeRecoveryRecord2(resourceType, completeHarnessSession2(resourceType));
    const missingHarness = clone(valid);
    delete missingHarness.identity.harness;
    return [valid, missingHarness];
  });
  assert.deepStrictEqual([validRecovery, missingRecoveryLinuxField].map((record) => contracts.validateRecoveryRecord2(record).valid), [true, false]);
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.RecoveryRecord2, [
    validRecovery, missingRecoveryLinuxField,
  ]), [true, false]);
  assert.deepStrictEqual(harnessRecoveryFixtures.map((record) => contracts.validateRecoveryRecord2(record).valid), [true, false, true, false]);
  assert.deepStrictEqual(validateDraft202012Fixtures(schemas.RecoveryRecord2, harnessRecoveryFixtures), [true, false, true, false]);
});

test('stage A legacy process recovery behavior stays unchanged while version-2 has its own decision path', () => {
  const legacy = legacyProcess();
  const legacyResult = contracts.decideProcessRecovery({
    duplicate_run_lock: false, owner_status: 'owned', expected_identity: legacy, observed_identity: clone(legacy),
    expected_generation: 2, observed_generation: 2, expected_scope: { kind: 'scope', value: 'root' }, observed_scope: { kind: 'scope', value: 'root' },
    graceful: { requested: true, exit_observed: false, deadline_reached: true }, exact_tree_termination_supported: true,
  });
  assert.strictEqual(legacyResult.action, 'TERMINATE_EXACT_TREE');
  assert.strictEqual(Object.hasOwn(legacyResult, 'action_authorized'), false);
  const completeV2 = completeLinuxProcess2();
  const legacyV2Result = contracts.decideProcessRecovery({
    duplicate_run_lock: false, owner_status: 'owned', expected_identity: completeV2, observed_identity: clone(completeV2),
    expected_generation: 2, observed_generation: 2, expected_scope: { kind: 'scope', value: 'root' }, observed_scope: { kind: 'scope', value: 'root' },
    graceful: { requested: true, exit_observed: false, deadline_reached: true }, exact_tree_termination_supported: true,
  });
  assert.strictEqual(legacyV2Result.action, 'OBSERVE_ONLY');
  assert.deepStrictEqual(legacyV2Result.reasons, ['IDENTITY_PARTIAL']);
  assert.strictEqual(legacyV2Result.identity_confidence, 'PARTIAL');
  assert.strictEqual(Object.hasOwn(legacyV2Result, 'action_authorized'), false);
  const version2 = contracts.decideProcessRecovery2({
    duplicate_run_lock: false, owner_status: 'owned', expected_identity: completeV2, observed_identity: clone(completeV2),
    expected_generation: 2, observed_generation: 2, expected_scope: { kind: 'scope', value: 'root' }, observed_scope: { kind: 'scope', value: 'root' },
    graceful: { requested: true, exit_observed: false, deadline_reached: true }, exact_tree_termination_supported: true,
  });
  assert.strictEqual(version2.action, 'TERMINATE_EXACT_TREE');
  assert.strictEqual(version2.identity_confidence, 'MATCH');
  assert.strictEqual(version2.action_authorized, false);
});

test('stage A review repair R1 rejects malformed version-2 process scopes before recovery actions', () => {
  const identity = completeLinuxProcess2();
  const validScope = { kind: 'scope', value: 'root' };
  const dangerousTails = [
    ['complete absence', { absence: { process_absent: true, thread_absent: true, port_absent: true } }],
    ['graceful deadline', {
      graceful: { requested: true, exit_observed: false, deadline_reached: true },
      exact_tree_termination_supported: true,
    }],
  ];
  const decisionFor = (scopeFields, tail) => contracts.decideProcessRecovery2({
    duplicate_run_lock: false,
    owner_status: 'owned',
    expected_identity: identity,
    observed_identity: clone(identity),
    expected_generation: 2,
    observed_generation: 2,
    ...scopeFields,
    ...tail,
  });
  const invalidScopes = [
    ['empty object', {}],
    ['null', null],
    ['array', []],
    ['string', 'scope'],
    ['number', 7],
    ['boolean', false],
    ['missing kind', { value: 'root' }],
    ['missing value', { kind: 'scope' }],
    ['extra key', { kind: 'scope', value: 'root', extra: true }],
    ['empty kind', { kind: '', value: 'root' }],
    ['whitespace kind', { kind: '  ', value: 'root' }],
    ['wrong kind', { kind: 'task', value: 'root' }],
    ['empty value', { kind: 'scope', value: '' }],
    ['whitespace value', { kind: 'scope', value: '  ' }],
    ['non-string value', { kind: 'scope', value: 7 }],
  ];
  const assertInvalid = (label, scopeFields, tailLabel) => {
    const result = decisionFor(scopeFields, tailLabel);
    assert.strictEqual(result.action, 'HOLD', label);
    assert.deepStrictEqual(result.reasons, ['SCOPE_IDENTITY_INVALID'], label);
    assert.strictEqual(result.identity_confidence, 'MATCH', label);
    assert.strictEqual(result.action_authorized, false, label);
    assert.notStrictEqual(result.downstream_release_allowed, true, label);
    assert.notStrictEqual(result.requires_identity_recheck, true, label);
  };

  for (const [tailLabel, tail] of dangerousTails) {
    for (const [label, invalid] of invalidScopes) {
      assertInvalid(`expected ${label} with ${tailLabel}`, { expected_scope: invalid, observed_scope: validScope }, tail);
      assertInvalid(`observed ${label} with ${tailLabel}`, { expected_scope: validScope, observed_scope: invalid }, tail);
    }
    assertInvalid(`expected omitted with ${tailLabel}`, { observed_scope: validScope }, tail);
    assertInvalid(`observed omitted with ${tailLabel}`, { expected_scope: validScope }, tail);
  }

  const graceful = decisionFor({ expected_scope: validScope, observed_scope: clone(validScope) }, dangerousTails[1][1]);
  assert.strictEqual(graceful.action, 'TERMINATE_EXACT_TREE');
  assert.deepStrictEqual(graceful.reasons, ['EXACT_OWNED_TREE']);
  assert.strictEqual(graceful.identity_confidence, 'MATCH');
  assert.strictEqual(graceful.action_authorized, false);
  const absence = decisionFor({ expected_scope: validScope, observed_scope: clone(validScope) }, dangerousTails[0][1]);
  assert.strictEqual(absence.action, 'OBSERVE_ONLY');
  assert.deepStrictEqual(absence.reasons, ['ABSENCE_VERIFIED']);
  assert.strictEqual(absence.downstream_release_allowed, true);
  assert.strictEqual(absence.action_authorized, false);
  for (const [tailLabel, tail] of dangerousTails) {
    const unequal = decisionFor({ expected_scope: validScope, observed_scope: { kind: 'scope', value: 'other-root' } }, tail);
    assert.strictEqual(unequal.action, 'HOLD', tailLabel);
    assert.deepStrictEqual(unequal.reasons, ['SCOPE_IDENTITY_MISMATCH'], tailLabel);
    assert.strictEqual(unequal.action_authorized, false, tailLabel);
  }
});

test('stage A review repair R1 binds temporary allocation platform to the manifest platform vocabulary', () => {
  const windowsIdentity = (manifest) => {
    const identity = completeTemporaryAllocation2(manifest, {
      platform: 'windows',
      canonical_root: 'C:\\dw\\run-A',
      task_directory: {
        path: 'C:\\dw\\run-A\\task-A',
        windows_file_identity: { volume_serial_number: 'A1B2-C3D4', file_id: '0011223344556677' },
      },
      confirmed_parent_directory: {
        path: 'C:\\dw\\run-A',
        windows_file_identity: { volume_serial_number: 'A1B2-C3D4', file_id: '0011223344556676' },
      },
      windows_file_identity: { volume_serial_number: 'A1B2-C3D4', file_id: '0011223344556676' },
    });
    delete identity.linux_file_identity;
    return identity;
  };
  const fixtureFor = (identityPlatform, manifestPlatform) => {
    const windows = identityPlatform === 'windows';
    const canonicalRoot = windows ? 'C:\\dw\\run-A' : '/tmp/dw/run-A';
    const childPath = windows ? 'C:\\dw\\run-A\\task-A' : '/tmp/dw/run-A/task-A';
    const manifest = stageATemporaryManifest({
      canonical_root_identity: {
        canonical_path: canonicalRoot,
        path_identity_hash: hash(`${canonicalRoot}:identity`),
        parent_identity_hash: hash(`${canonicalRoot}:parent`),
        platform: 'linux',
      },
    });
    if (manifestPlatform === undefined) delete manifest.canonical_root_identity.platform;
    else manifest.canonical_root_identity.platform = manifestPlatform;
    manifest.child_sublease_map['child-A'].canonical_descendant = childPath;
    manifest.manifest_sha256 = contracts.computeTemporaryManifestSha256(manifest);
    const identity = windows ? windowsIdentity(manifest) : completeTemporaryAllocation2(manifest);
    const observation = stageATemporaryObservation(manifest);
    return { manifest, identity, observation, policyIndex: stageATemporaryFixture().policyIndex };
  };
  const observe = (label, fixture) => {
    const tracker = makeStageATemporaryTracker();
    const scope = tracker.openRootScope({ scopeId: `platform-${label}`, purpose: 'platform binding' });
    scope.register(resource(`platform-${label}`, 'temporary_allocation'));
    assert.strictEqual(scope.bind(`platform-${label}`, {
      identity: fixture.identity, generation: 2, evidenceRefs: [`platform-${label}-bind`],
    }).state, 'ACTIVE', label);
    return scope.observe(`platform-${label}`, {
      manifest: fixture.manifest,
      child_id: 'child-A',
      intent: 'reclaim',
      observation: fixture.observation,
      policyIndex: fixture.policyIndex,
    });
  };

  for (const [label, identityPlatform, manifestPlatform] of [
    ['windows-win32', 'windows', 'win32'],
    ['linux-linux', 'linux', 'linux'],
  ]) {
    const result = observe(label, fixtureFor(identityPlatform, manifestPlatform));
    assert.strictEqual(result.action, 'RECLAIM_EXACT', label);
  }

  const negativeCases = [
    ['linux-win32', 'linux', 'win32'],
    ['windows-linux', 'windows', 'linux'],
    ...['darwin', 'freebsd', undefined, '', 7].flatMap((manifestPlatform) => [
      [`windows-${String(manifestPlatform)}`, 'windows', manifestPlatform],
      [`linux-${String(manifestPlatform)}`, 'linux', manifestPlatform],
    ]),
  ];
  for (const [label, identityPlatform, manifestPlatform] of negativeCases) {
    const result = observe(label, fixtureFor(identityPlatform, manifestPlatform));
    assert.strictEqual(result.action, 'HOLD', label);
    assert.deepStrictEqual(result.reasons, ['TEMP_BOUND_IDENTITY_MISMATCH'], label);
    assert.strictEqual(result.action_authorized, false, label);
    assert.strictEqual(result.downstream_release_allowed, false, label);
    assert.notStrictEqual(result.action, 'RECLAIM_EXACT', label);
  }
});

const malformedMissingDependencyPackages = [
  ['missing package field', undefined],
  ['null package', null],
  ['object package', {}],
  ['array package', []],
  ['numeric package', 7],
  ['empty package', ''],
];
for (const [label, packageName] of malformedMissingDependencyPackages) {
  test(`compatibility metadata missing_dependency with ${label} is malformed`, () => {
    const originalSpawnSync = childProcess.spawnSync;
    let calls = 0;
    try {
      childProcess.spawnSync = () => {
        calls += 1;
        assert.strictEqual(calls, 1, 'metadata probe made an unexpected extra call');
        const payload = { kind: 'missing_dependency' };
        if (packageName !== undefined) payload.package = packageName;
        return { status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null };
      };

      const probe = probePythonDescriptor(pythonDescriptor('malformed-metadata-python'));
      assert.strictEqual(probe.executed, true);
      assert(probe.error);
      assert.strictEqual(calls, 1);
      assert.strictEqual(probe.error.code, 'PYTHON_SCHEMA_MALFORMED_OUTPUT');
      assert.deepStrictEqual(probe.error.descriptor, pythonDescriptor('malformed-metadata-python'));
      assert.strictEqual(Object.hasOwn(probe.error, 'remediation'), false);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }
  });
}

const malformedMissingApiDetails = [
  ['missing detail field', undefined],
  ['null detail', null],
  ['object detail', {}],
  ['array detail', []],
  ['numeric detail', 7],
  ['empty detail', ''],
];
for (const [label, detail] of malformedMissingApiDetails) {
  test(`compatibility behavior missing_api with ${label} is malformed`, () => {
    const originalSpawnSync = childProcess.spawnSync;
    let calls = 0;
    try {
      childProcess.spawnSync = () => {
        calls += 1;
        assert(calls <= 2, 'behavior probe made an unexpected third call');
        if (calls === 1) {
          return {
            status: 0,
            stdout: JSON.stringify({ kind: 'compatible', jsonschema: '4.18.0', referencing: '0.28.4' }),
            stderr: '',
            signal: null,
          };
        }
        const payload = { kind: 'missing_api' };
        if (detail !== undefined) payload.detail = detail;
        return { status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null };
      };

      const probe = probePythonDescriptor(pythonDescriptor('malformed-behavior-python'));
      assert.strictEqual(probe.executed, true);
      assert(probe.error);
      assert.strictEqual(calls, 2);
      assert.strictEqual(probe.error.code, 'PYTHON_SCHEMA_MALFORMED_OUTPUT');
      assert.deepStrictEqual(probe.error.descriptor, pythonDescriptor('malformed-behavior-python'));
      assert.strictEqual(Object.hasOwn(probe.error, 'remediation'), false);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }
  });
}

test('stage B recovery scanning accepts only bounded plain JSON-like graphs', () => {
  const recover = (value) => {
    try {
      return contracts.validateRecoveryRecord2(value);
    } catch (caught) {
      return { threw: caught };
    }
  };
  const recovery = () => completeRecoveryRecord2('temporary_allocation', temporaryAllocation());
  const recoveryScannerErrorCodes = new Set([
    'RECOVERY_GRAPH_INVALID',
    'RECOVERY_GRAPH_CYCLE',
    'RECOVERY_NODE_LIMIT_EXCEEDED',
    'RECOVERY_DEPTH_LIMIT_EXCEEDED',
    'RECOVERY_STRING_SIZE_LIMIT_EXCEEDED',
    'RECOVERY_KEY_SIZE_LIMIT_EXCEEDED',
    'RECOVERY_OBJECT_KEY_LIMIT_EXCEEDED',
    'RECOVERY_AGGREGATE_SIZE_LIMIT_EXCEEDED',
  ]);
  const graphErrors = (value) => value.errors.filter((item) => recoveryScannerErrorCodes.has(item.code));
  const expectGraphError = (label, candidate, expected) => {
    const checked = recover(candidate);
    assert.strictEqual(Object.hasOwn(checked, 'threw'), false, label);
    assert.deepStrictEqual(graphErrors(checked), [expected], label);
    assert.strictEqual(checked.errors.some((item) => item.code === 'IDENTITY_SHAPE_INVALID'), false, label);
    return checked;
  };
  const expectNoGraphError = (label, candidate) => {
    const checked = recover(candidate);
    assert.strictEqual(Object.hasOwn(checked, 'threw'), false, label);
    assert.deepStrictEqual(graphErrors(checked), [], label);
    return checked;
  };
  const graphError = (code, path, message) => ({ code, path, message });
  const withDepth = (count) => {
    let child = 'safe';
    for (let index = 0; index < count; index += 1) child = { next: child };
    const record = recovery();
    record.graph = child;
    return record;
  };

  const shared = recovery();
  shared.identity.confirmed_parent_directory = shared.identity.task_directory;
  assert.strictEqual(expectNoGraphError('shared DAG temporary recovery remains valid', shared).valid, true);
  assert.deepStrictEqual(graphErrors(expectNoGraphError('depth eight is accepted', withDepth(7))), []);

  const exactString = recovery();
  exactString.resource_id = 'x'.repeat(4096);
  assert.deepStrictEqual(graphErrors(expectNoGraphError('exact string byte limit is accepted', exactString)), []);
  const multibyteExact = recovery();
  multibyteExact.resource_id = `${'中'.repeat(1365)}a`;
  assert.deepStrictEqual(graphErrors(expectNoGraphError('exact multibyte string byte limit is accepted', multibyteExact)), []);

  const cyclic = recovery();
  cyclic.current_phase.self = cyclic.current_phase;
  expectGraphError('cycle', cyclic, graphError(
    'RECOVERY_GRAPH_CYCLE', '$.current_phase.self', 'recovery graph contains an active-ancestor cycle',
  ));
  const accessor = recovery();
  let getterCount = 0;
  Object.defineProperty(accessor.current_phase, 'unreadable', {
    enumerable: true,
    get() { getterCount += 1; return 'must not be read'; },
  });
  expectGraphError('accessor', accessor, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const symbolic = recovery();
  symbolic.current_phase[Symbol('hidden')] = 'symbol';
  expectGraphError('symbol', symbolic, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const nonenumerable = recovery();
  Object.defineProperty(nonenumerable.current_phase, 'hidden', { enumerable: false, value: 'hidden' });
  expectGraphError('nonenumerable', nonenumerable, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const nullPrototype = recovery();
  nullPrototype.current_phase = Object.assign(Object.create(null), { phase: 'cleanup', state: 'ACTIVE' });
  expectGraphError('null prototype', nullPrototype, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const customPrototype = recovery();
  customPrototype.current_phase = Object.assign(Object.create({ inherited: true }), { phase: 'cleanup', state: 'ACTIVE' });
  expectGraphError('custom prototype', customPrototype, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const throwingProxy = recovery();
  throwingProxy.current_phase = new Proxy({}, { ownKeys() { throw new Error('proxy reflection must not escape'); } });
  expectGraphError('throwing proxy', throwingProxy, graphError(
    'RECOVERY_GRAPH_INVALID', '$.current_phase', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const sparseArray = recovery();
  sparseArray.evidence_refs = new Array(1);
  expectGraphError('sparse array', sparseArray, graphError(
    'RECOVERY_GRAPH_INVALID', '$.evidence_refs', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const extraArray = recovery();
  extraArray.evidence_refs.extra = 'extra';
  expectGraphError('extra array property', extraArray, graphError(
    'RECOVERY_GRAPH_INVALID', '$.evidence_refs', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const accessorArray = recovery();
  Object.defineProperty(accessorArray.evidence_refs, '0', {
    enumerable: true,
    get() { getterCount += 1; return opaqueRef('evidence', 'must-not-read'); },
  });
  expectGraphError('array accessor', accessorArray, graphError(
    'RECOVERY_GRAPH_INVALID', '$.evidence_refs', 'recovery graph is not plain descriptor-only JSON-like data',
  ));
  const hugeArray = recovery();
  hugeArray.evidence_refs = new Array(257);
  Object.defineProperty(hugeArray.evidence_refs, '0', {
    enumerable: true,
    get() { getterCount += 1; return opaqueRef('evidence', 'huge-array'); },
  });
  expectGraphError('huge array', hugeArray, graphError(
    'RECOVERY_NODE_LIMIT_EXCEEDED', '$.evidence_refs', 'recovery graph exceeds maximum node count',
  ));
  const rootString = expectNoGraphError('finite root string is JSON-like', 'not a recovery record');
  assert.deepStrictEqual(rootString.errors, [graphError(
    'IDENTITY_SHAPE_INVALID', '$', 'value must be a plain object',
  )]);
  expectGraphError('depth over limit', withDepth(8), graphError(
    'RECOVERY_DEPTH_LIMIT_EXCEEDED', '$.graph.next.next.next.next.next.next.next.next', 'recovery graph exceeds maximum depth',
  ));
  const overString = recovery();
  overString.resource_id = 'x'.repeat(4097);
  expectGraphError('string over limit', overString, graphError(
    'RECOVERY_STRING_SIZE_LIMIT_EXCEEDED', '$.resource_id', 'recovery string exceeds maximum UTF-8 byte length',
  ));
  const multibyteOver = recovery();
  multibyteOver.resource_id = `${'中'.repeat(1365)}ab`;
  expectGraphError('multibyte string over limit', multibyteOver, graphError(
    'RECOVERY_STRING_SIZE_LIMIT_EXCEEDED', '$.resource_id', 'recovery string exceeds maximum UTF-8 byte length',
  ));
  const overKey = recovery();
  overKey['k'.repeat(129)] = 'safe';
  expectGraphError('key over limit', overKey, graphError(
    'RECOVERY_KEY_SIZE_LIMIT_EXCEEDED', '$.*', 'recovery object key exceeds maximum UTF-8 byte length',
  ));

  for (const [label, value] of [
    ['undefined', undefined], ['function', () => {}], ['bigint', 1n], ['symbol', Symbol('value')],
    ['NaN', Number.NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ]) {
    const invalid = recovery();
    invalid.badValue = value;
    expectGraphError(`nested ${label}`, invalid, graphError(
      'RECOVERY_GRAPH_INVALID', '$.badValue', 'recovery graph is not plain descriptor-only JSON-like data',
    ));
  }
  assert.strictEqual(getterCount, 0, 'scanner never invokes getters');

  const ordinaryNodesAtLimit = { items: Array(253).fill(null), tail: {} };
  assert.deepStrictEqual(graphErrors(expectNoGraphError('ordinary graph has 256 nodes', ordinaryNodesAtLimit)), []);
  expectGraphError('ordinary graph has 257 nodes', { items: Array(253).fill(null), tail: { value: null } }, graphError(
    'RECOVERY_NODE_LIMIT_EXCEEDED', '$.tail.value', 'recovery graph exceeds maximum node count',
  ));
  assert.deepStrictEqual(graphErrors(expectNoGraphError('fast array has 256 nodes', { items: Array(254).fill(null) })), []);
  expectGraphError('fast array has 257 nodes', { items: Array(255).fill(null) }, graphError(
    'RECOVERY_NODE_LIMIT_EXCEEDED', '$.items', 'recovery graph exceeds maximum node count',
  ));
  assert.deepStrictEqual(graphErrors(expectNoGraphError('object has 32 keys', Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`k${index}`, null])))), []);
  expectGraphError('object has 33 keys', Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, null])), graphError(
    'RECOVERY_OBJECT_KEY_LIMIT_EXCEEDED', '$', 'recovery object exceeds maximum key count',
  ));

  const ascii128 = 'k'.repeat(128);
  const ascii129 = 'k'.repeat(129);
  const multibyte128 = `${'中'.repeat(42)}ab`;
  const multibyte129 = `${'中'.repeat(42)}abc`;
  for (const [label, key] of [['ASCII 128', ascii128], ['multibyte 128', multibyte128]]) {
    assert.deepStrictEqual(graphErrors(expectNoGraphError(label, { [key]: null })), [], label);
  }
  for (const [label, key] of [['ASCII 129', ascii129], ['multibyte 129', multibyte129]]) {
    expectGraphError(label, { [key]: null }, graphError(
      'RECOVERY_KEY_SIZE_LIMIT_EXCEEDED', '$.*', 'recovery object key exceeds maximum UTF-8 byte length',
    ));
  }

  const aggregateStringAtLimit = { parts: [...Array(7).fill('x'.repeat(4096)), 'x'.repeat(4091)] };
  assert.deepStrictEqual(graphErrors(expectNoGraphError('aggregate string is exactly 32768 bytes', aggregateStringAtLimit)), []);
  expectGraphError('aggregate string exceeds 32768 bytes', { parts: [...Array(7).fill('x'.repeat(4096)), 'x'.repeat(4092)] }, graphError(
    'RECOVERY_AGGREGATE_SIZE_LIMIT_EXCEEDED', '$.parts[7]', 'recovery graph exceeds maximum aggregate UTF-8 byte length',
  ));
  const aggregateKeyAtLimit = {
    parts: Array(7).fill('x'.repeat(4096)),
    child: { overflow: 'x'.repeat(4078) },
  };
  assert.deepStrictEqual(graphErrors(expectNoGraphError('aggregate key is exactly 32768 bytes', aggregateKeyAtLimit)), []);
  expectGraphError('aggregate key exceeds 32768 bytes', {
    parts: Array(7).fill('x'.repeat(4096)),
    child: { overflowX: 'x'.repeat(4078) },
  }, graphError(
    'RECOVERY_AGGREGATE_SIZE_LIMIT_EXCEEDED', '$.child.overflowX', 'recovery graph exceeds maximum aggregate UTF-8 byte length',
  ));

  const unsafeKeyCases = [
    ['api key', 'api_key'], ['bearer', 'bearer'], ['bare credential', 'bareCredentialValue12345678'],
    ['safe 65', `a${'b'.repeat(64)}`],
  ];
  for (const [label, key] of unsafeKeyCases) {
    const unsafe = recovery();
    unsafe[key] = undefined;
    const checked = expectGraphError(label, unsafe, graphError(
      'RECOVERY_GRAPH_INVALID', '$.<redacted-key>', 'recovery graph is not plain descriptor-only JSON-like data',
    ));
    assert.strictEqual(JSON.stringify(checked.errors).includes(key), false, label);
  }
  const safe64 = `a${'b'.repeat(63)}`;
  const safeKey = recovery();
  safeKey[safe64] = undefined;
  expectGraphError('safe 64-byte identifier remains diagnostic', safeKey, graphError(
    'RECOVERY_GRAPH_INVALID', `$.${safe64}`, 'recovery graph is not plain descriptor-only JSON-like data',
  ));

  const schemaValidRuntimeOverbudget = recovery();
  schemaValidRuntimeOverbudget.resource_id = 'x'.repeat(4097);
  assert.deepStrictEqual(validateDraft202012Fixtures(loadSchema('RecoveryRecord2.schema.json'), [schemaValidRuntimeOverbudget]), [true]);
  assert.strictEqual(recover(schemaValidRuntimeOverbudget).valid, false);

  const sensitive = recovery();
  const secret = 'sk-proj-1234567890abcdef';
  sensitive.api_key = secret;
  const sensitiveResult = recover(sensitive);
  assert(sensitiveResult.errors.some((item) => item.code === 'RECOVERY_SENSITIVE_CONTENT'));
  assert.deepStrictEqual(graphErrors(sensitiveResult), []);
  assert.strictEqual(JSON.stringify(sensitiveResult.errors).includes('api_key'), false);
  assert.strictEqual(JSON.stringify(sensitiveResult.errors).includes(secret), false);
  const hugeResult = recover(schemaValidRuntimeOverbudget);
  assert.strictEqual(JSON.stringify(hugeResult.errors).includes(schemaValidRuntimeOverbudget.resource_id), false);

  const originalArrayIsArray = Array.isArray;
  try {
    Array.isArray = () => { throw new Error('scanner must use captured Array.isArray'); };
    const intrinsicCycle = recovery();
    intrinsicCycle.current_phase.self = intrinsicCycle.current_phase;
    expectGraphError('captured Array.isArray', intrinsicCycle, graphError(
      'RECOVERY_GRAPH_CYCLE', '$.current_phase.self', 'recovery graph contains an active-ancestor cycle',
    ));
  } finally {
    Array.isArray = originalArrayIsArray;
  }
});

test('stage B support matrices derive overall state only from fully valid claims', () => {
  const evidence = opaqueRef('evidence', 'stage-b-support');
  const matrixFor = (overallState, states) => ({
    schema: 'SupportMatrix2',
    schema_version: 2,
    adapter_id: 'stage-b-adapter',
    platform: 'windows',
    observed_at: '2026-08-30T02:00:00Z',
    overall_state: overallState,
    claims: Object.fromEntries(states.map((state, index) => [["skillDiscovery", "childLifecycle"][index] || `capability_${index}`, {
      state,
      evidence_refs: state === 'NOT_RUN' ? [] : [evidence],
    }])),
  });
  const expectedStates = [
    [['VERIFIED_FULL'], 'VERIFIED_FULL'],
    [['VERIFIED_DEGRADED'], 'VERIFIED_DEGRADED'],
    [['UNVERIFIED'], 'UNVERIFIED'],
    [['NOT_RUN'], 'NOT_RUN'],
    [['FAILED'], 'FAILED'],
    [['VERIFIED_FULL', 'NOT_RUN'], 'UNVERIFIED'],
    [['VERIFIED_DEGRADED', 'NOT_RUN'], 'UNVERIFIED'],
    [['VERIFIED_DEGRADED', 'VERIFIED_FULL'], 'VERIFIED_DEGRADED'],
    [['FAILED', 'VERIFIED_FULL'], 'FAILED'],
  ];
  const supportStates = ['VERIFIED_FULL', 'VERIFIED_DEGRADED', 'UNVERIFIED', 'NOT_RUN', 'FAILED'];
  const schemaFixtures = [];
  const runtimeVector = [];
  for (const [states, expected] of expectedStates) {
    for (const overallState of supportStates) {
      const candidate = matrixFor(overallState, states);
      const validation = contracts.validateSupportMatrix2(candidate);
      const shouldPass = overallState === expected;
      assert.strictEqual(validation.valid, shouldPass, `${states.join(',')} ${overallState} runtime`);
      assert.strictEqual(validation.effective_state, shouldPass ? expected : 'UNVERIFIED', `${states.join(',')} ${overallState} effective`);
      if (!shouldPass) {
        assert(validation.errors.some((item) => item.code === 'SUPPORT_OVERALL_STATE_MISMATCH' && item.path === '$.overall_state'));
      }
      schemaFixtures.push(candidate);
      runtimeVector.push(shouldPass);
    }
  }
  assert.strictEqual(schemaFixtures.length, 45);
  assert.deepStrictEqual(validateDraft202012Fixtures(loadSchema('SupportMatrix2.schema.json'), schemaFixtures), runtimeVector);

  const invalidClaim = matrixFor('VERIFIED_DEGRADED', ['VERIFIED_DEGRADED']);
  invalidClaim.claims.skillDiscovery.state = 'UNKNOWN';
  const invalidClaimResult = contracts.validateSupportMatrix2(invalidClaim);
  assert.strictEqual(invalidClaimResult.valid, false);
  assert.strictEqual(invalidClaimResult.effective_state, 'UNVERIFIED');
  assert.strictEqual(invalidClaimResult.errors.some((item) => item.code === 'SUPPORT_OVERALL_STATE_MISMATCH'), false);

  const schema = loadSchema('SupportMatrix2.schema.json');
  const claimRules = schema.$defs.support_claim.allOf;
  assert(claimRules.some((rule) => rule.if.properties.state.const === 'NOT_RUN'
    && rule.then.properties.evidence_refs.maxItems === 0));
  assert(claimRules.some((rule) => rule.if.properties.state.not
    && rule.then.properties.evidence_refs.minItems === 1));
  for (const name of ['claims_all_full', 'claims_all_not_run', 'claims_all_full_or_degraded', 'claims_all_nonfailed']) {
    assert(schema.$defs[name], name);
  }
});

test('stage B recovery teardown conditions match every supported resource type', () => {
  const expected = [
    ['process_tree', windowsProcess(), 'identity_absence_verified'],
    ['command_session', windowsProcess(), 'identity_absence_verified'],
    ['agent_session', completeHarnessSession2('agent_session'), 'harness_closed'],
    ['runtime_thread', completeHarnessSession2('runtime_thread'), 'harness_closed'],
    ['temporary_allocation', temporaryAllocation(), 'allocation_absence_verified'],
  ];
  for (const [resourceType, identity, condition] of expected) {
    const valid = completeRecoveryRecord2(resourceType, identity);
    assert.strictEqual(valid.teardown_condition, condition, resourceType);
    assert.strictEqual(contracts.validateRecoveryRecord2(valid).valid, true, `${resourceType} valid`);
    assert.deepStrictEqual(validateDraft202012Fixtures(loadSchema('RecoveryRecord2.schema.json'), [valid]), [true], `${resourceType} schema valid`);
    for (const wrongCondition of ['identity_absence_verified', 'harness_closed', 'allocation_absence_verified']) {
      if (wrongCondition === condition) continue;
      const wrong = clone(valid);
      wrong.teardown_condition = wrongCondition;
      const wrongResult = contracts.validateRecoveryRecord2(wrong);
      assert.strictEqual(wrongResult.valid, false, `${resourceType} ${wrongCondition} controlled condition`);
      assert(wrongResult.errors.some((item) => item.code === 'RECOVERY_TEARDOWN_CONDITION_MISMATCH'
        && item.path === '$.teardown_condition'), resourceType);
      assert.strictEqual(wrongResult.errors.some((item) => item.code === 'RECOVERY_TEARDOWN_CONDITION_INVALID'), false, resourceType);
      assert.deepStrictEqual(validateDraft202012Fixtures(loadSchema('RecoveryRecord2.schema.json'), [wrong]), [false], `${resourceType} ${wrongCondition} schema`);
    }
  }
  const uncontrolled = completeRecoveryRecord2('process_tree', windowsProcess());
  uncontrolled.teardown_condition = 'task_complete';
  const uncontrolledResult = contracts.validateRecoveryRecord2(uncontrolled);
  assert.strictEqual(uncontrolledResult.valid, false);
  assert(uncontrolledResult.errors.some((item) => item.code === 'RECOVERY_TEARDOWN_CONDITION_INVALID'));
  assert.strictEqual(uncontrolledResult.errors.some((item) => item.code === 'RECOVERY_TEARDOWN_CONDITION_MISMATCH'), false);
  assert.deepStrictEqual(validateDraft202012Fixtures(loadSchema('RecoveryRecord2.schema.json'), [uncontrolled]), [false]);

  const schema = loadSchema('RecoveryRecord2.schema.json');
  assert.strictEqual(schema.allOf.length, 5);
  for (const [resourceType, , condition] of expected) {
    const branch = schema.allOf.find((entry) => entry.if.properties.resource_type.const === resourceType);
    assert(branch, resourceType);
    assert.strictEqual(branch.then.properties.teardown_condition.const, condition, resourceType);
  }
});

const requestedTestNames = process.argv.slice(2);
let selectedTests = tests;
if (requestedTestNames.length > 0) {
  const uniqueRequestedNames = new Set(requestedTestNames);
  if (uniqueRequestedNames.size !== requestedTestNames.length) {
    process.stderr.write('test selection failed: duplicate exact test name requested\n');
    process.exitCode = 2;
  } else {
    selectedTests = [];
    for (const requestedName of requestedTestNames) {
      const matches = tests.filter(({ name }) => name === requestedName);
      if (matches.length !== 1) {
        process.stderr.write(`test selection failed: ${JSON.stringify(requestedName)} matched ${matches.length} registered tests; expected exactly 1\n`);
        process.exitCode = 2;
      } else {
        selectedTests.push(matches[0]);
      }
    }
  }
}
if (process.exitCode === 2) process.exit(process.exitCode);

let failed = 0;
for (const { name, fn } of selectedTests) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failed > 0) process.exitCode = 1;
else process.stdout.write(`${selectedTests.length} identity/support v2 tests passed.\n`);
