# Case: 谁在偷看我的键盘？—— 一次异常向量表劫持攻击的取证分析

**难度：L4 | 耗时：2h | 知识点：中断与异常 / ARM64 异常向量表 / EL0-EL1 / Rootkit / VBAR Hooking | 来源：基于真实 Rootkit 技术改编**

---

#### 📅 场景

期末周，学校第三机房（这批电脑统一安装了 Ubuntu Linux 桌面版系统，配合操作系统课程使用）。

小张刚用 Vim 敲完操作系统的大作业，习惯性地打开浏览器登录了一下网页版 Steam，看看冬促有没有想买的游戏。旁边的小刘在查成绩，顺手登了一下学校邮箱。

第二天早上，小张收到 Steam 的安全警报——账号在凌晨 3 点从一个陌生 IP 登录过。他赶紧改了密码，在班群里吐槽了一句"Steam 号差点被盗"。

没想到消息一发出去，群里炸了锅：

> **小刘**："我也是！昨天在机房查完成绩，今天邮箱就收到异地登录提醒！"
> **小王**："卧槽我也中了，Github 密码被人改了……"
> **小李**："都是第三机房那排电脑？"

四个人一对时间线，全是昨天下午在**第三机房 C 排**的电脑上操作过。

"咱们用的可是 Linux，系统防病毒机制不是全开吗？怎么还能被盗号？"小张很困惑。

消息传到了学院安全实验室。学长阿坤正好在旁边喝咖啡："常规杀毒扫不到，多人同时中招，又都是同一排机器……这恐怕是内核级后门。走，带上我的 U 盘，咱去看看。"

---

#### 🔍 步骤 1：现场初步排查（静态取证）

阿坤没有直接开机进原系统，而是用自己的 U 盘引导了一个取证专用的 Live Linux。

"直接进被感染的系统的话，如果有内核级 Rootkit，它可能会拦截系统的文件排查命令并隐藏自己。我们用干净的外部系统挂载它的硬盘，从'上帝视角'看它就无处遁形了。"

```bash
$ lsblk
NAME   MAJ:MIN RM   SIZE RO TYPE MOUNTPOINT
sda      8:0    0 256.0G  0 disk
├─sda1   8:1    0   500M  0 part /boot/efi
└─sda2   8:2    0 255.5G  0 part /mnt/ubuntu_root  # ← 挂载机房电脑的系统盘
sdb      8:16   1  14.9G  0 disk
└─sdb1   8:17   1  14.9G  0 part /                # ← 阿坤的 Live U盘
```

"接下来找什么？"小张问。
"查一下系统的内核驱动目录里有没有混进脏东西。"

```bash
$ ls -lt /mnt/ubuntu_root/lib/modules/$(uname -r)/kernel/drivers/input/ | head -5
...
-rw-r--r-- 1 root root  16384 Dec 25 03:15 kbdmon.ko    # <-- 创建时间是昨天深夜？
-rw-r--r-- 1 root root  28560 Oct 10 14:20 mouse.ko
...
```

"等等——`kbdmon.ko`？" 阿坤盯着屏幕，"这不是 Linux 标准的外设驱动。名字是 keyboard monitor 的缩写。"

```bash
$ file /mnt/ubuntu_root/lib/modules/.../kbdmon.ko
kbdmon.ko: ELF 64-bit LSB relocatable, ARM aarch64, version 1 (SYSV)

$ strings /mnt/ubuntu_root/lib/modules/.../kbdmon.ko | grep -E "hook|log|http"
vbar_hook_install
keylog_ring_buffer
send_data_to_remote
http://45.76.xxx.xxx/collect
```

阿坤倒吸一口凉气："`vbar_hook_install`、`keylog_ring_buffer`……这是一个**内核级键盘记录器**。它把击键数据发到了远程服务器。"

"内核级？什么意思？"小张问。

"普通的木马运行在**用户态（EL0）**，很容易被扫出来。但这个东西伪装成驱动加载到了**内核态（EL1）**，拥有和操作系统同等的最高权限。从名字看，它 hook（劫持）了系统的命脉——**异常向量表（Exception Vector Table）**，也就是 `VBAR_EL1` 寄存器指向的那张表。"

---

#### 🧠 步骤 2：什么是中断和异常？

赵老师正好路过实验室，看到两人围着一台机房电脑，走过来听了几句。

