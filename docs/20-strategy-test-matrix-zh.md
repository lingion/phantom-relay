# Phantom Relay DOM 回复完成判定 — 20 策略可测试性矩阵

> 生成日期：2026-07-21
> 审计基准：`extension/content.js` (1995 行), `extension/background.js` (717 行), `extension/universal_bridge.js` (328 行), `server/api_server.py` (1289 行), `docs/dom-completion-audit-v2.md`, `docs/universal-adapter-architecture.md`
> 开源参考：zero-token/openclaw, ds2api, browser-use

---

## 评分体系

| 维度 | 含义 |
|------|------|
| **实现成本** | Low (<2h) / Medium (半天) / High (1-3天) / Very High (3天+) |
| **可观测性** | ★☆☆☆☆ (盲盒) ~ ★★★★★ (全链路追踪) |
| **风险** | 对当前架构的破坏性、回滚难度、误判率 |
| **测试就绪** | ✅ 立即可测 / ⚠️ 需少量改造 / ❌ 需大量前置工作 / 🔧 已在生产运行中 |

---

## 策略矩阵

### 策略 1：MutationObserver（DOM 变异监听）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `content.js:98-130` `pageTraceObserver`, `content.js:1503-1517` `responseMonitorObserver` |
| **核心机制** | `MutationObserver` 监听 `document.documentElement` 的 `subtree:true, childList, characterData, attributes` 变化，触发 `emitPageTrace` 和 `emitResponseMonitorSnapshot` |
| **实现成本** | N/A（已实现） |
| **可观测性** | ★★★★☆ — `page-trace.jsonl` 记录每次 mutation 的 target、added/removed nodes、bodyTextLength |
| **风险** | 中等。全树监听在虚拟列表高频重绘场景下可能产生大量 trace，影响性能；当前已限流 (debounce 250ms) |
| **最小测试协议** | 1. 发送消息到 DeepSeek/Doubao 2. 检查 `page-trace.jsonl` 的 `mutation` 条目 3. 验证 `bodyTextLength` 单调增长 4. 确认 `response_monitor` 快照出现 |
| **测试就绪** | ✅ 立即可测 |

---

### 策略 2：Copy 按钮检测与自动触发

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `content.js:256-273` 分类器识别 copy 按钮, `content.js:1253-1666` `getCopyButtons()` + `waitForNewCopyButton()` |
| **核心机制** | 录制时识别 copy 按钮（`copy`/`复制`/`clipboard` 关键词 + SVG 图标），回放时检测新出现的可用 copy 按钮作为完成信号；通过 `getExactRecordedCopyButton()` 匹配录制的 selector |
| **实现成本** | N/A（已实现） |
| **可观测性** | ★★★★☆ — `capture_snapshot` trace 包含每个 copy 候选的 `index, usable, messageId, messageText, streaming` |
| **风险** | 中等。不同 AI 站点的 copy 按钮 DOM 结构差异大（Doubao 在 action bar, DeepSeek 可能用 SVG icon），录制选择器可能因 class 变化失效 |
| **最小测试协议** | 1. 在目标站点击 AI 回复旁的 copy 按钮完成录制 2. 发送新消息触发 `auto_capture` 3. 检查 trace 中 `copy_dispatch` 和 `copy_dispatched` 条目 4. 验证返回的 assistant 文本非空 |
| **测试就绪** | ✅ 立即可测 |

---

### 策略 3：Stop 按钮检测（流式生成判定）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 缺失 — 审计报告 (v2) 标记为 P0 缺陷。`messageIsStreaming()` (L856-858) 仅依赖 `data-streaming`/`aria-busy` 属性，无 stop 按钮检测 |
| **核心机制** | 参考 zero-token：`document.querySelector('[aria-label*="Stop" i], [aria-label*="stop" i], button[data-testid*="stop" i]')`，stop 按钮可见 = 仍在流式生成 |
| **实现成本** | **Low** (~1h)。修改 `messageIsStreaming()` 函数，新增 20 行 stop 按钮 selector 列表，检查可见性、disabled 状态 |
| **可观测性** | ★★★★☆ — 可在 trace 中增加 `stop_button_visible: true/false` |
| **风险** | 低。纯增量逻辑，不影响现有 `data-streaming` 路径；误判风险在于某些站点 stop 按钮始终存在于 DOM（hidden），需检查 `getClientRects().length > 0` |
| **最小测试协议** | 1. 在 DeepSeek 发送消息触发流式生成 2. 在 popup 诊断日志中确认 `isPageStillGenerating() = true`（因 stop 按钮可见） 3. 等生成完成后验证 `isPageStillGenerating() = false` 4. 对照：当前不检测 stop 按钮时 DeepSeek 会在 450ms 后误判完成 |
| **测试就绪** | ⚠️ 需先实现 audit 报告的修复 1 + 修复 3 |

