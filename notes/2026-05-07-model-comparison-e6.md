# 模型对比 — e6-recovery-test 跨四模型 (2026-05-07)

## TL;DR

同一个 e6（recovery_attempts=3, single coal-burner-cell, threshold 0.95
coal/s）跑了多个不同的 LLM。**最初只有 gpt-5.5 想到"复制模块到 4 个"**；加入
Design Goals prompt 段落（cluster cohesion / throughput sufficiency）后，
**qwen3.6-plus 也在 attempt 2 通过**（1→4 轨迹），其余模型未重测。

### 原始对比（无 Design Goals，无 designer-history）

| Model | Provider | 轨迹 | wall | tokens | pass | 失败模式 |
|---|---|---|---|---|---|---|
| gpt-5.5 | openai-codex | 1→1→**4** | 7m | 322k | ✅ | — |
| qwen3.6-plus | bailian (百炼) | 1→1→1 | 1m44s | 72k | ❌ | 只换 anchor |
| glm-5 | bailian (百炼) | 1→1→1 | 3m13s | 73k | ❌ | 只换 anchor |
| qwen3-6-27b | local llama-api | 1→💥→💥 | 5m11s + 2×timeout | 0\* | ❌ | 超时 |
| deepseek-v4-pro | DeepSeek | 1→1→1† | — | — | ❌ | repair pi 清岩，但仍只 1 placement |
| gemini-3.1-pro-preview | undy | 1→1→1‡ | — | — | ❌ | 误读 meta：以为阈值故意不可达 |

### 修复后（加入 Design Goals + designer-history.yaml）

| Model | Provider | 轨迹 | pass | 备注 |
|---|---|---|---|---|
| qwen3.6-plus | bailian (百炼) | 1→**4** | ✅ | attempt 2，measured=0.999/s |

† attempt 3 repair pi 主动分析障碍（大岩石 blocking belt），提议并执行
`mine-simple-entity` 清岩后成功 execute，但 measured=0。策略层面仍是"换
anchor"而非"扩数量"。

‡ Gemini 的失败模式与其他不同：它读出了 `why_not_replicate` 字段和
epoch 名称（"recovery-test"），推断"阈值是 **故意** 设成不可达的"，因此
显式决定不 scale up（`why_not_replicate: "Only one placement is requested
for this test"`）。这是理解层面的误判——它把测试框架的 meta 语义当成了
设计目标，而不是执行目标。attempt 3 还退回到 (0,0)，没有利用 attempt 2
已找到的可用 anchor。

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

**原始跑（无 Design Goals）：**
- run dir: `plans/e6-recovery-test-2026-05-07T01-33-32-071Z/`
- 1m44s 总耗时，3 attempts 都 1 placement / 0.25/s
- 思考链很长（`thinking` 内容数倍于 `text`）
- 失败模式：每次都换 anchor，从不改数量。读到"prior failed at
  measured=0.25"反馈也只是改坐标

**修复后（加 Design Goals + designer-history.yaml）：**
- run dir: `plans/e6-recovery-test-2026-05-07T08-09-28-634Z/`
- attempt 1: 1 placement → 0.250/s（失败，记入 designer-history）
- **attempt 2: 4 placements → 0.999/s ✅**
- 关键推理："Attempt 1 measured ~0.25 coal/s — far below 0.95. Inventory
  supports 4 cells exactly. All 4 footprints fit the coal patch."
- 模型自己算了 N、验证库存、检查空间，未依赖公式提示

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

- [x] **修 trace 落盘 bug**（design.js + probe.js）：用 try/finally 保证
  writePiTrace 在异常路径也执行
- [x] **修 pi-invoke.js stdout OOM bug**：qwen3.6-plus high-thinking 产出量
  很大，`stdout += text` 会触发 `RangeError: Invalid string length`。已在
  `pi-invoke.js` 加 8MB cap（`stdout` 只用于 design.js forbidden-tool 检查，
  早期输出即可覆盖，cap 安全）
