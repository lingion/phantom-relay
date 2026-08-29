#!/usr/bin/env python3
"""Audit #5 — 只读审计：并发、队列、lease、stale job、tab binding、worker death、重复请求

只读探针，不启动浏览器，不改文件。证据优先，中文报告。

Covers:
  1. 并发 (Concurrency): BROWSER_LOCK 互斥、并行 claim、竞态条件
  2. 队列 (Queue): 顺序、优先级、queue 完整性、stale 清理
  3. lease: lease 生命周期、续约、过期回收
  4. stale job: 僵尸 job 检测、重新入队、binding 清理
  5. tab binding: 绑定隔离、跨 tab 攻击防护、binding TTL
  6. worker death: worker 消失时 lease 回收、job 重新分配
  7. 重复请求 (Duplicate): 幂等 key 去重、并行重复提交
"""

import importlib.util
import pathlib
import threading
import time
import json
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "phantom_api", ROOT / "server" / "api_server.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api_module()

PASS = 0
FAIL = 0
FINDINGS = []  # (severity, title, detail)


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  — {detail}")
    return condition


def finding(severity, title, detail):
    FINDINGS.append((severity, title, detail))
    marker = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵", "INFO": "⚪"}
    print(f"  {marker.get(severity, '?')} [{severity}] {title}: {detail}")


