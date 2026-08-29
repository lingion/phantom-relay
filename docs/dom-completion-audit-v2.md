# DOM → OpenAI 回复：事件/增量/完成判定 深度审计报告 v2

审计日期：2026-07-21
审计范围：Phantom Relay 当前实现 + zero-token/openclaw + ds2api 的完成判定设计

---

## 一、上游项目中 DOM 完成判定的三种核心模式

### 模式 A：zero-token/openclaw — Stop-Button 检测 + 稳定计数（最可靠）

**关键文件**：
- `src/zero-token/providers/chatgpt-web-client-browser.ts` L234-255 (DOM fallback)
- `src/zero-token/providers/gemini-web-client-browser.ts` L294-299

**伪代码提炼**：

```javascript
// ===== 零令牌的完成判定核心 =====
// 文件: gemini-web-client-browser.ts L294-299 + L161-255
// 这是所有 DOM-only provider 的统一模式

async function pollForCompletion(page, maxWaitMs, pollIntervalMs) {
  let lastText = "";
  let stableCount = 0;
  const signal = params.signal;

  for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
    await sleep(pollIntervalMs);  // 2000ms，注意是 2 秒不是 150ms

    const result = await page.evaluate(() => {
      const clean = (t) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

      // 核心1: 用 Stop 按钮的存在性判断是否仍在流式输出
      const stopBtn = document.querySelector(
        '[aria-label*="Stop"], [aria-label*="stop"],' +
        'button.bg-black .icon-lg, ' +   // ChatGPT 特有
        '[aria-label*="停止"]'
      );
      const isStreaming = !!stopBtn;
      // ↑ 这是最关键的判断：stop 按钮存在 = 模型还在生成

      // 核心2: 多个选择器级联查找最新回复
      const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-message-author="model"]',
        '[class*="model-response"]',
        '[class*="markdown"]',
      ];
      let text = "";
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        const last = els[els.length - 1];  // 取最后一条
        if (last) { text = clean(last.textContent); break; }
      }

      return { text, isStreaming };
    });

    // 核心3: 文本不再变化 + 流式已停止 → 完成
    if (result.text && result.text !== lastText) {
      lastText = result.text;
      stableCount = 0;            // 文本有变化，重置稳定计数
    } else if (result.text) {
      stableCount++;
      if (!result.isStreaming && stableCount >= 2) {
        break;  // 文本连续 2 轮不变 + stop 按钮消失 = 完成
      }
    }
  }
  return lastText;
}
```

**关键设计决策**：
- 轮询间隔 **2000ms**（不是 150ms），为降低风控指纹
- 完成判定需要**两个条件同时满足**：`!isStreaming && stableCount >= 2`
- Stop 按钮检测比 `data-streaming` 属性更可靠（所有主流 AI 站点都有 stop 按钮）

---

### 模式 B：ds2api — SSE 事件驱动的完成判定

**关键文件**：
- `internal/assistantturn/stream.go` L10-16（事件类型定义）
- `internal/assistantturn/turn.go`（turn 统一模型）

**事件类型**：
```go
StreamEventTextDelta     = "text_delta"    // 增量文本
StreamEventThinkingDelta = "thinking_delta" // 增量思考
StreamEventToolCall      = "tool_call"     // 工具调用
StreamEventDone          = "done"          // ← 完成信号
StreamEventError         = "error"
StreamEventPing          = "ping"          // 心跳保活
```

**完成判定的两个来源**：
1. 上游 SSE 的 `[DONE]` 标记 → 映射为 `StreamEventDone`
2. 上游 SSE 的 `finish_reason: "stop"` → 映射为 `StreamEventDone`

**Accumulator 设计** (`shared.StreamAccumulator`):
```go
// 累积器分离了五种文本流
type StreamAccumulator struct {
    RawText              strings.Builder    // 原始文本（含引用标记）
    Text                 strings.Builder    // 清洗后文本
    RawThinking          strings.Builder    // 原始思考
    Thinking             strings.Builder    // 清洗后思考
    ToolDetectionThinking strings.Builder   // 工具检测用思考
}
```

