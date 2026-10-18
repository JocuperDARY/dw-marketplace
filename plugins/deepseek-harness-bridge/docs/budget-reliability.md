# Budget reliability contract — 1.0.0

New tasks default to `executionMode: "budgeted"` and MUST supply preauthorized
`budget` totals: `totalModelRequests`, `totalOutputTokens`, `totalToolCalls` and
`totalDurationMs`. Missing totals produce `BUDGET_REQUIRED` before credential
preflight or worker launch. Defaults never create authorization. These totals
cover stages, recovery and continuation; restart and replay cannot refill them
or extend the deadline. Output includes reasoning. This is not a currency or
exact input-token cap; `maxRequestBytes` bounds serialized input separately.

Explicit `single-request` permits one inference-only/read-only request, zero
tools, no budget object and no continuation. Old records remain readable and
retain their original fingerprints and legacy same-session continuation rules;
they are not retroactively granted a total budget.

## Request planning

| Workload | Default work effort | Per-request ceiling |
| --- | --- | --- |
| `mechanical`: extraction and formatting | `off` | 4096 |
| `standard`: ordinary maintenance and review | `low` | 8192 |
| `reasoning`: substantive reasoning | `high` | 16384 |

Explicit effort overrides the workload; `max` defaults to 32768 tokens. Explicit
`maxTokens` is never silently raised. High effort with a small cap returns a
planning warning: reasoning and visible text share the allowance. These defaults
are not measured performance guarantees.

Stages receive at most remaining authorization and caller ceilings. The default
stage request ceiling is 6 (minimum 2). One request and up to 2048 tokens are
reserved for a checkpoint, reduced for smaller explicit caps/totals. Work uses
remaining stage output minus this reserve, up to its explicit cap. Known final
usage releases unused reservations; unknown/unfinished usage stays charged at
the full cap. Invalid receipts retain the entire stage allocation.

The pinned SDK `agent/request` waterfall prepares allowance and effort before
adapter selection and request freezing. Prompt assembly makes checkpoints
tool-free, with effort `off`. The stream gate rechecks route, output, input bytes,
tools and reservations before dispatch, including auxiliary SDK calls. The stage
ledger is saved before launch. At request-count, output-headroom, tool or soft
time boundaries, return progress JSON:

```json
{"state":"checkpoint","summary":"Completed work, evidence and changed files","nextSteps":"Remaining work and uncertainties"}
```

Use `completed` only for the whole assignment. Stage JSON is limited to 32 KiB;
larger deliverables belong in owned artifacts when write access permits. After
validated progress, accounting, durable publication and confirmed cleanup, the
next stage starts in a fresh SDK session. Identical progress pauses with
`NO_PROGRESS`; total exhaustion pauses with `TOTAL_BUDGET_EXHAUSTED`. Parent
acceptance remains separate. Checkpoints are cooperative at request boundaries;
stalls, ignored protocols and process failures can still hit hard limits.

## Truncation and partial results

Provider `max-tokens` is retained with `OUTPUT_TRUNCATED`, not a generic error.
`output.kind` distinguishes `complete_text`, `partial_text`, `reasoning_only`
and `empty`. Only reasoning presence is returned, never reasoning content.
`output.modelTruncated` describes the provider stop; `output.storageTruncated`
and legacy `outputTruncated` describe storage clipping. `resultAvailable` and
`nextOffset: null` describe storage/pagination, not successful completion.

A new budgeted task may use ONE automatic text-only recovery over its entire
lifetime after max-tokens, confirmed cleanup and valid accounting. Visible
partial text and metadata are first saved in `partial-N.json`. They are untrusted
evidence, not a validated checkpoint. Recovery uses a fresh session, `off`, one
request, zero tools, the original assignment, last validated checkpoint and at
most 16000 UTF-16 units of partial text. Metadata identifies context clipping and
the full artifact path. Recovery regenerates valid stage JSON; it cannot
concatenate broken JSON, repeat file actions or claim unseen reasoning as
evidence. Insufficient evidence must become a checkpoint with explicit unknowns.

Recovery spends the same remaining request/output/time authorization. A valid
checkpoint can resume ordinary stages; completed recovery returns its receipt.
Continuation and restart do not grant a second recovery. Further truncation,
malformed output, exhausted budget or process failure retains non-success and
partial evidence. Transport errors, denied calls, cancel/shutdown, unconfirmed
cleanup/accounting and persistence failures never auto-retry. Upgrades never
rerun historical paid failures.

## Observation and ownership

Status/list/result reads retry ownership conflicts for at most 1500 ms with
bounded backoff. `dsh_wait` shares its original timeout with this wait. Delays
hold no transition queue and shutdown interrupts them. Reads never resubmit or
cancel another connection's task. Persistent conflicts return `STATE_LOCKED`,
`operation: "observation"`, `retryable: true`, `retryAfterMs: 1000`: retry only
the observation and reconcile ownership if it persists. This does not prove
whether the owner is live or stale. Mutations remain exclusive; unresolved
cleanup retains ownership. No lock is automatically deleted or stolen.

## Release acceptance

- Reject missing totals before dispatch; verify the single-request exception,
  workload defaults, explicit caps and legacy fingerprint migration.
- Test allocations, checkpoint reserves, usage refunds, auxiliary races,
  immutable totals, cancellation and failed publication.
- Reproduce reasoning-only and partial-JSON truncation using the real pinned
  SDK, fake streams, dummy credentials and blocked network; verify durable
  evidence, one tool-free recovery and total bounds.
- Verify MCP submission, results, continuation, idempotency, cleanup and
  transient/persistent observation locks without duplicate execution.
- Review and merge one 1.0.0 PR, then synchronize marketplace and local plugin.

No paid test, dependency upgrade, desktop conversation reuse, nested team,
shell-permission expansion or change to the original workspace's 40 dirty
entries is part of this release. Offline success covers the fixtures;
real-provider quality and latency remain untested here.
