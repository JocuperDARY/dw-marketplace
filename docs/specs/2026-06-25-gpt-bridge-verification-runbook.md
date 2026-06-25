# gpt-bridge 功能验证操作说明书

> 目标读者：Claude Code 验证执行者。  
> 执行目标：按本文逐项验证 `plugins/gpt-bridge` 的核心功能、错误处理和 Claude Code MCP 集成是否可用。  
> 工作目录：仓库根目录 `development-workflow-skill`。  
> 结果要求：不要只说“看起来可用”。每一项必须记录命令、实际输出摘要和 PASS/FAIL。

## 0. 执行规则

1. 先执行本地可重复验证，再执行真实 Codex/Claude Code 端到端验证。
2. 每个失败项必须记录：
   - 失败命令或 MCP 调用参数
   - 实际错误输出
   - 对应功能项
   - 严重级别：P0/P1/P2/P3
3. 不要跳过 `outputSchema`、`sessionId resume`、`files` 路径安全边界，这三类是重点回归项。
4. 如真实 Codex CLI 因认证、网络、模型权限不可用而失败，标记为 `P3 external blocker`，但本地 fake Codex 测试仍必须完成。
5. 验证完成后，在最后按“验证报告模板”输出结论。

## 1. 验证范围

必须覆盖以下功能面：

| 功能面 | 必测能力 |
| --- | --- |
| MCP 协议 | server 启动、`tools/list`、`gpt` tool 可见 |
| 参数路由 | `model`、`mode`、`profile`、`effort`、`cwd`、`timeout` |
| 上下文注入 | `files`、`autoContext`、`images` |
| 输出协议 | 普通文本、`outputSchema`、`outputFile`、MCP `_meta` |
| 会话能力 | 新建 session、提取 `sessionId`、resume、`ephemeral` |
| 错误路径 | 缺文件、绝对路径、越界路径、profile 冲突、Codex 失败、超时 |

## 2. 环境预检查

在仓库根目录执行：

```powershell
git status --short --branch
node --version
npm --version
Get-Content plugins\gpt-bridge\package.json
```

验收标准：

- 当前目录是仓库根目录。
- Node.js 可以执行 ESM 模块。
- `plugins/gpt-bridge/package.json` 存在，`type` 为 `module`。
- 如工作区已有未提交变更，记录但不要擅自清理。

真实 Codex 冒烟前再执行：

```powershell
codex --version
```

验收标准：

- 能输出 Codex CLI 版本。
- 如果命令不存在，真实 Codex 冒烟项标记为 P3 blocker，本地测试继续。

## 3. 静态与单元验证

执行：

```powershell
node --check plugins\gpt-bridge\index.js
node --check plugins\gpt-bridge\test\gpt-bridge.test.js
node plugins\gpt-bridge\test\gpt-bridge.test.js
```

验收标准：

- 两个 `node --check` 无输出且退出码为 0。
- `gpt-bridge.test.js` 全部通过。
- 当前基线应至少覆盖这些断言：
  - sandbox mode 映射到当前 Codex CLI flags
  - 新建 `codex exec` 不再使用旧 `-p` profile 误用
  - resume 参数顺序正确
  - `ephemeral` 只在显式开启时传递
  - `outputFile` 相对路径在 `cwd` 下保留
  - 缺失显式文件在启动 Codex 前失败
  - 绝对路径 `files` 被拒绝
  - `../` 越界路径被拒绝
  - 项目内 `..not-parent.txt` 这类合法文件名不被误拒绝
  - `autoContext` 遵守数量限制并排除显式文件
  - timeout 返回失败
  - session id 可从 JSONL stdout 或 stderr 提取
  - `continueWith` 是合法 JSON
  - `outputSchema` 返回保留纯 JSON，并把 session 信息放入 MCP metadata
  - MCP server 可通过 stdio 暴露 `gpt` tool

失败分级：

- 语法错误：P0
- fake Codex 测试失败：P0
- 只有某个边界用例失败：按影响分 P0/P1，路径安全和结构化输出一律 P0

## 4. MCP stdio 协议冒烟

执行：

