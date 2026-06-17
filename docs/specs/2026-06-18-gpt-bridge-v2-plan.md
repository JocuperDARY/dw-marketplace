# gpt-bridge v2 实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升级 gpt-bridge 从 v1.0.0 到 v2.0.0，新增 sessionId、profile、effort、autoContext 四个参数，完全向后兼容。

**Architecture:** 单一文件 `plugins/gpt-bridge/index.js` 内修改。新增 `glob` 依赖用于 autoContext。codex args 构造从固定数组改为动态追加模式。

**Tech Stack:** Node.js, @modelcontextprotocol/sdk, glob

**Working directory:** `~/development-workflow-skill/`

---

### Task 1: 升级版本号和依赖

**Files:**
- Modify: `plugins/gpt-bridge/package.json`
- Modify: `plugins/gpt-bridge/.claude-plugin/plugin.json`

- [ ] **Step 1: 更新 package.json**

将 `version` 从 `1.0.0` 改为 `2.0.0`，添加 `glob` 依赖：

```json
{
  "name": "gpt-bridge",
  "version": "2.0.0",
  "description": "MCP Server bridging Claude Code to GPT via Codex CLI",
  "license": "Apache-2.0",
  "type": "module",
  "main": "index.js",
  "bin": { "gpt-bridge": "./index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "glob": "^11.0.0"
  },
  "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
  "author": { "name": "JocuperDARY" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JocuperDARY/dw-marketplace.git"
  }
}
```

- [ ] **Step 2: 更新 plugin.json**

```json
{
  "name": "gpt-bridge",
  "description": "在 Claude Code 对话中直接调用 GPT 模型执行子任务。v2 新增会话保持、预设 profile、推理深度控制和自动上下文收集。",
  "version": "2.0.0",
  "author": { "name": "JocuperDARY" },
  "homepage": "https://github.com/JocuperDARY/dw-marketplace",
  "repository": "https://github.com/JocuperDARY/dw-marketplace",
  "license": "Apache-2.0",
  "keywords": ["gpt", "codex", "mcp", "bridge", "openai"],
  "setupHint": "安装后需注册MCP Server: claude mcp add gpt-bridge -- node <plugin-path>/index.js"
}
```

- [ ] **Step 3: 安装新依赖**

```bash
cd plugins/gpt-bridge && npm install
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/package.json plugins/gpt-bridge/.claude-plugin/plugin.json plugins/gpt-bridge/package-lock.json
git commit -m "chore: bump gpt-bridge to 2.0.0, add glob dependency"
```

---

### Task 2: 新增 effort 参数

**Files:**
- Modify: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 在 TOOL_DEF 中添加 effort 属性**

在 `timeout` 属性之后，`required` 之前，插入：

```javascript
effort: {
  type: 'string',
  enum: ['low', 'medium', 'high', 'xhigh'],
  description: 'Reasoning effort. Default: codex config default',
},
```

- [ ] **Step 2: 修改 runCodex 函数签名和参数构造**

将 `runCodex` 解构参数加入 `effort`：

```javascript
async function runCodex({ prompt, model, mode, files, images, outputSchema, outputFile, systemPrompt, cwd, timeout, effort }) {
```

在 `--skip-git-repo-check` 之后添加：

```javascript
if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
```

- [ ] **Step 3: CallToolRequestSchema handler 传参**

```javascript
const result = await runCodex({
  // ...existing...
  effort: args.effort,
});
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/index.js
git commit -m "feat: add effort parameter for reasoning depth control"
```

---

### Task 3: 新增 profile 参数

**Files:**
- Modify: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 添加 profile 常量映射**

在 `CODEX_BIN` 之后插入：

```javascript
const PROFILES = {
  fast:     { model: 'gpt-5.4-mini', mode: 'strict'  },
  balanced: { model: 'gpt-5.4',      mode: 'yolo'    },
  max:      { model: 'gpt-5.5',      mode: 'yolo'    },
};
```

- [ ] **Step 2: 在 TOOL_DEF 中添加 profile 属性**

```javascript
profile: {
  type: 'string',
  enum: ['fast', 'balanced', 'max'],
  description: 'Preset model+mode combo. Mutually exclusive with model/mode.',
},
```

更新 model 和 mode 描述注明互斥。

- [ ] **Step 3: 在 handler 中加入冲突检测和 profile 解析**

```javascript
if (args.profile && (args.model || args.mode)) {
  return { content: [{ type: 'text', text: 'profile is mutually exclusive with model and mode' }], isError: true };
}

let model = args.model;
let mode = args.mode;
if (args.profile) {
  const p = PROFILES[args.profile];
  model = p.model;
  mode = p.mode;
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/index.js
git commit -m "feat: add profile parameter (fast/balanced/max)"
```

---

### Task 4: 新增 sessionId 参数

**Files:**
- Modify: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 在 TOOL_DEF 中添加 sessionId**

```javascript
sessionId: {
  type: 'string',
  description: 'Resume a previous GPT session by id. Omit to start a new session.',
},
```

- [ ] **Step 2: 修改 runCodex 支持 resume**

```javascript
let args;
if (sessionId) {
  args = ['exec', 'resume', sessionId, '--ephemeral', '-p', mode || 'yolo', '--color', 'never', '--skip-git-repo-check'];
} else {
  args = ['exec', '-p', mode || 'yolo', '--color', 'never', '--skip-git-repo-check'];
  if (model) args.push('-m', model);
}
```

- [ ] **Step 3: 从 stdout 解析 sessionId**

