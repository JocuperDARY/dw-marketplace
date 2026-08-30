'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const api = require('../skills/dw-collaboration/scripts/lib/contracts');
const { computeDetachedSha256, createDetachedJsonSnapshot } = require('../skills/dw-collaboration/scripts/lib/canonical-json');

const invalid = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/collaboration/platform-invalid.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const sourceHash = (record, field = 'source_sha256') => {
  const copy = clone(record);
  delete copy[field];
  return computeDetachedSha256(createDetachedJsonSnapshot(copy).snapshot);
};
const expectReason = (decision, action, reason) => {
  assert.strictEqual(decision.action, action);
  assert(decision.reasons.includes(reason), `${action} must include ${reason}: ${JSON.stringify(decision)}`);
};

for (const name of ['decideProcessRecovery', 'computeTemporaryManifestSha256', 'decideTemporaryLease', 'validateProgressReport', 'decideRetry']) {
  assert.strictEqual(typeof api[name], 'function', `missing Task 6 helper: ${name}`);
}

const exactIdentity = {
  pid: 49001,
  native_handle: 'handle-49001',
  start_time: '2026-08-29T00:00:00Z',
  exe_path_hash: hash('node.exe'),
  argv_hash: hash('marker argv'),
  parent_identity_hash: hash('parent'),
  nonce: 'marker-nonce',
  native_process_manager_run_id: 'native-run-1',
};
const processBase = {
  owner_status: 'owned',
  duplicate_run_lock: false,
  orphaned: false,
  expected_identity: exactIdentity,
  observed_identity: clone(exactIdentity),
  expected_generation: 4,
  observed_generation: 4,
  expected_scope: { kind: 'purpose', value: 'platform-marker' },
  observed_scope: { kind: 'purpose', value: 'platform-marker' },
  graceful: { requested: false, deadline_reached: false, exit_observed: false },
  exact_tree_termination_supported: true,
  absence: { process_absent: false, thread_absent: false, port_absent: false },
};

expectReason(api.decideProcessRecovery(processBase), 'REQUEST_GRACEFUL', 'GRACEFUL_NOT_REQUESTED');
expectReason(api.decideProcessRecovery({ ...processBase, graceful: { requested: true, deadline_reached: false, exit_observed: false } }), 'WAIT_BOUNDED', 'GRACEFUL_WINDOW_OPEN');
expectReason(api.decideProcessRecovery({ ...processBase, orphaned: true, graceful: { requested: true, deadline_reached: true, exit_observed: false } }), 'TERMINATE_EXACT_TREE', 'EXACT_OWNED_TREE');
expectReason(api.decideProcessRecovery({ ...processBase, duplicate_run_lock: true }), 'HOLD', 'DUPLICATE_RUN_LOCK');
expectReason(api.decideProcessRecovery({ ...processBase, owner_status: 'unknown' }), 'HOLD', 'OWNER_NOT_EXACT');
expectReason(api.decideProcessRecovery({ ...processBase, observed_identity: { ...exactIdentity, argv_hash: 'not_observable' } }), 'OBSERVE_ONLY', 'IDENTITY_PARTIAL');
expectReason(api.decideProcessRecovery({ ...processBase, graceful: { requested: true, deadline_reached: true, exit_observed: false }, exact_tree_termination_supported: false }), 'HOLD', 'EXACT_TREE_TERMINATION_UNSUPPORTED');
expectReason(api.decideProcessRecovery({ ...processBase, graceful: { requested: true, deadline_reached: true, exit_observed: true }, absence: { process_absent: true, thread_absent: true, port_absent: true } }), 'OBSERVE_ONLY', 'ABSENCE_VERIFIED');

for (const fixture of invalid.process_identity_drifts) {
  const observed = clone(exactIdentity);
  observed[fixture.field] = fixture.value;
  expectReason(api.decideProcessRecovery({ ...processBase, observed_identity: observed }), 'HOLD', fixture.reason);
}
for (const fixture of invalid.process_scope_drifts) {
  expectReason(api.decideProcessRecovery({ ...processBase, expected_scope: fixture.expected, observed_scope: fixture.observed }), 'HOLD', fixture.reason);
}

