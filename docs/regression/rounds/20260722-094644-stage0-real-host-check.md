# Round 000 — Stage 0 — real-host-check

- 时间戳：2026-07-22T09:46:44+0800
- 证据等级：baseline / unverified
- Git HEAD：`4f2cbae028af81716d0aa52255ed991355d5b120`
- origin/main：`37216e0d25b8088be5c08db588105ad7151e635a`
- 工作树：相对 HEAD 存在大量未提交业务改动和临时运行产物。

## 真实用户场景

原计划：在真实 GUI Canary 中，通过真实扩展和用户录制的 input/send/response，对豆包/DLM执行第一条短非流式请求。

## 录制三要素

本轮只读取规则和工作树配置，没有把配置冒充为页面实测：

- 豆包：input 存在；send 配置当前为 Enter 对象；response 配置需进一步核实。
- DLM/DeepSeek：input + CSS send button；response 配置当前为空，属于真实回归前配置缺口。

## 环境检查

- API `:8765`：未监听。
- CDP `:9334`：未监听。
- 真实 GUI Canary 进程：未发现。
- browser wake helper：未发现。
- computer-use 可见应用：空。

## 本轮动作

- 读取录制规范。
- 读取 Git HEAD、origin/main、工作树状态。
- 检查真实 GUI/API/端口。
- 未启动浏览器。
- 未启动 API。
- 未发送请求。
- 未修改业务代码。
- 未运行静态审计。

## 结果

`unverified`：真实宿主不可用，不能进入真实 E2E。没有任何产品成功证据。

## 阻塞边界

真实 GUI 扩展宿主不存在；继续执行只能变成临时 profile 或模拟链路，违反最终验收规则。

## 下一轮唯一动作

真实 GUI Canary 和已加载扩展宿主可用后，重新检查 `/browser/clients`，确认真实 content-ready heartbeat，再执行豆包/DLM第一条短非流式请求。