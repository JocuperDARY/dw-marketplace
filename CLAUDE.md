# Development Workflow Skill — Contributor Guidelines

## If You Are an AI Agent

This is a standalone skill repository. The SKILL.md at the root is the deliverable.

Before proposing changes:

1. **Understand the skill's purpose** — it defines a structured development workflow methodology (诊断 → 方案 → TDD → 数据完整性 → 测试闸门 → 验证 → 收尾)
2. **Skill changes require evidence** — if modifying behavioral content (铁律, 反模式, 检查清单), show before/after examples of how the change affects agent behavior
3. **Version the skill** — update the version number and version records table in SKILL.md
4. **Don't add project-specific content** — this skill is designed to be通用 (universal). If adding project-specific adaptations, those belong in the project's own synopsis directory, not here

## Pull Request Requirements

- One change per PR
- Update the version record table in SKILL.md
- Describe the real problem that motivated the change
- Test that the skill still triggers correctly (the frontmatter `name` and `description` fields)

## Skill Design Philosophy

This skill follows a "strict process, flexible application" design:
- The 铁律 (iron rules) are non-negotiable
- The 工作流程 (workflow) is the recommended path;场景化快速参考 defines acceptable simplifications
- The 反模式 (anti-patterns) are derived from real project failures

## What Does NOT Belong Here

- Project-specific optimization guides (those belong in project repos)
- Tool-specific configuration (this skill is tool-agnostic at its core)
- MCP/server setup instructions (those are environment-specific)
