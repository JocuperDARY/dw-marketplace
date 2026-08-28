# DW Marketplace

Development Workflow 工具集 —— AI 编程助手的开发工作方法论 + GPT 模型桥接。

## 插件

| 插件 | 版本 | 说明 |
|------|------|------|
| [development-workflow](./plugins/development-workflow/) | 5.0.0 | 风险分级开发闭环，11个 Skill（1个总纲 + 10个子 Skill）+ 2 hooks + 8 rules |
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
3. 功能完成安全收敛，当前版本为 5.0.0

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
