# RAG 系统设计

## 核心原则
- 文档分块策略: 按语义边界（段落/章节），非固定字符数
- 向量数据库选型: 规模 <1M → pgvector/Chroma; >1M → Pinecone/Weaviate
- 检索+重排序: 粗召回(top-k) → 精排(reranker)
- 引用溯源: 每个生成结果标注来源文档+位置

## 分块策略
| 文档类型 | 块大小 | 重叠 |
|---------|--------|------|
| 代码 | 函数/类级别 | 导入+签名 |
| 文档 | 段落 (200-500字) | 1-2句 |
| 对话 | 完整轮次 | 上一轮 |

## 检索增强
- Hybrid search: 向量 + BM25 关键词
- Reranker: cross-encoder 精排
- 查询重写: 用户问题 → 多角度检索查询

## 工具链
- 搜索: `mcp__tavily__tavily_search`
- 嵌入: `mcp__memory__create_entities`
