# 根据本机 DSH 插件选择能力

`dsh_capabilities` 读取本机 `.dsh/profiles/{desktop,web}/package.json` 和对应已安装包的 `package.json`，返回版本、用途及建议。它不执行插件入口，不解释可能含 JavaScript 的 Cordis 配置，不读取桌面凭据。`declaredBundle` 仅表示配置声明；`activation: not_verified` 和 `workerLoaded: false` 不能当作已启用证据。

默认 `files` 提供有界文件工具。纯文本转换、短答案或连接测试选择 `inference-only`，不发送文件工具 schema。只有需要其他能力时，才选择经过配置和审查的 profile；省下不相关的工具声明、技能上下文和额外模型调用。

| 已安装能力 | 委派方式 |
| --- | --- |
| Skills Manager | 只选与任务有关的 1–4 个 `SKILL.md`，作为参考上下文。无需启动管理界面。 |
| Ops 文件检索 | 校验路径限制和输出界限后，在独立 profile 中挂载其 headless 工具入口。不要同时打开 shell/background。 |
| Mnemon | 只挂载所需的 headless 检索源，限制作用域；不自动复制桌面全部记忆或远端凭据。 |
| Agent Teams | 当前保持 Codex 统一调度。第三方团队插件可能创建独立进程、自己的模型客户端，不能用当前单进程计数器保证整个团队预算。 |
| Office | 文档任务才选择对应适配器；先验证服务依赖。桌面插件已安装不代表 `sdk-minimal` 能加载它。 |
| Context、Cost Meter | 盘点可见；桥接本身返回请求/usage 回执，无须为短任务加载 UI。统计插件不等同于预算闸门。 |
| 压缩、自动化、归档、挂件 | 默认留在桌面端。自动压缩可能产生额外调用，自动化超出单次任务生命周期。 |

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

自定义 profile ID 必须唯一，不能使用内置的 `files` 或 `inference-only`。工作者内部生成的 Node preload 会对加载器实际返回的入口源码计算哈希，并把同一份字节交给运行时执行，防止检查后替换入口。原模块 URL 保留，因此相对依赖和包依赖仍按原位置解析；加载器不能提供可校验源码的格式会被拒绝。外部 `NODE_OPTIONS` 不会传入工作者。

调用 `dsh_submit` 时设置 `capabilityProfile: "docs-review"`。提交记录 profile digest；启动和每次续接重新检查配置及文件哈希，变化时拒绝执行。启动后核对实际注册工具名集合和预算闸门回执，再允许模型请求。未加载、意外多出的工具或不匹配的权限不会静默降级。

**自定义模块属于受信任代码，不是沙箱内的提示词。** 模块及其依赖必须经过审查；入口哈希不证明整个依赖树的安全性。模块应遵守工作区权限，不在初始化时发请求，不另建模型客户端/子进程，不直接绕过 `ctx.llm`。预算钩子覆盖当前运行时经 `ctx.llm` 的请求，不能约束任意第三方代码自行发送的网络请求。第三方工具自行负责其路径和副作用约束；内建文件保护不能自动套用到第三方实现。新增模块须先做零模型初始化和适当的工具验证，再用于有界真实任务。

本版本提供上述盘点、选择、挂载与核对机制；测试中的 headless fixture 验证机制本身。并未宣称本机所有第三方插件已经适配或通过真实任务验证。
