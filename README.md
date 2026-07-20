# Phantom Relay

Phantom Relay 是一个运行在 Google Chrome Canary 中的本地 AI 网页代理：它把用户已经登录的 AI 网页会话包装成本地 OpenAI-compatible HTTP API。

它不是直接调用 provider 私有 API 的客户端，也不是预置好所有网站的“全球 AI 搬运器”。它的主路径是：

```text
OpenAI-compatible request
  -> local Python API :8765
  -> model -> exact hostname route
  -> Chrome Canary MV3 background worker
  -> recorded DOM/input/send contract
  -> page DOM logical-message extraction
  -> JSON response or browser-backed SSE
```

本 README 区分三件事：上传代码本身包含什么、用户首次运行时需要自己配置什么、当前在本地环境中实测通过了哪些网站。未来目标单独列出，不把设计文档当成已完成能力。

## 当前结论

截至本次实测，项目的能力上限是：

- 在用户自己登录的 Chrome Canary 页面中，按 hostname 绑定一个模型别名。
- 新安装/上传的代码不携带作者机器上的模型路由、选择器、会话记录或 trace；这些运行时数据由用户自己录制和生成。
- 通过录制的输入框和发送策略，向目标 AI 网页提交一次文本请求。
- 从页面 DOM 中识别新用户消息之后的 assistant 消息，并转换为 OpenAI 风格 JSON。
- 将页面增长中的 DOM 快照转换为 SSE 内容增量；这不是上游 token 流。
- 当前作者本地环境实测通过了 DeepSeek 和 Doubao；这只是兼容性实测结果，不代表上传代码会预置这两个站点的配置。
- 处理 OpenAI `messages` 的 `system`、`developer`、`user`、`assistant`、`tool` 角色，但旧上下文会被串成文本后再输入网页，并不等于 provider 原生多轮会话。
- 通过 `Idempotency-Key` 防止同一个请求在 API waiter 超时或客户端重试时重复创建浏览器任务。

当前明确不能声称：

- 已经无录制支持任意 AI 网站。
- 已经支持所有 README 或 manifest 中列出的站点。
- 已经实现 provider 原生 API、token 级流式、OAuth、账号池、工具调用或多模态。
- 已经实现真正并行的多标签页执行。

## 实测证据

本次在现有运行环境中执行了以下检查：

```text
GET /health                         -> 200, service=phantom-relay-api
GET /v1/models                      -> 用户完成录制/绑定后返回模型；新安装默认为空
GET /model-routes                   -> 用户本地运行时路由；新安装默认为空
GET /browser/clients                -> 用户本地 Canary tab heartbeat
POST /v1/chat/completions           -> PR_RUNTIME_OK
POST /v1/chat/completions stream    -> STREAM_OK + valid SSE + [DONE]
Idempotency-Key replay              -> same response, idempotent_replay=true
Unknown model                      -> 400 model_route_missing
API idempotency tests               -> API_IDEMPOTENCY_TESTS_PASS
Universal bridge tests              -> UNIVERSAL_BRIDGE_TESTS_PASS
JavaScript/Python syntax checks     -> pass
```

真实端到端非流式请求的返回形状：

```json
{
  "id": "chatcmpl-job_<timestamp>_<suffix>",
  "object": "chat.completion",
  "model": "deepseek",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "PR_RUNTIME_OK"},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 21,
    "completion_tokens": 3,
    "total_tokens": 24
  }
}
```

真实流式请求返回了：

1. role chunk
2. 多个 `: heartbeat`
3. 页面 DOM 变化后产生的 `STREAM_OK` content chunk
4. `finish_reason: stop`
5. `data: [DONE]`

因此 `stream=true` 的真实语义是“浏览器 DOM 快照增量转 SSE”，不是上游模型 token 转发。

## 安装与运行

### 1. Chrome Canary 扩展

只使用 Google Chrome Canary，不要使用普通 Chrome。

在 Canary 打开：

```text
chrome://extensions/
```

然后：

1. 打开 Developer mode。
2. 选择 Load unpacked。
3. 选择本仓库的 `extension/` 目录。
4. 打开目标 AI 网站。
5. 点击 Phantom Relay 扩展图标。

