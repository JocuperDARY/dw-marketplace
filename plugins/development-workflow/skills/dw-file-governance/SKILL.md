---
name: dw-file-governance
description: Use when 规范项目目录分类、分配或回收临时工作区、清理根目录杂物、对可复算大产物做无损脱水归档、或核验产物完整性与空间账本。
---

# 工作区文件治理与无损归档

> 本 skill 是 [development-workflow](../development-workflow/SKILL.md) 的子模块，面向普通开发与跨项目维护，协同 [dw-wrapup](../dw-wrapup/SKILL.md)、[dw-collaboration](../dw-collaboration/SKILL.md) 与 [dw-tooling](../dw-tooling/SKILL.md)，作为工作区路径边界、八类目录分类、轻量双层临时区租约（TempLease1）、无损脱水（DehydratedBundle1）与不可变冷归档（ArchiveManifest1）的唯一规范入口；多智能体受管后台进程、子租约配额与资源账本仍由 [resource-lifecycle.md](../dw-collaboration/references/resource-lifecycle.md) 维护。

## 触发场景

- 需要新建脚本、文档、缓存、实验输出或外部存储路径，先确认落点合法性。
- 需要为长跑任务、构建或批处理分配临时目录，并在任务结束后安全回收。
- 仓库根目录出现临时/大文件堆积、需要按真实物理占用盘点磁盘空间。
- 需要把可复算重型二进制产物（如 `.mph`、`.pt`、`.ckpt`、`.npz`、大型网格/缓存）无损脱水为轻量重建清单，或对历史批次执行只读冷归档。

## 四项硬原则

1. **边界原则（Boundary）**：持久文件落在 `--repo-root` 内或显式 `--allow-external-prefix` 白名单下；拒绝控制字符、Windows 保留设备名（`CON`/`PRN`/`AUX`/`NUL`/`COM1..9`/`LPT1..9`）、越界符号链接/NTFS 重解析点与随意盘符临时路径。
2. **分类原则（Taxonomy）**：根目录仅保留项目入口与声明配置；源码、测试、脚本、配置、文档、受保护基线与运行产物各归其位，新增文件按下方分类表落盘。
3. **可追踪原则（Tracking）**：所有受保护资产由动态 `ProtectedSet`（`git ls-files`、`SHA256SUMS`/`*.sha256`、`templates/**` 及脱水保留清单）自动锁定；任何清理、脱水与封存均产出结构化 JSON 收据与 `SHA256SUMS`。
4. **分层原则（Tiering）**：临时区严格分为 `os` 层（`<os_tempdir>/<scoped_subdir>/`）与已忽略的 `repo` 层（`<repo_root>/.tmp/<run_id>/`）；热运行、脱水重建包与冷归档分层管理，先证明可恢复再释放空间。

## 代码强制门控 vs 语义判断

| 维度 | 执行机制 | 负责范围与判据 |
|------|----------|----------------|
| 1. 路径合法性 | `workspace_governance.py check-path` | 越界、保留设备名、控制字符、根目录杂物、越界重解析点、临时区白名单 |
| 2. 临时区租约 | `workspace_governance.py alloc-temp` | `--tier repo` 强制 `.tmp/` 已被 Git 忽略（否则 `exit 2`），原子写入 `.dw-temp-lease.json` |
| 3. 临时区回收 | `workspace_governance.py reclaim-temp` | 跨平台 PID 存活与启动时间防复用、`HOLD_ACTIVE` 保护、Junction 断路器不穿透目标 |
| 4. 空间与健康审计 | `workspace_governance.py audit` | 动态 `ProtectedSet`、`(st_dev, st_ino)` 物理去重统计、`--check` 退出码门控 |
| 5. 六道门无损脱水 | `workspace_governance.py dehydrate` | 6 项 fail-closed 门控（任一失败 `exit 2` 零删除），先写清单并回读校验再删除目标 |
| 6. 脱水包全量核验 | `workspace_governance.py verify-bundles` | 兼容 `dw-dehydrated-bundle.json` 与 `mph-dehydrated-bundle.json`，1 字节篡改即 `exit 1` |
| 7. 冷归档封存核验 | `workspace_governance.py archive-index` | 不可覆盖封存 `ARCHIVE-MANIFEST.json` + `SHA256SUMS`，`--verify` 检出篡改与额外文件 |
| 语义与业务判断 | 工程师 / Agent 评审 | 判断产物业务价值、选择 `deterministic_recompute` 或 `verified_tolerance_recompute`、确定归档批次边界与用户授权范围 |

