# Case: 谁在偷看我的键盘？—— 一次中断向量表劫持攻击的取证分析

**难度：L4 | 耗时：2h | 知识点：中断与异常 / IDT 结构 / Ring 0 / Rootkit / IDT Hooking / CR0 绕过 / UMIP | 来源：Rustock/TDSS 等真实 Rootkit 使用的经典技术**

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
kbdmon.ko: ELF 64-bit LSB relocatable, x86-64, version 1 (SYSV)

$ strings /mnt/ubuntu_root/lib/modules/.../kbdmon.ko | grep -E "hook|log|http"
idt_hook_install
keylog_ring_buffer
send_data_to_remote
http://45.76.xxx.xxx/collect
```

阿坤倒吸一口凉气："`idt_hook_install`、`keylog_ring_buffer`……这是一个**内核级键盘记录器**。它把击键数据发到了远程服务器。"

"内核级？什么意思？"小张问。

"普通的木马运行在**用户态（Ring 3）**，很容易被扫出来。但这个东西伪装成驱动加载到了**内核态（Ring 0）**，拥有和操作系统同等的最高权限。从名字看，它 hook（劫持）了系统的命脉——**中断描述符表（IDT）**。"

---

#### 🧠 步骤 2：什么是中断和异常？

赵老师正好路过实验室，看到两人围着一台机房电脑，走过来听了几句。

"要搞清楚 IDT Hooking，你们得先理解 CPU 是怎么处理中断的。" 赵老师拉了把椅子坐下。

"CPU 在执行程序的时候，会遇到各种需要**立即处理**的事件。这些事件分两大类：

**异常（Exception）**——CPU 自身在执行指令时产生的：
- **除零错误**（#DE, INT 0）：你写了个 `a / 0`
- **缺页异常**（#PF, INT 14）：访问的虚拟地址还没映射到物理内存
- **通用保护异常**（#GP, INT 13）：权限不对，比如用户态程序试图执行特权指令
- **断点**（#BP, INT 3）：调试器设的断点

**中断（Interrupt）**——外部硬件发来的信号：
- **键盘中断**（IRQ 1 → INT 0x21）：用户按了一个键
- **定时器中断**（IRQ 0 → INT 0x20）：时钟滴答，操作系统靠它做进程调度
- **磁盘中断**：DMA 传输完成
- **网卡中断**：数据包到达

不管是异常还是中断，CPU 的处理方式是一样的：**去一张表里查找对应的处理函数地址，然后跳过去执行。**"

"这张表就是 IDT？"

"没错。"

---

#### 📐 步骤 3：IDT 的结构

"在 x86 架构中，这张表叫 **IDT（Interrupt Descriptor Table）**，最多 256 个条目，每个条目 8 字节（32 位）或 16 字节（64 位），叫做**门描述符（Gate Descriptor）**。"

赵老师在白板上画了一张图：

```
IDT（中断描述符表）
┌────────┬──────────────────────────────┐
│ INT 0  │ → divide_error_handler()     │  除零异常
│ INT 1  │ → debug_handler()            │  调试异常
│ INT 2  │ → nmi_handler()              │  不可屏蔽中断
│ INT 3  │ → breakpoint_handler()       │  断点
│  ...   │   ...                        │
│ INT 13 │ → general_protection()       │  #GP 通用保护
│ INT 14 │ → page_fault_handler()       │  #PF 缺页异常
│  ...   │   ...                        │
│ INT 32 │ → timer_interrupt()          │  IRQ 0 定时器
│ INT 33 │ → keyboard_interrupt()       │  IRQ 1 键盘  ← 攻击目标!
│  ...   │   ...                        │
│ INT 128│ → system_call()              │  Linux 系统调用 (0x80)
└────────┴──────────────────────────────┘
        ↑
     IDTR 寄存器 (保存着这张表的内存基址)
