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
{{"tool":"plus_one","parameters":{{"number":"5"}}}}
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
    rendered: list[tuple[str, str]] = []
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
            rendered.append((role, " ".join(tc_parts)))
        elif role == "tool":
            tool_name = msg.name or "unknown"
            rendered.append((role, f"Tool {tool_name} returned: {content}"))
        else:
            if content.strip():
                rendered.append((role, f"{label}: {content}"))

    if not rendered:
        return ""

    if len(rendered) == 1:
        return rendered[0][1]

    # Browser-chat targets behave more reliably with a plain linear transcript
    # than with meta wrappers like “current question / historical dialogue”.
    # Meta wrappers can cause browser-chat targets to mirror the large user
    # block instead of answering the final turn. Preserve role order directly.
    return "\n\n".join(text for _, text in rendered)


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
    return f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"


def build_sse_done() -> str:
    return "data: [DONE]\n\n"


def build_sse_error(message: str, error_type: str = "server_error") -> str:
    error_obj = {"error": {"message": message, "type": error_type}}
    return f"data: {json.dumps(error_obj, separators=(',', ':'))}\n\n"


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
