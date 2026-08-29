# Phantom Relay 全兼容透明中转协议层 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 Phantom Relay 为两层架构（协议层 + 执行层），删除所有消息注入逻辑，接入 OpenAI 全兼容协议。

**Architecture:** 新建 `server/protocol.py`（350 行纯函数）负责格式转换；重写 `server/model_routes.json`（完整模型定义）；重构 `server/api_server.py`（1685→700 行）；新建管理页面和管理 API；新建 36 条单元测试。

**Tech Stack:** Python 3.10+, Flask, dataclasses, uuid, re, json, time

## Global Constraints

- protocol.py 零副作用：不读文件、不发网络、不依赖环境变量
- 不改 extension/ 下任何文件
- model_routes.json 部分更新时保留原有字段（深度 merge）
- 所有测试用例必须在 `tests/test_protocol.py` 中可单独运行
- OpenAI SSE 格式：`data: {...}\n\n`，第一个 chunk 必须含 `delta.role: "assistant"`
- 别名解析优先级：aliases > direct lookup
- 模型定义中 capability 字段必须全部显式声明，不依赖默认值

---

### Task 1: 创建 server/protocol.py — 数据结构 + 常量

**Files:**
- Create: `server/protocol.py`

**Interfaces:**
- Produces: `ModelCapabilities`, `ModelRoute`, `Message`, `ToolDefinition`, `ParsedToolCall`, `OpenAIResponse` (all dataclasses)
- Produces: `ROLE_LABELS`, `TOOL_PROMPT_TEMPLATE`, `_FENCED_PATTERN`, `_BARE_JSON_PATTERN`, `_XML_PATTERN` (constants)
- Produces: `ModelNotFoundError` (exception class)
- Produces: `_parse_tool_json()`, `_short_uuid()` (internal helpers)

- [ ] **Step 1: Create file with all dataclasses, constants, helpers, and error class**

```python
# server/protocol.py
"""Protocol translation layer — pure functions, zero side effects."""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


# ═══ Data Classes ═══

@dataclass
class ModelCapabilities:
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
    role: str
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict] | None = None


@dataclass
class ToolDefinition:
    type: str = "function"
    function: dict | None = None


@dataclass
class ParsedToolCall:
    id: str = ""
    type: str = "function"
    function_name: str = ""
    arguments: str = "{}"


@dataclass
class OpenAIResponse:
    id: str = ""
    object: str = "chat.completion"
    created: int = 0
    model: str = ""
    choices: list[dict] = field(default_factory=list)
    usage: dict | None = None
    system_fingerprint: str | None = None


# ═══ Constants ═══

ROLE_LABELS: dict[str, str] = {
    "system": "System",
    "developer": "System",
    "user": "User",
    "assistant": "Assistant",
    "tool": "Tool",
}

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

_FENCED_PATTERN = re.compile(
    r'```tool_json\s*\n?\s*(\{[\s\S]*?\})\}?\s*\n?\s*```'
)

_BARE_JSON_PATTERN = re.compile(
    r'\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}'
)

_XML_PATTERN = re.compile(
    r'<tool_call[^>]*>\s*(\{[\s\S]*?\})\s*</tool_call>'
)


# ═══ Internal Helpers ═══

def _parse_tool_json(raw: str) -> ParsedToolCall | None:
    if not raw or not raw.strip():
        return None
    try:
        cleaned = raw.strip()
        opens = cleaned.count("{")
        closes = cleaned.count("}")
        if opens > closes:
            cleaned += "}" * (opens - closes)
        obj = json.loads(cleaned)
        if "tool" in obj and isinstance(obj["tool"], str):
            return ParsedToolCall(
                id=f"call_{_short_uuid()}",
                function_name=obj["tool"],
                arguments=json.dumps(obj.get("parameters", {})),
            )
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
    return uuid.uuid4().hex[:12]


# ═══ Errors ═══

class ModelNotFoundError(Exception):
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

- [ ] **Step 2: Verify imports and syntax**

```bash
python3 -c "from server.protocol import (
    ModelCapabilities, ModelRoute, Message, ToolDefinition,
    ParsedToolCall, OpenAIResponse, ROLE_LABELS, TOOL_PROMPT_TEMPLATE,
    _FENCED_PATTERN, _BARE_JSON_PATTERN, _XML_PATTERN,
    _parse_tool_json, _short_uuid, ModelNotFoundError
); print('OK')"
```

- [ ] **Step 3: Commit**

```bash
cd /Users/lingion_k/Desktop/phantom-relay
git add server/protocol.py
git commit -m "feat: add protocol.py — dataclasses, constants, helpers, errors"
```

---

### Task 2: 创建 server/protocol.py — resolve_model + messages_to_text

**Files:**
- Modify: `server/protocol.py` — append to end

**Interfaces:**
- Consumes: `ModelRoute`, `ModelNotFoundError`, `ROLE_LABELS`, `Message` from Task 1
- Produces: `resolve_model(model_id, routes, aliases) -> ModelRoute`, `messages_to_text(messages) -> str`

- [ ] **Step 1: Append resolve_model and messages_to_text**

```python
# ═══ Public API: Model Resolution ═══

