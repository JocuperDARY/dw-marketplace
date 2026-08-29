# `dw-collaboration`：能力优先的协作编排设计（Scheme B）

- 状态：`APPROVED_FOR_IMPLEMENTATION_PLANNING`
- 计划审查增补：`PENDING_USER_APPROVAL`（完整 ResourceEvent/状态边、可执行自适应 route floor、精确文件面与 O-002 推荐）
- 日期：2026-08-26
- 设计范围：`development-workflow` 插件内的新子 Skill；本文只定义契约，不授权实现、提交、发布或外部执行
- 规范标识：`DWCollaborationDesign1`

## 1. 摘要与验收边界

本设计采用已批准的 **Scheme B**：保留 `dw-tooling` 作为能力发现与路由入口，在同一插件内新增专门的 `dw-collaboration` 子 Skill。新 Skill 负责协作能力证明、拓扑选择、阶段路由、任务/资源状态机、进程与临时存储租约、失败降级及完成证据；它不绑定任何厂商或特定宿主实现。

本文的设计验收条件是：后续实现者无需重新发明字段、状态、降级条件或资源所有权，即可据此编写 Skill、schema、fixtures 和行为测试；任何未知能力、身份漂移、资源未回收或验证不一致都必须 fail closed 为 `HOLD`、`UNVERIFIED` 或保守拓扑，而不是推断成功。

## 2. 问题、目标与非目标

### 2.1 问题陈述

现有 `dw-tooling` 已描述能力发现、串并行原则、简单子进程清理和运行时回退，但它没有定义：

- 如何区分“配置宣称能力”“探针成功”“真实观察”“独立验证”；
- 如何证明 spawn、collect、增量消息和双向通信分别可用；
- 如何把协作拓扑与模型/推理选择解耦；
- 如何记录 child、runtime thread、process tree、terminal、port、temporary allocation 和 constrained compute 的统一所有权；
- 如何在 PID 复用、路径换绑、磁盘压力、root crash、静默长任务和清理不确定时停止并保留证据；
- 如何证明“结果已提交”已经过 root 接受、审查和验证，以及“终止已请求”之后资源确已回收。

缺少这些契约时，多智能体使用容易把请求提交当成接收，把 child 自报当成 root 验证，把 timeout 当成失败证明，把配置中的模型名当成实际执行，并在共享工作树、进程树和临时目录上造成所有权冲突。

### 2.2 目标

1. 以实际能力及新鲜证据选择 `single`、`assignment_only`、`interactive_shared` 或 `serial_fallback`。
2. 为每个有界阶段独立选择模型/推理强度，同时保持路由与拓扑正交。
3. 用四个版本化 artifact 建立可重放、可校验、会话级的证据链。
4. 用统一 ledger 管理嵌套资源所有权和精确清理。
5. 为进程、终端、线程、临时存储和长任务提供跨运行时的最小安全契约。
6. 通过 RED-GREEN-REFACTOR 的压力场景和跨平台测试证明 Skill 行为，而不是只检查关键词。

### 2.3 非目标

- 不实现通用 agent runtime、消息总线、进程管理器、容器平台或 GPU 调度器。
- 不承诺所有宿主支持互动协作、后台任务、模型覆盖、团队恢复或嵌套 agent。
- 不把 Claude Code、Codex、Grok Build 或任何产品名写成能力判断条件；这些名称只用于 adapter discovery hint。
- 不扩大现有 hooks，不通过 hook 自动派生真实运行能力，也不恢复已删除的旧 orchestration hook。
- 不修复 `gpt-bridge` 的 child-process、timeout、cancellation 或 cleanup 缺陷；这是独立的未来工作。
- 不授权版本更新、实现、commit、push、merge、publish、部署、付费调用或 GPU 执行。

## 3. 当前仓库证据与方案选择

### 3.1 事实基线

- `dw-tooling` 已将运行时声明读取、最小充分工具集、权限/依赖/超时/清理定义为发现入口（`plugins/development-workflow/skills/dw-tooling/SKILL.md:20-28`），并已有并行/依赖感知分派能力目录（`:53-64`）。
- 同一 Skill 只给出粗粒度并排/串行规则（`:92-130`）和基本子进程协议（`:132-141`），尚无证据 schema、协作状态机和资源租约。
- 它已经明确静态工具名不是安装事实、不可用时回退本地串行（`:145-158`），并禁止共享写并行（`:162-172`）。新设计应深化这些边界，不应另造入口。
- `tool-inventory.js` 只枚举发现到的 skill/MCP/plugin，并标记 `sourcePolicy: 'discovered-only'`（`plugins/development-workflow/hooks/tool-inventory.js:99-123`）；其输出还明确“不包含推测工具”（`:126-140`）。因此 inventory 是 `DECLARED` 证据来源，不是 spawn/message/cleanup 的运行证明。
- 现有 hook 测试已覆盖 published-package 自测（`plugins/development-workflow/test/hooks.test.js:242-260`）、资源回收指导（`:394-421`）、Windows timeout 后精确回收（`:509-564`）及 manifest/README 版本一致性（`:639-662`），可扩展为协作契约回归面。
- `check-updates.ps1` 已有 bounded external command、timeout 和 owned process-tree cleanup 的真实代码路径（`plugins/development-workflow/skills/check-updates/scripts/check-updates.ps1:296-376`），是适配器测试的参考实现，不是通用 runtime adapter。
- 当前包清单只发布既有 skills 与 tests（`plugins/development-workflow/package.json:21-38`）；package 与 plugin manifest 均为 `5.0.0`（`plugins/development-workflow/package.json:1-7`；`plugins/development-workflow/.claude-plugin/plugin.json:1-16`），marketplace 与 README 同样陈述 5.0.0 和 11 个 Skill（`.claude-plugin/marketplace.json:6-16`；`README.md:5-10`）。
- 仓库贡献约束要求修改前识别目标、更新版本并 E2E 测试（`AGENTS.md:13-19,26-30`），但当前 5.0.0 工作树未提交，本文不得先替未来实现决定版本。

### 3.2 为什么选独立子 Skill

**相对继续扩充 `dw-tooling`**：能力发现/选择与协作执行是不同变化轴。前者面向所有工具且应短小；后者包含 schema、状态机、资源生命周期、威胁模型和跨平台验证，继续塞入 `dw-tooling` 会使普通工具选择也承担复杂协作上下文。Scheme B 让 `dw-tooling` 只判断“是否需要协作及是否存在候选能力”，再路由到 `dw-collaboration`。

**相对创建独立插件**：协作编排共享 development-workflow 的风险、计划、实现、验证和收尾语义，也必须复用其授权边界与发布测试。拆成插件会引入独立安装/版本漂移、跨插件路由和重复文档；目前没有独立发布或权限域的证据。

## 4. 明确实现边界

后续规范实现的 canonical location 是：

```text
plugins/development-workflow/skills/dw-collaboration/
```

允许的未来文件面见 §20。以下边界为硬约束：

1. `dw-tooling` 是 discovery/router entry；`dw-collaboration` 不复制全量工具 inventory。
2. 不恢复 `plugins/development-workflow/hooks/subagent-context.js`，不通过增加 hook 数量或 hook 副作用实现编排。
3. 不在项目级创建重复 `dmux` skill；若宿主发现 dmux 类能力，只作为 adapter hint 与候选 capability source。
4. 不修改 `gpt-bridge`；其 lifecycle defects 另立设计、测试和版本边界。
5. Skill 是运行时中立的决策与证据协议。宿主 adapter 只能映射受控 capability，不得把产品版本名直接提升为 `VERIFIED`。

## 5. 术语与共同约束

- **root**：对计划、授权、分派、接受、复核和外层资源负责的协调者。
- **child**：接收有界任务包的执行单元；可能是 agent session，也可能是无互动 executor。
- **adapter**：把宿主原语映射为本设计 capability/state/resource event 的薄层。
- **run**：由 `run_id` 标识的一次会话内协作尝试。
- **phase**：可独立路由、验证和结束的 bounded work unit。
- **lease**：资源使用权及其边界；TTL 只是复查触发器，不是删除权限。
- **ack**：由预期接收方返回、绑定 nonce/request/session 的确认；本地 API 返回 success 不等于接收方 ack。

所有时间字段使用 RFC 3339 UTC；所有 ID 为高熵、不可猜、run 内唯一的 opaque string。每个 artifact 都必须含 `schema`, `schema_version`, `run_id`, `session_id`, `created_at`, `producer`, `redaction`。`schema_version` 初始为整数 `1`；未知 major version 必须拒绝，未知可选字段可保留但不得改变既有含义。

