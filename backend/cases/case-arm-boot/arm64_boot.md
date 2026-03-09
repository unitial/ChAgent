# Case 19: 同一个内核，两块板子 —— 解剖 ARM64 启动流程

**难度：L6 | 耗时：2h | 知识点：CPU 启动流程 / 异常级别(EL) / 设备树(DTB) / 内核入口 | 来源：ARM Architecture Reference Manual + 工业实践**

---

#### 📅 2027年3月10日，周一上午

我们团队的 IoT 网关产品一直跑在一块 Cortex-A53 开发板（代号"旧板"）上，稳得一匹。上周硬件组换了供应商，来了一批新的 Cortex-A72 板子（代号"新板"），性能更强、价格更低。新板出厂时 SPI Flash 里已经烧好了适配本板的底层固件（U-Boot），只需要从 SD 卡引导 Linux 内核和根文件系统。主管说："内核和文件系统是通用的 ARM64 架构，直接把旧板的 SD 卡插过去就行。"

我把 SD 卡从旧板拔下来，插到新板上，接好串口线（USB-TTL 转接器连到新板的 UART0 排针），打开终端：

```bash
$ picocom -b 115200 /dev/ttyUSB0
picocom v3.1
port is        : /dev/ttyUSB0
flowcontrol    : none
baudrate is    : 115200
Terminal ready
```

上电。这次新板自带的 U-Boot 正常启动了——它读取了 SD 卡上的内核和设备树，一切看起来很顺利：

```
U-Boot 2024.01 (Board v3 - A72)

DRAM:  2 GiB
MMC:   mmc@fe320000: 0
Loading Environment from FAT... OK
Hit any key to stop autoboot:  0
## Reading Image from mmc 0:1 to 0x40200000 ... OK
## Reading board.dtb from mmc 0:1 to 0x48000000 ... OK
   Booting using the fdt blob at 0x48000000
   Loading Device Tree to 0000000049ff8000, end 0000000049fff47a ... OK

Starting kernel ...

```

然后——光标停在了 `Starting kernel ...` 之后。等了 30 秒，没有一行内核日志。等了 60 秒，依然沉默。

把同一张 SD 卡拔回旧板，接上串口，上电——旧板的串口立刻吐出完整启动流程：

```
U-Boot 2024.01 (Board v2 - A53)

DRAM:  1 GiB
MMC:   mmc@1c0f000: 0
Loading Environment from FAT... OK
## Reading Image from mmc 0:1 to 0x40200000 ... OK
## Reading board.dtb from mmc 0:1 to 0x48000000 ... OK
   Booting using the fdt blob at 0x48000000

Starting kernel ...

[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd034]
[    0.000000] Linux version 6.1.80 (builder@ci) (aarch64-linux-gnu-gcc 12.2)
[    0.000000] Machine model: IoT Gateway Board v2 (A53)
[    0.000000] earlycon: uart0 at MMIO 0x01c28000 (options '115200n8')
[    0.527000] Serial: 8250/16550 driver, 4 ports, IRQ sharing disabled
[    0.533000] 1c28000.serial: ttyS0 at MMIO 0x1c28000 (irq = 30, base_baud = 1500000) is a 16550A
...
[    2.841000] Run /sbin/init as init process

Welcome to Alpine Linux 3.19
gateway login: _
```

4 秒，旧板完美启动。SD 卡再插回新板——U-Boot 正常，但内核死寂。反复三次，结果一样：

```
  旧板 (Cortex-A53)：                新板 (Cortex-A72)：
  
  U-Boot ... loaded                  U-Boot ... loaded
  Starting kernel ...                Starting kernel ...
  Booting Linux on physical CPU 0    (光标停在这里，再无输出)
  ...                                (等待 60 秒……)
  Welcome to Alpine Linux!           (依然空白)
  gateway login: _                  

  ✅ 4秒启动                         ❌ U-Boot 过了，内核死了
```

同一个内核、同一个 rootfs、同一张 SD 卡、同一根串口线。U-Boot 阶段两块板子都正常。差异出在 **`Starting kernel ...` 之后**——内核拿到了控制权，但不说话了。

#### 🔦 勘查现场

**第一步：排除物理层问题。**

串口线接错了？不可能——U-Boot 阶段的输出证明串口线是通的。波特率错了？也不可能——U-Boot 和内核用的是同一个串口、同一个波特率 115200。

问题被精确锁定在：**内核启动的某个环节出了故障**。