```powershell
@'
const { spawnSync } = require('child_process');

const input = [
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'manual-smoke', version: '0' }
    }
  }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
].join('\n') + '\n';

const child = spawnSync(process.execPath, ['plugins/gpt-bridge/index.js'], {
  input,
  encoding: 'utf8',
  timeout: 3000
});

console.log('exit:', child.status);
console.log('stdout:', child.stdout);
console.error('stderr:', child.stderr);
if (!child.stdout.includes('"name":"gpt"')) process.exit(1);
'@ | node
```

验收标准：

- 退出码为 0。
- stdout 中包含 `"name":"gpt"`。
- `tools/list` 返回 schema 中包含 `prompt`、`sessionId`、`model`、`mode`、`files`、`images`、`outputSchema`、`outputFile`、`systemPrompt`、`cwd`、`timeout`、`effort`、`ephemeral`、`autoContext`、`profile`。

失败分级：

- server 无法启动：P0
- `tools/list` 不含 `gpt`：P0
- schema 缺公开参数：P1

## 5. Claude Code MCP 注册检查

执行：

```powershell
claude mcp list
```

验收标准：

- 列表中存在 `gpt-bridge`。
- 注册命令指向当前仓库或已安装插件中的 `plugins/gpt-bridge/index.js`。

如不存在，注册本地版本：

```powershell
claude mcp add gpt-bridge -- node C:\Users\ljp37\development-workflow-skill\plugins\gpt-bridge\index.js
claude mcp list
```

验收标准：

- 再次 `claude mcp list` 能看到 `gpt-bridge`。

失败分级：

- Claude Code CLI 不存在或无法管理 MCP：P3 external blocker
- MCP 注册成功但后续 tool 不可见：P0

## 6. 真实 Codex CLI 冒烟

本节会调用真实 Codex，可能依赖网络、认证、模型权限和当前 Codex CLI 版本。每项失败必须区分是 `gpt-bridge` 缺陷还是外部 blocker。

### 6.1 基础文本调用

在 Claude Code 对话中要求执行：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答 OK，不要输出其它内容。",
  "mode": "strict",
  "timeout": 120
}
```

验收标准：

- Claude Code 实际调用 `gpt-bridge` 的 `gpt` tool。
- 返回文本包含 `OK`。
- 没有 MCP error。

### 6.2 model/mode/effort 参数

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答 PARAM_OK。",
  "model": "gpt-5.5",
  "mode": "workspace",
  "effort": "low",
  "timeout": 120
}
```

验收标准：

- 返回包含 `PARAM_OK`。
- 没有 Codex CLI 参数错误。

### 6.3 profile 参数

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答 PROFILE_OK。",
  "profile": "fast",
  "timeout": 120
}
```

验收标准：

- 返回包含 `PROFILE_OK`。
- 没有 profile 解析错误。

再验证冲突：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "这个调用应该失败。",
  "profile": "fast",
  "model": "gpt-5.5"
}
```

验收标准：

- 返回 MCP error。
- 错误文本包含 `profile is mutually exclusive with model and mode`。

### 6.4 files 上下文注入

先创建哨兵文件：

```powershell
New-Item -ItemType Directory -Force .tmp\gpt-bridge-smoke | Out-Null
Set-Content -Path .tmp\gpt-bridge-smoke\context.txt -Value "GPT_BRIDGE_SENTINEL_FILES_20260625" -Encoding UTF8
```

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答上下文文件中的 GPT_BRIDGE_SENTINEL_* 值。",
  "mode": "strict",
  "files": [".tmp/gpt-bridge-smoke/context.txt"],
  "timeout": 120
}
```

验收标准：

- 返回精确包含 `GPT_BRIDGE_SENTINEL_FILES_20260625`。

路径安全负例：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "这个调用应该失败。",
  "mode": "strict",
  "files": ["../secret.txt"],
  "timeout": 30
}
```

验收标准：

- 返回 MCP error。
- 错误文本包含 `escapes project root`。
- 不应启动 Codex 执行。

