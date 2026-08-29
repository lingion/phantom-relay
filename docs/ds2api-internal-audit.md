# ds2api internal/account、auth、config、chathistory、responsehistory 审计报告

审计对象：`/tmp/upstream-audit/ds2api`（工作区实际存在的仓库；用户给定的 `ds2api@8316cf8` 对应目录名为 `ds2api`）。
审计范围：按目录逐文件阅读实现与测试，重点梳理职责、持久化边界、并发/认证状态和跨包调用关系。

## 1. 文件职责矩阵

### internal/account

| 文件 | 类型 | 职责 | 关键状态/边界 |
|---|---|---|---|
| `pool_core.go` | 实现 | 定义 `Pool`；按账号队列轮转；初始化/Reset；Release；Status | `queue`、`inUse`、`waiters` 受互斥锁保护；每账号、全局并发上限；Reset 会唤醒旧等待者 |
| `pool_acquire.go` | 实现 | `Acquire`/`AcquireWait`；目标账号与排除集合；实际分配和轮转 | 目标账号必须存在、未排除且有槽位；等待支持 context 取消；成功后 `inUse++` 并移到队尾 |
| `pool_limits.go` | 实现 | 运行时限制、环境变量默认值和可获取判断 | 单账号上限、全局上限、排队上限；`globalMaxInflight<=0` 时按账号数×单账号上限推导 |
| `pool_waiters.go` | 实现 | 等待队列入队/出队、FIFO 唤醒、Reset 清空 | `maxQueueSize` 限制的是等待者数量；释放只唤醒一个等待者 |
| `pool_test.go` | 测试 | 基本池分配、轮转、释放、限制等回归覆盖 | 验证正常生命周期 |
| `pool_edge_test.go` | 测试 | 空池、重复释放、目标不存在、排除、取消、并发等待、队列覆盖等边界 | 明确失败返回 `false`、不 panic、等待可取消 |

### internal/auth

| 文件 | 类型 | 职责 | 关键状态/边界 |
|---|---|---|---|
| `admin.go` | 实现 | 管理员静态 key/密码哈希认证；HS256 JWT 签发/校验；Authorization 校验 | 密码哈希优先于 key；JWT secret 优先环境变量、其次密码哈希、最后 admin key；`iat <= valid_after` 失效；无配置时回退不安全默认 `admin` |
| `request.go` | 实现 | 普通 API 请求身份解析、配置 API key 与托管账号分流；登录/刷新/失效/切账号；上下文注入 | 未命中配置 API key：直通调用者 token；命中后从账号池获取并确保 DeepSeek token；登录失败尝试下一个账号；指定目标账号禁止切换 |
| `admin_test.go` | 测试 | 管理员 key、密码哈希、JWT、过期/失效时间等 | 覆盖管理认证契约 |
| `request_test.go` | 测试 | 请求认证、账号解析、刷新、切换、释放等主流程 | 覆盖 Resolver 主流程 |
| `auth_edge_test.go` | 测试 | token 来源优先级、空/错误认证、取消、登录失败回退、target pin、JWT 边界等 | 明确兼容 `Bearer`、`x-api-key`、`x-goog-api-key`、query key |

### internal/config

