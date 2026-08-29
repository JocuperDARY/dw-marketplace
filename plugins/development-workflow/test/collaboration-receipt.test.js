'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('../skills/dw-collaboration/scripts/lib/contracts');
const { computeContentSha256, computeDetachedSha256, createDetachedJsonSnapshot } = require('../skills/dw-collaboration/scripts/lib/canonical-json');

const pluginRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'collaboration');
const invalid = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'receipt-invalid.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const ownHash = (record, field = 'source_sha256') => {
  const copy = clone(record); delete copy[field];
  return computeDetachedSha256(createDetachedJsonSnapshot(copy).snapshot);
};
const sealRecord = (record, field = 'source_sha256') => { record[field] = ownHash(record, field); return record; };
const sealReceipt = (receipt) => { receipt.content_sha256 = computeContentSha256(receipt); return receipt; };
const codes = (result) => result.errors.map((item) => item.code);
const expectCode = (result, code) => assert(codes(result).includes(code), `${code} not in ${codes(result).join(',')}`);

const schemaPath = path.join(pluginRoot, 'skills/dw-collaboration/references/schemas/ExecutionReceipt1.schema.json');
assert(fs.existsSync(schemaPath), 'RED: ExecutionReceipt1 schema is absent');
for (const name of ['validateExecutionReceipt', 'validateAuthorization', 'isActionAuthorized']) assert.strictEqual(typeof api[name], 'function', `RED: ${name} is absent`);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
assert.deepStrictEqual(schema.properties.run_outcome.enum, ['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED', 'HOLD', 'UNVERIFIED']);
assert.deepStrictEqual(schema.$defs.phaseReceipt.properties.route_attestation.enum, ['VERIFIED', 'UNVERIFIED', 'NOT_REQUIRED']);
assert.deepStrictEqual(schema.properties.cleanup_summary.properties.status.enum, ['all_reclaimed', 'quarantined', 'unknown']);
assert.strictEqual(schema.$defs.producer.additionalProperties, false);
assert.strictEqual(schema.$defs.redaction.additionalProperties, false);

