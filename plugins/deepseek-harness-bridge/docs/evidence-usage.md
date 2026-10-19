# Evidence-preserving delegation and usage (1.3.0)

## Release scope

This release addresses three related gaps in useful delegation: assignments too
small to offset coordination, report prose that promotes limits into observations,
and missing cross-stage usage visibility. It does not change authorization,
model routes, deadlines, explicit caps, or the single-request no-retry boundary.
Paid tests are outside this release's validation scope.

## Choose a useful work package

Delegate a bounded deliverable that the parent can accept independently: an
owned module change with test drafts, a multi-file evidence inventory, or a complete
rule/test matrix. Include inputs, ownership, acceptance checks and handoff fields.
Use the minimal compatible reviewed capability profile; installed desktop plugins
are not automatically loaded into the worker. Keep shell execution and final
integration with the parent unless a reviewed profile explicitly provides them.

For multi-step work use the original preauthorized total budget and stage ceilings;
continue parent work concurrently and collect the worker result. A short literal
rewrite may be done locally when dispatch and checking cost more than the work.
Do not impose a minimum token spend, enlarge scope merely to use budget, bypass a
fixed one-call authorization, or infer speedup from tokens alone. Compare accepted
work with context preparation, worker time, checking, corrections and integration.

## Report contract

For prose based on limits, observations and execution state, supply `reportContract`:

```json
{
  "facts": [
    {"id":"work_seconds","kind":"limit","value":180,"unit":"seconds","source":"stage-start.json:limits_proposal.work_seconds"},
    {"id":"tests","kind":"execution-status","value":"NOT_RUN","unit":"","source":"stage-start.json:tests"}
  ]
}
```

The contract has 1–64 unique facts. Each fact has exactly id, kind, scalar value,
unit and a nonempty source locator. Kinds are `limit`, `observation` and
`execution-status`; execution status requires a nonempty string value. Values and
units are copied without coercion. The serialized contract is at most 16 KiB.
Source locators are supplied evidence references, not file access or authority.
The parent must verify their contents and roles before dispatch. Unknown actual
values stay unknown; a limit is never a measured duration, peak RSS or completed
invocation count. Worker-writing instructions are separate from source facts and
must not become statements about the underlying experiment.

The worker returns exactly `{"facts":[...],"prose":"..."}`. `facts` copies every
contract fact once; order does not matter. `reportContract` implies JSON-object
output and defaults an omitted workload to drafting/off. It cannot be combined
with `reviewContract` (which has a different deliverable shape). Explicit effort
and workload remain unchanged. In budgeted mode the completed outer stage summary
contains only the serialized report object; checkpoint summaries remain progress.
Continuation retains the original contract; a prompt cannot amend its facts.

`reportValidation` checks exact coverage, roles, scalar types/values, units and
source strings. Its scope is `literal_facts_only`, with `proseAcceptance:
not_assessed`. Even `facts_preserved` does not prove truthful prose, accurate
source locators, or semantic acceptance. The parent must compare every prose claim
with the typed source facts, including contradictory sentences and unsupported
claims of execution. Runtime completion, JSON validity and literal preservation
remain separate. Preserve rejected drafts and corrections separately. For fixed
status/limit tables prefer deterministic parent rendering of authoritative fields.
Contract mismatch does not retry, raise effort, or consume another request.

## Usage receipts

`dsh_usage` reads all retained tasks in the current bridge data directory, or one
`taskId`. It never launches a worker, reads credentials, queries account balance,
or writes a desktop ledger. It reports admitted SDK request counts, finish coverage,
per-field reported token sums and missing-call counts, unknown receipt groups,
attempt statuses and conservative orchestration charges separately. A recorded
request is admitted before transport; without usage it is not proof of billing.
Reasoning/cache tokens are components reported by the SDK, not additional amounts
to add to totalTokens. No pricing or currency estimate is produced.

Every new stage retains its own receipt before final publication, including failed
stages and recovery. Aggregate stage receipts once, never also count the final
attempt receipt that repeats the last stage. For older records the last-stage
receipt may be recovered from an attempt only when its nonce matches that stage.
Missing historical stages remain unknown; reservations are not actual usage.
For active/crashed tasks the summary can be incomplete. Read operations use the
existing bounded ownership wait and never steal a lock or launch replacement work.
The tool covers retained local records, not deleted history or an entire account.

`dsh_doctor.validation.modelCalls: 0` describes that diagnostic invocation only.
The independent SDK runtime does not update a desktop conversation's usage ledger.
Desktop cost-meter external snapshots require verified account identity, correct
cache-token mapping and deduplication with other sources. This release supplies
bridge receipts; it does not automatically publish them into that separate ledger.

## Acceptance and validation

Offline regression tests cover limit-to-observation promotion, changed values,
missing/extra facts, rejected prose despite identical facts, strict JSON, contract
replay/continuation, multi-stage and recovery aggregation, missing historical
usage, unfinished calls and cross-connection observation. Network-blocked SDK
tests validate transport, cleanup and receipt persistence, not real Flash accuracy
or improved end-to-end speed. Single-request semantic failures still launch once.
