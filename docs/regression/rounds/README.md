# 回归轮次记录

本目录保存每一轮真实回归的时间戳、场景、改动、证据和结论。

## 证据等级

- `baseline`：GitHub/本地基线状态，不代表运行成功。
- `static`：语法、单元测试、diff 检查，只是中间证据。
- `bridge`：扩展 heartbeat/claim/result，只是桥接证据。
- `e2e`：真实 GUI 浏览器 + 录制 input/send/response + 调用方实际 HTTP 非空回复。只有 `e2e` 才能标记通过。

## 文件命名

```text
YYYYMMDD-HHMMSS-<stage>-<model>-<scenario>.md
```

每一轮必须记录：

```text
时间戳
GitHub/工作树基线
真实用户场景
录制三要素
调用方请求
HTTP status/body
页面与扩展证据
本轮改动
结论：passed / failed / unverified
下一步唯一动作
```