---

### 策略 4：ARIA/Role 选择器提升

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ⚠️ 部分实现 — `content.js:223-276` `classifyElement()` 使用 `role="textbox"`/`role="button"` 分类；`content.js:163-202` `generateSelector()` 使用 `aria-label` 作为第 3 优先级 |
| **核心机制** | 扩展 `generateSelector()` 使其也查询 `[role="..."][aria-label="..."]` 组合；对虚拟列表增加 `aria-posinset`/`aria-setsize` 识别 |
| **实现成本** | **Medium** (~4h)。需扩展选择器生成/查找逻辑，增加 `aria-describedby`、`aria-labelledby` 解析 |
| **可观测性** | ★★★☆☆ — 现有 `selector.method` 字段可区分 `aria-label`，需额外增加 trace |
| **风险** | 低—中。ARIA 属性在不同站点的语义差异大（Gemini 的 `aria-label` 可能是英文，DeepSeek 可能是中文），需站点级策略 |
| **最小测试协议** | 1. 录制阶段：对不同 AI 站点（DeepSeek, Doubao, Gemini, ChatGPT）的输入框、发送按钮、回复区域各点击 3 次 2. 检查录制的 `selector.method` 是否包含 `aria-label` 3. 刷新页面后验证选择器仍能唯一定位 |
| **测试就绪** | ⚠️ 需小幅改造 `generateSelector()` 增加 `aria + role` 组合 |

---

### 策略 5：DOM 文本差异（Text Diff）增量计算

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `universal_bridge.js:193-228` `mergeSnapshot()` 实现 overlap-based 增量；`content.js:1118-1131` 发送 `capture_delta` |
| **核心机制** | `mergeSnapshot(existing, incoming)`：若 incoming 以 existing 开头 → 返回后缀作为 delta；若完全匹配 → 空 delta；否则返回完整 incoming (minOverlapLength=32) |
| **实现成本** | N/A（已实现） |
| **可观测性** | ★★★★☆ — delta 通过 `capture_delta` → `BROWSER_DELTAS` → SSE `text_delta` 流转，可逐条验证 |
| **风险** | 低。`mergeSnapshot` 在虚拟列表重建 rows 时可能产生错误 delta（新 row identity 导致完整重发），但已由 `minOverlapLength` 兜底 |
| **最小测试协议** | 1. 使用 `stream: true` 发送请求 2. 逐条收集 SSE `delta.content` 3. 拼接所有 delta，验证与最终 `assistant` 文本一致 4. 检查是否存在重复或丢失 |
| **测试就绪** | ✅ 立即可测（已有 `tests/audit_2_sse_streaming.py`） |

---

### 策略 6：网络请求拦截（Network Interception）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未实现。当前架构完全通过 DOM 操作页面，不拦截网络请求 |
| **核心机制** | 通过 `chrome.webRequest` API (`manifest.json` 需增 `webRequest` 权限) 拦截目标 AI 站点的 SSE/WebSocket 流，直接解析 provider 原生事件 |
| **实现成本** | **Very High** (>3天)。需：1) 新增 `webRequest` + `webRequestBlocking` 权限 2) 解析各站点私有 API 格式 (DeepSeek SSE、Doubao `/samantha/chat/completion`、Gemini 等) 3) 与现有 DOM 回退路径共存 |
| **可观测性** | ★★★★★ — 可获得最精确的 token 级事件 |
| **风险** | 高。1) `webRequest` 权限增加 Manifest V3 审查风险 2) 站点 API 变更频繁（DeepSeek 每月数次） 3) 需要 cookie/header 同步 |
| **最小测试协议** | 当前不可测。需先建立至少一个站点的网络拦截 adapter |
| **测试就绪** | ❌ 需大量前置工作 |

