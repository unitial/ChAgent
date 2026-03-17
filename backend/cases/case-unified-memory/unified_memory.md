# Case: 同一个模型，两种命运 —— 分离式内存 vs 统一内存的推理对决

**难度：L4 | 耗时：2.5h | 知识点：统一内存 / 分离式内存 / HBM / PCIe / 内存带宽瓶颈 / LLM 推理 / 数据搬运开销 / 功耗效率 | 来源：工业实践 + 公开 Benchmark**

---

#### 📅 场景

小王是一家 AI 创业公司的工程师。算法团队日常需要在本地环境快速迭代模型 prompt 和做 demo 演示，每次调用云端 A100 既贵又慢（排队 + 网络延迟）。老板问小王："**能不能在 Mac 上跑本地推理，给算法团队做日常开发和端侧 AI 助理的原型验证？**"

公司有两套硬件：机房里一台 NVIDIA A100-80GB 服务器（承担对外推理服务），老板桌上一台 Apple M4 Max MacBook Pro（128GB 统一内存）。小王决定先做一组 **batch=1 单请求**的 benchmark（本地开发场景典型负载），看看 Mac 能不能满足个人使用需求。

> ⚠️ **边界声明**：本 Case 聚焦 **batch=1 单请求场景**（本地开发 / 端侧 AI 典型负载），用于揭示内存架构差异。数据中心部署需要评估大 Batch 高并发吞吐，A100 在该场景下的优势将在步骤 7 讨论。

小王用 llama.cpp 跑了一组对比测试（Q4 量化，batch=1 单请求场景）：

```bash
# A100-80GB (CUDA, llama.cpp)
$ ./llama-bench -m llama-3-8b-q4_k_m.gguf -t 1
model                 size     backend    threads   test     t/s
llama-3-8b-q4_k_m     4.9 GB   CUDA         1      tg128   138.3

# M4 Max 128GB (Metal, llama.cpp)
$ ./llama-bench -m llama-3-8b-q4_k_m.gguf -t 1
model                 size     backend    threads   test     t/s
llama-3-8b-q4_k_m     4.9 GB   Metal        1      tg128    58.7
```

小王看着数据，有点困惑：

"A100 的显存带宽是 2039 GB/s，M4 Max 只有 546 GB/s——差了 **3.7 倍**。但实际推理速度只差 **2.4 倍**？M4 Max 好像'超常发挥'了？"

他决定深入研究这两种截然不同的内存架构。

---

#### 🏗️ 步骤 1：两种内存架构——硬件拓扑的根本差异

小王找到了公司的系统架构师老李。老李在白板上画了两张图：

**架构 A：分离式内存（Discrete Memory）—— NVIDIA GPU / 华为 NPU**

```
分离式内存架构（以 NVIDIA A100 服务器为例）：

  ┌─────────────────────┐                    ┌─────────────────────┐
  │       CPU            │                    │       GPU (A100)     │
  │  ┌───────────────┐  │                    │  ┌───────────────┐  │
  │  │  计算核心      │  │                    │  │  CUDA 核心     │  │
  │  │  (x86/ARM)     │  │                    │  │  (6912 个)     │  │
  │  └───────┬───────┘  │                    │  └───────┬───────┘  │
  │          │          │                    │          │          │
  │  ┌───────▼───────┐  │    PCIe 4.0 x16   │  ┌───────▼───────┐  │
  │  │   CPU DRAM     │  │◄══════════════════►│  │   GPU HBM2e   │  │
  │  │   (DDR5)       │  │    ~32 GB/s 双向   │  │   (80 GB)     │  │
  │  │   256-512 GB   │  │    ≈ 内存带宽的    │  │   2039 GB/s   │  │
  │  └───────────────┘  │      1.6%          │  └───────────────┘  │
  └─────────────────────┘                    └─────────────────────┘
         ↑                                            ↑
    系统内存                                     显存（专用）
    (CPU 可直接访问)                        (GPU 可直接访问)
         └──────── 两个独立的内存空间 ────────────┘
                   数据必须显式搬运！
```

**架构 B：统一内存（Unified Memory）—— Apple M4 / 手机 SoC**

```
统一内存架构（以 Apple M4 Max 为例）：

  ┌──────────────────────────────────────────────────┐
  │                    SoC (M4 Max)                    │
  │                                                    │
  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
  │  │ CPU 核心  │  │ GPU 核心  │  │ Neural Engine │    │
  │  │ (14 核)   │  │ (40 核)   │  │ (16 核)       │    │
  │  └────┬─────┘  └────┬─────┘  └──────┬───────┘    │
  │       │              │               │             │
  │       └──────────────┼───────────────┘             │
  │                      │                             │
  │              ┌───────▼────────┐                    │
  │              │  统一内存池     │                    │
  │              │  (LPDDR5X)     │                    │
  │              │  128 GB        │                    │
  │              │  546 GB/s      │                    │
  │              └────────────────┘                    │
  └────────────────────────────────────────────────────┘
                         ↑
                   一个内存空间
              所有处理单元共享访问
              零拷贝，零 PCIe 开销！

  ⚠️ M4 Max 的 546 GB/s 是怎么来的？
  LPDDR5X-8533：8533 MT/s × 512-bit 位宽 ÷ 8 = 546 GB/s
  关键在于 512-bit 位宽——普通 PC 的 DDR5 双通道只有 128-bit，
  Apple 用了 8 通道（每通道 64-bit），
  这才是统一内存高带宽的硬件基础。
```

"看到了吗？" 老李说。"**根本区别在于：分离式架构有两个独立的内存空间，之间隔着一条 PCIe 管道。而统一架构只有一个内存池，所有计算单元直接共享。**"

---

#### 🔄 步骤 2：数据搬运——分离式架构的"隐性税"

老李继续："在分离式架构上做推理，数据需要怎么流动？"