项目的 `launch.sh` 可以用来加载扩展，但它会尝试退出并重新启动 Chrome Canary。不要在已有重要会话时盲目执行它。

### 2. 本地 API

```bash
cd ~/Desktop/phantom-relay
python3 server/api_server.py
```

默认监听：

```text
http://127.0.0.1:8765
```

`server/run-api.sh` 会先检查健康接口，已有健康实例时复用，不再启动第二个实例。

上传代码时，作者机器上的运行时数据不会进入仓库。以下文件被 `.gitignore` 排除：

```text
server/model_routes.json
server/selector_templates.json
server/conversations.json
server/page-trace.jsonl
```

它们由用户自己的录制、模型绑定、对话执行和诊断过程生成。干净安装没有作者机器上的 DeepSeek、Doubao 模板或历史对话。

## 首次接入一个站点

每个用户、每个浏览器配置文件、每个网站都要自己完成录制。项目上传包只提供录制器、回放器和 API，不提供作者本地站点配置。

### Step 1：录制输入框

在扩展 popup 中点击输入框录制，然后在网页上点击实际的 textarea、input 或 contenteditable。

选择器生成顺序由 `extension/content.js` 实现：

1. 唯一 `id`
2. 唯一 data 属性
3. `aria-label`
4. 唯一 tag + class
5. 最多六层的 CSS path

录制结果按 hostname 保存，不会自动把父域名模板当作当前 hostname 的模板。

### Step 2：选择发送策略

当前发送策略有三种：

- `enter`：向输入框派发一次 `keydown`。
- `shortcut`：录制并派发一次键盘快捷键；只有模板显式允许时才允许 Enter fallback。
- `button`：等待录制的发送元素出现并启用，然后只调用一次 `click()`。

发送逻辑有明确的一次提交预算。发送后必须观察到新的用户消息证据；没有证据时，不会盲目再点一次，以避免重复提交。

### Step 3：回复区域

popup 当前显示为“回复区域”，不是旧版的“录制复制按钮”。点击一个已经存在的 AI 回复正文，可以保存回复锚点。

运行时的主要提取路径是逻辑消息快照和消息身份归并，不依赖点击 copy 按钮才能完成回复提取。旧版 copy 相关代码仍保留兼容路径，但不是当前 API 主路径的能力承诺。

### Step 4：绑定模型别名

在 popup 的模型输入框中填入一个你自己的模型别名，例如：

```text
deepseek
```

然后将它绑定到当前 hostname。这个绑定写入用户自己的运行时存储；模型路由只负责决定目标网页，选择器由用户当前浏览器配置或本地运行时模板提供。

完成上述录制和绑定之前，`/v1/models` 不会出现可调用模型，API 也不会凭空知道要使用哪个网站。

## OpenAI-compatible API

### 健康检查

```bash
curl http://127.0.0.1:8765/health
```

### 模型列表

```bash
curl http://127.0.0.1:8765/v1/models
```

模型列表来自用户本地运行时路由。新安装时路由为空；以下示例只表示本次作者本地实测环境的结果，不会随上传代码提供给用户：

```json
{
  "object": "list",
  "data": [
    {"id": "deepseek", "object": "model", "created": 0, "owned_by": "phantom-relay"},
    {"id": "doubao", "object": "model", "created": 0, "owned_by": "phantom-relay"}
  ]
}
```

### 非流式调用

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek",
    "messages": [
      {"role": "user", "content": "只回复 OK"}
    ],
    "timeout": 120
  }'
```

### 流式调用

```bash
curl -N -sS -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek",
    "stream": true,
    "messages": [
      {"role": "user", "content": "只回复 STREAM_OK"}
    ],
    "timeout": 120
  }'
```

### 多轮 messages 的实际语义

服务端会保留消息角色顺序，并支持字符串内容和 text-part 数组。但目标网页没有统一的原生 API，因此多轮上下文会被格式化成一段文本：

```text
【以下是对话上下文，请基于它回答最后一个用户问题】

系统：...

助手：...

