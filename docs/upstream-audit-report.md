# 上游逻辑审计与 Phantom Relay 落地报告

审计版本：
- ds2api: 8316cf8a0352e900e03ce600b792083f590d80e2
- openclaw-zero-token: a654bcf2e6f3a3b45d2967adec75df177b87775a
- Phantom Relay 基线: 4f2cbae

## 结论

Phantom Relay 已经采用了两项目中最适合浏览器代理的基础路线：

1. OpenAI 兼容 HTTP 外壳，不把浏览器站点协议暴露给调用方。
2. 模型到站点域名的显式路由。
3. 后端任务队列 + 扩展轮询 + 精确域名/tab 校验。
4. 每个 conversation 创建独立执行 tab，避免旧 DOM 和旧页面状态污染。
5. 发送前 DOM 快照、发送后逻辑消息归并、流式增量、稳定快照和超时返回最长结果。
6. 录制选择器优先于自动猜测；页面响应区域可单独录制。
7. 上游返回的工具调用以浏览器可见文本协议承载，再归一化为 OpenAI tool_calls。

“不会封号”不能从源码或测试中证明。当前实现做的是降低无谓的页面/会话污染和异常重放，不是规避平台风控的保证。

## ds2api 文件逻辑矩阵

- `cmd/*/main.go`: 进程入口、配置加载、HTTP server 启动。
- `internal/httpapi/*`: OpenAI Chat、Responses、Claude、Gemini 兼容入口；校验请求、建立 turn、输出 JSON/SSE 和错误契约。
- `internal/assistantturn/turn.go`: turn 的统一中间模型；文本、思考、tool calls、stop reason、usage、空输出校验和重试判断。
- `internal/assistantturn/stream.go`: `text_delta`、`thinking_delta`、`tool_call`、`done`、`error`、`ping` 事件类型和累加快照。
- `internal/sse/*`: SSE 行解析、事件收集、断流和结束处理。
- `internal/toolcall/*`: tool call 检测、参数解析、schema 归一化、重复调用与已发调用标记。
- `internal/promptcompat/*`: tool_choice、请求消息、模型能力和不同 API 语义的兼容。
- `internal/deepseek/*`: 上游登录态、会话、请求发送、PoW/上传/代理、上游响应协议。
- `internal/account/*`: 账号池、凭据选择、账号状态和失败后的账号切换。
- `internal/chathistory/*`: 对话历史、parent message/session 继续和历史清理。
- `internal/responsehistory/*`: 响应缓存/历史恢复。
- `internal/config/*`: 环境变量、配置文件和模型/账号配置。

### 可复用到 Phantom Relay

- turn 中间模型：把原始页面快照、清洗后的可见文本、思考文本、工具调用、完成原因分开。
- 空输出判断：思考存在但可见答案为空，不能当成功；应区分 upstream unavailable、rate limit、content filter。
- 流式快照：增量输出和最终归约分离，避免把半截文本误当完整回复。
- tool_choice 约束、重复 tool call 去重、tool 参数 schema 归一化。
- session/parent message 思路可用于稳定 conversation_id。

### 不直接搬运

- DeepSeek 私有 API、PoW、账号池、自动换号和代理池属于 ds2api 的站点协议实现，不适合直接写入通用浏览器代理。
- 账号轮换不能被包装成“不会封号”；这会增加风控风险，也没有本地证据支持。

## openclaw-zero-token 文件逻辑矩阵

- `src/zero-token/bridge/web-providers.ts`: provider/model catalog、动态发现、模型 capability、contextWindow、maxTokens、reasoning/input 类型。
- `src/zero-token/providers/*-web-client-browser.ts`: 各站点浏览器客户端；登录态、页面导航、输入、提交、站点特有响应读取。
- `src/zero-token/streams/*-web-stream.ts`: provider 到统一 assistant event stream 的适配；输入消息变换、增量 partial、stop/error/usage。
- `src/zero-token/tool-calling/web-tool-prompt.ts`: 把工具定义压缩成网页模型可以理解的 prompt 协议。
- `src/zero-token/tool-calling/web-tool-parser.ts`: fenced/XML/文本中的工具调用解析、参数 JSON 处理。
- `src/zero-token/tool-calling/web-stream-middleware.ts`: 流事件中检测 tool call，发出 tool-use 事件，保证 done/error/end 顺序。
- `browser/src/browser/session-tab-registry.ts`: sessionKey 到 tab/page 的注册、归属和回收。
- `browser/src/browser/pw-role-snapshot.ts`: 页面 role snapshot、元素引用、动作目标和状态快照。
- `browser/src/browser/*`: snapshot、observe、click、type、press、scroll、wait、导航和 tab 生命周期。
- transcript/session 相关文件: JSONL/event 记录、partial assistant、tool result、compaction 和 session reset。