**第二步：确认内核是否还活着——请出 JTAG。**

`Starting kernel ...` 之后串口哑了，但这不等于内核挂了——也可能是内核在跑，只是串口驱动初始化失败了，内核"说不出话来"。要知道内核的真实状态，需要一种不依赖串口的调试手段——**JTAG 调试器**。

串口是 CPU"主动说话"——得内核初始化串口驱动后才能输出。JTAG 是我们"强行读心"——不需要目标系统有任何软件支持，直接通过硬件调试接口读写 CPU 寄存器和内存。所以即使串口一片漆黑，JTAG 照样能看到 CPU 在干什么。

我找硬件工程师老王借了一台 Segger J-Link，连上新板的 JTAG 接口（20-pin 排针），启动 OpenOCD：

```bash
$ openocd -f interface/jlink.cfg -f target/aarch64.cfg
Open On-Chip Debugger 0.12.0
Licensed under GNU GPL v2
Info : J-Link V11 connected
Info : JTAG tap: aarch64.cpu tap/device found: 0x4ba00477
Info : aarch64.cpu: hardware has 6 breakpoints, 4 watchpoints
Info : starting gdb server for aarch64.cpu on port 3333
Info : Listening on port 3333 for gdb connections
```

JTAG 识别到了 CPU（`tap/device found`）！芯片活着。老王在旁边打开了另一个终端，用 GDB 连上去，先暂停 CPU 再看寄存器：

```bash
$ aarch64-linux-gnu-gdb
(gdb) target remote :3333
Remote debugging using :3333
0xffff800008084a20 in ?? ()

(gdb) info reg pc cpsr
pc             0xffff800008084a20  0xffff800008084a20
cpsr           0x600003c5          1610613701

(gdb) p/x $CurrentEL
$1 = 0x4
```

老王看了一眼就说：**"`CurrentEL = 0x4`，说明 CPU 运行在 EL1。再看 PC 在 `0xffff800008084a20`——这是内核的虚拟地址空间，说明不仅进了内核，而且 MMU 都开了，跑得很远了。"**

> 💡 **为什么 `0x4` 等于 EL1？** ARM64 系统寄存器 `CurrentEL` 的异常级别存储在 `Bit[3:2]`。EL1 = 二进制 `01`，左移两位就是 `0b0100 = 0x4`。同理 EL2 = `0x8`，EL3 = `0xC`。

**而且 PC 处于 `0xffff...` 的高位地址，说明内核早已经开启了 MMU（虚拟内存管理），进入了 C 语言执行阶段。** 内核刚启动时 MMU 是关闭的，PC 会指向物理加载地址（如 `0x40400000`）。现在 PC 已经是虚拟地址，说明内核走得很远了——只是我们在串口上看不到任何输出。

这需要解释一下。ARM64 CPU 有四个特权等级：

```
  ARM64 异常级别（Exception Levels）：

  EL3: Secure Monitor    ← 最高特权，安全世界（TrustZone）
  EL2: Hypervisor        ← 虚拟化层
  EL1: OS Kernel         ← 操作系统内核       ← CPU 现在在这里！
  EL0: User Application  ← 用户程序
```

在采用 TF-A（ARM Trusted Firmware）的平台上，冷启动常见链路是 BL1 → BL2 → BL31 → BL33（U-Boot）→ Linux。注意：EL3 和 EL2 在架构上都是**可选的**，有些精简平台会跳过部分级别，引导程序直接以 EL2 或 EL1 进入内核。我们这块新板走的是完整 TF-A 链路，结合 EL1 + 虚拟地址 PC 可判断前四步都成功了：

```
  ARM64 启动链（本平台，采用 TF-A）：

  ① ROM 固件（BL1） [EL3]        ✅ 通过
  ② 可信固件（BL2） [EL3]        ✅ 通过（DRAM 初始化成功）
  ③ EL3 Runtime     [EL3]        ✅ 通过（降级到 EL2）
  ④ U-Boot          [EL2/EL1]    ✅ 通过（加载了内核和 DTB，串口有输出）
  ⑤ Linux 内核      [EL1]        ← CPU 在这里，MMU 已开启，但串口没输出
  ⑥ 用户空间                     ← 还没到这里
```

内核跑了，而且跑得很远（MMU 都开了），但为什么串口还是沉默的？

**第三步：读内核日志缓冲区——就算嘴巴哑了，"脑子里的想法"还在。**

