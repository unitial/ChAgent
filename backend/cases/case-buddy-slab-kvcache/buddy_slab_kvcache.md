# Case: 从 Buddy System 到 PagedAttention —— 内存分配的思想如何从 CPU 迁移到 GPU

**难度：L4 | 耗时：2.5h | 知识点：Buddy System / Slab 分配器 / 内部碎片 / 外部碎片 / KV Cache / PagedAttention / vLLM | 来源：Linux 内核 + 工业实践**

---

#### 📅 场景

我们是一家 AI 公司，核心产品是基于 LLaMA-2-70B 的在线对话服务。线上部署在 8×A100-80GB 的 DGX 节点上，最初使用基于 **FasterTransformer** 的自研推理框架，采用传统的静态 KV Cache 预分配策略。

最近运维小李发现一个奇怪的现象：GPU 显存明明还剩不少空闲，但新请求却被拒绝了，日志里频繁出现 OOM 错误。

```bash
$ nvidia-smi
+-----------------------------------------------------------------------------+
| GPU  Name        Memory-Usage     |
|   0  A100-SXM4   72314MiB / 81920MiB |   # 用了 72GB / 80GB
|   1  A100-SXM4   71842MiB / 81920MiB |
+-----------------------------------------------------------------------------+

# 推理框架尝试为新请求预分配一段连续的 KV Cache 显存
[ERROR] Failed to allocate 2.5GB contiguous KV Cache block. 
        Free memory: 8GB, but largest contiguous free region: 1.2GB.
        Rejecting request.
```

小李很困惑："明明还有 8GB 空闲显存，却分配不出 2.5GB 的连续块？这不是操作系统里经典的**碎片问题**吗？"

他决定先回顾一下 CPU 侧的操作系统是怎么解决这个问题的，然后再看看 GPU 侧有什么不同。

---

#### 🧱 步骤 1：CPU 侧的第一层——Buddy System 管理物理页

小李找到了老搭档、内核工程师老张。老张打开了一台鲲鹏 920 服务器的终端：

```bash
$ cat /proc/buddyinfo
Node 0, zone   Normal   1024   512   256   128    64    32    16     8     4     2     1
# order:                  0     1     2     3     4     5     6     7     8     9    10
# 块大小:               4KB   8KB  16KB  32KB  64KB 128KB 256KB 512KB  1MB   2MB   4MB
```

"Linux 内核的物理内存管理分两层。**第一层是 Buddy System**，它管的是**物理页框**。"

```
Buddy System 的核心思想：按 2^n 页的"阶"(order) 组织空闲内存

  order-0:  4KB   (1 页)     ──  最小分配单位
  order-1:  8KB   (2 页)     ──  两个相邻的 order-0 合并
  order-2:  16KB  (4 页)
  ...
  order-10: 4MB   (1024 页)  ──  最大分配单位

  核心规则：
  ① 分配：如果请求的 order 没有空闲块，就把更大的块一分为二（split）
  ② 释放：如果释放的块的"伙伴"(buddy)也空闲，就合并为更大的块（coalesce）
```

"举个例子，假设系统需要分配一个 16KB（order-2）的块，但 order-2 列表是空的："

```
分配 order-2 (16KB) 的过程：

  order-3 (32KB):  [████████████████████████████████]  ← 有一个空闲块
                              ↓ split
  order-2 (16KB):  [████████████████] [________________]
                    ↑ 分配给请求者      ↑ 放入 order-2 空闲链表

释放的逆过程（合并）：
  order-2 (16KB):  [________________] [________________]  ← 两个伙伴都空闲
                              ↓ coalesce
  order-3 (32KB):  [________________________________]    ← 合并回 order-3
```

小李问："这和我们 GPU 上看到的碎片问题有什么关系？"

老张说："关键在于——**外部碎片**。"

---

#### 🔍 步骤 2：外部碎片——Buddy System 要解决的核心问题

老张在服务器上跑了 24 小时的压测后，再次查看 buddyinfo：

```bash
# 刚开机时（内存干净）
$ cat /proc/buddyinfo
Node 0, zone   Normal   128   256   512   256   128    64    32    16     8     4    12
#                        0     1     2     3     4     5     6     7     8     9    10
# order-10 有 12 个 → 12 × 4MB = 48MB 的大连续块

# 运行 24 小时后（大量分配释放）
$ cat /proc/buddyinfo
Node 0, zone   Normal  34216  1208   384    92    24     8     2     0     0     0     0
#                        0     1     2     3     4     5     6     7     8     9    10
# order-7 以上全部是 0！最大只能分配 order-6 = 256KB 的连续块
```

"你看，24 小时后，**高阶块全部碎片化了**。系统总空闲内存可能还有好几 GB（34216 × 4KB + 1208 × 8KB + ... ≈ 170MB），但最大的连续块只有 256KB。如果有人需要 1MB 的连续内存——分配不出来！"

"这就是**外部碎片（External Fragmentation）**：空闲内存总量充足，但没有足够大的**连续空闲区域**。"