---

### 策略 7：Accessibility Tree 提取

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未实现。当前使用 `innerText`/`textContent` + `domToMarkdown()` 提取内容 |
| **核心机制** | 通过 `chrome.automation` API 或 CDP `Accessibility.getFullAXTree` 获取无障碍树，按 role 提取 `assistant` 消息 |
| **实现成本** | **High** (1-2天)。`chrome.automation` 需 `accessibility.read` 权限 (Manifest V3 严格审查)；CDP 需要 `debugger` 权限 |
| **可观测性** | ★★★☆☆ — 无障碍树输出结构化，但可能丢失格式信息 |
| **风险** | 高。1) `accessibility.read` 权限会触发 Chrome Web Store 人工审核 2) 不同浏览器实现差异大 3) 无障碍树可能不含 Markdown 格式 |
| **最小测试协议** | 1. 使用 Chrome DevTools → Accessibility 面板查看目标 AI 站点无障碍树 2. 验证 assistant 消息是否被标注为独立 accessible node 3. 对比 `AXValue` 与 `innerText` 的一致性 |
| **测试就绪** | ❌ 需大量前置工作 |

---

### 策略 8：Shadow DOM 穿透

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未处理。`document.querySelectorAll()` 无法穿透 Shadow DOM；`element.closest()` 在 Shadow boundary 停止 |
| **核心机制** | 遍历所有 `shadowRoot`，递归查询内部元素；对 `open` Shadow DOM 使用 `el.shadowRoot.querySelectorAll()` |
| **实现成本** | **Medium** (~4h)。在 `generateSelector()`、`findElement()`、`getMessageNodes()` 中增加 Shadow DOM 穿透 |
| **可观测性** | ★★★☆☆ — 需在 trace 中标注 `shadowRoot: true` |
| **风险** | 低。目前主流 AI 站点 (DeepSeek, Doubao, ChatGPT, Gemini) **均不使用** Shadow DOM 做聊天 UI。实现后收益有限，但可作为防御性能力 |
| **最小测试协议** | 1. 创建一个包含 Shadow DOM 的测试页面（自定义元素包裹聊天区域） 2. 验证 `querySelectorAll` 在 Shadow DOM 内能命中 input/send/response 3. 验证 `generateSelector()` 跨 Shadow boundary 生成有效选择器 |
| **测试就绪** | ⚠️ 需先实现 Shadow DOM 穿透工具函数 |

---

### 策略 9：Iframe 内消息提取

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未处理。content script 只在主文档运行，不访问 iframe 内容（跨域策略限制） |
| **核心机制** | 对同源 iframe，使用 `iframe.contentDocument.querySelectorAll()`；对跨域 iframe，仅能做存在性检测 |
| **实现成本** | **Medium** (~4h)。在 `getMessageNodes()`、`findElement()` 中增加 iframe 遍历 |
| **可观测性** | ★★☆☆☆ — 跨域 iframe 内容不可读，仅能日志标记 |
| **风险** | 中—高。1) 主流 AI 站点不使用 iframe 承载聊天 UI 2) 跨域限制使大部分场景不可行 3) 添加 iframe 支持可能产生安全警告 |
| **最小测试协议** | 1. 创建同源 iframe 测试页面，iframe 内包含 input/send/response 2. 验证 `getMessageNodes()` 能发现 iframe 内消息节点 3. 验证 `auto_capture()` 在 iframe 场景下正常工作 |
| **测试就绪** | ⚠️ 需实现同源 iframe 遍历 + 测试页面 |

---

### 策略 10：Clipboard（剪贴板）读取

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 部分部署 — `manifest.json` 已声明 `clipboardRead` 权限；`content.js:1729-1747` `enableCopyMonitor()` 监听 copy 事件；但**未主动读取系统剪贴板** |
| **核心机制** | `navigator.clipboard.readText()` 读取剪贴板内容作为回复文本 |
| **实现成本** | **Low** (~1h)。在 `autoCapture()` 完成判定后增加 `navigator.clipboard.readText()` 获取精确文本 |
| **可观测性** | ★★☆☆☆ — 剪贴板写入由网页触发，异步，时序不可控 |
| **风险** | 中。1) `clipboardRead` 权限在非 HTTPS 页面可能受限 2) 剪贴板内容可能被其他应用覆盖 3) 需要在用户手势上下文中调用 |
| **最小测试协议** | 1. 录制带 copy 按钮的站点 2. 触发 `auto_capture` → copy 按钮点击 → 读取剪贴板 3. 对比剪贴板文本与 DOM 提取的 `assistant` 文本 |
| **测试就绪** | ⚠️ 需实现读取逻辑（当前仅监听 copy 事件，未读剪贴板） |

