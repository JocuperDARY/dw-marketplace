# AI Agent 开发

## 核心原则
- 工具定义清晰: name + description + parameters schema
- 错误处理完善: 每个 tool call 可能失败，需降级
- 上下文窗口管理: 长对话需摘要/压缩
- 安全沙箱: 工具调用需权限控制

## 工具设计
```json
{
  "name": "search_docs",
  "description": "Search documentation by semantic similarity. Use when user asks about API usage.",
  "parameters": {
    "query": { "type": "string", "description": "Natural language query" },
    "top_k": { "type": "number", "default": 5 }
  }
}
```

## 多 Agent 模式
- 能力优先：Claude Code、Codex、Grok Build 等名称只是发现提示；先根据当前工具声明选择能力，首次有用调用提供运行证据；确有疑问时再做专门检查。
- 任务指派：只支持单向分派时，任务包必须自包含且结果由 root 验收；不得假装可进行中途互动。
- 互动协作：在当前工具支持且实际通信正常时使用；通信失败只改变拓扑，不提升模型、权限或完成状态。
- 写入所有权：共享可变文件默认串行；只有路径与资源互斥时才并行。
- 验收分离：child 的 DONE 是提交，不是接受；root 复核，必要时由独立 verifier 验证。

## 进程与空间

普通任务记录本次启动的进程、路径、退出结果和清理责任。以下完整身份与账本要求用于显式采用资源管理协议、恢复进程或处置可疑资源的任务。
- 启动前登记 owner、parent、generation、复合进程身份、作用域、超时、临时根和 teardown condition。
- 监控返回完成/失败计数、返回码分布、精确存活性、最新写入、CPU/内存/I/O、可观测 GPU、磁盘水位和阻塞原因，不用百分比替代进展证据。
- PID、名称、TTL 或表面路径都不能单独授权 kill/delete。只有身份、边界、退出和保留集全部重新验证后，才回收精确的任务资源；未知或重解析点越界进入 HOLD/隔离。
- 完整协议与可执行工件见 [dw-collaboration](../skills/dw-collaboration/SKILL.md)。
