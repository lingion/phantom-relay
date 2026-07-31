# Phantom Relay Phase A：Profile Lifecycle 设计

日期：2026-07-31
状态：待用户审核
推进顺序：A Profile lifecycle → B Browser runtime recovery → C Advanced capabilities

## 1. 目标

把“用户录制一次页面操作”提升为可长期复用的浏览器适配 profile：

```text
录制
→ 本地校验
→ 本地保存
→ 后端同步
→ model/profile 绑定
→ 页面加载
→ profile 健康检查
→ API 请求复用
→ 页面刷新、插件重载、后端重启后继续复用
```

Phase A 的完成标准不是“profile 文件成功写入”，而是：

> 用户不需要修改核心代码；只要插件和后端仍然存在，已经录制的 profile 在正常重启和页面刷新后仍能被找到、校验、执行；失效时必须返回可解释的诊断证据。

## 2. 当前上下文

当前代码已经存在以下基础：

- `extension/profile_contract.js`：profile normalizer、identity、role、streaming 和 text normalization；
- `extension/content.js`：录制输入、发送、回复区域和自动捕获；
- `extension/background.js`：`chrome.storage.local`、browser client registration、selector/profile 同步；
- `server/registry.py`：model registry、profile registry、user bindings 的边界；
- `server/api_server.py`：profile selector 兼容接口、分离 registry 加载和 browser client contract；
- `tests/test_isolated_dom_runtime.py`：direct、contenteditable、nested、virtualized generic DOM 运行时验证。

当前问题是生命周期语义分散：本地 selector、完整 profile、domain state、model route 和后端 profile registry 之间没有统一的版本、状态、校验和冲突规则。

## 3. 非目标

Phase A 不实现以下内容：

- 不增加任何具体 AI 网站或模型的核心分支；
- 不读取 cookie、localStorage、sessionStorage、密码、token 或浏览器 Keychain；
- 不自动导入用户的浏览器登录凭据；
- 不把旧 selector-only 数据偷偷升级为可执行 profile；
- 不在 profile 失效时自动切换到未知页面或其他 profile；
- 不实现文件、图片、reasoning、tool-call 等高级能力；
- 不实现多浏览器云端同步；
- 不实现社区 profile marketplace。

## 4. 核心决策

### 4.1 Profile 是唯一站点适配边界

核心 runtime 只消费 profile contract，不认识具体 provider、产品名称或真实站点的固定 selector。

站点差异只能存在于用户录制的 profile 数据中：

```text
页面差异 → profile 数据
执行逻辑 → provider-neutral runtime
模型选择 → model registry
模型与页面关系 → user bindings
```

### 4.2 本地 profile 是用户操作的第一来源，后端保存最后已知副本

插件本地 profile 负责离线启动和页面执行；后端 profile registry 负责：

- API 请求到 profile 的解析；
- 多次插件启动后的发现；
- 后端重启后的恢复；
- profile 版本和 checksum 的比较；
- profile 健康状态的集中查看。

后端副本不是用户凭据，也不包含页面内容、对话文本或认证材料。

### 4.3 冲突不自动合并 selector

同一 `profileId` 出现不同 `revision` 或 checksum 时：

- 保留本地当前 profile；
- 保留后端最后已知 profile；
- 标记 `profile_conflict`；
- 要求显式选择“保留本地”或“采用后端”；
- 不对 CSS selector、identity、excluded selector 做猜测合并。

### 4.4 健康状态只记录证据，不保存页面内容

健康检查只允许报告：

- 输入 selector 是否存在且可交互；
- 发送策略是否可执行；
- response selector 是否存在；
- identity 是否能解析；
- streaming indicator 是否语法有效；
- profile contract 是否能被 normalizer 接受。

不得上传当前输入文本、回复文本、cookie 或授权 header。

## 5. Profile 数据模型

profile 继续使用现有的执行 contract，并增加生命周期元数据。示意结构：

```json
{
  "profileId": "recorded-fixture-v1",
  "schemaVersion": 2,
  "origin": "https://example.invalid",
  "domain": "example.invalid",
  "input": {
    "selector": "#prompt",
    "kind": "textarea"
  },
  "send": {
    "kind": "enter",
    "key": "Enter",
    "modifiers": []
  },
  "response": {
    "selector": "[data-role='assistant']",
    "containerSelector": "[data-message-id]",
    "identity": {
      "attributes": ["data-message-id"]
    },
    "role": {
      "user": ["user"],
      "assistant": ["assistant"]
    },
    "streamingIndicators": [
      {"selector": "[aria-busy='true']", "equals": true}
    ],
    "excludedSelectors": ["[aria-hidden='true']"],
    "textNormalization": [
      {"kind": "trim"},
      {"kind": "collapse-whitespace"}
    ]
  },
  "capabilities": {
    "text": true,
    "streaming": "dom-snapshot"
  },
  "lifecycle": {
    "revision": 3,
    "checksum": "sha256:...",
    "createdAt": "2026-07-31T00:00:00.000Z",
    "updatedAt": "2026-07-31T00:00:00.000Z",
    "lastVerifiedAt": "2026-07-31T00:00:00.000Z",
    "source": "user-recorded",
    "state": "verified"
  }
}
```

