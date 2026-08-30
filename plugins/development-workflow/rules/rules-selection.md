# DW 规则选择与安全迁移

## 运行时契约

DW 5.0 的 `session-start.js` 会调用 `session-rules.js`，根据
`CLAUDE_PROJECT_DIR` 中实际出现的语言、框架文件和根目录 `package.json`
选择规则。运行时选择器遵守以下约束：

- 只读取 `~/.claude/rules/<language>/` 与 `~/.claude/rules-store/<language>/`
- 活跃目录优先；其规则只列入索引而不重复注入，因为 Claude 已自动加载它们
- 仅当对应活跃目录不存在时，才从 `rules-store` 读取并注入规则正文
- 不复制、不移动、不删除、不恢复规则，也不写状态或缓存
- 不跟随符号链接，所有读取路径必须留在所选语言目录内
- 项目扫描最多三层、4000 个目录项
- 会话规则上下文最多 90 KiB；超出的文件列为 deferred，不截断用户文件
- 未检测到语言时只考虑 `common`，不会猜测 Python 或 TypeScript

## 为什么迁移不再是 SessionStart 钩子

Claude 会在会话启动时自动加载活跃规则目录。若要降低这部分上下文，语言规则确实需要
离开 `~/.claude/rules/`；但这是全局、跨项目的持久化变更，不能由每次启动自动执行。
旧版 `prune-rules.js` 将检测、备份、删除、恢复和状态写入揉在一个并发钩子里，存在
覆盖新规则、备份陈旧、会话互相切换目录和中途失败留下半迁移状态的风险。

DW 5.0 将一次性迁移拆成显式工具。默认命令只输出计划，字节级不修改 `~/.claude`：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --dry-run
```

审阅计划且 `safeToApply` 为 `true` 后，才可由用户明确运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --apply
```

应用流程会先完整预检所有语言目录；任何目标冲突、符号链接或不支持的文件类型都会使
整次迁移在写入前失败。通过预检后，它复制并校验内容摘要，把原目录移动到
`~/.claude/rules-archive/<migration-id>/`，并写入 `manifest.json`。目标已存在但内容不同
时绝不覆盖任一副本。

## 回退

每次应用都会保留原始目录和清单。回退时，在目标
`~/.claude/rules/<language>/` 不存在的前提下，将归档中的对应语言目录移回即可；
`rules-store` 中经过摘要验证的只读副本可以保留，不会被 Claude 自动加载。

不要删除 `rules-archive`，直到至少一次新会话验证规则选择正确，并确认所有需保留的
自定义规则都能在 `manifest.json` 中追溯。
