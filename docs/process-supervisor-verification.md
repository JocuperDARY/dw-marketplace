# Windows process supervisor 5.6.0 verification

Original delivery date: 2026-10-19. Candidate base: `2ac88986cebe9bda9312df19ad08721d1a4857f1`
(development-workflow 5.5.2). Implementation is in the attached
`dw-process-lifecycle` worktree. The original checkout's 40 pre-existing status
entries were preserved. No commit, push, publication or live MCP configuration
change was part of that original delivery. The following source-delivery results
retain their original scope; the later marketplace integration is recorded below.

## Marketplace integration, 2026-10-19

The candidate was integrated onto remote master
`779b778a11a54a94956f23437271819094b0683c`. Development-workflow had not changed
between that revision and the candidate base. The root README was merged by hunk
to preserve the independently released DeepSeek bridge 1.3.0; gpt-bridge remains
2.0.0. No source worktree, original checkout or live MCP configuration was changed.

The imported implementation matches the original delivery after LF/CRLF
normalization. Git's Windows checkout conversion changed new text-file bytes,
including the C# source; the original executable hashes below identify only the
original delivery and must not identify a rebuild of this checkout. The integrated
C# source SHA-256 is
`60928c2a6f029e6b6ff8f604c7b4f1de8b5daa7a9967f2dbf1d9cb5f61a82bc1`.

The integrated source and its newly packed archive each passed all 17 supervisor
tests. The actual archive contains 100 files, each byte-matched to the integration
checkout; the structure check passed with 14 skills, 21 scripts and 21 test files.
The prior wide regression is reused for unchanged surfaces with its timing caveat
below. Live Codex MCP integration remains NOT_RUN. This synchronization does not
install or activate the supervisor in existing sessions.

## Result and evidence scope

The candidate adds a Windows process supervisor to development-workflow 5.6.0.
It has actual Windows fixture evidence for process ownership, byte-stream
transport, teardown and descendant cleanup. The final source and the final
extracted plugin archive each pass all 17 supervisor tests. The delivered binary
also has a separate process-count and post-exit observation.

This does not establish that Codex has loaded a modified MCP entry. Real Codex
MCP initialize/list-tools/request/disconnect validation is **NOT_RUN**. Existing
processes were not adopted by this implementation. Linux/macOS support is not
implemented by this backend; the Linux entry in the full suite was skipped as
not applicable to this Windows host.

## Test history

| Evidence | Observed result | Scope |
| --- | --- | --- |
| Pre-change `npm run test:core` | 16 pass, 1 fail, 0 skip, 3 unselected | Existing requirements-file assertion compared LF text with the Windows checkout's CRLF text; Windows checker lifecycle tests passed |
| Initial new supervisor test | Failed because the builder did not exist | Test-first baseline, retained as a real failure rather than represented as a successful run |
| Full `npm run test:all` | 21 pass, 0 fail, 1 skip, 0 not-run; exit 0 | Includes actual Windows lifecycle marker and package extraction/self-tests |
| Final source supervisor tests | 17 pass, 0 fail; exit 0 | Final root-handle verification and command-mode behavior included |
| Final archive supervisor tests | 17 pass, 0 fail; exit 0 | Tests executed from the extracted final 100-file npm archive |
| Final structure check | Pass: 14 skills, 21 scripts, 21 test files | Package links, metadata and test registration |
| Delivered binary footprint check | Both fixture trees absent after shutdown | Independent PID plus creation-time comparison included Node, supervisor and conhost |

The wide 21-entry regression run began before the final narrow root-handle
completion refinement and the command-mode addition. Its result is reused for
unchanged surfaces; it is not described as a rerun of every entry against the
final bytes. Final source and archive lifecycle tests were rerun after those
changes. The full run's hook/package contract suite passed 25/25 and exercised
`npm test` from an actual extracted npm archive. A previous full-run attempt was
interrupted by the execution environment; its partial log is not counted as a
successful full run.

The unrelated baseline assertion was changed only to normalize CRLF to LF in
the test. No production dependency contract was relaxed.

## Lifecycle coverage and corrections

The 17 final tests cover reusable builds and damaged build rejection; 300 KB
binary transport; arguments/cwd/environment; graceful EOF and nonzero exit status;
command completion after EOF; forced cleanup with an active sibling protected;
root exit with detached descendants; explicit deadlines; abrupt supervisor death;
original parent death while stdin remains open; blocked output; broken transport;
invalid launches and receipt collisions; batch shims; explicit cmd arguments; and
paired launch measurements.

