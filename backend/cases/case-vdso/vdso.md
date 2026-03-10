# Case: 每秒百万次取时间，系统调用扛不住了 —— vDSO：内核藏在用户空间的快车道

**难度：L5 | 耗时：1.5h | 知识点：系统调用开销 / vDSO / 虚拟内存映射 / ELF 动态链接 | 来源：Linux vDSO 机制 (kernel.org)**

> 调用 `clock_gettime()` 获取当前时间，一定要陷入内核吗？Linux 说：不需要。它把一小段内核代码偷偷映射到了你的进程里，让你以为自己在做系统调用，其实从头到尾都没离开用户态。这个机制叫 vDSO。

---

#### 📅 2026 年某天，一家量化交易公司的技术部

我们的行情数据处理系统出了性能问题。系统运行在 **ARM64 服务器**（华为鲲鹏 920）上。

系统的工作很简单：从交易所接收行情数据（每秒约 200 万条），给每条数据打上纳秒级接收时间戳，然后转发给策略引擎。打时间戳的代码就一行：

```c
// timestamp.c — 行情数据打戳核心循环
void process_market_data(struct market_data* md) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);   // 获取纳秒级时间戳
    md->recv_ts = ts.tv_sec * 1000000000LL + ts.tv_nsec;
    // ... 后续处理 ...
}
```

逻辑上没有任何问题。但监控显示，**CPU 利用率异常偏高**——系统明明只在做"收数据、打戳、转发"这种轻量操作，但一个核心的 CPU 利用率已经达到 70%。

我先用 `perf top` 看了一眼热点：

```bash
$ perf top -p $(pgrep market_recv)
  15.32%  [kernel]           [k] __arm64_sys_clock_gettime
   9.87%  [kernel]           [k] ktime_get_ts64
   8.21%  [kernel]           [k] el0_svc_common
   6.54%  market_recv        [.] process_market_data
   ...
```

**内核态的 `clock_gettime` 相关函数占了总 CPU 的 33%！** 每次调用 `clock_gettime()` 都要从用户态（EL0）陷入内核态（EL1），通过 `el0_svc_common`（ARM64 的系统调用入口）进入内核里读取时钟源（`ktime_get_ts64`），然后返回用户态。每秒 200 万次，这个来回的开销加起来非常可观。

> 📌 **备注（x86）**：在 x86 平台上，对应的内核函数是 `__x64_sys_clock_gettime`，系统调用入口是 `entry_SYSCALL_64`。

#### 🔦 勘查现场：系统调用到底有多贵？

我写了一个简单的基准测试来量化开销：

```c
// bench_gettime.c — 测量 clock_gettime 的调用延迟
#include <stdio.h>
#include <time.h>

int main() {
    struct timespec ts;
    int N = 100000000;  // 1 亿次

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    for (int i = 0; i < N; i++) {
        clock_gettime(CLOCK_MONOTONIC, &ts);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec)
                   + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("clock_gettime() x %d: %.3f 秒 (%.1f ns/call)\n",
           N, elapsed, elapsed / N * 1e9);
    return 0;
}
```

```bash
$ gcc -O2 -o bench_gettime bench_gettime.c
$ ./bench_gettime
clock_gettime() x 100000000: 2.340 秒 (23.4 ns/call)
```

23.4 纳秒一次？如果每次调用真的要陷入内核，ARM64 的 `svc #0` 系统调用开销至少 150-300ns。怎么会只有 23.4ns？

带着疑问，我用 `strace -c` 看了一下系统调用统计：

```bash
$ strace -c ./bench_gettime
clock_gettime() x 100000000: 2.381 秒 (23.8 ns/call)
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- --------
  0.00    0.000000           0         3           read
  0.00    0.000000           0         5           mmap
  0.00    0.000000           0         3           mprotect
  0.00    0.000000           0         1           write
------ ----------- ----------- --------- --------- --------
100.00    0.000000                    23           total
```

**1 亿次 `clock_gettime()`，`strace` 却一次都没有抓到！** 总共才 23 次系统调用，全是程序启动时的 `mmap`、`mprotect` 等。

这意味着 `clock_gettime()` 根本没有进入内核——它在用户态就完成了。

---

#### 💥 真相：vDSO —— 内核在你进程里埋的「快车道」

