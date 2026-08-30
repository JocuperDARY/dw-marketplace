# DW Marketplace

Development Workflow 工具集 —— AI 编程助手的开发工作方法论 + GPT 模型桥接。

## 插件

| 插件 | 版本 | 说明 |
|------|------|------|
| [development-workflow](./plugins/development-workflow/) | 5.2.0 | 按任务风险调整计划、实现、验证和资源管理，含 12个 Skill（1个总纲 + 11个子 Skill）、2 个 hooks 和 8 组规则 |
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
3. 将插件更新到当前的 5.2.0 版本

5.1.0 新增 `dw-collaboration`。它先检查当前工具是否真的能够创建子 agent、收集结果、双向通信和管理资源，再选择协作方式；不会只根据 Claude Code、Codex、Grok Build 等产品名称猜测能力。

5.2.0 为 `dw-collaboration` 增加三个不依赖第三方包的 CommonJS 模块：逐项登记并核对任务产生的子 agent、进程、终端、端口、临时空间和受限计算；同一失败重复时先总结原因和现状，只允许一次有证据、有明确停止条件的下一步；根据 CPU、内存、I/O、GPU 和预计时间安排并行工作。资源状态和历史记录必须一起成功或一起失败；临时目录检查、失败预算持久化和任务授权都由宿主管理的接口确认；队列只接受已经绑定到真实资源的任务，并在实际启动前重新检查这些资源。GPU 显存占用和实际计算利用率在有界时间窗内分别统计，85% 只是条件允许时的优化目标，不会通过单点尖峰、空转或无用任务追求数值。付费模型询问仍是未来可选方案，不包含在 5.2.0 中。

### 5.0.0 钩子收敛

5.0.0 只注册两个轻量钩子：

- `SessionStart`：识别真实项目边界并只读选择相关规则
- `UserPromptSubmit`：仅对高置信度开发意图提示对应 DW skill

工具清单改为显式按需运行，不再在会话启动时构造推测性的 MCP/skill 列表：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/tool-inventory.js" --json
```

旧版 `prune-rules.js` 已移除。运行时选择器不会修改用户规则；若需要把活跃语言规则
移出自动加载目录，必须先审阅只读迁移计划：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --dry-run
```

只有在计划无冲突且用户明确同意后才运行 `--apply`。原目录会保存在
`~/.claude/rules-archive/<migration-id>/`，不会被删除。
旧仓库 [JocuperDARY/development-workflow-skill](https://github.com/JocuperDARY/development-workflow-skill) 保留归档。

## 许可

Apache License 2.0