Observed implementation defects were corrected before delivery: .NET Framework
FileStream could hide a broken-pipe write, so relays now use native ReadFile and
WriteFile; cmd argument quoting now preserves ordinary host behavior; absence
verification now requires both zero active job processes and a signaled retained
root handle with a retrieved exit code. The final footprint receipt reports
`verified_absent`, zero active processes and child exit code 125 for the deliberately
uncooperative fixture, rather than a missing exit-code observation.

The parent-death test deliberately detaches its owner to avoid having an outer
runtime job supply the cleanup being tested. An independent ten-second watchdog
was added to that test owner after review. Tests have outer deadlines and explicit
fixture teardown; quiet connected siblings are not cleanup targets.

## Measured overhead and conhost observation

From the final extracted package, five paired launches gave median elapsed times
of 73 ms direct and 133 ms supervised: a 60 ms median difference in this local
sample. Median supervisor working set was 19,058,688 bytes (about 18.2 MiB).
The source-tree run measured 76/135 ms and 18,812,928 bytes. These are small local
measurements, not performance guarantees or whole-machine memory savings.

A separate simultaneous idle pair used the exact delivered binary:

| Fixture | Processes observed | Sum of working sets |
| --- | --- | ---: |
| Direct | node.exe + conhost.exe (2) | 63,971,328 bytes |
| Supervised | supervisor.exe + node.exe + conhost.exe (3) | 80,875,520 bytes |

The supervisor adds one process. The snapshot difference was 16,904,192 bytes;
summed working sets can include shared pages and are not a physical-memory
accounting claim. No resident Node or PowerShell supervisory wrapper was added.
Both associated conhost instances disappeared after their fixture sessions ended;
the independent remaining-process list was empty. This is evidence for these
fixtures, not a guarantee that every externally created console belongs to the
job. The receipt's `elapsedMs` includes launch and observation time and must not
be interpreted as isolated cleanup latency.

## Review and delivered bytes

Independent JavaScript, native C# and contract/package reviews completed. The
JavaScript review's fixture-watchdog finding was fixed; native follow-up approved
the root-handle completion check and command-mode EOF behavior. No unresolved
critical/high/medium finding was reported. A generic .NET SDK build was unavailable
because no SDK was installed; the actual product build uses the installed .NET
Framework compiler and succeeded, including from the extracted package.

Final native source SHA-256:
`9d560413c2b37dc50712b53909d1b6059b9f98a4c0d27f697fe20e475957d6f8`.

Delivered executable:
`bin/dw-process-supervisor-9d560413c2b37dc50712.exe`.
Its SHA-256 is
`17c1918e7e244719e44412d76dd416c3eaf34983268908056bb04ce4a3c7137c`.

`development-workflow-5.6.0.tgz` contains 100 files. Its supervisor source, builder,
reference and test bytes match the implementation worktree. Archive paths were
checked before extraction. The final binary ran the extraction command in command
mode with a lifetime bound, and that owned job was verified absent afterward.

The delivery folder includes the final source and package test logs,
`full-suite.log`, `package-readback.json`, `footprint.json`, the executable and
build manifest, the plugin archive, a patch against the stated base, and Chinese
activation/rollback instructions. Intermediate attempts and logs remain in the
worktree's `work` directory, outside the source patch and plugin archive.

## Activation and limits

Installing the plugin alone does not redirect host MCP commands. Each selected
entry must launch the supervisor with its original executable and arguments after
`--`. Default stdio mode treats stdin EOF as disconnect. Command mode forwards EOF
without ending a finite command; use an explicit lifetime where appropriate.

The supervisor observes retained handles and transport events, not process names,
CPU idleness, age or a global process scan. It never adopts old orphan trees or
kills svchost/unrelated consoles. Externally brokered processes are outside its
ownership. If a live host keeps an abandoned session's pipes open, no reliable
shutdown signal exists; a host release hook or explicit lifetime policy is needed.

Rollback restores the saved original command/args for future launches. Active
supervised sessions retain their immutable binary until they exit. There is no
installed global service, scheduled task, startup cleanup or automatic restart loop.
