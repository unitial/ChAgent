# Case: 百G模型三分钟加载？—— mmap 让大模型推理起飞

**难度：L4 | 耗时：2h | 知识点：虚拟内存 / mmap / Page Cache / 缺页异常 / 大页 / 多进程共享 | 来源：工业实践**

---

#### 📅 场景

我们是一家 AI 创业公司，核心产品是基于开源 LLaMA-70B 模型的智能客服。线上部署在一台 ARM64 服务器上（鲲鹏 920, 256GB 内存, NVMe SSD）。

模型文件有多大？70B 参数，FP16 精度，每个参数 2 字节——**光权重就 140GB**。加上 KV Cache 和运行时开销，推理需要大约 200GB 内存。

问题出在**冷启动**——每次重启服务、更新模型版本，或者 K8s 做滚动升级，都要重新加载模型到内存。

小陈是负责部署的工程师，他写了一版加载代码：

```c
// weight_loader_v1.c — 用 read() 加载模型权重
int fd = open("llama-70b.bin", O_RDONLY);
char *buf = malloc(140UL * 1024 * 1024 * 1024);  // 分配 140GB

size_t total = 0;
while (total < file_size) {
    ssize_t n = read(fd, buf + total, 1024*1024);  // 每次读 1MB
    total += n;
}
// 现在 buf 指向完整的模型权重，开始推理
```

事实上这也是很多开源推理框架（早期的 llama.cpp、vLLM）的默认做法。

上线第一天就出了问题。

---

#### ⏱️ 问题暴露：冷启动太慢

```bash
$ time ./inference_server --model llama-70b.bin --mode read
Loading model weights (140GB)...
[====================] 100%  (140.0 GB loaded)
Model loaded in 187.3 seconds.    # <-- 超过 3 分钟！
Process RSS: 141 GB               # <-- 进程自己占了 141GB

$ free -g
              total   used   free   shared  buff/cache   available
Mem:           256    143      2      0       111           0
# buff/cache 也被吃满了！系统可用内存逼近 0
```

小陈盯着屏幕：

"**3 分钟**才加载完？而且进程 RSS 占了 141GB，系统 buff/cache 也被撑到 111GB——整个系统几乎没有可用内存了！"

运维老刘在群里发消息："K8s 健康检查超时了，Pod 被杀了两次才启动成功。线上有客户在等。"

小陈知道需要找专家帮忙。他去找了系统组的王姐。

---

#### 🔬 步骤 1：诊断——read() 到底在做什么？

王姐先让小陈画出 `read()` 的数据链路：

```
read() 的数据搬运路径：
                                                
  ┌──────────┐    DMA     ┌──────────┐   memcpy   ┌──────────┐
  │  NVMe    │ ────────→  │  Page    │ ─────────→  │  用户态   │
  │  SSD     │            │  Cache   │             │  Buffer   │
  └──────────┘            └──────────┘             └──────────┘
                           (内核空间)                (用户空间)
                                                
       磁盘                 第一份副本                第二份副本
```

"你看到问题了吗？" 王姐指着白板。

"数据被**搬了两次**！SSD → Page Cache 是 DMA 传输，内核帮你做好了。但 `read()` 还会从 Page Cache **再 `memcpy` 一次**到你的用户态 Buffer。140GB 的模型，光这个 `memcpy` 就要拷贝 140GB！"

"所以进程 RSS 141GB + 系统 buff/cache 111GB 是怎么回事？"

"没错。你的 `malloc` Buffer 占了 141GB（这是进程的 RSS）。而 `read()` 过程中内核会把磁盘数据先缓存到 **Page Cache**——注意，Page Cache 属于系统级缓存，不计入你进程的 RSS，而是体现在 `free` 命令的 `buff/cache` 列中。虽然内核在内存压力下会回收 Page Cache，但 140GB 的顺序读取期间，Page Cache 仍然占据了大量物理内存。"（加载耗时 187 秒主要受限于 SSD 顺序读取带宽——140GB ÷ ~750MB/s ≈ 186 秒，加上 `memcpy` 的额外开销。）

小陈恍然大悟："进程自己就占了 141GB，系统缓存又吃了一大块——两份数据！那有没有办法**只用一份**？"

王姐笑了："这就轮到 `mmap()` 上场了。"

---

#### 🧠 步骤 2：mmap——让虚拟地址直接映射文件