用户：当前问题
```

这是一种文本上下文注入，不是 provider 原生 conversation id、parent message id 或服务端会话续接。

### 请求参数边界

服务端会把以下字段放入任务元数据和请求指纹：

```text
temperature
top_p
max_tokens
max_completion_tokens
stop
frequency_penalty
presence_penalty
stream
```

但当前网页 DOM 主路径没有把这些参数转换为目标网站的原生控制项。因此不能把 OpenAI 兼容请求字段写成“已经被目标模型完整支持”。当前核心可靠保证是消息文本、路由、单次发送、结果提取和协议外形。

## 当前支持范围

### 作者本地实测结果

本地作者环境中，DeepSeek 和 Doubao 都曾经完成过真实网页代理回归。这里的“通过”只说明这两个站点在当前本地登录态、当前页面版本和当前录制结果下验证成功；不表示上传代码自带这两个站点配置，也不表示其他用户无需录制即可直接使用。

| 项目 | 当前状态 |
|---|---|
| DeepSeek 网页文本请求 | 作者本地实测通过 |
| Doubao 网页文本请求 | 作者本地实测通过 |
| Chrome Canary MV3 扩展 | 源码实现，作者本地运行过 |
| hostname 路由 | 用户完成录制/绑定后生效 |
| Enter / shortcut / button 发送策略 | 源码实现，单元测试覆盖发送预算；每个站点仍需用户自己录制并验证 |
| DOM 逻辑消息归并 | 单元测试通过；作者本地 DeepSeek 实测命中消息节点 |
| reasoning/status 行过滤 | 单元测试通过；只处理可从 DOM 识别的状态文本 |
| JSON 响应 | 作者本地 DeepSeek 实测通过 |
| SSE 响应 | 作者本地 DeepSeek 实测通过 |
| 幂等 replay/conflict 基础逻辑 | 单元测试通过，作者本地 replay 已验证 |
| trace 与 heartbeat | 源码实现，作者本地运行时可读取 |
| 本地对话保存 | 源码实现；用户自己的运行时数据不会上传到代码仓库 |
| JSON 导出 | 扩展 popup 源码实现；服务端没有导出 HTTP 端点 |

### 用户首次安装后的实际状态

上传代码后，用户拿到的是空的代理框架：

- 没有作者本地的 DeepSeek 路由。
- 没有作者本地的 Doubao 路由。
- 没有作者录制的输入框、发送按钮或回复锚点。
- 没有作者的历史对话、trace 或登录态。
- 用户需要打开自己已登录的 AI 网站，逐步录制输入框、发送策略和回复区域，再绑定自己的模型别名。
- 录制和绑定完成后，模型才会出现在用户自己的 `/v1/models` 中。

### 当前不能按“支持”宣传的范围

manifest 中的 `host_permissions` 覆盖很多域名，但这只表示扩展被允许注入，不表示这些网站已经完成适配。

源码没有随 Git 上传作者本地的 `server/model_routes.json`、`server/selector_templates.json` 或 `server/conversations.json`；这些文件由 `.gitignore` 排除。下面的内容只能作为作者本地实测记录，不能当作发行版预置配置：

```text
deepseek -> chat.deepseek.com
doubao   -> www.doubao.com
```

`chat.qwen.ai` 虽在作者本地某份运行时路由文件中出现，但本次没有端到端通过证据，也不应在发行版中宣传为预置支持。

因此 ChatGPT、Claude、Gemini、Copilot、Kimi、通义、文心、Poe、Perplexity、Mistral、智谱、讯飞、HuggingFace 等不能仅凭 manifest 中的域名列表视为已支持；它们需要用户自己录制，并且还需要真实回归验证。

## 可靠性和边界

### 1. 页面结构变化

录制模板是当前站点执行契约。页面修改 class、输入框结构、发送按钮结构或消息节点身份后，模板可能失效，需要重新录制。

系统会尝试通用发现输入框和发送按钮，但这只是有限 fallback，不是任意网站适配器。

### 2. 回复识别

当前通过以下信息建立逻辑消息快照：

```text
data-observe-row
data-virtual-list-item-key
data-message-id
```

同一逻辑消息的外层 row 和内层节点可以合并；相同文本但没有相同身份不能随意合并。

完成判定主要是：

- `stable_snapshot`：文本连续稳定且页面标记为非 streaming。
- `idle_timeout`：超时但已经有最长候选文本，返回部分结果。
- `no_content_timeout`：超时且没有有效 assistant 文本。

因此页面一直处于加载状态、回复被截断、消息节点没有稳定身份或页面没有可读 DOM 时，结果可能失败或返回部分文本。

### 3. reasoning 与状态

通用层会过滤“正在思考”“正在搜索”“reading”“reasoning”等状态行，以及带有 status/progress/loading/thinking 等语义的元素。

这不等于恢复了 provider 的隐藏 reasoning，也不保证区分所有网站的真实思维内容。若真实回答和状态文本混在同一个无语义节点中，只能进行保守过滤。

### 4. 并发

当前浏览器执行路径通过单个本地 job queue 和后台 poll/claim 机制工作。已实现的是安全排队和幂等，不是多账号、多 tab 的真正并行执行能力。

并发请求的目标应该是“不会错误重复发送”，而不是“多个网页模型同时高速执行”。

### 5. 安全边界

API 默认绑定 `0.0.0.0:8765`，但文档和实际调用使用本机 `127.0.0.1`。当前代码没有认证层，也没有 API key 校验。不要把该端口暴露到公网或不可信局域网。

Chrome Canary 的登录态由用户自己持有；服务端不启动浏览器、不读取 cookie、不实现 OAuth refresh。

## API 与运行时端点

### 对外主要端点

```text
GET  /health
GET  /model-routes
GET  /v1/models
POST /v1/chat/completions
```

当前源码没有实现 `/export/jsonl`、`/export` 或其他对话导出 HTTP 端点。对话导出目前是扩展 popup 中的 `导出 JSON` 操作，不应把它宣传成服务端导出 API。

### 浏览器桥接端点

```text
GET  /browser/clients
GET  /browser/pending-domains
GET  /browser/selectors?domain=<hostname>
POST /browser/sync-routes
POST /browser/selectors
POST /browser/submit
POST /browser/poll
POST /browser/heartbeat
POST /browser/ready
POST /browser/delta
POST /browser/result
```

### 诊断端点

```text
POST /trace
GET  /trace/tail?limit=20
```

## 数据与持久化

上传发行版不包含作者本地运行时数据。以下路径是运行时生成或用户本地保存的数据，不属于代码能力，也不会随 Git 上传：

```text
server/model_routes.json       用户绑定的模型别名 -> hostname
server/selector_templates.json 用户保存的站点选择器模板
server/conversations.json      用户本地对话记录
server/page-trace.jsonl        用户本地页面诊断 trace
```

它们已被 `.gitignore` 排除。干净安装时这些数据为空，用户必须自己打开已登录网站、逐站录制并绑定模型。

扩展使用 `chrome.storage.local` 保存：

- 每个 hostname 的选择器模板
- 每个 hostname 的录制状态
- 模型路由
- 已抓取对话
- 调试日志

服务端保存：

```text
server/model_routes.json
server/selector_templates.json
server/conversations.json
server/page-trace.jsonl
```

`server/stats.json` 在常量中定义，但当前主代码没有形成完整的统计 API。

## 测试

```bash
cd ~/Desktop/phantom-relay