"要搞清楚向量表劫持，你们得先理解 CPU 是怎么处理异常的。" 赵老师拉了把椅子坐下。

"在 ARM64 架构中，CPU 在执行程序的时候，会遇到各种需要**立即处理**的事件。这些事件统称为**异常（Exception）**，分为四大类：

**同步异常（Synchronous）**——CPU 自身在执行指令时产生的：
- **SVC 指令**：用户态程序发起系统调用
- **数据异常（Data Abort）**：访问的虚拟地址还没映射到物理内存（类似缺页）
- **未定义指令异常**：CPU 遇到了不认识的指令

**异步异常**——外部硬件发来的信号：
- **IRQ（普通中断）**：键盘按键、网卡收包、定时器滴答……
- **FIQ（快速中断）**：安全相关的紧急中断
- **SError（系统错误）**：硬件故障

不管是哪种异常，CPU 的处理方式是一样的：**跳到 `VBAR_EL1` 寄存器指向的向量表中对应偏移处的代码去执行。**"

"这张表就是向量表？"

"没错。"

---

#### 📐 步骤 3：ARM64 异常向量表的结构

"在 ARM64 架构中，这张表叫 **Exception Vector Table**，由 `VBAR_EL1`（Vector Base Address Register）寄存器指向。它有 **16 个条目**，按照「异常来源 × 异常类型」组织，每个条目是 **128 字节**（0x80）的可执行代码空间。"

赵老师在白板上画了一张图：

```
ARM64 异常向量表（VBAR_EL1 指向）

偏移        异常类型              来源
────────────────────────────────────────────────────
+0x000      Synchronous           当前 EL, SP_EL0
+0x080      IRQ                   当前 EL, SP_EL0
+0x100      FIQ                   当前 EL, SP_EL0
+0x180      SError                当前 EL, SP_EL0

+0x200      Synchronous           当前 EL, SP_ELx
+0x280      IRQ                   当前 EL, SP_ELx
+0x300      FIQ                   当前 EL, SP_ELx
+0x380      SError                当前 EL, SP_ELx

+0x400      Synchronous           低 EL (EL0), AArch64  ← 系统调用入口!
+0x480      IRQ                   低 EL (EL0), AArch64  ← 攻击目标!
+0x500      FIQ                   低 EL (EL0), AArch64
+0x580      SError                低 EL (EL0), AArch64

+0x600      Synchronous           低 EL, AArch32
+0x680      IRQ                   低 EL, AArch32
...
        ↑
   VBAR_EL1 寄存器 (保存着这张表的内存基址)
```

<p class="insight">💡 <b>ARM64 向量表与 x86 IDT 的关键区别</b><br>
x86 的 IDT 每个条目存的是处理函数的<b>地址描述符</b>（门描述符），CPU 从表中读取地址后跳转。而 ARM64 的向量表每个条目直接就是 <b>128 字节的可执行代码空间</b>（通常放一条 <code>b</code> 跳转指令跳到正式的处理函数）。<br>
这意味着劫持方法不同：x86 需要修改描述符中的地址字段，而 ARM64 可以直接修改向量表中的跳转指令。
</p>

赵老师强调："当异常发生时，**纯硬件逻辑**会根据异常类型和来源 EL，自动跳到向量表中对应偏移处的代码，并**切换到 EL1 特权级**执行。如果黑客修改了向量表中的代码……比如用户按下键盘产生 IRQ 时，CPU 首先执行的就是攻击者注入的指令。"

---

#### 🔬 步骤 4：转储向量表——抓捕现行

为了抓现行，阿坤拔下 U盘，重启进入了被感染的机器原系统，并运行了特权内存取证工具。

```bash
# 获取当前 VBAR_EL1 地址和向量表内容
$ sudo ./forensic_tool --dump-vbar
VBAR_EL1 = 0xffff800010011800

Offset   Expected (kernel .text)        Actual Branch Target
------   ----------------------------   ----------------------------
+0x000   0xffff800010011800 (sync_cur)  0xffff800010011800  ✓
+0x080   0xffff800010011880 (irq_cur)   0xffff800010011880  ✓
+0x200   0xffff800010011a00 (sync_spx)  0xffff800010011a00  ✓
+0x400   0xffff800010011c00 (el0_sync)  0xffff800010011c00  ✓
+0x480   0xffff800010011c80 (el0_irq)   0xffff0000c0a8b000  <<< 异常!
+0x500   0xffff800010011d00 (el0_fiq)   0xffff800010011d00  ✓
```

