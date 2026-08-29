# CURRENT_ONLY_MATRIX — fresh batch 2026-07-23 (V27 final)

> 本批次只认当前真实 API caller HTTP/SSE body；历史结果不用于填充本批次。
> 千问按用户要求暂时搁置，不执行、不以失败计入三模型验收。

## Host / runtime
- Profile: `/tmp/phantom-relay-canary-auth-real`（源 Canary Default 的隔离克隆；源 profile 未修改）
- Extension manifest: `2.1.11`
- Content script: `2026-07-23.27`
- Background marker: `2026-07-23.27-network-drain`
- Live host: 单一 BiDi host；测试前清理了 Relay 自有临时 host、恢复 tab 和旧扩展缓存
- Verified fixes exercised: lease renewal、stale network capture drain、长响应等待、旧恢复 tab 隔离

## 三模型短请求 gate（真实 caller SSE body）

| 模型 | 状态 | 当前证据 |
|---|---|---|
| deepseek | **PASS** | HTTP 200；`GATE_DEEPSEEK_OK`；16 chars；`finish_reason=stop`；`[DONE]` |
| yiyan | **PASS** | HTTP 200；`GATE_YIYAN_OK`；13 chars；`finish_reason=stop`；`[DONE]` |
| doubao | **PASS** | HTTP 200；`GATE_DOUBAO_OK`；14 chars；`finish_reason=stop`；`[DONE]` |
| qwen | **NOT RUN / DEFERRED** | 按用户要求暂搁置；不执行 |

## 三模型长输入 / 长回复（真实 caller SSE body）

测试策略：每个模型独立顺序执行；输入要求生成十个编号工程段落，并在末行返回唯一 marker。

| 模型 | 状态 | 当前证据 |
|---|---|---|
| deepseek | **PASS** | HTTP 200；2682 chars；marker `LONG_GATE_DEEPSEEK_OK`；`finish_reason=stop`；`[DONE]`；40.2s |
| yiyan | **PASS** | HTTP 200；2201 chars；marker `LONG_GATE_YIYAN_OK`；`finish_reason=stop`；`[DONE]`；43.8s |
| doubao | **PASS** | HTTP 200；1653 chars；marker `LONG_GATE_DOUBAO_OK`；`finish_reason=stop`；`[DONE]`；32.4s |
| qwen | **NOT RUN / DEFERRED** | 按用户要求暂搁置；不执行 |

## 后续重测记录（独立于上述通过批次）

随后一次尝试使用 `/tmp/long_final_*.json` 的顺序重测被宿主清理中断：

| 模型 | 状态 | 证据 / 失败边界 |
|---|---|---|
| deepseek | **FAIL** | HTTP 200；180.2s；`chars=0`；无 `finish_reason`；仅 `[DONE]`；`/tmp/long_final_deepseek.json` |
| yiyan | **FAIL** | HTTP 200；180.3s；`chars=0`；无 `finish_reason`；仅 `[DONE]`；`/tmp/long_final_yiyan.json` |
| doubao | **NOT RUN** | 前两个模型结束前进程收到 SIGTERM，未产生结果文件 |

该次结果不能计入 PASS。它发生在 Relay host/API 清理过程中，且当前 `browser/status` 已验证为 `clients={}`, `jobs={}`, `bindings={}`, `queue_depth=0`；因此不能用它证明模型限额或页面生成失败。原先 `long_gate_*.json` 的三模型 PASS 证据仍单独保留，但本次中断重测必须另行修复/重跑后才能宣称最新批次通过。


- **长输入：DeepSeek、文心、豆包 3/3 PASS。**
- 三个模型均由当前 caller 收到非空真实 SSE content delta，不是页面文字、trace、队列状态或静态测试冒充。
- 空结果、旧回复复用、lease 过期导致的 `role-only/chars:0` 在本轮未复现。
- 千问未测，原因是用户明确要求暂时搁置；不改变其历史限额状态。

## 验证命令

- `node --check extension/background.js` PASS
- `node --check extension/content.js` PASS
- `python3 -m py_compile server/api_server.py scripts/bidi_browser_host.py` PASS
- `git diff --check` PASS
- `node tests/test_universal_bridge.js` → `UNIVERSAL_BRIDGE_TESTS_PASS`