```
外部碎片示意：

  物理内存布局（每格 = 1 页 = 4KB）：
  
  [已用][空闲][已用][空闲][已用][空闲][已用][空闲][已用][已用][空闲][空闲][已用]
  
  总空闲 = 6 页 = 24KB
  最大连续空闲 = 2 页 = 8KB
  
  如果需要 16KB（4 页连续）→ 分配失败！
  
Buddy System 的解决办法：
  → 分裂和合并机制保证"伙伴"关系
  → 释放时自动与伙伴合并，尽量保持大块完整
  → 但无法完美消除碎片（如果伙伴被占用，就无法合并）
```

"Buddy System 通过**合并机制**尽量对抗外部碎片，但并不完美。Linux 还有一个补充机制叫 **compaction**（内存压缩），会移动已分配的页来腾出连续空间——但这代价很大。"

小李点点头："那内核里那些小对象呢？`task_struct` 只有 832 字节，如果每次都分配一整页 4KB，岂不是浪费 80%？"

老张笑了："这就是第二层的工作了——**Slab 分配器**。"

---

#### 🧩 步骤 3：CPU 侧的第二层——Slab 消除内部碎片

```bash
$ sudo slabtop -o | head -20
 Active / Total Objects (% used)    : 2847361 / 3012456 (94.5%)
 Active / Total Slabs (% used)      : 86432 / 86432 (100.0%)
 Active / Total Size (% used)       : 412.8M / 436.2M (94.6%)

  OBJS ACTIVE  USE OBJ SIZE  SLABS OBJ/SLAB CACHE SIZE NAME                   
 89712  89712 100%    0.19K   4272       21     17088K dentry
 67584  64231  95%    0.81K   3456       19     55296K task_struct
 54320  52128  96%    0.57K   1940       28     31040K inode_cache
 45056  44800  99%    0.06K    704       64      2816K kmalloc-64
 32768  31456  96%    0.03K    256      128      1024K kmalloc-32
```

"看这张表。`task_struct` 每个 832 字节（0.81K），系统里有 67584 个。如果每个都用 Buddy 分一整页（4KB），就要浪费 `(4096-832)/4096 = 79.7%` 的空间！"

"Slab 的做法很聪明："

```
Slab 分配器的核心思想：

  Buddy System 分出整页 → Slab 把整页切成固定大小的小块

  ┌─── 一个 Slab（从 Buddy 拿来的若干连续页）────────────────┐
  │                                                           │
  │  [task_struct][task_struct][task_struct][task_struct][...]  │
  │   832 bytes   832 bytes   832 bytes   832 bytes           │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
  
  一页 4096 bytes ÷ 832 bytes = 4 个对象（+ 704 bytes padding）
  内部碎片率 = 704 / 4096 = 17.2%  ← 远好于单对象占整页的 79.7%！

  Slab 还有一个杀手锏：对象缓存（Object Cache）
  ├── 释放的 task_struct 不归还给 Buddy，而是留在 Slab 缓存中
  ├── 下次分配直接从缓存拿，不需要重新初始化
  └── 大幅减少 Buddy 的分配压力和构造/析构开销
```

"总结一下 CPU 侧的两层架构："

```
Linux 物理内存管理的两层架构：

  ┌──────────────────────────────────────────────────────┐
  │  应用层 / 内核子系统                                  │
  │  (需要各种大小的内存：832B, 192B, 64B, 4KB, 2MB...) │
  ├──────────────────────────────────────────────────────┤
  │  第二层：Slab 分配器                                  │
  │  • 管理小对象（< 1 页）                              │
  │  • 固定大小切割 → 消除内部碎片                        │
  │  • 对象缓存 → 减少初始化开销                          │
  │  • 解决的问题：内部碎片                               │
  ├──────────────────────────────────────────────────────┤
  │  第一层：Buddy System                                 │
  │  • 管理物理页框（4KB ~ 4MB）                         │
  │  • 2^n 分裂/合并 → 对抗外部碎片                      │
  │  • 解决的问题：外部碎片                               │
  ├──────────────────────────────────────────────────────┤
  │  物理内存 (DRAM)                                      │
  └──────────────────────────────────────────────────────┘
```

小李："这套方案在 CPU 侧已经用了 30 年了，非常成熟。但 GPU 侧呢？"

---

#### 🤖 步骤 4：转向 GPU——KV Cache 凭什么这么吃显存？

"先搞清楚 KV Cache 到底是什么。" 老张在白板上画了一张图：

```
Transformer 自回归推理过程：

  输入: "用户说：你好，请问今天天气"
  
  每一层 Transformer 的 Attention 需要：
  ┌─────────────────────────────────────────────┐
  │  Q (Query)   ← 当前 token 生成              │
  │  K (Key)     ← 所有历史 token + 当前 token   │  ← 这就是 KV Cache！
  │  V (Value)   ← 所有历史 token + 当前 token   │
  │                                              │
  │  Attention(Q, K, V) = softmax(QK^T/√d) × V  │
  └─────────────────────────────────────────────┘
  
  每生成一个新 token，K 和 V 各增加一行
  → 如果不缓存，每次都要重新计算所有历史 token 的 K、V
  → KV Cache = 用空间换时间，缓存历史的 K 和 V
```

"现在来算账。以 LLaMA-2-70B 为例："

