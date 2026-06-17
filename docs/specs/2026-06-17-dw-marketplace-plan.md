# DW Marketplace 重构 & gpt-bridge 实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 development-workflow-skill 单插件仓库重构为 dw-marketplace 多插件 marketplace，同时新建 gpt-bridge MCP server 插件。

**Architecture:** 现有内容迁入 `plugins/development-workflow/`，gpt-bridge 作为同级独立插件。两者共享 marketplace.json 但互不依赖。

**Tech Stack:** Node.js (MCP SDK), Bash (git), JSON (Claude Code manifests)

**Working directory:** `~/development-workflow-skill/`

---

### Task 1: 目录重构 — 迁移现有内容到 plugins/development-workflow/

**Files:**
- Move: `hooks/` → `plugins/development-workflow/hooks/`
- Move: `skills/` → `plugins/development-workflow/skills/`
- Move: `rules/` → `plugins/development-workflow/rules/`
- Move: `.claude-plugin/` → `plugins/development-workflow/.claude-plugin/`
- Move: `package.json` → `plugins/development-workflow/package.json`

- [ ] **Step 1: 创建目标目录并迁移**

```bash
cd ~/development-workflow-skill
mkdir -p plugins/development-workflow

# 逐项 git mv
git mv hooks/ plugins/development-workflow/hooks/
git mv skills/ plugins/development-workflow/skills/
git mv rules/ plugins/development-workflow/rules/
git mv .claude-plugin/ plugins/development-workflow/.claude-plugin/
git mv package.json plugins/development-workflow/package.json
```

- [ ] **Step 2: 验证**

```bash
ls plugins/development-workflow/
# 应显示: hooks/  skills/  rules/  .claude-plugin/  package.json
git status
# 应显示 renamed 状态，无 untracked 残留
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: move plugin assets into plugins/development-workflow/"
```

---

### Task 2: 更新 development-workflow plugin.json

**Files:**
- Modify: `plugins/development-workflow/.claude-plugin/plugin.json`

- [ ] **Step 1: 替换 plugin.json**

```json
{
  "name": "development-workflow",
  "description": "全流程开发准则：铁律体系+七阶段门控+三C验证闭环。含诊断、方案设计、TDD、数据完整性、优化方法论、工具编排等10个子Skill，及hooks、rules资产。",
  "version": "4.0.0",
  "author": {
    "name": "JocuperDARY"
  },
  "homepage": "https://github.com/JocuperDARY/dw-marketplace",
  "repository": "https://github.com/JocuperDARY/dw-marketplace",
  "license": "Apache-2.0",
  "keywords": [
    "workflow", "development", "tdd", "verification",
    "diagnosis", "planning", "implementation",
    "optimization", "debugging", "tool-orchestration",
    "hooks", "rules"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/development-workflow/.claude-plugin/plugin.json
git commit -m "feat: bump development-workflow to 4.0.0, rename from development-workflow-skill"
```

---

### Task 3: 更新 development-workflow package.json

**Files:**
- Modify: `plugins/development-workflow/package.json`

- [ ] **Step 1: 替换 package.json**

```json
{
  "name": "development-workflow",
  "version": "4.0.0",
  "description": "全流程开发准则：铁律体系+七阶段门控+三C验证闭环。含诊断、方案设计、TDD、数据完整性、优化方法论、工具编排等10个子Skill，及hooks、rules资产。",
  "license": "Apache-2.0",
  "keywords": [
    "claude-code", "workflow", "development", "verification",
    "tdd", "diagnosis", "planning", "implementation",
    "optimization", "debugging", "tool-orchestration",
    "hooks", "rules"
  ],
  "author": { "name": "JocuperDARY" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JocuperDARY/dw-marketplace.git"
  },
  "files": [
    ".claude-plugin/",
    "hooks/",
    "skills/development-workflow/",
    "skills/dw-diagnosis/",
    "skills/dw-planning/",
    "skills/dw-implementation/",
    "skills/dw-verification/",
    "skills/dw-wrapup/",
    "skills/dw-optimization/",
    "skills/dw-debugging/",
    "skills/dw-tooling/",
    "skills/dw-reference/",
    "skills/dw-domains/",
    "rules/"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/development-workflow/package.json
git commit -m "chore: update package.json for development-workflow 4.0.0"
```

