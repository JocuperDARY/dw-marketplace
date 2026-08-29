#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOSTS = Object.freeze(['claude-code', 'codex', 'grok-build']);
const STATUSES = Object.freeze(['VERIFIED', 'UNVERIFIED', 'FAILED']);
const UTC = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function fail(code, detail) { const error = new Error(detail || code); error.code = code; throw error; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, keys) { if (!isObject(value)) return false; const actual = Object.keys(value).sort(); const wanted = [...keys].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }
function strings(value, empty = false) { return Array.isArray(value) && (empty || value.length > 0) && value.every((item) => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length; }
function isUtc(value) {
  if (typeof value !== 'string' || !UTC.test(value)) return false;
  const match = UTC.exec(value); const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3])); date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isObject(value)) fail('CANONICAL_VALUE_INVALID');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}
function enforceJsonBudget(value) {
  const stack = [{ value, depth: 0 }]; let nodes = 0; let stringBytes = 0;
  while (stack.length) {
    const current = stack.pop(); nodes += 1;
    if (nodes > 250000 || current.depth > 64) fail('CONTRACT_LIMIT_EXCEEDED');
    if (typeof current.value === 'string') { stringBytes += Buffer.byteLength(current.value, 'utf8'); if (stringBytes > MAX_INPUT_BYTES) fail('CONTRACT_LIMIT_EXCEEDED'); }
    if (Array.isArray(current.value)) for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
    else if (isObject(current.value)) for (const entry of Object.values(current.value)) stack.push({ value: entry, depth: current.depth + 1 });
  }
}
function computeRecordSha256(value, field = 'content_sha256') { const detached = {}; for (const key of Object.keys(value)) if (key !== field) detached[key] = value[key]; return crypto.createHash('sha256').update(canonicalize(detached), 'utf8').digest('hex'); }
function ownHash(value, field, code) { if (!isObject(value) || !SHA256.test(value[field] || '') || computeRecordSha256(value, field) !== value[field]) fail(code); }
function readJson(filePath) { const stat = fs.lstatSync(filePath); if (!stat.isFile() || stat.isSymbolicLink()) fail('EVIDENCE_FILE_UNSAFE'); if (stat.size > MAX_INPUT_BYTES) fail('CONTRACT_LIMIT_EXCEEDED'); try { const value = JSON.parse(fs.readFileSync(filePath, 'utf8')); enforceJsonBudget(value); return value; } catch (error) { if (error && error.code) throw error; fail('EVIDENCE_JSON_INVALID', error.message); } }
function producer(value, code) { if (!exactKeys(value, ['actor_id', 'adapter_id']) || typeof value.actor_id !== 'string' || !value.actor_id || typeof value.adapter_id !== 'string' || !value.adapter_id) fail(code); }