```javascript
if (code === 0) {
  const output = stdout.trim();
  const sessionMatch = output.match(/session id:\s*([a-f0-9-]+)/i);
  resolve({
    success: true,
    result: sessionMatch ? output.replace(/^.*?\n/, '') : output,
    model: model || 'gpt-5.5',
    sessionId: sessionMatch ? sessionMatch[1] : null,
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/gpt-bridge/index.js
git commit -m "feat: add sessionId parameter for multi-turn conversations"
```

---

### Task 5: 新增 autoContext 参数

**Files:**
- Modify: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 添加 glob import**

```javascript
import { glob } from 'glob';
```

- [ ] **Step 2: 在 TOOL_DEF 中添加 autoContext**

```javascript
autoContext: {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Glob patterns to auto-collect files (e.g. ["src/**/*.ts"])',
    },
    maxFiles: {
      type: 'number',
      description: 'Max files to collect. Default: 10',
    },
    maxSizeKB: {
      type: 'number',
      description: 'Max size per file in KB. Default: 50',
    },
  },
  required: ['patterns'],
  description: 'Auto-collect matching files as GPT context (Layer 2)',
},
```

- [ ] **Step 3: 新增 autoCollectFiles 函数**

```javascript
async function autoCollectFiles({ patterns, cwd, maxFiles, maxSizeKB, explicitFiles }) {
  const maxF = maxFiles || 10;
  const maxSize = (maxSizeKB || 50) * 1024;
  const explicitSet = new Set(explicitFiles || []);
  const collected = [];

  for (const pattern of patterns) {
    if (collected.length >= maxF) break;
    try {
      const matches = await glob(pattern, {
        cwd, nodir: true, absolute: false,
        windowsPathsNoEscape: process.platform === 'win32',
      });
      for (const relPath of matches) {
        if (collected.length >= maxF) break;
        if (explicitSet.has(relPath)) continue;
        try {
          const absPath = join(cwd, relPath);
          const fsPromises = await import('fs/promises');
          const stat = await fsPromises.stat(absPath).catch(() => null);
          if (!stat || stat.size > maxSize) continue;
          const content = await readFile(absPath, 'utf-8');
          collected.push({ path: relPath, content });
        } catch { /* skip */ }
      }
    } catch { /* skip invalid glob */ }
  }
  return collected;
}
```

- [ ] **Step 4: 修改 buildStdin 支持 autoContext**

```javascript
function buildStdin({ prompt, systemPrompt, files, fileContents, autoCollected }) {
  // ... existing explicit files block ...
  if (autoCollected && autoCollected.length > 0) {
    parts.push('\n\n## Auto-Collected Context\n');
    for (const file of autoCollected) {
      parts.push(`\n### File: ${file.path} (matched)\n\`\`\`\n${file.content}\n\`\`\`\n`);
    }
  }
  return parts.join('');
}
```

- [ ] **Step 5: 修改 runCodex 集成 autoContext**

在文件读取之后，buildStdin 之前插入：

```javascript
let autoCollected = [];
if (autoContext && autoContext.patterns && autoContext.patterns.length > 0) {
  autoCollected = await autoCollectFiles({
    patterns: autoContext.patterns,
    cwd: effectiveCwd,
    maxFiles: autoContext.maxFiles,
    maxSizeKB: autoContext.maxSizeKB,
    explicitFiles: files || [],
  });
}

const stdin = buildStdin({ prompt, systemPrompt, files, fileContents, autoCollected });
```

- [ ] **Step 6: Commit**

```bash
git add plugins/gpt-bridge/index.js
git commit -m "feat: add autoContext parameter for automatic file collection"
```

---

### Task 6: 更新 server 版本号和 description

**Files:**
- Modify: `plugins/gpt-bridge/index.js`

- [ ] **Step 1: 更新 server metadata 和 TOOL_DEF description**

```javascript
const server = new Server(
  { name: 'gpt-bridge', version: '2.0.0' },
  { capabilities: { tools: {} } }
);
```

TOOL_DEF description 更新为：

```
Delegate a task to GPT via Codex CLI. v2: session resume, profiles, effort control, auto-context collection. v1 params fully supported.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/gpt-bridge/index.js
git commit -m "chore: bump gpt-bridge server version to 2.0.0"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 验证 server 启动无误**

```bash
timeout 2 node plugins/gpt-bridge/index.js 2>&1
# 预期: 无 import 错误
```

- [ ] **Step 2: 验证 v1 兼容**

```
mcp__gpt-bridge__gpt({ prompt: "Say OK" })
// 预期: 正常返回
```

- [ ] **Step 3: 验证 effort**

```
mcp__gpt-bridge__gpt({ prompt: "Say OK", effort: "low" })
// 预期: 正常返回
```

- [ ] **Step 4: 验证 profile**

```
mcp__gpt-bridge__gpt({ prompt: "Say OK", profile: "fast" })
// 预期: 使用 gpt-5.4-mini + strict
```

- [ ] **Step 5: 验证 profile/model 冲突**

```
mcp__gpt-bridge__gpt({ prompt: "Say OK", profile: "fast", model: "gpt-5.5" })
// 预期: 返回错误
```

- [ ] **Step 6: 验证 session 保持**

```
第1轮: gpt({ prompt: "My name is Alice. Remember it." }) → sessionId
第2轮: gpt({ prompt: "What is my name?", sessionId: "..." }) → "Alice"
```

- [ ] **Step 7: 验证 autoContext**

```
gpt({ cwd: "...", prompt: "What does this plugin do?", autoContext: { patterns: ["plugins/gpt-bridge/**/*.json"] } })
// 预期: GPT 能看到 plugin.json 内容
```

- [ ] **Step 8: Push**

```bash
git push dw-marketplace master
```

---

## 回滚

每个 Task 独立提交，可通过 `git revert` 逐项回滚。v1 兼容由所有新参数为 optional 保证。
