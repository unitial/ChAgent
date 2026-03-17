/**
 * player-data.js — 从 Buddy System 到 PagedAttention：内存分配思想的 CPU→GPU 迁移
 * 由 interactive-player SKILL 按照 buddy_slab_kvcache.md 生成
 */
const PLAYER_CONFIG = {
  title: "从 Buddy System 到 PagedAttention",
  subtitle: "内存分配的经典思想如何从 CPU 迁移到 GPU。<br>跟随内核工程师的视角，看 30 年前的 OS 设计如何拯救今天的大模型推理。",
  splashImage: null,

  steps: [
    {
      title: "📅 场景：GPU 显存碎片导致 OOM",
      terminal: {
        prompt: "$ ", command: "nvidia-smi",
        output: "+-----------------------------------------------------------------------------+\\n| GPU  Name        Memory-Usage                                              |\\n|   0  A100-SXM4   72314MiB / 81920MiB |   # 用了 72GB / 80GB               |\\n+-----------------------------------------------------------------------------+\\n\\n# 推理框架尝试为新请求预分配连续 KV Cache 显存\\n[ERROR] Failed to allocate 2.5GB contiguous KV Cache block.\\n        Free memory: 8GB, but largest contiguous free region: 1.2GB.\\n        Rejecting request."
      },
      commentary: `<p><strong>场景：</strong>AI 公司，基于 LLaMA-2-70B 的在线对话服务。8×A100-80GB 节点，最初使用基于 <strong>FasterTransformer</strong> 的自研推理框架，采用传统静态 KV Cache 预分配策略。</p>
<p class="warning">🔥 GPU 显存还剩 8GB 空闲，却分配不出 <strong>2.5GB 的连续块</strong>！推理框架的 KV Cache 静态预分配导致显存碎片化。</p>
<p class="dialogue"><span class="speaker">小李：</span>"这不是操作系统里经典的<strong>碎片问题</strong>吗？先回顾一下 CPU 侧是怎么解决的。"</p>`
    },
    {
      title: "🧱 CPU 侧——Buddy System 管理物理页",
      terminal: {
        prompt: "$ ", command: "cat /proc/buddyinfo",
        output: "Node 0, zone   Normal   1024   512   256   128    64    32    16     8     4     2     1\\n# order:                  0     1     2     3     4     5     6     7     8     9    10\\n# 块大小:               4KB   8KB  16KB  32KB  64KB 128KB 256KB 512KB  1MB   2MB   4MB"
      },
      commentary: `<p><strong>Buddy System</strong> 是 Linux 物理内存管理的<strong>第一层</strong>，按 2<sup>n</sup> 页的"阶"(order) 组织空闲内存。</p>
<p>核心规则：<br>
① <strong>分配</strong>：请求的 order 没有空闲块 → 把更大的块<strong>一分为二</strong>（split）<br>
② <strong>释放</strong>：释放的块的"伙伴"也空闲 → <strong>合并</strong>为更大的块（coalesce）</p>
<p class="insight">💡 <strong>Buddy 的目标：对抗外部碎片。</strong>通过分裂/合并机制，尽量保持大块的完整性。名字"Buddy"来源于每个块都有一个固定的"伙伴"——两者地址只差一个 bit（异或操作即可算出）。</p>`
    },
    {
      title: "🔍 外部碎片——Buddy 的核心战场",
      terminal: {
        prompt: "$ ", command: "# 运行 24 小时后再次查看 buddyinfo\\ncat /proc/buddyinfo",
        output: "# 刚开机时：\\nNode 0, zone   Normal   128   256   512   256   128    64    32    16     8     4    12\\n# order-10 有 12 个 → 12 × 4MB = 48MB 大连续块\\n\\n# 运行 24 小时后：\\nNode 0, zone   Normal  34216  1208   384    92    24     8     2     0     0     0     0\\n# order-7 以上全部是 0！最大只能分配 256KB 连续块"
      },
      commentary: `<p><strong>外部碎片</strong>：空闲内存总量充足，但<strong>没有足够大的连续空闲区域</strong>。</p>
<p>24 小时运行后，高阶块被碎片化。总空闲 ~170MB，但最大连续块只有 256KB。需要 1MB 连续块？<strong>分配失败！</strong></p>
<p class="dialogue"><span class="speaker">老张：</span>"Buddy 通过合并机制对抗外部碎片，但不完美——如果伙伴被占用就无法合并。Linux 还有补充机制 <code>compaction</code>（内存压缩），但代价很大。"</p>
<p class="dialogue"><span class="speaker">小李：</span>"那内核里的小对象呢？<code>task_struct</code> 只有 832 字节，每次都分配一整页 4KB 岂不是浪费 80%？"</p>`
    },
    {
      title: "🧩 Slab 分配器——消灭内部碎片",
      terminal: {
        prompt: "$ ", command: "sudo slabtop -o | head -10",
        output: " Active / Total Objects (% used)    : 2847361 / 3012456 (94.5%)\\n Active / Total Size (% used)       : 412.8M / 436.2M (94.6%)\\n\\n  OBJS ACTIVE  USE OBJ SIZE  SLABS OBJ/SLAB CACHE SIZE NAME\\n 89712  89712 100%    0.19K   4272       21     17088K dentry\\n 67584  64231  95%    0.81K   3456       19     55296K task_struct\\n 54320  52128  96%    0.57K   1940       28     31040K inode_cache\\n 45056  44800  99%    0.06K    704       64      2816K kmalloc-64"
      },
      commentary: `<p><strong>Slab 分配器</strong>——Linux 物理内存管理的<strong>第二层</strong>。</p>
<p>Slab 从 Buddy 拿整页，再<strong>切成固定大小的小块</strong>。<code>task_struct</code> 832 字节 → 一页切 4 个对象 → 内部碎片从 79.7% 降到 17.2%。</p>
<p>Slab 还有杀手锏：<strong>对象缓存</strong>。释放的 <code>task_struct</code> 不归还给 Buddy，而是留在 Slab 缓存中，下次分配直接复用，省去构造/析构开销。</p>
<p class="conclusion">🎯 <strong>两层架构的分工</strong>：<br>
Buddy = 管物理页框（4KB~4MB）→ 解决<strong>外部碎片</strong><br>
Slab = 管小对象（几十~几百字节）→ 解决<strong>内部碎片</strong></p>`
    },
    {
      title: "🤖 转向 GPU——KV Cache 到底多吃显存？",
      terminal: {
        prompt: ">>> ", command: "python3 kv_cache_calc.py  # LLaMA-2-70B KV Cache 估算",
        output: "单 token KV Cache = 80层 × 2(K+V) × 8(KV heads) × 128(head_dim) × 2(FP16)\\n               = 327,680 bytes ≈ 320 KB/token\\n\\n序列长度    单请求 KV Cache    占 80GB\\n  128 tok      40 MB          0.05%\\n  512 tok     160 MB          0.2%\\n 2048 tok     640 MB          0.8%\\n 4096 tok    1.28 GB          1.6%\\n 8192 tok    2.56 GB          3.2%\\n\\n批量推理（可用显存 ≈ 45GB）：\\n  avg 2048 tok → 最大并发 72 个请求\\n  avg 8192 tok → 最大并发 17 个请求"
      },
      commentary: `<p>Transformer 的 Attention 需要缓存每一层每个历史 token 的 K/V 向量——这就是 <strong>KV Cache</strong>。</p>
<p>LLaMA-2-70B：<strong>320KB / token</strong>。序列长度 8192 时单请求 KV Cache = <strong>2.56GB</strong>。</p>
<p class="dialogue"><span class="speaker">小李：</span>"batch=32，平均 2048 tokens，KV Cache 就要 20GB。加上模型权重 35GB，A100-80GB 刚好塞满！"</p>
<p class="warning">🔥 这还是理论最优。<strong>实际上传统框架的内存利用率远低于此。</strong></p>`
    },
    {
      title: "💀 KV Cache 的三大挑战——碎片地狱",
      terminal: {
        prompt: "", command: "",
        output: "挑战 1: 预分配浪费\\n  请求 A 实际 256 tok, 预分配 4096 tok → 浪费 93.75%\\n\\n挑战 2: 动态增长\\n  每步decode KV Cache +1行，不预分配就要频繁realloc(GPU代价极大)\\n\\n挑战 3: 生命周期碎片\\n  batch内请求到达/结束不同步 → 空洞 → GPU外部碎片\\n  [__空闲(A)__][BBBBB][__空闲(C)__][DDDDD]\\n  总空闲=数GB, 但最大连续块不够 → 新请求被拒！\\n\\nGPU GMMU虽支持虚拟内存，但页面粒度(4KB/2MB)不适合\\nKV Cache逐token增长场景 → 传统框架选择cudaMalloc预分配"
      },
      commentary: `<p><strong>挑战 1：预分配浪费</strong><br>
传统框架为每个请求预分配 <code>max_seq_len</code> 大小的 KV Cache。请求 A 实际 256 tokens，预分配 4096 tokens → <strong>浪费 93.75%</strong>！</p>
<p><strong>挑战 2：动态增长</strong><br>
每做一次 decode，KV Cache 增长一行。不预分配就要频繁 realloc（GPU 上代价极大）；预分配就浪费。经典的时间-空间困境。</p>
<p><strong>挑战 3：生命周期碎片</strong><br>
batch 内请求到达/结束时间不同。先结束的请求留下空洞，后到的长序列分配不出连续块 → <strong>GPU 上的外部碎片</strong>！</p>
<p class="dialogue"><span class="speaker">小李：</span>"这不就是 CPU 上 Buddy System 要解决的外部碎片问题吗？"</p>
<p class="dialogue"><span class="speaker">老张：</span>"对！但 GPU 更难——虽然 GPU 有 GMMU 硬件支持虚拟内存，但其<strong>页面粒度（4KB/2MB）和缺页中断机制</strong>不适合 KV Cache 逐 token 细粒度增长的场景，会导致频繁的 GPU stall。传统框架因此选择 <code>cudaMalloc</code> 预分配大块连续显存。"</p>`
    },
    {
      title: "📊 量化浪费——vLLM 论文的实测数据",
      terminal: {
        prompt: "", command: "",
        output: "┌────────────────────┬───────────┬───────────┬───────────┐\\n│ 数据集              │ 平均序列长 │ 显存利用率 │ 浪费      │\\n├────────────────────┼───────────┼───────────┼───────────┤\\n│ ShareGPT (对话)    │ 1024      │ 20.4%     │ 79.6%     │\\n│ Alpaca (指令)      │ 256       │ 38.2%     │ 61.8%     │\\n│ LMSYS-Chat (混合)  │ 512       │ 30.1%     │ 69.9%     │\\n└────────────────────┴───────────┴───────────┴───────────┘\\n\\n浪费构成（ShareGPT）：\\n  ████████  20.4%  实际使用\\n  ░░░░░░░░  35.6%  保留浪费（预分配未用）\\n  ▓▓▓▓▓▓▓▓  29.2%  内部碎片\\n  ████████  14.8%  外部碎片"
      },
      commentary: `<p>vLLM 论文（SOSP '23）实测：传统框架（FasterTransformer）<strong>浪费 60-80% 显存</strong>。</p>
<p>浪费由三部分构成：<strong>保留浪费</strong>（预分配未用）+ <strong>内部碎片</strong>（分配粒度不匹配）+ <strong>外部碎片</strong>（请求释放后的空洞）。</p>
<p class="warning">🔥 <strong>经济账：</strong>显存利用率的跃升解除了 Max Batch Size 的容量硬限制。注意：这不等于线性吞吐量提升——吞吐量还受 GPU 算力和显存带宽约束。vLLM 实测吞吐量提升 <strong>2-4×</strong>，保守按 3× 计可节省约 2/3 的 GPU 资源。</p>`
    },
    {
      title: "💡 PagedAttention——分页思想搬到 GPU",
      terminal: {
        prompt: "", command: "",
        output: "PagedAttention 核心设计：\\n  物理显存 → 切成固定 KV Block（16 tokens/block）\\n  每个请求 → Block Table（= 页表）：逻辑块 → 物理块\\n  物理不连续，但逻辑连续！\\n\\n  请求A (48tok):  逻辑0→物理3, 逻辑1→物理7, 逻辑2→物理1\\n  请求B (32tok):  逻辑0→物理5, 逻辑1→物理9\\n\\n类比对照：\\n  CPU 虚拟内存    →  PagedAttention\\n  页 (4KB)        →  KV Block (16 tok)\\n  页表            →  Block Table\\n  MMU 硬件翻译    →  Attention Kernel 软件查表\\n  结果: 显存利用率 20.4% → 96.3%"
      },
      commentary: `<p><strong>核心洞察：KV Cache 不需要物理连续。</strong></p>
<p>就像 OS 虚拟内存：应用看到连续虚拟地址，物理页可以散落各处，CPU 通过<strong>页表</strong>做翻译。PagedAttention 对 KV Cache 做了完全一样的事：</p>
<p>
• 物理显存被切成固定大小的 <strong>KV Block</strong>（16 tokens）<br>
• 每个请求有一个 <strong>Block Table</strong>（= 页表）：逻辑块 → 物理块<br>
• 物理不连续，但逻辑连续！
</p>
<p class="insight">💡 关键区别：CPU 用 <strong>MMU 硬件</strong>翻译（纳秒级），对应用完全透明。GPU 虽有 GMMU 硬件，但页面粒度（4KB/2MB）不适合 KV Cache 逐 token 的细粒度增长。因此 PagedAttention 在<strong>应用层</strong>（CUDA Kernel 内部）用软件查表实现更细粒度翻译。额外开销约 <strong>4%</strong>，但相比 2-4× 吞吐提升完全值得。</p>
<p class="conclusion">🎯 显存利用率：<strong>20.4% → 96.3%</strong></p>`
    },
    {
      title: "🔄 Slab + COW 思想也在 GPU 复活",
      terminal: {
        prompt: "", command: "",
        output: "类比 1: Slab 对象缓存 → Prefix Caching\\n  共享 system prompt KV Cache，只计算一次\\n  10请求×512tok×320KB = 1.6GB → 共享后仅 160MB，节省90%\\n\\n类比 2: COW (fork) → Beam Search KV 共享\\n  分叉前 KV Blocks 共享（引用计数），分叉后才分配新 Block\\n  常规: 4× 内存  →  COW: ~1.05× 内存\\n\\n类比 3: Buddy 合并 → Block 回收\\n  固定大小 Block 彻底消除外部碎片，不需要合并操作！"
      },
      commentary: `<p><strong>类比 1：Slab 对象缓存 → Prefix Caching</strong><br>
多个请求共享相同 system prompt 的 KV Cache，只计算一次。10 个请求 × 512 tokens × 320KB = <strong>1.6GB 冗余</strong> → 共享后只需 <strong>160MB</strong>，节省 90%。</p>
<p><strong>类比 2：COW (fork) → Beam Search KV 共享</strong><br>
Beam Search 多个 beam 从同一前缀分叉 → 分叉前的 KV Blocks 共享（引用计数），分叉后才分配新 Block。常规做法需要 4× 内存，COW 只需 ~1.05×。</p>
<p><strong>类比 3：Buddy 合并 → Block 回收</strong><br>
请求完成后 KV Blocks 立刻标记为空闲，可被新请求复用。但比 Buddy 更简单——固定大小的 Block <strong>彻底消除了外部碎片</strong>，不需要合并操作！</p>`
    },
    {
      title: "📊 完整性能对比",
      terminal: {
        prompt: "", command: "",
        output: "┌────────────────┬─────────────┬──────────────┬──────────────────┐\\n│ 指标           │ 传统静态分配 │ PagedAttention│ + Prefix Cache   │\\n├────────────────┼─────────────┼──────────────┼──────────────────┤\\n│ 显存利用率     │ 20.4%       │ 96.3%        │ 96.3%+           │\\n│ 外部碎片       │ 严重        │ ≈ 0          │ ≈ 0              │\\n│ 内部碎片       │ 严重        │ < 4%         │ < 4%             │\\n│ 保留浪费       │ 35.6%       │ ≈ 0          │ ≈ 0              │\\n│ Beam Search    │ 4× 内存     │ ~1.05× 内存  │ ~1.05× 内存      │\\n│ 请求吞吐量     │ 1×          │ 2-4×         │ 3-6×             │\\n│ Attention 开销 │ 基线        │ +4%          │ +4%              │\\n└────────────────┴─────────────┴──────────────┴──────────────────┘"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心思想迁移链：</strong></p>
<p>
<strong>Buddy System</strong> (1963) → <strong>PagedAttention</strong> (2023)<br>
"2<sup>n</sup> 分裂合并对抗外部碎片" → "固定 Block 彻底消除外部碎片"<br><br>
<strong>Slab Allocator</strong> (1994) → <strong>Prefix Caching</strong><br>
"对象缓存复用" → "共享 Prompt 的 KV 缓存"<br><br>
<strong>Copy-on-Write</strong> → <strong>Beam Search KV 共享</strong><br>
"共享页面，写时复制" → "共享 KV Block，分叉时分配"<br><br>
<strong>虚拟内存 + MMU</strong> → <strong>Block Table + 自定义 Kernel</strong><br>
"硬件翻译，应用透明" → "软件翻译，算子层面实现"
</p>`
    },
    {
      title: "💡 总结与启示",
      terminal: {
        prompt: "", command: "",
        output: "思想迁移时间线：\\n  1963  Buddy System (Knowlton)    → 2023  PagedAttention (vLLM)\\n  1994  Slab Allocator (Bonwick)   → 2023  Prefix Caching\\n  1979  Copy-on-Write (fork)       → 2023  Beam Search KV 共享\\n  1960s 虚拟内存 + MMU              → 2023  Block Table + CUDA Kernel\\n\\n核心差异：\\n  CPU: MMU 硬件翻译（纳秒级，应用透明）\\n  GPU: 软件查表翻译（+4% 开销，算子层面实现）\\n\\n结果：显存利用率 20% → 96%，吞吐量 2-4× 提升"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>Buddy System</strong>：Linux 管理物理页框的基础，2<sup>n</sup> 阶分裂/合并对抗<strong>外部碎片</strong><br>
2. <strong>Slab 分配器</strong>：在 Buddy 之上管理小对象，固定大小切割消除<strong>内部碎片</strong>，对象缓存减少开销<br>
3. <strong>KV Cache</strong> 是 LLM 推理关键瓶颈——LLaMA-70B 单请求最大 2.56GB，传统框架<strong>浪费 60-80%</strong> 显存<br>
4. <strong>PagedAttention</strong> 将 OS 分页思想迁移到 GPU：固定 KV Block + Block Table → 显存利用率 <strong>20% → 96%</strong><br>
5. <strong>Prefix Caching</strong> 复现 Slab 的对象缓存思想；<strong>COW</strong> 在 Beam Search 中复活<br>
6. 关键区别：CPU 用 <strong>MMU 硬件</strong>翻译（纳秒级），GPU 用<strong>软件查表</strong>（+4% 开销）——但换来 2-4× 实测吞吐提升</p>
<p class="insight">💡 <strong>一句话总结：操作系统的内存管理思想（分页、对象缓存、写时复制）在 GPU 时代以新的形式复活——PagedAttention 用软件实现了 CPU 用硬件做了 30 年的事情。经典的系统设计思想永不过时，它们只是在等待新的战场。</strong></p>`
    }
  ]
};
