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

用性能更好的库函数替代手动实现。

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
- [ ] numpy/pandas 操作是否存在不必要的 copy？
- [ ] pandas 的 `.iterrows()` / `.apply()` 可否替换为 vectorized ops？

### 3. JIT 编译优化

Numba JIT 对 Python 循环的加速比可达到 10-100x。

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
- [ ] 是否使用了 `cache=True` 避免重复编译？
- [ ] 是否避免了 JIT 函数内的数组增长操作（如 `np.append`）？

### 4. IO 优化

IO 往往是程序的瓶颈。减少不必要的 IO 可以带来显著的性能提升。

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
- [ ] 是否有在循环内 `with open(...)` 的模式？
- [ ] CSV/TXT 格式是否可替换为二进制（numpy `.npy` / pickle）？
- [ ] 是否有全局条件开关可以跳过不必要的 IO？

### 5. 并发并行优化

| 场景 | 模型 | 库 |
|------|------|----|
| IO 密集型（文件读写/网络请求） | 协程/线程 | `ThreadPoolExecutor` / `asyncio` |
| CPU 密集型（数值计算/循环） | 多进程 | `multiprocessing.Pool` / `ProcessPoolExecutor` |

**注意事项**：Python GIL 限制——CPU 密集型任务必须使用多进程；控制并发数（`min(cpu_count, 32)` 模式）。

### 6. GPU 优化

将适合并行计算的任务卸载到 GPU，释放 CPU 资源。

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

**注意事项**：GPU 显存有限——注意 batch size 控制；CPU-GPU 数据传输是瓶颈——减少 `cpu() ↔ cuda()` 来回拷贝。

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

### 可视化: Matplotlib vs Plotly

| 场景 | Matplotlib | Plotly (WebGL) |
|------|-----------|---------------|
| 100K 数据点 | **1-2s** | **1-2s** |
| 1M 数据点 | **5-10s** | **3-5s** |
| 交互性 | ❌ 静态 | ✅ 丰富 |

### 梯度提升: XGBoost vs LightGBM

| 维度 | XGBoost | LightGBM |
|------|---------|----------|
| 训练速度（CPU） | ~2-3x | **~5-10x** |
| GPU 加速 | ✅ 优秀 | ✅ 支持 |

### JSON: orjson vs ujson vs json

| 维度 | json（标准库） | ujson | orjson |
|------|--------------|-------|--------|
| 序列化速度 | 1x 基准 | ~2x | **~4-6x** |
| datetime/dataclass 原生 | ❌ | ❌ | ✅ |

### 进度条: tqdm vs rich.progress

| 维度 | tqdm | rich.progress |
|------|------|---------------|
| 开销（空循环 1M 次） | **~0.38s** | ~3.93s |
| 多任务进度条 | ❌ 有限 | ✅ 原生支持 |

### 路径操作: pathlib vs os.path

| 维度 | os.path | pathlib |
|------|---------|---------|
| 拼接性能 | **快** | ⚠️ 略慢 |
| 可读性 | `os.path.join(a,b,c)` | `Path(a) / b / c` |

> **选型通用原则**：性能差异可能来自底层语言（Rust/C++ vs Python）、并行策略、数据格式（Arrow 零拷贝）、计算模型（惰性求值 vs 即时执行）、加速硬件支持。以上数据为多轮 Benchmark 测试中的典型表现，实际效果因数据和场景而异。

---

## 相关子Skill

- [dw-implementation](../dw-implementation/SKILL.md) — 实现阶段（含优化相关反模式）
- [dw-verification](../dw-verification/SKILL.md) — 功能等价验证 L1-L3
- [dw-debugging](../dw-debugging/SKILL.md) — 性能异常时的诊断方法
- [development-workflow](../development-workflow/SKILL.md) — 返回总纲
