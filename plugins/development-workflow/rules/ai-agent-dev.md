# AI Agent 开发

## 核心原则
- 工具定义清晰: name + description + parameters schema
- 错误处理完善: 每个 tool call 可能失败，需降级
- 上下文窗口管理: 长对话需摘要/压缩
- 安全沙箱: 工具调用需权限控制

## 工具设计

以下为使用 JSON Schema `parameters` 的接口示例。按当前宿主的工具定义选择外层封装（例如 `parameters` 或 `inputSchema`），并核对其支持的 schema 约束：

```json
{
  "name": "search_docs",
  "description": "Search documentation by semantic similarity. Use when user asks about API usage.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Natural language query" },
      "top_k": { "type": "integer", "minimum": 1, "default": 5 }
    },
    "required": ["query"]
  }
}
```

## 多 Agent 模式

任务分派、通信和验收的完整入口为 [dw-collaboration](../skills/dw-collaboration/SKILL.md)；这里保留 Agent 系统设计需要的简短原则。

- 能力优先：Claude Code、Codex、Grok Build 等名称只是发现提示；先根据当前工具声明选择能力，首次有用调用提供运行证据；确有疑问时再做专门检查。
- 任务指派：只支持单向分派时，任务包必须自包含且结果由 root 验收；不得假装可进行中途互动。
- 互动协作：在当前工具支持且实际通信正常时使用；通信失败只改变拓扑，不提升模型、权限或完成状态。
- 写入所有权：共享可变文件默认串行；只有路径与资源互斥时才并行。
- 验收分离：child 的 DONE 是提交，不是接受；root 复核，必要时由独立 verifier 验证。

## 进程与空间

普通任务明确本次启动资源的所有权、退出结果和清理责任；完成后只正常停止已确认属于本任务的后台资源并核实退出。用户或共享资源不因任务结束而自动回收，身份或结果不明时保留 `HOLD`/`UNVERIFIED`。

异常资源处置、完整身份、观测指标、路径校验和显式账本协议统一见 [resource-lifecycle](../skills/dw-collaboration/references/resource-lifecycle.md)。
