# Phantom Relay 本地研究/回归资料索引

- 生成时间：2026-07-23
- 规则：联网检索只使用 `search_auto`；本地文件按“外部研究 / 当前回归 / 历史回归”分开。
- 说明：截至本次扫描，项目内明确命名为 search/research 的旧文件只有 Chrome Canary 研究记录；其余文件是回归证据，不冒充联网搜索结果。

## A. 外部研究记录

| 文件 | 用途 | 状态 |
|---|---|---|
| `docs/regression/chrome-canary-extension-loading-research-20260723.md` | Chrome branded Canary 扩展加载官方结论、本机 stderr、URL、决策 | 当前有效 |

## B. 当前回归入口

| 文件 | 用途 |
|---|---|

## C. 历史回归轮次（按时间倒序文件名查看）


## D. 归档约定

1. 每次 `search_auto` 查询保存：查询文本、时间、auto_mode、结果 URL、结论。
2. 外部搜索研究放 `docs/research/`；运行验证放 `docs/regression/rounds/`；两者不混写。
3. 当前结论只引用当前有效研究文件和最新真实工具输出；历史测试结果不自动当作当前能力。
4. 失败记录保留原始错误和下一步，不改写成成功。
