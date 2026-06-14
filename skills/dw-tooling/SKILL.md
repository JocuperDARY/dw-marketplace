---
name: dw-tooling
description: 工具普查与编排：普查流程、能力分层框架×6层（规划/实现/并行/验证/记忆/文档）、编排模板×3（轻量/标准/大型）、编排铁律×4、完整工具速查目录（MCP/Skills/Agents/场景速查）、工具使用反模式。触发词：工具、MCP、skill、编排、普查、并行、agent、tool、orchestration、parallel、选型、plugin。
---

# 工具普查与编排

> 本 skill 是 [development-workflow](../development-workflow/SKILL.md) 的子模块，覆盖 **工具普查与编排**。遵循铁律 A4（最大化利用工具）。

---

## 普查流程

```
□ 步骤 1：列出现有环境所有可用辅助工具
   └─ 包括：skill 列表、MCP server 及其 tools、可用的 agent/subagent 类型
□ 步骤 2：按能力分层归类（见下方分层框架）
□ 步骤 3：根据任务特征，从每层选配 1-3 个最匹配的工具
□ 步骤 4：设计编排顺序（串行/并行/流水线）
```

---

## 能力分层框架

### 规划/设计层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 结构化发散 | 引导式提问→多方案探索→收敛→设计文档 | 需求模糊、方案不明 |
| 计划生成 | 将设计转为 WBS 分解、任务列表、依赖图 | 设计确认后、实现前 |
| 代码库架构分析 | 分析现有代码模式，输出文件/接口/数据流蓝图 | 多文件改动、需理解现有架构 |
| 系统架构决策 | 技术选型、可扩展性评估、取舍分析 | 跨模块架构决策 |
| 多视角评估 | 并行出多套方案 + 综合评分 | 重大改动需要多角度评估 |

### 实现层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 测试驱动开发 | 红-绿-重构循环，强制测试先行 | 新功能、bug 修复 |
| 语言/框架惯用法 | 特定语言的最佳实践、设计模式、代码组织 | 模块/类/接口设计 |
| 测试编写 | 测试框架使用、fixtures、覆盖率配置 | 编写测试 |
| 代码清理 | 死代码检测、去重、简化 | 代码维护 |

### 并行/多智能体层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 独立任务并行调度 | 无状态依赖的独立子任务并行执行 | 多模块独立实现 |
| 依赖感知分派 | 按 DAG 顺序逐个分派 agent | 有依赖顺序的多步骤实现 |
| 通用子任务代理 | 文件搜索、信息收集、简单代码修改 | 辅助性工作 |
| 代码深度探索 | 追踪执行路径、映射跨文件调用链 | 理解现有代码链路 |
| 代码审查 | 检查正确性、安全性、惯用性、性能 | 实现后审查 |
| 语言专项审查 | 针对特定语言的深度审查 | 语言特定的代码检查 |
| 安全审查 | 漏洞检测、OWASP Top 10、密钥泄露 | 涉及认证/鉴权/输入处理 |
| 构建修复 | 编译/类型/依赖错误的诊断和修复 | 构建失败时 |

### 验证/质量层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 完成前验证清单 | 系统化的完成前检查（三 C 等） | 改动完成的最后关卡 |
| 系统化调试 | 复现→最小化→假设→插桩→修复→回归 | 复杂 bug 排查 |
| 运行验证 | 启动应用/管线，通过实际运行确认输出 | 集成验证 |
| Diff 审查 | 对变更做正确性 + 简化/提效的双维度审查 | 提交前审查 |

### 记忆/上下文层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 知识持久化 | 将设计决策、参数约定、模块间契约存储 | 防止决策遗忘 |
| 语义检索 | 按语义搜索已存储的知识 | 回溯历史决策 |
| 代码库语义搜索 | 用自然语言描述搜索代码 | 查找现有机制 |

### 文档层

| 能力 | 描述 | 适用场景 |
|---|---|---|
| 文档生成 | 从代码自动生成 README、DESIGN 骨架 | 新模块完成后 |
| 文档同步 | 根据代码变更更新 codemaps 和已有文档 | 改动后同步 |

---

## 编排模板

### 轻量改动（单文件、<30 行）

```
规划（可选） → 实现 → 审查 → 运行验证
```

### 标准改动（多文件、新功能/模块）

```
规划设计 → 计划生成 → 实现 → 审查 → 完成前验证
                       └─ TDD（若新增逻辑）
```

### 大型改动（3+ 模块、跨层影响）

```
规划设计 → 计划生成
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
 并行实现    并行实现    并行实现
 (模块 A)    (模块 B)    (模块 C)
    │           │           │
    └───────────┼───────────┘
                ▼
        并行审查 × N
                │
                ▼
         完成前验证
```

### 编排铁律

1. **无状态依赖 → 并行**：两个模块独立实现、不共享状态时并行启动。
2. **有依赖顺序 → 串行**：A 的输出是 B 的输入时必须等 A 完成。
3. **不确定是否有隐式依赖 → 先探后定**：用代码探索工具追踪数据流。
4. **审查在实现后立即进行**：每个模块完成后即触发审查。

