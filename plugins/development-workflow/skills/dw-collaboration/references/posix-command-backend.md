# Explicit POSIX process-group command backend

This optional backend requires an explicitly configured absolute Python 3
interpreter path. It uses Python's standard library only, invoked with `-I -S`;
the requested target receives the supplied environment. No interpreter discovery,
package installation, native compilation, or automatic fallback is performed.

Call `preparePosixCommandBackend({pythonPath})`, then await
`runPosixCommand({...prepared, executable, args, cwd, env, timeoutMs,
maxOutputBytes, cleanupMs:3000})`. Paths must be absolute POSIX paths. The caller
must explicitly opt into this weaker containment boundary. The default remains
HOLD on non-Windows systems. Target stdin is `/dev/null` for these finite
inventory/test commands. The backend does not provide an interactive session.

## Ownership and cleanup

The independent Python controller forks a guardian which becomes a new process
group leader in the controller's existing session. After the guardian's readiness
record, the controller forks the target. The target closes unrelated private
descriptors, joins that group, writes JOIN on its private handshake pipe and waits
for the guardian's GO before exec. Only the guardian holds GO's write endpoint;
the controller closes its copy before forking the target. The guardian checks
its deadline and both control channels before granting GO. EOF, invalid GO or
handshake expiry exits before user code. If the guardian dies before granting GO,
joining its group cannot start user code. Guardian failure after GO remains
subject to the independent guardian-failure limitation described below.
The target closes its remaining handshake descriptors before exec and restores
Python's normally ignored SIGPIPE/SIGXFZ/SIGXFSZ dispositions where available.
Both guardian and target remain direct controller children, permitting actual
`waitpid` evidence for each. The controller does not reap the guardian until the
target has been reaped, so its PID cannot be recycled across fork, join or GO.
A failed second fork closes the control and handshake endpoints without starting
user code. A failed group join exits before target execution.

The guardian stays alive to reserve its own group identity. It monitors its own
monotonic deadline, the Node caller's private fd 3 lifetime channel, and the
controller's private command pipe. EOF on either control channel, deadline, output
overflow, or normal root completion triggers one `killpg(getpgrp(), SIGKILL)`
from the living group leader. This includes the guardian itself. There is no
external destructive operation using a remembered PID or PGID after this point.

The controller drains bounded output independently from the guardian. It reaps
its two children and probes group absence with signal 0 only. `ESRCH`, both
children reaped, and the guardian's pre-kill record are all required for
`cleanup: verified_absent`. The pre-kill record is an intent record, not proof
that signal delivery completed; absence supplies the latter evidence. A recycled
group number can make the read-only observation conservatively remain unknown,
but is never killed. Permission errors and observation expiry remain unknown.

Execution and cleanup have independent finite deadlines. Output transport is
nonblocking and expires too; failed/partial terminal output remains unknown at
the Node boundary. A Node event-loop stall does not stop the guardian deadline.
No operating system scheduling or uninterruptible kernel-state deadline is
promised. Lost control channels normally trigger cleanup, while a stopped/crashed
guardian, inherited channel leak, permission change, or unobservable state can
leave cleanup unknown. The adapter does not convert expiry into successful
cleanup and never reports a Promise timeout as proof of termination.

## Deliberately narrower than Windows Job ownership

The result always reports `containment: posix-process-group` and
`escapedDescendants: unverified`. A target/descendant that calls `setsid` or
`setpgid`, delegates work to a broker, changes credentials so signals are denied,
or otherwise leaves the group is outside this boundary. The backend is intended
for cooperative finite commands, not hostile same-user code. A root which escapes
and stays alive cannot satisfy the direct-root reap condition. An escaped grandchild
can survive even when the original group is verified absent. Callers must retain
the scope labels rather than advertise full descendant-tree cleanup.

On platforms requiring stronger containment, a separately authorized native
backend (for example Linux cgroup/namespace ownership) is needed. Generic POSIX
process groups cannot provide Windows Job-equivalent ownership or kernel cleanup
on arbitrary guardian death.

## Evidence and remaining verification

The normal core/process suites register `test/posix-command-backend.test.js` for
the JavaScript protocol mocks. With a chosen local Python interpreter, run
`python -I -S test/posix-supervisor-contract.py` from the plugin root for the
separate Python mock contract checks. That command does not fork or signal real
POSIX processes and does not make Python a prerequisite for ordinary Windows
tests. Preserve its result separately from native-platform evidence.

Windows checks cover request validation, strict terminal parsing, scope/evidence
requirements, bounded adapter transport, and simulated Python guardian decisions.
The Python mocks also cover guardian death around JOIN, missing/invalid GO,
handshake expiry, a failed second fork, sole guardian GO ownership and normal
admission. These are state/descriptor contract checks, not real OS race tests.
They do not execute POSIX process lifecycle primitives. Native Linux and macOS
launch, fork/exec races, process-group persistence/reuse, TERM/KILL behavior,
orphan reaping, descriptor inheritance, stdout backpressure, and caller death
remain **NOT_RUN** until explicitly authorized on those hosts. Real Claude/Codex
installation, Grok integration and provider calls are also **NOT_RUN**.

Technical references:

- [Python OS process APIs](https://docs.python.org/3/library/os.html): fork,
  setpgid, killpg, waitpid, nonblocking descriptors and descriptor inheritance.
- [Python select](https://docs.python.org/3/library/select.html): Unix pipe polling
  and finite timeout behavior; Windows pipes do not exercise the same primitives.
- [Linux kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html): process-group
  signals, signal-zero existence checks, permissions and ESRCH.
- [Linux setpgid(2)](https://man7.org/linux/man-pages/man2/setpgid.2.html): group/session
  boundaries and exec-time join restrictions. These Linux references are not
  evidence of native macOS behavior.
