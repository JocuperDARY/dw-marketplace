# Development Workflow Skill（Plugin v3.0）

全流程开发准则 Plugin —— 为 AI 编程助手提供结构化的开发工作方法论。

**v3.0**：1 个总纲 + 9 个子 Skill + 7 hook 脚本，按流程阶段和领域自动选择。

## 架构总览

```
skills/
├── development-workflow/   # 总纲: 铁律(A1-A4/B1-B5) + 七阶段门控 + 生态衔接
├── dw-diagnosis/           # 阶段一: 诊断与根因定位
├── dw-planning/            # 阶段二: 方案设计与操作指引先行
├── dw-implementation/      # 阶段三~五: TDD + 数据完整性 + 测试闸门
├── dw-verification/        # 阶段六: 三C验证与偏差修复
├── dw-wrapup/              # 阶段七: 收尾与知识持久化
├── dw-optimization/        # 领域: 优化方法论(六类详解 + 库选型)
├── dw-debugging/           # 领域: 诊断与调试方法论
├── dw-tooling/             # 领域: 工具普查与编排
└── dw-reference/           # 领域: 检查清单 + 反模式 + 附录

hooks/
├── hooks.json              # 钩子注册配置
├── session-start.js        # SessionStart: 项目上下文 + 工具协议注入
├── tool-inventory.js       # SessionStart: 扫描可用工具, 17类别分类
├── prune-rules.js          # SessionStart: 按项目语言裁剪规则文件
├── skill-router.js         # UserPromptSubmit: 语义匹配 Skill/MCP/Agent 路由
├── workflow-state.js       # UserPromptSubmit: 七阶段门控追踪 + 循环检测
├── tool-routing.js         # PreToolUse: 代码变更前 checklist 检查
├── subagent-context.js     # PreToolUse: 子代理上下文注入(spec/PRD/plan)
└── post-code-check.js      # PostToolUse: 代码审查提醒标记
```

## 子 Skill 速查

| Skill | 触发场景 | 典型触发词 |
|-------|---------|-----------|
| `development-workflow` | 总纲入口：铁律体系、门控模型 | 工作流准则、开发规范、iron rules |
| `dw-diagnosis` | Bug 调查、异常排查、根因分析 | 诊断、根因、bug分析、问题排查 |
| `dw-planning` | 方案设计、编写操作指引 | 方案设计、操作指引、技术方案 |
| `dw-implementation` | 写代码、TDD、数据完整性 | TDD、实现、哨兵值、测试闸门 |
| `dw-verification` | 验证正确性、三C检查 | 验证、三C、偏差、正确性 |
| `dw-wrapup` | 文档更新、知识落盘 | 收尾、提交、知识持久化、基线对比 |
| `dw-optimization` | 性能分析与优化 | 优化、性能、profiling、加速 |
| `dw-debugging` | 深入调试管道/信号 | 调试、信号诊断、管道 |
| `dw-tooling` | 工具选型、并行编排 | 工具、MCP、编排、普查 |
| `dw-reference` | 查阅检查清单、反模式 | 检查清单、反模式、快速参考 |

## 核心流程（7 阶段）

**诊断 → 方案 → 实现 → 数据完整性 → 测试闸门 → 验证 → 收尾**

9 条铁律（A1-A4 工具使用 + B1-B5 流程纪律）贯穿全流程。

## 安装

```bash
# GitHub 安装
/plugin install github:JocuperDARY/development-workflow-skill

# 或从 marketplace 安装
/plugin marketplace add development-workflow-skill-marketplace
/plugin install development-workflow-skill@development-workflow-skill-marketplace
```

## 生态衔接

```
brainstorming → development-workflow → systematic-debugging / code-review / verify
    (需求模糊)     (操作指引先行)            (执行验证)
```

## 版本

| 版本 | 日期 | 变更 |
|------|------|------|
| **3.0** | 2026-06-15 | 插件架构: 1+9 子 Skill + 7 hooks, marketplace.json 规范化 |
| 2.0 | 2026-06 | 拆分为子模块, tool-proact 集成 |
| 1.4 | 2026-05 | 单一 SKILL.md, 7 阶段完整内容 |

## 许可

Apache License 2.0 — 详见 [LICENSE](LICENSE)
