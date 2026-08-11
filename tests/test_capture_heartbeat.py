#!/usr/bin/env python3
"""Test: Capture heartbeat keeps client alive during long capture.
Simulates heartbeat every 5s for 90s and verifies client doesn't expire."""

import json, os, time, urllib.request, urllib.error, sys

if "pytest" in sys.modules and not os.environ.get("PHANTOM_RELAY_RUN_LIVE_TESTS"):
    import pytest
    pytestmark = pytest.mark.skip(
        reason="live heartbeat test requires an explicitly isolated backend/browser"
    )

API = "http://127.0.0.1:8765"
TEST_TAB = int(time.time() * 1000)
CLIENT_ID = f"test-capture-heartbeat-{TEST_TAB}"
TEST_DOMAIN = f"capture-fixture-{TEST_TAB}.local"
TEST_CONVERSATION = f"capture-fixture-{TEST_TAB}"

def api_get(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=5) as resp:
        return json.loads(resp.read().decode())

def api_post(path, body, timeout=5):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{API}{path}", data=data, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

def heartbeat(domain, tab_id, conv_id):
    return api_post("/browser/heartbeat", {
        "domain": domain, "tab_id": tab_id,
        "client_id": CLIENT_ID,
        "conversation_id": conv_id,
        "ready": True, "input_ready": True, "send_ready": True,
        "source": "content-ready",
        "capabilities": {"can_execute": True, "can_observe": True}
    })[0]

def test_capture_heartbeat_keeps_client_alive():
    """Simulate 90s capture with heartbeat every 5s. Client must stay alive."""
    print("\n=== Test: capture heartbeat keeps client alive ===")

    TAB = TEST_TAB
    DOMAIN = TEST_DOMAIN
    CONV = TEST_CONVERSATION

    # 1. Submit + claim
    s, r = api_post("/browser/submit", {
        "message": "test",
        "domain": DOMAIN,
        "model": "fixture-model",
        "conversation_id": CONV,
    })
    assert s in (200, 202), f"Submit failed: {r}"
    jid = r.get("id") or r.get("job_id")
    assert jid
    print(f"   job_id={jid}")

    # Register client
    assert heartbeat(DOMAIN, TAB, CONV) == 200

    # Claim
    s, poll = api_post("/browser/poll", {"domain": DOMAIN, "tab_id": TAB,
        "conversation_id": CONV, "client_id": CLIENT_ID})
    assert s == 200 and poll.get("job"), f"Poll failed: {poll}"
    print(f"   claimed")

    # 2. Simulate 90s capture with heartbeat every 5s
    DURATION = 90
    INTERVAL = 5
    PRINT_EVERY = 3  # print every 3rd tick
    ticks = DURATION // INTERVAL
    start = time.time()
    expired = False

    for i in range(ticks):
        time.sleep(INTERVAL)
        status = heartbeat(DOMAIN, TAB, CONV)
        if i % PRINT_EVERY == 0:
            # Check client state
            clients_raw = api_get("/browser/clients")
            clients = clients_raw.get("clients", clients_raw)
            client = clients.get(str(TAB), {})
            last_seen_age = time.time() - client.get("last_seen", 0)
            print(f"   tick {i+1}/{ticks}: last_seen_age={last_seen_age:.0f}s, "
                  f"status={client.get('ready') and 'alive' or 'dead'}")

        if status != 200:
            print(f"   ⚠ heartbeat rejected at tick {i+1}")
            expired = True
            break

        # Check job still claimed (not reaped)
        jobs = api_get("/browser/status").get("jobs", {})
        job = jobs.get(jid, {})
        if job.get("status") != "claimed":
            print(f"   ✗ job reaped to {job.get('status')} at tick {i+1}")
            expired = True
            break

    elapsed = time.time() - start
    print(f"   duration: {elapsed:.0f}s")

    if not expired:
        # Final check
        clients_raw = api_get("/browser/clients")
        clients = clients_raw.get("clients", clients_raw)
        client = clients.get(str(TAB), {})
        last_seen = client.get("last_seen", 0)
        age = time.time() - last_seen

        print(f"   final last_seen_age: {age:.0f}s (CLIENT_TTL=45s)")
        assert age < 30, f"Client expired! last_seen_age={age:.0f}s > 30s"
        print("✓ PASS: Client alive after 90s capture simulation")
        return True
    else:
        print("✗ FAIL: Client or job expired during capture")
        return False


if __name__ == "__main__":
    try:
        api_get("/health")
    except:
        print("API not running"); sys.exit(1)

    try:
        if test_capture_heartbeat_keeps_client_alive():
            print("\n✓ GREEN")
        else:
            print("\nRED")
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        print("RED")