const authorityIndex = {
  'root-auth': sealRecord({ authority_id: 'root-auth', run_id: 'run-A', subject_id: 'run-A', plan_generation: 1, actor_role: 'root', actor_id: 'root-A', valid_from: '2026-08-29T00:00:00Z', valid_until: '2026-08-29T02:00:00Z', evidence_refs: ['root-authority'], source_sha256: '0'.repeat(64) }),
  'verifier-auth': sealRecord({ authority_id: 'verifier-auth', run_id: 'run-A', subject_id: 'run-A', plan_generation: 1, actor_role: 'verifier', actor_id: 'verifier-A', valid_from: '2026-08-29T00:00:00Z', valid_until: '2026-08-29T02:00:00Z', evidence_refs: ['verifier-authority'], source_sha256: '0'.repeat(64) }),
};
const planRecord = sealRecord({ artifact_id: 'plan-A', schema: 'CollaborationPlan1', content_sha256: 'a'.repeat(64), run_id: 'run-A', session_id: 'sess-A', status: 'VALID', plan_generation: 1, required_phase_ids: ['phase-A'], exact_lane_required_phase_ids: [], validated_at: '2026-08-29T00:10:00Z', validated_by_authority_ref: 'root-auth', evidence_refs: ['plan-validation'], source_sha256: '0'.repeat(64) });
const ledgerRecord = sealRecord({ artifact_id: 'ledger-A', schema: 'ResourceLedger1', content_sha256: 'b'.repeat(64), run_id: 'run-A', session_id: 'sess-A', status: 'VALID', plan_ref: { artifact_id: 'plan-A', content_sha256: 'a'.repeat(64) }, terminal_run_state: 'COMPLETE', resource_states: [], retained_artifact_ids: [], validated_at: '2026-08-29T00:50:00Z', validated_by_authority_ref: 'verifier-auth', evidence_refs: ['ledger-validation'], source_sha256: '0'.repeat(64) });
const evidence = (id, kind, actorRole, actorId, linkedEvidenceRef = null) => sealRecord({ evidence_id: id, run_id: 'run-A', session_id: 'sess-A', phase_id: 'phase-A', kind, status: 'PASS', actor_role: actorRole, actor_id: actorId, actor_authority_ref: actorRole === 'root' ? 'root-auth' : actorRole === 'verifier' ? 'verifier-auth' : null, observed_at: '2026-08-29T00:30:00Z', result_sha256: 'c'.repeat(64), linked_evidence_ref: linkedEvidenceRef, evidence_refs: [`${id}-source`], source_sha256: '0'.repeat(64) });
const evidenceIndex = {
  dispatch: evidence('dispatch', 'dispatch', 'root', 'root-A'),
  running: evidence('running', 'running', 'adapter', 'adapter-A', 'dispatch'),
  submitted: evidence('submitted', 'result_submission', 'child', 'child-A', 'running'),
  accepted: evidence('accepted', 'root_acceptance', 'root', 'root-A', 'submitted'),
  reviewed: evidence('reviewed', 'review', 'root', 'root-A', 'accepted'),
  verified: evidence('verified', 'verification', 'verifier', 'verifier-A', 'reviewed'),
};
const basePhase = { phase_id: 'phase-A', child_id: 'child-A', dispatch_event: 'dispatch', running_evidence: 'running', result_submission: 'submitted', root_acceptance: 'accepted', review: 'reviewed', verification: 'verified', requested_model: 'unspecified', selected_model: 'lane-professional', actual_model: 'unknown', requested_effort: 'unspecified', selected_effort: 'medium', actual_effort: 'unknown', route_attestation: 'UNVERIFIED', actual_route_evidence: null, artifact_refs: ['artifact-result-A'] };
const baseReceipt = sealReceipt({ schema: 'ExecutionReceipt1', schema_version: 1, artifact_id: 'receipt-A', run_id: 'run-A', session_id: 'sess-A', created_at: '2026-08-29T01:00:00Z', producer: { role: 'root', adapter_id: 'adapter-A' }, redaction: { policy: 'metadata_only' }, plan_ref: { artifact_id: 'plan-A', content_sha256: 'a'.repeat(64) }, ledger_ref: { artifact_id: 'ledger-A', content_sha256: 'b'.repeat(64) }, run_outcome: 'COMPLETE', phase_receipts: [basePhase], cleanup_summary: { status: 'all_reclaimed', ledger_hash: 'b'.repeat(64) }, authorization_summary: { authorization_refs: [] }, contradictions: [], residual_risks: [], content_sha256: '0'.repeat(64) });
const trustedAuthorityResolver = ({ purpose }) => purpose === 'receipt_authority';
const trustedRuntimeResolver = ({ purpose }) => purpose === 'actual_route';
const options = { now: '2026-08-29T01:00:00Z', expectedSessionId: 'sess-A', planIndex: { 'plan-A': planRecord }, ledgerIndex: { 'ledger-A': ledgerRecord }, evidenceIndex, authorityIndex, trustedAuthorityResolver };
const cloneOptions = () => ({ ...clone(options), trustedAuthorityResolver });

