# DeepSeek Harness Bridge 0.1.1

让 Codex 将范围明确的工作委派给独立的 DeepSeek Flash 工作者，再收回结果、检查证据并继续主任务。插件作为 DW Marketplace 的独立条目发布，不改变 development-workflow 或 gpt-bridge 的版本。

```mermaid
flowchart LR
  C[Codex 主智能体] <-->|MCP stdio| B[本地桥接器]
  B <-->|官方 Harness SDK / JSON-RPC| W[独立 Harness 工作者]
  W <-->|官方 DeepSeek API| F[DeepSeek Flash]
  W --> T[有界文件工具]
  B --> S[任务状态与结果]
```

这里的“调用 Harness”是通过官方 SDK 启动其独立运行时。插件不控制桌面窗口，不接管已有桌面会话，也不读取桌面保存的登录凭据。需要为 MCP 进程单独配置 API Key。桌面应用无需保持打开。

## 安装与配置

先准备 **Node.js 24.18+** 和 npm。插件源码市场安装不会自动执行 npm；首次安装或更新后，需要在**实际安装的插件目录**安装依赖。不要在未确认的缓存版本中操作。

```sh
npm ci --ignore-scripts --no-audit --no-fund
node launch.js --doctor
```

依赖通过 `npm-shrinkwrap.json` 锁定。官方 SDK 固定为 `@deepseek-ai/dsh-sdk-client@0.2.1-rc.2`，它加载同版本 `@deepseek-ai/dsh`。不使用 npm 的可漂移 latest 标签，不在启动时自动下载安装。`--doctor` 即使缺少依赖也可输出诊断，但退出码 0 只表示诊断运行完成；请检查 Node 支持和依赖状态。

在 Codex 中添加或刷新 `JocuperDARY/dw-marketplace`，安装 `deepseek-harness-bridge`，运行插件的 `deepseek-setup` 技能。市场沿用仓库的 `.claude-plugin/marketplace.json`；Codex 使用插件自身的 `.codex-plugin/plugin.json`，其中声明本地执行需求、技能和 MCP 入口。也保留 Claude 兼容清单；真实宿主支持分别验证。

支持插件管理命令的 Codex CLI 可在版本发布到市场后使用：

```sh
codex plugin marketplace add JocuperDARY/dw-marketplace
codex plugin add deepseek-harness-bridge@dw-marketplace
```

本地候选测试可将第一条的来源替换为本地市场仓库的绝对路径。请从安装返回信息确认真实插件目录，再在该目录执行 npm ci；不要把源码目录的 node_modules 当成已安装副本的依赖。

MCP 入口使用 `node launch.js`。本机 `config.json` 的 `nodePath` 可指定现有 Node 24.21，由启动器重新执行，无须修改系统 PATH。Windows 可用包内脚本将 API Key 加密保存，详见 [Windows 安装和凭据配置](docs/windows-setup.md)。不要把 Electron 桌面主程序当成 Node。

| 环境变量 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 由用户在 MCP 进程环境配置；不要放进聊天、仓库、工具参数或共享配置。 |
| `DSH_BRIDGE_CONFIG_DIR` | 本机配置目录；默认 Windows LocalAppData/DeepSeekHarnessBridge，其他系统 ~/DeepSeekHarnessBridge。 |
| `DSH_BRIDGE_DATA_DIR` | 建议显式设置的绝对状态目录，必须与每个任务工作区互不包含。 |
| `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` | 未指定状态目录时优先使用的宿主数据根；其下建立 `.deepseek-harness-bridge`。均未提供时使用用户目录下同名子目录。 |

同一数据目录只允许一个桥接进程，并且同一进程只运行一个 Flash 任务。若宿主对不同聊天启动独立 MCP 进程，应配置不同的数据目录。安装、配置和已连接是三个不同状态；以目标聊天实际列出并可调用 `dsh_doctor` 为连接证据。

## 使用

在已授权 DeepSeek 委派的主任务中调用 `deepseek-delegate`，或让 Codex 按以下工具流程执行。子任务 prompt 包含目标、相关上下文、文件归属、完成条件和所需证据；完整聊天不会自动同步。

调用授权由 Codex/MCP 宿主与主智能体依据用户指令执行。插件不提供独立的用户身份认证或付费许可服务；API Key 存在、插件已安装、模型填写“已批准”均不是用户授权证明。宿主应核对工作区、数据发送、所选能力和预算范围，已有明确授权可在该范围内持续执行。

| MCP 工具 | 作用 |
| --- | --- |
| `dsh_submit` | 提交新任务，立即返回 taskId；同 requestId 和同输入不会重复启动。 |
| `dsh_status` | 查询某次执行状态、终止原因和清理结果。 |
| `dsh_list` | 按最近一次执行的开始时间列出最多 50 项任务，便于恢复 taskId。 |
| `dsh_wait` | 等待最多 30 秒并返回简短状态。 |
| `dsh_result` | 按页读取最终或失败结果；用 nextOffset 继续。 |
| `dsh_continue` | 已完成任务继续同一个 Harness 会话，创建新的 attempt。 |
| `dsh_cancel` | 关闭该任务的 SDK 运行时，确认清理；保留部分修改。 |
| `dsh_doctor` | 检查配置和依赖，不调用模型，也不输出密钥。 |
| `dsh_capabilities` | 只读盘点已安装 DSH 包和显式配置的能力 profile；按任务选择最小能力集合。 |

示例任务参数，工作区应替换成实际存在的独立目录：