小张一眼就看出了问题："+0x480 的跳转目标不一样！其他都是 `0xffff8000`（正常的内核代码段）开头，它却跳到了 `0xffff0000c0` 开头的地方？"

阿坤敲下命令验证："`0xffff0000c0...` 是 Linux 动态加载**内核模块（vmalloc 区域）**的地址范围。"

```bash
$ sudo cat /proc/modules | grep kbd
kbdmon  16384  1 - Live 0xffff0000c0a8b000
```

"石锤了。+0x480 是来自 EL0（用户态）的 **IRQ 入口**。用户在敲键盘时产生的硬件中断，本应跳到内核的 `el0_irq` 处理函数，现在却被重定向到了木马模块。"

"也就是说——**每次我在键盘上按一个键，CPU 都会先跳到恶意代码去执行**？"

"Exactly。"

---

#### 🧬 步骤 5：反汇编恶意代码——键盘记录的实现

"让我们看看向量表 +0x480 处的代码到底被改成了什么。"

```bash
# 反汇编被篡改的 +0x480 入口代码（128 字节空间）
$ sudo ./forensic_tool --disasm-vbar-entry 0x480

# 原始代码（应该是）:
#   b  el0_irq_handler     // 直接跳到内核 IRQ 处理函数

# 实际代码（被替换为）:
0xffff800010011c80:  b   0xffff0000c0a8b000   // 跳到恶意模块！
```

"跳转目标的恶意模块代码如下："

```bash
$ sudo ./forensic_tool --disasm 0xffff0000c0a8b000 96

0xffff0000c0a8b000:  stp  x0, x1, [sp, #-16]!       // 保存 x0, x1
0xffff0000c0a8b004:  stp  x2, x3, [sp, #-16]!       // 保存 x2, x3
;
; === 第一步：通过 input subsystem 钩子读取按键 ===
0xffff0000c0a8b008:  adrp x0, latest_scancode       // 全局变量：最新扫描码
0xffff0000c0a8b00c:  ldr  w1, [x0, :lo12:latest_scancode]
0xffff0000c0a8b010:  cbz  w1, skip_log              // 如果没有新按键则跳过
;
; === 第二步：扫描码存入环形缓冲区 ===
0xffff0000c0a8b014:  adrp x2, ring_buffer
0xffff0000c0a8b018:  adrp x3, buf_index
0xffff0000c0a8b01c:  ldr  x3, [x3, :lo12:buf_index]
0xffff0000c0a8b020:  strb w1, [x2, x3]              // buffer[index] = scancode
0xffff0000c0a8b024:  add  x3, x3, #1
0xffff0000c0a8b028:  and  x3, x3, #0x3ff            // 环形缓冲，1024 字节
0xffff0000c0a8b02c:  adrp x2, buf_index
0xffff0000c0a8b030:  str  x3, [x2, :lo12:buf_index]
0xffff0000c0a8b034:  str  wzr, [x0, :lo12:latest_scancode]  // 清零
;
; === 第三步：跳回原始 IRQ 处理函数 ===
skip_log:
0xffff0000c0a8b038:  ldp  x2, x3, [sp], #16
0xffff0000c0a8b03c:  ldp  x0, x1, [sp], #16
0xffff0000c0a8b040:  b    original_el0_irq          // 跳回正常的 el0_irq
```

<p class="insight">💡 <b>比 x86 IDT Hooking 更精巧的设计</b><br>
在 x86 上，经典的键盘记录器直接用 <code>in $0x60, %al</code> 读硬件 I/O 端口，会"消费"掉数据导致吞键。<br>
而这个 ARM64 木马更聪明——它没有直接读硬件，而是通过 <code>notifier_chain</code> 在 input subsystem 注册了一个回调，把最新的扫描码拷贝到全局变量 <code>latest_scancode</code>。向量表钩子只是负责定期把积累的数据搬到环形缓冲区。这种方式<b>只读副本，不消费原始数据</b>，用户完全无感知——不会出现吞键！
</p>

"那记录下来的扫描码怎么发出去？" 小张问。

"这个模块还注册了一个 **hrtimer 内核定时器**，每隔 30 秒把环形缓冲区的内容通过 `kernel_sendmsg()` 发送到远程服务器。我们在 `strings` 里看到了那个 IP 地址。"

---

