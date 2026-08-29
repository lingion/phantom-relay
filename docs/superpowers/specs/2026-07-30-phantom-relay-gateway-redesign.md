# Phantom Relay 全兼容透明中转协议层 — 设计 Spec

> 日期：2026-07-30  
> 状态：设计完成，等待用户审查  
> 版本：v2.0（完整详细版）

---

## 目录

1. [目标与原则](#1-目标与原则)
2. [架构总览](#2-架构总览)
3. [文件变更清单与职责矩阵](#3-文件变更清单与职责矩阵)
4. [完整数据流（含所有错误分支）](#4-完整数据流)
5. [protocol.py — 完整 API 与实现](#5-protocolpy--完整-api-与实现)
6. [model_routes.json — 完整 Schema 与所有字段](#6-model_routesjson--完整-schema-与所有字段)
7. [api_server.py — 行级瘦身指南](#7-api_serverpy--行级瘦身指南)
8. [新增端点 — 完整请求/响应规范](#8-新增端点--完整请求响应规范)
9. [SSE 流格式规范](#9-sse-流格式规范)
10. [管理页面 /admin — 完整功能与 UI](#10-管理页面-admin--完整功能与-ui)
11. [测试策略 — 逐条测试用例](#11-测试策略--逐条测试用例)
12. [迁移计划 — 从当前代码到目标架构](#12-迁移计划--从当前代码到目标架构)
13. [边界情况与错误恢复](#13-边界情况与错误恢复)
14. [不做什么](#14-不做什么)

---

## 1. 目标与原则

### 1.1 目标

将 Phantom Relay 从"混杂了协议注入 + 浏览器自动化的单个 1685 行 `api_server.py`"重构为两层架构：

- **协议层**（`server/protocol.py`，纯函数，零副作用，零 I/O）
- **执行层**（已有扩展 + 瘦身后的 `api_server.py`，约 700 行）

### 1.2 核心原则

| # | 原则 | 含义 |
|---|------|------|
| 1 | Phantom Relay 是搬运工 | 不做 Agent Runtime，不内置执行工具 |
| 2 | 原封不动 | 消息进来什么样，到浏览器就是什么样（纯格式化，不删、不加） |
| 3 | 扩展是唯一浏览器通道 | 主力执行方案，不通过 CDP/Playwright 旁路操作 DOM |
| 4 | OpenAI 协议全兼容 | `/v1/models`、`/v1/chat/completions`、SSE、tool_calls、usage 全部支持 |
| 5 | 协议层零副作用 | protocol.py 不读文件、不发网络、不依赖环境变量，纯输入→输出 |
| 6 | model_routes.json 是唯一配置源 | 模型定义、选择器、能力、别名全在此文件 |
| 7 | 扩展不做协议判断 | 扩展只管"把文本投递到浏览器，把回复取回来"，不知道 OpenAI 格式 |

### 1.3 适用场景

```
✅ Cherry Studio → Phantom Relay → Chrome 扩展 → 豆包/DeepSeek/通义千问/文心一言/...
✅ 任何 OpenAI 兼容客户端 → Phantom Relay → 任何浏览器 AI 网站
✅ 带 tools 的请求 → tool 注入 → 浏览器回复 → tool call 提取 → 返回客户端
✅ 流式 + 非流式
✅ 长文本 → 扩展 DOM 文件上传
```

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    协议层 server/protocol.py                  │
│                    （新建，~350 行，纯函数）                    │
│                                                              │
│  resolve_model(model_id) → ModelRoute                        │
│  messages_to_text(messages) → str                            │
│  inject_tool_defs(tools) → str                               │
│  extract_tool_calls(text) → list[ParsedToolCall]             │
│  text_to_openai_response(text, ...) → OpenAIResponse         │
│  text_to_sse_chunk(delta, ...) → str                         │
│  build_sse_done() → str                                      │
│  build_sse_error(msg) → str                                  │
│  estimate_tokens(text) → int                                 │
│                                                              │
│  依赖：model_routes.json（启动时加载一次，之后全部走内存）     │
│  零副作用：不读文件、不发网络、不依赖环境变量                  │
└─────────────────────────────┬────────────────────────────────┘
                              │ 纯文本 / OpenAIResponse
┌─────────────────────────────▼────────────────────────────────┐
│                 执行层（已有的 + 瘦身）                        │
│                                                              │
│  api_server.py (~700 行，从 1685 行瘦身)                      │
│  ├── POST /v1/chat/completions   ← 主入口                     │
│  ├── GET  /v1/models              ← 新增                      │
│  ├── GET  /browser/clients        ← 已有                      │
│  ├── GET  /browser/status         ← 已有                      │
│  ├── POST /browser/jobs           ← 已有                      │
│  ├── POST /browser/claim          ← 已有                      │
│  ├── POST /browser/result         ← 已有                      │
│  ├── POST /browser/heartbeat      ← 已有                      │
│  ├── GET  /health                 ← 已有                      │
│  ├── GET  /admin                  ← 新增                      │
│  ├── GET  /admin/api/models       ← 新增                      │
│  ├── PUT  /admin/api/models/{id}  ← 新增                      │
│  ├── SSE 流引擎                   ← 保留，改用 protocol 封包  │
│  ├── job 队列 + 轮询               ← 保留                      │
│  └── 错误处理（404/500/503/429）   ← 保留，新增错误类型         │
│                                                              │
│  extension/                                                 │
│  ├── content.js      ← 不改，DOM 交互主力                    │
│  ├── background.js   ← 不改，job 轮询                        │
│  └── universal_bridge.js ← 不改                             │
│                                                              │
│  scripts/bidi_browser_host.py ← 不改                         │
└──────────────────────────────────────────────────────────────┘

配置层
├── model_routes.json   ← 重写：完整模型定义（OpenAI + OpenClaw 全字段）
├── /admin 管理页        ← 新建：可视化编辑 + 实时测试
└── selector_templates.json ← 废弃：字段合并进 model_routes.json
```

---

## 3. 文件变更清单与职责矩阵

| 文件 | 操作 | 原行数 | 目标行数 | 职责 |
|------|------|--------|---------|------|
| `server/protocol.py` | **新建** | 0 | ~350 | 协议转换纯函数 |
| `server/model_routes.json` | **重写** | 85 | ~500 | 完整模型定义 + 全局配置 |
| `server/api_server.py` | **重构** | 1685 | ~700 | HTTP 层（路由 + SSE + job） |
| `server/selector_templates.json` | **废弃** | 85 | — | 字段合并进 model_routes.json |
| `extension/content.js` | **不改** | 9424 字符 | 不变 | DOM 执行层 |
| `extension/background.js` | **不改** | 4348 行 | 不变 | job 轮询 + tab 管理 |
| `extension/universal_bridge.js` | **不改** | 2153 字符 | 不变 | 跨页面桥接 |
| `server/static/admin.html` | **新建** | 0 | ~400 | 管理页面（零依赖单文件 HTML） |
| `server/static/admin.js` | **新建** | 0 | ~200 | 管理页面 JS 逻辑 |
| `tests/test_protocol.py` | **新建** | 0 | ~500 | protocol.py 单元测试 |
| `scripts/bidi_browser_host.py` | **不改** | 已有 | 不变 | BiDi 启动 Chrome |

---

## 4. 完整数据流（含所有错误分支）

### 4.1 正常流程：非流式 + 无 tools

```
1. Cherry Studio 发送:
   POST /v1/chat/completions
   Content-Type: application/json
   Authorization: Bearer sk-xxx
   {
     "model": "router",
     "messages": [
       {"role": "system", "content": "你是豆包"},
       {"role": "user", "content": "1+1=?"}
     ],
     "stream": false
   }

2. api_server.py 解析:
   - 提取 model="router"
   - 调用 protocol.resolve_model("router")
   - "router" → alias → "doubao" → ModelRoute{id:"doubao", domain:"www.doubao.com", ...}

3. protocol.messages_to_text(messages):
   - 遍历 2 条消息
   - "system" → "System: 你是豆包"
   - "user" → "User: 1+1=?"
   - 输出: "System: 你是豆包\n\nUser: 1+1=?"

4. protocol.inject_tool_defs(tools=[]):
   - tools 为空 → 返回 ""
   - 最终 prompt: "System: 你是豆包\n\nUser: 1+1=?"

5. api_server.py 创建 job:
   {
     "job_id": "uuid-abc-123",
     "domain": "www.doubao.com",
     "prompt": "System: 你是豆包\n\nUser: 1+1=?",
     "selectors": {input: "...#chat_input", send: "...#send_btn", ...},
     "stream": false
   }

6. 扩展轮询 → claim job → 
   - content.js: 找到输入框 → 清空 → 输入文本 → Enter 发送
   - 等待回复区域出现文本
   - 回复区域完整文本: "1+1=2"

7. 扩展提交 result:
   POST /browser/result {"job_id": "uuid-abc-123", "text": "1+1=2", "status": "success"}

8. protocol.extract_tool_calls("1+1=2"):
   - fenced regex → 无匹配
   - bare JSON regex → 无匹配
   - XML regex → 无匹配
   - 返回 []

9. protocol.text_to_openai_response("1+1=2", model="doubao", tool_calls=[], stream=False):
   返回 OpenAIResponse{
     id: "chatcmpl-xxx",
     object: "chat.completion",
     created: 1712345678,
     model: "doubao",
     choices: [{
       index: 0,
       message: {role: "assistant", content: "1+1=2"},
       finish_reason: "stop",
       logprobs: null
     }],
     usage: {prompt_tokens: 8, completion_tokens: 3, total_tokens: 11}
   }

10. api_server.py: 返回 HTTP 200 + JSON body
```

### 4.2 正常流程：流式 + 带 tools + tool_calls

```
1. Cherry Studio 发送:
   POST /v1/chat/completions
   {
     "model": "deepseek",
     "messages": [
       {"role": "user", "content": "帮我查桌面有什么文件"}
     ],
     "tools": [{
       "type": "function",
       "function": {
         "name": "exec",
         "description": "Run shell command",
         "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
       }
     }],
     "stream": true
   }

2. protocol.resolve_model("deepseek") → ModelRoute{id:"deepseek-chat", domain:"chat.deepseek.com"}

3. protocol.messages_to_text(messages) → "User: 帮我查桌面有什么文件"

4. protocol.inject_tool_defs(tools):
   检查 capabilities.supports_tool_calling → true
   生成:
   "Tools: [{"name":"exec","description":"Run shell command","parameters":{...}}]

   Example: to add 1 to number 5, return:
   ```tool_json
   {"tool":"plus_one","parameters":{"number":"5"}}
   ```
   (plus_one is just an example, not a real tool)

   Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
   No tool needed? Answer directly."

   拼到 prompt 末尾:
   "User: 帮我查桌面有什么文件\n\nTools: [...]\n\nExample:..."

5. 扩展执行 → 浏览器回复（流式捕获）:
   "```tool_json\n{\"tool\":\"exec\",\"parameters\":{\"command\":\"ls -la ~/Desktop\"}}\n```"

6. api_server.py 收到 result.text:
   调用 protocol.extract_tool_calls(text) → 
   fenced regex 匹配到:
   ParsedToolCall{
     id: "call_xxx",
     type: "function", 
     function_name: "exec",
     arguments: '{"command":"ls -la ~/Desktop"}'
   }

7. api_server.py 构建 SSE 流:
   因为有 tool_calls，不流式输出文本内容，改为一次性返回 tool_calls:
   
   SSE stream:
   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1712345678,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"exec","arguments":"{\"command\":\"ls -la ~/Desktop\"}"}}]},"finish_reason":"tool_calls"}]}\n\n
   data: [DONE]\n\n
```

### 4.3 工具往返流程：客户端发回 tool_result

```
1. 客户端收到 tool_calls → 本地执行 exec → 拿到结果
   发送第二轮请求:
   POST /v1/chat/completions
   {
     "model": "deepseek",
     "messages": [
       {"role": "user", "content": "帮我查桌面有什么文件"},
       {"role": "assistant", "content": null, "tool_calls": [{"id":"call_xxx","type":"function","function":{"name":"exec","arguments":"{\"command\":\"ls -la ~/Desktop\"}"}}]},
       {"role": "tool", "tool_call_id": "call_xxx", "name": "exec", "content": "total 24\n-rw-r--r-- 1 user staff 1024 report.pdf\n-rw-r--r-- 1 user staff 2048 notes.txt"}
     ],
     "stream": false
   }

2. protocol.messages_to_text(messages):
   - "user" → "User: 帮我查桌面有什么文件"
   - "assistant" + tool_calls → "Assistant: \n<tool_call id=\"call_xxx\" name=\"exec\">{\"command\":\"ls -la ~/Desktop\"}</tool_call>"
   - "tool" → "Tool exec returned: total 24\n-rw-r--r-- 1 user staff 1024 report.pdf..."
   
   输出:
   "User: 帮我查桌面有什么文件\n\nAssistant: \n<tool_call id=\"call_xxx\" name=\"exec\">{\"command\":\"ls -la ~/Desktop\"}</tool_call>\n\nTool exec returned: total 24\n-rw-r--r-- 1 user staff 1024 report.pdf\n-rw-r--r-- 1 user staff 2048 notes.txt"

3. inject_tool_defs(tools) → 返回 ""（第二轮不需要再注入工具定义）

4. 浏览器回复: "您的桌面上有 report.pdf (1KB) 和 notes.txt (2KB) 两个文件。"

5. 返回 JSON: {"choices":[{"message":{"role":"assistant","content":"您的桌面上有 report.pdf (1KB) 和 notes.txt (2KB) 两个文件。"},"finish_reason":"stop"}]}
```

### 4.4 错误分支

```
分支 A: 模型别名无匹配
  resolve_model("unknown-model") → 抛 ModelNotFoundError
  api_server 捕获 → 返回 HTTP 404
  {"error": {"message": "Model 'unknown-model' not found. Available models: doubao, deepseek-chat, qwen, wenxin", "type": "invalid_request_error", "code": "model_not_found"}}

分支 B: 浏览器返回空文本
  result.text = ""
  protocol.text_to_openai_response("", ...) →
  choices = [] + finish_reason = "error"
  api_server 返回 HTTP 200 但 choices 为空（Cherry Studio 会处理）

分支 C: 浏览器连接超时
  job 在队列中 120 秒未被 claim → api_server 返回 HTTP 504
  {"error": {"message": "Browser request timed out after 120s", "type": "server_error", "code": "timeout"}}

分支 D: 扩展未连接
  GET /browser/clients 返回 {} → api_server 返回 HTTP 503
  {"error": {"message": "No browser extension connected. Please start Chrome with the extension loaded.", "type": "server_error", "code": "browser_unavailable"}}

分支 E: 客户端传了 tools 但模型 supports_tool_calling=false
  不注入 tool prompt，浏览器正常回复文本。
  text_to_openai_response 返回纯文本，没有 tool_calls。
  客户端自己判断是否重试。

分支 F: 消息全部为空
   20 条消息全部 content=null 或 content=""
   messages_to_text 返回 ""
   api_server 检测到 prompt 为空 → 返回 HTTP 400
   {"error": {"message": "All messages have empty content", "type": "invalid_request_error"}}

分支 G: 请求体不是合法 JSON
   Flask 自动返回 HTTP 400

分支 H: 扩展提交了 file_upload job 但文件上传失败
   扩展返回 status="error", error="File upload button not found"
   api_server → HTTP 502
   {"error": {"message": "File upload failed: File upload button not found", "type": "server_error"}}
```

---

## 5. protocol.py — 完整 API 与实现

### 5.1 文件结构

```python
# server/protocol.py
"""
Protocol translation layer for Phantom Relay.
Pure functions — zero side effects, zero I/O.
Depends only on the model_routes JSON loaded at startup.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# ═══════════════════════════════════════════════════════════
# Data Classes
# ═══════════════════════════════════════════════════════════

@dataclass
class ModelCapabilities:
    """Model capability flags — mirrors model_routes.json capabilities block."""
    supports_tool_calling: bool = False
    supports_streaming: bool = True
    supports_vision: bool = False
    supports_file_upload: bool = True
    supports_developer_role: bool = False
    supports_reasoning_effort: bool = False
    supports_usage_in_streaming: bool = False
    supports_strict_mode: bool = False
    supports_store: bool = False
    requires_tool_result_name: bool = False
    requires_assistant_after_tool_result: bool = False
    requires_thinking_as_text: bool = False
    thinking_format: str | None = None
    max_tokens_field: str = "max_tokens"
    context_window: int = 32000
    max_output_tokens: int = 4096
    max_input_chars: int = 8000
    input_modalities: list[str] = field(default_factory=lambda: ["text"])
    output_modalities: list[str] = field(default_factory=lambda: ["text"])
    reasoning: bool = False


@dataclass
class ModelRoute:
    """Resolved model route — all info needed to execute a browser job."""
    id: str
    name: str
    owned_by: str
    domain: str
    url: str
    api: str
    capabilities: ModelCapabilities
    selectors: dict[str, str]
    cost: dict[str, float]
    created: int = 1700000000


@dataclass
class Message:
    """Internal message representation — normalized from OpenAI format."""
    role: str
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict] | None = None


@dataclass
class ToolDefinition:
    """OpenAI tool definition."""
    type: str = "function"
    function: dict | None = None


@dataclass
class ParsedToolCall:
    """Extracted tool call from browser text response."""
    id: str = ""
    type: str = "function"
    function_name: str = ""
    arguments: str = "{}"


@dataclass
class OpenAIResponse:
    """OpenAI-compatible response object."""
    id: str = ""
    object: str = "chat.completion"
    created: int = 0
    model: str = ""
    choices: list[dict] = field(default_factory=list)
    usage: dict | None = None
    system_fingerprint: str | None = None


# ═══════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════

ROLE_LABELS: dict[str, str] = {
    "system": "System",
    "developer": "System",
    "user": "User",
    "assistant": "Assistant",
    "tool": "Tool",
}

# Tool prompt template — always English, always the same format
# Based on OpenClaw Zero Token's web-tool-prompt.ts (arXiv:2407.04997)
TOOL_PROMPT_TEMPLATE: str = """\
Tools: {tool_defs_json}

Example: to add 1 to number 5, return:
```tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
```
(plus_one is just an example, not a real tool)

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.
"""

# Regex patterns — based on OpenClaw Zero Token's web-tool-parser.ts
# Priority: fenced > bare JSON > XML

# Fenced: ```tool_json\n{...}\n```
_FENCED_PATTERN = re.compile(
    r'```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```'
)

# Bare JSON: {"tool":"name","parameters":{...}}
_BARE_JSON_PATTERN = re.compile(
    r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}'
)

# XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
_XML_PATTERN = re.compile(
    r'<tool_call[^>]*>\s*(\{[\s\S]*?\})\s*</tool_call>'
)

# ═══════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════

def resolve_model(
    model_id: str,
    routes: dict[str, ModelRoute],
    aliases: dict[str, str],
) -> ModelRoute:
    """
    Resolve a model identifier to a ModelRoute.

    Resolution order:
    1. Check aliases map (e.g. "router" → "doubao")
    2. Direct lookup in routes

    Args:
        model_id: Raw model string from client request
        routes: Model routes dict (id → ModelRoute)
        aliases: Alias map (short name → model id)

    Returns:
        ModelRoute if found

    Raises:
        ModelNotFoundError: No route found for this model_id
    """
    # Step 1: resolve alias
    resolved_id = aliases.get(model_id, model_id)
    
    # Step 2: direct lookup
    route = routes.get(resolved_id)
    if route is not None:
        return route
    
    # Not found
    available = list(routes.keys())
    raise ModelNotFoundError(
        model=model_id,
        available=available,
        aliases=aliases,
    )


def messages_to_text(messages: list[Message]) -> str:
    """
    Convert OpenAI message array to browser-ready plain text.

    Rules:
    - System/developer → "System: ..."
    - User → "User: ..."
    - Assistant → "Assistant: ..."
      - If assistant has tool_calls, render as <tool_call> tags
    - Tool → "Tool {name} returned: {content}"
    - Empty content → skip that message
    - Adjacent same-role messages → joined with double newline

    Args:
        messages: List of normalized Message objects

    Returns:
        Plain text string ready for browser input
    """
    lines: list[str] = []
    
    for msg in messages:
        role = msg.role
        label = ROLE_LABELS.get(role, role.capitalize())
        content = msg.content or ""
        
        if role == "assistant" and msg.tool_calls:
            # Render tool_calls as XML tags in the prompt
            tc_parts = [label + ":"]
            for tc in msg.tool_calls:
                tc_id = tc.get("id", "")
                fn = tc.get("function", {})
                fn_name = fn.get("name", "")
                fn_args = fn.get("arguments", "{}")
                tc_parts.append(
                    f'<tool_call id="{tc_id}" name="{fn_name}">{fn_args}</tool_call>'
                )
            if content.strip():
                tc_parts.append(content)
            lines.append(" ".join(tc_parts))
        elif role == "tool":
            tool_name = msg.name or "unknown"
            lines.append(f"Tool {tool_name} returned: {content}")
        else:
            if content.strip():
                lines.append(f"{label}: {content}")
    
    return "\n\n".join(lines)


def inject_tool_defs(
    tools: list[ToolDefinition],
    supports_tool_calling: bool = True,
) -> str:
    """
    Generate tool definition prompt text to append to browser prompt.

    Args:
        tools: List of OpenAI tool definitions from the request
        supports_tool_calling: Whether the target model supports tool calling

    Returns:
        Tool prompt string, or "" if tools is empty or not supported
    """
    if not tools or not supports_tool_calling:
        return ""
    
    # Build minimal tool list for the prompt
    tool_list: list[dict] = []
    for tool in tools:
        fn = tool.function or {}
        tool_list.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "parameters": fn.get("parameters", {}),
        })
    
    tool_defs_json = json.dumps(tool_list, ensure_ascii=False, indent=2)
    return "\n\n" + TOOL_PROMPT_TEMPLATE.format(tool_defs_json=tool_defs_json)


def extract_tool_calls(text: str) -> list[ParsedToolCall]:
    """
    Extract tool calls from browser text response using 3 regex patterns.

    Patterns tried in order (first match wins):
    1. Fenced tool_json block: ```tool_json\n{...}\n```
    2. Bare JSON: {"tool":"...","parameters":{...}}
    3. XML: <tool_call>{...}</tool_call>

    Args:
        text: Raw text from browser (may contain tool_call blocks)

    Returns:
        List of ParsedToolCall objects (empty if none found)
    """
    results: list[ParsedToolCall] = []
    
    # Pattern 1: Fenced code block
    for match in _FENCED_PATTERN.finditer(text):
        parsed = _parse_tool_json(match.group(1))
        if parsed:
            results.append(parsed)
            return results  # First match wins
    
    # Pattern 2: Bare JSON in text
    for match in _BARE_JSON_PATTERN.finditer(text):
        tool_name = match.group(1)
        try:
            params = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
        results.append(ParsedToolCall(
            id=f"call_{_short_uuid()}",
            function_name=tool_name,
            arguments=json.dumps(params),
        ))
        return results
    
    # Pattern 3: XML tag
    for match in _XML_PATTERN.finditer(text):
        parsed = _parse_tool_json(match.group(1))
        if parsed:
            results.append(parsed)
            return results
    
    return results


def text_to_openai_response(
    text: str,
    model: str,
    tool_calls: list[ParsedToolCall] | None = None,
    stream: bool = False,
    finish_reason: str = "stop",
    system_fingerprint: str | None = None,
) -> OpenAIResponse:
    """
    Build OpenAI-compatible response from browser result.

    Args:
        text: Browser result text (may be empty)
        model: Model ID used for the request
        tool_calls: Extracted tool calls (empty list if none)
        stream: Whether this is for a streaming response
        finish_reason: One of "stop", "tool_calls", "length", "content_filter", "error"
        system_fingerprint: Optional system fingerprint

    Returns:
        OpenAIResponse with populated choices and usage
    """
    response_id = f"chatcmpl-{_short_uuid()}"
    created = int(time.time())
    
    tool_calls = tool_calls or []
    prompt_tokens = estimate_tokens(text) if text else 0
    completion_tokens = estimate_tokens(text) if text else 0
    
    if tool_calls:
        # Tool call response
        openai_tool_calls = []
        for i, tc in enumerate(tool_calls):
            openai_tool_calls.append({
                "index": i,
                "id": tc.id or f"call_{_short_uuid()}",
                "type": "function",
                "function": {
                    "name": tc.function_name,
                    "arguments": tc.arguments,
                },
            })
        
        choices = [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": openai_tool_calls,
            },
            "finish_reason": "tool_calls",
            "logprobs": None,
        }]
    elif not text.strip():
        # Empty response → error finish
        choices = [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "",
            },
            "finish_reason": "error",
            "logprobs": None,
        }]
    else:
        # Normal text response
        choices = [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": text,
            },
            "finish_reason": finish_reason,
            "logprobs": None,
        }]
    
    return OpenAIResponse(
        id=response_id,
        object="chat.completion",
        created=created,
        model=model,
        choices=choices,
        usage={
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        system_fingerprint=system_fingerprint,
    )


def text_to_sse_chunk(
    delta_content: str | None = None,
    delta_role: str | None = None,
    tool_calls_delta: list[dict] | None = None,
    model: str = "",
    finish_reason: str | None = None,
    response_id: str = "",
    created: int = 0,
) -> str:
    """
    Build a single SSE data chunk for streaming response.

    OpenAI SSE format:
    data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...",
           "choices":[{"index":0,"delta":{...},"finish_reason":null}]}\n\n

    Args:
        delta_content: Text delta for content field
        delta_role: Role for the first chunk ("assistant")
        tool_calls_delta: Tool call delta array
        model: Model ID
        finish_reason: Set on final chunk
        response_id: Consistent ID across chunks
        created: Consistent timestamp

    Returns:
        SSE data line string
    """
    if not response_id:
        response_id = f"chatcmpl-{_short_uuid()}"
    if not created:
        created = int(time.time())
    
    delta: dict[str, Any] = {}
    if delta_role:
        delta["role"] = delta_role
    if delta_content is not None:
        delta["content"] = delta_content
    if tool_calls_delta is not None:
        delta["tool_calls"] = tool_calls_delta
    
    chunk = {
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
            "logprobs": None,
        }],
    }
    
    return f"data: {json.dumps(chunk)}\n\n"


def build_sse_done() -> str:
    """Return the SSE stream termination marker."""
    return "data: [DONE]\n\n"


def build_sse_error(message: str, error_type: str = "server_error") -> str:
    """Return an SSE error chunk."""
    error_chunk = {
        "error": {
            "message": message,
            "type": error_type,
        }
    }
    return f"data: {json.dumps(error_chunk)}\n\n"


def build_openai_error(
    message: str,
    error_type: str = "server_error",
    code: str = "internal_error",
    status_code: int = 500,
) -> tuple[dict, int]:
    """
    Build an OpenAI-compatible error response.

    Args:
        message: Human-readable error message
        error_type: OpenAI error type
        code: Error code
        status_code: HTTP status code

    Returns:
        (error_dict, status_code) tuple
    """
    return {
        "error": {
            "message": message,
            "type": error_type,
            "code": code,
        }
    }, status_code


def build_model_list(models: dict[str, ModelRoute]) -> dict:
    """
    Build OpenAI /v1/models response from model routes.

    Returns:
        {"object": "list", "data": [...]}
    """
    data = []
    for model_id, route in models.items():
        data.append({
            "id": model_id,
            "object": "model",
            "created": route.created,
            "owned_by": route.owned_by,
        })
    return {
        "object": "list",
        "data": data,
    }


def estimate_tokens(text: str) -> int:
    """
    Rough token estimation.
    English: ~4 chars/token, Chinese: ~1.5 chars/token.
    Fallback to char_count/3 for mixed text.

    Args:
        text: Input text

    Returns:
        Estimated token count (>= 1)
    """
    if not text:
        return 0
    
    char_count = len(text)
    # Detect CJK characters
    cjk_count = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    non_cjk = char_count - cjk_count
    
    tokens = (cjk_count / 1.5) + (non_cjk / 4.0)
    return max(1, int(tokens))


# ═══════════════════════════════════════════════════════════
# Internal Helpers
# ═══════════════════════════════════════════════════════════

def _parse_tool_json(raw: str) -> ParsedToolCall | None:
    """
    Parse raw JSON string into ParsedToolCall.
    Supports two JSON shapes:
    1. {"tool": "name", "parameters": {...}}  (ComfyUI LLM Party)
    2. {"name": "...", "arguments": {...}}     (OpenAI format)

    Auto-repairs unbalanced braces.
    """
    if not raw or not raw.strip():
        return None
    
    try:
        cleaned = raw.strip()
        # Auto-repair unbalanced braces
        opens = cleaned.count("{")
        closes = cleaned.count("}")
        if opens > closes:
            cleaned += "}" * (opens - closes)
        
        obj = json.loads(cleaned)
        
        # Format 1: {"tool": "name", "parameters": {...}}
        if "tool" in obj and isinstance(obj["tool"], str):
            return ParsedToolCall(
                id=f"call_{_short_uuid()}",
                function_name=obj["tool"],
                arguments=json.dumps(obj.get("parameters", {})),
            )
        
        # Format 2: {"name": "...", "arguments": {...}}
        if "name" in obj and isinstance(obj["name"], str):
            return ParsedToolCall(
                id=f"call_{_short_uuid()}",
                function_name=obj["name"],
                arguments=json.dumps(obj.get("arguments", {})),
            )
        
        return None
    except (json.JSONDecodeError, TypeError, KeyError):
        return None


def _short_uuid() -> str:
    """Generate a short unique ID."""
    return uuid.uuid4().hex[:12]


# ═══════════════════════════════════════════════════════════
# Errors
# ═══════════════════════════════════════════════════════════

class ModelNotFoundError(Exception):
    """Raised when a model identifier cannot be resolved."""
    
    def __init__(self, model: str, available: list[str], aliases: dict[str, str]):
        self.model = model
        self.available = available
        self.aliases = aliases
        alias_list = ", ".join(f"{k}→{v}" for k, v in aliases.items())
        super().__init__(
            f"Model '{model}' not found. "
            f"Available: {', '.join(available)}. "
            f"Aliases: {alias_list}"
        )
```

### 5.2 函数调用链

```
api_server.py 启动时:
  ① 加载 model_routes.json → dict[str, ModelRoute]
  ② 提取 aliases → dict[str, str]
  ③ routes 和 aliases 作为全局变量（启动后不变）

每个请求:
  model_id = body["model"]
  route = protocol.resolve_model(model_id, routes, aliases)
  
  messages = [_normalize_message(m) for m in body["messages"]]
  text = protocol.messages_to_text(messages)
  
  tools = [_normalize_tool(t) for t in body.get("tools", [])]
  tool_text = protocol.inject_tool_defs(tools, route.capabilities.supports_tool_calling)
  
  prompt = text + tool_text
  
  # ... 发 job、等结果 ...
  
  tool_calls = protocol.extract_tool_calls(result_text)
  response = protocol.text_to_openai_response(result_text, route.id, tool_calls, stream)
```

---

## 6. model_routes.json — 完整 Schema 与所有字段

### 6.1 完整的 JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Phantom Relay Model Routes",
  "type": "object",
  "required": ["aliases", "models", "settings"],
  "properties": {
    "aliases": {
      "type": "object",
      "description": "Short model names mapping to full model IDs",
      "additionalProperties": {"type": "string"},
      "default": {}
    },
    "models": {
      "type": "array",
      "items": {"$ref": "#/definitions/ModelDefinition"}
    },
    "settings": {"$ref": "#/definitions/GlobalSettings"}
  },
  "definitions": {
    "ModelDefinition": {
      "type": "object",
      "required": ["id", "object", "created", "owned_by", "name", "api", "provider", "capabilities", "selectors", "cost"],
      "properties": {
        "id": {
          "type": "string",
          "description": "Unique model identifier, used in /v1/chat/completions model field"
        },
        "object": {
          "type": "string",
          "const": "model",
          "description": "OpenAI standard: always 'model'"
        },
        "created": {
          "type": "integer",
          "description": "Unix timestamp of model registration"
        },
        "owned_by": {
          "type": "string",
          "description": "OpenAI standard: organization that owns the model"
        },
        "name": {
          "type": "string",
          "description": "Human-readable display name (OpenClaw compat: ModelDefinitionConfig.name)"
        },
        "root": {
          "type": ["string", "null"],
          "description": "OpenAI standard: root model this is derived from"
        },
        "parent": {
          "type": ["string", "null"],
          "description": "OpenAI standard: parent model"
        },
        "permission": {
          "type": "array",
          "description": "OpenAI standard: model permissions",
          "items": {
            "type": "object",
            "properties": {
              "id": {"type": "string"},
              "object": {"type": "string", "const": "model_permission"},
              "created": {"type": "integer"},
              "allow_create_engine": {"type": "boolean"},
              "allow_sampling": {"type": "boolean"},
              "allow_logprobs": {"type": "boolean"},
              "allow_search_indices": {"type": "boolean"},
              "allow_view": {"type": "boolean"},
              "allow_fine_tuning": {"type": "boolean"},
              "organization": {"type": "string"},
              "group": {"type": ["string", "null"]},
              "is_blocking": {"type": "boolean"}
            }
          }
        },
        "api": {
          "type": "string",
          "enum": ["browser"],
          "description": "Backend type (OpenClaw compat: ModelApi)"
        },
        "provider": {"$ref": "#/definitions/ProviderInfo"},
        "capabilities": {"$ref": "#/definitions/Capabilities"},
        "selectors": {"$ref": "#/definitions/Selectors"},
        "cost": {"$ref": "#/definitions/Cost"}
      }
    },
    "ProviderInfo": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "browser",
          "description": "Provider type — always 'browser' for Phantom Relay"
        },
        "domain": {
          "type": "string",
          "description": "Target browser domain (e.g. www.doubao.com)"
        },
        "url": {
          "type": "string",
          "description": "Full URL to navigate to (e.g. https://www.doubao.com/chat/)"
        },
        "auth_method": {
          "type": "string",
          "enum": ["cookie", "oauth", "none"],
          "description": "How the browser is authenticated"
        },
        "requires_login": {
          "type": "boolean",
          "description": "Whether a login session is required"
        }
      }
    },
    "Capabilities": {
      "type": "object",
      "properties": {
        "input_modalities": {
          "type": "array",
          "items": {"type": "string", "enum": ["text", "image", "audio"]}
        },
        "output_modalities": {
          "type": "array",
          "items": {"type": "string", "enum": ["text", "image", "audio"]}
        },
        "supports_tool_calling": {
          "type": "boolean",
          "description": "Can this model return tool_calls? (false → don't inject tool prompt)"
        },
        "supports_streaming": {"type": "boolean"},
        "supports_vision": {"type": "boolean"},
        "supports_file_upload": {
          "type": "boolean",
          "description": "Does the web UI have a file upload button?"
        },
        "supports_developer_role": {"type": "boolean"},
        "supports_reasoning_effort": {"type": "boolean"},
        "supports_usage_in_streaming": {"type": "boolean"},
        "supports_strict_mode": {"type": "boolean"},
        "supports_store": {"type": "boolean"},
        "requires_tool_result_name": {"type": "boolean"},
        "requires_assistant_after_tool_result": {"type": "boolean"},
        "requires_thinking_as_text": {"type": "boolean"},
        "thinking_format": {
          "type": ["string", "null"],
          "enum": [null, "openai", "openrouter", "qwen-chat-template"]
        },
        "max_tokens_field": {
          "type": "string",
          "description": "Which field name to use for max_tokens in API calls",
          "enum": ["max_tokens", "max_completion_tokens"]
        },
        "context_window": {"type": "integer"},
        "max_output_tokens": {"type": "integer"},
        "max_input_chars": {
          "type": "integer",
          "description": "Max characters for direct text input before switching to file upload"
        },
        "reasoning": {"type": "boolean"}
      }
    },
    "Selectors": {
      "type": "object",
      "properties": {
        "input": {
          "type": "string",
          "description": "CSS selector for the chat input textarea/div"
        },
        "send_button": {
          "type": "string",
          "description": "CSS selector for the send/submit button"
        },
        "response_area": {
          "type": "string",
          "description": "CSS selector for the AI response text container"
        },
        "file_upload": {
          "type": "string",
          "description": "CSS selector for the file upload input[type=file] or button"
        },
        "new_chat": {
          "type": "string",
          "description": "CSS selector for the 'new conversation' button"
        },
        "thinking_area": {
          "type": "string",
          "description": "CSS selector for the thinking/reasoning display area"
        },
        "error_indicator": {
          "type": "string",
          "description": "CSS selector for error messages"
        },
        "loading_indicator": {
          "type": "string",
          "description": "CSS selector for loading spinner/indicator"
        },
        "stop_button": {
          "type": "string",
          "description": "CSS selector for the stop generating button"
        }
      }
    },
    "Cost": {
      "type": "object",
      "properties": {
        "input_per_million_tokens": {"type": "number"},
        "output_per_million_tokens": {"type": "number"},
        "cache_read_per_million_tokens": {"type": "number"},
        "cache_write_per_million_tokens": {"type": "number"},
        "currency": {"type": "string", "default": "USD"}
      }
    },
    "GlobalSettings": {
      "type": "object",
      "properties": {
        "default_model": {"type": "string"},
        "request_timeout_ms": {"type": "integer"},
        "max_retries": {"type": "integer"},
        "browser": {
          "type": "object",
          "properties": {
            "idle_timeout_ms": {"type": "integer"},
            "max_concurrent_jobs": {"type": "integer"},
            "page_load_timeout_ms": {"type": "integer"}
          }
        },
        "sse": {
          "type": "object",
          "properties": {
            "heartbeat_interval_ms": {"type": "integer"},
            "max_chunk_delay_ms": {"type": "integer"}
          }
        }
      }
    }
  }
}
```

### 6.2 完整的初始配置（含 4 个模型）

```json
{
  "aliases": {
    "router": "doubao",
    "doubao-default": "doubao",
    "seed": "doubao",
    "ds": "deepseek-chat",
    "v3": "deepseek-chat",
    "deepseek": "deepseek-chat",
    "r1": "deepseek-reasoner",
    "qianwen": "qwen-turbo",
    "qwen": "qwen-turbo",
    "tongyi": "qwen-turbo",
    "wenxin": "ernie-bot",
    "ernie": "ernie-bot",
    "yiyan": "ernie-bot"
  },
  "models": [
    {
      "id": "doubao",
      "object": "model",
      "created": 1700000000,
      "owned_by": "bytedance",
      "name": "豆包 Seed 1.5",
      "root": "doubao",
      "parent": null,
      "permission": [
        {
          "id": "modelperm-doubao-001",
          "object": "model_permission",
          "created": 1700000000,
          "allow_create_engine": false,
          "allow_sampling": true,
          "allow_logprobs": false,
          "allow_search_indices": false,
          "allow_view": true,
          "allow_fine_tuning": false,
          "organization": "*",
          "group": null,
          "is_blocking": false
        }
      ],
      "api": "browser",
      "provider": {
        "type": "browser",
        "domain": "www.doubao.com",
        "url": "https://www.doubao.com/chat/",
        "auth_method": "cookie",
        "requires_login": true
      },
      "capabilities": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "supports_tool_calling": false,
        "supports_streaming": true,
        "supports_vision": false,
        "supports_file_upload": true,
        "supports_developer_role": false,
        "supports_reasoning_effort": false,
        "supports_usage_in_streaming": false,
        "supports_strict_mode": false,
        "supports_store": false,
        "requires_tool_result_name": false,
        "requires_assistant_after_tool_result": false,
        "requires_thinking_as_text": false,
        "thinking_format": null,
        "max_tokens_field": "max_tokens",
        "context_window": 32000,
        "max_output_tokens": 4096,
        "max_input_chars": 8000,
        "reasoning": false
      },
      "selectors": {
        "input": "textarea[placeholder*='发消息']",
        "send_button": "button[class*='send']",
        "response_area": "[class*='message-content']",
        "file_upload": "input[type='file']",
        "new_chat": "[data-testid='new_chat']",
        "thinking_area": "",
        "error_indicator": "[class*='error']",
        "loading_indicator": "[class*='loading']",
        "stop_button": "[class*='stop']"
      },
      "cost": {
        "input_per_million_tokens": 0,
        "output_per_million_tokens": 0,
        "cache_read_per_million_tokens": 0,
        "cache_write_per_million_tokens": 0,
        "currency": "USD"
      }
    },
    {
      "id": "deepseek-chat",
      "object": "model",
      "created": 1700000000,
      "owned_by": "deepseek",
      "name": "DeepSeek V3",
      "root": "deepseek-chat",
      "parent": null,
      "permission": [
        {
          "id": "modelperm-ds-001",
          "object": "model_permission",
          "created": 1700000000,
          "allow_create_engine": false,
          "allow_sampling": true,
          "allow_logprobs": false,
          "allow_search_indices": false,
          "allow_view": true,
          "allow_fine_tuning": false,
          "organization": "*",
          "group": null,
          "is_blocking": false
        }
      ],
      "api": "browser",
      "provider": {
        "type": "browser",
        "domain": "chat.deepseek.com",
        "url": "https://chat.deepseek.com/",
        "auth_method": "cookie",
        "requires_login": true
      },
      "capabilities": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "supports_tool_calling": true,
        "supports_streaming": true,
        "supports_vision": false,
        "supports_file_upload": true,
        "supports_developer_role": true,
        "supports_reasoning_effort": false,
        "supports_usage_in_streaming": true,
        "supports_strict_mode": false,
        "supports_store": false,
        "requires_tool_result_name": true,
        "requires_assistant_after_tool_result": true,
        "requires_thinking_as_text": false,
        "thinking_format": null,
        "max_tokens_field": "max_tokens",
        "context_window": 64000,
        "max_output_tokens": 8192,
        "max_input_chars": 64000,
        "reasoning": false
      },
      "selectors": {
        "input": "textarea[id='chat-input']",
        "send_button": "[data-testid='send_btn']",
        "response_area": ".ds-markdown",
        "file_upload": "input[type='file']",
        "new_chat": "[data-testid='new_chat']",
        "thinking_area": "[class*='ds-thinking']",
        "error_indicator": "[class*='error-message']",
        "loading_indicator": "[class*='spinner']",
        "stop_button": "[class*='stop']"
      },
      "cost": {
        "input_per_million_tokens": 0,
        "output_per_million_tokens": 0,
        "cache_read_per_million_tokens": 0,
        "cache_write_per_million_tokens": 0,
        "currency": "USD"
      }
    },
    {
      "id": "deepseek-reasoner",
      "object": "model",
      "created": 1700000000,
      "owned_by": "deepseek",
      "name": "DeepSeek R1",
      "root": "deepseek-reasoner",
      "parent": null,
      "permission": [
        {
          "id": "modelperm-dsr1-001",
          "object": "model_permission",
          "created": 1700000000,
          "allow_create_engine": false,
          "allow_sampling": true,
          "allow_logprobs": false,
          "allow_search_indices": false,
          "allow_view": true,
          "allow_fine_tuning": false,
          "organization": "*",
          "group": null,
          "is_blocking": false
        }
      ],
      "api": "browser",
      "provider": {
        "type": "browser",
        "domain": "chat.deepseek.com",
        "url": "https://chat.deepseek.com/",
        "auth_method": "cookie",
        "requires_login": true
      },
      "capabilities": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "supports_tool_calling": true,
        "supports_streaming": true,
        "supports_vision": false,
        "supports_file_upload": true,
        "supports_developer_role": true,
        "supports_reasoning_effort": false,
        "supports_usage_in_streaming": true,
        "supports_strict_mode": false,
        "supports_store": false,
        "requires_tool_result_name": true,
        "requires_assistant_after_tool_result": true,
        "requires_thinking_as_text": true,
        "thinking_format": "openai",
        "max_tokens_field": "max_tokens",
        "context_window": 64000,
        "max_output_tokens": 8192,
        "max_input_chars": 64000,
        "reasoning": true
      },
      "selectors": {
        "input": "textarea[id='chat-input']",
        "send_button": "[data-testid='send_btn']",
        "response_area": ".ds-markdown",
        "file_upload": "input[type='file']",
        "new_chat": "[data-testid='new_chat']",
        "thinking_area": "[class*='ds-thinking']",
        "error_indicator": "[class*='error-message']",
        "loading_indicator": "[class*='spinner']",
        "stop_button": "[class*='stop']"
      },
      "cost": {
        "input_per_million_tokens": 0,
        "output_per_million_tokens": 0,
        "cache_read_per_million_tokens": 0,
        "cache_write_per_million_tokens": 0,
        "currency": "USD"
      }
    },
    {
      "id": "qwen-turbo",
      "object": "model",
      "created": 1700000000,
      "owned_by": "alibaba",
      "name": "通义千问 Turbo",
      "root": "qwen-turbo",
      "parent": null,
      "permission": [
        {
          "id": "modelperm-qwen-001",
          "object": "model_permission",
          "created": 1700000000,
          "allow_create_engine": false,
          "allow_sampling": true,
          "allow_logprobs": false,
          "allow_search_indices": false,
          "allow_view": true,
          "allow_fine_tuning": false,
          "organization": "*",
          "group": null,
          "is_blocking": false
        }
      ],
      "api": "browser",
      "provider": {
        "type": "browser",
        "domain": "tongyi.aliyun.com",
        "url": "https://tongyi.aliyun.com/qianwen/",
        "auth_method": "cookie",
        "requires_login": true
      },
      "capabilities": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "supports_tool_calling": false,
        "supports_streaming": true,
        "supports_vision": false,
        "supports_file_upload": true,
        "supports_developer_role": false,
        "supports_reasoning_effort": false,
        "supports_usage_in_streaming": false,
        "supports_strict_mode": false,
        "supports_store": false,
        "requires_tool_result_name": false,
        "requires_assistant_after_tool_result": false,
        "requires_thinking_as_text": false,
        "thinking_format": null,
        "max_tokens_field": "max_tokens",
        "context_window": 32000,
        "max_output_tokens": 4096,
        "max_input_chars": 16000,
        "reasoning": false
      },
      "selectors": {
        "input": "textarea[placeholder*='请输入']",
        "send_button": "[class*='send-btn']",
        "response_area": "[class*='bot-answer']",
        "file_upload": "input[type='file']",
        "new_chat": "[class*='new-chat']",
        "thinking_area": "",
        "error_indicator": "[class*='error']",
        "loading_indicator": "[class*='loading']",
        "stop_button": "[class*='stop']"
      },
      "cost": {
        "input_per_million_tokens": 0,
        "output_per_million_tokens": 0,
        "cache_read_per_million_tokens": 0,
        "cache_write_per_million_tokens": 0,
        "currency": "USD"
      }
    }
  ],
  "settings": {
    "default_model": "router",
    "request_timeout_ms": 120000,
    "max_retries": 2,
    "browser": {
      "idle_timeout_ms": 300000,
      "max_concurrent_jobs": 3,
      "page_load_timeout_ms": 30000
    },
    "sse": {
      "heartbeat_interval_ms": 15000,
      "max_chunk_delay_ms": 2000
    }
  }
}
```

---

## 7. api_server.py — 行级瘦身指南

### 7.1 当前代码留存分析

| 行号范围 | 函数/模块 | 处理 |
|----------|----------|------|
| 1-60 | imports | 保留，删掉不再用的 import |
| 60-150 | Flask app setup, config | 保留 |
| 150-200 | `load_model_config()` | 重写 → 加载 model_routes.json → 构建 routes + aliases |
| 200-300 | `load_selector_config()` | 删除 → 选择器已在 model_routes.json |
| 300-400 | browser prompt 函数 (`_tool_prompt`, `_tool_injection_needed`, `browser_prompt`) | 全删 → 移到 protocol.py |
| 400-500 | `normalize_messages()` | 删除 → 简化为一行 `[Message(role=m.role, content=...) for m in raw]` |
| 500-650 | `parse_network_sse_body()` + SSE 解析 | 删除 → SSE 封装由 protocol.text_to_sse_chunk() |
| 650-750 | `unsupported_capability()` | 删除 → 能力表已返回 |
| 750-900 | browser endpoints (/browser/*) | 保留 |
| 900-1050 | health check | 保留 |
| 1050-1200 | job queue logic | 保留 |
| 1200-1425 | `/v1/chat/completions` handler | 重写（见下方） |
| 1425-1685 | SSE streaming engine | 重写（见下方） |

### 7.2 新的 `/v1/chat/completions` handler 伪代码

```python
@app.route('/v1/chat/completions', methods=['POST'])
def chat_completions():
    """OpenAI-compatible chat completions endpoint."""
    try:
        body = request.get_json(force=True)
    except Exception:
        return protocol.build_openai_error(
            "Invalid JSON in request body",
            "invalid_request_error", "invalid_json", 400
        )
    
    # 1. Validate required fields
    model_id = body.get('model', '')
    if not model_id:
        return protocol.build_openai_error(
            "Missing required field: model",
            "invalid_request_error", "missing_field", 400
        )
    
    raw_messages = body.get('messages', [])
    if not raw_messages:
        return protocol.build_openai_error(
            "Missing required field: messages",
            "invalid_request_error", "missing_field", 400
        )
    
    # 2. Resolve model
    try:
        route = protocol.resolve_model(model_id, _routes, _aliases)
    except protocol.ModelNotFoundError as e:
        return protocol.build_openai_error(
            str(e),
            "invalid_request_error", "model_not_found", 404
        )
    
    # 3. Normalize messages
    messages = []
    for m in raw_messages:
        content = m.get('content', '')
        if isinstance(content, list):
            # Handle content array (multimodal) — extract text parts only
            text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']
            content = '\n'.join(text_parts)
        messages.append(protocol.Message(
            role=m.get('role', 'user'),
            content=str(content) if content else '',
            name=m.get('name'),
            tool_call_id=m.get('tool_call_id'),
            tool_calls=m.get('tool_calls'),
        ))
    
    # 4. Build browser prompt
    browser_text = protocol.messages_to_text(messages)
    if not browser_text.strip():
        return protocol.build_openai_error(
            "All messages have empty content",
            "invalid_request_error", "empty_messages", 400
        )
    
    # 5. Inject tool definitions (if applicable)
    raw_tools = body.get('tools', [])
    tools = []
    for t in raw_tools:
        fn = t.get('function', {})
        tools.append(protocol.ToolDefinition(
            type=t.get('type', 'function'),
            function=fn,
        ))
    
    tool_prompt = protocol.inject_tool_defs(
        tools, route.capabilities.supports_tool_calling
    )
    full_prompt = browser_text + tool_prompt
    
    # 6. Check for streaming
    stream = body.get('stream', False)
    
    # 7. Create browser job
    job_id = str(uuid.uuid4())
    job = {
        'id': job_id,
        'domain': route.domain,
        'url': route.url,
        'prompt': full_prompt,
        'selectors': route.selectors,
        'stream': stream,
        'capabilities': {
            'max_input_chars': route.capabilities.max_input_chars,
            'supports_file_upload': route.capabilities.supports_file_upload,
        },
        'created_at': time.time(),
        'status': 'pending',
    }
    _jobs[job_id] = job
    
    # 8. If streaming, start SSE response
    if stream:
        return _handle_streaming(job_id, route)
    else:
        return _handle_nonstreaming(job_id, route)


def _handle_streaming(job_id: str, route: protocol.ModelRoute):
    """Handle streaming chat completion."""
    
    def generate():
        response_id = f"chatcmpl-{protocol._short_uuid()}"
        created = int(time.time())
        
        # Send initial chunk with role
        yield protocol.text_to_sse_chunk(
            delta_role="assistant",
            model=route.id,
            response_id=response_id,
            created=created,
        )
        
        # Wait for browser result (polling)
        last_text = ""
        timeout = _settings.get('request_timeout_ms', 120000) / 1000
        start = time.time()
        
        while time.time() - start < timeout:
            job = _jobs.get(job_id)
            if not job or job.get('status') == 'timeout':
                yield protocol.build_sse_error("Request timed out", "timeout")
                return
            if job.get('status') == 'error':
                yield protocol.build_sse_error(
                    job.get('error', 'Unknown browser error'), "browser_error"
                )
                return
            if job.get('status') == 'success':
                result_text = job.get('result_text', '')
                
                # Check for tool calls in final result
                tool_calls = protocol.extract_tool_calls(result_text)
                
                if tool_calls:
                    # Send tool_calls as a single chunk
                    tc_array = []
                    for i, tc in enumerate(tool_calls):
                        tc_array.append({
                            "index": i,
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function_name,
                                "arguments": tc.arguments,
                            }
                        })
                    yield protocol.text_to_sse_chunk(
                        delta_content=None,
                        tool_calls_delta=tc_array,
                        model=route.id,
                        finish_reason="tool_calls",
                        response_id=response_id,
                        created=created,
                    )
                elif result_text != last_text:
                    # Send text delta
                    delta = result_text[len(last_text):]
                    if delta:
                        yield protocol.text_to_sse_chunk(
                            delta_content=delta,
                            model=route.id,
                            response_id=response_id,
                            created=created,
                        )
                    last_text = result_text
                
                # Send final done chunk
                yield protocol.text_to_sse_chunk(
                    delta_content="",
                    model=route.id,
                    finish_reason="stop",
                    response_id=response_id,
                    created=created,
                )
                yield protocol.build_sse_done()
                return
            
            # Heartbeat to keep connection alive
            yield ": heartbeat\n\n"
            time.sleep(3)
        
        # Timeout
        yield protocol.build_sse_error("Request timed out", "timeout")
    
    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        }
    )


def _handle_nonstreaming(job_id: str, route: protocol.ModelRoute):
    """Handle non-streaming chat completion."""
    timeout = _settings.get('request_timeout_ms', 120000) / 1000
    start = time.time()
    
    while time.time() - start < timeout:
        job = _jobs.get(job_id)
        if not job or job.get('status') == 'timeout':
            return protocol.build_openai_error(
                "Request timed out",
                "server_error", "timeout", 504
            )
        if job.get('status') == 'error':
            return protocol.build_openai_error(
                job.get('error', 'Unknown browser error'),
                "server_error", "browser_error", 502
            )
        if job.get('status') == 'success':
            result_text = job.get('result_text', '')
            tool_calls = protocol.extract_tool_calls(result_text)
            
            if tool_calls:
                response = protocol.text_to_openai_response(
                    text="",
                    model=route.id,
                    tool_calls=tool_calls,
                    stream=False,
                    finish_reason="tool_calls",
                )
            else:
                response = protocol.text_to_openai_response(
                    text=result_text,
                    model=route.id,
                    stream=False,
                    finish_reason="stop",
                )
            
            return jsonify(dataclasses.asdict(response))
        
        time.sleep(1)
    
    return protocol.build_openai_error(
        "Request timed out",
        "server_error", "timeout", 504
    )
```

### 7.3 删除的 import

```python
# 以下 import 不再需要（逻辑移到 protocol.py）
# import re             → 移到 protocol.py
# import json           → 已在 protocol.py 使用，api_server 仍需要
# from typing import ... → 保留

# 以下函数全删
# _tool_prompt()
# _tool_injection_needed()
# browser_prompt()
# normalize_messages()
# parse_network_sse_body()
# unsupported_capability()
```

### 7.4 新增的 import

```python
import dataclasses
from server.protocol import (
    ModelRoute, ModelCapabilities, Message, ToolDefinition,
    ParsedToolCall, OpenAIResponse, ModelNotFoundError,
    resolve_model, messages_to_text, inject_tool_defs,
    extract_tool_calls, text_to_openai_response,
    text_to_sse_chunk, build_sse_done, build_sse_error,
    build_openai_error, build_model_list, estimate_tokens,
)
```

---

## 8. 新增端点 — 完整请求/响应规范

### 8.1 GET /v1/models

```
Request:
  GET /v1/models
  Authorization: Bearer sk-xxx

Response 200:
  {
    "object": "list",
    "data": [
      {"id": "doubao", "object": "model", "created": 1700000000, "owned_by": "bytedance"},
      {"id": "deepseek-chat", "object": "model", "created": 1700000000, "owned_by": "deepseek"},
      {"id": "deepseek-reasoner", "object": "model", "created": 1700000000, "owned_by": "deepseek"},
      {"id": "qwen-turbo", "object": "model", "created": 1700000000, "owned_by": "alibaba"}
    ]
  }
```

### 8.2 GET /admin/api/models

```
Request:
  GET /admin/api/models

Response 200:
  {
    "aliases": {...},
    "models": [...],    // Full model definitions
    "settings": {...}
  }
```

### 8.3 PUT /admin/api/models/{id}

```
Request:
  PUT /admin/api/models/{id}
  Content-Type: application/json
  {...}  // Partial or full model definition

Response 200:
  {"status": "ok", "model": "doubao"}

Response 404:
  {"status": "error", "message": "Model 'unknown' not found"}
```

### 8.4 POST /admin/api/models

```
Request:
  POST /admin/api/models
  Content-Type: application/json
  {...}  // Full model definition (must include "id")

Response 201:
  {"status": "ok", "model": "new-model"}

Response 400:
  {"status": "error", "message": "Model ID already exists"}
```

### 8.5 DELETE /admin/api/models/{id}

```
Request:
  DELETE /admin/api/models/{id}

Response 200:
  {"status": "ok"}

Response 404:
  {"status": "error", "message": "Model 'unknown' not found"}
```

### 8.6 POST /admin/api/test

```
Request:
  POST /admin/api/test
  Content-Type: application/json
  {
    "model": "doubao",
    "messages": [{"role": "user", "content": "1+1=?"}],
    "stream": false
  }

Response 200:
  {
    "status": "ok",
    "response": {
      "id": "chatcmpl-xxx",
      "choices": [{"message": {"content": "1+1=2"}, "finish_reason": "stop"}],
      "usage": {"total_tokens": 11}
    },
    "elapsed_ms": 5234
  }

Response 500:
  {
    "status": "error",
    "error": "Browser timeout",
    "elapsed_ms": 120000
  }
```

---

## 9. SSE 流格式规范

### 9.1 完整 SSE 流示例（正常文本）

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":"+"},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":"="},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":"2"},"finish_reason":null,"logprobs":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1712345678,"model":"doubao","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop","logprobs":null}]}

data: [DONE]
```

### 9.2 SSE 流示例（tool_calls）

```
data: {"id":"chatcmpl-xyz789","object":"chat.completion.chunk","created":1712345678,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null,"logprobs":null}]}

: heartbeat

data: {"id":"chatcmpl-xyz789","object":"chat.completion.chunk","created":1712345678,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"exec","arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":"tool_calls","logprobs":null}]}

data: [DONE]
```

### 9.3 SSE 格式要求

| 规则 | 说明 |
|------|------|
| 每个事件以 `data: ` 开头 | JSON 值紧跟冒号空格 |
| 每个事件以 `\n\n` 结尾 | 双换行是 SSE 事件分隔符 |
| heartbeat 以 `:` 开头 | `: heartbeat\n\n` 是 SSE 注释，客户端会忽略但保活 |
| 第一个 chunk 必须包含 `delta.role: "assistant"` | Cherry Studio 要求 |
| 最后一个 chunk 必须包含 `finish_reason` | 否则客户端不会停止 |
| `data: [DONE]\n\n` 是终止标记 | 必须在 finish_reason chunk 之后 |
| 空 content 不发 | Cherry Studio 对空 delta 会报错 |
| heartbeat 间隔 15 秒 | 配置在 settings.sse.heartbeat_interval_ms |

---

## 10. 管理页面 /admin — 完整功能与 UI

### 10.1 技术选型

- 单文件 HTML（零依赖，零构建）
- 原生 CSS（Flexbox 布局，暗色主题）
- 原生 JS（Fetch API，无框架）

### 10.2 页面结构

```
┌─────────────────────────────────────────────────────┐
│  Phantom Relay Admin                    [保存] [刷新] │
├─────────────────────────────────────────────────────┤
│  别名映射                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │ router → doubao   ds → deepseek-chat         │   │
│  │ qwen → qwen-turbo  wenxin → ernie-bot         │   │
│  │ [+ 添加别名]                                   │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  模型列表                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │ doubao    │ 豆包 Seed 1.5   │ ✅ 连接 │ [编辑]  │   │
│  │           │ doubao.com       │ 流式    │ [测试]  │   │
│  │           │ max_input: 8000  │ 上传    │ [删除]  │   │
│  ├──────────────────────────────────────────────┤   │
│  │ deepseek  │ DeepSeek V3      │ ✅ 连接 │ [编辑]  │   │
│  │ -chat     │ chat.deepseek    │ 流式    │ [测试]  │   │
│  │           │ max_input: 64000 │ 上传    │ [删除]  │   │
│  │           │ tool_calling: ✅  │         │         │
│  ├──────────────────────────────────────────────┤   │
│  │ ...                                           │   │
│  ├──────────────────────────────────────────────┤   │
│  │                                    [+ 添加模型] │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  测试面板                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │ 模型: [doubao ▼]   流式: [☑]                   │   │
│  │ Prompt: [_____________________________]        │   │
│  │                                  [发送测试]    │   │
│  │ ──────────────────────────────────────────── │   │
│  │ 结果:                                          │   │
│  │ 1+1=2                                         │   │
│  │ 耗时: 5.2s                                    │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  全局设置                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │ 默认模型: [doubao ▼]                           │   │
│  │ 超时: [120000] ms   重试: [2]                  │   │
│  │ 浏览器空闲超时: [300000] ms                     │   │
│  │ SSE heartbeat: [15000] ms                      │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 10.3 功能清单

| 功能 | 操作 | API 调用 |
|------|------|---------|
| 查看所有模型 | 页面加载 | GET /admin/api/models |
| 编辑模型 | 点击[编辑]→展开 JSON 编辑器 | — |
| 保存修改 | 点击[保存] | PUT /admin/api/models/{id} |
| 添加模型 | 点击[+ 添加模型]→填写 JSON→保存 | POST /admin/api/models |
| 删除模型 | 点击[删除]→确认 | DELETE /admin/api/models/{id} |
| 测试模型 | 输入 prompt→点击[发送测试] | POST /admin/api/test |
| 别名管理 | 点击[+ 添加别名]→输入 key/value | PUT /admin/api/models (批量更新 aliases) |
| 全局设置 | 编辑→保存 | PUT /admin/api/settings |

---

## 11. 测试策略 — 逐条测试用例

### 11.1 单元测试: test_protocol.py

```python
# tests/test_protocol.py
import pytest
from server.protocol import (
    ModelRoute, ModelCapabilities, Message, ToolDefinition,
    ParsedToolCall, resolve_model, messages_to_text,
    inject_tool_defs, extract_tool_calls,
    text_to_openai_response, text_to_sse_chunk,
    build_sse_done, build_sse_error, build_openai_error,
    build_model_list, estimate_tokens, ModelNotFoundError,
)

# ━━━━━ Fixtures ━━━━━

@pytest.fixture
def sample_routes():
    return {
        "doubao": ModelRoute(
            id="doubao", name="豆包", owned_by="bytedance",
            domain="www.doubao.com", url="https://www.doubao.com/chat/",
            api="browser",
            capabilities=ModelCapabilities(
                supports_tool_calling=False,
                context_window=32000, max_output_tokens=4096,
                max_input_chars=8000,
            ),
            selectors={"input": "textarea", "send_button": "button.send"},
            cost={"input_per_million_tokens": 0, "output_per_million_tokens": 0},
        ),
        "deepseek-chat": ModelRoute(
            id="deepseek-chat", name="DeepSeek V3", owned_by="deepseek",
            domain="chat.deepseek.com", url="https://chat.deepseek.com/",
            api="browser",
            capabilities=ModelCapabilities(
                supports_tool_calling=True,
                context_window=64000, max_output_tokens=8192,
                max_input_chars=64000,
            ),
            selectors={"input": "#chat-input", "send_button": "[data-testid='send_btn']"},
            cost={"input_per_million_tokens": 0, "output_per_million_tokens": 0},
        ),
    }

@pytest.fixture
def sample_aliases():
    return {"router": "doubao", "ds": "deepseek-chat"}


# ━━━━━ resolve_model tests ━━━━━

def test_resolve_model_direct(sample_routes, sample_aliases):
    """Model ID found directly in routes."""
    route = resolve_model("doubao", sample_routes, sample_aliases)
    assert route.id == "doubao"
    assert route.domain == "www.doubao.com"

def test_resolve_model_alias(sample_routes, sample_aliases):
    """Alias resolves to correct model."""
    route = resolve_model("router", sample_routes, sample_aliases)
    assert route.id == "doubao"

def test_resolve_model_alias_overrides_direct(sample_routes, sample_aliases):
    """Alias has priority over direct lookup."""
    # "ds" is an alias for "deepseek-chat"
    route = resolve_model("ds", sample_routes, sample_aliases)
    assert route.id == "deepseek-chat"

def test_resolve_model_not_found(sample_routes, sample_aliases):
    """Unknown model raises ModelNotFoundError."""
    with pytest.raises(ModelNotFoundError) as exc:
        resolve_model("nonexistent", sample_routes, sample_aliases)
    assert "nonexistent" in str(exc.value)
    assert "doubao" in str(exc.value)
    assert "deepseek-chat" in str(exc.value)


# ━━━━━ messages_to_text tests ━━━━━

def test_messages_to_text_simple():
    """Two messages → labeled text."""
    messages = [
        Message(role="system", content="你是豆包"),
        Message(role="user", content="1+1=?"),
    ]
    result = messages_to_text(messages)
    assert "System: 你是豆包" in result
    assert "User: 1+1=?" in result

def test_messages_to_text_20_messages():
    """20 messages → all preserved, nothing trimmed."""
    messages = []
    for i in range(10):
        messages.append(Message(role="user", content=f"User message {i}"))
        messages.append(Message(role="assistant", content=f"Assistant reply {i}"))
    result = messages_to_text(messages)
    assert "User message 0" in result
    assert "User message 9" in result
    assert "Assistant reply 0" in result
    assert "Assistant reply 9" in result
    # Count "User:" occurrences
    assert result.count("User:") == 10
    assert result.count("Assistant:") == 10

def test_messages_to_text_empty_content_skipped():
    """Message with empty content is skipped."""
    messages = [
        Message(role="user", content="Hello"),
        Message(role="assistant", content=""),
        Message(role="user", content="World"),
    ]
    result = messages_to_text(messages)
    assert "Hello" in result
    assert "World" in result
    assert result.count("Assistant:") == 0  # Skipped

def test_messages_to_text_all_empty():
    """All messages have empty content."""
    messages = [
        Message(role="user", content=""),
        Message(role="assistant", content=""),
    ]
    result = messages_to_text(messages)
    assert result == ""

def test_messages_to_text_tool_role():
    """Tool role message formatted correctly."""
    messages = [
        Message(role="tool", content="file1.txt\nfile2.txt", name="exec", tool_call_id="call_001"),
    ]
    result = messages_to_text(messages)
    assert "Tool exec returned:" in result
    assert "file1.txt" in result

def test_messages_to_text_assistant_with_tool_calls():
    """Assistant with tool_calls renders as XML tags."""
    messages = [
        Message(
            role="assistant",
            content="Let me check.",
            tool_calls=[{
                "id": "call_001",
                "type": "function",
                "function": {
                    "name": "exec",
                    "arguments": '{"command": "ls"}',
                },
            }],
        ),
    ]
    result = messages_to_text(messages)
    assert '<tool_call id="call_001" name="exec">' in result
    assert '{"command": "ls"}' in result
    assert "Let me check." in result

def test_messages_to_text_developer_role():
    """Developer role mapped to System label."""
    messages = [
        Message(role="developer", content="Be helpful."),
    ]
    result = messages_to_text(messages)
    assert result.startswith("System:")

def test_messages_to_text_chinese():
    """Chinese content preserved correctly."""
    messages = [
        Message(role="user", content="帮我查一下桌面有什么文件"),
        Message(role="assistant", content="好的，我来帮你查。"),
    ]
    result = messages_to_text(messages)
    assert "帮我查一下桌面有什么文件" in result
    assert "好的，我来帮你查" in result


# ━━━━━ inject_tool_defs tests ━━━━━

def test_inject_tool_defs_empty():
    """No tools → empty string."""
    result = inject_tool_defs([], supports_tool_calling=True)
    assert result == ""

def test_inject_tool_defs_not_supported():
    """Tools present but model doesn't support → empty string."""
    tools = [ToolDefinition(function={"name": "exec", "description": "Run command", "parameters": {}})]
    result = inject_tool_defs(tools, supports_tool_calling=False)
    assert result == ""

def test_inject_tool_defs_basic():
    """Single tool → template with tool def."""
    tools = [ToolDefinition(function={
        "name": "exec",
        "description": "Run shell command",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
    })]
    result = inject_tool_defs(tools, supports_tool_calling=True)
    assert "exec" in result
    assert "Run shell command" in result
    assert "tool_json" in result
    assert "plus_one" in result  # Example
    assert "Your actual tools are listed above" in result


# ━━━━━ extract_tool_calls tests ━━━━━

def test_extract_tool_calls_empty():
    """No tool call in text → empty list."""
    result = extract_tool_calls("Just a normal response.")
    assert result == []

def test_extract_tool_calls_fenced():
    """Fenced tool_json block extracted."""
    text = """```tool_json
{"tool":"exec","parameters":{"command":"ls -la"}}
```"""
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "exec"
    assert "ls -la" in result[0].arguments

def test_extract_tool_calls_bare_json():
    """Bare JSON tool call extracted."""
    text = '{"tool":"web_search","parameters":{"query":"天气"}}'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "web_search"

def test_extract_tool_calls_xml():
    """XML tool_call extracted."""
    text = '<tool_call>{"name":"read","arguments":{"path":"/etc/hosts"}}</tool_call>'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "read"

def test_extract_tool_calls_multiple_first_wins():
    """Multiple patterns → first match (fenced) wins."""
    text = """```tool_json
{"tool":"exec","parameters":{"command":"ls"}}
```
Also a bare JSON: {"tool":"web_search","parameters":{"query":"x"}}"""
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "exec"

def test_extract_tool_calls_broken_json():
    """Broken JSON → returns empty."""
    text = '{"tool":"exec","parameters":{}'
    result = extract_tool_calls(text)
    assert result == []

def test_extract_tool_calls_openai_format():
    """OpenAI format {"name":"...", "arguments":{...}}."""
    text = '<tool_call>{"name":"bash","arguments":{"cmd":"date"}}</tool_call>'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "bash"


# ━━━━━ text_to_openai_response tests ━━━━━

def test_text_to_response_normal():
    """Normal text → correct OpenAI response."""
    response = text_to_openai_response("1+1=2", model="doubao")
    assert response.object == "chat.completion"
    assert response.model == "doubao"
    assert len(response.choices) == 1
    assert response.choices[0]["message"]["content"] == "1+1=2"
    assert response.choices[0]["finish_reason"] == "stop"
    assert response.usage["total_tokens"] > 0

def test_text_to_response_empty():
    """Empty text → error finish reason."""
    response = text_to_openai_response("", model="doubao")
    assert response.choices[0]["finish_reason"] == "error"
    assert response.choices[0]["message"]["content"] == ""

def test_text_to_response_tool_calls():
    """Tool calls → properly formatted."""
    tool_calls = [ParsedToolCall(
        id="call_001",
        function_name="exec",
        arguments='{"command":"ls"}',
    )]
    response = text_to_openai_response("", model="deepseek-chat", tool_calls=tool_calls)
    assert response.choices[0]["finish_reason"] == "tool_calls"
    assert response.choices[0]["message"]["content"] is None
    assert len(response.choices[0]["message"]["tool_calls"]) == 1
    assert response.choices[0]["message"]["tool_calls"][0]["function"]["name"] == "exec"


# ━━━━━ SSE helpers tests ━━━━━

def test_text_to_sse_chunk_first():
    """First chunk has role."""
    chunk = text_to_sse_chunk(delta_role="assistant", model="doubao")
    assert chunk.startswith("data: ")
    assert chunk.endswith("\n\n")
    assert '"delta"' in chunk
    assert '"role":"assistant"' in chunk

def test_text_to_sse_chunk_content():
    """Content delta chunk."""
    chunk = text_to_sse_chunk(delta_content="Hello", model="doubao")
    assert '"content":"Hello"' in chunk

def test_text_to_sse_chunk_tool_calls():
    """Tool call delta."""
    tc = [{"index": 0, "id": "call_001", "type": "function", "function": {"name": "exec", "arguments": "{}"}}]
    chunk = text_to_sse_chunk(tool_calls_delta=tc, model="deepseek-chat", finish_reason="tool_calls")
    assert '"tool_calls"' in chunk
    assert '"finish_reason":"tool_calls"' in chunk

def test_build_sse_done():
    """Done marker."""
    assert build_sse_done() == "data: [DONE]\n\n"


# ━━━━━ estimate_tokens tests ━━━━━

def test_estimate_tokens_empty():
    assert estimate_tokens("") == 0

def test_estimate_tokens_english():
    tokens = estimate_tokens("Hello world")
    assert tokens > 0
    assert tokens <= 5

def test_estimate_tokens_chinese():
    tokens = estimate_tokens("你好世界")
    assert tokens > 0


# ━━━━━ build_openai_error tests ━━━━━

def test_build_openai_error():
    body, status = build_openai_error("Not found", "invalid_request_error", "model_not_found", 404)
    assert status == 404
    assert body["error"]["message"] == "Not found"
    assert body["error"]["type"] == "invalid_request_error"
    assert body["error"]["code"] == "model_not_found"


# ━━━━━ build_model_list tests ━━━━━

def test_build_model_list(sample_routes):
    result = build_model_list(sample_routes)
    assert result["object"] == "list"
    assert len(result["data"]) == 2
    ids = [m["id"] for m in result["data"]]
    assert "doubao" in ids
    assert "deepseek-chat" in ids
```

### 11.2 API 测试（curl）

```bash
# Test 1: /v1/models
curl -s http://localhost:8765/v1/models | jq '.data | length'  # Expect 4

# Test 2: Basic completion
curl -s http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"router","messages":[{"role":"user","content":"1+1=?"}],"stream":false}' \
  | jq '.choices[0].message.content'

# Test 3: Streaming
curl -s http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"router","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# Test 4: Tool calling
curl -s http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"list desktop"}],"tools":[{"type":"function","function":{"name":"exec","description":"Run shell","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}],"stream":false}'

# Test 5: Model alias
curl -s http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"ds","messages":[{"role":"user","content":"Hi"}],"stream":false}'

# Test 6: Unknown model → 404
curl -s -o /dev/null -w "%{http_code}" http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hi"}],"stream":false}'
# Expect 404

# Test 7: Empty messages → 400
curl -s -o /dev/null -w "%{http_code}" http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao","messages":[{"role":"user","content":""}],"stream":false}'
# Expect 400

# Test 8: Admin API
curl -s http://localhost:8765/admin/api/models | jq '.models[0].id'
```

### 11.3 Cherry Studio 端到端测试

```
1. Cherry Studio 配置:
   Provider Type: OpenAI Compatible
   Base URL: http://localhost:8765/v1
   API Key: sk-anything
   Model: router (or any configured alias)

2. Test A: 简单对话
   Input: "1+1=?"
   Expect: 文本回复，Cherry Studio 正常显示

3. Test B: 长对话（20 轮）
   Input: 连续发送 20 条消息
   Expect: 每条都正常回复，无消息丢失

4. Test C: 流式输出
   Enable stream in Cherry Studio
   Expect: 逐字显示

5. Test D: Tool calling (DeepSeek)
   Set model to deepseek-chat
   配置一个 tool（如 shell 命令）
   Expect: 返回 tool_call，Cherry Studio 显示工具调用
```

---

## 12. 迁移计划 — 从当前代码到目标架构

### Phase 1: 创建新文件（1 小时）

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1 | 创建 `server/protocol.py`（完整实现） | `python -c "from server.protocol import *"` 无报错 |
| 2 | 创建 `tests/test_protocol.py` | `pytest tests/test_protocol.py -v` 全部通过 |
| 3 | 创建 `server/model_routes.json`（新 schema） | `python -c "import json; json.load(open('server/model_routes.json'))"` 通过 |
| 4 | 创建 `server/static/admin.html` + `admin.js` | `curl http://localhost:8765/admin` 返回 200 |

### Phase 2: 重构 api_server.py（2 小时）

| 步骤 | 操作 | 验证 |
|------|------|------|
| 5 | 备份当前 api_server.py | `cp api_server.py api_server.py.bak` |
| 6 | 删除函数：`_tool_prompt`, `_tool_injection_needed`, `browser_prompt`, `normalize_messages`, `parse_network_sse_body`, `unsupported_capability` | diff 确认只有删除 |
| 7 | 删除函数：`load_selector_config` | diff 确认 |
| 8 | 重写 `load_model_config` → 加载新 model_routes.json | `python -c "from server.api_server import _routes; print(len(_routes))"` |
| 9 | 替换 `/v1/chat/completions` handler | curl test 1-3 |
| 10 | 替换 SSE 引擎 | curl test 3 (streaming) |
| 11 | 新增 `/v1/models` 端点 | curl test 1 |
| 12 | 新增 `/admin/*` 端点 | curl test 8 |

### Phase 3: 验证（1 小时）

| 步骤 | 操作 | 验证 |
|------|------|------|
| 13 | 跑全部 protocol 单元测试 | `pytest tests/test_protocol.py -v` 全部通过 |
| 14 | 跑全部 API curl 测试 | 8 个测试全部通过 |
| 15 | Cherry Studio 配置 | 发送简单对话，流式输出正常 |
| 16 | Cherry Studio tool calling | DeepSeek 模型 + tool，返回 tool_calls |
| 17 | 管理页面操作 | 添加/编辑/删除模型，保存后在 /v1/models 可见 |
| 18 | 回退测试 | 如有问题，`cp api_server.py.bak api_server.py` 回退 |

---

## 13. 边界情况与错误恢复

| 边界情况 | 行为 | 恢复方式 |
|---------|------|---------|
| 浏览器断开连接 | 所有 pending job → timeout | 客户端收到 504，可重试 |
| model_routes.json 格式错误 | 启动时报错退出 | 修复 JSON 格式后重启 |
| model_routes.json 文件不存在 | 启动时报错退出 | 创建默认配置文件 |
| 扩展版本不兼容 | 扩展连上但 content.js 行为异常 | 检查扩展版本，升级或降级 |
| 浏览器页面被关闭 | 当前 job → error | 扩展检测并报告，api_server 返回 502 |
| 同时 10 个请求到达 | 最多 3 个并发（settings.browser.max_concurrent_jobs） | 剩余排队，客户端可设置较短超时重试 |
| 工具调用 JSON 损坏 | extract_tool_calls 返回 [] | 浏览器文本原样返回，客户端自行处理 |
| 上传文件按钮找不到 | 扩展返回 error "File upload button not found" | api_server 返回 502，切换到键盘输入重试 |
| Cherry Studio 不认识某个参数 | 请求体直接透传 | 解析时跳过未知字段 |

---

## 14. 不做什么

| # | 不做什么 | 原因 |
|---|---------|------|
| 1 | ❌ 不内置执行工具 | Phantom Relay 不是 Agent Runtime |
| 2 | ❌ 不做消息裁剪 | 搬运工不删东西 |
| 3 | ❌ 不做 provider/adapter 类继承 | 过度设计，纯函数即可 |
| 4 | ❌ 不改扩展 content.js / background.js | 执行层已经是对的 |
| 5 | ❌ 不做模型选择器自动发现 | 用户手动在 /admin 配置 |
| 6 | ❌ 不做认证/API Key 管理 | 现阶段走 cookie，不管鉴权 |
| 7 | ❌ 不做请求限流 | 单用户场景，后续再加 |
| 8 | ❌ 不做聊天历史持久化 | 客户端自己管理 |
| 9 | ❌ 不做多账号/并发池 | 一个浏览器 profile 一个登录态 |