```c
// weight_loader_v2.c — 用 mmap() 加载模型权重
int fd = open("llama-70b.bin", O_RDONLY);

// 把文件直接映射到进程的虚拟地址空间
void *weights = mmap(NULL, file_size,
                     PROT_READ,       // 只读映射
                     MAP_PRIVATE,     // 私有映射
                     fd, 0);

// weights 指针现在直接指向模型权重——但此时还没有真正读磁盘！
// 推理代码可以直接用 weights 指针访问数据
```

"这段代码做了什么？" 小陈问。

"**几乎什么都没做**——这正是它的魅力。"

```
mmap() 的数据路径：
                                                    
  ┌──────────┐    DMA     ┌──────────┐        
  │  NVMe    │ ────────→  │  Page    │ ← ─ ─ ─ ─  虚拟地址
  │  SSD     │            │  Cache   │              直接指向
  └──────────┘            └──────────┘              这里
                           (内核空间)                    
                                                    
       磁盘                 只有一份！     CPU 通过页表
                                          直接访问
```

"关键区别看到了吗？**没有第二次拷贝**。`mmap()` 让你的进程虚拟地址**直接指向 Page Cache 中的物理页**。CPU 通过页表翻译，直接读 Page Cache 里的数据——零拷贝。"

---

#### ⚡ 步骤 3：实测——mmap 有多快？

小陈用 mmap 版本重新测试：

```bash
$ time ./inference_server --model llama-70b.bin --mode mmap
Mapping model weights (140GB)...
mmap() completed in 0.003 seconds.   # <-- 3 毫秒！！
Peak RSS: 2 GB                       # <-- 初始只占 2GB
```

"等等——**3 毫秒**？140GB 的文件 3 毫秒就加载完了？这不科学！"

"因为 `mmap()` 只是**建立了映射关系**（修改了页表和内核 VMA 数据结构），并没有真正把数据读到内存。数据是在你**第一次访问**某个地址时，CPU 发现页表里对应的物理页不存在，触发**缺页异常（Page Fault）**，内核才会把对应的页从磁盘读进 Page Cache。"

"这就是**按需加载**（Demand Paging）。"

小陈想了想："等等——LLaMA-70B 是 dense 模型，做一次推理会触及所有层的全部权重，最终这 140GB **都会被加载**。那 mmap 不就是把加载时间从开始推迟到了使用时吗？它的真正价值在哪里？"

王姐点头："问得好。对 dense 模型，mmap 确实不会减少总 I/O 量。它的**真正价值**是："

```
mmap 对 dense 模型的三大优势（与拐载无关）：

① 零拷贝：不需要 Page Cache + malloc Buffer 两份内存
  read():  内存占用 = Page Cache(~140GB) + 用户 Buffer(141GB)
  mmap():  内存占用 = Page Cache(140GB) ← 用户空间直接指向这里

② 快速启动：服务 0.003s 内就能通过 K8s 健康检查、开始接收请求
  read():  服务阻塞 3 分钟，健康检查超时，Pod 被杀
  mmap():  立刻就绪，加载成本分摆到前几个请求中

③ 多进程共享：多个推理进程共享同一组物理页
  read():  N 个进程 = N 份内存
  mmap():  N 个进程 = 1 份内存
```

"但对于 **MoE（Mixture of Experts）模型**，mmap 的按需加载还有一个额外的巨大优势："

```
MoE 模型示例：Mixtral 8x7B
  总参数：46.7B（权重文件 ~94GB）
  每次推理只激活 2/8 个 Expert → 实际参数 ~13B

  read():  必须加载全部 94GB → RSS = 94GB
  mmap():  只有被路由到的 Expert 的页面会被缺页加载
           未激活的 Expert 权重页根本不会进入内存！
           → RSS 可能只有 ~30-40GB

  这才是按需加载的真正美妆场景。
```

"VmSize 和 VmRSS 的区别正好体现了这一点："

```bash
# 推理运行 10 分钟后再检查（dense 模型）
$ cat /proc/$(pidof inference_server)/status | grep -E "VmRSS|VmSize"
VmSize:  143654912 kB   # 虚拟地址空间 ~140GB（映射了整个文件）
VmRSS:   141230080 kB   # 实际物理内存 ~135GB（dense 模型最终触及了 96%）
```

"对 dense 模型，VmRSS 最终会接近 VmSize——这很正常。mmap 的价值不在于'少加载'，而在于零拷贝、快速启动和多进程共享。"

