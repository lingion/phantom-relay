# Phantom Relay 真实可靠性验收标准

本文定义发布前的真实浏览器验收，不把单元测试、页面文字、job claim、手工
`/browser/result` 或少量冒烟调用算作产品成功。

## 1. 被验证的产品边界

每个用例只允许以下产品路径：

```text
curl /v1/chat/completions
-> API 立即唤起或复用用户浏览器
-> 已安装扩展执行用户录制的 input/send/response profile
-> 真实网页模型生成回复
-> API 返回当前请求的 assistant 内容
```

浏览器进程检查和退出只用于建立冷启动前置条件。验收工具禁止通过 CDP、
Playwright 或脚本直接输入、点击、按 Enter、导航 provider 页面，也禁止手工
提交 `/browser/result`。

## 2. 动态测试清单

测试不得硬编码豆包、Mimo 或其他 provider。它从当前 API 动态读取公开路由，
并对每个 domain 读取 `/browser/selectors`。只有同时具备以下条件的唯一 domain
才是一个独立录制模型：

- 有可访问且 hostname 与 domain 一致的 target URL；
- 有用户录制的 input 和 send；
- 有用户录制的 response selector；
- response identity 已验证；
- profile lifecycle 未标记为 invalid/degraded。

同一 domain 的多个 model ID 是路由别名，不得重复计为独立网页模型。API
公开但没有可执行录制 profile 的 model ID 必须单独报告，不能混入成功率分母。

## 3. 完整组合

设唯一录制模型数为 $N$。

| 层级 | 场景数 | 含义 |
|---|---:|---|
| 单模型 warm 资格 | $N$ | 每个模型至少一次真实闭环 |
| 每模型独立冷启动 | $N^2$ | 每个模型在浏览器完全退出后重复 $N$ 次 |
| 即时崩溃前置 | $N^2$ | 先证明同一模型刚刚 content-ready |
| 每模型即时崩溃恢复 | $N^2$ | 浏览器刚退出、ready lease 可能尚存时重复 $N$ 次 |
| 有向二模型上下文 | $N(N-1)$ | `A -> B` 与 `B -> A` 分开验证 |
| 三步回切 | $N(N-1)$ | `A -> B -> A` |
| 三个互异模型 | $N(N-1)(N-2)$ | `A -> B -> C`，三者互异 |
| 相邻不同的全部三步链 | $N(N-1)^2$ | 回切与三个互异模型之和 |

`C(N,2)` 只覆盖无方向的模型对，不足以证明上下文可以双向迁移。三步链只要求
相邻模型不同，因此必须同时保留 `A -> B -> A` 和 `A -> B -> C`。

上下文矩阵按前缀树执行：每个 `A` 真实生成一次种子，每个 `A -> B` 真实生成
一次转换结果，再将该真实结果交给所有允许的第三个模型。一次完整上下文 sweep
需要：

$$
N + N(N-1) + N(N-1)^2
$$

次真实 HTTP 请求，但仍覆盖全部二模型和三步路径，不用伪造上游模型输出。

当前若发现 $N=6$，则一轮覆盖为：30 个有向模型对、30 个回切、120 个三模型
互异路径、150 个三步路径；上下文树共 186 次真实请求。加上 warm、每模型 6 次
完全冷启动、6 次即时崩溃前置和 6 次即时关闭恢复，共 300 次；当前 7 个额外公开
别名各检查一次，总计 307 次真实请求。这足以完成组合
覆盖，但每个模型只有 44 个样本，尚不足以达到下面的发布置信门槛。

## 4. 独立 oracle

每个请求使用唯一 `Idempotency-Key` 和挑战应答 marker。用户消息只包含
`REQ_<nonce>`，期望回复必须且只能包含一次 `ACK_<nonce>`；因此直接误捕获用户
消息无法通过。允许网页模型在当前 ACK 周围附带自然语言，避免把模型格式服从度
误判为 relay 失败；但返回历史 ACK、多个候选 ACK 或上一条 assistant 文本都算
失败。

跨模型上下文不把期望答案直接写入当前用户消息：

1. A 只返回 `CTXA_...`；
2. B 从上一条 assistant 消息读取它，并把前缀转换为 `CTXB_...`；
3. C 从 B 的真实结果读取它，并把前缀转换为 `CTXC_...`。

因此 B/C 只有实际读取调用方传入的上一模型上下文，才可能产生期望结果。

每个成功请求还必须同时满足：

- HTTP 200，OpenAI assistant content 精确通过 oracle；
- terminal job 为 completed；
- `browser_capture_message_attempt = 1`；
- `browser_capture_message_dispatched = 1`；
- 冷启动出现 API-owned `browser_wake_requested`；
- 冷启动后出现目标 domain 的 content-ready client；
- 请求结束后 active jobs 为空且 queue depth 为 0。

## 5. 95% 门槛

成功率不得只做全局平均。至少分别输出：每个模型、每种阶段、每条组合路径的
trial、success、failure 和失败类型。

- 覆盖门槛：所有规定组合都至少执行一次且通过；
- 经验门槛：每个模型在每个关键边界的观测成功率不低于 95%；
- 发布置信门槛：每个模型的一侧 95% Clopper-Pearson 成功率下界不低于 95%；
- 分层门槛：每个“模型 × 阶段”单元的观测成功率也不得低于 95%，防止 warm
  成功掩盖该模型的冷启动或上下文失败；
- 路径门槛：每条有向二模型和三步 sequence 单独达到观测门槛，`A -> B` 的成功
  不能抵消 `B -> A` 的失败；
- 清单门槛：`/v1/models` 广告的每个浏览器 model ID 必须能解析到可执行录制
  profile，否则发布失败；
- 零容忍：任何旧回复/用户消息误捕获或一次请求多次发送，直接否决发布，不允许
  被其他成功调用平均掉。

在完全无失败时，至少连续 59 次成功才能使一侧 95% 精确二项下界达到 95%。
因此发布级默认执行两轮上下文 sweep：当前 $N=6$ 时加上 7 个别名共 493 次真实
请求，每个模型 81 次。少量覆盖只能说明走通过某条路径，不能证明稳定性。只有同一次 `full`
运行完成资格、组合覆盖和统计门槛，才能输出发布通过；单独的 qualification 或
context 运行只提供阶段证据。

## 6. 分层停止条件

1. 先跑每模型 warm、完全冷启动和即时崩溃恢复资格；
2. 任一模型资格失败，保留首个真实失败证据，阻止它进入昂贵组合；
3. 全部模型资格通过后，才跑完整有向二模型和三步上下文 sweep；
4. 完整覆盖通过后，再增加重复次数直到达到经验门槛和置信门槛；
5. 外部登录失效、验证码、配额或网络故障单独标为环境/外部依赖失败，但不得改写
   为产品成功。

## 7. 命令

先查看动态清单和精确请求数：

```bash
python3 scripts/live_reliability_acceptance.py inventory
python3 scripts/live_reliability_acceptance.py plan
```

以 Chrome Canary 为真实用户浏览器跑资格层：

```bash
python3 scripts/live_reliability_acceptance.py run \
  --suite qualification \
  --browser-bundle-id com.google.Chrome.canary
```

所有资格通过后跑完整上下文组合：

```bash
python3 scripts/live_reliability_acceptance.py run --suite context
```

完整一轮：

```bash
python3 scripts/live_reliability_acceptance.py run \
  --suite full \
  --browser-bundle-id com.google.Chrome.canary
```

证据写入 `tests/live-results/<timestamp>/`，包括 manifest、逐请求 JSONL 和汇总。