**对 Phantom Relay 的关键启示**：
- `thinking` 和 `text` 分开累积，思考内容不污染最终答案
- `done` 事件是权威的完成信号，不需要客户端猜测
- `ping` 心跳维持 SSE 连接，防止代理/负载均衡器断开

---

### 模式 C：zero-token 的流适配器 — 标签驱动的增量解析

**关键文件**：
- `src/zero-token/streams/deepseek-web-stream.ts` L73-80
- `src/zero-token/streams/doubao-web-stream.ts` L110-150

**增量解析伪代码**：
```javascript
// deepseek-web-stream.ts: 从 SSE 行中检测 XML 标签切换模式
let currentMode = "text";  // text | thinking | tool_call

function processLine(dataStr, data) {
  // 检测思考/回复边界标签
  if (/<thinking>/.test(raw))  currentMode = "thinking";
  if (/<\/thinking>/.test(raw)) currentMode = "text";
  if (/<tool_call>/.test(raw)) currentMode = "tool_call";

  // 根据当前模式 emit 不同类型的 delta
  if (currentMode === "text")     emitDelta("text", delta);
  if (currentMode === "thinking") emitDelta("thinking", delta);
  if (currentMode === "tool_call") emitDelta("toolcall", delta);
}
```

**对 Phantom Relay 的关键启示**：
- 不是一次性返回全部 DOM 文本，而是**逐行解析、逐模式分发**
- `text_delta` 是真正的内容增量，不包含 UI 装饰
- 流结束时统一发送 `done` 事件

---

## 二、Phantom Relay 当前实现的完成判定

### 当前路径

**文件**：`extension/content.js` L991-1059 `waitForDirectResponse()`

```javascript
// 当前 Phantom 的完成判定逻辑
async function waitForDirectResponse(userMessage, beforeKeys, timeout, ...) {
  let stable = 0;
  let bestResult = null;

  while (Date.now() - started < timeout) {      // 默认 120 秒
    let candidate = findDirectCandidate(...);
    // ...
    if (candidate) {
      if (candidate.key === lastKey && candidate.text === lastText) stable++;
      else { stable = 1; }                      // 文本变化 → 重置

      // 发送增量到后端        ← 这是好的，已实现
      if (candidateChanged) {
        chrome.runtime.sendMessage({ type: 'capture_delta', ... });
      }

      // ← 核心判定点：
      if (stable >= 3 && !candidate.streaming && ...) {
        return { completion_reason: 'stable_snapshot' };
      }
    }
    await sleep(150);  // 150ms 轮询
  }
  // 超时 → 返回最长部分结果
  return { ...bestResult, completion_reason: 'idle_timeout' };
}
```

### 流式判断来源

**文件**：`extension/content.js` L815-818 `messageIsStreaming()`

```javascript
function messageIsStreaming(el) {
  return !!el.matches?.('[data-streaming="true"], [aria-busy="true"]') ||
    !!el.querySelector?.('[data-streaming="true"], [aria-busy="true"], .dot-flashing, [class*="loading"]');
}
```

### 当前问题

| 问题 | 严重性 | 受影响的站点 |
|------|--------|-------------|
| `data-streaming` 属性不是通用标准，仅 Doubao/部分站点设置 | 高 | DeepSeek、Qwen、Kimi 等 |
| 不检测 Stop 按钮，`messageIsStreaming()` 可能一直返回 false | 高 | 大量非 Doubao 站点 |
| 没有 "stop button 消失" 作为完成信号的第二来源 | 高 | 所有站点 |
| 轮询间隔 150ms 过于密集，对风控不利 | 中 | 所有站点 |
| `stable >= 3`（450ms）太短，大模型可能暂停超过 450ms 后被误判完成 | 中 | 生成长文本时 |
| 没有 per-provider 的完成判定策略 | 中 | 多 provider 扩展性 |
| 增量是整段文本差异，不是 true delta（见下） | 低 | 流式体验 |

---

## 三、直接修复建议（按优先级排列）

### 修复 1（P0）：添加 Stop 按钮检测作为通用完成信号

**改文件**：`extension/content.js`

**修改点**：在 `messageIsStreaming()` 函数中增加 Stop 按钮检测