node --check extension/universal_bridge.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
python3 -m py_compile server/api_server.py
python3 -m py_compile tests/test_api_idempotency.py

node tests/test_universal_bridge.js
python3 tests/test_api_idempotency.py
```

当前仓库内的自动测试覆盖：

- message normalization
- send strategy 与一次提交预算
- shortcut fallback 的证据门槛
- logical message merge
- fresh user/assistant detection
- stable snapshot completion
- status/reasoning filtering
- snapshot overlap delta
- idle timeout partial response
- Idempotency-Key single owner
- same key different body conflict
- completed response replay

这些测试不能替代真实网站回归。真实网站回归还必须检查：

1. 当前 Canary tab 是否仍在目标 hostname。
2. 录制的输入框是否唯一、可见、可写。
3. 发送策略是否只提交一次。
4. 新用户消息是否出现。
5. assistant DOM 是否能被逻辑身份识别。
6. 页面完成后是否能返回完整文本。
7. `/trace/tail` 是否记录了完整生命周期。

## 测试证据边界

仓库当前没有自动化 Chrome Canary E2E 测试。本文中的 DeepSeek 端到端结果来自本次运行时手工发起的本地 API 请求，并由当时在线的 Canary tab 完成；`tests/` 目录中的测试是纯逻辑/API 幂等测试，不是浏览器 E2E。

因此，“DeepSeek 已验证”表示本次环境中的真实回归成功，不表示在干净机器、全新登录态或未来页面版本中永久保证成功。

## 当前能力上限

把当前版本当作以下产品来使用最准确：

> 一个交付给用户后由用户自己录制站点、自己绑定模型、复用自己登录态的本地 AI 网页代理。
>
> 作者当前已实测 DeepSeek 和 Doubao，但发行包不是“只支持 DeepSeek/Doubao”的硬编码客户端；它的目标是让用户通过录制把其他网页 AI 接入为本地 OpenAI-compatible 模型。

它的能力边界是：

- 代码提供通用录制、回放、DOM 回复识别、任务队列和 OpenAI-compatible API。
- 站点适配数据不随代码发布，用户必须逐站录制。
- DeepSeek 和 Doubao 是当前作者本地已验证的兼容性样本，不是发行包预置能力。

它适合：

- 给已经登录的网页 AI 增加一个本地 OpenAI-compatible 接口。
- 把简单文本请求交给网页执行。
- 在没有公开 API 的情况下复用现有浏览器会话。
- 记录页面 DOM 变化并调试站点适配。
- 把已抓取的问答导出为基础 JSON 数据。

它目前不适合：

- 作为公网 SaaS API。
- 作为高并发模型网关。
- 作为完整 OpenAI API 替代品。
- 作为带工具调用、图片理解、文件上传、音频、原生 reasoning 和原生会话的统一 provider 层。
- 在不录制、不维护模板的情况下承诺任意网站长期稳定。

## 未来目标

未来目标按优先级分为四层。以下是目标，不是当前已完成能力。

### P0：把当前 DOM 路径做成可维护产品

- 为每个已接入网站建立真实回归 fixture 和 Canary 端到端测试记录。
- 将输入、发送、回复识别拆成明确的 site capability profile。
- 为选择器失效、输入框不可写、发送无效、回复超时提供稳定错误码。
- 将任务状态、页面状态、回复完成原因统一成可查询的生命周期。
- 明确单浏览器会话的串行执行模型，并为队列增加取消、超时回收和队列长度指标。

### P1：provider adapter 层

- 将 DeepSeek、Doubao 等站点从核心 handler 中拆为独立 adapter。
- 每个 adapter 声明文本、图片、工具、stream、reasoning、conversation 的真实能力。
- 将站点特有的 DOM 识别、内部请求、错误分类和流解析隔离。
- 不支持的 OpenAI 参数返回明确的 unsupported capability，而不是静默忽略。

### P2：更接近真实 API 的协议能力

- 对可安全使用的站点实现 browser-context fetch 或 provider web API adapter。
- 只有能够取得真实增量边界时，才宣传 token/event 级流式。
- 增加 tool call、structured output、vision、文件输入的统一事件模型。
- 实现真正的 usage 统计，而不是基于字符长度的近似 token 估算。

### P3：多会话与生产化

- 多 Chrome profile 或 CDP session 的账号/会话租约。
- 账号健康状态、限流、冷却、过期和明确的 fallback 策略。
- API 鉴权、访问控制、审计日志、敏感数据隔离和安全默认值。
- 多 tab 并行，但保留同一会话内的串行约束和重复发送保护。
- 可观测性：请求、job、tab、消息、流事件之间的统一 trace id。

## 源码事实索引

主要事实来源：

```text
extension/manifest.json       MV3、权限、content script 匹配范围
extension/background.js        状态、存储、路由、后台 job claim、heartbeat、trace
extension/content.js           录制、输入注入、发送、DOM 快照、回复完成判定
extension/universal_bridge.js  通用文本归一化、发送预算、消息归并、快照增量
extension/popup.js             录制流程、模型绑定、抓取提交、导出
server/api_server.py           HTTP API、路由、job queue、幂等、SSE、持久化
server/model_routes.json       当前模型别名与 hostname 路由
server/selector_templates.json 当前服务端选择器模板
 tests/                         纯逻辑回归测试
 docs/universal-adapter-architecture.md 未来 adapter 架构契约
```

如果源码和这份 README 再次不一致，以源码和真实运行结果为准；README 应随下一次实际回归一起更新。