老王教了我一个关键技巧：`printk()` 的核心落点是内核日志缓冲区（`log_buf`）；控制台驱动再决定哪些日志被立即输出到串口或其他控制台。因此，**即使串口控制台初始化失败，内存中的日志缓冲区往往仍保留着关键线索**——只是没有输出通道而已。

我们用 JTAG 直接读日志缓冲区。由于内核已开启 MMU，所有地址都是虚拟地址——好在现代 JTAG 调试器（如 OpenOCD + J-Link）支持读取 CPU 的 `TTBR1_EL1`（内核页表基址寄存器），自动完成虚拟地址到物理地址的翻译。老王用内核自带的 GDB 扩展脚本导出了完整的 `dmesg` 日志：

> 💡 **前提条件**：下面的方法假设内核未启用 KASLR（内核地址空间随机化），或你已拿到运行时有效的符号地址。启用 KASLR 后，`vmlinux` 中的静态地址与实际运行时地址存在随机偏移，需先通过 JTAG 确定偏移量。

```bash
(gdb) # 加载内核 GDB 扩展脚本（内核源码自带）
(gdb) source vmlinux-gdb.py
(gdb) lx-dmesg
[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd083]
[    0.000000] Linux version 6.1.80
[    0.000000] Machine model: IoT Gateway Board v2 (A53)
[    0.000000] earlycon: uart0 at MMIO 0x01c28000 (options '115200n8')
[    0.000000] OF: fdt: Machine model: IoT Gateway Board v2 (A53)
[    0.000000] Memory: 1012345K/1048576K available
......
[    0.527000] Serial: 8250/16550 driver, 4 ports, IRQ sharing disabled
[    0.533000] 1c28000.serial: ttyS0 at MMIO 0x1c28000 (irq = 30) is a 16550A
[    0.535000] Unhandled fault at 0x1c28000: synchronous external abort (0x96000010)
[    0.535001] Internal error: : 96000010 [#1] PREEMPT SMP
[    0.535002] Kernel panic - not syncing: Fatal exception
```

> 💡 **实战注脚**：为了教学展示清晰，以上 GDB 交互做了简化。在真实的 Linux 5.10+ 版本中，`printk` 已重构为无锁环形队列（`printk_ringbuffer`），内存布局不再是简单的连续字符串。实际排障时需借助内核 GDB Python 扩展宏 `lx-dmesg` 来导出完整日志（如上所示），而不能直接用 `x/s` 盲读内存地址。

**找到了！** 最后三行是致命线索：

1. **`1c28000.serial: ttyS0 at MMIO 0x1c28000 ... is a 16550A`** —— 内核试图在地址 `0x1c28000` 初始化一个 16550 兼容串口
2. **`Unhandled fault at 0x1c28000: synchronous external abort`** —— 但那个地址在新板上什么都没有！CPU 通过总线去访问 `0x1c28000`，没有任何外设应答，总线控制器报回了 **DECERR**（Decode Error），触发了同步外部异常（Synchronous External Abort）
3. **`Kernel panic - not syncing: Fatal exception`** —— 内核直接崩溃了

> 💡 **ARM vs x86 的关键差异**：在 x86 的 PCI 总线上，读未映射设备通常会默默返回 `0xFFFFFFFF`。但在 ARM 架构的 AMBA 总线上，行为是**实现定义的**（implementation-defined）——有些 SoC 会像 x86 一样"安静失败"，但更多现代 SoC 会让总线返回错误信号（DECERR/SLVERR），触发 CPU 的 Data Abort 或 SError 异常，导致内核 panic。我们的新板就属于后者。

内核在地址 `0x1c28000` 去初始化串口——但这是**旧板**的串口地址。新板的串口在哪？

#### 💥 定位真凶

**内核怎么知道串口在 `0x1c28000` 的？** 它不是硬编码的，而是来自 **设备树（Device Tree Blob, `.dtb`）**——一个和内核镜像一起放在 SD 卡上的二进制配置文件，告诉内核"这块板子上有什么硬件、每个硬件在哪个地址"。

我把 SD 卡插回电脑，挂载 boot 分区，用 `dtc`（设备树编译器）反编译 `.dtb`：

```bash
$ sudo mount /dev/sdb1 /mnt/sdcard
$ ls /mnt/sdcard/
Image  board.dtb  extlinux/

$ dtc -I dtb -O dts /mnt/sdcard/board.dtb > old-board.dts
$ grep -A8 "serial@" old-board.dts
```

