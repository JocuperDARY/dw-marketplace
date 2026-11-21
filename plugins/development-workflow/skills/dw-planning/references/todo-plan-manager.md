# 分层 TODO 与计划管理器

本页说明可选的跨宿主分层 TODO 与计划管理脚本（`skills/dw-planning/scripts/todo-plan.js`）及其状态存储库（`lib/todo-plan-store.js`）和只读渲染库（`lib/todo-plan-render.js`）。它面向缺少原生持久 TODO/DAG 追踪的运行环境，不新增默认强制阶段、不替代宿主原生工具，也不接管外部验证与验收结论。

---

## 核心定位与边界

- **单一结构化真相源**：以 `DwTodoPlan1` JSON 文件（默认显式通过 `--file <path>` 或环境变量 `DW_TODO_PLAN_PATH` 指定）维护 **阶段（Phase） → 子任务（Task）** 两层结构与依赖 DAG。
- **派生视图非真相源**：同步生成的 Markdown（`TODO.md`）与静态 HTML（`progress.html`）只是只读派生快照；界面或视图写入失败（`VIEW_SYNC_FAILED`）会附带告警但不会覆盖或回滚主 JSON 状态。
- **完成门控边界**：`check-complete` 仅核对所声明 TODO 条目的状态是否全部为 `completed` 且无空阶段；它**不证明**外部测试通过、代码审查完成或宿主验收成立，真实行为与验收仍需通过 [dw-verification](../../dw-verification/SKILL.md) 独立核验。

---

## 数据模型与 5 态流转

### Schema（`DwTodoPlan1`，`schemaVersion: 1`）

- 顶层字段：`planId`、`title`、`goal`、`revision`（单调递增）、`createdAt`、`updatedAt`、`nextPhaseSeq`、`nextTaskSeq`、`maxHistoryEntries`（默认 `200`）、`truncatedHistoryCount`、`views`（`{ markdownPath, htmlPath }`）、`phases[]`、`archived[]`、`history[]`、`recentRequests[]`（保留最近 `128` 条幂等指纹）。
- 边界与净化：递归拒绝包含自身键 `__proto__`、`constructor`、`prototype` 的载荷与控制字符（`INVALID_ARGUMENT`）；ID 满足 `/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/`；单计划上限 `maxPhases = 100`、`maxTasks = 2000`、`maxFileBytes = 2 MiB`。
- 单调唯一 ID：阶段 ID（`P1`、`P2`…）与任务 ID（`P1-T1`…）在活动项与 `archived[]` 间全局唯一，删除或重排均不复用、不重编号。

### 任务 5 态与阶段派生状态

| 任务状态 | 终端/摘要徽章 | 约束与流转规则 |
|---|---|---|
| `pending` | `[○ 未完成]` | 初始状态；`pause`（`in_progress → pending`）可附 `--note`；`reopen`（`completed \| impossible \| error → pending`）必须提供 `--reason`。 |
| `in_progress` | `[▶ 进行中]` | 受 `Phase.dependsOn` 与 `Task.dependsOn` 门控（未满足时报 `DEPENDENCY_UNMET`，仅在 `--allow-unmet-deps --reason` 下绕过并记入历史）；`start --exclusive` 会将同属主的其他 `in_progress` 任务暂停为 `pending`。 |
| `completed` | `[✓ 已完成]` | 同样受前置依赖门控；可附 `--evidence` 与 `--note`。从 `error`/`impossible` 恢复时自动清空 `task.statusReason` 并保留历史原因。 |
| `impossible` | `[⊘ 无法完成]` | 必须提供非空 `--reason`（否则 `REASON_REQUIRED`）；会导致下游依赖方在摘要 `upstreamBlocked` 中标记受阻。 |
| `error` | `[✗ 出错]` | 必须提供非空 `--reason`；若上游阶段回到未完成而下游阶段已有 `in_progress`/`completed` 任务，摘要 `dependencyWarnings` 会发出 `UPSTREAM_PHASE_REOPENED`。 |