const policy = (policyId, kind, values) => {
  const record = { policy_id: policyId, kind, source_kind: 'synthetic_test_fixture', observed_at: '2026-08-29T00:00:00Z', values, evidence_refs: [`${policyId}-evidence`], source_sha256: '0'.repeat(64) };
  record.source_sha256 = sourceHash(record);
  return record;
};
const policyIndex = {
  'quota-test': policy('quota-test', 'quota', { soft_quota: 64, hard_quota: 128, unit: 'bytes' }),
  'watermark-test': policy('watermark-test', 'watermark', { low_watermark: 100, critical_watermark: 50, unit: 'bytes_available' }),
  'progress-test': policy('progress-test', 'progress', { no_progress_windows: 3 }),
  'retry-test': policy('retry-test', 'retry', { max_attempts: 2, backoff_schedule_ms: [10, 20], jitter_max_ms: 5 }),
};
const windowsRoot = 'C:\\Users\\tester\\.codex\\tmp\\dw-platform-test';
const posixRoot = '/tmp/dw-platform-test';
const canonicalRoot = process.platform === 'win32' ? windowsRoot : posixRoot;
const childPath = process.platform === 'win32' ? `${canonicalRoot}\\child-A` : `${canonicalRoot}/child-A`;
const manifest = {
  owner_id: 'root',
  run_id: 'run-A',
  session_id: 'session-A',
  lease_generation: 4,
  canonical_root_identity: { canonical_path: canonicalRoot, path_identity_hash: hash(canonicalRoot), parent_identity_hash: hash(path.dirname(canonicalRoot)), platform: process.platform },
  created_at: '2026-08-29T00:00:00Z',
  quota_profile_ref: 'quota-test',
  watermark_policy_ref: 'watermark-test',
  child_sublease_map: {
    'child-A': { owner_id: 'child-A', canonical_descendant: childPath, nonce: 'child-nonce', lease_generation: 4, soft_quota: 64, hard_quota: 128, teardown_condition: 'task_complete' },
  },
  retention_set: [],
  state: 'ACTIVE',
  manifest_sha256: '0'.repeat(64),
};
manifest.manifest_sha256 = api.computeTemporaryManifestSha256(manifest);
const tempObservation = {
  owner_id: 'root', run_id: 'run-A', session_id: 'session-A', lease_generation: 4,
  canonical_root_identity: clone(manifest.canonical_root_identity), child_path: childPath,
  usage: 32, available: 200, ttl_expired: false, active_handles: 0, quiescent: true,
  identity_observed: true, reparse_boundary: false, path_rebound: false, retention_set_sealed: true,
  retention_set_hash: hash(JSON.stringify(manifest.retention_set)), teardown_condition_met: true,
  precheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
  postcheck_identity_hash: manifest.canonical_root_identity.path_identity_hash,
};

expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: tempObservation, policyIndex }), 'ALLOW_WRITE', 'WITHIN_POLICY');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: { ...tempObservation, usage: 80 }, policyIndex }), 'STOP_EXPANSION', 'SOFT_QUOTA_REACHED');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: { ...tempObservation, usage: 128 }, policyIndex }), 'STOP_DISPATCH', 'HARD_QUOTA_EXCEEDED');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: { ...tempObservation, usage: 129 }, policyIndex }), 'STOP_DISPATCH', 'HARD_QUOTA_EXCEEDED');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: { ...tempObservation, available: 90 }, policyIndex }), 'STOP_EXPANSION', 'LOW_WATERMARK');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: { ...tempObservation, available: 40 }, policyIndex }), 'STOP_DISPATCH', 'CRITICAL_WATERMARK');
const missingPolicy = clone(policyIndex); delete missingPolicy['quota-test'];
const unverifiedPolicy = api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'write', observation: tempObservation, policyIndex: missingPolicy });
expectReason(unverifiedPolicy, 'OBSERVE_ONLY', 'POLICY_NOT_OBSERVABLE');
assert.strictEqual(unverifiedPolicy.observability, 'UNVERIFIED');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: { ...tempObservation, ttl_expired: true, active_handles: 1, quiescent: false }, policyIndex }), 'OBSERVE_ONLY', 'TTL_WITH_ACTIVE_HANDLE');
const trustedFilesystemResolver = ({ purpose }) => purpose === 'temporary_reclaim';
const reclaim = api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: { ...tempObservation, ttl_expired: true }, policyIndex, trustedFilesystemResolver });
expectReason(reclaim, 'RECLAIM_EXACT', 'RECLAIM_PRECONDITIONS_VERIFIED');
assert.strictEqual(reclaim.requires_same_parent_quarantine, true);
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: { ...tempObservation, ttl_expired: true }, policyIndex }), 'HOLD', 'RECLAIM_TRUST_NOT_PROVEN');
const missingReparseObservation = clone(tempObservation); delete missingReparseObservation.reparse_boundary;
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: missingReparseObservation, policyIndex, trustedFilesystemResolver }), 'HOLD', 'LEASE_IDENTITY_MISMATCH');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: { ...tempObservation, teardown_condition_met: false }, policyIndex }), 'HOLD', 'RECLAIM_PRECONDITION_MISSING');
expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation: { ...tempObservation, retention_set_hash: hash('wrong-retention') }, policyIndex }), 'HOLD', 'RECLAIM_PRECONDITION_MISSING');

