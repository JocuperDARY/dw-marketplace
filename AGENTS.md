# DW Marketplace — Contributor Guidelines

Multi-plugin marketplace repository. `plugins/` 下各插件独立维护。

## Repository Structure

```
plugins/
├── development-workflow/   # Hooks + Skills + Rules
└── gpt-bridge/             # MCP Server: Codex ↔ GPT
```

## Working on development-workflow

- hooks/ — Session lifecycle (SessionStart, UserPromptSubmit)
- skills/ — 1 core hub + 12 sub-skills
- rules/ — Domain knowledge (coding style, security, testing)

Before modifying: identify target sub-skill/hook/rule; update the aligned version surfaces in `plugins/development-workflow/.claude-plugin/plugin.json`, `plugins/development-workflow/package.json`, `.claude-plugin/marketplace.json`, and the root README when the package release version changes.

## Working on gpt-bridge

- `index.js` — MCP server entry point. Wraps `codex exec` via child_process.
- Uses `@modelcontextprotocol/sdk`.

## Pull Request Requirements

- One change per PR
- Update relevant plugin.json version
- Test end-to-end