```javascript
// 当前代码 (L815-818)
function messageIsStreaming(el) {
  return !!el.matches?.('[data-streaming="true"], [aria-busy="true"]') ||
    !!el.querySelector?.('[data-streaming="true"], [aria-busy="true"], .dot-flashing, [class*="loading"]');
}

// 修复后
function messageIsStreaming(el) {
  // 方法1: 属性检测（兼容现有站点）
  const attrMatch = !!el.matches?.('[data-streaming="true"], [aria-busy="true"]') ||
    !!el.querySelector?.('[data-streaming="true"], [aria-busy="true"], .dot-flashing, [class*="loading"]');

  // 方法2: Stop 按钮全局检测（zero-token 模式，站点无关）
  // 这是最可靠的跨站点流式判断：页面有 stop 按钮 = 模型仍在生成
  const stopBtn = document.querySelector(
    '[aria-label*="Stop" i], [aria-label*="stop" i], ' +
    '[aria-label*="停止"], [aria-label*="暂停"], ' +
    'button[data-testid*="stop" i], ' +
    'svg[class*="stop" i], ' +
    '.stop-generating, .stop-btn, [class*="stop-generate"]'
  );
  // stopBtn 存在 + 按钮可见 + 不是 disabled → 仍在流式
  const hasActiveStopBtn = !!stopBtn &&
    stopBtn.getClientRects().length > 0 &&
    !stopBtn.disabled &&
    stopBtn.getAttribute('aria-disabled') !== 'true';

  return attrMatch || hasActiveStopBtn;
}
```

### 修复 2（P0）：完成条件加固 — 需要 stop 按钮消失 + 文本稳定

**改文件**：`extension/content.js` L1046-1049

```javascript
// 当前代码
if (stable >= 3 && !candidate.streaming && !sameUserMessage(candidate.text, userMessage)) {
  return { key: candidate.key, text: candidate.text, completion_reason: 'stable_snapshot' };
}

// 修复后：zero-token 的 double-check 模式
// 1. 文本连续 N 轮不变
// 2. stop 按钮已消失（不再流式）
// 3. 文本长度 >= 阈值（排除空回复）
const isStillStreaming = messageIsStreaming(candidate.element);
const isGenerating = isStillStreaming;

if (stable >= 4 && !isGenerating && candidate.text.length >= 2 && !sameUserMessage(candidate.text, userMessage)) {
  // 额外安全确认：再等一轮确认 stop 按钮没有重新出现
  await sleep(300);
  if (!isPageStillGenerating()) {  // 新函数，见修复 3
    return { key: candidate.key, text: candidate.text, completion_reason: 'stop_button_gone_and_stable' };
  }
}
```

### 修复 3（P1）：新增 `isPageStillGenerating()` 全局生成状态函数

**改文件**：`extension/content.js`（新增函数）

```javascript
/**
 * 检查页面是否仍在生成回复。跨站点通用。
 * 对应 zero-token 中每个 provider 的 isStreaming 检查。
 *
 * 策略（按优先级）：
 *   1. Stop/pause 按钮存在且可见 → 正在生成（最可靠）
 *   2. 最后一条 assistant 消息有 data-streaming="true" → 正在生成
 *   3. DOM 持续变化（text 在增长）→ 可能仍在生成
 */
function isPageStillGenerating() {
  // 策略1: 全局 stop 按钮检测
  const stopBtnSelectors = [
    '[aria-label*="Stop" i]',
    '[aria-label*="stop" i]',
    '[aria-label*="停止"]',
    '[aria-label*="暂停生成"]',
    'button[data-testid*="stop" i]',
    'svg[data-icon*="stop" i]',
    '.stop-generating',
    '.stop-btn',
    '[class*="stop-generate"]',
    // ChatGPT 特有
    'button[data-testid="stop-button"]',
    'button.bg-black .icon-lg',          // ChatGPT DOM fallback path
    // DeepSeek 特有
    '.ds-stop-button',
    '[class*="stopButton"]',
    // Doubao 特有
    '[class*="stopIcon"]',
    // Gemini 特有
    'button[aria-label*="Stop responding"]',
  ];

  for (const sel of stopBtnSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.getClientRects().length > 0 &&
          !btn.disabled &&
          btn.getAttribute('aria-disabled') !== 'true' &&
          getComputedStyle(btn).display !== 'none' &&
          getComputedStyle(btn).visibility !== 'hidden') {
        return true;  // stop 按钮可见 = 页面仍在生成
      }
    } catch (_) {}
  }

  // 策略2: data-streaming 属性（兜底）
  try {
    const streaming = document.querySelector('[data-streaming="true"]');
    if (streaming) return true;
  } catch (_) {}

  return false;
}
```

