'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./host-e2e');

const HOSTS = ['claude-code', 'codex', 'grok-build'];
const NOW = '2026-08-29T01:00:00Z';
const PRODUCER = { actor_id: 'root-A', adapter_id: 'adapter-A' };
const roots = [];
const clone = (value) => JSON.parse(JSON.stringify(value));
const seal = (value, field = 'content_sha256') => { value[field] = api.computeRecordSha256(value, field); return value; };
const expectCode = (fn, code) => assert.throws(fn, (error) => error && error.code === code, `expected ${code}`);
function makeRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-host-e2e-')); roots.push(root); return root; }
function write(root, name, value) { fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function makePolicy(live = [], expires = '2026-08-29T02:00:00Z') {
  return seal({
    schema: 'HostEvidencePolicy1', schema_version: 1, producer: clone(PRODUCER), scope: clone(HOSTS), live_probe_hosts: clone(live),
    authorization_boundary: 'zero_side_effect_probe_only',
    expiry_by_host: Object.fromEntries(HOSTS.map((host) => [host, { status: live.includes(host) ? 'VERIFIED' : 'UNVERIFIED', expires_on: live.includes(host) ? expires : 'session_end_or_adapter_drift', policy_ref: 'policy.json' }])),
    retention: { action: 'no_persistent_retention_after_final_receipt', raw_prompts: false, credentials: false, private_absolute_paths: false },
    sealed_before_live_probe: true, content_sha256: '0'.repeat(64),
  });
}
function makeReceipt(host, status = 'UNVERIFIED') {
  const receipt = {
    schema: 'HostCapabilityReceipt1', schema_version: 1, producer: clone(PRODUCER), host, status,
    reason: status === 'VERIFIED' ? 'probe_validated' : 'not_available_or_not_authorized',
    declared: { present: host !== 'grok-build', source: 'local_command_inventory', binary_name: host === 'claude-code' ? 'claude' : host === 'codex' ? 'codex' : 'not_observed' },
    capabilities: status === 'VERIFIED' ? ['interactive_v2'] : [], actual_model: 'unknown', actual_effort: 'unknown', route_attestation: 'UNVERIFIED',
    evidence_refs: status === 'VERIFIED' ? ['policy.json', `probe-${host}.json`] : ['policy.json'],
    cleanup: status === 'VERIFIED' ? 'session_closed_verified' : 'no_session_started', content_sha256: '0'.repeat(64),
  };
  if (status === 'VERIFIED') receipt.probe_ref = `probe-${host}.json`;
  return seal(receipt);
}
function event(id, role, producerId, nonce, linked, observedAt) {
  return seal({ evidence_id: id, producer_role: role, producer_id: producerId, nonce, linked_evidence_ref: linked, observed_at: observedAt, source_sha256: '0'.repeat(64) }, 'source_sha256');
}
function makeProbe(host, expiresAt = '2026-08-29T02:00:00Z') {
  const nonce = 'nonce-0000000000000001';
  const request = event('request-A', 'root', 'root-A', nonce, null, '2026-08-29T00:10:00Z');
  const ack = event('ack-A', 'host_adapter', 'adapter-runtime-A', nonce, request.evidence_id, '2026-08-29T00:11:00Z');
  const collect = event('collect-A', 'root', 'root-A', nonce, ack.evidence_id, '2026-08-29T00:12:00Z');
  const independent = event('message-A', 'host_adapter', 'adapter-runtime-A', nonce, request.evidence_id, '2026-08-29T00:13:00Z');
  const liveness = event('liveness-A', 'host_runtime', 'runtime-A', nonce, ack.evidence_id, '2026-08-29T00:14:00Z');
  const cleanup = event('cleanup-A', 'root', 'root-A', nonce, collect.evidence_id, '2026-08-29T00:15:00Z');
  return seal({ schema: 'HostProbeEvidence1', schema_version: 1, host, session_id: 'session-A', protocol_version: 1, nonce, request, ack, collect,
    independent_message: independent, liveness, cleanup, route_metadata: null, observed_at: '2026-08-29T00:15:00Z', expires_at: expiresAt,
    producer: clone(PRODUCER), verifier: { actor_id: 'verifier-A', evidence_refs: ['independent-verification-A'] }, content_sha256: '0'.repeat(64) });
}
function writeSet(root, policy, receipts, probes = {}) {
  write(root, 'policy.json', policy);
  for (const host of HOSTS) write(root, `${host}.json`, receipts[host]);
  for (const [host, probe] of Object.entries(probes)) write(root, `probe-${host}.json`, probe);
}

try {
  const unverifiedRoot = makeRoot();
  writeSet(unverifiedRoot, makePolicy(), Object.fromEntries(HOSTS.map((host) => [host, makeReceipt(host)])));
  assert.deepStrictEqual(api.validateEvidenceRoot(unverifiedRoot, { now: NOW }), { VERIFIED: 0, UNVERIFIED: 3, FAILED: 0, total: 3 });

  const verifiedRoot = makeRoot(); const verifiedReceipts = Object.fromEntries(HOSTS.map((host) => [host, makeReceipt(host, host === 'codex' ? 'VERIFIED' : 'UNVERIFIED')]));
  writeSet(verifiedRoot, makePolicy(['codex']), verifiedReceipts, { codex: makeProbe('codex') });
  expectCode(() => api.validateEvidenceRoot(verifiedRoot, { now: NOW }), 'HOST_TRUST_NOT_PROVEN');
  assert.deepStrictEqual(api.validateEvidenceRoot(verifiedRoot, { now: NOW, trustedHostAttestor: ({ host }) => host === 'codex' }), { VERIFIED: 1, UNVERIFIED: 2, FAILED: 0, total: 3 });

  const missingProbeRoot = makeRoot(); writeSet(missingProbeRoot, makePolicy(['codex']), verifiedReceipts);
  expectCode(() => api.validateEvidenceRoot(missingProbeRoot, { now: NOW }), 'PROBE_EVIDENCE_MISSING');

  const staleRoot = makeRoot(); const stalePolicy = makePolicy(['codex'], '2026-08-29T00:30:00Z');
  writeSet(staleRoot, stalePolicy, verifiedReceipts, { codex: makeProbe('codex', '2026-08-29T00:30:00Z') });
  expectCode(() => api.validateEvidenceRoot(staleRoot, { now: NOW }), 'PROBE_EXPIRED');

  const tamperedRoot = makeRoot(); const tampered = clone(verifiedReceipts); tampered.codex.capabilities.push('forged');
  writeSet(tamperedRoot, makePolicy(['codex']), tampered, { codex: makeProbe('codex') });
  expectCode(() => api.validateEvidenceRoot(tamperedRoot, { now: NOW }), 'RECEIPT_HASH_INVALID');
  console.log('host evidence validator contract passed');
} finally {
  for (const root of roots) { const resolved = path.resolve(root); if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true }); }
}
