#!/usr/bin/env python3
"""One-shot CDP network probe for a logged-in chat page.

This is a diagnostic tool, not a provider client. It records response metadata,
stream byte events, websocket frames, and bodies only for the selected page.
It never prints cookies, headers, request bodies, or response contents.
"""
import argparse, base64, json, time, urllib.request, websocket


def pages():
    return json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="chat.deepseek.com")
    ap.add_argument("--seconds", type=float, default=35)
    ap.add_argument("--send", action="store_true", help="send one safe probe prompt with Enter")
    ap.add_argument("--prompt", default="请只回复：网络层探针成功")
    args = ap.parse_args()
    page = next((p for p in pages() if p.get("type") == "page" and args.domain in p.get("url", "")), None)
    if not page:
        raise SystemExit(f"page_not_found:{args.domain}")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=8)
    seq = 0

    def call(method, params=None):
        nonlocal seq
        seq += 1
        ident = seq
        ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == ident:
                return msg

    call("Network.enable", {"maxTotalBufferSize": 50 * 1024 * 1024,
                            "maxResourceBufferSize": 10 * 1024 * 1024})
    call("Page.enable")
    if args.send:
        expr = """(() => { const e=document.querySelector('textarea,[contenteditable=\\"true\\"],[role=\\"textbox\\"]'); if(!e)return false; e.focus(); if('value' in e)e.value=''; else e.textContent=''; return true; })()"""
        print("INPUT_READY", call("Runtime.evaluate", {"expression": expr, "returnByValue": True}).get("result", {}).get("result", {}).get("value"))
        call("Input.insertText", {"text": args.prompt})
        call("Input.dispatchKeyEvent", {"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13})
        call("Input.dispatchKeyEvent", {"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"nativeVirtualKeyCode":13})
        print("ENTER_SENT")

    requests = {}
    bodies = []
    deadline = time.time() + args.seconds
    ws.settimeout(1)
    while time.time() < deadline:
        try:
            event = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:
            continue
        method = event.get("method", "")
        p = event.get("params", {})
        if method == "Network.responseReceived":
            r = p.get("response", {})
            url = r.get("url", "")
            rid = p.get("requestId", "")
            if any(x in url.lower() for x in ("chat", "completion", "message", "conversation", "stream", "sse")):
                requests[rid] = {"url": url, "mime": r.get("mimeType", ""), "status": r.get("status"), "type": p.get("type")}
                print("RESPONSE", json.dumps(requests[rid], ensure_ascii=False))
        elif method == "Network.dataReceived":
            rid = p.get("requestId", "")
            if rid in requests:
                requests[rid]["data_events"] = requests[rid].get("data_events", 0) + 1
                requests[rid]["encoded_bytes"] = requests[rid].get("encoded_bytes", 0) + int(p.get("encodedDataLength") or 0)
                print("DATA", json.dumps({"requestId": rid, "events": requests[rid]["data_events"], "bytes": requests[rid]["encoded_bytes"]}))
        elif method == "Network.loadingFinished":
            rid = p.get("requestId", "")
            if rid in requests:
                out = call("Network.getResponseBody", {"requestId": rid})
                body = out.get("result", {}).get("body", "")
                bodies.append({"requestId": rid, "url": requests[rid]["url"], "body_length": len(body), "base64": bool(out.get("result", {}).get("base64Encoded"))})
                print("BODY", json.dumps(bodies[-1], ensure_ascii=False))
        elif method == "Network.webSocketFrameReceived":
            f = p.get("response", {})
            print("WS_FRAME", json.dumps({"requestId": p.get("requestId"), "opcode": f.get("opcode"), "payload_length": len(f.get("payloadData", ""))}))
    print("SUMMARY", json.dumps({"page": page.get("url"), "responses": list(requests.values()), "bodies": bodies}, ensure_ascii=False))
    ws.close()


if __name__ == "__main__":
    main()
