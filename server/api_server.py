#!/usr/bin/env python3
"""
Phantom Relay — 本地 API 服务
功能:
  - 接收 Chrome 扩展上传的对话
  - 提供 OpenAI 兼容的 /v1/chat/completions 接口
  - 导出为 OpenAI fine-tuning JSONL 格式

启动:
  python3 api_server.py
  # 默认监听 http://localhost:8765

端点:
  POST /import              — 导入对话 (Chrome 扩展用)
  POST /v1/chat/completions — OpenAI 兼容格式的对话回放
  GET  /export/openai       — 导出 OpenAI JSONL 格式
  GET  /stats               — 统计信息
"""

import json
import time
import os
import hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from datetime import datetime

PORT = 8765
DATA_FILE = os.path.join(os.path.dirname(__file__), "conversations.json")
STATS_FILE = os.path.join(os.path.dirname(__file__), "stats.json")
TRACE_FILE = os.path.join(os.path.dirname(__file__), "page-trace.jsonl")


def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"conversations": [], "models": ["doubao-default"]}


def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_stats():
    if os.path.exists(STATS_FILE):
        with open(STATS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "total_imports": 0,
        "total_messages": 0,
        "total_tokens_approx": 0,
        "first_import": None,
        "last_import": None,
    }


def save_stats(stats):
    with open(STATS_FILE, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)


def approx_tokens(text):
    """粗略估算 token 数 (中文 ~1.5 char/token, 英文 ~4 char/token)"""
    if not text:
        return 0
    chinese = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - chinese
    return int(chinese / 1.5 + other / 4)


