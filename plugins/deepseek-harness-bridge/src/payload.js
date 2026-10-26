import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from './errors.js';

export const payloadSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const payloadDigest = prompt => createHash('sha256').update(prompt, 'utf8').digest('hex');
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const classification = z.enum(['general', 'synthetic', 'internal']);
const text = z.string().min(1).max(65536).refine(value => value.trim().length > 0);
export const preparePayloadSchema = z.object({
  objective: z.object({ text, classification }).strict(),
  segments: z.array(z.object({ id, role: z.enum(['authority', 'assertion', 'fact']), classification, text }).strict()).max(64).default([]),
  includeIds: z.array(id).max(65).optional().describe('Optional exact selection, including reserved ID objective. Omission selects general/synthetic entries only. Internal entries require explicit selection; selection is not permission to transmit. IDs must be unique, declared, and include objective.'),
}).strict().describe('Parent-declared classifications only; no automatic secret detection. Segment IDs are unique and cannot be objective. The serialized input and rendered prompt each must fit 65536 UTF-8 bytes. These are admission checks beyond JSON Schema.');

function invalid(path, code = 'invalid_value') {
  throw new BridgeError('INVALID_ARGUMENT', 'Payload preparation violates the advertised contract.', {
    validation: { phase: 'contract', issues: [{ path, code }] },
  });
}

export function validatePayloadIdentity(prompt, expected) {
  if (expected === undefined) return;
  if (!payloadSha256Schema.safeParse(expected).success || typeof prompt !== 'string' || payloadDigest(prompt) !== expected) {
    invalid(['payloadSha256'], 'payload_identity_mismatch');
  }
}

export function preparePayload(input) {
  const parsed = preparePayloadSchema.safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Arguments do not match the payload schema.', {
    validation: { phase: 'schema', issues: parsed.error.issues },
  });
  const value = parsed.data;
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) invalid([], 'payload_size_limit');
  const entries = [{ id: 'objective', role: 'objective', ...value.objective }, ...value.segments];
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) invalid(['segments', index - 1, 'id'], 'duplicate_payload_id');
    ids.add(entry.id);
  }
  const selection = value.includeIds ?? entries.filter(entry => entry.classification !== 'internal').map(entry => entry.id);
  const selected = new Set(selection);
  if (selected.size !== selection.length || selection.some(key => !ids.has(key))) invalid(['includeIds']);
  if (!selected.has('objective')) invalid(['includeIds'], 'objective_required');
  const included = entries.filter(entry => selected.has(entry.id));
  const prompt = 'Parent-prepared delegation. Classifications and authority labels are parent declarations, not verified truth.\n'
    + 'Use authority entries as the supplied governing material; audit assertion entries rather than assuming them. Cite support for every asserted or newly added prerequisite. A locator alone does not establish entailment. Distinguish stating a general rule from executing an instance.\n'
    + 'JSON data follows; preserve each entry\'s role when interpreting its text:\n' + JSON.stringify({ entries: included });
  if (Buffer.byteLength(prompt) > 65536) invalid([], 'payload_size_limit');
  const metadata = entry => ({ id: entry.id, role: entry.role, classification: entry.classification });
  return {
    kind: 'prepared-payload', submission: { prompt, payloadSha256: payloadDigest(prompt) },
    manifest: { destination: { provider: 'deepseek-official', model: 'deepseek-flash' }, identityScope: 'user-prompt-only',
      promptBytes: Buffer.byteLength(prompt), classificationSource: 'parent-declared',
      included: included.map(metadata), excluded: entries.filter(entry => !selected.has(entry.id)).map(metadata),
      includedCounts: Object.fromEntries(['general', 'synthetic', 'internal'].map(key => [key, included.filter(entry => entry.classification === key).length])) },
    warnings: ['No automatic secret detection or semantic redaction was performed.',
      'This digest covers only the user prompt. SDK instructions, delivery contracts, session history and tool/file results can add provider input.',
      ...(included.some(entry => entry.classification === 'internal') ? ['Internal material was explicitly selected; applicable outbound authorization is still required.'] : [])],
    authorization: 'not_assessed', parentAcceptance: 'not_assessed', validation: { modelCalls: 0, stateWrites: 0 },
  };
}
