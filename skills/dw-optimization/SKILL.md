---
name: dw-optimization
description: 优化方法论：核心原则×5、九步决策树、六类优化详解（算法/库/JIT/IO/并发/GPU）含代码示例和检查清单、JIT性能对比表、性能分析流程(cProfile+Benchmark方法论)、附录C库选型性能参考(Polars/XGBoost/OpenCV/orjson等)。触发词：优化、性能、profiling、加速、算法优化、库优化、JIT、Numba、并发、并行、GPU、optimization、performance、speed、cProfile、内存优化、IO优化、向量化。
---

# 优化方法论

> 本 skill 是 [development-workflow](../development-workflow/SKILL.md) 的子模块，覆盖 **优化核心方法**（性能类量化验证 + 完整优化方法论）。

---

## 优化核心原则

任何优化必须遵循以下五条原则：

1. **功能等价（Functional Equivalence）**：优化不得改变原有行为。相同输入必须产生相同输出。
2. **可替换性（Drop-in Replacement）**：优化后的代码应能无缝替换原代码，接口不变。
3. **可验证性（Verifiability）**：每次优化必须附带验证手段——功能测试确认行为不变，性能测试确认加速真实。
4. **渐进优化（Incremental）**：优先优化热点路径。不做无目标的提前优化。
5. **可读性折中（Readability Trade-off）**：优化不应过度损害可读性。显著牺牲可读性的优化需附加注释说明意图。

---

## 优化决策树

在决定是否优化以及如何优化前，按以下顺序逐级评估：

```
1. 是否有性能问题？               → 无 → 不优化（保持现状）
   ↓ 是
2. 是否是热点路径（≥总耗时 10%）？ → 否 → 标记暂缓，不投入时间
   ↓ 是
3. 是否有更优的算法？             → 是 → 算法优化（复杂度降级/预计算/早期退出）
   ↓ 否
4. 是否有更优的库可替代？         → 是 → 库替换优化（向量化/更快的数据格式）
   ↓ 否
5. 是否适合 JIT 编译？           → 是 → JIT 优化（热路径循环 10-100x 加速）
   ↓ 否
6. 是否有不必要的 IO？           → 是 → IO 优化（批量读写/延迟加载/条件跳过）
   ↓ 否
7. 是否可以并发/并行？           → 是 → 并发并行优化（CPU密集→多进程, IO密集→线程）
   ↓ 否
8. 是否可以 GPU 加速？          → 是 → GPU 优化（合并内核启动/减少传输）
   ↓ 否
9. 保持现状，标记未来关注
```

**原则**：无 profiling 不优化。先用性能分析工具定位热点（≥总耗时 10% 才值得优化），再按树逐级评估。

---

## 优化方法详解

### 1. 算法优化

通过更精妙的算法设计提升性能。算法层面的改进通常带来数量级提升，且不依赖硬件。

**典型场景**：冒泡/选择/插入排序 → 快速/归并/基数排序；线性搜索 → 二分/哈希搜索；嵌套循环 → 双指针/滑动窗口/预处理查找表（LUT）；暴力匹配 → 贪心/匈牙利/KM 算法。

```python
# 优化前：每帧实时计算指数衰减
decay = 0.75 ** max(0, stationary_count - 5)

# 优化后：预计算为模块级常量（查找表）
DECAY_LUT = np.array([0.75 ** max(0, i - 5) for i in range(MAX_STATIONARY + 1)])
decay = DECAY_LUT[stationary_count]
```

**检查清单**：
- [ ] 是否存在可预计算并缓存的值？
- [ ] `O(n²)` 可否降为 `O(n log n)` 或 `O(n)`？
- [ ] 是否存在冗余计算（相同的值反复计算）？
- [ ] 是否存在可提前退出的循环（early exit）？
- [ ] 排序/搜索是否使用了最合适的算法？

### 2. 库优化

用性能更好的库函数替代手动实现。Python 原生 for 循环在数值密集型任务中通常远慢于 numpy 向量化操作。

**典型场景**：Python for 循环逐元素操作 → numpy 向量化/broadcasting；Python list 频繁 append → numpy array / pre-allocate；自行实现的矩阵/向量运算 → numpy/scipy API；pandas `.apply()` + lambda → pandas vectorized ops / numpy。

```python
# 优化前：for 循环筛选
valid = []
for pt in keypoints:
    if inside_box(pt, bbox):
        valid.append(pt)

# 优化后：numpy 布尔索引
mask = (kpts[:, 0] >= xmin) & (kpts[:, 0] <= xmax) & \
       (kpts[:, 1] >= ymin) & (kpts[:, 1] <= ymax)
valid = kpts[mask]
```

