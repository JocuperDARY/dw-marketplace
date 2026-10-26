# Persistent workers and parent communication (4.0)

`dsh_spawn_agent` starts an independent official Harness session with a stable `agentId` (the task ID). A parent can steer running work, leave an idle message, answer questions, wait for several agents, and interrupt one activity without discarding its original constraints or authorization. This does not control a desktop conversation or copy hidden Codex context. Supply an explicit assignment, file ownership, constraints and evidence.

| Operation | Behavior |
| --- | --- |
| `dsh_spawn_agent` | Submission arguments plus `communication: native/disabled`. Returns the stable identity and a control capability on first admission only. |
| `dsh_send_message` | Persist input; native `inject` at the next available step when running. An idle agent is not woken. |
| `dsh_followup_task` | Native `steer` while running; resume after confirmed cleanup when idle/interrupted. Original workspace, tools, route and totals remain fixed. |
| `dsh_interrupt_agent` | Freeze the activity/epoch target, stop new requests, interrupt the root and drain owned descendants. Retrying the request observes the original target. |
| `dsh_wait_agents` | Up to 32 targets with independent durable event cursors; 0–30000 ms observation. Timeout never cancels work or starts inference. |
| `dsh_list_agents` | Availability, pending messages, questions, context coverage and ordinary task/usage evidence. Store scope is observation, not ownership. |

Use `dsh_plan` on the underlying submission first. New agents default to native communication, except single-request agents, which fix it to disabled. A zero-tool or inference-only worker never gains `bridge_send_message`. Existing submit/continue/wait/result/cancel remain available; legacy continue still rejects running attempts. Single-request cannot be extended through either message API or continuation. No new discretionary request/token totals are introduced.

## A normal collaboration

1. Spawn separate workers for distinct responsibilities, with disjoint writing workspaces. Keep each first-admission `controlToken` private; a different connection needs it for mutations. Display labels grant no authority.
2. Send an instruction with a unique request ID. Repeating the identical operation returns its original receipt. Reusing the ID for different text or a different operation fails.
3. Keep the last event cursor for each agent. A `question_open` event contains a `messageId`; answer using `dsh_followup_task` with `replyTo` set to that ID. Ordinary followups do not resolve a question implicitly.
4. Use `dsh_result` for the pinned attempt's complete, paged final text. Progress/questions are separate events. Inspect artifacts, tests, input coverage and content before parent acceptance.

Running messages stay in the current activity. A followup received after the runtime has committed to closing is queued for the current owner to admit after cleanup. If that owner exits, the pending wake remains visible; a later authorized followup can resume after cleanup. There is no daemon, closed-parent-turn auto-wakeup, native Codex subagent UI, or automatic peer-to-peer cross-task channel. Parents may explicitly relay relevant evidence between their authorized workers. Native DSH Teams retain their own internal communication.

## Authority and coverage

`kind` is `instruction` (default), `context`, or `question`; `scope` is `persistent` (default) or `turn`. Material is labeled as data. Worker summaries cannot weaken instructions. Parent instructions remain verbatim in a required, literal, agent-scoped user-role context, including after native compaction and fresh budget stages.

Use `change: replace/retract`, explicit `targetMessageIds`, and `expectedContextRevision` to alter existing persistent instructions. A stale version or ineligible target fails; no implicit replacement occurs. Retraction has no text. Original entries remain in historical context versions. Turn scope binds to the first activity whose frozen request actually includes the message, and expires only when that activity finishes; an unincluded late arrival remains pending.

Input text is limited to 32768 Unicode code points per message; worker-to-parent text is limited to 8192. These are transport boundaries. The older continue prompt retains its 64 KiB UTF-8 boundary. Large evidence remains in scoped files or paged results. Event batches return complete messages without clipping; cursors can be replayed after reconnect and fail explicitly on wrong identity/history gaps.

`accepted`, `enqueued`, and `input_included` are distinct evidence. Inclusion records the exact frozen-input SHA-256, context revision and instruction/material IDs before the provider adapter. It does not prove provider receipt, comprehension, correct content, or per-message causality. An already flying request can finish with an older revision. Final completion is not proof it covered a later pending instruction.

Native message identity is persisted before enqueue. Recovery uses the original object and native log/inbox evidence; an uncertain dispatch blocks automatic replay with `deliveryUnknown`. Neither the journal nor SDK guarantees exactly-once external tool side effects. Do not automatically rerun training, Shell jobs, or other completed work merely because a summary omitted it. Reconcile artifact identity and actual receipts.

A queued followup receipt can still describe the previous terminal activity while its lease is being released. Wait for the new activity or that message's `input_included` event before accepting a final result; never count the previous completed result as the answer to newly accepted input. On Windows, reads of mutable registry/context heads may retry an ENOENT lookup for at most 35 ms; malformed data, permanent absence, leases and execution are never repaired or replayed by that observation retry.

`availability`, attempt status, cleanup, delivery coverage and parent acceptance are independent. A question becomes `needs_input` only after the activity and managed descendants settle. Until then the parent receives `question_open` while the worker remains running. Interrupted execution retains partial files, messages and accounted usage; unconfirmed cleanup or control-state failure blocks concurrent recovery. Closing a connection stops its owned runtimes, not other connections' work.

## Protocol 4 migration

Protocol 4 fences old 3.x writers. The existing schema-3 task snapshots, `tasks-v3` directories, results, SDK sessions and usage remain intact. This is why the package has a major version increment even though old task entry points are retained.

Migration is explicit and never performed by startup. Wait until all old task leases and latest cleanup records are settled; do not terminate unrelated tasks or remove their locks. Use the configured existing Node to run from the new installed/candidate package, with `DSH_BRIDGE_DATA_DIR` identifying the intended state directory:

```sh
node index.js --upgrade-store --dry-run
node index.js --upgrade-store
```

The operation uses the short registry transaction lock, revalidates under it, preserves exact old heads in `migrations/<uuid>/backup`, writes an intent, then publishes guard → registry → manifest. Foreign locks and linked state paths are refused. Partial publication fails closed with preserved evidence; there is no guessed rollback. A coherent already-v4 store is not rewritten. Both a newly connected old client and an idle old client opened before migration must fail before mutation/admission.

Do not restore a v3 head over work performed under v4: it would hide newer messages or usage. Keep v4 tasks read-only if rolling package files back until an explicit compatible recovery is established. Test the final installed package and current host connection separately; ask for a host refresh only after all updates and a live stale-version check.

## Verification limits

Offline tests use the actual pinned SDK with a local provider fixture and network blocking. They cover twelve-round retention and independent connections, native inject/steer, question/reply, interrupts, message recovery, compaction, scoped context, protocol fencing and existing budget rules. They establish mechanism behavior, not real Flash answer quality or an infinite physical context. Paid task results and live host activation need their own receipts; the parent remains responsible for semantic acceptance.

The 4.0 live collaboration campaign exercised two independent MCP connections, three root workers, multi-round parent messages and native Teams. A native Teams member encountered a provider `MALFORMED_RESPONSE` after writing its artifact; task reassignment did not reliably wake replacement members. The final artifact passed independent checks, but this is not evidence of seamless native Teams recovery or optimal efficiency. Preserve the original failure and useful artifacts, inspect member/session status before another reassignment, and report unresolved member lifecycle separately. Prefer separate persistent Bridge workers with explicit parent relays when reliable cross-turn coordination is the requirement; Teams remains an optional in-runtime capability.
