/**
 * player-data.js — 榨干系统调用最后一丝性能：openEuler xcall
 * 由 interactive-player SKILL 按照 openeuler_xcall.md 生成
 */
const PLAYER_CONFIG = {
  title: "榨干系统调用最后一丝性能：openEuler xcall",
  subtitle: "网络高频压测全真模拟推演。<br>跟随内核工程师的视角，看 openEuler 如何突破性能"玻璃天花板"。",
  splashImage: null,

  steps: [
    {
      title: "📎 故事背景：遇到性能天花板",
      terminal: {
        prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
        output: "PING_INLINE: 812345.67 requests per second, p50=0.512 msec\nGET: 809112.33 requests per second, p50=0.521 msec\n\n$ vmstat 1 3\nprocs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n12  0      0  2109M  120M  4100M    0    0     0     0 80k 120k 35 60  5  0  0\n14  0      0  2109M  120M  4100M    0    0     0     0 82k 125k 33 62  5  0  0"
      },
      commentary: `<p><strong>场景：</strong>Redis 分布式缓存网关在最新采购的 128 核 ARM64 服务器上进行真实流量回放压测。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"老王，我彻底抓狂了！按理说这种神级配置跑 Redis 应该是碾压局，可单实例 QPS 就是死死卡在 80 万上不去！"</p>
<p class="dialogue"><span class="speaker">小宇：</span>"你看 <code>vmstat</code>：<code>us</code>（User 用户态）只有 35%，而 <code>sy</code>（System 内核态）竟然高达 60%！Redis 的核心逻辑全在用户态里，现在 sy 反倒比 us 高出一大截，到底是谁偷走了 CPU 算力？"</p>`
    },
    {
      title: "🔍 perf top：追查 CPU 窃贼",
      terminal: {
        prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
        output: "Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000\nOverhead  Shared Object       Symbol\n  15.20%  [kernel]            [k] el0_sync\n  12.30%  [kernel]            [k] do_el0_svc\n   8.40%  [kernel]            [k] do_epoll_wait\n   7.20%  [kernel]            [k] copy_from_user\n   6.50%  [kernel]            [k] sys_read"
      },
      commentary: `<p>老王微微一笑，敲下了一行 <code>perf top</code> 命令。</p>
<p class="insight">🎯 <b>原来如此：系统调用的"过关费"太贵了！</b><br>
排名前两位的 <span class="chat-link">el0_sync</span> 和 <code>do_el0_svc</code> 加起来占了近 28% 的 CPU！这两个函数本身不做任何实际工作，它们只是系统调用的"入口框架"——像高速公路的收费站，不会帮你开车，但每次过路都强制停一下。<br>
后面的 <code>do_epoll_wait</code>、<code>copy_from_user</code>、<code>sys_read</code> 是真正干活的内核 I/O 操作。</p>`
    },
    {
      title: "🧳 冗长的常规系统调用路线",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">老王：</span>"在标准的 ARM64 Linux 中，每次发生系统调用（遇到 <code><span class="chat-link">SVC</span></code> 指令），CPU 会触发异常跳转到内核的 <code>el0_sync</code>。在这个过程中，内核必须做一整套'全身体检'。"</p>
<p>标准路线：<br>
1. 硬件切换到 <span class="chat-link">EL1</span> 特权级<br>
2. 软件在 <code>el0_sync</code> 中，把所有通用寄存器（X0~X30）统统压入内核栈（构建 <code>pt_regs</code>）<br>
3. 检查有没有挂起的信号量或调度需求<br>
4. 解析系统调用号，查表，分发<br>
5. 返回时再把 30 多个寄存器弹出来恢复</p>
<p class="thinking">对于像读写大文件这种极其耗时的操作，这点开销不值一提。但对于 Redis、Nginx 处理海量微小请求的程序来说，系统调用本身的开销甚至超过了实际干的活！这叫"底噪"太大。</p>`
    },
    {
      title: "⚡ 杀手锏：openEuler xcall 极速通道",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">老王：</span>"正因为如此，华为在主导的 <span class="chat-link">openEuler</span> 中针对 ARM64 引入了一把尖刀——<b>xcall 机制 (Fast System Call)</b>。"</p>
<p>xcall 的核心思想是<strong>"VIP 快速绿色通道"</strong>。</p>
<p class="insight">💡 <b>关键在于利用 C 语言的调用约定 (<span class="chat-link">ABI</span>)</b><br>
传统系统调用视用户进程为黑盒，"宁错杀不放过"地拍下 <code>pt_regs</code> 快照。<br>
而 xcall <b>主动信任并利用了用户态 C 函数的调用约定</b>。按照编译器规则（<span class="chat-link">AAPCS64</span>），函数调用允许破坏"暂存寄存器"（X0~X7），而"非易失性寄存器"（X19~X28）必须由被调用者负责保存。<br>
因此 xcall 只需保存 3~4 个受特权切换波及的底层寄存器，连 <code>pt_regs</code> 都不用建！</p>
<p>此外，xcall 还<b>彻底抛弃了调度检查包袱</b>，直通极简 C 函数，完事后光速返回 EL0。</p>`
    },
    {
      title: "🔓 实战：一键开启 xcall",
      terminal: {
        prompt: "$ ", command: "cat /sys/kernel/debug/xcall/status\n$ echo 1 | sudo tee /sys/kernel/debug/xcall/enable\n$ cat /proc/xcall/stat",
        output: "xcall is disabled.\nSupported syscalls: gettimeofday, epoll_wait, read, write, recvfrom, sendto...\n1\nxcall_hits: 0\nxcall_misses: 0"
      },
      commentary: `<p class="dialogue"><span class="speaker">小宇：</span>"需要我改 Redis 代码吗？用特殊 API？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"最牛的地方就是：<b>对用户态应用完全透明！零修改代码！</b>只需要在内核里打个开关。"</p>
<p>老王通过 debugfs 和 procfs，轻描淡写地激活了整个系统的极速调用引擎。</p>`
    },
    {
      title: "🚀 性能起飞：见证奇迹的时刻",
      terminal: {
        prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
        output: "PING_INLINE: 981240.11 requests per second, p50=0.380 msec\nGET: 978101.45 requests per second, p50=0.395 msec\n\n$ cat /proc/xcall/stat\nxcall_hits: 15480201\nxcall_misses: 231405\n\n$ vmstat 1 3\nprocs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n12  0      0  2105M  120M  4100M    0    0     0     0 95k  85k 50 45  5  0  0\n13  0      0  2105M  120M  4100M    0    0     0     0 97k  88k 48 47  5  0  0"
      },
      commentary: `<p class="thinking">小宇屏住呼吸，重置了压测环境，再次按下了回车键。</p>
<p class="insight">🔥 <b>性能提升的真相！</b><br>
QPS 从 81 万飙升到近 98 万，提升约 20%！<code>xcall_hits</code> 疯狂飙升证明海量调用已走上快速通道。<br>
更关键的是 <code>vmstat</code>：<code>us</code> 从 35% 回升到 50%，<code>sy</code> 从 60% 降到 45%！用户态终于变成大头。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"等等，内核态还有 45%？怎么没有彻底降下来？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"xcall 只优化了系统调用的<b>入口/出口框架</b>，而内核里真正干活的代码——网络 I/O、内存拷贝、Epoll 管理——是正当的内核工作，不能也不应该被消除。"</p>`
    },
    {
      title: "🛡️ perf top 重新复盘",
      terminal: {
        prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
        output: "Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000\nOverhead  Shared Object       Symbol\n   9.10%  [kernel]            [k] do_epoll_wait\n   7.20%  [kernel]            [k] copy_from_user\n   6.50%  [kernel]            [k] sys_read\n   2.10%  [kernel]            [k] el0_sync\n   1.50%  [kernel]            [k] do_el0_svc"
      },
      commentary: `<p class="conclusion">✨ <strong>小宇彻底懂了</strong><br>
曾经盘踞在 CPU 消耗榜头两名的 <code>el0_sync</code> + <code>do_el0_svc</code>（共 28%）降到了 3.6%！与 vmstat 中 sy 下降的幅度完美对应。<br>
xcall 的设计哲学：<b>不干涉内核的实际工作，只精准砍掉"进出城门"的无用开销</b>。</p>`
    },
    {
      title: "🎓 进阶探讨：为什么不全用 xcall？",
      terminal: null,
      commentary: `<p class="thinking">既然 xcall 性能如此爆炸，为什么 Linux 社区不把所有系统调用都改成极简模式？</p>
<p class="insight">💡 原因在于：<b>极简现场保存是有高昂代价的。</b></p>
<p><b>1. 丧失了进程调度能力</b><br>
传统的<span class="chat-link">抢占式</span>操作系统在系统调用返回前会检查时间片。调度发生时进程会被挂起，寄存器状态必须保存在 <code>pt_regs</code> 中。xcall 根本没有建立 <code>pt_regs</code>，所以<b>绝对不能被挂起</b>。它只适用于绝不阻塞的高频调用。</p>
<p><b>2. 丧失了信号处理时机</b><br>
<code>Ctrl+C</code> 这样的信号通常在系统调用返回时处理。xcall 为求极致速度直接砍掉了信号检查逻辑。</p>
<p><b>3. 内核追踪（<span class="chat-link">Strace</span>）失效</b><br>
追求极限性能和极致可观测性往往是矛盾的。xcall 会绕过 <code>ptrace</code> 探测点。</p>
<p class="conclusion">🎯 xcall 并非要替代传统架构，而是作为一种极精细的<strong>旁路加速插件</strong>，专供少量极高频、极低耗时的"白名单"操作使用。</p>`
    }
  ]
};