**检查清单**：
- [ ] 是否存在可向量化的逐元素循环？
- [ ] 是否可以批量操作替代逐帧/逐框操作？
- [ ] 是否在热点路径中使用 Python 原生容器（list/dict/set）？
- [ ] numpy/pandas 操作是否存在不必要的 copy？
- [ ] pandas 的 `.iterrows()` / `.apply()` 可否替换为 vectorized ops？

### 3. JIT 编译优化

当没有合适的库函数可用，或库函数性能不如 JIT 编译时，考虑 Numba JIT。JIT 对 Python 循环的加速比可达到 10-100x，在某些场景下甚至快于调用 C 语言 DLL（Numba 可内联代码消除调用开销）。

**适用条件**：热点路径中存在 Python for 循环、循环内无动态类型变化、循环体内主要涉及数值计算、库函数调用开销超过计算本身。

```python
from numba import njit

@njit(cache=True)
def _similarity_cosine(v1, v2):
    """inline 余弦相似度——加速比 6x-79x vs Python 原生。"""
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    n1 = math.sqrt(v1[0]**2 + v1[1]**2)
    n2 = math.sqrt(v2[0]**2 + v2[1]**2)
    if n1 < 1e-9 or n2 < 1e-9:
        return 0.0
    return dot / (n1 * n2)
```

**性能对比参考**：

| 优化方式 | Python 原生 | Numpy 向量化 | Numba JIT | C DLL |
|---------|------------|-------------|-----------|-------|
| 简单循环 | 1x | **5-20x** | 20-100x | 10-50x |
| 混合条件逻辑 | 1x | 2-5x | **20-80x** | 10-40x |
| 小数据频繁调用 | 1x | 0.5-2x | **10-50x** | 2-5x |

**检查清单**：
- [ ] 热点循环是否可被 `@njit` 装饰？
- [ ] JIT 函数内是否使用了不支持的类型（如 dict/list 的动态类型）？
- [ ] 是否有将小型 helper 内联到 JIT 函数中减少调用开销的空间？
- [ ] 是否使用了 `cache=True` 避免重复编译？
- [ ] JIT 函数是否存在全局变量依赖（需要显式传递）？
- [ ] 是否避免了 JIT 函数内的数组增长操作（如 `np.append`）？

### 4. IO 优化

IO 往往是程序的瓶颈。减少不必要的 IO 可以带来显著的性能提升。

**典型场景**：频繁的 CSV/TXT 读写 → 合并批处理 / lazy loading；重复读取同一文件 → 缓存到内存；逐行写入日志 → 批量 flush / 异步写入；多次打开/关闭同一文件 → 一次打开多次读写。

```python
# 优化前：每帧都追加写入（N 次 IO）
for fid in frames:
    result = compute(fid)
    with open(output_csv, 'a') as f:
        f.write(f"{fid},{result}\n")

# 优化后：批量写出（1 次 IO）
results = []
for fid in frames:
    results.append((fid, compute(fid)))
with open(output_csv, 'w') as f:
    for fid, result in results:
        f.write(f"{fid},{result}\n")
```

**检查清单**：
- [ ] 是否存在频繁的小文件读写，可否合并？
- [ ] 是否存在重复读取同一文件的可缓存内容？
- [ ] 诊断数据的写入路径是否在性能关键路径上？（诊断关掉后应零开销）
- [ ] 是否有在循环内 `with open(...)` 的模式？
- [ ] CSV/TXT 格式是否可替换为二进制（numpy `.npy` / pickle）？
- [ ] 是否有全局条件开关可以跳过不必要的 IO？

### 5. 并发并行优化

| 场景 | 模型 | 库 |
|------|------|----|
| IO 密集型（文件读写/网络请求） | 协程/线程 | `ThreadPoolExecutor` / `asyncio` |
| CPU 密集型（数值计算/循环） | 多进程 | `multiprocessing.Pool` / `ProcessPoolExecutor` |

**注意事项**：Python GIL 限制——CPU 密集型任务必须使用多进程；多进程的数据传递开销——大数据量应写入共享文件系统而非通过进程间通信传输；GPU 资源在多进程间不自动共享；控制并发数以避免资源耗尽（`min(cpu_count, 32)` 模式）。

```python
# 多进程并行评估
with multiprocessing.Pool(processes=min(os.cpu_count(), 32)) as pool:
    all_results = pool.map(process_video, all_tasks)
```

**检查清单**：
- [ ] 多个任务的评估是否存在交叉依赖？
- [ ] IO 操作是否可以异步/后台执行而不阻塞主流程？
- [ ] 并发数是否合理（不过度竞争 CPU/IO 资源）？
- [ ] 是否避免了多进程中共享 GPU 资源导致 OOM？

