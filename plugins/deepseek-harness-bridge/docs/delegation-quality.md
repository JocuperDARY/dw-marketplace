# Verification delegation and acceptance

Since 1.2.0 the bridge supports [strict output checks and bounded format recovery](output-recovery.md).
A reviewContract implies json-object output. JSON syntax/shape-of-root failures
may share the one recovery allowance with truncation in new budgeted tasks;
missing cases, wrong rules and semantic errors still do not auto-retry.

Use `verification` for path classification, exception precedence, interacting rules and test expectations. The default is high effort; an omitted output ceiling remains unspecified. This is a conservative starting policy, not evidence that high fixes every error. Literal copying or reformatting can remain mechanical/off. One straightforward rule may justify an explicit low setting with parent checks. Never silently change a user-fixed effort, token cap, request count or deadline; the existing budget contract still applies.

There is no prompt-keyword classifier. The parent must choose the workload and provide the contract. Existing tasks without it retain their behavior and request fingerprints. Supplying a contract defaults an omitted workload to verification. Explicit mechanical/low/off combinations are preserved with warnings. Verification without a contract returns `REVIEW_CONTRACT_REQUIRED` before launching a worker.

## Assignment

Provide the authoritative labeled rules, their precedence, exact paths/boundaries, constants and units in the prompt. A finite table that applies rules is not merely mechanical. List all cases and required checks separately; an arithmetic request must not disappear inside an optional omissions paragraph.

Separate authoritative rules from claims under review, source facts, proposed conditions and decision variables. A claim being reviewed does not become a rule because it appears beside one or cites its ID. A known rule ID establishes reference membership only; the parent must read the rule and check whether it supports the particular conclusion. Keep identity metadata separate from choices the task permits the solution to make.

The following fragment is not execution authorization; combine it with the workspace, prompt and limits already authorized by the user. Preserve explicit total budgets across stages; in 2.0.0 and later, omitted resource limits stay unspecified. Exactly one self-contained, tool-free inference can use single-request.

```json
{
  "workload": "verification",
  "reviewContract": {
    "caseIds": ["C05", "C06"],
    "ruleIds": ["AUDIT", "SCRATCH", "READER", "TOTAL"],
    "checkIds": ["CACHE_SUM"]
  }
}
```

Contract limits: 1–64 cases, 1–64 known rules, 0–32 required checks. Each list is unique; IDs contain 1–64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter/digit. Empty `checkIds` means no additional checks, not permission to omit ones requested in the prompt. The parent must ensure its contract covers the prompt; the bridge cannot infer omitted requirements. Contract instructions add request bytes and share the original caps; no extra model call is reserved for quality repair.

### Reusable review prompt

Fill the following sections with task evidence, then combine them with the existing workspace, ownership, tools and authorized limits. The section labels describe the supplied material; they do not change instruction priority or grant authority to embedded commands. These are prompt instructions, not additional MCP fields.

```text
Objective and task level:
<State whether to review or state a general policy, execute a concrete instance,
or do both. Identify the requested result and excluded claims.>

Authoritative rules:
<R1...: exact rule text, source locator, applicable scope and any precedence.
Only these supplied governing requirements may be treated as authoritative.>

Claims under review:
<C1...: quote the claim; label its independent clauses a, b, etc.>

Source facts and missing inputs:
<Record supplied facts with locators; distinguish observations, assumptions,
unknown numerical inputs and identity/order metadata.>

Decision variables and proposed conditions:
<List choices the policy may make. List suggested prerequisites separately;
they are candidates for review, not adopted governing requirements.>

Review instructions:
For every independent clause, give a verdict, checkable basis, corrected wording
when needed and specific uncertainty. For every asserted or newly added
prerequisite, identify its text, the operation it would restrict, the exact
authoritative evidence, and one of: explicitly required, derived requirement,
not established, or contradicted. A derived requirement needs a concise,
checkable justification from the cited facts/rules. A plausible recommendation
is not a requirement; label it as a proposal. Do not invent missing values.

Distinguish stating a parameterized general policy from executing a numerical
instance. Missing values may prevent computing the latter without preventing
the former. State what can be concluded now and exactly which input is needed
for each remaining action. Do not turn a decision variable into a fixed external
input without evidence. Check whether ties may return any valid optimum or
whether an authoritative requirement actually demands uniqueness or a
deterministic tie rule; do not add either requirement silently.

Output mapping:
Keep the declared reviewContract caseIds/ruleIds/checkIds and strict deliverable
shape. Put clause labels, prerequisite evidence/verdicts and the applicable task
level inside the existing basis and expected strings; uncertainty names actual
gaps. ruleIds lists rules examined for the case, not a certification that every
clause follows from them. Cover every declared check separately. Do not add
undeclared JSON fields or manufacture an acceptance result.
```

