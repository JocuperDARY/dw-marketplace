# gpt-bridge 根因诊断与修复报告

> 日期：2026-06-26
> 触发来源：[2026-06-25-gpt-bridge-verification-runbook.md](./2026-06-25-gpt-bridge-verification-runbook.md) 功能验证
> 修改文件：`plugins/gpt-bridge/index.js`

## 验证背景

按照 `2026-06-25-gpt-bridge-verification-runbook.md` 对 gpt-bridge v2.0.0 执行全功能验证。15 项静态/单元测试全部通过，MCP 协议集成、参数路由、上下文注入、路径安全边界等功能正常。但发现 2 个功能缺陷 + 1 个诊断盲区。

---

## 根因 1 (P0)：outputSchema 始终失败

### 症状

```text
mcp__gpt-bridge__gpt → "codex exited with code 1"
```

直接调用 codex 验证：

```powershell
codex exec --output-schema /tmp/schema.json ... "返回JSON: ok=true"
```

输出：

```text
ERROR: Invalid schema for response_format 'codex_output_schema':
In context=(), 'additionalProperties' is required to be supplied and to be false.
```

### 根因

OpenAI API 对 `response_format` 中的 JSON Schema 有严格约束：**根级对象必须显式设置 `"additionalProperties": false`**。这是上游 API 的硬性要求，缺则直接拒绝。

gpt-bridge 将用户传入的 `outputSchema` 原样写入临时文件后传给 `codex --output-schema`，不做任何补全。如果用户遗漏该字段（JSON Schema 规范中不强制要求），调用必然失败。

### 修复

`runCodex()` 中写入 schema 文件前强制根级默认值：

```javascript
// 修复前
if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    await writeFile(schemaFile, JSON.stringify(outputSchema), 'utf-8');
}

// 修复后
if (outputSchema) {
    schemaFile = join(tmpdir(), `gpt-bridge-schema-${randomUUID()}.json`);
    // OpenAI API requires additionalProperties: false at the root level.
    const safeSchema = { ...outputSchema, additionalProperties: false };
    await writeFile(schemaFile, JSON.stringify(safeSchema), 'utf-8');
}
```

`{ ...outputSchema, additionalProperties: false }` 的 spread 顺序确保根级 `additionalProperties` 始终为 `false`。这是上游 `response_format` 的硬性约束，因此不允许调用方覆盖成 `true`。

### 验证

直接 stdio 调用 gpt-bridge：

```json
{
  "outputSchema": {
    "type": "object",
    "properties": { "ok": { "type": "boolean" } },
    "required": ["ok"]
  }
}
```

返回：

```json
{
  "content": [{"type": "text", "text": "{\"ok\":true}"}],
  "structuredContent": { "ok": true },
  "_meta": { "gpt-bridge/sessionId": "019effb8-..." }
}
```

✅ JSON 未被 Markdown 污染，`structuredContent` 正确填充。

---

## 根因 2 (P1)：sessionId 永远返回 null

### 症状

- MCP 调用成功但 `_meta["gpt-bridge/sessionId"]` 缺失
- Session resume 功能不可用：无 sessionId 可供第二轮传入

### 根因

gpt-bridge v2 始终使用 `codex exec --json` 标志以获取 JSONL 实时进度流。在此模式下，Codex CLI 将所有输出（包括会话标识）以 JSONL 事件流形式输出到 **stdout**，而非 stderr。

第一行 JSONL 事件即包含会话 ID：

```json
{"type":"thread.started","thread_id":"019effac-c07d-7172-9e78-ebab6bae26bc"}
```

但 `extractSessionId()` 函数仅匹配**文本模式**：

```javascript
// 修复前 —— 三个正则都匹配不到 JSON 中的 thread_id
function extractSessionId(stderr, stdout) {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  const patterns = [
    /session id:\s*([^\s]+)/i,          // ← 匹配 stderr 文本
    /"session_id"\s*:\s*"([^"]+)"/i,     // ← 匹配显式 JSON key
    /"sessionId"\s*:\s*"([^"]+)"/i,      // ← 匹配 camelCase JSON key
  ];
  // 三个模式都无法匹配 JSONL 中的 "thread_id" 字段
}
```

> **关键洞察**：`--json` 模式下 codex stderr **完全为空**。所有输出（包括 preamble 中的 `session id:` 文本）都被重定向到 JSONL stdout。

### 修复

`extractSessionId()` 新增 JSONL 解析作为优先路径：

```javascript
function extractSessionId(stderr, stdout) {
  // 1) Try JSONL stdout (codex --json mode): thread.started event carries thread_id
  const jsonLines = (stdout || '').split('\n').filter(Boolean);
  for (const line of jsonLines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'thread.started' && evt.thread_id) {
        return evt.thread_id;
      }
    } catch { /* skip non-JSON lines */ }
  }

  // 2) Fallback text patterns (codex without --json, or stderr preamble)
  const combined = `${stderr || ''}\n${stdout || ''}`;
  const patterns = [
    /session id:\s*([^\s]+)/i,
    /"session_id"\s*:\s*"([^"]+)"/i,
    /"sessionId"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match) return match[1];
  }
  return null;
}
```

### 验证

端到端 session resume 测试：

```
Test 1: Create session...
SessionId: 019effb9-e31e-7172-93ef-91cd72b13e6c
Text: REMEMBERED

Test 2: Resume session (sessionId=019effb9-...)
Prompt: "只回答你之前被要求记住的 GPT_BRIDGE_SESSION_SENTINEL_* 值。"
Text: GPT_BRIDGE_SESSION_SENTINEL_20260625

✅ PASS: Session resume works!
```