---

## 工具速查目录

### MCP Server 工具

**Code Intelligence — codegraph**

| 工具 | 功能 | 场景 |
|------|------|------|
| `codegraph_explore` | 自然语言查代码，一次返回完整上下文 | 任何代码理解的第一选择 |
| `codegraph_search` | 按符号名快速定位 | 已知函数/类名只需位置时 |
| `codegraph_impact` | 分析修改某符号的影响范围 | 重构前评估风险 |
| `codegraph_callers` / `codegraph_callees` | 查调用者/被调用者 | 追踪数据流和控制流 |

**Documentation — context7**

| 工具 | 功能 | 场景 |
|------|------|------|
| `resolve-library-id` | 将库名解析为 Context7 ID | 使用任何库的第一步 |
| `query-docs` | 查询最新 API 文档和代码示例 | 写 API 调用前验证 |

**Deep Reasoning — sequential-thinking**

| 工具 | 功能 | 场景 |
|------|------|------|
| `sequentialthinking` | 多步骤结构化推理，支持分支/修订/回溯 | 复杂架构决策、多候选根因排查 |

**Web Search — tavily + brightdata**

| 工具 | 功能 | 场景 |
|------|------|------|
| `tavily_search` | Web 搜索 | 查最新版本、已知 bug |
| `tavily_research` | AI 驱动的深度多源研究 | 综合多来源信息 |
| `tavily_extract` | 提取 URL 为 Markdown | 阅读在线文档 |

**Knowledge Graph — memory**

| 工具 | 功能 | 场景 |
|------|------|------|
| `create_entities` | 创建知识图谱节点 | 存储 Bug 根因、项目规则 |
| `search_nodes` / `read_graph` | 搜索/读取知识图谱 | 会话开始时恢复上下文 |

**GitHub — github**

| 工具 | 功能 |
|------|------|
| `create_pull_request` | 创建 PR |
| `push_files` | 批量推送文件 |
| `search_code` / `search_issues` | 搜索代码/Issue |

### Plugin Skills

| Skill | 场景 |
|-------|------|
| `systematic-debugging` | Bug/异常/测试失败——强制先复现+根因 |
| `brainstorming` | 设计方案前——探索需求、发散方案 |
| `development-workflow` | 非平凡变更前——操作指引先行 |
| `test-driven-development` / `tdd` | 新功能/Bug 修复——RED→GREEN→REFACTOR |
| `requesting-code-review` | 每次代码变更完成后 |
| `ecc:security-review` | 涉及认证、文件 I/O、外部输入的变更 |
| `writing-plans` | 编写正式实施计划 |
| `verification-before-completion` | 完成前——检查所有步骤是否执行 |
| `finishing-a-development-branch` | 实现完成、测试全绿后——合并/PR/清理 |

### 内置 Agent

| Agent | 场景 |
|-------|------|
| `ecc:code-reviewer` | 通用代码质量审查 |
| `ecc:python-reviewer` | Python 专项审查 |
| `ecc:security-reviewer` | 安全漏洞扫描 |
| `ecc:performance-optimizer` | 性能瓶颈分析 |
| `Explore` | 只读代码库探索 |
| `tdd-guide` | TDD 循环指导 |
| `build-error-resolver` | 编译/类型/依赖错误修复 |

### 按场景速查

| 我要做什么 | 调什么 |
|-----------|--------|
| 理解代码逻辑 | `codegraph_explore` |
| 找函数/类定义 | `codegraph_search` |
| 用第三方库 | 先 `context7 resolve` → `context7 query-docs` |
| 做架构决策 | `sequential-thinking` |
| 遇到 Bug | `Skill:systematic-debugging` |
| 写新功能 | `Skill:tdd` |
| 代码写完了 | `Skill:requesting-code-review` |
| 涉及安全 | `Skill:ecc:security-review` |
| 记住发现 | `memory create_entities` |
| 开始复杂任务 | `Skill:development-workflow` |
| 设计方案 | `Skill:brainstorming` → `Skill:writing-plans` |

---

## 工具使用反模式

| 反模式 | 正确做法 |
|--------|---------|
| ❌ `grep`/`Read` 循环扫描代码库 | `codegraph_explore` 一次返回完整上下文 |
| ❌ 凭记忆写 API 调用 | 先 `context7 query-docs` 查最新文档 |
| ❌ `print()` 调试 | 结构化日志 + 自检哨兵 + 独立复现脚本 |
| ❌ 重要发现只留在对话上下文 | 立即 `memory create_entities` |
| ❌ 代码变更后不审查 | `Skill:requesting-code-review` |
| ❌ 跳过多步骤推理直接动手 | `sequential-thinking` 理清逻辑链 |
| ❌ 修复多个 Bug 后一次性测试 | 每个 Bug 独立 TDD 循环 |

---

## 相关子Skill

- [development-workflow](../development-workflow/SKILL.md) — 返回总纲（铁律 A4 完整内容）
- [dw-implementation](../dw-implementation/SKILL.md) — 实现阶段工具选配
- [dw-reference](../dw-reference/SKILL.md) — 场景化快速参考
