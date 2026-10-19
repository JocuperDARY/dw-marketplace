# Verification delegation and acceptance (1.2.0)

1.2.0 adds [strict output checks and bounded format recovery](output-recovery.md).
A reviewContract implies json-object output. JSON syntax/shape-of-root failures
may share the one recovery allowance with truncation in new budgeted tasks;
missing cases, wrong rules and semantic errors still do not auto-retry.

Use `verification` for path classification, exception precedence, interacting rules and test expectations. The default is high effort; an omitted output ceiling remains unspecified. This is a conservative starting policy, not evidence that high fixes every error. Literal copying or reformatting can remain mechanical/off. One straightforward rule may justify an explicit low setting with parent checks. Never silently change a user-fixed effort, token cap, request count or deadline; the existing budget contract still applies.

There is no prompt-keyword classifier. The parent must choose the workload and provide the contract. Existing tasks without it retain their behavior and request fingerprints. Supplying a contract defaults an omitted workload to verification. Explicit mechanical/low/off combinations are preserved with warnings. Verification without a contract returns `REVIEW_CONTRACT_REQUIRED` before launching a worker.

## Assignment

Provide the authoritative labeled rules, their precedence, exact paths/boundaries, constants and units in the prompt. A finite table that applies rules is not merely mechanical. List all cases and required checks separately; an arithmetic request must not disappear inside an optional omissions paragraph.

The following fragment is not execution authorization; combine it with the workspace, prompt and limits already authorized by the user. Long tasks still require all four total budgets. Exactly one self-contained, tool-free inference can use single-request.

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

## Evidence boundary

Offline tests use synthetic cases, wrong-but-well-formed drafts, missing checks and network-blocked pinned SDK streams. They verify planning, coverage validation, persistence, result propagation, lack of automatic retries and cleanup. They do not measure real Flash accuracy or establish that changing effort improves task quality. No paid inference is needed for these tests.