### 修复 4（P1）：增加稳定轮数 + 自适应间隔

**改文件**：`extension/content.js` L991-1059 `waitForDirectResponse()`

```javascript
// 当前：150ms 固定间隔，stable >= 3 完成
// 修复后逻辑：
const STABLE_THRESHOLD = 5;   // 从 3 提高到 5（750ms 确认）
const POLL_INTERVAL = 150;    // 不变
let stable = 0;
let consecutiveNoChange = 0;
let lastText = '';
let lastKey = '';
let wasGenerating = true;

while (Date.now() - started < timeout) {
  let candidate = findDirectCandidate(userMessage, beforeKeys, responseAnchorBefore);
  // ... 省略 fallback 逻辑 ...

  if (candidate) {
    const isGenerating = isPageStillGenerating();   // 新函数
    const textChanged = (candidate.key !== lastKey || candidate.text !== lastText);

    if (textChanged) {
      stable = 0;
      consecutiveNoChange = 0;
      lastKey = candidate.key;
      lastText = candidate.text;
      wasGenerating = isGenerating;
    } else {
      consecutiveNoChange++;
      if (!isGenerating && wasGenerating) {
        // stop 按钮刚刚消失：这是关键信号
        stable = STABLE_THRESHOLD - 1;  // 加速到完成
      }
      stable++;
    }

    // 发送增量（保持现有逻辑）
    if (textChanged && currentCaptureJobId) {
      chrome.runtime.sendMessage({ type: 'capture_delta', ... });
    }

    // 完成判定
    if (stable >= STABLE_THRESHOLD && !isGenerating && candidate.text.length >= 2) {
      return {
        key: candidate.key,
        text: candidate.text,
        completion_reason: 'stable_and_streaming_stopped'
      };
    }

    wasGenerating = isGenerating;
  }
  await sleep(POLL_INTERVAL);
}
```

### 修复 5（P2）：将 `response_anchor` 新鲜度检查扩展为完整的三态判定

**改文件**：`extension/content.js` `waitForDirectResponse()`

当前只有 `responseAnchorBefore`（发送前的响应区域快照），但没有利用发送后的 DOM 变化作为完成信号。

增加一个 `sendEvidenceAge` 计时器：

```javascript
// 在 waitForDirectResponse 开始处：
let sendEvidenceTime = null;     // 首次检测到发送证据的时间戳
let firstResponseTime = null;    // 首次检测到回复的时间戳
let totalQuietPeriods = 0;       // 连续安静轮数

while (...) {
  // ...
  if (candidate) {
    if (!firstResponseTime) {
      firstResponseTime = Date.now();
    }

    // 记录从发送到首次回复的延迟（诊断用）
    if (!sendEvidenceTime && firstResponseTime) {
      sendEvidenceTime = Date.now();
      emitPageTrace('first_response_latency', {
        msSinceSend: sendEvidenceTime - started
      });
    }

    // 如果已经安静超过 15 秒且 stop 按钮消失 → 快速结束
    if (consecutiveNoChange > 100 && !isGenerating) {  // 100 * 150ms = 15s
      reportPageEvent('early_completion_quiet_timeout', {
        quietMs: consecutiveNoChange * POLL_INTERVAL,
        textLength: candidate.text.length
      });
      return { key: candidate.key, text: candidate.text,
               completion_reason: 'extended_quiet_without_generation' };
    }
  }
}
```

### 修复 6（P2）：将 completion_reason 细化为结构化事件

**改文件**：`server/api_server.py` + `extension/content.js`

当前 `completion_reason` 只有两个值：`'stable_snapshot'` 和 `'idle_timeout'`。

对齐 ds2api 的 `StreamEventType` 设计，扩展为：