```
LLaMA-2-70B 的 KV Cache 大小估算：

  模型参数：
  • 层数 (num_layers):        80
  • 注意力头数 (num_heads):    64（GQA: 8 个 KV head）
  • 每头维度 (head_dim):       128
  • 精度:                      FP16 (2 bytes)

  单 token 的 KV Cache（全模型视角，未考虑 TP 分片）：
  = num_layers × 2(K+V) × num_kv_heads × head_dim × 2(bytes)
  = 80 × 2 × 8 × 128 × 2
  = 327,680 bytes ≈ 320 KB / token

  不同序列长度下单请求的 KV Cache：
  ┌──────────────┬────────────┬──────────┐
  │ 序列长度      │ KV Cache   │ 占 80GB  │
  ├──────────────┼────────────┼──────────┤
  │ 128 tokens   │ 40 MB      │ 0.05%   │
  │ 512 tokens   │ 160 MB     │ 0.2%    │
  │ 2048 tokens  │ 640 MB     │ 0.8%    │
  │ 4096 tokens  │ 1.28 GB    │ 1.6%    │
  │ 8192 tokens  │ 2.56 GB    │ 3.2%    │
  └──────────────┴────────────┴──────────┘

  ⚠️ 注意 Tensor Parallelism（TP）的影响：
  实际部署 70B 模型通常使用 8 卡 TP（TP=8），Attention 被跨卡切分。
  每张卡只需承载 num_kv_heads/TP = 8/8 = 1 个 KV Head。
  → 单卡单 token KV Cache = 80 × 2 × 1 × 128 × 2 = 40 KB / token（是全模型的 1/8）
  → 单卡单请求（2048 tokens）= 40KB × 2048 = 80 MB

  单卡显存预算（TP=8, A100-80GB）：
  模型权重（FP16, 70B × 2 bytes = 140GB 总量 / 8 卡）≈ 17.5 GB/卡
  可用显存 ≈ 80 - 17.5 - 5(runtime overhead) ≈ 57.5 GB
  如果平均序列长度 2048：
    单卡最大并发 = 57.5GB / 80MB ≈ 718 个请求（KV Cache 不是瓶颈）
  如果平均序列长度 8192（长文本场景）：
    单卡最大并发 = 57.5GB / 320MB ≈ 179 个请求

  但如果用更小的模型（如 LLaMA-13B 单卡部署，无 TP），
  KV Cache 就成为真正的显存瓶颈——这正是 vLLM 论文的测试配置。
```

"这还是理论最优。**实际上，传统框架的内存利用率远低于此。**"

小李："为什么？"

---

#### 💀 步骤 5：KV Cache 内存管理的三大挑战

老张指着白板说："KV Cache 的内存管理面临 CPU 侧从未有过的三大挑战："

**挑战 1：序列长度不可预知——预分配造成巨大浪费**

```
传统框架的做法（HuggingFace Transformers / FasterTransformer）：
  
  为每个请求预分配 max_seq_len 大小的 KV Cache

  请求 A: 实际长度 256 tokens, 预分配 4096 tokens
    实际使用: 256 × 320KB = 80MB
    预分配:   4096 × 320KB = 1.28GB
    浪费率:   (4096-256)/4096 = 93.75% !!!

  请求 B: 实际长度 3800 tokens, 预分配 4096 tokens
    实际使用: 3800 × 320KB = 1.19GB
    预分配:   4096 × 320KB = 1.28GB
    浪费率:   7.2%  ← 长序列浪费少

  ┌────────────────────────────────────────────────────────────┐
  │ 请求 A 的预分配空间:                                      │
  │ [██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] │
  │  实际用  ↑                                    预分配浪费 ↑ │
  │                                                           │
  │ 请求 B 的预分配空间:                                      │
  │ [█████████████████████████████████████████████████████░░░] │
  │  实际用                                              ↑    │
  └────────────────────────────────────────────────────────────┘
```

**挑战 2：序列动态增长——每做一次 decode，KV Cache 增加一行**

```
自回归生成过程：

  Step 1: "你"      → KV Cache: 1 token  × 320KB = 320KB
  Step 2: "你好"    → KV Cache: 2 tokens × 320KB = 640KB
  Step 3: "你好啊"  → KV Cache: 3 tokens × 320KB = 960KB
  ...
  Step N: "你好啊..." → KV Cache: N tokens × 320KB = N × 320KB

  每一步都在增长！如果不预分配，就要频繁 realloc（GPU 上代价极大）
  如果预分配最大长度，就浪费（回到挑战 1）
  
  → 这就是一个经典的"时间-空间权衡"困境
```

**挑战 3：batch 内请求生命周期不同——碎片化**

```
批量推理时的时间线：

  时间 →  t0    t1    t2    t3    t4    t5    t6    t7
  
  请求A:  [████████████████████████████]          ← 结束，释放 KV Cache
  请求B:  [████████████████████████████████████████████]  ← 还在生成
  请求C:        [████████████]                    ← 早早结束
  请求D:              [██████████████████████████████████] ← 还在生成
  请求E:                    [████████████████████] ← 中等长度
  
  t5 时刻的显存布局：
  [___空闲(A)___][BBBBBBBBBB][___空闲(C)___][DDDDDDDD][___空闲(E)___]
   ↑ A 已释放                 ↑ C 已释放              ↑ E 已释放
  
  总空闲 = A + C + E 的空间 = 可能有好几 GB
  但每个空闲块都不够大，新的长序列请求分配不出连续块！
  → 这就是 GPU 上的外部碎片！
```