```dts
serial@1c28000 {
    compatible = "snps,dw-apb-uart";
    reg = <0x00 0x1c28000 0x00 0x400>;
    interrupts = <0x00 0x00 0x04>;
    reg-shift = <2>;
    reg-io-width = <4>;
    clock-frequency = <0x16e3600>;   /* 24 MHz */
    status = "okay";
};
```

然后我翻开新板的硬件参考手册（PDF 第 347 页，UART 章节），对照着看：

```
  SD 卡中的设备树（旧板配置）：           新板硬件手册上写的实际配置：

  serial@1c28000 {                       Chapter 12: UART Controller
      compatible =                         Type: ARM PL011 PrimeCell
        "snps,dw-apb-uart";                Base Address: 0x0900_0000
      reg = <0x1c28000 0x400>;             Register Span: 0x1000
      clock-frequency = <24MHz>;           IRQ: SPI #1
  };                                       Clock: 48 MHz (from PCLK)

  ┌─────────────────────────────────────────────────────────────┐
  │  Synopsys DesignWare 16550        ARM PrimCell PL011        │
  │  TX Data Register: offset 0x00    Data Register: offset 0x00│
  │  Line Status Reg:  offset 0x14    Flag Register: offset 0x18│
  │  FIFO 深度: 64 bytes              FIFO 深度: 16 bytes       │
  │  Linux 驱动: 8250/16550           Linux 驱动: amba-pl011    │
  │                                                             │
  │        完全不同的 IP 核！地址、寄存器、驱动全不一样           │
  └─────────────────────────────────────────────────────────────┘
```

真相大白：旧板用的是 **Synopsys DesignWare UART**（16550 兼容，地址 `0x1c28000`），新板用的是 **ARM PL011**（地址 `0x09000000`）。它们是**两个完全不同的硬件 IP 核**——不仅基地址不同，控制寄存器的偏移量、操作方式、对应的 Linux 驱动都不一样。

内核拿着旧板的设备树，跑到地址 `0x1c28000` 去操作一个不存在的设备。ARM 总线对此不留情面——直接报错，CPU 触发同步外部异常，内核 panic。**内核不仅哑了，而且直接暴毙了。**

**在 ARM 的世界里，同一个内核镜像可以跑在一万种板子上，但每块板子必须有自己的"硬件说明书"——设备树（DTB）。** 把旧板的说明书给新板，就像拿着北京的地铁图在上海找地铁站。

#### 🛡️ 补丁

修复分三步。

**第一步**：基于旧板的 `.dts`，修改串口节点适配新板硬件：

```diff
-   serial@1c28000 {
-       compatible = "snps,dw-apb-uart";
-       reg = <0x00 0x1c28000 0x00 0x400>;
-       interrupts = <0x00 0x00 0x04>;
-       reg-shift = <2>;
-       reg-io-width = <4>;
-       clock-frequency = <0x16e3600>;
+   serial@9000000 {
+       compatible = "arm,pl011", "arm,primecell";
+       reg = <0x00 0x9000000 0x00 0x1000>;
+       interrupts = <0x00 0x01 0x04>;
+       clocks = <&pclk>;
+       clock-names = "apb_pclk";
    };
```

（实际工作中不止串口——内存控制器、中断控制器、GPIO 等节点全都要对照新板手册修改。这里为了聚焦只展示串口。）

**第二步**：编译新设备树，替换到 SD 卡：

```bash
$ dtc -I dts -O dtb -o new-board.dtb new-board.dts
$ sudo mount /dev/sdb1 /mnt/sdcard
$ sudo cp new-board.dtb /mnt/sdcard/board.dtb
$ sudo sync && sudo umount /mnt/sdcard
```

**第三步**：SD 卡插回新板，上电，盯着 picocom：

```
$ picocom -b 115200 /dev/ttyUSB0
Terminal ready

U-Boot 2024.01 (Board v3 - A72)

DRAM:  2 GiB
Loading Environment from FAT... OK
## Reading Image from mmc 0:1 to 0x40200000 ... OK
## Reading board.dtb from mmc 0:1 to 0x48000000 ... OK
   Booting using the fdt blob at 0x48000000
   Loading Device Tree to 0000000049ff8000, end 0000000049fff892 ... OK

Starting kernel ...

[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd083]
[    0.000000] Linux version 6.1.80 (builder@ci) (aarch64-linux-gnu-gcc 12.2)
[    0.000000] Machine model: IoT Gateway Board v3 (A72)
[    0.532000] Serial: AMBA PL011 UART driver
[    0.536000] 9000000.serial: ttyAMA0 at MMIO 0x9000000 (irq = 36) is a PL011 rev3
[    0.540000] printk: console [ttyAMA0] enabled
...
[    2.103000] Run /sbin/init as init process

Welcome to Alpine Linux 3.19
gateway login: _
```

