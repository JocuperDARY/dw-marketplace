# Changelog

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