小李恍然大悟："等等——这不就是 CPU 上 Buddy System 要解决的**外部碎片**问题吗？"

老张："对！但 GPU 显存比 CPU 的 DRAM 更难管理。虽然现代 NVIDIA GPU（从 Pascal 架构起）内置了 **GMMU**（GPU Memory Management Unit），支持硬件级虚拟地址翻译——这也是 CUDA Unified Memory 的基石——但问题在于**粒度和开销的错配**。硬件页面最小是 4KB / 2MB，而 KV Cache 逐 token 增长，单次增量可能只有几十 KB，且每次 decode 都在增长。如果依赖硬件缺页中断，就会引发频繁的 CPU-GPU 同步（GPU stall），延迟不可接受。传统推理框架因此选择了更简单粗暴的方式：用 `cudaMalloc` 预分配大块连续显存，接受碎片化的代价。"

---

#### 📊 步骤 6：量化问题——传统方案到底浪费多少？

"让我们用真实数据来量化。这是 vLLM 论文（SOSP '23）中的测量数据："

```
传统推理框架（FasterTransformer）的显存利用率实测：

  测试条件：LLaMA-13B, A100-40GB, 不同数据集

  ┌────────────────────┬───────────┬───────────┬───────────┐
  │ 数据集              │ 平均序列长 │ 显存利用率 │ 浪费      │
  ├────────────────────┼───────────┼───────────┼───────────┤
  │ ShareGPT (对话)    │ 1024      │ 20.4%     │ 79.6%     │
  │ Alpaca (指令)      │ 256       │ 38.2%     │ 61.8%     │
  │ LMSYS-Chat (混合)  │ 512       │ 30.1%     │ 69.9%     │
  └────────────────────┴───────────┴───────────┴───────────┘

  浪费的构成（以 ShareGPT 为例，利用率 20.4%）：
  ┌──────────────────────────────────────────────────┐
  │ ████████  20.4%  实际使用                        │
  │ ░░░░░░░░░░░░░░░░  35.6%  保留浪费（预分配未用）  │
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  29.2%  内部碎片               │
  │ ████████████████    14.8%  外部碎片               │
  └──────────────────────────────────────────────────┘
  
  关键发现：
  • 保留浪费 (reservation waste) = 预分配 max_len 但实际没用那么多
  • 内部碎片 (internal fragmentation) = 分配粒度不匹配
  • 外部碎片 (external fragmentation) = 请求完成释放后留下空洞
  
  → 80% 的显存被浪费，严重制约了系统的最大并发能力（Max Batch Size）！
```

"**80% 的显存浪费意味着什么？**"

```
  显存经济账（以前文推导的单卡 ~57.5GB 可用 KV Cache 显存池为基数）：

  传统方案（利用率 20.4%）：57.5GB × 20.4% ≈ 11.7GB 存放有效 KV 数据
  PagedAttention（利用率 96.3%）：57.5GB × 96.3% ≈ 55.4GB 存放有效 KV 数据
  
  ⚠️ 注意：显存利用率的提升并不直接等于吞吐量的线性提升！
  吞吐量还受制于 GPU 算力和显存带宽（Compute Bound / Memory Bandwidth Bound）。
  显存利用率的跃升解除了 Max Batch Size 的容量硬限制，
  等效于将可服务的并发请求数上限拔高了近 5 倍（55.4 / 11.7 ≈ 4.7×）。
  
  vLLM 论文实测吞吐量提升：2.0× ~ 4.0×（取决于模型和负载）
  
  保守按 3× 计：原来需要 30 张 A100 → 现在只需要 10 张
  每月节省：(30-10) × $2 × 720h = $28,800/月
```

小李："那 GPU 侧怎么解决这个问题？总不能把 Buddy System 照搬过去吧？"

老张："不能照搬——但可以**借鉴核心思想**。这就是 vLLM 的 **PagedAttention** 的由来。"

---

#### 💡 步骤 7：PagedAttention——把分页思想搬到 GPU

"PagedAttention 的核心洞察：**KV Cache 不需要物理连续**。"

"就像操作系统的虚拟内存一样：应用程序看到的是连续的虚拟地址，但实际的物理页可以散落在内存的任何位置。CPU 通过**页表**做地址翻译。PagedAttention 对 KV Cache 做了完全一样的事情。"

```
PagedAttention 的核心设计：

  传统方案（连续分配）：
  ┌─────────────────────────────────────────────────────────┐
  │ [请求A的KV Cache: 连续4096 tokens] [请求B: 连续4096]... │
  │  必须连续！中间不能有空洞！                              │
  └─────────────────────────────────────────────────────────┘

  PagedAttention（分页分配）：
  ┌─────────────────────────────────────────────────────────┐
  │ KV Block 大小 = 16 tokens                               │
  │                                                         │
  │ 物理显存被切成固定大小的 KV Block：                     │
  │ [Block0][Block1][Block2][Block3][Block4][Block5]...      │
  │                                                         │
  │ 请求 A (当前 48 tokens) 的 Block Table:                 │
  │   逻辑块 0 → 物理块 3                                   │
  │   逻辑块 1 → 物理块 7                                   │
  │   逻辑块 2 → 物理块 1    ← 物理不连续，但逻辑连续！     │
  │                                                         │
  │ 请求 B (当前 32 tokens) 的 Block Table:                 │
  │   逻辑块 0 → 物理块 5                                   │
  │   逻辑块 1 → 物理块 9                                   │
  └─────────────────────────────────────────────────────────┘
```