```python
# 建议的 completion_reason 枚举（对齐 ds2api 事件模型）
COMPLETION_REASONS = {
    "stop_button_gone_and_stable": "流式停止 + DOM 稳定",    # 最可靠
    "extended_quiet_no_generation": "长时间无生成活动",       # 次可靠
    "stable_snapshot": "DOM 连续稳定（无 stop 按钮参考）",   # 兜底
    "idle_timeout": "超时返回最长部分文本",                  # 最后手段
    "send_no_effect": "发送无效果",                           # 错误
    "no_content_timeout": "超时无内容",                       # 错误
}
```

并在 trace 中记录完整的完成判定过程：

```python
# api_server.py: append_browser_delta() 中
item = {
    "key": ...,
    "text": ...,
    "delta": ...,
    "streaming": ...,
    "completion_reason": body.get("completion_reason") or "",
    "completion_evidence": {                        # 新增
        "stop_button_visible": body.get("stop_button_visible"),
        "data_streaming_attr": body.get("data_streaming_attr"),
        "stable_rounds": body.get("stable_rounds"),
        "quiet_period_ms": body.get("quiet_period_ms"),
        "text_length": len(text),
    },
    "time": time.time(),
}
```

### 修复 7（P2）：Server 端流式转发对齐 ds2api 的 ping 心跳

**改文件**：`server/api_server.py` L1160-1206

当前 SSE 流使用 SSE comment (`: heartbeat\n\n`) 做心跳，但间隔固定在 0.25s：

```python
# 当前 (L1183)
self.wfile.write(b": heartbeat\n\n"); self.wfile.flush()
time.sleep(0.25)
```

对齐 ds2api，应：
1. 只在没有实际 delta 可发送时才发 heartbeat
2. 增加 15 秒硬性超时（当前依赖外层 timeout）

```python
# 建议修改
last_data_sent = time.time()
last_heartbeat = time.time()

while time.time() < stream_deadline:
    with BROWSER_LOCK:
        deltas = list(BROWSER_DELTAS.get(job["id"], []))
        current = BROWSER_JOBS.get(job["id"])

    had_data = False
    for item in deltas[sent_count:]:
        sent_count += 1
        text_delta = str(item.get("delta") or "")
        if not text_delta:
            continue
        chunk = dict(stream_base, choices=[{
            "index": 0, "delta": {"content": text_delta}, "finish_reason": None
        }])
        self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
        self.wfile.flush()
        had_data = True
        last_data_sent = time.time()

    # 检查完成
    terminal_now = ev.is_set() or (current and current.get("status") in ("completed", "failed"))
    if terminal_now:
        # ... 处理完成 ...
        break

    # 心跳：只在至少 5 秒无数据时发送（对齐 ds2api ping）
    now = time.time()
    if not had_data and now - last_heartbeat > 5.0:
        self.wfile.write(b": ping\n\n")
        self.wfile.flush()
        last_heartbeat = now

    # 数据静默超时：15 秒无增量 + 无完成 → 提前结束
    if now - last_data_sent > 15.0:
        # 尝试返回最长部分结果
        break

    time.sleep(0.25)
```

---

## 四、各上游项目 DOM 提取模式速查表

| 项目 | DOM 读取方式 | 流式判断 | 完成判定 | 增量粒度 |
|------|-------------|---------|---------|---------|
| **zero-token ChatGPT** | `page.evaluate()` + `querySelectorAll('[data-message-author-role="assistant"]')` | `stopBtn = querySelector('button.bg-black .icon-lg')` | `!isStreaming && stableCount >= 2` | 整段替换（DOM fallback 无真增量） |
| **zero-token Gemini** | 同上 | `stopBtn = querySelector('[aria-label*="Stop"]')` | 同上 | 同上 |
| **zero-token Doubao** | `page.evaluate()` 内 `fetch(/samantha/chat/completion)` → 直接读取 SSE 流 | 真正的 SSE 逐行解析 | SSE `[DONE]` 或流自然结束 | **逐行 SSE 增量**（最精细） |
| **zero-token DeepSeek** | 通过 HTTP client（非 DOM），`/chat_completion` API | 真正的 SSE | `finish_reason: "stop"` | 逐 chunk 文本增量 |
| **zero-token 流适配器** | SSE 行 → `processLine()` | XML 标签切换 `<thinking>/<tool_call>` | 流结束（reader.done）+ 最终 emit | text/thinking/tool 分类 delta |
| **ds2api** | 上游 SSE → `sse.LineResult` 解析 | 不适用（非 DOM） | `StreamEventDone` 事件 | `text_delta`/`thinking_delta` 事件 |
| **Phantom Relay 当前** | `logicalMessageSnapshot()` 基于 `data-message-id`/`data-observe-row` 轮询 | `messageIsStreaming()` = `data-streaming`/`aria-busy` 属性 | `stable >= 3 && !candidate.streaming` | 整段文本差异（非 true delta） |

