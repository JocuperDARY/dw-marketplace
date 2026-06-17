# DW Marketplace 重构 & gpt-bridge 插件设计

> 日期: 2026-06-17 | 状态: 已批准 | 作者: JocuperDARY

## 1. 背景与动机

### 1.1 现状

当前 `JocuperDARY/development-workflow-skill` 是一个单一插件仓库，包含 hooks、skills、rules 三类资产。虽然插件名为 "skill"，实际功能远不止 skill——它还包括 session 生命周期 hooks、tool routing、TF-IDF 语义路由等运行时行为。

### 1.2 目标

1. **仓库重命名与重构**：将仓库升级为 multi-plugin marketplace，容纳不同类别的开发工具
2. **新建 gpt-bridge 插件**：在 Claude Code 对话中通过 MCP tool 调用 Codex/GPT 执行子任务，利用 GPT 模型在长文本生成、代码翻译、创意发散等领域的优势

### 1.3 驱动因素

- 现有名字 "development-workflow-skill" 名不副实（包含 hooks、rules，不止 skills）
- 需要一个干净的 marketplace 框架容纳未来更多插件
- GPT 模型在特定任务类型上有 Claude 不具备的成本/质量优势

---

## 2. 整体架构

### 2.1 Marketplace 结构

```
dw-marketplace/                          ← GitHub: JocuperDARY/dw-marketplace (新建)
├── .claude-plugin/
│   └── marketplace.json
├── .gitignore
├── README.md
├── CLAUDE.md
│
├── plugins/
│   ├── development-workflow/            ← 从旧仓库插件迁移，改名
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── package.json
│   │   ├── hooks/                       ← 目录结构不变
│   │   ├── skills/                      ← 目录结构不变
│   │   └── rules/                       ← 目录结构不变
│   │
│   └── gpt-bridge/                      ← 全新
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── package.json
│       ├── index.js                     ← MCP server 核心
│       └── README.md
│
└── docs/
    └── specs/
        └── 2026-06-17-dw-marketplace-design.md  ← 本文档
```

### 2.2 插件关系

```
┌─────────────────────────────────────────┐
│          dw-marketplace                  │
│                                          │
│  ┌──────────────────────┐                │
│  │  development-workflow │               │
│  │  - hooks (7个)       │               │
│  │  - skills (10+子skill)│              │
│  │  - rules (8个)       │               │
│  │  - 七阶段门控        │               │
│  │  - 三C验证           │               │
│  └──────────────────────┘                │
│                                          │
│  ┌──────────────────────┐                │
│  │  gpt-bridge          │                │
│  │  - MCP Server        │                │
│  │  - codex exec 封装   │                │
│  │  - 独立安装/使用     │                │
│  └──────────────────────┘                │
│                                          │
│  两者完全独立，互不依赖                   │
└─────────────────────────────────────────┘
```

---

## 3. development-workflow 插件规格

### 3.1 命名变更

| 项目 | 旧值 | 新值 |
|------|------|------|
| 插件名 | development-workflow-skill | development-workflow |
| 仓库名 | development-workflow-skill | dw-marketplace |
| 版本 | 3.0.0 | 4.0.0（大版本，反映重构） |

### 3.2 内部目录不变

hooks/、skills/、rules/ 内部结构完全保留。skill 名称（如 `development-workflow-skill:development-workflow`）不变，保证向后兼容。

### 3.3 渐进式改动清单

| # | 改动点 | 旧路径/值 | 新路径/值 | 影响 |
|---|--------|---------|----------|------|
| 1 | 插件根目录 | `./` | `./plugins/development-workflow/` | 所有文件路径加深一层 |
| 2 | package.json name | `development-workflow-skill` | `development-workflow` | npm 发布名 |
| 3 | package.json files | `[".claude-plugin/", "hooks/", ...]` | `["plugins/development-workflow/.claude-plugin/", "plugins/development-workflow/hooks/", ...]` | npm 打包路径 |
| 4 | plugin.json name | `development-workflow-skill` | `development-workflow` | Claude Code 插件识别名 |
| 5 | plugin.json version | `3.0.0` | `4.0.0` | 大版本升级 |
| 6 | plugin.json homepage | `.../development-workflow-skill` | `.../dw-marketplace` | 链接更新 |
| 7 | plugin.json repository | `.../development-workflow-skill` | `.../dw-marketplace` | 链接更新 |
| 8 | marketplace.json 文件 | 不存在 | 新建 `.claude-plugin/marketplace.json` | 定义双插件 marketplace |
| 9 | 旧 marketplace.json 位置 | `.claude-plugin/marketplace.json` | 移到仓库根 `.claude-plugin/marketplace.json` | 原文件单插件，改为多插件 |
| 10 | 用户 settings.json marketplace source | `JocuperDARY/development-workflow-skill` | `JocuperDARY/dw-marketplace` | · |
| 11 | 用户 enabledPlugins 键 | `development-workflow-skill@development-workflow-skill-marketplace` | `development-workflow@dw-marketplace` | · |
| 12 | README.md | 旧仓库说明 | marketplace 总览 + 两个插件简介 | 文档 |
| 13 | CLAUDE.md | 单插件贡献指南 | marketplace 级贡献指南 + 各插件独立指南 | 文档 |
| 14 | .gitignore | 旧内容 | 追加 `node_modules/` (gpt-bridge 需要) | 构建 |

