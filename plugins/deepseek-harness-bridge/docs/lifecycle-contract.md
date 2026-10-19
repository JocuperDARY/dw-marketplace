# 生命周期分类的委派与一致性契约

## 已确认的失败与修复范围

一次只包含 7 条虚构记录的任务使用 mechanical/off、单请求、0 工具。实际运行 completed、cleanup confirmed、JSON valid，无截断；但 S3 的输入是 completed / cleanup unknown / parent accepted，输出却是 closed，且同一输出的 caveat 又说它不应视为 closed。原 closed=2 与错误行本身一致，并非独立的算术错误。原任务还没有为该未覆盖分支规定替代分类。

1.3.1 的格式检查如实标为 format_only，parentAcceptance 仍为 not_assessed。这次增强补充父级可声明的结果约束，不改变历史运行状态，不把这次内容错误归因成清理失败，也不声称提高推理档位已被实测证明能修复错误。

## 委派前先补齐规则

固定、可计算的生命周期表优先由父级本地计算或渲染，无须为已有确定答案增加模型调用。若仍需要委派整理、解释或核对，先确认：

1. 原始状态、cleanup、parent acceptance、live_handle 各表示什么，且不与本次工作者自己的执行状态混用。
2. 关闭、存活、失败、槽位复用的必要条件与优先级。
3. 未覆盖分支的处理。可以补充显式 fallback，或声明多个允许结果并解释不确定性；没有规则时不得偷偷视为 closed。记录 fallback 是父级新增决定，而非追溯成原始唯一答案。
4. 输出覆盖、顺序、字段类型、汇总计算与文字说明的验收方法。

生命周期规则核验使用 verification；已有 reviewContract 适用于开放式逐条依据。新的 lifecycleContract 适用于父级已经核验过允许结果及槽位复用值的表格。两者及 reportContract 的输出形状不同，同一次任务只能选择一种。

## lifecycleContract

该可选字段接受 1–16 个唯一 status 标签、1–64 个唯一 case，序列化后最多 16 KiB。所有 ID/标签为 1–64 个字母、数字、点、下划线或短横线，首字符须为字母或数字。

```json
{
  "statuses": ["closed", "submitted", "live", "unknown", "failure"],
  "cases": [
    {
      "id": "S3",
      "allowedStatuses": ["unknown"],
      "slotReusable": false,
      "basis": "输入 completed/accepted，cleanup unknown 禁止 closed 和复用。父级明确为这个原先未定义的分支选择 unknown。"
    }
  ]
}
```

- 每个 case 必须显式提供非空 allowedStatuses、布尔 slotReusable，以及非空 basis（最多 2048 字符），允许状态必须来自 statuses。
- basis 由父级提供，用于说明事实、规则来源或新增 fallback；插件不解析自然语言规则，也不核验来源真实性。
- 多个 allowedStatuses 表示父级明确允许的不确定分支；并不表示它们在业务意义上相同。
- 插件不内置 closed、unknown 等标签的全局含义，也不把这里的虚构规则变为真实 DW 运行时政策。父级声明错了，字面一致性检查仍可能通过。
- 自动采用 JSON-object 输出，省略 workload/effort 时使用现有 verification/high 默认值。显式 mechanical/off/low 及额度原样保留，并提示父级逐项核验；不会因内容失败自动升级推理或额度。
- 输入契约与 prompt 同享既有请求字节、输出 token 和总预算限制；契约不会扩大权限、能力或预算。

## 输出与结果字段

```json
{
  "rows": [{"id": "S3", "status": "unknown", "slot_reusable": false}],
  "status_counts": {"closed": 0, "submitted": 0, "live": 0, "unknown": 1, "failure": 0},
  "caveats": ["unknown 是父级对缺失分支的显式补充；这里不证明实际任务已清理。"]
}
```

rows 必须按 cases 顺序逐项返回，不得重复、漏项或添加项目。每项 status 必须属于该 case 的 allowedStatuses，slot_reusable 必须与声明的布尔值完全一致。status_counts 必须包含所有声明标签（包括 0），不得添加标签；值为非负整数，必须与实际 rows 重新计数一致。额外输出字段或错误类型不被接受。caveats 是有界非空字符串数组，可以为空，但语义不由自动检查认证。

lifecycleValidation 的状态：

| 状态 | 含义 |
|---|---|
| not_requested | 没有选择契约；不是通过 |
| not_evaluated | 运行未完成或清理未确认等导致无法按完成结果检查 |
| mismatch | JSON/结构、覆盖、顺序、允许结果、复用布尔值或计数不匹配；issues 给出字段路径 |
| consistent | 仅与父级声明及行计数一致；scope 为 declared_lifecycle_outcomes |

consistent 不是内容验收通过。proseAcceptance 与 parentAcceptance 仍为 not_assessed；父级必须核验每个 caveat 与结构化值是否矛盾，以及原始规则/声明是否正确。任意自然语言矛盾无法由这个有限检查器可靠识别；本次原始失败通过 S3 的确定字段约束被定位，而非声称实现了通用文本推理检查。

原始输出不被改写或修补。内容 mismatch 保持实际 runtime/cleanup 状态，既不改为运行失败，也不自动消耗重试额度。修正后的表格与原始失败分别保存，不把多数行正确作为整份验收通过。

## 编排与兼容边界

- single-request 仍只有一次 inference-only/read-only 请求、0 工具、无续接、无自动恢复。内容不匹配不自动重试。
- budgeted 在原始总预算内的截断/格式恢复规则保持不变。生命周期内容不匹配不触发该恢复；checkpoint 不是最终可验收表格。
- 契约参与请求指纹，保存并在重启、重放与显式续接中保持；改变契约却复用 requestId 返回 REQUEST_CONFLICT。旧任务没有该字段时保持原样，不重新判定历史结果。
- 损坏的已保存契约通过已有 INVALID_STATE 路径保留原始记录与锁，等待核对，不启动工作者。

## 离线验收条件

- **LC-1 原始失败回放**：test/fixtures/lifecycle-failure.json 保留原始虚构任务及完整错误正文。声明补充 fallback 后应返回 STATUS_NOT_ALLOWED / rows.S3.status；原 status_counts 与错误行一致，不虚报 COUNT_MISMATCH。原文、completed、confirmed、JSON valid 均保留。
- **LC-2 契约明确性**：缺少布尔值、依据、允许结果，重复 ID、未知状态、越界长度/字节，冲突输出契约在启动前拒绝。S3 的 unknown 是新声明，不追溯为原始要求。
- **LC-3 确定检查**：漏行、多行、重复、乱序、非法状态、复用错误/字符串布尔、缺失/多余/非整数/过期计数应分别拒绝。修正逐行值与全部计数后可以 consistent。
- **LC-4 验收范围**：人为错误的父级声明或与行矛盾的 caveat 不能被声称自动验证正确；测试应明确 proseAcceptance/parentAcceptance 未评估。
- **LC-5 预算与身份**：保留显式 off/2048/1 请求/0 工具及 single-request 续接禁止；预算模式内容不匹配不自动恢复；保存、重放、契约变更冲突和续接不重置契约/总预算。
- **LC-6 集成与回归**：真实官方 SDK 使用禁止网络的本地固定输出，经 MCP 提交/等待/结果回传验证新字段；全套离线回归和实际 npm 归档通过。不调用真实 DeepSeek，不升级正式安装。

相关说明：[交付质量](delegation-quality.md)、[严格输出与恢复](output-recovery.md)、[预算可靠性](budget-reliability.md)。