答案就是 **vDSO（virtual Dynamic Shared Object，虚拟动态共享对象）**。

Linux 内核在**每个进程启动时**，都会自动将一小段特殊的共享库映射到进程的虚拟地址空间中。这段代码包含 `clock_gettime()`、`gettimeofday()`、`clock_getres()` 等高频函数的**用户态实现**。当你调用这些函数时，C 库（glibc/musl）会**优先调用 vDSO 中的版本**，而不是发起系统调用。

我们可以直接看到这个映射：

```bash
$ cat /proc/self/maps | grep vdso
ffff9a7fc000-ffff9a7fe000 r-xp 00000000 00:00 0    [vdso]
```

**`[vdso]`** ——它没有对应任何磁盘文件（设备号 `00:00`，inode `0`），它完全由内核在内存中动态生成，然后映射到进程的地址空间中。权限是 `r-xp`（只读+可执行），大小通常只有 1~2 个页面（4KB~8KB）。

我们甚至可以把 vDSO 导出来，看看它到底是什么：

```bash
# 导出 vDSO 为文件
$ python3 -c "
import re
with open('/proc/self/maps') as f:
    for line in f:
        if '[vdso]' in line:
            start, end = [int(x, 16) for x in line.split()[0].split('-')]
            with open('/proc/self/mem', 'rb') as mem:
                mem.seek(start)
                with open('vdso.so', 'wb') as out:
                    out.write(mem.read(end - start))
            print(f'Exported {end - start} bytes')
            break
"
Exported 8192 bytes

# 它是一个合法的 ELF 共享库！
$ file vdso.so
vdso.so: ELF 64-bit LSB shared object, ARM aarch64, version 1 (LINUX)

# 看看它导出了哪些函数
$ objdump -T vdso.so
DYNAMIC SYMBOL TABLE:
0000000000000600 g    DF .text  0000000000000084 LINUX_2.6.39  __kernel_clock_gettime
0000000000000690 g    DF .text  0000000000000054 LINUX_2.6.39  __kernel_gettimeofday
0000000000000700 g    DF .text  0000000000000060 LINUX_2.6.39  __kernel_clock_getres
0000000000000530 g    DF .text  0000000000000004 LINUX_2.6.39  __kernel_rt_sigreturn
```

**一个 8KB 的 ELF 共享库**，里面有 `__kernel_clock_gettime`、`__kernel_gettimeofday`、`__kernel_clock_getres`、`__kernel_rt_sigreturn` 四个函数。它们就是内核提供的「用户态版本」。

> 📌 **备注（x86）**：x86_64 平台上 vDSO 导出的符号名称不同：`__vdso_clock_gettime`、`__vdso_gettimeofday`、`__vdso_time`、`__vdso_getcpu`。命名风格 `__kernel_` vs `__vdso_` 是 ARM 和 x86 的历史差异。

---

#### 🔬 vDSO 是怎么做到不进内核就读到时间的？

核心秘密是一个叫 **vvar** 的特殊内存页：

```bash
$ cat /proc/self/maps | grep -E 'vdso|vvar'
ffff9a7fa000-ffff9a7fc000 r--p 00000000 00:00 0    [vvar]
ffff9a7fc000-ffff9a7fe000 r-xp 00000000 00:00 0    [vdso]
```

**`[vvar]`**（variable data）是内核映射到用户空间的**只读数据页**。内核的定时器中断处理程序会**定期更新** vvar 页中的时间戳数据。vDSO 中的 `__kernel_clock_gettime()` 代码直接从 vvar 页读取这些数据，完全不需要进入内核。

```
数据传递路径（ARM64）：
┌─────────────────────────────────────────────────────────────┐
│                        内核空间 (EL1)                         │
│                                                               │
│   定时器中断 (arch_timer) ──→ 更新全局时间变量 ──→ 写入 vvar 页  │
│                                                  │            │
│ ─────────────────────────────────────────────────┼─────────── │
│                                                  │            │
│                        用户空间 (EL0)            ↓ (只读映射)  │
│                                                               │
│   进程调用 clock_gettime()                                     │
│       → glibc 检测到 vDSO 可用                                 │
│       → 调用 vDSO 中的 __kernel_clock_gettime()                │
│       → MRS 指令读取 CNTVCT_EL0（硬件计时器）                    │
│       → 结合 vvar 中的校准参数换算为 timespec                    │
│       → 返回！全程在 EL0，没有陷入 EL1                          │
└─────────────────────────────────────────────────────────────┘
```