function validatePolicy(policy) {
  const keys = ['schema', 'schema_version', 'producer', 'scope', 'live_probe_hosts', 'authorization_boundary', 'expiry_by_host', 'retention', 'sealed_before_live_probe', 'content_sha256'];
  if (!exactKeys(policy, keys) || policy.schema !== 'HostEvidencePolicy1' || policy.schema_version !== 1) fail('POLICY_SCHEMA_INVALID');
  ownHash(policy, 'content_sha256', 'POLICY_HASH_INVALID'); producer(policy.producer, 'POLICY_PRODUCER_INVALID');
  if (JSON.stringify(policy.scope) !== JSON.stringify(HOSTS) || !strings(policy.live_probe_hosts, true) || !policy.live_probe_hosts.every((host) => HOSTS.includes(host))) fail('POLICY_SCOPE_INVALID');
  if (typeof policy.authorization_boundary !== 'string' || !policy.authorization_boundary || !policy.sealed_before_live_probe || !exactKeys(policy.expiry_by_host, HOSTS)) fail('POLICY_AUTHORIZATION_INVALID');
  for (const host of HOSTS) {
    const expiry = policy.expiry_by_host[host];
    if (!exactKeys(expiry, ['status', 'expires_on', 'policy_ref']) || !STATUSES.includes(expiry.status) || typeof expiry.expires_on !== 'string' || !expiry.expires_on || expiry.policy_ref !== 'policy.json') fail('POLICY_EXPIRY_INVALID', host);
    if (policy.live_probe_hosts.includes(host) && (expiry.status !== 'VERIFIED' || !isUtc(expiry.expires_on))) fail('POLICY_VERIFIED_EXPIRY_INVALID', host);
  }
  if (!exactKeys(policy.retention, ['action', 'raw_prompts', 'credentials', 'private_absolute_paths']) || policy.retention.action !== 'no_persistent_retention_after_final_receipt'
    || policy.retention.raw_prompts !== false || policy.retention.credentials !== false || policy.retention.private_absolute_paths !== false) fail('POLICY_RETENTION_UNSAFE');
}
function validateDeclared(value) { if (!exactKeys(value, ['present', 'source', 'binary_name']) || typeof value.present !== 'boolean' || value.source !== 'local_command_inventory' || typeof value.binary_name !== 'string' || !value.binary_name || /[\\/]/.test(value.binary_name)) fail('DECLARED_VALUE_INVALID'); }
function validateEvent(event, expected, nonce) {
  const keys = ['evidence_id', 'producer_role', 'producer_id', 'nonce', 'linked_evidence_ref', 'observed_at', 'source_sha256'];
  if (!exactKeys(event, keys) || event.producer_role !== expected.role || typeof event.producer_id !== 'string' || !event.producer_id || event.nonce !== nonce || event.linked_evidence_ref !== expected.link || !isUtc(event.observed_at)) fail('PROBE_EVENT_INVALID', expected.name);
  ownHash(event, 'source_sha256', 'PROBE_EVENT_HASH_INVALID');
}
function validateRouteMetadata(metadata, receipt) {
  if (metadata === null) return false;
  const keys = ['evidence_id', 'actual_model', 'actual_effort', 'source_kind', 'observed_at', 'evidence_refs', 'source_sha256'];
  if (!exactKeys(metadata, keys) || metadata.source_kind !== 'host_runtime_metadata' || !isUtc(metadata.observed_at) || !strings(metadata.evidence_refs) || metadata.actual_model !== receipt.actual_model || metadata.actual_effort !== receipt.actual_effort) fail('ROUTE_METADATA_INVALID');
  ownHash(metadata, 'source_sha256', 'ROUTE_METADATA_HASH_INVALID'); return true;
}
function validateProbe(probe, receipt, policy, now) {
  const keys = ['schema', 'schema_version', 'host', 'session_id', 'protocol_version', 'nonce', 'request', 'ack', 'collect', 'independent_message', 'liveness', 'cleanup', 'route_metadata', 'observed_at', 'expires_at', 'producer', 'verifier', 'content_sha256'];
  if (!exactKeys(probe, keys) || probe.schema !== 'HostProbeEvidence1' || probe.schema_version !== 1 || probe.host !== receipt.host || typeof probe.session_id !== 'string' || !probe.session_id || probe.protocol_version !== 1 || typeof probe.nonce !== 'string' || probe.nonce.length < 16) fail('PROBE_SCHEMA_INVALID');
  ownHash(probe, 'content_sha256', 'PROBE_HASH_INVALID'); producer(probe.producer, 'PROBE_PRODUCER_INVALID');
  if (probe.producer.actor_id !== policy.producer.actor_id || probe.producer.adapter_id !== policy.producer.adapter_id) fail('PROBE_PRODUCER_MISMATCH');
  validateEvent(probe.request, { name: 'request', role: 'root', link: null }, probe.nonce);
  validateEvent(probe.ack, { name: 'ack', role: 'host_adapter', link: probe.request.evidence_id }, probe.nonce);
  validateEvent(probe.collect, { name: 'collect', role: 'root', link: probe.ack.evidence_id }, probe.nonce);
  validateEvent(probe.independent_message, { name: 'independent_message', role: 'host_adapter', link: probe.request.evidence_id }, probe.nonce);
  validateEvent(probe.liveness, { name: 'liveness', role: 'host_runtime', link: probe.ack.evidence_id }, probe.nonce);
  validateEvent(probe.cleanup, { name: 'cleanup', role: 'root', link: probe.collect.evidence_id }, probe.nonce);
  const events = [probe.request, probe.ack, probe.collect, probe.independent_message, probe.liveness, probe.cleanup];
  if (new Set(events.map((event) => event.evidence_id)).size !== events.length) fail('PROBE_EVIDENCE_ID_DUPLICATE');
  if (!events.every((event, index) => index === 0 || Date.parse(event.observed_at) >= Date.parse(events[index - 1].observed_at))) fail('PROBE_TIME_NOT_MONOTONIC');
  if (!isUtc(probe.observed_at) || !isUtc(probe.expires_at) || Date.parse(probe.observed_at) > Date.parse(now) || Date.parse(probe.expires_at) <= Date.parse(now) || probe.expires_at !== policy.expiry_by_host[receipt.host].expires_on) fail('PROBE_EXPIRED');
  if (!exactKeys(probe.verifier, ['actor_id', 'evidence_refs']) || typeof probe.verifier.actor_id !== 'string' || !probe.verifier.actor_id || !strings(probe.verifier.evidence_refs) || [probe.producer.actor_id, probe.producer.adapter_id, probe.request.producer_id, probe.ack.producer_id, probe.collect.producer_id, probe.independent_message.producer_id, probe.liveness.producer_id, probe.cleanup.producer_id].includes(probe.verifier.actor_id)) fail('PROBE_VERIFIER_NOT_INDEPENDENT');
  const routeMetadata = validateRouteMetadata(probe.route_metadata, receipt);
  if (receipt.route_attestation === 'VERIFIED' && !routeMetadata) fail('ROUTE_METADATA_REQUIRED');
  if (receipt.route_attestation === 'UNVERIFIED' && (routeMetadata || receipt.actual_model !== 'unknown' || receipt.actual_effort !== 'unknown')) fail('ROUTE_ATTESTATION_INVALID');
}
function validateReceipt(receipt, host, policy, probe, now, trustedHostAttestor) {
  const base = ['schema', 'schema_version', 'producer', 'host', 'status', 'reason', 'declared', 'capabilities', 'actual_model', 'actual_effort', 'route_attestation', 'evidence_refs', 'cleanup', 'content_sha256'];
  const keys = receipt.status === 'VERIFIED' ? [...base, 'probe_ref'] : base;
  if (!exactKeys(receipt, keys) || receipt.schema !== 'HostCapabilityReceipt1' || receipt.schema_version !== 1 || receipt.host !== host || !STATUSES.includes(receipt.status)) fail('RECEIPT_SCHEMA_INVALID');
  ownHash(receipt, 'content_sha256', 'RECEIPT_HASH_INVALID'); producer(receipt.producer, 'RECEIPT_PRODUCER_INVALID'); validateDeclared(receipt.declared);
  if (receipt.producer.actor_id !== policy.producer.actor_id || receipt.producer.adapter_id !== policy.producer.adapter_id || typeof receipt.reason !== 'string' || !receipt.reason || !strings(receipt.capabilities, true) || !strings(receipt.evidence_refs) || !receipt.evidence_refs.includes('policy.json') || policy.expiry_by_host[host].status !== receipt.status) fail('RECEIPT_POLICY_MISMATCH');
  if (receipt.status === 'UNVERIFIED') {
    if (receipt.reason !== 'not_available_or_not_authorized' || receipt.capabilities.length !== 0 || receipt.actual_model !== 'unknown' || receipt.actual_effort !== 'unknown' || receipt.route_attestation !== 'UNVERIFIED' || receipt.cleanup !== 'no_session_started' || probe !== null) fail('UNVERIFIED_CLAIM_INVALID');
    return;
  }
  if (receipt.status === 'FAILED') {
    if (receipt.actual_model !== 'unknown' || receipt.actual_effort !== 'unknown' || receipt.route_attestation !== 'UNVERIFIED' || !['no_session_started', 'session_closed', 'cleanup_hold'].includes(receipt.cleanup)) fail('FAILED_CLAIM_INVALID');
    return;
  }
  const probeRef = `probe-${host}.json`;
  if (!policy.live_probe_hosts.includes(host) || receipt.probe_ref !== probeRef || !receipt.evidence_refs.includes(probeRef) || receipt.reason !== 'probe_validated' || receipt.capabilities.length === 0 || receipt.cleanup !== 'session_closed_verified' || probe === null) fail('VERIFIED_CLAIM_INCOMPLETE');
  validateProbe(probe, receipt, policy, now);
  if (typeof trustedHostAttestor !== 'function' || trustedHostAttestor(Object.freeze({ host, policy, receipt, probe })) !== true) fail('HOST_TRUST_NOT_PROVEN');
}
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; const value = argv[index + 1]; if (!['--evidence-root', '--now'].includes(key) || !value || value.startsWith('--')) fail('USAGE_INVALID'); options[key === '--evidence-root' ? 'root' : 'now'] = value; index += 1; }
  if (!options.root) fail('USAGE_INVALID'); options.root = path.resolve(options.root); options.now = options.now || new Date().toISOString(); if (!isUtc(options.now)) fail('NOW_INVALID'); return options;
}
function validateEvidenceRoot(root, options = {}) {
  const now = options.now || new Date().toISOString(); if (!isUtc(now) || !fs.existsSync(root)) fail('EVIDENCE_ROOT_MISSING');
  const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('EVIDENCE_ROOT_UNSAFE');
  const entries = fs.readdirSync(root, { withFileTypes: true }); if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) fail('EVIDENCE_FILE_UNSAFE');
  const policyPath = path.join(root, 'policy.json'); if (!fs.existsSync(policyPath)) fail('POLICY_MISSING'); const policy = readJson(policyPath); validatePolicy(policy);
  for (const host of policy.live_probe_hosts) if (!fs.existsSync(path.join(root, `probe-${host}.json`))) fail('PROBE_EVIDENCE_MISSING', host);
  const expected = ['policy.json', ...HOSTS.map((host) => `${host}.json`), ...policy.live_probe_hosts.map((host) => `probe-${host}.json`)].sort(); const actual = entries.map((entry) => entry.name).sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('EVIDENCE_FILE_SET_INVALID');
  const counts = { VERIFIED: 0, UNVERIFIED: 0, FAILED: 0, total: HOSTS.length };
  for (const host of HOSTS) { const receipt = readJson(path.join(root, `${host}.json`)); const probe = policy.live_probe_hosts.includes(host) ? readJson(path.join(root, `probe-${host}.json`)) : null; validateReceipt(receipt, host, policy, probe, now, options.trustedHostAttestor); counts[receipt.status] += 1; }
  return counts;
}
function main(argv) { try { const options = parseArgs(argv); process.stdout.write(`${JSON.stringify(validateEvidenceRoot(options.root, { now: options.now }))}\n`); return 0; } catch (error) { process.stderr.write(`${JSON.stringify({ valid: false, code: error.code || 'VALIDATION_ERROR', detail: error.message })}\n`); return 2; } }

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { canonicalize, computeRecordSha256, validateEvidenceRoot };
