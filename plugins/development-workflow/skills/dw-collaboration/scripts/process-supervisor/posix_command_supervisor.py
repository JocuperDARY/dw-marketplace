"""Opt-in POSIX process-group owner. Not a descendant containment sandbox.

The controller retains both direct children. The guardian pins its process group
until its one self-group SIGKILL. No external process ever sends a PGID signal.
"""

import base64
import json
import os
import select
import signal
import sys
import time


def stop_reason(now, deadline, node_open=True, owner_open=True, command=None):
    if not node_open or not owner_open:
        return "control_eof"
    if command in ("child_exit", "output_limit", "guardian_error"):
        return command
    return "timeout_elapsed" if now >= deadline else None


def absence_verified(root_reaped, guardian_reaped, group_absent, kill_requested):
    return root_reaped and guardian_reaped and group_absent and kill_requested


def close_except(kept):
    # Enumerate the process's open descriptor range, without depending on /proc.
    import resource

    limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    if limit == resource.RLIM_INFINITY:
        limit = os.sysconf("SC_OPEN_MAX")
    boundaries = sorted(fd for fd in kept if fd >= 3)
    start = 3
    for fd in boundaries:
        os.closerange(start, fd)
        start = fd + 1
    os.closerange(start, int(limit))


def guardian(control, events, joined, go, deadline):
    close_except({control, events, joined, go, 3})
    os.set_blocking(control, False)
    os.set_blocking(events, False)
    os.set_blocking(3, False)
    os.set_blocking(joined, False)
    os.set_blocking(go, False)
    os.setpgid(0, 0)
    # Terminal/session signals must not remove the identity anchor prematurely.
    for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"):
        signal.signal(getattr(signal, name), signal.SIG_IGN)
    os.write(events, b"ready\n")
    command = None
    pending = b""
    join_buffer = b""
    wait_for_join = True
    while True:
        watched = [3, control] + ([joined] if wait_for_join else [])
        readable, _, _ = select.select(
            watched, [], [], max(0, min(0.05, deadline - time.monotonic()))
        )
        node_open = owner_open = True
        if 3 in readable:
            node_open = bool(os.read(3, 1024))
        if control in readable:
            data = os.read(control, 1024)
            owner_open = bool(data)
            pending += data
            if b"\n" in pending:
                command = pending.split(b"\n", 1)[0].decode("ascii")
        if wait_for_join and joined in readable:
            data = os.read(joined, 6)
            join_buffer += data
            if (
                not data
                or len(join_buffer) > 5
                or not b"JOIN\n".startswith(join_buffer)
            ):
                command = "guardian_error"
        reason = stop_reason(time.monotonic(), deadline, node_open, owner_open, command)
        # Only this live owner holds GO's write end. Check cancellation and the
        # independent deadline before admitting the already-joined target.
        if reason is None and wait_for_join and join_buffer == b"JOIN\n":
            try:
                if os.write(go, b"GO\n") != 3:
                    raise RuntimeError("incomplete GO")
                os.close(go)
                os.close(joined)
                wait_for_join = False
            except (OSError, RuntimeError):
                reason = "guardian_error"
        if reason:
            # A small nonblocking record precedes the irreversible self-kill.
            # If it cannot be recorded, the controller must report UNKNOWN.
            try:
                os.write(events, ("kill:" + reason + "\n").encode("ascii"))
            finally:
                # This process is still the live group leader here: no stale ID.
                os.killpg(os.getpgrp(), signal.SIGKILL)
            os._exit(125)


def reap(pid):
    result, status = os.waitpid(pid, os.WNOHANG)
    return status if result == pid else None


def probe_absent(pgid):
    try:
        os.killpg(pgid, 0)  # Observation only, never a post-reap kill.
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


