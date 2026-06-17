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