| 文件 | 类型 | 职责 | 关键状态/边界 |
|---|---|---|---|
| `config.go` | 实现 | 核心配置模型：API key、账号、代理、管理员、运行时、响应、自动删除等；账号/代理/凭据归一化 | 账号标识优先 email，否则归一化手机号；丢弃无标识账号；代理 ID 可稳定派生；清理账号 token |
| `codec.go` | 实现 | 自定义 JSON 编解码、未知字段保留、旧字段忽略、Clone；支持 JSON/base64 配置字符串 | `AdditionalFields` 保留未知字段；敏感账号 token 不由持久化层保存；兼容 legacy `base64:` 和多种 base64 编码 |
| `store.go` | 实现 | 配置加载、环境/文件来源决策、索引初始化、快照、账号/API key 查询更新、Replace/Update/Save、导出 | `DS2API_CONFIG_JSON` 可作为来源；Vercel/禁写回时跳过写盘；保存前清除账号 token；API key 与账号索引 O(1) |
| `store_accessors.go` | 实现 | 为各子系统提供带默认值的配置访问器 | 默认 TTL=900s、token refresh=6h、account inflight=2；布尔配置 nil 表示默认启用 |
| `store_env_writeback.go` | 实现 | 环境配置写回开关、路径暴露及配置文件写盘 | `DS2API_ENV_WRITEBACK` 仅接受 1/true/yes/on；写盘自动建目录 |
| `store_index.go` | 实现 | 重建 API key/账号/测试状态索引；账号标识变化后的回退查找 | 保留测试状态；更新 token 时保留历史 ID 别名，兼容长生命周期队列 |
| `validation.go` | 实现 | 代理、管理员、运行时、响应、embedding、自动删除、输入文件和代理引用校验 | 运行时范围/全局≥单账号；响应 TTL 30..86400；自动删除 none/single/all |
| `account.go` | 实现 | `Account.Identifier()` | email 优先，手机号规范化后作为 fallback |
| `credentials.go` | 实现 | `keys` 与结构化 `api_keys` 双表示的归一化、合并、比较 | 修改旧 `keys` 时尽量保留 API key 元数据；去空、去重 |
| `models.go` | 实现 | DeepSeek/Claude/Ollama 模型清单、模型别名解析、thinking/search/type 能力 | `-nothinking` 变体；用户别名覆盖默认别名；只返回受支持 canonical 模型 |
| `paths.go` | 实现 | cwd、Vercel 判定、配置/聊天历史/静态目录/样本路径解析 | `/app` 容器路径及 `/data` 探测；Vercel 默认聊天历史 `/tmp/chat_history.json` |
| `mobile.go` | 实现 | 手机号存储格式和比较键规范化 | 中国大陆号自动补 `+86`；其他无 `+` 号码补 `+`；过滤常见分隔符 |
| `dotenv.go` | 实现 | 当前目录 `.env` 加载，不覆盖已有环境变量 | 支持 `export`、BOM、引号、转义、行内注释；非法赋值报错 |
| `logger.go` | 实现 | 全局 slog 文本 logger，按 `LOG_LEVEL` 初始化/刷新 | 默认 INFO；支持 DEBUG/WARN/ERROR |
| `config_test.go` | 测试 | 配置核心加载/保存/归一化回归 | 主配置契约 |
| `config_edge_test.go` | 测试 | 配置环境、未知字段、敏感字段、路径/异常边界 | 边缘兼容性 |
| `validation_test.go` | 测试 | 全部校验器及边界范围 | 约束契约 |
| `dotenv_test.go` | 测试 | `.env` 语法与覆盖规则 | 加载器契约 |
| `mobile_test.go` | 测试 | 手机号归一化和 canonical key | 账号匹配契约 |
| `paths_test.go` | 测试 | 路径解析与环境分支 | 部署环境契约 |
| `model_alias_test.go` | 测试 | 模型别名、canonical 模型、nothinking 变体 | 模型兼容契约 |
| `store_accessors_test.go` | 测试 | accessor 默认值和显式配置 | 默认行为契约 |

### internal/chathistory

| 文件 | 类型 | 职责 | 关键状态/边界 |
|---|---|---|---|
| `store.go` | 实现 | 聊天历史索引+详情双层文件存储；Start/Update/Get/Delete/Clear/SetLimit；版本迁移、裁剪、原子写入、ETag | 默认 limit=20，允许 0/10/20/50；`streaming → success/error` 由上层驱动；全操作互斥；索引摘要与 `.d/<id>.json` 详情分离 |
| `store_test.go` | 测试 | 文件存储、版本迁移、裁剪、并发/失败、ETag 等主流程 | 持久化契约 |

### internal/responsehistory

| 文件 | 类型 | 职责 | 关键状态/边界 |
|---|---|---|---|
| `session.go` | 实现 | 将一次 HTTP/标准化请求包装为聊天历史 Session；采集请求消息；节流进度更新；成功/失败归档；缺失条目自愈 | prepare/release 内部请求不采集；Progress 最短 250ms；缺失条目重建一次；禁用或不可恢复错误后 session 进入 disabled |

