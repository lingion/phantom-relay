# Phantom Relay 响应捕获方案矩阵

状态：第一轮建立，未把未实测方案标记为成功。
验收唯一标准：真实 `POST /v1/chat/completions` 返回 2xx，且 `choices[0].message.content` 非空；DOM trace 不等于 API 成功。

| # | 方案 | 关键证据/实现 | 当前状态 | 失败判据 |
|---:|---|---|---|---|
| 1 | 新增用户消息后取其后最长 DOM 节点 | `data-message-id/data-observe-row` + `innerText` | 已有，真实请求仍 504 | 无 assistant 节点或未到 result |
| 2 | MutationObserver 增量快照 | 监听 childList/characterData/attributes | 已有 monitor，未闭环 | 只有 trace 无 result |
| 3 | 固定 quiet window | 文本不增长 N 次且静默窗口 | 已有，曾错误提前取前缀 | 取到前缀或 timeout |
| 4 | 生成最小 grace window | 首候选后至少 8s 才允许完成 | 已落地，待扩展重载后测 | 仍取前缀 |
| 5 | stop/generating 控件状态 | stop 消失或 send 恢复 | 待实现/测试 | 状态与完整文本不一致 |
| 6 | assistant/user role 属性 | `role`, `data-role`, aria 属性 | 待测试 | role 缺失/误分类 |
| 7 | 逻辑行去重 | 外层 row 与内层 message 合并 | 已有 | 重复节点污染候选 |
| 8 | response selector 变化检测 | 录制区域前后 key/text diff | 已有 | selector 匹配用户消息 |
| 9 | copy 按钮定位 | 最新 assistant 行内 copy | 已有旧路径，待切换测试 | copy 不存在或文本截断 |
| 10 | Clipboard 读取 | 点击 copy 后读取剪贴板 | 已有权限，待实测 | 权限/剪贴板为空 |
| 11 | Accessibility tree 文本 | aria/可访问名称读取 | 待实现/测试 | aria 只含控件文本 |
| 12 | Shadow DOM 穿透 | 递归 shadowRoot 查询 | 待实现/测试 | 节点在 shadow root 不可见 |
| 13 | iframe/frame 递归 | content script/frames 检查 | 待实现/测试 | assistant 在子 frame |
| 14 | 页面网络层事件 | fetch/XHR/PerformanceResourceTiming | 待实现/测试 | CSP/跨域/无可读正文 |
| 15 | SSE/ReadableStream 页面注入 | 观察页面流式 reader | 待实现/测试 | 页面未使用 SSE 或不可拦截 |
| 16 | React/Vue fiber/状态树 | 从 DOM 节点回溯内部状态 | 待实现/测试 | 构建压缩/结构变化 |
| 17 | 页面源码/JSON hydration | 查找初始数据与消息缓存 | 待实现/测试 | 数据未落 DOM 或加密 |
| 18 | Port 长连接回传 | `chrome.runtime.connect` + port.postMessage | 待实现，优先候选 | service worker/port 断开 |
| 19 | content script 直 POST | 结果绕过 sendMessage | 已有但未出现 direct_result trace | fetch 未执行/claim 校验失败 |
| 20 | background 主动轮询 DOM 快照 | content script 定时 snapshot → backend delta | 已有 delta，待闭环 | delta 到达但 final 未到 |

## 当前真实基线

- API：`POST /v1/chat/completions`，Doubao，`timeout=120`。
- 结果：HTTP 504，job `job_1784597456478_539d1525`。
- trace：到 `visible_response_returned`，`text=""`；没有 `browser_capture_returned`、`browser_result_posted`、`direct_result_posted`。
- 旧请求曾出现 `visible_response_complete`，但这是旧页面/旧请求的 DOM，不可视为当前 API 成功。
- Chrome Canary/API/扩展 heartbeat 当前可见，ready/input_ready/send_ready 均为 true。

## 每个方案的统一测试记录格式

```text
strategy=<n>
request_id=<job id>
http_status=<status>
assistant_length=<length>
elapsed_ms=<duration>
last_trace=<kind>
result_post_status=<status or none>
```