for (const fixture of invalid.temporary_boundaries) {
  const observation = clone(tempObservation);
  observation[fixture.field] = fixture.value === '__OUTSIDE__'
    ? (process.platform === 'win32' ? 'C:\\Users\\tester\\outside' : '/tmp/outside')
    : fixture.value;
  expectReason(api.decideTemporaryLease({ manifest, child_id: 'child-A', intent: 'reclaim', observation, policyIndex }), 'HOLD', fixture.reason);
}
const reboundManifest = clone(manifest); reboundManifest.owner_id = 'other-root'; reboundManifest.manifest_sha256 = api.computeTemporaryManifestSha256(reboundManifest);
expectReason(api.decideTemporaryLease({ manifest: reboundManifest, child_id: 'child-A', intent: 'reclaim', observation: tempObservation, policyIndex }), 'HOLD', 'LEASE_IDENTITY_MISMATCH');
const partialManifest = clone(manifest); delete partialManifest.retention_set;
expectReason(api.decideTemporaryLease({ manifest: partialManifest, child_id: 'child-A', intent: 'write', observation: tempObservation, policyIndex }), 'HOLD', 'TEMP_MANIFEST_INVALID');

const progressReport = {
  counts: { successful: 1, failed: 0, completed: 1, pending: 1 },
  return_code_distribution: { '0': 1 },
  liveness: { child: 'alive', process: 'alive', thread: 'not_observable', identity_confidence: 'MATCH' },
  newest_artifact: { path_hash: hash('artifact'), last_write_at: '2026-08-29T00:00:01Z' },
  resource_usage: { cpu: 0.1, gpu: 'not_observable', memory: 1024, io: 10 },
  temp: { usage: 32, quota_profile_ref: 'quota-test', disk_watermark: 200, watermark_policy_ref: 'watermark-test' },
  coordination: { blockers: [], external_wait: null, retry_state: 'idle', circuit_state: 'closed' },
  last_meaningful_progress: { observed_at: '2026-08-29T00:00:01Z', evidence_refs: ['heartbeat-1'] },
  next_gate: 'collect', progress_policy_ref: 'progress-test',
  windows: [{ cpu_delta: 0.1, io_delta: 0, artifact_write: false, heartbeat: false, external_wait: null }],
};
let progress = api.validateProgressReport(progressReport, { policyIndex });
assert.strictEqual(progress.valid, true); assert.strictEqual(progress.classification, 'QUIET_PROGRESS');
const externalWaitReport = clone(progressReport); externalWaitReport.windows = [{ cpu_delta: 0, io_delta: 0, artifact_write: false, heartbeat: false, external_wait: { job_identity: 'external-job-1', next_check_at: '2026-08-29T00:01:00Z', evidence_refs: ['external-1'] } }];
progress = api.validateProgressReport(externalWaitReport, { policyIndex }); assert.strictEqual(progress.classification, 'EXTERNAL_WAIT');
const hungReport = clone(progressReport); hungReport.windows = Array.from({ length: 3 }, () => ({ cpu_delta: 0, io_delta: 0, artifact_write: false, heartbeat: false, external_wait: null }));
progress = api.validateProgressReport(hungReport, { policyIndex }); assert.strictEqual(progress.classification, 'SUSPECTED_HUNG');
const percentageOnly = { percent: 50, next_gate: 'collect' };
progress = api.validateProgressReport(percentageOnly, { policyIndex }); assert.strictEqual(progress.valid, false); assert(progress.errors.some((item) => item.code === 'PROGRESS_REPORT_INCOMPLETE'));
const incompleteNewestArtifact = clone(progressReport); incompleteNewestArtifact.newest_artifact = { path_hash: 'not-a-hash' };
progress = api.validateProgressReport(incompleteNewestArtifact, { policyIndex }); assert.strictEqual(progress.valid, false); assert(progress.errors.some((item) => item.code === 'PROGRESS_REPORT_INCOMPLETE'));
const invalidProgressTime = clone(progressReport); invalidProgressTime.last_meaningful_progress.observed_at = 'soon';
progress = api.validateProgressReport(invalidProgressTime, { policyIndex }); assert.strictEqual(progress.valid, false); assert(progress.errors.some((item) => item.code === 'PROGRESS_REPORT_INCOMPLETE'));
const noProgressPolicy = clone(policyIndex); delete noProgressPolicy['progress-test'];
progress = api.validateProgressReport(hungReport, { policyIndex: noProgressPolicy }); assert.strictEqual(progress.classification, 'UNVERIFIED');