```
分离式架构的典型推理数据流：

  ┌──────────────────────────────────────────────────────────────┐
  │ 阶段 1：模型加载（一次性）                                    │
  │                                                              │
  │   磁盘 ──(SSD读取)──→ CPU DRAM ──(cudaMemcpy)──→ GPU HBM   │
  │          ~1 GB/s         ↑           ~25 GB/s       ↑        │
  │                      临时驿站                    最终目的地   │
  │                                                              │
  │   140GB 模型（FP16）加载时间：                                │
  │   SSD → CPU: 140GB ÷ 3.5GB/s ≈ 40s                          │
  │   CPU → GPU: 140GB ÷ 25GB/s  ≈ 5.6s（PCIe 4.0 有效带宽）   │
  │   总计 ≈ 46 秒                                               │
  ├──────────────────────────────────────────────────────────────┤
  │ 阶段 2：每次推理请求                                          │
  │                                                              │
  │   输入 tokens:  CPU ──→ GPU    (几十 KB, 可忽略)             │
  │   KV Cache:     在 GPU HBM 内 (不需要搬运)                  │
  │   输出 tokens:  GPU ──→ CPU    (几十 bytes, 可忽略)          │
  │                                                              │
  │   ⚠️ 但如果模型装不下 GPU 显存呢？                           │
  │   LLaMA-70B FP16 = 140GB > A100 的 80GB！                   │
  │   → 部分层必须留在 CPU 端，由 CPU 亲自计算                  │
  │                                                              │
  │   ⚠️ 真实的异构卸载流水线（以 llama.cpp 为例）：            │
  │                                                              │
  │   ┌─────────────────────────────────────────────────────┐    │
  │   │ 层 1-20    CPU 用 DDR 内存(~70 GB/s)做 GEMV          │    │
  │   │            ↓ 传激活值（几 MB）                        │    │
  │   │        ════ PCIe 4.0 (~25 GB/s) ════                 │    │
  │   │            ↓                                          │    │
  │   │ 层 21-80   GPU 用 HBM (2039 GB/s)做 GEMV             │    │
  │   └─────────────────────────────────────────────────────┘    │
  │                                                              │
  │   关键认知纠偏：                                              │
  │   ✗ 错误理解：16GB 权重每个 token 都跨 PCIe 搬一次          │
  │   ✓ 正确理解：权重驻留在 CPU DDR 中，由 CPU 本地计算        │
  │     仅中间激活值（~hidden_size × 2B ≈ 几 MB）走 PCIe        │
  │                                                              │
  │   那瓶颈在哪？在 CPU 端的 DDR 内存带宽！                    │
  │   量化演示（40GB 模型，24GB 显存，16GB 在 CPU 端）：        │
  │   CPU DDR5 双通道有效带宽 ≈ 70 GB/s × 30% 利用率 ≈ 21 GB/s│
  │   CPU 做 16GB 权重的 GEMV：16 / 21 ≈ 0.76 秒/token         │
  │   GPU 做 24GB 权重的 GEMV：24 / (1008×0.5) ≈ 0.048 秒      │
  │   串行流水线总耗时 ≈ 0.76 + 0.048 ≈ 0.81 秒                │
  │   → 上限约 1.2 tok/s，与实测 1-3 tok/s 吻合                 │
  │                                                              │
  │   真正的木桶短板：CPU 端 DDR 带宽（~70 GB/s）               │
  │   比 GPU HBM（1008-2039 GB/s）慢 15-30 倍！                 │
  └──────────────────────────────────────────────────────────────┘
```

"统一内存呢？完全不同：" 老李说。

```
统一内存架构的推理数据流：

  ┌──────────────────────────────────────────────────────────────┐
  │ 阶段 1：模型加载（一次性）                                    │
  │                                                              │
  │   磁盘 ──(SSD读取)──→ 统一内存                               │
  │          ~3.5 GB/s       ↑                                   │
  │                      直接到位！                              │
  │                      CPU/GPU/NPU 都能立刻访问                │
  │                                                              │
  │   没有 PCIe 搬运环节！                                       │
  ├──────────────────────────────────────────────────────────────┤
  │ 阶段 2：每次推理请求                                          │
  │                                                              │
  │   CPU 做 tokenize → GPU 做矩阵运算 → NPU 做后处理           │
  │         ↓                ↓                ↓                  │
  │   全部直接访问统一内存中的模型权重和 KV Cache                 │
  │   零拷贝！切换计算单元无需搬运数据！                          │
  │                                                              │
  │   ⚠️ 内存容量不仅要装权重，还要装 KV Cache！                │
  │   KV Cache 容量公式（per request, FP16）：                   │
  │   = 2 × n_layers × d_model × 2bytes × seq_len              │
  │   70B 模型 (80层, d=8192), seq=4096:                        │
  │   = 2 × 80 × 8192 × 2 × 4096 = 10.7 GB                    │
  │   → 权重 40GB + KV Cache 11GB = 总计 51GB                   │
  │                                                              │
  │   128GB 统一 > 24GB 消费级显存（RTX 4090）                   │
  │   → M4 Max 128GB 轻松容纳权重 + 长上下文 KV Cache            │
  │   → RTX 4090 仅 24GB，连 8B 模型 + 128K 长上下文都吃紧     │
  └──────────────────────────────────────────────────────────────┘
```

"所以 M4 Max 能跑 70B 模型？" 小王问。

"没错——单设备跑完整的 LLaMA-70B Q4 加上合理的 KV Cache，不需要任何层卸载。RTX 4090 只有 24GB 显存，同一个模型必须把 60% 的层放在 CPU 内存由 CPU 计算，速度被 DDR 带宽拖垮。"

```
LLaMA-2-70B Q4 量化（约 40GB）在不同平台的表现：

  ┌─────────────────┬──────────────┬───────────┬──────────────────┐
  │ 平台             │ 可用内存/显存 │ 装得下？   │ 生成速度 (tok/s) │
  ├─────────────────┼──────────────┼───────────┼──────────────────┤
  │ A100-80GB        │ 80GB HBM    │ ✅ 全在GPU │ ~25-30           │
  │ RTX 4090-24GB    │ 24GB GDDR6X │ ❌ 超限    │ ~1-3 (卸载模式)  │
  │ M4 Max-128GB     │ 128GB 统一   │ ✅ 全内存  │ ~8-12            │
  │ M2 Ultra-192GB   │ 192GB 统一   │ ✅ 全内存  │ ~8-12            │
  └─────────────────┴──────────────┴───────────┴──────────────────┘
  
  关键发现：
  • A100 HBM 带宽 2039 GB/s → 最快，但需要 $10k+ 级硬件
  • RTX 4090 显存不够 → 一旦卸载，速度暴跌 10-20 倍
  • M4 Max 统一内存大 → 虽然带宽低但"装得下"，性价比惊人
```

