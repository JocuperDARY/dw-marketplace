# Changelog

## 1.2.0 — 2026-10-19

- Add drafting/off for bounded prose from supplied facts; preserve explicit effort/caps and warn that single-request reasoning, including low, may exhaust output without a visible answer.
- Add explicit outputFormat json-object, strict final response/summary validation and format-only status separate from runtime, review coverage and parent acceptance. Never strip prose/fences, normalize paths or repair JSON implicitly.
- New budgeted tasks keep a soft request/token reserve while work plus checkpoint fits. Share one tool-free/off recovery across confirmed truncation and explicitly checked JSON format failure, charged to the original totals and deadline; save original failed text before recovery.
- Preserve single-request prohibition on retry/continuation, old fingerprints, saved task allocation policy and all hard caps. No automatic semantic, transport, cleanup, denied-call or persistence recovery.
- Add network-blocked SDK/MCP regressions for zero-visible reasoning, summary prose and single-request stopping. Withdrawn path-escaping claims are excluded; valid decoded Windows paths remain unchanged. No paid inference or dependency change.

## 1.1.0 — 2026-10-19

- Add verification workload for path classification, exception rules and test expectations, defaulting to high/16384. Preserve explicit effort/caps and warn on low/off overrides; no automatic escalation or new authorization.
- Require a bounded reviewContract for verification: named cases, rules and mandatory checks; inject concise per-item evidence, classification/accounting separation and completeness instructions.
- Publish structural delivery validation separately from runtime completion and parent acceptance. Detect omitted/duplicate/unknown items, missing evidence fields and malformed JSON without repair or quality-triggered retries. Structure-complete wrong answers remain unaccepted.
- Retain old fingerprints and receipts; carry review contracts through checkpoints and continuations. Add synthetic failure regressions and a real-SDK/MCP offline integration with network blocked. No paid test or dependency upgrade.

## 1.0.0 — 2026-10-19

- New long/multi-step submissions require preauthorized total budgets. Explicit single-request inference remains available without tools or continuation; persisted legacy records keep replay compatibility.
- Workload-aware off/low/high defaults and per-request allocation reserve up to 2048 tokens for tool-free/off checkpoints. Explicit token caps remain binding.
- Preserve max-tokens, visible partial text and reasoning-only metadata; save partial artifacts before at most one tool-free/off recovery from the same remaining total.
- Retry short observation-only lock conflicts with bounded backoff, preserve mutation ownership and report safe read-retry metadata.
- Offline tests use the pinned SDK with fake streams and blocked network. No paid smoke test was run for this release.

## 0.2.0 — 2026-10-18

- Add opt-in task-wide request, output-token, tool-call and elapsed-time authorization, with stage allocations and durable accounting shared by automatic stages and later continuations.
- Reserve a checkpoint response before stage limits, using SDK prompt assembly rather than mutating frozen model requests. Persist progress and confirm teardown before restoring a new isolated stage.
- Pause on budget exhaustion or repeated progress. Keep unknown usage conservatively reserved, and never auto-retry failed, truncated, cancelled or unclean execution.
- Verify the complete MCP/real-SDK checkpoint chain with a synthetic model and network-blocked subprocess, plus budget, restart, cancellation and persistence regression tests. No dependency upgrades or repeated paid smoke test.

## 0.1.3 — 2026-10-18

- Keep MCP discovery and diagnostics available across simultaneous desktop connections by acquiring task-store ownership only when a task tool needs it.
- Release ownership after a confirmed terminal result and idle readers, preserving active-worker exclusion and unresolved cleanup locks. A later connection can retrieve or continue the saved session.
- Add production stdio discovery regression coverage and connection lifecycle checks for continuation, replay, cancellation, unpolled completion and unverified cleanup.

## 0.1.2 — 2026-10-18

- Add portable Agent Plugins manifests so Codex expands `${PLUGIN_ROOT}` before starting the MCP server; retain legacy compatibility manifests.
- Include the portable manifests in npm packages and test their supported fields and onboarding path.
- Clarify that marketplace source metadata does not identify the installed runtime directory. Verified nine MCP tools through the local Codex desktop engine; paid inference is a separate check.

## 0.1.1 — 2026-10-18

- Add explicit installed-DSH capability inventory and pinned headless module/skill profiles.
- Enforce per-attempt model-request and request-byte limits before provider dispatch; publish provider usage receipts and allow zero-tool inference profiles.
- Add an existing-Node launcher and Windows DPAPI API-key setup helper.
- Fix the SDK event-pump/drain race that could discard a tool-limit failure or reorder assistant text at completion.
- Address review findings with atomic file publication, a shared bridge write lock, protected configuration paths and Windows alias rejection, and bounded read pages.
- Validate pinned module source at load time, reject duplicate profile IDs, and test actual readiness ordering and denied credential-file access.
- Publish task/request receipts only after the first durable save, retain successful attempts on continuation-save failure, and resolve idempotent retries before credential preflight.
- Honor the configured credential directory and forward catchable launcher shutdown signals; document host authorization and cooperative-writer limits.

## 0.1.0 — unreleased PR candidate

- 新增独立 Codex 插件及 DW Marketplace 条目，通过锁定版本的官方 SDK 启动 DeepSeek Flash 工作者。
- 提供提交、状态、任务列表、等待、分页结果、成功后续接、取消和配置诊断。
- 增加持久任务记录、幂等请求、独占所有权、时间/工具/单请求输出限制及明确清理状态。
- 默认只读文件工具，可显式启用有界写入；提供路径检查、内容冲突检查与原内容备份。
- 提供设置/委派技能和无需付费模型调用的协议、MCP、文件边界及官方运行时初始化测试。
- 本候选未通过付费 Flash 推理或真实 Codex 插件安装验证，未验证桌面会话复用或吞吐量提升。
