# 根据本机 DSH 插件选择能力

`dsh_capabilities` 读取本机 `.dsh/profiles/{desktop,web}/package.json` 和对应已安装包的 `package.json`，返回版本、用途及建议。它不执行插件入口，不解释可能含 JavaScript 的 Cordis 配置，不读取桌面凭据。`declaredBundle` 仅表示配置声明；`activation: not_verified` 和 `workerLoaded: false` 不能当作已启用证据。

新任务默认 native profile。只读选择 skills/files；workspace-write 可用 skills/files/shell/teams。nativePlugins 选择子集，空数组仅关闭这些原生扩展，仍保留 bridge_* 文件工具。inference-only 不加载工具。

| 能力 | 适配与证据 |
| --- | --- |
| Skills Manager / DSH skills | 官方 registry + filesystem provider；安装了 Skills Manager 时挂载其导出 provider，无管理 UI。先搜原生元数据、再按需加载正文；补充 Codex 来源必须先完成原生搜索并说明不适用理由。记录搜索、来源、哈希和加载证据；不等于已正确应用。 |
| files | 两种 access 都采用 bridge_list/read，workspace-write 另有 bridge_write 与受保护的单文件字面 ops_replace。任务工作区相对路径、已知 protected-name、链接拒绝、整文件哈希/CAS和备份统一复用 WorkspaceFiles；不挂载原始 dsh-ops file 组件。 |
| dsh-ops | 仅用于可用的 Windows Shell runtime 选择；原始 inspect/glob/grep/replace 不暴露给 native 任务。注册与成功执行仍分别记录。 |
| Shell | 官方 PowerShell 沙箱与 job_list/output/kill；仅 workspace-write。移除凭据环境后执行。注册不等于命令成功，命令可能失败或转后台 job，交付前必须确认状态。 |
| Agent Teams | 安装的团队插件使用官方 in-process 子智能体，@deepseek-ai peer 统一到锁定 SDK。父子调用经过共享计数器；状态目录为 .agent-teams-bridge/<taskId>，不复用桌面对话。独立调用 ctx.llm 之外客户端的任意第三方代码不在保证内。 |
| 原生压缩 | automatic 原生会话使用官方 compaction-basic；辅助模型请求共享计数和明确上限。budgeted 模式以持久检查点阶段替代；single-request 禁止压缩。 |
| Mnemon、Office、UI、自动化、归档 | 未自动适配，仍需按具体服务契约审查；不因已安装而自动宣称可用。 |

提交固定 profile 摘要，启动核对入口哈希和实际工具。回执分别提供 registeredTools、usedTools、toolOutcomes、skills 和 contextStrategy。工具 returned 不等于业务成功，加载技能不等于正确执行；parentAcceptance 始终独立。原生工具的访问策略与结构限制、SDK 有限默认值见 remainingImplementationConstraints；父任务应使用隔离工作区并核验全部副作用。

文件选择不是 host-scope opt-in：`nativePlugins: ["files"]` 仍只给受保护的 bridge 文件能力。read-only 不含 `ops_replace`；workspace-write 的同名工具是 bridge 适配器，必填 `path/pattern/replacement/expectedSha256`，仅单个既有 UTF-8 文件的大小写敏感字面替换。256 KiB 为已有文件上限，哈希覆盖完整文件；拒绝目录、外部绝对/父路径、已知保护名称、链接文件，拒绝 regex/glob/recursive/dryRun 参数。工作区外 tmpdir 也不作为写入根。SDK 进程 cwd 保持私有 worker home，现有 HarnessClient 初始化则明确传入 task.workspace 作为会话 cwd；这些文件工具仍独立按 task.workspace 解析。此修复不改变上述 cwd 设置或 Shell/Team 状态配置。

安装齐全的本机组合中，read-only 为 4 个工具（两个 bridge 文件工具、两个技能工具）；workspace-write 为 24 个（另含 bridge_write、受保护 ops_replace、四个 Shell/job 与十四个 Team 工具）。缺少可选组件时以解析回执为准，启动必须与 expectedTools 精确一致。离线 native 初始化和组件级文件探针分别验证注册与边界，不冒充真实模型工具循环或团队执行。

## 原生工作区与来源诊断

Windows 原生 Shell 会检查目录所有者是否为 MCP 工作者账户。Codex 沙箱创建的目录可能属于另一个 Windows SID；能读写文件不代表有权替它准备 Shell 沙箱。`dsh_prepare_workspace({workspace: "<现有父目录下的新目录绝对路径>"})` 是零模型调用：只创建一个新目录，不接管已有目录、不修改其所有权/ACL、不创建状态锁，并拒绝 junction/symlink 祖先及 Bridge 状态目录重叠。该工具不接受已存在的目标；收到不确定结果时先核对工件，不盲目换路径重试。将返回路径用于新任务。真正执行 Shell 时，官方沙箱仍可能为这个新工作区添加自身的隔离访问授权；prepare 的成功不等于 Shell 已执行。

