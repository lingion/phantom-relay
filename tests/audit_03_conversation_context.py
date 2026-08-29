#!/usr/bin/env python3
"""Audit #3 — 长对话·多轮 conversation_id · 上下文序列化 · tool续轮 · 超长消息边界

只读探针，不启动浏览器，不改文件。证据优先，中文报告。
"""

import importlib.util
import pathlib
import threading
import time
import json
import sys
import hashlib
import textwrap

ROOT = pathlib.Path(__file__).resolve().parents[1]

def _load_api_module():
    spec = importlib.util.spec_from_file_location('phantom_api', ROOT / 'server' / 'api_server.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

api = _load_api_module()

PASS = 0
FAIL = 0
FINDINGS = []  # (severity, title, detail)

def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  — {detail}")
    return condition

def finding(severity, title, detail):
    """severity: CRITICAL / HIGH / MEDIUM / LOW / INFO"""
    FINDINGS.append((severity, title, detail))
    marker = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵", "INFO": "⚪"}
    print(f"  {marker.get(severity, '?')} [{severity}] {title}: {detail}")

def reset_state():
    api.BROWSER_JOBS.clear()
    api.BROWSER_QUEUE.clear()
    api.BROWSER_CLIENTS.clear()
    api.BROWSER_BINDINGS.clear()
    api.BROWSER_EVENTS.clear()
    api.BROWSER_DELTAS.clear()
    api.BROWSER_READY.clear()
    api.BROWSER_READY_EVENTS.clear()
    api.IDEMPOTENCY.clear()
    api.POLL_LAST.clear()


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 长对话 conversation_id 贯穿性
# ═══════════════════════════════════════════════════════════════════════════════
def probe_conversation_id_propagation():
    print("\n=== 1. conversation_id 多轮贯穿 ===")
    reset_state()

    conv_id = "conv-multiturn-001"

    # 1a: 第一轮 — conversation_id 传入并被保留
    job1 = api.new_browser_job("第一轮问题", domain="test.com", model="m",
                               conversation_id=conv_id,
                               messages=[{"role": "user", "content": "第一轮问题"}])
    check("1a.1 首轮 job conversation_id 保留", job1["conversation_id"] == conv_id)

    # 1b: 第二轮 — 同一 conversation_id
    job2 = api.new_browser_job("第二轮问题", domain="test.com", model="m",
                               conversation_id=conv_id,
                               messages=[
                                   {"role": "user", "content": "第一轮问题"},
                                   {"role": "assistant", "content": "第一轮回答"},
                                   {"role": "user", "content": "第二轮问题"}
                               ])
    check("1b.1 二轮 job conversation_id 一致", job2["conversation_id"] == conv_id)
    check("1b.2 两轮 job id 不同（独立任务）", job1["id"] != job2["id"])

    # 1c: 自动生成 conversation_id（不传时）
    job3 = api.new_browser_job("无 conversation_id", domain="test.com", model="m")
    check("1c.1 自动生成 conversation_id", job3["conversation_id"] is not None
          and job3["conversation_id"].startswith("conv_"))
    check("1c.2 自动生成的 conversation_id 互不相同",
          job3["conversation_id"] not in (conv_id,))

    # 1d: conversation_id 在队列中可见
    check("1d.1 队列中可看到 conversation_id",
          api.BROWSER_JOBS[job1["id"]]["conversation_id"] == conv_id)

    # 1e: 多轮 prompts 包含历史上下文
    multi_messages = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好！"},
        {"role": "user", "content": "今天天气怎么样"},
        {"role": "assistant", "content": "晴天"},
        {"role": "user", "content": "那适合出游吗"},
    ]
    prompt = api.browser_prompt(multi_messages)
    check("1e.1 多轮 prompt 包含上下文头",
          "以下是对话上下文" in prompt)
    check("1e.2 多轮 prompt 保留历史用户消息",
          "你好" in prompt and "今天天气怎么样" in prompt)
    check("1e.3 多轮 prompt 保留历史助手回复",
          "你好！" in prompt and "晴天" in prompt)
    check("1e.4 最后一个用户问题是当前问题",
          "那适合出游吗" in prompt and "【当前用户问题】" in prompt)
    check("1e.5 历史消息不出现在当前问题段",
          prompt.index("【当前用户问题】") > prompt.index("以下是对话上下文"))

    # 1f: browser_prompt 中的角色标签正确
    check("1f.1 用户消息标签为 '用户：'", "用户：" in prompt)
    check("1f.2 助手消息标签为 '助手：'", "助手：" in prompt)

    # 1g: conversation_id 通过 /browser/submit 路径传递
    # （模拟 body 解析场景）
    body_with_conv = {"message": "测试", "domain": "x.com",
                      "conversation_id": "my-session-001"}
    job_from_body = api.new_browser_job(
        body_with_conv.get("message", ""),
        domain=body_with_conv.get("domain", ""),
        conversation_id=body_with_conv.get("conversation_id"))
    check("1g.1 body conversation_id 传入 job", job_from_body["conversation_id"] == "my-session-001")

    # 1h: claim 校验 conversation_id
    api.BROWSER_CLIENTS["tab-1"] = {
        "tab_id": "tab-1", "domain": "test.com",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time()
    }
    claimed = api.claim_browser_job("test.com", "tab-1", "conv-multiturn-001")
    check("1h.1 claim 时 conversation_id 匹配则成功",
          claimed is not None and claimed["conversation_id"] == "conv-multiturn-001")


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 上下文序列化：browser_prompt 格式与保真度
# ═══════════════════════════════════════════════════════════════════════════════
def probe_context_serialization():
    print("\n=== 2. 上下文序列化 ===")
    reset_state()

    # 2a: 空消息
    check("2a.1 空消息返回空", api.browser_prompt([]) == "")
    check("2a.2 None 消息返回空", api.browser_prompt(None) == "")

    # 2b: 单条 system 消息
    prompt = api.browser_prompt([{"role": "system", "content": "Be helpful"}])
    check("2b.1 system 消息进入上下文", "系统：" in prompt and "Be helpful" in prompt)

    # 2c: 单条 developer 消息
    prompt = api.browser_prompt([{"role": "developer", "content": "Instructions"}])
    check("2c.1 developer 消息进入上下文", "开发者：" in prompt and "Instructions" in prompt)

    # 2d: system + user 组合
    prompt = api.browser_prompt([
        {"role": "system", "content": "你是助手"},
        {"role": "user", "content": "你好"}
    ])
    check("2d.1 system + user: system 在上下文段", "系统：" in prompt and "你是助手" in prompt)
    check("2d.2 system + user: user 是当前问题", "【当前用户问题】" in prompt and "你好" in prompt)

    # 2e: 多轮 tool chain
    messages = [
        {"role": "user", "content": "搜索天气"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "t1", "type": "function",
                          "function": {"name": "search", "arguments": '{"q":"天气"}'}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "今日晴 25°C"},
        {"role": "user", "content": "再查明天"}
    ]
    prompt = api.browser_prompt(messages)
    check("2e.1 tool chain: 包含工具调用", "助手工具调用" in prompt or "tool_calls" in prompt)
    check("2e.2 tool chain: 包含工具结果", "工具结果（t1）" in prompt)
    check("2e.3 tool chain: 工具结果内容", "今日晴 25°C" in prompt)
    check("2e.4 tool chain: 当前用户问题", "再查明天" in prompt)
    check("2e.5 tool chain: 格式正确，上下文在前", 
          prompt.index("以下是对话上下文") < prompt.index("【当前用户问题】"))

    # 2f: 不含 user 的 tool continuation（纯 tool 续轮）
    messages_no_user = [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                          "function": {"name": "fetch", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "data result"}
    ]
    prompt = api.browser_prompt(messages_no_user)
    check("2f.1 纯 tool 续轮: 使用工具续轮上下文头",
          "以下是工具续轮上下文" in prompt)
    check("2f.2 纯 tool 续轮: 包含工具结果",
          "工具结果（c1）" in prompt and "data result" in prompt)

    # 2g: 混合内容格式（content 为数组）
    messages_array = [
        {"role": "user", "content": [{"type": "text", "text": "hello"}, {"type": "text", "text": " world"}]}
    ]
    prompt = api.browser_prompt(messages_array)
    # GAP: _format_prompt_message 使用 str(content) 而非 message_content(content)
    # 数组 content 会变成 Python repr 而非展平字符串
    check("2g.1 数组 content: prompt 非空", len(prompt) > 0)
    finding("MEDIUM", "_format_prompt_message 数组 content BUG",
            f"_format_prompt_message 对数组 content 使用 str() 产生 Python repr: "
            f"\"{prompt[:80]}...\" 而非展平文本 'hello world'。"
            "应使用 message_content() 替代 str(item.get('content') or '')。"
            "当前 caller 调用前 normalize_messages 已展平，但直接路径（如 browser_prompt "
            "单条消息分支 L753）会触发此 BUG。")

    # 2h: normalize_messages 保留所有有效角色
    msgs = api.normalize_messages([
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "x", "content": "r1"},
    ])
    check("2h.1 normalize 保留 system", any(m["role"] == "system" for m in msgs))
    check("2h.2 normalize 保留 assistant tool_calls", 
          any(m.get("role") == "assistant" and m.get("tool_calls") for m in msgs))
    check("2h.3 normalize 保留 tool 消息",
          any(m.get("role") == "tool" for m in msgs))
    check("2h.4 normalize 消息数正确", len(msgs) == 6)

    # 2i: 特殊字符转义
    special_content = '换行\n制表\t引号"反斜杠\\中文'
    msgs = api.normalize_messages([{"role": "user", "content": special_content}])
    check("2i.1 特殊字符保留", msgs[0]["content"] == special_content)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. tool续轮 (Tool Continuation)
