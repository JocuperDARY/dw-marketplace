# Windows stdio process supervisor

This opt-in launcher implements actual process ownership at startup. Use it for
stdio MCP servers or foreground commands whose descendants belong to that one
session. It follows the [resource lifecycle](resource-lifecycle.md) ownership and
graceful-stop principles, without requiring the full TaskResourceManager protocol.

## Build once, launch directly

Requirements: Windows with `PROC_THREAD_ATTRIBUTE_JOB_LIST` support (Windows 10+),
installed .NET Framework 4.x compiler, and Node for the explicit build step.
No download, administrator service, scheduled task or global scanning daemon is
installed. Build into a private directory writable only by the intended user.
The source and builder are shipped in the plugin package.

From the plugin directory, run PowerShell:

```powershell
$dwBin = Join-Path $env:LOCALAPPDATA 'DW\process-supervisor'
node skills/dw-collaboration/scripts/build-process-supervisor.js --output-dir $dwBin
```

The JSON result names an immutable `dw-process-supervisor-<source-hash>.exe`.
Use that exact executable path in the host configuration. The compiler runs only
during this step; each managed session subsequently has one small native-hosted
.NET process, with no resident Node/PowerShell wrapper and no extra console for
the supervisor. A source change produces a new filename, leaving running sessions
alone. Reusing a build verifies its manifest and binary hash. A damaged/partial
build or an interrupted build lock fails closed; build into a new private directory
after confirming the old build is no longer being written. Do not auto-delete locks.

The launcher syntax is:

```text
dw-process-supervisor-<hash>.exe [--mode stdio|command] [--grace-ms 1500] [--timeout-ms 0] [--receipt ABSOLUTE-UNIQUE-FILE] -- ABSOLUTE-EXECUTABLE [ARG ...]
```

- The executable must be an existing absolute path. Resolve `node`, `npx.cmd`,
  `python` or `cmd` to the intended installation before changing the configuration.
- `--grace-ms` accepts 0..30000. It is the time allowed after a shutdown trigger.
- `--mode stdio` is the default for MCP: closing stdin ends the session. For a
  finite command (build, script, diagnostic), use `--mode command`. That mode still
  forwards EOF, but lets the command finish after consuming input. Parent death,
  output failure and explicit deadlines still terminate its owned tree. In command
  mode an empty/closed input stream alone does not indicate abandonment.
- `--timeout-ms` accepts 0..2147483647. Zero means no lifetime deadline. Set a
  positive value only when the caller explicitly intends to bound the whole session.
- `--receipt` is optional and must name a new, unique local file with an existing
  parent directory. It is reserved before launch and written at exit. An existing
  file prevents launch; its contents are never overwritten. Do not put a fixed
  receipt path in a reusable MCP entry. Without it, diagnostics go to stderr.
- Native executable arguments retain the ordinary Windows argv quoting behavior.
  `.cmd`/`.bat` shims use the same restricted CALL form as the update checker;
  shell expansion/control characters in shim operands are rejected. Use the actual
  Node executable plus the server's JS entry point for complex literal operands.
  Host-specific verbatim shell strings are outside this argv contract.

## Connect an existing stdio MCP entry

Save the original command/args first. In a Codex TOML entry, replace only those two
fields; retain its existing environment, cwd, startup timeout and tool settings:

```toml
[mcp_servers.example]
command = 'C:\Users\your-user\AppData\Local\DW\process-supervisor\dw-process-supervisor-<hash>.exe'
args = ['--', 'C:\Program Files\nodejs\node.exe', 'C:\tools\example-server\index.js']
```

The original command becomes the first operand after `--`; the original args
follow in their original order. JSON stdio configurations use the same command/args
mapping. Apply this to each chosen server, then restart only that server/session
when its work has finished. First validate one inexpensive local server: initialize,
list tools, make a normal request, disconnect, and confirm no owned descendants
remain. Repository fixture tests do not prove that a particular host/plugin entry
has been loaded. Installing development-workflow alone does not rewrite settings.