技能搜索保留官方 preset、filesystem 和 Skills Manager 来源，并记录安装来源还是 Bridge 锁定 SDK 的回退来源。`total` 是查询匹配数，目录总数及来源状态单独返回；`no_matches`、目录 `empty` 和来源 `incomplete/unavailable` 不得混为一谈。支持 `query: "*"` 分页盘点元数据；扫描器可能读取技能文件解析元数据，但只在加载选定技能时把正文返回模型。来源诊断不读取桌面密钥或执行 Cordis 配置。

`searchCompleted` 表示本次搜索已返回，`complete` 表示所选来源类别的目录覆盖已获确认。Skills Manager 未导出可靠的嵌套扫描错误/截断诊断时，非空来源根的覆盖保持未确认，搜索结果为 `incomplete`，不能因零匹配宣称库为空。已返回的原生搜索即使覆盖不完整，也允许说明不适用或不可用原因后搜索补充来源；这不把原生覆盖改写为完整。搜索过程直接失败且未返回结果时不满足这一步。

`toolOutcomes` 分别记录 attempted、returned、error、unobserved。SDK 在准备/调度失败时可能没有 post-execute 回调，因此 unobserved 不能由 Bridge 自动解释为成功或失败；必须结合实际工具错误和任务证据判断。

## 显式本机配置

默认配置文件在 Windows `%LOCALAPPDATA%\DeepSeekHarnessBridge\config.json`，其他系统在 `~/DeepSeekHarnessBridge/config.json`。可用 `DSH_BRIDGE_CONFIG_DIR` 指定绝对目录。此文件是操作者维护的受信任配置，不从任务工作区加载，不放 API Key。

示例（路径及哈希必须替换成实际审查过的文件）：

```json
{
  "nodePath": "C:\\path\\to\\node.exe",
  "inventoryHome": "C:\\Users\\you\\.dsh",
  "capabilityProfiles": [
    {
      "id": "docs-review",
      "access": "read-only",
      "skills": [{"path": "C:\\reviewed-skills\\docs\\SKILL.md", "sha256": "<64 lowercase hexadecimal characters>"}]
    },
    {
      "id": "reviewed-search",
      "access": "read-only",
      "fileTools": true,
      "modules": [{
        "path": "C:\\reviewed-adapter\\index.js",
        "sha256": "<64 lowercase hexadecimal characters>",
        "tools": ["scoped_search"],
        "config": {"limit": 20}
      }]
    }
  ]
}
```

每个 module 是兼容锁定 SDK 的 Cordis 服务端插件入口，支持 `name`、`inject` 和 `apply(ctx, config)`。桥接额外传入 `workspace`、`access`，不允许配置覆盖它们。工具名必须精确声明；最多 8 个模块、32 个额外工具、4 个技能，每个技能最多 8 KiB。技能正文进入模型上下文，仍服从任务范围和现有工具权限。

自定义 profile ID 必须唯一，不能使用内置的 `native`、`files` 或 `inference-only`。工作者内部生成的 Node preload 会对加载器实际返回的入口源码计算哈希，并把同一份字节交给运行时执行，防止检查后替换入口。原模块 URL 保留，因此相对依赖和包依赖仍按原位置解析；加载器不能提供可校验源码的格式会被拒绝。外部 `NODE_OPTIONS` 不会传入工作者。

调用 `dsh_submit` 时设置 `capabilityProfile: "docs-review"`。提交记录 profile digest；启动和每次续接重新检查配置及文件哈希，变化时拒绝执行。启动后核对实际注册工具名集合和预算闸门回执，再允许模型请求。未加载、意外多出的工具或不匹配的权限不会静默降级。

**自定义模块属于受信任代码，不是沙箱内的提示词。** 模块及其依赖必须经过审查；入口哈希不证明整个依赖树的安全性。模块应遵守工作区权限，不在初始化时发请求，不另建模型客户端/子进程，不直接绕过 `ctx.llm`。预算钩子覆盖当前运行时经 `ctx.llm` 的请求，不能约束任意第三方代码自行发送的网络请求。第三方工具自行负责其路径和副作用约束；内建文件保护不能自动套用到第三方实现。新增模块须先做零模型初始化和适当的工具验证，再用于有界真实任务。

本版本提供上述盘点、选择、挂载与核对机制；测试中的 headless fixture 验证机制本身。并未宣称本机所有第三方插件已经适配或通过真实任务验证。