assert.strictEqual(api.validateExecutionReceipt(baseReceipt, options).valid, true, 'COMPLETE may retain unknown actual route when exact lane is not required');
const extraProducer = clone(baseReceipt); extraProducer.producer.unbound_extra = true; sealReceipt(extraProducer);
expectCode(api.validateExecutionReceipt(extraProducer, options), 'RECEIPT_PRODUCER_INVALID');
const nullResidualRisk = clone(baseReceipt); nullResidualRisk.residual_risks = [null]; sealReceipt(nullResidualRisk);
expectCode(api.validateExecutionReceipt(nullResidualRisk, options), 'RESIDUAL_RISKS_INVALID');
const extraCleanup = clone(baseReceipt); extraCleanup.cleanup_summary.unbound_extra = true; sealReceipt(extraCleanup);
expectCode(api.validateExecutionReceipt(extraCleanup, options), 'CLEANUP_NOT_COMPLETE');
const extraPlanReference = clone(baseReceipt); extraPlanReference.plan_ref.unbound_extra = true; sealReceipt(extraPlanReference);
expectCode(api.validateExecutionReceipt(extraPlanReference, options), 'PLAN_REFERENCE_INVALID');
const childProduced = clone(baseReceipt); childProduced.producer.role = 'child'; sealReceipt(childProduced);
expectCode(api.validateExecutionReceipt(childProduced, options), 'RECEIPT_PRODUCER_INVALID');
const brokenEarlyChain = cloneOptions(); brokenEarlyChain.evidenceIndex.running = sealRecord({ ...clone(evidenceIndex.running), linked_evidence_ref: 'unrelated-dispatch' });
expectCode(api.validateExecutionReceipt(baseReceipt, brokenEarlyChain), 'RESULT_CHAIN_MISMATCH');
const childAccepted = cloneOptions(); childAccepted.evidenceIndex.accepted = sealRecord({ ...clone(evidenceIndex.accepted), actor_role: 'child', actor_id: 'child-A' });
expectCode(api.validateExecutionReceipt(baseReceipt, childAccepted), 'ROOT_ACCEPTANCE_REQUIRED');
const missingReview = cloneOptions(); delete missingReview.evidenceIndex.reviewed;
expectCode(api.validateExecutionReceipt(baseReceipt, missingReview), 'ROOT_REVIEW_REQUIRED');
const sameVerifier = cloneOptions();
sameVerifier.authorityIndex['verifier-root-auth'] = sealRecord({ ...clone(authorityIndex['verifier-auth']), authority_id: 'verifier-root-auth', actor_id: 'root-A' });
sameVerifier.evidenceIndex.verified = sealRecord({ ...clone(evidenceIndex.verified), actor_role: 'verifier', actor_id: 'root-A', actor_authority_ref: 'verifier-root-auth' });
expectCode(api.validateExecutionReceipt(baseReceipt, sameVerifier), 'VERIFIER_NOT_INDEPENDENT');
const copiedCandidate = clone(baseReceipt); copiedCandidate.phase_receipts[0].actual_model = copiedCandidate.phase_receipts[0].selected_model; sealReceipt(copiedCandidate);
expectCode(api.validateExecutionReceipt(copiedCandidate, options), 'ACTUAL_ROUTE_UNVERIFIED');
const forgedNotRequired = clone(baseReceipt);
Object.assign(forgedNotRequired.phase_receipts[0], { actual_model: 'self-claimed-model', actual_effort: 'max', route_attestation: 'NOT_REQUIRED', actual_route_evidence: 'nonexistent' });
sealReceipt(forgedNotRequired);
expectCode(api.validateExecutionReceipt(forgedNotRequired, options), 'ACTUAL_ROUTE_NOT_REQUIRED');
const actualRoute = sealRecord({ evidence_id: 'actual-route-A', run_id: 'run-A', session_id: 'sess-A', phase_id: 'phase-A', actual_model: 'host:model-A', actual_effort: 'medium', source_kind: 'host_runtime_metadata', observed_at: '2026-08-29T00:31:00Z', evidence_refs: ['host-event-A'], source_sha256: '0'.repeat(64) });
const verifiedRouteReceipt = clone(baseReceipt); Object.assign(verifiedRouteReceipt.phase_receipts[0], { actual_model: 'host:model-A', actual_effort: 'medium', route_attestation: 'VERIFIED', actual_route_evidence: 'actual-route-A' }); sealReceipt(verifiedRouteReceipt);
assert.strictEqual(api.validateExecutionReceipt(verifiedRouteReceipt, { ...options, actualRouteIndex: { 'actual-route-A': actualRoute }, trustedRuntimeResolver }).valid, true);
expectCode(api.validateExecutionReceipt(verifiedRouteReceipt, { ...options, actualRouteIndex: { 'actual-route-A': actualRoute } }), 'ACTUAL_ROUTE_EVIDENCE_REQUIRED');
const candidateRoute = clone(actualRoute); candidateRoute.source_kind = 'route_candidate'; sealRecord(candidateRoute);
expectCode(api.validateExecutionReceipt(verifiedRouteReceipt, { ...options, actualRouteIndex: { 'actual-route-A': candidateRoute } }), 'ACTUAL_ROUTE_EVIDENCE_REQUIRED');
const forgedRootAuthority = cloneOptions(); forgedRootAuthority.evidenceIndex.accepted = sealRecord({ ...clone(evidenceIndex.accepted), actor_authority_ref: 'verifier-auth' });
expectCode(api.validateExecutionReceipt(baseReceipt, forgedRootAuthority), 'ROOT_ACCEPTANCE_REQUIRED');
const exactPlan = clone(planRecord); exactPlan.exact_lane_required_phase_ids = ['phase-A']; sealRecord(exactPlan);
expectCode(api.validateExecutionReceipt(baseReceipt, { ...options, planIndex: { 'plan-A': exactPlan } }), 'EXACT_ROUTE_ATTESTATION_REQUIRED');
const contradiction = clone(baseReceipt); contradiction.contradictions = [{ contradiction_id: 'conflict-A', status: 'UNRESOLVED', evidence_refs: ['conflict-source'] }]; sealReceipt(contradiction);
expectCode(api.validateExecutionReceipt(contradiction, options), 'UNRESOLVED_CONTRADICTION');
const holdLedger = clone(ledgerRecord); holdLedger.terminal_run_state = 'HOLD'; holdLedger.resource_states = [{ resource_id: 'unknown-A', type: 'process_tree', state: 'UNKNOWN' }]; sealRecord(holdLedger);
const emptyPhaseHold = clone(baseReceipt); emptyPhaseHold.run_outcome = 'HOLD'; emptyPhaseHold.phase_receipts = []; emptyPhaseHold.cleanup_summary.status = 'unknown'; emptyPhaseHold.contradictions = [{ contradiction_id: 'conflict-A', status: 'UNRESOLVED', evidence_refs: ['conflict-source'] }]; sealReceipt(emptyPhaseHold);
expectCode(api.validateExecutionReceipt(emptyPhaseHold, { ...options, ledgerIndex: { 'ledger-A': holdLedger } }), 'REQUIRED_PHASE_MISSING');
const holdReceipt = clone(emptyPhaseHold); holdReceipt.phase_receipts = [clone(basePhase)]; sealReceipt(holdReceipt);
assert.strictEqual(api.validateExecutionReceipt(holdReceipt, { ...options, ledgerIndex: { 'ledger-A': holdLedger } }).valid, true, 'truthful HOLD must preserve collected phases, unresolved contradiction and unknown cleanup');
const activeHoldLedger = clone(holdLedger); activeHoldLedger.resource_states = [{ resource_id: 'process-active-A', type: 'process_tree', state: 'ACTIVE' }]; sealRecord(activeHoldLedger);
assert.strictEqual(
  api.validateExecutionReceipt(holdReceipt, { ...options, ledgerIndex: { 'ledger-A': activeHoldLedger } }).valid,
  true,
  'truthful HOLD must preserve a known active resource when cleanup has no terminal proof',
);
const invalidLedgerResourceSummaries = [
  [{ resource_id: 'process-active-A', type: 'process_tree', state: 'BOGUS' }],
  [null],
  [{ type: 'process_tree', state: 'ACTIVE' }],
  [{ resource_id: 'duplicate-A', type: 'process_tree', state: 'ACTIVE' }, { resource_id: 'duplicate-A', type: 'artifact', state: 'RETAINED' }],
];
for (const resourceStates of invalidLedgerResourceSummaries) {
  const invalidLedgerSummary = clone(activeHoldLedger); invalidLedgerSummary.resource_states = resourceStates; sealRecord(invalidLedgerSummary);
  expectCode(
    api.validateExecutionReceipt(holdReceipt, { ...options, ledgerIndex: { 'ledger-A': invalidLedgerSummary } }),
    'LEDGER_REFERENCE_INVALID',
  );
}
for (const [runOutcome, terminalState] of [['COMPLETE', 'COMPLETE'], ['CANCELLED', 'CANCELLED'], ['FAILED', 'FAILED_RECLAIMED']]) {
  const unsafeTerminalLedger = clone(activeHoldLedger); unsafeTerminalLedger.terminal_run_state = terminalState; sealRecord(unsafeTerminalLedger);
  const unsafeTerminalReceipt = clone(baseReceipt); unsafeTerminalReceipt.run_outcome = runOutcome; sealReceipt(unsafeTerminalReceipt);
  expectCode(
    api.validateExecutionReceipt(unsafeTerminalReceipt, { ...options, ledgerIndex: { 'ledger-A': unsafeTerminalLedger } }),
    'CLEANUP_NOT_COMPLETE',
  );
}
const holdWithCompleteLedger = clone(holdReceipt); sealReceipt(holdWithCompleteLedger);
expectCode(api.validateExecutionReceipt(holdWithCompleteLedger, options), 'OUTCOME_LEDGER_MISMATCH');
for (const [runOutcome, terminalState] of [['CANCELLED', 'CANCELLED'], ['FAILED', 'FAILED_RECLAIMED']]) {
  const terminalLedger = clone(ledgerRecord); terminalLedger.terminal_run_state = terminalState; sealRecord(terminalLedger);
  const terminalReceipt = clone(baseReceipt); terminalReceipt.run_outcome = runOutcome; sealReceipt(terminalReceipt);
  assert.strictEqual(api.validateExecutionReceipt(terminalReceipt, { ...options, ledgerIndex: { 'ledger-A': terminalLedger } }).valid, true, `${runOutcome} must bind ${terminalState}`);
}
const retainedLedger = clone(ledgerRecord); retainedLedger.resource_states = [{ resource_id: 'artifact-A', type: 'artifact', state: 'RETAINED' }]; retainedLedger.retained_artifact_ids = ['artifact-A']; sealRecord(retainedLedger);
assert.strictEqual(api.validateExecutionReceipt(baseReceipt, { ...options, ledgerIndex: { 'ledger-A': retainedLedger } }).valid, true, 'sealed retained artifacts are terminal-safe');
const forgedRetainedLedger = clone(retainedLedger); forgedRetainedLedger.resource_states[0].type = 'process_tree'; sealRecord(forgedRetainedLedger);
expectCode(api.validateExecutionReceipt(baseReceipt, { ...options, ledgerIndex: { 'ledger-A': forgedRetainedLedger } }), 'RETAINED_ARTIFACT_INVALID');
const orphanRetentionLedger = clone(ledgerRecord); orphanRetentionLedger.retained_artifact_ids = ['missing-artifact']; sealRecord(orphanRetentionLedger);
expectCode(api.validateExecutionReceipt(baseReceipt, { ...options, ledgerIndex: { 'ledger-A': orphanRetentionLedger } }), 'RETAINED_ARTIFACT_INVALID');
for (const state of invalid.terminal_blocking_resource_states) {
  const ledger = clone(ledgerRecord); ledger.resource_states = [{ resource_id: 'resource-A', type: 'process_tree', state }]; sealRecord(ledger);
  expectCode(api.validateExecutionReceipt(baseReceipt, { ...options, ledgerIndex: { 'ledger-A': ledger } }), 'CLEANUP_NOT_COMPLETE');
}
const wrongPlan = clone(baseReceipt); wrongPlan.plan_ref.content_sha256 = 'd'.repeat(64); sealReceipt(wrongPlan);
expectCode(api.validateExecutionReceipt(wrongPlan, options), 'PLAN_REFERENCE_INVALID');
const crossSessionLedger = clone(ledgerRecord); crossSessionLedger.session_id = 'sess-other'; sealRecord(crossSessionLedger);
expectCode(api.validateExecutionReceipt(baseReceipt, { ...options, ledgerIndex: { 'ledger-A': crossSessionLedger } }), 'LEDGER_REFERENCE_INVALID');

