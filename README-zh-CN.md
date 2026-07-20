# Phantom Relay

> 一个基于浏览器的本地 AI 代理，通过 OpenAI 兼容 API 调用用户已登录的网页 AI 会话。

[English](README.md) · **中文**

Phantom Relay 将本地 HTTP API 与浏览器中的 AI 聊天网站连接起来。它不直接调用 provider 的私有 API，而是使用用户自己的浏览器登录态，并通过用户在目标网站上录制的页面交互模板完成请求。

这个项目的定位是一个可复用的浏览器 AI 代理框架：用户可以为某个网站录制输入框、发送方式和回复区域，绑定一个模型名称，然后通过本地 OpenAI-compatible API 使用它。

## 工作原理

```text
OpenAI 兼容客户端
        |
        v
本地 Python API（:8765）
        |
        v
模型名称 -> 网站路由
        |
        v
Chrome / Chromium 扩展
        |
        v
用户录制的网站模板
        |
        v
网页交互与 DOM 回复提取
        |
        v
OpenAI 兼容 JSON 或 SSE 响应
```

Phantom Relay 不会携带作者的浏览器配置文件、登录会话、历史对话或录制选择器。全新安装时没有站点配置；每个用户都需要在自己的浏览器中完成录制和绑定。

## 功能特性

- 基于 Manifest V3 的浏览器扩展。
- 本地 Python HTTP 服务。
- OpenAI-compatible `GET /v1/models` 接口。
- OpenAI-compatible `POST /v1/chat/completions` 接口。
- 非流式 JSON 响应。
- 基于浏览器 DOM 增长快照的 SSE 响应。
- 按 hostname 保存的网站模板。
- 支持手动录制：
  - 输入框；
  - Enter 发送；
  - 键盘快捷键；
  - 发送按钮；
  - 回复区域锚点。
- 基于稳定属性和 CSS 的选择器生成及备用选择器。
- 在完整模板不可用时，尝试通用发现输入框和发送控件。
- 面向虚拟列表聊天页面的逻辑消息识别。
- 面向 Markdown 内容的回复提取。
- 对可识别的思考、搜索和加载状态文本进行过滤。
- 单次提交保护，降低重复发送的风险。
- API 请求幂等处理。
- 本地对话保存和扩展 popup JSON 导出。
- 浏览器 heartbeat 和页面 trace 诊断接口。

## 兼容性状态

Phantom Relay 的设计不是固定支持一组 provider，而是让用户通过录制为网站建立本地适配配置。

作者已经在本地浏览器环境中实测通过 DeepSeek 和 Doubao。这些结果说明当前版本具备相应的网页兼容性，但它们不是随发行代码提供的内置集成。用户安装后仍然需要登录自己的账号，并为自己的浏览器配置录制网站模板。

其他网站也可以通过相同的录制流程接入，但最终效果取决于网站的 DOM 结构、消息渲染方式和发送行为。扩展权限中出现某个 hostname，并不代表该网站已经完成适配。

## 环境要求

### 仅安装浏览器扩展

Phantom Relay 扩展本身是 Manifest V3 浏览器扩展，可以安装在支持加载未打包 Manifest V3 扩展的 Chromium 系浏览器中，包括：

- Google Chrome；
- Google Chrome Canary；
- Microsoft Edge；
- Brave；
- Chromium 以及其他兼容的 Chromium 系浏览器。

使用浏览器扩展需要：

- 在浏览器中打开目标 AI 网站；
- 已经登录该网站的账号；
- 浏览器允许加载未打包扩展；
- 如果需要使用本地 API，还需要一个能够发送 OpenAI-compatible 请求的客户端。

### 可选的本地 API 服务

只有在需要通过 `/v1/chat/completions` 使用浏览器代理时，才需要启动本地 Python API。它需要 Python 3 和一台能够运行本地服务的设备。

浏览器扩展和本地 API 是两个独立组件。只使用扩展进行录制和浏览器侧操作时，不应把 macOS 或 Chrome Canary 视为硬性要求。

项目当前在 macOS + Chrome Canary 环境中开发和测试，但这只是开发环境，不是产品的强制要求。不同 Chromium 系浏览器的行为可能存在差异，建议在目标浏览器中实际验证。

## 安装

### 1. 在浏览器中安装扩展

Phantom Relay 可以作为未打包的 Manifest V3 扩展安装到兼容的 Chromium 系浏览器中。不同浏览器的菜单名称可能略有差异。

1. 打开浏览器的扩展页面：
   - Chrome / Chromium：`chrome://extensions/`
   - Edge：`edge://extensions/`
   - Brave：`brave://extensions/`
2. 开启 **Developer mode（开发者模式）**。
3. 点击 **Load unpacked（加载已解压的扩展）**。
4. 选择仓库中的 `extension/` 目录。
5. 打开你要接入的 AI 网站。
6. 打开 Phantom Relay 扩展 popup。

可选的 `launch.sh` 仅用于 macOS 上 Chrome Canary 的开发启动便利，不是安装所必需的，也不代表项目只支持该浏览器。

### 2. 启动本地 API（可选）

如果要通过 `/v1/chat/completions` 调用浏览器代理，请启动本地 API：

```bash
cd phantom-relay
python3 server/api_server.py
```

服务默认监听：

```text
http://127.0.0.1:8765
```

也可以使用：

```bash
./server/run-api.sh
```

启动脚本会先检查是否已有健康的 API 进程，避免重复监听同一个端口。

## 首次接入网站

网站配置由用户自己拥有，并保存在本地。

### 1. 录制输入框

在扩展 popup 中开始录制输入框，然后点击网页中的 textarea、input 或 contenteditable 元素。

