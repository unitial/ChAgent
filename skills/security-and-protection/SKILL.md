---
name: 安全与保护
type: knowledge_point
enabled: true
description: TCB，身份验证，访问控制，隔离，最小权限，沙箱；基于 Lampson 安全框架
source: Butler Lampson
---

当学生询问 OS 安全机制、访问控制、权限隔离、沙箱、认证、加密、漏洞利用防护等问题时，先让学生说出自己的理解，再用以下框架引导。

## CIA 三角：安全的三个目标

| 目标 | 含义 | OS 机制 |
|------|------|---------|
| **Confidentiality（保密性）** | 数据只能被授权方读取 | 地址空间隔离、文件权限、加密 |
| **Integrity（完整性）** | 数据只能被授权方修改 | 写权限控制、校验和、代码签名 |
| **Availability（可用性）** | 授权用户能正常使用服务 | 资源配额、DoS 防护、冗余 |

提问：「一个 OS 漏洞通常影响 CIA 中的哪些方面？举个具体的漏洞例子。」

## TCB（Trusted Computing Base）

**定义**：系统中必须正确工作才能保证安全性的所有代码/硬件。

**黄金法则**：TCB 应该尽量小、简单、可审计。

| 组件 | 是否在 TCB 中 |
|------|-------------|
| CPU 微码 + MMU | 是 |
| OS 内核（特权代码） | 是 |
| 用户态应用 | 否（不信任） |
| 虚拟机监控器（Hypervisor） | 是（相对于 VM） |
| 内核模块/驱动程序 | 是（因此驱动 bug = 内核 bug） |

**端对端使 TCB 更小**：若通信两端都做加密验证（TLS），中间的网络设备不需要在 TCB 中。

提问：「为什么微内核（Microkernel）比宏内核（Monolithic kernel）更"安全"？代价是什么？」

## 四种安全机制

Lampson 的安全框架：**隔离 → 认证 → 授权 → 审计**

### 1. 隔离（Isolation）

通过硬件机制强制隔离：
- **地址空间隔离**：每个进程有独立的虚拟地址空间，无法直接访问其他进程内存
- **特权级（Ring）**：x86 Ring 0（内核）vs Ring 3（用户态），通过系统调用切换
- **容器/虚拟机**：更强的隔离边界（namespace + cgroup / hypervisor）

### 2. 认证（Authentication）

确认「你是谁」：
- 基于你知道的（密码）、你拥有的（U2F 密钥）、你是谁（生物特征）
- 密码存储：永远存 hash（bcrypt/Argon2），绝不存明文
- **A speaks for B**：A 的请求等价于 B 授权（委托认证）— 例：HTTPS 证书链

### 3. 授权（Authorization）

确认「你能做什么」：

| 模型 | 机制 | 特点 |
|------|------|------|
| **ACL（访问控制列表）** | 资源 → 允许访问的主体列表 | Unix 文件权限（owner/group/other） |
| **Capability（能力）** | 主体持有对资源的令牌 | 可以传递，更灵活；难以集中撤销 |
| **RBAC（角色访问控制）** | 用户→角色→权限 | 企业系统，便于管理 |

**最小权限原则（Least Privilege）**：每个组件只拥有完成其任务所必需的最小权限。

例：Web 服务器不应以 root 运行；编辑器不应有网络访问权限。

### 4. 审计（Auditing）

记录所有敏感操作，用于事后分析：
- Linux audit 框架（`auditd`）
- 不可篡改的日志（append-only，异地备份）

## 沙箱（Sandboxing）

两种隔离方向：
- **保护 Host 免受 App 侵害**：浏览器沙箱（Chrome：渲染进程无特权）、Docker
- **保护 App 免受 Host 侵害**：VM（App 不信任 OS），TEE（Intel SGX）

实现机制：
- **seccomp**：限制进程可调用的系统调用集合
- **namespace**：PID/网络/文件系统等各类资源的隔离视图
- **cgroup**：资源使用配额（CPU、内存、I/O）

## 常见安全错误与防护

| 漏洞类型 | 原理 | 防护 |
|---------|------|------|
| Buffer Overflow | 写超出数组边界，覆盖返回地址 | Stack Canary、NX（不可执行栈）、ASLR |
| TOCTOU | Check 和 Use 之间状态改变 | 原子操作（openat + fstat vs stat + open） |
| Privilege Escalation | 利用 setuid 程序的漏洞 | 最小权限、seccomp 过滤 |
| Side Channel | 通过时间/缓存行为推断秘密 | Spectre/Meltdown 缓解（KPTI、Retpoline） |

提问：「ASLR 如何防止缓冲区溢出攻击？它能完全防止吗？Spectre 为什么绕过了传统的隔离机制？」

## 常见学生误区

| 误区 | 正确理解 |
|------|---------|
| 加密 = 安全 | 加密只解决保密性，不解决完整性和可用性 |
| 防火墙 = 不会被攻击 | 防火墙只是外围防护，内部漏洞仍然危险 |
| root 才能做危险操作 | setuid 程序可以让普通用户以特权执行特定操作，存在风险 |
| 密码越长越好 | 多因素认证（MFA）比单纯长密码更有效 |
