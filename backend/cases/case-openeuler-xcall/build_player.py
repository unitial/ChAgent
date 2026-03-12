import sys
import re

template_file = "../case19_player.html"
with open(template_file, "r", encoding="utf-8") as f:
    html = f.read()

# Replace Title
html = html.replace("Case 19: 同一个内核，两块板子", "榨干系统调用最后一丝性能：openEuler xcall 零门槛提速")
html = html.replace("嵌入式内核排障全真模拟推演。<br>跟随资深工程师的视角，一步步揭发底层系统命案真相。", "网络高频压测全真模拟推演。<br>跟随系统内核工程师的视角，看看 openEuler 如何突破性能“玻璃天花板”。")

# Replace STEPS array
new_steps_str = """
    const STEPS = [
      {
        title: "📎 故事背景 (遇到性能天花板)",
        terminal: {
          prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
          output: `PING_INLINE: 812345.67 requests per second, p50=0.512 msec
GET: 809112.33 requests per second, p50=0.521 msec

$ vmstat 1 3
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
12  0      0  2109M  120M  4100M    0    0     0     0 80k 120k 35 60  5  0  0
14  0      0  2109M  120M  4100M    0    0     0     0 82k 125k 33 62  5  0  0`
        },
        commentary: `<p><strong>场景：</strong>我们的 Redis 分布式集群在最新采购的 128 核 ARM64 服务器上进行疯狂压测。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"老王，我彻底抓狂了！按理说这种神级配置跑 Redis 这种纯内存数据库应该是碾压局，可单实例 QPS 就是死死卡在 80 万上不去！"</p>
<p class="dialogue"><span class="speaker">小宇：</span>"你看 <code>vmstat</code>：<code>us</code> (User 用户态) 只有 35%，而 <code>sy</code>（System 内核态）竟然高达 60%！Redis 的核心逻辑全在用户态里，现在 sy 反倒比 us 高出一大截，到底是谁偷走了 CPU 算力？"</p>`
      },
      {
        title: "🔍 perf top：追查 CPU 窃贼",
        terminal: {
          prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
          output: `Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000
Overhead  Shared Object       Symbol
  15.20%  [kernel]            [k] el0_sync
  12.30%  [kernel]            [k] do_el0_svc
   8.40%  [kernel]            [k] do_epoll_wait
   7.20%  [kernel]            [k] copy_from_user
   6.50%  [kernel]            [k] sys_read`
        },
        commentary: `<p>老王微微一笑，敲下了一行 <code>perf top</code> 命令。</p>
<p class="insight">🎯 <b>原来如此：系统调用的“过关费”太贵了！</b><br>
排名前两位的 <span class="chat-link">el0_sync</span> 和 <code>do_el0_svc</code> 加起来占了近 28% 的 CPU！这两个函数本身不做任何实际工作，它们只是系统调用的“入口框架”，像高速公路的收费站，它们不会帮你开车，但每次过路都强制让你停一下。<br>
后面的 <code>do_epoll_wait</code>、<code>copy_from_user</code>、<code>sys_read</code> 是真正干活的内核 I/O 操作，它们是正当的内核态工作。</p>`
      },
      {
        title: "🧳 冗长的常规系统调用路线",
        terminal: null,
        commentary: `<p class="dialogue"><span class="speaker">老王：</span>"在标准的 ARM64 Linux 中，每次发生系统调用，CPU 会触发异常跳转到内核的 <code>el0_sync</code>。在这个过程中，内核必须做一整套‘全身体检’。"</p>
<p>标准路线下内核不仅要保存 <span class="chat-link">pt_regs</span> (30个寄存器)，要检查待定信号，还要查表分发。<br>对于像读大文件这种极其耗时的操作，这点开销不值一提。但对于 Nginx 或 Redis 处理海量微小请求的程序来说，这点**底噪**甚至超过了进程实际干的活！</p>`
      },
      {
        title: "⚡ 杀手锏：openEuler xcall 极速通道",
        terminal: null,
        commentary: `<p class="dialogue"><span class="speaker">老王：</span>"正因为如此，华为在主导的 <span class="chat-link">openEuler</span> 中针对 ARM64 引入了一把尖刀——<b>xcall 机制 (Fast System Call)</b>。"</p>
<p>xcall 的核心思想是**“VIP 快速绿色通道”**。既然高频系统调用（比如读取时间、网络数据）极少阻塞，那为什么传统内核非要保存 30 多个通用寄存器呢？这就引出了一个底层设计问题：</p>
<p class="insight">💡 <b>关键在于利用 C 语言的调用约定 (ABI)</b><br>
传统系统调用视用户进程为黑盒，“宁错杀不放过”地拍下 <code>pt_regs</code> 快照。<br>
而 xcall <b>主动信任并利用了用户态 C 函数的调用约定</b>。按照编译器规则，函数调用默认允许破坏“暂存寄存器”（如 X0~X7），其他寄存器由调用者负责。只要 xcall 内部的极简 C 函数自己老实听话不去动非易失寄存器，它就能像个普通的 C 函数一样执行！<br>
因此，xcall 在陷入内核时，只需要极简保存 3~4 个受特权级切换波及的底层寄存器，连 <code>pt_regs</code> 都不用建，大幅减少压栈内存 IO。</p>
<p>此外，xcall 还<b>彻底抛弃了慢速的信号与调度检查包袱</b>，通过热指令替换，直通对应的极简版内联 Syscall 函数，完事后光速降级返回 EL0。</p>`
      },
      {
        title: "🔓 实战：一键开启 xcall",
        terminal: {
          prompt: "$ ", command: `cat /sys/kernel/debug/xcall/status
$ echo 1 | sudo tee /sys/kernel/debug/xcall/enable
$ cat /proc/xcall/stat`,
          output: `xcall is disabled.
Supported syscalls: gettimeofday, epoll_wait, read, write, recvfrom, sendto...
1
xcall_hits: 0
xcall_misses: 0`
        },
        commentary: `<p class="dialogue"><span class="speaker">小宇：</span>"需要我改 Redis 代码吗？是不是要用特殊的 API 库？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"最牛的地方就是：<b>对用户态应用完全透明！零修改代码！</b>只需要在这个包含 xcall_tune 插件的内核里打个开关即可。"</p>
<p>老王通过底层的 debugfs 和 procfs，轻描淡写地激活了整个系统的极速调用引擎。</p>`
      },
      {
        title: "🚀 性能起飞：见证奇迹的时刻",
        terminal: {
          prompt: "$ ", command: "redis-benchmark -q -n 2000000 -c 500 -P 16",
          output: `PING_INLINE: 981240.11 requests per second, p50=0.380 msec
GET: 978101.45 requests per second, p50=0.395 msec

$ cat /proc/xcall/stat
xcall_hits: 15480201
xcall_misses: 231405

$ vmstat 1 3
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
12  0      0  2105M  120M  4100M    0    0     0     0 95k  85k 50 45  5  0  0
13  0      0  2105M  120M  4100M    0    0     0     0 97k  88k 48 47  5  0  0`
        },
        commentary: `<p class="thinking">小宇屏住呼吸，再次按下了压测的回车键。</p>
<p class="insight">🔥 <b>性能提升的真相！</b><br>
QPS 从 81 万到近 98 万，提升约 20%！<code>xcall_hits</code> 飙升证明海量调用已走上快速通道。<br>
更关键的是看 vmstat：<code>us</code> 从 35% 回升到 50%，<code>sy</code> 从 60% 降到 45%！用户态终于变成大头，CPU 终于花更多时间做正事。</p>
<p class="dialogue"><span class="speaker">小宇：</span>"等等，内核态还有 45%？怎么没有彻底降下来？"</p>
<p class="dialogue"><span class="speaker">老王：</span>"xcall 只优化了系统调用的<b>入口框架</b>，而内核里真正干活的代码——网络 I/O、内存拷贝、Epoll 管理——是正当的内核工作，不能也不应该被消除。"</p>`
      },
      {
        title: "🛡️ perf top 重新复盘",
        terminal: {
          prompt: "$ ", command: "sudo perf top -p $(pidof redis-server)",
          output: `Samples: 50K of event 'cycles', 4000 Hz, Event count (approx.): 12000000000
Overhead  Shared Object       Symbol
   9.10%  [kernel]            [k] do_epoll_wait
   7.20%  [kernel]            [k] copy_from_user
   6.50%  [kernel]            [k] sys_read
   2.10%  [kernel]            [k] el0_sync
   1.50%  [kernel]            [k] do_el0_svc`
        },
        commentary: `<p class="conclusion">✨ **小宇彻底懂了**<br>
曾经盘踞在 CPU 消耗榜头两名的 <code>el0_sync</code> + <code>do_el0_svc</code> （共 28%）降到了 3.6%！这与 vmstat 中 sy 下降的幅度完美对应。<br>
xcall 的设计哲学：<b>不干涉内核的实际工作，只精准砍掉“进出城门”的无用开销</b>。</p>`
      },
      {
        title: "🎓 进阶探讨：为什么不全用 xcall？",
        terminal: null,
        commentary: `<p class="thinking">既然 xcall 性能如此爆炸，为什么 Linux 社区不把所有的系统调用都改成这种极简模式？</p>
<p class="insight">原因在于：<b>极简现场保存是有高昂代价的。</b></p>
<p><b>1. 丧失了进程调度 (Scheduling) 的能力</b><br>
传统的抢占式操作系统在系统调用返回前，会检查当前进程的时间片是否用尽。如果需要调度，进程会被挂起，其寄存器状态必须被安全地保存在 <code>pt_regs</code> 中。<br>xcall 因为根本没有建立 <code>pt_regs</code>，它<b>绝对不能被挂起</b>！因此它只适用于保证绝不阻塞休眠的高频调用。</p>
<p><b>2. 丧失了信号处理 (Signal Handling) 的时机</b><br>像 Ctrl+C 这样的信号，通常是在系统调用返回用户态时顺手处理的。xcall 为追求极致速度直接砍掉了这段逻辑。</p>
<p><b>3. 内核追踪 (Strace) 失效</b><br>追求极限性能和追求极致可观测性往往是矛盾的。xcall 会绕过 <code>ptrace</code> 探测点。</p>
<div class="cmd-summary">
  <h4>📋 本案例命令小结</h4>
  <table>
    <tr><th>命令</th><th>作用</th></tr>
    <tr><td><code>redis-benchmark</code></td><td>Redis 内置压测工具，用 pipeline 模式发起海量请求。</td></tr>
    <tr><td><code>vmstat 1 3</code></td><td>每隔 1 秒打印一次全系统的 CPU 和内存宏观表现。</td></tr>
    <tr><td><code>perf top -p PID</code></td><td>采样指定进程，热点代码大摸底，谁在拖慢速度一目了然。</td></tr>
  </table>
</div>`
      }
    ];
"""

