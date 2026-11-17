"""Pure mocked contracts. This file never forks or sends real process signals."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "skills/dw-collaboration/scripts/process-supervisor/posix_command_supervisor.py"
)
spec = importlib.util.spec_from_file_location("posix_owner", SOURCE)
assert spec is not None and spec.loader is not None
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class Contracts(unittest.TestCase):
    def test_guardian_death_before_and_after_join_blocks_exec(self):
        for death_stage in ("before_join", "after_join"):
            with self.subTest(death_stage=death_stage):
                alive = death_stage != "before_join"

                def send_join(fd, data):
                    nonlocal alive
                    self.assertEqual((fd, data), (6, b"JOIN\n"))
                    # In the before_join case this deliberately models a write
                    # racing guardian death. Even if JOIN appeared successful,
                    # there is no guardian left to issue GO.
                    alive = False
                    return len(data)

                fake_os = SimpleNamespace(
                    setpgid=Mock(),
                    write=send_join,
                    close=Mock(),
                    read=lambda *args: b"GO\n" if alive else b"",
                    execv=Mock(),
                )
                with (
                    patch.object(owner, "os", fake_os),
                    patch.object(owner, "close_except"),
                    patch.object(owner.time, "monotonic", return_value=0),
                    patch.object(owner.select, "select", return_value=([7], [], [])),
                ):
                    with self.assertRaisesRegex(RuntimeError, "GO"):
                        owner.exec_target({}, 123, 4, 5, 6, 7, 10)
                fake_os.execv.assert_not_called()

    def test_guardian_not_reaped_while_target_still_waits_for_go(self):
        class StopSimulation(BaseException):
            pass

        pipes = iter(((4, 5), (6, 7), (8, 9), (10, 11), (12, 13), (14, 15)))
        forks = iter((123, 234))
        selected = iter((([6], [], []), ([], [], [])))
        fake_os = SimpleNamespace(
            name="posix",
            fork=lambda: next(forks),
            setpgid=Mock(),
            killpg=Mock(),
            waitpid=Mock(),
            set_blocking=Mock(),
            fstat=Mock(),
            pipe=lambda: next(pipes),
            close=Mock(),
            read=lambda *args: b"ready\n",
        )
        seen = []

        def wait_root_only(pid):
            seen.append(pid)
            if len(seen) == 2:
                raise StopSimulation()
            return None

        with (
            patch.object(owner, "os", fake_os),
            patch.object(owner, "reap", side_effect=wait_root_only),
            patch.object(owner.time, "monotonic", return_value=0),
            patch.object(
                owner.select, "select", side_effect=lambda *args: next(selected)
            ),
        ):
            with self.assertRaises(StopSimulation):
                owner.controller({"timeoutMs": 1000, "cleanupMs": 1000})
        self.assertEqual(seen, [234, 234])

    def test_independent_deadline_and_lost_owners(self):
        self.assertEqual(owner.stop_reason(10, 10), "timeout_elapsed")
        self.assertEqual(owner.stop_reason(0, 10, node_open=False), "control_eof")
        self.assertEqual(owner.stop_reason(0, 10, owner_open=False), "control_eof")
        self.assertEqual(
            owner.stop_reason(0, 10, command="output_limit"), "output_limit"
        )
        self.assertIsNone(owner.stop_reason(0, 10))

    def test_absence_requires_all_four_facts(self):
        self.assertTrue(owner.absence_verified(True, True, True, True))
        for index in range(4):
            args = [True] * 4
            args[index] = False
            self.assertFalse(owner.absence_verified(*args))

    def test_post_reap_probe_never_sends_a_signal(self):
        for effect, expected in [
            (None, False),
            (ProcessLookupError(), True),
            (PermissionError(), False),
        ]:
            killpg = Mock(side_effect=effect)
            with patch.object(owner, "os", SimpleNamespace(killpg=killpg)):
                self.assertEqual(owner.probe_absent(123), expected)
            killpg.assert_called_once_with(123, 0)

    def test_guardian_self_kill_uses_current_group_only(self):
        class Killed(BaseException):
            pass

        calls = []
        fake_os = SimpleNamespace(
            set_blocking=Mock(),
            setpgid=Mock(),
            write=Mock(),
            read=lambda fd, size: b"output_limit\n",
            getpgrp=lambda: 123,
            killpg=lambda pid, sig: (
                calls.append((pid, sig)),
                (_ for _ in ()).throw(Killed()),
            ),
        )
        fake_signal = SimpleNamespace(
            SIGTERM=15,
            SIGINT=2,
            SIGHUP=1,
            SIGPIPE=13,
            SIGKILL=9,
            SIG_IGN=1,
            signal=Mock(),
        )
        with patch.object(owner, "os", fake_os), patch.object(
            owner, "signal", fake_signal
        ), patch.object(owner, "close_except"), patch.object(
            owner.time, "monotonic", return_value=0
        ), patch.object(
            owner.select, "select", return_value=([4], [], [])
        ):
            with self.assertRaises(Killed):
                owner.guardian(4, 5, 6, 7, 10)
        self.assertEqual(calls, [(123, 9)])
        fake_os.setpgid.assert_called_once_with(0, 0)

    def test_join_failure_never_executes_user_command(self):
        fake_os = SimpleNamespace(
            setpgid=Mock(side_effect=ProcessLookupError()), execv=Mock()
        )
        with patch.object(owner, "os", fake_os):
            with self.assertRaises(ProcessLookupError):
                with patch.object(owner, "close_except"):
                    owner.exec_target(
                        {"executable": "/usr/bin/example", "args": [], "cwd": "/tmp"},
                        123,
                        4,
                        5,
                        6,
                        7,
                        10,
                    )
        fake_os.execv.assert_not_called()

    def test_private_descriptors_closed_before_exec(self):
        order = []
        fake_os = SimpleNamespace(
            setpgid=lambda *x: order.append("join"),
            open=lambda *x: 9,
            devnull="/dev/null",
            O_RDONLY=0,
            dup2=Mock(),
            chdir=Mock(),
            close=Mock(),
            read=lambda *x: b"GO\n",
            write=lambda fd, data: len(data),
            execv=lambda *x: order.append("exec"),
        )
        fake_signal = SimpleNamespace(SIGPIPE=13, SIG_DFL=0, signal=Mock())
        with patch.object(owner, "os", fake_os), patch.object(
            owner, "signal", fake_signal
        ), patch.object(
            owner,
            "close_except",
            side_effect=lambda keep: order.append(("close", keep)),
        ), patch.object(
            owner.time, "monotonic", return_value=0
        ), patch.object(
            owner.select, "select", return_value=([7], [], [])
        ):
            owner.exec_target(
                {"executable": "/bin/example", "args": [], "cwd": "/tmp"},
                123,
                4,
                5,
                6,
                7,
                10,
            )
        self.assertEqual(
            order, [("close", {4, 5, 6, 7}), "join", ("close", set()), "exec"]
        )
        fake_signal.signal.assert_called_once_with(13, 0)

    def test_dead_guardian_or_invalid_go_never_executes(self):
        # A zombie group can still accept setpgid after guardian death. Admission
        # still fails because only that guardian could have written GO.
        for data in (b"", b"NO\n", b"G", b"GO\n!"):
            with self.subTest(data=data):
                fake_os = SimpleNamespace(
                    setpgid=Mock(),
                    write=lambda fd, value: len(value),
                    close=Mock(),
                    read=lambda *x: data,
                    execv=Mock(),
                )
                with patch.object(owner, "os", fake_os), patch.object(
                    owner, "close_except"
                ), patch.object(owner.time, "monotonic", return_value=0), patch.object(
                    owner.select, "select", return_value=([7], [], [])
                ):
                    with self.assertRaisesRegex(RuntimeError, "GO"):
                        owner.exec_target({}, 123, 4, 5, 6, 7, 10)
                fake_os.execv.assert_not_called()
                fake_os.setpgid.assert_called_once_with(0, 123)

    def test_join_writer_eof_and_go_timeout_prevent_exec(self):
        for ready, write in (
            ([], lambda *x: 5),
            ([7], Mock(side_effect=BrokenPipeError())),
        ):
            fake_os = SimpleNamespace(
                setpgid=Mock(), write=write, close=Mock(), execv=Mock()
            )
            with patch.object(owner, "os", fake_os), patch.object(
                owner, "close_except"
            ), patch.object(owner.time, "monotonic", return_value=0), patch.object(
                owner.select, "select", return_value=(ready, [], [])
            ):
                with self.assertRaises((RuntimeError, BrokenPipeError)):
                    owner.exec_target({}, 123, 4, 5, 6, 7, 10)
            fake_os.execv.assert_not_called()

    def test_guardian_denies_go_after_eof_or_deadline(self):
        class Killed(BaseException):
            pass

        for read_fd, payload, now in (
            (6, b"", 0),
            (6, b"BAD\n", 0),
            (3, b"", 0),
            (4, b"", 0),
            (6, b"JOIN\n", 10),
        ):
            with self.subTest(read_fd=read_fd, payload=payload, now=now):
                writes = []
                fake_os = SimpleNamespace(
                    set_blocking=Mock(),
                    setpgid=Mock(),
                    close=Mock(),
                    write=lambda fd, data: (writes.append((fd, data)) or len(data)),
                    read=lambda *x: payload,
                    getpgrp=lambda: 123,
                    killpg=Mock(side_effect=Killed()),
                )
                fake_signal = SimpleNamespace(
                    SIGTERM=15,
                    SIGINT=2,
                    SIGHUP=1,
                    SIGPIPE=13,
                    SIGKILL=9,
                    SIG_IGN=1,
                    signal=Mock(),
                )
                with patch.object(owner, "os", fake_os), patch.object(
                    owner, "signal", fake_signal
                ), patch.object(owner, "close_except"), patch.object(
                    owner.time, "monotonic", return_value=now
                ), patch.object(
                    owner.select, "select", return_value=([read_fd], [], [])
                ):
                    with self.assertRaises(Killed):
                        owner.guardian(4, 5, 6, 7, 10)
                self.assertNotIn((7, b"GO\n"), writes)

    def test_live_guardian_alone_issues_go(self):
        class Killed(BaseException):
            pass

        writes = []
        fake_os = SimpleNamespace(
            set_blocking=Mock(),
            setpgid=Mock(),
            close=Mock(),
            write=lambda fd, data: (writes.append((fd, data)) or len(data)),
            read=lambda fd, size: b"JOIN\n" if fd == 6 else b"output_limit\n",
            getpgrp=lambda: 123,
            killpg=Mock(side_effect=Killed()),
        )
        fake_signal = SimpleNamespace(
            SIGTERM=15,
            SIGINT=2,
            SIGHUP=1,
            SIGPIPE=13,
            SIGKILL=9,
            SIG_IGN=1,
            signal=Mock(),
        )
        with patch.object(owner, "os", fake_os), patch.object(
            owner, "signal", fake_signal
        ), patch.object(owner, "close_except"), patch.object(
            owner.time, "monotonic", return_value=0
        ), patch.object(
            owner.select, "select", side_effect=[([6], [], []), ([4], [], [])]
        ):
            with self.assertRaises(Killed):
                owner.guardian(4, 5, 6, 7, 10)
        self.assertEqual([item for item in writes if item[0] == 7], [(7, b"GO\n")])

    def test_second_fork_failure_closes_lifetime_without_reaping_guardian(self):
        log = []
        forks = iter((123, OSError("fork failed")))

        def fork():
            value = next(forks)
            log.append("fork")
            if isinstance(value, OSError):
                raise value
            return value

        pipes = iter(((4, 5), (6, 7), (8, 9), (10, 11), (12, 13), (14, 15)))
        fake_os = SimpleNamespace(
            name="posix",
            fork=fork,
            setpgid=Mock(),
            killpg=Mock(),
            waitpid=Mock(),
            set_blocking=Mock(),
            fstat=Mock(),
            pipe=lambda: next(pipes),
            close=lambda fd: log.append(("close", fd)),
            read=lambda *x: b"ready\n",
        )
        with patch.object(owner, "os", fake_os), patch.object(
            owner.time, "monotonic", return_value=0
        ), patch.object(owner.select, "select", return_value=([6], [], [])):
            with self.assertRaisesRegex(OSError, "fork failed"):
                owner.controller({"timeoutMs": 1000, "cleanupMs": 1000})
        self.assertLess(
            log.index(("close", 15)), len(log) - 1 - log[::-1].index("fork")
        )
        for fd in (5, 13, 14, 9, 11):
            self.assertIn(("close", fd), log)
        fake_os.waitpid.assert_not_called()
        fake_os.killpg.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