关键洞察：**vvar 页是从内核映射到用户空间的「信息公告板」。内核负责更新，用户态只需看一眼。**

在 ARM64 上，vDSO 使用 **`CNTVCT_EL0`**（Counter-timer Virtual Count register）来读取硬件时钟。这是 ARM 架构中**用户态可读**的系统寄存器，通过 `mrs x0, cntvct_el0` 指令访问，无需特权级切换。

> 📌 **备注（x86）**：x86 平台上对应的是 **RDTSC（Read Time-Stamp Counter）** 指令，同样是用户态可执行的指令，读取 CPU 的 TSC 寄存器。原理相同，但硬件接口不同。

---

#### ⚙️ 对比：有 vDSO vs 没有 vDSO

如果强制绕过 vDSO，直接用 `svc #0` 系统调用指令调用内核的 `clock_gettime`，性能差距就显现出来了：

```c
// bench_syscall_direct.c — 强制使用系统调用
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>

int main() {
    struct timespec ts;
    int N = 100000000;

    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    for (int i = 0; i < N; i++) {
        // 绕过 vDSO，直接发起系统调用
        syscall(SYS_clock_gettime, CLOCK_MONOTONIC, &ts);
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec)
                   + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("syscall(SYS_clock_gettime) x %d: %.3f 秒 (%.1f ns/call)\n",
           N, elapsed, elapsed / N * 1e9);
    return 0;
}
```

```bash
$ gcc -O2 -o bench_syscall_direct bench_syscall_direct.c
$ ./bench_syscall_direct
syscall(SYS_clock_gettime) x 100000000: 22.630 秒 (226.3 ns/call)

$ ./bench_gettime
clock_gettime() x 100000000: 2.340 秒 (23.4 ns/call)
```

```
性能对比（ARM64 鲲鹏 920）:
┌───────────────────────────────────────────────────────┐
│        clock_gettime() 调用方式          延迟    加速比  │
├───────────────────────────────────────────────────────┤
│  经由 vDSO（默认，用户态完成）        ~23 ns    10x   │
│  直接 syscall（强制陷入 EL1）         ~226 ns   1x    │
├───────────────────────────────────────────────────────┤
│  备注 — x86_64 平台：                                  │
│  vDSO 版本                            ~19 ns          │
│  直接 syscall                         ~187 ns         │
│  Spectre/Meltdown KPTI 补丁后 syscall ~350 ns         │
│  → x86 上 vDSO 加速比可达              ~18x !!         │
└───────────────────────────────────────────────────────┘
```

**接近 10 倍的性能差距**。ARM64 平台上虽然没有 x86 那样的 KPTI（因为 ARM 有独立的 TTBR0/TTBR1 页表寄存器，天然隔离用户/内核地址空间），但系统调用的 EL0→EL1 切换开销仍然很显著。

---

#### 🔍 回到行情系统的问题

那我们最初的行情系统为什么 `clock_gettime` 看起来很慢呢？

代码没改过，运维也说没做过什么变更。但细查之下发现，这台服务器最近经历了一次**虚拟机热迁移**（从一台物理鲲鹏迁到了另一台）。迁移之后的宿主机硬件时钟存在微小的频率偏差。

Linux 内核有一个 **时钟源看门狗（clocksource watchdog）**，它会持续监控硬件时钟是否可靠。当它检测到 `arch_sys_counter`（ARM Generic Timer）的读数出现异常漂移时，会将时钟源降级为更保守但不支持 vDSO 快速路径的备选时钟源：

```bash
# 检查当前时钟源
$ cat /sys/devices/system/clocksource/clocksource0/current_clocksource
jiffies     # 🚨 不是 arch_sys_counter！

# 查看内核日志，找到降级原因
$ dmesg | grep -i clocksource
[  142.873] clocksource: timekeeping watchdog on CPU0: Marking clocksource
            'arch_sys_counter' as unstable because the skew is too large.
[  142.874] clocksource: Switched to clocksource jiffies
```

