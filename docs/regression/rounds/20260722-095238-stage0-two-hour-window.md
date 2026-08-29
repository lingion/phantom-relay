# Round 001 — two-hour execution window started

- 时间戳：2026-07-22T09:52:38+0800
- 计划：`docs/REGRESSION_24H_PLAN_COMPRESSED_3X.md`
- 轮次：R000 extended / 2-hour window
- 证据等级：baseline / bridge-unavailable

## 当前10项todo

1. 规则与主线读取：完成。
2. Git基线/工作树记录：完成。
3. 真实GUI Canary持续监测：进行中。
4. API与真实heartbeat检查：当前不可用，持续监测。
5. 豆包/DLM录制三要素核对：已读取模板，response/发送配置存在缺口，待真实页面核实。
6. GitHub非流式基线差异清单：待读取和归档。
7. 真实豆包短非流式：等待真实宿主，不执行模拟。
8. 真实DLM短非流式：等待真实宿主，不执行模拟。
9. 站点特征档案：待真实页面证据。
10. 轮次收口：等待2小时窗口完成。

## 当前检查结果

- API `:8765` 不可用。
- CDP `:9334` 不可用。
- 真实GUI Canary未发现。
- 当前工作树相对 `origin/main` 有大量未提交改动和临时运行产物。
- 模板现状：豆包 send 为 Enter；DeepSeek 有 CSS send 但 response 为 null；千问/文心为 Enter并有部分response。
- `content.js`仍暴露 `discover_selectors`/`discoverReplaySelectors` 代码入口；本轮不擅自修改，先记录为普适性风险。

## 本轮执行方式

- 后台每分钟检查一次真实 Canary 进程和 `/browser/clients`，持续2小时；首个监测脚本误将自身 shell 命令识别为 Canary，已停止并修正为排除自身 PID 后重新启动。
- 新运行日志：`docs/regression/rounds/20260722-095921-stage0-two-hour-window.log`。
- 不启动临时profile，不使用CDP执行聊天，不手工提交result。
- 真实宿主出现后，才允许进入真实请求阶段。

## 暂定结论

当前不是产品失败，而是执行宿主未提供，结论为 `unverified`。在窗口结束前不把未执行的真实请求标记为通过。
