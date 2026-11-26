# 临时工作区与目录治理规范

> 返回总览：[SKILL.md](../SKILL.md) | 确定性 CLI：[workspace_governance.py](../scripts/workspace_governance.py) | 租约模式：[TempLease1.schema.json](schemas/TempLease1.schema.json)

本文档说明 `dw-file-governance` 对路径边界、八类目录布局、双层临时目录租约、安全回收及空间审计的具体执行细则。

## 1. 路径边界校验（`check-path`）

在脚本写入持久化产物、临时文件或外部目录前，调用 `check-path` 获取确定性判定：

```bash
python -B scripts/workspace_governance.py check-path \
  --repo-root <REPO_ROOT> \
  --target <TARGET_PATH> \
  --intent persistent|temp|external \
  [--allow-external-prefix <ALLOWED_DIR>] \
  --json
```

代码强制拦截以下违规项（命中任一项返回退出码 `1`，并在 `violations[]` 中给出机器可读 `code`）：

| 违规码 | 触发条件 | 修复方向 |
|--------|----------|----------|
| `CONTROL_CHAR` | 路径含 ASCII 控制字符（`< 0x20` 或 `0x7F`） | 清洗文件名，只保留可打印安全字符 |
| `RESERVED_DEVICE_NAME` | 任一路径段主干命中 `CON`/`PRN`/`AUX`/`NUL`/`COM1..9`/`LPT1..9`（忽略大小写与扩展名） | 重命名路径段，添加业务前缀 |
| `OUTSIDE_REPO_ROOT` | `--intent persistent` 逃逸 `--repo-root` 且未命中 `--allow-external-prefix` | 移回仓库规范目录或显式声明外部前缀 |
| `REPARSE_OR_SYMLINK_ESCAPE` | 目标或其父路径包含符号链接/Windows 重解析点（`0x400`）并指向允许边界外 | 改为真实目录或显式授权目标 |
| `ROOT_CLUTTER` | 仓库根目录直属文件匹配 `*.tmp`/`*.bak`/`*.log`/`*.out`/`.tmp*`/`_scratch*`/`tmp_*`/`*.mph`/`*.pt`/`*.ckpt`/`*.npz` | 移入 `artifacts/`、`.tmp/<run_id>/` 或专用子目录 |
| `ADHOC_TEMP_PATH` | 使用盘符临时目录（如 `C:\Temp`、`D:\tmp`、`/tmp_work`）、同级 `../tmp*` 或 `Desktop` | 改用 `alloc-temp` 签发的 `os` 或 `repo` 层路径 |
| `BARE_TEMP_PATH` | 在 `<os_tempdir>` 或 `.tmp/` 根下直接平铺裸文件，缺少隔离运行子目录 | 使用 `<base>/<scoped_subdir>/...` |
| `REPO_TMP_NOT_GITIGNORED` | `--intent temp` 指向 `.tmp/` 但 `.tmp/` 未被 Git 忽略 | 先在 `.gitignore` 中添加 `.tmp/` 并确认生效 |

## 2. 双层临时目录分配（`alloc-temp`）

临时目录按生命周期与可见性需求分为两层：

1. **`--tier os`（默认推荐）**：在操作系统临时目录（`tempfile.gettempdir()`）下创建 `<project>-<YYYYMMDDTHHMMSSZ>-pid<pid>-<nonce8>-<task>`。适合单元测试、编译缓存、中间转码等无需驻留仓库卷的工作负载。
2. **`--tier repo`（同卷大 I/O 场景）**：在 `<repo_root>/.tmp/` 下创建同命名格式目录。执行前强制校验 `git check-ignore -q .tmp/probe`（无 `.git` 时回退解析 `.gitignore`）；若 `.tmp/` 未被忽略，脚本立刻以退出码 `2` 失败且零创建。

分配成功后，脚本原子写入 `.dw-temp-lease.json`，结构遵循 [TempLease1.schema.json](schemas/TempLease1.schema.json)：