---

#### 🔍 步骤 4：缺页异常——操作系统的"魔法时刻"

王姐决定深入讲讲 mmap 背后的机制。

"当推理代码执行 `float w = weights[offset]` 时，实际上发生了这些事："

```
推理代码访问 weights[offset]，CPU 做的事：

① CPU 用 offset 计算出虚拟地址 VA
② MMU 查页表：VA → PA？
   ├── 命中：直接读 PA 处的数据（快路径，纳秒级）
   └── 未命中：页表项标记为"未映射"
       ③ CPU 触发缺页异常（Data Abort on ARM64）
       ④ 内核接管，查看 VMA：这个地址属于 mmap 映射的文件区域
       ⑤ 内核算出该页对应文件的哪个偏移量
       ⑥ 检查 Page Cache：
          ├── 命中：直接拿到物理页
          └── 未命中：发起磁盘 I/O，从 NVMe SSD 读一页（4KB）
       ⑦ 更新页表：VA → 新的 PA
       ⑧ 返回用户态，重新执行那条指令
       ⑨ 这次 MMU 查表命中了→ 正常读到数据
```

"这里最关键的一点是：**整个缺页处理对推理代码完全透明**。代码什么特殊处理都不用做，它只知道 `weights[offset]` 拿到了一个 float 值——内核在背后悄悄完成了一次磁盘 I/O 和页表更新。"

> 💡 **Hot Path vs Cold Path**：第一次访问某页时触发缺页异常（cold path，微秒级），之后再访问同一页（hot path）就是普通的 MMU 翻译，纳秒级完成。推理过程中，权重数据通常会被反复读取，所以绝大部分访问都走的是 hot path。

---

#### 🚀 步骤 5：进阶优化——第一道坎：磁盘 I/O 的漫长等待

小陈测试纯冷启动（先清空 Page Cache）：

```bash
# 纯冷启动：Page Cache 为空，所有缺页都是 Major Fault（需要磁盘 I/O）
$ sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
$ ./benchmark --model llama-70b.bin --mode mmap
Request 1:  first token latency = 45230 ms   # <-- 卡了 45 秒！
Request 2:  first token latency =   842 ms   # <-- 正常
```

"第一个请求为什么这么慢？"

"因为 mmap 是**按需加载**的。第一个推理请求需要访问模型的所有层，理论上 140GB / 4KB = **约 3600 万个页面**。每个页面第一次被访问时，都会触发缺页异常。冷启动时，这些都是**主缺页（Major Fault）**——内核需要从 NVMe SSD 物理读取数据（虽然内核会通过 readahead 批量预读，不是每 4KB 都是独立 I/O）。加上页表建立的开销，总共卡了 45 秒。"

"那怎么办？"

王姐给出了方案：

```c
// 方案 A：MAP_POPULATE — mmap 时就预加载所有页并建立页表
// 代价：mmap() 本身会变慢（类似 read），但之后推理没有缺页

// 方案 B：madvise WILLNEED — 后台异步预读数据到 Page Cache
madvise(weights, file_size, MADV_WILLNEED);
// 内核在后台异步读取，不阻塞当前线程
```

小陈用方案 B 重新测试：

```bash
$ ./benchmark --model llama-70b.bin --mode mmap --prefault willneed
mmap() completed in 0.003 seconds.
madvise(WILLNEED) hint sent.
# （主线程继续做其他初始化，等待 30 秒后接入请求……）
Request 1:  first token latency = 8234 ms    # <-- 降到了 8.2 秒，但还是很慢！
Request 2:  first token latency =  842 ms    # <-- 正常
```

小陈傻眼了："SSD 已经把数据全部预读进物理内存了，为什么还要卡 8 秒？"

王姐笑了："你遭遇了第二道坎——**页表风暴**。"

> 💡 **关键洞察：`MADV_WILLNEED` 的隐藏陷阱**
>
> `madvise(MADV_WILLNEED)` 底层调用的是 `force_page_cache_readahead`。它**只负责把数据从磁盘读进 Page Cache，但绝不会为进程建立页表映射（PTE）！**
>
> 这意味着：即使 140GB 数据已经 100% 在物理内存中，代码第一次访问时，CPU 查页表依然发现"未映射"——**依然会触发 3600 万次次缺页（Minor Fault）**！每次 Minor Fault 的处理开销约 200ns，3600 万 × 200ns ≈ **7.2 秒**。这正好解释了为什么 WILLNEED 把 45秒 降到了 8.2秒（消除了磁盘 I/O），但没能继续降。