绝对路径负例：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "这个调用应该失败。",
  "mode": "strict",
  "files": ["C:/Users/ljp37/.ssh/id_rsa"],
  "timeout": 30
}
```

验收标准：

- 返回 MCP error。
- 错误文本包含 `Absolute file paths are not allowed`。
- 不应启动 Codex 执行。

### 6.5 autoContext 上下文注入

创建文件：

```powershell
Set-Content -Path .tmp\gpt-bridge-smoke\auto-a.txt -Value "GPT_BRIDGE_SENTINEL_AUTO_A_20260625" -Encoding UTF8
Set-Content -Path .tmp\gpt-bridge-smoke\auto-b.txt -Value "GPT_BRIDGE_SENTINEL_AUTO_B_20260625" -Encoding UTF8
```

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "列出自动收集上下文中所有 GPT_BRIDGE_SENTINEL_AUTO_* 值。",
  "mode": "strict",
  "autoContext": {
    "patterns": [".tmp/gpt-bridge-smoke/auto-*.txt"],
    "maxFiles": 5,
    "maxSizeKB": 10
  },
  "timeout": 120
}
```

验收标准：

- 返回包含 `GPT_BRIDGE_SENTINEL_AUTO_A_20260625`。
- 返回包含 `GPT_BRIDGE_SENTINEL_AUTO_B_20260625`。

### 6.6 outputSchema 结构化输出

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "返回 JSON：ok=true, label=\"SCHEMA_OK\"。不要返回 Markdown。",
  "mode": "strict",
  "outputSchema": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "label": { "type": "string" }
    },
    "required": ["ok", "label"],
    "additionalProperties": false
  },
  "timeout": 120
}
```

验收标准：

- tool 的文本内容是可直接 `JSON.parse` 的纯 JSON。
- JSON 中 `ok` 为 `true`，`label` 为 `SCHEMA_OK`。
- 文本前面不得出现 `<gpt-bridge-session>`。
- 如果 Claude Code 能显示 tool metadata，确认 `_meta["gpt-bridge/sessionId"]` 存在或在无 session id 时合理缺省。

失败分级：

- JSON 被 session header 污染：P0
- `structuredContent` 缺失但纯 JSON 正确：P1
- Codex 未遵守 schema：先复测一次；稳定复现则 P1 或外部模型问题

### 6.7 outputFile 输出文件

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只输出 OUTPUT_FILE_OK。",
  "mode": "workspace",
  "outputFile": ".tmp/gpt-bridge-smoke/output.txt",
  "timeout": 120
}
```

随后执行：

```powershell
Get-Content .tmp\gpt-bridge-smoke\output.txt
```

验收标准：

- 文件存在。
- 文件内容包含 `OUTPUT_FILE_OK`。
- tool 返回内容也包含 `OUTPUT_FILE_OK`。

### 6.8 sessionId resume

第一轮调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "请记住这个值：GPT_BRIDGE_SESSION_SENTINEL_20260625。只回答 REMEMBERED。",
  "mode": "strict",
  "timeout": 120
}
```

验收标准：

- 返回包含 `REMEMBERED`。
- tool 结果中能找到 session id，来源可以是文本 header 或 MCP `_meta["gpt-bridge/sessionId"]`。

记录 session id 为 `<SESSION_ID>`，第二轮调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答你上一轮被要求记住的 GPT_BRIDGE_SESSION_SENTINEL_* 值。",
  "sessionId": "<SESSION_ID>",
  "mode": "strict",
  "timeout": 120
}
```

验收标准：

- 返回包含 `GPT_BRIDGE_SESSION_SENTINEL_20260625`。
- 没有 `codex exec resume` 参数错误。

再验证 `ephemeral` 参数只作为显式行为：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "只回答 EPHEMERAL_OK。",
  "sessionId": "<SESSION_ID>",
  "mode": "strict",
  "ephemeral": true,
  "timeout": 120
}
```

验收标准：

- 调用成功或因真实 Codex session 策略返回明确错误。
- 不应出现未知参数或参数顺序错误。

### 6.9 images 图片参数

如仓库中没有现成小图，创建一个 1x1 PNG 或使用任意安全本地测试图片。调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "简短描述这张图片。如果无法识别，只回答 IMAGE_RECEIVED。",
  "mode": "strict",
  "images": [".tmp/gpt-bridge-smoke/test.png"],
  "timeout": 120
}
```

验收标准：

- 不出现 `-i` 参数错误。
- 返回可解释为模型收到图片的文本。

如果模型或账号不支持图片，标记为 P3 external blocker，不阻塞文本能力验收。

