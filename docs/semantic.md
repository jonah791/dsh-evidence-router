# dsh-evidence-router · 语义文档

## 1. 元信息

| 项 | 值 |
|---|---|
| 插件 | `dsh-evidence-router` |
| 版本 | 0.1.0 |
| 状态 | `implemented`（编译通过 + 纯层 13/13 测试通过；**尚未挂载进 profile**） |
| owner | 爱丽丝 |
| 正本 | `self-plugins/dsh-evidence-router/`（本文档随代码住） |
| 关联 | `projects/self/evidence-router/DIRECTION-DECISION.md`（为何做）、`arXiv:2610.10507v1`（RECAST，出发点） |
| 日期 | 2026-10-08 |

**一句话**：把「证据是否充分」从一句自判断言，拆成两个**可分别复算**的读数，并把口径冻结进每一行读数。

---

## 2. 定位与反定位

**是**：
- 证据构建过程的**台账**（谁在第几轮取了什么、付出了多少字符）
- **双判仪器**：κ_self（调用方自判）与 κ_cov（插件独立覆盖判定）并报，分歧本身即读数
- **口径冻结器**：每次开题算一个口径指纹，写进每一行读数

**不是**（反定位，防止把职责混进来）：
- **不是检索器 / 执行器**：插件不执行任何证据操作，不碰网络、不碰数据库、不调模型
- **不是答案判定器**：它不判断最终答案对错——只判断「证据覆盖了任务声明的槽位没有」
- **不是策略学习器**：零训练、零参数、零模型调用；判定完全确定性
- **不是语义理解器**：κ_cov 只做字面命中，不做同义/推理（见 §6）

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| 证据构建会话 | 一次「为某个任务收集证据」的过程，由 `ev_open` 开启、`ev_close` 收口 |
| 槽位（slot） | 任务成立所必需的一条事实；形如 `{id, label, all:[模式], any:[模式]}` |
| κ_self | 调用方（证据的产生者）自报的充分性判定 |
| κ_cov | 插件算的覆盖判定：所有槽位都被命中 且 至少一个槽位存在 |
| 口径指纹 | `(任务陈述, 槽位定义)` 规范化后的哈希前 16 位；口径变了它就变 |
| 证据语料 | 所有 `ev_observe` 登记的 result 按序拼接（判定的对象） |
| premature_stop | κ_self=够 而 κ_cov=不够 —— **本工作预测的分歧方向** |
| over_retrieval | κ_self=不够 而 κ_cov=够 |

---

## 4. 概念模型与不变量

**模型**：
```
Store { sessions: { [id]: Session } }
Session { id, task, slots[], kappa, createdAtMs, corpus, observations[], assessments[], closed? }
Observation { seq, op, args, atMs, resultChars, sourceIds[], newlyCovered[] }
Assessment  { round, atMs, selfSufficient, selfReason, covSufficient, disagreement, covered[], missing[], ratio }
```

**不变量（违反即缺陷）**：

| # | 不变量 | 理由 |
|---|---|---|
| **I1** | 证据语料为空（或纯空白）时，任何槽位都不得判 covered，且 `reason=empty_corpus` | 报「干净」的同时必须说得清「我测到了什么」。空输入上报充分与恒真判据一样没有信息量 |
| **I2** | 既无 `all` 也无 `any` 的槽位判 `undefined_criteria`（不默认 covered）；槽位总数为 0 时 `covSufficient` 恒为 false | 「没有判据」不等于「已覆盖」 |
| **I3** | 同一会话内槽位不可改——口径在开题时冻结；要改口径必须开新会话 | 口径漂移会让同一批读数不可比较（P3） |
| **I4** | 每一行读数都必须带口径指纹 | 读数与口径必须同体；口径写在别处 = 不存在 |
| **I5** | κ_self 必须由调用方显式给出；未给布尔值时 `ev_assess` 报错，不代填 | 判断不可代填（主体性原则） |
| **I6** | 语料超上限时 fail-loud，**不静默截断** | 截断会改变覆盖判定，使读数与实际判定对象脱钩 |

---

## 5. 契约

### 5.1 工具面

