# Phantom Relay

> 在浏览器里录制一次网页 AI 的交互界面，把用户自己的登录会话转换成本地 OpenAI-compatible API。

**中文** | [English](README.md)

当前扩展版本：**2.5.8**

当前 content 握手协议：**2026-08-11.06**

当前 background 运行时：**2026-08-11.10-content-ready-inventory**

Phantom Relay 是一个本地浏览器会话网关。用户把未打包扩展安装到自己的 Chromium 系浏览器，运行 Python 后端，然后录制目标网页的输入框、发送动作和一条已完成回复。录制成功后，即可通过 `POST /v1/chat/completions` 调用这个网页会话。

它不是 provider SDK，也不会携带作者的账号、Cookie、录制 selector 或站点专用集成。每个安装实例只使用用户自己的浏览器登录态和用户自己录制的 DOM profile。

## 产品契约

```text
OpenAI-compatible 客户端
          |
          v
本地 Flask API：127.0.0.1:8765
          |
          v
用户模型别名 -> 用户录制的站点/profile
          |
          v
后端唤醒或复用用户浏览器
          |
          v
MV3 扩展执行一次已录制发送动作
          |
          v
只返回拥有全新录制身份的回复
          |
          v
OpenAI-compatible JSON 或 SSE
```

当前主线遵守以下边界：

- 录制的 DOM profile 是回复判断的唯一权威。
- API 请求执行期间，扩展不会临时猜测或发现 selector。
- 扩展 background 不会创建、导航、关闭或置顶 provider 标签页。
- 后端拥有浏览器激活职责；没有可复用页面时，只打开该 profile 录制的目标 URL。
- 一个请求只执行一次录制的发送动作；发送结果不确定时不会盲目重发。
- 回复必须证明出现了新的录制身份，或同一结构身份下出现了可验证的新正文。
- 身份归属不明确时失败关闭，不返回旧助手消息，也不返回用户刚发送的内容。
- 产品主路径禁用网络拦截；当前支持的稳定路径是录制 DOM 抓取。

## 当前能力

| 能力 | 当前状态 |
| --- | --- |
| Manifest V3 扩展 | 已实现 |
| 用户录制输入框、Enter、快捷键或发送按钮 | 已实现 |
| 用户录制回复身份 | 执行前强制要求 |
| 按站点保存 profile 和模型别名 | 已实现 |
| 后端唤醒/复用浏览器 | 已实现 |
| `GET /v1/models` | 已实现 |
| `POST /v1/chat/completions` JSON | 已实现并完成真实请求测试 |
| SSE 响应封装 | 已实现，效果取决于网页 DOM |
| provider 原生 token 流 | 不提供 |
| 网络响应拦截 | 已禁用 |
| 统一工具、视觉、文件、音频或 structured output | 尚未提供 |

2.5.8 已经从浏览器完全退出的状态，对用户录制的 Mimo 和豆包页面执行过真实后端请求：第一条 API 请求自动启动 Chrome Canary，随后在同一个终端完成 Mimo -> 豆包 -> Mimo 切换。三条请求都返回了各自的唯一 marker，每条只派发一次浏览器发送，最终后端队列为空。这些站点只是测试目标，不是内置集成，也不代表网站未来改版后仍然无需重录。

## 环境要求

- Python 3.10 或更高版本；
- 能够加载未打包 Manifest V3 扩展的 Chromium 系浏览器；
- 用户已经登录准备录制的 AI 网站；
- 系统打开录制目标 URL 时，必须进入安装了 Phantom Relay 的同一个浏览器 profile。

目前主要开发和真实测试环境是 macOS + Chrome Canary。Chrome、Edge、Brave 和其他 Chromium 系浏览器是预期目标，但浏览器激活和扩展行为仍需在目标安装环境实测。

## 快速开始

### 1. 克隆并启动后端

```bash
git clone https://github.com/lingion/phantom-relay.git
cd phantom-relay

python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
python3 -m server.api_server
```

API 默认监听 `http://127.0.0.1:8765`。

在 macOS 或 Linux 上也可以使用仓库启动脚本：

```bash
./launch.sh
```

录制前先确认服务健康：

```bash
curl http://127.0.0.1:8765/health
```

正常响应包含：

```json
{
  "browser_activation_owner": "api",
  "service": "phantom-relay-api",
  "status": "ok"
}
```

### 2. 安装扩展

1. 打开浏览器扩展管理页：
   - Chrome / Chromium：`chrome://extensions/`
   - Edge：`edge://extensions/`
   - Brave：`brave://extensions/`
