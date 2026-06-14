# Development Workflow Skill — Contributor Guidelines

## If You Are an AI Agent

This is a **multi-skill plugin repository**. The `skills/` directory contains **1 core hub + 9 sub-skills**, each in its own directory:

```
skills/
├── development-workflow/   # Core hub: 铁律 + 阶段门控 + 导航
├── dw-diagnosis/           # Phase 1: 诊断与根因定位
├── dw-planning/            # Phase 2: 方案设计与操作指引先行
├── dw-implementation/      # Phases 3-5: TDD + 数据完整性 + 闸门
├── dw-verification/        # Phase 6: 三C验证与偏差修复
├── dw-wrapup/              # Phase 7: 收尾与知识持久化
├── dw-optimization/        # Domain: 优化方法论 + 附录C
├── dw-debugging/           # Domain: 诊断与调试方法论
├── dw-tooling/             # Domain: 工具普查与编排
└── dw-reference/           # Domain: 检查清单 + 反模式 + 附录AB
```

Before proposing changes:

1. **Identify which sub-skill(s) to modify** — changes should be targeted to the specific sub-skill that covers that domain
2. **Skill changes require evidence** — if modifying behavioral content (铁律, 反模式, 检查清单), show before/after examples of how the change affects agent behavior
3. **Version the skill** — update the version number in the core `development-workflow/SKILL.md` version record table, and note which sub-skill was changed
4. **Don't add project-specific content** — this skill is designed to be通用 (universal). If adding project-specific adaptations, those belong in the project's own synopsis directory, not here
5. **Cross-references** — if a change in one sub-skill affects content in another, update both. Maintain the breadcrumb links (`> 本 skill 是 development-workflow 的子模块`)

## Pull Request Requirements

- One change per PR
- Update the version record table in the core `development-workflow/SKILL.md`
- Describe the real problem that motivated the change
- Test that the skill still triggers correctly (frontmatter `name` and `description` fields must match intended triggers)
- If adding a new sub-skill: add it to the navigation table in the core skill and update `package.json` `files` array

## Skill Design Philosophy

This plugin follows a "strict process, flexible application" design:
- The 铁律 (iron rules) are non-negotiable — defined in the core hub
- The 工作流程 (workflow) is the recommended path; 场景化快速参考 defines acceptable simplifications
- The 反模式 (anti-patterns) are derived from real project failures
- **Each sub-skill is independently triggerable** — the frontmatter `description` must contain domain-specific trigger keywords distinct from other sub-skills

## What Does NOT Belong Here

- Project-specific optimization guides (those belong in project repos)
- Tool-specific configuration (this skill is tool-agnostic at its core)
- MCP/server setup instructions (those are environment-specific)