Rollback restores the saved command/args for future launches. Existing supervised
sessions continue using their binary until they exit. The launcher never adopts
old processes; it cannot safely infer ownership from PID/name/age/CPU alone.

## Real-time behavior and limits

The child is atomically placed in a private, unnamed, non-inherited kill-on-close
Job Object before it runs. Only its three stdio pipe handles are inherited; the
parent-watch handle and job handle are excluded. Ordinary descendants inherit job
membership, including detached child processes that do not use an external broker.
The supervisor sleeps on the original parent handle, child handle and transport
event. It does not periodically enumerate Windows processes.

| Event | Action |
| --- | --- |
| Client closes stdin in stdio mode | Forward EOF, allow grace, terminate remaining owned job members, verify empty job |
| Input ends in command mode | Forward EOF and let the command finish; continue observing parent/process/deadline |
| Original parent exits | Cancel the input relay, close child stdin, then perform the same bounded teardown |
| Child exits or fails at startup | Preserve its observed exit status; reclaim descendants after grace; no restart loop |
| Explicit lifetime expires | Graceful window, owned-job termination if needed, verified cleanup; return 124 |
| Transport write/read fails | Bounded teardown; return 74 when transport loss caused shutdown |
| Supervisor is killed/crashes | Windows closes its last job handle and terminates job members; no final receipt is promised |
| Quiet connected service | Keep running; silence or low CPU is not a failure signal |

Stdout carries only the child's bytes. Stderr carries child stderr and at most one
`DW_PROCESS_SUPERVISOR {json}` diagnostic. Relays use fixed 16 KiB buffers and
preserve backpressure. Teardown allows up to 3 seconds for empty-job verification,
up to 1 second per output relay to drain and 100 ms for diagnostics, beyond grace.
`verified_absent` requires zero active job members and a signaled retained root
process handle; root exit-code retrieval must also succeed. It does not claim
independent observation of every descendant handle. Job cleanup and output delivery
are separate: `outputComplete: false` means output
was incomplete even if `cleanup: verified_absent`. Cleanup failure returns 125;
invalid launch arguments return 64. Child exit codes are preserved for ordinary
completion, so read `reason`/`cleanup` rather than interpreting an exit code alone.
No argument values, environment values or raw exception messages are added to
supervisor diagnostics. The child remains responsible for its own logging.

This is process hygiene, not a security sandbox. Processes created by an external
service/broker are outside this job; applications needing persistent shared helpers
must not wrap those helpers in a session-owned scope. System svchost and unrelated
console windows are never cleanup candidates. A conhost created outside the job
is not explicitly killed; a console associated with a terminated owned process
normally ends with that console's clients.

A host that retains both a live parent and open session pipes after abandoning a
task has not provided a reliable shutdown signal. That case needs a host release
hook or an explicit lifetime policy. This launcher does not invent a universal
hang detector, kill active requests after idle time, or retrofit old orphan trees.
The full manager's adapter, recovery-store and scheduler contracts remain separate.

## Verification

Run `npm run test:process` in the plugin directory. It compiles into a unique
temporary directory and exercises actual owned Windows fixture trees with outer
deadlines. It checks graceful and forced EOF, parent death, supervisor death,
descendants after root exit, deadlines, blocked/broken output, argument/binary I/O
equivalence, failure paths and protection of a quiet sibling. It also prints five
paired direct/supervised launch samples and supervisor working set. These numbers
describe local overhead; they are not a total host-memory savings estimate.
The test is also registered in core/all. Other operating systems explicitly skip
this backend; they do not receive simulated Windows lifecycle evidence.

Native contract references: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[synchronous I/O cancellation](https://learn.microsoft.com/en-us/windows/win32/fileio/synchronous-and-asynchronous-i-o).
