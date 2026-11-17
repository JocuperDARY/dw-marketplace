# Windows command resource adapter

Use this backend for a finite command whose ordinary descendants belong to that command. It provides a real Windows process boundary; it does not install or configure a Claude/Codex host. Commands that create processes through external services or brokers need a different ownership contract.

## Choose the entry point

| Need | Entry point | Responsibility |
| --- | --- | --- |
| Ordinary bounded command | `scripts/lib/windows-command-backend.js` | Launch, deadline, output limit, owned Job cleanup and terminal evidence |
| Persisted task resource records | `scripts/lib/windows-command-adapter.js` | Map native observations to TaskResourceManager identity, stop and release contracts |
| Plugin test suite | `test/test-runner.js` from the plugin root | Run each test through the command backend, preserve test counts, stop further dispatch after an execution-boundary failure |
| Long-lived stdio MCP server | [Process supervisor](process-supervisor.md), `--mode stdio` | Preserve the server byte stream and its connection lifetime |

The ordinary command and test paths do not require the persistent manager. These entry points own only new launches routed through them. Merely importing a module, registering a source file, or selecting a Skill does not supervise a process.

## Prepare the native backend

Windows 10+ Job-list process creation, the installed .NET Framework compiler and Node are required. Build into a private directory with `build-process-supervisor.js --output-dir <absolute-directory>`, then pass the returned executable path to the backend. Building is an explicit operation; module import and session hooks do not compile, install or update the host.

Both C# source files contribute to the immutable executable name. The existing source/binary manifest checks protect reuse of that executable. Ordinary launches do not hash the project tree. Keep the prepared directory under the launching user's control; this is a process-lifecycle boundary, not isolation from hostile code running with the same user privileges.

The backend exports `startWindowsCommand(options)` and `runWindowsCommand(options)`. Options include `supervisorPath`, absolute `executable`, literal `args`, absolute `cwd`, `env`, positive `timeoutMs`, and bounded `graceMs`, `maxOutputBytes` and `retentionMs`. Use the real Node executable plus script arguments rather than a shell command string. The native control mode is private to this backend and must not be used as an MCP byte stream.

`startWindowsCommand` returns a session with native identity, `observe()`, `gracefulStop()`, `terminate()`, `closeInput()`, `wait()` and `release()`. Closing child input and losing the controller are distinct events. Graceful stop acknowledges closing stdin; it does not claim application-level shutdown acknowledgement. Always release the session, including after an unsuccessful command.

## What constrains the process

The supervisor creates a private kill-on-close Job and atomically assigns the suspended root before it runs. Its retained process handle supplies the root PID, creation time and executable identity. The handle token sent to Node is an opaque reference to that retained native handle, not a numeric handle that Node may operate on.

The controller uses private NDJSON pipes with a per-session nonce, launch binding, monotonic command IDs and exact process-handle token. Child output travels as separate bounded payloads. It cannot impersonate control records by printing JSON. Only the child's three standard handles are inherited; it does not receive the control or Job handles.

The native lifetime boundary continues when Node stops reading, loses its connection or exits. A positive deadline and a combined stdout/stderr output cap constrain each command. Natural root exit also triggers cleanup of residual Job members. After terminal cleanup, retained handles remain available for observation until release or the finite retention deadline.

| Observation | Meaning |
| --- | --- |
| Nonzero child exit with verified cleanup | The command failed; its owned process resources were reclaimed |
| Graceful/terminate response | That specific action was observed, not proof that all processes exited |
| `cleanup: verified_absent` | Native observation found the retained root exited and the Job had zero active processes |
| `outputComplete: false` | Output was incomplete, even if process cleanup succeeded |
| Missing/malformed terminal record or broken supervisor | Cleanup evidence is `unknown`; a kill-on-close fallback is not a fabricated terminal observation |

## Persistent manager adapter

The asynchronous `createWindowsCommandHost` combines explicit run/owner/session/generation identity, a prepared supervisor, authorization and finite resource bounds with TaskResourceManager. Supply both `supervisorPath` and the complete `preparedBackend` result from `buildSupervisor`. The factory checks the build record and performs one bounded inert native capability probe before opening the manager. Business commands are not used as probes. The first adapter supports V1 commands with `temporaryRoot: null`; it does not implement temporary-root operations, M2 application shutdown contracts, messaging or reconnecting to old processes. Unsupported requests fail before a business command launch.

Because the native deadline and connection-loss paths can terminate the private Job, host construction requires explicit hard-deadline authorization and permission for forced termination of these owned commands. Reuse the user's existing authorization when it covers that behavior; do not insert an extra approval at each command.

The adapter authenticates its capability and native response records, then checks derived tracker observations against the same run, resource, generation, identity and observed state. A known evidence reference alone cannot authorize an altered absence claim. Unknown trust purposes stay rejected. These bindings are specific protocol checks, not a general requirement to hash every document or repeat verification.

