# 模型对比 — e6-recovery-test 跨四模型 (2026-05-07)

## TL;DR

同一个 e6（recovery_attempts=3, single coal-burner-cell, threshold 0.95
coal/s）跑了 4 个不同的 LLM。**只有 gpt-5.5 想到"复制模块到 4 个"，其他三个
都只会换 anchor**。这意味着之前 e1-e6 报告的所有"成功率"实际上是 gpt-5.5
（通过 pi 默认 provider 静默选中）的产物，不是基础设施保证。

| Model | Provider | 轨迹 | wall | tokens | pass |
|---|---|---|---|---|---|
| gpt-5.5 | openai-codex | 1→1→**4** | 7m | 322k | ✅ |
| qwen3.6-plus | bailian (百炼) | 1→1→1 | 1m44s | 72k | ❌ |
| glm-5 | bailian (百炼) | 1→1→1 | 3m13s | 73k | ❌ |
| qwen3-6-27b | local llama-api (192.168.10.181:8002) | 1→💥→💥 | 5m11s + 2×timeout | 0\* | ❌ |

\* 本地 server 不在 stream 里发 usage chunk，pi 拿不到 token 数。

## Context

起源：用户问"更换模型跑 e7 吧，怪不得成功率这么高呢"——直觉是之前所有
epoch 跑 100% 通过率有点反常。

最初以为 foundry 已经在用 qwen3.6-plus（父目录 `~/.pi/agent/settings.json`
defaultModel 是这个），实际上：

- pi-invoke.js 的 `--no-extensions` 一刀切，**同时**禁了 `.pi/extensions/`
  发现和 `packages` 列表加载
- `packages: ["npm:pi-bailian-models"]` 是路由器扩展，没加载就找不到
  "百炼 coding-plan" provider
- pi 静默退回到能用的非扩展 provider = openai-codex / gpt-5.5
- **所以 e1-e6 全部跑在 gpt-5.5 上**

修复（commit `6c1b2be`）：去掉 `--no-extensions` 默认 + foundry 写本地
`.pi/agent/settings.json` pin qwen3.6-plus + 只继承 bailian 包。

## 测试设置

四次跑都用 `node scripts/run-epoch.js e6-recovery-test`，probe cache hit
（同一 input save），唯一变量是 LLM。所有 run 都触发 winning=null 路径
（除了 gpt-5.5）。

### 1. gpt-5.5 (openai-codex)
**之前的"基线"**：
- 之前的 e6 run-meta：`plans/e6-recovery-test-2026-05-06T15-47-08-001Z/`
- attempt 1: 1 placement → 0.25/s
- attempt 2: 1 placement (different anchor) → 0.25/s
- **attempt 3: 4 placements → 0.999/s ✅**
- attempt 3 的 plan.yaml 写：`why_not_replicate: "...replicates the
  allowed coal-burner-cell four times at new anchors to exceed the coal
  throughput threshold."` — 模型主动总结了它的策略转变

### 2. qwen3.6-plus (bailian)
- run dir: `plans/e6-recovery-test-2026-05-07T01-33-32-071Z/`
- 1m44s 总耗时，3 attempts 都 1 placement / 0.25/s
- 思考链很长（`thinking` 内容数倍于 `text`）
- 失败模式：每次都换 anchor，从不改数量。读到"prior failed at
  measured=0.25"反馈也只是改坐标

### 3. glm-5 (bailian)
- run dir: `plans/e6-recovery-test-2026-05-07T02-25-...Z/`
- 3m13s，跟 qwen3.6-plus 一样 1→1→1 全 fail
- 第一次跑时被 pi fuzzy-match 到 `opencode/glm-*`（错的 provider），
  报 "No API key found for opencode"。**必须显式 `FOUNDRY_PI_PROVIDER="百炼
  coding-plan"`**，单 `FOUNDRY_PI_MODEL=glm-5` 不够。

### 4. qwen3-6-27b (local llama-api)
- run dir: `plans/e6-recovery-test-2026-05-07T02-37-57-506Z/`
- attempt 1：5m11s 完成，1 placement / 0.25/s（与其他 bailian 模型一致）
- attempt 2：design phase 10 分钟超时（previousAttempts 反馈让 prompt 变
  长，思考 token 也变多）
- attempt 3：同上超时
- 速度 ~38 tok/s，对 design 30k token 平均量 → ~13 min/attempt，超出
  现有 600_000 ms budget
- 用 `~/factorio-agent/.pi/extensions/local-openai-provider/index.ts` 注
  入，需要的 env 变量见下

## 配置参考

### bailian 模型
foundry 默认就是 `qwen3.6-plus`（写在本地 `.pi/agent/settings.json`）。
覆盖：
```bash
FOUNDRY_PI_MODEL=glm-5 \
FOUNDRY_PI_PROVIDER="百炼 coding-plan" \
node scripts/run-epoch.js e6-recovery-test
```

⚠️ **必须同时传 PROVIDER**——单传 MODEL 会 fuzzy-match 到错的 provider。