**时钟源成了 `jiffies`！** 这是一个基于定时器中断 tick 的低精度时钟源，无法在用户态高效读取。

vDSO 的 `__kernel_clock_gettime()` 代码中有一个关键检查：

```c
// vDSO 内部的降级逻辑
if (vd->clock_mode == VDSO_CLOCKMODE_NONE) {
    // 当前时钟源不支持用户态快速路径，退化为真正的系统调用
    return clock_gettime_fallback(clk, ts);  // → svc #0 陷入内核
}
```

当内核将时钟源从 `arch_sys_counter` 降级为 `jiffies` 时，它会将 vvar 页中的 `clock_mode` 设为 `VDSO_CLOCKMODE_NONE`。vDSO 代码检测到这个标志后，就会**主动放弃用户态快速路径**，退化为通过 `svc #0` 陷入内核获取时间——这正是 `perf top` 中出现大量 `__arm64_sys_clock_gettime` 的原因。

```bash
$ strace -c ./bench_gettime
clock_gettime() x 100000000: 23.105 秒 (231.1 ns/call)
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- --------
100.00   22.731052           0 100000000           clock_gettime  🚨
------ ----------- ----------- --------- --------- --------
```

**1 亿次真正的系统调用！** 因为 vDSO 的快速路径被 `VDSO_CLOCKMODE_NONE` 关闭了。

修复方法——**恢复可靠的硬件时钟源**：

```bash
# 方法 1：如果硬件时钟已恢复稳定，手动切回 arch_sys_counter
$ echo arch_sys_counter | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource

# 方法 2：根本修复——解决宿主机时钟同步问题后重新迁移
```

> 📌 **备注（x86）**：x86 上对应的场景是 TSC（Time Stamp Counter）被降级为 HPET（High Precision Event Timer）。TSC 不稳定的原因通常是：虚拟机热迁移、TSC 频率不同步的多路服务器、或内核发现 TSC 被标记为 `unstable`。

修复后，行情系统的 CPU 利用率从 70% 降到了 35%，`perf top` 中内核态的 `clock_gettime` 完全消失。

---

#### 🧬 深入 vDSO 的实现（ARM64）

vDSO 的 `__kernel_clock_gettime` 伪代码大致如下：

```c
// vDSO 中的 clock_gettime() 简化版（ARM64）
// 这段代码由内核编译，但在用户态 (EL0) 执行

struct vdso_data {
    u64  seq;               // 序列号（用于无锁同步）
    u64  wall_time_sec;
    u64  wall_time_nsec;
    u64  monotonic_sec;
    u64  monotonic_nsec;
    u64  mult;              // 时钟频率乘数
    u32  shift;             // 时钟频率移位
    u64  cycle_last;        // 上次更新时的计时器值
    // ...
};

// vvar 页中的数据，由内核定期更新
extern struct vdso_data *__vdso_data;   // 映射到 [vvar]

int __kernel_clock_gettime(clockid_t clk, struct timespec *ts) {
    struct vdso_data *vd = __vdso_data;
    u64 seq, ns;

    // ⚠️ 关键：检查时钟模式，不支持快速路径则降级为真正的系统调用
    if (vd->clock_mode == VDSO_CLOCKMODE_NONE)
        return clock_gettime_fallback(clk, ts);  // → svc #0 陷入内核

    do {
        seq = READ_ONCE(vd->seq);   // 读取序列号
        if (seq & 1) continue;      // 🚨 核心：奇数说明内核正在写入，必须自旋重试！
        dmb(ishld);                 // ARM 内存屏障（数据内存屏障）

        // 读取 CNTVCT_EL0 —— ARM64 用户态可读的硬件计时器！
        u64 cycles;
        asm volatile("mrs %0, cntvct_el0" : "=r"(cycles));

        cycles -= vd->cycle_last;
        ns = vd->monotonic_nsec + ((cycles * vd->mult) >> vd->shift);
        ts->tv_sec  = vd->monotonic_sec + ns / 1000000000;
        ts->tv_nsec = ns % 1000000000;

        dmb(ishld);                 // ARM 内存屏障
    } while (seq != READ_ONCE(vd->seq));  // 如果期间内核更新了数据，重试

    return 0;
}
```