### 可复用到 Phantom Relay

- provider capability 表，而不是只维护 `deepseek`、`doubao` 两个字符串。
- sessionKey/conversation_id/tab_id 三元绑定。
- 页面响应使用快照/增量/完成三态，而不是一次性 DOM 查询。
- 工具调用采用网页可理解的显式格式，回传时统一转换为 OpenAI tool_calls。
- 统一 provider stream event：partial、done、error、tool_call、usage。
- 页面动作前检查 selector/页面归属，动作后重新 snapshot 验证。

### 不直接搬运

- zero-token 的通用浏览器动作能力很大，不能因为存在 `click/type` 就假设所有站点可用。
- “真人模拟”和“不封号”是产品目标，不是源码证明；本项目目前只保留正常 DOM 交互、页面隔离和错误恢复，不添加隐蔽规避检测逻辑。

## Phantom Relay 当前已使用 / 缺失

### 已使用

- `server/api_server.py`: OpenAI Chat 入口、模型路由、队列、idempotency、conversation_id、上下文拼接、SSE/结果归约。
- `extension/background.js`: 精确域名路由、conversation 独立 tab、tab_id claim、content script 注入、heartbeat、poll、result、delta。
- `extension/content.js`: 录制输入/发送/响应选择器，发送前快照，逻辑消息归并，流式候选和稳定判断。
- `extension/universal_bridge.js`: 消息规范化、文本清洗、思考/状态行过滤、快照合并、发送策略。

### 本轮补齐

- conversation_id 可由 `conversation_id`/`session_id`/`conversation` 传入并贯穿任务。
- 选择性工具 prompt：只有请求包含搜索、网页、文件、命令等工具语义且确实传 tools 时才注入。
- 网页工具调用解析：`tool_json` fenced block、`tool_call` XML、裸 JSON 三种形式。
- 工具调用回传为 OpenAI `assistant.tool_calls`，`finish_reason=tool_calls`。
- delta/result 保留 conversation_id、tab_id、tool_call。
- 状态/思考行清洗，避免“正在思考/正在搜索”污染最终答案。
- 覆盖工具解析、工具 prompt、conversation 绑定和状态过滤测试。

## 实测证据

代码检查：
- `pytest -q`: 5 passed
- `node tests/test_universal_bridge.js`: `UNIVERSAL_BRIDGE_TESTS_PASS`
- `node --check extension/background.js`: pass
- `node --check extension/content.js`: pass
- `node --check extension/universal_bridge.js`: pass
- `python3 -m py_compile server/api_server.py`: pass
- `git diff --check`: pass

接口检查：
- `GET /health`: `{"status":"ok","service":"phantom-relay-api"}`
- `GET /v1/models`: deepseek、doubao

真实浏览器端到端：
- DeepSeek：成功返回 `PHANTOM_RELAY_VERIFY_OK`，HTTP 200，正常 stop。
- Doubao：第一次扩展旧代码状态导致 timeout；手动在 Chrome Canary 的 `chrome://extensions` 重载后，第二次成功 HTTP 200，并实际产生 `/browser/delta`、`/browser/result`、`/v1/chat/completions` 200 日志。
- 过程中发现并修复 content.js 的 delta 回调使用错误作用域变量 `expectedConversationId`；修复后重新加载扩展并完成 DeepSeek/Doubao 回归。

## ds2api HTTP/API 入口审计补充

异步复核进一步确认 ds2api 的核心不是简单转发器，而是：

