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
