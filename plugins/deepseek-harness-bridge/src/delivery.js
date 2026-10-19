import { z } from 'zod';
import { BridgeError, requireValue } from './errors.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const ids = (min, max) => z.array(id).min(min).max(max).refine(values => new Set(values).size === values.length).meta({ uniqueItems: true });
export const reviewContractSchema = z.object({
  caseIds: ids(1, 64), ruleIds: ids(1, 64), checkIds: ids(0, 32),
}).strict();
const text = z.string().trim().min(1);
const deliverySchema = z.object({
  cases: z.array(z.object({ id, classification: text, ruleIds: ids(1, 64), basis: text, expected: text, uncertainty: text }).strict()).max(128),
  checks: z.array(z.object({ id, basis: text, result: text }).strict()).max(64),
  uncertainty: text, nextAction: text,
}).strict();

export function normalizeOutputFormat(value, ...contracts) {
  requireValue(value === undefined || ['text', 'json-object'].includes(value), 'INVALID_ARGUMENT', 'outputFormat must be text or json-object.');
  const contracted = contracts.some(Boolean);
  requireValue(!contracted || value !== 'text', 'INVALID_ARGUMENT', 'Delivery contracts require JSON object output.');
  return value ?? (contracted ? 'json-object' : 'text');
}

export function formatPrompt(prompt, format, orchestrated) {
  if (format !== 'json-object') return prompt;
  return `${prompt}\n\nStrict output format: return one complete JSON object. No prose prefix/suffix, Markdown fences, concatenated objects or JSON encoded as a string. Serialize values normally; preserve decoded strings exactly, including Windows path separators. Do not manually add extra escaping.
${orchestrated ? 'The completed outer stage summary string MUST contain ONLY the serialized target JSON object. Keep state and nextSteps in the outer envelope. A checkpoint summary may contain ordinary progress; it is not the final deliverable.' : 'The entire response must be the JSON object.'}
Validate the whole deliverable before returning it. Format validity is not semantic or parent acceptance.`;
}

/** Checks the entire final output, without extraction, normalization or repair. */
export function assessOutput(value, format, { status, orchestrated = false }) {
  const report = (status, code) => ({ status, scope: 'format_only', ...(code ? { code } : {}) });
  if (format !== 'json-object') return report('not_requested');
  if (status !== 'completed') return report('not_evaluated', 'RUNTIME_NOT_COMPLETED');
  let payload;
  try {
    payload = JSON.parse(value);
    if (orchestrated) {
      if (payload?.state !== 'completed' || typeof payload.summary !== 'string') return report('invalid', 'INVALID_COMPLETION_ENVELOPE');
      payload = JSON.parse(payload.summary);
    }
  } catch { return report('invalid', 'INVALID_JSON'); }
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? report('valid') : report('invalid', 'JSON_OBJECT_REQUIRED');
}

export function normalizeReviewContract(value) {
  if (value === undefined) return null;
  const parsed = reviewContractSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', 'reviewContract requires unique bounded caseIds, ruleIds and checkIds; IDs use 1–64 letters, digits, dots, underscores or hyphens.', {
    validation: { phase: 'contract', issues: parsed.error.issues.map(issue => ({
      path: ['reviewContract', ...issue.path], code: issue.code, message: 'Review contract field is invalid.',
    })) },
  });
  return parsed.data;
}