**终于！** 同一个内核镜像，只换了一个 12KB 的 `.dtb` 文件，新板就活了。（当然，这次案例里导致"串口沉默"的直接原因是 DTB 中串口节点的错配。在真实板级迁移中，如果两块板子的 GIC 版本、CPU 拓扑、时钟树等也不同，DTB 只是适配工作的一部分，可能还需要修改更多设备树节点甚至内核配置。）

注意日志中的关键对比——同一个内核，根据设备树自动选择了完全不同的硬件驱动：

```
  旧板日志：                                新板日志（修复后）：

  Serial: 8250/16550 driver               Serial: AMBA PL011 UART driver
  1c28000.serial: ttyS0 at MMIO           9000000.serial: ttyAMA0 at MMIO
    0x1c28000 ... is a 16550A               0x9000000 ... is a PL011 rev3
  console [ttyS0] enabled                 console [ttyAMA0] enabled
```

一个是 16550 驱动配 `ttyS0`，一个是 PL011 驱动配 `ttyAMA0`。设备树就是这样把"通用内核"和"特定硬件"粘合在一起的。

这件事引发了我更深的思考：这条"从上电到 Shell"的链路上，到底有多少个环节？每个环节做了什么？

#### 🔬 深入：内核如何拿到硬件信息？

x86 有 BIOS/ACPI 告诉内核硬件配置。ARM64 最常见的硬件描述方式是 **设备树（Device Tree Blob, DTB）**—— 一个二进制数据结构，描述了板上的每一个设备（某些 ARM64 服务器平台也使用 ACPI，但嵌入式领域几乎全是设备树）：

```dts
// 设备树源文件（DTS）示例：描述一个 ARM64 系统
/ {
    compatible = "my,board";
    #address-cells = <2>;
    #size-cells = <2>;

    cpus {
        cpu@0 {
            device_type = "cpu";
            compatible = "arm,cortex-a72";
            reg = <0x0 0x0>;
        };
    };

    memory@40000000 {
        device_type = "memory";
        reg = <0x0 0x40000000 0x0 0x40000000>;  // 1GB @ 0x40000000
    };

    uart0: serial@9000000 {
        compatible = "arm,pl011";
        reg = <0x0 0x9000000 0x0 0x1000>;
        interrupts = <0 1 4>;
    };
};
```

引导加载器（U-Boot）将 DTB 加载到内存，然后把 DTB 的物理地址通过 **x0 寄存器** 传给内核。内核启动的第一件事就是解析这个设备树，得知系统上有什么 CPU、多少内存、串口在哪……

```
  ARM64 Linux 内核入口约定：

  x0 = DTB 的物理地址          ← "硬件说明书"
  x1 = 0  (reserved)
  x2 = 0  (reserved)
  x3 = 0  (reserved)
  
  PC = 内核 Image 的加载地址    ← 执行从这里开始
  当前特权级 = EL2（推荐）或 EL1（也合法）
  MMU = 关闭
  D-cache = 关闭或无效
```

这就是 ARM64 上"从上电到内核"的完整故事——也是我们在旧板到新板迁移中走穿的每一层。

#### 💡 战后总结

1. **"同一个内核"不等于"同一份配置"**：ARM 生态的碎片化意味着每块板子的外设地址、中断号、时钟频率都可能不同。内核是通用的，设备树是板级的——搞混了就是 panic。我们这次踩的坑，每个 ARM 嵌入式工程师都踩过

2. **ARM64 vs x86 启动：截然不同的哲学**：x86 从 16 位实模式一路爬到 64 位长模式，背负沉重的历史包袱（BIOS/UEFI/ACPI 帮你屏蔽了硬件差异）。ARM64 一上电就是 64 位，没有实模式概念，但硬件差异完全暴露给软件——设备树就是解决方案

3. **异常级别是嵌套的保护环**：EL3 > EL2 > EL1 > EL0，每一级都限制了下一级能做的事。我们借助 JTAG 这类外部硬件调试接口，在串口完全无输出时直接读取 CPU 寄存器和内存，最终把问题定位到内核/设备树这一层——理解异常级别层次和执行阶段是调试的前提

