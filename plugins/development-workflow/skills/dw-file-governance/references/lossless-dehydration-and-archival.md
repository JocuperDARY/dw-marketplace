# 无损脱水与冷归档协议

> 返回总览：[SKILL.md](../SKILL.md) | 确定性 CLI：[workspace_governance.py](../scripts/workspace_governance.py) | 模式文件：[DehydratedBundle1.schema.json](schemas/DehydratedBundle1.schema.json)、[ArchiveManifest1.schema.json](schemas/ArchiveManifest1.schema.json)

本协议用于在不损失科学/工程可复现性的前提下释放大体积产物空间，并为不再改动的历史批次建立不可篡改的冷归档索引。

## 1. 适用边界与策略选择

| 产物特征 | 推荐策略 | 保留内容 |
|----------|----------|----------|
| 可由确定性命令 + 锁定参数 + 固定引擎版本精确或容差内复算的重型产物（如求解器 `.mph`、大型缓存网格、中间张量） | **无损脱水（`dehydrate`）** | 全部结果表/指标/几何/日志证据 + `dw-dehydrated-bundle.json` + 重建参数与验证证明 |
| 不可复算的原始采集数据、最终认证模型权重、里程碑交付包 | **只读冷归档（`archive-index`）** | 完整原始文件 + `ARCHIVE-MANIFEST.json` + `SHA256SUMS` |
| 受 `ProtectedSet`（已跟踪文件、`SHA256SUMS` 锚定文件、`templates/**`）保护的基线资产 | **保持原位** | 禁止脱水或自动删除；若确需变更须先按仓库规则解除锚定并获明确授权 |

## 2. 六道 Fail-Closed 脱水门控（`dehydrate`）

执行 `dehydrate` 时（无论 `--dry-run` 或 `--execute`），脚本先串行校验 6 道门控；任一门控失败即以退出码 `2` 终止，保证目标文件零删除：

1. **Gate 1（目标合法且未受保护）**：所有 `--target` 位于 `--slot-dir` 内、为常规非链接文件，且不在动态 `ProtectedSet` 中。
2. **Gate 2（零冲突进程）**：当前系统活跃进程中无匹配 `--conflict-proc-substr` 的运行实例（自动排除脚本自身 PID），避免对正在读写的求解器或训练任务脱水。
3. **Gate 3（保留证据与参数完备）**：所有 `--preserve` 文件与 `--parameters-ref` 存在、非符号链接、字节数严格大于 0，且与 `--target` 集合零交集。
4. **Gate 4（前置重建证明通过）**：`--proof-ref` 为合法 JSON 对象，且顶层字段 `"status"` 严格等于 `"VERIFIED"`。
5. **Gate 5（收据目录洁净）**：`--receipt-dir` 中不存在既有的 `DEHYDRATION-RECEIPT.json` 或 `SHA256SUMS`，防止覆盖历史审计记录。
6. **Gate 6（槽位无冲突脱水包）**：`--slot-dir` 中不存在既有的 `dw-dehydrated-bundle.json` 或 `mph-dehydrated-bundle.json`。

### 原子执行顺序（`--execute`）

```text
[1] 6 道门控全通
  -> [2] 流式计算全部 --preserve、--parameters-ref、--proof-ref 与 --target 的 SHA-256 及 inode 元数据
  -> [3] 原子写入 <slot_dir>/dw-dehydrated-bundle.json（含 canonical bundle_sha256）
  -> [4] 立即从磁盘回读并全量校验 bundle_sha256 及所有保留文件字节数与 SHA-256
  -> [5] 回读 100% 通过后，二次确认非重解析点并 unlink 每个 --target
  -> [6] 原子写入 <receipt_dir>/DEHYDRATION-RECEIPT.json 与 <receipt_dir>/SHA256SUMS
```

示例命令：

```bash
python -B scripts/workspace_governance.py dehydrate \
  --repo-root <REPO_ROOT> \
  --slot-dir artifacts/runs/slot_01 \
  --target heavy_mesh.bin \
  --preserve metrics.csv \
  --command-template "solver --params params.json --out heavy_mesh.bin" \
  --engine-version "solver-2.4.1" \
  --parameters-ref artifacts/runs/slot_01/params.json \
  --seed 42 \
  --reproducibility-tier verified_tolerance_recompute \
  --proof-ref artifacts/proofs/slot_01_recompute_proof.json \
  --conflict-proc-substr solver \
  --receipt-dir artifacts/receipts/dehydrate-20261125 \
  --execute --json
```

## 3. 脱水包与历史格式全量核验（`verify-bundles`）

```bash
python -B scripts/workspace_governance.py verify-bundles \
  --repo-root <REPO_ROOT> \
  [--receipt-dir <RECEIPT_DIR>] \
  --json
```

- 同时扫描并校验通用 `dw-dehydrated-bundle.json`（[DehydratedBundle1.schema.json](schemas/DehydratedBundle1.schema.json)）与遗留/专用的 `mph-dehydrated-bundle.json`（`schema_version: "mph-dehydrated-bundle/v1"`，含 `dehydrated_mph_files` 列表与 `preserved_evidence` 映射）。
- 对每个保留文件在磁盘上重新计算真实字节数与 SHA-256；若指定 `--receipt-dir`，同步校验其 `SHA256SUMS` 中每一条目标。任意 1 字节篡改、文件缺失或摘要格式异常均返回退出码 `1`。

## 4. 不可变冷归档封存与核验（`archive-index`）

对里程碑证据、历史实验或只读快照目录执行一次性封存：

```bash
# 干跑预览文件计数与去重物理字节数
python -B scripts/workspace_governance.py archive-index \
  --repo-root <REPO_ROOT> \
  --archive-dir artifacts/archive/milestone-v1 \
  --batch-id milestone-v1 \
  --reason "Milestone v1 immutable snapshot" \
  --source-ref "git:main@abc1234" \
  --json

# 正式封存（已存在清单或 SHA256SUMS 时以 exit 2 拒绝覆盖）
python -B scripts/workspace_governance.py archive-index \
  --repo-root <REPO_ROOT> \
  --archive-dir artifacts/archive/milestone-v1 \
  --batch-id milestone-v1 \
  --reason "Milestone v1 immutable snapshot" \
  --source-ref "git:main@abc1234" \
  --execute --json

# 后续完整性复核（检出内容篡改、文件缺失、新增未登记文件或重解析点）
python -B scripts/workspace_governance.py archive-index \
  --repo-root <REPO_ROOT> \
  --archive-dir artifacts/archive/milestone-v1 \
  --verify --json
```

`ARCHIVE-MANIFEST.json` 字段定义见 [ArchiveManifest1.schema.json](schemas/ArchiveManifest1.schema.json)。封存后的归档目录自动受 `audit` 的 `ProtectedSet` 保护。
