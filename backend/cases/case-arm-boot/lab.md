# Lab: ARM64 启动故障排查 —— 从"串口沉默"到找出真凶

**目标**：在 QEMU 中复现 ARM64 内核启动失败（"Starting kernel ... 之后无输出"），用 GDB 诊断故障根因，修复设备树后成功启动。

**耗时**：45-60 分钟 | **难度**：★★★☆☆

---

## 📋 环境准备

在 Ubuntu/WSL2 中安装以下工具：

```bash
sudo apt update
sudo apt install -y qemu-system-aarch64 gcc-aarch64-linux-gnu \
    device-tree-compiler gdb-multiarch wget
```

创建工作目录并下载 ARM64 Linux 内核：

```bash
mkdir -p ~/arm64-lab && cd ~/arm64-lab

# 下载 Debian 预编译的 ARM64 内核和 initrd
wget -q http://ftp.debian.org/debian/dists/bookworm/main/installer-arm64/current/images/netboot/debian-installer/arm64/linux -O linux
wget -q http://ftp.debian.org/debian/dists/bookworm/main/installer-arm64/current/images/netboot/debian-installer/arm64/initrd.gz -O initrd.gz
echo "✅ 下载完成：$(ls -lh linux initrd.gz | awk '{print $5, $NF}')"
```

---

## 🎬 第一幕：正常启动——建立基线

> 在排查故障之前，先看看"正常"长什么样。

### 步骤 1.1：导出 QEMU virt 平台的设备树

QEMU 的 `virt` 平台会自动生成一份正确的设备树。先把它导出来看看：

```bash
cd ~/arm64-lab

# 导出 QEMU 自动生成的设备树
qemu-system-aarch64 \
    -M virt,dumpdtb=good.dtb -cpu cortex-a72 -m 256M -nographic

# 反编译成可读的 DTS 格式
dtc -I dtb -O dts -o good.dts good.dtb
```

#### ✋ 停下来看看

用你熟悉的方式（`cat`, `less`, `grep`）查看 `good.dts`，回答以下问题：

1. 找到串口节点——它的 `compatible` 属性是什么？基地址是多少？
2. 找到 `chosen` 节点——`stdout-path` 指向谁？
3. 找到 `memory` 节点——内存起始地址和大小是多少？

```bash
# 提示：用 grep 快速定位
grep -A5 "pl011" good.dts
grep -A3 "chosen" good.dts
grep -A3 "memory@" good.dts
```

<details>
<summary>📌 参考答案（先自己找，再展开核对）</summary>

- 串口：`compatible = "arm,pl011"`，基地址 `0x9000000`
- `stdout-path` 指向 `/pl011@9000000`（即串口设备）
- 内存：起始 `0x40000000`，大小 `0x10000000`（256MB）

</details>

### 步骤 1.2：用正确的设备树启动内核

```bash
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M -smp 2 \
    -nographic \
    -kernel linux \
    -initrd initrd.gz \
    -append "console=ttyAMA0 earlycon"
```

你应该看到完整的内核启动日志。留意以下关键行：

```
[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd083]
[    0.000000] Machine model: linux,dummy-virt
...
[    0.xxxxxx] Serial: AMBA PL011 UART driver
[    0.xxxxxx] 9000000.pl011: ttyAMA0 at MMIO 0x9000000 ...
```

> 📌 记住这个输出模式——它就是"健康"的样子。

按 **Ctrl+A** 然后按 **X** 退出 QEMU。

---

## 💀 第二幕：制造故障——串口沉默

> 现在你来扮演"把旧板 SD 卡插到新板"的角色。

### 步骤 2.1：制造一个"错误的设备树"

假设"新板"的串口不在 `0x9000000`，而在 `0x1c28000`（一个旧板的地址，在新板上什么都没有）。我们来篡改设备树：

```bash
cd ~/arm64-lab

# 复制正确的设备树，然后篡改
cp good.dts broken.dts

# 把串口地址从 0x9000000 改成 0x1c28000
sed -i 's/0x9000000/0x1c28000/g' broken.dts

# 编译成 DTB
dtc -I dts -O dtb -o broken.dtb broken.dts
```

#### ✋ 确认改对了

```bash
diff <(grep "pl011\|9000000\|1c28000" good.dts) \
     <(grep "pl011\|9000000\|1c28000" broken.dts)
```

你应该看到所有 `9000000` 都变成了 `1c28000`。

### 步骤 2.2：用错误的设备树启动——观察症状

```bash
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M \
    -nographic \
    -kernel linux \
    -dtb broken.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000"
```

> 💡 我们仍然用 `earlycon=pl011,0x9000000` 硬编码了正确的早期控制台地址。这样你能看到**前几行**内核日志（earlycon 不依赖设备树），但当内核初始化正式的串口驱动时，它会去找设备树中的错误地址—— 输出将突然停止。

#### ✋ 观察

等待 10-15 秒。你应该看到：
- 前几行内核日志正常输出（来自 earlycon）
- 然后输出突然停止，或内核直接卡死
- **再也没有新的输出**