---

### Task 4: 创建仓库根级 marketplace.json

**Files:**
- Create: `.claude-plugin/marketplace.json`

- [ ] **Step 1: 确保 .claude-plugin 目录存在**

```bash
mkdir -p .claude-plugin
```

- [ ] **Step 2: 创建 marketplace.json**

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

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat: add marketplace.json for dw-marketplace with two plugins"
```

---

### Task 5: 创建 gpt-bridge 插件骨架

**Files:**
- Create: `plugins/gpt-bridge/.claude-plugin/plugin.json`
- Create: `plugins/gpt-bridge/package.json`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p plugins/gpt-bridge/.claude-plugin
```

- [ ] **Step 2: 创建 plugin.json**

```json
{
  "name": "gpt-bridge",
  "description": "在 Claude Code 对话中直接调用 GPT 模型执行子任务。通过 Codex CLI 桥接，支持文件注入、结构化输出、图片输入。",
  "version": "1.0.0",
  "author": { "name": "JocuperDARY" },
  "homepage": "https://github.com/JocuperDARY/dw-marketplace",
  "repository": "https://github.com/JocuperDARY/dw-marketplace",
  "license": "Apache-2.0",
  "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
  "setupHint": "安装后需注册MCP Server: claude mcp add gpt-bridge -- node <plugin-path>/index.js"
}
```

- [ ] **Step 3: 创建 package.json**

```json
{
  "name": "gpt-bridge",
  "version": "1.0.0",
  "description": "MCP Server bridging Claude Code to GPT via Codex CLI",
  "license": "Apache-2.0",
  "type": "module",
  "main": "index.js",
  "bin": { "gpt-bridge": "./index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
  "author": { "name": "JocuperDARY" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JocuperDARY/dw-marketplace.git"
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/
git commit -m "feat: add gpt-bridge plugin skeleton"
```

---

### Task 6: 实现 gpt-bridge MCP Server

**Files:**
- Create: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 创建 index.js**

```javascript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const TOOL_DEF = {
  name: 'gpt',
  description: `Delegate a task to GPT via Codex CLI. GPT excels at: long-form text generation, code translation between languages, creative brainstorming, and independent sub-module creation. Returns the complete GPT response when done.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task description sent to GPT. Be specific about expected output.',
      },
      model: {
        type: 'string',
        description: 'OpenAI model. Default: gpt-5.4',
      },
      mode: {
        type: 'string',
        enum: ['yolo', 'strict'],
        description: 'Sandbox mode. yolo = full access, strict = read-only. Default: yolo',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative file paths to inject as context',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Image file paths to attach (via codex -i)',
      },
      outputSchema: {
        type: 'object',
        description: 'JSON Schema to constrain GPT output as structured JSON',
      },
      outputFile: {
        type: 'string',
        description: 'File path to write GPT output (also returned inline)',
      },
      systemPrompt: {
        type: 'string',
        description: 'Override the default system prompt',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to the current project root.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Default: 300',
      },
    },
    required: ['prompt'],
  },
};