4. **理解启动流程 = 理解整个系统栈**：从固件初始化硬件、引导加载器找到内核、内核设置虚拟内存和驱动、到 init 进程启动用户空间——这就是操作系统课程所有知识点的一次端到端串联。一个 `.dtb` 文件的错误就能让整条链断裂

---

## 🧪 动手实践

### 实验环境

- Linux（推荐 Ubuntu 22.04 或 WSL2）
- QEMU：`sudo apt install qemu-system-aarch64`
- 交叉编译工具链：`sudo apt install gcc-aarch64-linux-gnu`
- 设备树编译器：`sudo apt install device-tree-compiler`
- GDB：`sudo apt install gdb-multiarch`

### 实验步骤

#### 步骤 1：裸机 "Hello World" —— 在 QEMU ARM64 上输出第一个字符

我们不用任何操作系统，直接写汇编，让 ARM64 CPU 向串口吐出一个字符。这是对启动流程最原始的理解。

创建文件 `boot.S`：

```asm
// boot.S — ARM64 裸机 Hello World
// 目标：向 QEMU virt 平台的 PL011 串口输出 "Hello ARM64!\n"

.section .text
.global _start

_start:
    // QEMU virt 平台的 PL011 UART 基地址是 0x09000000
    ldr     x1, =0x09000000

    // 加载字符串地址
    adr     x2, hello_msg
    ldrb    w3, [x2]          // 加载第一个字节

print_loop:
    cbz     w3, halt           // 如果字符为 0（字符串结束），跳转到 halt

    // 等待 UART 就绪（检查 Flag Register 的 TXFF 位）
    ldr     x4, =0x09000018    // UART Flag Register 地址
wait_tx:
    ldr     w5, [x4]
    tbnz    w5, #5, wait_tx    // 如果 TXFF (bit 5) = 1，TX FIFO 满，继续等

    // 写字符到 UART 数据寄存器
    strb    w3, [x1]           // 把字符写到 UART Data Register

    add     x2, x2, #1        // 指针前移
    ldrb    w3, [x2]          // 加载下一个字节
    b       print_loop         // 继续循环

halt:
    // 打印完毕，用 WFI 让 CPU 休眠
    wfi
    b       halt

.section .rodata
hello_msg:
    .asciz "Hello ARM64! Boot from bare metal.\n"
```

创建链接脚本 `boot.ld`：

```ld
/* boot.ld — 链接脚本，告诉链接器代码放在哪个地址 */
ENTRY(_start)

SECTIONS
{
    /* QEMU virt 平台从 0x40000000 开始加载 */
    . = 0x40000000;

    .text : {
        *(.text)
    }

    .rodata : {
        *(.rodata)
    }

    .data : {
        *(.data)
    }

    .bss : {
        *(.bss)
    }
}
```

编译并运行：

```bash
# 交叉编译（直接生成 ELF，QEMU 原生支持 ELF 格式加载）
aarch64-linux-gnu-as -o boot.o boot.S
aarch64-linux-gnu-ld -T boot.ld -o boot.elf boot.o

# 在 QEMU 中运行（-M virt 是 QEMU 的通用 ARM64 虚拟板）
# 注意：直接加载 .elf 而非 .bin，QEMU 会严格按照 ELF 头中的地址加载
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 128M \
    -nographic \
    -kernel boot.elf

# 你应该看到：Hello ARM64! Boot from bare metal.
# 退出 QEMU：Ctrl+A 然后按 X
```

> 📌 **关键观察**：你刚才做的事等价于启动链中第 ① 步——CPU 复位后从固定地址取第一条指令并执行。QEMU 的 `-kernel` 选项帮你把代码加载到了链接脚本指定的 `0x40000000`。你没有操作系统、没有 C 库、没有 printf——只是直接往硬件寄存器里写字节。
>
> 💡 **为什么用 ELF 而不是 raw binary？** 如果你用 `objcopy -O binary` 生成纯 `.bin` 再加载，QEMU 对 AArch64 的 raw binary 会按 Linux Image 的惯例施加额外的加载偏移（`0x80000`），导致实际加载地址与链接脚本不一致。直接用 ELF 文件，QEMU 会严格遵守 ELF 程序头中的地址，与你的链接脚本完全吻合。

#### 步骤 2：用 GDB 观察 CPU 复位后的状态

重新启动 QEMU，这次加上 GDB 调试选项：