"Block Table 就是 PagedAttention 的**页表**："

```
  类比对照：

  ┌────────────────┬─────────────────────┬──────────────────────┐
  │ 概念            │ CPU 虚拟内存         │ PagedAttention       │
  ├────────────────┼─────────────────────┼──────────────────────┤
  │ 管理对象        │ 进程的虚拟地址空间    │ 请求的 KV Cache      │
  │ 最小分配单位    │ 页 (Page, 4KB)       │ KV Block (16 tokens) │
  │ 地址翻译表      │ 页表 (Page Table)    │ Block Table          │
  │ 翻译方式        │ MMU 硬件翻译         │ Attention 内核软件查表│
  │ 分配策略        │ 按需分页             │ 按需分 Block          │
  │ 碎片消除        │ 分页消除外部碎片     │ 分 Block 消除外部碎片 │
  └────────────────┴─────────────────────┴──────────────────────┘
```

"关键区别：CPU 的虚拟内存靠 **MMU 硬件**做翻译，开销极小（纳秒级），对应用完全透明。那为什么 PagedAttention 不直接使用 GPU 的硬件内存管理（如 CUDA VMM 的 `cuMemMap` / `cuMemSetAccess`）？原因是多层次的："

```
PagedAttention 不使用 GPU 硬件 VMM 的原因：

  ① 粒度错配：
     CUDA VMM 的最小映射粒度是 2MB（cuMemAddressReserve 的对齐要求），
     而 KV Cache 逐 token 增长——以 LLaMA-2-70B TP=8 为例，
     单 token KV 仅 40KB，16-token Block 也只有 640KB。
     用 2MB 粒度管理 640KB 的 Block，内部碎片高达 53%。

  ② API 调用开销：
     KV Cache 在每个 Decode Step（耗时仅 ~10ms）都在增长。
     如果每次都调用驱动层的 cuMemMap/cuMemSetAccess 动态修改页表映射，
     会引入 CPU-GPU 同步延迟和驱动层全局锁竞争，延迟不可接受。

  ③ 软件路由的简洁高效：
     PagedAttention 的做法更聪明——启动时用 cudaMalloc 预占一块连续显存，
     然后在 GPU Attention Kernel 内部，完全用软件（Block Table 数组 +
     一次间接寻址）实现细粒度的虚拟→物理 Block 路由，
     彻底绕开驱动层开销。代价仅是约 4% 的 Attention 计算增加，
     相比 2-4× 的吞吐量提升，完全值得。
```

---

#### 🔄 步骤 8：深层类比——Slab 思想也在 GPU 上复活了

"思想的迁移不止于 Buddy → PagedAttention。Slab 的**对象缓存复用**思想也在 GPU 上找到了对应："

**类比 1：Slab 对象缓存 → Prefix Caching**

```
CPU 侧 Slab 对象缓存：
  task_struct 被释放后，不归还给 Buddy
  → 留在 Slab 缓存中，下次分配直接复用（避免重新初始化）

GPU 侧 Prefix Caching（vLLM 的 Automatic Prefix Caching）：
  多个请求共享相同的 system prompt（如 "你是一个有帮助的助手..."）
  → System prompt 的 KV Cache 只计算一次，被多个请求共享复用
  
  效果示例（LLaMA-2-70B, system prompt = 512 tokens）：
  
  不共享：10 个并发请求 × 512 tokens × 320KB = 1.6GB 冗余
  共享后：1 份 × 512 tokens × 320KB = 160MB，节省 90%
  
  ┌──────────────────────────────────────────────────┐
  │ 共享 Prefix 的 KV Blocks:                        │
  │ [System Prompt KV Blocks] ← 所有请求共享         │
  │      ↕           ↕           ↕                    │
  │ [请求A独有部分] [请求B独有] [请求C独有]            │
  └──────────────────────────────────────────────────┘
```

**类比 2：Copy-on-Write → Beam Search 中的 KV 共享**

```
CPU 侧 COW (Copy-on-Write)：
  fork() 后父子进程共享相同的物理页
  → 只有写入时才复制（避免不必要的拷贝）

GPU 侧 PagedAttention 的 COW：
  Beam Search 时，多个 beam 从同一个前缀分叉
  → 分叉前的 KV Blocks 共享（引用计数 +1）
  → 只有新生成的 token 才分配新 Block

  Beam Search (beam_width=4) 的常规做法 vs PagedAttention：
  
  常规做法：4 个 beam 各复制一份完整 KV Cache
    内存 = 4 × full_kv_cache
  
  PagedAttention：分叉前的 blocks 共享，用引用计数
    内存 = 1 × shared_prefix_blocks + 4 × new_blocks
    节省 ~75% 的 KV Cache 显存
```

**类比 3：Buddy 的合并策略 → Block 的回收与再分配**