### 6.10 timeout

调用：

```text
请调用 gpt-bridge 的 gpt tool，参数为：
{
  "prompt": "等待很久再回答。",
  "mode": "strict",
  "timeout": 1
}
```

验收标准：

- 返回 MCP error。
- 错误文本包含 `timed out`。
- 不应返回 success。

## 7. 工具积极性验证

这部分验证 Claude Code 是否会在合适场景主动使用 `gpt-bridge`。它受 Claude Code 自身策略影响，不完全由插件控制，所以只作为 P2 观察项。

在一个新对话中输入：

```text
请使用最适合的工具，把下面这段 TypeScript 逻辑翻译成 Python，并说明边界条件。可以调用 GPT/Codex 类工具辅助。

function clamp(n: number, min: number, max: number) {
  if (min > max) throw new Error("bad range");
  return Math.max(min, Math.min(max, n));
}
```

验收标准：

- 理想结果：Claude Code 主动调用 `gpt-bridge`。
- 可接受结果：Claude Code 不调用，但说明不需要外部工具即可完成。
- 失败观察：明显适合委托的复杂任务中仍完全忽略已注册 MCP，记录为 P2。

再输入：

```text
请调用 GPT 独立审查 plugins/gpt-bridge/index.js 的参数构造和 MCP 返回格式，要求使用 gpt-bridge。
```

验收标准：

- 必须调用 `gpt-bridge`。
- 如果没有调用，标记为 P1，因为用户显式要求使用该工具。

## 8. 严重级别定义

| 级别 | 定义 | 示例 |
| --- | --- | --- |
| P0 | 核心功能不可用或安全边界失效 | MCP 不启动、基础调用失败、结构化 JSON 被污染、绝对路径可注入 |
| P1 | 重要功能退化 | resume 不可用、profile/effort 参数错误、autoContext 失效 |
| P2 | 体验或策略问题 | Claude Code 不够主动调用、work log 展示质量差 |
| P3 | 外部阻塞 | Codex 未登录、网络不可用、模型权限不足、图片能力不支持 |

## 9. 验证报告模板

验证完成后输出以下报告：

```markdown
# gpt-bridge 验证报告

日期：YYYY-MM-DD
执行环境：
- OS:
- Node:
- npm:
- Codex CLI:
- Claude Code MCP 注册状态:

## 总结
- 总体结论：PASS / FAIL / BLOCKED
- P0 数量：
- P1 数量：
- P2 数量：
- P3 blocker 数量：

## 结果矩阵

| 项目 | 结果 | 证据摘要 | 严重级别 |
| --- | --- | --- | --- |
| 静态语法检查 | PASS/FAIL |  |  |
| fake Codex 单测 | PASS/FAIL |  |  |
| MCP stdio tools/list | PASS/FAIL |  |  |
| Claude MCP 注册 | PASS/FAIL |  |  |
| 基础文本调用 | PASS/FAIL |  |  |
| model/mode/effort | PASS/FAIL |  |  |
| profile 与冲突检测 | PASS/FAIL |  |  |
| files 注入 | PASS/FAIL |  |  |
| files 安全边界 | PASS/FAIL |  |  |
| autoContext | PASS/FAIL |  |  |
| outputSchema | PASS/FAIL |  |  |
| outputFile | PASS/FAIL |  |  |
| session resume | PASS/FAIL |  |  |
| ephemeral | PASS/FAIL |  |  |
| images | PASS/FAIL/BLOCKED |  |  |
| timeout | PASS/FAIL |  |  |
| 工具积极性 | PASS/FAIL/OBSERVED |  |  |

## 失败详情

### FAIL-1: 标题
- 功能项：
- 严重级别：
- 复现步骤：
- 实际输出：
- 期望输出：
- 初步判断：

## 建议修复顺序
1. P0:
2. P1:
3. P2:

## 附录
- 关键命令输出摘要：
- MCP 调用参数：
- 生成的临时文件：
```

## 10. 清理

验证结束后，如临时文件不再需要，执行：

```powershell
Remove-Item -LiteralPath .tmp\gpt-bridge-smoke -Recurse -Force
```

清理不是验收必要条件。如果失败证据需要保留，可以暂不清理，但必须在报告中说明。
