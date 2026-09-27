# DW Marketplace

Development Workflow 工具集 —— AI 编程助手的开发工作方法论 + GPT 模型桥接。

## 插件

| 插件 | 版本 | 说明 |
|------|------|------|
| [development-workflow](./plugins/development-workflow/) | 5.4.0 | 按任务风险调整计划、实现、验证、资源管理与交接治理，含 13个 Skill（1个总纲 + 12个子 Skill）、2 个 hooks 和 8 组规则 |
| [gpt-bridge](./plugins/gpt-bridge/) | 1.0.0 | MCP Server：Claude Code 对话中调用 GPT 执行子任务 |

## 安装

在 `~/.claude/settings.json` 的 `extraKnownMarketplaces` 中添加：

```json
"dw-marketplace": {
  "source": { "repo": "JocuperDARY/dw-marketplace", "source": "github" }
}
```

然后：

```bash
/plugin install development-workflow@dw-marketplace
/plugin install gpt-bridge@dw-marketplace
```

### gpt-bridge MCP 注册

```bash
claude mcp add gpt-bridge -- node \
  ~/.claude/plugins/cache/dw-marketplace/gpt-bridge/*/plugins/gpt-bridge/index.js
```

## 从旧版迁移

旧版 `development-workflow-skill@development-workflow-skill-marketplace` 用户：

1. 替换 `extraKnownMarketplaces` 中的 marketplace source 为 `JocuperDARY/dw-marketplace`
2. 替换 `enabledPlugins` 键为 `development-workflow@dw-marketplace`
3. 将插件更新到当前的 5.4.0 版本

5.1.0 新增 `dw-collaboration`。它先检查当前工具是否能够创建子 agent、收集结果、双向通信和管理资源，再选择协作方式。

5.2.0 为 `dw-collaboration` 增加三个不依赖第三方包的 CommonJS 模块：逐项登记并核对任务产生的子 agent、进程、终端、端口、临时空间和受限计算；同一失败重复时先总结原因和现状，只允许一次有证据、有明确停止条件的下一步；根据 CPU、内存、I/O、GPU 和预计时间安排并行工作。资源状态和历史记录必须一起成功或一起失败；临时目录检查、失败预算持久化和任务授权都由宿主管理的接口确认；队列只接受已经绑定到真实资源的任务，并在实际启动前重新检查这些资源。GPU 显存占用和实际计算利用率在有界时间窗内分别统计，85% 只作为条件允许时的优化目标；判断依据是持续利用率和实际计算量。付费模型询问列为后续可选方案，5.2.0 不提供该能力。

5.2.1 对资源回收规则增加了观察门控和状态证据要求，并同步发布元数据与测试契约。

5.4.0 候选补充面向用户的中文说明规则：报告先写当前状态、已完成动作和证据，再写尚缺证据、下一步和授权；普通说明少用否定式、对照句和抽象词。正式状态值、路径、哈希、schema 和安全要求保持原样。文本规范与 Windows、Linux、Claude/Codex 的真实组合验证分别进行。

总纲新增铁律 B6《重要文件增删治理》：重要文件（影响后续方向的节点文件、框架核心代码与核心逻辑、技能/规则/契约正文；无耐久备份者为风险加重项）的增删必须完整留痕（含被删内容原文与耐久落点）、保留旧版本；关键修改需经 2–4 个子 agent 交叉审议一致通过，或按无子 agent 备选方案（中断交用户新对话审核 / 多轮异向自审）执行。

### 5.0.0 钩子收敛

5.0.0 只注册两个轻量钩子：

- `SessionStart`：识别真实项目边界并只读选择相关规则
- `UserPromptSubmit`：仅对高置信度开发意图提示对应 DW skill

工具清单改为显式按需运行，不再在会话启动时构造推测性的 MCP/skill 列表：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/tool-inventory.js" --json
```

旧版 `prune-rules.js` 已移除。运行时选择器不会修改用户规则；若需要把活跃语言规则
移出自动加载目录，必须先审阅只读迁移计划：

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/rules-migrate.js" --dry-run
```

计划无冲突并取得用户明确同意后运行 `--apply`。原目录保存在
`~/.claude/rules-archive/<migration-id>/`，不会被删除。
旧仓库 [JocuperDARY/development-workflow-skill](https://github.com/JocuperDARY/development-workflow-skill) 保留归档。

### Windows 与平台验证

在插件目录先运行核心检查，再根据当前主机运行适用的平台套件；各主机的结果分别记录：

```bash
npm run test:core
```

按主机执行对应命令（PowerShell 示例）：

```powershell
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  npm run test:platform:windows
} elseif ($IsLinux) {
  npm run test:platform:linux
} else {
  Write-Error "Unsupported host: platform suite is NOT_RUN"
  exit 2
}
```

Windows 运行会记录 `LIFECYCLE_RAN` 或 `SKIP_NOT_APPLICABLE`。Windows 平台套件所需的 sandbox 或 helper 缺失、不可访问或未获授权时，记录具体原因并标为 `NOT_RUN` 或 `HOLD`；只有 Windows 套件的实际结果可以记录为 Windows 平台通过，核心测试、静态检查、合成 fixture 和其他主机结果分别保留原状态。Linux 原生验收和 Grok Build 验收在计划/TODO 中单独记录为 `NOT_RUN` 或 `deferred`，各自等待对应环境的验证结果。

### 证据状态说明

`IMPLEMENTED` 只表示代码或文本已写入；`PASS_STATIC` 表示结构、路径和哈希检查通过；`PASS_FOCUSED` 表示指定焦点测试通过；`VERIFIED` 需要运行时与独立读回证据；`VERIFIED_DEGRADED` 表示已验证但能力受限；`UNVERIFIED`、`NOT_RUN`、`FAIL` 和 `HOLD` 保留原因，并按原状态记录。5.3 实现平台资源管理；真实 Claude、Codex 或 Grok Build 组合的运行效果仍需对应环境验证。本候选将 Linux 原生和 Grok Build 暂缓验收保持为计划/TODO 中的 `NOT_RUN` 或 `deferred`。

## 许可

Apache License 2.0


5.3.0 合并 dw-handoff 与 dw-collaboration：交接重新审视目标、起点、过程、结果、TODO 与授权/资源边界；重要文件增删遵循 B6 的留痕、旧版本保留和关键变更审批。该说明仅记录当前文本和版本状态；安装、启用和发布按对应流程另行验证。
