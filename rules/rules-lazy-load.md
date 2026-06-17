# 按需加载规则库

> 此文件由 DW 插件 `prune-rules.js` (SessionStart hook) 根据当前项目语言自动生成。
> 模板位于 `skills/dw-domains/rules-lazy-load.md`，运行时填充 `{{PLACEHOLDER}}`。

## 概述

为了降低每次会话的初始上下文占用，语言/框架特定的规则文件已从活跃规则目录中移除，
并存放在 `~/.claude/rules-store/` 中。这些规则不会自动加载，但在需要时应当主动读取。

## 触发规则

当你遇到以下场景时，请**先读取对应的规则文件**，再继续回答：

1. **检测到特定语言的文件**（如 .tsx, .rs, .go, .java 等）— 读取对应语言规则
2. **用户提及特定框架**（如 React, Next.js, Spring Boot）— 读取对应规则
3. **生成新项目/模块** — 读取目标语言的规则以遵循项目编码规范

## 规则索引

| 语言/框架 | 存储位置 | 包含文件 |
|-----------|----------|----------|
{{LANG_LINKS}}

## 使用方法

当上述触发条件满足时，使用 `Read` 工具读取对应规则文件。例如：

- `Read ~/.claude/rules-store/typescript/coding-style.md`
- `Read ~/.claude/rules-store/web/patterns.md`

读取后，规则中的指令优先级与活跃规则相同。

## 已预加载的语言

以下语言的规则已直接加载，无需手动读取：
{{PRELOADED_LANGS}}