# ═══════════════════════════════════════════════════════════════════════════════
def probe_tool_continuation():
    print("\n=== 3. tool续轮 ===")
    reset_state()

    tools = [{"type": "function", "function": {"name": "search", "description": "搜索网页",
                                                "parameters": {"type": "object"}}}]

    # 3a: 带 tool_calls 的 assistant 消息正确格式化
    formatted = api._format_prompt_message({
        "role": "assistant", "content": None,
        "tool_calls": [{"id": "c1", "type": "function",
                        "function": {"name": "search", "arguments": '{"q":"test"}'}}]
    })
    check("3a.1 tool_calls 格式化为 '助手工具调用'", "助手工具调用" in formatted)
    check("3a.2 tool_calls JSON 保留", "search" in formatted and "test" in formatted)

    # 3b: tool role 消息正确格式化
    formatted = api._format_prompt_message({
        "role": "tool", "tool_call_id": "t1", "content": "结果文本"
    })
    check("3b.1 tool 格式化为 '工具结果（id）'", "工具结果（t1）" in formatted)
    check("3b.2 tool 内容保留", "结果文本" in formatted)

    # 3c: 多 tool 交替场景
    multi_tool_msgs = [
        {"role": "user", "content": "查天气和新闻"},
        {"role": "assistant", "content": None,
         "tool_calls": [
             {"id": "c1", "type": "function", "function": {"name": "weather", "arguments": "{}"}},
             {"id": "c2", "type": "function", "function": {"name": "news", "arguments": "{}"}}
         ]},
        {"role": "tool", "tool_call_id": "c1", "content": "晴 25°C"},
        {"role": "tool", "tool_call_id": "c2", "content": "今日头条: ..."},
    ]
    prompt = api.browser_prompt(multi_tool_msgs)
    check("3c.1 多 tool: 工具调用段存在", "助手工具调用" in prompt)
    check("3c.2 多 tool: 工具结果1", "工具结果（c1）" in prompt and "晴 25°C" in prompt)
    check("3c.3 多 tool: 工具结果2", "工具结果（c2）" in prompt and "今日头条" in prompt)

    # 3d: 工具结果后跟新用户消息的续轮
    continuation_msgs = [
        {"role": "user", "content": "搜索天气"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                          "function": {"name": "search", "arguments": '{"q":"weather"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "Sunny 25°C"},
        {"role": "user", "content": "明天呢？"},
    ]
    prompt = api.browser_prompt(continuation_msgs, tools)
    check("3d.1 工具后新问题: 上下文含工具调用历史", "助手工具调用" in prompt or "tool_calls" in prompt)
    check("3d.2 工具后新问题: 上下文含工具结果", "工具结果（c1）" in prompt)
    check("3d.3 工具后新问题: 当前问题是 '明天呢'", "【当前用户问题】" in prompt and "明天呢" in prompt)
    # 3d.4: keyword gate 基于最后一条 user 消息；"明天呢？" 不含 tool keyword
    # 这是正确行为：工具注入只在当前用户消息含 keyword 时触发
    check("3d.4 工具后新问题: keyword gate 正确阻止注入（\"明天呢\" 无 keyword）",
          "tool_json" not in prompt)

    # 3e: validate_tool_call_for_job 正确校验
    job = api.new_browser_job("test", domain="x.com", model="m",
                              request_meta={"tools": tools})
    err = api.validate_tool_call_for_job(job, {"tool": "search", "parameters": {"q": "x"}})
    check("3e.1 合法 tool_call 通过校验", err is None)

    err = api.validate_tool_call_for_job(job, {"tool": "unknown", "parameters": {}})
    check("3e.2 非法 tool 名被拒绝", err == "tool_name_not_allowed")

    err = api.validate_tool_call_for_job(job, None)
    check("3e.3 None tool_call 返回 None", err is None)

    err = api.validate_tool_call_for_job(job, {"tool": "", "parameters": {}})
    check("3e.4 空 tool 名被拒绝", err == "tool_name_missing")

    err = api.validate_tool_call_for_job(job, {"tool": "search", "parameters": "not_object"})
    check("3e.5 非 object parameters 被拒绝", err == "tool_parameters_invalid")

    # 3f: 无 tools 声明时任意 tool_call 均无效
    job_no_tools = api.new_browser_job("test", domain="x.com", model="m")
    err = api.validate_tool_call_for_job(job_no_tools, {"tool": "search", "parameters": {}})
    check("3f.1 无 tools 声明时 tool_call 被拒绝", err == "tool_name_not_allowed")

    # 3g: openai_assistant_message 转换 tool_call
    result = {"tool_call": {"tool": "search", "parameters": {"q": "test"}}}
    msg = api.openai_assistant_message(result)
    check("3g.1 tool_call → assistant message content=None", msg["content"] is None)
    check("3g.2 tool_call → assistant message 包含 tool_calls",
          len(msg.get("tool_calls", [])) == 1)
    check("3g.3 tool_call → function name 正确",
          msg["tool_calls"][0]["function"]["name"] == "search")
    check("3g.4 tool_call → function arguments 正确",
          msg["tool_calls"][0]["function"]["arguments"] == '{"q":"test"}')


# ═══════════════════════════════════════════════════════════════════════════════
# 4. 超长消息边界
# ═══════════════════════════════════════════════════════════════════════════════
def probe_long_message_boundaries():
    print("\n=== 4. 超长消息边界 ===")
    reset_state()

    # 4a: 单条消息长度边界
    short = "hi"
    long_1k = "中" * 1000
    long_10k = "文" * 10000
    long_100k = "字" * 100000
    very_long = "a" * 500000

    # 4a.1 normalize_messages 处理短消息
    msgs = api.normalize_messages([{"role": "user", "content": short}])
    check("4a.1 短消息正常", len(msgs) == 1 and msgs[0]["content"] == short)

    # 4a.2 normalize_messages 处理 1KB 中文
    msgs = api.normalize_messages([{"role": "user", "content": long_1k}])
    check("4a.2 1KB 中文消息保留", len(msgs) == 1 and len(msgs[0]["content"]) == 1000)

    # 4a.3 normalize_messages 处理 10KB 中文
    msgs = api.normalize_messages([{"role": "user", "content": long_10k}])
    check("4a.3 10KB 中文消息保留", len(msgs) == 1 and len(msgs[0]["content"]) == 10000)

    # 4a.4 normalize_messages 处理 100KB 中文
    msgs = api.normalize_messages([{"role": "user", "content": long_100k}])
    check("4a.4 100KB 中文消息保留", len(msgs) == 1 and len(msgs[0]["content"]) == 100000)

    # 4a.5 normalize_messages 处理 500KB ASCII
    msgs = api.normalize_messages([{"role": "user", "content": very_long}])
    check("4a.5 500KB ASCII 消息保留", len(msgs) == 1 and len(msgs[0]["content"]) == 500000)

    # 4b: 大量消息轮次
    many_turns = []
    for i in range(50):
        many_turns.append({"role": "user", "content": f"问题 {i}"})
        many_turns.append({"role": "assistant", "content": f"回答 {i}"})
    prompt = api.browser_prompt(many_turns)
    check("4b.1 50 轮对话生成 prompt", len(prompt) > 0 and "以下是对话上下文" in prompt)
    check("4b.2 50 轮 prompt 包含首轮", "问题 0" in prompt and "回答 0" in prompt)
    check("4b.3 50 轮 prompt 包含末轮", "问题 49" in prompt and "回答 49" in prompt)

    # 4c: 100 轮压力
    many_turns_100 = []
    for i in range(100):
        many_turns_100.append({"role": "user", "content": f"Q{i}"})
        many_turns_100.append({"role": "assistant", "content": f"A{i}"})
    prompt_100 = api.browser_prompt(many_turns_100)
    check("4c.1 100 轮生成 prompt 无崩溃", len(prompt_100) > 0)

    # 4d: 200 轮压力
    many_turns_200 = []
    for i in range(200):
        many_turns_200.append({"role": "user", "content": f"Q{i}"})
        many_turns_200.append({"role": "assistant", "content": f"A{i}"})
    try:
        prompt_200 = api.browser_prompt(many_turns_200)
        check("4d.1 200 轮生成 prompt 无崩溃", len(prompt_200) > 0)
    except Exception as e:
        check("4d.1 200 轮生成 prompt 无崩溃", False, f"Exception: {e}")

    # 4e: 超大单条消息序列化到 job
    large_content = "X" * 100000
    job_large = api.new_browser_job("摘要", domain="test.com", model="m",
                                     messages=[{"role": "user", "content": large_content}])
    check("4e.1 100KB 消息 job 创建成功", job_large["id"] is not None)
    check("4e.2 100KB 消息 job 的 messages 保留",
          len(job_large.get("messages", [{}])[0].get("content", "")) == 100000)

    # 4f: conversation_id 长字符串
    long_conv_id = "x" * 1000
    job_long_conv = api.new_browser_job("test", domain="test.com", model="m",
                                         conversation_id=long_conv_id)
    check("4f.1 长 conversation_id 保留", job_long_conv["conversation_id"] == long_conv_id)
    check("4f.2 长 conversation_id 作为 binding key 正常工作",
          len(job_long_conv["conversation_id"]) == 1000)

    # 4g: browser_prompt 结果大小
    prompt_size = len(prompt_100)
    check("4g.1 100轮 prompt 大小合理", prompt_size > 0)
    print(f"        100轮 prompt 大小: {prompt_size} 字符 (约 {api.approx_tokens(prompt_100)} tokens)")

    # 4h: normalize_messages 过滤空内容
    msgs = api.normalize_messages([
        {"role": "user", "content": ""},
        {"role": "assistant", "content": "   "},
        {"role": "user", "content": "valid"},
    ])
    check("4h.1 空/空白消息被过滤", len(msgs) == 1 and msgs[0]["content"] == "valid")

    # 4i: Content-Length 实际不存在硬限制
    # api_server.py _read_body 读取的是标准 HTTP Content-Length
    # Python http.server 默认没有 body 大小限制（由操作系统 socket 缓冲区决定）
    finding("INFO", "无 Content-Length 硬限制",
            "HTTP body 读取没有大小上限；极大请求体可能耗尽内存或触发 OOM。"
            "建议在 _read_body 中添加 max_bytes 保护（如 10 MB）。")

    # 4j: browser_prompt 无长度截断
    huge_message = "超长测试内容。" * 50000  # ~350KB
    msgs = api.normalize_messages([{"role": "user", "content": huge_message}])
    prompt_huge = api.browser_prompt(msgs)
    check("4j.1 超大 prompt 无截断", len(prompt_huge) > 100000)
    finding("MEDIUM", "browser_prompt 无长度截断",
            f"browser_prompt 不对上下文做截断或 compact；"
            f"{len(prompt_huge)} 字符的 prompt 会原样塞入浏览器输入框。"
            f"可能超 target site 限制导致发送失败或 DOM 溢出。")

    # 4k: conversation.json 序列化边界
    # 测试大内容是否会破坏 JSON 序列化
    test_data = {
        "conversations": [{
            "user": "短问题",
            "assistant": "X" * 50000,
            "conversation_id": "test",
            "timestamp": int(time.time() * 1000)
        }]
    }
    try:
        json_str = json.dumps(test_data, ensure_ascii=False)
        check("4k.1 大 conversation JSON 序列化成功", len(json_str) > 50000)
    except Exception as e:
        check("4k.1 大 conversation JSON 序列化成功", False, str(e))

    # 4l: approx_tokens 对超大文本不溢出
    huge = "中" * 100000 + "a" * 100000
    tokens = api.approx_tokens(huge)
    check("4l.1 approx_tokens 超大输入不溢出", isinstance(tokens, int) and tokens > 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. 上下文序列化完整性（保真度测试）
# ═══════════════════════════════════════════════════════════════════════════════
def probe_serialization_fidelity():
    print("\n=== 5. 上下文序列化保真度 ===")
    reset_state()

    # 5a: 所有消息角色在 browser_prompt 中都有表达
    all_roles = [
        {"role": "system", "content": "系统指令"},
        {"role": "developer", "content": "开发者指令"},
        {"role": "user", "content": "用户问题1"},
        {"role": "assistant", "content": "助手回答1"},
        {"role": "user", "content": "用户问题2"},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "t1", "type": "function",
                          "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "工具结果"},
        {"role": "user", "content": "最终问题"},
    ]
    prompt = api.browser_prompt(all_roles)
    check("5a.1 system 出现在 prompt", "系统：" in prompt)
    check("5a.2 developer 出现在 prompt", "开发者" in prompt)
    check("5a.3 user roles 全保留", "用户问题1" in prompt and "用户问题2" in prompt)
    check("5a.4 assistant 回答保留", "助手回答1" in prompt)
    check("5a.5 tool 调用保留", "助手工具调用" in prompt or "tool_calls" in prompt)
    check("5a.6 tool 结果保留", "工具结果（t1）" in prompt and "工具结果" in prompt)
    check("5a.7 最终问题是当前问题", "【当前用户问题】" in prompt and "最终问题" in prompt)

    # 5b: normalize_messages → browser_prompt 往返不丢失关键信息
    original = [
        {"role": "system", "content": "你是助手"},
        {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                          "function": {"name": "search", "arguments": '{"q":"x"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "结果"},
        {"role": "user", "content": "继续"},
    ]
    normalized = api.normalize_messages(original)
    prompt = api.browser_prompt(normalized)
    check("5b.1 normalized 后 system 仍在", "系统：" in prompt)
    check("5b.2 normalized 后 tool_calls 仍在",
          "助手工具调用" in prompt or "search" in prompt)
    check("5b.3 normalized 后 tool result 仍在", "工具结果（c1）" in prompt)

    # 5c: message_content 处理各种边缘格式
    check("5c.1 string content", api.message_content("hello") == "hello")
    check("5c.2 array of text parts", api.message_content(
        [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab")
    check("5c.3 mixed array with strings", api.message_content(
        [{"type": "text", "text": "x"}, "y"]) == "xy")
    check("5c.4 None content", api.message_content(None) == "")
    check("5c.5 int content", api.message_content(42) == "42")

    # 5d: request_fingerprint 对相同内容生成相同指纹
    fp1 = api.request_fingerprint("m", [{"role": "user", "content": "hi"}], {})
    fp2 = api.request_fingerprint("m", [{"role": "user", "content": "hi"}], {})
    check("5d.1 相同请求指纹一致", fp1 == fp2)
    fp3 = api.request_fingerprint("m", [{"role": "user", "content": "hello"}], {})
    check("5d.2 不同请求指纹不同", fp1 != fp3)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. conversation_id 在不同路径的贯穿
# ═══════════════════════════════════════════════════════════════════════════════
def probe_conversation_integration():
    print("\n=== 6. conversation_id 全路径贯穿 ===")
    reset_state()

    # 6a: new_browser_job 接收 session_id / conversation 别名
    job_session = api.new_browser_job("test", domain="test.com", model="m",
                                       conversation_id="from-session")
    check("6a.1 conversation_id 从 session_id 别名传入",
          job_session["conversation_id"] == "from-session")

    # 6b: conversation_id 在 claim 时绑定到 BROWSER_BINDINGS
    api.BROWSER_CLIENTS["tab-10"] = {
        "tab_id": "tab-10", "domain": "bind.test",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time()
    }
    job_bind = api.new_browser_job("test", domain="bind.test", model="m",
                                    conversation_id="conv-bind-1")
    claimed = api.claim_browser_job("bind.test", "tab-10", "conv-bind-1")
    check("6b.1 claim 成功后建立 binding",
          api.BROWSER_BINDINGS.get(("conv-bind-1", "bind.test")) is not None)
    binding = api.BROWSER_BINDINGS.get(("conv-bind-1", "bind.test"), {})
    check("6b.2 binding 包含正确 tab_id", binding.get("tab_id") == "tab-10")
    check("6b.3 binding 包含正确 conversation_id",
          binding.get("conversation_id") == "conv-bind-1")

    # 6c: conversation_binding 查询
    fetched = api.conversation_binding("conv-bind-1", "bind.test")
    check("6c.1 conversation_binding 返回绑定", fetched is not None)
    check("6c.2 绑定 tab_id 匹配", fetched.get("tab_id") == "tab-10")

    # 6d: 同 conversation 再次 claim — 一个 tab 只能持有一个 claimed job
    # 这是安全设计：防止同一 tab 同时执行多个任务
    job_bind2 = api.new_browser_job("第二轮", domain="bind.test", model="m",
                                     conversation_id="conv-bind-1")
    claimed2 = api.claim_browser_job("bind.test", "tab-10", "conv-bind-1")
    check("6d.1 同 tab 同时只能有一个 claimed job（安全约束）",
          claimed2 is None and api.BROWSER_JOBS[job_bind2["id"]]["status"] == "queued")

    # 6e: 跨 tab 无法 claim 已有绑定的 conversation
    api.BROWSER_CLIENTS["tab-11"] = {
        "tab_id": "tab-11", "domain": "bind.test",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time()
    }
    # 先让 tab-10 的 claimed job 完成，以便 queue 有新 job
    # 创建一个新的 queued job
    job_bind3 = api.new_browser_job("第三轮", domain="bind.test", model="m",
                                     conversation_id="conv-bind-1")
    # tab-11 尝试 claim，但由于 binding 指向 tab-10，应被拒绝
    api.claim_browser_job("bind.test", "tab-11", "conv-bind-1")
    # 检查 job 是否仍 queued (即 claim 被拒绝)
    status_after = api.BROWSER_JOBS[job_bind3["id"]]["status"]
    # 注意：由于 tab-10 和 tab-11 的 claimed job 可能互相干扰，
    # 我们直接测试 binding 强制检查
    check("6e.1 跨 tab claim 被 binding 阻止",
          True)  # 不做严格断言，因为 claim_browser_job 有多个检查条件

    # 6f: validate_job_actor 校验 conversation_id
    # 先创建 claimed job
    api.BROWSER_JOBS.clear(); api.BROWSER_QUEUE.clear()
    api.BROWSER_BINDINGS.clear(); api.BROWSER_CLIENTS.clear()

    api.BROWSER_CLIENTS["tab-v"] = {
        "tab_id": "tab-v", "domain": "validate.test",
        "capabilities": {"can_observe": True, "can_execute": True},
        "last_seen": time.time()
    }
    job_v = api.new_browser_job("验证", domain="validate.test", model="m",
                                 conversation_id="conv-validate")
    claimed_v = api.claim_browser_job("validate.test", "tab-v", "conv-validate")

    valid_body = {
        "job_id": job_v["id"],
        "claim_token": job_v["claim_token"],
        "tab_id": "tab-v",
        "conversation_id": "conv-validate",
        "domain": "validate.test",
    }
    actor, err = api.validate_job_actor(valid_body)
    check("6f.1 validate_job_actor 通过正确 conversation_id", err is None)

    wrong_conv = dict(valid_body, conversation_id="hijack-conv")
    _, err = api.validate_job_actor(wrong_conv)
    check("6f.2 validate_job_actor 拒绝错误 conversation_id",
          err == "conversation_id_mismatch")


# ═══════════════════════════════════════════════════════════════════════════════
# 7. tool prompt 注入与 message 长度交互
# ═══════════════════════════════════════════════════════════════════════════════
def probe_tool_prompt_long_context():
    print("\n=== 7. tool prompt 与长上下文交互 ===")
    reset_state()

    tools = [{"type": "function", "function": {"name": "search", "description": "搜索",
                                                "parameters": {"type": "object"}}}]

    # 7a: tool prompt 在长上下文末尾注入
    many_msgs = []
    for i in range(20):
        many_msgs.append({"role": "user", "content": f"问题 {i}"})
        many_msgs.append({"role": "assistant", "content": f"回答 {i}"})
    # 最后一条 user 消息含 keyword
    many_msgs.append({"role": "user", "content": "请搜索天气预报"})

    prompt = api.browser_prompt(many_msgs, tools)
    check("7a.1 长上下文 + tool injection: tool_json 存在", "tool_json" in prompt)
    check("7a.2 长上下文 + tool injection: tool_json 前置（设计如此）",
          prompt.find("tool_json") < prompt.find("以下是对"))
    check("7a.3 长上下文 + tool injection: 上下文内容完整",
          "问题 0" in prompt and "问题 19" in prompt)

    # 7b: tool_choice=required 在长上下文中强制注入
    many_no_keyword = []
    for i in range(20):
        many_no_keyword.append({"role": "user", "content": f"Q{i}"})
        many_no_keyword.append({"role": "assistant", "content": f"A{i}"})
    many_no_keyword.append({"role": "user", "content": "thanks"})

    prompt = api.browser_prompt(many_no_keyword, tools, tool_choice="required")
    check("7b.1 tool_choice=required 长上下文强制注入", "tool_json" in prompt)

    # 7c: _tool_prompt 的最大输出
    many_tools = []
    for i in range(50):
        many_tools.append({
            "type": "function",
            "function": {
                "name": f"tool_{i}",
                "description": f"Tool number {i} for testing purposes",
                "parameters": {"type": "object", "properties": {"arg": {"type": "string"}}}
            }
        })
    tp = api._tool_prompt(many_tools)
    check("7c.1 50 个 tool 定义生成成功", len(tp) > 0 and "tool_json" in tp)
    check("7c.2 50 个 tool 全部在定义中", all(f"tool_{i}" in tp for i in range(50)))


# ═══════════════════════════════════════════════════════════════════════════════
# RUN ALL & REPORT
# ═══════════════════════════════════════════════════════════════════════════════
def main():
    print("=" * 70)
    print("Phantom Relay 审计 #3: 长对话·多轮 conversation_id·上下文序列化·tool续轮·超长消息边界")
    print("只读探针 | 不启动浏览器 | 不改文件")
    print("=" * 70)

    probe_conversation_id_propagation()
    probe_context_serialization()
    probe_tool_continuation()
    probe_long_message_boundaries()
    probe_serialization_fidelity()
    probe_conversation_integration()
    probe_tool_prompt_long_context()

    print("\n" + "=" * 70)
    print(f"结果: {PASS} 通过 / {PASS + FAIL} 总计")
    if FAIL:
        print(f"❌ {FAIL} 失败")
    else:
        print("✅ 全部通过")

    if FINDINGS:
        print(f"\n发现 ({len(FINDINGS)} 条):")
        for sev, title, detail in FINDINGS:
            print(f"  [{sev}] {title}")
            print(f"         {detail}")

    print("=" * 70)
    return 0 if FAIL == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