---

## 五、Phantom Relay 缺失的核心能力（对照上游）

### 1. 无 Stop 按钮检测（致命缺陷）
- **上游**: zero-token 所有 DOM provider 都检测 stop 按钮
- **当前**: 只检查 `data-streaming`/`aria-busy` 属性，DeepSeek 等站点**根本不设这些属性**
- **后果**: 非 Doubao 站点上 `messageIsStreaming()` 永远返回 `false`，`stable >= 3` 在 450ms 后即判定完成，可能截断生成中的回复

**修复**: 立即实施 **修复 1 + 修复 3**

### 2. 无 provider 级完成策略
- **上游**: zero-token 每个 provider 有独立的完成判断（ChatGPT 检测 `button.bg-black .icon-lg`，Gemini 检测 `[aria-label*="Stop"]`）
- **当前**: 一套通用逻辑应用所有站点
- **修复建议**: 在 `selector_templates.json` 中增加 `completion_indicators` 字段

```json
{
  "chat.deepseek.com": {
    "input": {...},
    "send": {...},
    "completion_indicators": {
      "stop_button_selectors": [
        ".ds-stop-button",
        "[class*='stopButton']",
        "button[class*='stop']"
      ],
      "streaming_attributes": ["data-streaming"],
      "stable_rounds": 5,
      "max_quiet_ms": 15000
    }
  }
}
```

### 3. 无 thinking/content 分离
- **上游 ds2api**: `StreamAccumulator` 将 RawText/Text/RawThinking/Thinking 完全分离
- **上游 zero-token**: `emitDelta("text")` vs `emitDelta("thinking")` 分开
- **当前**: `cleanAssistantText()` 只能按行过滤状态文字，无法区分思考区和回答区
- **后果**: DeepSeek 的思考面板内容会混入最终回复

**修复建议**: 利用录制的 `response` 区域选择器，明确只取回答面板（非思考面板）。一次录制可以有多个 response 区域：`thinking_region` 和 `answer_region`。

### 4. 增量粒度过粗
- **上游 zero-token Doubao**: 逐 SSE 行转发，每行 1-10 字符
- **当前**: 每次 `capture_delta` 发送整段候选文本差异，可能是几百字符的块
- **后果**: SSE 客户端看到的是大块文本跳变，不是流畅的逐词流式

### 5. 无服务器端 SSE ping 机制
- **上游 ds2api**: `StreamEventPing` 维持长连接
- **当前**: 硬编码 `: heartbeat\n\n` 每 0.25s
- **修复**: 见 **修复 7**

### 6. 无 page_session_id 变化检测（已有但未用于完成判定）
- **当前**: `pageSessionId` 已生成和传递，但只用于 trace 去重
- **缺失**: 当一个 DOM document 被替换（SPA 导航、虚拟列表重建），旧的 `page_session_id` 失效，但 `waitForDirectResponse` 仍继续轮询
- **上游 zero-token**: session-tab-registry 中有 `sessionKey → tab/page` 的注册和归属管理

---

## 六、推荐实施路线

### 第 1 天（立即）
1. **修复 1**: 在 `messageIsStreaming()` 中增加 stop 按钮检测
2. **修复 3**: 新增 `isPageStillGenerating()` 全局生成状态函数
3. 测试 DeepSeek、Doubao 两个站点，验证新完成判定不会过早截断

### 第 2 天
4. **修复 2**: 完成条件加固（stop 按钮消失 + 文本稳定双重确认）
5. **修复 4**: 提高稳定轮数到 5，增加自适应间隔
6. 端到端测试：验证 5-10 轮对话的完成判定准确率

