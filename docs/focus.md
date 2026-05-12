# Focus — 2026-05-11

> 这份文档的目的：当我又开始想"再开一个分支去做 X"的时候，先回到这一页。
> 它不是 roadmap，是**当前唯一应该做的那件事**。当 e5 通过时整页重写。

## 项目目标的重申

不是"做能玩 Factorio 的 agent"。是：

> 用 Factorio 这种强可验证的长程任务，做一个**可自我进化**的 agent。
> 自我进化的初步定义 = **把成功经验沉淀到脚本/库，让相似任务下次用更少交互完成得更好**。

verify/observe 的"魔法"（harness、meter、disposable verifier clone）**不是作弊**，
是这个目标的前提——没有自动颁发证书的能力，就不能信任地往 `lib/modules/` 里写东西。
所以 bootstrap 的工程税该交，不该砍。

## 当前位置（2026-05-11）

```
e0 ✅ → e1 ✅ → e2 ✅ → e3 ✅ → e4 ✅ → e5 ❌ → e6 ⏳
                                              ↑ wall
```

- DAG: **5 / 9 passed**
- Pipeline `probe → design → dry-validate → verify → observe` 稳定
- e5-gear 已跑 4+ 个时间戳，最近一次 3 个 attempt 全部 0/s
- `state/digests/` 有 5 个成功 epoch 的结构化产物
- `state/world.md` 写满了 e4/e5 的真实教训（散文）

## 真正的瓶颈是**一件事**

> `world.md` 里那些"Lessons from e5"是宝贵的训练数据，
> **但没有任何代码把它们读回去喂给下次 design prompt**。

所有看起来不同的问题都是这个根因的侧面：
- e5 反复在同一个坑里 → 跨 run 失败记忆 = 0
- parallel mode 没有 feedback parity → 同一类问题
- evidence promotion 没数据 → 同一类问题
- e5 design 不知道 e4 boiler 的真实坐标 → 同一类问题

`previousAttempts` 在 sequential 模式里**单次 run 内**注入是有的；问题在跨 run。

## 下一步：唯一允许做的事

实现一个最小的反馈回路，把 e5 当试金石。

### Step 1 — 诊断（半天）
人工读最近 4 次 `plans/e5-gear-*/design/` 的输入。确认 design prompt 里：
- 有没有 e4 实际 boiler/pole 坐标
- 有没有 e2 实际 iron-chest 坐标
- 有没有上一次失败的 root_cause 和实测值

假设：**全都没有**。这一步把"我猜"变成"我看到"。

### Step 2 — `prior-context.js`（1-2 天）
- **输入**: epoch id
- **输出**: 要 prepend 到 design prompt 的 markdown 段
- **数据源**:
  1. 从 `state/digests/<上游 epoch>.md` 抽出 port 坐标 + 实测吞吐
  2. 从 `plans/<this-epoch>-*` 抽出本 epoch 所有历史 attempt 的
     `root_cause` + `suggested_changes` + 实测值
- **不要碰** `world.md` 散文段。散文是给人看的，不是协议。
  只读结构化产物（`run-meta.json`、`run-summary.json`、`executor_proposal.json` 等）。

### Step 3 — 接入 + 验收（半天）
- 把 `prior-context.js` 的输出拼进 `design.js` 的 prompt 组装
- 跑 e5。**通过**就锁死；**不通过**就看缺什么再加一类上下文。

### Step 4 — 冻结清单

下列项目在 e5 通过前**禁止开工**。它们不是放弃，是搬到等候室：

| 项目 | 放回 |
|---|---|
| sub-designer / connector-injector 真正接入 e5 | 等 prior-context 不够用时再上 |
| parallel mode 的 feedback parity | todo.md 已有条目 |
| evidence promotion (`lib/lua-lib/`) | 等数据 |
| probe-based criteria 统一 | 等审计案例 |
| per-tick observe sampling | 等 verify 误判案例 |
| live load rollback | 研究项 |
| upgrade verb | 等 tier 跨越 |

## 单一掌控指标

**DAG passed: 5 / 9**

每次 main 上 push 前，回答两个问题：
1. 这个 push 让这个数字变了吗？
2. 没变的话，它是不是在直接为变这个数字做准备？

两个都"否" = 又一个分叉，应该停。

## 何时重写这个文档

- e5 通过 ✅ → 整页重写，新 focus 放到 e6 或下一个瓶颈
- prior-context.js 落地但 e5 仍 0/s → 增补 Step 2 的数据源清单
- 出现新的、不属于"反馈回路缺失"的根因 → 在"瓶颈"段补一条

---

**一句话**：基础设施已经够用，缺的是**让 world.md 里的教训被代码读回去**。
做完这个，e5 大概率自己过，e6 也会更快——这才是最初想要的"积累让下次更少交互"。