- `schema`: `"dw-temp-lease-v1"`，`schema_version`: `1`
- `pid` 与 `process_start_token`：记录绑定进程 PID 与跨平台进程启动时间令牌（Windows 通过 `OpenProcess` + `GetProcessTimes` 获取 `win-ft:<filetime64>`；Linux 读取 `/proc/<pid>/stat` 第 22 字段 `linux-st:<starttime>`；macOS 回退 `ps -o lstart=`）。
- `lease_sha256`：去除该字段后的规范 JSON（`sort_keys=True`、紧凑分隔符、UTF-8）的 SHA-256 摘要，防止租约篡改。

> **层级边界**：上述 `.dw-temp-lease.json`（`TempLease1`）适用于普通单任务及跨项目临时目录治理；当多智能体协作需要受管子租约配额（软/硬字节上限）、磁盘低水位门控及 `ResourceLedger1` 绑定时，转用 [resource-lifecycle.md](../../dw-collaboration/references/resource-lifecycle.md#temporary-allocation-manifest) 中的 `TemporaryAllocationIdentity2` 协议。

## 3. 安全回收与重解析点断路器（`reclaim-temp`）

```bash
# 先干跑检查
python -B scripts/workspace_governance.py reclaim-temp --repo-root <REPO_ROOT> --grace-sec 600 --json
# 确认后执行回收并落盘收据
python -B scripts/workspace_governance.py reclaim-temp --repo-root <REPO_ROOT> --grace-sec 600 --execute --receipt-out <RECEIPT.json> --json
```

回收判定严格遵守以下防误删不变量：

- **活跃进程绝对保留（`HOLD_ACTIVE`）**：若租约绑定的 PID 当前存活且 `process_start_token` 匹配，即使已超过 `ttl_sec` 也绝不删除。
- **PID 复用识别（`RECLAIM_PID_REUSED`）**：若 PID 存活但 `process_start_token` 与租约记录不一致，说明原进程已退出且操作系统复用了该 PID，允许回收。
- **死亡进程即时可回收（`RECLAIM_DEAD_PID`）**：若 PID 已退出（含 Windows 非 `STILL_ACTIVE` 句柄和 Linux `Z` 僵尸态），标记为可回收。
- **无租约目录宽限期（`--grace-sec`，默认 600 秒）**：`.tmp/` 内无有效租约的目录仅在修改时间超过宽限期时回收（`RECLAIM_UNLEASED_EXPIRED`），宽限期内保留（`HOLD_GRACE_PERIOD`）。开启 `--scan-os-temp` 时仅处理含有效本仓库/本项目租约的目录，跳过系统临时目录中的其他文件。
- **重解析点断路器**：递归清理前对每一级目录项调用 `os.lstat`，命中符号链接或 Windows Junction（`0x400` / `mklink /J`）时仅解除链接本身（Windows 调用 `os.rmdir`，POSIX 调用 `os.unlink`），绝不进入外部目标目录，确保挂载的外部数据零损失。

## 4. 空间与健康审计（`audit`）

```bash
python -B scripts/workspace_governance.py audit \
  --repo-root <REPO_ROOT> \
  --large-file-mb 50 \
  --orphan-grace-sec 600 \
  --check --json
```

- **动态 `ProtectedSet`**：自动汇总非临时区 `SHA256SUMS`/`*.sha256`/`*.sha256.txt` 清单及其引用文件（支持两列、`*` 二进制前缀与三列 `sha256 size path`）、`git ls-files` 已跟踪文件、`templates/**`、`--protected-glob` 匹配文件，以及有效脱水包中的保留证据文件。
- **双口径空间统计**：同时报告 `logical_bytes` 与按 `(st_dev, st_ino)` 去重的 `physical_bytes` 及硬链接去重节省字节数，避免硬链接副本导致的体积误判。
- **已脱水目标豁免**：当某历史 `SHA256SUMS` 引用的大文件已登记在有效 `dw-dehydrated-bundle.json` 或 `mph-dehydrated-bundle.json` 的脱水目标列表中时，不计入 `broken_integrity_refs`。
- **`--check` 退出码**：当且仅当 `root_clutter`、`broken_integrity_refs`、`unignored_large_untracked` 均为 0 且（若 `.tmp/` 存在）`.tmp/` 已被 Git 忽略时返回 `0`，否则返回 `1`。