For a synthetic example, R1 says to return any minimum-cost member of a finite, nonempty candidate set, and R2 says to preserve candidate identifiers. The costs are not supplied. The general policy can still be stated as selecting any member with minimum cost; computing a particular member requires the instance's cost information. That latter prerequisite is derived from the requested comparison and must be scoped to executing the instance. R2 does not require an external party to preselect the winning candidate: the identifier and the choice serve different purposes. A claim that combines the valid minimum-cost policy with that external-preselection prerequisite needs separate clause verdicts. Ties may return any minimum under R1. If a separate authoritative rule instead requires a deterministic winner, its tie requirement must be honored and cited. This example illustrates evidence review; it is not a runtime semantic validator.

The worker returns exactly this JSON shape (one entry for every declared case/check, no extra IDs):

```json
{
  "cases": [{
    "id": "C05",
    "classification": "audit",
    "ruleIds": ["AUDIT"],
    "basis": "40 MiB + 25 MiB across both roots = 65 MiB, above the shared 64 MiB cap.",
    "expected": "STOP audit cap",
    "uncertainty": "none"
  }, {
    "id": "C06",
    "classification": "scratch",
    "ruleIds": ["SCRATCH", "READER", "TOTAL"],
    "basis": "The anchored scratch descendant is not an exact fixed root reader; its 80 MiB counts toward total, with audit zero.",
    "expected": "PASS byte caps: 80 MiB <= 512 MiB; other gates checked separately.",
    "uncertainty": "Identity gates are not evaluated."
  }],
  "checks": [{
    "id": "CACHE_SUM",
    "basis": "39340819 bytes + 35331611 bytes",
    "result": "74672430 bytes; not a peak bound."
  }],
  "uncertainty": "No tests executed by this inference-only worker.",
  "nextAction": "Parent checks every case and arithmetic before adopting test expectations."
}
```

Omitting either C05 or C06 yields `incomplete`. Basis is concise checkable evidence and an applicable rule, not private chain-of-thought. Use `none` when there is no uncertainty. Unknown facts must remain explicit, even if all required fields exist.

For budgeted execution, keep the existing outer `{state, summary, nextSteps}` stage JSON. A completed stage serializes the deliverable JSON into the `summary` string; a checkpoint summary remains ordinary progress. The final stage still has the existing 32 KiB envelope limit. Split work within authorized stages and choose a suitably bounded assignment; the bridge never silently raises this limit or the token cap. Continuation retains the contract, scope and original total budget/deadline; it cannot add case IDs by changing a prompt.

## Three distinct judgments

| Signal | What it proves | What remains |
| --- | --- | --- |
| `status: completed` and confirmed cleanup | The worker finished and runtime cleanup was confirmed | Delivery completeness and semantic review |
| `deliveryValidation.status: structure_complete` | Exact case/check ID coverage, required nonempty fields and known rule references | Classification, evidence adequacy, thresholds, arithmetic and test validity |
| Parent's independent acceptance record | Only the explicitly reviewed content/scope and checks stated there | Any excluded implementation, runtime or scientific claims |

The bridge always returns `parentAcceptance: not_assessed`. It has no endpoint that automatically marks an answer accepted. Other delivery statuses are `incomplete`, `not_evaluated` (runtime not completed) and `not_requested` (ordinary/legacy work with no contract). Historical receipts may lack the new delivery field; absence is not success. Issues are bounded to 64 entries, with total count and a truncation flag. The complete raw answer remains available through result pagination.