---

#### 📊 步骤 3：内存带宽——LLM 推理的真正瓶颈

小王问："为什么我们一直在讨论带宽，而不是算力？"

老李解释："**LLM 推理的 decode 阶段（逐 token 生成）本质上是 memory-bandwidth-bound（带宽受限），不是 compute-bound（算力受限）。**"

```
为什么 LLM decode 是带宽受限的？

  每生成一个 token 的计算过程：
  
  1. 从内存读取模型全部权重（用于矩阵乘法）
     LLaMA-8B Q4: ~4.9 GB
     LLaMA-70B Q4: ~40 GB
  
  2. 执行矩阵-向量乘法（GEMV）
     计算量：2 × 参数量 ≈ 16 GFLOP (8B 模型)
  
  3. 关键指标——算术强度（Arithmetic Intensity）：
     = 计算量 / 数据量
     = 16 GFLOP / 4.9 GB
     ≈ 3.3 FLOP/Byte  ← 极低！
     
     对比参考：GPU 的算力/带宽比：
     A100:  312 TFLOPS / 2039 GB/s = 153 FLOP/Byte
     M4 Max: 54 TFLOPS / 546 GB/s = 99 FLOP/Byte
     
     3.3 << 153 → 严重带宽受限！
     GPU 的算力大部分时间在空转，等着数据从内存搬过来
  
  结论：decode 速度 ≈ 内存带宽 ÷ 模型大小
  
  理论最大 tok/s 估算：
  ┌─────────────────┬───────────┬────────────┬───────────────────┐
  │ 平台             │ 内存带宽   │ 模型大小    │ 理论 max tok/s    │
  ├─────────────────┼───────────┼────────────┼───────────────────┤
  │ A100-80GB        │ 2039 GB/s │ 4.9GB (8B) │ 2039/4.9 ≈ 416   │
  │ H100-80GB        │ 3350 GB/s │ 4.9GB (8B) │ 3350/4.9 ≈ 683   │
  │ RTX 4090-24GB    │ 1008 GB/s │ 4.9GB (8B) │ 1008/4.9 ≈ 206   │
  │ M4 Max-128GB     │ 546 GB/s  │ 4.9GB (8B) │  546/4.9 ≈ 111   │
  │ M4 Pro-48GB      │ 273 GB/s  │ 4.9GB (8B) │  273/4.9 ≈  56   │
  │ Snapdragon 8G3   │ 77 GB/s   │ 4.9GB (8B) │   77/4.9 ≈  16   │
  ├─────────────────┼───────────┼────────────┼───────────────────┤
  │ A100-80GB        │ 2039 GB/s │ 40GB (70B) │ 2039/40  ≈  51   │
  │ M4 Max-128GB     │ 546 GB/s  │ 40GB (70B) │  546/40  ≈  14   │
  └─────────────────┴───────────┴────────────┴───────────────────┘
  
  ⚠️ 注意：这是理论上限（假设 100% 带宽利用率）
  实测值通常是理论值的 30-60%（受 kernel 效率、调度开销影响）
```

小王恍然大悟："所以 M4 Max 的 58.7 tok/s 实测值，对比理论上限 111 tok/s，利用率大约 **53%**——这和 A100 的利用率（138/416 ≈ 33%）相比其实**更高**！统一内存的零拷贝确实在发挥作用。"

老李点头："**利用率差异不只是'搬运开销'那么简单，还有更深层的内存物理特性差异。**"

```
为什么 batch=1 时统一内存的带宽利用率更高？

  除了零 PCIe 开销之外，还有一个关键因素：内存访问延迟（Latency）

  HBM（High Bandwidth Memory）：
  • 设计目标：极高的并发吞吐量（为大 Batch 优化）
  • 通过大量独立通道（如 A100 有 5120-bit 位宽）实现高带宽
  • 但单次突发读取（Burst Read）的延迟比 LPDDR 更高
  • 在 batch=1 时，宽总线无法被充分填满，延迟成为主要矛盾

  LPDDR5X（Low Power DDR）：
  • 设计目标：移动端的低延迟、低功耗
  • 突发读取延迟更低（面向单请求场景优化）
  • 在 batch=1 的少量并发访问模式下，能保持较高的有效利用率

  类比：HBM 是 8 车道高速公路（吞吐大但上匝道慢），
       LPDDR 是 4 车道城市快速路（车道少但红绿灯少、响应快）。
       只有一辆车的时候，城市快速路反而更快到达目的地。

  → 当 batch size 增大后，HBM 的高吞吐优势才会充分体现，
    A100 的利用率会从 33% 逐步攀升到 60-80%
```

---

#### 📐 步骤 4：CUDA 统一内存——NVIDIA 的"软件补丁"

"等等，" 小王说，"NVIDIA 不是也有个叫 Unified Memory 的东西吗？跟 Apple 的统一内存是一回事吗？"

老李笑了："完全不是！这是一个非常容易混淆的概念。"

```
两个 "Unified Memory" 的本质区别：

  Apple 统一内存（Hardware Unified Memory）：
  ┌────────────────────────────────────────────────┐
  │ 硬件层面的统一                                   │
  │ • CPU 和 GPU 物理共享同一组 LPDDR5X 芯片        │
  │ • 没有 PCIe 总线，没有数据搬运                   │
  │ • 内存一致性由硬件缓存协议保证                   │
  │ • 真正的零拷贝                                   │
  └────────────────────────────────────────────────┘

  NVIDIA CUDA 统一内存（cudaMallocManaged）：
  ┌────────────────────────────────────────────────┐
  │ 软件层面的统一（虚拟地址空间统一）               │
  │ • CPU DRAM 和 GPU HBM 物理上仍然分离             │
  │ • 提供统一的虚拟地址空间，程序员不需要手动搬运   │
  │ • 运行时通过缺页中断自动迁移数据                 │
  │ • PCIe 总线仍然是瓶颈！                          │
  │ • 本质是"透明搬运"，不是"不搬运"                │
  └────────────────────────────────────────────────┘
```

