# Strict output and bounded recovery

Current resource semantics are defined in [budget reliability](budget-reliability.md):
new omitted limits stay unspecified; original failed artifacts and saved budgets stay unchanged.

Two separate failures motivated this change: a low-effort short draft exhausted
its reasoning-inclusive output allowance without visible text; a completed
literal-extraction task put prose before its requested summary JSON. The former
does not establish why the provider spent its allowance. A reported Windows-path
corruption was withdrawn after exact decoded-value comparisons and is excluded
from the failure cases. No path normalization or unescaping repair is added.

## Choose work, format and authorization separately

- `drafting` starts at off without inventing an output cap for prose from supplied facts. It is not a
  shortcut for rule reasoning, research or ambiguous synthesis. Literal extraction
  stays mechanical/off; ordinary work stays standard/low; rule verification stays
  verification/high with reviewContract. Explicit effort and caps remain binding.
- Even low effort can spend the whole output allowance on reasoning. A
  single-request reasoning task receives a warning, never an automatic effort
  change, larger allowance, second request or continuation.
- Budgeted mode preserves any explicit totals and leaves omitted totals unspecified.
  Use it when durable stage continuation is useful; this does not authorize replaying
  a historical failed single request. Automatic native context compaction is a
  separate mechanism, and is disabled in single-request and staged execution.
- For any JSON-only deliverable set `outputFormat: "json-object"`, including
  mechanical extraction. A reviewContract implies this format and cannot combine
  with explicit text. Ordinary tasks default to text; no keyword classifier infers
  an output contract from the prompt.

This fragment is configuration, not execution authorization:

```json
{
  "workload": "drafting",
  "outputFormat": "json-object",
  "executionMode": "budgeted",
  "capabilityProfile": "inference-only",
  "maxTokens": 4096,
  "maxModelRequests": 3,
  "maxToolCalls": 0,
  "budget": {
    "totalModelRequests": 3,
    "totalOutputTokens": 8192,
    "totalToolCalls": 0,
    "totalDurationMs": 60000
  }
}
```

For budgeted final output keep the outer `{state, summary, nextSteps}` envelope.
When completed, the entire summary string must contain only the serialized
target object. Checkpoint summaries remain ordinary progress text. The 32 KiB
outer envelope limit remains; split a larger assignment into appropriately scoped
work within its authorized budget rather than silently increasing limits.

## Strict checking is not semantic acceptance

`outputValidation` reports `not_requested`, `not_evaluated`, `valid` or `invalid`,
with scope `format_only`. JSON-object checks parse the entire final response (or
completed summary) and require an object root. Prose, fences, concatenated
objects, incomplete JSON, arrays, string roots and null fail. No substring
extraction, type conversion, path normalization or JSON repair is performed.
`not_requested` and zero issues do not mean a check passed. Check the finished
status result, not a paginated fragment of text.

Runtime `completed` may coexist with invalid output after recovery is unavailable
or unsuccessful. `deliveryValidation` separately checks a reviewContract's IDs
and fields. Format-valid and structure-complete answers can still be wrong;
`parentAcceptance` always remains `not_assessed`. Compare decoded types and values
to authoritative inputs, check all required fields, and record semantic decisions
separately. Never classify escaped tool-display strings by visual slash count.

## Shared recovery eligibility

For new budgeted tasks, when at least three requests and 768 output tokens remain,
stage allocation holds back one request and up to 2048 output tokens, bounded by
the per-request cap and one third of remaining output. The ordinary stage still
reserves its own checkpoint. This is a soft reserve: when work plus checkpoint
and the separate reserve no longer fit, the last ordinary stage may use the
remaining authorization. Tiny budgets, elapsed deadlines and repeated failure can
still leave no recovery. Time and token ceilings are never raised.

Confirmed max-tokens and an explicitly requested invalid completed JSON summary
share one initial off, one-request, zero-tool recovery. New progress-v2 records may earn another episode only through newly verified parent-declared milestones after ordinary work; see [progress recovery](progress-recovery.md). Omitted milestones and saved bounded-v1 records retain at most one lifetime episode.
Cleanup and accounting must be confirmed; cancellation, denied calls, storage
clipping, transport, persistence and semantic errors do not trigger recovery.
Missing review items with otherwise valid JSON do not trigger it either.

Before recovery, save original text, reason and output metadata in partial-N.json
and persist the charged stage. Format failures retain the complete invalid draft;
the filename does not imply that every stored artifact was truncated. Regenerate
from original supplied facts and bounded visible evidence in a fresh session;
never replay tools or claim access to hidden reasoning. Insufficient evidence
becomes an honest checkpoint. Recovery uses the same format and coverage checks;
failure, no remaining budget or another defect without renewed eligibility is exposed without another
automatic repair. `recovery` identifies reason, outcome and original artifact;
`orchestration.recoveries` counts actual recovery stages, while truncationRecoveries
still counts just truncation recovery stages.

Existing saved tasks keep their original allocation policy and fingerprints.
Explicit outputFormat participates in replay identity, survives restart and
continuation, and cannot be changed by a follow-up prompt. No upgrade reruns a
historical failure. Single-request continues to allow exactly one inference,
no tools and no recovery or continuation, even with outputFormat enabled.

## Evidence

Offline tests use synthetic facts, strict parsing, fake model streams and a real
pinned SDK/MCP with network blocked. They cover both failure types, insufficient
budgets, shared recovery limits, persistence, denied/uncertain execution,
single-request stopping and unchanged valid Windows paths. These tests establish
bridge behavior, not provider accuracy or an assurance that every authorized
task will finish. No paid model test is required or performed for this release.
