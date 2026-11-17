# DW 自动化覆盖与执行边界

本页说明 5.9.0 的脚本实际负责什么，以及哪些判断仍由执行者负责。范围包括全部 14 个 Skill、8 份规则、hooks 与 Skill scripts 下的 25 个生产源码，以及测试入口。逐文件归属、约束类型与测试登记见 [机器可读清单](automation-coverage.json)。清单登记完整不等于行为覆盖完整，也不代表测试已经执行。

## 按职责查看

| 职责入口 | 可自动检查或执行的部分 | 需要判断或另行接通的部分 |
|---|---|---|
| development-workflow | 会话 hook 提取上下文；路由 hook 建议入口；规则迁移有预检和回退 | 授权范围、风险和是否需要某阶段；hook 不拦截后续操作 |
| dw-diagnosis | 复用日志、测试结果和有界工具盘点 | 问题定义、因果解释、会话证据是否充分 |
| dw-planning | 协作契约可检查依赖、写域、预算字段和状态 | 方案取舍、问题依赖的含义、何时足以执行 |
| dw-implementation | 注册测试检查具体行为；必要时调用已有资源后端 | 不强制所有文字修改 TDD，不以测试数量代替正确性 |
| dw-debugging | 回归样例、失败循环记录及有界等待能力 | 根因与相关性区别；不按固定失败次数断言架构错误 |
| dw-verification | 测试运行器记录 pass/fail/skip/not-run；Windows 测试命令经私有 Job 回收；证据工具检查结构与关联 | 结果能否支持声明、其他平台的回收证据、真实宿主验收 |
| dw-wrapup | 复用 Git 状态、差异、测试和发布工具 | 提交/合并/清理是否在授权内，独有数据是否已保护 |
| dw-handoff | 复用文件与 Git 记录、必要时保存一次恢复副本 | 事实/待办/取舍归档及恢复可用性；不普遍要求全树哈希 |
| dw-writing | 可复用链接和格式检查 | 术语、重复、证据强度、读者是否能理解；无词表式硬门禁 |
| dw-optimization | 已有基准与资源观测可提供测量 | 样本代表性、等价性与收益判断 |
| dw-collaboration | 契约、资源跟踪、队列决策、失败循环、Windows 命令后端与 manager adapter | 普通宿主协作不强制完整协议；队列自动派发、临时目录及其他平台适配仍需实现 |
| dw-tooling | 结构、路由目标、源码登记、测试登记与打包声明检查 | 已登记不等于已加载、可调用或验证通过 |
| dw-reference | 结构检查可验证相对引用 | 内容归属和是否过时；参考页不成为新的审批层 |
| check-updates | 版本/配置读取、报告、Windows 有界命令执行 | 不安装升级；非 Windows 外部命令保持 HOLD，原生验证待办 |

规则复用对应职责，不另外实现相同的审批或凭证链。两个已注册 hook 是 SessionStart 和 UserPromptSubmit，均提供提示；没有把提示内容当作不可绕过的执行层约束。

## 任务分配、子进程与回收

这三件事已有不同层次的实现，不应合称“所有任务自动托管”：

1. **任务与资源数据。** 契约校验器检查已声明身份、写域、预算和能力。TaskResourceTracker 跟踪 scope、绑定与释放证据；只知道调用者提交且可信观察者认可的资源，不会自行发现所有 OS 进程。
2. **队列决策。** ResourceAwareQueue 按依赖、容量和授权回调返回 START_WORK 等决定，维护 draining 和 release 状态。它不调用宿主 spawn，也不把返回的决定自动变成真实执行；调用方要处理启动失败，并凭 tracker 的关闭结果确认回收。一次调度使用同一份隔离的观测快照。
3. **管理器。** TaskResourceManager 将启动、观察、停止、清理交给注入的 adapter，并保留未完成状态。Windows 命令 adapter 已将这些调用接到 native supervisor，并绑定实际身份与释放证据。管理器本身不限制任意第三方 adapter；只有经此后端的命令拥有独立于 JavaScript 等待的原生截止时间。没有有效启动身份时，manager 保留 HOLD。
4. **Windows 进程入口。** DwProcessSupervisor 的 managed 模式以私有控制管道提供启动身份、观察、停止与释放；原生截止时间、输出总额和 Job 限定其副作用。更新检查另有 bounded-command-windows.ps1。各入口只拥有自己新建的进程树，没有自动接入所有宿主会话，也不按进程名扫描并清理系统。
5. **测试入口。** Windows 通用 test-runner 使用同一 managed 后端，每个测试及其普通后代属于同一 Job。正常根进程退出后也回收残留后代；执行异常停止后续派发。有效原生终态与关闭证据支持已回收，缺失时保留 UNKNOWN；非 Windows 显式 portable-direct 路径保留 UNVERIFIED。marker/PID 扫描仍只用于观察，不能承担生产清理。

普通协作优先使用宿主已有的任务、消息、等待和回收工具；确需跨中断恢复、持久资源或硬资源限制时再接入完整协议。平台没有可靠观察或清理能力时，降低拓扑或保留 HOLD/UNKNOWN，而非伪造完成回执。详见 [普通协作](../../dw-collaboration/references/ordinary-collaboration.md)、[运行时适配](../../dw-collaboration/references/runtime-adapters.md) 和 [资源控制](../../dw-collaboration/references/resource-control.md)。

## 确定性检查如何进入维护

在插件根目录运行 `node skills/dw-tooling/scripts/check-skill-structure.js --json` 或 `npm run check:skills`。检查器验证元数据、引用、脚本打包声明、路由目标和测试入口，并将发现的生产源码与机器清单逐一对照。新增脚本、C# 源码或平台适配器时，补充 owner、约束类型、已注册测试及能力限制；遗漏、重复、悬空条目和无效路径均报错。

这里的 owner 是内容维护归属，不能授权该 Skill 操作机器上的任意资源。enforcement 描述实现方式：

- advisory：提供上下文或建议，不阻止调用方后续动作。
- validation：拒绝不符合数据/结构契约的输入，不执行被描述的任务。
- opt-in-runtime：调用这个入口后才执行其有限副作用；绕过入口的工作不受其约束。

测试路径存在且已登记，只证明维护入口可定位。运行结果、实际 npm 归档、平台行为及宿主激活需要各自的证据。真实 Claude Code/Codex 安装、用户配置、原生 Linux 与 Grok Build 的暂缓不会由静态检查解除。

## 后续自动化的准入

先指出要保护的对象、真正发生副作用的入口、失败时怎样停止/回收，以及能区分正确行为的反例；优先复用已有实现。只有输出可判定、入口可接通且失败语义清楚时才加硬约束。对设计价值、授权语义、因果和写作质量，保留有针对性的审查，不增加固定审批次数、团队人数、全量哈希或重复检查。

本版交付边界见 [Windows 命令 adapter](../../dw-collaboration/references/windows-command-adapter.md)。仍待独立实现和验收：队列到 manager 的自动派发及未启动资源释放契约、临时目录和重连接适配、非 Windows 可靠进程回收、真实宿主接线。不能把当前命令适配扩大为对所有资源、任意 adapter 或全部宿主的保证。