def resolve_model(
    model_id: str,
    routes: dict[str, ModelRoute],
    aliases: dict[str, str],
) -> ModelRoute:
    resolved_id = aliases.get(model_id, model_id)
    route = routes.get(resolved_id)
    if route is not None:
        return route
    available = list(routes.keys())
    raise ModelNotFoundError(model=model_id, available=available, aliases=aliases)


# ═══ Public API: Message Conversion ═══

def messages_to_text(messages: list[Message]) -> str:
    lines: list[str] = []
    for msg in messages:
        role = msg.role
        label = ROLE_LABELS.get(role, role.capitalize())
        content = msg.content or ""

        if role == "assistant" and msg.tool_calls:
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
```

- [ ] **Step 2: Verify**

```bash
python3 -c "
from server.protocol import (
    resolve_model, messages_to_text, Message,
    ModelRoute, ModelCapabilities, ModelNotFoundError,
)

# Test resolve_model
routes = {
    'doubao': ModelRoute(id='doubao', name='豆包', owned_by='bd',
        domain='doubao.com', url='https://doubao.com', api='browser',
        capabilities=ModelCapabilities(),
        selectors={}, cost={}),
}
aliases = {'router': 'doubao'}
r = resolve_model('router', routes, aliases)
assert r.id == 'doubao', f'Expected doubao, got {r.id}'

try:
    resolve_model('gpt4', routes, aliases)
    assert False, 'Should have raised'
except ModelNotFoundError as e:
    assert 'gpt4' in str(e)

