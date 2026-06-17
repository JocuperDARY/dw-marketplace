# gpt-bridge v2 设计

> 日期: 2026-06-18 | 状态: 已批准 | 基于: v1.0.0 (`ef59c9e`)

## 1. 背景

v1 实现了 Claude Code ↔ GPT 的基础桥接（一问一答 MCP server）。v2 新增三个能力：会话保持、预设 profile、自动上下文收集。

## 2. v2 新增参数

### 2.1 sessionId — 会话保持

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string? | 传入已有 session id 则 `codex exec resume`，不传则新建 `codex exec` |

返回值新增 `sessionId` 字段。

```
// 第1轮：新建
gpt({ prompt: "分析 src/auth/ 的安全问题" })
→ { ..., sessionId: "019ed674-ca0f-..." }

// 第2轮：追问
gpt({ prompt: "针对第一个问题给出修复代码", sessionId: "..." })
→ { ..., sessionId: "..." }
```

实现：
- 新建: `codex exec -p <mode> -m <model> --ephemeral -`
- 续接: `codex exec resume <sessionId> --ephemeral -p <mode> -`
- 从 codex stdout 解析 session id

### 2.2 profile — 预设模板

| 值 | model | mode |
|----|-------|------|
| `fast` | gpt-5.4-mini | strict |
| `balanced` | gpt-5.4 | yolo |
| `max` | gpt-5.5 | yolo |

约束：`profile` 与 `model`/`mode` 互斥——同时传入返回错误。不传 profile 则 v1 兼容。

### 2.3 effort — 推理深度

| 值 | codex 参数 |
|----|-----------|
| `low` | `-c model_reasoning_effort=low` |
| `medium` | `-c model_reasoning_effort=medium` |
| `high` | `-c model_reasoning_effort=high` |
| `xhigh` | `-c model_reasoning_effort=xhigh` |

独立参数，不绑 profile。不传则用 codex 配置默认值。

### 2.4 autoContext — 自动文件收集

```typescript
autoContext?: {
  patterns: string[],    // glob 模式，如 ["src/**/*.ts", "*.py"]
  maxFiles?: number,     // 默认 10
  maxSizeKB?: number,    // 默认 50
}
```

安全约束：
- glob 匹配仅限 `cwd` 范围内
- 已存在于 `files[]` 的文件去重
- `maxSizeKB` 过滤超大文件

## 3. 上下文注入三层

```
Layer 1: files[] — Claude Code 显式传入
Layer 2: autoContext — gpt-bridge glob 自动匹配
Layer 3: GPT 自行读取 — yolo 模式下 codex 有文件系统权限
```

注入 stdin 格式：

```
<systemPrompt>

## Task
<prompt>

## Explicit Context Files                          ← Layer 1
### File: src/auth/login.py
```...
```

## Auto-Collected Context                        ← Layer 2
### File: src/auth/session.py (matched: src/**/*.py)
```...
```
```

## 4. 完整 Tool Signature (v2)

```
gpt({
  // —— v1 ——
  prompt: string,
  model?: string,
  mode?: "yolo" | "strict",
  files?: string[],
  images?: string[],
  outputSchema?: object,
  outputFile?: string,
  systemPrompt?: string,
  cwd?: string,
  timeout?: number,

  // —— v2 ——
  sessionId?: string,
  profile?: "fast" | "balanced" | "max",
  effort?: "low" | "medium" | "high" | "xhigh",
  autoContext?: {
    patterns: string[],
    maxFiles?: number,
    maxSizeKB?: number,
  },
})
```

返回值：

```
{ success: boolean, result: string, model: string, sessionId?: string }
```

## 5. 实现要点

### 5.1 session 生命周期

- `--ephemeral` 模式下 session 文件不落盘
- `codex exec resume` 需要前次 session 的运行时状态
- 如果 resume 失败（session 已过期/不存在），返回错误并建议新开会话

### 5.2 autoContext glob 实现

- 用 `glob` 或 `fast-glob` npm 依赖
- 结果按文件大小升序排序，优先纳入小文件
- 去重逻辑：Set 跟踪 `files[]` + 已收集路径

### 5.3 参数冲突检测

```javascript
if (profile && (model || mode)) {
  return { success: false, error: 'profile 与 model/mode 互斥' };
}
```

### 5.4 向后兼容

v1 所有参数不变，所有现有调用方式不受影响。新参数全是可选的。

## 6. v1 vs v2 能力矩阵

| 维度 | v1 | v2 |
|------|-----|-----|
| 执行模式 | 一问一答 | 一问一答 + 会话保持 |
| 上下文注入 | 文件 + 图片 | 文件 + 图片 + 自动收集 |
| 模型选择 | 调用时指定 | 调用时指定 + 预设 profile |
| 推理深度 | codex 配置默认 | 可指定 effort |
| 流式返回 | 不做 | 不做（编排场景不需要） |