---

## 根因 3 (P1)：错误信息诊断盲区

### 症状

当 codex 返回非零退出码时，gpt-bridge 只报告 `"codex exited with code 1"`，不含任何上游错误详情。调试者无法从 MCP 返回中判断是模型容量满、schema 格式错误、还是 API 权限问题。

### 根因

`--json` 模式下 codex 的**错误事件也以 JSONL 形式输出到 stdout**（而非 stderr）：

```json
{"type":"error","message":"Invalid schema for response_format 'codex_output_schema': ..."}
{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}
```

但原错误处理路径仅从 stderr 文本中提取错误信息：

```javascript
// 修复前：只读 stderr，漏掉 JSONL 中的 error 事件
const stderrClean = stderr
  .split('\n')
  .filter(l => !l.includes(...))
  .join('\n').trim();
resolve({ success: false, error: stderrClean || `codex exited with code ${code}` });
```

而 `--json` 模式下 stderr 几乎为空，导致有效的错误详情被丢弃。

### 修复

错误处理时同步解析 progressFile 中的 JSONL 错误事件，与 stderr 合并：

```javascript
// 修复后：合并 stderr + JSONL error events
let jsonErrors = [];
try {
  const raw = await readFile(progressFile, 'utf-8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const parsed = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  jsonErrors = parsed.flatMap(e => {
    if (e.type === 'error' && e.message) return [e.message];
    if (e.type === 'turn.failed' && e.error?.message) return [e.error.message];
    return [];
  });
} catch {}
const combinedError = [stderrClean, ...jsonErrors]
  .filter(Boolean).join('; ');
```

---

## 修改清单

| 文件 | 位置 (行) | 改动 | 类型 |
|------|----------|------|------|
| `plugins/gpt-bridge/index.js` | L348-353 | `outputSchema` 写入前强制根级 `additionalProperties: false` | 功能修复 |
| `plugins/gpt-bridge/index.js` | L252-272 | `extractSessionId()` 新增 JSONL `thread.started` 解析 | 功能修复 |
| `plugins/gpt-bridge/index.js` | L522-548 | 错误处理路径新增 JSONL `error` / `turn.failed` 事件提取与合并 | 可观测性提升 |
| `plugins/gpt-bridge/test/gpt-bridge.test.js` | 新增用例 | 覆盖 `thread.started`、schema 强制补全、JSONL 错误事件返回 | 回归测试 |

## 测试结果

```
$ node plugins/gpt-bridge/test/gpt-bridge.test.js

ok - sandbox mode maps to current Codex CLI flags
ok - new Codex exec calls use --sandbox instead of old -p profile misuse
ok - resume Codex exec puts exec-level flags before the resume subcommand
ok - ephemeral opt-in is passed to Codex resume
ok - relative outputFile is resolved under cwd and preserved
ok - missing explicit files fail before launching Codex
ok - absolute explicit files are rejected before launching Codex
ok - escaping explicit files are rejected before launching Codex
ok - project-relative files starting with dotdot text are allowed inside cwd
ok - auto context respects max file count and excludes explicit files
ok - timeout returns an error instead of success
ok - session id can be extracted from JSONL stdout
ok - tool result exposes continuation metadata when Codex returns a session id
ok - outputSchema responses preserve raw JSON and move session data to metadata
ok - outputSchema forces root additionalProperties false for Codex compatibility
ok - JSONL error and turn.failed events are surfaced on Codex failure
ok - MCP server exposes gpt tool over stdio
17/17 tests passed
```

### 端到端验证

| 功能 | 修复前 | 修复后 |
|------|--------|--------|
| outputSchema 基本调用 | ❌ `codex exited with code 1` | ✅ `structuredContent: {ok: true}` |
| outputSchema + additionalProperties | ❌ 上游 API 拒绝 | ✅ 强制根级 `additionalProperties: false` |
| sessionId 提取 | ❌ 始终 null | ✅ `_meta["gpt-bridge/sessionId"]` |
| session resume 往返 | ❌ 无法获取 sessionId | ✅ 两轮会话正确回忆 |
| 错误消息可读性 | ❌ 只有退出码 | ✅ stderr + JSONL 合并报告 |

---

## 技术要点（供后续维护参考）

1. **Codex CLI `--json` 模式的行为特征**：
   - stdout：全部输出以 JSONL 格式（每行一个 JSON 对象）
   - stderr：完全为空（包括 preamble、error 文本全部被重定向到 JSONL stdout）
   - 第一行始终是 `{"type":"thread.started","thread_id":"..."}`
   - 错误事件格式包括 `{"type":"error","message":"..."}` 和 `{"type":"turn.failed","error":{"message":"..."}}`

2. **OpenAI `response_format` 约束**：
   - 根级 JSON Schema **必须**包含 `"additionalProperties": false`
   - 子对象的 `additionalProperties` 可以省略
   - 这是 OpenAI API 端校验，非 Codex CLI 层面的限制

3. **MCP server 热重载**：
   - Claude Code 的 stdio MCP transport 在首次连接后可能缓存 server 进程
   - 修改 MCP server 代码后，MCP tool 调用可能仍使用旧进程
   - 需重启 Claude Code 会话或等待进程自然回收才能加载新代码
   - 直接通过 `node plugins/gpt-bridge/index.js` 测试可绕过此限制
