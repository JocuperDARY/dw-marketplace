import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BridgeError } from './errors.js';
import { readCompleteResult, ResultReadError } from './result-reader.js';
import { WorkspaceFiles } from './workspace.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const pointer = z.string().max(1024).regex(/^(?:\/(?:[^~]|~[01])*)?$/);
const scalar = z.union([z.string().max(8192), z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.boolean(), z.null()]);
const source = z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const claim = { id, pointer };
export const evidenceCheckSchema = z.discriminatedUnion('kind', [
  z.object({ ...claim, kind: z.literal('literal'), expected: scalar }).strict(),
  z.object({ ...claim, kind: z.literal('count'), expected: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...claim, kind: z.literal('arithmetic'), operator: z.enum(['sum', 'product']), operands: z.array(z.number()).min(1).max(64),
    absoluteTolerance: z.number().nonnegative().optional() }).strict(),
  z.object({ ...claim, kind: z.literal('source-quote'), source }).strict(),
  z.object({ ...claim, kind: z.literal('execution'), receipt: source,
    identity: z.object({ pointer, expected: scalar }).strict(), exitCodePointer: pointer }).strict(),
  z.object({ id, kind: z.literal('manual'), reason: z.enum(['semantic', 'prerequisite', 'scientific']) }).strict(),
]);
export const checkResultSchema = z.object({ taskId: z.string().uuid(), attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  checks: z.array(evidenceCheckSchema).min(1).max(64).describe('Parent-owned deterministic checks, with unique IDs and at most 32768 UTF-8 bytes. Missing evidence is unknown; a pass never certifies natural-language meaning, source authority or scientific/parent acceptance.') }).strict();

export function normalizeEvidenceChecks(checks) {
  const parsed = checkResultSchema.shape.checks.safeParse(checks);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Invalid evidence checks.', { validation: {
    phase: 'schema', issues: parsed.error.issues.map(issue => ({ ...issue, path: ['checks', ...issue.path] })),
  } });
  const seen = new Set();
  for (const [index, check] of parsed.data.entries()) {
    if (seen.has(check.id)) throw new BridgeError('INVALID_ARGUMENT', 'Evidence check IDs must be unique.', {
      validation: { phase: 'contract', issues: [{ path: ['checks', index, 'id'], code: 'duplicate_check_id' }] },
    });
    seen.add(check.id);
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > 32768) throw new BridgeError('INVALID_ARGUMENT', 'Evidence checks exceed the 32768-byte contract limit.', {
    validation: { phase: 'contract', issues: [{ path: ['checks'], code: 'checks_utf8_size_limit' }] },
  });
  return parsed.data;
}

const absent = Symbol('absent');
function atPointer(root, path) {
  if (path === '') return root;
  let value = root;
  for (const segment of path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return absent;
    value = value[segment];
  }
  return value;
}
const item = (check, status, code, evidence) => ({ id: check.id, kind: check.kind, status, code, ...(evidence ? { evidence } : {}) });
const compare = (check, ok, code, evidence) => item(check, ok ? 'PASS' : 'FAIL', ok ? 'MATCH' : code, evidence);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const newline = value => value.replace(/\r\n?/g, '\n');

function artifactReader(workspace) {
  const files = new WorkspaceFiles({ workspace, access: 'read-only' });
  const cache = new Map();
  return source => {
    const key = JSON.stringify(source);
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        const bytes = await files.readEvidence(source.path);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== source.sha256) return { unavailable: 'SOURCE_CHANGED' };
        if (bytes.includes(0)) return { unavailable: 'SOURCE_NOT_TEXT' };
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return { unavailable: 'SOURCE_NOT_TEXT' }; }
        return { text, sha256 };
      } catch { return { unavailable: 'SOURCE_UNAVAILABLE' }; }
    })());
    return cache.get(key);
  };
}

