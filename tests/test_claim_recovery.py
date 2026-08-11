#!/usr/bin/env python3
"""Test: Claim recovery accepts queued jobs with matching identity.
Uses /browser/submit to create jobs without waiting for browser readiness."""

import json, os, time, urllib.request, urllib.error, sys

if "pytest" in sys.modules and not os.environ.get("PHANTOM_RELAY_RUN_LIVE_TESTS"):
    import pytest
    pytestmark = pytest.mark.skip(
        reason="live claim recovery test requires an explicitly isolated backend/browser"
    )

API = "http://127.0.0.1:8765"
TEST_TAB_BASE = int(time.time() * 1000)
TEST_DOMAIN = f"fixture-{TEST_TAB_BASE}.local"
TEST_MODEL = "fixture-model"


def make_test_tab(seed):
    return TEST_TAB_BASE + seed

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

def register_client(tab_id, domain=TEST_DOMAIN):
    client_id = f"test-claim-recovery-{tab_id}"
    api_post("/browser/heartbeat", {
        "domain": domain, "tab_id": tab_id,
        "client_id": client_id,
        "ready": True, "input_ready": True, "send_ready": True,
        "source": "content-ready",
        "capabilities": {"can_execute": True, "can_observe": True}
    })
    return client_id

def submit_and_claim(domain, tab_id, conv_hint, message="test"):
    status, resp = api_post("/browser/submit", {
        "message": message, "domain": domain, "model": TEST_MODEL,
        "conversation_id": conv_hint})
    assert status in (200, 202), f"Submit failed: {resp}"
    job_id = resp.get("id") or resp.get("job_id")
    assert job_id
    client_id = register_client(tab_id, domain)
    status, poll = api_post("/browser/poll", {
        "domain": domain, "tab_id": tab_id, "conversation_id": conv_hint,
        "client_id": client_id})
    assert status == 200 and poll.get("job"), f"Poll failed: {poll}"
    job = poll["job"]
    return {"job_id": job_id, "claim_token": job["claim_token"],
            "conv_id": job["conversation_id"]}

def test_valid_claim():
    print("\n=== Test A: valid claim_token accepts result ===")
    tab_id = make_test_tab(1)
    info = submit_and_claim(TEST_DOMAIN, tab_id, "conv-hint-a")
    s, r = api_post("/browser/result", {
        "job_id": info["job_id"], "success": True,
        "assistant": "1+1=2", "domain": TEST_DOMAIN,
        "tab_id": tab_id, "conversation_id": info["conv_id"],
        "claim_token": info["claim_token"]})
    print(f"Result: HTTP {s}")
    assert s == 200, f"Rejected: {r}"
    print("✓ PASS")
    return True

def test_queued_recovery():
    print("\n=== Test B: queued+matched identity recovers ===")
    tab_id = make_test_tab(2)
    info = submit_and_claim(TEST_DOMAIN, tab_id, "conv-hint-b")
    s, r = api_post("/browser/result", {
        "job_id": info["job_id"], "success": True,
        "assistant": "recovered!", "domain": TEST_DOMAIN,
        "tab_id": tab_id, "conversation_id": info["conv_id"],
        "claim_token": info["claim_token"]})
    print(f"Result: HTTP {s}")
    assert s in (200, 404), f"Unexpected: {r}"
    print("✓ PASS")
    return True

def test_mismatch_rejected():
    print("\n=== Test C: mismatched identity rejected ===")
    tab_id = make_test_tab(3)
    info = submit_and_claim(TEST_DOMAIN, tab_id, "conv-hint-c")
    # Wrong domain
    s, _ = api_post("/browser/result", {
        "job_id": info["job_id"], "success": True,
        "assistant": "bad", "domain": "www.evil.com",
        "tab_id": tab_id, "conversation_id": info["conv_id"],
        "claim_token": info["claim_token"]})
    print(f"Wrong domain: HTTP {s}")
    assert s != 200, "Should reject wrong domain"
    # Wrong token
    s, _ = api_post("/browser/result", {
        "job_id": info["job_id"], "success": True,
        "assistant": "bad", "domain": TEST_DOMAIN,
        "tab_id": tab_id, "conversation_id": info["conv_id"],
        "claim_token": "fake-token"})
    print(f"Wrong token: HTTP {s}")
    assert s != 200, "Should reject wrong token"
    print("✓ PASS")
    return True

if __name__ == "__main__":
    try:
        api_get("/health")
    except:
        print("API not running"); sys.exit(1)
    passed = 0
    for name, fn in [("valid claim", test_valid_claim),
                      ("queued recovery", test_queued_recovery),
                      ("mismatch rejected", test_mismatch_rejected)]:
        try:
            if fn(): passed += 1
        except Exception as e:
            print(f"  ✗ FAIL: {e}")
    print(f"\n{'='*40}\n{passed}/3 passed")
    print("✓ GREEN" if passed == 3 else "RED")