几个关键点：
1. **`VDSO_CLOCKMODE_NONE` 降级检查**：vDSO 代码在执行快速路径之前会检查当前时钟源是否支持用户态读取。如果不支持（如时钟源被降级为 `jiffies`），则直接 fallback 为真正的系统调用。这就是时钟源降级导致 CPU 飙升的根本原因
2. **CNTVCT_EL0 寄存器**：ARM 架构的 Generic Timer 提供的虚拟计数器，可在 EL0（用户态）直接通过 `mrs` 指令读取，不需要特权级切换。频率通常为固定值（如鲲鹏 920 为 25MHz），由 `CNTFRQ_EL0` 寄存器给出
3. **SeqLock 无锁同步**：内核更新 vvar 数据时递增 `seq`（写入前+1 变奇数，写入后+1 变偶数）。读者先检查 `seq` 是否为偶数（奇数说明内核正在写入，必须自旋等待），读取后再检查 `seq` 是否变化。如果发生变化，说明读取期间内核更新了数据，必须重试。这是经典的**读者-写者无锁同步**
4. **运算符优先级**：注意 `((cycles * vd->mult) >> vd->shift)` 中的括号——C 语言中 `+` 的优先级**高于** `>>`，如果不加括号会导致 `monotonic_nsec` 被一起右移，算出完全错误的时间值
5. **`dmb ishld` 内存屏障**：ARM 是弱内存序架构，需要显式的内存屏障来保证读取顺序的正确性。这是 ARM 与 x86（强内存序）的一个重要区别

> 📌 **备注（x86）**：x86 上对应的是 `rdtsc`（Read Time-Stamp Counter）指令，同样是用户态指令。x86 使用 `smp_rmb()` 内存屏障（在 x86 上通常编译为 no-op，因为 x86 的 load→load 本身是有序的）。

---

#### 📊 战果

```
修复前（时钟源降级为 jiffies，vDSO fallback 为真正的系统调用）：
  clock_gettime 延迟:  ~226 ns/call
  CPU 利用率:         ~70%
  内核态时间占比:      ~33%

修复后（时钟源恢复为 arch_sys_counter，走 vDSO 快速路径）：
  clock_gettime 延迟:  ~23 ns/call
  CPU 利用率:         ~35%
  内核态时间占比:      ~5%

性能提升:  ~10x（时间获取部分）, 整体 CPU 节省 ~50%
```

---

#### 💡 战后总结

1. **不是所有「系统调用」都需要进入内核**：vDSO 将少量高频操作（获取时间、获取时钟分辨率）的实现直接映射到用户空间。应用程序调用 `clock_gettime()` 时实际执行的是用户态代码——一段由内核编写、但运行在 EL0 的函数。这模糊了「系统调用」和「库函数」的传统界限

2. **vDSO 不是无条件加速**：vDSO 能在用户态高效取时间，**强依赖于底层硬件时钟源支持用户态读取**（ARM: `CNTVCT_EL0`，x86: `rdtsc`）。当内核检测到硬件时钟不可靠（如 VM 热迁移导致时钟漂移），会将时钟源降级为不支持用户态读取的备选（如 `jiffies`），此时 vDSO 会通过 `VDSO_CLOCKMODE_NONE` 主动退化为真正的系统调用。**排查时钟源状态**是高频交易和低延迟系统的必修课

3. **CNTVCT_EL0 —— 硬件与 OS 的协作**：vDSO 能在用户态获取时间，靠的是 ARM 架构的 Generic Timer 提供了一个用户态可读的硬件计时器（`CNTVCT_EL0`）。这是硬件（提供计时器）和操作系统（提供频率校准参数）协作的典范。x86 上类似的机制是 RDTSC 指令

4. **vDSO 是虚拟内存的精妙应用**：vDSO 本质上是一个 `mmap`——内核在进程创建时将一小段代码页和数据页映射到每个进程的地址空间。代码页（vDSO）只读+可执行，数据页（vvar）只读。内核通过直接写物理页来更新时间数据，所有进程立刻可见。这与 `mmap(MAP_SHARED)` 的原理一脉相承