*(注：现代多核 APIC 架构中断号为动态分配，为教学直观，此处沿用经典 8259A 的 0x21 映射)*
```

赵老师强调："当中断发生时，**纯硬件逻辑**会自动查 IDT 表，并**带着 Ring 0 的最高权限**跳转到该地址。如果黑客把键盘中断的地址改成了他自己的代码……你敲击键盘的瞬间，CPU 首先执行的就是恶意代码。"

---

#### 🔬 步骤 4：转储 IDT——抓捕现行

为了抓现行，阿坤拔下 U盘，重启进入了被感染的机器原系统，并运行了特权内存取证工具。

```bash
# 获取当前内存中真实的 IDT 数据（过滤输出）
$ sudo ./forensic_tool --dump-idt
INT#  Type        DPL  Handler Address          Symbol
----  ----------  ---  ----------------------  -------------------------
0x00  Interrupt   0    0xffffffff81a01000       divide_error
0x0E  Interrupt   0    0xffffffff81a01e00       page_fault
0x20  Interrupt   0    0xffffffff81a02000       timer_interrupt
0x21  Interrupt   0    0xffffffffc0a8b000  <<<  ???  ← 地址异常!
0x22  Interrupt   0    0xffffffff81a02200       cascade
```

小张一眼就看出了问题："0x21 的地址不一样！其他都是 `0xffffffff81`（正常的操作系统内核代码段）开头，它却指向了 `0xffffffffc0` 开头的区域？"

阿坤敲下命令："`0xffffffffc0...` 是 Linux 动态加载**内核模块（vmalloc）**的地址范围。"

```bash
$ sudo cat /proc/modules | grep kbd
kbdmon  16384  1 - Live 0xffffffffc0a8b000
```

"石锤了。原始的系统键盘处理函数被替换，控制流被完美劫持到了木马模块中。"

"也就是说——**每次我在键盘上按一个键，CPU 都会跳到恶意代码去执行**？"

"Exactly."

---

#### 🧬 步骤 5：反汇编恶意代码——键盘记录的实现

"让我们看看这段恶意代码到底在干什么。"

```bash
# 从内存中提取恶意模块的代码段
$ sudo dd if=/proc/kcore bs=1 skip=$((0xffffffffc0a8b000)) count=4096 | \
    objdump -D -b binary -m i386:x86-64 -

0000000000000000 <.data>:
   0:   55                      push   %rbp
   1:   48 89 e5                mov    %rsp,%rbp
   4:   50                      push   %rax
   5:   53                      push   %rbx
   ;
   ; === 第一步：读取键盘扫描码 ===
   8:   e4 60                   in     $0x60,%al       ; ← 读端口 0x60
   a:   88 c3                   mov    %al,%bl         ;    保存扫描码
   ;
   ; === 第二步：扫描码存入环形缓冲区 ===
   c:   48 8d 0d xx xx xx xx    lea    buffer(%rip),%rcx
  13:   48 8b 15 xx xx xx xx    mov    buf_index(%rip),%rdx
  1a:   88 1c 11                mov    %bl,(%rcx,%rdx,1)  ; 存入 buffer[index]
  1d:   48 ff c2                inc    %rdx
  20:   48 81 e2 ff 03 00 00    and    $0x3ff,%rdx     ; 环形缓冲，1024 字节
  27:   48 89 15 xx xx xx xx    mov    %rdx,buf_index(%rip)
   ;
   ; === 第三步：跳回原始键盘中断处理函数 ===
  2e:   5b                      pop    %rbx
  2f:   58                      pop    %rax
  30:   5d                      pop    %rbp
  31:   ff 25 xx xx xx xx       jmp    *original_handler(%rip)  ; ← 跳回正常 handler