## 6. 四个版本化 artifact

### 6.1 共同 evidence contract

#### 证据等级

| `evidence_level` | 含义 | 可支持的结论 |
|---|---|---|
| `DECLARED` | 配置、inventory、文档或 adapter 自述存在 | 仅候选；不得分派 |
| `PROBED` | 本 session 内最小 nonce probe 得到结构有效结果 | 可用于保守规划；受 expiry/contradiction 限制 |
| `OBSERVED` | 当前 run 真实动作产生可关联事件 | 证明该动作发生，不证明正确性或完成 |
| `VERIFIED` | root 或独立 verifier 复核身份、结果和不变量 | 可支持 gate；仍受授权与作用域限制 |

能力 `support` 受控值：`supported`, `request_only`, `unsupported`, `unknown`。`request_only` 表示可提交请求但没有 ack/collect 证明；它不能满足需要可靠接收或互动的拓扑。证据等级与 support 不混用：例如 `{support:"request_only", evidence_level:"OBSERVED"}` 只证明请求被提交。

#### 会话、有效期与矛盾

- capability evidence 默认绑定 `session_id`、adapter instance fingerprint 和 auth/permission fingerprint；不得跨 session 复用 `PROBED`/`OBSERVED`。
- 每条能力含 `observed_at`, `expires_at`。到期后降为候选 `DECLARED`，必须重新 probe；不得自动续期。
- `contradictions[]` 记录较新的反证及 source event。任何同 scope 的 `unsupported`、identity drift、permission change、ack mismatch 或 adapter error 优先于旧正证据，并将 capability 置为 `unknown`，直至重新 probe。
- capability intersection 取 root 和 child 两侧同一语义 capability 的最弱 support 与最低新鲜 evidence；任一侧未知即未知。

#### 隐私与完整性

- `redaction.policy` 受控值：`metadata_only`, `hashed_identifiers`, `approved_excerpt`；默认 `metadata_only`。
- 不记录 raw prompt、secret、token、credential、私人绝对路径、完整命令行或未经批准的源文件内容。路径记录 workspace-relative logical ID 或 salted hash；命令记录 canonical executable path hash、argv hash 与 redacted summary。
- artifact 必须对“除顶层 `content_sha256` 字段外”的 canonical serialization 计算 `content_sha256`，避免自引用摘要；引用其他 artifact 时记录其 `artifact_id` 与 hash。修改产生新 artifact/generation，不原地覆盖已 sealed 证据。

### 6.2 `CapabilityMatrix1`

用途：列出当前 session、当前 adapter 实例能够证明的最小能力及其交集。受控 capability IDs：

```text
spawn_child, collect_result, child_to_root_message, root_to_child_message,
interrupt_child, request_shutdown, verify_child_exit, shared_task_status,
isolated_workspace, exclusive_file_ownership, runtime_liveness,
process_identity, process_tree_terminate, terminal_session_control,
temporary_lease, constrained_compute_lease, resource_observation,
model_request_control, reasoning_request_control,
actual_model_metadata, actual_effort_metadata
```

每个 `capabilities[]` 项必含：`capability_id`, `subject` (`root|child|adapter`), `support`, `evidence_level`, `source_kind` (`config|inventory|probe|runtime_event|verifier`), `scope`, `observed_at`, `expires_at`, `evidence_ref`, `contradictions`。额外 capability ID 必须置于 namespaced extension，不能参与 v1 gate。

**非规范示例（illustrative only）：**

```json
{
  "schema": "CapabilityMatrix1",
  "schema_version": 1,
  "artifact_id": "cap_run7_g2",
  "run_id": "run_7",
  "session_id": "sess_A",
  "created_at": "2026-08-26T03:00:00Z",
  "producer": {"role": "root", "adapter_id": "adapter_local_1"},
  "redaction": {"policy": "hashed_identifiers"},
  "capabilities": [{
    "capability_id": "root_to_child_message",
    "subject": "adapter",
    "support": "supported",
    "evidence_level": "PROBED",
    "source_kind": "probe",
    "scope": {"adapter_generation": 2},
    "observed_at": "2026-08-26T02:59:58Z",
    "expires_at": "2026-08-26T03:09:58Z",
    "evidence_ref": "probe_msg_nonce_8f",
    "contradictions": []
  }],
  "content_sha256": "illustrative-not-a-real-digest"
}
```

验证不变量：同一 subject/capability/scope 只能有一个有效结论；重复或冲突而无显式 supersedes 链即拒绝；`PROBED+supported` 必须引用本 session nonce/ack；`VERIFIED` 必须引用 verifier identity 和被验证 artifact hash。

### 6.3 `CollaborationPlan1`

用途：在任何 lease/dispatch 之前冻结 phase DAG、拓扑、路由请求、所有权、授权和 review gates。

受控字段：

- `status`: `DRAFT|VALIDATED|AUTHORIZED|SUPERSEDED|CANCELLED`
- `topology`: `single|assignment_only|interactive_shared|serial_fallback`
- `phases[]`: `phase_id`, `task_type`, `scope`, `dependencies`, `risk`, `reversibility`, `phase_kind`, `latency_cost`, `validation_failure_cost`, `task_packet_ref`, `ownership`, `route`
- `route`: `requested_model`, `requested_effort`, `selected_model`, `selected_effort`, `selection_evidence`, `allowed_fallbacks`; `actual_*` 禁止出现在 plan 中
- `gates`: `authorization`, `pre_dispatch`, `root_review`, `verification`, `cleanup`
- `capability_matrix_ref`, `resource_policy`, `failure_policy`, `telemetry_policy`

**非规范示例（illustrative only）：**

```json
{
  "schema": "CollaborationPlan1",
  "schema_version": 1,
  "artifact_id": "plan_run7_g1",
  "run_id": "run_7",
  "session_id": "sess_A",
  "created_at": "2026-08-26T03:01:00Z",
  "producer": {"role": "root"},
  "redaction": {"policy": "metadata_only"},
  "status": "VALIDATED",
  "topology": "assignment_only",
  "capability_matrix_ref": {"artifact_id": "cap_run7_g2", "content_sha256": "illustrative-capability-hash"},
  "phases": [{
    "phase_id": "phase_schema_tests",
    "task_type": "test_design",
    "scope": "bounded_single_module",
    "dependencies": [],
    "risk": "medium",
    "reversibility": "reversible",
    "phase_kind": "planning",
    "latency_cost": "balanced",
    "validation_failure_cost": "focused_tests",
    "task_packet_ref": "brief_phase_schema_tests_v1",
    "ownership": {"exclusive_paths": ["logical:path:test-fixtures"]},
    "route": {
      "requested_model": "unspecified",
      "requested_effort": "unspecified",
      "selected_model": "capability_lane:professional",
      "selected_effort": "medium",
      "selection_evidence": "route_decision_3",
      "allowed_fallbacks": ["single"]
    }
  }],
  "gates": {"authorization":"required_before_external_action","pre_dispatch":"ledger_open","root_review":"required","verification":"required","cleanup":"all_reclaimed"},
  "resource_policy": "policy_ref_v1",
  "failure_policy": "fail_closed",
  "telemetry_policy": "prompt_free_metadata_only",
  "content_sha256": "illustrative-not-a-real-digest"
}
```

验证不变量：DAG 无环、依赖存在；每个 phase 有 immutable task packet 和 ownership；拓扑满足 capability matrix；`AUTHORIZED` 只能来自 scope 匹配的人类授权或既有明确授权，不可由 child 消息产生；任何矩阵过期/冲突、范围或授权变化都使 plan `SUPERSEDED`，必须新建 generation。

### 6.4 `ResourceLedger1`

用途：在 dispatch 前登记所有外层资源，并持续记录 nested sublease、身份、状态和清理证据。

资源类型受控值：`agent_session|runtime_thread|process_tree|terminal_session|command_session|port|temporary_allocation|artifact|constrained_compute`。

资源状态受控值：`DECLARED|LEASED|START_REQUESTED|ACTIVE|QUIESCING|TERMINATE_REQUESTED|EXIT_OBSERVED|RECLAIMING|RECLAIMED|UNKNOWN|QUARANTINED`。`DECLARED` 不表示存在；`START_REQUESTED` 不表示运行；`TERMINATE_REQUESTED` 不表示退出或回收。

每项必含 `resource_id`, `type`, `owner_role`, `owner_id`, `parent_resource_id`, `lease_generation`, `state`, `identity`, `created_by_event`, `scope`, `quota_policy`, `cleanup_policy`, `last_verified_at`, `evidence_refs`。所有 state transition 是 append-only event；snapshot 由事件确定性归约。

