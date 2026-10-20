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
    id: 'tensor_axes', ruleId: 'ARRAY',
    authority: 'ARRAY: Four member response matrices each have shape (2, 3). stack has shape (4, 2, 3). mask is boolean with shape (2, 3), checked against stack.shape[1:]. mean = stack.mean(axis=0); dispersion uses mean[mask].',
    claim: 'The boolean mask has the same shape as the full stack, and mean is computed across members.',
    referenceJudgment: 'partly_supported',
    referenceOutcome: 'Reject full-stack shape equality: stack is (4, 2, 3), mask and stack.shape[1:] are (2, 3). Accept mean over member axis 0, yielding (2, 3).',
    evidence: 'Axes are member, row, column. Slicing shape[1:] removes the member axis. The mean reduction removes axis 0; mean[mask] selects entries from that two-dimensional result.',
    workerOutcome: 'Accept both clauses: the mask has full-stack shape and mean reduces the member axis.',
  },
  {
    id: 'exclusive_imports', ruleId: 'IMPORTS',
    authority: 'IMPORTS: The complete inspected producer.py imports Loader, Settings and Catalog. Its source has no import of score and no direct score() call. No other files or dynamic execution were inspected.',
    claim: 'producer.py imports only Loader and Settings, and has no direct score() call.',
    referenceJudgment: 'partly_supported',
    referenceOutcome: 'Catalog refutes imports only Loader and Settings. Retain no direct score() call in this file; broader dynamic or repository absence is unresolved.',
    evidence: 'The quantified import set is the complete producer.py file; Catalog is a counterexample to only. The direct-call claim has distinct static evidence and a file boundary.',
    workerOutcome: 'Accept the entire claim because there is no direct score() call.',
  },
  {
    id: 'import_is_execution', ruleId: 'EXECUTION',
    authority: 'EXECUTION: A supplied excerpt defines score; another excerpt imports score. No call-site inventory, execution trace or output is supplied.',
    claim: 'The import proves score necessarily ran successfully.',
    referenceJudgment: 'reject',
    referenceOutcome: 'Definition and import are evidenced; invocation and successful runtime execution remain unverified.',
    evidence: 'An imported callable can remain unused. The excerpts establish code existence and import, not a call or a successful runtime result.',
    workerOutcome: 'Accept: importing score proves it was called and succeeded.',
  },
  {
    id: 'broadcast_control', ruleId: 'BROADCAST',
    authority: 'BROADCAST: Under the supplied trailing-axis elementwise rule, dimensions are compatible when equal or one is 1; missing leading dimensions are treated as 1. stack has axes member,row,column and shape (4,2,3); mask has axes row,column and shape (2,3).',
    claim: 'mask can broadcast elementwise over stack without having the same rank; this alone says nothing about stack[mask] boolean indexing.',
    referenceJudgment: 'support',
    referenceOutcome: 'For elementwise use align (1,2,3) with (4,2,3), giving (4,2,3). Full shape equality and boolean-index validity are separate claims.',
    evidence: 'Trailing columns 3=3 and rows 2=2 align; the missing leading mask dimension acts as 1 and expands to 4 under BROADCAST.',
  },
  {
    id: 'scoped_absence', ruleId: 'SOURCE_SCOPE',
    authority: 'SOURCE_SCOPE: An exhaustive inventory of imports and direct calls in one complete supplied file finds no score import or direct call. No other files, dynamic dispatch or runtime were inspected.',
    claim: 'No score import or direct call is present in the inspected file; repository-wide absence and runtime behavior are unverified.',
    referenceJudgment: 'support',
    referenceOutcome: 'Accept the bounded static absence; keep the uninspected repository, dynamic paths and runtime unresolved.',
    evidence: 'The negative claim is limited to the complete inventory actually supplied. It does not promote absence of direct source evidence to proof that score never runs.',
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