```

"可是学长，现在不都是 USB 键盘吗？" 小张很敏锐，"读古老的 `0x60` PS/2 端口还有用？"

赵老师赞许地点头："虽然是 USB 键盘，但绝大多数主板 BIOS 默认开启了 **USB Legacy Support**。为了兼容老系统，主板会在底层（SMM 模式）把 USB 键盘输入强制转换为传统的 `0x60` 端口信号。所以这种古老的方法依然能读到数据。"

**【硬核破绽】**

赵老师突然指着代码笑了："但必须指出，写这个木马的人犯了一个底层硬件错误——掉进了**数据消费（Data Consumption）陷阱**。"

"什么意思？"小张不解。

"键盘控制器的 `0x60` 端口是硬件 FIFO（先进先出）缓冲区。木马用 `in` 指令读走扫描码，**数据就被硬件出队'吃掉'了**！当它 `jmp` 跳回系统原生驱动时，原生驱动再去读 `0x60` 端口，拿到的就是**空数据或下一帧数据**！"

小张恍然大悟："难怪！我昨天打字的时候，感觉键盘有些断触，经常吞掉我按的字母！"

"对，" 赵老师说，"这也是为什么现代高级 Rootkit 早就淘汰了这种暴力的底层硬件截获，转而去 Hook 操作系统更上层的 `kbd_event` 回调链——那种方式只是在软件层读取数据的副本，不会'消费'硬件数据，用户才真的完全无感知。但作为 IDT 劫持的骨灰级鼻祖，这段代码非常值得研究。"

"那记录下来的扫描码怎么发出去？" 小张问。

"这个模块还注册了一个**内核定时器**，每隔 30 秒把环形缓冲区的内容通过 socket 发送到远程服务器。我们在 `strings` 里看到了那个 IP 地址。"


---

#### 💀 步骤 6：还原完整攻击链

赵老师听完整个分析过程，在白板上画出了完整的攻击链：

```
攻击链还原
══════════════════════════════════════════════════════════════

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  1. 初始入侵     │ ──→ │  2. 提权到 Ring 0 │ ──→ │  3. 加载恶意模块  │
│  利用未修补的    │     │  内核漏洞利用      │     │  insmod kbdmon.ko │
│  本地提权漏洞    │     │  (CVE-2023-xxxx) │     │                   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
         ┌──────────────────────────────────────────────┘
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  4. 篡改 IDT     │ ──→ │  5. 键盘记录      │ ──→ │  6. 数据外传      │
│  修改 INT 0x21   │     │  每次按键触发      │     │  定时器每 30 秒   │
│  指向恶意 handler │     │  先记录扫描码     │     │  发送到远程服务器  │
│                  │     │  再跳回原 handler  │     │                   │
└─────────────────┘     └─────────────────┘     └─────────────────┘

关键：步骤 4 是整个攻击的核心——修改 IDT 使得中断处理流程被劫持
```

"攻击者大概率是先以普通用户身份（可能通过物理接触机房电脑）登录了系统，然后利用一个**本地提权漏洞**获取 root 权限，加载了自己编写的恶意内核模块。模块初始化时做了一件事——**修改 IDT 第 0x21 项（键盘中断）的 handler 地址**，指向自己的代码。"

"为什么选择 hook IDT 而不是别的方式？" 小张问。

赵老师解释：

"因为 IDT Hooking 有几个'优势'（对攻击者而言）：

1. **极度隐蔽** — 不像用户态 hook，没有任何进程、没有任何文件路径会出现在 `ps`、`top`、`/proc` 的常规输出中
2. **无法被用户态杀软检测** — 杀毒软件运行在 Ring 3，它调用的所有系统调用本身就可能被 hook 过的内核代码拦截
3. **可靠性高** — 键盘中断是硬件级事件，只要键盘在工作，每一次按键都必然经过 IDT

当然，我们刚才已经看到了它的致命缺陷——数据消费冲突会导致吞键。这就是'理论上很美，工程上翻车'的典型案例。"

---

#### 🔧 步骤 7：恢复 IDT 并清除后门

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
[*] Unhooking IDT entry 0x21...
[*] Restoring original handler: 0xffffffff81a02100
[*] Removing module from kernel...
[+] Module removed successfully

# 验证 IDT 已恢复
$ sudo ./dump_idt | grep "0x21"
0x21  Interrupt   0    0x0010   0xffffffff81a02100       keyboard_interrupt  ✓
```