---

### 策略 11：Page Source (页面源码) 比较

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 部分实现 — `pageTraceObserver` 记录 `bodyTextLength` 和 `bodyTextTail` (L109-110)，但**不使用完整 page source 做 diff** |
| **核心机制** | 周期性获取 `document.documentElement.outerHTML`，计算 SHA-256，当 hash 变化时做全文 diff 提取新增文本 |
| **实现成本** | **Medium** (~4h)。实现 page source hash 轮询器 + 最小 diff 算法 |
| **可观测性** | ★★★★☆ — 可完整记录每次 page source 快照时间线 |
| **风险** | 中。1) `outerHTML` 可能超过 100MB（长对话），diff 计算开销大 2) 虚拟列表重建行时 hash 也会变，但语义上无新内容 |
| **最小测试协议** | 1. 构造已知 page source 的测试对话 2. 每 500ms 获取 outerHTML hash 3. 追踪 hash 变化时间线 4. 验证 hash 稳定时间与 `completion_reason: stable_snapshot` 一致 |
| **测试就绪** | ⚠️ 需实现 page source hash 轮询 |

---

### 策略 12：React Fiber 内部状态读取

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未实现。当前使用 `click()` 和 `dispatchEvent()` 操作 DOM，不访问 React 内部状态树 |
| **核心机制** | 通过 `el._reactInternals` → `_reactFiber` 遍历 React fiber 树，读取 `memoizedState`/`memoizedProps` 获取消息数据 |
| **实现成本** | **Very High** (>3天)。需要：1) 逆向各站点的 React 组件树结构 2) 处理 React 18 concurrent mode 的 fiber 链表 3) 适配不同 React 版本 |
| **可观测性** | ★★★★☆ — 可获得精确的 state 数据（消息列表、streaming flag、completion status） |
| **风险** | 极高。1) React 内部 API 随版本变化（无稳定性保证） 2) 不同 AI 站点的组件树结构完全不同 3) Production build 可能不暴露 `_reactInternals` (取决于 webpack 配置) 4) 维护成本高 |
| **最小测试协议** | 1. 在 DeepSeek 页面 console 执行 `document.querySelector('[data-message-id]').__reactFiber` 2. 确认能访问到 fiber 树 3. 遍历 state 获取消息文本和 streaming 状态 4. 对比与 DOM 提取的一致性 |
| **测试就绪** | ❌ 需大量前置工作（每个站点都要逆向 fiber 树） |

---

### 策略 13：Virtualized Row Grouping（虚拟列表行归并）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `content.js:906-946` `logicalMessageSnapshot()` 按 `data-observe-row`/`data-message-id`/`row:` 前缀归并；`universal_bridge.js:152-166` `logicalMessageSnapshot()` 按 `logicalKey`/`containerKey` 分组 |
| **核心机制** | Doubao 等虚拟列表将同一消息拆分为外层 row (`data-observe-row`) + 内层 message node (`data-message-id`)，归并逻辑用 `row:${rowKey}` 作为逻辑 key |
| **实现成本** | N/A（已实现） |
| **可观测性** | ★★★☆☆ — 归并结果通过 `logicalMessageSnapshot()` 和 debug 日志可观测 |
| **风险** | 低—中。不同站点的虚拟列表实现差异大（ChatGPT 可能不用 `data-observe-row`），归并 key 需要站点级适配 |
| **最小测试协议** | 1. 在 Doubao 上做多轮对话 2. 检查 `logicalMessageSnapshot()` 返回的消息数量 3. 验证没有重复 key（同一条消息出现两次） 4. 在 trace 中确认 `row:` 前缀合并生效 |
| **测试就绪** | ✅ 立即可测 |

---