小陈："那怎么消除这 3600 万次中断？"

王姐："很简单，把积木变大——用**大页**。"

---

#### 🏗️ 步骤 6：大页（Huge Pages）——消除页表风暴的终极武器

"使用透明大页（THP），140GB / 2MB = **仅 71,680 个页面**。次缺页异常从 3600 万次暴降到 7 万次，建表耗时从 8 秒缩减到十几毫秒！"

王姐看了一眼 perf 输出来验证：

```bash
$ perf stat -e dTLB-load-misses,dTLB-loads ./inference_server --model llama-70b.bin --mode mmap

 Performance counter stats:
   12,345,678,901   dTLB-loads
      823,456,789   dTLB-load-misses    # 6.67% 的 TLB 未命中率！
```

"你看到了吗？**6.67% 的 TLB miss 率**。140GB 的模型用 4KB 小页需要 **3600 万个页表项**——这正是步骤 5 中页表风暴的根源。大页能同时解决两个问题：**减少缺页次数**（从 3600 万降到 7 万）和**降低 TLB miss 率**。针对文件映射，Linux 通过**透明大页（THP）**来实现："

```c
// 步骤 1：正常 mmap 映射文件
void *weights = mmap(NULL, file_size,
                     PROT_READ, MAP_PRIVATE,
                     fd, 0);

// 步骤 2：建议内核为这段虚拟内存使用透明大页（THP）
madvise(weights, file_size, MADV_HUGEPAGE);
// 内核会尝试将 4KB 小页合并为 2MB 大页
// 140GB / 2MB = 仅 71680 个页表项（vs 4KB 的 3600 万个！）
```

> ⚠️ **常见 API 陷阱**：你可能见过 `MAP_HUGETLB` 标志。但 `MAP_HUGETLB` **只能用于匿名映射（`MAP_ANONYMOUS`）或 `hugetlbfs` 特殊文件系统**，不能用于普通磁盘文件（ext4/xfs 上的 `.bin`）的 `fd`——否则 `mmap` 直接返回 `EINVAL`。对于文件映射，正确的做法是用 `madvise(MADV_HUGEPAGE)` 启用透明大页（需要 Linux 5.4+，且系统开启了 THP：`echo always > /sys/kernel/mm/transparent_hugepage/enabled`）。

```
页大小对比（140GB 模型）：

  页大小      页表项数量        TLB 覆盖率
  ─────────────────────────────────────
  4KB         36,700,160       TLB 覆盖 ~0.01%
  2MB (大页)      71,680       TLB 覆盖 ~7%     ← 500x 改善！
  1GB (巨页)         140       TLB 覆盖 ~100%   ← 终极方案
```

```bash
# 启用 WILLNEED + THP 后实测
$ ./benchmark --model llama-70b.bin --mode mmap --prefault willneed --thp
Request 1:  first token latency =  856 ms    # <-- 终于真正正常了！
Request 2:  first token latency =  842 ms
# （~850ms 是纯 CPU 计算的极限——140GB ÷ ~200GB/s 内存带宽 ≈ 700ms + 计算开销）
```

小陈激动了："从 45 秒到 850 毫秒！三步优化的因果链完美闭环："

```
优化因果链：

  纯冷启动：        45s  = 40s 磁盘 I/O + 5s 页表建立
                            ↓
  + WILLNEED：       8.2s = 0s 磁盘 I/O + 8.2s 页表建立（3600万次 Minor Fault）
                            ↓
  + WILLNEED + THP： 0.85s = 0s 磁盘 I/O + ~15ms 页表建立（7万次 Minor Fault）
                            + ~840ms 纯 CPU 计算（内存带宽极限）
```

---

#### 🤝 步骤 7：多进程共享——mmap 的隐藏王牌

上线一个月后，业务量翻倍。运维老刘决定在同一台机器上起两个推理进程来提高吞吐量。

小陈担心："两个进程各加载一份 140GB 的模型，岂不是要 280GB 内存？我们机器只有 256GB！"

王姐："如果用 `read()`，确实会有两份独立的 Buffer。但用 `mmap()` 就不会——**两个进程映射同一个文件，底层共享的是同一组 Page Cache 物理页**。"

