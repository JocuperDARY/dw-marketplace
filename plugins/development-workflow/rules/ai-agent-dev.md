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
- Orchestrator: 任务分解 → 子 agent 并行 → 结果整合
- Router: 根据意图分发到专业 agent
- Evaluator: 独立验证输出质量

## 工具链
- 编排: `Skill:dispatching-parallel-agents`
- 工具: `mcp__sequential-thinking__sequentialthinking`