"NVIDIA 的 CUDA Unified Memory 性能如何？来看实测数据：" 老李调出了一组 benchmark 结果。

```
cudaMalloc vs cudaMallocManaged 对比（PCIe 4.0 系统）：

  ┌────────────────────┬────────────────┬───────────────────┐
  │ 操作方式           │ 有效带宽       │ 说明               │
  ├────────────────────┼────────────────┼───────────────────┤
  │ cudaMemcpy (显式)  │ ~25 GB/s       │ 程序员手动搬运     │
  │ cudaMemPrefetchAsync│ ~22 GB/s      │ 预取提示，接近显式 │
  │ cudaMallocManaged   │ ~10 GB/s      │ 自动按需迁移       │
  │   (on-demand)       │               │ (频繁缺页中断)    │
  └────────────────────┴────────────────┴───────────────────┘

  来源：NVIDIA Developer Blog, "Unified Memory on Pascal and Beyond"
  
  关键发现：
  • On-demand migration 比显式拷贝慢 ~2.5x
  • 加上 cudaMemPrefetchAsync 可以挽回大部分性能

  底层机制（操作系统视角）：
  ┌─────────────────────────────────────────────────────────────┐
  │ cudaMallocManaged 的基础机制是 OS 缺页中断（Page Fault）     │
  │                                                             │
  │ ① GPU 核心访问一个虚拟地址                                  │
  │ ② GPU MMU 查页表 → 该页不在显存（未驻留）                   │
  │ ③ GPU 触发 Page Fault → 中断交给 CPU 上的 OS 驱动处理      │
  │ ④ OS 驱动通过 PCIe 将 4KB/2MB 页面从主机内存迁移到显存      │
  │ ⑤ 更新 GPU 页表（TLB）                                      │
  │ ⑥ GPU 恢复执行                                              │
  │                                                             │
  │ 每次缺页涉及：GPU stall + CPU-GPU 同步 + PCIe 传输          │
  │ 单次缺页延迟：20-50 μs（vs HBM 正常访问 ~100 ns）          │
  └─────────────────────────────────────────────────────────────┘

  ⚠️ 技术演进：现代 GPU 的改进
  ┌─────────────────────────────────────────────────────────────┐
  │ 上述纯缺页机制主要描述 Pascal 时代（2016+）的行为。          │
  │ 现代数据中心 GPU 已有显著改进：                              │
  │                                                             │
  │ • Volta+: 硬件页迁移引擎（Page Migration Engine, PME）      │
  │   → 页面迁移不再完全依赖 CPU 中断，GPU 可自主发起           │
  │ • Ampere+: 地址翻译服务（ATS）支持                          │
  │   → GPU 可直接使用 CPU 页表，减少 TLB Miss                  │
  │ • Hopper+: NVLink-C2C 实现硬件级缓存一致性                  │
  │   → Grace Hopper 中 CPU-GPU 互联达 900 GB/s                 │
  │                                                             │
  │ 结论：NVIDIA 在持续缩小"软件统一"与"硬件统一"的差距，       │
  │ 但受限于 PCIe 物理总线时，核心瓶颈仍然存在。                │
  │ 真正的突破在于换掉 PCIe（→ NVLink-C2C / CXL）。           │
  └─────────────────────────────────────────────────────────────┘

  内存密集型 workload 的典型开销（传统 PCIe 系统）：
  • cudaMallocManaged 比 cudaMalloc: 慢 10-30%（一般 workload）
  • 频繁 CPU-GPU 共享访问场景: 可能慢 2-5x
  
  → 在传统 PCIe 系统上，NVIDIA 的"统一内存"仍是编程便利性工具
  → 在 Grace Hopper 等新互联架构上，差距正在快速缩小
  → Apple 的统一内存是硬件架构优势，天然零开销
```

"看到了吧？" 老李总结。"**NVIDIA 的 Unified Memory 是软件抽象——让你'感觉'不需要搬运数据，但物理上该搬的一点没少。Apple 的统一内存是硬件事实——物理上就不需要搬。** 两个概念名字相同，本质完全不同。"

---

#### 🇨🇳 步骤 5：华为 Ascend NPU——另一种分离式设计

小王问："华为的昇腾 NPU 呢？它的内存架构是什么样的？"

老李说："**华为 Ascend 910 系列也是分离式架构——NPU 有独立的 HBM，和 CPU DRAM 通过高速互联连接。** 但它的设计有一些独特之处。"

```
华为 Ascend 910C 内存架构：

  ┌─────────────────────┐                    ┌─────────────────────┐
  │       CPU            │                    │    Ascend 910C NPU  │
  │  ┌───────────────┐  │                    │  ┌───────────────┐  │
  │  │  鲲鹏 920      │  │                    │  │  DaVinci 核心  │  │
  │  │  (ARM64)       │  │                    │  │  (Da Vinci)    │  │
  │  └───────┬───────┘  │                    │  └───────┬───────┘  │
  │          │          │                    │          │          │
  │  ┌───────▼───────┐  │    HCCS 互联      │  ┌───────▼───────┐  │
  │  │   DDR4/DDR5    │  │◄══════════════════►│  │   HBM2e       │  │
  │  │   系统内存      │  │    ~56 GB/s       │  │   64 GB       │  │
  │  │   256-512 GB   │  │                    │  │   1.8 TB/s    │  │
  │  └───────────────┘  │                    │  └───────────────┘  │
  └─────────────────────┘                    └─────────────────────┘
  
  关键数据对比：
  ┌──────────────────┬──────────────────┬──────────────────┐
  │ 指标              │ NVIDIA A100       │ Huawei Ascend 910C│
  ├──────────────────┼──────────────────┼──────────────────┤
  │ HBM 容量          │ 80 GB (HBM2e)    │ 64 GB (HBM2e)   │
  │ HBM 带宽          │ 2039 GB/s        │ 1.8 TB/s        │
  │ CPU-加速器互联    │ PCIe 4.0 (32GB/s)│ HCCS (~56 GB/s) │
  │ 多卡互联          │ NVLink (600GB/s) │ HCCS (56 GB/s)  │
  │ 推理性能 (相对)    │ 100%             │ ~60%            │
  │ 软件栈            │ CUDA + TensorRT  │ CANN + MindSpore│
  │ 自研高带宽内存    │ ❌ (SK海力士)     │ ✅ (3D封装方案)  │
  └──────────────────┴──────────────────┴──────────────────┘
  
  华为的独特之处：
  • 受制裁影响，无法采购标准 HBM 芯片（SK 海力士/三星），
    转向基于先进封装的自研高带宽内存方案
    （采用 3D 堆叠 + 多颗粒封装技术替代标准 HBM）
    据分析师报告，已有 1.6 TB/s 和 4.0 TB/s 两档方案
  • CANN 框架可以较低成本从 CUDA 迁移（DeepSeek 已验证）
  • 系统级优化：CloudMatrix 384 集群在 DeepSeek R1 上超过了 H800
  • 未来路线：Ascend 960 目标 9.6 TB/s 带宽，288GB 容量
```