阶段状态由其子任务实时派生（不可直接手写覆盖）：无任务为 `empty`（`check-complete` 视为 `PLAN_EMPTY`）；全部 `completed` 为 `completed`；含 `error` 为 `error`；否则含 `impossible` 为 `impossible`；否则含 `in_progress` 或既有 `completed` 又有 `pending` 为 `in_progress`；其余为 `pending`。

---

## CLI 子命令与公共选项

入口：`node skills/dw-planning/scripts/todo-plan.js <subcommand> [options]`

### 全局选项

- `--file <path>`（缺省回退 `DW_TODO_PLAN_PATH`）、`--root <dir>`（强制 canonical 边界与逐段 `lstatSync` 符号链接拒绝）、`--json`
- `--expected-revision <n>`、`--request-id <id>`（同指纹重放返回 `idempotentReplay: true`，不同载荷报 `REQUEST_ID_CONFLICT`）
- `--actor <id>`、`--role <coordinator|author|verifier>`（默认 `coordinator`）、`--lock-wait-ms <n>`（默认 `5000`）
- `--no-sync`、`--sync-md <path|none>`、`--sync-html <path|none>`、`--stdin`（自动剥离 UTF-8 BOM `\uFEFF`）

### 25 个子命令分类

| 类别 | 子命令 | 说明 |
|---|---|---|
| 初始化与视图 | `init`、`configure-views`、`validate` | 创建 `DwTodoPlan1`（`--title`/`--goal`/`--plan-id`/`--force`）、绑定侧车视图路径、离线校验结构与 DAG |
| 状态流转 | `start`、`claim-next`、`pause`、`complete`、`reopen`、`mark-impossible`、`mark-error`、`set-status` | 驱动 5 态变更；`claim-next --owner <id>` 原子认领首个就绪任务（无就绪返回 `NO_READY_TASK`） |
| 阶段调整 | `add-phase`、`update-phase`、`remove-phase`、`reorder-phases` | 动态增删改排阶段；`remove-phase` 默认归档，被引用时报 `DEPENDENCY_IN_USE`（需 `--unlink-deps`），`--purge` 硬删除 |
| 任务调整 | `add-task`、`update-task`、`split-task`、`remove-task`、`reorder-tasks` | 支持 `--before`/`--after`/`--during`（记录 `origin`）、`--move-to-phase`；`split-task --into ... --chain \| --parallel` 归档原任务并重绑下游依赖 |
| 批量与观测 | `apply`、`status`、`check-complete`、`render`、`recover-lock` | `apply --stdin` 单锁原子执行多条 ops；`render --format terminal\|text\|brief\|markdown\|html`（`--watch` 在非 TTY 必须同时带 `--allow-non-tty` 与有界 `--max-seconds`/`--max-events`） |

---

## 库 API（CommonJS，零外部依赖）

`todo-plan.js` 导出 `{ runCli, ...store, ...render }`，也可直接引入子模块：

- **`lib/todo-plan-store.js`**：导出 `TodoPlanError`、`EXIT_CODES`、`VALID_STATUSES`、`VALID_ROLES`、`SCHEMA_NAME`、`SCHEMA_VERSION`、`sleepSync`、`resolvePlanPath`、`resolveSidecarPath`、`createAtomicWriter`、`atomicWriteFile`、`readPublishedPlan`、`validatePlan`、`derivePhaseStatus`、`getSummary`、`checkComplete`、`initPlan`、`configureViews`、`loadAndValidate`、`startTask`、`claimNextTask`、`pauseTask`、`completeTask`、`reopenTask`、`markImpossible`、`markError`、`setTaskStatus`、`addPhase`、`updatePhase`、`removePhase`、`reorderPhases`、`addTask`、`updateTask`、`splitTask`、`removeTask`、`reorderTasks`、`applyPatch`、`statusPlan`、`checkCompletePlan`、`recoverLock`。
- **`lib/todo-plan-render.js`**：导出 `STATUS_META`、`escapeHtml`、`safeJsonForScript`、`renderTerminal`、`renderBrief`、`renderMarkdown`、`renderHtml`、`renderPlan`（HTML 自带严格 CSP `default-src 'none'`、`role="progressbar"`、无 JS 完整 DOM 与 XSS 转义）。

