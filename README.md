# 👻 Phantom Relay

**单步录制 · 全球 AI 对话搬运工**

Chrome 扩展，三步录制 → 自动抓取 → 导出 OpenAI 兼容 API。

> 当前版本是浏览器桥接实验版。已完成的能力与尚未完成的边界见下方“当前状态”。`stream:true` 当前转发的是页面 assistant DOM 快照增量，不冒充上游 token 级流式。

```
┌─────────────────────────────────────────────────────┐
│  Phantom Relay Chrome Extension (Manifest V3)       │
│                                                     │
│  Step ①: Click "Record Input"  → tap input box     │
│  Step ②: Click "Record Send"   → tap send button   │
│  Step ③: Click "Record Copy"   → tap copy button   │
│                                                     │
│  Each step: ONE click, auto-stop, no mess.          │
│                                                     │
│  Then: export as OpenAI JSON → local API server     │
└─────────────────────────────────────────────────────┘
```

## 安装

```bash
# 1. Chrome 扩展
chrome://extensions/ → 开发者模式 → 加载已解压 → 选 extension/ 目录

# 2. 本地 API (可选)
cd server && python3 api_server.py
# → http://localhost:8765
```

## 使用

```
打开豆包 → 点 Phantom Relay 图标 →

① 点「⏺ 录制」输入框  →  点击页面上的输入框  →  ✓ 自动锁定
② 点「⏺ 录制」发送按钮 →  点击发送按钮       →  ✓ 自动锁定  
③ 点「⏺ 录制」复制按钮 →  等 AI 回复后点复制 →  ✓ 全部就绪

→ 📦 导出 JSON / 📡 发送到本地 API
```

### 关键设计

- **每次只录一个动作**：录完立刻停，锁定该步骤。点错元素会闪红但不记录。
- **步骤顺序锁**：必须先录输入框 → 才解锁发送按钮 → 才解锁复制按钮
- **选择器优先级**：`id` > `data-testid` > `aria-label` > 唯一 class 组合 > CSS 路径

## 支持的平台

| 平台 | URL |
|------|-----|
| 豆包 | doubao.com |
| DeepSeek | chat.deepseek.com |
| ChatGPT | chatgpt.com |
| Claude | claude.ai |
| Gemini | gemini.google.com |
| Copilot | copilot.microsoft.com |
| Kimi | kimi.moonshot.cn |
| 通义千问 | tongyi.aliyun.com |
| 文心一言 | yiyan.baidu.com |
| Poe | poe.com |
| Perplexity | perplexity.ai |
| Mistral | chat.mistral.ai |
| 智谱清言 | zhipuai.cn |
| 讯飞星火 | xinghuo.xfyun.cn |
| HuggingFace Chat | huggingface.co/chat |

## 本地 API

```bash
# 启动
python3 server/api_server.py

# OpenAI 兼容调用
curl http://localhost:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"phantom-relay","messages":[{"role":"user","content":"你好"}]}'

# 导出 fine-tuning 数据
curl http://localhost:8765/export/jsonl > finetune.jsonl
```

## 导出格式

```json
{
  "messages": [
    {"role": "user", "content": "用户问题"},
    {"role": "assistant", "content": "AI 回复"}
  ],
  "metadata": {
    "timestamp": "2026-07-18T...",
    "source": "doubao"
  }
}
```

## 项目结构

```
phantom-relay/
├── extension/
│   ├── manifest.json     # V3, <all_urls> (全球覆盖)
│   ├── background.js      # 状态机 (6 态) + 存储
│   ├── content.js         # 单动作录制 + 选择器生成 + 回放
│   ├── popup.html         # 三步独立录制 UI
│   ├── popup.js           # 控制器 + 轮询
│   └── icons/
└── server/
    └── api_server.py      # 零依赖 OpenAI 兼容 API
```

## 当前状态

### 已完成

- 三步录制：输入、发送策略、回复锚点，按 hostname 隔离模板。
- DeepSeek/Doubao 风格虚拟列表的逻辑消息归并：`data-observe-row`、`data-virtual-list-item-key`、`data-message-id`。
- reasoning/status 与回答分离：整行的“正在思考”“正在阅读”“正在搜索”“搜索几篇文章”等 UI 状态不会写入 assistant 内容；只有同一快照中的实质回答保留。
- 长 DOM 快照 overlap 归并，避免页面反复返回完整前缀造成重复文本。
- 浏览器快照增量通道：页面候选变化 → MV3 background → `/browser/delta` → OpenAI SSE。
- `stream:true` 输出合法 OpenAI SSE：role chunk、增量 content、heartbeat 注释、`finish_reason: stop`、`[DONE]`。
- `Idempotency-Key`、请求指纹、任务复用、完成结果回放。
- 启动前端口健康检查、launchd 实例重载、健康/客户端/trace 检查。
- DeepSeek Two API 的通用可复用原则已抽象：状态路径/推理内容不进文本、完整快照按身份与类型归并、流终止与内容分离。

### 尚未完成

- 尚未完成任意新站点的无录制通用适配；录制模板仍是执行权威。
- 浏览器页面的真实 L5 端到端自动化回归尚未在本机完成。当前 API、扩展客户端和目标 tab 都能被验证，但 `computer_use` 对 Canary 返回 0×0，无法把桌面端结果冒充成通过。
- 浏览器 DOM 快照流不是上游网络 token 流；页面自身只暴露快照时，无法恢复真实 token 边界。
- reasoning 内容目前按“传输状态/进度 UI”抑制；若站点把真正推理与最终答案混在同一文本节点且没有 DOM 语义边界，只能依赖录制的回复锚点和保守行级过滤，不能保证恢复隐藏 reasoning。
- 账户池、OAuth refresh、provider-specific HTTP/SSE adapter 尚未作为独立运行时接入；当前主路径仍是本地 Chrome + MV3。
- 工具调用、多模态和跨站会话尚未完成通用化。

## 运行时验证

```bash
node --check extension/universal_bridge.js
node --check extension/content.js
node --check extension/background.js
node tests/test_universal_bridge.js
python3 -m py_compile server/api_server.py
python3 tests/test_api_idempotency.py
```

API 流式回归使用临时本地 job 验证页面快照：`正在思考` 被丢弃，后续 `答`、`案完成` 作为两个 SSE content chunk 输出，最后输出 `stop` 与 `[DONE]`。

## Roadmap

- [x] 三步独立录制 (防乱按)
- [x] 智能选择器生成 (6 级降级策略)
- [x] 自动回放抓取
- [x] OpenAI 兼容 API
- [x] 豆包/Doubao
- [ ] 更多平台适配 (进行中)
- [ ] 批量自动抓取
- [ ] 对话数据集管理 UI