```
CPU 侧 Buddy 合并：
  释放一个 order-2 块时，检查其伙伴是否也空闲
  → 如果空闲，合并为 order-3
  
GPU 侧 Block 回收：
  请求完成后，其占用的所有 KV Blocks 被标记为空闲
  → 立刻可以被新请求复用
  → 不需要合并（因为 Block 大小固定，不存在"高阶块"问题）
  → 这是 PagedAttention 比 Buddy 更简单的地方：
    固定大小的 Block 彻底消除了外部碎片！
```

---

#### 📊 步骤 9：完整性能对比

```
┌───────────────────────────────────────────────────────────────────────────┐
│              KV Cache 内存管理方案对比（LLaMA-2-70B, A100-80GB）         │
├────────────────┬─────────────┬──────────────┬────────────────────────────┤
│ 指标           │ 传统静态分配 │ PagedAttention│ PagedAttention + Prefix  │
│                │(FasterTransf)│ (vLLM)       │ Caching                  │
├────────────────┼─────────────┼──────────────┼────────────────────────────┤
│ 显存利用率     │ 20.4%       │ 96.3%        │ 96.3%+                   │
│ 外部碎片       │ 严重        │ ≈ 0          │ ≈ 0                      │
│ 内部碎片       │ 严重        │ < 4%*        │ < 4%*                    │
│ 保留浪费       │ 35.6%       │ ≈ 0          │ ≈ 0                      │
│ Beam Search 开销│ 4× 内存    │ ~1.05× 内存   │ ~1.05× 内存              │
│ 请求吞吐量     │ 1×          │ 2-4×         │ 3-6×                     │
│ Attention 开销  │ 基线        │ +4%          │ +4%                      │
│ 启动延迟       │ 无额外开销   │ Block Table 初始化 ~0.1ms │ 同左        │
└────────────────┴─────────────┴──────────────┴────────────────────────────┘

* 内部碎片：最后一个 KV Block 未填满，平均浪费 = block_size/2 = 8 tokens
  单请求浪费 = 8 × 320KB = 2.5MB（相对于整个 KV Cache 可忽略）
```

> **核心思想迁移链**：
> 
> ```
> Buddy System (1963, Knowlton)           →  PagedAttention (2023, vLLM)
> "2^n 分裂合并对抗外部碎片"             →  "固定 Block 彻底消除外部碎片"
>
> Slab Allocator (1994, Bonwick)          →  Prefix Caching
> "对象缓存复用，避免重复初始化"          →  "共享 Prompt 的 KV 缓存，避免重复计算"
>
> Copy-on-Write (fork)                    →  Beam Search KV 共享
> "共享页面，写时再复制"                  →  "共享 KV Block，分叉时再分配"
>
> 虚拟内存 + MMU                          →  Block Table + 自定义 Attention Kernel
> "硬件翻译，应用透明"                    →  "软件翻译，算子层面实现"
> ```

---

#### 💡 战后总结

1. **Buddy System** 是 Linux 管理物理页框的基础机制，通过 2^n 阶的分裂/合并对抗**外部碎片**。但运行时间长后，高阶块仍可能被耗尽

2. **Slab 分配器** 在 Buddy 之上管理小对象，通过固定大小切割消除**内部碎片**，通过对象缓存减少分配/初始化开销

3. **KV Cache** 是 LLM 推理的关键瓶颈——LLaMA-70B 单请求最大 KV Cache 可达 2.56GB，批量推理时占满整张 A100 的显存

4. **传统推理框架** 采用静态预分配策略，导致 **60-80% 的显存被浪费**——保留浪费 + 内部碎片 + 外部碎片三重打击

5. **PagedAttention (vLLM)** 将操作系统的分页思想迁移到 GPU 显存管理：KV Cache 被切成固定大小的 **KV Block**（类似物理页），通过 **Block Table**（类似页表）实现逻辑连续到物理离散的翻译。显存利用率从 20% 提升到 96%

6. **Prefix Caching** 是 Slab 对象缓存思想的 GPU 对应——共享 system prompt 的 KV 缓存；**COW** 在 Beam Search 中得到复现——共享前缀的 KV Block，分叉时按需分配

> **一句话总结：操作系统的内存管理思想（分页、对象缓存、写时复制）在 GPU 时代以新的形式复活——PagedAttention 用软件实现了 CPU 用硬件做了 30 年的事情，将 LLM 推理的显存利用率提升了近 5 倍。经典的系统设计思想永不过时，它们只是在等待新的战场。**

---

## 🧪 动手实践

### 实验环境

- Linux（推荐 Ubuntu 22.04，x86_64 或 ARM64）
- GCC：`sudo apt install build-essential`
- Python 3.8+（用于 vLLM 实验，可选）

### 实验 1：观察 Buddy System 的碎片化（透明大页退化观测）

> ⚠️ **重要提醒**：用户态 `malloc` 分配的是**虚拟地址空间**。即使物理内存碎片化严重，MMU 仍然可以将碎片化的 4KB 物理页映射为连续的虚拟地址，因此 `malloc(4MB)` 不会因物理碎片而失败。要观察物理碎片的影响，必须涉及需要**物理连续内存**的场景——例如**透明大页（THP）**。2MB 大页在物理层面必须是连续的 512 个 4KB 页框，当 Buddy System 无法拿出 order-9 的连续块时，大页分配就会失败，退化为普通 4KB 小页。

