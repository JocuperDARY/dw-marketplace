# DW Marketplace

Development Workflow 工具集 —— AI 编程助手的开发方法、GPT 桥接与 DeepSeek Harness 任务委派。

## 插件

| 插件 | 版本 | 说明 |
|------|------|------|
| [development-workflow](./plugins/development-workflow/) | 5.6.0 | 按任务风险调整计划、实现、验证、资源管理与交接治理，含 Windows 进程监管器、14个 Skill（1个总纲 + 13个子 Skill）、2 个 hooks 和 8 组规则 |
| [gpt-bridge](./plugins/gpt-bridge/) | 2.0.0 | MCP Server：Claude Code 对话中调用 GPT 执行子任务 |
| [deepseek-harness-bridge](./plugins/deepseek-harness-bridge/) | 3.7.1 | Codex MCP：可靠分页、逐项验收与原生执行 |

**deepseek-harness-bridge 3.7.1**：Stabilize offline native Teams cancellation identity checks when the synthetic heartbeat is briefly empty during writing.

**deepseek-harness-bridge 3.7.0**：Stable connection-local history pagination with parent/status/time filters and explicit snapshot boundaries.

**deepseek-harness-bridge 3.6.0**：Local payload minimization and separate parent-reported pre-admission rejection evidence; no implied outbound authorization.

**deepseek-harness-bridge 3.5.0**：新增进展驱动的文本恢复，凭预先声明的文件里程碑开放后续恢复，原始总预算与单请求边界保持。

**deepseek-harness-bridge 3.4.0**：新增固定尝试的父级证据检查，区分 PASS、FAIL、UNKNOWN，保留语义与科学验收边界。

**deepseek-harness-bridge 3.3.0**：新增零模型调用的提交前计划预览，明确参数来源、风险和单请求/恢复边界；保留用户授权与独立验收。

**deepseek-harness-bridge 3.2.0**：新增只读完整结果读取器，逐页核对同一 attempt、边界和摘要；完善数组维度及限定性断言验收；修复日志释放失败先发成功回执的问题，并验证实际原生 Shell 启动与取消。

**deepseek-harness-bridge 3.1.0**：可选暂存本机启动支持，复用已验证路径与训练/评估证据，明确几何和数值推理档位及父级独立验收；离线验证不代表成本收益已测得。见[执行复用与验收](./plugins/deepseek-harness-bridge/docs/execution-efficiency.md)。

**deepseek-harness-bridge 3.0.0**：同一状态目录内多个聊天可并行执行，按任务隔离会话、预算和取消；控制凭据授权续接，独立工作区避免写冲突，旧记录只读保留。升级先等待旧任务完成。见[并行与升级契约](./plugins/deepseek-harness-bridge/docs/parallel-conversations.md)。

**deepseek-harness-bridge 2.1.0**：新增可选生命周期契约，检查父级声明的逐行允许状态、槽位复用值、顺序与重算计数；公开 schema 和安全入场错误保持一致。保留 2.0.4 的原生 Teams 检查点、回执可靠性、native 文件边界、通用委派与逐项验收规则；不因内容不一致自动重试。见[生命周期契约](./plugins/deepseek-harness-bridge/docs/lifecycle-contract.md)。

**deepseek-harness-bridge 2.0.4**：父任务保留原生 Teams 检查点，按运行时所有权回收子任务并保留终态证据；Windows 回执有限重试，新增官方 SDK 的实际工具和子任务离线验证。模型流仍为合成数据，独立验收与实际用量证据保持分开。见[原生验证](./plugins/deepseek-harness-bridge/docs/native-validation.md)。