"华为的架构本质上和 NVIDIA 是同构的——**加速器有独立的高速内存（HBM），通过总线连接 CPU**。核心挑战也一样：如果模型超过 HBM 容量，就要跨总线搬数据，性能悬崖式下跌。"

---

#### 📱 步骤 6：手机 SoC——统一内存的另一个战场

"手机又是什么情况？" 小王问。

"**手机 SoC 也是统一内存架构**——CPU、GPU、NPU 共享一块 LPDDR 内存。但带宽要低得多。" 老李说。

```
手机/边缘端统一内存架构对比：

  ┌────────────────────┬────────────┬────────────┬────────────────┐
  │ 平台               │ 内存容量    │ 内存带宽    │ LLM 推理能力    │
  ├────────────────────┼────────────┼────────────┼────────────────┤
  │ Snapdragon 8 Gen 3 │ 12-24 GB   │ 77 GB/s    │ 10B@20 tok/s   │
  │ (LPDDR5X-9600)     │ (共享)     │            │                │
  ├────────────────────┼────────────┼────────────┼────────────────┤
  │ Snapdragon X Elite │ 16-64 GB   │ 136 GB/s   │ 13B@30 tok/s   │
  │ (LPDDR5X-8448)     │ (共享)     │            │                │
  ├────────────────────┼────────────┼────────────┼────────────────┤
  │ Apple M4 (iPad)    │ 8-16 GB    │ 120 GB/s   │ 7B@25 tok/s    │
  │ (LPDDR5)           │ (统一)     │            │                │
  ├────────────────────┼────────────┼────────────┼────────────────┤
  │ Apple M4 Max       │ 64-128 GB  │ 546 GB/s   │ 7B@58 tok/s    │
  │ (LPDDR5X)          │ (统一)     │            │ 70B@12 tok/s   │
  ├────────────────────┼────────────┼────────────┼────────────────┤
  │ NVIDIA Jetson Orin │ 32-64 GB   │ 204 GB/s   │ 7B@35 tok/s    │
  │ (LPDDR5, 统一)     │ (统一)     │            │                │
  └────────────────────┴────────────┴────────────┴────────────────┘
  
  有趣的现象：
  • Jetson Orin 是 NVIDIA 的统一内存产品！
    → NVIDIA 自己也在边缘设备上用统一架构
    → 在 Jetson 上 cudaMallocManaged 几乎没有额外开销
       因为 CPU 和 GPU 物理共享同一块 LPDDR5！
  
  • 手机 NPU 的 prefill 显著快于 decode：
    Hexagon NPU prefill: 比 CPU/GPU 快 10-50x
    Hexagon NPU decode: 仅比 CPU/GPU 快 1.2-1.5x
    → 因为 prefill 是 compute-bound，decode 是 bandwidth-bound
    → NPU 的算力优势在 decode 阶段被带宽瓶颈抵消
```

---

#### ⚖️ 步骤 7：全景对比——同一 workload 的架构博弈

老李做了一张综合对比表：

```
LLaMA-3-8B Q4 推理性能全景对比（batch=1, decode, 公开数据汇总）：

┌────────────────────┬──────┬────────┬────────┬────────┬────────┬──────────┐
│ 指标               │A100  │H100    │RTX4090 │M4 Max  │M4 Pro  │SD 8 Gen3 │
│                    │80GB  │80GB    │24GB    │128GB   │48GB    │24GB      │
├────────────────────┼──────┼────────┼────────┼────────┼────────┼──────────┤
│ 架构类型           │分离式│分离式  │分离式  │统一    │统一    │统一      │
│ 加速器内存类型     │HBM2e │HBM3   │GDDR6X  │LPDDR5X │LPDDR5X │LPDDR5X   │
│ 内存/显存 (GB)     │80    │80      │24      │128     │36      │24        │
│ 内存带宽 (GB/s)    │2039  │3350    │1008    │546     │273     │77        │
├────────────────────┼──────┼────────┼────────┼────────┼────────┼──────────┤
│ 理论 max tok/s     │416   │683     │206     │111     │56      │15.7      │
│ 实测 tok/s (8B Q4) │~138  │~210    │~105    │~59     │~30     │~8        │
│ 带宽利用率         │33%   │31%     │51%     │53%     │54%     │51%       │
├────────────────────┼──────┼────────┼────────┼────────┼────────┼──────────┤
│ 70B Q4 可运行?     │✅    │✅      │❌      │✅      │❌      │❌        │
│ 70B Q4 tok/s       │~30   │~50     │~1-3*   │~12     │N/A     │N/A       │
├────────────────────┼──────┼────────┼────────┼────────┼────────┼──────────┤
│ 估算动态功耗 (W) ‡ │~100  │~200    │~120    │~45     │~25     │~5        │
│ tok/s per Watt     │1.38  │1.05    │0.88    │1.31    │1.20    │1.60      │
│ 价格 (USD, 约)     │10K+  │25K+    │1.5K    │3.5K†   │2.0K†   │800†      │
├────────────────────┼──────┼────────┼────────┼────────┼────────┼──────────┤
│ 数据搬运开销       │有    │有      │有      │无      │无      │无        │
│ PCIe 瓶颈          │有    │有      │有      │无      │无      │无        │
│ 多卡扩展           │NVLink│NVLink  │有限    │不支持  │不支持  │不支持    │
└────────────────────┴──────┴────────┴────────┴────────┴────────┴──────────┘

* RTX 4090 跑 70B 需要层卸载到 CPU，速度被 CPU DDR 带宽拖垮
† 为搭载该芯片的整机价格
‡ batch=1 单并发下估算动态功耗（非 TDP 热设计功耗上限）
  A100 TDP 300W，但 batch=1 时 Tensor Core 大量空闲，实际约 100W
  使用 TDP 计算能效比会人为压低 GPU 的效率 3 倍

数据来源：llama-bench (llama.cpp), MLX Community Benchmarks
⚠️ 软件栈说明：以上数据均基于 llama.cpp，该框架对 Metal 有深度优化，
但其 CUDA 后端在小 Batch 下存在 Kernel Launch Overhead。
若在 A100 上使用 TensorRT-LLM + CUDA Graphs，利用率可提升至 50-60%。
```