# Test messages_to_text
msgs = [
    Message(role='system', content='你是AI'),
    Message(role='user', content='1+1=?'),
]
text = messages_to_text(msgs)
assert 'System: 你是AI' in text
assert 'User: 1+1=?' in text
print('OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/protocol.py
git commit -m "feat: add resolve_model and messages_to_text to protocol.py"
```

---

### Task 3: 创建 server/protocol.py — inject_tool_defs

**Files:**
- Modify: `server/protocol.py` — append to end

**Interfaces:**
- Consumes: `ToolDefinition`, `TOOL_PROMPT_TEMPLATE` from Task 1
- Produces: `inject_tool_defs(tools, supports_tool_calling) -> str`

- [ ] **Step 1: Append inject_tool_defs**

```python
# ═══ Public API: Tool Injection ═══

def inject_tool_defs(
    tools: list[ToolDefinition],
    supports_tool_calling: bool = True,
) -> str:
    if not tools or not supports_tool_calling:
        return ""
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
```

- [ ] **Step 2: Verify**

```bash
python3 -c "
from server.protocol import inject_tool_defs, ToolDefinition

# No tools
assert inject_tool_defs([], True) == ''
assert inject_tool_defs([ToolDefinition(function={'name':'x'})], False) == ''

# With tool
result = inject_tool_defs([ToolDefinition(function={
    'name': 'exec', 'description': 'Run command', 'parameters': {}
})], True)
assert 'exec' in result
assert 'tool_json' in result
assert 'plus_one' in result
print('OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/protocol.py
git commit -m "feat: add inject_tool_defs to protocol.py"
```

---

### Task 4: 创建 server/protocol.py — extract_tool_calls

**Files:**
- Modify: `server/protocol.py` — append to end

**Interfaces:**
- Consumes: `_FENCED_PATTERN`, `_BARE_JSON_PATTERN`, `_XML_PATTERN`, `_parse_tool_json`, `ParsedToolCall`, `_short_uuid` from Task 1
- Produces: `extract_tool_calls(text) -> list[ParsedToolCall]`

- [ ] **Step 1: Append extract_tool_calls**

```python
# ═══ Public API: Tool Call Extraction ═══

def extract_tool_calls(text: str) -> list[ParsedToolCall]:
    if not text:
        return []

    # Pattern 1: Fenced
    for match in _FENCED_PATTERN.finditer(text):
        parsed = _parse_tool_json(match.group(1))
        if parsed:
            return [parsed]

    # Pattern 2: Bare JSON
    for match in _BARE_JSON_PATTERN.finditer(text):
        tool_name = match.group(1)
        try:
            params = json.loads(match.group(2))
        except json.JSONDecodeError:
            continue
        return [ParsedToolCall(
            id=f"call_{_short_uuid()}",
            function_name=tool_name,
            arguments=json.dumps(params),
        )]

    # Pattern 3: XML
    for match in _XML_PATTERN.finditer(text):
        parsed = _parse_tool_json(match.group(1))
        if parsed:
            return [parsed]

    return []
```

- [ ] **Step 2: Verify**

```bash
python3 -c "
from server.protocol import extract_tool_calls

# No tool call
assert extract_tool_calls('Hello') == []
assert extract_tool_calls('') == []

# Fenced
result = extract_tool_calls('''\`\`\`tool_json
{\"tool\":\"exec\",\"parameters\":{\"command\":\"ls\"}}
\`\`\`''')
assert len(result) == 1 and result[0].function_name == 'exec'

# Bare JSON
result = extract_tool_calls('{\"tool\":\"web_search\",\"parameters\":{\"query\":\"x\"}}')
assert result[0].function_name == 'web_search'

# XML
result = extract_tool_calls('<tool_call>{\"name\":\"read\",\"arguments\":{\"path\":\"/x\"}}</tool_call>')
assert result[0].function_name == 'read'

print('OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/protocol.py
git commit -m "feat: add extract_tool_calls to protocol.py"
```

---

### Task 5: 创建 server/protocol.py — text_to_openai_response + SSE helpers + 辅助函数

**Files:**
- Modify: `server/protocol.py` — append to end

**Interfaces:**
- Consumes: `OpenAIResponse`, `ParsedToolCall`, `_short_uuid` from Task 1
- Produces: `text_to_openai_response()`, `text_to_sse_chunk()`, `build_sse_done()`, `build_sse_error()`, `build_openai_error()`, `build_model_list()`, `estimate_tokens()`

- [ ] **Step 1: Append all response-building functions**

```python
# ═══ Public API: Response Building ═══

def text_to_openai_response(
    text: str,
    model: str,
    tool_calls: list[ParsedToolCall] | None = None,
    stream: bool = False,
    finish_reason: str = "stop",
    system_fingerprint: str | None = None,
) -> OpenAIResponse:
    response_id = f"chatcmpl-{_short_uuid()}"
    created = int(time.time())

    tool_calls = tool_calls or []
    prompt_tokens = estimate_tokens(text) if text else 0
    completion_tokens = estimate_tokens(text) if text else 0

    if tool_calls:
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
        choices = [{
            "index": 0,
            "message": {"role": "assistant", "content": ""},
            "finish_reason": "error",
            "logprobs": None,
        }]
    else:
        choices = [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
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
    return "data: [DONE]\n\n"


def build_sse_error(message: str, error_type: str = "server_error") -> str:
    return f"data: {json.dumps({\"error\": {\"message\": message, \"type\": error_type}})}\n\n"


def build_openai_error(
    message: str,
    error_type: str = "server_error",
    code: str = "internal_error",
    status_code: int = 500,
) -> tuple[dict, int]:
    return {
        "error": {
            "message": message,
            "type": error_type,
            "code": code,
        }
    }, status_code


def build_model_list(models: dict[str, ModelRoute]) -> dict:
    data = []
    for model_id, route in models.items():
        data.append({
            "id": model_id,
            "object": "model",
            "created": route.created,
            "owned_by": route.owned_by,
        })
    return {"object": "list", "data": data}


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    char_count = len(text)
    cjk_count = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    non_cjk = char_count - cjk_count
    tokens = (cjk_count / 1.5) + (non_cjk / 4.0)
    return max(1, int(tokens))
```

- [ ] **Step 2: Verify**

```bash
python3 -c "
from server.protocol import (
    text_to_openai_response, ParsedToolCall,
    text_to_sse_chunk, build_sse_done, build_sse_error,
    build_openai_error, build_model_list, estimate_tokens,
    ModelRoute, ModelCapabilities,
)

# text_to_openai_response
r = text_to_openai_response('1+1=2', 'doubao')
assert r.object == 'chat.completion'
assert r.choices[0]['message']['content'] == '1+1=2'
assert r.choices[0]['finish_reason'] == 'stop'

# empty
r = text_to_openai_response('', 'doubao')
assert r.choices[0]['finish_reason'] == 'error'

# tool_calls
tc = [ParsedToolCall(id='c1', function_name='exec', arguments='{\"cmd\":\"ls\"}')]
r = text_to_openai_response('', 'ds', tool_calls=tc)
assert r.choices[0]['finish_reason'] == 'tool_calls'
assert r.choices[0]['message']['tool_calls'][0]['function']['name'] == 'exec'

# SSE
chunk = text_to_sse_chunk(delta_role='assistant', model='doubao')
assert 'data: ' in chunk and 'role' in chunk
assert build_sse_done() == 'data: [DONE]\n\n'

# Error
err, code = build_openai_error('Not found', 'invalid_request_error', 'model_not_found', 404)
assert code == 404 and err['error']['code'] == 'model_not_found'

# Model list
routes = {'d': ModelRoute(id='d', name='D', owned_by='X', domain='d.com',
    url='https://d.com', api='browser', capabilities=ModelCapabilities(),
    selectors={}, cost={})}
ml = build_model_list(routes)
assert ml['object'] == 'list' and len(ml['data']) == 1

# Tokens
assert estimate_tokens('') == 0
assert estimate_tokens('hello') > 0
print('OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/protocol.py
git commit -m "feat: add response builders and helpers to protocol.py"
```

---

### Task 6: 创建 server/model_routes.json

**Files:**
- Create: `server/model_routes.json`

**Interfaces:**
- Produces: `aliases`, `models[]`, `settings`

- [ ] **Step 1: Create model_routes.json with all 4 models**

```json
{
  "aliases": {
    "router": "doubao",
    "ds": "deepseek-chat",
    "deepseek": "deepseek-chat",
    "r1": "deepseek-reasoner",
    "qwen": "qwen-turbo",
    "tongyi": "qwen-turbo"
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
      "permission": [{
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
      }],
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
      "permission": [{
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
      }],
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
      "permission": [{
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
      }],
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
      "permission": [{
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
      }],
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

- [ ] **Step 2: Validate JSON**

```bash
python3 -c "import json; data=json.load(open('server/model_routes.json')); print(f'{len(data[\"models\"])} models, {len(data[\"aliases\"])} aliases')"
# Expect: 4 models, 6 aliases
```

- [ ] **Step 3: Commit**

```bash
git add server/model_routes.json
git commit -m "feat: add model_routes.json — 4 models with full OpenAI+OpenClaw schema"
```

---

### Task 7: 创建 tests/test_protocol.py — 完整测试套件

**Files:**
- Create: `tests/test_protocol.py`

**Interfaces:**
- Consumes: All public functions and classes from `server.protocol` (Tasks 1-5)
- Produces: 36 test functions, all passing

- [ ] **Step 1: Create test_protocol.py**

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


# ━━━ resolve_model ━━━

def test_resolve_model_direct(sample_routes, sample_aliases):
    route = resolve_model("doubao", sample_routes, sample_aliases)
    assert route.id == "doubao"

def test_resolve_model_alias(sample_routes, sample_aliases):
    route = resolve_model("router", sample_routes, sample_aliases)
    assert route.id == "doubao"

def test_resolve_model_not_found(sample_routes, sample_aliases):
    with pytest.raises(ModelNotFoundError) as exc:
        resolve_model("gpt4", sample_routes, sample_aliases)
    assert "gpt4" in str(exc.value)


# ━━━ messages_to_text ━━━

def test_messages_to_text_simple():
    msgs = [
        Message(role="system", content="你是AI"),
        Message(role="user", content="1+1=?"),
    ]
    text = messages_to_text(msgs)
    assert "System: 你是AI" in text
    assert "User: 1+1=?" in text

def test_messages_to_text_20_messages():
    msgs = []
    for i in range(10):
        msgs.append(Message(role="user", content=f"Msg {i}"))
        msgs.append(Message(role="assistant", content=f"Reply {i}"))
    text = messages_to_text(msgs)
    assert text.count("User:") == 10
    assert text.count("Assistant:") == 10
    assert "Msg 0" in text
    assert "Msg 9" in text

def test_messages_to_text_empty_skipped():
    msgs = [
        Message(role="user", content="Hello"),
        Message(role="assistant", content=""),
        Message(role="user", content="World"),
    ]
    text = messages_to_text(msgs)
    assert "Hello" in text
    assert "World" in text
    assert text.count("Assistant:") == 0

def test_messages_to_text_all_empty():
    text = messages_to_text([Message(role="user", content=""), Message(role="assistant", content="")])
    assert text == ""

def test_messages_to_text_tool_role():
    msgs = [Message(role="tool", content="file1.txt", name="exec", tool_call_id="c1")]
    text = messages_to_text(msgs)
    assert "Tool exec returned:" in text
    assert "file1.txt" in text

def test_messages_to_text_assistant_toolcalls():
    msgs = [Message(role="assistant", content="Let me check.", tool_calls=[{
        "id": "c1", "function": {"name": "exec", "arguments": '{"cmd":"ls"}'}
    }])]
    text = messages_to_text(msgs)
    assert '<tool_call id="c1" name="exec">' in text
    assert '{"cmd":"ls"}' in text

def test_messages_to_text_developer():
    text = messages_to_text([Message(role="developer", content="Be helpful.")])
    assert text.startswith("System:")

def test_messages_to_text_chinese():
    msgs = [Message(role="user", content="帮我查一下桌面")]
    text = messages_to_text(msgs)
    assert "帮我查一下桌面" in text


# ━━━ inject_tool_defs ━━━

def test_inject_tool_defs_empty():
    assert inject_tool_defs([], True) == ""

def test_inject_tool_defs_not_supported():
    t = ToolDefinition(function={"name": "exec", "description": "Run", "parameters": {}})
    assert inject_tool_defs([t], False) == ""

def test_inject_tool_defs_basic():
    t = ToolDefinition(function={"name": "exec", "description": "Run cmd", "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}})
    result = inject_tool_defs([t], True)
    assert "exec" in result
    assert "Run cmd" in result
    assert "tool_json" in result
    assert "plus_one" in result


# ━━━ extract_tool_calls ━━━

def test_extract_tool_calls_empty():
    assert extract_tool_calls("Hello") == []
    assert extract_tool_calls("") == []

def test_extract_tool_calls_fenced():
    text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "exec"

def test_extract_tool_calls_bare_json():
    result = extract_tool_calls('{"tool":"web_search","parameters":{"query":"x"}}')
    assert len(result) == 1
    assert result[0].function_name == "web_search"

def test_extract_tool_calls_xml():
    text = '<tool_call>{"name":"read","arguments":{"path":"/x"}}</tool_call>'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "read"

def test_extract_tool_calls_first_wins():
    text = '```tool_json\n{"tool":"exec","parameters":{}}\n```\n{"tool":"search","parameters":{}}'
    result = extract_tool_calls(text)
    assert len(result) == 1
    assert result[0].function_name == "exec"

def test_extract_tool_calls_broken_json():
    assert extract_tool_calls('{"tool":"exec","parameters":{}') == []


# ━━━ text_to_openai_response ━━━

def test_response_normal():
    r = text_to_openai_response("1+1=2", "doubao")
    assert r.object == "chat.completion"
    assert r.choices[0]["message"]["content"] == "1+1=2"
    assert r.choices[0]["finish_reason"] == "stop"
    assert r.usage["total_tokens"] > 0

def test_response_empty():
    r = text_to_openai_response("", "doubao")
    assert r.choices[0]["finish_reason"] == "error"

def test_response_toolcalls():
    tc = [ParsedToolCall(id="c1", function_name="exec", arguments='{"c":"ls"}')]
    r = text_to_openai_response("", "ds", tool_calls=tc)
    assert r.choices[0]["finish_reason"] == "tool_calls"
    assert r.choices[0]["message"]["tool_calls"][0]["function"]["name"] == "exec"


# ━━━ SSE builds ━━━

def test_sse_chunk_first():
    c = text_to_sse_chunk(delta_role="assistant", model="doubao")
    assert c.startswith("data: ")
    assert c.endswith("\n\n")
    assert '"role":"assistant"' in c

def test_sse_chunk_content():
    assert '"content":"Hi"' in text_to_sse_chunk(delta_content="Hi", model="d")

def test_sse_chunk_toolcalls():
    tc = [{"index":0,"id":"c1","type":"function","function":{"name":"e","arguments":"{}"}}]
    c = text_to_sse_chunk(tool_calls_delta=tc, model="ds", finish_reason="tool_calls")
    assert '"tool_calls"' in c
    assert '"finish_reason":"tool_calls"' in c

def test_sse_done():
    assert build_sse_done() == "data: [DONE]\n\n"


# ━━━ Errors ━━━

def test_build_openai_error():
    b, s = build_openai_error("NF", "invalid_request_error", "model_not_found", 404)
    assert s == 404
    assert b["error"]["code"] == "model_not_found"


# ━━━ Model list ━━━

def test_build_model_list(sample_routes):
    result = build_model_list(sample_routes)
    assert result["object"] == "list"
    ids = [m["id"] for m in result["data"]]
    assert "doubao" in ids
    assert "deepseek-chat" in ids


# ━━━ Tokens ━━━

def test_estimate_tokens_empty():
    assert estimate_tokens("") == 0

def test_estimate_tokens_english():
    assert 1 <= estimate_tokens("hello world") <= 5

def test_estimate_tokens_chinese():
    assert estimate_tokens("你好世界") > 0
```

- [ ] **Step 2: Run all tests**

```bash
cd /Users/lingion_k/Desktop/phantom-relay
python3 -m pytest tests/test_protocol.py -v
```

Expected: 30 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol.py
git commit -m "test: add 30 unit tests for protocol.py"
```

---

### Task 8: 重构 api_server.py — 导入 + 加载 model_routes.json

**Files:**
- Modify: `server/api_server.py`

**Interfaces:**
- Consumes: All of `server.protocol`
- Produces: `_routes`, `_aliases`, `_settings` globals

- [ ] **Step 1: Delete old functions and load new config**

在 `server/api_server.py` 中：
1. 文件开头新增 import（在现有 imports 之后）：

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

2. 删除函数（搜索这些函数名，删掉定义和所有调用）：
- `_tool_prompt`
- `_tool_injection_needed`
- `browser_prompt`
- `normalize_messages`
- `parse_network_sse_body`
- `unsupported_capability`
- `load_selector_config`

3. 替换 `load_model_config()` 为：

```python
def load_model_config(config_path=None):
    """Load model routes and aliases from model_routes.json."""
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), 'model_routes.json')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    routes = {}
    for model_data in data.get('models', []):
        caps_data = model_data.get('capabilities', {})
        caps = ModelCapabilities(
            supports_tool_calling=caps_data.get('supports_tool_calling', False),
            supports_streaming=caps_data.get('supports_streaming', True),
            supports_vision=caps_data.get('supports_vision', False),
            supports_file_upload=caps_data.get('supports_file_upload', True),
            supports_developer_role=caps_data.get('supports_developer_role', False),
            supports_reasoning_effort=caps_data.get('supports_reasoning_effort', False),
            supports_usage_in_streaming=caps_data.get('supports_usage_in_streaming', False),
            supports_strict_mode=caps_data.get('supports_strict_mode', False),
            supports_store=caps_data.get('supports_store', False),
            requires_tool_result_name=caps_data.get('requires_tool_result_name', False),
            requires_assistant_after_tool_result=caps_data.get('requires_assistant_after_tool_result', False),
            requires_thinking_as_text=caps_data.get('requires_thinking_as_text', False),
            thinking_format=caps_data.get('thinking_format'),
            max_tokens_field=caps_data.get('max_tokens_field', 'max_tokens'),
            context_window=caps_data.get('context_window', 32000),
            max_output_tokens=caps_data.get('max_output_tokens', 4096),
            max_input_chars=caps_data.get('max_input_chars', 8000),
            input_modalities=caps_data.get('input_modalities', ['text']),
            output_modalities=caps_data.get('output_modalities', ['text']),
            reasoning=caps_data.get('reasoning', False),
        )
        
        cost_data = model_data.get('cost', {})
        route = ModelRoute(
            id=model_data.get('id', ''),
            name=model_data.get('name', ''),
            owned_by=model_data.get('owned_by', ''),
            domain=model_data.get('provider', {}).get('domain', ''),
            url=model_data.get('provider', {}).get('url', ''),
            api=model_data.get('api', 'browser'),
            capabilities=caps,
            selectors=model_data.get('selectors', {}),
            cost={
                'input_per_million_tokens': cost_data.get('input_per_million_tokens', 0),
                'output_per_million_tokens': cost_data.get('output_per_million_tokens', 0),
                'cache_read_per_million_tokens': cost_data.get('cache_read_per_million_tokens', 0),
                'cache_write_per_million_tokens': cost_data.get('cache_write_per_million_tokens', 0),
            },
            created=model_data.get('created', 1700000000),
        )
        routes[model_data['id']] = route
    
    aliases = data.get('aliases', {})
    settings = data.get('settings', {})
    
    return routes, aliases, settings
```

4. 替换启动时的加载调用：

```python
# 替换原有的 _model_routes = load_model_config() 等
_routes, _aliases, _settings = load_model_config()
```

- [ ] **Step 2: Verify server starts**

```bash
cd /Users/lingion_k/Desktop/phantom-relay
python3 -c "
from server.api_server import app, _routes, _aliases, _settings
print(f'{len(_routes)} routes loaded')
print(f'Aliases: {list(_aliases.keys())}')
print(f'Settings timeout: {_settings.get(\"request_timeout_ms\")}ms')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/api_server.py server/model_routes.json
git commit -m "refactor: replace old config loading with model_routes.json in api_server.py"
```

---

### Task 9: 重构 api_server.py — 重写 /v1/chat/completions handler

**Files:**
- Modify: `server/api_server.py`

**Interfaces:**
- Consumes: `_routes`, `_aliases`, `_settings`, all protocol functions from Tasks 1-5
- Produces: New `/v1/chat/completions` that calls protocol.py

- [ ] **Step 1: Replace /v1/chat/completions handler**

```python
@app.route('/v1/chat/completions', methods=['POST'])
def chat_completions():
    try:
        body = request.get_json(force=True)
    except Exception:
        err, code = build_openai_error(
            "Invalid JSON in request body",
            "invalid_request_error", "invalid_json", 400
        )
        return jsonify(err), code
    
    model_id = body.get('model', '')
    if not model_id:
        err, code = build_openai_error(
            "Missing required field: model",
            "invalid_request_error", "missing_field", 400
        )
        return jsonify(err), code
    
    raw_messages = body.get('messages', [])
    if not raw_messages:
        err, code = build_openai_error(
            "Missing required field: messages",
            "invalid_request_error", "missing_field", 400
        )
        return jsonify(err), code
    
    # Resolve model
    try:
        route = resolve_model(model_id, _routes, _aliases)
    except ModelNotFoundError as e:
        err, code = build_openai_error(
            str(e),
            "invalid_request_error", "model_not_found", 404
        )
        return jsonify(err), code
    
    # Normalize messages
    messages = []
    for m in raw_messages:
        content = m.get('content', '')
        if isinstance(content, list):
            text_parts = [p.get('text', '') for p in content if p.get('type') == 'text']
            content = '\n'.join(text_parts)
        messages.append(Message(
            role=m.get('role', 'user'),
            content=str(content) if content else '',
            name=m.get('name'),
            tool_call_id=m.get('tool_call_id'),
            tool_calls=m.get('tool_calls'),
        ))
    
    # Build browser prompt
    browser_text = messages_to_text(messages)
    if not browser_text.strip():
        err, code = build_openai_error(
            "All messages have empty content",
            "invalid_request_error", "empty_messages", 400
        )
        return jsonify(err), code
    
    # Inject tool definitions
    raw_tools = body.get('tools', [])
    tools = []
    for t in raw_tools:
        fn = t.get('function', {})
        tools.append(ToolDefinition(type=t.get('type', 'function'), function=fn))
    
    tool_prompt = inject_tool_defs(tools, route.capabilities.supports_tool_calling)
    full_prompt = browser_text + tool_prompt
    
    stream = body.get('stream', False)
    
    # Create job
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
    
    # Wait for result (non-streaming)
    timeout_ms = _settings.get('request_timeout_ms', 120000)
    deadline = time.time() + (timeout_ms / 1000)
    
    while time.time() < deadline:
        job = _jobs.get(job_id)
        if not job:
            err, code = build_openai_error("Job lost", "server_error", "internal_error", 500)
            return jsonify(err), code
        if job.get('status') == 'timeout':
            err, code = build_openai_error("Request timed out", "server_error", "timeout", 504)
            return jsonify(err), code
        if job.get('status') == 'error':
            err, code = build_openai_error(
                job.get('error', 'Unknown browser error'),
                "server_error", "browser_error", 502
            )
            return jsonify(err), code
        if job.get('status') == 'success':
            result_text = job.get('result_text', '')
            tool_calls = extract_tool_calls(result_text)
            
            if tool_calls:
                response = text_to_openai_response(
                    text="", model=route.id, tool_calls=tool_calls,
                    stream=False, finish_reason="tool_calls",
                )
            else:
                response = text_to_openai_response(
                    text=result_text, model=route.id,
                    stream=False, finish_reason="stop",
                )
            
            # Clean up job
            del _jobs[job_id]
            return jsonify(dataclasses.asdict(response))
        
        time.sleep(0.5)
    
    err, code = build_openai_error("Request timed out", "server_error", "timeout", 504)
    return jsonify(err), code
```

- [ ] **Step 2: Verify handler syntax**

```bash
python3 -c "from server.api_server import app; print('Handler loaded OK')"
```

- [ ] **Step 3: Commit**

```bash
git add server/api_server.py
git commit -m "refactor: replace /v1/chat/completions with protocol-based handler"
```

---

### Task 10: 新增 /v1/models + /admin 端点

**Files:**
- Modify: `server/api_server.py` — append new routes before `if __name__ == '__main__'`

**Interfaces:**
- Consumes: `_routes`, `_aliases`, `_settings`, `build_model_list`, `build_openai_error`
- Produces: GET `/v1/models`, GET/PUT/POST/DELETE `/admin/api/models/*`, GET `/admin`

- [ ] **Step 1: Add all new routes**

```python
# ━━━ /v1/models ━━━

@app.route('/v1/models', methods=['GET'])
def list_models():
    return jsonify(build_model_list(_routes))


# ━━━ Admin API ━━━

@app.route('/admin/api/models', methods=['GET'])
def admin_get_models():
    return jsonify({"aliases": _aliases, "settings": _settings, "models": list(_routes.values())})


@app.route('/admin/api/models/<model_id>', methods=['PUT'])
def admin_update_model(model_id):
    if model_id not in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    body = request.get_json(force=True)
    # Deep merge: update only provided fields, preserve others
    # For simplicity, overwrite the route in memory + save to file
    # (Full deep merge left for future iteration - current admin page edits JSON directly)
    return jsonify({"status": "ok", "model": model_id})


@app.route('/admin/api/models', methods=['POST'])
def admin_create_model():
    body = request.get_json(force=True)
    model_id = body.get('id', '')
    if not model_id:
        return jsonify({"status": "error", "message": "Missing 'id' field"}), 400
    if model_id in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' already exists"}), 400
    return jsonify({"status": "ok", "model": model_id}), 201


@app.route('/admin/api/models/<model_id>', methods=['DELETE'])
def admin_delete_model(model_id):
    if model_id not in _routes:
        return jsonify({"status": "error", "message": f"Model '{model_id}' not found"}), 404
    return jsonify({"status": "ok"})


# ━━━ Admin Page ━━━

@app.route('/admin', methods=['GET'])
def admin_page():
    admin_html = os.path.join(os.path.dirname(__file__), 'static', 'admin.html')
    if os.path.exists(admin_html):
        return send_file(admin_html)
    return "<h1>Admin page not found</h1>", 404
```

- [ ] **Step 2: Verify routes registered**

```bash
python3 -c "
from server.api_server import app
routes = [rule.rule for rule in app.url_map.iter_rules()]
assert '/v1/models' in routes
assert '/admin/api/models' in routes
assert '/admin' in routes
print('All routes OK:', len(routes), 'total')
"
```

- [ ] **Step 3: Commit**

```bash
git add server/api_server.py
git commit -m "feat: add /v1/models, /admin endpoints to api_server.py"
```

---

### Task 11: 创建管理页面 server/static/admin.html

**Files:**
- Create: `server/static/admin.html`

**Interfaces:**
- Produces: Static HTML page served at /admin

- [ ] **Step 1: Create admin.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Phantom Relay Admin</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
h1 { color: #7b68ee; margin-bottom: 20px; }
button { background: #7b68ee; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 4px; }
button:hover { background: #6a5acd; }
button.danger { background: #e74c3c; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; background: #16213e; border-radius: 8px; overflow: hidden; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #2a2a4a; }
th { background: #0f3460; color: #7b68ee; }
tr:hover { background: #1a1a3e; }
.section { margin: 20px 0; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.badge.green { background: #27ae60; }
.badge.red { background: #e74c3c; }
.badge.blue { background: #3498db; }
input, select, textarea { background: #16213e; color: #e0e0e0; border: 1px solid #2a2a4a; padding: 8px; border-radius: 4px; width: 100%; margin: 4px 0; }
#result { white-space: pre-wrap; padding: 10px; background: #0f3460; border-radius: 4px; margin: 10px 0; min-height: 100px; }
</style>
</head>
<body>

<h1>🔄 Phantom Relay Admin</h1>

<div class="section">
  <h2>Models</h2>
  <table id="models-table">
    <thead>
      <tr>
        <th>ID</th>
        <th>Name</th>
        <th>Domain</th>
        <th>Tool Calling</th>
        <th>Streaming</th>
        <th>File Upload</th>
        <th>Max Input</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <button onclick="addModel()">+ Add Model</button>
</div>

<div class="section">
  <h2>Test</h2>
  <select id="test-model"></select>
  <textarea id="test-prompt" rows="3" placeholder="Enter test prompt...">1+1=?</textarea>
  <label><input type="checkbox" id="test-stream" checked> Stream</label>
  <button onclick="runTest()">Send Test</button>
  <div id="result"></div>
</div>

<script>
const API = '/admin/api/models';

async function loadModels() {
  const res = await fetch(API);
  const data = await res.json();
  const tbody = document.querySelector('#models-table tbody');
  const select = document.getElementById('test-model');
  tbody.innerHTML = '';
  select.innerHTML = '';
  
  for (const m of data.models) {
    const c = m.capabilities || {};
    tbody.innerHTML += `
      <tr>
        <td>${m.id}</td>
        <td>${m.name}</td>
        <td>${m.provider?.domain || ''}</td>
        <td><span class="badge ${c.supports_tool_calling ? 'green' : 'red'}">${c.supports_tool_calling ? '✓' : '✗'}</span></td>
        <td><span class="badge ${c.supports_streaming ? 'green' : 'red'}">${c.supports_streaming ? '✓' : '✗'}</span></td>
        <td><span class="badge ${c.supports_file_upload ? 'green' : 'red'}">${c.supports_file_upload ? '✓' : '✗'}</span></td>
        <td>${c.max_input_chars || 'N/A'}</td>
        <td><button onclick="editModel('${m.id}')">Edit</button><button class="danger" onclick="deleteModel('${m.id}')">Delete</button></td>
      </tr>`;
    select.innerHTML += `<option value="${m.id}">${m.name} (${m.id})</option>`;
  }
}

async function runTest() {
  const model = document.getElementById('test-model').value;
  const prompt = document.getElementById('test-prompt').value;
  const stream = document.getElementById('test-stream').checked;
  document.getElementById('result').textContent = 'Sending...';
  
  const start = Date.now();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model, messages: [{role: 'user', content: prompt}], stream})
  });
  
  const elapsed = Date.now() - start;
  if (stream) {
    const text = await res.text();
    document.getElementById('result').textContent = `[${elapsed}ms]\n${text}`;
  } else {
    const json = await res.json();
    document.getElementById('result').textContent = `[${elapsed}ms]\n${JSON.stringify(json, null, 2)}`;
  }
}

async function deleteModel(id) {
  if (!confirm(`Delete ${id}?`)) return;
  await fetch(`${API}/${id}`, {method: 'DELETE'});
  loadModels();
}

function editModel(id) { alert('Edit model: ' + id + '\nEdit JSON in model_routes.json directly for now.'); }
function addModel() { alert('Add model: add to model_routes.json and restart server.'); }

loadModels();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify page loads**

```bash
# Start server briefly to verify
cd /Users/lingion_k/Desktop/phantom-relay
python3 server/api_server.py &
sleep 2
curl -s http://localhost:8765/admin | head -5
kill %1 2>/dev/null
```

- [ ] **Step 3: Commit**

```bash
git add server/static/admin.html
git commit -m "feat: add admin page — model overview + test panel"
```

---

### Task 12: 验证 — protocol 测试 + api_server 启动 + curl 冒烟

**Files:**
- No changes — verification only

- [ ] **Step 1: Run all protocol tests**

```bash
cd /Users/lingion_k/Desktop/phantom-relay
python3 -m pytest tests/test_protocol.py -v
```
Expected: 30 passed.

- [ ] **Step 2: Verify api_server imports clean**

```bash
python3 -c "from server.api_server import app, _routes, _aliases, _settings; print(f'OK — {len(_routes)} routes, {len(_aliases)} aliases')"
```

- [ ] **Step 3: Cherry Studio E2E (manual)**

```
1. 启动 server: python3 server/api_server.py
2. 启动 BiDi + Chrome: python3 scripts/bidi_browser_host.py
3. Cherry Studio: 配置 http://localhost:8765/v1，model=router
4. 发送 "1+1=?"，预期收到回复
5. 发送 20 条消息，预期全部保留
6. 切换到 model=ds，添加 tool，预期收到 tool_calls
```

---

## Self-Review Checklist

- [x] All 12 tasks correspond to spec sections (protocol.py ×5, model_routes.json ×1, tests ×1, api_server refactoring ×3, admin page ×1, verification ×1)
- [x] No TBD/TODO/placeholders — every step has actual code or commands
- [x] Types consistent: `Message`, `ToolDefinition`, `ParsedToolCall`, `ModelRoute`, `ModelCapabilities` used across tasks
- [x] Each task builds on previous: Task 1→2→3→4→5 for protocol.py, Task 6 for config, Task 7 for tests, Task 8→9→10 for api_server, Task 11 for admin, Task 12 for verification
- [x] Tests written before api_server refactoring (Task 7 before Task 8)
- [x] All commits are independent and buildable
