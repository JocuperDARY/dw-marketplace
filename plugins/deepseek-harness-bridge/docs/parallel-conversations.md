# Cross-conversation task execution

Execution contract for Bridge 3.0.0. Test evidence and installed-host validation
remain separate from this design description.

## Required behavior

- Different tasks can execute concurrently through independent MCP connections
  sharing one state directory. Each root owns its SDK client/runtime, session,
  budget, abort controller, artifacts and cleanup.
- A task has one execution owner at a time. A stable request ID starts at most one
  attempt, even when two processes submit it together.
- Observations read committed snapshots without acquiring an execution lease or
  changing another task's lifecycle.
- Continuing or cancelling requires the owning connection or an explicit opaque
  control capability. Labels are not authorization. Tokens never enter worker
  prompts, model arguments, public list results or error messages.
- Cancellation and disconnect only stop owned workers; cleanup and unknown usage
  remain task scoped. They cannot release another task's lease or budget.
- Overlapping writable workspaces require isolation. Read-only tasks may share a
  stable workspace. Native Shell has the declared workspace authority.
- Omitted resource ceilings remain unspecified. Existing explicit per-task
  budgets include every stage, child and auxiliary request; continuation never
  resets them. Aggregate usage is reporting, not an invented shared budget pool.

## Storage and upgrade boundary

Use short cross-process registry transactions, per-task execution leases and
committed task snapshots. Publish durable idempotent admission before launching a
worker. Publish results before terminal snapshots. Observation is not recovery.
Uncertain admission, stale locks and unknown cleanup fail closed for the affected
task; no age-based lock stealing or automatic paid retry.

Version 2.1's global owner.lock and recovery scanner cannot coexist with a
concurrent writer. Switch only after all old tasks finish and old host processes
release ownership. Preserve historical state, install an explicit version guard
against old writers, and retain legacy results as read-only evidence. A downgrade
must never silently make old code scan new running tasks.

Before upgrade, let existing tasks finish and confirm their cleanup. Stop old
hosts before allowing v3 admission. Do not delete owner.lock: in v3 it permanently
protects the protocol rather than indicating an active task. No downgrade writer
may access the new task store. All offline tests use isolated source and fixtures.

Initial submission returns a private controlToken once. Keep it in the parent
connection; it is required for cross-connection continue/cancel, is never sent to
workers and is not returned by list/status/result/usage/replay. It guards against
accidental cross-chat control, not an OS user with direct filesystem access.
Default list/usage scope is connection; explicit scope store includes historical
records without granting control. Cancellation refers to the exact attempt
selected in the transaction, even if a continuation has since begun.

A lost registry lock requires explicit reconciliation; an abandoned task lease
quarantines its overlapping workspace. No lock is stolen based on age or PID.
Persistence failures retain original evidence. The executing connection may
report durability: unconfirmed alongside the committed status when even an error
receipt could not be published; another reader reports committed data.
Mutable Windows publication retries only transient EPERM/EBUSY within 500 ms,
never replaying a model request or an entire admission transaction.

## Verification

1. Two independent host processes run different workers with overlapping active
   intervals and independent outputs, usage and limits.
2. Concurrent identical request IDs admit once; conflicting payloads spend
   nothing. Concurrent continuation of one task has one owner.
3. Observing B while A runs never marks A interrupted or blocks for A's lifetime.
4. Wrong-owner continue/cancel is refused. Disconnect/cancel A leaves B running.
5. Crash/persistence faults preserve admission identity, unknown usage and leases;
   completed work is not reported before durable result publication.
6. Workspace conflict isolation and legacy-version guard reject unsafe starts.
7. Existing offline regressions and package checks pass; independent code,
   JavaScript and ownership/security review have no unresolved blockers.
8. After the pelican task finishes, two real chats prove concurrent execution and
   cancellation isolation; actual results, accounting and cleanup are inspected.
9. Review and merge the PR, publish aligned marketplace metadata, synchronize one
   formal local version, and check its live tools before requesting any refresh.