小王看完恍然大悟："原来不能只看带宽！要看**有效带宽利用率**和**模型能否完全装入**。"

老李总结：

```
核心洞察：

1. 绝对带宽：分离式 >> 统一（HBM 2039 vs LPDDR5X 546 GB/s）
   → 分离式在"模型装得下"的前提下，raw speed 无敌

2. 有效利用率（batch=1）：统一 > 分离式（53% vs 33%）
   → 部分源自零 PCIe 开销，部分源自 LPDDR 低延迟特性
   → 也与软件栈优化程度有关（llama.cpp Metal vs CUDA）
   → 使用 TensorRT-LLM 可将 A100 利用率提升至 50-60%

3. 容量灵活性：统一 >> 消费级分离式（128GB vs 24GB）
   → 大模型场景：装得下（权重 + KV Cache）>> 跑得快
   → 24GB 显存的 RTX 4090 跑 70B 模型，被 CPU DDR 带宽拖垮

4. 功耗效率：统一 > 分离式（batch=1 动态功耗口径下差距缩小）
   → 统一内存没有 PCIe 传输功耗、没有独立供电的 HBM
   → 注意：使用 TDP 会高估差距；应以动态功耗为准

5. 扩展性与大 Batch 吞吐：分离式 >> 统一
   → 数据中心需要多 GPU 并行 + 大 Batch 高并发
   → 当 Batch ≥ 100 时，HBM 高吞吐优势全面爆发，
     A100 的大量 Tensor Core 被充分利用，碾压统一架构
   → 训练场景几乎只能用分离式
```

---

#### 🔮 步骤 8：架构融合——未来的方向

"有意思的是，分离式和统一式正在**彼此靠拢**。" 老李最后说。

```
架构融合趋势：

  ┌──────────────────────────────────────────────────────────────┐
  │ 分离式 → 向统一靠拢                                          │
  │                                                              │
  │ 1. NVIDIA Grace Hopper (GH200)                               │
  │    • Grace CPU + Hopper GPU 通过 NVLink-C2C 连接            │
  │    • CPU LPDDR5X + GPU HBM3 共享虚拟地址空间                │
  │    • C2C 带宽 900 GB/s（vs PCIe 5.0 的 64 GB/s）           │
  │    • 支持硬件级缓存一致性                                    │
  │    → 物理上仍分离，但互联带宽接近"伪统一"                  │
  │                                                              │
  │ 2. AMD MI300A                                                │
  │    • CPU (Zen4) + GPU (CDNA3) 封装在同一芯片上              │
  │    • 共享 128GB HBM3（统一！）                              │
  │    • 内存带宽 5.3 TB/s                                      │
  │    → 真正的硬件级统一内存，且用了 HBM 而非 LPDDR            │
  │    → 兼具统一架构的零拷贝和 HBM 的高带宽！                  │
  ├──────────────────────────────────────────────────────────────┤
  │ 统一式 → 向高带宽靠拢                                        │
  │                                                              │
  │ 1. Apple M-系列持续提升带宽                                  │
  │    M1 Max: 400 GB/s → M4 Max: 546 GB/s (+37%)              │
  │    M3 Ultra: 819 GB/s → M4 Ultra (预计): ~1 TB/s           │
  │                                                              │
  │ 2. 新型内存技术                                              │
  │    • LPDDR6 (预计 2025-2026): 带宽翻倍                      │
  │    • HBM-on-Package: 在 SoC 封装内集成 HBM（类似 MI300A）  │
  │    → 统一架构 + HBM 级带宽 = 终极形态？                    │
  └──────────────────────────────────────────────────────────────┘

  未来可能的"最优"架构（推测）：
  
  ┌──────────────────────────────────────────┐
  │          统一 SoC（All in One）           │
  │                                          │
  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
  │  │ CPU  │ │ GPU  │ │ NPU  │ │ 其他  │  │
  │  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘  │
  │     └────────┼────────┼────────┘       │
  │              │                          │
  │      ┌───────▼────────┐                │
  │      │  Package HBM    │                │
  │      │  统一 + 高带宽   │                │
  │      │  512GB, 5TB/s   │     ← AMD MI300A│
  │      └────────────────┘        已经在   │
  │                                 这条路上│
  └──────────────────────────────────────────┘
```

---

#### 💡 战后总结

1. **分离式内存架构**（NVIDIA GPU / 华为 NPU）：加速器拥有独立的高速 HBM（2-5 TB/s），通过 PCIe/NVLink 连接 CPU。**带宽极高但容量有限**，数据搬运是隐性成本

2. **统一内存架构**（Apple M4 / 手机 SoC / Jetson）：CPU/GPU/NPU 共享同一物理内存池。**零拷贝零搬运**，但带宽相对较低（50-800 GB/s）

