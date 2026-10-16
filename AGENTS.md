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
- skills/ — 1 core hub + 13 sub-skills
- rules/ — Domain knowledge (coding style, security, testing)

Before modifying: identify target sub-skill/hook/rule; update the aligned version surfaces in `plugins/development-workflow/.claude-plugin/plugin.json`, `plugins/development-workflow/package.json`, `.claude-plugin/marketplace.json`, and the root README when the package release version changes.

## Working on gpt-bridge

- `index.js` — MCP server entry point. Wraps `codex exec` via child_process.
- Uses `@modelcontextprotocol/sdk`.

## Pull Request Requirements

- One change per PR
- Update relevant plugin.json version
- Choose checks for the affected behavior. Text-only changes use the existing text, link, and package checks; live harness tests run when that integration changes and an agreed test window is available.

## Marketplace version policy

- Before each independent PR merges into `master`, increment each affected plugin once and record the change. Documentation, tests and fixes use at least PATCH; new functionality uses MINOR; incompatible changes use MAJOR. A mixed change uses its highest applicable level (MAJOR > MINOR > PATCH).
- Revisions within one PR keep its candidate version. Editing version metadata does not itself trigger another increment; unaffected plugins keep their versions.
- Keep the affected plugin's package.json, plugin.json, marketplace entry and README release record aligned. Derive test expectations from these files rather than maintaining another literal version in tests.
- The development-workflow hub's 3.x methodology version is independent of its plugin release version. Preserve historical release notes.
- Use `npm run check:skills` in the development-workflow plugin to validate metadata, links, route targets, declared package assets and complete-suite registration. This read-only check does not validate real host loading or replace relevant behavior tests.

## Current project context

- When local `docs/handoff/` records exist, locate the current handoff through its current index or explicit supersession notes, then consult its status, TODO, and future plan. Verify which snapshot is current rather than relying on a fixed date or filename alone. Local recovery records are excluded from publication.
- Continue work covered by the user's existing authorization and latest instructions. Preserve any user-specified scope, expiry, use limit, or revocation; ask only when a new decision or permission is actually needed.
- Use Git history and a readable diff for reversible source changes. Before replacement, back up unique content that committed history or an existing saved copy cannot recover, including pre-existing uncommitted edits; calculate checksums for transfer, release, or recovery when useful.
- Review meaningful changes once at the appropriate scope, then revisit affected parts when a finding requires a correction. Use additional specialists only for a concrete unresolved risk.
- Historical `.superpowers` plans and goal prompts are reference material. Their repeated hash, approval, and log-copying procedures have been superseded by this handoff.