```json
{
  "requestId": "docs-review-001",
  "workspace": "D:\\worktrees\\docs-review",
  "prompt": "检查 docs/ 中的接口说明是否与 src/ 一致。仅阅读文件，返回差异、文件路径和证据。其他智能体可能同时工作，不修改或覆盖他们的内容。没有执行测试时明确说明。",
  "access": "read-only",
  "effort": "high",
  "timeoutMs": 300000,
  "maxTokens": 8192,
  "maxToolCalls": 32,
  "maxModelRequests": 16,
  "maxRequestBytes": 262144,
  "capabilityProfile": "files"
}
```

主智能体收到 taskId 后继续独立工作，随后等待和取回结果。插件不主动向 Codex 聊天发送消息，也不能唤醒已经结束的主回合。v0.1.1 不支持执行中插入消息；成功结束后可以续接，急需改方向时取消并提交明确的新任务。

插件固定路由为 `deepseek-official / deepseek-flash`。锁定 SDK 的模型目录将此别名标为 DeepSeek-V4.1-Flash；服务端别名的实际版本仍以服务提供方为准。支持 high / max，默认 high；不切换到其他模型，不修改宿主自动模型白名单。模型能力、200 tok/s 和整体加速效果需要真实任务测量，本插件不预设这些结论。

## 工作区、预算和状态

默认 `files` profile 的 read-only 提供 `bridge_list`、`bridge_read`。workspace-write 增加 `bridge_write`，覆盖需提交刚读到的 sha256，并备份原内容；创建使用 `expectedSha256: "new"`。`inference-only` 不加载文件工具。默认不提供删除、创建目录、终端、联网工具、测试执行或子智能体；由主智能体完成这些操作。

已有 dsh 插件可通过显式本机 capability profile 选择经过审查的 headless 模块和少量技能。按安装版本盘点、提交时固定配置摘要、每次启动验证文件哈希及实际工具集合。不会因桌面“已安装”就自动挂载整套插件。适配方式和第三方代码边界见 [能力选择](docs/capabilities.md)。

文件工具限制为单目录最多扫描 1000 个条目、单个 UTF-8 文件/写入最多 256 KiB，拒绝路径穿越、符号链接、junction、硬链接文件和常见配置/凭据目录。过滤路径不是任意秘密内容识别器；任务工作区只应包含允许发送给 DeepSeek 的资料。该边界由工具代码实施，不是操作系统沙箱，也不能抵御其他本地进程恶意并发替换路径。写任务使用独立副本或 worktree，避免两个工作者同时写同一文件。

读取按最多 16384 个 UTF-16 字符分页，`sha256` 覆盖完整文件，`nextOffset` 指示下一页；任务累计历史仍受请求字节预算约束。写入先完成同目录临时文件，再原子发布；同一工作区的桥接写入方共享 `.dsh-bridge-write.lock`。锁不会自动抢占，异常退出后须核实现场再处理。该锁不约束外部编辑器或第三方工具，哈希检查与发布也不是针对所有进程的通用 CAS；文件归属和独立副本仍必需。

默认时限 5 分钟，范围 1 秒至 30 分钟；maxToolCalls 默认 32（0–128），maxTokens 每请求默认 8192（256–32768）；maxModelRequests 每次 attempt 默认 16（1–128），maxRequestBytes 默认 262144（1024–1048576）。模型请求进入 adapter 前受次数、路由、字节数和输出配置约束，初始化阶段禁止付费调用。状态返回逐调用 provider usage，未知时为 null。maxTokens 不是任务总 token 或金额上限，输入字节也不是精确 token 数。自动重试、标题请求和自动压缩关闭；取消后的 SDK 清理可能多用数秒。每项任务最多 16 次 attempt；续接会重新获得该 attempt 的预算，必须在已有授权内。状态最多 1000 项任务；prompt 最多 64 KiB，结果最多 1 MiB，单页最多 32000 个 UTF-16 code units。

只有当前 prompt 的 durable inbox 回执、`session/wait`、`turn/end: completed`、非空结果和已确认的进程退出都成立时，才报告 completed。parentAcceptance 始终由主智能体另行判断。max-tokens、缺少 terminal、SDK 错误、超时和取消均保留为非成功；不自动重试。取消不会回滚已完成的文件写入。

任务元数据与结果写入状态目录；Harness 在每项任务的隔离 home 中保存会话历史和工具记录，方便成功后的续接。不要把该目录提交到仓库或随插件打包。桥接器不把原始 provider stderr 返回给模型；错误使用固定类别。MCP 的配置诊断成功不等于 API Key 有效或付费推理成功。

## 异常退出与恢复

正常关闭会先取消活动任务、等待 SDK 进程退出，再释放 owner.lock。无法确认清理或写入失败时保留锁并阻止新任务。已有锁不会因为 PID 不存在就被自动删除。

发生 STATE_LOCKED / RECOVERY_REQUIRED 时，保留状态目录，检查是否还有桥接进程及其所属 Harness 运行时；先核实进程身份并完成清理，必要时由操作者归档整个状态目录。确认旧资源均已停止后再建立新的数据目录继续。不要把删除锁当成自动修复。旧结果仍可由操作者从 task.json 和 result-N.txt 取回；未完成任务不得自动续跑。

## 验证和维护

```sh
npm test
```

测试覆盖任务持久化和幂等、并发限制、续接、超时/取消、失败清理、路径边界、真实 MCP 客户端、官方 SDK 与本地假运行时通信，以及已安装官方运行时的无模型初始化。所有测试都不发起模型推理；SDK 初始化测试只使用不可用的占位凭据。应分别记录付费 Flash 调用、真实 Codex 安装/加载和各操作系统的验证结果。

设计契约见 [docs/design.md](docs/design.md)。官方参考：[Harness SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)、[Codex 插件打包](https://developers.openai.com/plugins/build/plugins)、[本地 MCP 插件](https://developers.openai.com/plugins/deploy/desktop-only)。