```bash
# 终端 1：启动 QEMU 并等待 GDB 连接
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 128M \
    -nographic \
    -kernel boot.elf \
    -S -s  # -S: 启动后暂停  -s: 在端口 1234 上启动 GDB server
```

```bash
# 终端 2：用 GDB 连接
gdb-multiarch boot.elf
(gdb) target remote :1234
(gdb) info registers                  # 查看所有寄存器初始值
(gdb) print/x $CurrentEL              # 查看当前异常级别
(gdb) stepi                           # 单步执行一条指令
(gdb) x/10i $pc                       # 查看 PC 附近的 10 条指令
(gdb) watch *0x09000000               # 在 UART 数据寄存器上设置观察点
(gdb) continue                        # 继续运行，观察字符输出
```

> 📌 **关键观察**：
> - `CurrentEL` 的值揭示了 CPU 当前运行在哪个异常级别（QEMU virt 默认从 EL1 启动内核）
> - 单步执行时，你可以看到每条 ARM64 指令如何操作寄存器
> - 观察 `x1`（UART 基地址）和 `w3`（当前字符），理解"往地址写字节 = 让串口发字符"这一 MMIO（Memory-Mapped I/O）机制

#### 步骤 3：编写设备树，引导真正的 Linux 内核

现在我们来走完整条启动链：用 QEMU 引导一个真正的 ARM64 Linux 内核。

**3a. 获取预编译的 ARM64 内核和 initrd**

```bash
# 下载 Debian 提供的预编译 ARM64 内核和 initrd（适用于任何 x86 宿主机）
wget http://ftp.debian.org/debian/dists/bookworm/main/installer-arm64/current/images/netboot/debian-installer/arm64/linux
wget http://ftp.debian.org/debian/dists/bookworm/main/installer-arm64/current/images/netboot/debian-installer/arm64/initrd.gz
```

**3b. 查看 QEMU virt 平台自动生成的设备树**

```bash
# QEMU 可以导出自己的设备树！
qemu-system-aarch64 \
    -M virt,dumpdtb=virt.dtb -cpu cortex-a72 -m 256M \
    -nographic

# 反编译成可读的 DTS 格式
dtc -I dtb -O dts -o virt.dts virt.dtb
cat virt.dts
```

> 📌 **关键观察**：打开 `virt.dts`，找到以下关键节点：
> - `cpus { cpu@0 { ... } }` —— 描述了 CPU 型号和数量
> - `memory@40000000 { ... }` —— 描述了内存的起始地址和大小
> - `pl011@9000000 { ... }` —— 这就是我们在步骤 1 中用的串口！地址 `0x9000000` 对上了
> - `chosen { stdout-path = "/pl011@9000000" }` —— 告诉内核用哪个设备做控制台

**3c. 启动完整的 Linux 内核**

```bash
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 512M -smp 2 \
    -nographic \
    -kernel linux \
    -initrd initrd.gz \
    -append "console=ttyAMA0 earlycon"
```

> 📌 **关键观察**：
> - 内核启动日志中搜索 `"Booting Linux on physical CPU"` —— 内核从 EL2 或 EL1 开始执行
> - 搜索 `"OF: fdt:"` —— 内核正在解析设备树（Open Firmware / Flattened Device Tree）
> - 搜索 `"Serial: AMBA PL011 UART"` —— 内核根据设备树找到了串口驱动
> - 搜索 `"Run /init"` —— 内核完成初始化，跳转到用户空间  
> - 对比你在步骤 1 中手写 UART 地址 `0x09000000` 和设备树中的串口节点——它们是同一个设备！

#### 步骤 4：破坏实验 —— 复现案例中的故障

这是最有趣的部分——用 QEMU 复现我们在新板上遇到的问题！

**4a. 改错串口地址——复现"串口沉默"**

```bash
# 编辑 virt.dts，把 pl011 的地址改成一个不存在的地址
cp virt.dts virt_broken_uart.dts
sed -i 's/0x9000000/0xDEAD000/g' virt_broken_uart.dts

# 重新编译设备树
dtc -I dts -O dtb -o virt_broken.dtb virt_broken_uart.dts

# 用错误的设备树启动（加 earlycon 硬编码正确地址，观察断裂点）
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 512M \
    -nographic \
    -kernel linux \
    -dtb virt_broken.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000"
```