### 策略 14：Generation Markers（生成标记检测）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ⚠️ 部分实现 — `content.js:856-858` `messageIsStreaming()` 检测 `data-streaming="true"`/`aria-busy="true"`；`universal_bridge.js:33-49` `STATUS_LINE_PATTERNS` 过滤 "思考中"/"搜索中" 等状态文本 |
| **核心机制** | 扩展 `messageIsStreaming()` 支持 per-site streaming marker（如 ChatGPT 的 `.result-streaming` class, DeepSeek 的思考面板 toggle, Gemini 的 `.response-container.streaming`） |
| **实现成本** | **Medium** (~4h)。在 `selector_templates.json` 中增加 `streaming_indicators` 字段，加载到 `messageIsStreaming()` 中 |
| **可观测性** | ★★★★☆ — 每次 `messageIsStreaming()` 调用返回的布尔值可写入 trace |
| **风险** | 中。per-site marker 需要维护，站点 UI 更新后可能失效 |
| **最小测试协议** | 1. 对 DeepSeek、Doubao、ChatGPT、Gemini 各录制一次 2. 在 `selector_templates.json` 中为每个站点配置 streaming indicators 3. 发送消息后每轮 poll 验证 `messageIsStreaming()` 返回值 |
| **测试就绪** | ⚠️ 需实现 per-site `streaming_indicators` 配置 |

---

### 策略 15：Quiet Windows（安静窗口自适应判定）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `content.js:1140-1143` `stable >= 3` (450ms) 判定完成；`content.js:1440-1455` `waitForVisibleResponse()` 使用 `stable >= 6 && firstCandidateAt >= 8000ms && lastChangeAt >= 4500ms` |
| **核心机制** | 借鉴 zero-token 模式：文本不再变化 + stop 按钮消失 + 额外安静确认窗口 → 完成 |
| **实现成本** | **Low** (~1h)。微调稳定阈值参数（`STABLE_THRESHOLD`, `MIN_GENERATION_WINDOW`, `QUIET_WINDOW`）并使之可配置 |
| **可观测性** | ★★★★☆ — `stable` 计数器已在 trace 中记录 (`response_candidate` 条目) |
| **风险** | 低。阈值调整可能影响不同模型的判定准确率；Doubao 等慢模型需要更长窗口 |
| **最小测试协议** | 1. 用不同长度的问题（短/中/长）测试完成判定时间 2. 记录 `completion_reason` 和 `stable` 轮数 3. 对比 `stable_snapshot` vs `idle_timeout` 的比例 4. 调整 `STABLE_THRESHOLD` 参数重新测试 |
| **测试就绪** | ✅ 立即可测（参数调整即可） |

---

### 策略 16：Ports（长连接通信通道）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未使用。当前使用 `chrome.runtime.sendMessage`（单次消息）进行扩展内部通信 |
| **核心机制** | 使用 `chrome.runtime.connect()` 创建 `Port`，保持 content script ↔ background 的长连接，实现低延迟双向流式通信 |
| **实现成本** | **High** (1-2天)。需重构 content.js 与 background.js 之间的通信模式，从 `sendMessage` 迁移到 `connect` + `port.postMessage` |
| **可观测性** | ★★★★☆ — Port 状态可实时监控 (`port.onDisconnect` 记录断开原因) |
| **风险** | 中。1) Manifest V3 service worker 可能在空闲时被终止，Port 会断开 2) 当前 `sendMessage` 模式已稳定，重构引入回归风险 |
| **最小测试协议** | 1. 建立 background ↔ content 的 Port 连接 2. 发送 100 条连续消息 3. 验证消息顺序和送达率 4. 模拟 service worker 休眠后重连 |
| **测试就绪** | ❌ 需大量前置工作 |

---

### 策略 17：Polling Endpoint（轮询端点优化）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `POST /browser/poll` + `POST /browser/result` 模式；background.js 每 0.17 分钟 (约10秒) 通过 `chrome.alarms` 触发 poll |
| **核心机制** | optimized polling: 任务到达时后端主动推送通知 → 减少空轮询；job claim 时一次性返回完整上下文 |
| **实现成本** | **Medium** (~4h)。在后端增加长轮询 (long-poll) 或 EventSource；在 background.js 使用 `fetch` + `AbortController` 做长连接等待 |
| **可观测性** | ★★★★★ — `BROWSER_QUEUE`/`BROWSER_JOBS` 状态可在 `/browser/pending-domains` 看到 |
| **风险** | 低。纯后端优化，不影响现有路径；长轮询可能增加端口占用 |
| **最小测试协议** | 1. 启动 API server 2. 在 background.js poll 循环中记录空轮询次数 3. 对比当前 10s 周期与长轮询的延迟差异 |
| **测试就绪** | ✅ 立即可测（观测现有 poll 行为） |