```
进程 1 的虚拟地址空间           物理内存 (Page Cache)          进程 2 的虚拟地址空间
┌──────────────────┐                                        ┌──────────────────┐
│ VA: 0x7f...000   │           ┌──────────────────┐         │ VA: 0x7f...000   │
│     weight[0]    │ ────────→ │  物理页: 模型第1页  │ ←─────── │     weight[0]    │
│ VA: 0x7f...1000  │           └──────────────────┘         │ VA: 0x7f...1000  │
│     weight[4096] │ ────────→ ┌──────────────────┐ ←─────── │     weight[4096] │
│     ...          │           │  物理页: 模型第2页  │         │     ...          │
└──────────────────┘           └──────────────────┘         └──────────────────┘
                                                                        
                    两个进程的虚拟地址不同，                          
                    但通过页表指向同一组物理页！                      
                    物理内存只需要 140GB，不是 280GB                 
```

```bash
# 启动两个推理进程
$ ./inference_server --model llama-70b.bin --mode mmap --port 8001 &
$ ./inference_server --model llama-70b.bin --mode mmap --port 8002 &

# 检查系统总内存
$ free -g
              total   used   free   shared  buff/cache   available
Mem:           256    145     12      0        99           98

# 两个进程只用了 ~145GB，不是 280GB！
# 因为它们共享了同一组 Page Cache 页

$ cat /proc/$(pidof inference_server | awk '{print $1}')/smaps | grep -A4 "llama-70b"
...
Shared_Clean:    141230080 kB    # <-- 共享的干净页，两个进程共享这 135GB
Private_Clean:         0 kB     # <-- 没有私有副本
```

"这就是 `mmap()` 在多进程场景下的**隐藏王牌**——操作系统 Page Cache 天然支持去重。用 `read()` 的话，每个进程都有自己的 `malloc` Buffer，操作系统无法知道这些 Buffer 里装的是同一份数据。"

---

#### 📊 步骤 8：完整性能对比

小陈做了一组完整的 Benchmark：

```
┌─────────────────────────────────────────────────────────────────────┐
│        模型加载性能对比（LLaMA-70B, 140GB, 鲲鹏 920 CPU）          │
├────────────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 指标           │ read()   │ mmap     │ mmap +   │ mmap + THP       │
│                │ (eager)  │ (裸冷启动)│ WILLNEED │ + WILLNEED       │
├────────────────┼──────────┼──────────┼──────────┼──────────────────┤
│ 加载/映射耗时  │ 187s     │ 0.003s*  │ 0.003s*  │ 0.003s*          │
│ 首请求延迟     │ 842ms    │ 45230ms  │ 8234ms   │ 856ms            │
│ 延迟组成       │ 纯计算   │ I/O+建表 │ 纯建表   │ 纯计算           │
│ 进程 RSS       │ 141GB    │ 140GB    │ 140GB    │ 140GB            │
│ 双进程总内存   │ 282GB ❌ │ 145GB    │ 145GB    │ 145GB            │
└────────────────┴──────────┴──────────┴──────────┴──────────────────┘

最终方案：mmap + MADV_WILLNEED + THP (2MB)
  → 首请求：从 45 秒降至 856ms（已触及 CPU 内存带宽极限）
  → 内存节省：双进程从 282GB 降至 145GB（节省 49%）
```

> \* mmap 的 0.003s 仅为映射建立时间，实际数据在后续访问时按需装入。

---

#### 🛡️ 步骤 9：陷阱与注意事项

王姐提醒小陈，mmap 不是银弹：

**陷阱 1：缺页延迟不可预测**

```
read()：所有延迟集中在加载阶段（可预期的 3 分钟）
mmap()：延迟分散到整个推理过程（随机的缺页中断）

对于实时性要求极高的场景（如自动驾驶），
应该用 MAP_POPULATE 或 mlock() 提前加载所有页，消除运行时缺页
```

**陷阱 2：内存压力下页被回收**

```
如果系统内存紧张，内核可能回收 mmap 映射的页。
下次访问时会重新触发缺页 + 磁盘 I/O —— 推理突然变慢！

解决：mlock(weights, file_size);  
// 锁定在物理内存中，禁止内核回收（需要 CAP_IPC_LOCK 权限）
```

**陷阱 3：MAP_PRIVATE 的 Copy-on-Write**