> 📌 **关键观察**：
> - `earlycon=pl011,0x9000000` 是硬编码的早期控制台地址（绕过设备树），所以你仍能看到早期启动日志
> - 但一旦内核切换到设备树驱动的串口驱动，输出会消失——因为驱动去了错误的地址 `0xDEAD000` 找串口
> - **这就是我们在新板上看到的症状！** earlycon 能输出的那几行日志，正好对应"CPU 活着但串口驱动坏了"的阶段

**4b. 破坏驱动匹配——让内核"认不出"串口**

```bash
# 编辑 virt.dts，把串口的 compatible 属性故意拼错
cp virt.dts virt_broken_driver.dts
sed -i 's/"arm,pl011"/"arm,pl011-does-not-exist"/g' virt_broken_driver.dts

# 重新编译设备树
dtc -I dts -O dtb -o virt_broken_driver.dtb virt_broken_driver.dts

# 用错误的设备树启动
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 512M \
    -nographic \
    -kernel linux \
    -dtb virt_broken_driver.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000"
```

> 📌 **关键观察**：内核的设备驱动通过 `compatible` 字符串来匹配设备。PL011 驱动在内核里注册了 `"arm,pl011"` 这个匹配字符串。当你把设备树里的 `compatible` 改成 `"arm,pl011-does-not-exist"` 后，没有任何驱动能匹配这个设备——串口硬件依然在 `0x9000000`，但内核根本不会为它加载驱动。
>
> 💡 **为什么不演示改内存大小？** 你可能想试试把 `/memory` 节点的大小改成 1MB。但 QEMU 有一个隐藏行为：启动前它会根据命令行的 `-m 512M` 参数**强行覆盖**设备树中的 `/memory` 节点！你改的 1MB 会被默默复原为 512MB，内核照样完美启动——这会让你陷入自我怀疑。所以我们选择破坏 QEMU 不会自动修复的 `compatible` 属性。

### 实验总结表

| 步骤 | 你做了什么 | 对应启动链 | 核心知识点 |
|------|-----------|-----------|-----------|
| 步骤 1 | 裸机汇编直接写 UART | BL1/固件阶段 | MMIO、ARM64 汇编基础 |
| 步骤 2 | GDB 观察 CPU 初始状态 | CPU 复位 | 异常级别、寄存器 |
| 步骤 3 | 导出/阅读设备树 + 启动 Linux | U-Boot → 内核 | 设备树、内核入口约定 |
| 步骤 4 | 故意破坏设备树 | 全链路调试 | 启动失败诊断 |

### 思考题

1. 为什么 ARM64 需要 EL0-EL3 四个异常级别，而 x86 的 Ring 0-3 中实际只使用了 Ring 0 和 Ring 3？多出来的层次解决了什么问题？
2. 在步骤 1 的汇编中，我们把字符直接写到地址 `0x09000000` 就能让串口输出。这是 MMIO（Memory-Mapped I/O）机制——CPU 把设备寄存器映射到物理地址空间。x86 还有一种叫 PMIO（Port-Mapped I/O，用 `in`/`out` 指令）的方式。ARM64 为什么只使用 MMIO？
3. 如果你要让同一个 Linux 内核镜像在两块完全不同的 ARM64 板子上启动（不同的串口、不同的网卡、不同的内存布局），你只需要更换什么文件？为什么这种设计比"在内核里硬编码硬件信息"更好？
4. （进阶）在步骤 3 中，QEMU 用 `-kernel` 选项直接加载了内核镜像。在真实的开发板上，U-Boot 是如何找到内核镜像并加载它的？提示：U-Boot 环境变量 `bootcmd`。

---

> **📚 延伸阅读**
> - ARM Architecture Reference Manual (ARMv8-A): D1 - The AArch64 Exception Level
> - Devicetree Specification: https://www.devicetree.org/specifications/
> - ARM Trusted Firmware (TF-A) 文档: https://trustedfirmware-a.readthedocs.io/
> - 前置案例：本书 Case 18（Xen — 虚拟化/特权级）

---

> 📌 **回溯关联**：本案例与 **Case 18（Xen）** 直接相关——Xen 利用 x86 的 Ring 0/1/3 实现虚拟化，而 ARM64 的 EL2 **天生就是为 Hypervisor 设计的**。与 **Case 7（虚拟内存/Page Fault）** 也有关联——内核启动过程中的关键一步就是设置页表（`TTBR0_EL1` / `TTBR1_EL1`）并打开 MMU，从物理地址模式切换到虚拟地址模式。**理解启动流程，就是把 OS 课上学的所有独立知识点串成一条完整的链。**
