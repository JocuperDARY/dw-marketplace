# Resource limits and persistent progress — 2.0.0

This release changes omitted-limit semantics for new tasks. Existing saved
tasks retain their original limits, fingerprints and recovery policy. The
[delivery contract](output-recovery.md) still separates format from acceptance.

New tasks default to `executionMode: "automatic"` when no budget is supplied.
Omitted/null maxTokens, maxModelRequests, maxToolCalls, maxRequestBytes and
timeoutMs stay null: no finite bridge spending cap is invented. A supplied
budget selects budgeted mode. Its four optional totals are totalModelRequests,
totalOutputTokens, totalToolCalls and totalDurationMs; omitted totals stay null.
Explicit totals cover stages, recovery and continuation, and cannot be refilled
or extended by restart/replay. Output includes reasoning; request bytes are
neither exact input tokens nor currency. Omitted limits do not expand task scope,
grant access or instruct the worker to spend more.

Native automatic sessions prefer the SDK's own repeated context compaction.
Auxiliary compaction requests use the same official Flash route and request
meter; explicit request/output limits still apply. Their omitted effort is
recorded as null, rather than falsely reported as the parent's effort. The
pinned SDK supplies finite defaults (256000 request output, 1000000 context;
65536 compaction output) even when the bridge omits limits. These are inspected
SDK settings, not measured provider hard maxima or infinite physical context.

For durable logical task expansion, explicitly select budgeted mode. An omitted
budget or budget:{} leaves all totals unspecified and permits a sequence of
checkpoint stages with no fixed stage count or parent-attempt ceiling. Each
stage publishes progress before its successor starts; older evidence remains
on disk. There is no fixed total-capacity promise: disk, memory, SDK, provider
and structural storage boundaries remain. This mode uses stage checkpoints
instead of native in-session compaction. Cancellation, repeated identical
progress, unsafe accounting, failed persistence and explicit exhausted totals
still stop work. Failed stages are not retried indefinitely.

Explicit `single-request` permits one inference-only/read-only request, zero
tools, no budget object and no continuation. Old records remain readable and
retain their original fingerprints and legacy same-session continuation rules;
they are not retroactively granted a total budget.

## Request planning

| Workload | Default work effort |
| --- | --- |
| `mechanical`: extraction and formatting | `off` |
| `drafting`: prose from supplied facts | `off` |
| `standard`: ordinary maintenance and review | `low` |
| `reasoning`: substantive reasoning | `high` |
| `verification`: interacting rules and test expectations | `high` |

Effort does not set a token limit. Explicit effort overrides the workload. Explicit
`maxTokens` is never silently raised. High effort with a small cap returns a
planning warning: reasoning and visible text share the allowance. These defaults
are not measured performance guarantees.

Stages receive at most remaining explicit authorization and caller ceilings.
There is no default stage request ceiling. When a checkpoint fits, one request and up to 2048 tokens are
reserved for a checkpoint, reduced for smaller explicit caps/totals. Work uses
remaining stage output minus this reserve, up to its explicit cap. Known final
usage releases unused reservations; unknown/unfinished usage stays charged at
the full available reservation; an unknown unbounded reservation stays null,
never zero. Invalid receipts retain the stage allocation and prevent continuation.

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

A new budgeted task gets one initial text-only recovery, shared between max-tokens and explicitly checked invalid final JSON. Further progress-v2 episodes require newly verified parent-declared milestones (see [progress recovery](progress-recovery.md)),
after confirmed cleanup and valid accounting. Visible
partial text and metadata are first saved in `partial-N.json`. They are untrusted
evidence, not a validated checkpoint. Recovery uses a fresh session, `off`, one
request, zero tools, the original assignment, last validated checkpoint and at
most 16000 UTF-16 units of partial text. Metadata identifies context clipping and
the full artifact path. Recovery regenerates valid stage JSON; it cannot
concatenate broken JSON, repeat file actions or claim unseen reasoning as
evidence. Insufficient evidence must become a checkpoint with explicit unknowns.

Recovery spends the same remaining request/output/time authorization. A valid
checkpoint can resume ordinary stages; completed recovery returns its receipt.
Continuation and restart alone do not renew recovery. Saved bounded-v1 and omitted-milestone tasks retain one episode. Without new eligible progress, further truncation,
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

- Preserve unspecified limits through schema, planning, persistence, continuation
  and accounting; verify explicit caps and legacy fingerprint migration.
- Test allocations, checkpoint reserves, usage refunds, auxiliary races,
  immutable totals, cancellation and failed publication.
- Reproduce reasoning-only and partial-JSON truncation using the real pinned
  SDK, fake streams, dummy credentials and blocked network; verify durable
  evidence, one tool-free recovery and total bounds.
- Verify MCP submission, results, continuation, idempotency, cleanup and
  transient/persistent observation locks without duplicate execution.
- Review the versioned candidate independently; merging/publication requires the
  user-approved release step. Candidate installation is not a marketplace release.

No paid test, dependency upgrade, desktop conversation reuse or change to the
original workspace's 40 dirty entries is part of this release. Native tools,
shell and in-process teams are selected under the declared access and capability
contract. Offline success covers the fixtures; real-provider quality and latency
remain untested here.