| 工具 | 入参 | 出参（关键字段） |
|---|---|---|
| `ev_open` | `task`, `slots[]` | `sessionId`, `kappa`, `slotCount`, `slots[]`, `warnings[]` |
| `ev_observe` | `sessionId`, `op`, `result`, `args?`, `sourceIds?[]` | `seq`, `corpusChars`, `newlyCovered[]`, `covered[]`, `missing[]` |
| `ev_assess` | `sessionId`, `selfSufficient`, `selfReason?` | `round`, `disagreement`, `kappa`, `covered[]`, `missing[]`, `missingDetail[]`, `ratio` |
| `ev_close` | `sessionId`, `outcome` | 全量读数一行（含 `kappa`/`rounds`/`corpusChars`/`assessed`/`disagreement`/`ops[]`） |
| `ev_report` | `sessionId?` | `total`, `summary{分歧率, 平均轮数, 平均语料字符, 口径指纹数}`, `sessions[]` |

**所有错误路径都返回与成功路径同形状的对象**（`error` 字段承载原因）——因为 `output.schema` 的 required 字段在运行期会被校验；裸 `{error}` 会同时撞类型与 schema 两道门（见 §9 实践修订记录）。

### 5.2 存储契约

| 路径 | 内容 | 语义 |
|---|---|---|
| `<storeDir>/sessions.json` | 全量会话 | 原子写（临时文件 + rename） |
| `<storeDir>/evidence-router-trace.jsonl` | 读数留痕，一行一次 | **append-only**；写失败不进主流程，原因回吐为 `traceError` |

默认 `storeDir = E:/alice/.dsh/evidence-router`。

### 5.3 调用点清单

| 调用点 | 位置 | 状态 |
|---|---|---|
| 纯层单测 | `tests/kappa.test.mjs` | 已接线（13 条） |
| 生产调用 | 尚无 | **未接线**——见 §10 未决问题 |

> 契约缺失调用点清单会让「谁在用什么」变成放假话（§5.20 规则 3）。此处如实登记：当前**没有任何生产调用点**。

---

## 6. 边界与信任

1. **κ_cov 是字面量级弱仪器**：大小写不敏感子串命中，不做同义、不做推理、不做形态归一化。
   这条边界**已被固化成测试**（`口径边界（已知，非缺陷）`）——同一概念的 `operating_income` 与 `operating income` 判定不同。
   ⇒ 分歧必须连同口径指纹一起读，**不得外推成「模型判断力差」**。
2. **不验证证据真伪**：插件只知道「你登记了什么」，不知道它是否真实、是否来自真实数据源。
   篡改/虚构的证据会被照单计入覆盖。这是**已知的不设防面**。
3. **不执行操作**：因此没有沙箱/越权问题，也没有「插件自己去找证据」的能力。
4. **写盘吞错语义**：`loadStore`/`saveStore`/`appendTrace` 全部 try/catch，失败**不抛**、只回报原因（§5.24 同进程隔离纪律）。
5. **语料上限**：默认 `maxCorpusChars = 1_000_000`，超过即拒绝登记（I6）。
6. **同源风险**：若调用方用同一个模型既产生证据又产生槽位定义，则槽位定义与证据同源——**这一点插件无法检测**，只能由使用者在论文/报告中声明。

---

## 7. 可证伪验收

复算命令（在 `self-plugins/dsh-evidence-router/` 下）：

```
node node_modules/typescript/bin/tsc -p tsconfig.json   # 编译
node --test tests/*.test.mjs                            # 纯层测试
```

| # | 可证伪判据 | 复算命令 | 状态 |
|---|---|---|---|
| A1 | 编译零错误（exit 0） | `node node_modules/typescript/bin/tsc -p tsconfig.json` | 已实测 |
| A2 | 纯层测试 13/13 通过 | `node --test tests/*.test.mjs` | 已实测 |
| A3 | 尸体样本：空语料不报 covered（`reason=empty_corpus`） | 上表 A2 内 `ok 1`/`ok 2` | 已实测 |
| A4 | 尸体样本：空模式不变成恒真判据（`undefined_criteria`） | 上表 A2 内 `ok 3` | 已实测 |
| A5 | 尸体样本：零槽位不判充分 | 上表 A2 内 `ok 4` | 已实测 |
| A6 | 口径指纹对槽位/模式顺序不敏感，对口径变化敏感 | 上表 A2 内 `ok 11`/`ok 12` | 已实测 |
| A7 | 插件挂载进 profile 且五工具可调用（真组合冒烟） | 实调（2026-10-08 18:25–18:29）：`ev_open`→`ev_observe`→`ev_assess`→`ev_close`→`ev_report` 依次真调用成功；`plugin_list` 显示 [mounted] | 已实测 |
| A8 | 工具返回值过宿主运行期契约（lossless JSON + output.schema，成功与失败双路径） | `node tests/apply-smoke.mjs`（24 条断言；2026-10-08 由此判据离线复现并修复 `$.error = undefined` 的 lossless 违规） | 已实测 |
| A9 | 读数留痕真实落盘且口径指纹在场 | 实调：`ev_report` 回显口径指纹 `4ee8052b4b1d3653` 与逐会话行 | 已实测 |