### 6. GPU 优化

将适合并行计算的任务卸载到 GPU，释放 CPU 资源。

**典型场景**：大规模矩阵运算、批量 LK 光流（CUDA 后端）、YOLO 推理、批量 IoU 矩阵计算。

```python
# 优化前：多次调用 GPU（3 次内核启动）
main_flow = lk_cuda(main_kpts)
anchor_flow = lk_cuda(anchor_kpts)
buffer_flow = lk_cuda(buffer_kpts)

# 优化后：单次 GPU 调用后拆分（1 次内核启动）
all_kpts = np.concatenate([main_kpts, anchor_kpts, buffer_kpts])
all_flow = lk_cuda(all_kpts)
main_flow, anchor_flow, buffer_flow = split(all_flow, splits)
```

**注意事项**：GPU 显存有限——注意 batch size 控制；CPU-GPU 数据传输是瓶颈——减少 `cpu() ↔ cuda()` 来回拷贝；GPU 不适合逻辑密集或分支密集的运算。

**检查清单**：
- [ ] 是否有连续多次 GPU 调用可合并为一次？
- [ ] CPU↔GPU 数据传输是否必要？可否减少？
- [ ] 推理 batch 大小是否合适（太大会 OOM，太小浪费 GPU）？
- [ ] 是否有仅在 CPU 上运行的逻辑可以卸载到 GPU？

---

## 性能分析流程

1. **宏观定位**：使用 Python `cProfile` 或 `time` 模块定位耗时函数
2. **微观分析**：对候选热点函数使用 `timeit` 量化子步骤耗时
3. **内存分析**：使用 `memory_profiler` 检查是否存在不必要的内存占用
4. **根因确认**：确认瓶颈在算法/IO/计算/显存传输的哪一环

```bash
# 使用 cProfile 定位热点（按累计耗时排序）
python -m cProfile -s cumulative run_analysis.py --exp_dir ... | head -50
```

**Benchmark 方法论**：

| 数据规模 | 重复次数 | 报告指标 |
|---------|---------|---------|
| 小（10 帧） | 1000 | 均值、P50/P95/P99 |
| 中（1000 帧） | 100 | 均值、P50/P95/P99 |
| 大（10000 帧） | 10 | 均值、P50/P95/P99 |

**对比基线要求**：
- 优化前后的代码在**同一硬件环境**上运行
- 排除系统负载干扰（至少运行 3 轮取中位数）
- 记录测试环境（CPU/GPU/内存/Python 版本/库版本）

---

## 附录 C：库选型性能参考

### DataFrame: Polars vs Pandas vs Dask

| 维度 | Pandas | Polars | Dask |
|------|--------|--------|------|
| CSV 写入 (10M 行) | ~35s | **~3s** (10x) | ~47s |
| CSV 读取 (10M 行) | ~10s | **~1.3s** (8x) | ~9s |
| 超内存数据 | ❌ | ⚠️ streaming | ✅ 原生支持 |

```
数据 < 1K 行      → Pandas（零开销，生态成熟）
数据 1K - 10M 行  → Polars（性能优势 2-12x）
数据 > RAM        → Dask（唯一可扩展选项）
```

### 可视化: Matplotlib vs Seaborn vs Plotly

| 场景 | Matplotlib | Seaborn | Plotly (SVG) | Plotly (WebGL) |
|------|-----------|---------|-------------|---------------|
| 1K 数据点 | 瞬开 | 瞬开 | 瞬开 | 瞬开 |
| 10K 数据点 | **快** | 快 | 1-2s | 瞬开 |
| 100K 数据点 | **1-2s** | 3-5s | 10-20s（可能卡死） | **1-2s** |
| 1M 数据点 | **5-10s** | 极慢 | 崩溃 | **3-5s** |
| 交互性 | ❌ 静态 | ❌ 静态 | ✅ 丰富 | ✅ 丰富 |
| 出版质量 | ✅ 最佳 | ✅ 好 | ⚠️ 一般 | ⚠️ 一般 |

```
选择建议：
静态出版级图（<100K 点）     → Matplotlib（最快、质量最高）
交互式大规模数据（>100K 点） → Plotly WebGL（render_mode='webgl'）
```

### 梯度提升: XGBoost vs LightGBM vs scikit-learn

| 维度 | scikit-learn GBM | XGBoost | LightGBM |
|------|-----------------|---------|----------|
| 树生长策略 | Level-wise | Level-wise | **Leaf-wise**（最快） |
| 训练速度（CPU） | 基准 1x | ~2-3x | **~5-10x** |
| GPU 加速 | ❌ 不支持 | ✅ 优秀（推理可达 150x） | ✅ 支持 |
| 内存占用 | 高 | 中 | **低** |
| 默认精度 | 一般 | 好 | **差（需调参）** |
| 调参后精度 | 有提升 | 好 | **最佳** |
| 类别特征处理 | 需手动编码 | 需手动编码 | 原生支持 |

