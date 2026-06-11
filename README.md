# Development Workflow Skill

全流程开发准则 Skill —— 为 AI 编程助手提供结构化的开发工作方法论。

## 核心内容

本 Skill 定义了从诊断到收尾的完整 7 阶段开发流程：

- **阶段一：诊断与根因定位** — 多维度证据收集、假设交叉验证、根因层级分类，在找到根因前绝不修复
- **阶段二：操作指引先行** — 写代码前先编写 5 部分操作指引（背景、方案探索、选定理由、实现计划、回退计划）
- **阶段三：TDD 实现** — RED→GREEN→REFACTOR 循环，纯函数测试优先，合成数据优于真实数据
- **阶段四：数据完整性防护** — 哨兵值与真实值区分、运行时元数据落盘、FAIL/WARN 两级自检哨兵
- **阶段五：分层测试闸门** — 单元→集成→风格→类型→代码审查→安全扫描，全绿方进入验证
- **阶段六：三 C 验证闭环** — 一致性（Consistency）、完整性（Completeness）、正确性（Correctness）+ P0-P3 偏差分级修复
- **阶段七：收尾与知识持久化** — 文档更新、基线对比记录、memory 知识库落盘

**9 条铁律**分为两类：
- **工具使用铁律 A1-A4**：Edit 工具强制、敏感信息保护、Agent 不自行 commit、最大化利用工具
- **流程铁律 B1-B5**：计划先行、TODO 对照、偏差分级修复、过测试闸门、数据完整性保护

## 适用范围

适用于**任何**代码改动：新功能、Bug 修复、性能优化、代码重构、参数调整、配置变更。

## 安装

### Claude Code（推荐：插件安装）

在 Claude Code 中直接安装本仓库：

```bash
/plugin install github:JocuperDARY/development-workflow-skill
```

Claude Code 会自动识别 `.claude-plugin/plugin.json` 和 `skills/` 目录，安装后 skill 即刻生效。

### 手动安装

克隆仓库并复制 skill 文件：

```bash
git clone https://github.com/JocuperDARY/development-workflow-skill.git
mkdir -p ~/.claude/skills/development-workflow
cp development-workflow-skill/skills/development-workflow/SKILL.md ~/.claude/skills/development-workflow/
```

## Skill 触发

当你的 AI 助手收到以下类型的请求时，本 Skill 会指导它按结构化流程工作：

- 新功能/新模块添加
- Bug 修复
- 性能优化
- 代码重构
- 参数调整

触发词：工作流准则、开发规范、操作指引、三C验证、闭环流程、量化验证、工作指引、development workflow、operational guideline、iron rules、开发方法论

## 生态衔接

本 Skill 与其他 Skill 组成完整工作链：

```
brainstorming → development-workflow → systematic-debugging / code-review / verify
```

## 版本

当前版本：2.0（2026-06-12）

## 许可

MIT License — 详见 [LICENSE](LICENSE)