```bash
# 步骤 1：查看当前 buddyinfo（关注 order-9 即 2MB 块的数量）
echo "=== 初始状态 ==="
cat /proc/buddyinfo
grep -i hugepages /proc/meminfo

# 步骤 2：临时关闭 THP 的同步碎片整理
# 避免内核在大页分配时自动做 compaction 掩盖碎片效应
sudo sh -c 'echo defer > /sys/kernel/mm/transparent_hugepage/defrag'

# 步骤 3：用 stress-ng 在后台制造内存碎片并保持对内存的"劫持"
# ⚠️ 关键：stress-ng 必须在后台保持运行！
# 如果 stress-ng 退出，内核会通过 exit_mmap() 瞬间回收所有页面，
# Buddy System 以 O(1) 效率将散落页面重新合并为完美的大块，
# 碎片将在几毫秒内消失。
echo "=== 正在后台制造物理内存碎片 ==="
stress-ng --vm 4 --vm-bytes 80% --vm-keep &
STRESS_PID=$!
sleep 5  # 等待系统进入碎片化高压状态

# 步骤 4：再次查看 buddyinfo
echo "=== 碎片化后 ==="
cat /proc/buddyinfo
# 关键观察：对比 order-9 (2MB) 和 order-10 (4MB) 的空闲块数量
# 碎片化后，高阶块应该明显减少

# 步骤 5：尝试分配透明大页，观察是否退化
cat > thp_test.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

int main() {
    size_t size = 64 * 1024 * 1024;  // 64MB = 32 个 2MB 大页
    
    // 分配匿名内存并请求透明大页
    void *addr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (addr == MAP_FAILED) { perror("mmap"); return 1; }
    
    // 请求使用透明大页
    madvise(addr, size, MADV_HUGEPAGE);
    
    // 触摸所有页面，触发实际分配
    memset(addr, 0x42, size);
    
    // 读取 /proc/self/smaps 检查大页使用情况
    char cmd[256];
    snprintf(cmd, sizeof(cmd),
        "grep -A 20 '%lx' /proc/self/smaps | grep -E 'AnonHugePages|Size'\n",
        (unsigned long)addr);
    printf("检查大页分配情况（AnonHugePages > 0 表示成功使用了大页）：\n");
    system(cmd);
    
    // 如果 AnonHugePages 远小于 Size，说明大页分配因碎片而退化为 4KB 小页
    munmap(addr, size);
    return 0;
}
EOF

gcc -O2 -o thp_test thp_test.c

# 确保 THP 启用
sudo sh -c 'echo always > /sys/kernel/mm/transparent_hugepage/enabled'

# 在碎片化环境下运行（stress-ng 仍在后台占据内存），观察大页是否退化
./thp_test

# 步骤 6：清理现场（极其关键！）
echo "=== 实验结束，清理后台进程并恢复系统设置 ==="
kill $STRESS_PID
wait $STRESS_PID 2>/dev/null
# 恢复 THP defrag 为默认值
sudo sh -c 'echo madvise > /sys/kernel/mm/transparent_hugepage/defrag'
```

> 📌 **关键观察**：
> - 在 stress-ng 持续占据内存的碎片化状态下，`AnonHugePages` 会远小于分配总量——说明内核无法凑齐物理连续的 512 个页框来组成 2MB 大页，被迫退化为 4KB 小页
> - 这就是物理碎片的**真实影响**：不是 malloc 失败，而是大页退化，导致 TLB 覆盖率下降、性能下降
> - 清理 stress-ng 后，可以运行 `sudo sh -c 'echo 1 > /proc/sys/vm/compact_memory'` 触发内核 compaction，然后再次运行 thp_test 对比效果

### 实验 2：观察 Slab 分配器的对象缓存与回收

```bash
#!/bin/bash
# slab_experiment.sh — 观察 Slab 对象缓存的完整生命周期

# 创建临时目录并确保退出时清理
DIR=$(mktemp -d /tmp/slab_test.XXXXXX)
trap 'rm -rf "$DIR"' EXIT

# 查看 slab 缓存初始状态
echo "=== 初始状态 ==="
sudo slabtop -o | head -5
grep dentry /proc/slabinfo

# 大量创建文件（触发 dentry 分配）
echo -e "\n=== 创建 10000 个文件 ==="
for i in $(seq 1 10000); do touch "$DIR/file_$i"; done
grep dentry /proc/slabinfo
# 关键观察：active_objs 大幅增加

# 删除文件（触发 dentry 释放——但 slab 会缓存！）
echo -e "\n=== 删除所有文件 ==="
rm -rf "$DIR"/*
grep dentry /proc/slabinfo
# 关键观察：即使文件已删除，dentry 对象数量几乎没有减少！
# 这就是 Slab 的对象缓存——释放的对象留在缓存中，等待复用

# 手动触发内核回收 dentry 和 inode 缓存
echo -e "\n=== 强制回收 slab 缓存 ==="
sync  # ⚠️ 必须先 sync！确保所有脏元数据落盘，解除 VFS 对对象的锁定
      # 否则 drop_caches 不会清理处于脏状态的 dentry/inode 对象
sudo sysctl -w vm.drop_caches=2  # 2 = 释放 dentry 和 inode 缓存
grep dentry /proc/slabinfo
# 关键观察：dentry 对象数量断崖式下跌！
# 这证明了 Slab 的对象缓存机制：对象释放后驻留在缓存中，
# 只有在内核主动回收（或内存压力下 shrinker 触发）时才真正归还给 Buddy
```