#### 💀 步骤 6：还原完整攻击链

赵老师听完整个分析过程，在白板上画出了完整的攻击链：

```
攻击链还原
══════════════════════════════════════════════════════════════

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  1. 初始入侵     │ ──→ │  2. 提权到 EL1   │ ──→ │  3. 加载恶意模块  │
│  利用未修补的    │     │  内核漏洞利用      │     │  insmod kbdmon.ko │
│  本地提权漏洞    │     │  (CVE-2023-xxxx) │     │                   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
         ┌──────────────────────────────────────────────┘
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  4. 篡改向量表   │ ──→ │  5. 键盘记录      │ ──→ │  6. 数据外传      │
│  修改 +0x480     │     │  每次 IRQ 触发     │     │  hrtimer 每 30 秒 │
│  的跳转指令      │     │  读取扫描码副本    │     │  发送到远程服务器  │
│                  │     │  存入环形缓冲区    │     │                   │
└─────────────────┘     └─────────────────┘     └─────────────────┘

关键：步骤 4 是整个攻击的核心——修改向量表 +0x480 入口的 b 指令
```

"攻击者大概率是先以普通用户身份（可能通过物理接触机房电脑）登录了系统，然后利用一个**本地提权漏洞**获取 root 权限，加载了自己编写的恶意内核模块。模块初始化时做了两件事——**在 input subsystem 注册键盘回调**，并**修改向量表 +0x480 处的跳转指令**。"

"为什么选择 hook 向量表而不是别的方式？" 小张问。

赵老师解释：

"因为向量表劫持有几个'优势'（对攻击者而言）：

1. **极度隐蔽** — 不像用户态 hook，没有任何进程、没有任何文件路径会出现在 `ps`、`top`、`/proc` 的常规输出中
2. **无法被用户态杀软检测** — 杀毒软件运行在 EL0，它调用的所有系统调用本身就要经过 EL1 的处理
3. **可靠性高** — IRQ 是硬件级事件，只要硬件中断在工作，每次事件都必然经过向量表
4. **ARM64 向量表是可执行代码** — 只需修改一条 `b`（branch）指令就能劫持控制流，实现简单"

---

#### 🔧 步骤 7：恢复向量表并清除后门

"知道原理了，修复起来就简单了。" 阿坤开始操作。

```bash
# 第一步：记录恶意模块信息用于后续取证
$ sudo cp /sys/module/kbdmon/sections/.text /tmp/kbdmon_evidence.bin

# 第二步：卸载恶意内核模块
$ sudo rmmod kbdmon
rmmod: ERROR: Module kbdmon is in use
# 模块设置了防卸载——它把自己的引用计数锁死了

# 第三步：强制清除（需要用到我们的取证工具）
$ sudo ./force_rmmod kbdmon
[*] Resetting module refcount to 0...
[*] Restoring VBAR_EL1+0x480 entry...
[*] Writing original branch: b el0_irq (0xffff800010011c80)
[*] Flushing instruction cache (IC IALLU)...
[*] Removing module from kernel...
[+] Module removed successfully

# 验证向量表已恢复
$ sudo ./forensic_tool --dump-vbar | grep 0x480
+0x480   0xffff800010011c80 (el0_irq)  0xffff800010011c80  ✓
```

<p class="thinking">注意恢复向量表后，必须执行 <code>IC IALLU</code>（Instruction Cache Invalidate All）或 <code>IC IVAU</code>（按地址失效）刷新指令缓存——因为 ARM64 向量表的条目是可执行代码，CPU 很可能缓存了旧的（被篡改的）跳转指令。如果不刷 I-Cache，修复不会立刻生效！</p>

"好了，+0x480 恢复了！跳转目标回到了正常的内核 `el0_irq` 处理函数。" 阿坤松了口气。

"但是——" 赵老师提醒，"仅仅恢复向量表和删模块是不够的。攻击者既然能第一次装上去，说明系统有漏洞。机房管理员需要：

1. **重装系统** — 不能信任一个被 rootkit 感染过的系统
2. **修补内核漏洞** — 更新到最新内核版本
3. **受害同学立即修改所有密码**

而且所有在这些电脑上输入过的密码都应视为已泄露。"

---

#### 🛡️ 步骤 8：攻与防——现代操作系统的防御层次

小张提出一个核心疑问："不对啊，我记得现代操作系统的内存保护机制，**向量表所在的内存页不是只读（Read-Only）的吗**？木马是怎么改写成功的？"

