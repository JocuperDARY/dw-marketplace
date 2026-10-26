# Retained history pagination

`dsh_list` still defaults to this connection's owned tasks and at most50 recent summaries. Explicit `scope: store` includes other connections and retained legacy records, without granting control. Each summary describes the latest attempt at initial observation, sorted by start time descending and then task ID descending. Legacy summaries keep `readOnly: true`; no control tokens are returned.

Optional filters:

- `limit`: integer1–50, default50.
- `parentLabel`: exact case-sensitive match. Omitted includes unlabeled records; empty string matches only an explicitly empty label.
- `statuses`: nonempty unique array of advertised latest-attempt statuses. Duplicates are rejected as a contract check beyond JSON Schema.
- `startedFrom`: inclusive UTC ISO8601 timestamp with seconds, ending in Z; optional fractional seconds have1–3 digits (millisecond precision). Greater precision is rejected, never rounded.
- `startedBefore`: exclusive timestamp with the same precision rule; must be later than startedFrom.

```json
{"scope":"store","limit":20,"parentLabel":"experiment-A","statuses":["completed","failed"],"startedFrom":"2026-10-01T00:00:00Z"}
```

The response retains `tasks`, `total`, `blocked`, `activeTaskIds` and `activeTaskId`. `total` is the number matching the query; `scopeTotal` counts all tasks in the selected scope before filters. `pagination` gives `mode: snapshot`, capture/expiry times, offset, limit, nextCursor and nextRequest. Follow the complete `pagination.nextRequest` unchanged until it is null. It already includes the normalized scope/filter/page-size fields; omitting them can invalidate a cursor. Equivalent timestamp spelling/status ordering normalizes to the same query.

The first call captures immutable summaries. New insertions, new attempts, result updates and status transitions do not modify that snapshot or move rows between its pages. Cursor replay returns the same page. Even the active-task list is captured evidence, **not live status**. Use `dsh_status` for a task's current status or omit cursor to start a fresh history query. Cursor pages perform no store refresh, task writes or execution-lease operations.

Snapshots are observation data in the current connection's memory, not shared task state. They last10minutes; at most8 snapshots and16MiB of serialized task summaries are retained per manager, evicting oldest snapshots when necessary. A query whose matching summaries exceed16MiB fails with `HISTORY_SNAPSHOT_TOO_LARGE`; narrow its filters. This bound is not a task-duration, token or request cap. A cursor from another connection, a restarted host, an expired/evicted snapshot or closed connection cannot continue: start a fresh query and reconcile any already-consumed IDs explicitly. The bridge never silently restarts pagination. Scope/filter/page-size mismatch and tampering also fail clearly without exposing cursor values in diagnostics.

These are coherent snapshots of the store observation, not a globally atomic transaction across every worker's in-flight activity or a guarantee that local history contains the provider's entire bill. Existing usage, ownership, cancellation and budget accounting remain separate.