### 3.4 不变部分（保证向后兼容）

- hooks/ 下所有文件名和内部逻辑
- skills/ 下所有 SKILL.md 的 `name` 和 `description` 字段
- rules/ 下所有规则文件内容
- hooks.json 结构

---

## 4. gpt-bridge 插件规格

### 4.1 MCP Tool Signature

```
gpt({
  // 必选
  prompt: string,            // 任务描述，发送给 GPT

  // 可选
  model?: string,            // 默认 "gpt-5.4"，可选任意 OpenAI 模型
  mode?: "yolo" | "strict",  // 默认 "yolo" (完整权限)，strict = 只读
  files?: string[],          // 注入到 GPT 上下文的工作区相对路径
  images?: string[],         // 注入图片文件路径 (走 codex -i)
  outputSchema?: object,     // JSON Schema，约束 GPT 输出结构化 JSON
  outputFile?: string,       // 结果落盘路径 (走 codex -o)，同时返回对话
  systemPrompt?: string,     // 覆盖 system prompt
  cwd?: string,              // 工作目录，默认项目根
  timeout?: number,          // 超时秒数，默认 300
})
```

### 4.2 架构

```
Claude Code
    │  JSON-RPC over stdio (MCP protocol)
    ▼
index.js  ←  MCP Server (Node.js, @modelcontextprotocol/sdk)
    │
    │  child_process.spawn("codex", ["exec", "-p", mode, "-m", model, ...])
    │  stdin:  prompt + files 内容 (### File: path 格式)
    │  stdout: GPT 完整响应
    ▼
结果解析 → 返回 Claude Code
```

### 4.3 上下文注入格式

当 `files` 参数指定文件时，注入 GPT 前的 stdin 格式：

```
<systemPrompt 内容>

## Task

<prompt 内容>

## Context Files

### File: src/auth/login.py
```python
<文件内容>
```

### File: src/auth/session.py
```python
<文件内容>
```
```

### 4.4 错误处理策略

| 场景 | 行为 |
|------|------|
| codex CLI 不在 PATH | 返回错误 "codex CLI not found. Install with: npm i -g @anthropic/codex" |
| codex 非零退出 | 返回 stderr + exit code |
| 超时 | 返回 "GPT task timed out after Ns" |
| outputSchema 写入失败 | 返回文件系统错误详情 |
| files 指向不存在的文件 | 返回明确的文件缺失错误，列出缺失路径 |

### 4.5 安全边界

- `cwd` 默认锁定在 Claude Code 当前项目根目录
- `mode: "strict"` 时传 `--sandbox strict`，GPT 无法写文件
- 不允许 `cwd` 逃逸到项目父目录之外（除非显式 allowlist）
- outputSchema 临时文件写入系统 temp 目录，用完即删

### 4.6 声明的能力 vs 不做的能力

| 维度 | v1 选择 | v2 候选 |
|------|--------|---------|
| 执行模式 | 一问一答 | 会话保持 (`codex exec resume`) |
| 流式返回 | 不做（编排场景不需要） | 终端直调模式 |
| 上下文注入 | 文件 + 图片 | 自动上下文收集 |
| 输出处理 | 原样返回 + 结构化JSON + 落盘 | - |
| 模型选择 | 调用时指定 | 预设 profile |
| 沙箱模式 | 调用时可选 | - |

---

## 5. 用户侧配置变更

### 5.1 settings.json diff

```diff
{
  "extraKnownMarketplaces": {
-   "development-workflow-skill-marketplace": {
-     "source": {
-       "repo": "JocuperDARY/development-workflow-skill",
-       "source": "github"
-     }
-   },
+   "dw-marketplace": {
+     "source": {
+       "repo": "JocuperDARY/dw-marketplace",
+       "source": "github"
+     }
+   },
    // ... 其他 marketplace 不变 ...
  },
  "enabledPlugins": {
-   "development-workflow-skill@development-workflow-skill-marketplace": true,
+   "development-workflow@dw-marketplace": true,
+   "gpt-bridge@dw-marketplace": true,
    // ... 其他插件不变 ...
  }
}
```

### 5.2 gpt-bridge MCP 注册

插件安装后，需额外注册 MCP server（v1 手动）：

```bash
# 找到 gpt-bridge 的安装路径
claude mcp add gpt-bridge -- node \
  ~/.claude/plugins/cache/dw-marketplace/gpt-bridge/*/plugins/gpt-bridge/index.js
```

