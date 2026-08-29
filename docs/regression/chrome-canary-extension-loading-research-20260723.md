# Phantom Relay Chrome Canary 扩展加载研究记录

- 记录时间：2026-07-23
- 本地浏览器：Google Chrome Canary 152.0.7962.0
- 目标：后端冷启动浏览器后，加载 Phantom Relay MV3 扩展并产生 content-ready

## 本地实证

启动参数：

```text
--load-extension=/Users/lingion_k/Desktop/phantom-relay/extension
--disable-extensions-except=/Users/lingion_k/Desktop/phantom-relay/extension
```

Chrome stderr：

```text
--disable-extensions-except is not allowed in Google Chrome, ignoring.
--load-extension is not allowed in Google Chrome, ignoring.
```

CDP：只能看到内置扩展 worker，例如：

```text
chrome-extension://fignfifoniblkonapihmkfakmlgkbkcf/service_worker.js
manifest.name = Google Network Speech
```

不能将内置 worker 当作 Phantom Relay worker。目标页面没有 Phantom Relay content-script marker，`/browser/status` 没有 `content-ready` client。

## 官方检索证据（本轮仅使用 search_auto）

### Chromium Extensions 官方邮件列表

URL：
https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ

结论：Chrome 137 起官方 Chrome branded builds 移除 `--load-extension`；Chrome for Testing 和 Chromium 继续支持。Chrome 官方建议 branded Chrome 使用 `chrome://extensions` 的 Load unpacked，自动化/测试场景使用 WebDriver BiDi 的 `webExtension.install`。

同一线程给出的 BiDi 参数方向：

```text
options.enable_bidi = True
options.browser_version = 'Canary'
options.add_experimental_option('enableExtensionTargets', True)
options.add_argument('--remote-debugging-pipe')
options.add_argument('--enable-unsafe-extension-debugging')
```

安装命令：

```json
{
  "method": "webExtension.install",
  "params": {
    "extensionData": {
      "type": "path",
      "path": "extension"
    }
  }
}
```

### Chromium Extensions 官方邮件列表

URL：
https://groups.google.com/a/chromium.org/g/chromium-extensions/c/FxMU1TvxWWg/m/daZVTYNlBQAJ

结论：Chrome 139 起移除 `--disable-extensions-except`；Chrome for Testing 和 Chromium 继续支持。`--extensions-on-extension-urls` 是允许的替代调试开关，但不能替代扩展安装。

### Chromium source / official branded-build policy

URL：
https://chromium.googlesource.com/chromium/src/+/main/docs/google_chrome_branded_builds.md

结论：Chrome branded build 与 Chromium 行为不同；不能把 Chromium 的启动参数假设套到 branded Canary。

### 相关开发实践

URL：
https://bitcrowd.dev/loading-chrome-extensions-for-development-in-2025/

结论：Chrome branded build 移除 `--load-extension` 后，开发工具转向 remote debugging pipe / WebDriver BiDi。

## 决策

- ❌ 不再继续尝试 `--load-extension` / `--disable-extensions-except` 修复 branded Canary。
- ❌ 不把 Google Network Speech、Hangouts、PDF Viewer 等 worker 视为 Phantom Relay。
- ✅ 当前 Canary 路径改为：启动带 `--remote-debugging-pipe` 与 `--enable-unsafe-extension-debugging` 的浏览器 → 通过 BiDi `webExtension.install(type=path)` 安装扩展 → 校验真实 Phantom Relay worker / manifest / marker → 校验 content-ready → 才允许模型请求。
- ✅ 备用路径：Chrome for Testing/Chromium，继续使用 `--load-extension`；但不能替代用户指定的 Canary 回归路径。

## 当前待实现

1. 查现有工作区是否已有 BiDi/pipe/extension install 实现。
2. 如无，增加独立 host installer，不触碰用户主 Canary profile，不使用 GUI 手工操作。
3. 先跑扩展安装探针，不发模型请求。
4. 仅当真实 worker identity + content-ready 出现后，重新执行当前短对话矩阵。