> 📌 **认知闭环**：
> - 创建文件 → dentry 对象通过 Slab 分配（从 Buddy 拿页、切成小块）
> - 删除文件 → dentry 对象释放**但留在 Slab 缓存中**（不归还 Buddy）
> - `drop_caches=2` → 内核强制回收 Slab 缓存，对象归还给 Buddy
> - 这就是 Slab "对象缓存" 的完整生命周期

### 实验 3：KV Cache 大小估算（Python）

```python
# kv_cache_calc.py — 估算不同模型的 KV Cache 大小
models = {
    "LLaMA-2-7B":  {"layers": 32, "kv_heads": 32, "head_dim": 128, "dtype_bytes": 2},
    "LLaMA-2-13B": {"layers": 40, "kv_heads": 40, "head_dim": 128, "dtype_bytes": 2},
    "LLaMA-2-70B": {"layers": 80, "kv_heads": 8,  "head_dim": 128, "dtype_bytes": 2},
    "GPT-4 (est)": {"layers": 120,"kv_heads": 16, "head_dim": 128, "dtype_bytes": 2},
    "Mixtral-8x7B": {"layers": 32, "kv_heads": 8, "head_dim": 128, "dtype_bytes": 2},
}

seq_lengths = [128, 512, 2048, 4096, 8192]

print(f"{'模型':<16} | {'单token KV':<12} | " + " | ".join(f"{s:>5} tok" for s in seq_lengths))
print("-" * 100)

for name, cfg in models.items():
    per_token = cfg["layers"] * 2 * cfg["kv_heads"] * cfg["head_dim"] * cfg["dtype_bytes"]
    per_token_kb = per_token / 1024
    
    sizes = []
    for seq_len in seq_lengths:
        total_mb = per_token * seq_len / (1024 * 1024)
        sizes.append(f"{total_mb:>7.1f}MB")
    
    print(f"{name:<16} | {per_token_kb:>8.1f} KB | " + " | ".join(sizes))

# 计算批量推理时的显存占用（考虑 Tensor Parallelism）
print("\n=== 批量推理显存估算（A100-80GB）===")
print("注意：多卡部署时需考虑 Tensor Parallelism (TP)，KV heads 被均分到各卡\n")

gpu_mem_gb = 80
tp_configs = {
    "LLaMA-2-7B": 1,    # 单卡即可
    "LLaMA-2-13B": 1,   # 单卡
    "LLaMA-2-70B": 8,   # 8 卡 TP
    "GPT-4 (est)": 8,   # 8 卡 TP
    "Mixtral-8x7B": 2,  # 2 卡 TP
}

for name, cfg in models.items():
    tp = tp_configs.get(name, 1)
    local_kv_heads = max(1, cfg["kv_heads"] // tp)
    per_token_per_gpu = cfg["layers"] * 2 * local_kv_heads * cfg["head_dim"] * cfg["dtype_bytes"]
    # 权重占用：FP16, 按模型大小粗略估计
    weight_sizes = {"LLaMA-2-7B": 14, "LLaMA-2-13B": 26, "LLaMA-2-70B": 140, "GPT-4 (est)": 240, "Mixtral-8x7B": 94}
    total_weight_gb = weight_sizes.get(name, 14)
    weight_per_gpu = total_weight_gb / tp
    available_gb = gpu_mem_gb - weight_per_gpu - 3  # 3GB runtime overhead
    for seq_len in [512, 2048, 4096]:
        per_req_gb = per_token_per_gpu * seq_len / (1024**3)
        max_batch = int(available_gb / per_req_gb) if per_req_gb > 0 else 0
        print(f"  {name:<16} TP={tp} seq={seq_len:<5} → 单卡KV={per_req_gb*1024:.1f}MB, 最大并发={max_batch}")
```

```bash
python3 kv_cache_calc.py
```

### 思考题

1. Buddy System 中，如果一个 order-3 (32KB) 的块被分配出去，它的"伙伴"地址是怎么算的？为什么 buddy 的地址计算如此高效（只需一次异或操作）？

2. Linux 的 Slab 分配器经历了三代演进：slab → slub → slob。现代 Linux 默认使用 SLUB。请查阅资料，说明 SLUB 相比原始 Slab 做了哪些简化？为什么这些简化在多核 CPU 上更有优势？

3. PagedAttention 的 KV Block 大小（通常 16 tokens）是一个关键设计参数。如果把 block_size 设为 1（极端细粒度），会发生什么？如果设为 4096（整个序列一个 block），会退化成什么？请分析 block_size 对内部碎片和 Block Table 大小的影响。

4. （进阶）vLLM 的 PagedAttention 通过软件查表实现了类似 CPU 页表的功能，但引入了约 4% 的计算开销。如果 GPU 未来在硬件层面支持类似 MMU 的地址翻译（如 NVIDIA 的 Unified Memory），PagedAttention 的设计会发生什么变化？

5. （进阶）在多 GPU 推理场景（Tensor Parallelism）中，KV Cache 被分片到多张 GPU 上。PagedAttention 的 Block Table 如何适配这种分布式场景？与分布式系统中的**分布式页表**有何类比？