`LifecycleEvent1` 是 run/child 的唯一规范状态写入接口，必含：`event_id`, `machine` (`run|child`), `subject_id`, `from_state`, `to_state`, `sequence`, `observed_at`, `actor_role`, `actor_id`, `plan_generation`, `evidence_refs`, `guard_refs`, `supersedes_event_id`。`ResourceEvent1` 是 resource 的唯一规范写入接口，必含：`event_id`, `resource_id`, `event_kind`, `from_state`, `to_state`, `sequence`, `observed_at`, `actor_role`, `actor_id`, `lease_generation`, `identity_ref`, `evidence_refs`, `postconditions`, `supersedes_event_id`。`event_kind` 受控值为 `DECLARE|LEASE|REQUEST_START|OBSERVE_ACTIVE|REQUEST_QUIESCE|REQUEST_TERMINATE|OBSERVE_EXIT|BEGIN_RECLAIM|VERIFY_RECLAIM|MARK_UNKNOWN|QUARANTINE`。ResourceLedger1 保存 `run_events[]`, `child_events[]`, `resource_events[]` 与归约后的 `resources[]`；所有数组共享 run 内唯一 `event_id` namespace。

每个 machine/subject 的首事件使用 `from_state=null` 和相应初态；之后每个事件的 `from_state` 必须等于上一有效 snapshot 状态，`sequence` 必须严格递增，plan/lease generation、owner 与 parent 不得漂移。旧事件不可改写；纠正只能追加一个同 generation、引用旧 `event_id` 的 `supersedes_event_id`，且 sealed receipt 引用的事件不得被 supersede。resource snapshot 中的 `created_by_event` 来自首个 DECLARE，`state`、`last_verified_at` 和聚合 `evidence_refs` 由事件流确定性归约。run/child snapshot 同理由 `LifecycleEvent1` 归约；guard refs 必须证明 terminal intent、新 packet version、dispatch/collect/review/verification 等边条件。

**非规范示例（illustrative only）：**

```json
{
  "schema": "ResourceLedger1",
  "schema_version": 1,
  "artifact_id": "ledger_run7_g5",
  "run_id": "run_7",
  "session_id": "sess_A",
  "created_at": "2026-08-26T03:05:00Z",
  "producer": {"role": "root"},
  "redaction": {"policy": "hashed_identifiers"},
  "plan_ref": {"artifact_id": "plan_run7_g1", "content_sha256": "illustrative-plan-hash"},
  "resources": [{
    "resource_id": "proc_2",
    "type": "process_tree",
    "owner_role": "child",
    "owner_id": "child_1",
    "parent_resource_id": "agent_child_1",
    "lease_generation": 1,
    "state": "ACTIVE",
    "identity": {"pid": 4120, "start_time":"2026-08-26T03:04:10Z", "exe_path_hash":"illustrative-exe-hash", "argv_hash":"illustrative-argv-hash", "parent_identity_hash":"illustrative-parent-hash", "nonce":"p_91"},
    "scope": {"cwd_hash":"illustrative-cwd-hash", "purpose":"focused_test"},
    "quota_policy": "task_profile:test",
    "cleanup_policy": "graceful_then_exact_tree",
    "last_verified_at": "2026-08-26T03:04:59Z",
    "evidence_refs": ["liveness_event_4"]
  }],
  "content_sha256": "illustrative-not-a-real-digest"
}
```

验证不变量：`plan_ref` 必须是有效 plan；ledger 在首个 dispatch 前存在；child sublease 必须挂在有效 parent；owner 不可把资源转给未授权主体；`RECLAIMED` 需要身份匹配的 postcondition；`UNKNOWN|QUARANTINED` 不得被静默丢弃并强制 run `HOLD`。

### 6.5 `ExecutionReceipt1`

用途：记录实际执行，而不是候选、配置或计划。它由 root 在 collect、review、verification、cleanup 后封存。

受控字段：

- `run_outcome`: `COMPLETE|PARTIAL|FAILED|CANCELLED|HOLD|UNVERIFIED`
- `phase_receipts[]`: `phase_id`, `child_id`, `dispatch_event`, `running_evidence`, `result_submission`, `root_acceptance`, `review`, `verification`, `requested_model`, `selected_model`, `actual_model`, `requested_effort`, `selected_effort`, `actual_effort`, `route_attestation`, `actual_route_evidence`, `artifact_refs`
- `cleanup_summary`: `all_reclaimed|quarantined|unknown`, plus ledger hash
- `authorization_summary`, `contradictions`, `residual_risks`

`actual_model`/`actual_effort` 只允许取自实际 executor/host 可验证元数据；不可验证时填受控值 `unknown`，不得从配置名、route candidate、profile 或 child 文字自报推断。`route_attestation` 的受控值为 `VERIFIED|UNVERIFIED|NOT_REQUIRED`，它与任务结果、审查和资源回收正交：宿主不暴露实际模型时，可以在结果与清理证据均充分的情况下完成任务，但必须保留 `route_attestation=UNVERIFIED`，且不得声称选定模型/effort 确已执行。如果精确执行 lane 是该 phase 的显式验收条件，则 `UNVERIFIED` 会使该 phase 不能通过 verification gate。

**非规范示例（illustrative only）：**

```json
{
  "schema": "ExecutionReceipt1",
  "schema_version": 1,
  "artifact_id": "receipt_run7_g1",
  "run_id": "run_7",
  "session_id": "sess_A",
  "created_at": "2026-08-26T03:30:00Z",
  "producer": {"role": "root"},
  "redaction": {"policy": "metadata_only"},
  "plan_ref": {"artifact_id": "plan_run7_g1", "content_sha256": "illustrative-plan-hash"},
  "ledger_ref": {"artifact_id": "ledger_run7_g9", "content_sha256": "illustrative-ledger-hash"},
  "run_outcome": "COMPLETE",
  "phase_receipts": [{
    "phase_id": "phase_schema_tests",
    "child_id": "child_1",
    "dispatch_event": "dispatch_1",
    "running_evidence": "runtime_started_1",
    "result_submission": "result_4",
    "root_acceptance": "accepted_after_review_1",
    "review": "review_pass_2",
    "verification": "focused_tests_pass_3",
    "requested_model": "unspecified",
    "selected_model": "capability_lane:professional",
    "actual_model": "host:model-id-redacted-hash",
    "requested_effort": "unspecified",
    "selected_effort": "medium",
    "actual_effort": "medium",
    "route_attestation": "VERIFIED",
    "actual_route_evidence": "host_execution_event_17",
    "artifact_refs": ["artifact_schema_fixtures_hash"]
  }],
  "cleanup_summary": {"status":"all_reclaimed","ledger_hash":"illustrative-ledger-hash"},
  "authorization_summary": "local_test_only",
  "contradictions": [],
  "residual_risks": [],
  "content_sha256": "illustrative-not-a-real-digest"
}
```

验证不变量：`COMPLETE` 需要所有 required phase 通过 root acceptance、review、verification，且 ledger 全部 `RECLAIMED` 或被明确声明为 retained artifact；任何 `UNKNOWN|QUARANTINED`、verifier disagreement 或未解决 contradiction 禁止 `COMPLETE`。缺少 actual route evidence 时必须将 `actual_*` 记为 `unknown` 且 `route_attestation=UNVERIFIED`；它禁止具体执行路线声明，并仅在精确 lane 属于 phase 验收条件时禁止 `COMPLETE`。completion 不表示 commit、integration、release 或 deployment。

## 7. Capability-first runtime adapter

### 7.1 原则

adapter 按语义能力注册，不按厂商注册。Claude Code、Codex、Grok Build 等只帮助查找可能的 spawn/message/collect 原语；任何官方文档只说明某产品可能提供某能力，不能证明本 session 已启用、权限允许、接口未漂移或探针成功。