class APIHandler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, indent=2)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", str(len(body.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_OPTIONS(self):
        self._send_json({}, 204)

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/stats":
            stats = load_stats()
            data = load_data()
            stats["total_conversations"] = len(data["conversations"])
            stats["models"] = data.get("models", [])
            self._send_json(stats)

        elif path == "/export/openai":
            data = load_data()
            jsonl = []
            for conv in data["conversations"]:
                jsonl.append(
                    {
                        "messages": [
                            {"role": "user", "content": conv.get("user", "")},
                            {
                                "role": "assistant",
                                "content": conv.get("assistant", ""),
                            },
                        ]
                    }
                )
            self._send_json(
                {
                    "format": "openai-chat",
                    "count": len(jsonl),
                    "data": jsonl,
                    "exported_at": datetime.now().isoformat(),
                }
            )

        elif path == "/export/jsonl":
            data = load_data()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-jsonlines; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=doubao-export.jsonl")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            for conv in data["conversations"]:
                line = json.dumps(
                    {
                        "messages": [
                            {"role": "user", "content": conv.get("user", "")},
                            {
                                "role": "assistant",
                                "content": conv.get("assistant", ""),
                            },
                        ]
                    },
                    ensure_ascii=False,
                )
                self.wfile.write((line + "\n").encode("utf-8"))

        elif path == "/health":
            self._send_json({"status": "ok", "service": "phantom-relay-api"})

        elif path == "/trace/tail":
            # 便于在不复制 popup 内容的情况下读取最近的页面变化。
            limit = 100
            try:
                from urllib.parse import parse_qs
                limit = max(1, min(1000, int(parse_qs(urlparse(self.path).query).get("limit", [100])[0])))
            except (ValueError, TypeError):
                pass
            rows = []
            if os.path.exists(TRACE_FILE):
                with open(TRACE_FILE, "r", encoding="utf-8") as f:
                    rows = f.readlines()[-limit:]
            self._send_json({"count": len(rows), "entries": [json.loads(r) for r in rows if r.strip()]})

        else:
            self._send_json(
                {
                    "service": "Phantom Relay API",
                    "version": "1.0.0",
                    "endpoints": {
                        "POST /import": "导入对话",
                        "POST /v1/chat/completions": "OpenAI 兼容聊天接口",
                        "GET /export/openai": "导出 OpenAI 格式",
                        "GET /export/jsonl": "下载 JSONL 文件",
                        "GET /stats": "统计信息",
                        "GET /health": "健康检查",
                        "POST /trace": "实时写入页面 DOM Trace",
                        "GET /trace/tail": "读取最近页面 DOM Trace",
                    },
                }
            )

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/trace":
            body = self._read_body()
            # 每行立即 flush，确保 tail -f/其他进程可以实时看到。
            with open(TRACE_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n")
                f.flush()
            self._send_json({"status": "ok", "written": True})
            return

        if path == "/import":
            body = self._read_body()
            conversations = body.get("conversations", [])

            if not conversations:
                self._send_json({"error": "conversations 为空"}, 400)
                return

            data = load_data()
            stats = load_stats()

            imported = 0
            for conv in conversations:
                # 去重 (基于 user 文本 hash)
                user_hash = hashlib.md5(
                    conv.get("user", "").encode("utf-8")
                ).hexdigest()
                existing = any(
                    hashlib.md5(c.get("user", "").encode("utf-8")).hexdigest()
                    == user_hash
                    for c in data["conversations"]
                )
                if not existing:
                    conv["id"] = f"conv_{int(time.time() * 1000)}_{imported}"
                    conv["imported_at"] = datetime.now().isoformat()
                    data["conversations"].append(conv)
                    imported += 1
                    stats["total_messages"] += 2
                    stats["total_tokens_approx"] += approx_tokens(
                        conv.get("user", "")
                    ) + approx_tokens(conv.get("assistant", ""))

            stats["total_imports"] += 1
            now = datetime.now().isoformat()
            stats["last_import"] = now
            if not stats["first_import"]:
                stats["first_import"] = now

            save_data(data)
            save_stats(stats)

            self._send_json(
                {
                    "status": "ok",
                    "imported": imported,
                    "skipped": len(conversations) - imported,
                    "total": len(data["conversations"]),
                }
            )

        elif path == "/v1/chat/completions":
            body = self._read_body()
            messages = body.get("messages", [])
            data = load_data()

            # 从已存储对话中匹配
            user_msg = ""
            for m in messages:
                if m.get("role") == "user":
                    user_msg = m.get("content", "")
                    break

            if not user_msg:
                self._send_json(
                    {
                        "id": "chatcmpl-local",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": body.get("model", "doubao-default"),
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "请提供 user 消息内容",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                    }
                )
                return

            # 精确匹配
            assistant_content = ""
            for conv in data["conversations"]:
                if conv.get("user", "").strip() == user_msg.strip():
                    assistant_content = conv.get("assistant", "")
                    break

            # 模糊匹配 (包含关系)
            if not assistant_content:
                for conv in data["conversations"]:
                    stored = conv.get("user", "").strip()
                    if stored in user_msg or user_msg in stored:
                        assistant_content = conv.get("assistant", "")
                        break

            prompt_tokens = approx_tokens(user_msg)
            completion_tokens = approx_tokens(assistant_content)

            self._send_json(
                {
                    "id": f"chatcmpl-{int(time.time())}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": body.get("model", "doubao-default"),
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": assistant_content
                                or "未找到匹配的对话记录",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    },
                }
            )

        else:
            self._send_json({"error": "Unknown endpoint"}, 404)

    def log_message(self, format, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {args[0]}")


def main():
    server = HTTPServer(("0.0.0.0", PORT), APIHandler)
    print(f"""
╔══════════════════════════════════════════════╗
║         👻 Phantom Relay API Server          ║
║                                              ║
║  本地地址: http://localhost:{PORT}             ║
║  OpenAI API: http://localhost:{PORT}/v1/chat/completions
║                                              ║
║  使用方法:                                    ║
║    curl http://localhost:{PORT}/v1/chat/completions \\ 
║      -H "Content-Type: application/json" \\ 
║      -d '{{"model":"doubao-default","messages":[{{"role":"user","content":"你好"}}]}}'
║                                              ║
║  导出 JSONL:                                  ║
║    curl http://localhost:{PORT}/export/jsonl > data.jsonl
║                                              ║
║  按 Ctrl+C 停止                               ║
╚══════════════════════════════════════════════╝
""")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