赵老师画出了攻防演进图：

**1. `set_memory_rw()` 绕过（矛 — 攻击者的手段）**

在 ARM64 上没有 x86 那样的 `CR0.WP` 位可以一键关闭写保护。但木马作为 `.ko` 模块加载后已经拥有 EL1 权限，可以调用内核函数 `set_memory_rw()` 修改向量表所在页的**页表项（PTE）**，将只读属性改为可写，篡改后再调用 `set_memory_ro()` 恢复：
```c
// 修改页表 → 写入向量表 → 恢复页表
set_memory_rw(vbar_addr, 1);     // 将向量表页标记为可写
// ... 修改 +0x480 处的 branch 指令 ...
set_memory_ro(vbar_addr, 1);     // 恢复为只读
flush_icache_range(vbar_addr + 0x480, vbar_addr + 0x500);  // 必须刷 I-Cache！
```

**2. PAN（Privileged Access Never）— 在本案中不起作用！**

- PAN 是 ARM64 独有的安全特性：防止**内核态（EL1）直接访问用户态（EL0）的内存**
- 它防御的是 ret2user 攻击（内核被骗去执行用户空间的恶意代码）
- 但在本案中，黑客加载了 `.ko` 内核模块，恶意代码本身就已经被分配在**内核地址空间（`0xffff0000c0...`）**
- 既然是 EL1 执行 EL1 的代码，**PAN 毫无作用**

**3. 内核模块强制签名（真正的终极杀手锏）**

既然进了内核就无法无天，现代 Linux 只能死守大门——开启强制签名校验结合 UEFI Secure Boot，系统只允许加载带有官方数字签名的驱动。黑客自己编译的无签名 `kbdmon.ko` 会在加载第一步就被直接踢飞：
```bash
# Linux 可以配置为只加载签名过的模块
CONFIG_MODULE_SIG=y
CONFIG_MODULE_SIG_FORCE=y

# 查看当前内核的模块签名策略
$ cat /proc/sys/kernel/modules_disabled
0    # 0 表示允许加载，可以设为 1 彻底禁止动态加载模块
```
机房之所以中招，很可能是因为近期做特殊硬件开发实验，管理员临时关掉了签名校验。

**4. BTI（Branch Target Identification）**
- ARMv8.5 引入的控制流完整性保护
- 只有标记了 `BTI` 指令的地址才能作为间接跳转的合法目标
- 攻击者注入的跳转目标没有 BTI 标记，CPU 会触发**分支目标异常**
- 类似 x86 的 CET（Control-flow Enforcement Technology）
- 但在本案中攻击者直接修改的是向量表中的**直接跳转指令**（`b` 而非 `br`），BTI 对直接跳转不做检查，因此也无法防御

---

#### 💡 步骤 9：总结

阿坤帮机房管理员提交了安全报告，小张和其他同学都改了密码。晚上在寝室，小张回忆今天学到的东西：

1. **异常向量表是 ARM64 最底层的事件分发机制** — 系统调用（SVC）、硬件中断（IRQ）、缺页异常……所有事件都通过 VBAR_EL1 指向的向量表分发处理
2. **ARM64 向量表直接存放可执行代码** — 每个条目是 128 字节的代码空间（通常是一条 `b` 跳转指令），而不像 x86 IDT 存放地址描述符。修改一条跳转指令就能劫持控制流
3. **按来源 EL 分组是 ARM64 的独特设计** — 向量表按「异常来源的特权级 × 异常类型」组织为 16 个条目，来自 EL0 和来自 EL1 的中断走不同入口
4. **向量表劫持是经典 Rootkit 技术的 ARM64 变体** — 原理与 x86 的 IDT Hooking 相通，但技术细节完全不同
5. **现代防御是多层次的** — PAN/PXN（CPU 级）、BTI（控制流级）、Secure Boot（固件级）、模块签名（软件级）层层防护

> **一句话总结：异常向量表是 ARM64 CPU 的"神经系统"。保护好 VBAR_EL1 指向的这张表，就是保护系统最核心的控制流不被劫持。**

---

## 🧪 动手实践

### 实验环境

- Linux ARM64（推荐 Ubuntu 22.04 on QEMU 或树莓派 4）
- GCC (aarch64) + binutils
- 需要 root 权限

### 实验 1：查看你自己系统的异常向量表