## 八类目录分类表（Directory Taxonomy）

| 类别 | 典型路径 | Git 策略 | 生命周期与治理规则 |
|------|----------|----------|-------------------|
| 1. 根目录声明 | `README.md`, `pyproject.toml`, `.gitignore` | 跟踪 | 保持精简，禁止写入 `*.tmp`/`*.log`/`*.mph`/`*.pt` 等杂物 |
| 2. 核心源码 | `src/`, `lib/`, `packages/` | 跟踪 | 仅放可维护源码，变更走标准测试闸门 |
| 3. 自动化测试 | `tests/`, `test/` | 跟踪 | 临时夹具使用测试框架 `tmp_path` 或 `alloc-temp`，结束后自动回收 |
| 4. 工具与脚本 | `tools/`, `scripts/` | 跟踪 | 确定性 CLI 工具，支持 `--dry-run` 与 `--json` |
| 5. 配置与模板 | `config/`, `templates/` | 跟踪 | `templates/**` 自动纳入 `ProtectedSet`，禁止自动化清理 |
| 6. 文档与决策 | `docs/` | 跟踪 | 仅维护有持续价值的规范、架构与验证记录 |
| 7. 临时运行区 | `<os_tempdir>/<scoped>/` 或 `.tmp/<run_id>/` | 忽略 | 必须经 `alloc-temp` 签发租约；`.tmp/` 未忽略时 `exit 2` 阻断 |
| 8. 产物与归档 | `artifacts/`, `artifacts/archive/` | 按策略忽略或外部存储 | 受 `SHA256SUMS` 保护；重型可复算产物走 `dehydrate`，冷批次走 `archive-index` |

## 五步治理闭环（Governance Loop）

1. **Audit**：执行 `python -B scripts/workspace_governance.py audit --repo-root <repo> --json` 盘点物理/逻辑占用、`ProtectedSet`、根目录杂物、孤儿临时区与可脱水候选项。
2. **Dry-Run**：对回收（`reclaim-temp`）、脱水（`dehydrate`）或封存（`archive-index`）先运行默认 `--dry-run --json`，核对受影响路径与预期释放字节数。
3. **Pre-Flight Proof**：脱水前完成重算/重建验证并落盘 `"status": "VERIFIED"` 的 proof JSON；回收前确认目标目录无活跃进程占用；封存前确认批次内无未完结写入。
4. **Atomic Execute**：显式传入 `--execute` 执行变更，落盘 `dw-dehydrated-bundle.json` / `DEHYDRATION-RECEIPT.json` / `ARCHIVE-MANIFEST.json` 与 `SHA256SUMS`。
5. **Verify**：执行 `verify-bundles`、`archive-index --verify` 与 `audit --check`，全部返回退出码 `0` 后再声明治理完成。

## 完成判据与参考资料

治理动作完成需同时具备：对应命令的新鲜退出码 `0` JSON 输出、新生成的收据/清单路径及校验摘要、受保护文件与外部挂载目标零误删证据。

- 路径、目录与临时区规范：[temp-and-directory-governance.md](references/temp-and-directory-governance.md)
- 无损脱水与冷归档协议：[lossless-dehydration-and-archival.md](references/lossless-dehydration-and-archival.md)
- 确定性治理脚本入口：[workspace_governance.py](scripts/workspace_governance.py)
