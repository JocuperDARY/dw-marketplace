# API 设计

## 核心原则
- RESTful 命名（名词复数: /users, /orders）
- 版本化（/v1/ 或 Header）
- 一致的错误格式 `{ error: { code, message } }`
- 分页支持 `{ data, meta: { total, page, limit } }`

## 设计清单
- [ ] 资源命名用名词复数
- [ ] GET 幂等，POST 创建，PUT/PATCH 更新，DELETE 删除
- [ ] 查询参数用于过滤/排序/分页
- [ ] 201 Created + Location header 用于创建
- [ ] 204 No Content 用于删除
- [ ] 限流头: X-RateLimit-*
- [ ] OpenAPI/Swagger 文档

## 错误格式
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [{"field": "email", "reason": "missing"}]
  }
}
```

## 工具链
- 设计: `Skill:api-design`, `Skill:design-an-interface`
- 文档: OpenAPI / Swagger