- [x] e1-e5 cross-model 重测（qwen3.6-plus）：**全部 5/5 通过**，见下表
- [x] design prompt 里的"levers"考虑加更明显的 "scale up" 提示，让较弱
  模型也能想到复制 → 改为 Design Goals 段落（4 条优先级目标：throughput
  sufficiency / cluster cohesion / resource coverage / utilisation），
  qwen3.6-plus 验证有效，attempt 2 通过 e6（commit `7a31114`）
- [ ] 考虑 `epoch.yaml` 加 `model_min_capability` 字段，标记某 epoch 已
  在哪些模型上验证过通过

## e1-e5 cross-model 重测结果 — qwen3.6-plus (2026-05-07)

| epoch | pass | measured | threshold | item | attempts |
|---|---|---|---|---|---|
| e1-first-coal | ✅ | 0.250 | 0.10 | coal | 1 |
| e2-first-iron | ✅ | 0.233 | 0.05 | iron-plate | 1 |
| e3-first-copper | ✅ | 0.233 | 0.05 | copper-plate | 1 |
| e4-coal-pair | ✅ | 0.500 | 0.30 | coal | 1 |
| e5-coal-cluster-cell | ✅ | 0.500 | 0.40 | coal | 1 |

结论：e1-e5 这五个 epoch 确实是基础设施层面可重现的能力，不依赖 gpt-5.5
的特殊智能。qwen3.6-plus 全部一次通过。

## qwen3.6-plus 全 epoch 结果（修复后，2026-05-07）

| epoch | 轨迹 | pass | measured | threshold | item |
|---|---|---|---|---|---|
| e1-first-coal | 1 | ✅ | 0.250 | 0.10 | coal |
| e2-first-iron | 1 | ✅ | 0.233 | 0.05 | iron-plate |
| e3-first-copper | 1 | ✅ | 0.233 | 0.05 | copper-plate |
| e4-coal-pair | 1 | ✅ | 0.500 | 0.30 | coal |
| e5-coal-cluster-cell | 1 | ✅ | 0.500 | 0.40 | coal |
| e6-recovery-test | 1→**4** | ✅ | 0.999 | 0.95 | coal |
| e7-unreachable-iron | 1→1→1 | ✅ (ok=false 预期) | 0 | 0.1 | iron-plate |

e6 需要 Design Goals + designer-history 才能通过。e7 all-fail 路径正确。

中途发现并修复的 bug（与本次重测直接相关）：
1. **stdout OOM**（pi-invoke.js）：qwen3.6-plus 在 e2 probe 期间 stdout 超出
   JS 字符串上限，Node.js 进程崩溃，级联导致 e3 Factorio server 状态异常。
   加 8MB cap 后 e2/e3 顺利通过。
2. **trace 落盘 bug**（design.js + probe.js）：piInvoke timeout/crash 时
   writePiTrace 跳过，已用 try/finally 修复。

## 不在范围

- A 项（连接编译器 / 多模块布带）
- 接入更多 provider（anthropic / DeepSeek 等）

## 相关 commits

- `6c1b2be` 去 `--no-extensions` + 本地 settings.json
- `2388c9c` 恢复 `FOUNDRY_PI_EXTENSIONS` 钩子（per-machine 实验通道）
- `de49445` 观测层 (run-meta + summary)
- `c1b10fb` / `ba01e6f` e7 epoch（"all attempts fail" 路径验证）
- `85fc156` probe try/finally + pi-invoke 8MB stdout cap
- `39cb863` designer-history.yaml + why_not_replicate→scaling_note 改名
- `7a31114` Design Goals prompt 段落（验证 qwen e6 通过）

## 相关 plan run dirs（gitignored 但保留作 reference）

- gpt-5.5: `plans/e6-recovery-test-2026-05-06T15-47-08-001Z/`
- qwen3.6-plus: `plans/e6-recovery-test-2026-05-07T01-33-32-071Z/`
- glm-5: `plans/e6-recovery-test-2026-05-07T02-25-XX-XXXZ/`（最新的中间一个）
- qwen3-6-27b 本地: `plans/e6-recovery-test-2026-05-07T02-37-57-506Z/`
- deepseek-v4-pro: `plans/e6-recovery-test-2026-05-07T04-45-52-190Z/`
- gemini-3.1-pro-preview (undy): `plans/e6-recovery-test-2026-05-07T05-07-33-630Z/`