```
MAP_PRIVATE 映射的页在写入时会触发 COW（Copy-on-Write），
内核会复制一份私有副本 —— 如果推理框架修改了权重（比如量化），
每一页都会被拷贝！

解决：如果只是读取权重，确保用 PROT_READ。
      如果需要修改，考虑用 MAP_SHARED 或预先在内存中做量化。
```

**陷阱 4：32 位系统不可用**

```
32 位系统的虚拟地址空间只有 4GB，无法映射 140GB 的文件。
但在 64 位 ARM64（虚拟地址空间 256TB+）上完全不是问题。
```

---

#### 💡 战后总结

1. **`read()` = 两次拷贝**：SSD → Page Cache → 用户 Buffer。进程 RSS 占 141GB（malloc Buffer），系统 Page Cache 又占据大量物理内存。加载耗时受限于 SSD 顺序读取带宽 + memcpy 开销

2. **`mmap()` = 零拷贝**：用户虚拟地址直接映射到 Page Cache 物理页。只建立映射关系，不立刻读磁盘，3 毫秒完成

3. **mmap 的核心价值不在于“少加载”**：对 dense 模型，最终所有权重都会被加载。但对 MoE 模型（如 Mixtral 8x7B，每次只激活 2/8 Expert），未被路由到的 Expert 权重页不会进内存——这才是按需加载的真正美妆场景

4. **`madvise()` 消除冷启动延迟**：`MADV_WILLNEED` 异步预加载，`MADV_SEQUENTIAL` 触发内核预读。让第一个推理请求和后续请求一样快

5. **大页（2MB / 1GB）减少 TLB 压力**：140GB 模型用 4KB 页需要 3600 万个 TLB 条目，换成 2MB 大页只需 7 万——TLB miss 率降低 66 倍

6. **多进程共享是隐藏王牌**：多个推理进程 mmap 同一个模型文件，操作系统自动去重。物理内存只需一份，不是 N 份

> **一句话总结：mmap 让操作系统的虚拟内存机制为你工作——零拷贝、按需加载、多进程共享。对于大模型推理这种"巨型只读文件 + 内存密集访问"的场景，mmap 是最自然的选择。**

---

## 🧪 动手实践

### 实验环境

- Linux（推荐 Ubuntu 22.04 或 WSL2，x86_64 或 ARM64 均可）
- GCC：`sudo apt install build-essential`
- perf：`sudo apt install linux-tools-generic`

### 实验 1：亲手测量 read() vs mmap() 的性能差异

创建一个约 1GB 的测试文件，分别用 read() 和 mmap() 读取，对比耗时和内存占用。

创建文件 `bench_io.c`：

```c
// bench_io.c — read() vs mmap() 性能对比
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <string.h>

double now() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1e6;
}

// 遍历数据，模拟推理访问（防止编译器优化掉）
volatile unsigned long checksum = 0;
void touch_data(const char *data, size_t size) {
    unsigned long sum = 0;
    for (size_t i = 0; i < size; i += 4096) {  // 每页读一次
        sum += ((volatile const unsigned char*)data)[i];
    }
    checksum = sum;
    printf("Validation checksum: %lu\n", checksum);  // 防止编译器死代码消除
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <file> <read|mmap|mmap_willneed>\n", argv[0]);
        return 1;
    }

    const char *path = argv[1];
    const char *mode = argv[2];

    int fd = open(path, O_RDONLY);
    struct stat st;
    fstat(fd, &st);
    size_t size = st.st_size;

    printf("File: %s (%zu MB)\n", path, size / (1024*1024));
    printf("Mode: %s\n\n", mode);

    // 清空 Page Cache（需要 root）
    sync();
    // system("echo 3 > /proc/sys/vm/drop_caches");

    double t0, t1, t2;

    if (strcmp(mode, "read") == 0) {
        char *buf = malloc(size);
        t0 = now();
        size_t total = 0;
        while (total < size) {
            ssize_t n = read(fd, buf + total, 1024*1024);
            if (n <= 0) break;
            total += n;
        }
        t1 = now();
        printf("read() completed: %.3f seconds\n", t1 - t0);

        touch_data(buf, size);
        t2 = now();
        printf("Data access:      %.3f seconds\n", t2 - t1);
        printf("Total:            %.3f seconds\n", t2 - t0);
        free(buf);

    } else if (strcmp(mode, "mmap") == 0) {
        t0 = now();
        char *data = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
        if (data == MAP_FAILED) { perror("mmap failed"); exit(1); }
        t1 = now();
        printf("mmap() completed: %.6f seconds\n", t1 - t0);

        touch_data(data, size);
        t2 = now();
        printf("Data access:      %.3f seconds (includes page faults)\n", t2 - t1);
        printf("Total:            %.3f seconds\n", t2 - t0);
        munmap(data, size);

    } else if (strcmp(mode, "mmap_willneed") == 0) {
        t0 = now();
        char *data = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
        if (data == MAP_FAILED) { perror("mmap failed"); exit(1); }
        madvise(data, size, MADV_WILLNEED);
        t1 = now();
        printf("mmap()+madvise(): %.6f seconds\n", t1 - t0);

        sleep(2);  // 给内核预读时间
        touch_data(data, size);
        t2 = now();
        printf("Data access:      %.3f seconds\n", t2 - t1);
        printf("Total:            %.3f seconds\n", t2 - t0);
        munmap(data, size);
    }

    close(fd);
    return 0;
}
```