## 2. 关键状态机

### 2.1 账号池（Pool）

```text
Reset/初始化
  ├─ 读取 Store.Accounts()
  ├─ 有 token 账号优先排序
  ├─ queue=账号标识，inUse 清零，等待者全部唤醒
  └─ 计算 per-account/global/queue limits

空闲
  ├─ Acquire(target/round-robin)
  │    ├─ 目标合法且有槽位 → inUse[id]++，账号移到队尾 → 已占用
  │    └─ 否则失败
  └─ AcquireWait
       ├─ 可获取 → 同上
       ├─ 不可排队/队列满 → 失败
       └─ 入 FIFO waiter → 等待释放、Reset 或 ctx 取消

已占用
  ├─ 同账号未达 per-account 且全局未达 → 可继续获取
  ├─ Release → 计数减一；到零删除；唤醒一个 waiter
  └─ 达到限制 → 等待/失败
```

注意：`canQueueLocked` 只检查目标存在/未排除和等待队列容量，不预留账号槽位；被唤醒后仍需重新竞争，因此取消和竞争失败是正常路径。

### 2.2 普通请求认证与账号切换（Resolver）

```text
提取 caller token
  ├─ Authorization: Bearer
  ├─ x-api-key
  ├─ x-goog-api-key
  └─ query key/api_key（仅无 header 凭证时）

无 token → ErrUnauthorized
有 token
  ├─ 不在 Store API keys → 直通模式
  │    UseConfigToken=false, DeepSeekToken=caller token
  └─ 命中 Store API key → 托管模式
       Pool.AcquireWait(target, tried)
       ├─ 无账号/上下文取消/队列失败 → ErrNoAccount 或最后一次登录错误
       └─ 获得账号 → ensureManagedToken
            ├─ 已有 token且未到刷新周期 → 使用缓存 token
            ├─ 无 token/到刷新周期 → Login → 持久化 token
            ├─ 登录失败 → 标记 tried，Release，非 target 时换号
            └─ 成功 → RequestAuth

托管请求后续
  ├─ RefreshToken：清空旧 token → Login → 持久化
  ├─ MarkTokenInvalid：清空内存/Store token，清除刷新时间标记
  ├─ SwitchAccount：非托管或 target pinned → false；否则当前账号加入 tried、释放，再找下一个
  └─ Release：归还 Pool 槽位
```

### 2.3 管理员认证/JWT

```text
Bearer credential
  ├─ VerifyAdminCredential
  │    ├─ Store.AdminPasswordHash 非空 → sha256: 哈希或兼容明文比较
  │    └─ 否则比较 DS2API_ADMIN_KEY；再无则不安全默认 "admin"
  └─ 失败 → VerifyJWTWithStore
       签名 HS256（JWT secret > 密码哈希 > admin key）
       ├─ 格式/签名/payload 错误 → 拒绝
       ├─ exp < now → 拒绝
       ├─ iat <= AdminJWTValidAfterUnix → 拒绝（批量吊销）
       └─ 通过 → admin payload
```

### 2.4 配置加载/保存

```text
LoadStore
  ├─ DS2API_CONFIG_JSON 非空
  │    ├─ JSON/base64 解析成功
  │    │    ├─ 清除账号 token、丢弃无标识账号
  │    │    ├─ Vercel 或未开启 writeback → env-backed 内存配置
  │    │    └─ 开启 writeback → 优先读取已有文件；无文件则尝试 bootstrap 写回
  │    └─ 解析失败 → 非 Vercel 且可写回时尝试文件回退，否则返回错误
  └─ 无 env 配置
       ├─ 文件存在 → 读取、归一化、校验
       ├─ Vercel 缺文件/不可写 → 空内存 env-backed 配置
       ├─ 指定 DS2API_CONFIG_PATH 且缺文件 → 空 file-backed bootstrap
       └─ 其他读取错误 → 返回错误

写入 Save/Update/Replace/UpdateAccountToken
  ├─ env-backed 且 Vercel/禁 writeback → 跳过写盘
  └─ 否则 Clone → ClearAccountTokens → JSON 写入
```

