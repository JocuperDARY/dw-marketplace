---
name: check-updates
description: 全局环境更新与健康检查：默认联网检查 Claude Code、Codex、MCP Servers、Plugins、Skills，以及 CodeGraph、OpenSpec 这类独立 CLI/MCP/项目索引工具的本地版本、注册状态、项目状态和远程 npm 更新状态。用户说“检查更新”“有哪些组件要升级”“看一下 codegraph/openspec/codex 是否需要更新”“check updates”“update check”“outdated”时必须使用。
---

# Check Updates - 全局环境更新检查

> 本 skill 是 [development-workflow](../development-workflow/SKILL.md) 的子模块，覆盖 **AI 编程环境的工具更新、注册状态和健康检查**。它替代旧版只检查 Claude Code 插件/MCP/技能的三段式脚本，新增对 CodeGraph、OpenSpec 和 Codex 的适配。

---

## 适用范围

检查以下组件：

| 类别 | 检查内容 |
|------|----------|
| Claude Code | CLI 版本、启用插件、插件缓存、MCP 配置 |
| MCP Servers | Claude MCP 配置、安装方式分类、CodeGraph/OpenSpec 注册状态 |
| CodeGraph | CLI 版本、npm 全局包、Claude/Codex MCP 注册、当前项目 `.codegraph/`、全局索引 |
| OpenSpec | CLI 版本、npm 全局包、项目 `openspec/` 目录、`openspec-mcp`、MCP 注册 |
| Codex | CLI 版本、`~/.codex/config.toml`、`version.json`、MCP servers、Codex skills/rules |
| Skills | CC Switch skills、Claude local skills、Codex skills、plugin-distributed skills |

---

## 执行流程

### 1. 优先运行插件内脚本

在 Claude Code 插件环境中：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:CLAUDE_PLUGIN_ROOT\skills\check-updates\scripts\check-updates.ps1"
```

在本仓库开发环境中：

```powershell
powershell -ExecutionPolicy Bypass -File ".\plugins\development-workflow\skills\check-updates\scripts\check-updates.ps1"
```

默认模式会联网查询 npm registry，并同时读取版本缓存、配置文件、安装目录和本地 CLI 输出。网络、代理、认证或沙箱导致远程检查失败时，脚本按 `WARN` 汇报，不把整个检查判为失败。

### 2. 受限环境需要本地-only 时加 `-NoRemote`

只有在用户明确要求不联网、当前环境没有网络权限、或正在做离线排障时，才关闭远程检查：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:CLAUDE_PLUGIN_ROOT\skills\check-updates\scripts\check-updates.ps1" -NoRemote
```

`-CheckRemote` 仍可被旧调用传入，但现在只是兼容参数；远程检查已经是默认行为。

### 3. 汇报结果

按以下顺序简要汇报：

1. 是否有 `UPDATE` 项。
2. 是否有 `ERROR` 或需要手动处理的 `WARN` 项。
3. CodeGraph、OpenSpec、Codex 三类新增适配项的状态。
4. 报告 JSON 保存路径。

---

## 结果判读

| 状态 | 含义 | 用户动作 |
|------|------|----------|
| `OK` | 已安装/已注册/本地缓存显示无需更新 | 无需处理 |
| `UPDATE` | 明确发现可更新版本 | 按建议命令升级 |
| `WARN` | 可用但存在缺口，如远程检查失败、版本缓存过旧、MCP 未注册 | 视需求处理 |
| `INFO` | 状态说明，如项目未初始化 OpenSpec、当前仓库未建 CodeGraph 索引 | 不一定需要处理 |
| `MISSING` | 未安装或未找到 | 仅当用户需要该能力时安装 |
| `ERROR` | 检查过程异常 | 先修复脚本权限、配置格式或命令可执行性 |

---

## 适配要点

- CodeGraph 是“CLI + MCP + 项目索引”三层检查：CLI 存在不代表当前仓库已建 `.codegraph/`，MCP 注册也不代表索引健康。
- OpenSpec 是“CLI + 项目目录 + 可选 MCP”三层检查：没有 `openspec/` 目录通常只是当前项目尚未采用 OpenSpec，不应误报为错误。
- Codex 是独立运行时，不属于 Claude Code 插件体系：必须检查 `codex --version`、`~/.codex/config.toml`、`~/.codex/version.json`、`~/.codex/skills` 和 Codex MCP 配置。
- 脚本不得输出配置中的 `env`、token、API key 或 auth 文件内容；只能输出组件名、版本、路径存在性和注册状态。

---

## 相关子Skill

- [dw-tooling](../dw-tooling/SKILL.md) - 工具普查与编排
- [dw-verification](../dw-verification/SKILL.md) - 完成前验证闭环
- [dw-wrapup](../dw-wrapup/SKILL.md) - 收尾、基线和知识持久化
