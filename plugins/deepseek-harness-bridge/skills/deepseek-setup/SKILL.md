---
name: deepseek-setup
description: Configure and diagnose the local DeepSeek Harness Bridge plugin. Use when installing this bridge, resolving a missing runtime or API key, or checking whether delegation is ready.
---

Help the user prepare this plugin's installed copy. Setup is local; installation alone does not authorize model spending or changes to existing routing policy.

1. Read the packaged [README](../../README.md). Resolve the plugin root from this skill's location, not from a guessed cache version. Do not edit another installed version.
2. Check the Node executable the MCP server will use. The runtime needs Node.js 24.18+. Set nodePath in the local config to reuse an existing Node through launch.js. Do not run the desktop application as Node or modify global PATH. See [Windows setup](../../docs/windows-setup.md).
3. In the installed plugin root, install the locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund` when installation is within the user's requested scope. Do not use an unpinned `npx` download or substitute a different SDK version. Source marketplace installation does not run npm automatically.
4. Run `node launch.js --doctor`. This shows booleans/versions, never key values. Verify Node support and all dependencies, not merely command exit status. index.js --doctor bypasses local credential/Node setup and is only a low-level diagnostic.
5. Use a user-configured DEEPSEEK_API_KEY or, on Windows, let the user run scripts/set-api-key.ps1 in their own terminal. It uses masked input and DPAPI, with a current-user directory ACL. Never ask for a key in chat; never inspect desktop credentials, dump environments, store plaintext keys or send keys as tool arguments. A GUI login does not configure this bridge.
6. Choose an absolute `DSH_BRIDGE_DATA_DIR` outside all delegated workspaces. Multiple MCP connections can share this store using task-scoped execution ownership. Protocol-3 state needs an explicit quiescent protocol-4 migration; follow [persistent worker upgrade](../../docs/agent-communication.md#protocol-4-migration). Do not migrate active tasks, silently repair partial state or delete a foreign lock.
7. Enable/reconnect the plugin using the host's supported controls when authorized. Confirm that `dsh_doctor` is callable in the intended chat. Report local diagnostic success separately from actual Codex host loading and paid Flash execution.

Inspect dsh_capabilities and select only relevant reviewed capabilities; follow [capability profiles](../../docs/capabilities.md). Do not enable all installed desktop plugins or treat metadata as runtime validation.

When live verification is authorized, preserve the user's total and request constraints; use dsh_plan before dispatch. An expressly authorized one-request smoke uses single-request/inference-only/read-only and cannot retry. A long-task collaboration test uses persistent agents and its authorized scope instead. Omitted spending limits remain omitted; do not invent token or call caps. Record identities, actual usage, input coverage, terminal, cleanup, full result and independent acceptance. Existing authorization persists; do not ask again for approved scope. No paid call is part of doctor or offline tests.
