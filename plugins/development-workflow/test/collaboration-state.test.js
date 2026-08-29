#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const api = require(path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact'));
const invalidFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collaboration', 'state-invalid.json'), 'utf8'));
const schemaPath = path.join(pluginRoot, 'skills', 'dw-collaboration', 'references', 'schemas', 'ResourceLedger1.schema.json');

const EXPECTED_RUN_EDGES = {
  PLANNING: ['PLAN_VALIDATED', 'CANCELLING', 'FAILED', 'HOLD'],
  PLAN_VALIDATED: ['AUTHORIZED', 'CANCELLING', 'FAILED', 'HOLD'],
  AUTHORIZED: ['LEDGER_OPEN', 'CANCELLING', 'FAILED', 'HOLD'],
  LEDGER_OPEN: ['DISPATCHING', 'RUNNING', 'CANCELLING', 'FAILED', 'HOLD'],
  DISPATCHING: ['RUNNING', 'CANCELLING', 'FAILED', 'HOLD'],
  RUNNING: ['COLLECTING', 'ROOT_REVIEW', 'CANCELLING', 'FAILED', 'HOLD'],
  COLLECTING: ['ROOT_REVIEW', 'CANCELLING', 'FAILED', 'HOLD'],
  ROOT_REVIEW: ['VERIFYING', 'CANCELLING', 'FAILED', 'HOLD'],
  VERIFYING: ['RECLAIMING', 'CANCELLING', 'FAILED', 'HOLD'],
  CANCELLING: ['RECLAIMING', 'HOLD'],
  FAILED: ['RECLAIMING', 'HOLD'],
  RECLAIMING: ['COMPLETE', 'CANCELLED', 'FAILED_RECLAIMED', 'HOLD'],
  COMPLETE: [], CANCELLED: [], FAILED_RECLAIMED: [], HOLD: [],
};
const EXPECTED_CHILD_EDGES = {
  DECLARED: ['DISPATCH_REQUESTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  DISPATCH_REQUESTED: ['DISPATCH_ACKED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  DISPATCH_ACKED: ['START_OBSERVED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  START_OBSERVED: ['WORKING', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  WORKING: ['QUIET_PROGRESS', 'EXTERNAL_WAIT', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  QUIET_PROGRESS: ['WORKING', 'EXTERNAL_WAIT', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  EXTERNAL_WAIT: ['WORKING', 'QUIET_PROGRESS', 'SUSPECTED_HUNG', 'RESULT_SUBMITTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  SUSPECTED_HUNG: ['WORKING', 'INTERRUPT_REQUESTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_SUBMITTED: ['RESULT_ACCEPTED', 'RESULT_REJECTED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_REJECTED: ['WORKING', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  RESULT_ACCEPTED: ['REVIEWED', 'CANCEL_REQUESTED', 'FAILED', 'UNKNOWN'],
  REVIEWED: ['VERIFIED', 'FAILED', 'UNKNOWN'],
  VERIFIED: ['CLOSED', 'UNKNOWN'],
  INTERRUPT_REQUESTED: ['EXIT_OBSERVED', 'FAILED', 'UNKNOWN'],
  CANCEL_REQUESTED: ['INTERRUPT_REQUESTED', 'EXIT_OBSERVED', 'FAILED', 'UNKNOWN'],
  FAILED: ['EXIT_OBSERVED', 'CLOSED', 'UNKNOWN'],
  EXIT_OBSERVED: ['CLOSED', 'UNKNOWN'],
  CLOSED: [], UNKNOWN: [],
};
const EXPECTED_RESOURCE_EDGES = {
  DECLARED: ['LEASED', 'UNKNOWN', 'QUARANTINED'],
  LEASED: ['START_REQUESTED', 'ACTIVE', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  START_REQUESTED: ['ACTIVE', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  ACTIVE: ['QUIESCING', 'TERMINATE_REQUESTED', 'EXIT_OBSERVED', 'RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  QUIESCING: ['ACTIVE', 'TERMINATE_REQUESTED', 'EXIT_OBSERVED', 'UNKNOWN', 'QUARANTINED'],
  TERMINATE_REQUESTED: ['EXIT_OBSERVED', 'UNKNOWN', 'QUARANTINED'],
  EXIT_OBSERVED: ['RECLAIMING', 'UNKNOWN', 'QUARANTINED'],
  RECLAIMING: ['RECLAIMED', 'RETAINED', 'UNKNOWN', 'QUARANTINED'],
  RECLAIMED: [], RETAINED: [], UNKNOWN: [], QUARANTINED: [],
};

for (const name of ['RUN_EDGES', 'CHILD_EDGES', 'RESOURCE_EDGES', 'RUN_STATES', 'CHILD_STATES', 'RESOURCE_STATES', 'RESOURCE_EVENT_KINDS', 'canTransition', 'compareProcessIdentity', 'reduceLifecycleEvents', 'reduceResourceEvents', 'validateResourceLedger']) {
  assert(Object.prototype.hasOwnProperty.call(api, name), `RED: state-machine API is absent: ${name}`);
}
assert.deepStrictEqual(api.RUN_EDGES, EXPECTED_RUN_EDGES);
assert.deepStrictEqual(api.CHILD_EDGES, EXPECTED_CHILD_EDGES);
assert.deepStrictEqual(api.RESOURCE_EDGES, EXPECTED_RESOURCE_EDGES);
for (const [machine, edges, states] of [['run', api.RUN_EDGES, api.RUN_STATES], ['child', api.CHILD_EDGES, api.CHILD_STATES], ['resource', api.RESOURCE_EDGES, api.RESOURCE_STATES]]) {
  assert.deepStrictEqual(states, Object.keys(edges));
  for (const from of states) for (const to of states) assert.strictEqual(api.canTransition(machine, from, to), edges[from].includes(to), `${machine}:${from}->${to}`);
}
assert.strictEqual(api.canTransition('unknown', 'A', 'B'), false);

assert(fs.existsSync(schemaPath), 'RED: ResourceLedger1 schema is absent');
const ledgerSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
assert.strictEqual(ledgerSchema.properties.schema.const, 'ResourceLedger1');
assert.deepStrictEqual(ledgerSchema.$defs.resource.properties.type.enum, ['agent_session', 'runtime_thread', 'process_tree', 'terminal_session', 'command_session', 'port', 'temporary_allocation', 'artifact', 'constrained_compute']);
assert.deepStrictEqual(ledgerSchema.$defs.resource.properties.state.enum, api.RESOURCE_STATES);
assert.strictEqual(ledgerSchema.properties.run_events.maxItems, 4096);
assert.strictEqual(ledgerSchema.properties.run_events.minItems, 1, 'a ledger must contain its canonical run stream');
assert.strictEqual(ledgerSchema.properties.child_events.maxItems, 4096);
assert.strictEqual(ledgerSchema.properties.resource_events.maxItems, 4096);
assert.strictEqual(ledgerSchema.properties.resources.maxItems, 256);
assert.strictEqual(ledgerSchema.properties.run_events.items.$ref, '#/$defs/runLifecycleEvent');
assert.strictEqual(ledgerSchema.properties.child_events.items.$ref, '#/$defs/childLifecycleEvent');
assert.strictEqual(ledgerSchema.$defs.runLifecycleEvent.allOf[1].properties.machine.const, 'run');
assert.strictEqual(ledgerSchema.$defs.childLifecycleEvent.allOf[1].properties.machine.const, 'child');
assert(ledgerSchema.$defs.resource.required.includes('sublease_ref'));
assert.strictEqual(ledgerSchema.$defs.resourceEvent.properties.postconditions.additionalProperties, false);
assert(api.RESOURCE_EVENT_KINDS.includes('RETAIN_ARTIFACT'), 'retained artifact must have one canonical event kind');
assert(ledgerSchema.$defs.resourceEvent.properties.event_kind.enum.includes('RETAIN_ARTIFACT'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sourceHash(record) { const detached = clone(record); delete detached.source_sha256; return crypto.createHash('sha256').update(api.canonicalize(detached), 'utf8').digest('hex'); }
function sealed(record) { const value = clone(record); value.source_sha256 = sourceHash(value); return value; }
function expectStateError(fn, code) { assert.throws(fn, (error) => error && error.name === 'StateMachineError' && error.code === code, `expected ${code}`); }
function expectValidationCode(result, code) { assert.strictEqual(result.valid, false); assert(result.errors.some((error) => error.code === code), `${code}: ${JSON.stringify(result.errors)}`); }
function lifecycleEvent(machine, subjectId, sequence, fromState, toState, overrides = {}) {
  return { event_id: `${machine}-${subjectId}-${sequence}`, machine, subject_id: subjectId, from_state: fromState, to_state: toState, sequence,
    observed_at: `2026-08-26T03:${String(sequence).padStart(2, '0')}:00Z`, actor_role: 'root', actor_id: 'root-A', plan_generation: 1,
    evidence_refs: [`evidence-${sequence}`], guard_refs: [], supersedes_event_id: null, ...overrides };
}
function lifecycleTrace(machine, subjectId, states) { return states.map((state, index) => lifecycleEvent(machine, subjectId, index + 1, index === 0 ? null : states[index - 1], state)); }

const planRef = { artifact_id: 'plan-A', content_sha256: 'a'.repeat(64) };
function authority(authorityId, actorRole, actorId) {
  return sealed({ authority_id: authorityId, run_id: 'run-A', subject_id: '*', plan_generation: 1, actor_role: actorRole, actor_id: actorId,
    valid_from: '2026-08-26T03:00:00Z', valid_until: '2026-08-26T05:00:00Z', evidence_refs: [`${authorityId}-evidence`], source_sha256: '0'.repeat(64) });
}
const authorityIndex = {
  'authority-root-A': authority('authority-root-A', 'root', 'root-A'),
  'authority-verifier-A': authority('authority-verifier-A', 'verifier', 'verifier-A'),
};
const validatedPlan = sealed({ plan_artifact_id: planRef.artifact_id, content_sha256: planRef.content_sha256, run_id: 'run-A', session_id: 'sess-A', plan_generation: 1,
  status: 'AUTHORIZED', validated_at: '2026-08-26T03:00:00Z', validated_by_authority_ref: 'authority-root-A', evidence_refs: ['validated-plan-evidence'], source_sha256: '0'.repeat(64) });
const planIndex = { [planRef.artifact_id]: validatedPlan };
function guardRecord(event, guardId, kind, payload, authorityRef = 'authority-root-A') {
  return sealed({ guard_id: guardId, run_id: 'run-A', machine: event.machine, subject_id: event.subject_id, plan_generation: event.plan_generation,
    from_state: event.from_state, to_state: event.to_state, kind, observed_at: event.observed_at, actor_role: event.actor_role, actor_id: event.actor_id,
    actor_authority_ref: authorityRef, evidence_refs: [`${guardId}-evidence`], payload: clone(payload), source_sha256: '0'.repeat(64) });
}

const runTrace = lifecycleTrace('run', 'run-A', ['PLANNING', 'PLAN_VALIDATED', 'AUTHORIZED', 'LEDGER_OPEN', 'DISPATCHING', 'RUNNING', 'COLLECTING', 'ROOT_REVIEW', 'VERIFYING', 'RECLAIMING', 'COMPLETE']);
const guardIndex = {};
guardIndex['guard-ledger-open'] = guardRecord(runTrace[4], 'guard-ledger-open', 'ledger_open', {});
guardIndex['guard-terminal-complete'] = guardRecord(runTrace[10], 'guard-terminal-complete', 'terminal_intent', { intent: 'COMPLETE' });
guardIndex['guard-terminal-sealed'] = guardRecord(runTrace[10], 'guard-terminal-sealed', 'terminal_intent_seal', { intent: 'COMPLETE', intent_guard_id: 'guard-terminal-complete', intent_source_sha256: guardIndex['guard-terminal-complete'].source_sha256 });
guardIndex['guard-resources-reclaimed'] = guardRecord(runTrace[10], 'guard-resources-reclaimed', 'resources_reclaimed', { resource_ids: ['process-A'], resource_snapshot_sha256: 'd'.repeat(64) });
runTrace[4].guard_refs = ['guard-ledger-open'];
runTrace[10].guard_refs = ['guard-terminal-complete', 'guard-terminal-sealed', 'guard-resources-reclaimed'];
const trustedAuthorityResolver = (record, context) => (
  Object.isFrozen(record)
  && Object.isFrozen(context)
  && record.authority_id === context.authorityRef
);
const lifecycleOptions = { runId: 'run-A', planGeneration: 1, guardIndex, authorityIndex, trustedAuthorityResolver };
const runSnapshots = api.reduceLifecycleEvents(runTrace, lifecycleOptions);
assert.strictEqual(runSnapshots[0].state, 'COMPLETE');
assert.strictEqual(runSnapshots[0].sequence, 11);
const missingTrustedAuthority = { ...lifecycleOptions }; delete missingTrustedAuthority.trustedAuthorityResolver;
expectStateError(() => api.reduceLifecycleEvents(runTrace, missingTrustedAuthority), 'AUTHORITY_TRUST_NOT_PROVEN');
expectStateError(() => api.reduceLifecycleEvents(runTrace, { ...lifecycleOptions, trustedAuthorityResolver: () => false }), 'AUTHORITY_TRUST_NOT_PROVEN');
expectStateError(() => api.reduceLifecycleEvents(runTrace, { ...lifecycleOptions, trustedAuthorityResolver: () => ({ trusted: true }) }), 'AUTHORITY_TRUST_NOT_PROVEN');
expectStateError(() => api.reduceLifecycleEvents(runTrace, { ...lifecycleOptions, trustedAuthorityResolver: () => { throw new Error('resolver rejected'); } }), 'AUTHORITY_TRUST_NOT_PROVEN');
const unresolvedGuardTrace = clone(runTrace); unresolvedGuardTrace[4].guard_refs = ['ledger_open'];
expectStateError(() => api.reduceLifecycleEvents(unresolvedGuardTrace, lifecycleOptions), 'GUARD_REFERENCE_UNRESOLVED');
const wrongIntent = guardRecord(runTrace[10], 'guard-terminal-cancelled', 'terminal_intent', { intent: 'CANCELLED' });
const wrongSeal = guardRecord(runTrace[10], 'guard-terminal-cancelled-seal', 'terminal_intent_seal', { intent: 'CANCELLED', intent_guard_id: wrongIntent.guard_id, intent_source_sha256: wrongIntent.source_sha256 });
const wrongTerminalTrace = clone(runTrace); wrongTerminalTrace[10].guard_refs = [wrongIntent.guard_id, wrongSeal.guard_id, 'guard-resources-reclaimed'];
expectStateError(() => api.reduceLifecycleEvents(wrongTerminalTrace, { ...lifecycleOptions, guardIndex: { ...guardIndex, [wrongIntent.guard_id]: wrongIntent, [wrongSeal.guard_id]: wrongSeal } }), 'TERMINAL_INTENT_MISMATCH');
const replayedGuardIndex = clone(guardIndex); replayedGuardIndex['guard-ledger-open'].plan_generation = 2; replayedGuardIndex['guard-ledger-open'].source_sha256 = sourceHash(replayedGuardIndex['guard-ledger-open']);
expectStateError(() => api.reduceLifecycleEvents(runTrace, { ...lifecycleOptions, guardIndex: replayedGuardIndex }), 'GUARD_GENERATION_MISMATCH');
const expiredAuthority = clone(authorityIndex); expiredAuthority['authority-root-A'].valid_until = '2026-08-26T03:30:00Z'; expiredAuthority['authority-root-A'].source_sha256 = sourceHash(expiredAuthority['authority-root-A']);
const staleDispatch = clone(runTrace.slice(0, 5)); staleDispatch[4].observed_at = '2026-08-26T04:00:00Z';
expectStateError(() => api.reduceLifecycleEvents(staleDispatch, { ...lifecycleOptions, authorityIndex: expiredAuthority }), 'GUARD_ACTOR_UNAUTHORIZED');
const dispatchWithoutLedger = clone(runTrace.slice(0, 5)); dispatchWithoutLedger[4].guard_refs = [];
expectStateError(() => api.reduceLifecycleEvents(dispatchWithoutLedger, lifecycleOptions), 'LEDGER_BEFORE_DISPATCH_REQUIRED');
const terminalRollback = [...runTrace, lifecycleEvent('run', 'run-A', 12, 'COMPLETE', 'RUNNING')];
expectStateError(() => api.reduceLifecycleEvents(terminalRollback, lifecycleOptions), 'ILLEGAL_TRANSITION');

const childTrace = lifecycleTrace('child', 'child-A', ['DECLARED', 'DISPATCH_REQUESTED', 'DISPATCH_ACKED', 'START_OBSERVED', 'WORKING', 'RESULT_SUBMITTED', 'RESULT_ACCEPTED', 'REVIEWED', 'VERIFIED', 'CLOSED']);
childTrace[8].actor_role = 'verifier'; childTrace[8].actor_id = 'verifier-A';
guardIndex['guard-result-acceptance'] = guardRecord(childTrace[6], 'guard-result-acceptance', 'result_acceptance', { result_sha256: 'e'.repeat(64) });
guardIndex['guard-result-review'] = guardRecord(childTrace[7], 'guard-result-review', 'result_review', { acceptance_guard_id: 'guard-result-acceptance', result_sha256: 'e'.repeat(64) });
guardIndex['guard-result-verification'] = guardRecord(childTrace[8], 'guard-result-verification', 'result_verification', { review_guard_id: 'guard-result-review', result_sha256: 'e'.repeat(64) }, 'authority-verifier-A');
childTrace[6].guard_refs = ['guard-result-acceptance']; childTrace[7].guard_refs = ['guard-result-review']; childTrace[8].guard_refs = ['guard-result-verification'];
assert.strictEqual(api.reduceLifecycleEvents(childTrace, lifecycleOptions)[0].state, 'CLOSED');
const childSelfAccepted = clone(childTrace); childSelfAccepted[6].guard_refs = [];
expectStateError(() => api.reduceLifecycleEvents(childSelfAccepted, lifecycleOptions), 'ROOT_ACCEPTANCE_REQUIRED');
const reworkTrace = lifecycleTrace('child', 'child-B', ['DECLARED', 'DISPATCH_REQUESTED', 'DISPATCH_ACKED', 'START_OBSERVED', 'WORKING', 'RESULT_SUBMITTED', 'RESULT_REJECTED', 'WORKING']);
expectStateError(() => api.reduceLifecycleEvents(reworkTrace, lifecycleOptions), 'NEW_PACKET_VERSION_REQUIRED');
guardIndex['guard-new-packet'] = guardRecord(reworkTrace[7], 'guard-new-packet', 'new_packet_version', { packet_version: 2, packet_sha256: 'f'.repeat(64) });
reworkTrace[7].guard_refs = ['guard-new-packet'];
assert.strictEqual(api.reduceLifecycleEvents(reworkTrace, lifecycleOptions)[0].state, 'WORKING');
const repeatedRework = lifecycleTrace('child', 'child-B', ['DECLARED', 'DISPATCH_REQUESTED', 'DISPATCH_ACKED', 'START_OBSERVED', 'WORKING', 'RESULT_SUBMITTED', 'RESULT_REJECTED', 'WORKING', 'RESULT_SUBMITTED', 'RESULT_REJECTED', 'WORKING']);
repeatedRework[7].guard_refs = ['guard-new-packet']; repeatedRework[10].guard_refs = ['guard-new-packet'];
expectStateError(() => api.reduceLifecycleEvents(repeatedRework, lifecycleOptions), 'NEW_PACKET_VERSION_REQUIRED');
const freshPacketGuard = guardRecord(repeatedRework[10], 'guard-new-packet-v3', 'new_packet_version', { packet_version: 3, packet_sha256: '1'.repeat(64) });
const freshRework = clone(repeatedRework); freshRework[10].guard_refs = [freshPacketGuard.guard_id];
assert.strictEqual(api.reduceLifecycleEvents(freshRework, { ...lifecycleOptions, guardIndex: { ...guardIndex, [freshPacketGuard.guard_id]: freshPacketGuard } })[0].state, 'WORKING');
const resultJump = lifecycleTrace('child', 'child-C', ['DECLARED', 'DISPATCH_REQUESTED', 'DISPATCH_ACKED', 'START_OBSERVED', 'WORKING', 'RESULT_ACCEPTED']);
expectStateError(() => api.reduceLifecycleEvents(resultJump, lifecycleOptions), 'ILLEGAL_TRANSITION');

const exactIdentity = { pid: 4120, native_handle: 'handle-4120', start_time: '2026-08-26T03:00:00Z', exe_path_hash: 'a'.repeat(64), argv_hash: 'b'.repeat(64), parent_identity_hash: 'c'.repeat(64), nonce: 'nonce-A', native_process_manager_run_id: 'native-run-A', confidence: 'exact' };
assert.strictEqual(api.compareProcessIdentity(exactIdentity, clone(exactIdentity), 1, 1), 'MATCH');
for (const identityCase of invalidFixture.identity_cases) { const observed = clone(exactIdentity); observed[identityCase.field] = identityCase.value; assert.strictEqual(api.compareProcessIdentity(exactIdentity, observed, 1, 1), identityCase.expected, identityCase.name); }
assert.strictEqual(api.compareProcessIdentity(exactIdentity, clone(exactIdentity), 1, 2), 'MISMATCH');
const unavailableIdentity = { ...clone(exactIdentity), native_process_manager_run_id: 'not_available' };
assert.strictEqual(api.compareProcessIdentity(unavailableIdentity, clone(unavailableIdentity), 1, 1), 'MATCH');
assert.strictEqual(api.compareProcessIdentity(exactIdentity, unavailableIdentity, 1, 1), 'MISMATCH');
assert.strictEqual(api.compareProcessIdentity(exactIdentity, { ...clone(exactIdentity), native_process_manager_run_id: 'unknown' }, 1, 1), 'PARTIAL');

function resourceEntry(resourceId = 'process-A', type = 'process_tree') {
  return { resource_id: resourceId, type, owner_role: 'root', owner_id: 'root-A', parent_resource_id: null, sublease_ref: null, lease_generation: 1, state: 'DECLARED', identity: clone(exactIdentity), created_by_event: `${resourceId}-1`,
    scope: { purpose: 'focused-test', cwd_logical_id: 'workspace-A', timeout_seconds: 120, temporary_root_logical_id: 'run-root-A', stop_condition: 'exit' }, quota_policy: { profile_ref: 'local-test' },
    cleanup_policy: { strategy: 'graceful_then_exact_identity_bound', teardown_condition: 'identity-bound absence verified' }, last_verified_at: null, evidence_refs: ['before-A'] };
}
function resourceEvent(entry, sequence, kind, fromState, toState, overrides = {}) {
  return { event_id: `${entry.resource_id}-${sequence}`, resource_id: entry.resource_id, event_kind: kind, from_state: fromState, to_state: toState, sequence,
    observed_at: `2026-08-26T04:${String(sequence).padStart(2, '0')}:00Z`, actor_role: entry.owner_role, actor_id: entry.owner_id, lease_generation: entry.lease_generation,
    identity_ref: 'identity-A', evidence_refs: [`resource-evidence-${sequence}`], postconditions: {}, supersedes_event_id: null, ...overrides };
}
function processResourceTrace(entry) { return [
  resourceEvent(entry, 1, 'DECLARE', null, 'DECLARED'), resourceEvent(entry, 2, 'LEASE', 'DECLARED', 'LEASED'), resourceEvent(entry, 3, 'REQUEST_START', 'LEASED', 'START_REQUESTED'),
  resourceEvent(entry, 4, 'OBSERVE_ACTIVE', 'START_REQUESTED', 'ACTIVE'), resourceEvent(entry, 5, 'REQUEST_TERMINATE', 'ACTIVE', 'TERMINATE_REQUESTED'),
  resourceEvent(entry, 6, 'OBSERVE_EXIT', 'TERMINATE_REQUESTED', 'EXIT_OBSERVED', { postconditions: { identity_result: 'MATCH', liveness_absent: true } }),
  resourceEvent(entry, 7, 'BEGIN_RECLAIM', 'EXIT_OBSERVED', 'RECLAIMING'),
  resourceEvent(entry, 8, 'VERIFY_RECLAIM', 'RECLAIMING', 'RECLAIMED', { postconditions: { identity_result: 'MATCH', liveness_absent: true, owner_verified: true, generation_verified: true } }),
]; }
const processEntry = resourceEntry();
const identityOptions = { runId: 'run-A', planRef, validatedPlanRef: planRef, planIndex, authorityIndex, guardIndex, trustedAuthorityResolver, identityIndex: { 'identity-A': clone(exactIdentity) } };
const resourceSnapshots = api.reduceResourceEvents(processResourceTrace(processEntry), [processEntry], identityOptions);
assert.strictEqual(resourceSnapshots[0].state, 'RECLAIMED');
assert.strictEqual(resourceSnapshots[0].created_by_event, 'process-A-1');
assert(resourceSnapshots[0].evidence_refs.includes('resource-evidence-8'));

const retainedArtifact = resourceEntry('artifact-A', 'artifact');
const retentionRecord = sealed({
  retention_id: 'retention-artifact-A', run_id: 'run-A', plan_ref: clone(planRef), resource_id: retainedArtifact.resource_id,
  policy_ref: 'policy-retain-sealed-evidence', authorized_at: '2026-08-26T04:01:00Z', authorized_by_authority_ref: 'authority-root-A',
  verified_at: '2026-08-26T04:02:00Z', verified_by_authority_ref: 'authority-verifier-A', evidence_refs: ['retention-evidence-A'], source_sha256: '0'.repeat(64),
});
const retainedArtifactTrace = [
  resourceEvent(retainedArtifact, 1, 'DECLARE', null, 'DECLARED'),
  resourceEvent(retainedArtifact, 2, 'LEASE', 'DECLARED', 'LEASED'),
  resourceEvent(retainedArtifact, 3, 'BEGIN_RECLAIM', 'LEASED', 'RECLAIMING', {
    postconditions: { never_started: true, no_side_effects: true, owner_verified: true, generation_verified: true },
  }),
  resourceEvent(retainedArtifact, 4, 'RETAIN_ARTIFACT', 'RECLAIMING', 'RETAINED', {
    postconditions: { owner_verified: true, generation_verified: true, artifact_sealed: true },
  }),
];
const retainedSnapshots = api.reduceResourceEvents(retainedArtifactTrace, [retainedArtifact], {
  ...identityOptions,
  retentionIndex: { [retainedArtifact.resource_id]: retentionRecord },
});
assert.strictEqual(retainedSnapshots[0].state, 'RETAINED');
expectStateError(
  () => api.reduceResourceEvents(retainedArtifactTrace, [retainedArtifact], identityOptions),
  'ARTIFACT_RETENTION_AUTHORIZATION_REQUIRED',
);

const invalidStateJump = processResourceTrace(processEntry); invalidStateJump[2].from_state = 'DECLARED';
expectStateError(() => api.reduceResourceEvents(invalidStateJump, [processEntry], identityOptions), 'RESOURCE_FROM_STATE_MISMATCH');
const outOfOrder = processResourceTrace(processEntry); outOfOrder[3].sequence = 2;
expectStateError(() => api.reduceResourceEvents(outOfOrder, [processEntry], identityOptions), 'EVENT_SEQUENCE_INVALID');
const duplicateEvent = [...processResourceTrace(processEntry), clone(processResourceTrace(processEntry)[7])];
expectStateError(() => api.reduceResourceEvents(duplicateEvent, [processEntry], identityOptions), 'EVENT_ID_DUPLICATE');
const reusedIdentityOptions = { ...identityOptions, identityIndex: { 'identity-A': { ...clone(exactIdentity), start_time: '2026-08-26T03:06:00Z' } } };
expectStateError(() => api.reduceResourceEvents(processResourceTrace(processEntry), [processEntry], reusedIdentityOptions), 'IDENTITY_MISMATCH_REQUIRES_UNKNOWN');
expectStateError(() => api.reduceResourceEvents(processResourceTrace(processEntry), [processEntry], { ...identityOptions, identityIndex: {} }), 'IDENTITY_REFERENCE_UNRESOLVED');
expectStateError(() => api.reduceResourceEvents(processResourceTrace(processEntry), [processEntry], { ...identityOptions, planRef: null }), 'PLAN_BEFORE_LEASE_REQUIRED');
const missingCleanupProof = processResourceTrace(processEntry); missingCleanupProof[7].postconditions = { identity_result: 'MATCH', owner_verified: true, generation_verified: true };
expectStateError(() => api.reduceResourceEvents(missingCleanupProof, [processEntry], identityOptions), 'RECLAIM_POSTCONDITION_MISSING');
const selfReportedCleanup = processResourceTrace(processEntry); selfReportedCleanup[7].postconditions = { child_reported_clean: true };
expectStateError(() => api.reduceResourceEvents(selfReportedCleanup, [processEntry], identityOptions), 'RESOURCE_POSTCONDITIONS_INVALID');
const directProcessReclaim = processResourceTrace(processEntry).slice(0, 4);
directProcessReclaim.push(resourceEvent(processEntry, 5, 'BEGIN_RECLAIM', 'ACTIVE', 'RECLAIMING', { postconditions: { quiescent: true, no_handles: true, owner_verified: true, generation_verified: true } }));
expectStateError(() => api.reduceResourceEvents(directProcessReclaim, [processEntry], identityOptions), 'EXECUTABLE_EXIT_REQUIRED');

const rootlessChild = resourceEntry('rootless-child'); rootlessChild.owner_role = 'child'; rootlessChild.owner_id = 'child-A';
expectStateError(() => api.reduceResourceEvents([resourceEvent(rootlessChild, 1, 'DECLARE', null, 'DECLARED')], [rootlessChild], identityOptions), 'CHILD_PARENT_REQUIRED');
const parentHost = resourceEntry('parent-host', 'agent_session');
const childOwnedHost = resourceEntry('child-host', 'terminal_session'); childOwnedHost.owner_role = 'child'; childOwnedHost.owner_id = 'child-A'; childOwnedHost.parent_resource_id = parentHost.resource_id; childOwnedHost.sublease_ref = 'sublease-child-host';
const sublease = sealed({ sublease_id: 'sublease-child-host', run_id: 'run-A', plan_ref: clone(planRef), resource_id: childOwnedHost.resource_id, parent_resource_id: parentHost.resource_id,
  child_id: 'child-A', lease_generation: 1, authorized_at: '2026-08-26T04:01:00Z', authorized_by_authority_ref: 'authority-root-A', verified_at: '2026-08-26T04:01:30Z',
  verified_by_authority_ref: 'authority-verifier-A', evidence_refs: ['sublease-evidence'], source_sha256: '0'.repeat(64) });
const parentEvents = [resourceEvent(parentHost, 1, 'DECLARE', null, 'DECLARED'), resourceEvent(parentHost, 2, 'LEASE', 'DECLARED', 'LEASED')];
const childHostEvents = [
  resourceEvent(childOwnedHost, 1, 'DECLARE', null, 'DECLARED', { observed_at: '2026-08-26T04:03:00Z' }),
  resourceEvent(childOwnedHost, 2, 'LEASE', 'DECLARED', 'LEASED', { observed_at: '2026-08-26T04:04:00Z' }),
  resourceEvent(childOwnedHost, 3, 'OBSERVE_ACTIVE', 'LEASED', 'ACTIVE', { observed_at: '2026-08-26T04:05:00Z' }),
  resourceEvent(childOwnedHost, 4, 'REQUEST_TERMINATE', 'ACTIVE', 'TERMINATE_REQUESTED', { observed_at: '2026-08-26T04:06:00Z', postconditions: { target_is_host_session: true } }),
];
const childOptions = { ...identityOptions, subleaseIndex: { [sublease.sublease_id]: sublease } };
expectStateError(() => api.reduceResourceEvents([...parentEvents, ...childHostEvents], [parentHost, childOwnedHost], childOptions), 'CHILD_HOST_TERMINATION_FORBIDDEN');
expectStateError(() => api.reduceResourceEvents([parentEvents[0], ...childHostEvents.slice(0, 2)], [parentHost, childOwnedHost], childOptions), 'PARENT_LEASE_EVENT_REQUIRED');
expectStateError(() => api.reduceResourceEvents([...childHostEvents.slice(0, 2), ...parentEvents], [parentHost, childOwnedHost], childOptions), 'PARENT_LEASE_EVENT_REQUIRED');
const parentReclaimingEvents = [
  ...parentEvents,
  resourceEvent(parentHost, 3, 'BEGIN_RECLAIM', 'LEASED', 'RECLAIMING', { observed_at: '2026-08-26T04:03:00Z', postconditions: { never_started: true, no_side_effects: true, owner_verified: true, generation_verified: true } }),
  resourceEvent(childOwnedHost, 1, 'DECLARE', null, 'DECLARED', { observed_at: '2026-08-26T04:04:00Z' }),
  resourceEvent(childOwnedHost, 2, 'LEASE', 'DECLARED', 'LEASED', { observed_at: '2026-08-26T04:05:00Z' }),
];
expectStateError(() => api.reduceResourceEvents(parentReclaimingEvents, [parentHost, childOwnedHost], childOptions), 'PARENT_LEASE_NOT_ACTIVE');
const superseded = processResourceTrace(processEntry); superseded[2].supersedes_event_id = 'missing-event';
expectStateError(() => api.reduceResourceEvents(superseded, [processEntry], identityOptions), 'SUPERSEDED_EVENT_INVALID');

function resourceSeal(entry) {
  return sealed({ resource_id: entry.resource_id, run_id: 'run-A', plan_ref: clone(planRef), launch_card: clone(entry), sealed_at: '2026-08-26T04:00:00Z',
    sealed_by_authority_ref: 'authority-root-A', evidence_refs: [`${entry.resource_id}-seal-evidence`], source_sha256: '0'.repeat(64) });
}
const resourceIndex = { [processEntry.resource_id]: resourceSeal(processEntry) };
const ledgerOptions = { ...identityOptions, resourceIndex };

const validLedger = { schema: 'ResourceLedger1', schema_version: 1, artifact_id: 'ledger-A', run_id: 'run-A', session_id: 'sess-A', created_at: '2026-08-26T04:10:00Z',
  producer: { role: 'root', adapter_id: 'adapter-A' }, redaction: { policy: 'metadata_only' }, plan_ref: clone(planRef),
  run_events: runTrace, child_events: childTrace, resource_events: processResourceTrace(processEntry), resources: resourceSnapshots, content_sha256: '0'.repeat(64) };
validLedger.content_sha256 = api.computeContentSha256(validLedger);
const noPlanIndex = { ...ledgerOptions }; delete noPlanIndex.planIndex;
expectValidationCode(api.validateResourceLedger(validLedger, noPlanIndex), 'PLAN_INDEX_REQUIRED');
const wrongPlanIndex = clone(planIndex); wrongPlanIndex['plan-A'].content_sha256 = 'b'.repeat(64); wrongPlanIndex['plan-A'].source_sha256 = sourceHash(wrongPlanIndex['plan-A']);
expectValidationCode(api.validateResourceLedger(validLedger, { ...ledgerOptions, planIndex: wrongPlanIndex }), 'VALIDATED_PLAN_BINDING_MISMATCH');
expectValidationCode(api.validateResourceLedger(validLedger, identityOptions), 'RESOURCE_INDEX_REQUIRED');
const validLedgerResult = api.validateResourceLedger(validLedger, ledgerOptions);
assert.strictEqual(validLedgerResult.valid, true, JSON.stringify(validLedgerResult.errors));
const untrustedLedgerOptions = { ...ledgerOptions }; delete untrustedLedgerOptions.trustedAuthorityResolver;
expectValidationCode(api.validateResourceLedger(validLedger, untrustedLedgerOptions), 'AUTHORITY_TRUST_NOT_PROVEN');
function reclaimedTerminalTrace(outcome) {
  const trace = clone(runTrace.slice(0, 10));
  const terminal = lifecycleEvent('run', 'run-A', 11, 'RECLAIMING', outcome);
  const suffix = outcome.toLowerCase();
  const intent = guardRecord(terminal, `guard-terminal-${suffix}`, 'terminal_intent', { intent: outcome });
  const intentSeal = guardRecord(terminal, `guard-terminal-${suffix}-seal`, 'terminal_intent_seal', {
    intent: outcome, intent_guard_id: intent.guard_id, intent_source_sha256: intent.source_sha256,
  });
  const reclaimed = guardRecord(terminal, `guard-resources-${suffix}`, 'resources_reclaimed', {
    resource_ids: ['process-A'], resource_snapshot_sha256: 'd'.repeat(64),
  });
  terminal.guard_refs = [intent.guard_id, intentSeal.guard_id, reclaimed.guard_id];
  trace.push(terminal);
  return { trace, guardIndex: { ...guardIndex, [intent.guard_id]: intent, [intentSeal.guard_id]: intentSeal, [reclaimed.guard_id]: reclaimed } };
}
const activeProcessEvents = processResourceTrace(processEntry).slice(0, 4);
const activeProcessSnapshots = api.reduceResourceEvents(activeProcessEvents, [processEntry], identityOptions);
for (const outcome of ['CANCELLED', 'FAILED_RECLAIMED']) {
  const terminal = reclaimedTerminalTrace(outcome);
  const activeTerminalLedger = clone(validLedger);
  activeTerminalLedger.run_events = terminal.trace;
  activeTerminalLedger.resource_events = activeProcessEvents;
  activeTerminalLedger.resources = activeProcessSnapshots;
  activeTerminalLedger.content_sha256 = api.computeContentSha256(activeTerminalLedger);
  expectValidationCode(
    api.validateResourceLedger(activeTerminalLedger, { ...ledgerOptions, guardIndex: terminal.guardIndex }),
    'RUN_TERMINAL_WITH_UNRECLAIMED_RESOURCE',
  );

  const openChildLedger = clone(validLedger);
  openChildLedger.run_events = terminal.trace;
  openChildLedger.child_events = childTrace.slice(0, 5);
  openChildLedger.content_sha256 = api.computeContentSha256(openChildLedger);
  expectValidationCode(
    api.validateResourceLedger(openChildLedger, { ...ledgerOptions, guardIndex: terminal.guardIndex }),
    'RUN_TERMINAL_WITH_OPEN_CHILD',
  );
}
const emptyRunLedger = clone(validLedger); emptyRunLedger.run_events = []; emptyRunLedger.content_sha256 = api.computeContentSha256(emptyRunLedger);
expectValidationCode(api.validateResourceLedger(emptyRunLedger, ledgerOptions), 'RUN_EVENT_STREAM_REQUIRED');
const extraProducerLedger = clone(validLedger); extraProducerLedger.producer.unbound_extra = true; extraProducerLedger.content_sha256 = api.computeContentSha256(extraProducerLedger);
expectValidationCode(api.validateResourceLedger(extraProducerLedger, ledgerOptions), 'LEDGER_ENVELOPE_INVALID');
const emptyRedactionLedger = clone(validLedger); emptyRedactionLedger.redaction = {}; emptyRedactionLedger.content_sha256 = api.computeContentSha256(emptyRedactionLedger);
expectValidationCode(api.validateResourceLedger(emptyRedactionLedger, ledgerOptions), 'LEDGER_ENVELOPE_INVALID');
const extraPlanRefLedger = clone(validLedger); extraPlanRefLedger.plan_ref.unbound_extra = true; extraPlanRefLedger.content_sha256 = api.computeContentSha256(extraPlanRefLedger);
expectValidationCode(api.validateResourceLedger(extraPlanRefLedger, ledgerOptions), 'LEDGER_PLAN_REF_INVALID');
const driftedLedger = clone(validLedger); driftedLedger.resources[0].state = 'ACTIVE'; driftedLedger.content_sha256 = api.computeContentSha256(driftedLedger);
const driftedResult = api.validateResourceLedger(driftedLedger, ledgerOptions);
assert.strictEqual(driftedResult.valid, false);
assert(driftedResult.errors.some((error) => error.code === 'RESOURCE_SNAPSHOT_MISMATCH'));
const coordinatedTamper = clone(validLedger); coordinatedTamper.resources[0].owner_role = 'child'; coordinatedTamper.resources[0].owner_id = 'child-X'; coordinatedTamper.resource_events.forEach((event) => { event.actor_role = 'child'; event.actor_id = 'child-X'; }); coordinatedTamper.content_sha256 = api.computeContentSha256(coordinatedTamper);
expectValidationCode(api.validateResourceLedger(coordinatedTamper, ledgerOptions), 'RESOURCE_OWNERSHIP_TRANSFER_FORBIDDEN');
const wrongPlanSeal = clone(resourceIndex); wrongPlanSeal['process-A'].plan_ref.content_sha256 = 'b'.repeat(64); wrongPlanSeal['process-A'].source_sha256 = sourceHash(wrongPlanSeal['process-A']);
expectValidationCode(api.validateResourceLedger(validLedger, { ...ledgerOptions, resourceIndex: wrongPlanSeal }), 'RESOURCE_PLAN_BINDING_MISMATCH');
const unknownResourceLedger = clone(validLedger); unknownResourceLedger.resources[0].state = 'UNKNOWN'; unknownResourceLedger.content_sha256 = api.computeContentSha256(unknownResourceLedger);
assert(api.validateResourceLedger(unknownResourceLedger, ledgerOptions).errors.some((error) => error.code === 'RUN_COMPLETE_WITH_UNRECLAIMED_RESOURCE'));
const duplicateNamespaceLedger = clone(validLedger); duplicateNamespaceLedger.resource_events[0].event_id = duplicateNamespaceLedger.run_events[0].event_id; duplicateNamespaceLedger.content_sha256 = api.computeContentSha256(duplicateNamespaceLedger);
assert(api.validateResourceLedger(duplicateNamespaceLedger, ledgerOptions).errors.some((error) => error.code === 'EVENT_ID_DUPLICATE'));
const runInChildLedger = clone(validLedger); runInChildLedger.child_events = clone(runTrace); runInChildLedger.content_sha256 = api.computeContentSha256(runInChildLedger);
expectValidationCode(api.validateResourceLedger(runInChildLedger, ledgerOptions), 'LIFECYCLE_EVENT_PARTITION_MISMATCH');
const childInRunLedger = clone(validLedger); childInRunLedger.run_events = clone(childTrace); childInRunLedger.content_sha256 = api.computeContentSha256(childInRunLedger);
expectValidationCode(api.validateResourceLedger(childInRunLedger, ledgerOptions), 'LIFECYCLE_EVENT_PARTITION_MISMATCH');
const wrongGenerationLedger = clone(validLedger); wrongGenerationLedger.run_events.forEach((event) => { event.plan_generation = 2; }); wrongGenerationLedger.child_events.forEach((event) => { event.plan_generation = 2; }); wrongGenerationLedger.content_sha256 = api.computeContentSha256(wrongGenerationLedger);
expectValidationCode(api.validateResourceLedger(wrongGenerationLedger, ledgerOptions), 'PLAN_GENERATION_MISMATCH');

console.log('collaboration state-machine contract passed');