"好了，INT 0x21 恢复了！handler 地址回到了正常的内核代码段。" 阿坤松了口气。

"但是——" 赵老师提醒，"仅仅恢复 IDT 和删模块是不够的。攻击者既然能第一次装上去，说明系统有漏洞。机房管理员需要：

1. **重装系统** — 不能信任一个被 rootkit 感染过的系统
2. **修补内核漏洞** — 更新到最新内核版本
3. **受害同学立即修改所有密码**

而且所有在这些电脑上输入过的密码都应视为已泄露。"

---

#### 🛡️ 步骤 8：攻与防——现代操作系统的防御层次

小张提出一个核心疑问："不对啊，我记得现代操作系统的内存保护机制，**IDT 表所在的内存页不是只读（Read-Only）的吗**？木马是怎么改写成功的？"

赵老师画出了攻防演进图：

**1. CR0 寄存器绕过（矛 — 攻击者的手段）**

木马作为 `.ko` 模块加载后就已经拥有 Ring 0 权限。此时它可以执行特权汇编：通过清除 CPU `CR0` 寄存器的 **WP（Write-Protect）位**，强行关闭 CPU 写保护，对只读的 IDT 表进行篡改后，再把 WP 位恢复。这是 Rootkit 修改只读内核数据结构的经典手法：
```c
// 关闭写保护 → 修改 IDT → 恢复写保护
unsigned long cr0 = read_cr0();
write_cr0(cr0 & ~X86_CR0_WP);   // 清除 WP 位
// ... 修改 IDT 条目 ...
write_cr0(cr0);                  // 恢复 WP 位
```

**2. SMEP / SMAP — 在本案中不起作用！**

- SMEP 防御的是"处于 Ring 0 的 CPU 执行 Ring 3 的代码"（防止 ret2user 攻击）
- 但在本案中，黑客加载了 `.ko` 内核模块，恶意代码本身就已经被分配在 **Ring 0 的内核内存区（`0xffffffffc0...`）**
- 既然是 Ring 0 执行 Ring 0，**SMEP 毫无作用**

**3. 内核模块强制签名（真正的终极杀手锧）**

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

**4. Kernel Patch Protection（KPP / PatchGuard）**
- Windows 的内核数据结构保护机制
- 定期检查 IDT、SSDT、GDT 等关键内核数据结构
- 如果发现被篡改，直接**蓝屏（BSOD）**→ 宁可崩溃也不让 rootkit 继续运行

---

#### 💡 步骤 9：总结

阿坤帮机房管理员提交了安全报告，小张和其他同学都改了密码。晚上在寝室，小张回忆今天学到的东西：

1. **中断和异常是 CPU 最底层的事件分发机制** — 键盘按键、缺页、除零……所有紧急事件都通过 IDT 查找对应的处理函数
2. **IDT 是 CPU 硬件查表的** — 由 IDTR 寄存器指向，中断发生时 CPU 自动查表跳转，不经过任何软件
3. **修改 IDT = 劫持 CPU 的控制流** — 攻击者把 handler 地址改成自己的代码，每次中断触发就执行恶意逻辑
4. **IDT Hooking 是经典 Rootkit 技术** — Rustock、TDSS、Alureon 等真实恶意软件都使用过，极难被用户态程序检测
5. **现代防御是多层次的** — SMEP/SMAP（CPU 级）、PatchGuard（OS 级）、Secure Boot（固件级）、模块签名（软件级）层层防护

