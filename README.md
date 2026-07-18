# 👻 Phantom Relay

**单步录制 · 全球 AI 对话搬运工**

Chrome 扩展，三步录制 → 自动抓取 → 导出 OpenAI 兼容 API。

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

## Roadmap

- [x] 三步独立录制 (防乱按)
- [x] 智能选择器生成 (6 级降级策略)
- [x] 自动回放抓取
- [x] OpenAI 兼容 API
- [x] 豆包/Doubao
- [ ] 更多平台适配 (进行中)
- [ ] 批量自动抓取
- [ ] 对话数据集管理 UI