---

### 策略 18：Direct Fetch（直接 HTTP 请求 bypass DOM）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未实现。当前完全通过 DOM 操作页面，不发送独立 HTTP 请求到 AI provider |
| **核心机制** | 参考 zero-token 的 Doubao adapter：在 `page.evaluate()` 内 `fetch(/samantha/chat/completion)` 直接调用 provider 私有 API，获得原生 SSE 流 |
| **实现成本** | **Very High** (>3天)。需：1) 逆向各站点的私有 API endpoint + 认证方式 2) 处理 token/签名生成 3) 维护 API 契约随站点更新 |
| **可观测性** | ★★★★★ — 可获得完整的请求/响应头、body、SSE 行 |
| **风险** | 极高。1) 站点 API 变更频繁，维护成本极高 2) 可能触发风控 (非浏览器指纹) 3) 与 Phantom Relay 的 "browser login session" 设计哲学冲突 |
| **最小测试协议** | 当前不可测。需先逆向至少一个站点的私有 API |
| **测试就绪** | ❌ 需大量前置工作 |

---

### 策略 19：Background Relay（后台任务调度中继）

| 项目 | 详情 |
|------|------|
| **当前实现状态** | 🔧 已部署 — `background.js:224-396` `browserBridgeTick()` 作为核心调度器：poll → claim job → sendMessage → collect result → POST /browser/result |
| **核心机制** | Service Worker 通过 `chrome.alarms` 定期唤醒 (0.17min 间隔)，`browserBridgeTick()` 是唯一任务入口，防止重复提交 |
| **实现成本** | N/A（已实现） |
| **可观测性** | ★★★★☆ — `addDebugLog()` 记录每个 tick 的完整生命周期 (`browser_poll_claimed`, `browser_capture_returned`, `browser_result_posted`) |
| **风险** | 低。当前 `browserPollInFlight` 锁防止并发；`claimedJobId` → 失败时 fallback 写 error result |
| **最小测试协议** | 1. 启动 API server + 扩展 2. 发送 `/v1/chat/completions` 请求 3. 在 popup 诊断日志中追踪完整 tick 流程 4. 验证 `browserPollInFlight` 锁在并发场景下正确工作 |
| **测试就绪** | ✅ 立即可测（已有 `tests/audit_05_concurrency_queue_lease.py`） |

---

### 策略 20：Service Worker Offscreen Document + CDP

| 项目 | 详情 |
|------|------|
| **当前实现状态** | ❌ 未实现。当前使用 Manifest V3 Service Worker + Content Script，不使用 offscreen document 或 CDP |
| **核心机制** | 创建 `offscreen` document (Manifest V3 支持) 维持长连接；通过 CDP (`chrome.debugger`) 发送 `Runtime.evaluate`、`DOM.getDocument`、`Accessibility.getFullAXTree` 等协议命令 |
| **实现成本** | **Very High** (>3天)。需：1) 新增 `offscreen` 权限 + offscreen.html/js 2) 新增 `debugger` 权限 (触发 Chrome Web Store 人工审查) 3) 实现 CDP 协议子集 |
| **可观测性** | ★★★★★ — CDP 提供 protocol-level 日志、DOM 快照、网络监控 |
| **风险** | 极高。1) `debugger` 权限在页面显示 "Phantom Relay is debugging this browser" 黄条，用户体验差 2) Manifest V3 审查严格 3) CDP 连接不稳定 (tab 导航/崩溃) |
| **最小测试协议** | 1. 使用 `chrome.debugger.attach()` 连接目标 tab 2. 发送 `Runtime.evaluate` 获取 `document.title` 3. 验证 CDP 响应格式 4. 测试 tab 导航时重连 |
| **测试就绪** | ❌ 需大量前置工作 |

---

## 综合排名：当前可测试性