### 第 3 天（如需要）
7. **修复 5**: 三态判定（发送证据 → 首次回复 → 安静超时）
8. **修复 6**: `completion_reason` 细化为枚举
9. **修复 7**: SSE 流对齐 ds2api ping 模型

---

## 七、关键数据流对照

### zero-token 的完整数据流

```
用户消息
  → provider client (chatgpt-web-client-browser.ts)
    → page.evaluate() 内 fetch(/backend-api/conversation)
    → 读取 ReadableStream<Uint8Array> (SSE 字节流)
  → stream adapter (chatgpt-web-stream.ts)
    → reader.read() 逐 chunk 解码
    → processLine() 逐行解析 JSON
    → 检测 content_type: "text" vs "code" vs "tool_use"
    → emitDelta("text", delta)  或  emitDelta("toolcall", delta)
    → 流结束 → stream.push({ type: "done" })
  → pi-agent 层
    → createAssistantMessageEventStream() 收集所有事件
    → 最终归并为 AssistantMessage { role, content, stopReason, usage }
```

### Phantom Relay 当前数据流

```
用户消息
  → POST /v1/chat/completions
    → browser_prompt() 构造网页消息
    → new_browser_job() 创建队列任务
  → extension/background.js 轮询
    → chrome.tabs.sendMessage({ action: 'auto_capture' })
  → extension/content.js
    → setInputValue() 填入输入框
    → safeClick() / dispatchEvent(Enter) 发送
    → waitForDirectResponse() 轮询 DOM
      → findDirectCandidate() 每 150ms 查 DOM
      → capture_delta 发送到后端      ← 有增量
      → stable >= 3 && !streaming     ← 完成判定（问题在这里）
  → POST /browser/result
    → finish_browser_job() 标记完成
    → SSE 流式转发 delta 累积结果
    → openai_stream_chunks() 组装 OpenAI 响应
```

### 建议的目标数据流（对齐 zero-token + ds2api 混合模型）

```
用户消息
  → POST /v1/chat/completions
    → browser_prompt() 构造网页消息
    → new_browser_job() + completion_strategy = loadFromProviderConfig()
  → extension/content.js
    → autoCapture()
      → 发送前 isPageStillGenerating() = false（初始状态）
      → sendMessage()
      → waitForDirectResponse() 改进版
        → 每轮检查 isPageStillGenerating()  ← [新增] stop 按钮检测
        → 文本变化 → 重置 stable
        → stop 按钮消失 → 加速完成
        → stable >= 5 && !isGenerating → 完成
        → completion_reason = "streaming_stopped_and_stable"
  → SSE 转发
    → 每 5 秒无数据才发 ping（不是每 0.25s）
    → 15 秒数据静默 → 主动结束
```

---

## 八、源代码级验证清单

以下是对 Phantom Relay 当前代码中完成判定相关路径的检查结果：

| 检查项 | 文件:行号 | 状态 |
|--------|----------|------|
| 流式判断仅依赖 `data-streaming`/`aria-busy` | `content.js:816-818` | ❌ 需要扩展 |
| 完成判定 `stable >= 3` | `content.js:1047` | ⚠️ 阈值偏低 |
| 无 stop 按钮检测 | 整个 `content.js` | ❌ 缺失 |
| 无 provider 配置化完成策略 | `selector_templates.json` | ❌ 缺失 |
| delta 是整段文本差异而非 true delta | `content.js:1024-1036` | ⚠️ 可接受 |
| SSE 心跳间隔 0.25s | `api_server.py:1183` | ⚠️ 可优化 |
| completion_reason 只有两个值 | `api_server.py:1047-1056` | ⚠️ 可扩展 |
| page_session_id 未用于完成判定 | `content.js:30-32` | ⚠️ 未利用 |

---

**结论**：Phantom Relay 当前最大的完成判定缺陷是**完全依赖 `data-streaming` 属性**，而这是 Doubao 特有的实现细节。zero-token 的 stop 按钮检测模式是跨站点的通用方案，应立即采用。ds2api 的事件驱动模型（`text_delta` / `done` / `error` / `ping`）也是 SSE 流式转发的更优参考。建议按第 6 节的路线实施修复。