这就是案例中"Starting kernel ... 之后无输出"的症状！

按 **Ctrl+A** 然后按 **X** 退出 QEMU。

#### ❓ 思考题

此时你只知道"内核不说话了"。但你不知道：
1. 内核还活着吗？还是已经 panic 了？
2. 如果活着，它卡在哪里了？
3. 如果 panic 了，panic 的原因是什么？

要回答这些问题，你需要一种**不依赖串口**的调试手段。在真实硬件上用 JTAG；在 QEMU 中，我们用 **GDB**。

---

## 🔍 第三幕：用 GDB 诊断——读取 CPU 的"内心想法"

### 步骤 3.1：启动 QEMU 并等待 GDB 连接

打开一个新终端（保持当前终端不关），启动 QEMU，这次加上 GDB 调试选项：

```bash
cd ~/arm64-lab

# 终端 1
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M \
    -nographic \
    -kernel linux \
    -dtb broken.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000" \
    -s -S
```

> `-S`：启动后 CPU 暂停，等待 GDB 发出 `continue` 命令  
> `-s`：在端口 1234 上启动 GDB server

终端应该停在那里，没有任何输出（CPU 被暂停了）。

### 步骤 3.2：用 GDB 连接并让内核跑一会儿

在另一个终端中：

```bash
cd ~/arm64-lab

# 终端 2
gdb-multiarch linux
```

在 GDB 中执行：

```gdb
(gdb) target remote :1234
(gdb) continue
```

切换回终端 1，你应该看到 earlycon 输出了几行日志，然后停止了——和步骤 2.2 一样的症状。

等大约 5 秒，然后回到 GDB 终端（终端 2），按 **Ctrl+C** 暂停 CPU：

```gdb
^C
Program received signal SIGINT ...
(gdb)
```

### 步骤 3.3：检查 CPU 状态——它还活着吗？

```gdb
(gdb) info reg pc cpsr
```

#### ✋ 观察并回答

1. **PC（程序计数器）** 的值是多少？它是 `0xffff....` 开头吗？
2. 如果 PC 是 `0xffff....` 开头，说明什么？（提示：虚拟地址 vs 物理地址，MMU 开了吗？）

<details>
<summary>📌 提示</summary>

- `0xffff800...` 开头 = 内核虚拟地址空间 = MMU 已开启 = 内核跑得很远了
- `0x4000...` 开头 = 物理地址 = 内核还在早期阶段，MMU 未开启

</details>

再检查异常级别：

```gdb
(gdb) print/x $CurrentEL
```

> 💡 ARM64 的 `CurrentEL` 寄存器的异常级别存在 Bit[3:2]：
> - `0x4` = EL1（内核态）
> - `0x8` = EL2（Hypervisor）
> - `0xC` = EL3（安全监控）

#### ✋ Checkpoint

如果你看到 `CurrentEL = 0x4`，说明 CPU 运行在 EL1（内核态）。结合 PC 在虚拟地址空间，可以确认：**内核已经启动了，MMU 也开了，CPU 还活着——只是串口驱动出了问题**。

### 步骤 3.4：读取内核日志缓冲区——嘴巴哑了，脑子还有记忆

即使串口不输出，`printk()` 仍然会把日志写入内核的内存缓冲区（`log_buf`）。我们用 GDB 直接读取它：

```gdb
(gdb) # 查找内核日志缓冲区的地址
(gdb) print &__log_buf
```

如果上面的命令报错（符号找不到），改用另一种方式——直接搜索内存中的关键字符串。由于内核 dmesg 总是以 `"Booting Linux"` 开头，可以试着在内核内存中搜索：

```gdb
(gdb) # 方法一：如果有符号，直接 lx-dmesg
(gdb) # 方法二：搜索 printk 环形缓冲区描述符
(gdb) print (char *)&prb
```

> 💡 **实际操作提示**：在现代 Linux 内核（5.10+）中，`printk` 使用无锁环形队列，直接读内存比较复杂。最可靠的方式是使用内核自带的 GDB 扩展脚本。但在本 lab 的 QEMU 环境中，我们可以用一个更简单的技巧——直接看 QEMU 的串口输出日志。

让我们换一种方式——用 QEMU 的 `-d` 选项捕获 guest 输出。先退出 GDB 和 QEMU。

### 步骤 3.5：用 QEMU 的串口日志文件捕获内核输出

```bash
cd ~/arm64-lab

# 把串口输出重定向到文件（同时保留终端输出）
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M \
    -nographic \
    -kernel linux \
    -dtb broken.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000" \
    -serial mon:stdio \
    -d guest_errors 2>qemu_errors.log &

QEMU_PID=$!
sleep 10
kill $QEMU_PID 2>/dev/null

# 检查 QEMU 的客户端错误日志
cat qemu_errors.log
```

> 💡 QEMU 的 `-d guest_errors` 选项会在客户端（内核）触发异常时记录日志。如果内核试图访问一个不存在的 MMIO 地址，QEMU 可能会报告。