5. **vDSO 的跨架构支持**：vDSO 并非 x86 独有——ARM64、RISC-V、MIPS、PowerPC 等架构都有各自的 vDSO 实现。各架构的用户态时钟读取指令不同（ARM: `mrs cntvct_el0`，x86: `rdtsc`，RISC-V: `rdtime`），但 vDSO 的框架设计（vvar 数据页 + 用户态代码页 + SeqLock 同步）是跨架构统一的

---

## 🧪 动手实践

### 实验环境

- Linux（推荐 Ubuntu 22.04，ARM64 或 x86_64 均可）
  - ARM64：树莓派 4/5、华为鲲鹏、AWS Graviton、Apple M 系列 + Asahi Linux
  - x86_64：普通 PC + WSL2 即可
- GCC：`sudo apt install gcc`
- strace：`sudo apt install strace`
- binutils（objdump）：`sudo apt install binutils`

### 实验步骤

#### 步骤 1：观察你进程中的 vDSO

```bash
# 查看当前 shell 进程的内存映射中的 vDSO
cat /proc/self/maps | grep -E 'vdso|vvar'
```

> 📌 你应该看到两行：`[vvar]`（只读数据页）和 `[vdso]`（可执行代码页）。注意它们的地址——每次运行都不同（ASLR 随机化）。

#### 步骤 2：导出并分析 vDSO

```bash
# 从进程内存导出 vDSO
python3 -c "
import re
with open('/proc/self/maps') as f:
    for line in f:
        if '[vdso]' in line:
            start, end = [int(x, 16) for x in line.split()[0].split('-')]
            with open('/proc/self/mem', 'rb') as mem:
                mem.seek(start)
                with open('vdso.so', 'wb') as out:
                    out.write(mem.read(end - start))
            print(f'导出 vDSO: {end - start} 字节')
            break
"

# 确认它是一个合法的 ELF 文件
file vdso.so
# ARM64: ELF 64-bit LSB shared object, ARM aarch64
# x86:   ELF 64-bit LSB shared object, x86-64

# 查看导出的符号（vDSO 提供的函数）
objdump -T vdso.so

# 反汇编查看 clock_gettime 的实现
objdump -d vdso.so | head -80
```

> 📌 关键观察：ARM64 的反汇编中你能看到 `mrs x?, cntvct_el0` 指令——这就是 vDSO 在用户态读取硬件时钟的方式。x86 上则是 `rdtsc` 或 `rdtscp` 指令。

#### 步骤 3：对比 vDSO 和真正的系统调用

创建文件 `bench_vdso.c`：

```c
#include <stdio.h>
#include <time.h>
#include <sys/syscall.h>
#include <unistd.h>

#define N 100000000

void bench_vdso() {
    struct timespec ts, start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        clock_gettime(CLOCK_MONOTONIC, &ts);  // 走 vDSO
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec)
                   + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("vDSO   clock_gettime: %.3f 秒 (%.1f ns/call)\n",
           elapsed, elapsed / N * 1e9);
}

void bench_syscall() {
    struct timespec ts, start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (int i = 0; i < N; i++) {
        syscall(SYS_clock_gettime, CLOCK_MONOTONIC, &ts);  // 真正的系统调用
    }
    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec)
                   + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("syscall clock_gettime: %.3f 秒 (%.1f ns/call)\n",
           elapsed, elapsed / N * 1e9);
}

int main() {
    bench_vdso();
    bench_syscall();
    printf("\n差距来自：vDSO 不需要 EL0→EL1 的特权级切换\n");
    return 0;
}
```

```bash
gcc -O2 -o bench_vdso bench_vdso.c
./bench_vdso
```

> 📌 你应该看到 vDSO 版本比 syscall 版本快 **8-10 倍**（ARM64）或 **10-18 倍**（x86_64，取决于是否有 KPTI 补丁）。

#### 步骤 4：用 strace 验证 vDSO 拦截了系统调用

```bash
# strace 跟踪时，vDSO 的调用不会出现
strace -c -e trace=clock_gettime ./bench_vdso 2>&1 | tail -10
```

> 📌 关键观察：`clock_gettime` 的 calls 列只显示 `bench_syscall` 部分的调用。strace 通过 ptrace 拦截 `svc #0`（ARM64）/ `syscall`（x86）指令——vDSO 不使用这些指令，所以 strace 看不到。