const authEvidenceIndex = { 'human-approval-A': sealRecord({ evidence_id: 'human-approval-A', evidence_class: 'explicit_human_approval', actor_id: 'user-A', observed_at: '2026-08-29T00:40:00Z', evidence_refs: ['approval-source'], source_sha256: '0'.repeat(64) }) };
const authorization = sealRecord({ authorization_id: 'auth-commit-A', actor_id: 'user-A', actor_kind: 'human', scope: 'repository:dw-worktree', action: 'commit', resource_ids: ['repo-A'], issued_at: '2026-08-29T00:40:00Z', expires_at: '2026-08-29T01:40:00Z', plan_ref: { artifact_id: 'plan-A', content_sha256: 'a'.repeat(64) }, source_evidence_ref: 'human-approval-A', source_sha256: '0'.repeat(64) });
const trustedAuthorizationResolver = ({ purpose }) => purpose === 'authorization';
const authContext = { expectedActorId: 'user-A', expectedScope: 'repository:dw-worktree', expectedAction: 'commit', expectedResourceIds: ['repo-A'], now: '2026-08-29T01:00:00Z', planRef: baseReceipt.plan_ref, authorizationEvidenceIndex: authEvidenceIndex, allowedSourceEvidenceClasses: ['explicit_human_approval'], trustedAuthorizationResolver };
assert.strictEqual(api.validateAuthorization(authorization, authContext).valid, true);
assert.strictEqual(api.isActionAuthorized('commit', authorization, authContext), true);
expectCode(api.validateAuthorization(authorization, { ...authContext, trustedAuthorizationResolver: undefined }), 'AUTHORIZATION_TRUST_NOT_PROVEN');
for (const action of invalid.distinct_actions.filter((item) => item !== 'commit')) assert.strictEqual(api.isActionAuthorized(action, authorization, { ...authContext, expectedAction: action }), false, `commit must not imply ${action}`);
const expiredContext = { ...authContext, now: '2026-08-29T02:00:00Z' };
expectCode(api.validateAuthorization(authorization, expiredContext), 'AUTHORIZATION_EXPIRED');
for (const actorKind of invalid.forbidden_authorizing_actor_kinds) {
  const bad = clone(authorization); bad.actor_kind = actorKind; sealRecord(bad);
  expectCode(api.validateAuthorization(bad, authContext), 'AUTHORIZING_ACTOR_FORBIDDEN');
}
const wrongResourceContext = { ...authContext, expectedResourceIds: ['repo-B'] };
expectCode(api.validateAuthorization(authorization, wrongResourceContext), 'AUTHORIZATION_RESOURCE_MISMATCH');
const wrongPlanContext = { ...authContext, planRef: { artifact_id: 'plan-B', content_sha256: 'e'.repeat(64) } };
expectCode(api.validateAuthorization(authorization, wrongPlanContext), 'AUTHORIZATION_PLAN_MISMATCH');
for (const malformedAuthorization of [
  { ...clone(authorization), resource_ids: [] },
  { ...clone(authorization), plan_ref: { content_sha256: authorization.plan_ref.content_sha256 } },
  { ...clone(authorization), plan_ref: { artifact_id: authorization.plan_ref.artifact_id, content_sha256: 'not-a-sha' } },
]) {
  sealRecord(malformedAuthorization);
  expectCode(api.validateAuthorization(malformedAuthorization, authContext), 'AUTHORIZATION_INVALID');
}

console.log('collaboration execution-receipt contract passed');
