// Public synthetic examples with explicit reference judgments for parent review.
// These authored expectations are not a runtime semantic oracle or human sign-off.
export const scenarios = [
  {
    id: 'reviewed_authority', ruleId: 'SELECT',
    authority: 'SELECT: At execution, choose any available item with maximal score.',
    claim: 'SELECT requires fixing the selected item before execution.',
    referenceJudgment: 'reject',
    referenceOutcome: 'The rule requires a maximal-score item at execution; no pre-fixed item is required.',
    evidence: 'The timing and pre-fixed identity appear only in the claim under review, despite its known SELECT label.',
    workerOutcome: 'Accept: SELECT requires the item to be fixed in advance.',
  },
  {
    id: 'added_prerequisite', ruleId: 'RECORD',
    authority: 'RECORD: Record the selected item after selection.',
    claim: 'A signed approval must exist before any selection.',
    referenceJudgment: 'reject',
    referenceOutcome: 'The supplied rule does not establish a signed-approval prerequisite; no broader execution authorization is inferred.',
    evidence: 'Recording a result does not imply obtaining a signature before selection.',
    workerOutcome: 'Accept: a signed approval is a necessary prerequisite.',
  },
  {
    id: 'general_policy', ruleId: 'RATE',
    authority: 'RATE: Charge equals quantity multiplied by unit price. No quantity or price has been supplied.',
    claim: 'The general charge policy cannot be stated until both numbers are supplied.',
    referenceJudgment: 'reject',
    referenceOutcome: 'The general policy can be stated as charge = quantity * unit price.',
    evidence: 'Missing operands prevent a numerical result; they do not prevent stating the supplied formula.',
    workerOutcome: 'Accept: missing numbers block both the policy and the numerical result.',
  },
  {
    id: 'stable_identity', ruleId: 'IDENTITY',
    authority: 'IDENTITY: Keep job ID J7 stable across executions; choose a destination at execution.',
    claim: 'The stable job ID requires the destination to stay fixed across executions.',
    referenceJudgment: 'reject',
    referenceOutcome: 'J7 remains stable; the destination may be chosen at each execution.',
    evidence: 'The stable field is the job identity, while destination selection has separate timing.',
    workerOutcome: 'Accept: a stable job ID implies a fixed destination.',
  },
  {
    id: 'compound_claim', ruleId: 'AUDIT',
    authority: 'AUDIT: Log the selected route after execution. Route selection occurs at execution.',
    claim: 'Log the selected route, and pre-fix the route before execution.',
    referenceJudgment: 'partly_supported',
    referenceOutcome: 'Logging is required; pre-fixing the route is unsupported.',
    evidence: 'The first conjunct follows AUDIT; the second adds a condition absent from AUDIT.',
    workerOutcome: 'Accept the entire claim because route logging is required.',
  },
  {
    id: 'ties_any', ruleId: 'MAX_ANY',
    authority: 'MAX_ANY: Return any maximal-score candidate; A and B both score 8.',
    claim: 'Selection must wait for an explicit tie selector.',
    referenceJudgment: 'reject',
    referenceOutcome: 'Either A or B satisfies MAX_ANY without a tie selector.',
    evidence: 'The output is allowed to be any maximum; uniqueness and determinism are not required.',
    workerOutcome: 'Accept: all tied maxima require a tie selector before selection.',
  },
  {
    id: 'explicit_constraint', ruleId: 'PIN',
    authority: 'PIN: The parent must fix exactly one destination before execution.',
    claim: 'A destination fixed by the parent is a prerequisite to execution.',
    referenceJudgment: 'support',
    referenceOutcome: 'Execution requires the parent to fix one destination first.',
    evidence: 'PIN explicitly imposes the timing, actor, and single destination requirement.',
  },
  {
    id: 'numerical_inputs', ruleId: 'TOTAL',
    authority: 'TOTAL: Produce the numerical total quantity * unit price. Neither operand is supplied.',
    claim: 'The requested numerical total requires both operands or equivalent sufficient numerical information.',
    referenceJudgment: 'support',
    referenceOutcome: 'The numerical total is unresolved until sufficient numerical inputs are supplied.',
    evidence: 'No numerical total can be derived from the formula alone when both operands are unspecified.',
  },
  {
    id: 'missing_decision', ruleId: 'APPROVAL',
    authority: 'APPROVAL: The parent must choose east or west before execution. No choice is supplied.',
    claim: 'Execution is unresolved pending the parent destination decision.',
    referenceJudgment: 'support',
    referenceOutcome: 'Request the missing east-or-west decision before execution.',
    evidence: 'APPROVAL expressly reserves this required decision to the parent.',
  },
  {
    id: 'ties_unique', ruleId: 'MAX_UNIQUE',
    authority: 'MAX_UNIQUE: Return a deterministic single winner using the parent-supplied priority order for ties. Only the parent may set that order. A and B both score 8. No priority order is supplied.',
    claim: 'The required deterministic winner remains unresolved without an authorized tie selector.',
    referenceJudgment: 'support',
    referenceOutcome: 'Request a tie selector to resolve the required deterministic winner.',
    evidence: 'MAX_UNIQUE expressly reserves the required priority order to the parent; determinism alone would not require external selection.',
  },
];

export const contract = {
  caseIds: scenarios.map(item => item.id),
  ruleIds: scenarios.map(item => item.ruleId),
  checkIds: ['EVIDENCE_REVIEW'],
};

export const assignment = scenarios.map(item =>
  `Case ${item.id}\nAuthoritative rule/facts: ${item.authority}\nClaim under review: ${item.claim}`
).join('\n\n');

export function delivery({ counterexamples = false } = {}) {
  return {
    cases: scenarios.map(item => ({
      id: item.id,
      classification: counterexamples && item.workerOutcome ? 'support' : item.referenceJudgment,
      ruleIds: [item.ruleId],
      basis: counterexamples && item.workerOutcome ? item.claim : item.evidence,
      expected: counterexamples && item.workerOutcome ? item.workerOutcome : item.referenceOutcome,
      uncertainty: 'none',
    })),
    checks: [{ id: 'EVIDENCE_REVIEW', basis: 'All supplied case and rule IDs are present.', result: 'Coverage complete; semantic judgment requires parent review.' }],
    uncertainty: 'Authored synthetic reference panel only; no model was evaluated or human acceptance recorded.',
    nextAction: 'Parent checks every conclusion against the authoritative rule and facts.',
  };
}