#### 步骤 5：观察 vDSO 的辅助向量

```bash
# 内核通过辅助向量告诉进程 vDSO 的地址（注意：此命令仅对动态链接的程序有效）
LD_SHOW_AUXV=1 /bin/true | grep -i -E 'sysinfo|vdso'
```

> 📌 `AT_SYSINFO_EHDR` 就是 vDSO 在进程地址空间中的起始地址。动态链接器（ld-linux-aarch64.so / ld-linux-x86-64.so）在程序启动时读取这个值，将 vDSO 当作一个普通的动态库进行符号解析。注意：`LD_SHOW_AUXV` 是动态链接器的专属环境变量，对静态链接的二进制文件无效（静态二进制不经过 `ld-linux.so`）。

#### 步骤 6（进阶，需要 root）：手动破坏时钟源，亲眼看 vDSO 降级

```bash
# 查看当前时钟源（正常情况应该是 arch_sys_counter）
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# → arch_sys_counter

# 先跑一次基准测试（vDSO 正常工作）
gcc -O2 -o bench_gettime bench_gettime.c
./bench_gettime
# → clock_gettime() x 100000000: 2.340 秒 (23.4 ns/call)

# 🚨 手动将时钟源切为 jiffies（不支持 vDSO 快速路径）
echo jiffies | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource

# 再跑一次——性能暴跌 10 倍！
./bench_gettime
# → clock_gettime() x 100000000: 23.105 秒 (231.1 ns/call)

# 用 strace 验证：这次 strace 能抓到所有的 clock_gettime！
strace -c ./bench_gettime 2>&1 | grep clock_gettime
# → 100.00   22.731052   0  100000000   clock_gettime  🚨

# ⚠️ 实验完毕后务必恢复！
echo arch_sys_counter | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource
```

> 📌 **原理**：当时钟源变为 `jiffies` 后，内核会将 vvar 页中的 `clock_mode` 设为 `VDSO_CLOCKMODE_NONE`。vDSO 代码检测到这个标志后，主动放弃用户态快速路径，退化为 `svc #0` 真正的系统调用。这就是为什么同样的程序、同样的编译参数，仅仅因为时钟源不同就会产生 10 倍性能差距。
> 
> 📌 **x86 等效操作**：`echo hpet | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource`（将 TSC 切为 HPET）。

### 思考题

1. vDSO 中的 `__kernel_clock_gettime()` 使用 SeqLock 来同步内核写和用户态读。如果把它换成互斥锁（mutex），会有什么问题？（提示：内核态持锁，用户态等锁……）

2. 为什么 `open()`、`read()`、`write()` 这些系统调用不适合放入 vDSO？哪些特征让 `clock_gettime` 成为 vDSO 的理想候选？

3. ARM64 使用独立的 TTBR0（用户页表）和 TTBR1（内核页表），因此不需要像 x86 KPTI 那样在系统调用时切换页表。这对系统调用性能有什么影响？对 vDSO 的加速比有什么影响？

4. 在容器（Docker）中运行的进程能使用 vDSO 吗？如果宿主机和容器内核版本不同，vDSO 会有问题吗？

---

> **📚 延伸阅读**
> - 内核文档：[kernel.org/doc/html/latest/userspace-api/vdso.html](https://docs.kernel.org/userspace-api/vdso.html)
> - ARM64 vDSO 源码：`arch/arm64/kernel/vdso/` 目录（内核源码树）
> - x86 vDSO 源码：`arch/x86/entry/vdso/` 目录
> - ARM Generic Timer：[ARM Architecture Reference Manual - Generic Timer](https://developer.arm.com/documentation/ddi0487/latest)
> - 前置案例：本书 Case（mmap — GIS 地图加载优化）—— vDSO 本质是内核自动做的一次特殊 mmap

---

> 📌 **回溯关联**：本案例与 **mmap 案例** 形成呼应——mmap 让应用程序把文件当内存用，vDSO 让内核把代码"塞"到用户空间。两者都是虚拟内存映射的精妙应用。本案例也与 **系统调用开销** 主题相关——vDSO 的存在提醒我们：系统调用的用户态/内核态切换是有真实成本的，当这个成本大于操作本身的计算量时，就值得想办法绕过它。
