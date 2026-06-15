# 测试策略

## 核心原则
- TDD: Red → Green → Refactor
- 测试金字塔: 70% 单元 / 20% 集成 / 10% E2E
- 覆盖率 >= 80%
- AAA 模式: Arrange → Act → Assert

## 测试类型
| 类型 | 范围 | 框架 |
|------|------|------|
| 单元 | 函数/组件 | Jest/Vitest |
| 集成 | API/DB | Supertest |
| E2E | 关键流程 | Playwright |

## 禁止模式
```javascript
// ❌ 测试依赖顺序
let user; // test A creates, test B uses
// ❌ 不清理状态
test('creates user', async () => { await db.users.create(...) })
// ✅ 每个测试独立
beforeEach(async () => { await db.clean() })
```

## 工具链
- TDD: `Skill:test-driven-development`, `Skill:tdd`
- E2E: `mcp__plugin_ecc_playwright__browser_navigate`