### 本地 llama-api
```bash
FOUNDRY_PI_EXTENSIONS=/home/holo/factorio-agent/.pi/extensions/local-openai-provider/index.ts \
FOUNDRY_PI_PROVIDER=local-openai \
FOUNDRY_PI_MODEL=qwen3-6-27b \
PI_LOCAL_OPENAI_BASE_URL=http://192.168.10.181:8002/v1 \
PI_LOCAL_OPENAI_MODEL=qwen3-6-27b \
PI_LOCAL_OPENAI_PROVIDER=local-openai \
PI_LOCAL_OPENAI_CONTEXT_WINDOW=131072 \
PI_LOCAL_OPENAI_MAX_TOKENS=8192 \
PI_LOCAL_OPENAI_THINKING_FORMAT=reasoning_content \
PI_LOCAL_OPENAI_REASONING=true \
node scripts/run-epoch.js e6-recovery-test
```

⚠️ **必须 `PI_LOCAL_OPENAI_THINKING_FORMAT=reasoning_content`**——qwen3
系列在流里把思考输出走 `delta.reasoning_content` 而不是 `delta.content`，
不设这个，pi 收不到任何 assistant text。

⚠️ **本地 server 不在 stream 里发 usage chunk**（即使带
`stream_options.include_usage: true` 也不发），所以 token / cost 字段全
是 0。这是 server 端限制，不是 pi 或 foundry 的问题。

## 关键发现

### 1. gpt-5.5 的 e6 通过是孤例

之前以为 "recovery loop + previousAttempts feedback 让 LLM 调整策略" 是
基础设施层面的能力。**实际上**只有 gpt-5.5 一家从"换 anchor"跳到"换数
量"。其他三个模型读到一样的反馈，全部只在 anchor 维度调整。

这暗示：
- e1-e5 的所有"通过"也可能含 gpt-5.5 的特殊聪明（需要 cross-model 重测
  才知道几个真的能跨模型通过）
- design prompt 里的 hint 可能太隐晦（"different anchor / different
  module / revisit blueprint geometry" 三个 lever，gpt-5.5 自己加了
  "scale up"，其他模型不会）
- foundry 的"系统能力评估"应该至少在 2 个模型上验证才报 pass

### 2. pi 扩展加载语义

`.pi/extensions/` 只看 cwd，不沿父目录 walk-up。**但** settings.json 的
`packages` 列表是沿父目录走的。所以：

- 想让一个扩展跟随仓库走（portable）：放 `packages` 列表里（npm:foo 或
  repo-relative path）
- 想让一个扩展只在某机器上用（per-machine experiment）：用
  `FOUNDRY_PI_EXTENSIONS` 环境变量传绝对路径

不要用 `--no-extensions`，它把两类都禁了。

### 3. 观测层有个 trace 落盘 bug

`design.js` 的 `await writePiTrace(outDir, trace)` 写在 try-block 后面，
但 `piInvoke` 自己抛 timeout 不会进 design.js 的错误分支——异常直接传
出，trace 不落盘。导致：

- summary.md 里超时的 attempt wall 显示 0 ms
- run-meta totals 漏算超时部分的实际耗时
- 现实例子：本地 qwen3-6-27b run，attempt 2/3 各 10 分钟实际墙钟，
  summary 报 "0 ms / 0 tok"

**修法**：把 `writePiTrace(outDir, trace)` 挪到 try/finally 的 finally
分支，或包一层 try/catch 让 trace 写盘哪怕 piInvoke 抛错也能成功。同
样适用于 probe.js。

### 4. 本地模型 budget 不够

本地 qwen3-6-27b 速度 38 tok/s，design 平均 30k token（含 thinking）→
~13 分钟/attempt。recovery_attempts > 1 时第二个 attempt 起，
previousAttempts 反馈让 prompt 更长，更慢。现有 600s budget 不够。

可选解：
- 把 `design_timeout_ms` 在 epoch.yaml 里抬到 1_800_000（30 分钟）
- 或加一个 `FOUNDRY_DESIGN_TIMEOUT_MS` env override，让本地模型实验时
  从外部抬

## 后续 TODO（本报告产生的）

- [ ] **修 trace 落盘 bug**（design.js + probe.js）：用 try/finally 保证
  writePiTrace 在异常路径也执行
- [ ] e1-e5 cross-model 重测：用至少 qwen3.6-plus + glm-5 重跑，看哪些
  epoch 真能跨模型通过
- [ ] design prompt 里的"levers"考虑加更明显的 "scale up" 提示，让较弱
  模型也能想到复制
- [ ] 考虑 `epoch.yaml` 加 `model_min_capability` 字段，标记某 epoch 已
  在哪些模型上验证过通过

## 不在范围

- A 项（连接编译器 / 多模块布带）
- 调 design prompt 让 qwen 也通过 e6（需要先决定是不是真的应该这样）
- 接入更多 provider（anthropic / DeepSeek 等）

## 相关 commits

- `6c1b2be` 去 `--no-extensions` + 本地 settings.json
- `2388c9c` 恢复 `FOUNDRY_PI_EXTENSIONS` 钩子（per-machine 实验通道）
- `de49445` 观测层 (run-meta + summary)
- `c1b10fb` / `ba01e6f` e7 epoch（"all attempts fail" 路径验证）

## 相关 plan run dirs（gitignored 但保留作 reference）

- gpt-5.5: `plans/e6-recovery-test-2026-05-06T15-47-08-001Z/`
- qwen3.6-plus: `plans/e6-recovery-test-2026-05-07T01-33-32-071Z/`
- glm-5: `plans/e6-recovery-test-2026-05-07T02-25-XX-XXXZ/`（最新的中间一个）
- qwen3-6-27b 本地: `plans/e6-recovery-test-2026-05-07T02-37-57-506Z/`