def reset_state():
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()
    api.BROWSER_READY.clear()
    api.BROWSER_READY_EVENTS.clear()
    api.IDEMPOTENCY.clear()
    api.POLL_LAST.clear()


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 并发 (Concurrency) — BROWSER_LOCK 互斥与竞态条件
# ═══════════════════════════════════════════════════════════════════════════════
def probe_concurrency():
    print("\n=== 1. 并发 (Concurrency) ===")
    reset_state()

    # 1a: BROWSER_LOCK 是一个标准 threading.Lock — 确认
    check("1a.1 BROWSER_LOCK 是 threading.Lock",
          isinstance(api.BROWSER_LOCK, type(threading.Lock())))

    # 1b: BROWSER_LOCK 互斥 — 同时只能有一线程持有
    lock_held = threading.Event()
    enter_barrier = threading.Event()
    release_barrier = threading.Event()
    results = []

    def lock_holder():
        with api.BROWSER_LOCK:
            lock_held.set()  # tell main we have the lock
            enter_barrier.wait(timeout=5)  # wait for contender to try
        release_barrier.set()

    def lock_contender():
        lock_held.wait(timeout=5)  # wait until holder has the lock
        acquired = api.BROWSER_LOCK.acquire(blocking=False)
        results.append(acquired)
        enter_barrier.set()  # tell holder we tried
        if acquired:
            api.BROWSER_LOCK.release()

    t1 = threading.Thread(target=lock_holder)
    t2 = threading.Thread(target=lock_contender)
    t1.start()
    t2.start()
    t1.join(timeout=10)
    t2.join(timeout=10)
    check("1b.1 BROWSER_LOCK 阻止并行获取", len(results) == 1 and results[0] is False)

    # 1c: 并行 new_browser_job — 多个线程同时创建 job
    reset_state()
    job_count = 50
    errors = []
    created_ids = set()

    def create_job_batch(start, count):
        try:
            for i in range(start, start + count):
                j = api.new_browser_job(f"msg-{i}", domain="concurrent.com", model="m")
                if j["id"] in created_ids:
                    errors.append(f"duplicate id: {j['id']}")
                created_ids.add(j["id"])
        except Exception as e:
            errors.append(f"thread error: {e}")

    threads = []
    batch_size = job_count // 5
    for t_idx in range(5):
        t = threading.Thread(target=create_job_batch, args=(t_idx * batch_size, batch_size))
        threads.append(t)
        t.start()
    for t in threads:
        t.join(timeout=10)

    check("1c.1 并行创建 50 jobs 无崩溃", len(errors) == 0,
          f"errors: {errors[:5]}" if errors else "")
    check("1c.2 并行创建 50 jobs 无重复 ID", len(created_ids) == job_count,
          f"got {len(created_ids)} unique out of {job_count}")
    check("1c.3 并行 jobs 全部状态 queued",
          all(api.BROWSER_JOBS[jid]["status"] == "queued" for jid in created_ids))
    check("1c.4 队列完整", len(api.BROWSER_QUEUE) == job_count)

    # 1d: 并行 claim — 两个线程同时 claim 同一 job
    reset_state()
    job = api.new_browser_job("race", domain="race.com", model="m",
                              conversation_id="conv-race")
    api.BROWSER_CLIENTS["10"] = {
        "tab_id": 10, "domain": "race.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    api.BROWSER_CLIENTS["20"] = {
        "tab_id": 20, "domain": "race.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claim_results = []

    def claimer(tab_id):
        r = api.claim_browser_job("race.com", tab_id, "conv-race")
        claim_results.append((tab_id, r))

    t10 = threading.Thread(target=claimer, args=(10,))
    t20 = threading.Thread(target=claimer, args=(20,))
    t10.start()
    t20.start()
    t10.join(timeout=5)
    t20.join(timeout=5)

    successes = [r for _, r in claim_results if r is not None]
    failures = [r for _, r in claim_results if r is None]
    check("1d.1 并行 claim: 仅一个线程成功", len(successes) == 1,
          f"successes={len(successes)}, failures={len(failures)}")
    check("1d.2 成功 claim 的 job 状态为 claimed",
          len(successes) == 1 and successes[0]["status"] == "claimed")
    check("1d.3 job 不在队列中", job["id"] not in api.BROWSER_QUEUE,
          f"queue still has job")
    check("1d.4 失败 claim 返回 None", len(failures) == 1)

    # 1e: 并行队列操作 — 同时 poll 和 submit
    reset_state()
    sync_errors = []

    def enqueuer():
        try:
            for i in range(100):
                api.new_browser_job(f"eq-{i}", domain="sync.com", model="m")
        except Exception as e:
            sync_errors.append(f"enqueuer: {e}")

    def dequeuer():
        try:
            api.BROWSER_CLIENTS["d1"] = {
                "tab_id": "d1", "domain": "sync.com",
                "capabilities": {"can_observe": True, "can_execute": True},
                "last_seen": time.time(),
            }
            while api.BROWSER_QUEUE:
                claimed = api.claim_browser_job("sync.com", "d1")
                if claimed:
                    claimed["status"] = "claimed"
                    api.finish_browser_job(claimed["id"], "completed",
                                           result={"assistant": "ok"})
        except Exception as e:
            sync_errors.append(f"dequeuer: {e}")

    t_enq = threading.Thread(target=enqueuer)
    t_deq = threading.Thread(target=dequeuer)
    t_enq.start()
    time.sleep(0.05)
    t_deq.start()
    t_enq.join(timeout=10)
    t_deq.join(timeout=10)

    check("1e.1 并行入队/出队无异常", len(sync_errors) == 0,
          f"errors: {sync_errors[:5]}" if sync_errors else "")

    # 1f: BROWSER_LOCK 竞争压力测试 — 多线程高频操作
    reset_state()
    stress_errors = []

    def stress_worker(worker_id):
        try:
            for i in range(200):
                # mixed operations under lock
                with api.BROWSER_LOCK:
                    # enqueue
                    jid = f"stress_{worker_id}_{i}_{uuid.uuid4().hex[:4]}"
                    api.BROWSER_JOBS[jid] = {
                        "id": jid, "status": "queued", "domain": "stress.com",
                        "conversation_id": f"conv-{worker_id}",
                        "claim_token": uuid.uuid4().hex,
                        "queued_at": time.time(),
                    }
                    api.BROWSER_QUEUE.append(jid)
                    # remove old ones
                    if len(api.BROWSER_QUEUE) > 500:
                        while len(api.BROWSER_QUEUE) > 400:
                            old = api.BROWSER_QUEUE.pop(0)
                            api.BROWSER_JOBS.pop(old, None)
        except Exception as e:
            stress_errors.append(f"worker {worker_id}: {e}")

    stress_threads = [threading.Thread(target=stress_worker, args=(i,)) for i in range(10)]
    for t in stress_threads:
        t.start()
    for t in stress_threads:
        t.join(timeout=15)

    check("1f.1 10 线程压力测试无异常", len(stress_errors) == 0,
          f"{len(stress_errors)} errors" if stress_errors else "")

    # 1g: ThreadingHTTPServer 并发模型 — 每个请求独立线程
    finding("INFO", "ThreadingHTTPServer 并发模型",
            "使用 Python ThreadingHTTPServer，每个请求创建独立线程。"
            "BROWSER_LOCK 保证关键区互斥，但 HTTP 处理本身无请求级超时。"
            "建议: 确认生产环境有 reverse proxy 限流。")


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 队列 (Queue) — 顺序、优先级、完整性
# ═══════════════════════════════════════════════════════════════════════════════
def probe_queue():
    print("\n=== 2. 队列 (Queue) ===")
    reset_state()

    # 2a: 队列 FIFO 顺序 — 先入先出
    job1 = api.new_browser_job("first", domain="q.com", model="m")
    time.sleep(0.001)
    job2 = api.new_browser_job("second", domain="q.com", model="m")
    time.sleep(0.001)
    job3 = api.new_browser_job("third", domain="q.com", model="m")

    check("2a.1 队列顺序: first → second → third",
          api.BROWSER_QUEUE == [job1["id"], job2["id"], job3["id"]])

    # 2b: claim 按队列顺序出队
    api.BROWSER_CLIENTS["qtab"] = {
        "tab_id": "qtab", "domain": "q.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    c1 = api.claim_browser_job("q.com", "qtab", job1["conversation_id"])
    check("2b.1 首次 claim 获取 first", c1["id"] == job1["id"])
    # Finish job1 to free the tab for job2
    api.finish_browser_job(c1["id"], "completed", result={"assistant": "ok"})
    c2 = api.claim_browser_job("q.com", "qtab", job2["conversation_id"])
    check("2b.2 二次 claim 获取 second", c2["id"] == job2["id"],
          f"got {c2['id'] if c2 else None}, expected {job2['id']}")
    # Finish job2 to free the tab for job3
    api.finish_browser_job(c2["id"], "completed", result={"assistant": "ok"})
    c3 = api.claim_browser_job("q.com", "qtab", job3["conversation_id"])
    check("2b.3 三次 claim 获取 third", c3["id"] == job3["id"])

    # 2c: 队列空后 claim 返回 None
    c4 = api.claim_browser_job("q.com", "qtab")
    check("2c.1 空队列 claim 返回 None", c4 is None)

    # 2d: 不同 domain 的 job — claim 只匹配同 domain
    reset_state()
    job_a = api.new_browser_job("a", domain="alpha.com", model="m")
    job_b = api.new_browser_job("b", domain="beta.com", model="m")
    job_c = api.new_browser_job("c", domain="alpha.com", model="m")

    api.BROWSER_CLIENTS["beta_tab"] = {
        "tab_id": "beta_tab", "domain": "beta.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed_beta = api.claim_browser_job("beta.com", "beta_tab", job_b["conversation_id"])
    check("2d.1 domain=beta 只 claim beta job", claimed_beta["id"] == job_b["id"])
    check("2d.2 alpha jobs 仍在队列",
          job_a["id"] in api.BROWSER_QUEUE and job_c["id"] in api.BROWSER_QUEUE)

    # 2e: claim 跳过已完成的 job (stale queued status → 清理)
    reset_state()
    job_stale = api.new_browser_job("stale", domain="s.com", model="m")
    job_valid = api.new_browser_job("valid", domain="s.com", model="m")
    # 手动污染 stale job 的状态
    job_stale["status"] = "completed"
    # stale job 不应在队列中 (但 claim 侧会跳过并清理)
    api.BROWSER_CLIENTS["stable"] = {
        "tab_id": "stable", "domain": "s.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed = api.claim_browser_job("s.com", "stable", job_valid["conversation_id"])
    check("2e.1 claim 跳过非 queued job 并清理", claimed["id"] == job_valid["id"],
          f"got {claimed['id'] if claimed else None}")
    check("2e.2 非 queued job 已从队列移除", job_stale["id"] not in api.BROWSER_QUEUE)

    # 2f: 队列最大深度测试
    reset_state()
    max_jobs = 200
    for i in range(max_jobs):
        api.new_browser_job(f"bulk-{i}", domain="bulk.com", model="m")
    check("2f.1 200 jobs 入队成功", len(api.BROWSER_QUEUE) == max_jobs)
    check("2f.2 BROWSER_JOBS 数量一致", len(api.BROWSER_JOBS) == max_jobs)
    check("2f.3 每个 job 有对应 event", all(jid in api.BROWSER_EVENTS for jid in api.BROWSER_QUEUE))
    check("2f.4 每个 job 有对应 delta list", all(jid in api.BROWSER_DELTAS for jid in api.BROWSER_QUEUE))

    # 2g: 队列中同一 job 不应重复
    reset_state()
    job_dup = api.new_browser_job("dup", domain="dup.com", model="m")
    count_in_queue = api.BROWSER_QUEUE.count(job_dup["id"])
    check("2g.1 job 在队列中唯一", count_in_queue == 1, f"appears {count_in_queue} times")

    # 2h: poll 限流 (POLL_MIN_INTERVAL)
    # 无法直接调用 handler，但可以检查 POLL_MIN_INTERVAL 和 POLL_LAST 机制
    check("2h.1 POLL_MIN_INTERVAL 默认为 0.25s", api.POLL_MIN_INTERVAL == 0.25)

    # 2i: queue 与 BROWSER_JOBS 一致性 — claim 后队列减一
    reset_state()
    job_q = api.new_browser_job("qcheck", domain="qcheck.com", model="m")
    pre_claim_qlen = len(api.BROWSER_QUEUE)
    api.BROWSER_CLIENTS["qctab"] = {
        "tab_id": "qctab", "domain": "qcheck.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    api.claim_browser_job("qcheck.com", "qctab", job_q["conversation_id"])
    post_claim_qlen = len(api.BROWSER_QUEUE)
    check("2i.1 claim 后队列减少", post_claim_qlen == pre_claim_qlen - 1)

    finding("INFO", "队列无限容量",
            "BROWSER_QUEUE 和 BROWSER_JOBS 均无上限检查。"
            "高并发场景下可能无限增长消耗内存。建议添加 max_queue_size 配置。")


# ═══════════════════════════════════════════════════════════════════════════════
# 3. lease — 生命周期、续约、过期回收
# ═══════════════════════════════════════════════════════════════════════════════
def probe_lease():
    print("\n=== 3. lease (租约) ===")
    reset_state()

    # 3a: claim 后 lease_expires_at 被正确设置
    job = api.new_browser_job("lease-test", domain="lease.com", model="m")
    api.BROWSER_CLIENTS["lease_tab"] = {
        "tab_id": "lease_tab", "domain": "lease.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed = api.claim_browser_job("lease.com", "lease_tab", job["conversation_id"])
    check("3a.1 claimed job 有 lease_expires_at",
          claimed["lease_expires_at"] is not None)
    check("3a.2 lease 在未来 (约150s)",
          claimed["lease_expires_at"] > time.time())
    check("3a.3 lease 不超过 150s + 缓冲",
          claimed["lease_expires_at"] <= time.time() + 155.0)

    # 3b: delta 更新续约 lease
    old_lease = claimed["lease_expires_at"]
    time.sleep(0.05)

    # 模拟 delta 提交
    delta_body = {
        "job_id": job["id"],
        "claim_token": job["claim_token"],
        "tab_id": "lease_tab",
        "conversation_id": job["conversation_id"],
        "domain": "lease.com",
        "text": "streaming content...",
    }
    api.append_browser_delta(delta_body)

    with api.BROWSER_LOCK:
        updated_job = api.BROWSER_JOBS[job["id"]]
    check("3b.1 delta 后 lease 更新", updated_job["lease_expires_at"] > old_lease)
    check("3b.2 last_worker_seen 更新", updated_job["last_worker_seen"] > 0)

    # 3c: lease 过期 → reap 回 queued
    reset_state()
    job_exp = api.new_browser_job("expired", domain="exp.com", model="m")
    job_exp["status"] = "claimed"
    job_exp["tab_id"] = 99
    job_exp["lease_expires_at"] = time.time() - 1  # 1秒前过期
    job_exp["claim_token"] = "old_exp_token"
    job_exp["last_worker_seen"] = time.time() - 200

    api.reap_expired_browser_jobs()
    check("3c.1 过期 lease → status 回 queued", job_exp["status"] == "queued")
    check("3c.2 过期 lease → tab_id 清除", job_exp["tab_id"] is None)
    check("3c.3 过期 lease → reservation_tab_id 清除",
          job_exp["reservation_tab_id"] is None)
    check("3c.4 过期 lease → claim_token 重新生成",
          job_exp["claim_token"] != "old_exp_token")
    check("3c.5 过期 lease → claim_attempt +1",
          job_exp["claim_attempt"] == 1)
    check("3c.6 过期 lease → lease_expires_at 清除",
          job_exp["lease_expires_at"] is None)
    check("3c.7 过期 lease → last_worker_seen 清除",
          job_exp["last_worker_seen"] is None)
    check("3c.8 过期 lease → 重新入队",
          job_exp["id"] in api.BROWSER_QUEUE)

    # 3d: 未过期 lease 不被 reap
    reset_state()
    job_fresh = api.new_browser_job("fresh", domain="fresh.com", model="m")
    job_fresh["status"] = "claimed"
    job_fresh["tab_id"] = 50
    job_fresh["lease_expires_at"] = time.time() + 3600  # 1h 后
    job_fresh["claim_token"] = "fresh_token"

    api.reap_expired_browser_jobs()
    check("3d.1 未过期 lease 不被回收", job_fresh["status"] == "claimed")
    check("3d.2 未过期 lease token 不变", job_fresh["claim_token"] == "fresh_token")

    # 3e: lease_expires_at 为 None 的 claimed job 不被 reap
    reset_state()
    job_nolease = api.new_browser_job("nolease", domain="nl.com", model="m")
    job_nolease["status"] = "claimed"
    job_nolease["lease_expires_at"] = None
    job_nolease["tab_id"] = 1

    api.reap_expired_browser_jobs()
    check("3e.1 lease=None 的 claimed job 不被 reap", job_nolease["status"] == "claimed")

    # 3f: 连续多次 reap 不产生副作用
    reset_state()
    job_reap = api.new_browser_job("reap-multi", domain="rm.com", model="m")
    job_reap["status"] = "claimed"
    job_reap["tab_id"] = 1
    job_reap["lease_expires_at"] = time.time() - 10
    job_reap["claim_token"] = "tok1"
    job_reap["claim_attempt"] = 2

    api.reap_expired_browser_jobs()
    api.reap_expired_browser_jobs()
    api.reap_expired_browser_jobs()

    check("3f.1 多次 reap: status 保持 queued", job_reap["status"] == "queued")
    # claim_attempt 应该在第一次 reap 时 +1=3, 后续不再递增
    check("3f.2 多次 reap: claim_attempt 仅递增一次",
          job_reap["claim_attempt"] == 3)

    # 3g: non-claimed job 不被 reap 影响
    reset_state()
    job_queued = api.new_browser_job("qjob", domain="qj.com", model="m")
    job_queued["lease_expires_at"] = time.time() - 1
    api.reap_expired_browser_jobs()
    check("3g.1 queued job 不被 reap", job_queued["status"] == "queued")

    # 3h: completed job 不被 reap
    reset_state()
    job_done = api.new_browser_job("done", domain="done.com", model="m")
    job_done["status"] = "completed"
    job_done["lease_expires_at"] = time.time() - 1
    api.reap_expired_browser_jobs()
    check("3h.1 completed job 不被 reap", job_done["status"] == "completed")

    # 3i: lease 时长检查
    lease_duration = 150.0
    finding("INFO", "lease 固定 150s",
            f"lease_expires_at 在 claim 和 delta 时均固定设置为 time+{lease_duration}s。"
            "这意味着即使 worker 频繁提交 delta，lease 也不会超过 150s 的窗口。"
            "长时间运行的任务（如大文件处理）可能在 150s 后被误判过期。")


# ═══════════════════════════════════════════════════════════════════════════════
# 4. stale job — 僵尸 job 检测与清理
# ═══════════════════════════════════════════════════════════════════════════════
def probe_stale_job():
    print("\n=== 4. stale job (僵尸任务) ===")
    reset_state()

    # 4a: claim_attempt 计数器正确
    job = api.new_browser_job("attempt", domain="att.com", model="m")
    check("4a.1 初始 claim_attempt=0", job["claim_attempt"] == 0)

    # 首次 claim
    api.BROWSER_CLIENTS["att_tab"] = {
        "tab_id": "att_tab", "domain": "att.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    c1 = api.claim_browser_job("att.com", "att_tab", job["conversation_id"])
    check("4a.2 首次 claim 后 claim_attempt=1", c1["claim_attempt"] == 1)

    # 模拟 lease 过期 → 重新入队
    job["lease_expires_at"] = time.time() - 1
    api.reap_expired_browser_jobs()
    check("4a.3 reap 后 claim_attempt=2", job["claim_attempt"] == 2)

    # 再次 claim
    c2 = api.claim_browser_job("att.com", "att_tab", job["conversation_id"])
    check("4a.4 二次 claim 后 claim_attempt=3", c2["claim_attempt"] == 3)

    # 4b: claim_attempt 上限检查
    max_attempts_seen = job["claim_attempt"]
    for i in range(5):
        job["lease_expires_at"] = time.time() - 1
        api.reap_expired_browser_jobs()
    check("4b.1 claim_attempt 持续递增无上限", job["claim_attempt"] > max_attempts_seen,
          f"claim_attempt={job['claim_attempt']}")
    finding("MEDIUM", "claim_attempt 无上限",
            f"job 可以无限次被 reap 重新入队 (当前 {job['claim_attempt']} 次)。"
            "没有最大尝试次数限制；僵尸 job 会永久占用队列。"
            "建议添加 max_claim_attempts (如 5) 并标记 failed。")

    # 4c: stale binding 在 claim 时被清理
    reset_state()
    api.BROWSER_BINDINGS[("conv-stale", "stale.com")] = {
        "conversation_id": "conv-stale", "domain": "stale.com",
        "tab_id": 111, "last_seen": 0,  # 很久以前
    }
    job_stale_bind = api.new_browser_job("sb", domain="stale.com", model="m",
                                         conversation_id="conv-stale")
    api.BROWSER_CLIENTS["sb_tab"] = {
        "tab_id": "sb_tab", "domain": "stale.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed_sb = api.claim_browser_job("stale.com", "sb_tab", "conv-stale")
    check("4c.1 stale binding 清除后 claim 成功",
          claimed_sb is not None and claimed_sb["id"] == job_stale_bind["id"])
    # After claim, a fresh binding replaces the stale one
    fresh_binding = api.BROWSER_BINDINGS.get(("conv-stale", "stale.com"))
    check("4c.2 新 binding 已创建 (替换 stale)",
          fresh_binding is not None and fresh_binding["last_seen"] > 0)

    # 4d: reap 中的 binding 清理 — 已知 BUG (tab_id 在比较前被 nullified)
    reset_state()
    job_bug = api.new_browser_job("bug", domain="bug.com", model="m",
                                  conversation_id="conv-bug")
    job_bug["status"] = "claimed"
    job_bug["tab_id"] = 777
    job_bug["lease_expires_at"] = time.time() - 1
    api.BROWSER_BINDINGS[("conv-bug", "bug.com")] = {
        "conversation_id": "conv-bug", "domain": "bug.com",
        "tab_id": 777, "last_seen": time.time(),
    }

    api.reap_expired_browser_jobs()
    # 在 L540 tab_id 被置为 None，然后 L549 比较 binding.get("tab_id") == None
    # 777 != None → binding 不会被删除。这是已知的 dead code。
    binding_still = ("conv-bug", "bug.com") in api.BROWSER_BINDINGS
    check("4d.1 GAP: reap binding 清理 dead code (tab_id nullified 在比较前)",
          not binding_still,
          "binding 仍存在 — 确认已知 BUG: L540 nullify 在 L549 比较之前")
    if binding_still:
        finding("HIGH", "reap_expired_browser_jobs binding 清理 dead code",
                "L540 将 tab_id 设为 None 后，L549 的比较 binding.get('tab_id') == None "
                "永远为 False (binding tab_id 777 != None)。binding 永远不会被 reap 清理。"
                "这导致已失效的 tab binding 残留，可能阻止正确的 tab 获取 job。")

    # 4e: 长时间 stale client 清理
    reset_state()
    api.BROWSER_CLIENTS["ancient"] = {"tab_id": "ancient", "last_seen": 0}
    api.BROWSER_READY["ancient"] = {"tab_id": "ancient", "last_seen": 0}
    api.purge_stale_browser_state()
    check("4e.1 stale client 被 purge", "ancient" not in api.BROWSER_CLIENTS)
    check("4e.2 stale ready 被 purge", "ancient" not in api.BROWSER_READY)

    # 4f: CLIENT_TTL = 45s
    check("4f.1 CLIENT_TTL=45s", api.CLIENT_TTL == 45.0)

    # 4g: fresh client 不被 purge
    api.BROWSER_CLIENTS["fresh"] = {"tab_id": "fresh", "last_seen": time.time()}
    api.purge_stale_browser_state()
    check("4g.1 fresh client 不被 purge", "fresh" in api.BROWSER_CLIENTS)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. tab binding — 绑定隔离与安全性
# ═══════════════════════════════════════════════════════════════════════════════
def probe_tab_binding():
    print("\n=== 5. tab binding (标签绑定) ===")
    reset_state()

    # 5a: 创建 binding 并查询
    conv_id = "conv-tb"
    domain = "tb.com"
    api.BROWSER_BINDINGS[(conv_id, domain)] = {
        "conversation_id": conv_id, "domain": domain,
        "tab_id": 42, "profile": "chrome-extension",
        "last_seen": time.time(),
    }
    binding = api.conversation_binding(conv_id, domain)
    check("5a.1 binding 查询返回正确 tab_id", binding["tab_id"] == 42)
    check("5a.2 binding 查询返回对话 ID", binding["conversation_id"] == conv_id)

    # 5b: 不存在的 binding 返回 None
    check("5b.1 不存在 binding 返回 None",
          api.conversation_binding("nonexistent", "no.com") is None)

    # 5c: binding TTL 过期清理
    api.BROWSER_BINDINGS[("conv-old", "old.com")] = {
        "conversation_id": "conv-old", "domain": "old.com",
        "tab_id": 1, "last_seen": 0,  # epoch 0 → 非常 stale
    }
    binding = api.conversation_binding("conv-old", "old.com")
    check("5c.1 stale binding 被 conversation_binding 清理",
          binding is None)
    check("5c.2 stale binding 已从 dict 删除",
          ("conv-old", "old.com") not in api.BROWSER_BINDINGS)

    # 5d: mark_browser_ready 创建 binding
    api.mark_browser_ready({
        "domain": "mark.com",
        "tab_id": 99,
        "conversation_id": "conv-mark",
        "ready": True,
        "input_ready": True,
        "send_ready": True,
    })
    binding = api.BROWSER_BINDINGS.get(("conv-mark", "mark.com"))
    check("5d.1 mark_browser_ready 创建 binding", binding is not None)
    check("5d.2 binding tab_id 正确", binding["tab_id"] == 99)

    # 5e: 跨 tab 攻击防护 — binding 阻止错误的 tab claim
    reset_state()
    api.BROWSER_BINDINGS[("conv-secure", "secure.com")] = {
        "conversation_id": "conv-secure", "domain": "secure.com",
        "tab_id": 10, "last_seen": time.time(),
    }
    job_sec = api.new_browser_job("secret", domain="secure.com", model="m",
                                  conversation_id="conv-secure")
    # 设置 tab 20 为合法 client
    api.BROWSER_CLIENTS["20"] = {
        "tab_id": 20, "domain": "secure.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    # 设置 tab 10 也为合法 client
    api.BROWSER_CLIENTS["10"] = {
        "tab_id": 10, "domain": "secure.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }

    # Tab 20 尝试 claim (应该被 binding 阻止)
    blocked = api.claim_browser_job("secure.com", 20, "conv-secure")
    check("5e.1 跨 tab claim 被 binding 阻止", blocked is None)

    # Tab 10 claim (应该成功)
    allowed = api.claim_browser_job("secure.com", 10, "conv-secure")
    check("5e.2 正确 tab claim 成功", allowed is not None)

    # 5f: 同一 tab 不能同时有多个 claimed job
    reset_state()
    job_a = api.new_browser_job("a", domain="multi.com", model="m",
                                conversation_id="conv-a")
    job_b = api.new_browser_job("b", domain="multi.com", model="m",
                                conversation_id="conv-b")
    api.BROWSER_CLIENTS["shared_tab"] = {
        "tab_id": "shared_tab", "domain": "multi.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claim_a = api.claim_browser_job("multi.com", "shared_tab", "conv-a")
    check("5f.1 tab 首次 claim 成功", claim_a is not None)
    claim_b = api.claim_browser_job("multi.com", "shared_tab", "conv-b")
    check("5f.2 同 tab 二次 claim 被阻止 (已有 claimed job)",
          claim_b is None,
          f"expected None, got {claim_b['id'] if claim_b else 'None'}")
    # 验证检查逻辑: L585-590 — tab_id 的正则检查
    finding("INFO", "同 tab 单 conversation 限制",
            "L585-590: claim 时检查是否存在同一 tab_id 的其他 claimed job。"
            "一个 tab 只能 supervise 一个 live conversation。")

    # 5g: binding 在 claim 成功后被创建/更新
    reset_state()
    job_g = api.new_browser_job("g", domain="g.com", model="m",
                                conversation_id="conv-g")
    api.BROWSER_CLIENTS["g_tab"] = {
        "tab_id": "g_tab", "domain": "g.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    api.claim_browser_job("g.com", "g_tab", "conv-g")
    binding = api.BROWSER_BINDINGS.get(("conv-g", "g.com"))
    check("5g.1 claim 后 binding 自动创建", binding is not None)
    check("5g.2 binding tab_id 匹配", binding["tab_id"] == "g_tab")

    # 5h: binding 完整性 — browser_status_snapshot 包含 bindings
    snapshot = api.browser_status_snapshot()
    check("5h.1 snapshot 包含 bindings", "bindings" in snapshot)

    # 5i: binding 无 conversation_id 键不会被错误创建
    # (在 mark_browser_ready 中 conversation_id 为空时不会创建 binding)
    reset_state()
    api.mark_browser_ready({
        "domain": "no-conv.com",
        "tab_id": 77,
        "ready": True,
        "input_ready": True,
        "send_ready": True,
        # 没有 conversation_id
    })
    # 应该没有为 ("", "no-conv.com") 创建 binding
    empty_conv_binding = api.BROWSER_BINDINGS.get(("", "no-conv.com"))
    check("5i.1 无 conversation_id 不创建 binding", empty_conv_binding is None)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. worker death — worker 消失时的恢复
# ═══════════════════════════════════════════════════════════════════════════════
def probe_worker_death():
    print("\n=== 6. worker death (Worker 消亡) ===")
    reset_state()

    # 6a: worker 长时间无心跳 → lease 过期 → job 重新入队
    job = api.new_browser_job("death-test", domain="death.com", model="m",
                              conversation_id="conv-death")
    api.BROWSER_CLIENTS["death_tab"] = {
        "tab_id": "death_tab", "domain": "death.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed = api.claim_browser_job("death.com", "death_tab", "conv-death")
    check("6a.1 初始 claim 成功", claimed is not None)

    # 模拟 worker 死亡: 提交一些 delta 但随后停止
    api.append_browser_delta({
        "job_id": job["id"],
        "claim_token": job["claim_token"],
        "tab_id": "death_tab",
        "conversation_id": "conv-death",
        "domain": "death.com",
        "text": "working...",
    })

    # 检查 lease 被更新
    with api.BROWSER_LOCK:
        lease_after_delta = api.BROWSER_JOBS[job["id"]]["lease_expires_at"]
    check("6a.2 worker alive: lease 被 delta 更新", lease_after_delta > time.time())

    # 模拟 worker 死亡：设置 lease 过期
    job["lease_expires_at"] = time.time() - 1
    job["tab_id"] = "death_tab"
    job["claim_token"] = "dead_token"

    # 确认 binding 存在
    api.BROWSER_BINDINGS[("conv-death", "death.com")] = {
        "conversation_id": "conv-death", "domain": "death.com",
        "tab_id": "death_tab", "last_seen": time.time(),
    }

    # reap
    api.reap_expired_browser_jobs()
    check("6a.3 worker death: job 重新入队", job["status"] == "queued")
    check("6a.4 worker death: tab_id 清除", job["tab_id"] is None)
    check("6a.5 worker death: claim_token 重新生成",
          job["claim_token"] != "dead_token")
    check("6a.6 worker death: 新 token 可被新 worker claim",
          len(job["claim_token"]) > 0)

    # 另一个 worker 可以 claim
    api.BROWSER_CLIENTS["new_tab"] = {
        "tab_id": "new_tab", "domain": "death.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    new_claim = api.claim_browser_job("death.com", "new_tab", "conv-death")
    check("6a.7 新 worker 成功 claim 重新入队 job", new_claim is not None)
    check("6a.8 新 claim token 有效",
          new_claim["claim_token"] == job["claim_token"])

    # 6b: worker death 无 lease 场景 (orphan claimed job)
    reset_state()
    job_orphan = api.new_browser_job("orphan", domain="orphan.com", model="m")
    job_orphan["status"] = "claimed"
    job_orphan["tab_id"] = 999
    job_orphan["lease_expires_at"] = None  # 无 lease 的孤儿 job
    job_orphan["claim_token"] = "orphan_token"

    # 无 lease → 不被 reap
    api.reap_expired_browser_jobs()
    check("6b.1 orphan job (lease=None) 不被 reap", job_orphan["status"] == "claimed")
    finding("LOW", "orphan claimed job (lease=None)",
            "claimed job 如果没有 lease_expires_at (不正常但可能发生)，"
            "reap 不会回收。它永远处于 claimed 状态占用资源。"
            "建议: 在 claim 时保证 always set lease_expires_at。")


# ═══════════════════════════════════════════════════════════════════════════════
# 7. 重复请求 (Duplicate) — 幂等 key 去重与并行提交
# ═══════════════════════════════════════════════════════════════════════════════
def probe_duplicate_requests():
    print("\n=== 7. 重复请求 (Duplicate Requests) ===")
    reset_state()

    # 7a: 同 key + 同 fingerprint → 非 owner replay
    rec1, owner1, conflict1 = api.claim_idempotency("dup-key-1", "fp-same")
    check("7a.1 首次 claim 是 owner", owner1 is True and conflict1 is False)

    rec2, owner2, conflict2 = api.claim_idempotency("dup-key-1", "fp-same")
    check("7a.2 重复 claim (同 fp): 非 owner", owner2 is False)
    check("7a.3 重复 claim (同 fp): 无 conflict", conflict2 is False)
    check("7a.4 重复 claim: 返回同一 record", rec2 is rec1)

    # 7b: 同 key + 不同 fingerprint → conflict
    _, _, conflict3 = api.claim_idempotency("dup-key-1", "fp-different")
    check("7b.1 同 key 不同 fp: conflict", conflict3 is True)

    # 7c: 并行重复提交 — 多线程同时用相同 key 提交
    api.IDEMPOTENCY.clear()
    parallel_key = "parallel-dup"
    fp = api.request_fingerprint("m", [{"role": "user", "content": "hi"}], {})
    results = []

    def duplicator(thread_id):
        rec, owner, conflict = api.claim_idempotency(parallel_key, fp)
        results.append((thread_id, owner, conflict, rec["key"] if rec else None))

    threads = [threading.Thread(target=duplicator, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    owners = [r for r in results if r[1] is True]
    non_owners = [r for r in results if r[1] is False]
    conflicts = [r for r in results if r[2] is True]

    check("7c.1 10 线程并行同 key: 仅 1 个 owner", len(owners) == 1,
          f"owners={len(owners)}")
    check("7c.2 10 线程并行同 key: 其余 non-owner", len(non_owners) == 9)
    check("7c.3 10 线程并行同 key: 无 conflict", len(conflicts) == 0)

    # 7d: 幂等完成后 replay
    api.IDEMPOTENCY.clear()
    rec, _, _ = api.claim_idempotency("replay-test", "fp-r")
    api.complete_idempotency("replay-test", {
        "id": "chatcmpl-replay", "choices": [{"message": {"content": "cached"}}]
    })

    rec_r, owner_r, conflict_r = api.claim_idempotency("replay-test", "fp-r")
    check("7d.1 完成后 replay: not owner", owner_r is False)
    check("7d.2 完成后 replay: status=completed", rec_r["status"] == "completed")
    replay_resp = api.idempotency_response(rec_r)
    check("7d.3 完成后 replay: 返回缓存响应", replay_resp is not None)
    check("7d.4 完成后 replay: 内容正确",
          replay_resp["choices"][0]["message"]["content"] == "cached")

    # 7e: 空 key → 无幂等保护
    api.IDEMPOTENCY.clear()
    rec_empty, owner_empty, conflict_empty = api.claim_idempotency("", "any-fp")
    check("7e.1 空 key: record=None", rec_empty is None)
    check("7e.2 空 key: 当作 owner", owner_empty is True)
    check("7e.3 空 key: 无 conflict", conflict_empty is False)

    # 7f: 空 key 不参与 complete/fail
    api.complete_idempotency("", {"test": True})
    api.fail_idempotency("", "error", terminal=True)
    check("7f.1 空 key complete/fail no-op: 无崩溃", True)

    # 7g: request_fingerprint 稳定性与区分度
    fp1 = api.request_fingerprint("m1", [{"role": "user", "content": "a"}], {})
    fp2 = api.request_fingerprint("m1", [{"role": "user", "content": "a"}], {})
    fp3 = api.request_fingerprint("m1", [{"role": "user", "content": "b"}], {})
    fp4 = api.request_fingerprint("m2", [{"role": "user", "content": "a"}], {})

    check("7g.1 fingerprint 确定性", fp1 == fp2)
    check("7g.2 fingerprint 区分 content", fp1 != fp3)
    check("7g.3 fingerprint 区分 model", fp1 != fp4)

    # 7h: IDEMPOTENCY_TTL 清理
    api.IDEMPOTENCY.clear()
    api.IDEMPOTENCY["stale-rec"] = {
        "key": "stale-rec", "fingerprint": "fp", "status": "processing",
        "created_at": 0, "updated_at": 0, "event": threading.Event(),
        "response": None,
    }
    rec_new, owner_new, _ = api.claim_idempotency("new-rec", "fp-n")
    check("7h.1 TTL 清理: stale record 被移除",
          "stale-rec" not in api.IDEMPOTENCY)
    check("7h.2 TTL 清理后新 claim 成功", owner_new is True)

    # 7i: POLL_MIN_INTERVAL 防重复轮询
    # POLL_LAST 机制防止同一 client 频繁 poll
    check("7i.1 POLL_MIN_INTERVAL=0.25", api.POLL_MIN_INTERVAL == 0.25)

    # 7j: validate_job_actor — 防重复提交 (claim_token 校验)
    reset_state()
    job_v = api.new_browser_job("validate", domain="val.com", model="m",
                                conversation_id="conv-val")
    api.BROWSER_CLIENTS["val_tab"] = {
        "tab_id": "val_tab", "domain": "val.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed_v = api.claim_browser_job("val.com", "val_tab", "conv-val")

    # 正确 token
    valid_body = {
        "job_id": job_v["id"],
        "claim_token": job_v["claim_token"],
        "tab_id": "val_tab",
        "conversation_id": "conv-val",
        "domain": "val.com",
    }
    _, err = api.validate_job_actor(valid_body)
    check("7j.1 正确 token: 验证通过", err is None)

    # 错误 token
    _, err = api.validate_job_actor(dict(valid_body, claim_token="bad_token"))
    check("7j.2 错误 token: 阻止重复/伪造提交", err == "claim_token_invalid")

    # 错误 tab_id
    _, err = api.validate_job_actor(dict(valid_body, tab_id="evil_tab"))
    check("7j.3 错误 tab_id: 阻止", err == "tab_id_mismatch")

    # 错误 conversation_id
    _, err = api.validate_job_actor(dict(valid_body, conversation_id="evil-conv"))
    check("7j.4 错误 conversation_id: 阻止", err == "conversation_id_mismatch")


# ═══════════════════════════════════════════════════════════════════════════════
# 综合: 跨域交互测试
# ═══════════════════════════════════════════════════════════════════════════════
def probe_cross_domain_interaction():
    print("\n=== 8. 跨域交互 (Cross-Domain Interaction) ===")
    reset_state()

    # 8a: 不同 domain 的 job 队列隔离
    job_d1 = api.new_browser_job("d1", domain="domain1.com", model="m")
    job_d2 = api.new_browser_job("d2", domain="domain2.com", model="m")

    check("8a.1 不同 domain jobs 在同一队列", 
          job_d1["id"] in api.BROWSER_QUEUE and job_d2["id"] in api.BROWSER_QUEUE)

    # domain1 的 worker 不应能 claim domain2 的 job
    api.BROWSER_CLIENTS["d1_tab"] = {
        "tab_id": "d1_tab", "domain": "domain1.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time(),
    }
    claimed = api.claim_browser_job("domain1.com", "d1_tab", job_d1["conversation_id"])
    check("8a.2 domain1 worker 只 claim domain1 job", 
          claimed["id"] == job_d1["id"],
          f"expected {job_d1['id']}, got {claimed['id']}")
    check("8a.3 domain2 job 仍在队列", job_d2["id"] in api.BROWSER_QUEUE)

    # 8b: 无 domain 的 claim 被拒绝 (claim 需要 domain)
    reset_state()
    job_nod = api.new_browser_job("nod", domain="hasdomain.com", model="m")
    nod_claimed = api.claim_browser_job("", "d1_tab")  # 空 domain
    check("8b.1 空 domain claim 返回 None (job 有 domain 时)",
          nod_claimed is None)

    # 8c: 无 domain job + 无 domain claim
    # 注意: new_browser_job 总是要 domain
    # 测试 api_server.py L570: job domain 非空但传入空 domain → 跳过


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print("=" * 70)
    print("Audit #5 — 并发·队列·lease·stale job·tab binding·worker death·重复请求")
    print("=" * 70)

    probes = [
        ("1. 并发 (Concurrency)", probe_concurrency),
        ("2. 队列 (Queue)", probe_queue),
        ("3. lease (租约)", probe_lease),
        ("4. stale job (僵尸任务)", probe_stale_job),
        ("5. tab binding (标签绑定)", probe_tab_binding),
        ("6. worker death (Worker 消亡)", probe_worker_death),
        ("7. 重复请求 (Duplicate Requests)", probe_duplicate_requests),
        ("8. 跨域交互 (Cross-Domain)", probe_cross_domain_interaction),
    ]

    for name, fn in probes:
        try:
            fn()
        except Exception as e:
            print(f"\n  💥 {name} 崩溃: {e}")
            import traceback
            traceback.print_exc()
            FAIL += 1

    # ── 报告 ──
    total = PASS + FAIL
    print("\n" + "=" * 70)
    print(f"结果: ✅ {PASS} / {total} 通过  ❌ {FAIL} 失败")
    if total > 0:
        print(f"通过率: {PASS/total*100:.1f}%")
    print("=" * 70)

    if FINDINGS:
        print(f"\n📋 发现 ({len(FINDINGS)} 条):")
        for sev, title, detail in FINDINGS:
            marker = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵", "INFO": "⚪"}
            print(f"  {marker.get(sev, '?')} [{sev}] {title}")
            print(f"     {detail}")

    print(f"\n审计结论: {'🟢 全通过' if FAIL == 0 else '🔴 存在问题，见上方详情'}")
    sys.exit(0 if FAIL == 0 else 1)
