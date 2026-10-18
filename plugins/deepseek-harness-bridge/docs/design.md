# DeepSeek Harness bridge 0.2.0

## Goal and scope

Add an independently versioned Codex plugin to DW Marketplace. Codex submits a bounded task to one independently owned DeepSeek Harness runtime through the official SDK. The bridge provides submit, status, list, wait, result, continue, cancel, diagnostics and installed-capability inventory. Existing marketplace plugins keep their versions. Installation/configuration occurs within explicit user authorization.

## Execution contract

- The exact route is `deepseek-official / deepseek-flash`, with explicit `high` or `max` effort. The bridge does not modify the caller's automatic-model policy or infer delegation authorization from installation.
- Pin SDK and its matching runtime to 0.2.1-rc.2. Use the SDK's supported Node runtime, not private Desktop IPC or GUI automation. Desktop login and GUI sessions are not reused.
- One active task per bridge data directory, no implicit queue and no automatic task retry. A caller-supplied request ID makes submission idempotent; conflicting reuse is rejected.
- Each new task has its own Harness home and session. A continuation keeps its task's workspace, route, access mode and home. It creates a separate attempt; a task cannot be continued while running or cleanup is uncertain.
- MCP discovery does not reserve the task store. A connection acquires exclusive ownership on its first task operation and releases it after confirmed terminal persistence and idle readers. Other connections can then recover results and continue the logical task. Legacy continuations restore the saved SDK session; budgeted stages restore checkpoints into fresh SDK sessions. Active-worker ownership, including between automatic stages, and unresolved cleanup locks remain exclusive.
- Tasks survive as durable records. Opening an unlocked store marks unfinished attempts interrupted and prevents automatic resubmission. Lock ownership is never recovered merely from a saved PID; an unclean bridge exit requires explicit operator reconciliation.
- Default access is read-only. Built-in files exposes bounded read/list and optionally guarded writes; inference-only omits file tools. Local capability profiles can explicitly select pinned reviewed headless modules and skills. Installed desktop metadata is advisory, never automatic authority to load code. Exact runtime tool names are checked before prompting. Third-party modules and their dependencies are trusted code, responsible for their own path/effect policy; this is not an OS sandbox. See capabilities.md.
- Paths must remain inside the resolved task workspace, including symlink resolution. Protected metadata and credentials are unavailable. Runtime state is outside the task workspace.
- Task timeout, official SDK request count, request content bytes, per-request output tokens and tool calls have finite limits. The llm/stream hook reserves a request before adapter dispatch; initialization cannot spend. Failed-call retries, compaction and title generation are disabled. Missing usage is unknown. Legacy attempt budgets reset on explicitly requested continuation. Opt-in budget orchestration instead shares immutable task-wide totals across all stages and continuations; see [budget-orchestration.md](budget-orchestration.md). Third-party code bypassing the SDK is outside this gate. No exact total currency cap is claimed. Cancellation closes the owned runtime and reports cleanup failure honestly.
- Subscribe before enqueue; wait through session/wait and a single-consumer delivery fence; inspect durable turn/end. No competing queue drainer may discard an in-flight event or reorder assistant text. Only a completed terminal is successful. Truncation, blocked, error, unknown termination and cleanup failure remain distinct from success. Runtime completion does not mean parent acceptance.
- Windows launch selects a configured existing Node executable and optionally decrypts a DPAPI credential into process memory. No secret is placed in argv/config/diagnostic output. Environment credentials have precedence. Desktop credentials remain separate.
- Return a concise task summary and paged result. Raw model/tool traffic is not echoed into MCP or written by the bridge. Harness keeps its own transcript in its isolated home. Bridge errors use safe categories, not raw provider stderr or credential-bearing exception text.

## Implementation order and acceptance

1. Add behavioral tests and verify the missing behavior fails.
2. Implement durable task state, single ownership, idempotency, timeout/cancel, continuation and bounded results using a fake runner.
3. Implement official SDK adapter and constrained filesystem tools. Verify SDK transport with a local fake JSON-RPC runtime and exercise filesystem boundaries.
4. Wire MCP tools and plugin/marketplace metadata. Exercise the real MCP stdio boundary without a paid model call; validate package contents and existing marketplace checks.
5. Review standards and specification independently; repair concrete findings and repeat affected tests.

Real DeepSeek inference, live Codex plugin installation, desktop session visibility, performance claims and publication require their own evidence. Zero-model protocol tests must not be reported as live Flash validation.
