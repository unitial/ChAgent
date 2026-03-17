/**
 * player-data.js — vDSO 案例数据
 * 由 interactive-player SKILL 按照 vdso.md 生成
 */
const PLAYER_CONFIG = {
  title: "每秒百万次取时间 — vDSO：内核藏在用户空间的快车道",
  subtitle: "量化交易系统性能排障全真模拟推演。<br>从 perf 热点追踪到 vDSO 原理，揭秘内核如何在用户态完成系统调用。",
  splashImage: "trading_desk.png",

  steps: [
    {
      title: "📅 场景：量化交易系统的 CPU 异常",
      terminal: {
        prompt: "$ ", command: "perf top -p $(pgrep market_recv)",
        output: "  15.32%  [kernel]           [k] __arm64_sys_clock_gettime\\n   9.87%  [kernel]           [k] ktime_get_ts64\\n   8.21%  [kernel]           [k] el0_svc_common\\n   6.54%  market_recv        [.] process_market_data\\n   ..."
      },
      commentary: `<img src="trading_desk.png" class="hardware-photo" alt="量化交易工作台">
<p>一家量化交易公司的行情数据处理系统出了性能问题。系统运行在 <strong>ARM64 服务器</strong>（华为鲲鹏 920）上。</p>
<p>系统每秒接收约 200 万条行情数据，每条数据需要打上纳秒级时间戳——就一行代码：<code>clock_gettime(CLOCK_MONOTONIC, &ts)</code></p>
<p class="warning">🔥 <strong>CPU 利用率异常偏高（70%）</strong>，但系统明明只在做"收数据、打戳、转发"这种轻量操作。<br>
<code>perf top</code> 显示：内核态的 <code>clock_gettime</code> 相关函数占了总 CPU 的 33%！</p>
<p class="thinking">每次调用 <code>clock_gettime()</code> 都要从 <span class="chat-link">EL0</span>（用户态）陷入 <span class="chat-link">EL1</span>（内核态），每秒 200 万次，来回的开销非常可观。</p>`
    },
    {
      title: "🔦 勘查现场：系统调用到底有多贵？",
      terminal: {
        prompt: "$ ", command: "gcc -O2 -o bench_gettime bench_gettime.c\\n$ ./bench_gettime",
        output: "clock_gettime() x 100000000: 2.340 秒 (23.4 ns/call)"
      },
      commentary: `<p>写了一个基准测试来量化开销：对 <code>clock_gettime(CLOCK_MONOTONIC)</code> 循环调用 1 亿次。</p>
<p class="thinking">23.4 纳秒一次？如果每次真的要陷入内核，ARM64 的 <code>svc #0</code> 系统调用开销至少 150~300ns。怎么会只有 23.4ns？</p>
<p class="insight">💡 这个数字本身就在暗示——<strong>这些调用根本没有真正走进内核</strong>。</p>`
    },
    {
      title: "🔍 strace 揭秘：1 亿次调用消失了！",
      terminal: {
        prompt: "$ ", command: "strace -c ./bench_gettime",
        output: "clock_gettime() x 100000000: 2.381 秒 (23.8 ns/call)\\n% time     seconds  usecs/call     calls    errors syscall\\n------ ----------- ----------- --------- --------- --------\\n  0.00    0.000000           0         3           read\\n  0.00    0.000000           0         5           mmap\\n  0.00    0.000000           0         3           mprotect\\n  0.00    0.000000           0         1           write\\n------ ----------- ----------- --------- --------- --------\\n100.00    0.000000                    23           total"
      },
      commentary: `<p class="warning">🔥 <strong>1 亿次 <code>clock_gettime()</code>，<code>strace</code> 却一次都没有抓到！</strong></p>
<p>总共才 23 次系统调用，全是程序启动时的 <code>mmap</code>、<code>mprotect</code> 等初始化操作。</p>
<p class="conclusion">🎯 这意味着 <code>clock_gettime()</code> 根本没有进入内核——它在<strong>用户态就完成了</strong>。<br>
<code>strace</code> 通过 <span class="chat-link">ptrace</span> 拦截 <code>svc #0</code> 指令——如果函数不使用 <code>svc</code>，strace 就看不到。</p>`
    },
    {
      title: "💥 真相：vDSO — 内核在进程里埋的快车道",
      terminal: {
        prompt: "$ ", command: "cat /proc/self/maps | grep vdso\\n$ objdump -T vdso.so",
        output: "ffff9a7fc000-ffff9a7fe000 r-xp 00000000 00:00 0    [vdso]\\n\\nDYNAMIC SYMBOL TABLE:\\n0000000000000600 g  DF .text  __kernel_clock_gettime\\n0000000000000690 g  DF .text  __kernel_gettimeofday\\n0000000000000700 g  DF .text  __kernel_clock_getres\\n0000000000000530 g  DF .text  __kernel_rt_sigreturn"
      },
      commentary: `<p>答案就是 <strong><span class="chat-link">vDSO</span>（virtual Dynamic Shared Object，虚拟动态共享对象）</strong>。</p>
<p>Linux 内核在<strong>每个进程启动时</strong>，都会自动将一小段特殊的共享库映射到进程的虚拟地址空间中。这段代码包含 <code>clock_gettime()</code>、<code>gettimeofday()</code> 等高频函数的<strong>用户态实现</strong>。当你调用这些函数时，C 库（glibc/musl）会<strong>优先调用 vDSO 中的版本</strong>。</p>
<p class="insight">💡 <code>[vdso]</code> — 它没有对应任何磁盘文件（设备号 <code>00:00</code>，inode <code>0</code>），完全由内核在内存中动态生成。权限是 <code>r-xp</code>（只读 + 可执行）。<br>
一个 <strong>8KB 的 ELF 共享库</strong>，里面有 4 个内核提供的"用户态版本"函数。</p>`
    },
    {
      title: "🔬 vDSO 工作原理：vvar + 硬件计时器",
      terminal: {
        prompt: "$ ", command: "cat /proc/self/maps | grep -E 'vdso|vvar'",
        output: "ffff9a7fa000-ffff9a7fc000 r--p 00000000 00:00 0    [vvar]\\nffff9a7fc000-ffff9a7fe000 r-xp 00000000 00:00 0    [vdso]"
      },
      commentary: `<p>核心秘密是一个叫 <strong><span class="chat-link">vvar</span></strong> 的特殊内存页。</p>
<p><code>[vvar]</code>（variable data）是内核映射到用户空间的<strong>只读数据页</strong>。内核的定时器中断处理程序会<strong>定期更新</strong> vvar 页中的时间戳数据。vDSO 代码直接从 vvar 页读取，完全不需要进入内核。</p>
<p>在 ARM64 上，vDSO 使用 <strong><code><span class="chat-link">CNTVCT_EL0</span></code></strong>（Counter-timer Virtual Count register）来读取硬件时钟。这是 ARM 架构中<strong>用户态可读</strong>的系统寄存器，通过 <code>mrs x0, cntvct_el0</code> 指令访问，无需特权级切换。</p>
<p class="insight">💡 <strong>vvar 页是从内核映射到用户空间的"信息公告板"。内核负责更新，用户态只需看一眼。</strong>写者（内核）和读者（用户进程）通过 <strong>SeqLock 无锁同步</strong>协调。</p>`
    },
    {
      title: "⚙️ 对比：有 vDSO vs 没有 vDSO",
      terminal: {
        prompt: "$ ", command: "gcc -O2 -o bench_vdso bench_vdso.c\\n$ ./bench_vdso",
        output: "vDSO   clock_gettime: 2.340 秒 (23.4 ns/call)\\nsyscall clock_gettime: 22.630 秒 (226.3 ns/call)\\n\\n差距来自：vDSO 不需要 EL0→EL1 的特权级切换"
      },
      commentary: `<p class="conclusion">🎯 <strong>接近 10 倍的性能差距。</strong></p>
<p>ARM64 平台上虽然没有 x86 那样的 <span class="chat-link">KPTI</span>（因为 ARM 有独立的 <span class="chat-link">TTBR0/TTBR1</span> 页表寄存器，天然隔离用户/内核地址空间），但系统调用的 EL0→EL1 切换开销仍然很显著。</p>
<p class="insight">💡 在 x86 上，由于 Spectre/Meltdown KPTI 补丁后 syscall 延迟可达 ~350ns，而 vDSO 仅 ~19ns，加速比可达 <strong>~18 倍</strong>！</p>`
    },
    {
      title: "🔍 回到行情系统：时钟源降级！",
      terminal: {
        prompt: "$ ", command: "cat /sys/devices/system/clocksource/clocksource0/current_clocksource\\n$ dmesg | grep -i clocksource",
        output: "jiffies\\n\\n[  142.873] clocksource: timekeeping watchdog on CPU0: Marking clocksource\\n            'arch_sys_counter' as unstable because the skew is too large.\\n[  142.874] clocksource: Switched to clocksource jiffies"
      },
      commentary: `<p>回到最初的行情系统，代码没改过。但细查之下发现这台服务器最近经历了一次<strong>虚拟机热迁移</strong>，导致硬件时钟频率出现微小偏差。</p>
<p class="warning">🔥 <strong>时钟源成了 <code>jiffies</code>！不是 <code>arch_sys_counter</code>！</strong></p>
<p>Linux 内核的 <strong>时钟源看门狗（clocksource watchdog）</strong> 检测到 <code>arch_sys_counter</code> 出现异常漂移后，将时钟源降级。</p>
<p class="insight">💡 当时钟源降级为 <code>jiffies</code> 后，内核会将 vvar 页中的 <code>clock_mode</code> 设为 <code>VDSO_CLOCKMODE_NONE</code>。<br>
vDSO 代码检测到这个标志后，<strong>主动放弃用户态快速路径</strong>，退化为 <code>svc #0</code> 真正的系统调用——这正是 <code>perf top</code> 中出现大量 <code>__arm64_sys_clock_gettime</code> 的原因。</p>`
    },
    {
      title: "🛠️ 修复：恢复硬件时钟源",
      terminal: {
        prompt: "$ ", command: "echo arch_sys_counter | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource\\n$ ./bench_gettime",
        output: "arch_sys_counter\\nclock_gettime() x 100000000: 2.340 秒 (23.4 ns/call)  ✅ 恢复正常！"
      },
      commentary: `<p>修复后，行情系统的 CPU 利用率从 <strong>70% 降到了 35%</strong>，<code>perf top</code> 中内核态的 <code>clock_gettime</code> 完全消失。</p>
<p class="conclusion">🎯 <strong>战果：</strong><br>
修复前：<code>clock_gettime</code> ~226 ns/call，CPU ~70%，内核态 ~33%<br>
修复后：<code>clock_gettime</code> ~23 ns/call，CPU ~35%，内核态 ~5%<br>
<strong>性能提升 ~10x（时间获取部分），整体 CPU 节省 ~50%</strong></p>
<p class="thinking">同样的程序、同样的编译参数，仅仅因为时钟源不同，就产生了 10 倍性能差距。</p>`
    },
    {
      title: "💡 核心回顾",
      terminal: {
        prompt: "", command: "",
        output: "核心知识点：\\n  1. 不是所有\"系统调用\"都需要进入内核\\n     vDSO 将高频操作的用户态实现映射到进程地址空间\\n  2. vDSO 不是无条件加速\\n     依赖硬件时钟源，降级后退化为真正的 syscall\\n  3. CNTVCT_EL0 — 硬件与 OS 的协作\\n     ARM Generic Timer 提供用户态可读的硬件计时器\\n  4. vDSO 是虚拟内存的精妙应用\\n     内核映射代码页+数据页到每个进程，零拷贝\\n  5. 跨架构统一框架\\n     ARM64: mrs cntvct_el0 / x86: rdtsc / RISC-V: rdtime\\n     vvar + 用户态代码 + SeqLock 框架是跨架构统一的"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong></p>
<p><strong>1. 不是所有"系统调用"都需要进入内核</strong><br>
<span class="chat-link">vDSO</span> 将少量高频操作的实现直接映射到用户空间。应用程序调用 <code>clock_gettime()</code> 时实际执行的是用户态代码——一段由内核编写、但运行在 EL0 的函数。这模糊了"系统调用"和"库函数"的界限。</p>
<p><strong>2. vDSO 不是无条件加速</strong><br>
vDSO 能在用户态高效取时间，<strong>强依赖于底层硬件时钟源支持用户态读取</strong>。当内核检测到硬件时钟不可靠，会通过 <code>VDSO_CLOCKMODE_NONE</code> 主动退化为真正的系统调用。<strong>排查时钟源状态</strong>是高频交易和低延迟系统的必修课。</p>
<p><strong>3. <span class="chat-link">CNTVCT_EL0</span> — 硬件与 OS 的协作</strong><br>
ARM 的 Generic Timer 提供了用户态可读的硬件计时器。x86 上类似机制是 <span class="chat-link">RDTSC</span>（Read Time-Stamp Counter）指令。</p>
<p><strong>4. vDSO 是虚拟内存的精妙应用</strong><br>
本质上是一个 <code>mmap</code>——内核映射代码页和数据页到每个进程的地址空间。内核通过直接写物理页来更新时间数据，所有进程立刻可见。</p>
<p><strong>5. vDSO 的跨架构统一框架</strong><br>
ARM64、RISC-V、MIPS、PowerPC 等架构都有各自的 vDSO 实现。用户态时钟读取指令不同（ARM: <code>mrs cntvct_el0</code>，x86: <code>rdtsc</code>，RISC-V: <code>rdtime</code>），但 vvar 数据页 + 用户态代码页 + SeqLock 同步的框架设计是跨架构统一的。</p>`
    }
  ]
};