def exec_target(request, guardian_pid, out_w, err_w, joined, go, deadline):
    # No controller lifetime or terminal writer may survive into the target.
    # Only the guardian has a GO writer; its death closes this pipe even when
    # setpgid can still join the group of its unreaped zombie.
    close_except({out_w, err_w, joined, go})
    os.setpgid(0, guardian_pid)
    if os.write(joined, b"JOIN\n") != 5:
        raise RuntimeError("incomplete JOIN")
    os.close(joined)
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not select.select([go], [], [], remaining)[0]:
        raise RuntimeError("GO deadline expired")
    if os.read(go, 4) != b"GO\n":
        raise RuntimeError("missing or invalid guardian GO")
    os.close(go)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    close_except(set())
    # Match subprocess restore_signals=True: Python ignores these at startup,
    # while a normally exec'd target should receive their default dispositions.
    for name in ("SIGPIPE", "SIGXFZ", "SIGXFSZ"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_DFL)
    os.chdir(request["cwd"])
    os.execv(request["executable"], [request["executable"], *request["args"]])


def write_result(value, limit_seconds=1.0):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    os.set_blocking(1, False)
    end = time.monotonic() + limit_seconds
    offset = 0
    while offset < len(data):
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("result transport blocked")
        _, ready, _ = select.select([], [1], [], remaining)
        if ready:
            try:
                offset += os.write(1, data[offset : offset + 65536])
            except BlockingIOError:
                pass


