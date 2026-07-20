# Phantom Relay 通用适配器架构契约

本文件定义 Phantom Relay 的 provider-neutral 边界。目标是让新的网页 AI 站点通过录制模板、通用 DOM 发现或独立适配器接入，而不是把某个站点的选择器、内部字段或错误语义扩散到核心层。

## 1. 分层

```text
OpenAI-compatible HTTP
        ↓
Normalized Request / Response
        ↓
Idempotent Request Lifecycle
        ↓
Routing + Account/Session Lease
        ↓
Provider Adapter
        ├── Authenticator
        ├── Browser Runtime / HTTP Client
        ├── Request Builder
        ├── Stream Parser
        └── Error Classifier
        ↓
Unified Output Events
        ↓
OpenAI SSE / JSON Renderer
```

当前 Phantom Relay 已实现的核心路径：

```text
/v1/chat/completions
  → normalize_messages()
  → browser_prompt()
  → Idempotency-Key claim
  → browser job queue
  → exact-host tab selection
  → universal bridge / recorded site template
  → DOM logical-message reducer
  → stable snapshot / idle timeout
  → OpenAI JSON or SSE
```

## 2. 核心数据模型

### Normalized request

```text
request_id
idempotency_key
model
messages[]: role + normalized text
stream
request parameters
capability requirements
```

请求进入浏览器或 provider adapter 前必须完成归一化。核心层不得依赖 Claude/OpenAI/Gemini 的原始字段名。

### Unified output event

推荐内部事件类型：

```text
message_start
text_delta
reasoning_delta
tool_call_delta
usage
heartbeat
message_end
error
```

当前 browser bridge 主要输出最终 assistant 文本；未来需要将流式 DOM 快照转换为 `text_delta`，再由协议层编码。

### Provider capabilities

每个绑定或 adapter 应声明：

```text
streaming
vision
tools
native_reasoning
server_side_conversation
browser_required
```

OpenAI 兼容不代表能力完全等价。不支持的能力必须返回明确错误或经过显式策略降级，不能静默丢弃。

## 3. 请求幂等契约

发送动作之前必须完成原子 claim：

```text
new key + same fingerprint
  → owner
  → create one browser job

same key + same fingerprint
  → processing: return original job_id
  → completed: replay original response

same key + different fingerprint
  → 409 idempotency_key_conflict
```

浏览器已经可能提交、但 HTTP waiter 超时后，不能删除原 job，也不能创建第二个 job。`submit_once` 的责任属于 job/adapter 生命周期，不属于 HTTP 调用方。

## 4. Browser Adapter 边界

站点特例只能存在于以下位置：

```text
recorded selectors
site capability profile
provider-specific request builder
provider-specific stream parser
provider-specific error classifier
```

不得进入核心层：

```text
DeepSeek/Doubao 默认模型
特定站点内部 API 字段
特定网站 401/403 语义
固定 CSS selector
固定 Enter 或按钮策略
```

通用发送策略：

```text
recorded action
  → unique candidate discovery
  → one submission budget
  → fresh user-message evidence
  → explicit no-effect evidence 才允许 fallback
```

解析 fallback 与发送 retry 必须分离：

```text
selector failure → next extraction layer
send uncertain   → wait/observe, never blind re-submit
```

## 5. DOM 消息归并

DOM 读取先形成完整快照，再由 reducer 计算增量。不得将最后一个 markdown 节点直接视为回答。

逻辑身份优先级：

```text
data-observe-row
→ data-virtual-list-item-key
→ data-message-id
→ explicit logical key
```

同一个容器内的外层 row 与内层 message 节点可以合并；相同文本但不同逻辑 key 不得合并。

长快照 overlap：

```text
existing = A
incoming = A + B
emit = B

existing = A + B
incoming = A
emit = empty
```

短 token 不进行激进前缀裁剪，避免吞掉正常内容。

## 6. 完成判定

完成原因必须可观测：

```text
stable_snapshot
explicit_done
idle_timeout
no_content_timeout
content_filter
cancelled
upstream_error
```

推荐判定顺序：

```text
error
→ content filter / policy stop
→ explicit done marker
→ DOM completed marker
→ 有内容 + 稳定快照
→ 有内容 + idle timeout
→ 无内容 + no-content timeout
→ cancellation
```

当前实现已区分：

- `stable_snapshot`
- `idle_timeout`
- `no_content_timeout`

## 7. Account / Session 边界

未来引入多个 provider 或多个浏览器账户时，必须区分：

```text
Credential
  cookie / bearer / OAuth token

Browser Session
  profile / CDP / page / tab

Conversation Session
  upstream conversation id / parent message id / local history
```

账号运行状态不得写回静态路由：

```text
healthy
cooldown
expired
degraded
disabled
in_flight
```

固定账号失败时不得自动切换到另一个账号；非固定账号才可由账户池决定 fallback。

## 8. 重试与 fallback

错误先分类，再决定动作：

```text
auth_expired
forbidden
rate_limited
quota_exhausted
upstream_timeout
upstream_5xx
network_error
bad_request
unsupported_feature
stream_parse_error
client_cancelled
```

fallback 层级：

```text
刷新同一账户凭证
  → 同 provider 换账户
    → 满足能力约束的其他 provider/model
```

首个有效输出事件发给客户端之前可以切换；已经发出有效内容后，通常只能继续、终止或发送规范化错误，不能悄悄切换并重复输出。

## 9. 新 provider 接入清单

新增 provider 不得修改核心 HTTP handler 以加入站点条件。应提供：

```text
provider id
model registry
capability declaration
auth/session adapter
request builder
stream parser
error classifier
optional browser adapter
fixture tests
```

最低测试集合：

```text
相同 idempotency key replay
相同 key 不同 body conflict
发送动作只执行一次
DOM 外层/内层节点归并
长快照 overlap
旧快照 replay
短 token 不被吞掉
显式 done
stable snapshot
idle timeout
no-content timeout
stream parse error
unsupported capability
```

## 10. 研究依据与证据边界

已实际读取并用于架构参考的公开项目 README：

- `linuxhsj/openclaw-zero-token`
- `dreamhunter2333/chatgpt_reverse_proxy`
- `router-for-me/CLIProxyAPI`
- `skloxo/CPA2API`
- `browser-use/browser-use`

这些项目支持的可复用结论是分层、账户/会话管理、协议转换、流式事件和浏览器 runtime 边界。具体网站 token、内部字段、403 语义、选择器和 tool-call 标记仍属于 provider 特例，不能泛化到核心层。

仅搜索摘要、未作为代码级证据使用的项目：

- `Amm1rr/WebAI-to-API`

## 11. 当前验证命令

```bash
node --check extension/universal_bridge.js
node --check extension/content.js
node --check extension/background.js
node tests/test_universal_bridge.js
python3 -m py_compile server/api_server.py tests/test_api_idempotency.py
python3 tests/test_api_idempotency.py
git diff --check
```

当前已通过：

```text
UNIVERSAL_BRIDGE_TESTS_PASS
API_IDEMPOTENCY_TESTS_PASS
DIFF_CHECK_PASS
```
