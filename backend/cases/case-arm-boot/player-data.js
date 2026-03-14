/**
 * player-data.js — Case 19: 同一个内核，两块板子 — 解剖 ARM64 启动流程
 * 由 interactive-player SKILL 按照 arm64_boot.md 生成
 */
const PLAYER_CONFIG = {
  title: "同一个内核，两块板子：解剖 ARM64 启动流程",
  subtitle: "嵌入式内核排障全真模拟推演。<br>跟随资深工程师的视角，一步步揭发底层系统命案真相。",
  splashImage: "hardware_setup.png",

  steps: [
    {
      title: "📅 故事背景：新板上电，内核沉默",
      terminal: {
        prompt: "$ ", command: "picocom -b 115200 /dev/ttyUSB0",
        output: "picocom v3.1\nport is        : /dev/ttyUSB0\nbaudrate is    : 115200\nTerminal ready\n\nU-Boot 2024.01 (Board v3 - A72)\n\nDRAM:  2 GiB\nMMC:   mmc@fe320000: 0\nLoading Environment from FAT... OK\n## Reading Image from mmc 0:1 to 0x40200000 ... OK\n## Reading board.dtb from mmc 0:1 to 0x48000000 ... OK\n   Booting using the fdt blob at 0x48000000\n\nStarting kernel ...\n\n(光标停在这里……等待 60 秒，再无输出)"
      },
      commentary: `<p><strong>场景：</strong>团队的 IoT 网关产品一直跑在 <span class="chat-link">Cortex-A53</span> 板子上（代号"旧板"），稳得一匹。硬件组换了供应商，来了新的 <span class="chat-link">Cortex-A72</span> 板子（代号"新板"）。主管说："内核是通用的 ARM64，直接把旧板的 SD 卡插过去就行。"</p>
<p class="warning">🔥 SD 卡插上新板，U-Boot 正常启动。但 <code>Starting kernel ...</code> 之后——光标停住了，等了 60 秒，没有一行内核日志。</p>
<p>把同一张 SD 卡拔回旧板，4 秒完美启动。反复三次，结果一样：<strong>同一个内核、同一个 rootfs、同一张 SD 卡</strong>。差异出在 <code>Starting kernel ...</code> 之后——内核拿到了控制权，但不说话了。</p>`
    },
    {
      title: "🔦 排除物理层 + 请出 JTAG",
      terminal: {
        prompt: "$ ", command: "openocd -f interface/jlink.cfg -f target/aarch64.cfg",
        output: "Open On-Chip Debugger 0.12.0\nLicensed under GNU GPL v2\nInfo : J-Link V11 connected\nInfo : JTAG tap: aarch64.cpu tap/device found: 0x4ba00477\nInfo : aarch64.cpu: hardware has 6 breakpoints, 4 watchpoints\nInfo : starting gdb server for aarch64.cpu on port 3333\nInfo : Listening on port 3333 for gdb connections"
      },
      commentary: `<p>串口线接错了？不可能——U-Boot 阶段就有输出。波特率错了？也不可能——U-Boot 和内核用同一个 115200。</p>
<p class="thinking"><code>Starting kernel ...</code> 之后串口沉默 ≠ 内核挂了。也可能是串口驱动初始化失败，内核"说不出话来"。需要<strong>不依赖串口</strong>的调试手段——<span class="chat-link">JTAG</span> 调试器。</p>
<p class="insight">💡 串口是 CPU"主动说话"——得内核初始化串口驱动后才能输出。<br>
JTAG 是我们"强行读心"——不需要目标系统有任何软件支持，直接通过硬件调试接口读写 CPU 寄存器和内存。即使串口一片漆黑，JTAG 照样能看到 CPU 在干什么。</p>`
    },
    {
      title: "🔍 GDB 连上：CPU 还活着！",
      terminal: {
        prompt: "(gdb) ", command: "target remote :3333\ninfo reg pc cpsr\np/x $CurrentEL",
        output: "Remote debugging using :3333\n0xffff800008084a20 in ?? ()\n\npc             0xffff800008084a20  0xffff800008084a20\ncpsr           0x600003c5          1610613701\n\n$1 = 0x4"
      },
      commentary: `<p class="dialogue"><span class="speaker">老王看了一眼就说：</span>"<code>CurrentEL = 0x4</code>，说明 CPU 运行在 <span class="chat-link">EL1</span>。再看 PC 在 <code>0xffff800008084a20</code>——这是内核的虚拟地址空间，不仅进了内核，而且 MMU 都开了，跑得很远了。"</p>
<p class="insight">💡 <b>为什么 0x4 = EL1？</b> ARM64 系统寄存器 <code>CurrentEL</code> 的异常级别存储在 Bit[3:2]。EL1 = 二进制 <code>01</code>，左移两位就是 <code>0x4</code>。</p>
<p>ARM64 CPU 有四个特权等级：<br>
<code>EL3</code>: Secure Monitor（最高特权，TrustZone）<br>
<code>EL2</code>: Hypervisor（虚拟化层）<br>
<code>EL1</code>: OS Kernel ← <strong>CPU 现在在这里！</strong><br>
<code>EL0</code>: User Application</p>
<p>PC 处于 <code>0xffff...</code> 高位地址 = MMU 已开启 = 内核早已进入 C 语言执行阶段。只是串口看不到任何输出。</p>`
    },
    {
      title: "📋 启动链分析：哪一步出了问题？",
      terminal: null,
      commentary: `<p>结合 <span class="chat-link">EL1</span> + 虚拟地址 PC 可以判断前四步都成功了：</p>
<p>
<strong>① ROM 固件（BL1）[EL3]</strong> ✅ 通过<br>
<strong>② 可信固件（BL2）[EL3]</strong> ✅ 通过（DRAM 初始化成功）<br>
<strong>③ EL3 Runtime [EL3]</strong> ✅ 通过（降级到 EL2）<br>
<strong>④ U-Boot [EL2/EL1]</strong> ✅ 通过（加载了内核和 DTB，串口有输出）<br>
<strong>⑤ Linux 内核 [EL1]</strong> ← CPU 在这里，MMU 已开启，但串口没输出<br>
<strong>⑥ 用户空间</strong> ← 还没到这里</p>
<p class="thinking">内核跑了而且跑得很远（MMU 都开了），但为什么串口还是沉默的？就算嘴巴哑了，"脑子里的想法"还在——<code>printk()</code> 的核心落点是内核日志缓冲区（<code>log_buf</code>），即使串口控制台初始化失败，内存中的日志仍保留着关键线索。</p>`
    },
    {
      title: "💣 内核日志缓冲区：真相浮出水面",
      terminal: {
        prompt: "(gdb) ", command: "source vmlinux-gdb.py\nlx-dmesg",
        output: "[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd083]\n[    0.000000] Linux version 6.1.80\n[    0.000000] Machine model: IoT Gateway Board v2 (A53)\n[    0.000000] earlycon: uart0 at MMIO 0x01c28000 (options '115200n8')\n...\n[    0.527000] Serial: 8250/16550 driver, 4 ports, IRQ sharing disabled\n[    0.533000] 1c28000.serial: ttyS0 at MMIO 0x1c28000 (irq = 30) is a 16550A\n[    0.535000] Unhandled fault at 0x1c28000: synchronous external abort (0x96000010)\n[    0.535001] Internal error: : 96000010 [#1] PREEMPT SMP\n[    0.535002] Kernel panic - not syncing: Fatal exception"
      },
      commentary: `<p>用 JTAG 直接读日志缓冲区——通过内核 GDB 扩展脚本 <code>lx-dmesg</code> 导出完整日志。</p>
<p class="warning">🔥 <strong>找到了！最后三行是致命线索：</strong><br>
1. 内核试图在地址 <code>0x1c28000</code> 初始化一个 16550 兼容串口<br>
2. 但那个地址在新板上什么都没有！CPU 通过总线去访问，没有外设应答，触发 <strong>Synchronous External Abort</strong><br>
3. 内核直接 <strong>panic</strong>——不仅哑了，而且暴毙了！</p>
<p class="insight">💡 <b>ARM vs x86 的关键差异：</b>在 x86 的 PCI 总线上，读未映射设备通常默默返回 <code>0xFFFFFFFF</code>。但在 ARM 的 AMBA 总线上，更多现代 SoC 会返回错误信号（DECERR），触发 CPU 的 Data Abort 异常，导致内核 panic。</p>`
    },
    {
      title: "💥 定位真凶：设备树不匹配",
      terminal: {
        prompt: "$ ", command: "dtc -I dtb -O dts /mnt/sdcard/board.dtb > old-board.dts\n$ grep -A8 \"serial@\" old-board.dts",
        output: "serial@1c28000 {\n    compatible = \"snps,dw-apb-uart\";\n    reg = <0x00 0x1c28000 0x00 0x400>;\n    interrupts = <0x00 0x00 0x04>;\n    reg-shift = <2>;\n    reg-io-width = <4>;\n    clock-frequency = <0x16e3600>;   /* 24 MHz */\n    status = \"okay\";\n};"
      },
      commentary: `<p>内核怎么知道串口在 <code>0x1c28000</code>？来自<strong>设备树（<span class="chat-link">DTB</span>）</strong>——和内核一起放在 SD 卡上的二进制配置文件。</p>
<p class="conclusion">🎯 <strong>真相大白：</strong><br>
旧板用 <strong>Synopsys DesignWare UART</strong>（16550 兼容，地址 <code>0x1c28000</code>）<br>
新板用 <strong>ARM PL011</strong>（地址 <code>0x09000000</code>）<br>
它们是<strong>两个完全不同的硬件 IP 核</strong>——不仅基地址不同，寄存器布局、操作方式、Linux 驱动都不一样。</p>
<p class="thinking">内核拿着旧板的设备树，跑到地址 <code>0x1c28000</code> 去操作一个不存在的设备。ARM 总线不留情面——直接报错，CPU 触发同步外部异常，内核 panic。</p>
<p><strong>在 ARM 的世界里，同一个内核镜像可以跑在一万种板子上，但每块板子必须有自己的"硬件说明书"——设备树。</strong></p>`
    },
    {
      title: "✍️ 修复：编写新板设备树",
      terminal: {
        prompt: "$ ", command: "dtc -I dts -O dtb -o new-board.dtb new-board.dts\n$ sudo cp new-board.dtb /mnt/sdcard/board.dtb\n$ sudo sync && sudo umount /mnt/sdcard",
        output: ""
      },
      commentary: `<p>修复分三步：</p>
<p><strong>① 修改串口节点</strong>（对照新板硬件手册）：</p>
<p><code>-  serial@1c28000 { compatible = "snps,dw-apb-uart"; ... }</code><br>
<code>+  serial@9000000 { compatible = "arm,pl011", "arm,primecell"; ... }</code></p>
<p><strong>② 编译新设备树</strong>：<code>dtc -I dts -O dtb</code></p>
<p><strong>③ 替换到 SD 卡</strong></p>
<p class="thinking">实际工作中不止串口——内存控制器、中断控制器、GPIO 等节点全都要对照新板手册修改。这里聚焦串口作为演示。</p>`
    },
    {
      title: "🚀 新板复活！",
      terminal: {
        prompt: "$ ", command: "picocom -b 115200 /dev/ttyUSB0",
        output: "Terminal ready\n\nU-Boot 2024.01 (Board v3 - A72)\n\nDRAM:  2 GiB\nStarting kernel ...\n\n[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd083]\n[    0.000000] Linux version 6.1.80\n[    0.000000] Machine model: IoT Gateway Board v3 (A72)\n[    0.532000] Serial: AMBA PL011 UART driver\n[    0.536000] 9000000.serial: ttyAMA0 at MMIO 0x9000000 (irq = 36) is a PL011 rev3\n[    0.540000] printk: console [ttyAMA0] enabled\n...\n[    2.103000] Run /sbin/init as init process\n\nWelcome to Alpine Linux 3.19\ngateway login: _"
      },
      commentary: `<p class="conclusion">🎯 <strong>终于！</strong>同一个内核镜像，只换了一个 12KB 的 <code>.dtb</code> 文件，新板就活了。</p>
<p>注意日志中的关键对比——同一个内核，根据设备树自动选择了完全不同的硬件驱动：</p>
<p>旧板：<code>Serial: 8250/16550 driver</code> → <code>ttyS0 at MMIO 0x1c28000</code><br>
新板：<code>Serial: AMBA PL011 UART driver</code> → <code>ttyAMA0 at MMIO 0x9000000</code></p>
<p>一个是 16550 驱动配 <code>ttyS0</code>，一个是 PL011 驱动配 <code>ttyAMA0</code>。<strong>设备树就是这样把"通用内核"和"特定硬件"粘合在一起的。</strong></p>`
    },
    {
      title: "🔬 深入：设备树与内核入口约定",
      terminal: null,
      commentary: `<p>x86 有 BIOS/ACPI 告诉内核硬件配置。ARM64 用<strong>设备树（<span class="chat-link">DTB</span>）</strong>——一个二进制数据结构，描述板上的每个设备。</p>
<p>引导加载器（U-Boot）将 DTB 加载到内存，然后把 DTB 的物理地址通过 <strong>x0 寄存器</strong> 传给内核：</p>
<p class="insight">💡 <b>ARM64 Linux 内核入口约定</b>：<br>
<code>x0</code> = DTB 的物理地址 ← "硬件说明书"<br>
<code>x1~x3</code> = 0 (reserved)<br>
<code>PC</code> = 内核 Image 的加载地址<br>
当前特权级 = <span class="chat-link">EL2</span>（推荐）或 EL1<br>
MMU = 关闭，D-cache = 关闭</p>
<p>这就是 ARM64 上"从上电到内核"的完整故事。</p>`
    },
    {
      title: "💡 战后总结",
      terminal: null,
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>"同一个内核"≠"同一份配置"</strong> — ARM 生态碎片化意味着每块板子的外设地址、中断号、时钟频率都可能不同。内核是通用的，<span class="chat-link">设备树</span>是板级的——搞混了就是 panic<br>
2. <strong>ARM64 vs x86 启动：截然不同的哲学</strong> — x86 从 16 位爬到 64 位，背负沉重历史包袱（BIOS/UEFI/ACPI 屏蔽硬件差异）。ARM64 一上电就是 64 位，硬件差异完全暴露给软件<br>
3. <strong>异常级别是嵌套的保护环</strong> — EL3 > EL2 > EL1 > EL0。JTAG 是在串口无输出时的终极调试手段<br>
4. <strong>理解启动流程 = 理解整个系统栈</strong> — 从固件初始化、U-Boot 加载内核、设置虚拟内存、到 init 启动用户空间——一个 <code>.dtb</code> 文件的错误就能让整条链断裂</p>`
    }
  ]
};