### 2.5 聊天历史存储

```text
New(path)
  ├─ 初始化 version=2, limit=20, revision=0
  ├─ 创建 index path 和 path.d
  └─ loadLocked
       ├─ 不存在 → bootstrap 空索引
       ├─ legacy items（无 detail_revision）→ 全量迁移到详情文件
       └─ v2 index → 逐项读取详情，重建摘要索引

Start
  ├─ store disabled（limit=0）→ ErrDisabled
  └─ 创建 chat_<uuid>，status=streaming，revision++，写详情+索引

Update
  ├─ 找不到 → not found
  ├─ 找到 → revision++、更新内容/状态/usage/错误/完成时间
  └─ rebuildIndex → 按 created/revision/updated 排序 → 超限删除旧详情 → 原子写详情和索引

终态（由调用方选择）
  ├─ success + Completed=true
  └─ error + Completed=true

Delete/Clear/SetLimit
  ├─ 标记待删除/重建索引/递增 revision
  └─ 原子提交；limit=0 只禁用新建/更新，不删除已有详情的语义由代码路径决定（SetLimit 本身不清空 details）
```

### 2.6 Response history Session

```text
Start(params)
  ├─ Store/Request/Auth 缺失 → nil
  ├─ history disabled 或 __stream_prepare/__stream_release → nil
  └─ chathistory.Start → Session(entryID, startedAt, lastPersist)
       ├─ 无 ID 且失败 → nil
       └─ 有 ID 但写盘失败 → 保留内存 session，后续可继续尝试

流式期间
  └─ Progress(thinking, content)
       ├─ nil/disabled → no-op
       ├─ 距上次持久化 <250ms → 丢弃本次进度
       └─ Update(status=streaming, 200, elapsed)

结束
  ├─ Success/SuccessTurn → status=success, Completed=true, finish_reason/usage
  └─ Error/ErrorTurn → status=error, Completed=true, error/status code

Update 错误
  ├─ ErrDisabled → disabled=true，永久 no-op
  ├─ entry not found → Start 重建；重试 Update
  │    ├─ 重建/重试仍 missing 或 disabled → disabled=true
  │    └─ 其他错误 → 警告，保持 session
  └─ 其他错误 → 警告，保持 session
```

## 3. 跨目录关系与审计结论

1. 依赖主链为：`config.Store` → `account.Pool` → `auth.Resolver` → `responsehistory.Session` → `chathistory.Store`。配置同时为管理员 JWT、账号并发、模型别名和历史路径提供策略源。
2. 账号 token 是运行时凭据：加载环境/文件后会清理，保存/导出前再次清理；登录刷新只把 token 留在内存结构和运行时 Store，不落盘明文。
3. 账号池采用“轮转队列 + 每账号计数 + 全局计数 + FIFO 等待者”，Resolver 在登录失败时主动释放并换号，形成请求级故障转移。
4. 聊天历史是“轻量索引 + 独立详情文件”，每次写入都重建摘要并使用临时文件 `Sync`/`Rename` 原子提交；revision 同时用于列表/详情 ETag 和并发可见性。
5. responsehistory 是旁路归档，不阻塞主请求：进度写入节流；持久化失败只记录日志，缺失条目尝试重建；禁用/不可恢复缺失后关闭该 session 的归档。
6. 安全关注点：`admin.go` 在无任何配置时回退到默认 key `admin`，代码会告警但生产部署必须显式设置 `DS2API_ADMIN_KEY` 或管理员密码哈希；JWT 的批量吊销依赖 `JWTValidAfterUnix` 的严格 `iat` cutoff。
7. 测试执行：`go test ./internal/account ./internal/auth ./internal/config ./internal/chathistory ./internal/responsehistory` 中 account、auth、config 通过；chathistory/responsehistory 被网络依赖下载失败阻塞（`go-tiktoken`、brotli、klauspost/compress、x/*、chi 等无法从 `proxy.golang.org` 获取），不是代码测试失败。
