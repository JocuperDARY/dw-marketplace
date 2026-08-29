#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'collaboration');

function loadValidatorOrEmpty() {
  try {
    return require(path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact'));
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

function seal(artifact, computeContentSha256) {
  artifact.content_sha256 = computeContentSha256(artifact);
  return artifact;
}

function sealSource(record) {
  const detached = clone(record);
  delete detached.source_sha256;
  record.source_sha256 = crypto.createHash('sha256').update(canonicalize(detached), 'utf8').digest('hex');
  return record;
}

function inheritedDescriptorView(ownProperties, inheritedProperties) {
  const target = Object.assign(Object.create(inheritedProperties), ownProperties);
  return new Proxy(target, {
    getPrototypeOf() { return Object.prototype; },
  });
}

function expectError(result, code) {
  assert(codes(result).includes(code), `expected ${code}; received ${codes(result).join(', ')}`);
}

const api = loadValidatorOrEmpty();
assert.strictEqual(typeof api.validateArtifact, 'function', 'RED: validator API is absent');
assert.strictEqual(typeof api.validateArtifactSet, 'function', 'RED: validator set API is absent');
assert.strictEqual(typeof api.canonicalize, 'function', 'RED: canonical JSON API is absent');
assert.strictEqual(typeof api.computeContentSha256, 'function', 'RED: content hash API is absent');

const {
  CAPABILITY_IDS,
  CAPABILITY_SUBJECTS,
  SUPPORT,
  EVIDENCE_LEVELS,
  SOURCE_KINDS,
  REDACTION_POLICIES,
  UTC_TIMESTAMP_PATTERN,
  ContractError,
  canonicalize,
  computeContentSha256,
  isCapabilitySupported,
  validateArtifact,
  validateArtifactSet,
} = api;

const schema = JSON.parse(fs.readFileSync(path.join(
  pluginRoot,
  'skills',
  'dw-collaboration',
  'references',
  'schemas',
  'CapabilityMatrix1.schema.json',
), 'utf8'));

assert.deepStrictEqual(schema.$defs.capability.properties.capability_id.enum, CAPABILITY_IDS);
assert.deepStrictEqual(schema.$defs.capability.properties.subject.enum, CAPABILITY_SUBJECTS);
assert.deepStrictEqual(schema.$defs.capability.properties.support.enum, SUPPORT);
assert.deepStrictEqual(schema.$defs.capability.properties.evidence_level.enum, EVIDENCE_LEVELS);
assert.deepStrictEqual(schema.$defs.capability.properties.source_kind.enum, SOURCE_KINDS);
assert.deepStrictEqual(schema.properties.redaction.properties.policy.enum, REDACTION_POLICIES);
assert.strictEqual(schema.properties.created_at.pattern, UTC_TIMESTAMP_PATTERN);
assert.strictEqual(schema.$defs.capability.properties.observed_at.pattern, UTC_TIMESTAMP_PATTERN);
assert.strictEqual(schema.$defs.capability.properties.expires_at.pattern, UTC_TIMESTAMP_PATTERN);
assert.strictEqual(schema.$defs.scope.properties.adapter_generation.maximum, Number.MAX_SAFE_INTEGER);

const collaborationPlanSchemaPath = path.join(
  pluginRoot,
  'skills',
  'dw-collaboration',
  'references',
  'schemas',
  'CollaborationPlan1.schema.json',
);
assert(fs.existsSync(collaborationPlanSchemaPath), 'RED: CollaborationPlan1 schema is absent');
const collaborationPlanSchema = JSON.parse(fs.readFileSync(collaborationPlanSchemaPath, 'utf8'));
assert.strictEqual(collaborationPlanSchema.properties.schema.const, 'CollaborationPlan1');
assert.deepStrictEqual(collaborationPlanSchema.properties.topology.enum, ['single', 'assignment_only', 'interactive_shared', 'serial_fallback']);
assert.strictEqual(collaborationPlanSchema.$defs.route.additionalProperties, false, 'plan routes must reject actual_* fields');
assert.strictEqual(collaborationPlanSchema.properties.phases.maxItems, 256, 'plan schema must bound phases');
assert.strictEqual(collaborationPlanSchema.$defs.phase.properties.dependencies.maxItems, 256, 'plan schema must bound dependencies');
assert.strictEqual(collaborationPlanSchema.$defs.phase.properties.dependencies.uniqueItems, true, 'plan schema must reject duplicate dependencies');
assert.strictEqual(collaborationPlanSchema.$defs.ownership.properties.exclusive_paths.maxItems, 256, 'plan schema must bound ownership paths');
assert.strictEqual(collaborationPlanSchema.$defs.route.properties.allowed_fallbacks.maxItems, 256, 'plan schema must bound route fallbacks');
for (const field of ['created_at', 'producer', 'redaction']) {
  assert(collaborationPlanSchema.required.includes(field), `plan schema must require common field: ${field}`);
}
for (const fixtureName of ['plan-valid.json', 'plan-cyclic.json', 'plan-shared-write.json', 'plan-incomplete-packet.json']) {
  const fixturePath = path.join(fixtureRoot, fixtureName);
  assert(fs.existsSync(fixturePath), `RED: Task 4 fixture is absent: ${fixtureName}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(fixturePath, 'utf8')), `fixture must be valid JSON: ${fixtureName}`);
}

// R6-5: the schema and executable validator must require the same PROBED shape/source.
const probedSchemaRule = schema.$defs.capability.allOf.find((entry) => (
  entry.if
  && entry.if.properties
  && entry.if.properties.evidence_level
  && entry.if.properties.evidence_level.const === 'PROBED'
));
assert(probedSchemaRule, 'PROBED schema rule must exist');
assert(probedSchemaRule.then.required.includes('probe'), 'PROBED schema rule must require probe');
assert(
  probedSchemaRule.then.properties
  && probedSchemaRule.then.properties.source_kind
  && probedSchemaRule.then.properties.source_kind.const === 'probe',
  'PROBED schema rule must require probe source',
);

// R6-6: executable input limits must also be machine-readable schema limits.
assert.strictEqual(schema.properties.capabilities.maxItems, 1024, 'schema must cap capabilities at the executable limit');
assert.strictEqual(schema.$defs.capability.properties.supersedes.maxItems, 64, 'schema must cap supersedes at the executable limit');
expectError(validateArtifactSet([], { now: '2026-08-26T03:05:00Z' }), 'ARTIFACT_SET_EMPTY');

assert.strictEqual(
  canonicalize({ z: [{ b: 2, a: 1 }], a: null }),
  '{"a":null,"z":[{"a":1,"b":2}]}',
  'canonical JSON must recursively sort object keys while preserving array order',
);
const nestedDigest = computeContentSha256({
  outer: { content_sha256: 'nested-value' },
  content_sha256: 'top-level-value',
});
assert.strictEqual(
  nestedDigest,
  computeContentSha256({ outer: { content_sha256: 'nested-value' }, content_sha256: 'other-top-level-value' }),
  'only the top-level content_sha256 may be excluded from the digest',
);

for (const rejected of [undefined, () => {}, Symbol('private'), 1n, Infinity]) {
  assert.throws(
    () => canonicalize(rejected),
    (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
  );
}
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => canonicalize(cyclic), (error) => error.code === 'CANONICAL_CYCLE');
let tooDeep = {};
for (let depth = 0; depth < 65; depth += 1) tooDeep = { child: tooDeep };
assert.throws(() => canonicalize(tooDeep), (error) => error.code === 'CONTRACT_LIMIT_EXCEEDED', 'deep JSON must fail with a stable budget error');
const oversizedKey = 'k'.repeat(8 * 1024 * 1024 + 1);
assert.throws(() => canonicalize({ [oversizedKey]: null }), (error) => error.code === 'CONTRACT_LIMIT_EXCEEDED', 'object key bytes must count toward the shared JSON budget');
assert.throws(
  () => canonicalize(JSON.parse('{"__proto__":{"polluted":true}}')),
  (error) => error.code === 'CANONICAL_PROTOTYPE_KEY',
);
const sparseArray = [];
sparseArray.length = 1;
assert.throws(
  () => canonicalize(sparseArray),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const arrayWithExtraKey = [];
arrayWithExtraKey.extra = 'hidden';
assert.throws(
  () => canonicalize(arrayWithExtraKey),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const arrayWithSymbol = [];
arrayWithSymbol[Symbol('hidden')] = true;
assert.throws(
  () => canonicalize(arrayWithSymbol),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const customArrayPrototype = [];
Object.setPrototypeOf(customArrayPrototype, { custom: true });
assert.throws(
  () => canonicalize(customArrayPrototype),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const hiddenObjectKey = {};
Object.defineProperty(hiddenObjectKey, 'secret', { value: 'hidden', enumerable: false });
assert.throws(
  () => canonicalize(hiddenObjectKey),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const symbolObjectKey = {};
Object.defineProperty(symbolObjectKey, Symbol('secret'), { value: 'hidden', enumerable: true });
assert.throws(
  () => canonicalize(symbolObjectKey),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const accessorObjectKey = {};
Object.defineProperty(accessorObjectKey, 'secret', { get: () => 'hidden', enumerable: true });
assert.throws(
  () => canonicalize(accessorObjectKey),
  (error) => error instanceof ContractError && error.code === 'CANONICAL_NON_JSON',
);
const accessorArtifact = {};
Object.defineProperty(accessorArtifact, 'content_sha256', { enumerable: true, get: () => { throw new Error('getter executed'); } });
let accessorResult;
assert.doesNotThrow(() => { accessorResult = validateArtifact(accessorArtifact, { now: '2026-08-26T03:05:00Z' }); });
assert(accessorResult.errors.some((error) => ['CANONICAL_NON_JSON', 'CANONICAL_REJECTED'].includes(error.code)), 'accessor input must return a metadata-only contract error');

const validMatrix = loadJson('capability-valid.json');
const invalidCases = loadJson('capability-invalid.json');
const fixedNow = '2026-08-26T03:05:00Z';

const validResult = validateArtifact(validMatrix, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(validResult.valid, true, JSON.stringify(validResult.errors));
assert.strictEqual(validResult.schema, 'CapabilityMatrix1');

// Task 4 RED: route decisions must use runtime-discovered lanes, not vendor names or a silent fallback.
const routeLanes = [
  { lane_id: 'lane-light', capability_class: 'light', supported_task_types: ['classification'], supported_efforts: ['low'], latency_class: 'interactive', cost_rank: 1, availability_evidence_ref: 'available-light', request_control_support: 'supported', actual_metadata_support: 'unsupported' },
  { lane_id: 'lane-standard', capability_class: 'standard', supported_task_types: ['classification'], supported_efforts: ['medium'], latency_class: 'interactive', cost_rank: 2, availability_evidence_ref: 'available-standard', request_control_support: 'supported', actual_metadata_support: 'unsupported' },
  { lane_id: 'lane-engineering', capability_class: 'engineering', supported_task_types: ['implementation'], supported_efforts: ['high'], latency_class: 'interactive', cost_rank: 2, availability_evidence_ref: 'available-engineering', request_control_support: 'supported', actual_metadata_support: 'supported' },
  { lane_id: 'lane-professional', capability_class: 'professional', supported_task_types: ['planning', 'verification'], supported_efforts: ['high'], latency_class: 'offline', cost_rank: 3, availability_evidence_ref: 'available-professional', request_control_support: 'request_only', actual_metadata_support: 'unsupported' },
];
function laneAvailabilityCapability(evidenceRef, fingerprint) {
  const capability = clone(validMatrix.capabilities[1]);
  capability.scope.adapter_fingerprint = fingerprint;
  capability.evidence_ref = evidenceRef;
  return capability;
}
const routeMatrix = clone(validMatrix);
routeMatrix.artifact_id = 'capability-route-A';
routeMatrix.capabilities = routeLanes.map((lane) => laneAvailabilityCapability(lane.availability_evidence_ref, lane.lane_id));
seal(routeMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(routeMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
const lowRiskAxes = {
  task_type: 'classification', scope: 'single_unit', risk: 'low', reversibility: 'reversible', phase_kind: 'diagnosis', latency_cost: 'interactive', validation_failure_cost: 'automatic_check',
};
const lowRiskRoute = api.selectRoute(routeLanes, lowRiskAxes, routeMatrix, { now: fixedNow });
assert.strictEqual(lowRiskRoute.status, 'SELECTED');
assert.strictEqual(lowRiskRoute.selected_model, 'lane-light');
assert.strictEqual(lowRiskRoute.selected_effort, 'low');
assert.strictEqual(Object.hasOwn(lowRiskRoute, 'actual_model'), false, 'route selection must never invent actual model metadata');
assert.strictEqual(
  api.selectRoute(routeLanes, lowRiskAxes, {}, { now: fixedNow }).status,
  'HOLD_ROUTE_UNAVAILABLE',
  'lane availability strings must resolve to fresh capability evidence',
);

const engineeringRoute = api.selectRoute(routeLanes, {
  task_type: 'implementation', scope: 'bounded_single_module', risk: 'medium', reversibility: 'reversible', phase_kind: 'implementation', latency_cost: 'interactive', validation_failure_cost: 'focused_tests',
}, routeMatrix, { now: fixedNow });
assert.strictEqual(engineeringRoute.status, 'SELECTED');
assert.strictEqual(engineeringRoute.selected_model, 'lane-engineering');
assert.strictEqual(engineeringRoute.selected_effort, 'high');

const testGateRoute = api.selectRoute(routeLanes, {
  task_type: 'classification', scope: 'single_unit', risk: 'low', reversibility: 'reversible', phase_kind: 'test_gates', latency_cost: 'interactive', validation_failure_cost: 'automatic_check',
}, routeMatrix, { now: fixedNow });
assert.strictEqual(testGateRoute.status, 'SELECTED');
assert.strictEqual(testGateRoute.selected_model, 'lane-standard');
assert.strictEqual(testGateRoute.capability_class, 'standard');

const unavailableAssuranceRoute = api.selectRoute(routeLanes, {
  phase_id: 'phase-assurance', task_type: 'verification', scope: 'cross_system', risk: 'extreme', reversibility: 'irreversible', phase_kind: 'verification', latency_cost: 'offline', validation_failure_cost: 'full_surface_audit',
}, routeMatrix, { now: fixedNow, assurance_binding: { actor_id: 'user-A', action: 'select_assurance_route', phase_id: 'phase-assurance', plan_hash: 'a'.repeat(64), resource_scope: 'logical:critical', expires_at: '2026-08-26T03:10:00Z', exit_condition: 'verification_complete' }, assurance_authorization: { actor_id: 'user-A', action: 'select_assurance_route', phase_id: 'phase-assurance', plan_hash: 'a'.repeat(64), resource_scope: 'logical:critical', expires_at: '2026-08-26T03:10:00Z', exit_condition: 'verification_complete' }, assurance_lease: { actor_id: 'user-A', action: 'select_assurance_route', phase_id: 'phase-assurance', plan_hash: 'a'.repeat(64), resource_scope: 'logical:critical', expires_at: '2026-08-26T03:10:00Z', exit_condition: 'verification_complete' } });
assert.strictEqual(unavailableAssuranceRoute.status, 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED');
assert.strictEqual(unavailableAssuranceRoute.selected_model, 'unspecified');

for (const unknownAxis of ['task_type', 'scope', 'risk', 'reversibility', 'phase_kind', 'latency_cost', 'validation_failure_cost']) {
  const unknownAxes = clone(lowRiskAxes);
  unknownAxes[unknownAxis] = 'unknown';
  assert.strictEqual(
    api.selectRoute(routeLanes, unknownAxes, routeMatrix, { now: fixedNow }).status,
    'NEEDS_EVIDENCE',
    `unknown ${unknownAxis} must not silently select a low route`,
  );
}
for (const [invalidAxis, invalidValue] of [['task_type', 'invented'], ['scope', 'local'], ['risk', 'catastrophic'], ['reversibility', 'easy'], ['phase_kind', 'test_gate'], ['latency_cost', 'fast'], ['validation_failure_cost', 'none']]) {
  const invalidAxes = clone(lowRiskAxes);
  invalidAxes[invalidAxis] = invalidValue;
  assert.strictEqual(api.selectRoute(routeLanes, invalidAxes, routeMatrix, { now: fixedNow }).status, 'NEEDS_EVIDENCE');
}
const assuranceLane = { lane_id: 'lane-assurance', capability_class: 'assurance', supported_task_types: ['verification'], supported_efforts: ['max'], latency_class: 'offline', cost_rank: 4, availability_evidence_ref: 'available-assurance', request_control_support: 'supported', actual_metadata_support: 'supported' };
const assuranceRouteMatrix = clone(routeMatrix);
assuranceRouteMatrix.artifact_id = 'capability-assurance-A';
assuranceRouteMatrix.capabilities.push(laneAvailabilityCapability('available-assurance', 'lane-assurance'));
seal(assuranceRouteMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(assuranceRouteMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
const assuranceAxes = {
  phase_id: 'phase-assurance', task_type: 'verification', scope: 'cross_system', risk: 'extreme', reversibility: 'irreversible', phase_kind: 'verification', latency_cost: 'offline', validation_failure_cost: 'full_surface_audit',
  plan_ref: { artifact_id: 'plan-assurance-A', content_sha256: 'a'.repeat(64) }, resource_scope: ['logical:critical'],
};
const assuranceBinding = { actor_id: 'user-A', action: 'select_assurance_route', phase_id: 'phase-assurance', plan_hash: assuranceAxes.plan_ref.content_sha256, resource_scope: clone(assuranceAxes.resource_scope), expires_at: '2026-08-26T03:10:00Z', exit_condition: 'verification_complete' };
const assuranceEvidence = sealSource({ evidence_id: 'assurance-approval-A', evidence_class: 'explicit_human_approval', actor_id: 'user-A', observed_at: '2026-08-26T03:00:00Z', evidence_refs: ['host-approval-handle-A'], source_sha256: '0'.repeat(64) });
const assuranceAuthorization = sealSource({ authorization_id: 'auth-assurance-A', actor_id: 'user-A', actor_kind: 'human', scope: 'assurance-route:phase-assurance', action: 'select_assurance_route', resource_ids: clone(assuranceAxes.resource_scope), issued_at: '2026-08-26T03:00:00Z', expires_at: '2026-08-26T03:10:00Z', plan_ref: clone(assuranceAxes.plan_ref), source_evidence_ref: assuranceEvidence.evidence_id, source_sha256: '0'.repeat(64) });
const validAssurancePolicy = { now: fixedNow, assurance_binding: clone(assuranceBinding), assurance_authorization: assuranceAuthorization, assurance_lease: clone(assuranceBinding), authorizationEvidenceIndex: { [assuranceEvidence.evidence_id]: assuranceEvidence }, allowedSourceEvidenceClasses: ['explicit_human_approval'], trustedAuthorizationResolver: ({ purpose }) => purpose === 'authorization' };
assert.strictEqual(api.selectRoute([...routeLanes, assuranceLane], assuranceAxes, assuranceRouteMatrix, validAssurancePolicy).status, 'SELECTED');
for (const [field, value] of [['actor_id', 'other-user'], ['action', 'different_action'], ['phase_id', 'other-phase'], ['plan_hash', 'b'.repeat(64)], ['resource_scope', ['logical:other']], ['expires_at', '2026-08-26T03:09:00Z'], ['exit_condition', 'different_exit']]) {
  const mismatchedPolicy = clone(validAssurancePolicy);
  mismatchedPolicy.trustedAuthorizationResolver = validAssurancePolicy.trustedAuthorizationResolver;
  mismatchedPolicy.assurance_lease[field] = value;
  assert.strictEqual(api.selectRoute([...routeLanes, assuranceLane], assuranceAxes, assuranceRouteMatrix, mismatchedPolicy).status, 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED', `assurance ${field} mismatch must reject`);
}
const extraAssuranceFieldPolicy = clone(validAssurancePolicy);
extraAssuranceFieldPolicy.trustedAuthorizationResolver = validAssurancePolicy.trustedAuthorizationResolver;
extraAssuranceFieldPolicy.assurance_lease.unbound_extra = true;
assert.strictEqual(api.selectRoute([...routeLanes, assuranceLane], assuranceAxes, assuranceRouteMatrix, extraAssuranceFieldPolicy).status, 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED');
const untrustedAssurancePolicy = { ...validAssurancePolicy, trustedAuthorizationResolver: undefined };
assert.strictEqual(api.selectRoute([...routeLanes, assuranceLane], assuranceAxes, assuranceRouteMatrix, untrustedAssurancePolicy).status, 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED');
for (const malformedAxes of [
  { ...assuranceAxes, plan_ref: { content_sha256: assuranceAxes.plan_ref.content_sha256 } },
  { ...assuranceAxes, plan_ref: { artifact_id: assuranceAxes.plan_ref.artifact_id, content_sha256: 'not-a-sha' } },
  { ...assuranceAxes, resource_scope: [] },
]) assert.strictEqual(api.selectRoute([...routeLanes, assuranceLane], malformedAxes, assuranceRouteMatrix, validAssurancePolicy).status, 'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED');
assert.strictEqual(
  api.selectRoute([...routeLanes, assuranceLane], assuranceAxes, assuranceRouteMatrix, { now: fixedNow, assurance_authorization: true, assurance_lease: {} }).status,
  'HOLD_ASSURANCE_AUTHORIZATION_REQUIRED',
  'an unbound assurance flag and empty lease must not permit assurance routing',
);
assert.strictEqual(api.validateRouteDecision(lowRiskRoute, routeLanes, lowRiskAxes, routeMatrix, { now: fixedNow }), true);
for (const [field, value] of [['required_validation', 'none'], ['reasons', ['forged']], ['fallbacks', ['below-floor']], ['capability_class', 'assurance']]) {
  const forgedDecision = clone(lowRiskRoute);
  forgedDecision[field] = value;
  assert.strictEqual(api.validateRouteDecision(forgedDecision, routeLanes, lowRiskAxes, routeMatrix, { now: fixedNow }), false, `forged ${field} must reject`);
}
const extraDecision = clone(lowRiskRoute);
extraDecision.actual_model = 'forged';
assert.strictEqual(api.validateRouteDecision(extraDecision, routeLanes, lowRiskAxes, routeMatrix, { now: fixedNow }), false);

// Task 4 RED: capability intersection controls topology, and a complete task packet is mandatory for dispatch.
function supportedCapability(capabilityId, subject = 'adapter', scope = null) {
  const capability = clone(validMatrix.capabilities[0]);
  capability.capability_id = capabilityId;
  capability.subject = subject;
  if (scope) capability.scope = clone(scope);
  capability.evidence_ref = `evidence-${subject}-${capabilityId}-${capability.scope.adapter_generation}`;
  capability.probe.nonce = `nonce-${subject}-${capabilityId}-${capability.scope.adapter_generation}`;
  capability.probe.ack_ref = `ack-${subject}-${capabilityId}-${capability.scope.adapter_generation}`;
  return capability;
}
const adapterOnlyMatrix = clone(validMatrix);
adapterOnlyMatrix.capabilities = [
  supportedCapability('spawn_child'),
  supportedCapability('collect_result'),
  supportedCapability('root_to_child_message'),
  supportedCapability('child_to_root_message'),
  supportedCapability('runtime_liveness'),
];
seal(adapterOnlyMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(adapterOnlyMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(
  api.selectTopology(adapterOnlyMatrix, { child_useful: true, requires_interaction: true }, fixedNow).topology,
  'serial_fallback',
  'adapter-only evidence must not impersonate a root/child capability intersection',
);
const interactiveMatrix = clone(validMatrix);
interactiveMatrix.capabilities = [
  supportedCapability('spawn_child', 'root'),
  supportedCapability('collect_result', 'root'),
  supportedCapability('root_to_child_message', 'root'),
  supportedCapability('child_to_root_message', 'child'),
  supportedCapability('runtime_liveness', 'root'),
];
seal(interactiveMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(interactiveMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.deepStrictEqual(
  api.selectTopology(interactiveMatrix, { child_useful: true, requires_interaction: true }, fixedNow),
  { topology: 'interactive_shared', reasons: ['fresh_interactive_intersection'], downgrade: 'assignment_only' },
);
interactiveMatrix.capabilities[2].support = 'request_only';
seal(interactiveMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(interactiveMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(
  api.selectTopology(interactiveMatrix, { child_useful: true, requires_interaction: true }, fixedNow).topology,
  'assignment_only',
  'communication failure must downgrade topology without changing route selection',
);
const scopeDriftMatrix = clone(interactiveMatrix);
scopeDriftMatrix.capabilities[2].support = 'supported';
scopeDriftMatrix.capabilities[3].scope.adapter_generation = 2;
scopeDriftMatrix.capabilities[3].evidence_ref = 'evidence-child-child_to_root_message-2';
scopeDriftMatrix.capabilities[3].probe.nonce = 'nonce-child-child_to_root_message-2';
scopeDriftMatrix.capabilities[3].probe.ack_ref = 'ack-child-child_to_root_message-2';
seal(scopeDriftMatrix, computeContentSha256);
assert.strictEqual(validateArtifact(scopeDriftMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(
  api.selectTopology(scopeDriftMatrix, { child_useful: true, requires_interaction: true }, fixedNow).topology,
  'assignment_only',
  'interactive evidence from a different adapter generation must not satisfy the intersection',
);

const completeTaskPacket = {
  packet_version: 1,
  phase_id: 'route',
  objective: 'choose one safe route',
  acceptance_criteria: ['selection is evidence-bound'],
  dependency_artifact_hashes: ['a'.repeat(64)],
  owned_paths_resources: ['logical:route-result'],
  forbidden_actions: ['push'],
  authorization_scope: 'local-plan-b',
  allowed_capabilities: ['collect_result'],
  expected_output_schema: 'RouteDecision1',
  validation_commands: ['node test/collaboration-contract.test.js'],
  timeout_progress_contract: { timeout_seconds: 30, progress_interval_seconds: 10 },
  cleanup_duties: ['close command session'],
  return_channel: 'root-collect',
};
assert.deepStrictEqual(api.validateTaskPacket(completeTaskPacket).missing, []);
const incompleteTaskPacket = { ...completeTaskPacket };
delete incompleteTaskPacket.cleanup_duties;
assert.deepStrictEqual(api.validateTaskPacket(incompleteTaskPacket).missing, ['cleanup_duties']);
const emptyShellTaskPacket = Object.fromEntries(Object.keys(completeTaskPacket).map((key) => [key, null]));
emptyShellTaskPacket.phase_id = 'route';
assert.strictEqual(api.validateTaskPacket(emptyShellTaskPacket).valid, false, 'present-but-null safety fields must reject');
const extraKeyTaskPacket = { ...completeTaskPacket, unbound_extra: true };
assert.strictEqual(api.validateTaskPacket(extraKeyTaskPacket).valid, false, 'task packets must reject additional properties');
const invalidTimeoutTaskPacket = clone(completeTaskPacket);
invalidTimeoutTaskPacket.timeout_progress_contract = { timeout_seconds: 10, progress_interval_seconds: 20 };
assert.strictEqual(api.validateTaskPacket(invalidTimeoutTaskPacket).valid, false, 'progress interval cannot exceed timeout');
const overlongTaskPacket = clone(completeTaskPacket);
overlongTaskPacket.objective = 'x'.repeat((8 * 1024 * 1024) + 1);
assert.deepStrictEqual(api.validateTaskPacket(overlongTaskPacket).invalid, ['CONTRACT_LIMIT_EXCEEDED'], 'direct packet validation must enforce the canonical byte budget');
const oversizedArrayTaskPacket = clone(completeTaskPacket);
oversizedArrayTaskPacket.acceptance_criteria = Array.from({ length: 100001 }, () => 'criterion');
assert.deepStrictEqual(api.validateTaskPacket(oversizedArrayTaskPacket).invalid, ['CONTRACT_LIMIT_EXCEEDED'], 'direct packet validation must enforce the canonical array budget');
const tooDeepTaskPacket = clone(completeTaskPacket);
let deepPacketValue = 'leaf';
for (let depth = 0; depth < 66; depth += 1) deepPacketValue = { nested: deepPacketValue };
tooDeepTaskPacket.objective = deepPacketValue;
assert.deepStrictEqual(api.validateTaskPacket(tooDeepTaskPacket).invalid, ['CONTRACT_LIMIT_EXCEEDED'], 'direct packet validation must enforce the canonical depth budget');

// Task 4 RED: plans must bind references, reject cyclic dependencies, and serialize shared writes.
const taskPacketArtifact = {
  schema: 'TaskPacket1', schema_version: 1, artifact_id: 'packet-route-A', run_id: 'run-A', session_id: 'sess-A',
  created_at: fixedNow, producer: { role: 'root', adapter_id: 'adapter-A' }, redaction: { policy: 'metadata_only' },
  packet: completeTaskPacket, content_sha256: '0'.repeat(64),
};
seal(taskPacketArtifact, computeContentSha256);
const validPlan = {
  schema: 'CollaborationPlan1', schema_version: 1, artifact_id: 'plan-A', run_id: 'run-A', session_id: 'sess-A',
  created_at: fixedNow, producer: { role: 'root', adapter_id: 'adapter-A' }, redaction: { policy: 'metadata_only' },
  status: 'VALIDATED', topology: 'serial_fallback', capability_matrix_ref: { artifact_id: validMatrix.artifact_id, content_sha256: validMatrix.content_sha256 },
  phases: [{
    phase_id: 'route', task_type: 'classification', scope: 'single_unit', dependencies: [], risk: 'low', reversibility: 'reversible', phase_kind: 'test_gates', latency_cost: 'interactive', validation_failure_cost: 'automatic_check',
    task_packet_ref: { artifact_id: taskPacketArtifact.artifact_id, content_sha256: taskPacketArtifact.content_sha256 }, ownership: { exclusive_paths: ['logical:route-output'] },
    route: { requested_model: 'unspecified', requested_effort: 'unspecified', selected_model: 'lane-light', selected_effort: 'low', selection_evidence: 'available-light', allowed_fallbacks: [] },
  }],
  resource_policy: {}, failure_policy: {}, telemetry_policy: {}, gates: { authorization: {}, pre_dispatch: {}, root_review: {}, verification: {}, cleanup: {} }, content_sha256: '0'.repeat(64),
};
seal(validPlan, computeContentSha256);
const planArtifacts = new Map([[validMatrix.artifact_id, validMatrix], [taskPacketArtifact.artifact_id, taskPacketArtifact]]);
assert.strictEqual(api.validateCollaborationPlan(validPlan, planArtifacts, { now: fixedNow }).valid, true);
assert.strictEqual(api.validateArtifact(validPlan, { now: fixedNow, artifactIndex: planArtifacts }).valid, true, 'public validator must dispatch CollaborationPlan1 by schema');
assert.strictEqual(api.validateArtifactSet([validPlan, validMatrix, taskPacketArtifact], { now: fixedNow }).valid, true, 'mixed public artifact set must validate transactionally');
const unauthorizedExecutablePlan = clone(validPlan);
unauthorizedExecutablePlan.status = 'AUTHORIZED';
unauthorizedExecutablePlan.phases[0].risk = 'extreme';
unauthorizedExecutablePlan.phases[0].reversibility = 'irreversible';
unauthorizedExecutablePlan.phases[0].validation_failure_cost = 'full_surface_audit';
seal(unauthorizedExecutablePlan, computeContentSha256);
expectError(api.validateCollaborationPlan(unauthorizedExecutablePlan, planArtifacts, { now: fixedNow }), 'PLAN_AUTHORIZATION_REQUIRED');

const authorizationEvidence = sealSource({
  evidence_id: 'approval-plan-route-A', evidence_class: 'direct_user_approval', actor_id: 'user-A',
  observed_at: '2026-08-26T03:00:00Z', evidence_refs: ['approval-message-A'], source_sha256: '0'.repeat(64),
});
function bindPlanAuthorization(plan) {
  plan.status = 'AUTHORIZED';
  plan.gates.authorization = {
    authorization_ref: 'authorization-plan-route-A', actor_id: 'user-A', scope: `collaboration-plan:${plan.artifact_id}`,
    allowed_source_evidence_classes: ['direct_user_approval'],
  };
  seal(plan, computeContentSha256);
  const authorization = sealSource({
    authorization_id: plan.gates.authorization.authorization_ref, actor_id: 'user-A', actor_kind: 'human',
    scope: plan.gates.authorization.scope, action: 'execute_plan', resource_ids: plan.phases.map((phase) => `phase:${phase.phase_id}`),
    issued_at: '2026-08-26T03:01:00Z', expires_at: '2026-08-26T03:10:00Z',
    plan_ref: { artifact_id: plan.artifact_id, content_sha256: plan.content_sha256 },
    source_evidence_ref: authorizationEvidence.evidence_id, source_sha256: '0'.repeat(64),
  });
  return {
    now: fixedNow,
    availableLanes: routeLanes,
    authorizationIndex: { [authorization.authorization_id]: authorization },
    authorizationEvidenceIndex: { [authorizationEvidence.evidence_id]: authorizationEvidence },
    trustedAuthorizationResolver: ({ purpose }) => purpose === 'authorization',
  };
}
const authorizedPlan = clone(validPlan);
authorizedPlan.artifact_id = 'plan-authorized-route-A';
authorizedPlan.topology = 'single';
authorizedPlan.capability_matrix_ref = { artifact_id: routeMatrix.artifact_id, content_sha256: routeMatrix.content_sha256 };
authorizedPlan.phases[0].phase_kind = 'diagnosis';
authorizedPlan.phases[0].route = {
  requested_model: 'unspecified', requested_effort: 'unspecified', selected_model: 'lane-light', selected_effort: 'low',
  selection_evidence: 'available-light', allowed_fallbacks: ['lane-standard'],
};
const authorizedPlanOptions = bindPlanAuthorization(authorizedPlan);
const authorizedPlanArtifacts = new Map([[routeMatrix.artifact_id, routeMatrix], [taskPacketArtifact.artifact_id, taskPacketArtifact]]);
assert.strictEqual(
  validateArtifact(routeMatrix, { now: fixedNow, expectedSessionId: 'sess-A' }).valid,
  true,
  'authorized-plan test must establish a fresh capability authorization generation',
);
const authorizedExpectedRoute = api.selectRoute(routeLanes, {
  phase_id: authorizedPlan.phases[0].phase_id,
  task_type: authorizedPlan.phases[0].task_type,
  scope: authorizedPlan.phases[0].scope,
  risk: authorizedPlan.phases[0].risk,
  reversibility: authorizedPlan.phases[0].reversibility,
  phase_kind: authorizedPlan.phases[0].phase_kind,
  latency_cost: authorizedPlan.phases[0].latency_cost,
  validation_failure_cost: authorizedPlan.phases[0].validation_failure_cost,
  requested_model: authorizedPlan.phases[0].route.requested_model,
  requested_effort: authorizedPlan.phases[0].route.requested_effort,
}, routeMatrix, { now: fixedNow });
const authorizedPlanResult = api.validateCollaborationPlan(authorizedPlan, authorizedPlanArtifacts, authorizedPlanOptions);
assert.strictEqual(
  authorizedPlanResult.valid,
  true,
  `an exact scope-bound authorization and independently recomputed route must validate: expected=${JSON.stringify(authorizedExpectedRoute)} errors=${JSON.stringify(authorizedPlanResult.errors)}`,
);
const forgedAuthorizedRoute = clone(authorizedPlan);
forgedAuthorizedRoute.phases[0].route.selected_model = 'lane-standard';
forgedAuthorizedRoute.phases[0].route.selected_effort = 'medium';
forgedAuthorizedRoute.phases[0].route.selection_evidence = 'available-standard';
const forgedAuthorizedRouteOptions = bindPlanAuthorization(forgedAuthorizedRoute);
expectError(
  api.validateCollaborationPlan(forgedAuthorizedRoute, authorizedPlanArtifacts, forgedAuthorizedRouteOptions),
  'PLAN_ROUTE_EVIDENCE_REQUIRED',
);
const unsupportedTopologyPlan = clone(validPlan);
unsupportedTopologyPlan.topology = 'interactive_shared';
seal(unsupportedTopologyPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(unsupportedTopologyPlan, planArtifacts, { now: fixedNow }), 'PLAN_TOPOLOGY_CAPABILITY_MISMATCH');
const shadowMatrix = clone(validMatrix);
shadowMatrix.capabilities[0].support = 'unsupported';
seal(shadowMatrix, computeContentSha256);
expectError(
  api.validateCollaborationPlan(validPlan, [shadowMatrix, validMatrix, taskPacketArtifact], { now: fixedNow }),
  'DUPLICATE_ARTIFACT_ID',
);
const validPlanFixture = loadJson('plan-valid.json');
assert.strictEqual(api.validateCollaborationPlan(validPlanFixture, planArtifacts, { now: fixedNow }).valid, true, 'plan-valid fixture must be semantically valid, not merely parseable');
assert.strictEqual(api.validateTaskPacket(loadJson('plan-incomplete-packet.json')).valid, false, 'incomplete-packet fixture must fail packet semantics');
expectError(api.validateCollaborationPlan(loadJson('plan-cyclic.json'), planArtifacts, { now: fixedNow }), 'PLAN_DEPENDENCY_CYCLE');
expectError(api.validateCollaborationPlan(loadJson('plan-shared-write.json'), planArtifacts, { now: fixedNow }), 'SHARED_WRITE_CONFLICT');
function planWithTaskPacket(packetArtifact) {
  const plan = clone(validPlan);
  plan.phases[0].task_packet_ref = { artifact_id: packetArtifact.artifact_id, content_sha256: packetArtifact.content_sha256 };
  seal(plan, computeContentSha256);
  return { plan, artifacts: new Map([[validMatrix.artifact_id, validMatrix], [packetArtifact.artifact_id, packetArtifact]]) };
}
const wrongSchemaPacket = clone(taskPacketArtifact);
wrongSchemaPacket.schema = 'NotTaskPacket1';
seal(wrongSchemaPacket, computeContentSha256);
let packetCase = planWithTaskPacket(wrongSchemaPacket);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'TASK_PACKET_SCHEMA_INVALID');
const incompleteReferencedPacket = clone(taskPacketArtifact);
delete incompleteReferencedPacket.packet.cleanup_duties;
seal(incompleteReferencedPacket, computeContentSha256);
packetCase = planWithTaskPacket(incompleteReferencedPacket);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'TASK_PACKET_INCOMPLETE');
const wrongPhasePacket = clone(taskPacketArtifact);
wrongPhasePacket.packet.phase_id = 'different-phase';
seal(wrongPhasePacket, computeContentSha256);
packetCase = planWithTaskPacket(wrongPhasePacket);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'TASK_PACKET_PHASE_MISMATCH');
const badHashPacket = clone(taskPacketArtifact);
badHashPacket.content_sha256 = '0'.repeat(64);
packetCase = planWithTaskPacket(badHashPacket);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'ARTIFACT_SET_MEMBER_INVALID');
const missingEnvelopePacket = clone(taskPacketArtifact);
delete missingEnvelopePacket.producer;
seal(missingEnvelopePacket, computeContentSha256);
packetCase = planWithTaskPacket(missingEnvelopePacket);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'TASK_PACKET_ARTIFACT_INVALID');
const emptyShellPacketArtifact = clone(taskPacketArtifact);
emptyShellPacketArtifact.packet = clone(emptyShellTaskPacket);
seal(emptyShellPacketArtifact, computeContentSha256);
packetCase = planWithTaskPacket(emptyShellPacketArtifact);
expectError(api.validateCollaborationPlan(packetCase.plan, packetCase.artifacts), 'TASK_PACKET_INCOMPLETE');
const fakeCapabilityMatrix = {
  schema: 'NotCapabilityMatrix1', schema_version: 99, artifact_id: 'fake-capability-A', run_id: 'run-A', session_id: 'sess-A',
  content_sha256: 'c'.repeat(64),
};
seal(fakeCapabilityMatrix, computeContentSha256);
const fakeCapabilityPlan = clone(validPlan);
fakeCapabilityPlan.capability_matrix_ref = { artifact_id: fakeCapabilityMatrix.artifact_id, content_sha256: fakeCapabilityMatrix.content_sha256 };
seal(fakeCapabilityPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(fakeCapabilityPlan, new Map([[fakeCapabilityMatrix.artifact_id, fakeCapabilityMatrix], [taskPacketArtifact.artifact_id, taskPacketArtifact]]), { now: fixedNow }), 'CAPABILITY_MATRIX_INVALID');
const emptyOwnershipPlan = clone(validPlan);
emptyOwnershipPlan.phases[0].ownership = {};
seal(emptyOwnershipPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(emptyOwnershipPlan, planArtifacts, { now: fixedNow }), 'PLAN_OWNERSHIP_INVALID');
for (const commonField of ['created_at', 'producer', 'redaction']) {
  const missingCommonFieldPlan = clone(validPlan);
  delete missingCommonFieldPlan[commonField];
  seal(missingCommonFieldPlan, computeContentSha256);
  expectError(api.validateCollaborationPlan(missingCommonFieldPlan, planArtifacts), 'PLAN_COMMON_FIELD_MISSING');
}
const extraRootFieldPlan = clone(validPlan);
extraRootFieldPlan.untrusted_root_field = true;
seal(extraRootFieldPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(extraRootFieldPlan, planArtifacts), 'PLAN_ADDITIONAL_PROPERTY');
const extraPhaseFieldPlan = clone(validPlan);
extraPhaseFieldPlan.phases[0].untrusted_phase_field = true;
seal(extraPhaseFieldPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(extraPhaseFieldPlan, planArtifacts), 'PLAN_ADDITIONAL_PROPERTY');
const incompleteRoutePlan = clone(validPlan);
delete incompleteRoutePlan.phases[0].route.selection_evidence;
seal(incompleteRoutePlan, computeContentSha256);
expectError(api.validateCollaborationPlan(incompleteRoutePlan, planArtifacts), 'PLAN_ROUTE_INVALID');
const invalidPhaseAxisPlan = clone(validPlan);
invalidPhaseAxisPlan.phases[0].risk = 'catastrophic';
seal(invalidPhaseAxisPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(invalidPhaseAxisPlan, planArtifacts), 'PLAN_PHASE_AXIS_INVALID');
const cyclicPlan = clone(validPlan);
cyclicPlan.phases = [
  { ...cyclicPlan.phases[0], phase_id: 'left', dependencies: ['right'], ownership: { exclusive_paths: ['logical:left'] } },
  { ...cyclicPlan.phases[0], phase_id: 'right', dependencies: ['left'], ownership: { exclusive_paths: ['logical:right'] } },
];
seal(cyclicPlan, computeContentSha256);
expectError(api.validateCollaborationPlan(cyclicPlan, planArtifacts), 'PLAN_DEPENDENCY_CYCLE');
const sharedWritePlan = clone(validPlan);
sharedWritePlan.phases = [
  { ...sharedWritePlan.phases[0], phase_id: 'writer-one', ownership: { exclusive_paths: ['logical:shared'] } },
  { ...sharedWritePlan.phases[0], phase_id: 'writer-two', ownership: { exclusive_paths: ['logical:shared'] } },
];
seal(sharedWritePlan, computeContentSha256);
expectError(api.validateCollaborationPlan(sharedWritePlan, planArtifacts), 'SHARED_WRITE_CONFLICT');

// R5 transactionality: a rejected mixed artifact/plan transaction must never publish route authorization.
function makeFreshTransactionalPlanCase(caseId) {
  const matrix = clone(routeMatrix);
  matrix.artifact_id = `capability-transaction-${caseId}`;
  seal(matrix, computeContentSha256);
  const packet = clone(taskPacketArtifact);
  packet.artifact_id = `packet-transaction-${caseId}`;
  seal(packet, computeContentSha256);
  const plan = clone(validPlan);
  plan.artifact_id = `plan-transaction-${caseId}`;
  plan.capability_matrix_ref = { artifact_id: matrix.artifact_id, content_sha256: matrix.content_sha256 };
  plan.phases[0].task_packet_ref = { artifact_id: packet.artifact_id, content_sha256: packet.content_sha256 };
  seal(plan, computeContentSha256);
  return { matrix, packet, plan, artifacts: [matrix, packet] };
}

function routeStatusFor(matrix) {
  return api.selectRoute(routeLanes, lowRiskAxes, matrix, { now: fixedNow }).status;
}

function assertRejectedPlanDoesNotAuthorize(caseId, expectedCode, arrangeFailure) {
  const candidate = makeFreshTransactionalPlanCase(caseId);
  const arrangedArtifacts = arrangeFailure(candidate) || candidate.artifacts;
  seal(candidate.plan, computeContentSha256);
  assert.strictEqual(routeStatusFor(candidate.matrix), 'HOLD_ROUTE_UNAVAILABLE', `${caseId}: candidate matrix must begin unauthorized`);
  const result = api.validateCollaborationPlan(candidate.plan, arrangedArtifacts, { now: fixedNow });
  expectError(result, expectedCode);
  assert.strictEqual(result.valid, false, `${caseId}: rejected plan must remain invalid`);
  assert.strictEqual(routeStatusFor(candidate.matrix), 'HOLD_ROUTE_UNAVAILABLE', `${caseId}: rejected plan must not publish matrix authorization`);
}

assertRejectedPlanDoesNotAuthorize('array-own-hash', 'ARTIFACT_SET_MEMBER_INVALID', (candidate) => {
  const unrelated = clone(candidate.packet);
  unrelated.artifact_id = 'packet-unrelated-invalid-hash';
  seal(unrelated, computeContentSha256);
  unrelated.content_sha256 = '0'.repeat(64);
  return [...candidate.artifacts, unrelated];
});
assertRejectedPlanDoesNotAuthorize('array-duplicate-id', 'DUPLICATE_ARTIFACT_ID', (candidate) => (
  [candidate.matrix, clone(candidate.matrix), candidate.packet]
));
assertRejectedPlanDoesNotAuthorize('map-key-mismatch', 'ARTIFACT_INDEX_INVALID', (candidate) => {
  const unrelated = clone(candidate.packet);
  unrelated.artifact_id = 'packet-map-key-mismatch';
  seal(unrelated, computeContentSha256);
  return new Map([
    [candidate.matrix.artifact_id, candidate.matrix],
    [candidate.packet.artifact_id, candidate.packet],
    ['wrong-map-key', unrelated],
  ]);
});
assertRejectedPlanDoesNotAuthorize('map-own-hash', 'ARTIFACT_SET_MEMBER_INVALID', (candidate) => {
  const unrelated = clone(candidate.packet);
  unrelated.artifact_id = 'packet-map-invalid-hash';
  seal(unrelated, computeContentSha256);
  unrelated.content_sha256 = '0'.repeat(64);
  return new Map([
    [candidate.matrix.artifact_id, candidate.matrix],
    [candidate.packet.artifact_id, candidate.packet],
    [unrelated.artifact_id, unrelated],
  ]);
});

assertRejectedPlanDoesNotAuthorize('missing-reference', 'ARTIFACT_REFERENCE_MISSING', (candidate) => {
  candidate.plan.capability_matrix_ref.artifact_id = 'missing-capability-matrix';
});
assertRejectedPlanDoesNotAuthorize('hash-reference', 'ARTIFACT_REFERENCE_HASH_MISMATCH', (candidate) => {
  candidate.plan.capability_matrix_ref.content_sha256 = '0'.repeat(64);
});
assertRejectedPlanDoesNotAuthorize('session-reference', 'ARTIFACT_REFERENCE_SESSION_MISMATCH', (candidate) => {
  candidate.matrix.session_id = 'other-session';
  seal(candidate.matrix, computeContentSha256);
  candidate.plan.capability_matrix_ref.content_sha256 = candidate.matrix.content_sha256;
});

assertRejectedPlanDoesNotAuthorize('matrix-schema', 'CAPABILITY_MATRIX_INVALID', (candidate) => {
  candidate.matrix.schema = 'NotCapabilityMatrix1';
  seal(candidate.matrix, computeContentSha256);
  candidate.plan.capability_matrix_ref.content_sha256 = candidate.matrix.content_sha256;
});
assertRejectedPlanDoesNotAuthorize('packet-schema', 'TASK_PACKET_SCHEMA_INVALID', (candidate) => {
  candidate.packet.schema = 'NotTaskPacket1';
  seal(candidate.packet, computeContentSha256);
  candidate.plan.phases[0].task_packet_ref.content_sha256 = candidate.packet.content_sha256;
});
assertRejectedPlanDoesNotAuthorize('packet-own-hash', 'ARTIFACT_SET_MEMBER_INVALID', (candidate) => {
  candidate.packet.content_sha256 = '0'.repeat(64);
  candidate.plan.phases[0].task_packet_ref.content_sha256 = candidate.packet.content_sha256;
});
assertRejectedPlanDoesNotAuthorize('packet-incomplete', 'TASK_PACKET_INCOMPLETE', (candidate) => {
  delete candidate.packet.packet.cleanup_duties;
  seal(candidate.packet, computeContentSha256);
  candidate.plan.phases[0].task_packet_ref.content_sha256 = candidate.packet.content_sha256;
});
assertRejectedPlanDoesNotAuthorize('packet-phase', 'TASK_PACKET_PHASE_MISMATCH', (candidate) => {
  candidate.packet.packet.phase_id = 'other-phase';
  seal(candidate.packet, computeContentSha256);
  candidate.plan.phases[0].task_packet_ref.content_sha256 = candidate.packet.content_sha256;
});

assertRejectedPlanDoesNotAuthorize('plan-envelope', 'PLAN_ADDITIONAL_PROPERTY', (candidate) => {
  candidate.plan.untrusted_root_field = true;
});
assertRejectedPlanDoesNotAuthorize('plan-status', 'PLAN_STATUS_INVALID', (candidate) => {
  candidate.plan.status = 'UNCONTROLLED';
});
assertRejectedPlanDoesNotAuthorize('plan-topology-enum', 'PLAN_TOPOLOGY_INVALID', (candidate) => {
  candidate.plan.topology = 'uncontrolled';
});
assertRejectedPlanDoesNotAuthorize('plan-topology-capability', 'PLAN_TOPOLOGY_CAPABILITY_MISMATCH', (candidate) => {
  candidate.plan.topology = 'interactive_shared';
});
assertRejectedPlanDoesNotAuthorize('plan-empty-phases', 'PLAN_PHASES_INVALID', (candidate) => {
  candidate.plan.phases = [];
});
assertRejectedPlanDoesNotAuthorize('plan-duplicate-phase', 'PLAN_PHASE_DUPLICATE', (candidate) => {
  candidate.plan.phases.push(clone(candidate.plan.phases[0]));
});
assertRejectedPlanDoesNotAuthorize('plan-phase-axis', 'PLAN_PHASE_AXIS_INVALID', (candidate) => {
  candidate.plan.phases[0].risk = 'catastrophic';
});
assertRejectedPlanDoesNotAuthorize('plan-route', 'PLAN_ROUTE_INVALID', (candidate) => {
  delete candidate.plan.phases[0].route.selection_evidence;
});
assertRejectedPlanDoesNotAuthorize('plan-ownership', 'PLAN_OWNERSHIP_INVALID', (candidate) => {
  candidate.plan.phases[0].ownership = {};
});
assertRejectedPlanDoesNotAuthorize('plan-dependency-missing', 'PLAN_DEPENDENCY_MISSING', (candidate) => {
  candidate.plan.phases[0].dependencies = ['missing-phase'];
});
assertRejectedPlanDoesNotAuthorize('plan-dependency-cycle', 'PLAN_DEPENDENCY_CYCLE', (candidate) => {
  candidate.plan.phases = [
    { ...candidate.plan.phases[0], phase_id: 'left', dependencies: ['right'], ownership: { exclusive_paths: ['logical:left'] } },
    { ...candidate.plan.phases[0], phase_id: 'right', dependencies: ['left'], ownership: { exclusive_paths: ['logical:right'] } },
  ];
});
assertRejectedPlanDoesNotAuthorize('plan-shared-write', 'SHARED_WRITE_CONFLICT', (candidate) => {
  candidate.plan.phases = [
    { ...candidate.plan.phases[0], phase_id: 'writer-one', ownership: { exclusive_paths: ['logical:shared'] } },
    { ...candidate.plan.phases[0], phase_id: 'writer-two', ownership: { exclusive_paths: ['logical:shared'] } },
  ];
});

const tamperedPlanTransaction = makeFreshTransactionalPlanCase('plan-own-hash');
tamperedPlanTransaction.plan.content_sha256 = '0'.repeat(64);
assert.strictEqual(routeStatusFor(tamperedPlanTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE', 'tampered plan must begin with an unauthorized matrix');
const tamperedPlanResult = api.validateCollaborationPlan(tamperedPlanTransaction.plan, tamperedPlanTransaction.artifacts, { now: fixedNow });
expectError(tamperedPlanResult, 'CONTENT_HASH_MISMATCH');
assert.strictEqual(tamperedPlanResult.valid, false);
assert.strictEqual(routeStatusFor(tamperedPlanTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE', 'tampered plan must not authorize its matrix');

assertRejectedPlanDoesNotAuthorize('artifact-limit', 'CONTRACT_LIMIT_EXCEEDED', (candidate) => {
  const artifacts = [...candidate.artifacts];
  for (let index = 0; index < 255; index += 1) {
    const extra = clone(candidate.packet);
    extra.artifact_id = `packet-artifact-limit-${index}`;
    seal(extra, computeContentSha256);
    artifacts.push(extra);
  }
  return artifacts;
});
assertRejectedPlanDoesNotAuthorize('phase-limit', 'CONTRACT_LIMIT_EXCEEDED', (candidate) => {
  candidate.plan.phases = Array.from({ length: 257 }, (_, index) => ({
    ...clone(candidate.plan.phases[0]),
    phase_id: `phase-limit-${index}`,
    ownership: { exclusive_paths: [`logical:phase-limit-${index}`] },
  }));
});
assertRejectedPlanDoesNotAuthorize('dependency-limit', 'CONTRACT_LIMIT_EXCEEDED', (candidate) => {
  candidate.plan.phases[0].dependencies = Array.from({ length: 257 }, (_, index) => `missing-dependency-${index}`);
});
assertRejectedPlanDoesNotAuthorize('ownership-limit', 'CONTRACT_LIMIT_EXCEEDED', (candidate) => {
  candidate.plan.phases[0].ownership.exclusive_paths = Array.from({ length: 257 }, (_, index) => `logical:ownership-${index}`);
});
assertRejectedPlanDoesNotAuthorize('fallback-limit', 'CONTRACT_LIMIT_EXCEEDED', (candidate) => {
  candidate.plan.phases[0].route.allowed_fallbacks = Array.from({ length: 257 }, (_, index) => `fallback-${index}`);
});

const collectionFirstTransaction = makeFreshTransactionalPlanCase('collection-first');
collectionFirstTransaction.plan.status = 'UNCONTROLLED';
seal(collectionFirstTransaction.plan, computeContentSha256);
const collectionFirstInvalidMember = clone(collectionFirstTransaction.packet);
collectionFirstInvalidMember.artifact_id = 'packet-collection-first-invalid';
seal(collectionFirstInvalidMember, computeContentSha256);
collectionFirstInvalidMember.content_sha256 = '0'.repeat(64);
assert.strictEqual(routeStatusFor(collectionFirstTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');
const collectionFirstResult = api.validateCollaborationPlan(
  collectionFirstTransaction.plan,
  [...collectionFirstTransaction.artifacts, collectionFirstInvalidMember],
  { now: fixedNow },
);
assert.deepStrictEqual(codes(collectionFirstResult), ['ARTIFACT_SET_MEMBER_INVALID'], 'collection failure must precede every plan semantic gate');
assert.strictEqual(routeStatusFor(collectionFirstTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');

const oversizedCanaryTransaction = makeFreshTransactionalPlanCase('artifact-limit-canary');
let oversizedCanaryExecutions = 0;
const oversizedCanaryArtifacts = new Array(257);
oversizedCanaryArtifacts[0] = oversizedCanaryTransaction.matrix;
oversizedCanaryArtifacts[1] = oversizedCanaryTransaction.packet;
Object.defineProperty(oversizedCanaryArtifacts, '256', {
  enumerable: true,
  get() {
    oversizedCanaryExecutions += 1;
    throw new Error('oversized artifact canary executed');
  },
});
assert.strictEqual(routeStatusFor(oversizedCanaryTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');
const oversizedCanaryResult = api.validateCollaborationPlan(
  oversizedCanaryTransaction.plan,
  oversizedCanaryArtifacts,
  { now: fixedNow },
);
expectError(oversizedCanaryResult, 'CONTRACT_LIMIT_EXCEEDED');
assert.strictEqual(oversizedCanaryExecutions, 0, 'artifact limit must reject before detached snapshot reads members');
assert.strictEqual(routeStatusFor(oversizedCanaryTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');

const malformedGraphTransaction = makeFreshTransactionalPlanCase('malformed-graph');
malformedGraphTransaction.plan.phases = [
  { ...clone(malformedGraphTransaction.plan.phases[0]), phase_id: 'malformed-left', dependencies: 'malformed-right', ownership: { exclusive_paths: ['logical:malformed-shared'] } },
  { ...clone(malformedGraphTransaction.plan.phases[0]), phase_id: 'malformed-right', dependencies: [], ownership: { exclusive_paths: ['logical:malformed-shared'] } },
];
seal(malformedGraphTransaction.plan, computeContentSha256);
assert.strictEqual(routeStatusFor(malformedGraphTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');
const malformedGraphResult = api.validateCollaborationPlan(malformedGraphTransaction.plan, malformedGraphTransaction.artifacts, { now: fixedNow });
expectError(malformedGraphResult, 'PLAN_DEPENDENCIES_INVALID');
assert.strictEqual(codes(malformedGraphResult).includes('SHARED_WRITE_CONFLICT'), false, 'malformed dependencies must not drive shared-write inference');
assert.strictEqual(routeStatusFor(malformedGraphTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');

const duplicateGraphTransaction = makeFreshTransactionalPlanCase('duplicate-graph');
const duplicateGraphPhase = clone(duplicateGraphTransaction.plan.phases[0]);
duplicateGraphPhase.phase_id = 'duplicate-phase';
duplicateGraphPhase.dependencies = ['duplicate-phase'];
duplicateGraphTransaction.plan.phases = [
  { ...clone(duplicateGraphPhase), dependencies: [] },
  duplicateGraphPhase,
];
seal(duplicateGraphTransaction.plan, computeContentSha256);
assert.strictEqual(routeStatusFor(duplicateGraphTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');
const duplicateGraphResult = api.validateCollaborationPlan(duplicateGraphTransaction.plan, duplicateGraphTransaction.artifacts, { now: fixedNow });
expectError(duplicateGraphResult, 'PLAN_PHASE_DUPLICATE');
assert.strictEqual(codes(duplicateGraphResult).includes('PLAN_DEPENDENCY_CYCLE'), false, 'duplicate phase IDs must prevent graph analysis');
assert.strictEqual(routeStatusFor(duplicateGraphTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');

const malformedOwnershipTransaction = makeFreshTransactionalPlanCase('malformed-ownership-graph');
malformedOwnershipTransaction.plan.phases[0].ownership.exclusive_paths = ['logical:duplicate-owned-path', 'logical:duplicate-owned-path'];
seal(malformedOwnershipTransaction.plan, computeContentSha256);
assert.strictEqual(routeStatusFor(malformedOwnershipTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');
const malformedOwnershipResult = api.validateCollaborationPlan(malformedOwnershipTransaction.plan, malformedOwnershipTransaction.artifacts, { now: fixedNow });
expectError(malformedOwnershipResult, 'PLAN_OWNERSHIP_INVALID');
assert.strictEqual(codes(malformedOwnershipResult).includes('SHARED_WRITE_CONFLICT'), false, 'malformed ownership must not drive shared-write inference');
assert.strictEqual(routeStatusFor(malformedOwnershipTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE');

const successfulTransaction = makeFreshTransactionalPlanCase('success');
assert.strictEqual(routeStatusFor(successfulTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE', 'valid transaction must begin unauthorized');
assert.strictEqual(
  api.validateCollaborationPlan(successfulTransaction.plan, successfulTransaction.artifacts, { now: fixedNow }).valid,
  true,
  'the complete valid plan transaction must succeed',
);
assert.strictEqual(routeStatusFor(successfulTransaction.matrix), 'SELECTED', 'authorization must publish only after the complete plan succeeds');
const successfulMapTransaction = makeFreshTransactionalPlanCase('map-success');
const successfulMapArtifacts = new Map([
  [successfulMapTransaction.matrix.artifact_id, successfulMapTransaction.matrix],
  [successfulMapTransaction.packet.artifact_id, successfulMapTransaction.packet],
]);
assert.strictEqual(routeStatusFor(successfulMapTransaction.matrix), 'HOLD_ROUTE_UNAVAILABLE', 'valid Map transaction must begin unauthorized');
assert.strictEqual(
  api.validateCollaborationPlan(successfulMapTransaction.plan, successfulMapArtifacts, { now: fixedNow }).valid,
  true,
  'the complete valid Map transaction must succeed',
);
assert.strictEqual(routeStatusFor(successfulMapTransaction.matrix), 'SELECTED', 'Map authorization must publish only after complete success');
assert.strictEqual(
  validMatrix.capabilities.some((item) => item.capability_id === 'actual_model_metadata'),
  true,
);
assert.strictEqual(
  validMatrix.capabilities.some((item) => item.capability_id === 'model_request_control'),
  false,
  'actual host metadata must remain distinct from request control',
);
assert.strictEqual(isCapabilitySupported(validMatrix.capabilities[0], { now: fixedNow }), true);

// R6-1: freshness includes the supplied top-level hash, not only the hash-excluded content.
const suppliedHashTamper = clone(validMatrix);
assert.strictEqual(validateArtifact(suppliedHashTamper, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
suppliedHashTamper.content_sha256 = '0'.repeat(64);
assert.strictEqual(
  isCapabilitySupported(suppliedHashTamper.capabilities[0], { now: fixedNow }),
  false,
  'mutating only the supplied top-level hash must invalidate support tokens',
);
assert.deepStrictEqual(
  api.getEffectiveCapabilities(suppliedHashTamper, { now: fixedNow }),
  [],
  'mutating only the supplied top-level hash must invalidate effective capabilities',
);

// R6-2: descriptors are authoritative; a Proxy get trap must not upgrade unsupported evidence.
const descriptorUnsupported = clone(validMatrix);
descriptorUnsupported.capabilities[0].support = 'unsupported';
seal(descriptorUnsupported, computeContentSha256);
let splitGetExecutions = 0;
const splitCapability = new Proxy(descriptorUnsupported.capabilities[0], {
  get(target, property, receiver) {
    if (property === 'support') {
      splitGetExecutions += 1;
      return 'supported';
    }
    return Reflect.get(target, property, receiver);
  },
});
const descriptorSplitArtifact = clone(descriptorUnsupported);
descriptorSplitArtifact.capabilities[0] = splitCapability;
descriptorSplitArtifact.content_sha256 = descriptorUnsupported.content_sha256;
const descriptorSplitResult = validateArtifact(descriptorSplitArtifact, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(descriptorSplitResult.valid, true, JSON.stringify(descriptorSplitResult.errors));
assert.strictEqual(splitGetExecutions, 0, 'validation and hashing must not execute Proxy get traps');
assert.strictEqual(isCapabilitySupported(splitCapability, { now: fixedNow }), false, 'descriptor-unsupported evidence cannot obtain a support token');
const descriptorSplitEffective = api.getEffectiveCapabilities(descriptorSplitArtifact, { now: fixedNow });
const descriptorSplitSpawn = descriptorSplitEffective.find((entry) => entry.capability_id === 'spawn_child');
assert(descriptorSplitSpawn, 'descriptor-derived spawn capability must remain effective');
assert.strictEqual(descriptorSplitSpawn.support, 'unsupported', 'effective reduction must use descriptor-derived support');
assert.strictEqual(splitGetExecutions, 0, 'authorization gates must not execute Proxy get traps');

// R6-3: reflection/accessor failures are stable metadata-only ContractErrors and never execute accessors.
const reflectionSecret = 'C:\\Users\\alice\\private-token.txt';
const reflectionFailure = new Proxy({ schema: 'CapabilityMatrix1', content_sha256: '0'.repeat(64) }, {
  ownKeys() { throw new Error(reflectionSecret); },
});
let reflectionFailureResult;
assert.doesNotThrow(() => {
  reflectionFailureResult = validateArtifact(reflectionFailure, { now: fixedNow, expectedSessionId: 'sess-A' });
});
assert.strictEqual(reflectionFailureResult.valid, false);
assert(reflectionFailureResult.errors.every((entry) => entry instanceof ContractError));
assert(reflectionFailureResult.errors.every((entry) => entry.path === '$'));
assert(!JSON.stringify(reflectionFailureResult).includes(reflectionSecret), 'reflection failures must redact user-controlled exception text');
let hostileAccessorExecutions = 0;
const hostileAccessor = { schema: 'CapabilityMatrix1' };
Object.defineProperty(hostileAccessor, 'content_sha256', {
  enumerable: true,
  get() {
    hostileAccessorExecutions += 1;
    throw new Error(reflectionSecret);
  },
});
const hostileAccessorResult = validateArtifact(hostileAccessor, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(hostileAccessorResult.valid, false);
assert.strictEqual(hostileAccessorExecutions, 0, 'accessor rejection must not execute the accessor');
assert.deepStrictEqual(
  hostileAccessorResult.errors.map((entry) => [entry.code, entry.path, entry.message]),
  [['CANONICAL_REJECTED', '$', 'artifact input rejected']],
  'public validation boundaries must normalize accessor failures to fixed metadata',
);
assert(!JSON.stringify(hostileAccessorResult).includes(reflectionSecret), 'accessor failures must redact user-controlled exception text');

// R7-1: every public entry point must fail closed when Proxy reflection fails.
const revokedArtifactSet = Proxy.revocable([], {});
revokedArtifactSet.revoke();
let revokedArtifactSetResult;
assert.doesNotThrow(() => {
  revokedArtifactSetResult = validateArtifactSet(revokedArtifactSet.proxy, { now: fixedNow, expectedSessionId: 'sess-A' });
}, 'a revoked artifact-set Proxy must not escape a raw reflection error');
assert.strictEqual(revokedArtifactSetResult.valid, false);
assert(revokedArtifactSetResult.errors.every((entry) => entry instanceof ContractError && entry.path === '$'));

const hostileOptions = new Proxy({}, {
  getOwnPropertyDescriptor() { throw new Error(reflectionSecret); },
});
assert.deepStrictEqual(
  api.getEffectiveCapabilities(validMatrix, hostileOptions),
  [],
  'a hostile options Proxy must make the effective reducer fail closed',
);
assert.strictEqual(
  isCapabilitySupported(validMatrix.capabilities[0], hostileOptions),
  false,
  'a hostile options Proxy must make the support gate fail closed',
);

// R8-1: public ContractError instances from untrusted input must be redacted at public boundaries.
const forgedContractError = new ContractError('ATTACKER_CONTROLLED_CODE', reflectionSecret, reflectionSecret);
const forgedErrorOptions = new Proxy({}, {
  ownKeys() { throw forgedContractError; },
});
for (const [entryPoint, invoke] of [
  ['artifact', () => validateArtifact(clone(validMatrix), forgedErrorOptions)],
  ['artifact-set', () => validateArtifactSet([clone(validMatrix)], forgedErrorOptions)],
]) {
  const forgedErrorResult = invoke();
  assert.strictEqual(forgedErrorResult.valid, false, `${entryPoint} must reject hostile options`);
  assert.deepStrictEqual(
    forgedErrorResult.errors.map((entry) => [entry.code, entry.path, entry.message]),
    [['CANONICAL_REJECTED', '$', 'artifact input rejected']],
    `${entryPoint} must replace untrusted public ContractError metadata`,
  );
  assert(!JSON.stringify(forgedErrorResult).includes(reflectionSecret), `${entryPoint} must not disclose hostile exception text`);
}

// R8-2: a set reflection failure must invalidate every previously published capability token.
const firstPartiallyEnumeratedMember = clone(validMatrix);
const secondPartiallyEnumeratedMember = clone(validMatrix);
assert.strictEqual(validateArtifact(firstPartiallyEnumeratedMember, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(validateArtifact(secondPartiallyEnumeratedMember, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(isCapabilitySupported(firstPartiallyEnumeratedMember.capabilities[0], { now: fixedNow }), true);
assert.strictEqual(isCapabilitySupported(secondPartiallyEnumeratedMember.capabilities[0], { now: fixedNow }), true);
const partiallyEnumerableSet = new Proxy([firstPartiallyEnumeratedMember, secondPartiallyEnumeratedMember], {
  getOwnPropertyDescriptor(target, property) {
    if (property === '1') throw new Error(reflectionSecret);
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
});
const partiallyEnumerableResult = validateArtifactSet(partiallyEnumerableSet, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(partiallyEnumerableResult.valid, false);
assert.strictEqual(isCapabilitySupported(firstPartiallyEnumeratedMember.capabilities[0], { now: fixedNow }), false, 'partial set failure must invalidate first member token');
assert.strictEqual(isCapabilitySupported(secondPartiallyEnumeratedMember.capabilities[0], { now: fixedNow }), false, 'partial set failure must invalidate every remaining member token');

// R6-4: extension namespace failures use a fixed wildcard path, never the rejected key.
const invalidExtensionKey = 'C:\\Users\\alice\\secret-extension';
const invalidExtensionNamespace = clone(validMatrix);
invalidExtensionNamespace.extensions = { [invalidExtensionKey]: true };
seal(invalidExtensionNamespace, computeContentSha256);
const invalidExtensionResult = validateArtifact(invalidExtensionNamespace, { now: fixedNow, expectedSessionId: 'sess-A' });
expectError(invalidExtensionResult, 'EXTENSION_NAMESPACE_INVALID');
const extensionNamespaceError = invalidExtensionResult.errors.find((entry) => entry.code === 'EXTENSION_NAMESPACE_INVALID');
assert.strictEqual(extensionNamespaceError.path, '$.extensions.*');
assert(!JSON.stringify(extensionNamespaceError).includes(invalidExtensionKey), 'extension failure metadata must not contain the rejected key');

// R6-5: optional probe data is structurally validated even at VERIFIED, and PROBED requires probe source/fields.
const verifiedMalformedProbe = clone(validMatrix);
verifiedMalformedProbe.capabilities[0].evidence_level = 'VERIFIED';
verifiedMalformedProbe.capabilities[0].source_kind = 'verifier';
verifiedMalformedProbe.capabilities[0].probe = { session_id: 'sess-A' };
verifiedMalformedProbe.capabilities[0].verification = {
  verifier_id: 'verifier-A',
  artifact_id: 'verified-target-A',
  content_sha256: 'a'.repeat(64),
};
seal(verifiedMalformedProbe, computeContentSha256);
assert.strictEqual(
  validateArtifact(verifiedMalformedProbe, { now: fixedNow, expectedSessionId: 'sess-A' }).valid,
  false,
  'malformed optional probe must not be accepted at VERIFIED',
);
const probedWrongSource = clone(validMatrix);
probedWrongSource.capabilities[0].source_kind = 'inventory';
seal(probedWrongSource, computeContentSha256);
expectError(validateArtifact(probedWrongSource, { now: fixedNow, expectedSessionId: 'sess-A' }), 'PROBE_ACK_REQUIRED');

// R6-7: inherited nested fields never satisfy required data-property contracts.
const inheritedNestedCases = [];
const inheritedScope = clone(validMatrix);
inheritedScope.capabilities[0].scope = inheritedDescriptorView({
  auth_fingerprint: 'auth-fingerprint-A',
  adapter_generation: 1,
}, { adapter_fingerprint: 'adapter-fingerprint-A' });
seal(inheritedScope, computeContentSha256);
inheritedNestedCases.push(['scope', inheritedScope]);

const inheritedProbe = clone(validMatrix);
inheritedProbe.capabilities[0].probe = inheritedDescriptorView({
  session_id: 'sess-A',
  ack_ref: 'spawn-ack-A',
}, { nonce: 'spawn-nonce-A' });
seal(inheritedProbe, computeContentSha256);
inheritedNestedCases.push(['probe', inheritedProbe]);

const inheritedVerification = clone(validMatrix);
inheritedVerification.capabilities[0].evidence_level = 'VERIFIED';
inheritedVerification.capabilities[0].source_kind = 'verifier';
inheritedVerification.capabilities[0].verification = inheritedDescriptorView({
  verifier_id: 'verifier-A',
  artifact_id: 'verified-target-A',
}, { content_sha256: 'a'.repeat(64) });
seal(inheritedVerification, computeContentSha256);
inheritedNestedCases.push(['verification', inheritedVerification]);

const inheritedContradiction = clone(validMatrix);
inheritedContradiction.capabilities[0].contradictions = [inheritedDescriptorView({
  observed_at: inheritedContradiction.capabilities[0].observed_at,
  support: 'unsupported',
  source_kind: 'runtime_event',
  reason_code: 'same-time-observation',
}, { evidence_ref: 'inherited-contradiction-ref' })];
seal(inheritedContradiction, computeContentSha256);
inheritedNestedCases.push(['contradiction', inheritedContradiction]);

for (const [nestedName, inheritedArtifact] of inheritedNestedCases) {
  assert.strictEqual(
    validateArtifact(inheritedArtifact, { now: fixedNow, expectedSessionId: 'sess-A' }).valid,
    false,
    `inherited ${nestedName} fields must not satisfy the contract`,
  );
}

// R6-8: compare the full decimal fraction; Date.parse truncation must not hide a newer contradiction.
const fractionalContradiction = clone(validMatrix);
fractionalContradiction.capabilities[0].observed_at = '2026-08-26T03:00:00.0001Z';
fractionalContradiction.capabilities[0].contradictions = [{
  evidence_ref: 'fractionally-newer-contradiction',
  observed_at: '2026-08-26T03:00:00.0002Z',
  support: 'unsupported',
  source_kind: 'runtime_event',
  reason_code: 'fractional-ordering',
}];
seal(fractionalContradiction, computeContentSha256);
expectError(
  validateArtifact(fractionalContradiction, { now: fixedNow, expectedSessionId: 'sess-A' }),
  'CAPABILITY_CONTRADICTED',
);

const mutatedAfterValidation = clone(validMatrix);
mutatedAfterValidation.capabilities[0].support = 'unsupported';
seal(mutatedAfterValidation, computeContentSha256);
assert.strictEqual(validateArtifact(mutatedAfterValidation, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
mutatedAfterValidation.capabilities[0].support = 'supported';
assert.strictEqual(isCapabilitySupported(mutatedAfterValidation.capabilities[0], { now: fixedNow }), false, 'mutating a validated capability must invalidate its gate token');
assert.deepStrictEqual(api.getEffectiveCapabilities(mutatedAfterValidation, { now: fixedNow }), [], 'mutating a validated artifact must invalidate effective capabilities');

const validSetMember = clone(validMatrix);
assert.strictEqual(validateArtifact(validSetMember, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
const invalidSetMember = clone(validMatrix);
invalidSetMember.artifact_id = 'capability-invalid-set-member';
invalidSetMember.schema = 'NotCapabilityMatrix';
seal(invalidSetMember, computeContentSha256);
const failedSet = validateArtifactSet([validSetMember, invalidSetMember], { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(failedSet.valid, false);
assert.strictEqual(isCapabilitySupported(validSetMember.capabilities[0], { now: fixedNow }), false, 'failed artifact sets must not publish partial capability tokens');

const declaredCapability = clone(validMatrix);
declaredCapability.capabilities[0].evidence_level = 'DECLARED';
declaredCapability.capabilities[0].source_kind = 'inventory';
delete declaredCapability.capabilities[0].probe;
seal(declaredCapability, computeContentSha256);
assert.strictEqual(validateArtifact(declaredCapability, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, true);
assert.strictEqual(
  isCapabilitySupported(declaredCapability.capabilities[0], { now: fixedNow }),
  false,
  'DECLARED evidence must never satisfy a dispatch/support gate',
);

const supersededMatrix = clone(validMatrix);
const oldCapability = clone(supersededMatrix.capabilities[0]);
oldCapability.evidence_ref = 'probe-spawn-old';
oldCapability.probe.nonce = 'spawn-nonce-old';
const newerUnsupported = clone(oldCapability);
newerUnsupported.evidence_ref = 'probe-spawn-new';
newerUnsupported.probe.nonce = 'spawn-nonce-new';
newerUnsupported.observed_at = '2026-08-26T03:01:00Z';
newerUnsupported.expires_at = '2026-08-26T03:11:00Z';
newerUnsupported.support = 'unsupported';
newerUnsupported.supersedes = ['probe-spawn-old'];
supersededMatrix.capabilities = [oldCapability, newerUnsupported];
seal(supersededMatrix, computeContentSha256);
const supersededResult = validateArtifact(supersededMatrix, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(supersededResult.valid, true, JSON.stringify(supersededResult.errors));
assert.strictEqual(typeof api.getEffectiveCapabilities, 'function', 'RED: effective capability reducer is absent');
const effectiveSuperseded = api.getEffectiveCapabilities(supersededMatrix, { now: fixedNow });
assert.strictEqual(effectiveSuperseded.length, 1);
assert.strictEqual(effectiveSuperseded[0].evidence_ref, 'probe-spawn-new');
assert.strictEqual(isCapabilitySupported(effectiveSuperseded[0], { now: fixedNow }), false, 'newer unsupported evidence must win over superseded support');

const expiredSupported = clone(validMatrix);
expiredSupported.capabilities[0].expires_at = '2026-08-26T03:04:00Z';
seal(expiredSupported, computeContentSha256);
assert.strictEqual(validateArtifact(expiredSupported, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, false);
assert.strictEqual(isCapabilitySupported(expiredSupported.capabilities[0], { now: fixedNow }), false, 'expired evidence must not satisfy a support gate');

const unvalidatedCapability = {
  capability_id: 'spawn_child',
  subject: 'adapter',
  support: 'supported',
  evidence_level: 'OBSERVED',
  observed_at: '2026-08-26T03:00:00Z',
  expires_at: '2026-08-26T03:10:00Z',
  scope: { adapter_fingerprint: 'adapter-fingerprint-A', auth_fingerprint: 'auth-fingerprint-A', adapter_generation: 1 },
};
assert.strictEqual(isCapabilitySupported(unvalidatedCapability, { now: fixedNow }), false, 'unvalidated helper input must fail closed');
assert.deepStrictEqual(api.getEffectiveCapabilities({ capabilities: [unvalidatedCapability] }, { now: fixedNow }), [], 'effective reducer must require validated artifact evidence');

const requestOnly = seal(clone(validMatrix), computeContentSha256);
requestOnly.capabilities[0].support = 'request_only';
seal(requestOnly, computeContentSha256);
assert.strictEqual(isCapabilitySupported(requestOnly.capabilities[0], { now: fixedNow }), false, 'request_only must never satisfy supported');

const tampered = invalidCases.tampered_content_hash;
expectError(validateArtifact(tampered, { now: fixedNow, expectedSessionId: 'sess-A' }), 'CONTENT_HASH_MISMATCH');

const unknownMajor = seal(clone(validMatrix), computeContentSha256);
unknownMajor.schema_version = 2;
seal(unknownMajor, computeContentSha256);
expectError(validateArtifact(unknownMajor, { now: fixedNow, expectedSessionId: 'sess-A' }), 'SCHEMA_VERSION_UNSUPPORTED');

const stale = seal(clone(validMatrix), computeContentSha256);
stale.capabilities[0].expires_at = '2026-08-26T03:00:00Z';
seal(stale, computeContentSha256);
expectError(validateArtifact(stale, { now: fixedNow, expectedSessionId: 'sess-A' }), 'CAPABILITY_STALE');

const futureEvidence = clone(validMatrix);
futureEvidence.capabilities[0].observed_at = '2099-01-01T00:00:00Z';
futureEvidence.capabilities[0].expires_at = '2100-01-01T00:00:00Z';
seal(futureEvidence, computeContentSha256);
expectError(validateArtifact(futureEvidence, { now: fixedNow, expectedSessionId: 'sess-A' }), 'CAPABILITY_FUTURE');

const wrongSession = seal(clone(validMatrix), computeContentSha256);
wrongSession.capabilities[0].probe.session_id = 'sess-other';
seal(wrongSession, computeContentSha256);
expectError(validateArtifact(wrongSession, { now: fixedNow, expectedSessionId: 'sess-A' }), 'PROBE_SESSION_MISMATCH');

const missingProbeAck = seal(clone(validMatrix), computeContentSha256);
delete missingProbeAck.capabilities[0].probe.ack_ref;
seal(missingProbeAck, computeContentSha256);
expectError(validateArtifact(missingProbeAck, { now: fixedNow, expectedSessionId: 'sess-A' }), 'PROBE_ACK_REQUIRED');

const unverifiedVerifier = seal(clone(validMatrix), computeContentSha256);
unverifiedVerifier.capabilities[0].evidence_level = 'VERIFIED';
unverifiedVerifier.capabilities[0].source_kind = 'verifier';
delete unverifiedVerifier.capabilities[0].verification;
seal(unverifiedVerifier, computeContentSha256);
expectError(validateArtifact(unverifiedVerifier, { now: fixedNow, expectedSessionId: 'sess-A' }), 'VERIFIER_EVIDENCE_REQUIRED');

const verifiedTarget = seal(clone(validMatrix), computeContentSha256);
verifiedTarget.artifact_id = 'capability-target-A';
seal(verifiedTarget, computeContentSha256);
const verified = seal(clone(validMatrix), computeContentSha256);
verified.artifact_id = 'capability-verified-A';
verified.capabilities[0].evidence_level = 'VERIFIED';
verified.capabilities[0].source_kind = 'verifier';
verified.capabilities[0].verification = {
  verifier_id: 'verifier-A',
  artifact_id: verifiedTarget.artifact_id,
  content_sha256: verifiedTarget.content_sha256,
};
seal(verified, computeContentSha256);
assert.strictEqual(validateArtifactSet([verifiedTarget, verified], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
  trustedRuntimeResolver: ({ purpose }) => purpose === 'capability_verification',
}).valid, true);
assert.strictEqual(validateArtifactSet([verifiedTarget, verified, taskPacketArtifact], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
  trustedRuntimeResolver: ({ purpose }) => purpose === 'capability_verification',
}).valid, true, 'mixed artifact sets must resolve VERIFIED references through the frozen collection index');
expectError(validateArtifactSet([verified, taskPacketArtifact], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
  trustedRuntimeResolver: () => true,
}), 'VERIFIED_ARTIFACT_MISSING');
expectError(validateArtifact(verified, { now: fixedNow, expectedSessionId: 'sess-A' }), 'VERIFIED_ARTIFACT_MISSING');
expectError(validateArtifactSet([verifiedTarget, verified], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
}), 'VERIFIED_TRUST_NOT_PROVEN');
const verifiedPlan = clone(validPlan);
verifiedPlan.artifact_id = 'plan-verified-matrix-A';
verifiedPlan.capability_matrix_ref = { artifact_id: verified.artifact_id, content_sha256: verified.content_sha256 };
seal(verifiedPlan, computeContentSha256);
assert.strictEqual(api.validateCollaborationPlan(verifiedPlan, new Map([[verified.artifact_id, verified], [verifiedTarget.artifact_id, verifiedTarget], [taskPacketArtifact.artifact_id, taskPacketArtifact]]), {
  now: fixedNow,
  trustedRuntimeResolver: ({ purpose }) => purpose === 'capability_verification',
}).valid, true, 'plan-internal matrix validation must retain the same frozen verifier index');
verified.capabilities[0].verification.content_sha256 = 'a'.repeat(64);
seal(verified, computeContentSha256);
expectError(validateArtifactSet([verifiedTarget, verified], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
  trustedRuntimeResolver: () => true,
}), 'VERIFIED_HASH_MISMATCH');

const extraScopeProperty = seal(clone(validMatrix), computeContentSha256);
extraScopeProperty.capabilities[0].scope.unexpected = 'rejected';
seal(extraScopeProperty, computeContentSha256);
expectError(validateArtifact(extraScopeProperty, { now: fixedNow, expectedSessionId: 'sess-A' }), 'ADDITIONAL_PROPERTY');

const explicitUnknownKey = clone(validMatrix);
explicitUnknownKey['C:\\Users\\alice\\private\\token.txt'] = 'sensitive-name';
seal(explicitUnknownKey, computeContentSha256);
const redactedPathResult = validateArtifact(explicitUnknownKey, { now: fixedNow, expectedSessionId: 'sess-A' });
assert.strictEqual(redactedPathResult.valid, false);
assert(!JSON.stringify(redactedPathResult.errors).includes('alice'), 'dynamic error paths must not disclose user-controlled private paths');

const duplicateCapability = seal(clone(validMatrix), computeContentSha256);
duplicateCapability.capabilities.push(clone(duplicateCapability.capabilities[0]));
duplicateCapability.capabilities[2].evidence_ref = 'probe-spawn-duplicate';
seal(duplicateCapability, computeContentSha256);
expectError(validateArtifact(duplicateCapability, { now: fixedNow, expectedSessionId: 'sess-A' }), 'DUPLICATE_EFFECTIVE_CAPABILITY');

const invalidSupersedes = clone(validMatrix);
const malformedSupersedes = clone(invalidSupersedes.capabilities[0]);
malformedSupersedes.evidence_ref = 'probe-spawn-malformed-supersedes';
malformedSupersedes.supersedes = {};
invalidSupersedes.capabilities.push(malformedSupersedes);
seal(invalidSupersedes, computeContentSha256);
let malformedSupersedesResult;
assert.doesNotThrow(() => {
  malformedSupersedesResult = validateArtifact(invalidSupersedes, { now: fixedNow, expectedSessionId: 'sess-A' });
});
expectError(malformedSupersedesResult, 'SUPERSEDES_INVALID');

const invalidCalendar = clone(validMatrix);
invalidCalendar.created_at = '2026-02-30T03:00:00Z';
seal(invalidCalendar, computeContentSha256);
expectError(validateArtifact(invalidCalendar, { now: fixedNow, expectedSessionId: 'sess-A' }), 'TIMESTAMP_INVALID');

const invalidClock = clone(validMatrix);
invalidClock.capabilities[0].observed_at = '2026-01-01T24:00:00Z';
seal(invalidClock, computeContentSha256);
expectError(validateArtifact(invalidClock, { now: fixedNow, expectedSessionId: 'sess-A' }), 'TIMESTAMP_INVALID');

const contradicted = seal(clone(validMatrix), computeContentSha256);
contradicted.capabilities[0].contradictions = [{
  evidence_ref: 'adapter-error-2',
  observed_at: '2026-08-26T03:01:00Z',
  support: 'unsupported',
  source_kind: 'runtime_event',
  reason_code: 'ack_mismatch',
}];
seal(contradicted, computeContentSha256);
expectError(validateArtifact(contradicted, { now: fixedNow, expectedSessionId: 'sess-A' }), 'CAPABILITY_CONTRADICTED');

const missingContradictionReason = clone(validMatrix);
missingContradictionReason.capabilities[0].contradictions = [{
  evidence_ref: 'adapter-error-missing-reason',
  observed_at: '2026-08-26T03:01:00Z',
  support: 'unsupported',
  source_kind: 'runtime_event',
}];
seal(missingContradictionReason, computeContentSha256);
expectError(validateArtifact(missingContradictionReason, { now: fixedNow, expectedSessionId: 'sess-A' }), 'CONTRADICTION_INVALID');

const extraProbeProperty = clone(validMatrix);
extraProbeProperty.capabilities[0].probe.unexpected = 'rejected';
seal(extraProbeProperty, computeContentSha256);
expectError(validateArtifact(extraProbeProperty, { now: fixedNow, expectedSessionId: 'sess-A' }), 'ADDITIONAL_PROPERTY');

const unexpectedProbe = clone(validMatrix);
unexpectedProbe.capabilities[0].evidence_level = 'DECLARED';
unexpectedProbe.capabilities[0].source_kind = 'inventory';
seal(unexpectedProbe, computeContentSha256);
assert.strictEqual(validateArtifact(unexpectedProbe, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, false, 'probe structure must not be silently accepted at DECLARED level');

const unexpectedVerification = clone(validMatrix);
unexpectedVerification.capabilities[0].verification = {};
seal(unexpectedVerification, computeContentSha256);
assert.strictEqual(validateArtifact(unexpectedVerification, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, false, 'verification structure must not be silently accepted outside VERIFIED level');

const offsetContradiction = clone(validMatrix);
offsetContradiction.capabilities[0].contradictions = [{
  evidence_ref: 'offset-contradiction',
  observed_at: '2026-08-26T03:01:00+08:00',
  support: 'unsupported',
  source_kind: 'runtime_event',
  reason_code: 'offset-time',
}];
seal(offsetContradiction, computeContentSha256);
assert.strictEqual(validateArtifact(offsetContradiction, { now: fixedNow, expectedSessionId: 'sess-A' }).valid, false, 'contradiction timestamps must use the same UTC schema contract');

const hugeSupersedes = clone(validMatrix);
hugeSupersedes.capabilities = Array.from({ length: 12000 }, (_, index) => {
  const capability = clone(validMatrix.capabilities[0]);
  capability.evidence_ref = `probe-large-${index}`;
  capability.probe.nonce = `nonce-large-${index}`;
  if (index > 0) capability.supersedes = [`probe-large-${index - 1}`];
  return capability;
});
seal(hugeSupersedes, computeContentSha256);
let hugeResult;
assert.doesNotThrow(() => { hugeResult = validateArtifact(hugeSupersedes, { now: fixedNow, expectedSessionId: 'sess-A' }); }, 'large supersedes input must not overflow the call stack');
expectError(hugeResult, 'CONTRACT_LIMIT_EXCEEDED');

const hashOnlyBypass = clone(validMatrix);
hashOnlyBypass.schema = 'NotCapabilityMatrix';
seal(hashOnlyBypass, computeContentSha256);
const hashOnlyResult = validateArtifactSet([hashOnlyBypass], { hashOnly: true, now: fixedNow, expectedSessionId: 'sess-A' });
expectError(hashOnlyResult, 'SCHEMA_IDENTITY_INVALID');

const duplicateArtifact = clone(validMatrix);
const duplicateSetResult = validateArtifactSet([validMatrix, duplicateArtifact], {
  now: fixedNow,
  expectedSessionId: 'sess-A',
});
expectError(duplicateSetResult, 'DUPLICATE_ARTIFACT_ID');
assert.strictEqual(duplicateSetResult.index.get(validMatrix.artifact_id), validMatrix);

const cli = childProcess.spawnSync(process.execPath, [
  path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact.js'),
  path.join(fixtureRoot, 'capability-valid.json'),
  '--now',
  fixedNow,
  '--expected-session',
  'sess-A',
], { encoding: 'utf8', windowsHide: true });
assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
assert.strictEqual(JSON.parse(cli.stdout).valid, true);

const tooManyCliInputs = Array.from({ length: 257 }, (_, index) => `artifact-${index}.json`);
const tooManyCliOptions = api.parseArgs([...tooManyCliInputs, '--now', fixedNow]);
assert.strictEqual(tooManyCliOptions.errorCode, 'CONTRACT_LIMIT_EXCEEDED', 'CLI artifact count must reject before file reads');
let preflightStatCalls = 0;
assert.throws(
  () => api.preflightArtifactPaths(['artifact-a.json', 'artifact-b.json', 'artifact-c.json', 'artifact-d.json', 'artifact-e.json'], {
    lstatSync() {
      preflightStatCalls += 1;
      return { dev: 7, ino: preflightStatCalls, isFile: () => true, isSymbolicLink: () => false, size: 8 * 1024 * 1024 };
    },
  }),
  (error) => error && error.code === 'CONTRACT_LIMIT_EXCEEDED',
  'CLI total input bytes must reject during metadata preflight',
);
assert.strictEqual(preflightStatCalls, 5, 'all file metadata must be checked before any file content is read');
assert.throws(
  () => api.preflightArtifactPaths(['artifact-oversized.json'], {
    lstatSync: () => ({ dev: 7, ino: 9, isFile: () => true, isSymbolicLink: () => false, size: (8 * 1024 * 1024) + 1 }),
  }),
  (error) => error && error.code === 'CONTRACT_LIMIT_EXCEEDED',
  'single-file metadata above 8 MiB must reject before opening',
);

function injectedStat({ dev = 7, ino = 11, size = 2, file = true, symlink = false } = {}) {
  return { dev, ino, size, isFile: () => file, isSymbolicLink: () => symlink };
}
const injectedPreflight = api.preflightArtifactPaths(['artifact-a.json'], { lstatSync: () => injectedStat() });
let reboundClosed = 0;
assert.throws(
  () => api.openValidatedArtifactHandles(injectedPreflight, {
    openSync: () => 41,
    fstatSync: () => injectedStat({ ino: 12 }),
    lstatSync: () => injectedStat({ ino: 12 }),
    closeSync: () => { reboundClosed += 1; },
  }),
  (error) => error && error.code === 'INPUT_IDENTITY_CHANGED',
  'metadata-to-open path rebound must reject',
);
assert.strictEqual(reboundClosed, 1, 'path rebound failure must close the opened handle');

let symlinkClosed = 0;
assert.throws(
  () => api.openValidatedArtifactHandles(injectedPreflight, {
    openSync: () => 42,
    fstatSync: () => injectedStat(),
    lstatSync: () => injectedStat({ symlink: true }),
    closeSync: () => { symlinkClosed += 1; },
  }),
  (error) => error && error.code === 'INPUT_IDENTITY_CHANGED',
  'post-open symlink or reparse rebound must reject',
);
assert.strictEqual(symlinkClosed, 1, 'symlink rebound failure must close the opened handle');

let growthClosed = 0;
assert.throws(
  () => api.openValidatedArtifactHandles(injectedPreflight, {
    openSync: () => 43,
    fstatSync: () => injectedStat({ size: (8 * 1024 * 1024) + 1 }),
    lstatSync: () => injectedStat({ size: (8 * 1024 * 1024) + 1 }),
    closeSync: () => { growthClosed += 1; },
  }),
  (error) => error && error.code === 'CONTRACT_LIMIT_EXCEEDED',
  'post-preflight single-file growth must retain the hard byte limit',
);
assert.strictEqual(growthClosed, 1, 'growth failure must close the opened handle');

const aggregatePreflight = Array.from({ length: 5 }, (_, index) => ({ resolvedPath: `artifact-${index}.json`, dev: 7, ino: index + 20, size: 1 }));
let aggregateClosed = 0;
let aggregateOpened = 0;
assert.throws(
  () => api.openValidatedArtifactHandles(aggregatePreflight, {
    openSync: () => 50 + aggregateOpened++,
    fstatSync: (fd) => injectedStat({ ino: (fd - 50) + 20, size: 8 * 1024 * 1024 }),
    lstatSync: (artifactPath) => injectedStat({ ino: Number(/(\d+)/.exec(artifactPath)[1]) + 20, size: 8 * 1024 * 1024 }),
    closeSync: () => { aggregateClosed += 1; },
  }),
  (error) => error && error.code === 'CONTRACT_LIMIT_EXCEEDED',
  'post-preflight aggregate growth must retain the transaction byte limit',
);
assert.strictEqual(aggregateClosed, 5, 'aggregate failure must close every opened handle');

let handleReadClosed = 0;
let handleReadCalls = 0;
const handleArtifacts = api.readValidatedArtifactHandles([{ fd: 61, resolvedPath: 'artifact-a.json', size: 2 }], {
  readSync(fd, buffer, offset, length) {
    handleReadCalls += 1;
    assert.strictEqual(fd, 61, 'validated reads must use the retained descriptor');
    if (length === 1 && offset === 0 && handleReadCalls > 1) return 0;
    buffer.write('{}', offset, 'utf8');
    return 2;
  },
  readFileSync() { throw new Error('path-based read is forbidden'); },
  closeSync: () => { handleReadClosed += 1; },
});
assert.deepStrictEqual(handleArtifacts, [{}]);
assert.strictEqual(handleReadClosed, 1, 'successful reads must close the retained handle');

let changedDuringReadClosed = 0;
let changedDuringReadCalls = 0;
assert.throws(
  () => api.readValidatedArtifactHandles([{ fd: 62, resolvedPath: 'artifact-a.json', size: 2 }], {
    readSync(_fd, buffer, offset, length) {
      changedDuringReadCalls += 1;
      if (changedDuringReadCalls === 1) { buffer.write('{}', offset, 'utf8'); return length; }
      return 1;
    },
    closeSync: () => { changedDuringReadClosed += 1; },
  }),
  (error) => error && error.code === 'CONTRACT_LIMIT_EXCEEDED',
  'growth detected from the retained handle must reject',
);
assert.strictEqual(changedDuringReadClosed, 1, 'read-growth failure must close the retained handle');

let parseFailureClosed = 0;
let parseFailureReads = 0;
assert.throws(
  () => api.readValidatedArtifactHandles([{ fd: 63, resolvedPath: 'artifact-invalid.json', size: 2 }], {
    readSync(_fd, buffer, offset, length) {
      parseFailureReads += 1;
      if (parseFailureReads === 1) { buffer.write('xx', offset, 'utf8'); return length; }
      return 0;
    },
    closeSync: () => { parseFailureClosed += 1; },
  }),
  SyntaxError,
  'JSON parse failure must still close retained handles',
);
assert.strictEqual(parseFailureClosed, 1, 'parse failure must close the retained handle');

const mixedCliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-collaboration-cli-'));
try {
  const mixedCliArtifacts = [validPlan, validMatrix, taskPacketArtifact];
  const mixedCliPaths = mixedCliArtifacts.map((artifact, index) => {
    const artifactPath = path.join(mixedCliRoot, `${index}-${artifact.schema}.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return artifactPath;
  });
  const mixedCli = childProcess.spawnSync(process.execPath, [
    path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact.js'),
    ...mixedCliPaths,
    '--now',
    fixedNow,
  ], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(mixedCli.status, 0, mixedCli.stderr || mixedCli.stdout);
  assert.strictEqual(JSON.parse(mixedCli.stdout).valid, true, 'CLI must validate mixed plan, matrix, and packet artifacts transactionally');
} finally {
  fs.rmSync(mixedCliRoot, { recursive: true, force: true });
}

const missingCliValue = childProcess.spawnSync(process.execPath, [
  path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact.js'),
  '--artifact',
  '--now',
  fixedNow,
], { encoding: 'utf8', windowsHide: true });
assert.strictEqual(missingCliValue.status, 64, missingCliValue.stderr || missingCliValue.stdout);
assert.strictEqual(JSON.parse(missingCliValue.stderr).errors[0].code, 'USAGE');

const missingNowCli = childProcess.spawnSync(process.execPath, [
  path.join(pluginRoot, 'skills', 'dw-collaboration', 'scripts', 'validate-artifact.js'),
  path.join(fixtureRoot, 'capability-valid.json'),
], { encoding: 'utf8', windowsHide: true });
assert.strictEqual(missingNowCli.status, 64, missingNowCli.stderr || missingNowCli.stdout);
assert.strictEqual(JSON.parse(missingNowCli.stderr).errors[0].code, 'USAGE');

expectError(validateArtifact(validMatrix, { now: '', expectedSessionId: 'sess-A' }), 'NOW_INVALID');

console.log('collaboration capability contract passed');