### 5.1 字段规则

- `profileId`：稳定逻辑身份；同一 profile 更新时保持不变；
- `schemaVersion`：profile contract 的结构版本，不等同于 extension version；
- `revision`：同一 profile 的单调递增修改版本；
- `checksum`：对规范化 profile 内容计算，排除 `lastVerifiedAt` 和 health diagnostics；
- `source`：`user-recorded`、`imported`、`migrated` 或 `test-fixture`；
- `state`：生命周期状态，不代替执行时即时健康检查；
- `lastVerifiedAt`：最近一次成功验证时间；
- `capabilities`：声明 profile 支持的能力，不表示当前页面一定健康。

## 6. Profile 状态机

```text
draft
  ↓ local_validate
recorded
  ↓ sync_requested
sync_pending ──sync_failed──→ recorded
  ↓ sync_accepted
synced
  ↓ health_check_passed
verified
  ↓ health_check_failed
degraded
  ↓ contract_invalid
invalid

verified/degraded/invalid → archived
```

状态定义：

| 状态 | 含义 | 是否允许新请求 |
|---|---|---:|
| `draft` | 录制尚未完成 | 否 |
| `recorded` | 本地 profile 完整且可 normalize | 可以进入同步，不直接作为后端绑定依据 |
| `sync_pending` | 本地版本等待后端确认 | 本地已有健康证据时可执行；否则否 |
| `synced` | 后端已保存 profile 副本 | 取决于健康检查 |
| `verified` | contract 和当前页面检查均通过 | 是 |
| `degraded` | 页面部分能力不可用，但文本主路径仍可能可用 | 仅允许明确支持的能力 |
| `invalid` | contract 不完整或 response ownership 无法证明 | 否，返回结构化错误 |
| `archived` | 用户显式停用或替换 | 否 |

`degraded` 不能被当作 `verified`；API 返回中必须带出 profile health 状态和 reason code。

## 7. 生命周期流程

### 7.1 录制完成

1. content runtime 根据当前页面生成完整 profile；
2. extension worker 规范化 profile；
3. 校验输入、发送、response identity 和 origin/domain；
4. 计算 revision 和 checksum；
5. 原子写入 `chrome.storage.local`；
6. 状态进入 `recorded`；
7. 异步同步到后端；
8. 后端确认后状态进入 `synced`；
9. 当前页面健康检查通过后进入 `verified`。

录制过程中的任一步失败都必须保留原有已验证 profile，不得用半成品覆盖 last-known-good profile。

### 7.2 插件启动或 service worker 重启

1. 读取本地 profile envelope；
2. 校验 checksum；
3. 校验 schemaVersion；
4. 对旧版本执行显式迁移；
5. 迁移失败则标记 `invalid`，保留原始数据供诊断；
6. 向后端同步 profile summary；
7. content runtime 加载当前域名对应 profile；
8. 页面 ready 后执行不包含页面内容的 health check；
9. 更新 `lastVerifiedAt` 和 health state。

### 7.3 后端重启

后端启动时：

- 读取 model registry、profile registry、user bindings；
- 校验 profile key 与 `profileId` 一致；
- 校验 binding 指向的 profile 是否存在；
- 不完整 binding 保留但标记 migration hint；
- API 请求遇到无 profile、invalid profile 或 conflict 时立即返回结构化错误，不等待浏览器超时。

### 7.4 页面刷新

页面刷新后 content runtime 不应依赖旧的内存 selector：

```text
page load
→ worker 根据 hostname 取 profile
→ 注入/初始化 runtime
→ normalize profile
→ wait input readiness
→ health check
→ ready lease
```

页面刷新不能生成新的 profileId，也不能覆盖用户本地 profile。

## 8. 后端资源边界

引入独立 profile resource；旧 `/browser/selectors` 保持兼容，但只作为过渡适配层。

### 8.1 Profile upsert

```http
POST /browser/profiles
Content-Type: application/json
```

请求包含：

```json
{
  "client_id": "client-install-id",
  "profile": {"profileId": "...", "schemaVersion": 2, "...": "..."},
  "revision": 3,
  "checksum": "sha256:..."
}
```

成功返回：

```json
{
  "ok": true,
  "profile_id": "recorded-fixture-v1",
  "revision": 3,
  "checksum": "sha256:...",
  "state": "synced"
}
```

### 8.2 Profile health report

```http
POST /browser/profiles/health
```

只允许发送结构化健康证据：

```json
{
  "profile_id": "recorded-fixture-v1",
  "revision": 3,
  "state": "verified",
  "checks": {
    "input": "pass",
    "send": "pass",
    "response": "pass",
    "identity": "pass",
    "streaming": "pass"
  },
  "reason_codes": []
}
```

禁止字段：页面文本、输入内容、assistant 内容、cookie、token、authorization header。

### 8.3 错误码

至少定义：

