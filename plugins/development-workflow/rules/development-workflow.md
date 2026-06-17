# Development Workflow

> **Authoritative source**: The `development-workflow` skill (installed via `development-workflow` plugin) defines the canonical methodology. This file summarizes the key phases for quick reference. For the full methodology including 操作指引 templates, 三C validation details, quantified verification methods, and anti-patterns, invoke `Skill:development-workflow:development-workflow`.

> This file extends [common/git-workflow.md](./git-workflow.md) with the full feature development process that happens before git operations.

## Iron Rules (铁律)

From the `development-workflow` skill — these are non-negotiable:

1. **All code changes must use Edit tool** — bypassing Edit makes changes untraceable
2. **Protect sensitive information** — never leak credentials or private data
3. **Agent cannot self-execute git commit** — all commits reviewed by user
4. **Maximize tool usage** — do not rely solely on Read/Edit/Grep/Bash; use plugins, MCP servers, and skills as mandatory workflow components

## Skill Chain

```
brainstorming → development-workflow → implementation → code-review → verify → commit
    (需求模糊)    (操作指引先行)        (TDD)        (审查)      (三C验证)
```

## Feature Implementation Workflow

### Phase 0: Research & Reuse _(mandatory before any new implementation)_

- **GitHub code search first:** Run `gh search repos` and `gh search code` to find existing implementations, templates, and patterns before writing anything new.
- **Library docs second:** Use Context7 or primary vendor docs to confirm API behavior, package usage, and version-specific details before implementing.
- **Exa only when the first two are insufficient:** Use Exa for broader web research or discovery after GitHub search and primary docs.
- **Check package registries:** Search npm, PyPI, crates.io, and other registries before writing utility code. Prefer battle-tested libraries over hand-rolled solutions.
- **Search for adaptable implementations:** Look for open-source projects that solve 80%+ of the problem and can be forked, ported, or wrapped.
- Prefer adopting or porting a proven approach over writing net-new code when it meets the requirement.

### Phase 1: Operational Guideline First (操作指引先行)

- **Write operational guideline before any code** — use `Skill:development-workflow` for the full template
- Structure: (1) Background & Motivation → (2) Solution Exploration (≥2 options) → (3) Selected Solution & Rationale → (4) Implementation Plan with acceptance criteria → (5) Rollback Plan
- Divergent thinking first, then converge on selected approach
- Each implementation step must have a verifiable acceptance criterion

### Phase 2: TDD Implementation

- Use **tdd-guide** agent
- Write tests first (RED)
- Implement to pass tests (GREEN)
- Refactor (IMPROVE)
- Verify 80%+ coverage
- All code modifications via Edit tool (铁律 1)

### Phase 3: 3C Validation (三C验证)

From the `development-workflow` skill — all three must pass:

| C | Check | Method |
|---|-------|--------|
| **Consistency** | Implementation matches guideline? No surprise logic? | Compare against TODO list |
| **Completeness** | All TODOs done? Edge cases handled? Rollback exists? | Checklist verification |
| **Correctness** | Compile/import pass? Functional tests pass? Metrics in range? | Quantified comparison |

- Single failure → return to Phase 2
- Guideline flaw → return to Phase 1
- **3 consecutive cycles without pass → pause and re-evaluate feasibility**

### Phase 4: Code Review

- Use **code-reviewer** agent immediately after writing code
- Address CRITICAL and HIGH issues
- Fix MEDIUM issues when possible

### Phase 5: Sync & Commit

- Record changes in project work history (SYNOPSIS.md or equivalent)
- Document: what changed, why, quantified results, affected files
- Use baseline comparison template for quantified verification results
- Commit with conventional commits format
- See [git-workflow.md](./git-workflow.md) for commit message format and PR process

### Phase 6: Pre-Review Checks

- Verify all automated checks (CI/CD) are passing
- Resolve any merge conflicts
- Ensure branch is up to date with target branch
- Only request review after these checks pass

## Scenario-Specific Quick Reference

| Change Type | Must Execute | Can Simplify | Typical Time |
|-------------|-------------|-------------|-------------|
| **Bug Fix** | Background analysis + minimal repro + functional verification | Integration check can be subset | 1-3h |
| **Performance Optimization** | Baseline comparison + quantified verification + regression check | Guideline can be brief, 1-2 solutions | 2-4h |
| **New Feature/Module** | Full guideline (all 5 sections) + full 3C verification | Solutions can be 2-3 | 1-5d |
| **Refactoring** | Compile check + integration check + 3C consistency | Guideline can be brief | 1-2d |
| **Parameter Tuning** | Baseline comparison + A/B test + ablation | No guideline needed; direct comparison table | 2-8h |
