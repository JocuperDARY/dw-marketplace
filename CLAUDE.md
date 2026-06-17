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
