/**
 * player-data.js — 榨干系统调用最后一丝性能：openEuler xcall 零门槛提速
 * 由 interactive-player SKILL 按照 openeuler_xcall.md 生成
 */
const PLAYER_CONFIG = {
  title: "榨干系统调用最后一丝性能：openEuler xcall 零门槛提速",
  subtitle: '网络高频压测全真模拟推演。<br>跟随内核工程师的视角，看 openEuler 如何突破性能"玻璃天花板"。',
  splashImage: null,

  steps: [
    {
      title: "😱 场景：遇到性能的\u201C玻璃天花板\u201D",
      terminal: {
        prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
        output: "PING_INLINE: 812345.67 requests per second, p50=0.512 msec\nGET: 809112.33 requests per second, p50=0.521 msec\n\n$ vmstat 1 3\nprocs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n12  0      0  2109M  120M  4100M    0    0     0     0 80k 120k 35 60  5  0  0\n14  0      0  2109M  120M  4100M    0    0     0     0 82k 125k 33 62  5  0  0"
      },
      commentary: `<p><strong>场景：</strong>Redis 分布式缓存网关在 128 核 ARM64 服务器上进行真实流量回放压测。单实例 QPS 死死卡在 80 万上不去。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"老王，按理说这种神级配置跑 Redis 这种纯内存数据库应该是碾压局，可 QPS 就是死死卡在 80 万上不去！"</p>
<p class="dialogue"><span class="speaker">小宇：</span>"你看 <code>vmstat</code>：<code>us</code>（User 用户态）只有 35%，而 <code>sy</code>（System 内核态）竟然高达 60%！<code>cs</code>（上下文切换）每秒高达十二万次！Redis 的核心逻辑全在用户态里，现在 sy 反倒比 us 高出一大截——到底是谁偷走了 CPU 算力？"</p>`
    },
    {
      title: "🔍 perf top：追查 CPU 窃贼",
      terminal: {
        prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
        output: "Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000\nOverhead  Shared Object       Symbol\n  15.20%  [kernel]            [k] el0_sync\n  12.30%  [kernel]            [k] do_el0_svc\n   8.40%  [kernel]            [k] do_epoll_wait\n   7.20%  [kernel]            [k] copy_from_user\n   6.50%  [kernel]            [k] sys_read"
      },
      commentary: `<p>老王微微一笑，敲下了一行 <code>perf top</code> 命令。</p>
<p class="insight">🎯 <b>原来如此：系统调用的"过关费"太贵了！</b><br>
排名前两位的 <span class="chat-link">el0_sync</span> 和 <code>do_el0_svc</code> 加起来占了近 <strong>28%</strong> 的 CPU！这两个函数本身不做任何实际工作，它们只是系统调用的"入口框架"——像高速公路的收费站，不会帮你开车，但每次过路都强制让你停一下。<br>
后面的 <code>do_epoll_wait</code>、<code>copy_from_user</code>、<code>sys_read</code> 是真正干活的内核 I/O 操作，它们是正当的内核态工作。</p>`
    },
    {
      title: "🧳 常规系统调用路线的沉重包袱",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">老王：</span>"在标准的 ARM64 Linux 中，每次发生系统调用（遇到 <code><span class="chat-link">SVC</span></code> 指令），CPU 会触发异常跳转到内核的 <code>el0_sync</code>。在这个过程中，内核必须做一整套'全身体检'。"</p>
<p>标准的系统调用入口流程：<br>
1. 硬件切换到 <span class="chat-link">EL1</span> 特权级<br>
2. 软件在 <code>el0_sync</code> 中，把所有通用寄存器（X0~X30）统统压入内核栈（构建 <code>pt_regs</code>）<br>
3. 检查有没有挂起的信号量或调度需求（TIF_WORK）<br>
4. 解析系统调用号，查表，分发到具体的函数<br>
5. 返回时，再把 30 多个寄存器从栈里弹出来恢复（<code>ERET</code>）</p>
<p class="thinking">对于像读写大文件这种极其耗时的操作，这点开销不值一提。但对于 Redis、Nginx 这种处理海量微小请求的程序来说，系统调用本身（保存和恢复几十个寄存器）的开销，甚至超过了系统调用里面实际干的那点活！这叫"底噪"太大。</p>`
    },
    {
      title: "⚡ 杀手锏出栈：openEuler xcall 极速通道",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">老王：</span>"正因为如此，华为在主导的 <span class="chat-link">openEuler</span> 操作系统中，针对 ARM64 引入了一把尖刀——<b>xcall 机制 (Fast System Call)</b>。"</p>
<p>xcall 的核心思想是<strong>"VIP 快速绿色通道"</strong>：既然很多高频的系统调用只用到两三个寄存器、根本不可能阻塞，那为什么还要傻乎乎地保存和恢复全部 30 多个寄存器呢？</p>
<p class="insight">💡 <b>关键在于利用 C 语言的 ABI（调用规范）约定</b><br>
传统系统调用视用户进程为黑盒，"宁错杀不放过"地拍下 <code>pt_regs</code> 快照。<br>
而 xcall <b>主动信任并利用了用户态 C 函数的调用约定（<span class="chat-link">AAPCS64</span> ABI）</b>。按照编译器规则，函数调用允许破坏"暂存寄存器"（X0~X7 和 LR），而"非易失性寄存器"（X19~X28）必须由被调用者负责保存。<br>
因此 xcall 只需保存 3~4 个受特权切换波及的底层寄存器，连 <code>pt_regs</code> 都不用建！</p>
<p>此外，xcall 还做到了：</p>
<p>① <strong>指令热替换拦截</strong>：自动把白名单系统调用的 <code>SVC</code> 指令替换成可直接跳往极速入口的"魔法指令"<br>
② <strong>极简现场保存</strong>：仅保存 3~4 个受损寄存器，不建立 <code>pt_regs</code><br>
③ <strong>彻底抛弃调度包袱</strong>：不检查信号和调度，做完立刻返回<br>
④ <strong>直通 C 函数执行</strong>：绕开 <code>do_el0_svc</code> 查表分发，直接执行极简版函数</p>`
    },
    {
      title: "🔓 实战：一键开启 xcall",
      terminal: {
        prompt: "$ ", command: "cat /sys/kernel/debug/xcall/status\n$ echo 1 | sudo tee /sys/kernel/debug/xcall/enable\n$ cat /proc/xcall/stat",
        output: "xcall is disabled.\nSupported syscalls: gettimeofday, epoll_wait, read, write, recvfrom, sendto...\n1\nxcall_hits: 0\nxcall_misses: 0"
      },
      commentary: `<p class="dialogue"><span class="speaker">小宇：</span>"需要我改 Redis 的代码吗？用特殊 API？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"这就是最牛的地方：<b>对用户态应用完全透明！零修改代码！</b>只需要在内核里打个开关。"</p>
<p>老王检查了系统，确认内含 xcall 特性并带有 <code>xcall_tune</code> 插件，通过 debugfs 和 procfs 轻描淡写地激活了整个系统的极速调用引擎。</p>`
    },
    {
      title: "🚀 性能起飞：见证奇迹的时刻",
      terminal: {
        prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
        output: "PING_INLINE: 981240.11 requests per second, p50=0.380 msec\nGET: 978101.45 requests per second, p50=0.395 msec\n\n$ cat /proc/xcall/stat\nxcall_hits: 15480201\nxcall_misses: 231405\n\n$ vmstat 1 3\nprocs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n12  0      0  2105M  120M  4100M    0    0     0     0 95k  85k 50 45  5  0  0\n13  0      0  2105M  120M  4100M    0    0     0     0 97k  88k 48 47  5  0  0"
      },
      commentary: `<p class="thinking">小宇屏住呼吸，重置了压测环境，再次按下了回车键。</p>
<p class="insight">🔥 <b>性能提升的真相！</b><br>
QPS 从 81 万飙升到近 98 万，提升约 <strong>20%</strong>！<code>xcall_hits</code> 疯狂飙升，证明海量系统调用已成功走上快速通道。<br>
更关键的是 <code>vmstat</code>：<code>us</code> 从 35% 回升到 50%，<code>sy</code> 从 60% 降到 45%！用户态终于变成大头，CPU 终于花更多时间做正事。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"等等，内核态还有 45%？怎么没有彻底降下来？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"xcall 只优化了系统调用的<b>入口/出口框架</b>（保存寄存器、查表分发），而内核里真正干活的代码——网络 I/O、内存拷贝、Epoll 管理——是正当的内核工作，不能也不应该被消除。"</p>`
    },
    {
      title: "🛡️ 重新审视 perf 分布",
      terminal: {
        prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
        output: "Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000\nOverhead  Shared Object       Symbol\n   9.10%  [kernel]            [k] do_epoll_wait\n   7.20%  [kernel]            [k] copy_from_user\n   6.50%  [kernel]            [k] sys_read\n   2.10%  [kernel]            [k] el0_sync\n   1.50%  [kernel]            [k] do_el0_svc"
      },
      commentary: `<p class="conclusion">✨ <strong>小宇彻底懂了</strong><br>
曾经盘踞在 CPU 消耗榜头两名的 <code>el0_sync</code> + <code>do_el0_svc</code>（共 28%）降到了微不足道的 <strong>3.6%</strong>！这与 vmstat 中 sy 下降的幅度完美对应。<br>
xcall 的设计哲学：<b>不干涉内核的实际工作，只精准砍掉"进出城门"的无用开销</b>。不改一行用户代码，用操作系统底层架构创新带来的顶级性能红利。</p>`
    },
    {
      title: "🎓 进阶探讨：为什么不全用 xcall？",
      terminal: null,
      commentary: `<p class="thinking">既然 xcall 性能如此爆炸，为什么 Linux 社区不把所有的系统调用都改成这种极简模式？原因在于<strong>极简现场保存是有高昂代价的</strong>。</p>
<p><b>1. 丧失了进程调度能力</b><br>
传统的<span class="chat-link">抢占式</span>操作系统在系统调用返回前，会检查时间片是否用尽。调度意味着进程会被挂起，寄存器必须保存在 <code>pt_regs</code> 中。xcall 没有建立 <code>pt_regs</code>，<b>绝对不能被挂起</b>！只适用于绝不阻塞的高频调用。</p>
<p><b>2. 丧失了信号处理时机</b><br>
<code>Ctrl+C</code>（SIGINT）等信号通常在系统调用返回时派发给用户进程。xcall 为追求极致速度直接砍掉了信号检查逻辑。</p>
<p><b>3. 内核追踪（<span class="chat-link">Strace</span>）失效</b><br>
<code>strace</code> 利用 <code>ptrace</code> 机制在系统调用入口和出口打桩。xcall 的快速路径会绕过这些追踪探测点。追求极限性能和极致可观测性往往矛盾。</p>
<p class="conclusion">🎯 xcall 并不是要替代传统架构，而是作为极精细的<strong>旁路加速插件</strong>，专供少量极高频、极低耗时的"白名单"操作使用（网络 I/O、时间读取、Epoll 等）。</p>`
    },
    {
      title: "📊 战后总结",
      terminal: {
        prompt: "", command: "",
        output: "┌────────────────────┬────────────────────────────┬──────────────────────────────┐\n│ 维度               │ 传统 Syscall (el0_sync)    │ openEuler xcall              │\n├────────────────────┼────────────────────────────┼──────────────────────────────┤\n│ 现场保存           │ 完整保存 30+ 通用寄存器    │ 仅保存 3~4 个受损寄存器      │\n│ 调度与信号         │ 每次返回前检查信号与调度    │ 忽略非必须检查，极速退出内核  │\n│ 路径长度           │ 长（多层函数包装、查表分发） │ 极短（直通目标极速处理函数）  │\n│ 适用场景           │ 兼容所有系统调用            │ 高频短耗时调用白名单          │\n│ 代码侵入性         │ 无侵入                     │ 用户态零侵入，内核开关即可    │\n└────────────────────┴────────────────────────────┴──────────────────────────────┘"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>系统调用"底噪"</strong>：<code>el0_sync</code> + <code>do_el0_svc</code> 两个入口框架函数占了 28% CPU，它们只做保存/恢复寄存器与查表分发，不做任何实际工作<br>
2. <strong>xcall 利用 ABI 约定</strong>：信任 <span class="chat-link">AAPCS64</span> 规范，仅保存 3~4 个底层硬件寄存器，跳过 <code>pt_regs</code> 构建<br>
3. <strong>三大取舍</strong>：不能被调度（无 <code>pt_regs</code>）、不检查信号、不支持 <code>ptrace</code> 追踪——换来进出内核的极致速度<br>
4. <strong>实测效果</strong>：Redis QPS 提升 ~20%（81万 → 98万），<code>sy</code> 从 60% 降至 45%，入口框架开销从 28% 降至 3.6%<br>
5. <strong>零侵入设计</strong>：用户态应用完全无感知，仅需一行内核开关命令即可启用</p>
<p class="dialogue"><span class="speaker">老王：</span>"在通用操作系统中，'通用性'往往是'极限性能'的死敌。要在不打破 POSIX 语义的前提下榨干最后一点算力，这正是顶级内核工程师的乐趣所在。"</p>`
    }
  ]
};