- `profile_missing`
- `profile_incomplete`
- `profile_schema_unsupported`
- `profile_checksum_mismatch`
- `profile_conflict`
- `profile_domain_mismatch`
- `profile_input_unavailable`
- `profile_send_unavailable`
- `profile_response_unavailable`
- `profile_identity_unavailable`
- `profile_streaming_unavailable`

错误响应必须包含：

```json
{
  "error": {
    "type": "profile_error",
    "code": "profile_response_unavailable",
    "message": "recorded response selector did not resolve",
    "profile_id": "...",
    "revision": 3,
    "recoverable": true
  }
}
```

## 9. 本地存储与原子性

插件本地存储新增 envelope，而不是继续只存裸 selector map。录制中的新版本不能直接覆盖正在工作的 last-known-good profile：

```text
phantomProfiles: {
  "profileId": {
    "active": {
      "profile": {...},
      "revision": 3,
      "checksum": "sha256:...",
      "state": "verified",
      "health": {...}
    },
    "pending": null,
    "lastError": null
  }
}
```

要求：

- 写入前完成 normalize 和 checksum；
- 新录制先写入 `pending`，只替换单个 profile，不覆盖其他域名；
- `pending` 只有通过本地 contract 校验并获得同步确认后，才能提升为 `active`；
- `active` 始终是可回退的 last-known-good profile；
- 同步失败不能丢失本地 profile；
- 读取损坏 JSON 时保留坏数据诊断副本；
- 旧 `phantomSelectors` 只读迁移，不立即删除；
- 迁移后只有含 response identity contract 的 profile 才能进入 executable 状态。

## 10. B、C 的接口预留

Phase A 不实现 B、C，但必须给它们留下稳定边界。

### B Browser runtime recovery 消费的字段

- `profileId`、revision、checksum；
- profile health state；
- `client_id`、tab_id、conversation_id；
- ready lease 和 capability summary；
- 最近一次 recoverable reason code。

B 不应修改 profile 内容；它只负责重新加载、重新验证和重新申请执行 lease。

### C Advanced capabilities 消费的字段

能力通过 `capabilities` 扩展，不通过 provider 分支扩展：

```json
{
  "text": true,
  "streaming": "dom-snapshot",
  "file_upload": false,
  "image_input": false,
  "reasoning_regions": false,
  "tool_calls": false
}
```

C 的每项能力都必须：

- 有 profile 声明；
- 有健康检查；
- 有失败 reason code；
- 有 generic fixture；
- 不影响 text-only 主路径。

## 11. 测试策略

### 单元测试

- profile envelope normalize；
- schemaVersion 校验；
- revision 单调递增；
- checksum 稳定计算；
- lifecycle state transition；
- conflict detection；
- invalid profile fail-closed；
- legacy selector 只读迁移。

### 集成测试

- 本地保存后同步后端；
- 后端 profile registry 原子写入；
- model binding 在 profile 缺失时返回 `profile_incomplete`；
- profile 更新不会改变其他域名；
- 后端重启后 profile 和 binding 仍然存在；
- 同 revision 不重复写入；
- 不同 checksum 返回 `profile_conflict`。

### 真实隔离浏览器测试

使用现有 generic fixtures 验证：

1. 录制 profile；
2. 保存 profile envelope；
3. 关闭并重新加载 content runtime；
4. 刷新页面；
5. 重新加载 profile；
6. 发送请求并捕获 stable response；
7. 故意破坏 selector，确认得到结构化 health error；
8. 恢复 profile 后确认回到 `verified`。

### 隐私边界测试

自动断言同步 payload 不包含：

- cookie；
- localStorage/sessionStorage；
- authorization；
- page text；
- assistant text；
- 用户 prompt。

## 12. Phase A 验收标准

Phase A 只有同时满足以下条件才算完成：

- [ ] 一个 profile 可以被录制、规范化、加 checksum 并原子保存；
- [ ] 插件 reload 后能恢复同一个 profileId 和 revision；
- [ ] 页面刷新后 profile 能重新加载并通过健康检查；
- [ ] 后端重启后 profile registry 和 binding 保持一致；
- [ ] API 请求不会使用缺失或 invalid profile；
- [ ] profile conflict 不会自动合并 selector；
- [ ] profile health 只上传结构化证据，不上传页面内容或凭据；
- [ ] generic DOM matrix 在 profile reload 后仍然全部通过；
- [ ] selector 失效能在有限时间内返回明确错误，而不是等待 API timeout；
- [ ] 不新增任何具体 provider 分支；
- [ ] B 可以只消费 lifecycle/health/lease contract，不需要重新设计 A；
- [ ] C 可以只扩展 capabilities，不需要修改 profile identity 主路径。

## 13. A 内部实现切片顺序

1. Profile envelope、schema version、checksum 和 state reducer；
2. 本地 profile 原子持久化与旧 selector 只读迁移；
3. 后端 profile resource 和 conflict semantics；
4. reload / refresh health check；
5. model binding 与 profile health 错误；
6. isolated browser lifecycle acceptance；
7. checkpoint：A 完成后再进入 B。

每个切片都必须保持 text-only 主路径可运行，不允许先搭建高级 capability 骨架再回头修 profile 生命周期。