2. 开启 **开发者模式**；
3. 点击 **加载已解压的扩展**；
4. 选择本仓库的 `extension/` 目录；
5. 如需方便操作，可以把 Phantom Relay 固定到工具栏。

扩展申请广泛网页权限，是因为它面向用户录制的任意站点，而不是写死一组 provider。安装前可以直接检查 `extension/manifest.json`。

### 3. 录制站点 profile

1. 打开目标 AI 聊天页面并登录；
2. 在该页面打开 Phantom Relay popup；
3. 确认后端地址，默认是 `http://127.0.0.1:8765`；
4. 点击录制 **输入框**，再点击网页上真实的输入编辑器；
5. 选择一种发送方式：
   - **回车**：直接采用 Enter，不需要再录制按钮；
   - **快捷键**：录制网页实际使用的键盘组合；
   - **发送按钮**：录制网页上真实的发送控件；
6. 点击录制 **回复区域**，再点击一条已经完成生成的助手回复。页面会显示候选框，用户可以看到自己选中了什么；
7. 保留或修改 popup 中的模型别名。完整 profile 建立后，这个别名会绑定到当前站点；
8. 等待 Profile 生命周期显示已经同步并可执行。

回复录制不能跳过。只录制一个宽泛的对话容器，无法稳定区分新助手回复、历史回复和用户消息，因此这类 profile 会被拒绝。

### 4. 调用本地 API

查看当前用户自己录制并绑定的模型：

```bash
curl http://127.0.0.1:8765/v1/models
```

发送非流式请求：

```bash
curl -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: relay-check-001' \
  -d '{
    "model": "my-chat",
    "conversation_id": "relay-check-001",
    "messages": [
      {"role": "user", "content": "只回复：relay-ok"}
    ]
  }'
```

请求 SSE 响应：

```bash
curl -N -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-chat",
    "stream": true,
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

SSE 只说明调用方使用流式传输格式，不代表网页一定提供 provider 原生 token 流。有些网页会暴露连续增长的 DOM 快照，有些网页只能捕获一次合格的终态快照。没有观察到连续合格快照时，不能把 Phantom Relay 宣称为逐 token 流式。

### 5. 验证冷启动和模型切换

至少录制两个模型后，应通过 API 验证安装结果，而不是只点 popup 里的手动抓取按钮：

1. 完全退出安装了 Phantom Relay 的浏览器 profile；
2. 使用唯一 marker `curl` 第一个录制模型。后端必须自动启动浏览器并返回本轮 marker；
3. 不操作浏览器，使用第二个唯一 marker `curl` 另一个录制模型；
4. 再使用第三个 marker 切回第一个模型；
5. 确认最终队列为空：

```bash
curl -sS http://127.0.0.1:8765/browser/status
```

每条请求都必须是 HTTP 200，并且只返回当前 marker。只要出现超时、上一条助手回复、用户刚发送的内容，或者最终 `jobs`/`queue_depth` 不为空，就不能认为真实浏览器搬运已经通过。

## 请求行为

后端接受经过归一化的 `system`、`developer`、`user`、`assistant` 和 `tool` 消息记录。历史消息会转换成网页可读的文本上下文，不会被伪装成统一的 provider 原生 conversation ID。

常用请求字段：

```text
model             必填，本地模型别名
messages          OpenAI 风格消息数组
stream            false 返回 JSON，true 返回 SSE
conversation_id   可选，本地稳定会话身份
```

重复 HTTP 请求可以使用 `Idempotency-Key`。幂等键不会把一次不确定的浏览器动作变成“允许发送第二次”。

`temperature`、`top_p` 或 provider 特有 reasoning 参数目前不会自动映射成网页 UI 控件操作。

## 浏览器激活职责

收到请求后：

1. 后端把模型别名解析成用户录制的目标；
2. 如果该域名已有 ready 的扩展页面，就直接复用；
3. 否则后端请求操作系统打开 profile 中保存的目标 URL；
4. 扩展在领取任务前验证页面域名、录制 profile、运行代际和回复身份。

macOS 默认通过 LaunchServices 在后台请求打开目标。其他平台使用 Python 默认浏览器接口，前后台表现可能不同。受管环境可以配置 `PHANTOM_RELAY_BROWSER_BUNDLE_ID` 或 `PHANTOM_RELAY_BROWSER_WAKE_COMMAND`。

`scripts/` 下的可选 BiDi host 是测试基础设施，默认禁用，不能与正常的 API 激活路径同时拥有导航职责。

## 本地数据与隐私

所有网页登录状态都留在用户浏览器内。Phantom Relay 不读取或导出浏览器 Cookie、密码或 OAuth refresh token。

本地运行时文件包括：

```text
server/model_routes.json        通用源码配置
server/user_bindings.json       本地模型别名与录制目标
server/selector_templates.json  本地录制 selector 与 profile
server/conversations.json       本地对话历史
server/browser_jobs.sqlite3     持久化浏览器任务状态
server/page-trace.sqlite3       以元数据为主的运行诊断（SQLite，自动 TTL 清理）
```

设置 `PHANTOM_RELAY_REGISTRY_DIR` 后，模型注册表、profile 注册表和用户绑定会改存到该目录。不设置（默认）时，全部都在上面列出的 `server/` 下。

用户绑定、profile、对话、任务数据库、日志、截图和浏览器 profile 都被 Git 排除。全新 clone 不包含任何已录制站点。

API 默认只监听 `127.0.0.1`，并且没有认证层。不要把 `8765` 暴露到公网或不可信局域网。

## 常见问题

### `Failed to fetch` 或 `profile_sync_failed`

- 确认 `curl http://127.0.0.1:8765/health` 能成功；
- 确认 popup 中的后端地址使用同一个 host 和端口；
- 保存后端地址，然后重新验证或重新录制 profile。