**deepseek-harness-bridge 2.0.3**：验证原内容备份后再发布替换；同名损坏、部分写入或链接备份明确失败并保留原目标及问题备份。内建文件工具在任意深度及大小写下隐藏并拒绝 `.agent-teams-bridge`，原生 Team 工具仍直接维护状态。这是文件工具策略，不约束显式选择的 Shell 或受信任自定义模块。详见[OBS-1 / OBS-2 加固](./plugins/deepseek-harness-bridge/docs/capabilities.md#obs-1--obs-2-后续加固)。

**deepseek-harness-bridge 2.0.2**：补充通用委派模板、前置条件证据要求和逐条父级验收规则；离线反例覆盖格式通过但内容错误的回传，并显式核对终态与用量回执保存。集成 2.0.1 的 native 文件边界修复；不代表真实 Flash 质量已提高。

**deepseek-harness-bridge 2.0.1（历史）**：native 文件读写统一使用 bridge 工作区保护；两种访问模式均不加载第三方任意路径读/glob/grep。可写模式的 `ops_replace` 改为带哈希检查和备份的单文件字面替换，只读不广告该工具。独立离线复核已通过，包含真实 native 启动与文件边界回归。当时披露的 OBS-1 备份碰撞和 OBS-2 Teams 状态保护在 2.0.3 加固，详见[能力说明](./plugins/deepseek-harness-bridge/docs/capabilities.md#obs-1--obs-2-后续加固)。

**deepseek-harness-bridge 2.0.0**：优先使用 DSH 原生技能和适配的文件、Shell、Agent Teams；新任务省略资源额度时保持未指定，明确上限与旧任务不变。原生会话压缩优先，检查点阶段可持续扩展；结果区分注册、调用和验收。包含公开 schema 与运行时一致性修复、安全字段错误及旧请求指纹兼容；离线验收不代表真实模型内容或浏览器验收通过。

**deepseek-harness-bridge 1.3.0**：优先委派可独立验收的工作包；新增 `reportContract` 保留上限、观测和执行状态的事实角色，并单独检查字面交付。新增零模型调用的 `dsh_usage`，逐阶段保存回执、去除 attempt 尾阶段重复、显式报告未知用量。正文仍需父级验收，单请求仍禁止重试，不自动改写桌面消费账本。详见[事实与用量契约](./plugins/deepseek-harness-bridge/docs/evidence-usage.md)。本次不重复付费测试。

**deepseek-harness-bridge 1.0.0（历史，预算契约继续适用）**：新多阶段任务必须携带预授权总预算；按工作类型选择推理档位，单请求额度为检查点留出余量。保存截断和部分结果证据，在原预算内最多执行一次关闭推理、禁止工具的恢复；短暂锁冲突只重试读取。显式单请求模式和旧记录兼容规则见[当前预算契约](./plugins/deepseek-harness-bridge/docs/budget-reliability.md)。

**deepseek-harness-bridge 0.2.0（历史）**：引入可选总预算与检查点编排，续接与重启不重置预算。[原版设计](./plugins/deepseek-harness-bridge/docs/budget-orchestration.md)保留供兼容性参考；新任务使用上方 1.0.0 契约。

**deepseek-harness-bridge 0.1.3**：修复多条 Codex MCP 连接争用任务状态锁导致的握手失败。工具发现不再占锁；任务完成并确认清理后释放所有权，后续连接可取回结果或续接原会话，异常清理仍保留锁。支持指定现有 Node、Windows DPAPI 凭据和有界 Flash 委派；详见[安装与使用](./plugins/deepseek-harness-bridge/README.md)。离线验证、实际 Codex 加载和付费 Flash 执行分别记录。

**5.6.0 Windows 进程监管**：[安装与退出语义](./plugins/development-workflow/skills/dw-collaboration/references/process-supervisor.md)说明如何为 stdio MCP 或有界命令接入实际启动监管。专属 Job 在创建时绑定，连接关闭、父进程退出、命令结束和显式超时均触发有界清理；监管器崩溃时由内核回收后代。空闲时等待内核事件，不扫描或按名称结束系统进程。此入口需要显式接入服务器的 command/args，安装插件本身不会接管已有进程。

**5.5.2 写作准确性完善**：[dw-writing](./plugins/development-workflow/skills/dw-writing/SKILL.md) 补充符号与别名的取舍、明确且一致的命名、按阅读需要合并重复说明，以及与条件和证据强度一致的结论；适用于技术说明、推导解释、报告与交接，保留必要定义、限定条件和正式标识。

**5.5.1 交接说明完善**：[dw-handoff](./plugins/development-workflow/skills/dw-handoff/SKILL.md) 按下一段对话的用途组织目标、首项动作和结束条件；引用可访问的已有资料，说明建议技能的用途与调用时机，并对整个交接提示词脱敏。用户已授权自动续接时，使用宿主工具传递文本，保留任务回执并区分创建、送达与开始执行。

**5.5.0 技能与脚本整理**：明确诊断、调试、实现、验证、优化、收尾和文字表述的主维护位置；快速参考使用短链接，详细进程维护集中在协作模块。新增全部 Skill 的显式调用注册和写作/协作/工具提示路由，修正否定、引用文本及规则选择问题；增加只读结构检查与 Windows 有界命令后端，按新增功能递增 MINOR。manager 的关闭、持久化、写入路径冲突和模型选择约束补齐相应回归，原先遗漏的 manager 测试接入完整入口。

**5.4.3 文字表述拆分**：[dw-writing](./plugins/development-workflow/skills/dw-writing/SKILL.md) 集中维护已有的中文说明、结果与证据表达、限制说明和任务命名规范，可单独用于润色说明。总纲、规则和快速参考引用它。

**5.4.2 流程简化**：普通工作沿用已有授权，复用 Git 历史、相关测试与一次适当审查；覆盖独有未提交内容前保存一次副本。普通协作使用宿主工具，需要持久资源恢复时启用完整资源管理协议。

持久交接按现状、待办、未来规划和接手说明分工；本地恢复资料单独归档。

本次验证覆盖本地包、文本与隔离辅助脚本检查。真实 Claude Code / Codex、用户配置安装、原生 Linux 和 Grok Build 验证保持 `DEFERRED_NOT_RUN`，等待可用验证窗口。

## 安装

在 `~/.claude/settings.json` 的 `extraKnownMarketplaces` 中添加：

```json
"dw-marketplace": {
  "source": { "repo": "JocuperDARY/dw-marketplace", "source": "github" }
}
```

然后：

```bash
/plugin install development-workflow@dw-marketplace
/plugin install gpt-bridge@dw-marketplace
```

### gpt-bridge MCP 注册

```bash
claude mcp add gpt-bridge -- node \
  ~/.claude/plugins/cache/dw-marketplace/gpt-bridge/*/plugins/gpt-bridge/index.js
```

## 从旧版迁移

旧版 `development-workflow-skill@development-workflow-skill-marketplace` 用户：

1. 替换 `extraKnownMarketplaces` 中的 marketplace source 为 `JocuperDARY/dw-marketplace`
2. 替换 `enabledPlugins` 键为 `development-workflow@dw-marketplace`
3. 将插件更新到当前的 5.6.0 版本

5.1.0 新增 `dw-collaboration`。它先检查当前工具是否能够创建子 agent、收集结果、双向通信和管理资源，再选择协作方式。

5.2.0 为 `dw-collaboration` 增加三个不依赖第三方包的 CommonJS 模块：逐项登记并核对任务产生的子 agent、进程、终端、端口、临时空间和受限计算；同一失败重复时先总结原因和现状，只允许一次有证据、有明确停止条件的下一步；根据 CPU、内存、I/O、GPU 和预计时间安排并行工作。资源状态和历史记录必须一起成功或一起失败；临时目录检查、失败预算持久化和任务授权都由宿主管理的接口确认；队列只接受已经绑定到真实资源的任务，并在实际启动前重新检查这些资源。GPU 显存占用和实际计算利用率在有界时间窗内分别统计，85% 只作为条件允许时的优化目标；判断依据是持续利用率和实际计算量。付费模型询问列为后续可选方案，5.2.0 不提供该能力。

5.2.1 对资源回收规则增加了观察门控和状态证据要求，并同步发布元数据与测试契约。

5.4.0 候选补充面向用户的中文说明规则：报告先写当前状态、已完成动作和证据，再写尚缺证据、下一步和授权；普通说明少用否定式、对照句和抽象词。正式状态值、路径、哈希、schema 和安全要求保持原样。文本规范与 Windows、Linux、Claude/Codex 的真实组合验证必须分别进行；对于本候选，Linux、Claude/Codex 及运行时验证仍为 `NOT_RUN` 或 deferred。

5.4.1 作为 5.4.0 合并后的补丁版本，补充版本迭代规则：每个独立 PR 在合并进入 master 前，为受影响插件选定一次版本；版本更新属于这次变更的一部分。文档、测试和小修正至少递增 PATCH，功能新增递增 MINOR，不兼容变更递增 MAJOR；同一 PR 含多种类型时取最高级别，多个插件分别判定；只更新一个插件时，其他插件沿用原版本。插件发布元数据、README、测试断言和本次变更记录中的版本号保持一致，总纲的 3.x 方法论版本独立维护。

铁律 B6 已简化为“重要修改的记录与恢复”：通过 Git 历史与 diff 追踪源码修改；提交历史无法恢复的独有内容按需备份；沿用已有授权，并根据具体影响选择检查与审查。

### 5.0.0 钩子收敛

5.0.0 只注册两个轻量钩子：

- `SessionStart`：识别真实项目边界并只读选择相关规则
- `UserPromptSubmit`：仅对高置信度开发意图提示对应 DW skill

工具清单改为显式按需运行，不再在会话启动时构造推测性的 MCP/skill 列表：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/tool-inventory.js" --json
```

该清单读取配置，记录来源和项目作用域；`configured` 不证明当前会话的工具已连接或可调用。只有显式 `--write-cache` 才写配置盘点缓存。技能发现、规则选择/迁移和结构检查的职责见 [dw-tooling](./plugins/development-workflow/skills/dw-tooling/SKILL.md)。

维护插件时，可在插件目录执行只读检查：

```bash
npm run check:skills
```

它校验 Skill 元数据、导航与本地引用、显式路由目标、发布清单及全部 `.test.js` 的入口登记。不会修改源码、替用户作授权决定或检查写作风格。`npm run test:package` 另外生成实际 npm 归档，在隔离目录离线安装后运行包内测试，防止清单存在但文件未实际发布。

路由只给出建议，保留两个 advisory hooks。全部 14 个 Skill 支持显式名称；总纲与快速参考主要通过显式调用使用。领域提示资料已归入 [dw-reference](./plugins/development-workflow/skills/dw-reference/references/domains.json)，不再声明为运行中的 Layer 3 自动注入。

旧版 `prune-rules.js` 已移除。运行时选择器不会修改用户规则；若需要把活跃语言规则
移出自动加载目录，必须先审阅只读迁移计划：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --dry-run
```

计划无冲突并取得用户明确同意后运行 `--apply`。原目录保存在
`~/.claude/rules-archive/<migration-id>/`，不会被删除。
旧仓库 [JocuperDARY/development-workflow-skill](https://github.com/JocuperDARY/development-workflow-skill) 保留归档。

### Windows 与平台验证

在插件目录先运行核心检查，再根据当前主机运行适用的平台套件；各主机的结果分别记录：

```bash
npm run test:core
```

按主机执行对应命令（PowerShell 示例）：

```powershell
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  npm run test:platform:windows
} elseif ($IsLinux) {
  npm run test:platform:linux
} else {
  Write-Error "Unsupported host: platform suite is NOT_RUN"
  exit 2
}
```

Windows 运行会记录 `LIFECYCLE_RAN` 或 `SKIP_NOT_APPLICABLE`。Windows 平台套件所需的 sandbox 或 helper 缺失、不可访问或未获授权时，记录具体原因并标为 `NOT_RUN` 或 `HOLD`；只有 Windows 套件的实际结果可以记录为 Windows 平台通过，核心测试、静态检查、合成 fixture 和其他主机结果分别保留原状态。Linux 原生验收和 Grok Build 验收在计划/TODO 中单独记录为 `NOT_RUN` 或 `deferred`，各自等待对应环境的验证结果。

### 证据状态说明

`IMPLEMENTED` 只表示代码或文本已写入；`PASS_STATIC` 表示结构和相关静态检查通过；`PASS_FOCUSED` 表示指定焦点测试通过；`VERIFIED` 需要对应功能的运行时与独立读回证据；`VERIFIED_DEGRADED` 表示已验证但能力受限；`UNVERIFIED`、`NOT_RUN`、`FAIL` 和 `HOLD` 保留原因，并按原状态记录。

`TaskResourceManager`、tracker、recovery store 和验证器已作为库交付；其完整协议仍没有通用 Windows/Linux 或 Claude/Codex/Grok 的生产平台 adapter。5.6.0 的 Windows stdio 监管器是单独的窄入口，具有真实隔离进程测试；它不提供完整 manager 的恢复、存储和队列适配。manager 的 fake adapter 测试与监管器的实际进程测试分别计证。managed 模型路由要求宿主提供可信的模型映射和允许组合；它不调用模型，也不证明实际 dispatch 的模型。

更新检查工具有独立的 Windows Job Object 命令后端，仅用于约束它自己启动的检查命令及 Job 内后代，不替代完整 manager adapter。无法建立或确认命令归属时报告 HOLD；POSIX 外部命令检查尚无等价后端，保持 HOLD/NOT_RUN，本地文件审计仍可运行。Windows 监管器的验收覆盖本地隔离 fixture；原生 Linux、Grok Build、真实 Claude/Codex 插件加载和用户配置切换另行验收。

## 许可

Apache License 2.0


5.3.0 合并了 dw-handoff 与 dw-collaboration。当前交接说明覆盖目标、起点、过程、结果与 TODO；协作按任务需要选择宿主工具或完整资源管理协议。