```bash
# 编译
gcc -O2 -o bench_io bench_io.c

# 创建 1GB 测试文件
dd if=/dev/urandom of=test_weights.bin bs=1M count=1024

# 测试 read()（建议 root 下运行并先 drop_caches）
sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
./bench_io test_weights.bin read

# 测试 mmap()
sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
./bench_io test_weights.bin mmap

# 测试 mmap() + MADV_WILLNEED
sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
./bench_io test_weights.bin mmap_willneed
```

> 📌 **关键观察**：
> - `read()` 的 "read completed" 时间和 "data access" 时间之和就是总时间
> - `mmap()` 的 "mmap completed" 时间极短（微秒级），但 "data access" 时间包含了缺页异常的开销
> - `mmap_willneed` 在 sleep 后访问数据应该更快，因为内核已经在后台预读了

### 实验 2：观察缺页异常

```bash
# 用 perf 统计缺页次数
sudo perf stat -e page-faults,minor-faults,major-faults ./bench_io test_weights.bin mmap

# 对比
sudo perf stat -e page-faults,minor-faults,major-faults ./bench_io test_weights.bin read
```

> 📌 **关键观察**：
> - mmap 方式会有大量 minor faults（从 Page Cache 分配页）和可能的 major faults（从磁盘读取页）
> - read 方式的 page faults 数量远少于 mmap（因为 `malloc` 一次性分配了 Buffer）
> - minor fault = 物理页已在 Page Cache，只需更新页表
> - major fault = 物理页不在内存，需要从磁盘读取

### 实验 3：验证多进程内存共享

```bash
# 终端 1：第一个进程 mmap 文件
./bench_io test_weights.bin mmap &
PID1=$!

# 终端 2：第二个进程 mmap 同一文件
./bench_io test_weights.bin mmap &
PID2=$!

# 检查两个进程的内存
cat /proc/$PID1/smaps | grep -A2 "test_weights"
cat /proc/$PID2/smaps | grep -A2 "test_weights"

# 看 Shared_Clean —— 两个进程共享的物理页
# 再看 free -m —— 系统总内存消耗并不是翻倍
```

### 思考题

1. 如果模型文件存储在网络文件系统（NFS）上而不是本地 NVMe SSD 上，`mmap()` 的性能优势还存在吗？为什么？
2. PyTorch 的 `torch.load()` 默认使用 `read()` 加载模型。从 PyTorch 2.1 开始引入了 `torch.load(mmap=True)` 选项。请解释这个选项的底层原理，以及什么场景下应该开启它。
3. （进阶）Android 系统大量使用 mmap 加载 APK 中的 DEX 字节码和共享库（.so），而不是用 read()。这和 LLM 模型加载的场景有什么相似之处？Android 的哪些系统机制依赖于 mmap 的多进程共享特性？
4. （进阶）Intel 的 Optane 持久内存（PMEM）支持一种叫 DAX（Direct Access）的模式，可以让 mmap 直接映射到物理 PMEM 地址，绕过 Page Cache。这对 LLM 推理意味着什么？
5. 为什么 `mmap()` + `MAP_PRIVATE` + `PROT_READ` 的组合对模型权重最合适？如果换成 `MAP_SHARED` 会有什么不同？如果去掉 `PROT_READ` 限制（加上 `PROT_WRITE`），会发生什么？