扩展会尽量使用稳定的页面标识生成选择器，包括：

1. 唯一 `id`；
2. `data-*` 属性；
3. `aria-label`；
4. 唯一的标签名与 class 组合；
5. CSS 路径备用方案。

### 2. 录制发送方式

选择一种发送方式：

- **Enter**：派发一次 Enter 键操作；
- **快捷键**：录制并回放键盘快捷键；
- **发送按钮**：等待网站发送控件出现并启用后点击一次。

发送后，扩展会等待网页中出现与本次请求对应的新用户消息。如果发送结果不确定，不会盲目重复提交。

### 3. 录制回复锚点

点击页面中已有的一条 AI 回复。这个锚点用于帮助扩展定位相关消息区域；实际回复提取主要依赖网页提供的逻辑消息节点。

### 4. 绑定模型名称

在 popup 中填写一个模型别名，并将它绑定到当前 hostname。例如：

```text
my-deepseek
chat-model-1
```

这个别名只是用户本地配置，不是 provider API key，也不会创建或连接 provider 账号。

完成录制和绑定后，该别名才会出现在当前用户安装的 `/v1/models` 中。

## API 使用

### 健康检查

```bash
curl http://127.0.0.1:8765/health
```

### 查看已配置模型

```bash
curl http://127.0.0.1:8765/v1/models
```

全新安装在用户完成网站录制和模型绑定之前，不会返回用户配置的模型。

### 聊天请求

```bash
curl -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-deepseek",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### 流式聊天请求

```bash
curl -N -sS http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-deepseek",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

当前流式实现会把浏览器中连续增长的 DOM 快照转换为 SSE 增量。它不是 provider 原生 token 流，也不保证 token 级别的边界。

### 支持的消息输入

服务端接受经过归一化的 `system`、`developer`、`user`、`assistant` 和 `tool` 消息角色。由于浏览器桥接层是 provider-neutral 的，历史消息目前会被格式化为网页可读的文本上下文，而不是映射成 provider 原生 conversation ID。

## 运行时数据

运行时数据在本地生成，并被排除在代码仓库之外：

```text
server/model_routes.json       模型别名与 hostname 路由
server/selector_templates.json 用户录制的网站选择器
server/conversations.json      本地对话记录
server/page-trace.jsonl        本地页面诊断信息
```

这些文件不会作为源码发行包的一部分。它们包含用户自己的配置、浏览器行为和对话数据。

扩展还会通过 `chrome.storage.local` 保存每个用户自己的状态。

## API 端点

### 客户端主要端点

```text
GET  /health
GET  /model-routes
GET  /v1/models
POST /v1/chat/completions
```

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

当前本地服务没有提供 `/export` 或 `/export/jsonl` 服务端端点。对话导出由扩展 popup 提供 JSON 导出功能。

## 项目结构

```text
phantom-relay/
├── extension/
│   ├── background.js          MV3 service worker 与任务调度
│   ├── content.js             录制、回放与 DOM 提取
│   ├── popup.html              扩展界面
│   ├── popup.js                popup 控制器
│   └── universal_bridge.js     provider-neutral 桥接基础能力
├── server/
│   ├── api_server.py           本地 HTTP API 与浏览器任务队列
│   ├── run-api.sh              API 启动脚本
│   └── *.json                  本地运行时数据，已被 Git 忽略
├── tests/
│   ├── test_universal_bridge.js
│   ├── test_api_idempotency.py
│   └── fixtures/
├── docs/
│   └── universal-adapter-architecture.md
├── launch.sh
└── README.md
```

## 当前限制

Phantom Relay 是浏览器自动化代理，不是 provider 原生 API 的完整替代品。

当前限制包括：

- 目标网站必须已在用户浏览器中登录；
- 每个网站都需要录制，页面 UI 变化后可能需要重新录制；
- 浏览器执行路径围绕本地任务队列设计，目前不是生产级多账号并行系统；
- 流式输出基于 DOM 快照，而不是 token 流；
- `temperature`、`top_p` 等 OpenAI 请求参数不会自动转换为目标网站的原生控件操作；
- 不同网站的 provider 原生 conversation ID 尚未统一；
- 当前没有统一的 tool calls、视觉输入、文件上传、音频、structured output 和原生 reasoning 能力层；
- 本地 API 默认没有认证层，不要把 `8765` 端口暴露到公网或不可信网络；
- 浏览器登录凭据和 cookies 保留在用户自己的浏览器中，Phantom Relay 不实现 OAuth refresh。

## 开发

运行语法检查和仓库测试：

```bash
node --check extension/universal_bridge.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
python3 -m py_compile server/api_server.py tests/test_api_idempotency.py
node tests/test_universal_bridge.js
python3 tests/test_api_idempotency.py
git diff --check
```

自动化测试覆盖桥接基础能力、消息归一化、回复跟踪、快照合并、发送动作安全和 API 幂等性。它们不能替代针对真实登录网站的浏览器回归测试。

## 未来路线

- 为用户录制的网站模板增加可重复的端到端浏览器测试；
- 改进 adapter 能力声明和站点错误报告；
- 将 provider adapter 与核心 HTTP 生命周期分离；
- 对无法映射到网页的请求能力返回明确的 unsupported capability；
- 在网站能够提供可靠增量边界时改进流式事件语义；
- 支持可选的多 profile 与多会话调度；
- 增加认证、访问控制和更安全的生产默认配置；
- 在目标网站能够稳定暴露这些能力时，探索统一的工具调用、视觉、文件、structured output 和 provider 原生会话支持。

## License

项目当前尚未声明许可证。
