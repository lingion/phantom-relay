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
