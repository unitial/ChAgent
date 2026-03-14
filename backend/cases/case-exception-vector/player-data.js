/**
 * player-data.js — 谁在偷看我的键盘？—— 中断向量表劫持取证
 * 由 interactive-player SKILL 按照 exception_vector.md 生成
 */
const PLAYER_CONFIG = {
  title: "谁在偷看我的键盘？—— 中断向量表劫持取证",
  subtitle: "内核安全取证全真模拟推演。<br>跟随安全实验室学长的视角，揭开 IDT Hooking 的面纱。",
  splashImage: "computer_lab.png",

  steps: [
    {
      title: "📅 场景：机房大面积盗号事件",
      terminal: null,
      commentary: `<img src="computer_lab.png" class="hardware-photo" alt="学校机房">
<p>期末周，学校第三机房。小张刚用 Vim 敲完操作系统大作业，顺手登了一下 Steam。旁边的小刘在查成绩，登了学校邮箱。</p>
<p class="warning">🔥 第二天早上，小张收到 Steam 安全警报——账号在凌晨 3 点从陌生 IP 登录过。班群里一问，<strong>四个人都中招了</strong>，全是昨天在第三机房 C 排电脑上操作过的。</p>
<p class="dialogue"><span class="speaker">小张：</span>"咱们用的可是 Linux，怎么还能被盗号？"</p>
<p class="dialogue"><span class="speaker">学长阿坤：</span>"常规杀毒扫不到，多人同时中招，又都是同一排机器……这恐怕是<strong>内核级后门</strong>。走，带上我的 U 盘，咱去看看。"</p>`
    },
    {
      title: "🔍 步骤 1：静态取证——从外部审视被感染系统",
      terminal: {
        prompt: "$ ", command: "ls -lt /mnt/ubuntu_root/lib/modules/$(uname -r)/kernel/drivers/input/ | head -5",
        output: "...\n-rw-r--r-- 1 root root  16384 Dec 25 03:15 kbdmon.ko    # <-- 创建时间是昨天深夜？\n-rw-r--r-- 1 root root  28560 Oct 10 14:20 mouse.ko\n..."
      },
      commentary: `<p>阿坤没有直接开机进原系统，而是用自己的 U 盘引导了一个取证专用的 Live Linux。</p>
<p class="dialogue"><span class="speaker">阿坤：</span>"直接进被感染的系统的话，如果有内核级 <span class="chat-link">Rootkit</span>，它可能会拦截系统调用并隐藏自己。我们用干净的外部系统挂载它的硬盘，从'上帝视角'看它就无处遁形了。"</p>
<p class="warning">🔥 <code>kbdmon.ko</code>？这不是 Linux 标准的外设驱动。名字是 keyboard monitor 的缩写！创建时间居然是昨天深夜 3:15！</p>`
    },
    {
      title: "🔬 深入可疑模块：strings 取证",
      terminal: {
        prompt: "$ ", command: "strings /mnt/ubuntu_root/lib/modules/.../kbdmon.ko | grep -E \"hook|log|http\"",
        output: "idt_hook_install\nkeylog_ring_buffer\nsend_data_to_remote\nhttp://45.76.xxx.xxx/collect"
      },
      commentary: `<p class="dialogue"><span class="speaker">阿坤倒吸一口凉气：</span>"<code>idt_hook_install</code>、<code>keylog_ring_buffer</code>……这是一个<strong>内核级键盘记录器</strong>。它把击键数据发到了远程服务器。"</p>
<p class="dialogue"><span class="speaker">小张：</span>"内核级？什么意思？"</p>
<p class="insight">💡 普通木马运行在<strong>用户态（<span class="chat-link">Ring 3</span>）</strong>，容易被杀软扫出来。但这个东西伪装成驱动加载到了<strong>内核态（<span class="chat-link">Ring 0</span>）</strong>，拥有和操作系统同等的最高权限。它 hook 了系统的命脉——<strong>中断描述符表（<span class="chat-link">IDT</span>）</strong>。</p>`
    },
    {
      title: "🧠 步骤 2：什么是中断和异常？",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">赵老师：</span>"要搞清楚 IDT Hooking，你们得先理解 CPU 是怎么处理中断的。"</p>
<p>CPU 在执行程序时，会遇到各种需要<strong>立即处理</strong>的事件，分两大类：</p>
<p><strong>异常（Exception）</strong>——CPU 自身在执行指令时产生的：除零错误（#DE）、<span class="chat-link">缺页异常</span>（#PF）、通用保护异常（#GP）、断点（#BP）等。</p>
<p><strong>中断（Interrupt）</strong>——外部硬件发来的信号：键盘中断（<span class="chat-link">IRQ 1</span> → INT 0x21）、定时器中断（IRQ 0）、磁盘中断、网卡中断等。</p>
<p class="conclusion">🎯 不管是异常还是中断，CPU 的处理方式是一样的：<strong>去一张表（IDT）里查找对应的处理函数地址，然后跳过去执行。</strong></p>
<p class="dialogue"><span class="speaker">赵老师：</span>"当中断发生时，<strong>纯硬件逻辑</strong>会自动查 IDT 表，并<strong>带着 Ring 0 的最高权限</strong>跳转到该地址。如果黑客把键盘中断的地址改成了他自己的代码……你敲击键盘的瞬间，CPU 首先执行的就是恶意代码。"</p>`
    },
    {
      title: "📐 步骤 3：IDT 的结构",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">赵老师在白板上画了一张图：</span></p>
<p>在 x86 架构中，<span class="chat-link">IDT</span>（Interrupt Descriptor Table）最多 256 个条目，每个条目叫做<strong>门描述符（Gate Descriptor）</strong>。</p>
<p>关键条目：<br>
<code>INT 0</code> → 除零异常<br>
<code>INT 14</code> → 缺页异常<br>
<code>INT 32</code> → 定时器中断<br>
<code>INT 33 (0x21)</code> → <strong>键盘中断 ← 攻击目标!</strong><br>
<code>INT 128 (0x80)</code> → Linux 系统调用</p>
<p><code><span class="chat-link">IDTR</span></code> 寄存器保存着这张表的内存基址。</p>
<p class="insight">💡 当中断发生时，CPU 硬件自动查 IDT 表并跳转。如果这张表被篡改了，控制流就被完美劫持——而且整个过程完全在硬件层面发生，任何软件检测都来不及干预。</p>`
    },
    {
      title: "🔬 步骤 4：转储 IDT——抓捕现行",
      terminal: {
        prompt: "$ ", command: "sudo ./forensic_tool --dump-idt",
        output: "INT#  Type        DPL  Handler Address          Symbol\n----  ----------  ---  ----------------------  -------------------------\n0x00  Interrupt   0    0xffffffff81a01000       divide_error\n0x0E  Interrupt   0    0xffffffff81a01e00       page_fault\n0x20  Interrupt   0    0xffffffff81a02000       timer_interrupt\n0x21  Interrupt   0    0xffffffffc0a8b000  <<<  ???  ← 地址异常!\n0x22  Interrupt   0    0xffffffff81a02200       cascade"
      },
      commentary: `<p>阿坤拔下 U 盘，重启进入了被感染的机器原系统，运行了特权内存取证工具。</p>
<p class="warning">🔥 <strong>小张一眼就看出了问题：</strong>"0x21 的地址不一样！其他都是 <code>0xffffffff81</code>（正常的内核代码段）开头，它却指向了 <code>0xffffffffc0</code> 开头的区域？"</p>
<p class="dialogue"><span class="speaker">阿坤：</span>"<code>0xffffffffc0...</code> 是 Linux 动态加载<strong>内核模块（<span class="chat-link">vmalloc</span>）</strong>的地址范围。"</p>
<p class="conclusion">🎯 <strong>石锤了。</strong>原始的系统键盘处理函数被替换，控制流被完美劫持到了木马模块中。每次你在键盘上按一个键，CPU 都会先跳到恶意代码去执行。</p>`
    },
    {
      title: "🧬 步骤 5：反汇编恶意代码",
      terminal: {
        prompt: "$ ", command: "sudo dd if=/proc/kcore bs=1 skip=$((0xffffffffc0a8b000)) count=4096 | objdump -D -b binary -m i386:x86-64 -",
        output: "0000000000000000 <.data>:\n   0:   55                      push   %rbp\n   1:   48 89 e5                mov    %rsp,%rbp\n   8:   e4 60                   in     $0x60,%al       ; ← 读端口 0x60\n   a:   88 c3                   mov    %al,%bl         ;    保存扫描码\n   c:   48 8d 0d xx xx xx xx    lea    buffer(%rip),%rcx\n  13:   48 8b 15 xx xx xx xx    mov    buf_index(%rip),%rdx\n  1a:   88 1c 11                mov    %bl,(%rcx,%rdx,1)  ; 存入 buffer[index]\n  1d:   48 ff c2                inc    %rdx\n  20:   48 81 e2 ff 03 00 00    and    $0x3ff,%rdx     ; 环形缓冲，1024 字节\n  31:   ff 25 xx xx xx xx       jmp    *original_handler(%rip)  ; ← 跳回正常 handler"
      },
      commentary: `<p>恶意代码的三步操作：</p>
<p><strong>① 读取键盘扫描码</strong>：<code>in $0x60, %al</code> 读端口 0x60<br>
<strong>② 存入环形缓冲区</strong>：buffer[index] = scancode<br>
<strong>③ 跳回原始处理函数</strong>：<code>jmp *original_handler</code></p>
<p class="dialogue"><span class="speaker">赵老师指着代码笑了：</span>"写这个木马的人犯了一个底层硬件错误——<strong>数据消费（Data Consumption）陷阱</strong>。键盘控制器的 <code>0x60</code> 端口是硬件 FIFO，木马用 <code>in</code> 读走扫描码，<strong>数据就被出队'吃掉'了</strong>！原生驱动再读就是空数据！"</p>
<p class="dialogue"><span class="speaker">小张恍然大悟：</span>"难怪！我昨天打字的时候感觉键盘断触，经常吞掉字母！"</p>
<p class="insight">💡 这也是为什么现代高级 Rootkit 早就淘汰了暴力的底层硬件截获，转而去 Hook 上层 <code>kbd_event</code> 回调链——那种方式只读数据副本，用户完全无感知。</p>`
    },
    {
      title: "💀 步骤 6：还原完整攻击链",
      terminal: null,
      commentary: `<p class="dialogue"><span class="speaker">赵老师在白板上画出了完整的攻击链：</span></p>
<p><strong>① 初始入侵</strong> → <strong>② 提权到 Ring 0</strong>（利用未修补的本地提权漏洞）→ <strong>③ 加载恶意模块</strong> <code>insmod kbdmon.ko</code> → <strong>④ 篡改 IDT</strong>（修改 INT 0x21 指向恶意 handler）→ <strong>⑤ 键盘记录</strong>（每次按键触发，先记录扫描码再跳回原 handler）→ <strong>⑥ 数据外传</strong>（定时器每 30 秒发送到远程服务器）</p>
<p class="dialogue"><span class="speaker">小张：</span>"为什么选择 hook IDT 而不是别的方式？"</p>
<p class="insight">💡 IDT Hooking 的"优势"：<br>
1. <strong>极度隐蔽</strong> — 没有任何进程或文件路径出现在 <code>ps</code>、<code>top</code> 的常规输出中<br>
2. <strong>无法被用户态杀软检测</strong> — 杀毒软件运行在 Ring 3，它的所有系统调用本身就可能被 hook 过的内核代码拦截<br>
3. <strong>可靠性高</strong> — 键盘中断是硬件级事件，每一次按键都必然经过 IDT</p>`
    },
    {
      title: "🔧 步骤 7：恢复 IDT 并清除后门",
      terminal: {
        prompt: "$ ", command: "sudo ./force_rmmod kbdmon",
        output: "[*] Resetting module refcount to 0...\n[*] Unhooking IDT entry 0x21...\n[*] Restoring original handler: 0xffffffff81a02100\n[*] Removing module from kernel...\n[+] Module removed successfully\n\n$ sudo ./dump_idt | grep \"0x21\"\n0x21  Interrupt   0    0x0010   0xffffffff81a02100       keyboard_interrupt  ✓"
      },
      commentary: `<p class="dialogue"><span class="speaker">阿坤：</span>"知道原理了，修复起来就简单了。"</p>
<p>模块设置了防卸载（引用计数锁死），需要用取证工具强制清除。</p>
<p class="conclusion">🎯 <strong>INT 0x21 恢复了！handler 地址回到了正常的内核代码段。</strong></p>
<p class="dialogue"><span class="speaker">赵老师提醒：</span>"仅仅恢复 IDT 和删模块是不够的。攻击者既然能第一次装上去，说明系统有漏洞。需要：<br>1. <strong>重装系统</strong>（不能信任被 rootkit 感染过的系统）<br>2. <strong>修补内核漏洞</strong><br>3. <strong>受害同学立即修改所有密码</strong>"</p>`
    },
    {
      title: "🛡️ 步骤 8：攻与防——现代 OS 的防御层次",
      terminal: {
        prompt: "", command: "",
        output: "// 关闭写保护 → 修改 IDT → 恢复写保护\nunsigned long cr0 = read_cr0();\nwrite_cr0(cr0 & ~X86_CR0_WP);   // 清除 WP 位\n// ... 修改 IDT 条目 ...\nwrite_cr0(cr0);                  // 恢复 WP 位\n\n# Linux 可以配置为只加载签名过的模块\nCONFIG_MODULE_SIG=y\nCONFIG_MODULE_SIG_FORCE=y"
      },
      commentary: `<p class="dialogue"><span class="speaker">小张：</span>"IDT 所在的内存页不是只读的吗？木马是怎么改写的？"</p>
<p><strong>1. <span class="chat-link">CR0</span> 寄存器绕过（攻击者手段）</strong><br>
木马拥有 Ring 0 权限后，可通过清除 CPU <code>CR0</code> 寄存器的 <strong>WP（Write-Protect）位</strong> 来强行关闭写保护。这是 Rootkit 修改只读内核数据结构的经典手法。</p>
<p><strong>2. <span class="chat-link">SMEP</span> / SMAP — 在本案中不起作用！</strong><br>
SMEP 防御的是 Ring 0 执行 Ring 3 代码。本案中恶意代码本身就在 Ring 0 内存区，SMEP 毫无作用。</p>
<p><strong>3. 内核模块强制签名（终极杀手锏）</strong><br>
开启强制签名校验 + <span class="chat-link">UEFI Secure Boot</span>，无签名的 <code>kbdmon.ko</code> 在加载第一步就被直接踢飞。机房中招，很可能是管理员临时关掉了签名校验。</p>
<p><strong>4. <span class="chat-link">PatchGuard</span>（Windows 方案）</strong><br>
定期检查 IDT、SSDT 等关键内核数据结构。如果发现被篡改，直接蓝屏——宁可崩溃也不让 rootkit 继续运行。</p>`
    },
    {
      title: "💡 步骤 9：战后总结",
      terminal: null,
      commentary: `<p>晚上在寝室，小张回忆今天学到的东西：</p>
<p class="conclusion">🎯 <strong>核心知识点：</strong><br>
1. <strong>中断和异常是 CPU 最底层的事件分发机制</strong> — 键盘按键、缺页、除零……所有紧急事件都通过 IDT 查找处理函数<br>
2. <strong>IDT 是 CPU 硬件查表的</strong> — 由 <span class="chat-link">IDTR</span> 寄存器指向，中断发生时 CPU 自动查表跳转，不经过任何软件<br>
3. <strong>修改 IDT = 劫持 CPU 的控制流</strong> — 攻击者把 handler 地址改成自己的代码，每次中断触发就执行恶意逻辑<br>
4. <strong>IDT Hooking 是经典 Rootkit 技术</strong> — Rustock、TDSS、Alureon 等真实恶意软件都使用过，极难被用户态程序检测<br>
5. <strong>现代防御是多层次的</strong> — SMEP/SMAP（CPU 级）、PatchGuard（OS 级）、Secure Boot（固件级）、模块签名（软件级）层层防护</p>
<p class="insight">💡 <strong>一句话总结：IDT 是连接硬件事件和软件处理的桥梁。保护好这张表，就是保护 CPU 的"神经系统"不被劫持。</strong></p>`
    }
  ]
};
