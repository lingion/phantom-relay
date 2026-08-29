# BiDi host migration — 2026-07-23

## 完成

- Chrome Canary 152 branded build 不再接受 `--load-extension` / `--disable-extensions-except`，已停止使用旧启动参数。
- 安装 Selenium 4.46.0。
- 下载并固定匹配 Canary 152.0.7962.0 的 ChromeDriver：`.tools/chromedriver-152.0.7962.0/chromedriver`。
- 新增 `scripts/bidi_extension_probe.py`：冷启动 + `webExtension.install(path)` 探针。
- 新增 `scripts/bidi_browser_host.py`：持久 BiDi 浏览器宿主。
- `browser_host_launcher.sh` 改为启动持久 BiDi 宿主，使用 Hermes venv Python，避免 shell Python 环境缺 Selenium。
- `browser-host.conf` 注明 BiDi 宿主契约。

## 已验证证据

```text
extension_installed
extension = jdnglmjikhickphemoinoinihjjpbdfo
profile = /tmp/phantom-relay-bidi-host
target_opened = https://www.doubao.com/chat/
page marker = 2026-07-22.20
```

后端真实状态：

```text
source=content-ready
ready=true
input_ready=true
send_ready=true
transport=chrome-extension
can_execute=true
can_stream=true
```

豆包原始 caller gate：

```text
HTTP 200
assistant content = BIDI_HOST_OK
job = job_1784793906082_1f446c19
```

## 当前-only 矩阵

- doubao：PASS
- deepseek：BLOCKED；页面被重定向到 `https://chat.deepseek.com/sign_in`，client `can_execute=false`，原始 caller 超时；不是“匿名登录能力”的结论，而是当前页面执行契约未准备好。
- qwen：NOT RUN
- yiyan：NOT RUN

按规则，共享/提供商前置条件失败后停止矩阵，不把未运行项伪造为失败或成功。

## 检查

- `python3 -m py_compile scripts/bidi_extension_probe.py scripts/bidi_browser_host.py server/api_server.py`：PASS
- `bash -n browser_host_launcher.sh`：PASS
- `node --check extension/background.js`：PASS
- `node --check extension/content.js`：PASS
- `node --check extension/universal_bridge.js`：PASS
- `node tests/test_universal_bridge.js`：PASS
- `node tests/test_network_sse_parser.js`：PASS
- `git diff --check`：PASS