```text
多协议入口
  → body/UTF-8 边界校验
  → StandardRequest 统一规范化
  → model alias/capability 解析
  → auth/account lease
  → provider runtime
  → SSE/tool/thinking 归约
  → 协议专用 renderer
```

可迁移到 Phantom Relay 的重点：

- `StandardRequest`：把 model、messages、prompt、thinking、tools、tool_choice、stream、文件和 pass-through 参数放入统一请求对象，协议差异只留在入口/输出层。
- `ResolveModel`：请求模型先 lowercase/trim，再经过 native model、alias、no-thinking 变体和 capability 校验；不要在每个 handler 中写死模型判断。
- `response_store`：使用 caller/tenant + response_id 作为 key，配合 TTL，支持异步 response 查询；多实例时改用共享存储。
- `translatorcliproxy`：逐 SSE frame 缓冲、翻译、保留 comment/terminator、flush，并在客户端断连时传播 cancellation。
- `tool_choice` policy：校验 required/forced/allowed 工具是否在 tools 声明中，避免模型输出未声明的工具。
- schema-aware tool normalization：递归修正 object/array/string 参数，再生成 OpenAI `function.arguments`。
- prepare/release lease：长流式请求应把页面会话/执行资源视为 lease，开始时占用，结束/断连时释放。

不直接搬运：

- DeepSeek 私有 token、PoW、账号池、自动切换和私有上游协议不应混入 Phantom Relay 的通用浏览器层。
- ds2api 的 stream retry 在已经发出 reasoning 后可能产生不可撤回的跨 attempt 输出；Phantom Relay 当前没有透明 retry，后续若加入必须先做 attempt buffer。

文件级核心清单见异步审计结果，已核对的主要路径包括：

- `internal/server/router.go`
- `internal/httpapi/requestbody/json_utf8.go`
- `internal/auth/request.go`
- `internal/config/models.go`
- `internal/promptcompat/standard_request.go`
- `internal/promptcompat/request_normalize.go`
- `internal/promptcompat/message_normalize.go`
- `internal/promptcompat/responses_input_normalize.go`
- `internal/httpapi/openai/chat/handler_chat.go`
- `internal/httpapi/openai/responses/responses_handler.go`
- `internal/httpapi/openai/responses/response_store.go`
- `internal/httpapi/claude/handler_messages.go`
- `internal/httpapi/gemini/handler_generate.go`
- `internal/translatorcliproxy/stream_writer.go`
- `internal/js/chat-stream/proxy_go.js`
- `internal/js/chat-stream/toolcall_policy.js`
- `internal/js/helpers/stream-tool-sieve/format.js`


