# 六类优化模式、代码示例与检查清单（Optimization Patterns & Examples）

> 返回 [dw-optimization](../SKILL.md)。先用代表性负载确认热点与端到端贡献，再按层级选择适用模式与验证方法。

## 1. 算法优化（Algorithmic Optimization）

通过更精妙的算法设计提升性能。算法层面的改进通常带来数量级提升，且不依赖硬件。

**典型场景**：冒泡/选择/插入排序 → 快速/归并/基数排序；线性搜索 → 二分/哈希搜索；嵌套循环 → 双指针/滑动窗口/预处理查找表（LUT）；暴力匹配 → 贪心/匈牙利/KM 算法。

```python
# 优化前：每帧实时计算指数衰减
decay = 0.75 ** max(0, stationary_count - 5)

# 优化后：仅缓存有界整数输入；其他输入沿用原表达式
DECAY_LUT = np.array([0.75 ** max(0, i - 5) for i in range(MAX_STATIONARY + 1)])
if isinstance(stationary_count, int) and 0 <= stationary_count <= MAX_STATIONARY:
    decay = DECAY_LUT[stationary_count]
else:
    decay = 0.75 ** max(0, stationary_count - 5)
```

**检查清单**：
- [ ] 是否存在可预计算并缓存的值？
- [ ] `O(n²)` 可否降为 `O(n log n)` 或 `O(n)`？
- [ ] 是否存在冗余计算（相同的值反复计算）？
- [ ] 是否存在可提前退出的循环（early exit）？
- [ ] 排序/搜索是否使用了最合适的算法？

## 2. 库优化（Library / Vectorized Replacement）

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

## 3. JIT 编译优化（JIT Compilation）

当没有合适的库函数可用，且代表性基准表明解释器开销显著时，考虑 JIT。收益取决于数据规模、类型稳定性、预热、缓存和部署环境，不能套用固定倍数。

**适用条件**：热点路径中存在 Python for 循环、循环内无动态类型变化、循环体内主要涉及数值计算、库函数调用开销超过计算本身。

```python
from numba import njit

@njit(cache=True)
def _similarity_cosine(v1, v2):
    """数值热路径示例；是否值得 JIT 由本地基准决定。"""
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    n1 = math.sqrt(v1[0]**2 + v1[1]**2)
    n2 = math.sqrt(v2[0]**2 + v2[1]**2)
    if n1 < 1e-9 or n2 < 1e-9:
        return 0.0
    return dot / (n1 * n2)
```

对比解释器、向量化、JIT 或原生扩展时，使用同一输入和环境，同时报告冷启动、预热后的稳态、编译缓存命中和端到端耗时。

**检查清单**：
- [ ] 热点循环是否可被 `@njit` 装饰？
- [ ] JIT 函数内是否使用了不支持的类型（如 dict/list 的动态类型）？
- [ ] 是否有将小型 helper 内联到 JIT 函数中减少调用开销的空间？
- [ ] 是否使用了 `cache=True` 避免重复编译？
- [ ] JIT 函数是否存在全局变量依赖（需要显式传递）？
- [ ] 是否避免了 JIT 函数内的数组增长操作（如 `np.append`）？

## 4. IO 优化（I/O Batching & Caching）

IO 往往是程序的瓶颈。减少不必要的 IO 可以带来显著的性能提升。

**典型场景**：频繁的 CSV/TXT 读写 → 合并批处理 / lazy loading；重复读取同一文件 → 缓存到内存；逐行写入日志 → 批量 flush / 异步写入；多次打开/关闭同一文件 → 一次打开多次读写。

```python
# 优化前：每帧都追加写入（N 次 IO）
for fid in frames:
    result = compute(fid)
    with open(output_csv, 'a') as f:
        f.write(f"{fid},{result}\n")

# 优化后：减少 open/flush 次数；仅适用于允许该缓冲丢失窗口的任务
# 有 checkpoint/刷盘要求时，先按原恢复契约实现对应动作
with open(output_csv, 'a', buffering=1024 * 1024) as f:
    for fid in frames:
        result = compute(fid)
        f.write(f"{fid},{result}\n")
```

**检查清单**：
- [ ] 是否存在频繁的小文件读写，可否合并？
- [ ] 是否存在重复读取同一文件的可缓存内容？
- [ ] 诊断数据的写入路径是否在性能关键路径上？关闭后的开销是否符合预先定义并实测的预算？
- [ ] 是否有在循环内 `with open(...)` 的模式？
- [ ] 格式变更是否保持追加、崩溃恢复、兼容性和内存契约？不可信输入禁止使用 pickle
- [ ] 是否有全局条件开关可以跳过不必要的 IO？

## 5. 并发并行优化（Concurrency & Parallelism）

| 场景 | 模型 | 库 |
|------|------|----|
| IO 密集型（文件读写/网络请求） | 协程/线程 | `ThreadPoolExecutor` / `asyncio` |
| CPU 密集型（数值计算/循环） | 先比较原生库、线程和多进程 | `ProcessPoolExecutor` 或会释放 GIL 的库 |

**注意事项**：选择模型前测量 GIL 行为、IPC/序列化成本、容器 CPU 配额和依赖线程池。GPU 资源不自动安全共享；并发上限由实测吞吐、内存和外部服务配额决定。

```python
# 多进程并行评估；Windows 调用方放在 if __name__ == "__main__" 下
with concurrent.futures.ProcessPoolExecutor(max_workers=measured_workers) as pool:
    all_results = list(pool.map(process_video, all_tasks))
```

**检查清单**：
- [ ] 多个任务的评估是否存在交叉依赖？
- [ ] IO 操作是否可以异步/后台执行而不阻塞主流程？
- [ ] 并发数是否合理（不过度竞争 CPU/IO 资源）？
- [ ] 是否避免了多进程中共享 GPU 资源导致 OOM？
- [ ] 异常、取消和超时路径是否关闭 executor、回收子进程并释放端口/文件句柄？

## 6. GPU 优化（GPU Offload & Batching）

将适合并行计算的任务卸载到 GPU，释放 CPU 资源。

**典型场景**：大规模矩阵运算、批量 LK 光流（CUDA 后端）、YOLO 推理、批量 IoU 矩阵计算。

```python
# 优化前：3 次 GPU API 调用；实际内核数量由 profiler 确认
main_flow = lk_cuda(main_kpts)
anchor_flow = lk_cuda(anchor_kpts)
buffer_flow = lk_cuda(buffer_kpts)

# 优化后：1 次 GPU API 调用后拆分；先确认批量处理与原调用语义等价
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
