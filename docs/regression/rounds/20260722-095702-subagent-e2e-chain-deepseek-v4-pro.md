# 子 Agent 只读报告 — E2E链路

- 完成时间：2026-07-22T09:57 左右
- Agent模型：deepseek-v4-pro
- 证据等级：bridge analysis / not E2E
- 禁止事项遵守：未改文件、未启动浏览器、未使用CDP执行、未手工POST result。

## 结论

当前真实链路为：

```text
/v1/chat/completions
→ new_browser_job
→ extension browserBridgeTick
→ ensureContentScript
→ /browser/poll claim
→ auto_capture
→ recorded input/send
→ recorded response capture
→ browser_result_relay
→ /browser/result
→ API caller body
```

无真实宿主时不能推进，因为 claim 依赖真实 Chrome tab、content script、ready heartbeat、DOM input/response 和 capability gate。API服务本身不会替代浏览器执行。

## 当前最短真实验证路径

前置：API运行、真实GUI Canary已加载扩展、`/browser/clients`出现`source=content-ready`、ready/input_ready/send_ready为真、can_execute=true。

第一条真实请求应选择豆包：

```text
model=doubao
stream=false
短固定回复请求
```

最终只看调用方HTTP body：HTTP 200 + 非空 `choices[0].message.content`。

## 关键风险

- 当前没有真实GUI宿主，因此本轮不能执行E2E。
- DeepSeek当前response配置为null，是配置缺口；不应先作为第一个验证站点。
- 模板和content脚本策略必须继续遵循录制规范，不得由CDP或通用DOM扫描替代。

## 下一唯一动作

真实宿主出现后，检查 `/health` 和 `/browser/clients`，确认真实 content-ready heartbeat 与 can_execute，再发送第一条豆包短非流式请求。