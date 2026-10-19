# 根据本机 DSH 插件选择能力

`dsh_capabilities` 读取本机 `.dsh/profiles/{desktop,web}/package.json` 和对应已安装包的 `package.json`，返回版本、用途及建议。它不执行插件入口，不解释可能含 JavaScript 的 Cordis 配置，不读取桌面凭据。`declaredBundle` 仅表示配置声明；`activation: not_verified` 和 `workerLoaded: false` 不能当作已启用证据。

新任务默认 native profile。只读选择 skills/files；workspace-write 可用 skills/files/shell/teams。nativePlugins 选择子集，空数组仅关闭这些原生扩展，仍保留 bridge_* 文件工具。inference-only 不加载工具。

| 能力 | 适配与证据 |
| --- | --- |
| Skills Manager / DSH skills | 官方 registry + filesystem provider；安装了 Skills Manager 时挂载其导出 provider，无管理 UI。先搜原生元数据、再按需加载正文；补充 Codex 来源必须先完成原生搜索并说明不适用理由。记录搜索、来源、哈希和加载证据；不等于已正确应用。 |
| dsh-ops | Windows 原生文件工具及可用的 Shell runtime 选择；实际注册、调用与结果分别记录。第三方文件工具保留 DSH 原生策略，不能声称自动继承 bridge_* 的逐文件哈希/CAS或凭据名称过滤。 |
| Shell | 官方 PowerShell 沙箱与 job_list/output/kill；仅 workspace-write。移除凭据环境后执行。注册不等于命令成功，命令可能失败或转后台 job，交付前必须确认状态。 |
| Agent Teams | 安装的团队插件使用官方 in-process 子智能体，@deepseek-ai peer 统一到锁定 SDK。父子调用经过共享计数器；状态目录为 .agent-teams-bridge/<taskId>，不复用桌面对话。独立调用 ctx.llm 之外客户端的任意第三方代码不在保证内。 |
| 原生压缩 | automatic 原生会话使用官方 compaction-basic；辅助模型请求共享计数和明确上限。budgeted 模式以持久检查点阶段替代；single-request 禁止压缩。 |
| Mnemon、Office、UI、自动化、归档 | 未自动适配，仍需按具体服务契约审查；不因已安装而自动宣称可用。 |

提交固定 profile 摘要，启动核对入口哈希和实际工具。回执分别提供 registeredTools、usedTools、toolOutcomes、skills 和 contextStrategy。工具 returned 不等于业务成功，加载技能不等于正确执行；parentAcceptance 始终独立。原生工具的访问策略与结构限制、SDK 有限默认值见 remainingImplementationConstraints；父任务应使用隔离工作区并核验全部副作用。

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