---

## 8. 与实现的关系

| 文档概念 | 实现落点 |
|---|---|
| 槽位解析 / fail-loud | `src/kappa.ts` `normalizeSlots` |
| 覆盖判定（I1/I2） | `src/kappa.ts` `judgeSlot` / `coverageOf` / `covSufficient` |
| 分歧四态 | `src/kappa.ts` `classify` |
| 口径指纹（I3/I4） | `src/kappa.ts` `kappaFingerprint` |
| 五工具 + 存储（I5/I6） | `src/index.ts` `apply` |
| 尸体样本与口径边界 | `tests/kappa.test.mjs` |

分层理由（§5.34 可重构性）：判定逻辑全部在纯层（零 IO、可离线单测），`index.ts` 只做存储与工具接线；换掉存储或工具面不影响判定语义。

---

## 9. 实践修订记录

**2026-10-08 · 首次实现（同日两处回修）**

1. **错误分支必须返回完整形状**（编译期发现）。
   初版 `withSession` 在错误时返回裸 `{error}`，同时撞类型（TS2322）与运行期 `output.schema` 两道门。
   ⇒ 改为：错误构造器与成功路径**形状一致**（含 `error: string | undefined`）；泛型推断才能收敛。
   教训：**「能编译」与「能跑」是两件事，把错误路径当二等公民会同时踩两处。**
2. **测试第 5 条失败暴露了口径边界，而不是实现缺陷**（判据 vs 期望之争）。
   期望 `operating_income` 命中语料里的 `operating income`（空格）——仪器判未命中。**仪器是对的**。
   ⇒ 不弱化判据、不改语料迁就期望，而是：把陷阱案例修正为真陷阱（缺 `revenue`），
   并**新增一条测试把口径边界固化为可执行事实**（`口径边界（已知，非缺陷）`）。
3. **工具输出必须过宿主的 lossless JSON 校验**（真宿主运行期发现 · 同日修复闭环）。
   症状：`ev_observe` 首次真调报 `tool "ev_observe" returned invalid output: value is not lossless JSON`。
   根因：成功路径按第 1 条的形状约定返回了 `error: undefined`——`JSON.stringify` **会丢掉** undefined 键，
   序列化往返后与原值不等 ⇒ 被拒。
   ⇒ 修复：新增递归 `dropUndefined`，包裹全部 5 个返回点（顶层与嵌套一并清）。
   ⇒ 判据升级：A8 从「实调错误路径」升级为 `tests/apply-smoke.mjs` 的**成功/失败双路径 × lossless × output.schema**
   共 24 条断言（含 2 具「证明判据自身有区分力」的尸体样本）——**先红后绿**跑通，把线上缺陷变成离线可复现。
   教训：第 1 条的修法在**类型层**是对的（形状一致），但**值**不能带 undefined 出去；
   「能编译」「离线 apply 不抛」「过宿主运行期契约」是三件不同的事，三件都要过。

---

## 10. 未决问题

| # | 问题 | 影响 | 现状 |
|---|---|---|---|
| Q1 | **没有生产调用点**（2026-10-08 更新：A7–A9 已由本机验收闭环覆盖，但那些是**我的验收调用**，不是生产使用——「有人真的用它推进工作」仍不成立） | 仍不成立 | 在真实的证据构建任务里试用（补上第一个真实调用点） |
| Q2 | κ_cov 的字面形态敏感性 | 覆盖判定会低估（把同义/变体写法算作未覆盖） | 已知边界，已测试固化；改进方向：形态归一化——**但这会降低「零模型」的纯度**，需权衡 |
| Q3 | 多会话口径不同时读数不可直接合并 | `ev_report` 已报 `kappaCount`，但未阻止误用 | 约定：跨口径比较前先按 `kappa` 分组 |
| Q4 | 同一证据被重复登记会重复计入语料 | 覆盖判定幂等，但 `corpusChars` 会虚高 | 待定：是否去重（会改变字符读数口径） |
| Q5 | 槽位定义由谁产生 | 若由产生证据的同一模型产生，则判据与证据同源 | **插件无法检测**，只能在使用方声明（论文须显式交代） |