3. **LLM decode 是 memory-bandwidth-bound**：每个 token 需要读取整个模型权重，算术强度极低（~3 FLOP/Byte）。因此内存带宽决定了推理速度的上限

4. **NVIDIA 的 CUDA Unified Memory ≠ Apple 的统一内存**：前者是软件抽象（自动搬运，有开销），后者是硬件事实（物理共享，零开销）

5. **统一内存的杀手级优势**：①容量灵活（128GB 统一 > 24GB 显存），权重 + KV Cache 直接装下 ②功耗效率高 ③编程模型简单

6. **分离式的杀手级优势**：①绝对带宽碾压（HBM 2039 vs LPDDR5X 546 GB/s）②多卡 NVLink 扩展 ③大 Batch 高并发吞吐量（Batch ≥ 100 时碾压统一架构）

7. **架构正在融合**：NVIDIA Grace Hopper 用 C2C 互联向统一靠拢；AMD MI300A 直接实现 CPU+GPU 统一 HBM；Apple 持续提升统一内存带宽

> **一句话总结：分离式用极致带宽换取极致单卡性能，统一式用极致简洁换取极致效率。两者不是谁优谁劣的关系，而是工程约束与设计哲学的不同选择。未来的方向是"统一 + 高带宽"——兼得两者的优势。**

---

## 🧪 动手实践

### 实验环境

- Python 3.8+
- 根据平台：CUDA Toolkit（NVIDIA GPU）/ MLX（Apple Silicon）/ llama.cpp（通用）

### 实验 1：估算不同平台的推理性能上限（Python）

```python
# bandwidth_bound_calc.py — 估算 bandwidth-bound 场景下的理论 max tok/s
# 注意：功耗使用 batch=1 估算动态功耗（非 TDP），确保能效比口径公平

platforms = {
    "NVIDIA A100-80GB": {
        "type": "discrete", "mem_gb": 80, "bw_gbs": 2039,
        "active_w": 100, "host_ddr_bw": 70  # batch=1 动态功耗约 100W
    },
    "NVIDIA H100-80GB": {
        "type": "discrete", "mem_gb": 80, "bw_gbs": 3350,
        "active_w": 200, "host_ddr_bw": 90
    },
    "NVIDIA RTX 4090": {
        "type": "discrete", "mem_gb": 24, "bw_gbs": 1008,
        "active_w": 120, "host_ddr_bw": 70
    },
    "Apple M4 Max 128GB": {
        "type": "unified", "mem_gb": 128, "bw_gbs": 546,
        "active_w": 45, "host_ddr_bw": 0
    },
    "Apple M4 Pro 48GB": {
        "type": "unified", "mem_gb": 48, "bw_gbs": 273,
        "active_w": 25, "host_ddr_bw": 0
    },
    "Snapdragon 8 Gen 3": {
        "type": "unified", "mem_gb": 24, "bw_gbs": 77,
        "active_w": 5, "host_ddr_bw": 0
    },
}

models = {
    "LLaMA-3-8B Q4":  {"size_gb": 4.9, "kv_cache_gb": 1.0},
    "LLaMA-2-70B Q4": {"size_gb": 40.0, "kv_cache_gb": 6.0},
}

UTIL_DISCRETE = 0.35
UTIL_UNIFIED = 0.53
CPU_DDR_UTIL = 0.30  # CPU DDR 在 GEMV 下的有效利用率

print(f"{'平台':<22} {'模型':<18} {'状态':<14} {'tok/s':<10} {'tok/W':<8}")
print("-" * 80)

for pname, p in platforms.items():
    for mname, m in models.items():
        total_mem = m["size_gb"] + m["kv_cache_gb"]
        fits = total_mem < p["mem_gb"]
        
        if p["type"] == "unified":
            if not fits:
                status, est_tps = "❌ OOM", 0.0
            else:
                status = "✅ 统一内存"
                est_tps = (p["bw_gbs"] * UTIL_UNIFIED) / m["size_gb"]
        else:
            if fits:
                status = "✅ 全在HBM"
                est_tps = (p["bw_gbs"] * UTIL_DISCRETE) / m["size_gb"]
            else:
                status = "⚠️ 层卸载"
                # 正确模型：CPU 用 DDR 本地计算卸载层，GPU 用 HBM 计算其余层
                offload_gb = total_mem - p["mem_gb"]
                gpu_gb = m["size_gb"] - offload_gb
                if gpu_gb < 0: gpu_gb = 0
                cpu_time = offload_gb / (p["host_ddr_bw"] * CPU_DDR_UTIL)
                gpu_time = gpu_gb / (p["bw_gbs"] * UTIL_DISCRETE)
                est_tps = 1.0 / (cpu_time + gpu_time)  # 串行流水线
        
        tok_w = est_tps / p["active_w"] if est_tps > 0 else 0
        st = "✅ 统一内存" if p["type"]=="unified" and fits else status
        print(f"{pname:<22} {mname:<18} {st:<14} {est_tps:<10.1f} {tok_w:<8.3f}")
    print()
```

```bash
python3 bandwidth_bound_calc.py
```

> 📌 **关键观察**：
> - 对比 "理论max" 和 "估计实测"，统一内存的利用率更高
> - 对比 "tok/W"（每瓦特生成的 token 数），统一内存的效率显著更优
> - "装得下?" 列是性能悬崖的分界线：一旦超限，速度暴跌 10-20 倍

### 实验 2：可视化不同架构的带宽利用率