```
选择建议：
小型数据 + 快速原型     → scikit-learn（接口统一，零调参）
中等数据 + 开箱即用     → XGBoost（稳定、GPU 友好）
大型数据 + 极致速度     → LightGBM（需调参后最佳）
推理阶段 + GPU 加速     → XGBoost FIL
```

### 图像 I/O: OpenCV vs Pillow vs imageio

| 维度 | OpenCV (cv2) | Pillow (PIL) | imageio |
|------|-------------|-------------|---------|
| JPEG 解码后端 | libjpeg-turbo（快） | 默认解码器 | 自研 |
| 单张读取 (4032×3024) | **~102ms** | ~315ms | ~N/A |
| 批量小图 (100K 张) | **~0.04ms/张** | ~0.10ms/张 | ~0.22ms/张 |
| 懒加载（仅读元数据） | ❌ 总是全解码 | ✅ 支持 | ✅ 支持 |
| 格式支持广度 | 常见格式 | 常见格式 | **最广**（医学/科学）|

```
选择建议：
批量 JPEG 读取 + 像素处理 → OpenCV（最快 2-3x）
仅需元数据/EXIF        → Pillow（懒加载，不读像素）
格式兼容（DICOM/TIFF） → imageio
避免同流程混用两库     → cv2 转 PIL 的 BGR↔RGB 转换有拷贝开销
```

### JSON: orjson vs ujson vs json

| 维度 | json（标准库） | ujson | orjson |
|------|--------------|-------|--------|
| 实现语言 | Python/C | C | **Rust** |
| 序列化 (dumps) 速度 | 1x 基准 | ~2x | **~4-6x** |
| 反序列化 (loads) 速度 | 1x 基准 | ~1.3-2x | **~3-4x** |
| 返回类型 | str | str | **bytes** |
| datetime 原生 | ❌ | ❌ | ✅ |
| dataclass 原生 | ❌ | ❌ | ✅ |
| numpy 数组原生 | ❌ | ❌ | ✅ |
| 维护状态 | ✅ 持续 | ⚠️ 仅维护模式 | ✅ 活跃 |

```
选择建议：
高吞吐 API 服务        → orjson（比 stdlib 快 4-6x）
大型 payload (>10MB)   → orjson（Rust 引擎优势明显）
简单脚本低数据量        → json（零依赖，够用）
```

### 进度条: tqdm vs rich.progress

| 维度 | tqdm | rich.progress |
|------|------|---------------|
| 开销（空循环 1M 次） | **~0.38s** | ~3.93s（10x 慢）|
| 开销（100K 次微计算） | **~10.8s** | ~58.5s（5x 慢）|
| 视觉质量 | 基础 ASCII | **丰富的样式/颜色/动画** |
| 多任务进度条 | ❌ 有限 | ✅ **原生支持** |

```
选择建议：
数据处理循环（每次 <1ms） → tqdm（开销小 5-10x）
CLI 工具 + 需要美观   → rich.progress
每次迭代 >50ms 的重计算 → 两者差异可忽略
```

### 路径操作: pathlib vs os.path

| 维度 | os.path | pathlib |
|------|---------|---------|
| API 风格 | 函数式（字符串拼接） | **面向对象（Path 对象）** |
| 拼接性能 | **快**（纯字符串操作） | ⚠️ 略慢（Path 对象构造开销）|
| 易用性 | 嵌套、重复路径前缀 | **链式操作、/ 运算符重载** |
| 可读性 | `os.path.join(a, b, c)` | `Path(a) / b / c` |

```
选择建议：
性能关键路径（简单拼接） → os.path（无对象开销）
日常代码/可维护性优先 → pathlib（推荐写法）
```

> **选型通用原则**：性能差异可能来自底层语言（Rust/C++ vs Python）、并行策略、数据格式（Arrow 零拷贝）、计算模型（惰性求值 vs 即时执行）、加速硬件支持。以上数据为多轮 Benchmark 测试中的典型表现，实际效果因数据和场景而异。

---

## 相关子Skill

- [dw-implementation](../dw-implementation/SKILL.md) — 实现阶段（含优化相关反模式）
- [dw-verification](../dw-verification/SKILL.md) — 功能等价验证 L1-L3
- [dw-debugging](../dw-debugging/SKILL.md) — 性能异常时的诊断方法
- [development-workflow](../development-workflow/SKILL.md) — 返回总纲