# Find the STEPS block and replace it
start_idx = html.find("const STEPS = [")
end_idx = html.find("];\n\n    class TerminalPlayer")
if start_idx != -1 and end_idx != -1:
    html = html[:start_idx] + new_steps_str.strip() + html[end_idx+1:]
else:
    print("Could not find STEPS array to replace")

# Replace AI keywords block
old_ai_start = html.find("function simulateAIResponse(query) {")
old_ai_end = html.find("appendMessage('ai', reply);\n    }") + len("appendMessage('ai', reply);\n    }")
if old_ai_start != -1 and old_ai_end != -1:
    new_ai = """function simulateAIResponse(query) {
      let reply = "这是一个模拟的 AI 回复。";
      
      if (query.includes("SVC") || query.includes("el0_sync")) {
        reply = "**SVC (Supervisor Call) 指令**\\n\\n在 ARM64 架构下，用户态应用要请求内核服务（如读文件、网络IO），必须要执行 `SVC #0`。这会触发硬件状态切换，并跳转到内核定好的异常处理向量入口（通常就是 `el0_sync`，意为来自 EL0 用户态的同步异常）。\\n\\n在这里内核开始保存巨大的上下文结构。";
      } else if (query.includes("pt_regs")) {
        reply = "**pt_regs 结构体**\\n\\n在操作系统内核中，每次发生异常或中断，要跨越特权级时，第一件事是必须把你目前的所有寄存器锁进栈里保管好，这堆寄存器的集合就叫 `pt_regs`。在 AArch64 中，保存/恢复 30 多个 64 位寄存器会消耗不少的 CPU 周期。";
      } else if (query.includes("openEuler") || query.includes("xcall")) {
        reply = "**xcall (极速系统调用)**\\n\\n这是华为为 openEuler 设计的内核态黑科技。核心思想是识别那些‘又短又高频’的内核调用过程（如内存和快速网络IO），然后绕开巨大的传统内核分发路径（不保存完整的 `pt_regs`），用极少的指令周期完成跨界执行然后迅速返回，极大提升了网络和缓存集群性能。";
      }
      
      const mdHtml = miniMarkdown(reply);
      appendMessage('ai', mdHtml);
    }
    
    function miniMarkdown(text) {
        return text
            .replace(/```(\\w*)\\n([\\s\\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
            .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/^---$/gm, '<hr>')
            .replace(/^\\d+\\.\\s+(.+)$/gm, '<li class="md-ol">$1</li>')
            .replace(/^[-*]\\s+(.+)$/gm, '<li>$1</li>')
            .replace(/(<li[^>]*>.*<\\/li>\\n?)+/g, m =>
                m.includes('md-ol') ? `<ol>${m}</ol>` : `<ul>${m}</ul>`)
            .replace(/\\n{2,}/g, '</p><p>')
            .replace(/\\n/g, '<br>')
            .replace(/^(.+)$/s, '<p>$1</p>')
            .replace(/<p><(h[34]|ul|ol|pre|hr)/g, '<$1')
            .replace(/<\\/(h[34]|ul|ol|pre)><\\/p>/g, '</$1>');
    }
"""
    html = html[:old_ai_start] + new_ai + html[old_ai_end:]