```python
# visualize_arch.py — 可视化分离式 vs 统一内存的数据流差异
import time

def simulate_discrete_inference(model_gb, hbm_bw, host_ddr_bw, hbm_gb, n_tokens=10):
    """模拟分离式架构的推理过程（修正版：真实异构流水线）"""
    print(f"\n=== 分离式架构 (HBM={hbm_gb}GB/{hbm_bw}GB/s, CPU DDR={host_ddr_bw}GB/s) ===")
    
    if model_gb > hbm_gb:
        # 层卸载：CPU 用 DDR 本地计算，仅传激活值给 GPU
        offload_gb = model_gb - hbm_gb
        gpu_gb = hbm_gb
        print(f"⚠️  模型 {model_gb}GB > 显存 {hbm_gb}GB")
        print(f"    CPU 本地计算 {offload_gb:.0f}GB (DDR {host_ddr_bw}GB/s)")
        print(f"    GPU 计算 {gpu_gb:.0f}GB (HBM {hbm_bw}GB/s)")
        print(f"    仅中间激活值(~几MB)走 PCIe，可忽略")
        
        # 串行流水线：CPU DDR GEMV + GPU HBM GEMV（串行，非并行 max）
        cpu_time = offload_gb / (host_ddr_bw * 0.30)  # CPU DDR GEMV 利用率约 30%
        gpu_time = gpu_gb / (hbm_bw * 0.35)
        per_token_time = cpu_time + gpu_time  # 串行累加，不是 max！
    else:
        print(f"✅ 模型 {model_gb}GB ≤ 显存 {hbm_gb}GB，全在 GPU")
        # 仅从 HBM 读取，假设 35% 利用率
        per_token_time = model_gb / (hbm_bw * 0.35)
        pcie_time = 0
    
    tok_per_sec = 1.0 / per_token_time
    
    for i in range(min(n_tokens, 5)):
        if model_gb > hbm_gb:
            print(f"  Token {i+1}: CPU DDR {cpu_time*1000:.1f}ms + GPU HBM {gpu_time*1000:.1f}ms"
                  f" = {per_token_time*1000:.1f}ms (串行流水线)")
        else:
            print(f"  Token {i+1}: HBM读取 {per_token_time*1000:.2f}ms")
    
    print(f"  ... 速度: {tok_per_sec:.1f} tok/s")
    return tok_per_sec


def simulate_unified_inference(model_gb, mem_bw, mem_gb, n_tokens=10):
    """模拟统一内存架构的推理过程"""
    print(f"\n=== 统一内存架构 (MEM={mem_gb}GB, BW={mem_bw}GB/s) ===")
    
    if model_gb > mem_gb:
        print(f"⚠️  模型 {model_gb}GB > 内存 {mem_gb}GB，无法运行")
        return 0
    
    print(f"✅ 模型 {model_gb}GB ≤ 统一内存 {mem_gb}GB")
    print(f"   零拷贝：CPU/GPU/NPU 直接访问，无 PCIe 开销")
    
    # 假设 53% 利用率
    per_token_time = model_gb / (mem_bw * 0.53)
    tok_per_sec = 1.0 / per_token_time
    
    for i in range(min(n_tokens, 5)):
        print(f"  Token {i+1}: 统一内存读取 {per_token_time*1000:.2f}ms (零搬运)")
    
    print(f"  ... 速度: {tok_per_sec:.1f} tok/s")
    return tok_per_sec


# 场景 1: 8B 模型 (4.9GB) — 都装得下
print("=" * 60)
print("场景 1: LLaMA-3-8B Q4 (4.9GB)")
print("=" * 60)
a100 = simulate_discrete_inference(4.9, 2039, 70, 80)
m4max = simulate_unified_inference(4.9, 546, 128)
print(f"\n  A100/M4Max 速度比: {a100/m4max:.1f}x")

# 场景 2: 70B 模型 (40GB) — RTX 4090 装不下
print("\n" + "=" * 60)
print("场景 2: LLaMA-2-70B Q4 (40GB)")
print("=" * 60)
a100 = simulate_discrete_inference(40, 2039, 70, 80)
rtx4090 = simulate_discrete_inference(40, 1008, 70, 24)  # CPU DDR 瓶颈！
m4max = simulate_unified_inference(40, 546, 128)
print(f"\n  A100 vs M4Max: {a100/m4max:.1f}x")
print(f"  RTX4090(CPU DDR瓶颈) vs M4Max: {rtx4090/m4max:.1f}x")
```

```bash
python3 visualize_arch.py
```

> 📌 **关键观察**：
> - 场景 1 中，A100 远快于 M4 Max（高带宽碾压）
> - 场景 2 中，RTX 4090 因 PCIe 卸载导致速度暴跌，M4 Max 反超
> - 统一内存的核心优势不在于"快"，而在于"装得下就能跑得稳"

### 思考题

1. NVIDIA Grace Hopper 超级芯片通过 NVLink-C2C（900 GB/s）连接 CPU 和 GPU。虽然物理上 CPU LPDDR5X 和 GPU HBM3 仍然分离，但这种高速互联是否已经"等效于"统一内存？分析 900 GB/s 互联带宽与 Apple M4 Max 的 546 GB/s 统一内存带宽的本质区别。

2. AMD MI300A 将 CPU 和 GPU 封装在同一芯片上，共享 128GB HBM3（5.3 TB/s）。这是否代表了未来内存架构的"终极方案"——统一 + 高带宽？它的劣势是什么？（提示：考虑热密度、良率、成本）

3. 在 batch=1（单请求）场景下，decode 是纯 bandwidth-bound。但当 batch size 增大时，多个请求共享模型权重读取，计算量线性增长但数据量不变——什么时候会变成 compute-bound？请推导 batch size 的临界值。（提示：使用 Roofline 模型。A100 INT8 算力 624 TOPS，带宽 2039 GB/s，算力/带宽比 ≈ 306 FLOP/Byte。Batch=B 时算术强度 ≈ 2B FLOP/Byte。令 2B ≥ 306 求解临界 B。）

4. （进阶）手机 NPU 的 prefill 速度比 CPU/GPU 快 10-50 倍，但 decode 只快 1.2-1.5 倍。请解释为什么 prefill 和 decode 对计算单元的需求如此不同。统一内存架构在这种"异构计算"场景中有什么优势？

5. （进阶）华为受制裁影响，采用 3D 封装 + 多颗粒堆叠技术自研高带宽内存替代标准 HBM。据分析师报告，已有约 1.6 TB/s 和 4.0 TB/s 两档方案。这些自研方案在带宽上与 SK 海力士/三星的标准 HBM3（如 H100 的 3.35 TB/s）有何差距？这个差距如何影响 Ascend NPU 在 LLM 推理中的竞争力？系统级优化（如 CloudMatrix 集群）能在多大程度上弥补单芯片的带宽劣势？