Each host admits at most its configured `maxCommands` (1..256) and 4,096 adapter action requests, including repeated reads. These bounds limit retained protocol evidence; exhausting a bound rejects further admission and preserves HOLD instead of silently widening it. Choose observation intervals that fit the task's finite duration and keep capacity for closing resources. Command deadlines remain enforced by the native backend.

Use the host's start/observe/stop/wait/close operations and inspect their returned states. Release native sessions after manager closure. `dispose()` is bounded cleanup for abandoned or unsuccessful work; it must retain a manager HOLD rather than manufacture a successful release.

From the plugin root, this example accepts the caller's existing authorization and private directories. `cleanupAuthorityRef` in that authorization identifies the caller's authority record; constructing an arbitrary reference does not grant permission.

```js
const { randomUUID } = require('node:crypto');
const { buildSupervisor } = require('./skills/dw-collaboration/scripts/build-process-supervisor');
const { createWindowsCommandHost } = require('./skills/dw-collaboration/scripts/lib/windows-command-adapter');

async function runManaged({ binaryDirectory, dataRoot, cwd, executable, args,
  authorization, hardDeadlineAuthorized }) {
  const prepared = buildSupervisor(binaryDirectory);
  const runId = randomUUID();
  const host = await createWindowsCommandHost({
    runId, harnessId: 'command-host', producerId: 'native-command-observer',
    ownerId: 'command-owner', sessionId: runId, managerRunId: runId,
    managerGeneration: 1, adapterId: 'windows-command', adapterGeneration: 1,
    authorization, // TaskResourceAuthorization1, cleanupAuthorityRef, allowForceTermination:true
    hardDeadlineAuthorized, // true only when the supplied authority covers bounded forced cleanup
    supervisorPath: prepared.executable, preparedBackend: prepared, dataRoot,
    bounds: { maxTimeoutMs: 60000, graceMs: 250, maxOutputBytes: 1048576,
      retentionMs: 30000, maxCommands: 1 },
  });
  let closed = false;
  try {
    const start = await host.startCommand({ commandId: 'work', executable, args,
      cwd, timeoutMs: 60000, temporaryRoot: null });
    if (start.status !== 'STARTED') throw new Error(JSON.stringify(start));
    const result = await host.wait('work');
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const end = await host.close();
      if (end.status === 'CLOSED') { closed = true; return result; }
      if (end.status !== 'CLOSING') throw new Error(JSON.stringify(end));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Manager close did not finish within the example budget');
  } finally {
    if (!closed) {
      const cleanup = await host.dispose();
      console.error('Managed command remains HOLD:', JSON.stringify(cleanup));
    }
  }
}
```

The returned command result still needs its own exit-code, `error`, output and cleanup checks. A host `CLOSED` result means manager and native session closure succeeded; it does not convert a nonzero or timed-out command into success. Keep `dataRoot` unique to the run and preserve a HOLD record for later reconciliation.

A launch failure has three possible native facts: never created, created and reclaimed, or unknown. The current manager keeps an incomplete start on HOLD when no valid spawn identity was bound. That conservative result is not a resource leak claim, and must not be changed into a fake successful start to make `close()` pass.

## Queue and recovery boundary

ResourceAwareQueue still returns scheduling decisions; it does not launch this host automatically. After a selected task fails to start, its owner must put the task into `beginDrain(taskId, 'failed')`. A task continues consuming capacity until its exact tracker close result is accepted. Do not treat the manager's public `CLOSED` summary as a queue close token or refund capacity merely because spawn threw. If a batch stops before other selected tasks launch, account for every selected task and its preclaimed resources.

Automatic queue-to-manager dispatch, proven no-start capacity release, persistent reattachment, temporary-storage management and non-Windows process adapters remain separate extensions. Recovery records help reconcile state; they do not revive an old native handle or grant new cleanup authority.

## Test and platform evidence

On Windows, run `npm run test:process` for the shared supervisor/backend/adapter tests and `npm run test:core` for the core suite. The runner prepares one private native build per invocation and each test runs in its own Job. `test:all`, `test:hooks` and `test:package` use the same runner. Tests launched directly with `node test/file.test.js` are outside that outer boundary unless the test itself creates a managed fixture.

On other platforms, portable logic tests can be requested explicitly with `npm run test:core -- --portable-direct`. That path declares descendant cleanup unverified and does not claim Windows or native Linux lifecycle acceptance. Missing Windows backend capability fails before launching the selected tests; it does not silently fall back to bare subprocess execution.

Local Windows fixtures cover only the exercised command path. Actual Claude/Codex installation, user configuration, MCP activation, model/provider calls and native Linux/Grok validation remain deferred according to the current task's authorization.