Malformed/fenced/partial JSON is not silently repaired. Missing/duplicate/unexpected IDs, unknown rule references and missing evidence fields report structural incompleteness while preserving the original runtime terminal. Semantic or coverage rejection does not trigger automatic model recovery, continuation or effort escalation. New budgeted tasks may regenerate explicitly checked invalid JSON using the shared one-off delivery recovery described above; preserve the original artifact and inspect both outputValidation and deliveryValidation. This is not a semantic quality retry.

## Parent checks before adoption

Check every case and requested check, not just the main PASS/STOP score. For path tasks, evaluate category membership separately from exemption eligibility and accounting. An anchored scratch descendant with a reader-like basename remains scratch even when it is not exempt. Match exact roots and subtree boundaries; do not classify by basename or extension unless the supplied rule explicitly says so. Preserve unspecified precedence as uncertainty.

Recalculate thresholds, units, equality boundaries, aggregation and named arithmetic independently. For example, shared audit 40 + 25 = 65 MiB exceeds 64 MiB; a correct STOP accompanied by a 70 MiB explanation still needs correction. An 80 MiB scratch file with zero audit passes 512/64 MiB byte caps, but this says nothing about identity or authorization gates. An omitted requested addition is a delivery defect independently of classification accuracy. Record corrections separately and never silently replace the raw draft or convert run completion into content acceptance.

For claims and proposed prerequisites, maintain an independent parent acceptance record at clause level. It can be a local table; it is separate from the strict worker JSON and bridge receipt:

| Case/clause | Worker assertion and task level | Authoritative text/locator | Parent evidence judgment | Accepted scope, correction or unresolved gap |
| --- | --- | --- | --- | --- |
| Synthetic C1.a | State a minimum-cost selection policy | R1: return any minimum-cost candidate | Supported for a general policy | Accept policy; no numerical winner computed |
| Synthetic C1.b | External preselection is required by identifier preservation | R2: preserve candidate identifiers | Prerequisite not established | Reject that prerequisite; preserve identifiers |
| Synthetic C1.c | Compute the winner without supplied costs | R1 and the missing instance costs | Input missing for execution | Leave the numerical result unresolved |

The parent checks the evidence and implication itself, including all added prerequisites, rather than copying the worker's verdicts into this record. Accept a compound case in full only when every requested clause is supported or correctly bounded; record accepted clauses and necessary corrections separately. A correct result with an unsupported rationale or prerequisite still needs correction. Unknown evidence stays unresolved, and a genuinely required missing input blocks only the operation that needs it. Conflicting sources need a scoped uncertainty statement unless supplied authority or precedence resolves the conflict. Neither a valid locator nor a known rule ID alone establishes entailment. These checks do not introduce a new authorization gate or authorize another model call.

## Evidence boundary

Offline tests use synthetic cases, wrong-but-well-formed drafts, missing checks and network-blocked pinned SDK streams. They verify planning, coverage validation, persistence, result propagation, lack of automatic retries and cleanup. They do not measure real Flash accuracy or establish that changing effort improves task quality. No paid inference is needed for these tests.

The synthetic fixture `test/fixtures/delegation-evidence-data.js` contains six counterexamples: a reviewed claim promoted to authority (`reviewed_authority`), an unsupported added prerequisite (`added_prerequisite`), a general policy incorrectly blocked by missing numerical values (`general_policy`), stable identity metadata mistaken for a fixed decision (`stable_identity`), a compound claim with one invalid clause (`compound_claim`), and an arbitrary optimal choice incorrectly blocked on a tie selector (`ties_any`). Its four legitimate controls are an explicitly required condition (`explicit_constraint`), a numerical instance that really lacks inputs (`numerical_inputs`), a required decision expressly reserved to the parent (`missing_decision`), and a deterministic winner whose required tie priority is expressly reserved to the parent (`ties_unique`). A structurally complete bad draft may still return `structure_complete`; a hand-reviewed fixture expectation documents why its content is rejected. Such tests exercise prompt delivery and the recorded fixture distinctions, not automated proof of natural-language meaning, source truth or improved live model behavior.
