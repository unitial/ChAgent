/**
 * player-data.js — 谁在偷看我的键盘？—— 中断向量表劫持取证
 * 由 interactive-player SKILL 按照 exception_vector.md (ARM64版) 生成
 */
const PLAYER_CONFIG = {
  title: "谁在偷看我的键盘？—— 异常向量表劫持取证",
  subtitle: "内核安全取证全真模拟推演。<br>跟随安全实验室学长的视角，揭开 ARM64 向量表劫持的面纱。",
  splashImage: "computer_lab.png",

  steps: [
    {
      title: "📅 场景：机房大面积盗号事件",
      terminal: {
        prompt: "", command: "",
        output: "      ██████ 学校第三机房 ██████\\n\\n期末周。小张用 Vim 敲完 OS 大作业，顺手登了 Steam。\\n第二天早上——Steam 安全警报：账号凌晨 3 点被异地登录！\\n\\n班群一问：4 人中招，全是昨天 C 排电脑操作过的。\\n\\n小张：\"用的 Linux，怎么还能被盗号？\"\\n学长阿坤：\"常规杀毒扫不到，多人同时中招……恐怕是内核级后门。\""
      },
      commentary: `<img src="computer_lab.png" class="hardware-photo" alt="学校机房">
<p>期末周，学校第三机房。小张刚用 Vim 敲完操作系统大作业，顺手登了一下 Steam。旁边的小刘在查成绩，登了学校邮箱。</p>
<p class="warning">🔥 第二天早上，小张收到 Steam 安全警报——账号在凌晨 3 点从陌生 IP 登录过。班群里一问，<strong>四个人都中招了</strong>，全是昨天在第三机房 C 排电脑上操作过的。</p>
<p class="dialogue"><span class="speaker">小张：</span>"咱们用的可是 Linux，怎么还能被盗号？"</p>
<p class="dialogue"><span class="speaker">学长阿坤：</span>"常规杀毒扫不到，多人同时中招，又都是同一排机器……这恐怕是<strong>内核级后门</strong>。走，带上我的 U 盘，咱去看看。"</p>`
    },
    {
      title: "🔍 静态取证——发现可疑内核模块",
      terminal: {
        prompt: "$ ", command: "ls -lt /mnt/ubuntu_root/lib/modules/.../kernel/drivers/input/ | head -5\\n$ strings /mnt/ubuntu_root/lib/modules/.../kbdmon.ko | grep -E \"hook|log|http\"",
        output: "...\\n-rw-r--r-- 1 root root  16384 Dec 25 03:15 kbdmon.ko    # <-- 深夜创建！\\n...\\n\\nvbar_hook_install\\nkeylog_ring_buffer\\nsend_data_to_remote\\nhttp://45.76.xxx.xxx/collect"
      },
      commentary: `<p>阿坤用自己的 U 盘引导了取证专用 Live Linux，将被感染电脑的硬盘只读挂载。</p>
<p class="dialogue"><span class="speaker">阿坤：</span>"直接进被感染的系统的话，如果有内核级 <span class="chat-link">Rootkit</span>，它可能会隐藏自己。我们用干净系统从外部看。"</p>
<p class="warning">🔥 <code>kbdmon.ko</code>？名字是 keyboard monitor 的缩写！而且 strings 输出有 <code>vbar_hook_install</code>！</p>
<p class="insight">💡 普通木马运行在<strong>用户态（<span class="chat-link">EL0</span>）</strong>，容易被扫出来。但这个东西伪装成驱动加载到了<strong>内核态（<span class="chat-link">EL1</span>）</strong>，拥有和操作系统同等的最高权限。它 hook 了系统的命脉——<strong>异常向量表</strong>，也就是 <code><span class="chat-link">VBAR_EL1</span></code> 寄存器指向的那张表。</p>`
    },
    {
      title: "🧠 ARM64 的异常处理机制",
      terminal: {
        prompt: "", command: "",
        output: "ARM64 异常分四大类：\\n\\n同步异常（CPU 执行时产生）：\\n  • SVC 指令（系统调用）\\n  • Data Abort（缺页）\\n  • 未定义指令异常\\n\\n异步异常（外部硬件信号）：\\n  • IRQ（普通中断：键盘、网卡、定时器……）\\n  • FIQ（快速中断，安全相关）\\n  • SError（系统错误，硬件故障）\\n\\n不管哪种异常，CPU 的处理方式都一样：\\n  → 跳到 VBAR_EL1 指向的向量表中对应偏移处执行"
      },
      commentary: `<p class="dialogue"><span class="speaker">赵老师路过实验室，拉了把椅子坐下：</span>"要搞清楚这个攻击，你们得先理解 ARM64 的异常处理机制。"</p>
<p>ARM64 中，所有需要立即处理的事件统称为<strong>异常（Exception）</strong>，分为四大类：</p>
<p><strong>同步异常（Synchronous）</strong>——CPU 执行指令时产生：<br>
• <span class="chat-link">SVC</span> 指令（系统调用）<br>
• 数据异常 Data Abort（类似缺页）<br>
• 未定义指令异常</p>
<p><strong>异步异常</strong>——外部硬件信号：<br>
• <span class="chat-link">IRQ</span>（普通中断：键盘、网卡、定时器……）<br>
• <span class="chat-link">FIQ</span>（快速中断，安全相关）<br>
• SError（系统错误，硬件故障）</p>
<p class="conclusion">🎯 不管哪种异常，CPU 的处理方式是一样的：<strong>跳到 <code>VBAR_EL1</code> 寄存器指向的向量表中对应偏移处的代码去执行。</strong></p>`
    },
    {
      title: "📐 向量表的结构",
      terminal: {
        prompt: "", command: "",
        output: "ARM64 向量表：16 个条目（4 异常类型 × 4 来源组合）\\n每个条目 = 128 字节可执行代码空间（通常存一条 b 跳转指令）\\n\\n+0x000 Synchronous, 当前EL, SP_EL0\\n+0x080 IRQ, 当前EL, SP_EL0\\n+0x200 Synchronous, 当前EL, SP_ELx\\n+0x280 IRQ, 当前EL, SP_ELx\\n...\\n+0x400 Synchronous, 低EL(EL0) ← 系统调用入口\\n+0x480 IRQ, 低EL(EL0)         ← ★ 攻击目标！\\n\\nARM64 vs x86 关键区别：\\n  ARM64 向量表条目 = 直接可执行代码\\n  x86 IDT = 处理函数地址描述符"
      },
      commentary: `<p class="dialogue"><span class="speaker">赵老师在白板上画了一张图：</span></p>
<p>ARM64 向量表有 <strong>16 个条目</strong>（4 种异常类型 × 4 种来源组合），每个条目是 <strong>128 字节的可执行代码空间</strong>（通常存放一条 <code>b</code> 跳转指令）。</p>
<p class="insight">💡 <b>ARM64 vs x86 的关键区别</b>：ARM64 向量表的每个条目是<strong>直接可执行的代码</strong>，而 x86 IDT 存的是处理函数的地址描述符。<br>
劫持方法也不同：x86 需要修改描述符中的地址字段，ARM64 只需修改一条 <code>b</code> 跳转指令。<br>
<code><span class="chat-link">VBAR_EL1</span></code> 保存向量表基地址，类似 x86 的 <code>IDTR</code>。</p>`
    },
    {
      title: "🔬 转储向量表——抓捕现行",
      terminal: {
        prompt: "$ ", command: "sudo ./forensic_tool --dump-vbar",
        output: "VBAR_EL1 = 0xffff800010011800\\n\\nOffset   Expected (kernel .text)        Actual Branch Target\\n------   ----------------------------   ----------------------------\\n+0x000   0xffff800010011800 (sync_cur)  0xffff800010011800  ✓\\n+0x080   0xffff800010011880 (irq_cur)   0xffff800010011880  ✓\\n+0x400   0xffff800010011c00 (el0_sync)  0xffff800010011c00  ✓\\n+0x480   0xffff800010011c80 (el0_irq)   0xffff0000c0a8b000  <<< 异常!\\n+0x500   0xffff800010011d00 (el0_fiq)   0xffff800010011d00  ✓"
      },
      commentary: `<p>阿坤重启进入被感染的原系统，运行了特权内存取证工具。</p>
<p class="warning">🔥 <strong>+0x480 的跳转目标被篡改了！</strong><br>
其他条目都指向 <code>0xffff8000</code>（正常的内核 <code>.text</code> 段），它却跳到了 <code>0xffff0000c0</code>——这是<strong>内核模块（<span class="chat-link">vmalloc</span>）</strong>的地址范围！</p>
<p class="conclusion">🎯 <strong>石锤了。</strong>+0x480 是来自 <span class="chat-link">EL0</span>（用户态）的 <strong>IRQ 入口</strong>。每次用户按下键盘，CPU 首先跳到恶意代码去执行。</p>`
    },
    {
      title: "🧬 反汇编恶意代码",
      terminal: {
        prompt: "$ ", command: "sudo ./forensic_tool --disasm 0xffff0000c0a8b000 96",
        output: "0xffff0000c0a8b000:  stp  x0, x1, [sp, #-16]!       // 保存 x0, x1\\n0xffff0000c0a8b004:  stp  x2, x3, [sp, #-16]!       // 保存 x2, x3\\n; === 读取最新扫描码 ===\\n0xffff0000c0a8b008:  adrp x0, latest_scancode\\n0xffff0000c0a8b00c:  ldr  w1, [x0, :lo12:latest_scancode]\\n0xffff0000c0a8b010:  cbz  w1, skip_log              // 无新按键则跳过\\n; === 存入环形缓冲区 ===\\n0xffff0000c0a8b014:  adrp x2, ring_buffer\\n0xffff0000c0a8b018:  adrp x3, buf_index\\n0xffff0000c0a8b01c:  ldr  x3, [x3, :lo12:buf_index]\\n0xffff0000c0a8b020:  strb w1, [x2, x3]              // buffer[idx] = scancode\\n0xffff0000c0a8b024:  add  x3, x3, #1\\n0xffff0000c0a8b028:  and  x3, x3, #0x3ff            // 环形缓冲 1024\\nskip_log:\\n0xffff0000c0a8b038:  ldp  x2, x3, [sp], #16\\n0xffff0000c0a8b03c:  ldp  x0, x1, [sp], #16\\n0xffff0000c0a8b040:  b    original_el0_irq          // 跳回正常 handler"
      },
      commentary: `<p>恶意代码的三步操作：</p>
<p><strong>① 读取扫描码副本</strong>：从 <code>latest_scancode</code> 全局变量读取（通过 input subsystem 回调拷贝而来）<br>
<strong>② 存入环形缓冲区</strong>：buffer[index] = scancode<br>
<strong>③ 跳回原始处理函数</strong>：<code>b original_el0_irq</code></p>
<p class="insight">💡 比 x86 键盘记录器更精巧的设计：x86 经典方法用 <code>in $0x60, %al</code> 直接读硬件端口，会"消费"掉数据导致吞键。而这个 ARM64 木马通过 <code>notifier_chain</code> 在 input subsystem 注册回调，<strong>只读副本，不消费原始数据</strong>，用户完全无感知！</p>
<p>模块还注册了 <code>hrtimer</code> 内核定时器，每 30 秒通过 <code>kernel_sendmsg()</code> 把缓冲区数据发到远程服务器。</p>`
    },
    {
      title: "💀 还原完整攻击链",
      terminal: {
        prompt: "", command: "",
        output: "完整攻击链：\\n  ① 初始入侵（物理接触机房电脑）\\n  ② 提权到 EL1（利用内核提权漏洞）\\n  ③ 加载恶意模块 insmod kbdmon.ko\\n  ④ 篡改向量表（修改 +0x480 处的 b 指令）\\n  ⑤ 键盘记录（每次 EL0 IRQ 触发，读扫描码存入缓冲区）\\n  ⑥ 数据外传（hrtimer 每 30 秒发送到远程服务器）\\n\\n向量表劫持的\"优势\"：\\n  1. 极度隐蔽 — 没有进程/文件出现在 ps/top 中\\n  2. 无法被用户态检测 — 所有 syscall 都经过 EL1\\n  3. 可靠性极高 — IRQ 是硬件级事件，必经向量表\\n  4. 实现简单 — ARM64 只需修改一条 b 跳转指令"
      },
      commentary: `<p class="dialogue"><span class="speaker">赵老师在白板上画出了完整的攻击链：</span></p>
<p><strong>① 初始入侵</strong>（物理接触机房电脑）→ <strong>② 提权到 <span class="chat-link">EL1</span></strong>（利用内核提权漏洞）→ <strong>③ 加载恶意模块</strong> <code>insmod kbdmon.ko</code> → <strong>④ 篡改向量表</strong>（修改 +0x480 处的 <code>b</code> 指令）→ <strong>⑤ 键盘记录</strong>（每次 EL0 IRQ 触发，读取扫描码副本存入缓冲区）→ <strong>⑥ 数据外传</strong>（hrtimer 每 30 秒发送到远程服务器）</p>
<p class="dialogue"><span class="speaker">小张：</span>"为什么选择 hook 向量表？"</p>
<p class="insight">💡 向量表劫持的"优势"：<br>
1. <strong>极度隐蔽</strong> — 没有进程或文件路径出现在 <code>ps</code>、<code>top</code> 中<br>
2. <strong>无法被用户态检测</strong> — EL0 的所有系统调用都要经过 EL1 处理<br>
3. <strong>可靠性极高</strong> — IRQ 是硬件级事件，每次中断必经向量表<br>
4. <strong>实现简单</strong> — ARM64 向量表是代码，只需修改一条 <code>b</code> 跳转指令</p>`
    },
    {
      title: "🔧 恢复向量表并清除后门",
      terminal: {
        prompt: "$ ", command: "sudo ./force_rmmod kbdmon",
        output: "[*] Resetting module refcount to 0...\\n[*] Restoring VBAR_EL1+0x480 entry...\\n[*] Writing original branch: b el0_irq (0xffff800010011c80)\\n[*] Flushing instruction cache (IC IALLU)...\\n[*] Removing module from kernel...\\n[+] Module removed successfully\\n\\n$ sudo ./forensic_tool --dump-vbar | grep 0x480\\n+0x480   0xffff800010011c80 (el0_irq)  0xffff800010011c80  ✓"
      },
      commentary: `<p class="dialogue"><span class="speaker">阿坤：</span>"知道原理了，修复起来就简单了。"</p>
<p>模块设置了防卸载（引用计数锁死），需要取证工具强制清除。</p>
<p class="thinking">注意恢复向量表后必须执行 <code>IC IALLU</code>（Instruction Cache Invalidate All）刷新指令缓存——ARM64 向量表条目是可执行代码，CPU 可能缓存了旧的（被篡改的）跳转指令！</p>
<p class="conclusion">🎯 <strong>+0x480 恢复了！</strong>跳转目标回到了正常的内核 <code>el0_irq</code> 处理函数。</p>
<p class="dialogue"><span class="speaker">赵老师提醒：</span>"仅仅恢复向量表和删模块是不够的。需要：<br>
1. <strong>重装系统</strong>（不能信任被 rootkit 感染过的系统）<br>
2. <strong>修补内核漏洞</strong><br>
3. <strong>受害同学立即修改所有密码</strong>"</p>`
    },
    {
      title: "🛡️ 攻与防——ARM64 的安全防线",
      terminal: {
        prompt: "", command: "",
        output: "攻击手段：\\n  set_memory_rw(vbar_addr, 1)  // 将向量表页标记为可写\\n  // 修改 +0x480 处的 b 指令\\n  set_memory_ro(vbar_addr, 1)  // 恢复只读\\n  flush_icache_range(...)      // 刷新指令缓存\\n\\n防御机制：\\n  PAN (Privileged Access Never) → 不起作用！恶意代码在 EL1\\n  BTI (Branch Target ID)        → 不起作用！攻击改的是直接跳转(b)\\n  CONFIG_MODULE_SIG_FORCE=y     → ★ 终极杀手锏！无签名模块被拒绝加载\\n  + UEFI Secure Boot            → 固件级信任链"
      },
      commentary: `<p class="dialogue"><span class="speaker">小张：</span>"向量表所在的内存不是只读的吗？木马是怎么改写的？"</p>
<p><strong>1. <code>set_memory_rw()</code> 绕过（攻击手段）</strong><br>
ARM64 没有 x86 的 <code>CR0.WP</code> 位。但拥有 EL1 权限后，攻击者可以调用 <code>set_memory_rw()</code> 修改向量表所在页的页表项（PTE），篡改后再 <code>set_memory_ro()</code> 恢复。</p>
<p><strong>2. <span class="chat-link">PAN</span>（Privileged Access Never）— 不起作用！</strong><br>
PAN 防止内核（EL1）直接访问用户态（EL0）内存。但本案中恶意代码在内核地址空间，EL1 执行 EL1 的代码，PAN 无法阻止。</p>
<p><strong>3. 内核模块强制签名（终极杀手锏）</strong><br>
开启 <code>CONFIG_MODULE_SIG_FORCE=y</code> + <span class="chat-link">UEFI Secure Boot</span>，无签名的 <code>kbdmon.ko</code> 在加载时直接被拒绝。机房中招很可能是管理员临时关了签名校验。</p>
<p><strong>4. <span class="chat-link">BTI</span>（Branch Target Identification）</strong><br>
ARMv8.5 引入：只有标记了 <code>BTI</code> 指令的地址才能作为间接跳转目标。但攻击者修改的是<strong>直接跳转指令</strong>（<code>b</code> 而非 <code>br</code>），BTI 对直接跳转不检查，因此也无法防御本案攻击。</p>`
    },
    {
      title: "💡 核心回顾",
      terminal: {
        prompt: "", command: "",
        output: "核心知识点：\\n  1. 异常向量表 = ARM64 最底层的事件分发机制\\n     SVC/IRQ/缺页 全通过 VBAR_EL1 分发\\n  2. ARM64 向量表 = 直接可执行代码\\n     每条目 128B, 通常一条 b 跳转, 改一条指令即可劫持\\n  3. 16 条目按\"来源 EL × 异常类型\"组织\\n     EL0/EL1 中断走不同入口, 攻击者选择+0x480劫持EL0 IRQ\\n  4. 向量表劫持 = IDT Hooking 的 ARM64 变体\\n     原理相通但技术细节完全不同\\n  5. 现代防御是多层次的\\n     PAN/PXN(CPU级) + BTI(控制流) + SecureBoot(固件) + 模块签名(软件)"
      },
      commentary: `<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>异常向量表是 ARM64 最底层的事件分发机制</strong> — SVC、IRQ、缺页……所有异常都通过 <span class="chat-link">VBAR_EL1</span> 指向的向量表分发处理<br>
2. <strong>ARM64 向量表直接存放可执行代码</strong> — 每个条目 128 字节，通常是一条 <code>b</code> 跳转指令。修改一条指令就能劫持控制流<br>
3. <strong>按来源 EL 分组是 ARM64 的独特设计</strong> — 16 个条目按「来源 EL × 异常类型」组织，来自 EL0 和 EL1 的中断走不同入口<br>
4. <strong>向量表劫持是 IDT Hooking 的 ARM64 变体</strong> — 原理相通但技术细节完全不同<br>
5. <strong>现代防御是多层次的</strong> — PAN/PXN（CPU 级）、BTI（控制流级）、Secure Boot（固件级）、模块签名（软件级）</p>
<p class="insight">💡 <strong>一句话总结：异常向量表是 ARM64 CPU 的"神经系统"。保护好 VBAR_EL1 指向的这张表，就是保护系统最核心的控制流不被劫持。</strong></p>`
    }
  ]
};