function buildStdin({ prompt, systemPrompt, files, fileContents }) {
  const parts = [];
  if (systemPrompt) {
    parts.push(systemPrompt);
    parts.push('\n---\n');
  }
  parts.push('## Task\n\n');
  parts.push(prompt);
  if (files && files.length > 0) {
    parts.push('\n\n## Context Files\n');
    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const content = fileContents[i] || '(file not readable)';
      parts.push(`\n### File: ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }
  return parts.join('');
}

async function readFiles(filePaths, cwd) {
  const contents = [];
  const missing = [];
  for (const relPath of filePaths) {
    try {
      const absPath = join(cwd, relPath);
      contents.push(await readFile(absPath, 'utf-8'));
    } catch {
      missing.push(relPath);
      contents.push(null);
    }
  }
  return { contents, missing };
}

async function runCodex({ prompt, model, mode, files, images, outputSchema, outputFile, systemPrompt, cwd, timeout }) {
  const effectiveCwd = cwd || process.cwd();
  const args = ['exec', '-p', mode || 'yolo', '--color', 'never'];

  if (model) args.push('-m', model);
  if (images) for (const img of images) args.push('-i', img);

  let schemaFile = null;
  if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    await writeFile(schemaFile, JSON.stringify(outputSchema), 'utf-8');
    args.push('--output-schema', schemaFile);
  }

  if (outputFile) args.push('-o', outputFile);
  args.push('-C', effectiveCwd);
  args.push('-');

  let fileContents = [];
  if (files && files.length > 0) {
    const result = await readFiles(files, effectiveCwd);
    fileContents = result.contents;
    if (result.missing.length > 0) {
      return { success: false, error: `Files not found: ${result.missing.join(', ')}` };
    }
  }

  const stdin = buildStdin({ prompt, systemPrompt, files, fileContents });

  return new Promise((resolve) => {
    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      timeout: (timeout || 300) * 1000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      resolve({ success: false, error: `Failed to start codex: ${err.message}. Is Codex CLI installed?` });
    });

    proc.on('close', async (code) => {
      if (schemaFile) { try { await unlink(schemaFile); } catch {} }
      if (code === 0) {
        resolve({ success: true, result: stdout.trim(), model: model || 'gpt-5.4' });
      } else {
        const stderrClean = stderr
          .split('\n')
          .filter(l => !l.includes('Tracing initialized'))
          .join('\n').trim();
        resolve({ success: false, error: `codex exited ${code}${stderrClean ? ': ' + stderrClean : ''}` });
      }
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

const server = new Server(
  { name: 'gpt-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL_DEF],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'gpt') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }

  const args = request.params.arguments;
  const result = await runCodex({
    prompt: args.prompt,
    model: args.model,
    mode: args.mode,
    files: args.files,
    images: args.images,
    outputSchema: args.outputSchema,
    outputFile: args.outputFile,
    systemPrompt: args.systemPrompt,
    cwd: args.cwd,
    timeout: args.timeout,
  });

  if (result.success) {
    return { content: [{ type: 'text', text: result.result }] };
  } else {
    return { content: [{ type: 'text', text: result.error }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('gpt-bridge fatal:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 安装依赖**

```bash
cd plugins/gpt-bridge && npm install
```

- [ ] **Step 3: 验证 server 可启动**

```bash
# 启动后立即 kill（MCP server 在 stdio 上阻塞等待，属正常行为）
timeout 2 node index.js 2>&1; echo "Exit: $?"
# 预期: 无异常报错（timeout kill 是正常的）
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/index.js plugins/gpt-bridge/package-lock.json
git commit -m "feat: implement gpt-bridge MCP server"
```

---

### Task 7: 确认 .gitignore 覆盖

**Files:**
- Possibly modify: `.gitignore`

- [ ] **Step 1: 检查 node_modules 是否被忽略**

```bash
git check-ignore plugins/gpt-bridge/node_modules/
```

如果未被忽略，追加：

```bash
echo "plugins/gpt-bridge/node_modules/" >> .gitignore
git add .gitignore
git commit -m "chore: ensure gpt-bridge node_modules is gitignored"
```

---

### Task 8: 更新 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 重写 README**

```markdown
# DW Marketplace

Development Workflow 工具集 —— AI 编程助手的开发工作方法论 + GPT 模型桥接。

## 插件

| 插件 | 版本 | 说明 |
|------|------|------|
| [development-workflow](./plugins/development-workflow/) | 4.0.0 | 铁律体系+七阶段门控+三C验证闭环，10个子Skill + 7 hooks + 8 rules |
| [gpt-bridge](./plugins/gpt-bridge/) | 1.0.0 | MCP Server：Claude Code 对话中调用 GPT 执行子任务 |

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
3. 功能完全继承，版本升至 4.0.0

旧仓库 [JocuperDARY/development-workflow-skill](https://github.com/JocuperDARY/development-workflow-skill) 保留归档。

## 许可

Apache License 2.0
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for dw-marketplace"
```

---

### Task 9: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 重写 CLAUDE.md**

```markdown
# DW Marketplace — Contributor Guidelines

Multi-plugin marketplace repository. `plugins/` 下各插件独立维护。

## Repository Structure

```
plugins/
├── development-workflow/   # Hooks + Skills + Rules
└── gpt-bridge/             # MCP Server: Claude Code ↔ GPT
```

## Working on development-workflow

- hooks/ — Session lifecycle (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse)
- skills/ — 1 core hub + 9 sub-skills
- rules/ — Domain knowledge (coding style, security, testing)

Before modifying: identify target sub-skill/hook/rule, update version in plugin.json.

## Working on gpt-bridge

- `index.js` — MCP server entry point. Wraps `codex exec` via child_process.
- Uses `@modelcontextprotocol/sdk`.

## Pull Request Requirements

- One change per PR
- Update relevant plugin.json version
- Test end-to-end
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for multi-plugin marketplace"
```

---

### Task 10: 旧仓库迁移指引

- [ ] **Step 1: 在旧仓库 README 顶部添加迁移 banner**

在 `JocuperDARY/development-workflow-skill` 的 README.md 顶部插入：

```markdown
> ⚠️ **已迁移至 [dw-marketplace](https://github.com/JocuperDARY/dw-marketplace)**
>
> `development-workflow-skill` → `development-workflow`，版本 4.0.0。
> 新 marketplace source: `JocuperDARY/dw-marketplace`
>
> 本仓库保留归档。
```

此步骤在 GitHub Web 界面或通过 `mcp__github__create_or_update_file` 完成。

---

### Task 11: 创建新 GitHub 仓库并推送

- [ ] **Step 1: 创建仓库**

在 GitHub 上创建 `JocuperDARY/dw-marketplace`（通过 gh CLI 或 Web 界面）。

- [ ] **Step 2: 添加 remote 并推送**

```bash
git remote add origin-new https://github.com/JocuperDARY/dw-marketplace.git
git push -u origin-new master
```

- [ ] **Step 3: 验证**

浏览器访问 `https://github.com/JocuperDARY/dw-marketplace`，确认文件结构正确。

---

### Task 12: 更新本地 Claude Code 配置

**Files:**
- Modify: `~/.claude/settings.json`

- [ ] **Step 1: 更新 extraKnownMarketplaces**

删除 `development-workflow-skill-marketplace` 条目，新增 `dw-marketplace` 条目。

- [ ] **Step 2: 更新 enabledPlugins**

删除 `development-workflow-skill@development-workflow-skill-marketplace`，新增 `development-workflow@dw-marketplace` 和 `gpt-bridge@dw-marketplace`。

- [ ] **Step 3: 验证插件安装**

```bash
claude plugin list
# 应显示两个新插件
```

---

### Task 13: 注册 gpt-bridge MCP Server

- [ ] **Step 1: 注册**

```bash
GB_PATH=$(ls -1d ~/.claude/plugins/cache/dw-marketplace/gpt-bridge/*/ 2>/dev/null | head -1)
claude mcp add gpt-bridge -- node "${GB_PATH}plugins/gpt-bridge/index.js"
```

- [ ] **Step 2: 验证**

```bash
claude mcp list | grep gpt-bridge
```

---

### Task 14: 端到端验证

- [ ] **Step 1: 重启 Claude Code**，确认 `<dw-session>` banner 出现（DW hooks 正常）

- [ ] **Step 2: 测试 gpt-bridge**

在对话中：*"用 gpt-bridge 的 gpt tool 生成一个计算斐波那契数列的 Python 函数"*

- [ ] **Step 3: 测试文件注入**

在对话中：*"用 gpt-bridge 翻译 plugins/gpt-bridge/index.js 核心逻辑为 Python，附上该文件"*

---

## 回滚计划

| 场景 | 操作 |
|------|------|
| git 层面出错 | 旧仓库完整保留，切回原 remote |
| 插件安装失败 | settings.json 改回旧值 |
| gpt-bridge 异常 | `claude mcp remove gpt-bridge`，不影响 DW |
