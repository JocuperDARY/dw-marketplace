---
name: dw-optimization
description: Use when 有可复现的性能、吞吐、延迟、内存、I/O 或 GPU 资源问题，并且能够建立基线与代表性工作负载。
---

# 优化方法论

> 本 skill 是 [development-workflow](../development-workflow/SKILL.md) 的子模块，覆盖 **优化核心方法**（性能类量化验证 + 完整优化方法论）。

---

## 优化核心原则

任何优化必须遵循以下五条原则：

1. **功能等价（Functional Equivalence）**：优化不得改变原有行为。相同输入必须满足该 API 预先定义的精确或数值容差契约；浮点或非确定性路径不得事后放宽容差。
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
2. 是否是对目标指标有实质贡献的热点？ → 否 → 标记暂缓，不投入时间
   ↓ 是
3. 是否有更优的算法？             → 是 → 算法优化（复杂度降级/预计算/早期退出）
   ↓ 否
4. 是否有更优的库可替代？         → 是 → 库替换优化（向量化/更快的数据格式）
   ↓ 否
5. 是否适合 JIT 编译？           → 是 → JIT 优化（先计入预热与部署成本）
   ↓ 否
6. 是否有不必要的 IO？           → 是 → IO 优化（批量读写/延迟加载/条件跳过）
   ↓ 否
7. 是否可以并发/并行？           → 是 → 并发并行优化（CPU密集→多进程, IO密集→线程）
   ↓ 否
8. 是否可以 GPU 加速？          → 是 → GPU 优化（合并内核启动/减少传输）
   ↓ 否
9. 保持现状，标记未来关注
```

**原则**：无基线与 profiling 不优化。热点阈值来自用户目标、调用频率和端到端影响，不使用全局固定百分比。

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

### 4. IO 优化

IO 往往是程序的瓶颈。减少不必要的 IO 可以带来显著的性能提升。

**典型场景**：频繁的 CSV/TXT 读写 → 合并批处理 / lazy loading；重复读取同一文件 → 缓存到内存；逐行写入日志 → 批量 flush / 异步写入；多次打开/关闭同一文件 → 一次打开多次读写。

```python
# 优化前：每帧都追加写入（N 次 IO）
for fid in frames:
    result = compute(fid)
    with open(output_csv, 'a') as f:
        f.write(f"{fid},{result}\n")

# 优化后：保持 append 契约，只减少 open/flush 次数；按需分块 checkpoint
with open(output_csv, 'a', buffering=1024 * 1024) as f:
    for fid in frames:
        result = compute(fid)
        f.write(f"{fid},{result}\n")
```

**检查清单**：
- [ ] 是否存在频繁的小文件读写，可否合并？
- [ ] 是否存在重复读取同一文件的可缓存内容？
- [ ] 诊断数据的写入路径是否在性能关键路径上？（诊断关掉后应零开销）
- [ ] 是否有在循环内 `with open(...)` 的模式？
- [ ] 格式变更是否保持追加、崩溃恢复、兼容性和内存契约？不可信输入禁止使用 pickle
- [ ] 是否有全局条件开关可以跳过不必要的 IO？

### 5. 并发并行优化

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

1. **宏观定位**：优先使用仓库/语言原生 profiler 定位端到端热点
2. **微观分析**：对候选热点量化子步骤，同时保留真实调用上下文
3. **资源分析**：按目标检查内存、I/O、CPU、GPU、网络或外部服务等待
4. **根因确认**：确认瓶颈在算法/IO/计算/显存传输的哪一环

**Benchmark 方法论**：

- 用本地代表性工作负载覆盖常见规模和已知边界，不按固定帧数套模板。
- 先定义时间预算或误差目标，再自适应增加重复次数；报告样本数、中位数、尾延迟和离散度。
- 分开测冷启动与稳态；JIT 记录预热，GPU 在计时边界同步，缓存场景区分冷/热。
- 比较候选库时锁定版本、输入、配置和硬件，并先验证输出语义等价。

**对比基线要求**：
- 优化前后的代码在**同一硬件环境**上运行
- 记录并尽量控制系统负载；样本不足或方差过大时不得宣称提升
- 记录测试环境（CPU/GPU/内存/Python 版本/库版本）

---

## 库与实现选型协议

静态性能排行榜会随版本、硬件、数据分布和配置失效。比较 DataFrame、可视化、模型、图像 I/O、序列化或进度展示方案时：

1. 先列硬约束：正确性、格式/接口兼容、内存上限、部署体积、维护状态和安全边界。
2. 用仓库真实版本构造最小但代表性的本地基准；测量端到端路径，不只测微内核。
3. 同时记录迁移成本、可读性、可观测性和回退方案；最快不自动等于最佳。
4. 选定方案后把环境、输入、命令、统计量和功能等价结果写入变更证据。

---

## 相关子Skill

- [dw-implementation](../dw-implementation/SKILL.md) — 实现阶段（含优化相关反模式）
- [dw-verification](../dw-verification/SKILL.md) — 功能等价验证 L1-L3
- [dw-debugging](../dw-debugging/SKILL.md) — 性能异常时的诊断方法
- [development-workflow](../development-workflow/SKILL.md) — 返回总纲
