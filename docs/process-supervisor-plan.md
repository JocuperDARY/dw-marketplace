# Windows process lifecycle integration (5.6.0)

## Problem and measured baseline

Baseline: `2ac88986cebe9bda9312df19ad08721d1a4857f1` (development-workflow 5.5.2).
The original checkout has pre-existing changes and is not an implementation target.

The existing TaskResourceManager enforces ownership and verified teardown through an
injected adapter, but no production launch adapter or stdio supervisor is shipped.
SessionStart remains advisory/read-only. The update checker already demonstrates
atomic Windows Job Object binding, but only for finite captured-output commands.

The earlier host inspection in this chat found hundreds of MCP descendants under a
live Codex backend. Removing 54 reviewed inactive groups removed 220 processes,
including 54 conhost processes. Conhost subsequently increased from 173 to 193.
These snapshots establish accumulation, not that every remaining process is stale.

Pre-change core suite: Windows update-checker lifecycle cases pass; the identity
suite exposes a pre-existing CRLF-sensitive requirements-file assertion. Preserve
this failure in the verification record; normalize only the test's line endings.

## Scope and behavioral contract

1. Add an opt-in Windows stdio launcher inside dw-collaboration. Compile the small
   C# supervisor once using the installed .NET Framework compiler; launch the
   executable directly thereafter, without a resident Node/PowerShell wrapper.
2. Bind the child atomically to a private, non-inherited, kill-on-close Job Object.
   Only the three child stdio pipe handles are inherited. Never adopt existing
   processes, enumerate/kill by name, or infer inactivity from CPU/age/no output.
3. Preserve binary stdio, arguments, cwd, environment and normal child exit status.
   Bound buffering and preserve backpressure. Keep supervisor diagnostics on stderr.
   Explicit command mode forwards EOF without cancelling a finite command; default
   stdio mode treats client EOF as the session teardown signal.
4. On stdin EOF, broken transport, original parent exit, explicit timeout or child
   exit, close child stdin, allow a bounded grace period, terminate only the owned
   job if necessary, then query the job for absence. Supervisor crashes are covered
   by the kernel's last-job-handle-close behavior.
5. No automatic restart loop. A failed launch exits promptly. Default lifetime is
   unlimited: a quiet but connected service is valid. Optional lifetime deadlines
   are explicit caller policy, not a diagnosis of corruption.
6. Expose a CLI/build recipe and Codex stdio configuration example. Installing the
   plugin alone does not reroute existing MCP commands. Do not modify live user
   configuration or restart active tasks as part of repository implementation.
7. Keep the existing full manager API, its evidence semantics, hooks and unrelated
   plugins compatible. This launcher is a narrower execution backend, not a claim
   that all manager adapters or all host integrations have been implemented.

## Acceptance and resource bounds

- Tests first: stdio/argument/exit equivalence; graceful EOF; uncooperative child;
  descendants after root exit; original parent death; abrupt supervisor death;
  timeout; failed launch; quiet active sibling protection; output backpressure.
- Actual Windows tests create only isolated fixture trees. Every test has an
  outer deadline and explicit teardown. Linux/macOS are unsupported for this
  backend and report SKIP/NOT_RUN, never simulated Windows success.
- Record child absence using both native job accounting and independent fixture
  process checks; keep cleanup failure distinct from successful command exit.
- Compare direct and supervised fixture launches for process count, memory and
  latency. Report measured overhead, not a whole-machine speedup claim.
- Run current core/package checks and the relevant Windows lifecycle suite;
  register new tests in the default manifest. Perform one independent code review.

## Rollback and remaining boundary

Restore each configured server's original command/args to stop using the launcher
for future launches. Existing supervised sessions keep their immutable binary.
No global service, scheduled task, startup hook, auto-update, or system-process
cleanup is installed. A host that keeps a leaked session's pipes open and remains
alive must provide an explicit lifetime/release signal; a generic plugin cannot
safely distinguish that session from a legitimate quiet service.

## Delivery result

Implementation and Windows fixture verification are complete. The final source
and extracted archive each pass 17 supervisor tests; the wide regression run has
21 passing entries and one platform skip. See the
[verification record](process-supervisor-verification.md) for exact run timing,
baseline failures, measured overhead and the untested live-host integration boundary.
