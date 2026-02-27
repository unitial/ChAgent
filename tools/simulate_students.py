"""
simulate_students.py
模拟4名大三学生使用学生端，产生真实的对话数据。
"""
import time
import sys
import requests

BASE = "http://localhost:8000/api/student"


def login(name: str) -> str:
    r = requests.post(f"{BASE}/login", json={"name": name}, timeout=10)
    r.raise_for_status()
    token = r.json()["access_token"]
    print(f"[login] {name} ✓")
    return token


def chat(token: str, message: str, session_id: int | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    body = {"message": message}
    if session_id is not None:
        body["session_id"] = session_id
    r = requests.post(f"{BASE}/chat", json=body, headers=headers, timeout=60)
    r.raise_for_status()
    data = r.json()
    preview = data["reply"].replace("\n", " ")[:120]
    print(f"  ← {preview}…")
    return data


def start_challenge(token: str) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{BASE}/challenge/start", headers=headers, timeout=60)
    r.raise_for_status()
    return r.json()


def run(label: str, token: str, messages: list[str], session_id: int | None = None, delay: float = 2.0):
    sid = session_id
    for msg in messages:
        print(f"\n[{label}] {msg}")
        result = chat(token, msg, sid)
        sid = result["session_id"]
        time.sleep(delay)
    return sid


# ──────────────────────────────────────────────
# 张伟：中等水平，搞不清进程/线程，追问死锁
# ──────────────────────────────────────────────
def simulate_zhang_wei():
    print("\n" + "=" * 50)
    print("张伟  ·  进程/线程/死锁")
    print("=" * 50)
    token = login("张伟")

    msgs1 = [
        "老师，进程和线程有什么区别？我总感觉概念很模糊",
        "那线程比进程轻量是因为不用复制地址空间吗？",
        "多线程共享内存的话，会不会有数据冲突的问题？",
        "怎么用锁来解决这个问题，能举个例子吗？",
        "如果两个线程互相等对方的锁，会不会就卡住了？这是死锁吗？",
        "死锁的四个必要条件我只记得互斥和循环等待，另外两个是啥来着",
        "银行家算法是用来避免死锁还是检测死锁的？",
    ]
    run("张伟", token, msgs1, delay=3)
    print("\n  [间隔，模拟下一天回来继续提问]")
    time.sleep(2)

    msgs2 = [
        "老师我又来了，昨天讲的锁我还有点不懂，wait()和signal()是什么关系",
        "条件变量为什么要放在while循环里判断，放if不行吗",
        "生产者消费者问题里，缓冲区满了生产者要wait，消费者取走东西后signal，这样理解对吗",
    ]
    run("张伟", token, msgs2, delay=3)


# ──────────────────────────────────────────────
# 李明：较强，深入虚拟内存、TLB、页面置换
# ──────────────────────────────────────────────
def simulate_li_ming():
    print("\n" + "=" * 50)
    print("李明  ·  虚拟内存深度追问")
    print("=" * 50)
    token = login("李明")

    msgs = [
        "虚拟地址到物理地址的转换，TLB miss之后的完整流程能讲一下吗",
        "多级页表和单级页表相比，优势是节省内存，但代价是多次内存访问，这样理解对吗",
        "TLB是每个进程独立的还是全局共享的？进程切换的时候TLB怎么处理",
        "ASID是用来解决进程切换flush TLB性能问题的，对吗？",
        "缺页中断处理时，如果物理内存满了要换出一页，LRU在硬件上怎么实现，好像代价很高",
        "CLOCK算法是LRU的近似，用一个reference bit，能详细说说它的工作过程吗",
        "写时复制（COW）的具体实现：fork()之后父子进程共享物理页，写的时候才复制，page fault处理程序怎么区分是COW还是普通缺页",
        "Linux里面/proc/pid/maps看到的那些vma是虚拟内存区域，和物理内存的对应是lazy的，这个理解对吗",
    ]
    run("李明", token, msgs, delay=3)


# ──────────────────────────────────────────────
# 王芳：偏弱，有误解，需要引导纠正
# ──────────────────────────────────────────────
def simulate_wang_fang():
    print("\n" + "=" * 50)
    print("王芳  ·  有误解，需要纠正")
    print("=" * 50)
    token = login("王芳")

    msgs = [
        "CPU调度里，进程优先级高的一定先执行吗",
        "时间片轮转里，时间片越小越好吧，因为响应越快",
        "我以为虚拟内存就是把内存扩大了，和硬盘没关系？",
        "文件系统里inode是干什么的，和文件名有什么关系",
        "rm删除文件之后数据还在硬盘上吗，为什么",
        "RAID0是把两块硬盘合并成一块，坏了一块数据就全丢了，这个对吗",
        "请问操作系统课期末考试重点是什么",
    ]
    run("王芳", token, msgs, delay=3)


# ──────────────────────────────────────────────
# 陈雷：进入挑战模式，接受调度算法考察
# ──────────────────────────────────────────────
def simulate_chen_lei():
    print("\n" + "=" * 50)
    print("陈雷  ·  挑战模式（调度算法）")
    print("=" * 50)
    token = login("陈雷")

    # 先普通聊几句，再进挑战模式
    msgs_before = [
        "我想复习一下调度算法，能帮我梳理一下主要有哪些吗",
        "MLFQ中，新进程为什么要放在最高优先级队列",
    ]
    run("陈雷", token, msgs_before, delay=3)

    print("\n  [陈雷进入挑战模式]")
    time.sleep(2)
    challenge = start_challenge(token)
    sid = challenge["session_id"]
    print(f"  [challenge session_id={sid}]")
    time.sleep(3)  # 等AI生成开场白

    msgs_challenge = [
        "我想挑战调度算法",
        "FCFS会有护航效应，就是一个长作业拖慢所有后面的短作业",
        "SJF需要预测下一次CPU使用时间，可以用指数平均来估计",
        "抢占式SJF也叫SRTN，最短剩余时间优先",
        "优先级调度可能导致低优先级进程永远得不到CPU，这叫饥饿，可以用aging解决",
        "我觉得差不多了，感觉今天的挑战还可以",
        "退出挑战",
    ]
    run("陈雷", token, msgs_challenge, session_id=sid, delay=3)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
if __name__ == "__main__":
    students = {
        "1": ("张伟", simulate_zhang_wei),
        "2": ("李明", simulate_li_ming),
        "3": ("王芳", simulate_wang_fang),
        "4": ("陈雷", simulate_chen_lei),
    }

    if len(sys.argv) > 1:
        keys = sys.argv[1:]
    else:
        keys = list(students.keys())

    for k in keys:
        if k in students:
            name, fn = students[k]
            try:
                fn()
            except Exception as e:
                print(f"[ERROR] {name}: {e}")
            time.sleep(3)

    print("\n\n✓ 模拟完成")