---

## 写入模式、角色隔离与锁恢复

1. **Coordinator 单写默认模式**：普通任务仅由总控（`role: coordinator`）读写单一计划文件，执行成员通过消息回报结果，避免无谓写锁竞争。
2. **`DW_TODO_PLAN_PATH` 共享加锁模式**：多进程并发协作时通过环境变量或绝对 `--file` 共享同一计划文件（`author`/`verifier` 传相对路径会收到 `SHARED_RELATIVE_PATH_WARNING` 提醒）。每次写入通过 `<plan>.lock`（`O_EXCL` + 随机 `nonce`）串行化、先写临时文件再 `fsync` + 原子重命名，并在锁内完成侧车同步。
3. **角色隔离矩阵**：
   - `coordinator`：全部读写权限，支持 `start --reassign --reason` 改派与 `recover-lock`。
   - `author`：需提供 `--actor`；仅能认领未归属任务或更新自己名下任务（否则 `NOT_TASK_OWNER`），禁止阶段级变更、`--purge`、`--reassign`、`reorder-tasks` 与 `recover-lock`（`ROLE_FORBIDDEN`）。
   - `verifier`：只读查询 + `mark-error --reason` + 通过 `update-task` 追加 `--evidence`/`--note`；禁止 `complete`、`add-task` 等实现修改（`ROLE_FORBIDDEN`）。
4. **崩溃锁恢复**：锁超时抛出 `STATE_LOCKED` 时**绝不**自动删锁；需人工或总控核对 `.lock` 中的 `nonce` 后显式执行 `recover-lock --expected-nonce <nonce>`，口令不匹配报 `LOCK_RECOVERY_MISMATCH`。

---

## 退出码契约

| 退出码 | 含义与对应错误码 |
|---|---|
| `0` | 成功：`OK`、`PLAN_COMPLETE`、`CLAIMED`、`NO_READY_TASK`、`LOCK_RECOVERED` |
| `1` | 未完成：`PLAN_INCOMPLETE`（存在未完成/`error`/`impossible` 任务且无空阶段） |
| `2` | 请求/状态语义错误：`INVALID_ARGUMENT`、`INVALID_SCHEMA`、`NOT_FOUND`、`DUPLICATE_ID`、`DEPENDENCY_CYCLE`、`DEPENDENCY_MISSING`、`DEPENDENCY_IN_USE`、`DEPENDENCY_UNMET`、`REASON_REQUIRED`、`INVALID_TRANSITION`、`PLAN_EMPTY`、`REQUEST_ID_CONFLICT`、`WATCH_NON_TTY_FORBIDDEN` |
| `3` | 并发/锁/权限冲突：`REVISION_CONFLICT`、`STATE_LOCKED`、`LOCK_RECOVERY_MISMATCH`、`TASK_ALREADY_CLAIMED`、`NOT_TASK_OWNER`、`ROLE_FORBIDDEN` |
| `4` | 路径安全与 I/O 错误：`PATH_SECURITY_VIOLATION`（越出 `--root` 或遇到符号链接）、`IO_ERROR` |

## 相关入口

- [dw-planning](../SKILL.md) — 方案设计与计划粒度标准
- [dw-collaboration](../../dw-collaboration/references/ordinary-collaboration.md) — 普通协作中的角色隔离与能力映射
- [dw-tooling](../../dw-tooling/SKILL.md) — 自带辅助脚本与工具发现边界
- [dw-verification](../../dw-verification/SKILL.md) — 独立运行验证与验收标准
