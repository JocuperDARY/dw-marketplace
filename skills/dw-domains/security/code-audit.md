# 代码安全审计

## 核心原则
- 追踪数据流: source(外部输入) → sink(危险函数)
- 污点分析: 标记不可信数据，追踪传播路径
- 最小权限: 每个组件只访问其必需的资源

## 审计清单
- [ ] 无硬编码密钥/密码/Token
- [ ] 所有外部输入经过验证
- [ ] 数据库查询参数化
- [ ] 文件操作路径防遍历
- [ ] 反序列化有类型检查
- [ ] 加密使用标准库（不自己实现）
- [ ] 日志不含敏感信息

## 危险函数速查
| 语言 | 危险函数 |
|------|---------|
| JS | eval(), Function(), innerHTML, exec() |
| Python | eval(), exec(), os.system(), pickle.loads() |
| SQL | 字符串拼接的查询 |

## 工具链
- 审查: `Skill:ecc:security-review`
- 扫描: `Skill:ecc:security-scan`