或使用 Claude Code 交互命令：
```
/mcp add gpt-bridge -- node <path-to-index.js>
```

---

## 6. 实施计划

### 6.1 步骤

| # | 步骤 | 工具 | 验证标准 |
|---|------|------|---------|
| 1 | 本地仓库目录重构 | mkdir, git mv | `git status` 显示正确迁移 |
| 2 | 更新所有 manifest 文件 | Edit | plugin.json、package.json、marketplace.json 正确 |
| 3 | 创建 gpt-bridge MCP server | Write | `node index.js` 能启动并响应 MCP 协议 |
| 4 | 更新 README.md、CLAUDE.md | Edit | 文档反映新结构 |
| 5 | 本地 MCP 注册测试 | Bash | `claude mcp list` 显示 gpt-bridge |
| 6 | 功能测试：Claude Code 调 gpt-bridge | 对话测试 | GPT 返回结果正确 |
| 7 | 旧仓库加迁移指引 | Write/Edit | README 顶部有迁移说明 |
| 8 | 创建新 GitHub 仓库并推送 | git | `JocuperDARY/dw-marketplace` 存在 |
| 9 | 更新本地 settings.json | Edit | 新 marketplace source 生效 |

### 6.2 回滚计划

若出现问题，回滚路径：
1. 旧仓库 `JocuperDARY/development-workflow-skill` 完整保留，可随时切回
2. 本地 `settings.json` 改回旧 marketplace source 即恢复
3. gpt-bridge 是独立插件，不影响 development-workflow 的正常运行

---

## 7. 附录

### 7.1 plugin.json 模板

**development-workflow**:
```json
{
  "name": "development-workflow",
  "description": "全流程开发准则：铁律体系+七阶段门控+三C验证闭环。含诊断、方案设计、TDD、数据完整性、优化方法论、工具编排等10个子Skill，及hooks、rules资产。",
  "version": "4.0.0",
  "author": { "name": "JocuperDARY" },
  "homepage": "https://github.com/JocuperDARY/dw-marketplace",
  "repository": "https://github.com/JocuperDARY/dw-marketplace",
  "license": "Apache-2.0",
  "keywords": ["workflow", "development", "tdd", "verification", "hooks", "rules"]
}
```

**gpt-bridge**:
```json
{
  "name": "gpt-bridge",
  "description": "在 Claude Code 对话中直接调用 GPT 模型执行子任务。通过 Codex CLI 桥接，支持文件注入、结构化输出、图片输入，适用于代码翻译、长文本生成、创意发散等场景。",
  "version": "1.0.0",
  "author": { "name": "JocuperDARY" },
  "homepage": "https://github.com/JocuperDARY/dw-marketplace",
  "repository": "https://github.com/JocuperDARY/dw-marketplace",
  "license": "Apache-2.0",
  "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
  "setupHint": "安装后需注册MCP Server: claude mcp add gpt-bridge -- node <path>/plugins/gpt-bridge/index.js"
}
```

### 7.2 marketplace.json 最终形态

```json
{
  "name": "dw-marketplace",
  "description": "Development Workflow 工具集：全流程开发准则 + GPT 模型桥接",
  "owner": { "name": "JocuperDARY" },
  "plugins": [
    {
      "name": "development-workflow",
      "source": "./plugins/development-workflow",
      "description": "全流程开发准则：铁律体系+七阶段门控+三C验证闭环。含诊断、方案设计、TDD、数据完整性、优化方法论、工具编排等10个子Skill，及hooks、rules资产。",
      "version": "4.0.0",
      "author": { "name": "JocuperDARY" },
      "homepage": "https://github.com/JocuperDARY/dw-marketplace",
      "repository": "https://github.com/JocuperDARY/dw-marketplace",
      "license": "Apache-2.0",
      "keywords": ["workflow", "development", "tdd", "verification"],
      "category": "development"
    },
    {
      "name": "gpt-bridge",
      "source": "./plugins/gpt-bridge",
      "description": "在 Claude Code 对话中直接调用 GPT 模型执行子任务。通过 Codex CLI 桥接，支持文件注入、结构化JSON输出、图片输入。",
      "version": "1.0.0",
      "author": { "name": "JocuperDARY" },
      "homepage": "https://github.com/JocuperDARY/dw-marketplace",
      "repository": "https://github.com/JocuperDARY/dw-marketplace",
      "license": "Apache-2.0",
      "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
      "category": "ai-integration"
    }
  ]
}
```

### 7.3 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 仓库策略 | 新建而非原地重构 | 旧仓库保留做历史归档 |
| 插件命名 | development-workflow（去 skill 后缀） | 更准确反映实际内容 |
| gpt-bridge 独立性 | 独立插件，非 DW 子功能 | 两者无耦合，各自独立安装 |
| 流式返回 | v1 不做 | MCP tool call 的 req/res 模式不适用，编排场景不需要 |
| MCP 注册 | v1 手动 | 自动化需额外基础设施（install hook），先验证核心价值 |