### `recording_route_missing`

- 在安装扩展的同一个浏览器 profile 中打开目标网页；
- 在该网页完成输入框、发送方式和回复区域录制；
- 完整 profile 建立后再确认模型别名绑定。

### 请求超时

超时表示任务没有在配置期限内产生一个合格终态回复。先检查 popup 诊断和 `/trace/tail`，在确认网页是否接受第一次发送之前，不要连续重复提交同一个请求。

### 返回了旧回复或用户消息

运行时 `2026-08-11.06` 会拒绝已知用户回声，并让发送确认与最终抓取共用同一个规范化录制边界。Background 运行时 `2026-08-11.10-content-ready-inventory` 只接受目标域名精确匹配且新鲜的 `content-ready` 执行租约来决定是否复用浏览器页面。如果网站改版导致录制身份失效，应重新录制一条完成的助手回复，而不是把 selector 扩大到整个页面或整个对话容器。

### 扩展已更新，但网页仍使用旧运行时

在扩展管理页重新加载 Phantom Relay，然后刷新已经录制的站点页面。Popup 诊断会显示 content script 版本漂移。

## 更新

```bash
git pull --ff-only
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

随后在扩展管理页重新加载 Phantom Relay，刷新已录制标签页，并重启后端进程。

本地 profile 不进入 Git。执行浏览器 profile 或本地数据清理之前，应自行备份。

## 开发与验证

安装仅用于开发测试的依赖：

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements-dev.txt
```

运行当前静态测试：

```bash
node --test tests/*.js
python3 -m pytest -q

node --check extension/content.js
node --check extension/background.js
node --check extension/profile_contract.js
node --check extension/response_observation.js
git diff --check
```

静态测试只能证明代码契约和回归用例，不能证明登录网站仍然可用。浏览器侧改动达到发布标准，还必须执行真实后端请求、真实录制发送动作，捕获全新回复身份，确认用户哨兵没有泄漏，并确认任务队列最终回到零。

## 仓库结构

```text
phantom-relay/
├── extension/              MV3 popup、worker、录制器和 DOM 运行时
├── server/                 Flask API、路由/profile registry 和任务存储
├── scripts/                迁移脚本和隔离浏览器测试工具
├── tests/                  Node 与 pytest 契约/回归测试
├── docs/                   架构、决策和测试证据
├── launch.sh               可移植后端启动脚本
├── requirements.txt        Python 运行依赖
├── requirements-dev.txt    开发与浏览器测试依赖
└── README.md
```

## 当前限制

- 每个站点都需要用户录制，网页 UI 改版后可能需要重录；
- 必须保留网页登录状态；
- 目前还没有持续覆盖所有 Chromium 浏览器的自动化矩阵；
- DOM 抓取不是 provider 原生 token 流；
- 网站延迟和生成状态仍然会造成超时波动；
- 多账号和高并发生产调度尚未完成；
- 工具、视觉、上传、音频、structured output 和 provider 原生 reasoning 还不是统一可靠契约；
- 网络拦截被明确排除在当前产品主路径之外。

## 许可证

Phantom Relay 采用 [GNU 通用公共许可证 v3.0（GPL-3.0）](LICENSE) 发布。