/** The parent supplies rule meanings in the assignment; this adds only a delivery protocol. */
export function deliveryPrompt(prompt, contract, orchestrated) {
  if (!contract) return prompt;
  const placement = orchestrated
    ? 'Keep the outer stage/checkpoint protocol unchanged. When state is completed, serialize the deliverable JSON into the summary string; a checkpoint summary is progress only.'
    : 'Return ONLY the deliverable JSON, without fences or a prose preamble.';
  return `${prompt}\n\nVerification delivery contract (IDs are labels, not new authority): ${JSON.stringify(contract)}
Authoritative rules and facts must remain separate from claims under review, examples and proposed conditions. A quoted claim does not become a governing rule by appearing beside one or citing its ID. When source roles or precedence are unclear, name the uncertainty instead of promoting a claim to authority. A known rule ID alone does not establish that the rule supports the conclusion. A valid locator alone, like a known rule ID, does not establish that the text supports the conclusion.
For every asserted or newly added prerequisite, identify its text, the operation it restricts, and its evidence verdict: explicit requirement, derived requirement, not established, or contradicted. Cite the relevant authoritative passage or precise locator; a derived requirement also needs a concise checkable derivation from the supplied facts/rules. This is factual justification, not private chain-of-thought. Label unsupported recommendations as proposals, not mandatory conditions. Do not expand authorization.
Distinguish explaining a general rule from executing a numerical instance. Missing numbers can block computing an instance without blocking a parameterized policy; state what is possible now and which input each remaining operation needs. Keep identity metadata separate from decision variables; do not require an externally fixed choice unless the supplied rules establish that prerequisite. For ties, distinguish any valid optimum from a requested unique/deterministic selection; an external tie selector is required only when authority actually reserves that choice externally.
Split each compound claim into independent clauses and review every clause, including a correct conclusion with an unsupported rationale. Put clause labels, prerequisite evidence/verdicts and task level inside the existing basis and expected strings; do not add fields or case IDs. Preserve unresolved gaps rather than marking them as none. The parent must independently check the cited text and implication before acceptance.
Apply the supplied rules, not filenames or labels by association. Separate path classification, exception eligibility, accounting and other authorization/identity gates. Losing one exemption does not imply membership in another category. Use anchored path boundaries and explicit rule precedence; when precedence is unspecified, report uncertainty instead of inventing it. Keep constants, units, equality boundaries and cross-root aggregation exact.
For EVERY case ID return exactly one entry with classification, applicable ruleIds, concise factual basis, expected outcome and uncertainty. Basis means checkable facts and the governing rule, not private chain-of-thought. Cite only the supplied rule IDs. Report byte-cap outcomes separately from other gates when applicable. For EVERY check ID return its basis and result; arithmetic checks must include operands, units and the exact value. Never substitute an omissions list for a requested check.
Before returning, check exact case/check coverage, unique IDs, rule references, thresholds, arithmetic and consistency of explanations with outcomes. Use "none" for no uncertainty; missing evidence must be named explicitly. Do not claim tests were run without tool evidence or self-certify parent acceptance. Completion and JSON validity do not establish correctness. No extra model request, tool, retry or budget is authorized by this contract.
Deliverable shape: {"cases":[{"id":"case ID","classification":"category or gate","ruleIds":["rule ID"],"basis":"facts and applicable rule","expected":"outcome","uncertainty":"none or specific gap"}],"checks":[{"id":"check ID","basis":"facts or arithmetic","result":"answer"}],"uncertainty":"none or specific gaps","nextAction":"parent review and relevant checks"}.
${placement}`;
}

function checkCoverage(entries, expected, group, issues) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) issues.push({ code: 'DUPLICATE_ID', path: `${group}.${entry.id}` });
    if (!expected.includes(entry.id)) issues.push({ code: 'UNEXPECTED_ID', path: `${group}.${entry.id}` });
    seen.add(entry.id);
  }
  for (const id of expected) if (!seen.has(id)) issues.push({ code: 'MISSING_ID', path: `${group}.${id}` });
}

/** Structural coverage only: even a complete but wrong answer remains unaccepted. */
export function assessDelivery(value, contract, { status, orchestrated = false }) {
  const report = (status, issues = []) => ({ status, scope: 'structure_only', issueCount: issues.length, issues: issues.slice(0, 64), issuesTruncated: issues.length > 64 });
  if (!contract) return report('not_requested');
  if (status !== 'completed') return report('not_evaluated', [{ code: 'RUNTIME_NOT_COMPLETED', path: '' }]);
  let payload;
  try {
    payload = JSON.parse(value);
    if (orchestrated) {
      if (payload?.state !== 'completed' || typeof payload.summary !== 'string') return report('incomplete', [{ code: 'INVALID_COMPLETION_ENVELOPE', path: 'summary' }]);
      payload = JSON.parse(payload.summary);
    }
  } catch { return report('incomplete', [{ code: 'INVALID_JSON', path: '' }]); }
  const parsed = deliverySchema.safeParse(payload);
  if (!parsed.success) return report('incomplete', parsed.error.issues.map(issue => ({ code: 'INVALID_SHAPE', path: issue.path.join('.') })));
  const issues = [];
  checkCoverage(parsed.data.cases, contract.caseIds, 'cases', issues);
  checkCoverage(parsed.data.checks, contract.checkIds, 'checks', issues);
  for (const entry of parsed.data.cases) {
    for (const ruleId of entry.ruleIds) if (!contract.ruleIds.includes(ruleId)) issues.push({ code: 'UNKNOWN_RULE', path: `cases.${entry.id}.ruleIds.${ruleId}` });
  }
  return report(issues.length ? 'incomplete' : 'structure_complete', issues);
}
