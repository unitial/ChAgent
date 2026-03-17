/**
 * player-data.js — 百G模型三分钟加载？—— mmap 让大模型推理起飞
 * 由 interactive-player SKILL 按照 mmap_weights.md 生成
 */
const PLAYER_CONFIG = {
  title: "百G模型加载优化：mmap 让大模型推理起飞",
  subtitle: "性能优化全真模拟推演。<br>跟随系统工程师的视角，三步优化把首请求延迟从 45 秒降到 850 毫秒。",
  splashImage: null,

  steps: [
    {
      title: "📅 场景：冷启动太慢，Pod 被杀",
      terminal: {
        prompt: "$ ", command: "time ./inference_server --model llama-70b.bin --mode read",
        output: "Loading model weights (140GB)...\\n[====================] 100%  (140.0 GB loaded)\\nModel loaded in 187.3 seconds.    # <-- 超过 3 分钟！\\nProcess RSS: 141 GB               # <-- 进程自己占了 141GB\\n\\n$ free -g\\n              total   used   free   shared  buff/cache   available\\nMem:           256    143      2      0       111           0\\n# buff/cache 也被吃满了！系统可用内存逼近 0"
      },
      commentary: `<p><strong>场景：</strong>AI 创业公司，核心产品是基于 LLaMA-70B 的智能客服。线上部署在 ARM64 服务器（鲲鹏 920, 256GB 内存, NVMe SSD）。</p>
<p>模型有多大？70B 参数 × FP16 × 2 字节 = <strong>光权重就 140GB</strong>。</p>
<p class="warning">🔥 <strong>3 分钟</strong>才加载完，进程 RSS 占了 141GB，系统 buff/cache 被撑到 111GB——整个系统几乎没有可用内存了。K8s 健康检查超时，Pod 被杀了两次。</p>
<p class="dialogue"><span class="speaker">小陈：</span>"进程 RSS 141GB，系统缓存 111GB——两份数据？"</p>
<p class="dialogue"><span class="speaker">系统组王姐：</span>"问题出在 <code>read()</code> 的数据路径上。"</p>`
    },
    {
      title: "🔬 诊断——read() 的双重拷贝",
      terminal: {
        prompt: "", command: "",
        output: "read() 数据搬运路径：\\n  NVMe SSD →(DMA)→ Page Cache (内核空间) →(memcpy)→ 用户 Buffer (malloc)\\n\\n问题：数据被搬了两次！\\n  进程 RSS = 141GB (malloc Buffer)\\n  buff/cache = 111GB (Page Cache)\\n  两份数据挤占系统内存！\\n\\nmmap() 数据路径：\\n  NVMe SSD →(DMA)→ Page Cache ←── 虚拟地址直接指向这里\\n  没有第二次拷贝！零拷贝！"
      },
      commentary: `<p class="dialogue"><span class="speaker">王姐画出数据链路：</span></p>
<p><code>read()</code> 的数据搬运路径：<br>
<strong>NVMe SSD</strong> →(DMA)→ <strong><span class="chat-link">Page Cache</span></strong>（内核空间）→(memcpy)→ <strong>用户 Buffer</strong>（malloc）</p>
<p class="warning">🔥 数据被<strong>搬了两次</strong>！SSD → Page Cache 是 DMA 传输，但 <code>read()</code> 还会从 Page Cache <strong>再 memcpy 一次</strong>到用户态 Buffer。</p>
<p class="insight">💡 进程 RSS = 141GB（malloc Buffer）。而 Page Cache 属于系统级缓存，不计入进程 RSS，体现在 <code>free</code> 命令的 <code>buff/cache</code> 列中。两份数据挤占系统内存。加载 187 秒主要受限于 SSD 顺序读取带宽 + memcpy 开销。</p>
<p class="dialogue"><span class="speaker">小陈：</span>"有没有办法只用一份？"</p>
<p class="dialogue"><span class="speaker">王姐：</span>"这就轮到 <code><span class="chat-link">mmap()</span></code> 上场了。"</p>`
    },
    {
      title: "🧠 mmap——零拷贝映射",
      terminal: {
        prompt: "$ ", command: "time ./inference_server --model llama-70b.bin --mode mmap",
        output: "Mapping model weights (140GB)...\\nmmap() completed in 0.003 seconds.   # <-- 3 毫秒！！\\nPeak RSS: 2 GB                       # <-- 初始只占 2GB"
      },
      commentary: `<p><code>mmap()</code> 的数据路径：<br>
<strong>NVMe SSD</strong> →(DMA)→ <strong><span class="chat-link">Page Cache</span></strong> ←── 虚拟地址直接指向这里</p>
<p><strong>没有第二次拷贝！</strong><code>mmap()</code> 让进程虚拟地址<strong>直接映射到 Page Cache 中的物理页</strong>。CPU 通过页表翻译，直接读 Page Cache 里的数据——零拷贝。</p>
<p class="dialogue"><span class="speaker">小陈：</span>"等等——3 毫秒？140GB 的文件 3 毫秒？这不科学！"</p>
<p class="insight">💡 因为 <code>mmap()</code> 只是<strong>建立了映射关系</strong>（修改了页表和 VMA），并没有真正把数据读到内存。数据是在<strong>第一次访问</strong>时，通过<span class="chat-link">缺页异常</span>按需加载的——这就是 <strong><span class="chat-link">Demand Paging</span></strong>。</p>`
    },
    {
      title: "🤔 mmap 的真正价值——Dense vs MoE",
      terminal: {
        prompt: "$ ", command: "cat /proc/$(pidof inference_server)/status | grep -E \"VmRSS|VmSize\"",
        output: "VmSize:  143654912 kB   # 虚拟地址空间 ~140GB（映射了整个文件）\\nVmRSS:   141230080 kB   # 实际物理内存 ~135GB（dense 模型最终触及了 96%）"
      },
      commentary: `<p class="dialogue"><span class="speaker">小陈：</span>"LLaMA-70B 是 dense 模型，做一次推理会触及所有层的全部权重。那 mmap 不就是把加载推迟了？它的真正价值在哪里？"</p>
<p class="dialogue"><span class="speaker">王姐：</span>"问得好。对 dense 模型，mmap 确实不会减少总 I/O 量。它的<strong>真正价值</strong>是："</p>
<p>① <strong>零拷贝</strong>：不需要 Page Cache + malloc Buffer 两份内存<br>
② <strong>快速启动</strong>：服务 0.003s 内通过 K8s 健康检查<br>
③ <strong>多进程共享</strong>：多个推理进程共享同一组物理页</p>
<p class="insight">💡 但对 <strong>MoE 模型</strong>（如 Mixtral 8x7B，每次只激活 2/8 Expert），未被路由到的 Expert 权重页<strong>根本不会进入内存</strong>——这才是按需加载的真正美妆场景。</p>
<p>对 dense 模型，VmRSS 最终会接近 VmSize——这很正常。mmap 的价值不在于"少加载"，而在于零拷贝、快速启动和多进程共享。</p>`
    },
    {
      title: "🔍 缺页异常——操作系统的魔法时刻",
      terminal: {
        prompt: "", command: "",
        output: "推理代码访问 weights[offset] 时，CPU 背后做的事：\\n\\n① MMU 查页表：VA → PA？\\n├── 命中：直接读数据（纳秒级，hot path）\\n└── 未命中：页表项标记为\"未映射\"\\n    ② 触发缺页异常（ARM64: Data Abort）\\n    ③ 内核接管：查 VMA → 算出文件偏移 → 检查 Page Cache\\n       ├── Page Cache 命中：Minor Fault（微秒级）\\n       └── Page Cache 未命中：Major Fault（毫秒级，需磁盘 I/O）\\n    ④ 更新页表：VA → 新 PA\\n    ⑤ 返回用户态，重新执行那条指令 → 命中！"
      },
      commentary: `<p>推理代码访问 <code>weights[offset]</code> 时，CPU 背后做的事：</p>
<p><strong>① MMU 查页表</strong>：VA → PA？<br>
├── <strong>命中</strong>：直接读数据（纳秒级，hot path）<br>
└── <strong>未命中</strong>：页表项标记为"未映射"<br>
&nbsp;&nbsp;&nbsp;&nbsp;<strong>② 触发<span class="chat-link">缺页异常</span></strong>（ARM64: Data Abort）<br>
&nbsp;&nbsp;&nbsp;&nbsp;<strong>③ 内核接管</strong>：查 VMA → 算出文件偏移 → 检查 Page Cache<br>
&nbsp;&nbsp;&nbsp;&nbsp;<strong>④ 更新页表</strong>：VA → 新 PA<br>
&nbsp;&nbsp;&nbsp;&nbsp;<strong>⑤ 返回用户态</strong>，重新执行那条指令 → 命中！</p>
<p class="thinking">整个过程对推理代码<strong>完全透明</strong>。代码只知道 <code>weights[offset]</code> 拿到了值——内核在背后悄悄完成了磁盘 I/O 和页表更新。</p>
<p class="insight">💡 <b>Hot Path vs Cold Path</b>：第一次访问触发缺页（cold path，微秒级），之后再访问同一页（hot path）就是纳秒级 MMU 翻译。</p>`
    },
    {
      title: "🚀 第一道坎——磁盘 I/O + 页表风暴",
      terminal: {
        prompt: "$ ", command: "./benchmark --model llama-70b.bin --mode mmap --prefault willneed",
        output: "# 纯冷启动（Page Cache 为空）：\\nRequest 1:  first token latency = 45230 ms   # <-- 卡了 45 秒！\\n\\n# 加上 MADV_WILLNEED 后台预读（等待 30 秒后接入请求）：\\nmadvise(WILLNEED) hint sent.\\nRequest 1:  first token latency = 8234 ms    # <-- 降到 8.2 秒，但还是很慢！\\nRequest 2:  first token latency =  842 ms    # <-- 正常"
      },
      commentary: `<p>裸 mmap <strong>纯冷启动</strong>：140GB / 4KB ≈ <strong>3600 万个页面</strong>，全是主缺页（Major Fault）→ 磁盘 I/O + 页表建立 = 45 秒。</p>
<p><code>MADV_WILLNEED</code> 把数据预读进 Page Cache，消除了磁盘 I/O——但首请求<strong>仍然卡 8.2 秒</strong>！</p>
<p class="dialogue"><span class="speaker">小陈：</span>"SSD 数据已经全部在内存里了，为什么还卡 8 秒？"</p>
<p class="dialogue"><span class="speaker">王姐：</span>"你遭遇了第二道坎——<strong>页表风暴</strong>。"</p>
<p class="warning">🔥 <b>关键洞察：MADV_WILLNEED 的隐藏陷阱</b><br>
<code>madvise(MADV_WILLNEED)</code> 底层调用 <code>force_page_cache_readahead</code>。它<strong>只负责把数据读进 Page Cache，但绝不会为进程建立页表映射（PTE）！</strong><br>
即使 140GB 数据 100% 在物理内存中，首次访问仍触发 <strong>3600 万次次缺页（Minor Fault）</strong>。每次 ~200ns → 3600万 × 200ns ≈ <strong>7.2 秒</strong>。</p>
<p class="dialogue"><span class="speaker">小陈：</span>"那怎么消除这 3600 万次中断？"</p>
<p class="dialogue"><span class="speaker">王姐：</span>"很简单，把积木变大——用<strong>大页</strong>。"</p>`
    },
    {
      title: "🏗️ 大页——消除页表风暴的终极武器",
      terminal: {
        prompt: "$ ", command: "./benchmark --model llama-70b.bin --mode mmap --prefault willneed --thp",
        output: "Request 1:  first token latency =  856 ms    # <-- 终于真正正常了！\\nRequest 2:  first token latency =  842 ms\\n# (~850ms 是纯 CPU 计算极限：140GB ÷ ~200GB/s 内存带宽 ≈ 700ms + 计算开销)"
      },
      commentary: `<p>140GB / 2MB = <strong>仅 71,680 个页面</strong>。次缺页从 3600 万暴降到 7 万，建表耗时从 8 秒缩减到十几毫秒！</p>
<p>用 <strong><span class="chat-link">透明大页</span>（THP）</strong>：正常 mmap 后调用 <code>madvise(MADV_HUGEPAGE)</code>。</p>
<p class="insight">💡 ⚠️ 常见 API 陷阱：<code>MAP_HUGETLB</code> <strong>只能用于匿名映射或 hugetlbfs</strong>，不能用于普通磁盘文件——否则返回 <code>EINVAL</code>。对文件映射，正确做法是 <code>madvise(MADV_HUGEPAGE)</code>（需 Linux 5.4+）。</p>
<p><strong>三步优化的因果链完美闭环：</strong></p>
<p>
纯冷启动：45s = 40s 磁盘 I/O + 5s 页表建立<br>
&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
+ WILLNEED：8.2s = 0s I/O + 8.2s 页表建立（3600万次 Minor Fault）<br>
&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
+ WILLNEED + THP：0.85s = ~15ms 页表 + ~840ms 纯 CPU 计算（内存带宽极限）
</p>`
    },
    {
      title: "🤝 多进程共享——隐藏王牌",
      terminal: {
        prompt: "$ ", command: "free -g",
        output: "              total   used   free   shared  buff/cache   available\\nMem:           256    145     12      0        99           98\\n\\n# 两个推理进程只用了 ~145GB，不是 280GB！\\n# 因为它们共享了同一组 Page Cache 页"
      },
      commentary: `<p>业务量翻倍，需要在同一台机器上<strong>起两个推理进程</strong>。</p>
<p class="dialogue"><span class="speaker">小陈：</span>"两个进程各 140GB，需要 280GB！我们只有 256GB！"</p>
<p class="dialogue"><span class="speaker">王姐：</span>"用 <code>read()</code> 确实要两份独立 Buffer。但用 <code>mmap()</code> 就不会——<strong>两个进程的虚拟地址通过页表指向同一组 Page Cache 物理页</strong>。物理内存只需一份。"</p>
<p class="conclusion">🎯 <strong>mmap 的隐藏王牌</strong>：操作系统 Page Cache 天然支持去重。<code>read()</code> 的 <code>malloc</code> Buffer 则无法被系统识别为相同数据。</p>`
    },
    {
      title: "📊 完整性能对比",
      terminal: {
        prompt: "", command: "",
        output: "┌────────────────┬──────────┬──────────┬──────────┬──────────────────┐\\n│ 指标           │ read()   │ mmap     │ mmap +   │ mmap + THP       │\\n│                │ (eager)  │ (裸冷启动)│ WILLNEED │ + WILLNEED       │\\n├────────────────┼──────────┼──────────┼──────────┼──────────────────┤\\n│ 加载/映射耗时  │ 187s     │ 0.003s*  │ 0.003s*  │ 0.003s*          │\\n│ 首请求延迟     │ 842ms    │ 45230ms  │ 8234ms   │ 856ms            │\\n│ 延迟组成       │ 纯计算   │ I/O+建表 │ 纯建表   │ 纯计算           │\\n│ 进程 RSS       │ 141GB    │ 140GB    │ 140GB    │ 140GB            │\\n│ 双进程总内存   │ 282GB ❌ │ 145GB    │ 145GB    │ 145GB            │\\n└────────────────┴──────────┴──────────┴──────────┴──────────────────┘"
      },
      commentary: `<p class="conclusion">🎯 <strong>最终方案：mmap + MADV_WILLNEED + THP (2MB)</strong></p>
<p>
→ 首请求：从 45 秒降至 856ms（已触及 CPU 内存带宽极限）<br>
→ 内存节省：双进程从 282GB 降至 145GB（<strong>节省 49%</strong>）</p>
<p class="insight">💡 * mmap 的 0.003s 仅为映射建立时间，实际数据在后续访问时按需装入。</p>`
    },
    {
      title: "🛡️ 陷阱与注意事项",
      terminal: {
        prompt: "", command: "",
        output: "陷阱 1: 缺页延迟不可预测\\n  read() 延迟集中在加载阶段\\n  mmap() 延迟分散到整个推理过程（随机缺页）\\n  解决: MAP_POPULATE 或 mlock() 提前锁定\\n\\n陷阱 2: 内存压力下页被回收\\n  内核可能回收 mmap 页 → 下次访问重新缺页\\n  解决: mlock(weights, file_size)\\n\\n陷阱 3: MAP_PRIVATE 的 Copy-on-Write\\n  写入时内核复制私有副本 → 量化修改权重会触发逐页拷贝\\n  解决: 用 PROT_READ 只读访问"
      },
      commentary: `<p>王姐提醒：mmap 不是银弹。</p>
<p><strong>陷阱 1：缺页延迟不可预测</strong><br>
<code>read()</code> 所有延迟集中在加载阶段。<code>mmap()</code> 延迟分散到整个推理过程（随机缺页）。<br>
对实时性要求极高的场景（自动驾驶），应该用 <code>MAP_POPULATE</code> 或 <code><span class="chat-link">mlock()</span></code> 提前加载。</p>
<p><strong>陷阱 2：内存压力下页被回收</strong><br>
内核可能回收 mmap 的页。下次访问重新触发缺页——推理突然变慢！<br>
解决：<code>mlock(weights, file_size)</code> 锁定物理内存。</p>
<p><strong>陷阱 3：MAP_PRIVATE 的 <span class="chat-link">Copy-on-Write</span></strong><br>
写入时内核会复制私有副本。如果推理框架修改权重（量化），每页都被拷贝！<br>
解决：确保用 <code>PROT_READ</code>，只读访问。</p>`
    },
    {
      title: "💡 总结与启示",
      terminal: {
        prompt: "", command: "",
        output: "三步优化因果链：\\n  纯冷启动: 45s = 磁盘I/O(40s) + 页表建立(5s)\\n       ↓ + MADV_WILLNEED (预读进 Page Cache)\\n  8.2s = I/O消除 + 3600万次 Minor Fault(8.2s)\\n       ↓ + THP 2MB 大页 (缺页从3600万→7万)\\n  0.85s = 页表~15ms + 纯CPU计算(840ms, 内存带宽极限)\\n\\n核心知识点：\\n  read()  = 两次拷贝 (SSD→PageCache→malloc)\\n  mmap()  = 零拷贝 (虚拟地址直接映射PageCache)\\n  WILLNEED = 只预读不建页表\\n  THP     = 消除页表风暴 (4KB→2MB)\\n  多进程共享 = OS自动去重"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>read() = 两次拷贝</strong> — SSD → Page Cache → 用户 Buffer。进程 RSS 141GB + 系统 Page Cache 挤占内存<br>
2. <strong>mmap() = 零拷贝</strong> — 虚拟地址直接映射到 <span class="chat-link">Page Cache</span> 物理页。0.003s 建立映射<br>
3. <strong>mmap 的核心价值不在于"少加载"</strong> — 对 dense 模型最终全部加载。但对 MoE 模型（Mixtral 8x7B，每次激活 2/8 Expert），未被路由的 Expert 权重不进内存<br>
4. <strong>MADV_WILLNEED 只预读不建页表</strong> — 消除磁盘 I/O（45s → 8.2s），但 3600 万次 Minor Fault 仍需 8 秒<br>
5. <strong>THP 消除页表风暴</strong> — 2MB 大页让缺页从 3600 万降到 7 万，建表耗时 8s → 15ms<br>
6. <strong>多进程共享是隐藏王牌</strong> — 操作系统自动去重，物理内存只需一份</p>
<p class="insight">💡 <strong>一句话总结：mmap 让操作系统的虚拟内存机制为你工作——零拷贝、按需加载、多进程共享。三步优化（WILLNEED 消 I/O → THP 消页表风暴 → CPU 带宽极限）让 140GB 模型的首请求从 45 秒降到 856 毫秒。</strong></p>`
    }
  ]
};