- openclaw-zero-token 的 CDP/Playwright、ARIA snapshot、locator/ref、截图、导航和 tab 生命周期是真实实现；当前 commit 的传统 extension relay 主路径已移除，existing-session 走 Chrome DevTools MCP，旧文档仍有残留描述。
- `local-managed`、`local-existing-session`、`remote-cdp` 能力不同；Phantom Relay 后续应引入 capability profile，claim 前校验 tab 创建/关闭/观察能力。
- 上游的固定 delay typing、DOM fallback 和真实浏览器 API 不构成真人模拟或反检测；源码未发现 stealth、指纹伪装、鼠标轨迹、随机行为画像或“不封号”保证。
- 可以迁移 snapshot → ref → action → snapshot 验证循环、ref 失效后重新观察，以及 loopback/auth/导航 host/SSRF 防护；不应把这些包装成规避平台风控。
- 现行扩展 heartbeat 已上报 `transport` 和 `capabilities`，后端会保存 `can_observe/can_execute/can_stream/can_create_tab/can_close_tab/can_snapshot`；目前尚未让 claim 根据所有 capability 做复杂调度。
- 已进一步把 `can_observe && can_execute` 作为 browser job claim 的最低门槛；能力不足的 tab 不会消费队列任务，并有回归测试覆盖。
- 新增只读 `GET /browser/status`，返回脱敏的 browser clients、能力 profile、活动任务和队列深度；不会暴露未列入白名单的 client 字段。
- OpenClaw browser-tool 的通用 `snapshot/act/tabs/wait` 差距已确认；Phantom 仍是聊天领域 relay，不伪装成通用浏览器自动化工具。当前新增的是 status/capability 观察面，不是通用 action schema。
- zero-token provider 审计确认：统一抽象应是 `provider catalog → auth profile → browser/page transport → provider stream adapter → common assistant events`；各站点的 Cookie/token、conversation/parent ID 和页面/API 协议不能混为一个通用凭据字段。
- 当前 Phantom 的 `model → hostname + selector template` 路线只适合已录制的聊天站点；尚未实现 provider capability catalog、认证 profile、持久 provider session/parent 链或多 provider stream adapter，因此不宣称已具备 zero-token 的 provider 广度。
- provider 目录、认证白名单、真实 model/assistant 映射在上游分散维护；后续若扩展 Phantom，应在单一 registry 中校验模型路由、域名、能力和 selector 版本，避免静态目录漂移。
- Qwen 国内/国际命名在上游存在文档/代码不一致；Phantom 目前不复制该命名，不新增未经实测的 provider 别名。
- OpenClaw session-tab-registry 审计确认：上游是 `session → tab 集合` 的弱追踪，profile 级 `lastTargetId` 仍可能跨会话串页，并非严格的一对话一页面所有权模型。
- Phantom 已新增最小 owner binding：`(conversation_id, domain) → tab_id`，heartbeat/ready 会更新绑定；claim 时若已有绑定且 tab 不匹配则拒绝跨 tab 消费任务。当前 binding 仍是进程内、TTL 约束，尚未做持久租约、显式 rebind 或 session lifecycle 自动关闭 tab。
- browser status 现会脱敏展示 bindings；扩展仍需持续携带 conversation_id，不能只依赖 tab/domain。
- zero-token 人类交互审计确认：ChatGPT/Gemini/Perplexity 等少数路径只有固定 20ms 打字和固定 300–1500ms 等待；大量 provider 仍是页面内 fetch/API 调用。未发现随机节奏、鼠标轨迹、账号级限速、429/Retry-After 策略或不封号保证。
- AskOnce 的指数退避属于编排层错误重试，不等于 provider 风控控制；多 provider `Promise.allSettled` 并发可能放大请求压力，且未见通用幂等防重复发送。Phantom 不迁移该并发广播语义，继续使用 job claim、idempotency 和 tab/conversation binding。
- 上游页面生命周期的 `browser/context/page` 缓存不保证对象仍连接或仍位于正确站点；Phantom 继续以 heartbeat、ready、TTL、稳定 DOM snapshot 和显式 completion_reason 作为页面可用性边界，不把非空对象当作 ready。
- 针对 Phantom 自身审计新增了 job actor 完整性校验：job 创建时生成 `claim_token`；delta/result 必须同时匹配 token、tab_id、conversation_id、domain；poll 不再允许覆盖 job 原始 conversation_id。
- terminal job 状态转移已收紧：`claimed → completed/failed` 后不可被迟到结果反向覆盖；result 持久化使用 job 原始 user/model，而不是信任扩展回传字段。
- recorded response selector 已加入发送前 anchor/key/text 新鲜度判断；direct content-script poller 已禁用，避免绕过 background scheduler 和 tab identity。
- zero-token transcript 审计已纳入迁移边界：持久化应区分 session registry、append-only transcript、runtime partial；assistant partial/tool partial 只属于运行态，最终 assistant/toolResult 才写 durable transcript；compaction、branch parentId、session reset lineage 和跨进程 transcript lock 不能被压平成 conversations.json 的 user/assistant pair。
- Phantom 已让完成 turn 保存 `conversation_id`、`job_id`、`completion_reason`，但当前 JSON 文件仍不是完整 transcript store；尚未迁移到 JSONL/SQLite，也未实现 partial runtime snapshot、tool-result pairing、compaction 或 reset lineage。
- `new_tab` 执行路径增加 reservation_tab_id 优先复用，且不再因 new_tab 在已选中同域 tab 后重复创建第二个 tab；服务端仍需在后续实现 reservation 的持久化与过期回收。
- zero-token tool-calling 审计已落地为当前桥接层的最小安全增强：Universal parser 现在使用带字符串转义处理的平衡括号扫描，限制 payload 64KiB、校验工具名格式、要求 parameters/arguments 为 object，并覆盖嵌套对象与花括号文本回归测试。
- Phantom 的工具调用仍是“DOM 文本 → `tool_call` → OpenAI `tool_calls`”适配，不是本地工具执行器；关键词只负责 prompt 预过滤，不构成权限边界。工具授权、循环上限、执行和 tool result 回填仍属于后续 runtime 设计。
- zero-token extension 审计已落地轻量 identity 层：content document 生成 `page_session_id`；trace/capture_progress/capture_delta/page_ready 携带该 ID；background 按 `tabId + page_session_id + frameId` 记录当前页面运行态，拒绝旧 document 的 trace/progress/delta，并按 seq 丢弃重复 trace。
- 当前仍保留 content-script DOM bridge，没有迁移 zero-token 的 `chrome.debugger`/CDP relay；因此 tab replacement、导航 reattach、断线事件重放和可靠 ACK 队列仍未实现。
- 审计总编辑建议的 P1 capability registry 已先落地：`model_routes.json` 支持 provider/adapter/target/capabilities 元数据；`/v1/models` 返回 capability profile；请求包含未声明支持的 tools、vision/multimodal 或 structured output 时返回 `unsupported_capability`，不再静默降级为普通文本。
- 独立复核提出的边界问题已修复：claim 现在强制要求 job 的 conversation_id；result/delta 已统一使用 claim_token + tab_id + conversation_id + domain actor 校验；记录 response region 必须相对发送前 identity/text 产生新证据；tool_choice required/auto/指定 function 会强制注入工具协议；结果工具名必须属于本次请求的 tools allowlist；流式工具调用及 idempotent replay 返回 `delta.tool_calls` 与 `finish_reason: tool_calls`。
- zero-token 145 个生产核心文件的 provider/stream/bridge/tool-calling/browser 职责矩阵已归档至 `docs/upstream-web-provider-browser-matrix.md`；该文件只读审计上游源码，未把 provider token/auth、CDP/Playwright 生命周期或 provider-native parser 直接复制进 Phantom Relay。
- ds2api 的 `internal/httpapi`、`assistantturn`、`sse`、`toolcall`、`account`、`chathistory`、`responsehistory`、`promptcompat`、`deepseek` 文件职责矩阵已归档至 `docs/ds2api-internal-audit.md`；重点保留其请求规范化→统一 turn/event→协议 renderer、账号池/持久化/错误边界，未直接搬运 DeepSeek token/PoW/协议实现。
- 最终独立复核发现的 streaming tool-call 协议缺口已修复：新增统一 `openai_stream_chunks()`，live stream、非流式完成后的 stream、以及 idempotent replay 共用同一编码；工具调用发送 `delta.tool_calls` 并以 `finish_reason: tool_calls` 结束，普通文本保持 `content`/`stop`。
- ds2api 的跨请求浏览器对话建议仍应保持三层 ID：`browser conversation_id → owner-scoped conversation → upstream session_id + parent_message_id`；当前 Phantom Relay 只实现上层 conversation/tab 绑定，尚未持久化 provider session/parent message 链。
- ds2api 的 Claude/Gemini 断连、SSE 写错误和 handler 错误契约问题属于上游审计发现，不应直接复制到 Phantom Relay；本项目当前以浏览器任务超时、heartbeat、结果归并和 OpenAI SSE 终止为边界。
- `IDEMPOTENCY` 目前为进程内状态，已加入 24 小时懒清理；多实例部署仍需共享存储。
- 账号健康/cooldown、代理熔断、backoff+jitter 尚未迁移；当前 Phantom Relay 不做账号/代理轮换规避平台封禁。
- 真实网页工具调用已完成“页面文本 -> 结构化 tool_calls”以及 OpenAI Chat 非流式/流式输出层；尚未实现 Phantom Relay 自己执行任意工具并把 tool result 再回送网页模型的完整闭环。
- 多 provider capability catalog、自动发现、完整 transcript compaction 仍是后续工程项，不应伪称已经完成。
- 根据 ds2api 流式审计补强了累计 DOM snapshot 的前缀/重叠归并、SSE heartbeat、最终 stop/DONE，以及流式 tool_calls 的 finalization。
- 本报告和代码修改均未提交远程仓库。
