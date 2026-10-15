<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 证据构建台账与充分性双判仪器：把「证据是否充分」从产生者自判拆成两个可分别复算的读数（kappa_self vs 独立覆盖 kappa_cov），冻结口径指纹并留痕，使「省了几轮」「够不够」这类结论可复算
  inject: ['tools']
  tools: ev_open,ev_observe,ev_assess,ev_close,ev_report
  runtime: host-only
  envDeps: 见 README「配置」节
  boundary: 见 README「设计要点」与「生效判据与回退」节
  compat: cordis ^4.0.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-evidence-router

<p align="center">
  <a href="https://github.com/jonah791/dsh-evidence-router"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-13%20passed-brightgreen" alt="tests">
</p>

**证据构建台账 + 充分性双判仪器。** 它让「证据是否充分」这句话变得可复算。

## 快速开始

**1) 装依赖**（在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-evidence-router": "link:E:/alice/self-plugins/dsh-evidence-router"
```

**2) 挂组合**：

```yaml
- id: dsh-evidence-router
  name: dsh-evidence-router
```

**3) 30 秒验证**：`ev_open {task, slots}` → 应返回 sessionId + **口径指纹**（开题即冻结）

## 它解决什么

在证据构建类任务里（先查、再算、再补，直到够了下结论），决定「够了」的那句话通常是**产生者自己说的**。
RECAST 让 RouterLM 自己发 `ACCEPT_CONTEXT`；REVEAL 用模型生成的 rubric；TASR 用模型的 logit margin。
三者都报告了结论，但都没有报告：**换一个判据，这些结论会不会变。**

本插件把「够了」拆成两个**可分别复算**的读数，同时落盘：

| 读数 | 谁给 | 口径 |
|---|---|---|
| `kappa_self` | 调用方（证据的产生者） | 自报，本插件不代填 |
| `kappa_cov` | 本插件 | 零模型、纯确定性：任务声明的必需槽位在证据语料上是否被字面命中 |

两者的关系分四类，其中 `premature_stop`（自判够了、覆盖说没够）是本工作预测的分歧方向。

## 五个工具

| 工具 | 作用 |
|---|---|
| `ev_open` | 开一次证据会话：声明任务 + 必需槽位；返回**口径指纹**（冻结） |
| `ev_observe` | 登记一次证据操作及其返回（操作你做，这里只记账）；返回覆盖增量与缺口 |
| `ev_assess` | 双判：你给自判，插件给覆盖判定，返回两者关系与缺口明细 |
| `ev_close` | 收口，落一行完整读数 |
| `ev_report` | 读数汇总（分歧率 / 平均轮数 / 平均证据字符 / 口径指纹数） |

**本插件不执行任何证据操作**——它只记账、判定、留痕。因此它可以挂在任何 harness 上，不与任何检索器或执行器耦合。

## 快速上手

```
ev_open   { task: "2022 年哪三个月营业利润率增幅最大",
            slots: [ {id:"fy", all:["2022"]},
                     {id:"rev", all:["revenue"]},
                     {id:"opinc", all:["operating_income"]} ] }
          → 会话 ev-...，口径指纹 a1b2c3...

ev_observe { sessionId, op:"relational", result:"<SQL 返回的记录文本>" }
          → 本轮新覆盖: fy, rev；仍缺: opinc

ev_assess  { sessionId, selfSufficient:true, selfReason:"我认为够了" }
          → ⚠ premature_stop：你判够了，独立覆盖判没够
            缺口明细: opinc（missing_all）缺: operating_income

ev_close   { sessionId, outcome:"..." }
```

## 两条不变量（违反即缺陷）

- **I1 空语料不得报 covered**——证据为空时一律 missing 且 `reason=empty_corpus`。
  报「干净」的同时必须说得清「我测到了什么」。
- **I2 无判据的槽位 fail-loud**——既无 `all` 也无 `any` 的槽位不默认 covered（`undefined_criteria`）；
  槽位总数为 0 时 `covSufficient` 恒为 false。**「没有判据」不等于「已覆盖」。**

## 口径诚实声明

`kappa_cov` 是**字面量级**的弱仪器（大小写不敏感子串命中），不理解语义、不做推理。
它的价值**不在准确，而在独立**：它不与证据的产生者同源，因此两者的分歧本身就是一个可观测事实。

若用弱仪器都能测出显著分歧，那说明充分性判定对判据的选择高度敏感——这是**下界**，不是上界。

完整契约、边界与未决问题见 [`docs/semantic.md`](docs/semantic.md)。

## 测试

```bash
cd self-plugins/dsh-evidence-router && npm test
```

**13 条用例**（跑一次得到）。