```bash
# 方法 1：通过 /proc 查看中断分配
cat /proc/interrupts

# 方法 2：使用 dmesg 查看内核注册的中断信息
sudo dmesg | grep -i "vectors\|vbar\|irq"

# 方法 3：如果安装了调试工具（需要 CONFIG_DEBUG_FS）
sudo cat /sys/kernel/debug/aarch64/vectors
```

> 📌 观察 IRQ 对应的处理函数，想一想——如果向量表 +0x480 处的跳转指令变了，你怎么发现？

### 实验 2：理解 VBAR_EL1 寄存器

在内核模块中可以用 `mrs` 指令读取 VBAR_EL1 的值（EL1 特权指令）：

```c
// read_vbar.c — 内核模块：读取 VBAR_EL1 寄存器
#include <linux/module.h>
#include <linux/kernel.h>

static int __init read_vbar_init(void) {
    unsigned long vbar;
    asm volatile("mrs %0, vbar_el1" : "=r" (vbar));

    printk(KERN_INFO "VBAR_EL1 = 0x%016lx\n", vbar);
    printk(KERN_INFO "Vector table size: 0x800 (2048 bytes, 16 entries x 128 bytes)\n");

    // 读取 +0x480 处的第一条指令（应该是 b el0_irq）
    unsigned int *entry = (unsigned int *)(vbar + 0x480);
    printk(KERN_INFO "+0x480 first instruction: 0x%08x\n", *entry);

    return 0;
}

static void __exit read_vbar_exit(void) {}

module_init(read_vbar_init);
module_exit(read_vbar_exit);
MODULE_LICENSE("GPL");
```

```bash
$ make -C /lib/modules/$(uname -r)/build M=$PWD modules
$ sudo insmod read_vbar.ko
$ dmesg | tail -3
VBAR_EL1 = 0xffff800010011800
Vector table size: 0x800 (2048 bytes, 16 entries x 128 bytes)
+0x480 first instruction: 0x14000050   # 这是一条 b 指令（ARM64 编码）
```

> 📌 注意：x86 的 `sidt` 指令可以在 Ring 3（用户态）执行，是个安全隐患。但 ARM64 的 `mrs vbar_el1` 只能在 EL1（内核态）执行——这是更安全的设计。攻击者无法从用户态探测向量表位置。

### 实验 3：对比学习——x86 的中断描述符表（IDT）

x86 架构使用完全不同的中断处理结构。对比 ARM64 Exception Vector Table 和 x86 IDT，思考它们的异同：

```
x86 IDT（中断描述符表）
┌────────┬──────────────────────────────┐
│ INT 0  │ → divide_error_handler()     │  除零异常
│ INT 1  │ → debug_handler()            │  调试异常
│ INT 3  │ → breakpoint_handler()       │  断点
│  ...   │   ...                        │
│ INT 14 │ → page_fault_handler()       │  #PF 缺页异常
│ INT 32 │ → timer_interrupt()          │  IRQ 0 定时器
│ INT 33 │ → keyboard_interrupt()       │  IRQ 1 键盘
│  ...   │   ...                        │
│ INT 128│ → system_call()              │  Linux 系统调用 (0x80)
└────────┴──────────────────────────────┘
```

> 📌 x86 IDT 按统一的中断号（0~255）线性排列，而 ARM64 向量表按**异常来源的 EL 级别**组织。ARM64 的设计更清晰地区分了特权级别之间的边界——来自 EL0 的中断走 +0x400~0x580，来自 EL1 的走 +0x200~0x380，互不干扰。

### 思考题

1. ARM64 的 `mrs vbar_el1` 只能在 EL1 执行，而 x86 的 `sidt` 可以在 Ring 3 执行。这两种设计各有什么优劣？
2. 如果攻击者不修改向量表本身，而是直接修改 `VBAR_EL1` 寄存器指向自己的假向量表，这种攻击能否成功？如何防御？
3. ARM64 的 PAN 为什么无法防御本案中的攻击？如果把恶意代码放在用户态内存中，PAN 能否拦截？
4. 除了 IRQ 入口（+0x480），攻击者还可以 hook 向量表中的哪些条目来做哪些恶意操作？（提示：思考 +0x400 Synchronous）
5. 在虚拟化环境中（如 ARM64 EL2 / Hypervisor），向量表劫持会有什么不同？Hypervisor 层面有什么额外的防御手段？