def controller(request):
    if os.name != "posix" or not all(
        hasattr(os, name)
        for name in ("fork", "setpgid", "killpg", "waitpid", "set_blocking")
    ):
        raise RuntimeError("POSIX Python process primitives unavailable")
    # fd 3 is a separate parent-owned lifetime channel, not target stdin.
    os.fstat(3)
    deadline = time.monotonic() + request["timeoutMs"] / 1000
    final_deadline = deadline + request["cleanupMs"] / 1000
    control_r, control_w = os.pipe()
    events_r, events_w = os.pipe()
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    joined_r, joined_w = os.pipe()
    go_r, go_w = os.pipe()
    guardian_pid = os.fork()
    if guardian_pid == 0:
        try:
            guardian(control_r, events_w, joined_r, go_w, deadline)
        except BaseException:
            os._exit(125)
    os.close(control_r)
    os.close(events_w)
    # Close before the second fork: neither controller nor target may hold GO's
    # writer or JOIN's reader and hide a guardian death from the waiting target.
    os.close(joined_r)
    os.close(go_w)
    os.set_blocking(events_r, False)
    os.set_blocking(control_w, False)
    event_buffer = b""
    ready = False
    guardian_status = None
    while time.monotonic() < deadline and not ready:
        if select.select(
            [events_r], [], [], min(0.05, max(0, deadline - time.monotonic()))
        )[0]:
            data = os.read(events_r, 4096)
            event_buffer += data
            ready = b"ready\n" in event_buffer
            if not data:
                break
    # Do not reap the guardian until the target is known to have exited. Its
    # retained PID must not be recycled during the fork / join / GO interval.
    if not ready:
        os.close(control_w)
        raise RuntimeError("guardian did not bind its process group")
    try:
        root_pid = os.fork()
    except BaseException:
        # Closing the sole controller writer independently cancels the owner;
        # closing JOIN tells it no target can arrive. No user exec occurred.
        for fd in (control_w, joined_w, go_r, out_w, err_w):
            os.close(fd)
        raise
    if root_pid == 0:
        try:
            exec_target(request, guardian_pid, out_w, err_w, joined_w, go_r, deadline)
        except BaseException:
            os._exit(127)
    os.close(out_w)
    os.close(err_w)
    os.close(joined_w)
    os.close(go_r)
    for fd in (out_r, err_r, 3):
        os.set_blocking(fd, False)
    streams = {out_r: bytearray(), err_r: bytearray()}
    active = {out_r, err_r, events_r, 3}
    root_status = None
    reason = None
    kill_requested = False
    output_limited = False
    group_absent = False
    stop_sent = False
    retained = 0

    def request_stop(why):
        nonlocal stop_sent, reason, final_deadline
        if stop_sent:
            return
        stop_sent = True
        reason = why
        final_deadline = min(
            final_deadline, time.monotonic() + request["cleanupMs"] / 1000
        )
        try:
            os.write(control_w, (why + "\n").encode("ascii"))
        except (BlockingIOError, BrokenPipeError):
            pass  # The independent guardian deadline still applies.

    while time.monotonic() < final_deadline:
        if root_status is None:
            root_status = reap(root_pid)
            if root_status is not None:
                request_stop("child_exit")
        if guardian_status is None and root_status is not None:
            guardian_status = reap(guardian_pid)
        if guardian_status is not None:
            # Read-only observation can conservatively see a reused group ID;
            # it can never kill that unrelated new group.
            group_absent = probe_absent(guardian_pid)
        if (
            guardian_status is not None
            and root_status is not None
            and group_absent
            and events_r not in active
            and not (set(streams) & active)
        ):
            break
        if time.monotonic() >= deadline:
            request_stop("timeout_elapsed")
        readable, _, _ = select.select(
            list(active), [], [], min(0.05, max(0, final_deadline - time.monotonic()))
        )
        for fd in readable:
            data = os.read(fd, 65536 if fd in streams else 4096)
            if not data:
                active.discard(fd)
                if fd == 3:
                    request_stop("control_eof")
                continue
            if fd in streams:
                remaining = request["maxOutputBytes"] - retained
                streams[fd].extend(data[:remaining])
                retained += min(len(data), remaining)
                if len(data) > remaining:
                    output_limited = True
                    request_stop("output_limit")
            elif fd == events_r:
                event_buffer += data
                if len(event_buffer) > 4096:
                    request_stop("guardian_error")
                for line in event_buffer.split(b"\n"):
                    if line.startswith(b"kill:"):
                        kill_requested = True
                        reason = line[5:].decode("ascii")
    if not stop_sent:
        request_stop("guardian_error")
    os.close(control_w) if control_w >= 0 else None
    status = (
        os.WEXITSTATUS(root_status)
        if root_status is not None and os.WIFEXITED(root_status)
        else None
    )
    sig = (
        os.WTERMSIG(root_status)
        if root_status is not None and os.WIFSIGNALED(root_status)
        else None
    )
    verified = absence_verified(
        root_status is not None,
        guardian_status is not None,
        group_absent,
        kill_requested,
    )
    return {
        "v": 1,
        "session": request["session"],
        "containment": "posix-process-group",
        "escapedDescendants": "unverified",
        "status": status,
        "signal": sig,
        "reason": reason or "guardian_error",
        "cleanup": "verified_absent" if verified else "unknown",
        "rootExited": root_status is not None,
        "guardianReaped": guardian_status is not None,
        "groupAbsent": group_absent,
        "killRequested": kill_requested,
        "pgid": guardian_pid,
        "outputComplete": not output_limited and not (set(streams) & active),
        "stdout": base64.b64encode(streams[out_r]).decode("ascii"),
        "stderr": base64.b64encode(streams[err_r]).decode("ascii"),
    }


def main():
    # The JS adapter bounds this frame too. No target exists before validation.
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("request too large")
    request = json.loads(raw)
    if request.get("v") != 1 or not isinstance(request.get("session"), str):
        raise ValueError("invalid protocol")
    for field in ("timeoutMs", "cleanupMs", "maxOutputBytes"):
        if type(request.get(field)) is not int or request[field] <= 0:
            raise ValueError("invalid limit")
    if (
        not 100 <= request["cleanupMs"] <= 30000
        or request["timeoutMs"] > 2147000000
        or request["maxOutputBytes"] > 64 * 1024 * 1024
    ):
        raise ValueError("limit out of range")
    for field in ("executable", "cwd"):
        if (
            not isinstance(request.get(field), str)
            or not os.path.isabs(request[field])
            or "\0" in request[field]
        ):
            raise ValueError("invalid path")
    if (
        not isinstance(request.get("args"), list)
        or len(request["args"]) > 4096
        or not all(isinstance(arg, str) and "\0" not in arg for arg in request["args"])
    ):
        raise ValueError("invalid arguments")
    write_result(controller(request))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Missing/partial terminal remains UNKNOWN in the adapter.
        os._exit(125)
