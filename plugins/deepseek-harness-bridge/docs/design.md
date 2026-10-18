# DeepSeek Harness bridge 0.1.0

## Goal and scope

Add an independently versioned Codex plugin to DW Marketplace. Codex submits a bounded task to one independently owned DeepSeek Harness runtime through the official SDK. The bridge provides submit, status, wait, result, continue and cancel, plus a non-model diagnostic tool. Existing plugins and user installations remain unchanged.

## Execution contract

- The exact route is `deepseek-official / deepseek-flash`, with explicit `high` or `max` effort. The bridge does not modify the caller's automatic-model policy or infer delegation authorization from installation.
- Pin SDK and its matching runtime to 0.2.1-rc.2. Use the SDK's supported Node runtime, not private Desktop IPC or GUI automation. Desktop login and GUI sessions are not reused.
- One active task per bridge data directory, no implicit queue and no automatic task retry. A caller-supplied request ID makes submission idempotent; conflicting reuse is rejected.
- Each new task has its own Harness home and session. A continuation keeps its task's workspace, route, access mode and home. It creates a separate attempt; a task cannot be continued while running or cleanup is uncertain.
- Tasks survive as durable records. A bridge restart marks unfinished attempts interrupted and prevents automatic resubmission. Lock ownership is never recovered merely from a saved PID; an unclean bridge exit requires explicit operator reconciliation.
- Default access is read-only. The worker profile exposes only bounded filesystem read/list tools; workspace-write additionally exposes bounded write. No shell, external MCP, recursive agents, arbitrary plugins, user skills, or GUI credential access. This is a tool-level file boundary, not an OS sandbox.
- Paths must remain inside the resolved task workspace, including symlink resolution. Protected metadata and credentials are unavailable. Runtime state is outside the task workspace.
- Task timeout is bounded; output tokens are capped per model request. No claim of an exact total currency/token cap. Tool calls have a separate finite limit. Cancellation closes the owned SDK runtime and reports cleanup failure honestly.
- Subscribe before enqueue; wait through `session/wait`; inspect durable `turn/end`. Only a completed terminal is successful. Truncation, blocked, error, unknown termination and cleanup failure remain distinct from success. Runtime completion does not mean parent acceptance.
- Return a concise task summary and paged result. Raw model/tool traffic is not echoed into MCP or written by the bridge. Harness keeps its own transcript in its isolated home. Bridge errors use safe categories, not raw provider stderr or credential-bearing exception text.

## Implementation order and acceptance

1. Add behavioral tests and verify the missing behavior fails.
2. Implement durable task state, single ownership, idempotency, timeout/cancel, continuation and bounded results using a fake runner.
3. Implement official SDK adapter and constrained filesystem tools. Verify SDK transport with a local fake JSON-RPC runtime and exercise filesystem boundaries.
4. Wire MCP tools and plugin/marketplace metadata. Exercise the real MCP stdio boundary without a paid model call; validate package contents and existing marketplace checks.
5. Review standards and specification independently; repair concrete findings and repeat affected tests.

Real DeepSeek inference, live Codex plugin installation, desktop session visibility, performance claims and publication require their own evidence. Zero-model protocol tests must not be reported as live Flash validation.