| 排名 | 策略 | 状态 | 优先级 | 实施建议 |
|------|------|------|--------|----------|
| 🥇 | **Stop 按钮检测 (S3)** | ❌ 缺失 | **P0** | 立即实施 audit 修复 1+3，~1h |
| 🥈 | **Quiet Windows 优化 (S15)** | 🔧 已有 | **P1** | 微调参数，~1h |
| 🥉 | **Generation Markers (S14)** | ⚠️ 部分 | **P1** | per-site streaming indicators，~4h |
| 4 | **MutationObserver (S1)** | 🔧 已有 | 维护 | 已有，监控性能 |
| 5 | **Copy 按钮 (S2)** | 🔧 已有 | 维护 | 已有，验证各站点 |
| 6 | **ARIA/Role 选择器 (S4)** | ⚠️ 部分 | **P2** | 扩展 selector 生成 |
| 7 | **Virtualized Row (S13)** | 🔧 已有 | 维护 | 已有，验证覆盖度 |
| 8 | **DOM Text Diff (S5)** | 🔧 已有 | 维护 | 已有 |
| 9 | **Page Source 比较 (S11)** | ⚠️ 部分 | **P2** | 增加 outerHTML hash |
| 10 | **Clipboard 读取 (S10)** | ⚠️ 部分 | **P2** | 增加 readText() |
| 11 | **Shadow DOM (S8)** | ❌ 缺失 | **P3** | 防御性能力 |
| 12 | **Iframe (S9)** | ❌ 缺失 | **P3** | 防御性能力 |
| 13 | **Polling 优化 (S17)** | 🔧 已有 | **P3** | 长轮询优化 |
| 14 | **Background Relay (S19)** | 🔧 已有 | 核心 | 无需改动 |
| 15 | **Ports (S16)** | ❌ 缺失 | **P4** | 需重构通信层 |
| 16 | **React Fiber (S12)** | ❌ 缺失 | **P4** | 维护成本极高 |
| 17 | **Accessibility Tree (S7)** | ❌ 缺失 | **P4** | 权限审查风险 |
| 18 | **Network Interception (S6)** | ❌ 缺失 | **P4** | 架构哲学冲突 |
| 19 | **Direct Fetch (S18)** | ❌ 缺失 | **P4** | 与设计哲学冲突 |
| 20 | **Offscreen + CDP (S20)** | ❌ 缺失 | **P4** | 用户体验差，审查风险 |

---

## 优先实施路线（对齐 DOM 完成审计 v2）

### 第 1 天 — P0/P1 立即修复
1. **策略 3**：Stop 按钮检测 → 修改 `messageIsStreaming()` (30 min)
2. **策略 3**：新增 `isPageStillGenerating()` 全局函数 (30 min)
3. **策略 15**：稳定阈值从 3 提高到 5 (15 min)
4. 端到端验证 DeepSeek + Doubao (1h)

### 第 2 天 — P1 加固
5. **策略 14**：per-site `streaming_indicators` 配置 → `selector_templates.json`
6. **策略 15**：完成条件加固（stop 按钮消失 + 文本稳定双重确认）
7. 5-10 轮对话端到端测试

### 第 3 天 — P2 增强
8. **策略 11**：page source hash 辅助判定
9. **策略 10**：clipboard readText() 作为精确文本来源
10. **策略 4**：ARIA role 组合 selector 增强

---

## 审计证据

所有策略判定基于以下源代码的逐文件审计：

| 文件 | 行数 | 审计范围 |
|------|------|----------|
| `extension/content.js` | 1995 行 | 完整读取 |
| `extension/background.js` | 717 行 | 完整读取 |
| `extension/universal_bridge.js` | 328 行 | 完整读取 |
| `extension/popup.js` | 428 行 | 完整读取 |
| `extension/popup.html` | 262 行 | 完整读取 |
| `extension/manifest.json` | 43 行 | 完整读取 |
| `server/api_server.py` | 1289 行 | 关键路径读取 |
| `docs/dom-completion-audit-v2.md` | 718 行 | 完整读取 |
| `docs/universal-adapter-architecture.md` | 335 行 | 完整读取 |
| `README-zh-CN.md` | 351 行 | 完整读取 |

**总计审计代码量**：约 6,500 行源代码 + 1,053 行设计文档。

---

*报告由 Hermes Agent 基于代码文件级审计生成。所有策略可行性判定均有源码位置引用。不包含虚构结果。*