# Replace appendMessage to handle mdHtml properly (miniMarkdown is already handled inside simulateAIResponse before appendMessage)
# So we need to modify appendMessage a tiny bit
append_msg_start = html.find("function appendMessage(role, text) {")
append_msg_body = """function appendMessage(role, text) {
      const container = document.getElementById('chatMessages');
      const typing = document.getElementById('typingIndicator');
      if (typing) typing.remove();
      
      const msgDiv = document.createElement('div');
      msgDiv.className = `chat-msg ${role}`;
      // Note: text is already rendered HTML by simulateAIResponse, or raw text by user
      const isHtml = typeof text === 'string' && (text.includes('<p>') || text.includes('<strong>') || text.includes('<code>'));
      const renderStr = role === 'ai' && !isHtml ? text.replace(/\\n/g, '<br>') : text;
      msgDiv.innerHTML = `<div class="chat-bubble">${renderStr}</div>`;
      container.appendChild(msgDiv);
      container.scrollTop = container.scrollHeight;
      return msgDiv;
    }"""
append_msg_end = html.find("return msgDiv;\n    }") + len("return msgDiv;\n    }")
if append_msg_start != -1 and append_msg_end != -1:
     html = html[:append_msg_start] + append_msg_body + html[append_msg_end:]

chat_bubble_css = """
    /* Chat Bubble Markdown 样式 */
    .chat-bubble code { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; background: rgba(110,118,129,0.25); padding: 1px 5px; border-radius: 3px; color: var(--accent-yellow); }
    .chat-bubble pre { margin: 8px 0; padding: 10px; background: var(--bg-terminal); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; }
    .chat-bubble pre code { background: none; padding: 0; color: var(--text-primary); font-size: 12px; line-height: 1.5; }
    .chat-bubble strong { color: var(--text-primary); font-weight: 600; }
    .chat-bubble em { color: var(--text-secondary); }
    .chat-bubble ul, .chat-bubble ol { margin: 6px 0; padding-left: 20px; }
    .chat-bubble li { margin: 3px 0; line-height: 1.5; }
    .chat-bubble h3, .chat-bubble h4 { font-size: 13px; margin: 8px 0 4px; color: var(--accent-blue); }
    .chat-bubble hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
    .chat-bubble p { margin: 4px 0; }
    .cmd-summary { margin: 16px 0; }
    .cmd-summary h4 { font-size: 14px; margin-bottom: 8px; color: var(--accent-blue); }
    .cmd-summary table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .cmd-summary th { text-align: left; padding: 6px 10px; background: rgba(88,166,255,0.1); border-bottom: 1px solid var(--border); color: var(--accent-blue); font-weight: 600; }
    .cmd-summary td { padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-secondary); }
    .cmd-summary td code { color: var(--accent-yellow); background: rgba(110,118,129,0.2); padding: 1px 5px; border-radius: 3px; }
    .cmd-summary tr:hover td { background: rgba(255,255,255,0.03); }
"""
html = html.replace("/* ===== Control Bar ===== */", chat_bubble_css + "\n    /* ===== Control Bar ===== */")

# Remove image since we don't have hardware_setup.png yet
html = html.replace('<img src="hardware_setup.png" class="hardware-photo" alt="真实硬件连接图">', '')

with open("player.html", "w", encoding="utf-8") as f:
    f.write(html)
print("build success for openeuler_xcall player")