> **一句话总结：IDT 是连接硬件事件和软件处理的桥梁。保护好这张表，就是保护 CPU 的"神经系统"不被劫持。**

---

## 🧪 动手实践

### 实验环境

- Linux（推荐 Ubuntu 22.04 或 VM 虚拟机）
- GCC + NASM
- 需要 root 权限

### 实验 1：查看你自己系统的 IDT

```bash
# 方法 1：通过 /proc 查看中断分配
cat /proc/interrupts

# 方法 2：使用 dmesg 查看内核注册的中断信息
sudo dmesg | grep -i "idt\|interrupt\|irq"

# 方法 3：如果安装了调试工具
sudo cat /sys/kernel/debug/x86/idt  # 需要 debugfs
```

> 📌 观察 INT 0x21 对应的 handler，记录其地址。想一想——如果这个地址变了，你怎么发现？

### 实验 2：理解 IDT 条目结构（Ring 3 只读实验）

在用户态你可以用 `sidt` 指令读取 IDTR 的值（这是 x86 少数在 Ring 3 也能执行的特权信息读取指令）：

```c
// read_idtr.c — 在用户态读取 IDTR 寄存器
#include <stdio.h>
#include <stdint.h>

struct idtr {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed));

int main() {
    struct idtr idt_reg;
    __asm__ volatile ("sidt %0" : "=m"(idt_reg));

    printf("IDT Base Address: 0x%016lx\n", idt_reg.base);
    printf("IDT Limit:        0x%04x (%d entries)\n",
           idt_reg.limit, (idt_reg.limit + 1) / 16);

    return 0;
}
```

```bash
$ gcc -o read_idtr read_idtr.c
$ ./read_idtr
IDT Base Address: 0xfffffe0000000000
IDT Limit:        0x0fff (256 entries)
```

> 📌 注意：`sidt` 可以在 Ring 3 执行，这本身就是一个安全隐患——攻击者可以用它来探测内核地址布局。这就是为什么现代内核启用了 **KASLR（内核地址空间随机化）** 来缓解。

### 实验 3：对比学习——ARM 的异常向量表

ARM 架构使用完全不同的异常向量表结构。对比 x86 IDT 和 ARM Exception Vector Table，思考它们的异同：

```
ARM64 异常向量表（VBAR_EL1 指向）
偏移        异常类型              来源
────────────────────────────────────────
+0x000      Synchronous           当前 EL, SP_EL0
+0x080      IRQ/vIRQ              当前 EL, SP_EL0
+0x100      FIQ/vFIQ              当前 EL, SP_EL0
+0x180      SError/vSError        当前 EL, SP_EL0
+0x200      Synchronous           当前 EL, SP_ELx
+0x280      IRQ/vIRQ              当前 EL, SP_ELx
...
+0x400      Synchronous           低 EL, AArch64
+0x480      IRQ/vIRQ              低 EL, AArch64
...
```

> 📌 ARM 的向量表按**异常来源的 EL 级别**组织，而 x86 IDT 是统一的 256 个编号。ARM 的设计更清晰地区分了特权级别之间的边界——这也使得类似 IDT Hooking 的攻击在 ARM 上要困难得多。

### 思考题

1. `sidt` 指令可以在 Ring 3 执行，这对安全有什么影响？攻击者能用它做什么？KASLR 如何缓解这个问题？
2. 如果操作系统把 IDT 所在的内存页设为只读，攻击者还有哪些方法可以绕过？（提示：思考 `cr0.WP` 位）
3. Windows 的 PatchGuard 采用"检测到篡改就蓝屏"的策略，你觉得这个设计合理吗？有没有更好的方案？
4. 除了键盘中断，攻击者还可以 hook IDT 中的哪些条目来做哪些恶意操作？（提示：思考 INT 0x80、INT 0x0E）
5. 在虚拟化环境中（如 VMX），IDT Hooking 会有什么不同？Hypervisor 层面有什么额外的防御手段？
