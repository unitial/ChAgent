/**
 * player-data.js — 同一个模型，两种命运：分离式内存 vs 统一内存的推理对决
 * 由 interactive-player SKILL 按照 unified_memory.md 生成
 */
const PLAYER_CONFIG = {
  title: "分离式内存 vs 统一内存",
  subtitle: "同一个 LLM 推理任务，在 NVIDIA GPU、华为 NPU、Apple M4、手机 SoC 上的表现为何截然不同？<br>从硬件拓扑到内存带宽，深入解析两种内存架构的设计哲学与性能博弈。",
  splashImage: null,

  steps: [
    {
      title: "📅 场景：Mac 跑 LLM，速度出乎意料",
      terminal: {
        prompt: "$ ", command: "llama-bench -m llama-3-8b-q4_k_m.gguf",
        output: "# A100-80GB (CUDA)\\nmodel                 size     backend    test     t/s\\nllama-3-8b-q4_k_m     4.9 GB   CUDA       tg128   138.3\\n\\n# M4 Max 128GB (Metal)\\nmodel                 size     backend    test     t/s\\nllama-3-8b-q4_k_m     4.9 GB   Metal      tg128    58.7\\n\\n# 带宽差 3.7 倍 (2039 vs 546 GB/s)\\n# 速度只差 2.4 倍？M4 Max \"超常发挥\"了？"
      },
      commentary: `<p><strong>场景：</strong>算法团队评估能否用 M4 Max 做本地开发和端侧 AI 原型验证（batch=1 单请求）。</p>
<p class="warning">🔥 A100 显存带宽是 M4 Max 的 <strong>3.7 倍</strong>，但 batch=1 推理速度只差 <strong>2.4 倍</strong>。边界声明：本 Case 聚焦 batch=1 场景，数据中心大 Batch 场景 A100 优势将全面爆发。</p>
<p class="dialogue"><span class="speaker">小王：</span>"为什么统一内存的实际效率这么高？这背后的架构差异是什么？"</p>`
    },
    {
      title: "🏗️ 两种内存架构的硬件拓扑",
      terminal: {
        prompt: "", command: "",
        output: "分离式架构（NVIDIA GPU / 华为 NPU）：\\n  CPU DRAM ←──PCIe 4.0 (~32 GB/s)──→ GPU HBM (2039 GB/s)\\n  两个独立内存空间，数据必须显式 cudaMemcpy 搬运\\n  PCIe 带宽仅为 HBM 的 1.6%\\n\\n统一架构（Apple M4 / 手机 SoC / Jetson）：\\n  ┌── CPU ──┐\\n  │  GPU    ├──→ 统一内存池 (LPDDR5X, 546 GB/s)\\n  └── NPU ──┘\\n  一个物理内存空间，零拷贝\\n\\n根本区别：\\n  分离式 = 两个内存 + 一条窄管道 (PCIe)\\n  统一式 = 一个内存，所有计算单元直接访问"
      },
      commentary: `<p><strong>分离式架构</strong>（NVIDIA GPU / 华为 NPU）：</p>
<p>CPU DRAM 和 GPU HBM 是<strong>两个独立的内存空间</strong>，通过 PCIe 总线（~32 GB/s）连接。数据必须通过 <code>cudaMemcpy</code> 显式搬运。PCIe 带宽仅为 HBM 带宽的 <strong>1.6%</strong>。</p>
<p><strong>统一架构</strong>（Apple M4 / 手机 SoC / Jetson）：</p>
<p>CPU、GPU、NPU 共享<strong>同一物理内存池</strong>（LPDDR5X）。零拷贝——切换计算单元不需要搬运任何数据。</p>
<p class="insight">💡 <strong>根本区别：</strong>分离式有两个内存空间 + 一条窄管道（PCIe），统一式只有一个内存空间。这决定了数据流动的一切。</p>`
    },
    {
      title: "🔄 数据搬运——分离式的隐性税",
      terminal: {
        prompt: "", command: "",
        output: "分离式 卸载流水线 (真实机制):\\n  层 1-20: CPU 用 DDR (~70 GB/s) 本地 GEMV\\n       ↓ 传激活值(几MB) → PCIe\\n  层 21-80: GPU 用 HBM (1008-2039 GB/s) GEMV\\n\\n注意: 权重不跨 PCIe！CPU 本地计算其层\\n瓶颈 = CPU DDR 带宽 (~70 GB/s × 30% = 21 GB/s)\\n16GB/21GB/s = 0.76s + GPU 0.05s = 0.81s/tok\\n→ 上限约 1.2 tok/s\\n\\n70B Q4 (40GB) + KV Cache (6-11GB):\\n  A100-80GB:    ✅ 全在HBM     ~30 tok/s\\n  RTX 4090-24GB: ⚠️ CPU DDR瓶颈 ~1-3 tok/s\\n  M4 Max-128GB:  ✅ 统一内存   ~12 tok/s"
      },
      commentary: `<p><strong>模型能否完全装入（权重 + KV Cache）</strong>是性能悬崖的分界线。</p>
<p>RTX 4090 只有 24GB 显存，70B Q4 模型（40GB）必须把 60% 的层留在 CPU 内存。<strong>纠偏——权重不跨 PCIe！</strong>CPU 用 DDR 本地做 GEMV，仅将几 MB 激活值通过 PCIe 传给 GPU。真正瓶颈是 CPU DDR 带宽（~70 GB/s）比 GPU HBM 慢 15-30 倍。</p>
<p>M4 Max 有 128GB 统一内存，权重 + KV Cache 直接装下，<strong>12 tok/s</strong>！</p>
<p class="warning">🔥 统一内存的核心优势：<strong>大容量装得下</strong>（权重 + KV Cache），避免被 CPU DDR 带宽拖垮。</p>`
    },
    {
      title: "📊 内存带宽——推理的真正瓶颈",
      terminal: {
        prompt: ">>> ", command: "python3 bandwidth_bound_calc.py",
        output: "LLM decode 算术强度 ≈ 3.3 FLOP/Byte (极低！)\\nGPU 算力/带宽比: A100=153, M4Max=99 FLOP/Byte\\n3.3 << 153 → 严重带宽受限！算力大部分在空转\\n\\n理论 max tok/s = 内存带宽 ÷ 模型大小\\n  A100:     2039/4.9 = 416 tok/s\\n  RTX4090:  1008/4.9 = 206 tok/s\\n  M4 Max:    546/4.9 = 111 tok/s\\n  Snap 8G3:   77/4.9 =  16 tok/s\\n\\n实测带宽利用率:\\n  统一架构: ~53%  (零搬运+LPDDR低延迟)\\n  分离架构: ~33%  (PCIe开销+HBM高延迟)"
      },
      commentary: `<p><strong>LLM decode 是 memory-bandwidth-bound</strong>：每生成一个 token 需要读取整个模型权重，算术强度极低（~3 FLOP/Byte），GPU 算力大部分时间在空转等数据。</p>
<p>因此 <strong>tok/s ≈ 内存带宽 × 利用率 ÷ 模型大小</strong>。</p>
<p class="insight">💡 利用率差异还有更深层原因：<strong>HBM 为高并发吞吐设计，单次突发读取延迟比 LPDDR 更高</strong>。batch=1 时宽总线无法被填满，延迟成为主要矛盾；LPDDR5X 突发延迟更低，单并发时有效利用率反而更高。类比：8 车道高速（HBM）vs 4 车道快速路（LPDDR），只有一辆车时快速路更快。</p>`
    },
    {
      title: "⚠️ CUDA Unified Memory ≠ 硬件统一内存",
      terminal: {
        prompt: "", command: "",
        output: "cudaMalloc + cudaMemcpy (显式):  ~25 GB/s\\ncudaMemPrefetchAsync (预取):     ~22 GB/s\\ncudaMallocManaged (自动迁移):    ~10 GB/s ← 2.5x 慢！\\n\\n底层机制 = OS 缺页中断 (Page Fault):\\n  ① GPU 访问虚拟地址 → GPU MMU 查页表 → 未驻留\\n  ② GPU 触发 Page Fault → 中断交给 CPU 上的 OS 驱动\\n  ③ OS 通过 PCIe 迁移 4KB/2MB 页面 → 更新 GPU TLB\\n  单次缺页: 20-50 μs (vs HBM正常 ~100ns, 放大200-500倍！)\\n\\nNVIDIA UM = 软件抽象（OS缺页驱动，有开销）\\nApple 统一内存 = 硬件事实（物理共享，零开销）"
      },
      commentary: `<p><strong>NVIDIA CUDA Unified Memory（<code>cudaMallocManaged</code>）</strong>的基础机制是 OS 缺页中断（Pascal 时代）。现代 GPU 已改进：Volta+ 有硬件页迁移引擎（PME），Ampere+ 支持 ATS，Hopper 实现硬件缓存一致性。但受限于 PCIe 物理总线时，核心瓶颈仍存在。</p>
<p><strong>Apple 统一内存</strong>是硬件层面的物理统一——CPU/GPU 共享同一组 LPDDR5X 芯片，真正的零拷贝。</p>
<p class="warning">🔥 NVIDIA 在持续缩小"软件统一"与"硬件统一"的差距，但传统 PCIe 系统上仍是编程便利性工具。真正的突破在于换掉 PCIe（→ NVLink-C2C / CXL）。</p>`
    },
    {
      title: "🇨🇳 华为 NPU 与手机 SoC",
      terminal: {
        prompt: "", command: "",
        output: "华为 Ascend 910C vs NVIDIA A100:\\n  HBM: 64GB HBM2e (1.8TB/s) vs 80GB HBM2e (2039GB/s)\\n  互联: HCCS (~56GB/s) vs PCIe 4.0 (~32GB/s)\\n  推理: ~A100 的 60%\\n  自研高带宽内存: 3D封装方案 (据报告 1.6~4.0 TB/s)\\n\\n手机 SoC (统一内存):\\n  Snapdragon 8G3: 77GB/s → 10B@20tok/s\\n  Apple M4 iPad:  120GB/s  → 7B@25tok/s\\n\\nNVIDIA Jetson Orin: 204GB/s (统一!) → 7B@35tok/s\\n→ NVIDIA 自己也在边缘设备用统一架构！"
      },
      commentary: `<p><strong>华为 Ascend 910C</strong>：分离式架构，64GB HBM2e，1.8 TB/s 带宽。受制裁影响，采用 3D 封装 + 多颗粒堆叠技术自研高带宽内存替代标准 HBM。系统级优化（CloudMatrix 384）在特定场景超过 H800。</p>
<p><strong>手机 SoC</strong>：清一色统一内存。有趣的是，<strong>NPU prefill 比 CPU/GPU 快 10-50x，但 decode 仅快 1.2-1.5x</strong>——因为 decode 被带宽限制，NPU 的算力优势被抵消。</p>
<p class="insight">💡 <strong>NVIDIA Jetson Orin 是 NVIDIA 自家的统一内存产品</strong>——在边缘场景，NVIDIA 自己也选择了统一架构。</p>`
    },
    {
      title: "⚖️ 全景性能对比",
      terminal: {
        prompt: "", command: "",
        output: "┌────────────────┬──────┬───────┬───────┬──────┬──────────┐\\n│ 指标           │A100  │RTX4090│M4 Max │M4Pro │Snap 8G3  │\\n├────────────────┼──────┼───────┼───────┼──────┼──────────┤\\n│ 架构           │分离  │分离   │统一   │统一  │统一      │\\n│ 内存 (GB)      │80    │24     │128    │48    │24        │\\n│ 带宽 (GB/s)    │2039  │1008   │546    │273   │77        │\\n│ 8B tok/s       │~138  │~105   │~59    │~30   │~8        │\\n│ 70B 可运行?    │✅    │❌     │✅     │❌    │❌        │\\n│ 动态功耗(W)‡   │~100  │~120   │45     │25    │5         │\\n│ tok/s/W        │1.38  │0.88   │1.31   │1.20  │1.60      │\\n└────────────────┴──────┴───────┴───────┴──────┴──────────┘\\n‡ batch=1 估算动态功耗(非TDP) | 数据: llama.cpp"
      },
      commentary: `<p class="conclusion">🎯 <strong>五个核心洞察：</strong></p>
<p>
1. <strong>绝对带宽</strong>：分离式碾压（HBM 2039 vs LPDDR5X 546 GB/s）<br>
2. <strong>有效利用率</strong>（batch=1）：统一更高（53% vs 33%）；也与软件栈优化有关（llama.cpp Metal vs CUDA）<br>
3. <strong>容量灵活性</strong>：统一内存大（128GB 容纳权重 + KV Cache），避免 CPU DDR 瓶颈<br>
4. <strong>功耗效率</strong>：用动态功耗(非TDP)计算，差距比 TDP 口径小<br>
5. <strong>大 Batch 吞吐</strong>：分离式碾压！Batch ≥ 100 时 Tensor Core 充分利用，统一架构无法比拟
</p>`
    },
    {
      title: "🔮 架构融合——未来方向",
      terminal: {
        prompt: "", command: "",
        output: "分离式 → 向统一靠拢：\\n  NVIDIA Grace Hopper: NVLink-C2C (900 GB/s)，硬件缓存一致性\\n  AMD MI300A: CPU+GPU 同芯片，共享 128GB HBM3 (5.3 TB/s)\\n    → 真正的\"统一 + 高带宽\"！\\n\\n统一式 → 向高带宽靠拢：\\n  Apple M 系列: M1 Max 400 → M4 Max 546 GB/s (+37%)\\n  LPDDR6 预计带宽翻倍\\n  HBM-on-Package: SoC 封装内集成 HBM\\n\\n未来终极方案 (雏形: AMD MI300A):\\n  统一 SoC + Package HBM = 零拷贝 + 5+ TB/s 带宽"
      },
      commentary: `<p><strong>分离式 → 向统一靠拢：</strong></p>
<p>
• <strong>NVIDIA Grace Hopper</strong>：NVLink-C2C（900 GB/s）连接 CPU+GPU，硬件缓存一致性<br>
• <strong>AMD MI300A</strong>：CPU+GPU 同一芯片，共享 128GB HBM3（5.3 TB/s）——真正的<strong>统一 + 高带宽</strong>！
</p>
<p><strong>统一式 → 向高带宽靠拢：</strong></p>
<p>
• Apple M 系列持续提升（M1 Max 400 → M4 Max 546 GB/s）<br>
• LPDDR6 预计带宽翻倍<br>
• HBM-on-Package：SoC 封装内集成 HBM
</p>
<p class="insight">💡 AMD MI300A 已经展示了"终极方案"的雏形：<strong>统一内存 + HBM 级带宽</strong>。未来可能在一块芯片上同时获得零拷贝和 5+ TB/s 带宽。</p>`
    },
    {
      title: "💡 总结与启示",
      terminal: {
        prompt: "", command: "",
        output: "┌──────────────────┬───────────────────────┬───────────────────────┐\\n│ 维度             │ 分离式 (GPU/NPU+HBM) │ 统一式 (Apple/SoC)    │\\n├──────────────────┼───────────────────────┼───────────────────────┤\\n│ 带宽             │ 极高 (2-5 TB/s)      │ 中等 (50-800 GB/s)    │\\n│ 容量(权重+KV)    │ 有限 (24-80 GB)      │ 灵活 (8-192 GB)       │\\n│ 卸载瓶颈         │ CPU DDR (~70GB/s)    │ 无 (零拷贝)           │\\n│ 动态能效(b=1)   │ ~1.0-1.4 tok/s/W     │ ~1.2-1.6 tok/s/W      │\\n│ 大Batch吞吐      │ 碾压（Batch≥100）    │ “胶着”               │\\n│ 多卡扩展         │ 支持 (NVLink)        │ 不支持                │\\n│ 适合场景         │ 数据中心/训练        │ 本地开发/边缘/移动    │\\n└──────────────────┴───────────────────────┴───────────────────────┘"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong></p>
<p>
1. <strong>分离式架构</strong>（GPU/NPU + HBM）：极致带宽（2-5 TB/s），但容量有限、有搬运开销、功耗高<br>
2. <strong>统一架构</strong>（Apple M / 手机 SoC）：零拷贝、大容量、高效率，但带宽相对低（50-800 GB/s）<br>
3. LLM decode 是 <strong>bandwidth-bound</strong>：tok/s ≈ 带宽 × 利用率 ÷ 模型大小<br>
4. CUDA Unified Memory ≠ 硬件统一内存：前者是<strong>软件抽象</strong>（自动搬运），后者是<strong>硬件事实</strong>（零搬运）<br>
5. <strong>"装得下"比"跑得快"更重要</strong>：24GB 显存跑 70B 模型 → 1 tok/s；128GB 统一内存 → 12 tok/s<br>
6. 架构正在融合：Grace Hopper / MI300A 代表<strong>"统一 + 高带宽"</strong>的未来方向
</p>
<p class="insight">💡 <strong>一句话总结：分离式用极致带宽换取极致单卡性能，统一式用极致简洁换取极致效率。两者不是谁优谁劣，而是工程约束与设计哲学的不同选择。未来的方向是"统一 + 高带宽"——兼得两者的优势。</strong></p>`
    }
  ]
};
