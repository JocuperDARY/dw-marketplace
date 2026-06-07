# Development Workflow Skill

全流程开发准则 Skill —— 为 AI 编程助手提供结构化的开发工作方法论。

## 核心内容

本 Skill 定义了从方案设计到验证同步的完整开发流程：

- **操作指引先行** — 写代码前先编写 5 部分操作指引（背景、方案探索、选定理由、实现计划、回退计划）
- **三 C 验证闭环** — 一致性（Consistency）、完整性（Completeness）、正确性（Correctness）
- **量化验证** — 用数据替代直觉，基线对比替代感觉判断
- **中间态信号检查** — 不只看最终指标，逐级排查管道中的中间信号
- **铁律** — Edit 工具强制、敏感信息保护、Agent 不自行 commit、最大化利用工具

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

触发词：工作流准则、开发规范、操作指引、三C验证、闭环流程、量化验证、工作指引

## 生态衔接

本 Skill 与其他 Skill 组成完整工作链：

```
brainstorming → development-workflow → systematic-debugging / code-review / verify
```

## 版本

当前版本：1.4（2026-06-07）

## 许可

MIT License — 详见 [LICENSE](LICENSE)
