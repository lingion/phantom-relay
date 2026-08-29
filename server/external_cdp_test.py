"""Manual external-CDP acceptance probe.

This is intentionally not a pytest module. Keep all network/browser activity
inside ``main`` so importing or collecting the file cannot submit a request or
terminate a test process.
"""

import base64
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request

import websocket


API = "http://127.0.0.1:8765"


def main():
    prompt = "请只回复：最终截图回车闭环成功"
    request = [
        "curl", "-sS", "--max-time", "150",
        "-H", "Content-Type: application/json",
        "-H", "Idempotency-Key: external-cdp-final-20260721",
        API + "/v1/chat/completions",
        "-d", json.dumps({
            "model": "deepseek",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "timeout": 120,
        }, ensure_ascii=False),
    ]
    process = subprocess.Popen(request, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    job = None
    for _ in range(100):
        try:
            status = json.load(urllib.request.urlopen(API + "/browser/status"))
            candidates = []
            for candidate in status.get("jobs", {}).values():
                if candidate.get("model") != "deepseek" or not candidate.get("id", "").startswith("job_"):
                    continue
                try:
                    job_number = int(candidate["id"].split("_")[1])
                except Exception:
                    job_number = 0
                candidates.append((job_number, candidate))
            if candidates:
                newest = max(candidates, key=lambda item: item[0])[1]
                if newest.get("status") == "claimed":
                    job = newest
                    break
        except Exception:
            pass
        time.sleep(0.5)
    print("JOB", job, flush=True)
    if not job or job.get("status") != "claimed":
        raise SystemExit("no claimed job")

    items = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list"))
    target = next(item for item in items if item.get("type") == "page" and "chat.deepseek.com" in item.get("url", ""))
    socket = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=15)
    sequence = 0

    def command(method, params=None):
        nonlocal sequence
        sequence += 1
        socket.send(json.dumps({"id": sequence, "method": method, "params": params or {}}))
        while True:
            response = json.loads(socket.recv())
            if response.get("id") == sequence:
                return response

    command("Runtime.enable")
    command("Page.enable")
    expression = """(()=>{const e=document.querySelector('textarea'); if(!e)return null; e.focus(); return {value:e.value,active:document.activeElement===e}})()"""
    print("FOCUS", command("Runtime.evaluate", {"expression": expression, "returnByValue": True}), flush=True)
    command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
    command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})

    answer = ""
    for index in range(70):
        time.sleep(2)
        body = command("Runtime.evaluate", {"expression": "document.body.innerText.slice(-1800)", "returnByValue": True})["result"]["result"].get("value", "")
        if prompt in body:
            tail = body.split(prompt)[-1].strip()
            if tail and tail not in ("快速模式", "深度思考", "智能搜索", "内容由 AI 生成，请仔细甄别"):
                lines = [line.strip() for line in tail.splitlines() if line.strip()]
                if lines:
                    answer = lines[0]
        print("WAIT", index * 2, repr(answer), flush=True)
        if answer and answer != prompt:
            break

    screenshot = command("Page.captureScreenshot", {"format": "png", "fromSurface": True})
    screenshot_path = os.path.join(os.path.dirname(__file__), "external-cdp-final.png")
    with open(screenshot_path, "wb") as output:
        output.write(base64.b64decode(screenshot["result"]["data"]))
    socket.close()
    print("ANSWER", answer, flush=True)
    if answer and answer != prompt:
        query = urllib.parse.urlencode({
            "job_id": job["id"],
            "tab_id": str(job["tab_id"]),
            "domain": "chat.deepseek.com",
            "conversation_id": job.get("conversation_id", ""),
        })
        token = json.load(urllib.request.urlopen(API + "/browser/result-token?" + query))
        payload = {
            "job_id": job["id"],
            "claim_token": token["claim_token"],
            "success": True,
            "user": prompt,
            "assistant": answer,
            "conversation_id": job.get("conversation_id", ""),
            "tab_id": job["tab_id"],
            "domain": "chat.deepseek.com",
            "response_region": "external-cdp",
            "completion_reason": "stable_snapshot",
        }
        result_request = urllib.request.Request(
            API + "/browser/result",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        result = urllib.request.urlopen(result_request)
        print("RESULT", result.status, result.read().decode(), flush=True)
    print("API", process.communicate(timeout=20)[0], flush=True)


if __name__ == "__main__":
    main()