async function assess(check, deliverable, readArtifact) {
  if (check.kind === 'manual') return item(check, 'UNKNOWN', 'PARENT_REVIEW_REQUIRED');
  const value = atPointer(deliverable, check.pointer);
  if (value === absent) return item(check, 'UNKNOWN', 'CLAIM_MISSING');
  if (check.kind === 'literal') return compare(check, value === check.expected, 'VALUE_MISMATCH');
  if (check.kind === 'count') return compare(check, Array.isArray(value) && value.length === check.expected, 'COUNT_MISMATCH');
  if (check.kind === 'arithmetic') {
    let expected = check.operator === 'sum' ? 0 : 1;
    for (const operand of check.operands) {
      const previous = expected;
      expected = check.operator === 'sum' ? expected + operand : expected * operand;
      if (!Number.isFinite(expected) || (Number.isInteger(operand) && !Number.isSafeInteger(operand))
        || (Number.isInteger(expected) && !Number.isSafeInteger(expected))
        || (check.operator === 'product' && previous !== 0 && operand !== 0 && expected === 0)) {
        return item(check, 'UNKNOWN', 'NUMERIC_RANGE');
      }
    }
    return compare(check, typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= (check.absoluteTolerance ?? 0), 'ARITHMETIC_MISMATCH');
  }
  const artifact = await readArtifact(check.kind === 'source-quote' ? check.source : check.receipt);
  if (artifact.unavailable) return item(check, 'UNKNOWN', artifact.unavailable);
  const evidence = { sha256: artifact.sha256 };
  if (check.kind === 'source-quote') {
    const lines = newline(artifact.text).split('\n');
    if (!plainObject(value) || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine)
      || value.startLine < 1 || value.endLine < value.startLine || value.endLine > lines.length || typeof value.quote !== 'string') {
      return item(check, 'FAIL', 'SOURCE_LOCATOR_INVALID', evidence);
    }
    return compare(check, newline(value.quote) === lines.slice(value.startLine - 1, value.endLine).join('\n'), 'SOURCE_QUOTE_MISMATCH',
      { ...evidence, startLine: value.startLine, endLine: value.endLine });
  }
  let receipt;
  try { receipt = JSON.parse(artifact.text); } catch { return item(check, 'UNKNOWN', 'RECEIPT_INVALID', evidence); }
  if (!plainObject(receipt) || atPointer(receipt, check.identity.pointer) !== check.identity.expected) {
    return item(check, 'UNKNOWN', 'RECEIPT_IDENTITY_UNVERIFIED', evidence);
  }
  const exitCode = atPointer(receipt, check.exitCodePointer);
  if (!Number.isSafeInteger(exitCode)) return item(check, 'UNKNOWN', 'EXECUTION_UNOBSERVED', evidence);
  if (!plainObject(value) || value.identity !== check.identity.expected || !['succeeded', 'failed'].includes(value.status)) {
    return item(check, 'FAIL', 'EXECUTION_CLAIM_INVALID', evidence);
  }
  return compare(check, value.status === (exitCode === 0 ? 'succeeded' : 'failed'), 'EXECUTION_OUTCOME_MISMATCH', evidence);
}

/** Deterministic parent checks over one saved result; no worker, retry or acceptance mutation. */
export async function checkSavedResult(callTool, input) {
  const parsed = checkResultSchema.safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'Invalid result-check arguments.', { validation: { phase: 'schema', issues: parsed.error.issues } });
  const { taskId, attempt } = parsed.data;
  const checks = normalizeEvidenceChecks(parsed.data.checks);
  let result;
  let problem;
  try { result = await readCompleteResult(callTool, { taskId, attempt, parseJson: true }); }
  catch (error) {
    result = error instanceof ResultReadError ? error.result : undefined;
    problem = error instanceof ResultReadError ? error.code : 'RESULT_READ_FAILED';
  }
  let deliverable = result?.json;
  if (!problem && (result.receipt.status !== 'completed' || result.receipt.terminal !== 'completed' || result.receipt.cleanup !== 'confirmed'
    || result.receipt.leasePending || result.receipt.durability === 'unconfirmed'
    || result.receipt.error || result.truncation.model !== false || result.truncation.storage !== false || result.receipt.output?.kind !== 'complete_text')) problem = 'RESULT_NOT_ACCEPTABLE';
  if (!problem && result.receipt.planning?.executionMode === 'budgeted') {
    try {
      if (deliverable.state !== 'completed' || typeof deliverable.summary !== 'string') throw new Error();
      deliverable = JSON.parse(deliverable.summary);
      if (!plainObject(deliverable)) throw new Error();
    } catch { problem = 'DELIVERABLE_INVALID'; }
  }
  const readArtifact = result && !problem ? artifactReader(result.receipt.workspace) : null;
  const items = [];
  for (const check of checks) items.push(problem ? item(check, 'UNKNOWN', problem) : await assess(check, deliverable, readArtifact));
  const counts = { total: items.length, passed: items.filter(x => x.status === 'PASS').length,
    failed: items.filter(x => x.status === 'FAIL').length, unknown: items.filter(x => x.status === 'UNKNOWN').length };
  return { scope: 'deterministic_evidence_only', status: counts.failed ? 'checks_failed' : counts.unknown ? 'incomplete' : 'checks_passed',
    resultIdentity: { taskId, attempt, sha256: result?.retrieval.sha256 ?? null },
    retrieval: result?.retrieval ?? { complete: false }, items, counts,
    sourceAuthority: 'not_assessed', parentAcceptance: 'not_assessed', validation: { modelCalls: 0, stateWrites: 0 } };
}
