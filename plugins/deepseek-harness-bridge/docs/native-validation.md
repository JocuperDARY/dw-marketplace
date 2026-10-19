# Native execution and checkpoint validation

Native capability registration, execution, model output quality and parent acceptance are separate results. The offline suite runs the pinned official SDK with scripted local model streams and blocks network connections. Its Shell commands and in-process Team children actually execute; the model stream is synthetic. These tests do not establish Flash quality, throughput, account cost, or behavior on an untested operating system.

## Shared stage accounting

In a native budgeted stage, the captain and its in-process descendants share the original request, output and tool allowances. Preparing a request reserves its allowance until admission or cancellation. Admission transfers that reservation to charged accounting before another stream can dispatch; abort, rejected pre-step, idle and disposal release unused preparation reservations.

The captain owns the final checkpoint request. When a child reaches the checkpoint boundary, the runtime stops admitting descendants and drains the captain's owned descendants. A child never waits for its own disposal. The captain waits for that drain before emitting a tool-free checkpoint with reasoning disabled. Already prepared work retains its original request mode; another session cannot silently turn it into a checkpoint.

Ownership comes from the SDK's exact runtime owner references, including descendants published while drain is pending. Durable parent-session labels alone are insufficient. The checkpoint includes bounded child terminal evidence; drained means execution handles were released, not that the child's assignment succeeded. At most 16 child records and 16 late settlement notices are included, with each text field limited to 512 characters and explicit omission/truncation indicators. Original SDK session and Team state records remain the underlying evidence.

The SDK claims its inbox before prompt assembly. Native child settlement notices that arrive during the later drain are therefore saved into the budget receipt before their matching inbox entries are removed. Only native settlement notices from the captured owned descendants are folded this way. Original message IDs are retained in the evidence; removed notices are not re-admitted under those IDs. Unrelated messages, unknown senders and user steering remain in the inbox, and can legitimately prevent a final checkpoint from completing within the remaining allowance.

Automatic mode continues using the native runtime without stage checkpoint orchestration. Single-request mode remains inference-only and never retries. A new durable stage restores the saved assignment/checkpoint in a fresh SDK session; it does not extend the original task budget or deadline.

## Receipt publication

Worker budget and capability receipts are complete-file atomic replacements. On Windows, an overlapping reader can briefly prevent replacement. The writer retries only `EPERM` and `EBUSY`, with finite backoff within a 500 ms retry window; other errors fail immediately. A unique, exclusively created temporary file belongs to that publication attempt. The helper never deletes the destination or changes an ownership lock. A persistent publication or owned-temporary cleanup failure remains an error, not a successful receipt.

## Offline test scope

| Test family | Observable acceptance |
| --- | --- |
| Native files | Actual read, guarded literal replacement, exact resulting file and original backup, stale whole-file hash rejection |
| Skills and Shell | Matching synthetic skill search/load, loaded body, real bounded PowerShell command, task cwd, credential-variable absence, output artifact |
| Jobs and resume | Finished job output, explicit long-job cancellation and exit, empty job list, saved SDK session resume with task cwd and relative file access |
| Teams | Real in-process child assignment/read/report/archive; parent and child share request/output/tool accounting; explicit cancellation verifies aborted signals, owned process exit and stopped child heartbeat |
| Checkpoints | Captain reservation, active-child drain, preserved terminal/late-notice evidence, actual shared soft deadline, and native files without a subagent service |
| Coordination units | Concurrent preparations, output reservation, aborted/rejected unused preparations, exact descendant ownership, unrelated inbox preservation and late child publication |
| Publication | Transient Windows sharing errors, finite persistent failure, immediate unrelated errors, old-receipt preservation and owned temporary cleanup |

Test deadlines allow the SDK's existing initialization interval while keeping each fixture finite. The work, tool and output budgets in the truncation/recovery tests remain explicit. A checkpoint reached before any work must say that no read has occurred; a fixture can claim file work only after a matching successful tool result.

The full default test command also isolates configuration discovery from the operator's live Bridge configuration. Explicit fixture profiles still exercise the profile contract. Fresh package installation is checked separately from a reused dependency tree. Genuine provider tasks, semantic parent acceptance, user-approved total spending and final installed-host version require their own evidence.
