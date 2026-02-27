---
name: 事务与日志
type: knowledge_point
enabled: true
description: ACID 事务，Redo/Undo 日志，Write-Ahead Logging，崩溃恢复，原子性实现原理
source: Butler Lampson
---

当学生询问 ACID、数据库事务、文件系统 Journal、Write-Ahead Log（WAL）、崩溃恢复、原子写入等问题时，先让学生说出自己的理解，再用以下框架引导。

## 为什么需要事务？

核心问题：对多个数据项的更新需要**原子性**——要么全部完成，要么全部不完成。

典型场景：
- 银行转账：`A -= 100; B += 100`（中途崩溃会导致钱凭空消失）
- 文件系统：创建文件需要更新 inode + 目录项 + 位图（中途崩溃会导致不一致）
- 包管理器：安装软件更新多个文件（中途断电导致系统无法启动）

提问：「如果操作系统在写磁盘中途断电，文件系统会处于什么状态？」

## ACID 四个性质

| 性质 | 含义 | 实现机制 |
|------|------|---------|
| **Atomic（原子性）** | 全做或全不做 | Redo/Undo 日志 |
| **Consistent（一致性）** | 保持数据满足约束 | Abort 回滚到一致状态 |
| **Isolated（隔离性）** | 并发事务互不干扰 | 锁 / OCC / MVCC |
| **Durable（持久性）** | 提交后数据永久保存 | 提交前强制刷盘（fsync） |

## Redo 日志（Write-Ahead Logging）

**核心思想**：Lampson —「把任意原子更新归约为：向日志末尾追加一条记录」

**WAL 规则**：
1. 在修改数据之前，先将 Redo 日志记录写入磁盘（Write-Ahead）
2. 提交时，写入 COMMIT 记录并 fsync
3. 之后可以将修改异步写回数据文件

**为什么日志追加是原子的？**
- 磁盘的单个扇区（512B）写入是原子的（设备保证）
- 日志记录设计为单扇区大小，或用 checksum 检测部分写
- 追加操作只移动尾指针，不修改已有数据

**崩溃恢复流程（ARIES 算法）**：
1. **Analysis（分析）**：扫描日志，确定崩溃时哪些事务未提交
2. **Redo（重做）**：从最早未完成 checkpoint 开始，重放所有已提交事务的操作
3. **Undo（撤销）**：对未提交事务的修改，逐一撤销（用 Undo 日志）

提问：「重做（Redo）操作的结果必须是幂等的，为什么？如果不是会怎样？」

## Checkpoint（检查点）

**问题**：日志会无限增长，崩溃恢复需要重放所有日志
**解决**：定期做 Checkpoint
1. 将所有脏页（dirty page）刷写到磁盘
2. 记录 Checkpoint 记录到日志
3. 之前的日志可以截断（不再需要用于恢复）

**Fuzzy Checkpoint**：不要求在 checkpoint 时暂停所有事务，允许脏页异步刷盘（需要额外记录哪些页已刷盘）

## 文件系统 Journal vs. 数据库 WAL

| | 文件系统 Journal | 数据库 WAL |
|-|-----------------|-----------|
| 保护对象 | 文件系统元数据（inode、目录项） | 数据库记录 |
| 原子单元 | 一次系统调用（write/rename/link） | 一个事务（可含多条 SQL） |
| 数据 Journal | 可选（ext4 data=journal 模式） | 总是记录数据 |
| 实现 | ext4、XFS、NTFS | PostgreSQL WAL、SQLite WAL |

**ext4 三种 Journal 模式**：
- `data=writeback`：只 journal 元数据，数据先写数据区（性能最高，数据有风险）
- `data=ordered`（默认）：元数据 journal，但数据先于元数据写入
- `data=journal`：所有数据都写入 journal（最安全，性能最低）

提问：「为什么数据库在有了文件系统 Journal 的情况下，还要自己维护 WAL？」

## Log-Structured File System（LFS）

**核心思想**：整个磁盘是一个巨大的环形日志，所有写入都追加到日志末尾

优点：
- 顺序写性能极高（对 HDD 尤其显著）
- 崩溃恢复简单（日志本身就是数据）

缺点：
- 读取需要通过 inode map 间接寻址（随机读性能下降）
- Garbage collection（清理旧版本数据）开销大

## 常见学生误区

| 误区 | 正确理解 |
|------|---------|
| 写了数据就是持久化 | 必须 fsync() 才能保证刷盘；write() 只写到 page cache |
| Journal 保证数据不丢失 | Journal 保证元数据一致性，不一定保证数据内容（取决于 journal 模式） |
| Redo 和 Undo 日志是一种东西 | Redo 用于重放已提交事务，Undo 用于回滚未提交事务 |
| Checkpoint 之后旧日志可以立即删除 | 需要确认所有脏页都已刷盘，才能截断日志 |
