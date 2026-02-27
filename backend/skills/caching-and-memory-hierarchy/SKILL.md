---
name: 缓存与存储层次
type: knowledge_point
enabled: true
description: Cache 设计原理，局部性，快路径与 Amdahl 定律，TLB，Cache 一致性，工作集模型
source: Butler Lampson
---

当学生询问 CPU cache、TLB、Buffer Cache、缓存一致性、页面置换、快路径优化等问题时，先让学生说出自己的理解，再用以下框架引导。

## 缓存的本质模型

缓存保存函数 `f(x)` 的结果，用 `(f, x)` 作为 key：

| 缓存类型 | f | x |
|---------|---|---|
| CPU L1/L2/L3 | 内存地址的内容 | 物理地址 |
| TLB | 虚拟→物理地址翻译 | 虚拟页号（VPN） |
| 文件系统 Buffer Cache | 磁盘块内容 | 设备号 + 块号 |
| 数据库查询缓存 | 查询结果 | SQL + 参数 |

**关键问题**：当 `f(x)` 的值发生变化时，如何让缓存失效？两种策略：
- **通知（Notification / Directory）**：源数据变更时主动通知所有缓存副本 → 精确，但需要维护目录
- **广播（Snooping）**：所有变更广播到总线，各缓存自行监听判断是否失效 → 简单，但不适合大规模

提问：「多核 CPU 的 cache coherence 用哪种策略？为什么 NUMA 系统更倾向 directory 协议？」

## 快路径与 Amdahl 定律

**Fast Path 原则**：让常见情况快速执行，罕见情况可以慢。

Amdahl 定律（缓存版）：
- 命中时延 = f，未命中时延 = s，未命中率 = p
- **平均延迟 = f + p × s**
- 提速来自：提高命中率（降低 p）或降低未命中惩罚（降低 s）

例题：TLB hit = 1 cycle，page table walk = 100 cycles，TLB hit rate = 99%
→ 平均 = 1 + 0.01 × 100 = **2 cycles**（vs. 100 cycles without TLB）

提问：「你的 cache 命中率大概是多少？用 Amdahl 定律估算一下平均访问时延。」

## 时间局部性与空间局部性

- **时间局部性**：刚访问过的数据很快会再次访问 → LRU 替换策略有效
- **空间局部性**：访问地址 x 后，很快会访问 x 附近 → Cache line 批量加载（x86 通常 64 字节）

**Working Set 工作集**：进程在时间窗口 Δ 内访问的独特页面集合
- 若所有进程的工作集之和 > 物理内存容量 → **Thrashing（抖动）**：大量时间花在缺页处理上
- OS 解决方案：工作集模型（动态调整每个进程的驻留页数）或 swapping（暂时换出某进程）

提问：「一个程序出现 Thrashing，你会怎么诊断？`vmstat`/`perf` 看什么指标？」

## Cache 替换策略

| 策略 | 描述 | 适用场景 |
|------|------|---------|
| LRU | 替换最久未使用的 | 通用场景，近似可用 Clock 算法 |
| CLOCK（近似 LRU） | 环形链表 + 访问位 | Linux 页面替换 |
| LFU | 替换使用频率最低的 | 频率分布稳定时 |
| OPT（Bélády） | 替换未来最晚使用的 | 理论上最优，但需预知未来 |

提问：「为什么 Linux 不直接实现 LRU，而用 Clock 近似？」

## TLB 工作原理

- TLB 是页表的缓存：虚拟页号 → 物理页号 + 权限位
- **TLB miss 处理**：
  - x86：MMU 硬件自动遍历页表（Hardware Page Table Walk）
  - MIPS/RISC-V：软件处理（OS TLB miss handler）
- **TLB Shootdown**：多核系统修改页表后，需要 IPI 通知其他核刷新其 TLB → 这是 fork()/mmap() 的隐藏成本

## 常见学生误区

| 误区 | 正确理解 |
|------|---------|
| 缓存越大越好 | 关键是命中率和替换策略；大缓存 = 高延迟（SRAM 面积大） |
| TLB miss 总是由 OS 处理 | 取决于架构：x86 硬件处理，MIPS/RISC-V 软件处理 |
| 页面替换只影响缺页率 | 也影响磁盘 I/O 带宽消耗和整体系统吞吐量 |
| cache 和 TLB 是同一个东西 | TLB 是专门缓存地址翻译的，cache 缓存数据/指令 |
