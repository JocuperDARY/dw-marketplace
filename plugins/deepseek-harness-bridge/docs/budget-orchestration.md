# Historical 0.2.0 design: Authorized budget orchestration — historical 0.2.0 contract

For new submissions, the [current reliability contract](budget-reliability.md)
supersedes opt-in admission, effort allocation and truncation behavior below.
This document records the original ledger/checkpoint design and release scope.

## Contract

Orchestration is opt-in through `dsh_submit.budget`. Its required fields are
`totalModelRequests`, `totalOutputTokens`, `totalToolCalls`, and
`totalDurationMs`. These limits authorize the entire logical task, including
automatic stages and later `dsh_continue` calls. They cannot be increased by
worker output, a repeated request ID, restart, or continuation. This is an
output-token/request/tool/time budget, not a currency or exact input-token cap.
`maxRequestBytes` still bounds each serialized model input.

The existing request, output-token, tool and timeout options become per-stage
ceilings in this mode. The parent allocates each stage from the remaining total,
reserving room for a progress response. The worker receives the original scope
and the last saved checkpoint in a fresh isolated SDK session. This bounds
history growth without importing any desktop conversation. Legacy calls without
`budget` retain their existing same-session continuation behavior.

Before the last available stage request, insufficient output headroom, the soft
time deadline, or exhausted stage tool allowance, the request gate switches to a
text-only checkpoint request. Normal work must leave one request and its output
allowance available for that checkpoint. Completed stage responses use JSON:

```json
{"state":"checkpoint","summary":"Completed work, evidence and changed files","nextSteps":"Remaining work and uncertainties"}
```

Use `state: "completed"` only when the assignment is finished; parent acceptance
remains separate. The bridge validates and durably saves the response, accounts
for spending, and confirms SDK cleanup before starting another stage. Repeated
identical checkpoints pause as stalled rather than spending on an empty loop.

Every provider request is reserved before dispatch. Known final output usage can
release unused reservations; missing or unfinished usage is charged at the full
reserved cap, never zero. Invalid receipts, provider failure, truncation,
cancel/shutdown, unconfirmed cleanup and persistence failure never trigger an
automatic retry. Incomplete persisted execution retains the existing recovery
lock behavior. Total-budget exhaustion produces `paused` with the last saved
checkpoint, not successful completion. Increasing authorization requires a new
explicitly authorized task; `dsh_continue` cannot reset totals or deadlines.

Checkpointing is cooperative at request boundaries. A single stalled provider
request, ignored response protocol, or process failure can still require the
hard timeout/limit. The bridge preserves earlier checkpoints and reports that
failure; it does not claim to eliminate every possible interruption.

## Implementation and acceptance

1. Add a persisted task-wide ledger and stage allocator, retaining old records.
2. Extend the SDK budget gate to reserve output and request checkpoint-only
   responses before a stage's hard limit. Count checkpoint calls in the budget.
3. Save checkpoint artifacts and orchestrate serial stages only after cleanup
   and durable publication; retain ownership across the entire chain.
4. Expose compact progress, authorized/charged/remaining totals and pause reasons
   in status/result. Preserve idempotency, isolation and credential boundaries.
5. Validate offline: boundary budgets, unknown usage, duplicate calls, restart,
   cancellation, checkpoint write failure, malformed response, cleanup failure,
   no-progress detection, MCP lifecycle and a real SDK with a fake provider.
6. Publish 0.2.0 through one reviewed PR and synchronize the formal plugin.

No paid model smoke test is authorized for this change. No dependency upgrade,
desktop session reuse, nested agent teams, shell permission expansion, or
modification of the original workspace's 40 changes is part of this release.