const retryBase = { transient: true, side_effect_state: 'none', idempotency_key: 'idem-1', attempts: 1, failure_fingerprint: 'phase:cmd:hash:error:env:none', retry_policy_ref: 'retry-test' };
expectReason(api.decideRetry(retryBase, { policyIndex }), 'RETRY', 'TRANSIENT_IDEMPOTENT');
expectReason(api.decideRetry({ ...retryBase, attempts: 2 }, { policyIndex }), 'OPEN_CIRCUIT', 'RETRY_BUDGET_EXHAUSTED');
expectReason(api.decideRetry({ ...retryBase, repeated_failure: true }, { policyIndex }), 'OPEN_CIRCUIT', 'RETRY_BUDGET_EXHAUSTED');
expectReason(api.decideRetry({ ...retryBase, side_effect_state: 'unknown' }, { policyIndex }), 'HOLD', 'SIDE_EFFECT_STATE_NOT_CLEAN');
expectReason(api.decideRetry({ ...retryBase, idempotency_key: '' }, { policyIndex }), 'HOLD', 'IDEMPOTENCY_KEY_REQUIRED');

async function runMarker() {
  if (process.platform !== 'win32') {
    console.log(`SKIP_NOT_APPLICABLE:windows:host is ${process.platform}`);
    console.log('platform lifecycle contract passed');
    return;
  }
  console.log('SKIP_NOT_APPLICABLE:posix:host is win32');
  const sandboxRoot = process.env.DW_PLATFORM_SANDBOX_ROOT;
  assert(sandboxRoot, 'DW_PLATFORM_SANDBOX_ROOT is required for the applicable Windows marker test');
  const markerPath = path.join(sandboxRoot, 'marker-observed.json');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  fs.rmSync(markerPath, { force: true });
  const script = `const fs=require('fs'),crypto=require('crypto');const h=v=>crypto.createHash('sha256').update(String(v)).digest('hex');fs.writeFileSync(${JSON.stringify(markerPath)},JSON.stringify({pid:process.pid,parent:process.ppid,start_time:new Date().toISOString(),exe_path_hash:h(process.execPath),argv_hash:h(JSON.stringify(process.argv)),parent_identity_hash:h(process.ppid),native_process_manager_run_id:process.env.DW_PLATFORM_NATIVE_RUN_ID||'not_available'}));process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(23),15000);`;
  const child = spawn(process.execPath, ['-e', script], { cwd: sandboxRoot, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const pid = child.pid;
  let exited = false;
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(markerPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert(fs.existsSync(markerPath), 'owned marker did not publish liveness evidence');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.strictEqual(marker.pid, pid); assert.strictEqual(marker.parent, process.pid);
    assert.match(marker.start_time, /^\d{4}-\d{2}-\d{2}T/); assert.match(marker.exe_path_hash, /^[0-9a-f]{64}$/);
    assert.match(marker.argv_hash, /^[0-9a-f]{64}$/); assert.strictEqual(marker.parent_identity_hash, hash(process.pid));
    assert.strictEqual(marker.native_process_manager_run_id, process.env.DW_PLATFORM_NATIVE_RUN_ID || 'not_available');
    child.stdin.end('graceful\n');
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    exited = true;
    assert.strictEqual(exitCode, 0);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (!exited) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  console.log('platform lifecycle contract passed');
}

runMarker().catch((caught) => { console.error(caught && caught.stack ? caught.stack : caught); process.exitCode = 1; });
