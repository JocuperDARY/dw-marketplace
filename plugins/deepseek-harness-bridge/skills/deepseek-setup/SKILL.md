---
name: deepseek-setup
description: Configure and diagnose the local DeepSeek Harness Bridge plugin. Use when installing this bridge, resolving a missing runtime or API key, or checking whether delegation is ready.
---

Help the user prepare this plugin's installed copy. Setup is local; installation alone does not authorize model spending or changes to existing routing policy.

1. Read the packaged [README](../../README.md). Resolve the plugin root from this skill's location, not from a guessed cache version. Do not edit another installed version.
2. Check the Node executable the MCP server will use. The official Harness runtime needs Node.js 24.18 or later. A newer executable can be supplied through an explicitly configured MCP launch command. Do not silently run the desktop application as Node or modify global PATH.
3. In the installed plugin root, install the locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund` when installation is within the user's requested scope. Do not use an unpinned `npx` download or substitute a different SDK version. Source marketplace installation does not run npm automatically.
4. Run `node index.js --doctor`. This works before dependencies are present and shows booleans/versions, never key values. Verify Node support and all dependencies, not merely command exit status.
5. Use a user-configured `DEEPSEEK_API_KEY` in the MCP process environment. Never ask the user to paste a key into the conversation; never inspect the desktop credentials file, dump environment variables, store a key in this repository or send it as a tool argument. A GUI login does not configure this bridge.
6. Choose an absolute `DSH_BRIDGE_DATA_DIR` outside all delegated workspaces. One MCP process owns one data directory. Use distinct directories if the host launches separate plugin processes for different chats. A lock error requires reconciliation, not automatic PID-based lock deletion.
7. Enable/reconnect the plugin using the host's supported controls when authorized. Confirm that `dsh_doctor` is callable in the intended chat. Report local diagnostic success separately from actual Codex host loading and paid Flash execution.

When the user has authorized a live smoke task and its finite limits, use a disposable workspace, one task, read-only access, a short timeout and small per-request token/tool limits. Record the task ID, terminal status, cleanup, result and remaining unknowns. Existing authorization persists; do not ask again for already approved scope. No paid call is part of `--doctor` or the offline tests.