### 步骤 3.6：用 earlycon + dmesg 对比定位故障

回忆第一幕中正常启动的日志。正常时看到：

```
Serial: AMBA PL011 UART driver
9000000.pl011: ttyAMA0 at MMIO 0x9000000 ...
```

现在用错误 DTB 启动时，earlycon 能输出的最后几行是什么？关键线索是：

1. 内核试图初始化串口驱动
2. 设备树告诉它串口在 `0x1c28000`
3. 那个地址上什么都没有
4. CPU 访问时触发异常

#### ✋ 诊断结论

> **根因**：设备树中串口节点的基地址 (`0x1c28000`) 与实际硬件 (`0x9000000`) 不匹配。内核按照设备树的指示，访问了一个无效的 MMIO 地址，导致启动失败。

---

## 🔧 第四幕：修复——换上正确的设备树

### 步骤 4.1：审查差异

```bash
cd ~/arm64-lab

# 对比正确和错误的设备树
diff good.dts broken.dts | head -30
```

### 步骤 4.2：用正确的设备树重新启动

```bash
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M -smp 2 \
    -nographic \
    -kernel linux \
    -initrd initrd.gz \
    -dtb good.dtb \
    -append "console=ttyAMA0 earlycon"
```

#### ✋ 确认修复成功

你应该看到完整的内核启动日志，包括：

```
Serial: AMBA PL011 UART driver
9000000.pl011: ttyAMA0 at MMIO 0x9000000 (irq = ...) is a PL011 rev3
```

按 **Ctrl+A** 然后按 **X** 退出。

### 步骤 4.3：进阶实验——只修复串口节点

不用整个替换回正确的 DTB，而是**只修改**错误 DTB 中的串口地址。这模拟了真实场景中"为新板适配设备树"的操作。

```bash
cd ~/arm64-lab

# 从错误的 DTS 出发，只修复串口地址
cp broken.dts fixed.dts
sed -i 's/0x1c28000/0x9000000/g' fixed.dts

# 重新编译
dtc -I dts -O dtb -o fixed.dtb fixed.dts

# 验证修复
qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M -smp 2 \
    -nographic \
    -kernel linux \
    -initrd initrd.gz \
    -dtb fixed.dtb \
    -append "console=ttyAMA0 earlycon"
```

🎉 **内核应该成功启动！** 你刚刚完成了与案例中工程师相同的排障和修复流程。

---

## 🧪 附加实验：破坏 compatible 属性

除了改错地址，还有一种更隐蔽的故障——让内核"认不出"串口硬件。

```bash
cd ~/arm64-lab

cp good.dts broken_compat.dts
# 把 "arm,pl011" 改成一个不存在的驱动名
sed -i 's/"arm,pl011"/"arm,pl011-nope"/g' broken_compat.dts
dtc -I dts -O dtb -o broken_compat.dtb broken_compat.dts

qemu-system-aarch64 \
    -M virt -cpu cortex-a72 -m 256M \
    -nographic \
    -kernel linux \
    -dtb broken_compat.dtb \
    -append "console=ttyAMA0 earlycon=pl011,0x9000000"
```

#### ✋ 观察差异

这次的症状和改错地址时有什么不同？

<details>
<summary>📌 分析</summary>

- **改错地址**：内核 `pl011` 驱动匹配成功，但访问错误的 MMIO 地址时触发异常 → 硬崩溃
- **改错 compatible**：没有驱动能匹配设备 → 串口设备被静默忽略 → 内核可能正常运行，但没有控制台输出（"活着但哑了"）

这是两种不同的故障模式：一种是"去了错误的地方"，一种是"忘了带翻译"。

</details>

---

## 📊 总结

| 你做了什么 | 对应真实场景 | 核心知识点 |
|-----------|------------|-----------|
| 导出/查看 QEMU 设备树 | 阅读硬件手册 | DTB 结构、设备节点 |
| 用错误 DTB 启动 | 旧板 SD 卡插新板 | 内核与 DTB 的关系 |
| GDB 检查 CPU 寄存器 | JTAG 调试器 | 异常级别、PC、MMU |
| 对比 earlycon vs 正式串口 | 串口沉默的诊断 | earlycon 机制 |
| 修改 DTS 并重编译 | 为新板适配设备树 | dtc 工具链 |
| 破坏 compatible 属性 | 驱动匹配失败 | 设备-驱动绑定 |

## 💡 思考题

1. 为什么 `earlycon` 能在设备树出错的情况下仍然输出日志？它和正式的 console 驱动有什么区别？
2. 在 ARM 总线上访问一个不存在的地址会报 DECERR，而在 x86 PCI 总线上通常返回 `0xFFFFFFFF`。这两种设计哲学各有什么优劣？
3. 如果你要同时支持 10 款不同的开发板，Linux 发行版的安装镜像中应该带多少个 `.dtb` 文件？看看 `/boot/dtbs/` 目录（或 Debian 的 `linux-image` 包）是怎么做的。
