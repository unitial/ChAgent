---
name: OS系统设计原则
type: teaching_strategy
enabled: true
description: 基于 Lampson Hints 框架，引导学生用系统思维分析 OS 设计决策与权衡
source: Butler Lampson
---

当学生提问涉及 OS 设计决策（"为什么这样设计"、"哪种方案更好"、"这个机制的缺陷是什么"）时，运用本指南引导学生进行结构化分析。

## STEADY 设计目标框架

任何 OS 组件都可以从六个维度评估，引导学生逐一思考：

- **Simple**：接口和实现是否尽量简单？复杂性是 bug 的温床。
- **Timely**：能否按时交付？（可以先做出"够用"版本，再迭代）
- **Efficient**：计算、存储、带宽等资源是否高效利用？
- **Adaptable**：能否应对需求变化？策略与机制是否分离？
- **Dependable**：局部故障时整体是否还能保持正确性？
- **Yummy**：使用者（用户/开发者）体验是否友好？

提问方式：「你觉得 Unix fork/exec 设计更符合哪些 STEADY 目标？违反了哪些？」

## 核心原则一：Spec vs. Code 分离

- **Spec（规约）**：接口的行为承诺——调用者需要知道什么？不需要知道什么？
- **Code（实现）**：如何实现 spec——可以替换、可以优化，不影响调用者
- OS 的价值在于稳定的抽象层：进程、文件、地址空间、套接字——这些都是 spec
- 提问：「这个系统调用的 spec 是什么？哪些是实现细节，调用者不应该依赖？」

## 核心原则二：模块化与接口隔离

- 模块只通过接口交互；内部实现可替换
- 常见 OS 模块边界：VFS 与具体文件系统、调度框架与调度策略、驱动接口与硬件
- 反例：Linux 早期内核 monolithic design 的耦合问题 vs. 微内核的过度解耦

## 核心原则三：Keep It Simple

Lampson 的设计流程：**先设计，再编码调试，再测量，最后（必要时）优化。**

- 不要过早优化——先让它正确运行
- 提问：「最简单的能工作的方案是什么？它在什么情况下会不够用？」
- 简单的设计更容易验证正确性，更容易推理并发行为

## 核心原则四：策略与机制分离

- **机制（Mechanism）**：OS 提供的能力（如优先级队列、定时器、地址映射）
- **策略（Policy）**：应用层决定如何使用（如选择哪种调度算法、分配多少内存）
- 经典案例：Linux 的 CFS/RT 调度类是策略，调度框架是机制；mmap 是机制，malloc 是策略

## 主要设计权衡（Oppositions）

引导学生识别每个设计中的内在张力：

| 权衡 | OS 中的体现 |
|------|-------------|
| Simple ↔ Rich | RISC vs. CISC；POSIX vs. Plan 9 |
| Perfect ↔ Adequate | 强一致性 vs. 最终一致性；精确 GC vs. 引用计数 |
| Immutable ↔ Mutable | Copy-on-write vs. 直接修改；不可变文件 vs. mmap |
| Dynamic ↔ Static | 动态链接 vs. 静态链接；动态调度 vs. 实时系统 |
| Indirect ↔ Inline | 虚函数 vs. 直接调用；虚拟内存 vs. 物理地址 |
| Lazy ↔ Eager | Demand paging vs. 预取；写时复制 vs. 立即复制 |

## 教学方法

1. **先问后答**：让学生先提出方案，再一起用 STEADY/权衡框架分析
2. **反例驱动**：用真实 OS 故障（Therac-25、Cloudflare 断网、Linux 死锁 bug）说明违反原则的代价
3. **画模块图**：要求学生画出模块边界和接口，检验抽象是否清晰
4. **对比两个实现**：如 ext4 journaling vs. SQLite WAL，分析各自如何权衡 STEADY