背景资料包括 [OpenAI GPT-5.6 model guide](https://developers.openai.com/api/docs/guides/latest-model)、[Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) 和 [Grok Build subagents](https://docs.x.ai/build/features/subagents)。这些文档展示了不同模型档位、独立 child context、结果回传、共享任务和直接消息等产品概念，也明确存在实验性、会话范围、恢复、关闭和后台限制；本文因此只抽取 capability vocabulary，不把品牌映射为事实。

### 7.2 最小 nonce/ack probes

probe 必须零业务副作用、短超时、最小 token/compute，并写入 ledger：

1. **spawn/collect probe**：root 生成 `spawn_nonce`，分派只要求 child 原样返回 `{spawn_nonce, child_session_nonce, protocol_version}`。adapter API success 仅产生 `spawn_child=request_only/OBSERVED`；只有 root 收到结构匹配结果，且 child/session identity 可关联，才产生 `spawn_child=supported/PROBED` 与 `collect_result=supported/PROBED`。
2. **root→child probe**：在已识别 child 上发送新 `message_nonce`。发送 API success 只证明 submission；child 返回绑定 `{message_nonce, child_session_nonce, ack_kind:"received"}` 才证明 receipt。
3. **child→root probe**：root 向 child 下发新 `reply_nonce`，要求 child 通过独立增量消息通道发送 ack，而不是最终 collect payload。root 实际收到并校验 identity 后才证明 `child_to_root_message`。
4. **双向交集**：`interactive_shared` 需要 root→child 与 child→root 两项在同 session、同 adapter generation 上均为新鲜 `PROBED` 或更高，且 child 端能力无 contradiction。

probe timeout 只产生 `unknown`，不是 `unsupported`；明确的 host capability error 可产生 session-scoped `unsupported`。未知必须降级，不能通过重复无界 probe 猜成功。

## 8. 自适应模型/推理与拓扑正交

每个 bounded phase 在 dispatch 前按六轴分类：

1. `task_type`：检索、规划、实现、审查、验证、机械转换等；
2. `scope/dependencies`：单文件、跨模块、DAG 深度、共享状态；
3. `risk/reversibility`：失败后果、数据/安全/生产影响、回退能力；
4. `phase`：diagnosis、planning、implementation、data-integrity、test-gates、verification、wrapup；
5. `latency/cost`：互动延迟、吞吐、token/compute 预算；
6. `validation/failure_cost`：自动检查、focused tests、independent verification、rollback proof 或 full-surface audit。

v1 分类字段使用以下受控值；无法归类时必须选 `unknown`，不能写任意近义词：

| 字段 | 受控值 |
|---|---|
| `task_type` | `retrieval|classification|planning|implementation|debugging|review|verification|mechanical|unknown` |
| `scope` | `single_unit|bounded_single_module|cross_module|cross_system|unknown`；DAG 深度和共享状态另用结构化字段表达 |
| `risk` | `low|medium|high|extreme` |
| `reversibility` | `reversible|unclear|irreversible` |
| `phase_kind` | `diagnosis|planning|implementation|data_integrity|test_gates|verification|wrapup|unknown` |
| `latency_cost` | `interactive|balanced|throughput|offline|unknown` |
| `validation_failure_cost` | `automatic_check|focused_tests|independent_verification|rollback_proof|full_surface_audit|unknown` |
| `requested_effort` / `selected_effort` / `actual_effort` | `unspecified|low|medium|high|xhigh|max|unknown`；adapter 可把宿主值降为这些语义级别，不能创造新值 |

runtime-neutral route selection 使用宿主在当前 session 暴露的动态 lane catalog，而不是品牌名称。每个 lane descriptor 至少含：`lane_id`（opaque）、`capability_class`（`light|standard|engineering|professional|assurance`）、`supported_task_types`、`supported_efforts`、`latency_class`、`cost_rank`、`availability_evidence_ref`、`request_control_support` 与 `actual_metadata_support`。只允许选择存在新鲜 availability evidence 的 lane；`request_control_support=request_only` 只说明可提交选择请求，不能证明实际执行。

v1 默认 route floor 是可测试策略输入，而不是固定厂商映射：

| phase/任务证据 | 最低 `capability_class` | 默认 selected effort（宿主支持时） |
|---|---|---|
| `mechanical|classification|retrieval`，scope 不超过 `bounded_single_module`，risk=`low`，validation=`automatic_check` | `light` | `low|medium` |
| 有界工具执行、知识库/RAG、常规 test gate | `standard` | `medium` |
| `implementation|debugging` 且需要 focused tests，或迭代工程 | `engineering` | `high` |
| cross-module planning/review/verification、risk=`high` 或 independent verification | `professional` | `high` |
| risk=`extreme`、不可逆动作、rollback proof/full-surface audit 或关键安全不变量 | `assurance` | `xhigh|max`，且必须有 action-scoped 人类授权和 bounded assurance lease |

选择器取满足 floor、required validation、latency/cost policy 的最低可用 class；若没有满足 floor 的 lane，返回 `HOLD_ROUTE_UNAVAILABLE`，不得静默降档。`scope|risk|phase_kind|validation_failure_cost=unknown` 时不得猜低档：先补证据，仍未知则按 policy 进入 `HOLD` 或使用不低于 `professional` 的保守 lane。若宿主不支持 effort 请求，`selected_effort=unspecified`，不能假称默认 effort 已生效。每个 phase 完成、风险/依赖变化、验证失败或外部动作前重选；高难阶段结束后按新轴值 downshift。通信失败只改变 topology，不能改变上述 route floor。

模型字段不是闭合产品枚举：`requested_model` 可为用户提供的 opaque identifier 或 `unspecified`，`selected_model` 必须为运行时发现的 opaque identifier/能力 lane，`actual_model` 必须为 host-observed opaque identifier 或 `unknown`。schema 只校验来源、redaction 和 requested/selected/actual 分离，不把任意产品目录固化为规范。

模型或 effort 的请求参数存在，只能证明 `model_request_control` / `reasoning_request_control` 至多为 `request_only`；只有新 executor 的 host receipt 或等价运行事件才能证明 `actual_model_metadata` / `actual_effort_metadata`。路由决策只作用于尚未创建的 executor，不能改变已经运行的 root/child，也不得把“已选 route agent”表述为“当前 root 已切换模型”。

`route` 决定执行智能/成本层级，`topology` 决定协作关系；二者不得互相推导。相同模型可运行 `single` 或 `assignment_only`；通信失败只把 `interactive_shared` 降为 `assignment_only`/`serial_fallback`，不得自动提升模型或 effort。

必须分开记录：

- `requested_*`：用户或上层请求；
- `selected_*`：root 基于六轴选择；
- `actual_*`：executor 实际运行且有 host evidence 的值。

每个新 phase、重大依赖/风险变化、验证失败或外部动作前重路由。高难度阶段结束后重新评估并 downshift；extreme effort 只用于有证据的极端后果、不可逆行动、关键安全不变量或正式高后果验证，不能因 prompt 长、通信失败或“更保险”而选择。

## 9. 四种 topology

| topology | 进入条件 | capability 要求 | 规则与 root gate |
|---|---|---|---|
| `single` | 单链任务、并行收益不足、共享状态不可安全切分，或用户禁止 delegation | 无 child capability | root 本地执行；仍需 plan/ledger（如有资源）、review、verification、cleanup |
| `assignment_only` | 至少一个独立 bounded task；只需要 dispatch + final collect | `spawn_child` 与 `collect_result` 新鲜 `PROBED+supported`；不要求增量消息 | 每个 child 收到完整自包含 task packet；exclusive ownership；root 接受/审查/验证后才算完成 |
| `interactive_shared` | 任务需要迭代澄清、共享证据或阶段性纠偏，且通信收益超过成本 | assignment-only 能力 + root/child 双向消息交集 + liveness；均新鲜无 contradiction | 只允许增量、结构化、最小必要消息；root 保持授权与 merge 权；共享可变状态仍需独占/隔离 |
| `serial_fallback` | 能力未知/漂移、互动失败、DAG 强依赖、共享写不能隔离或宿主只提供 request-only | 无可靠 child 要求 | dispatch 前完成整个 DAG；以 immutable artifact 串行交接；每一步 root gate 后再开始下一步 |

### 9.1 完整 task packet

`assignment_only` 和无互动路径的 task packet 必含：`packet_version`, `phase_id`, objective, acceptance criteria, immutable dependency artifact hashes, owned paths/resources, forbidden actions, authorization scope, allowed tools/capabilities, expected output schema, validation commands, timeout/progress contract, cleanup duties, return channel。缺一项不得 dispatch。

### 9.2 downgrade transitions

- `interactive_shared -> assignment_only`：增量消息能力失效，但 spawn/collect 仍新鲜，且 child 已拥有足够完整 task packet；否则转 `serial_fallback`。
- `assignment_only -> serial_fallback`：collect 未证实、capability drift、共享写冲突、预算/资源 gate 失败。
- `interactive_shared|assignment_only -> single`：尚未 dispatch、并行收益消失且 root 可安全本地执行。
- 已 dispatch 后不得把拓扑标签改写来掩盖历史；新建 plan generation，旧 run 保留 `PARTIAL|HOLD` 证据。

## 10. 状态机

### 10.1 run state

```text
PLANNING -> PLAN_VALIDATED -> AUTHORIZED -> LEDGER_OPEN -> DISPATCHING
DISPATCHING -> RUNNING -> COLLECTING -> ROOT_REVIEW -> VERIFYING -> RECLAIMING
RECLAIMING -> COMPLETE
任何非终态 -> CANCELLING -> RECLAIMING -> CANCELLED
任何非终态 -> FAILED -> RECLAIMING -> FAILED_RECLAIMED
任何状态遇到未知/隔离资源、证据矛盾或授权漂移 -> HOLD
```

受控 run states 仅为：`PLANNING|PLAN_VALIDATED|AUTHORIZED|LEDGER_OPEN|DISPATCHING|RUNNING|COLLECTING|ROOT_REVIEW|VERIFYING|RECLAIMING|COMPLETE|CANCELLING|CANCELLED|FAILED|FAILED_RECLAIMED|HOLD`。

硬不变量：plan 在 lease 前；ledger 在 dispatch 前；`COMPLETE` 只能从 `RECLAIMING` 进入，并满足全部 review/verification/cleanup gate。`HOLD` 不是清理豁免：只允许继续安全观察、证据封存和已验证 owned resource 的回收。

### 10.2 child state

```text
DECLARED -> DISPATCH_REQUESTED -> DISPATCH_ACKED -> START_OBSERVED -> WORKING
WORKING -> RESULT_SUBMITTED -> RESULT_ACCEPTED -> REVIEWED -> VERIFIED -> CLOSED
WORKING -> SUSPECTED_HUNG -> INTERRUPT_REQUESTED -> EXIT_OBSERVED -> CLOSED
任一活动态 -> FAILED|CANCEL_REQUESTED；身份不明 -> UNKNOWN
```

受控 child states：`DECLARED|DISPATCH_REQUESTED|DISPATCH_ACKED|START_OBSERVED|WORKING|QUIET_PROGRESS|EXTERNAL_WAIT|SUSPECTED_HUNG|RESULT_SUBMITTED|RESULT_ACCEPTED|RESULT_REJECTED|REVIEWED|VERIFIED|INTERRUPT_REQUESTED|CANCEL_REQUESTED|EXIT_OBSERVED|CLOSED|FAILED|UNKNOWN`。

`dispatch != running`：只有 host/runtime start evidence 或绑定 child ack 才进入 `START_OBSERVED`。`result submitted != accepted`：root 必须校验 schema、scope、artifact hash 和 forbidden-action compliance。child 自报 `done` 只能进入 `RESULT_SUBMITTED`。

### 10.3 resource state

以下邻接表是 v1 的规范边集；未列出的边全部拒绝。所有活动 run state 可按表进入 `CANCELLING|FAILED|HOLD`，但不能借取消或失败跳过资源回收：

```text
RUN_EDGES
PLANNING       -> PLAN_VALIDATED | CANCELLING | FAILED | HOLD
PLAN_VALIDATED -> AUTHORIZED | CANCELLING | FAILED | HOLD
AUTHORIZED     -> LEDGER_OPEN | CANCELLING | FAILED | HOLD
LEDGER_OPEN    -> DISPATCHING | RUNNING | CANCELLING | FAILED | HOLD
DISPATCHING    -> RUNNING | CANCELLING | FAILED | HOLD
RUNNING        -> COLLECTING | ROOT_REVIEW | CANCELLING | FAILED | HOLD
COLLECTING     -> ROOT_REVIEW | CANCELLING | FAILED | HOLD
ROOT_REVIEW    -> VERIFYING | CANCELLING | FAILED | HOLD
VERIFYING      -> RECLAIMING | CANCELLING | FAILED | HOLD
CANCELLING     -> RECLAIMING | HOLD
FAILED         -> RECLAIMING | HOLD
RECLAIMING     -> COMPLETE | CANCELLED | FAILED_RECLAIMED | HOLD
COMPLETE | CANCELLED | FAILED_RECLAIMED | HOLD -> no outgoing run edge

CHILD_EDGES
DECLARED           -> DISPATCH_REQUESTED | CANCEL_REQUESTED | FAILED | UNKNOWN
DISPATCH_REQUESTED  -> DISPATCH_ACKED | CANCEL_REQUESTED | FAILED | UNKNOWN
DISPATCH_ACKED      -> START_OBSERVED | CANCEL_REQUESTED | FAILED | UNKNOWN
START_OBSERVED      -> WORKING | CANCEL_REQUESTED | FAILED | UNKNOWN
WORKING             -> QUIET_PROGRESS | EXTERNAL_WAIT | SUSPECTED_HUNG | RESULT_SUBMITTED | CANCEL_REQUESTED | FAILED | UNKNOWN
QUIET_PROGRESS      -> WORKING | EXTERNAL_WAIT | SUSPECTED_HUNG | RESULT_SUBMITTED | CANCEL_REQUESTED | FAILED | UNKNOWN
EXTERNAL_WAIT       -> WORKING | QUIET_PROGRESS | SUSPECTED_HUNG | RESULT_SUBMITTED | CANCEL_REQUESTED | FAILED | UNKNOWN
SUSPECTED_HUNG      -> WORKING | INTERRUPT_REQUESTED | CANCEL_REQUESTED | FAILED | UNKNOWN
RESULT_SUBMITTED    -> RESULT_ACCEPTED | RESULT_REJECTED | CANCEL_REQUESTED | FAILED | UNKNOWN
RESULT_REJECTED     -> WORKING | CANCEL_REQUESTED | FAILED | UNKNOWN
RESULT_ACCEPTED     -> REVIEWED | CANCEL_REQUESTED | FAILED | UNKNOWN
REVIEWED            -> VERIFIED | FAILED | UNKNOWN
VERIFIED            -> CLOSED | UNKNOWN
INTERRUPT_REQUESTED -> EXIT_OBSERVED | FAILED | UNKNOWN
CANCEL_REQUESTED    -> INTERRUPT_REQUESTED | EXIT_OBSERVED | FAILED | UNKNOWN
FAILED              -> EXIT_OBSERVED | CLOSED | UNKNOWN
EXIT_OBSERVED       -> CLOSED | UNKNOWN
CLOSED | UNKNOWN    -> no outgoing child edge

RESOURCE_EDGES
DECLARED            -> LEASED | UNKNOWN | QUARANTINED
LEASED              -> START_REQUESTED | ACTIVE | RECLAIMING | UNKNOWN | QUARANTINED
START_REQUESTED      -> ACTIVE | RECLAIMING | UNKNOWN | QUARANTINED
ACTIVE               -> QUIESCING | TERMINATE_REQUESTED | EXIT_OBSERVED | RECLAIMING | UNKNOWN | QUARANTINED
QUIESCING            -> ACTIVE | TERMINATE_REQUESTED | EXIT_OBSERVED | UNKNOWN | QUARANTINED
TERMINATE_REQUESTED  -> EXIT_OBSERVED | UNKNOWN | QUARANTINED
EXIT_OBSERVED        -> RECLAIMING | UNKNOWN | QUARANTINED
RECLAIMING           -> RECLAIMED | UNKNOWN | QUARANTINED
RECLAIMED | UNKNOWN | QUARANTINED -> no outgoing resource edge
```

`RECLAIMING -> COMPLETE|CANCELLED|FAILED_RECLAIMED` 由 run 的 sealed `terminal_intent` 分别守卫；不匹配即拒绝。`RESULT_REJECTED -> WORKING` 需要 root 签发的新 task-packet version。`LEASED|START_REQUESTED -> RECLAIMING` 只适用于有证据证明从未启动/未产生副作用的租约。`ACTIVE -> RECLAIMING` 只适用于非执行型资源，且必须先有 quiescence、无句柄和 owner/generation postcondition；process、agent、thread、terminal、port 或 compute 资源必须先有对应的 `EXIT_OBSERVED`。`TERMINATE_REQUESTED -> EXIT_OBSERVED` 需要身份绑定的 liveness 反证；`EXIT_OBSERVED -> RECLAIMING -> RECLAIMED` 还需 port/thread/temp/compute postconditions。identity mismatch 只能进 `UNKNOWN` 或 `QUARANTINED`，不得 force kill/delete。`HOLD|UNKNOWN|QUARANTINED` 对新工作是终态，但仍允许追加不改变状态的 observation evidence；恢复执行必须创建新 plan/run generation。

## 11. 统一资源 ledger 与嵌套所有权

ledger 覆盖：

- agent sessions；
- runtime threads；
- process trees；
- terminal/command sessions；
- ports；
- temporary allocations；
- input/output/evidence artifacts；
- constrained compute（GPU、accelerator、exclusive worker slot、quota-bound service）。

嵌套规则：child 拥有并负责它启动的 task-local process、terminal、port 和 temp sublease；root 拥有 child session、outer executor、全局 temp root 和 constrained-compute global lease。child 只能请求 host 终止或回报 task-local descendants，**不得 kill 自己的 host process/session**。root 不接受“已清理”的文字自报作为关键资源证据，必须用独立身份/liveness/port/path/compute check 验证。

共享资源必须显式 `owner_role=root`，child 仅获得 scoped sublease。不可表达所有权、不可观察身份或不可证明清理的资源不得用于并行 topology。

## 12. 进程、线程与终端生命周期

### 12.1 identity binding

PID/handle 不能单独作为身份。若宿主可观察，process identity 至少绑定：

- PID/handle + start time；
- executable canonical path 或其 salted hash；
- argv hash 与 redacted command summary；
- parent identity；
- ledger generation + launch nonce；
- cwd logical ID、bound port、purpose；
- native process-manager registration/run ID（若存在）。

缺少关键字段时 identity confidence 置 `partial`，只允许优雅请求和观察，不允许 exact force kill。发现 PID reuse、parent/path/command/generation/port 任一漂移时转 `UNKNOWN/HOLD`，绝不触碰该进程。

### 12.2 bounded liveness 与 hung classification

长任务每个 observation window 收集：process/thread state、最后输出、最新 artifact write、CPU time delta、IO delta、heartbeat/host event、外部依赖状态。窗口与阈值由 workload profile 在 plan 中确定，不使用通用固定秒数。

- `QUIET_PROGRESS`：无新日志但 CPU/IO/artifact/heartbeat 有有意义变化；继续观察。
- `EXTERNAL_WAIT`：有明确外部 job/request ID、等待原因和下一复查点；不得误判 hung。
- `SUSPECTED_HUNG`：多个有界窗口均无 meaningful progress，且无可信 external wait；先采证据、停止新增分派，再请求 interrupt。

### 12.3 termination 与恢复

顺序固定为：停止新工作 → 发送 graceful shutdown/interrupt → 等待 bounded ack/exit → 重查完整 identity → 仅对精确 owned tree 采取宿主支持的 exact force termination → 验证 process/thread/port 已消失 → 释放下游 lease。`terminate requested` 从不等于 `reclaimed`。

root crash 后由新 root/恢复器读取 sealed plan + ledger，重新观察身份。仅在 ownership、generation、nonce 和 current identity 全匹配时继续回收；不匹配则 quarantine。duplicate-run prevention 使用 task fingerprint + active lease generation + exclusive run lock；旧 lease 未关闭时不得重复 dispatch。

retry 只针对分类为 transient 且未发生副作用的动作，使用有界 attempts/backoff/jitter 并记录同一 idempotency key。连续同类失败触发 circuit breaker：停止该 adapter/topology 的新分派，重新 probe 或降级；不得无限重试。

永远不 kill `unknown`、user-owned、shared 或身份不完整的进程。

## 13. 临时存储租约

每个 run 在 adapter 允许的 temp root 下创建唯一 canonical root；创建前 canonicalize parent，创建后以不可预测 nonce + generation 绑定。必须原子写入 manifest，至少包括 owner/run/session/generation、canonical root identity、created time、quota profile、child sublease map、retention set 和 state。

### 13.1 quota 与压力策略

- soft/hard quota 与磁盘 low/critical watermark 来自 host/workload policy，不写死 universal 数字。
- 达 soft quota：停止扩张、报告 top consumers、压缩或 seal 非活动 artifact。
- 达 hard quota/critical watermark：停止新 dispatch 和大写入，优雅中止可回退工作，保留最小 failure evidence，run 进入 `HOLD`。
- child 只能写入分配的 canonical sublease；root 聚合总量。

### 13.2 sealing、retention 与 cleanup

完成写入后先 seal manifest 和 evidence-retention set。清理前必须：所有绑定进程/terminal quiescent；重查 owner/generation/root identity；逐级拒绝 symlink、junction、mount/reparse escape；将候选 root 移入同一受控 parent 下的 quarantine 名称（若平台可原子实现）；再次校验；只删除 manifest 声明且不在 retention set 的 owned 内容。

TTL 仅触发复查，**不是 delete authority**。路径消失、换绑、reparse 变化、父目录 identity 漂移或进程仍活跃时，不删除，标为 `QUARANTINED/HOLD`。只有重新枚举确认路径、配额和句柄均已释放，才写 `RECLAIMED`。

## 14. 长运行进度契约

每个 progress report 至少包含：

- successful/failed/completed/pending counts；
- return-code distribution（含 signal/timeout/cancel 分类）；
- child/process/thread liveness 与 identity confidence；
- newest artifact write time/size/logical ID；
- CPU/GPU/memory/IO 使用或 `not_observable`；
- temp usage、soft/hard quota、disk free/capacity/watermark；
- blockers、external waits、retry/circuit-breaker state；
- `last_meaningful_progress_at` 与其 evidence；
- 下一 observation/action gate。

百分比只能作为派生展示，不能单独作为进度或 liveness 证据。

## 15. 共享可变状态与上下文

1. 并行写必须为 exclusive file/directory ownership 或 isolated worktree；同一文件不并行修改。
2. 跨 child 合并使用 append-only artifact 或 root-mediated merge；child 不覆盖、revert、format、stage 或清理他人改动。
3. task brief、dependency artifact 和 acceptance criteria 按 hash immutable；变更生成新 packet/version，并由 root 决定是否取消旧工作。
4. `interactive_shared` 消息只携带 blocker、decision evidence、phase result 或必要增量上下文；完整 prompt/history 不广播。
5. telemetry 只记录 schema、状态、计数、hash、redacted summary 和授权引用；禁止 raw prompts、secrets、credentials、私人完整路径和不必要源码。
6. 无互动时，root 必须在 dispatch 前完成完整 DAG，并以 immutable artifact 作为串行 handoff；child 不依赖中途问答才能完成。

## 16. 授权与证据语义

以下蕴含关系一律无效：

- planning ≠ implementation；
- local edit ≠ commit；
- commit ≠ push/merge/publish/deploy/GPU；
- route candidate/config/profile ≠ actual model/effort execution；
- request submission ≠ receipt/ack；
- child self-report ≠ root verification；
- timeout ≠ failure root cause，也不证明 resource exit；
- task completion ≠ integration/release readiness。

authorization 必须绑定 actor、scope、action、resource、expiry 和 plan hash；child 消息不能授予或扩大人类授权。外部写、消息、PR、部署、付费 job、credential/config 变更和 constrained compute 使用需各自明确授权。receipt 只陈述实际、可验证动作，不能将准备态升级为运行态。

## 17. 失败矩阵

| 失败 | 允许恢复 | 强制 `HOLD` 条件 |
|---|---|---|
| child failure | 保留结果/日志；root 判断可重试的无副作用 phase；可换 child 或串行接管 | 失败后副作用未知、artifact 不一致、资源未清理 |
| communication failure | 若 task packet 完整且 collect 可用，`interactive_shared -> assignment_only`；否则 serial | ack/identity 不明、消息可能部分生效、授权相关消息丢失 |
| capability drift | 停止新 dispatch，作最小 probe，生成新 matrix/plan | 活动 child 能力或权限与 plan 矛盾 |
| shared-write conflict | 冻结写入，保存双方 diff/artifact，由 root 在隔离区仲裁 | 无法证明先后/ownership、用户改动可能被覆盖 |
| root crash/orphan | 读取 sealed ledger，精确 reattach/observe/reclaim | identity/generation/owner 任一不匹配 |
| process hang/deadlock | 分类 quiet/external/hung；graceful → exact owned-tree termination | 只能按 PID 猜测、共享/用户进程、post-termination 不确定 |
| disk pressure | 停止新写与 dispatch；seal 最小证据；回收已验证 temp | critical watermark、manifest 不完整、活跃进程仍持有路径 |
| cleanup identity mismatch | 不删除/不 kill；quarantine 并报告 | mismatch 本身即 `HOLD`，直至人工或可靠恢复器裁决 |
| verifier disagreement | 保留两份 evidence，运行预先定义的 tie-breaker/更强独立验证 | 关键 gate 无一致结论或 verifier 非独立 |

失败恢复不能放宽 acceptance threshold、跳过 cleanup、重写历史 receipt 或把 `UNVERIFIED` 改称成功。

## 18. 安全、隐私与威胁模型

| 威胁 | 主要缓解 |
|---|---|
| 不可信 child output | schema validate；内容视为 untrusted data；root review；禁止 child 授权 |
| artifact prompt injection | 明确 data/instruction boundary；只允许 task packet 中的 immutable 指令；引用内容不自动执行 |
| path traversal | canonical allowed-root check；拒绝 `..`、绝对 escape、symlink/junction/reparse；open/delete 前重查 |
| PID reuse | PID + start time + exe/argv/parent + nonce/generation 复合身份；漂移即停止 |
| TOCTOU/path swap | manifest/parent identity；原子 quarantine；操作前后 revalidation；不按未解析变量/glob 删除 |
| secret leakage | metadata-only telemetry；redaction；禁止 raw prompt/env/credential/full private path；最小输入 |
| 未授权外部动作 | action-scoped authorization gate；adapter 不继承 child 声称的批准；外部 side effect receipt |
| agent/process/disk explosion | concurrency/child/depth/process/quota policy；bounded timeout；circuit breaker；disk watermarks |
| 恶意 cleanup claim | root 独立 postcondition；critical resource 不能只用 child 自报 |
| forged capability/result | nonce/ack/session binding；artifact hashes；freshness/contradiction；actual host metadata |

残余风险包括：部分宿主不暴露足够 process/model identity；网络/agent runtime 可能在 ack 后、执行前失败；跨平台文件系统无法完全等价地提供原子 rename/handle identity。此时必须降级能力或保留 `UNVERIFIED/HOLD`，不能伪造等价保证。

## 19. 验证策略：RED-GREEN-REFACTOR

### 19.1 RED：先写压力场景

在写 `SKILL.md` 前，以 baseline replay 证明当前指导无法稳定区分以下场景：

1. inventory 宣称 agent 但 spawn API 不可用；
2. spawn request 成功但 collect/ack 永不出现；
3. 单向消息可发但 child→root 不可用；
4. capability 在 dispatch 后漂移；
5. child 自报 done 但输出 schema/ownership 不合格；
6. 两个 child 请求写同一文件；
7. PID 被复用或 executable/parent identity 改变；
8. quiet CPU/IO progress 与真实 hung；
9. TTL 到期但 process 仍持有 temp root；
10. junction/reparse/path swap 逃逸；
11. root crash 后 orphan ledger 恢复；
12. disk critical watermark 与 evidence retention 冲突；
13. selected model 与 actual metadata 不一致/不可见；
14. verifier disagreement 与 cleanup quarantine。

RED 的通过定义是“当前基线确实未满足新行为断言”，不是测试脚本语法失败。

### 19.2 GREEN：最小 Skill/schema 行为

实现后运行相同 behavioral replays，并新增：

- 四类 schema valid/invalid fixtures，含 duplicate IDs、unknown major、stale evidence、contradiction、hash/reference mismatch、非法 `COMPLETE`；
- topology matrix：root/child capability 的 supported/request_only/unknown/unsupported 组合及精确 downgrade；
- run/child/resource state-transition table tests 与 property tests：禁止跳跃、终态回退、无 ledger dispatch、未知资源 COMPLETE；
- process recovery tests：normal exit、timeout、PID reuse、parent drift、orphan、graceful failure、exact owned-tree cleanup；
- storage recovery tests：quota、disk watermark、manifest partial write、active handle、symlink/junction/reparse、path rebound、quarantine verification；
- Windows adapter tests（process tree、start time、canonical path、junction/reparse）与 POSIX adapter tests（process group/session、symlink/mount boundary）；平台不可用则明确 skip reason，不能记为 pass；
- `npm test`；
- `npm pack --dry-run --json`，校验新 Skill/schema/fixtures/必要 tests 被打包且无 temp/private artifact；
- 从 pack 文件复制到隔离目录后的 package-local tests，Windows 继续按仓库已验证的 `cmd /c npm test` 路径；
- 宿主 E2E：至少覆盖可用宿主的 spawn/collect probe、双向 message probe、downgrade、cleanup receipt。不可用宿主记 `UNVERIFIED`，不得用 mock 冒充 host success。

### 19.3 REFACTOR

仅在 behavioral replay 全绿后去重 Skill 文本、schema validator 和 adapter fixtures；重构不得改变 controlled vocabulary 或放宽 fail-closed gate。每次重构重跑 topology、state property、package-copy 与 applicable host E2E。

### 19.4 实现验收条件

后续实现只有同时满足以下条件才能称为“Skill implementation verified”：

1. `dw-tooling` 能路由到 canonical `dw-collaboration`，无 duplicate project-level dmux skill 或 hook expansion。
2. 四 artifact schema/validator 拒绝 stale、contradictory、out-of-order 和伪 COMPLETE fixtures。
3. topology matrix 对未知能力始终选择 `single|serial_fallback`，互动失败不提升 route effort。
4. assignment packet、interactive intersection、无互动完整 DAG 均有行为 replay。
5. process/temp/resource property 与 recovery tests 在适用平台通过，未知资源强制 `HOLD`。
6. requested/selected/actual model/effort 分离，actual unknown 不被补猜；route attestation 与任务完成分层，精确 lane gate 按其显式验收条件执行。
7. long-run report 不只输出 percentage。
8. security fixtures 覆盖 injection、path escape、PID reuse、TOCTOU、secret redaction、unauthorized action 与 DoS bounds。
9. `npm test`、pack JSON、packed-copy tests 全通过；host 不可用明确 `UNVERIFIED`。
10. 独立 review 无 P0/P1；P2/P3 与所有 host/platform 未验证项写入 residual-risk report。
11. 发布面 gate 证明实际 `SKILL.md` 数量为 12（1 个总纲 + 11 个子 Skill），README、marketplace、plugin manifest 与 package description 的数量陈述一致，`package.files` 显式包含 `skills/dw-collaboration/`，所有新测试文件存在、未被 ignore、包含在 package inventory 中，并在任何经授权的 staged/commit/release candidate 中完整纳入 exact allowlist；未授权 staging/commit 时不得把 working-tree candidate 误称为 Git-tracked 或 release-ready。目标 5.0.0 基线必须可由 commit SHA 重现。

## 20. 提议文件影响与版本决策 gate

以下是未来实现的预期影响面，不是本设计任务的修改授权：

```text
docs/specs/2026-08-26-dw-collaboration-design.md
docs/superpowers/plans/2026-08-26-development-workflow-5.0.0-baseline-freeze.md
docs/superpowers/plans/2026-08-26-dw-collaboration-5.1.0-implementation.md
plugins/development-workflow/skills/dw-collaboration/SKILL.md
plugins/development-workflow/skills/dw-collaboration/references/evidence-and-artifacts.md
plugins/development-workflow/skills/dw-collaboration/references/state-machines.md
plugins/development-workflow/skills/dw-collaboration/references/resource-lifecycle.md
plugins/development-workflow/skills/dw-collaboration/references/runtime-adapters.md
plugins/development-workflow/skills/dw-collaboration/references/schemas/CapabilityMatrix1.schema.json
plugins/development-workflow/skills/dw-collaboration/references/schemas/CollaborationPlan1.schema.json
plugins/development-workflow/skills/dw-collaboration/references/schemas/ResourceLedger1.schema.json
plugins/development-workflow/skills/dw-collaboration/references/schemas/ExecutionReceipt1.schema.json
plugins/development-workflow/skills/dw-collaboration/scripts/validate-artifact.js
plugins/development-workflow/skills/dw-collaboration/scripts/lib/canonical-json.js
plugins/development-workflow/skills/dw-collaboration/scripts/lib/contracts.js
plugins/development-workflow/skills/dw-collaboration/scripts/lib/state-machines.js
plugins/development-workflow/skills/dw-tooling/SKILL.md
plugins/development-workflow/skills/development-workflow/SKILL.md
plugins/development-workflow/skills/dw-domains/domains.json
plugins/development-workflow/rules/ai-agent-dev.md
plugins/development-workflow/rules/development-workflow.md
plugins/development-workflow/test/collaboration-contract.test.js
plugins/development-workflow/test/collaboration-behavior.test.js
plugins/development-workflow/test/collaboration-platform.test.js
plugins/development-workflow/test/host-e2e.js
plugins/development-workflow/test/fixtures/collaboration/**
plugins/development-workflow/test/hooks.test.js
plugins/development-workflow/package.json
plugins/development-workflow/.claude-plugin/plugin.json
.claude-plugin/marketplace.json
README.md
AGENTS.md
```

O-002 仍由实施计划批准门决定。当前 Plan B 的明确建议是采用上述 dependency-free CommonJS executable validator，并以四份 Draft 2020-12 schema 作为发布契约；批准 Plan B 即表示接受该建议并解决 O-002。无论选择如何，都不得新增 hook、daemon 或通用 agent runtime。

**版本 gate**：2026-08-26 的只读审计已经确认，当前 dirty worktree 的 5.0.0 baseline 尚未形成可重现的 Git 边界：`HEAD/master` 为 `c51195449c418294be7812641e28e46411231544`，该提交中的 development-workflow manifests 仍为 4.2.0；5.0.0 只存在于未提交工作树。当前测试入口已引用尚未跟踪的 `test/runtime-v5.test.js`。对 canonical Git 远端执行只读 `git ls-remote --heads --tags dw-marketplace` 只返回 `master` 指向同一 `c511954`，未返回 5.0.0 分支或 tag。因此，“5.0.0 是否已有本地或 canonical Git 远端 commit/tag boundary”已经判定为 **否**，不再作为未知项。

同日对当前 dirty candidate 执行了两层基线验证。受限沙箱中的 `cmd /c npm test` 得到 `runtime-v5=12/12`、`hooks=17/20`、exit 1；三项失败均由沙箱拒绝 `Get-CimInstance Win32_Process`（`0x80041003`）引起，不能据此判定代码失败。随后在用户批准的非沙箱只读会话中重跑同一命令，得到 `runtime-v5=12/12`、`hooks=20/20`、exit 0；发布副本自测、timeout 进程树回收和 detached-child 回收均通过。两个附着 exec session 都已关闭，本轮 `dw-v5-*`/`dw-hooks-*` 临时目录差集为 0；测试窗口内一度可见但身份不完整的 `powershell.exe` PID 22468 未被猜测性终止，后续精确 PID 复查确认其已不存在。该证据证明当前工作树测试基线在具备所需 Windows 进程查询权限时通过，但**不**把 dirty tree 升格为已提交、可重现或可发布的 5.0.0 baseline。

用户已于 2026-08-26 解决 O-001 并选择 V1：先冻结、验证并以 exact commit SHA 固化当前 5.0.0 candidate，再从该 SHA 创建隔离 branch/worktree，以 5.1.0 candidate 实现 `dw-collaboration`。当前 dirty tree、计划文本、测试通过或版本字符串都不能替代该 exact 5.0.0 commit boundary。

只有在以下事实都满足后，才能修改任何实现或版本发布面：

1. V1 的 5.0.0 candidate 已按独立冻结计划完成 fresh tests、package-copy、审查和资源终态验证，并经单独授权形成 exact local commit SHA；
2. 新子 Skill 的用户可见行为、Skill 数量、package files 和 migration impact 已审阅；
3. manifest、marketplace、README 和 tests 的原子版本更新计划已生成；
4. 不会混入当前 unrelated dirty changes。

canonical Git 远端没有 5.0.0 发布边界，因此“已在该远端发布”不再是本地未知；如果用户另有非 GitHub registry、私有镜像或尚未同步的冻结证据，必须在执行冻结计划前提供并重新审查版本边界。V1 决策只授权实施规划，不授权 staging、commit、worktree 创建、实现、push、tag、merge 或 publish。

## 21. Rollout、migration 与 rollback

### 21.1 rollout

1. 在用户选定并封存的 exact baseline 上创建隔离 branch/worktree，再实现 RED fixtures；如果用户明确批准在当前 dirty candidate 上工作，则先生成不可变 baseline diff/hash 与路径 ownership 清单。两种路径都不得触碰 unrelated changes。
2. 添加 schema/Skill 与 `dw-tooling` router；默认 topology 为 `single`/`serial_fallback`，互动需 probe opt-in。
3. 通过 schema、state、process/storage、package-copy tests。
4. 在每个可用 host 做最小 E2E；按 host/version/capability 记录 VERIFIED/UNVERIFIED，不做品牌全局声明。
5. 独立 review 后才生成版本 postimage 与发布候选；commit/push/publish 分别请求授权。

### 21.2 migration

旧用户无需迁移状态：没有历史 `CapabilityMatrix1` 等 artifact 时，首次运行从 `DECLARED/unknown` 开始并保守回退。不得转换旧 tool inventory 为 `PROBED`。旧 dmux/project-local 指导若存在，先只读报告冲突；不自动删除。历史运行记录不回填伪 receipt。

### 21.3 rollback

回滚单元是新 Skill、router link、schemas/tests 和同步 manifest/docs 的同一版本变更。回滚后 `dw-tooling` 回到现有本地串行 fallback；已生成 artifact 作为 evidence 保留但标记 producer version，不由旧版解释或删除。任何活动 child/process/temp lease 必须先按 ledger 回收或 quarantine，不能通过卸载 Skill 代替清理。

## 22. 决策日志

### 22.1 已批准

| ID | 决策 | 理由 |
|---|---|---|
| D-001 | 采用 Scheme B：`dw-tooling` discovery/router + 同插件 `dw-collaboration` | 分离普通工具发现与复杂协作协议，同时复用 development-workflow 风险/验证体系 |
| D-002 | capability-first、runtime-neutral | 产品/版本/配置不是 session 实际能力证明 |
| D-003 | 四个 versioned artifact | 分离能力、计划、资源和实际执行证据，支持 fail-closed validation |
| D-004 | topology 与 route 正交、逐 phase 重选 | 通信质量不等于任务难度；避免失败时错误升档 |
| D-005 | 未知能力/资源保守降级或 `HOLD` | 不以推测换取并行或完成声明 |
| D-006 | 不恢复 `subagent-context.js`，不扩 hook，不复制 dmux skill | 避免隐藏副作用和重复入口 |
| D-007 | gpt-bridge lifecycle defects 延后且独立处理 | 防止跨插件范围与版本耦合 |
| D-008 | O-001 采用 V1：先冻结并验证 5.0.0，再由 exact SHA 在隔离工作区实现 5.1.0 | 将现有 dirty candidate 收敛为可重现边界，避免协作 Skill 与未冻结基线混杂 |

### 22.2 有界开放决策

以下不是模糊占位符，而是实现前必须由明确证据触发的 gate：

| ID | 需要决定 | 决策输入 | 最迟决策点 |
|---|---|---|---|
| O-002 | schema 仅文档化还是增加 executable validator；当前 Plan B 建议 dependency-free CommonJS validator | property/negative fixture 与跨工件 hash/reference/state/completion 语义无法仅靠静态文档可靠覆盖；package 体积与维护成本 | 批准 Plan B 时；批准即接受其 executable-validator 建议 |
| O-003 | 首批 host adapters 范围 | CI/本机可用宿主、可观察身份字段、无需额外 credential 的 probe 能力 | 写 adapter fixtures 前 |
| O-004 | 默认 capability evidence expiry profile | 各宿主权限/adapter drift 频率与 probe 成本；不得采用 universal 时长 | 首个 host E2E 前 |
| O-005 | quota/watermark profiles 的宿主来源 | runtime 可用磁盘/compute observation 与企业政策；不得硬编码通用数字 | storage adapter 实现前 |
| O-006 | artifact 默认落盘位置与 retention | 宿主 allowed temp/cache root、隐私要求、crash recovery 需求 | 首个 persisted E2E 前 |

### 22.3 实施计划审查增补（待随两份计划一并批准）

| ID | 增补 | 原因 |
|---|---|---|
| A-001 | 定义完整 `ResourceEvent1`、run/child/resource 邻接边与守卫 | 消除 reducer、取消/失败清理、结果拒绝和 UNKNOWN/HOLD 语义留白 |
| A-002 | 定义动态 lane descriptor、五级 capability class、六轴 route floor 与 effort/downshift 规则 | 将“自适应选择模型和思考深度”从说明文字变成可执行、可回归测试的策略 |
| A-003 | 将 §20 收敛为 Plan B 的完整文件 allowlist，并明确批准 Plan B 即解决 O-002 为 executable validator | 防止实现越出设计文件面或将开放决策悄然当成已批准 |
| A-004 | 规定 Plan A/Plan B temp evidence 与 worktree 的消费、迁移、回收和 PARTIAL/HOLD 条件 | 防止证据目录、代理会话或隔离工作树在任务结束后失去 owner/teardown condition |

## 23. 本设计文档完成判据

本文已达到 `APPROVED_FOR_IMPLEMENTATION_PLANNING`：用户批准 Scheme B 详细设计并解决 O-001 为 V1。实施计划独立审查产生的 A-001 至 A-004 仍待随两份计划一并批准；它们是对已批准方向的可执行性补全，不授权实现。本文不表示 Skill 已实现、fresh 验证已完成、5.0.0 已形成 commit boundary、5.1.0 工作树已创建、变更已集成或发布。进入 Plan A 执行前仍需用户批准增补、独立实施计划与精确文件范围；staging、commit 和 Plan B worktree 创建分别需要独立授权；其余开放决策按表中 gate 用实测证据收敛。
