import { z } from 'zod';
import { BridgeError } from './errors.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const uniqueIds = max => z.array(id).min(1).max(max).refine(values => new Set(values).size === values.length).meta({ uniqueItems: true });
const basis = z.string().min(1).max(2048).regex(/\S/);

// These are parent-declared expectations, not built-in lifecycle or authorization rules.
export const lifecycleContractSchema = z.object({
  statuses: uniqueIds(16),
  cases: z.array(z.object({ id, allowedStatuses: uniqueIds(16), slotReusable: z.boolean(), basis }).strict()).min(1).max(64),
}).strict().describe('Parent-declared lifecycle outcomes. Additional admission checks require unique cases[].id values, allowedStatuses membership in statuses, and at most 16384 UTF-8 bytes in normalized JSON.');

const outputSchema = z.object({
  rows: z.array(z.object({ id, status: id, slot_reusable: z.boolean() }).strict()).max(128),
  status_counts: z.record(id, z.number().int().min(0).max(64)),
  caveats: z.array(basis).max(64),
}).strict();

export function normalizeLifecycleContract(value) {
  if (value === undefined) return null;
  const parsed = lifecycleContractSchema.safeParse(value);
  const issues = parsed.success ? [] : parsed.error.issues.map(issue => ({ path: ['lifecycleContract', ...issue.path], code: issue.code }));
  if (parsed.success) {
    const seen = new Set();
    for (const [index, entry] of parsed.data.cases.entries()) {
      if (seen.has(entry.id)) issues.push({ path: ['lifecycleContract', 'cases', index, 'id'], code: 'duplicate_case_id' });
      seen.add(entry.id);
      for (const [statusIndex, status] of entry.allowedStatuses.entries()) {
        if (!parsed.data.statuses.includes(status)) issues.push({ path: ['lifecycleContract', 'cases', index, 'allowedStatuses', statusIndex], code: 'status_not_declared' });
      }
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 16384) {
      issues.push({ path: ['lifecycleContract'], code: 'lifecycle_utf8_size_limit' });
    }
  }
  if (issues.length) throw new BridgeError('INVALID_ARGUMENT', 'lifecycleContract requires 1–16 unique statuses and 1–64 unique cases with nonempty allowedStatuses from that vocabulary, explicit slotReusable and basis; at most 16 KiB. Resolve undefined branches explicitly before delegating.', { validation: { phase: 'contract', issues } });
  return parsed.data;
}

export function lifecyclePrompt(prompt, contract, orchestrated) {
  if (!contract) return prompt;
  return `${prompt}\n\nLifecycle consistency contract (parent-supplied expectations, not runtime evidence or new authority): ${JSON.stringify(contract)}
Return exactly {"rows":[{"id":"case ID","status":"one allowed status","slot_reusable":false}],"status_counts":{"each supplied status":0},"caveats":["specific uncertainties or conflicts"]}. Return every case exactly once in contract order, preserving boolean types. Use the declared allowedStatuses and slotReusable for that case. A case with several allowed statuses is deliberately unresolved; explain that uncertainty. Do not infer lifecycle policy from status names. The parent must explicitly define uncovered branches, including accepted completion without confirmed cleanup; never invent a fallback or promote unknown cleanup into confirmed cleanup.
Keep the supplied records' cleanup and acceptance separate from this worker's actual execution/cleanup. Runtime completion, JSON validity and matching this contract do not establish parent acceptance or the truth of the supplied expectations. If the assignment and declared expectations conflict, report the conflict in caveats for parent review; do not silently rewrite the contract.
Before returning, check row IDs/order, each allowed status, exact slot_reusable booleans and every status_count against the actual rows (including zeros). Check every caveat against its row: a caveat must not negate the structured result. Caveat meaning still needs parent review. No extra request, tool, retry or budget is authorized.
${orchestrated ? 'Keep the outer stage protocol. Only on completed, serialize this entire object into the summary string; checkpoints contain progress only.' : 'The entire response must be ONLY this JSON object.'}`;
}

/** Checks declared outcomes and counts only; never parses prose or proves the parent's rules. */
export function assessLifecycle(value, contract, { status, orchestrated = false }) {
  const result = (status, issues = []) => ({ status, scope: 'declared_lifecycle_outcomes', proseAcceptance: 'not_assessed', issueCount: issues.length, issues: issues.slice(0, 64), issuesTruncated: issues.length > 64 });
  if (!contract) return result('not_requested');
  if (status !== 'completed') return result('not_evaluated', [{ code: 'RUNTIME_NOT_COMPLETED', path: '' }]);
  let payload;
  try {
    payload = JSON.parse(value);
    if (orchestrated) {
      if (payload?.state !== 'completed' || typeof payload.summary !== 'string') return result('mismatch', [{ code: 'INVALID_COMPLETION_ENVELOPE', path: 'summary' }]);
      payload = JSON.parse(payload.summary);
    }
  } catch { return result('mismatch', [{ code: 'INVALID_JSON', path: '' }]); }
  const parsed = outputSchema.safeParse(payload);
  if (!parsed.success) return result('mismatch', parsed.error.issues.map(issue => ({ code: 'INVALID_SHAPE', path: issue.path.join('.') })));
  const expected = new Map(contract.cases.map(entry => [entry.id, entry]));
  const seen = new Set();
  const counts = new Map(contract.statuses.map(status => [status, 0]));
  const issues = [];
  for (const [index, row] of parsed.data.rows.entries()) {
    const path = `rows.${row.id}`;
    if (seen.has(row.id)) issues.push({ code: 'DUPLICATE_ID', path });
    seen.add(row.id);
    if (contract.cases[index]?.id !== row.id) issues.push({ code: 'ORDER_MISMATCH', path });
    if (!counts.has(row.status)) issues.push({ code: 'UNKNOWN_STATUS', path: `${path}.status` });
    else counts.set(row.status, counts.get(row.status) + 1);
    const original = expected.get(row.id);
    if (!original) { issues.push({ code: 'UNEXPECTED_ID', path }); continue; }
    if (!original.allowedStatuses.includes(row.status)) issues.push({ code: 'STATUS_NOT_ALLOWED', path: `${path}.status` });
    if (row.slot_reusable !== original.slotReusable) issues.push({ code: 'SLOT_REUSE_MISMATCH', path: `${path}.slot_reusable` });
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push({ code: 'MISSING_ID', path: `rows.${id}` });
  for (const [status, count] of counts) {
    const path = `status_counts.${status}`;
    if (!Object.hasOwn(parsed.data.status_counts, status)) issues.push({ code: 'MISSING_COUNT', path });
    else if (parsed.data.status_counts[status] !== count) issues.push({ code: 'COUNT_MISMATCH', path });
  }
  for (const status of Object.keys(parsed.data.status_counts)) {
    if (!counts.has(status)) issues.push({ code: 'UNEXPECTED_COUNT', path: `status_counts.${status}` });
  }
  return result(issues.length ? 'mismatch' : 'consistent', issues);
}
