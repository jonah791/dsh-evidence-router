/**
 * 组合冒烟（离线）：stub 一个最小 ctx → 调 apply → 断言工具真注册 → **真调 execute** → 验返回值契约。
 *
 * 为什么需要它（三个都是实测教训，2026-10-08）：
 *   ① `node --check` 与 `tsc` 只验语法/类型，**验不到 apply 会不会在装配时抛错**——
 *      而 apply 抛错 = 宿主启动失败（插件与宿主同进程，无框架兜底）。
 *   ② 宿主对工具输出做 **lossless JSON** 校验：返回对象里出现 `undefined` 值 ⇒
 *      `JSON.stringify` 丢掉该键 ⇒ 往返不等 ⇒ 运行期报 `value is not lossless JSON`。
 *      首版 ev_observe 正是这样：类型层为了让泛型收敛写了 `error: undefined as string | undefined`，
 *      编译与离线冒烟都过，**真宿主才炸**。⇒ 本脚本把这条契约变成可离线执行的判据。
 *   ③ full preflight 对「新插入的插件行」**没有区分力**——把插件名改成不存在的
 *      `dsh-evidence-router-CORPSE-TEST-DOES-NOT-EXIST` 后仍报「预检通过」。
 *
 * 复算：cd self-plugins/dsh-evidence-router && node tests/apply-smoke.mjs
 *
 * 边界（诚实）：这是 **stub ctx**，不是宿主的真 ctx。它验的是装配与返回值契约；
 * 它**不能**替代真挂载后的工具面验收（那一项已由 2026-10-08 18:25 的真调用承担）。
 */
import { apply, inject } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fail = 0
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++ }

/** 递归找出**破坏 lossless JSON** 的值（宿主判据：序列化往返必须无损）。 */
function losslessProblems(v, path = '$') {
  const out = []
  if (v === undefined) out.push(`${path} = undefined`)
  else if (typeof v === 'function') out.push(`${path} = function`)
  else if (typeof v === 'symbol') out.push(`${path} = symbol`)
  else if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${path} = ${v}（非有限数）`)
  else if (Array.isArray(v)) v.forEach((x, i) => out.push(...losslessProblems(x, `${path}[${i}]`)))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) out.push(...losslessProblems(x, `${path}.${k}`))
  }
  return out
}

/** 按 DSH 的 schema DSL（required 落在 property 上）校验返回值。 */
function schemaProblems(schema, v, path = '$') {
  const out = []
  if (!schema) return out
  const t = schema.type
  const okType = t === undefined
    || (t === 'string' && typeof v === 'string')
    || (t === 'number' && typeof v === 'number')
    || (t === 'boolean' && typeof v === 'boolean')
    || (t === 'array' && Array.isArray(v))
    || (t === 'object' && !!v && typeof v === 'object' && !Array.isArray(v))
    || t === 'json'
  if (!okType) out.push(`${path}: 期望 ${t}，实际 ${Array.isArray(v) ? 'array' : typeof v}`)
  if (t === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    const props = schema.properties ?? {}
    for (const [k, sub] of Object.entries(props)) {
      if (sub?.required && !(k in v)) out.push(`${path}.${k}: required 字段缺失`)
      if (k in v) out.push(...schemaProblems(sub, v[k], `${path}.${k}`))
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(v)) if (!(k in props)) out.push(`${path}.${k}: 不在 schema 内（additionalProperties:false）`)
    }
  }
  if (t === 'array' && Array.isArray(v) && schema.items) {
    v.forEach((x, i) => out.push(...schemaProblems(schema.items, x, `${path}[${i}]`)))
  }
  return out
}

function makeCtx(sink) {
  return {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    tools: { register: (t) => { sink.push(t) } },
  }
}

// ── 第一段：装配 ──
const registered = []
const ctx = makeCtx(registered)
// 落盘用临时目录：测试**不得触碰生产资产**，也不该在插件目录里留垃圾
const storeDir = mkdtempSync(join(tmpdir(), 'ev-smoke-'))

ok(Array.isArray(inject) && inject.includes('tools'),
  `inject 声明含 tools（实际 ${JSON.stringify(inject)}）`)

let threw = null
try {
  apply(ctx, { enabled: true, storeDir })
} catch (e) {
  threw = e
}
ok(threw === null, `apply 装配不抛错（${threw ? `${threw.name}: ${threw.message}` : '无异常'}）`)
ok(registered.length === 5, `注册工具数 = 5（实际 ${registered.length}）`)

const names = registered.map((t) => t?.name).filter(Boolean).sort()
const expected = ['ev_assess', 'ev_close', 'ev_observe', 'ev_open', 'ev_report']
ok(JSON.stringify(names) === JSON.stringify(expected), `工具名集合正确（实际 ${names.join(', ')}）`)

// ── 第二段：形状（以实测为准，不假想 render 在哪）──
console.log(`   [诊断] registered[0] 的键: ${Object.keys(registered[0] ?? {}).join(', ')}`)
const pickRender = (t) => {
  if (typeof t?.render === 'function') return { fn: t.render, where: 'top' }
  if (typeof t?.output?.render === 'function') return { fn: t.output.render, where: 'output' }
  return { fn: null, where: 'none' }
}
for (const t of registered) {
  const { fn, where } = pickRender(t)
  let rThrew = null
  let out = null
  try {
    out = fn === null ? null : fn({}, {})
  } catch (e) {
    rThrew = e
  }
  ok(fn !== null && rThrew === null && Array.isArray(out) && out.every((x) => x && typeof x.type === 'string'),
    `${t.name} 的 render（${where}）对空值不抛且返回 [{type,...}]（${fn === null ? '未找到 render' : rThrew ? `抛 ${rThrew.message}` : 'ok'}）`)
}

// ── 第三段：端到端真调 execute（含失败路径）──
// 失败路径是「二等公民」最容易出事的地方；而首版的 undefined 出在**成功路径**的 error 键上，
// 所以两条路径都要喂。
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const cases = [
  ['ev_open', { task: '端到端探针', slots: [{ id: 'a', all: ['alice'] }] }, '成功路径'],
  ['ev_observe', { sessionId: 'no-such', op: 'o', result: 'r' }, '失败路径（会话不存在）'],
  ['ev_assess', { sessionId: 'no-such', selfSufficient: true }, '失败路径（会话不存在）'],
  ['ev_close', { sessionId: 'no-such', outcome: 'x' }, '失败路径（会话不存在）'],
  ['ev_report', {}, '成功路径（空账本）'],
]
let openedId = null
for (const [name, inArgs, note] of cases) {
  let v = null
  let e = null
  try {
    v = await byName[name].execute(inArgs)
  } catch (err) {
    e = err
  }
  if (e) {
    ok(false, `${name}（${note}）执行抛错: ${e.message}`)
    continue
  }
  const lp = losslessProblems(v)
  ok(lp.length === 0, `${name}（${note}）返回值是 lossless JSON${lp.length ? ` — 违规: ${lp.join('; ')}` : ''}`)
  const sp = schemaProblems(byName[name].output?.schema, v)
  ok(sp.length === 0, `${name}（${note}）返回值满足 output.schema${sp.length ? ` — 违规: ${sp.join('; ')}` : ''}`)
  if (name === 'ev_open') openedId = v?.sessionId ?? null
}
ok(typeof openedId === 'string' && openedId.length > 0, `ev_open 返回了可用 sessionId（${openedId}）`)

// 成功路径的 observe（真会话）——失败路径过了不代表成功路径过（反之亦然）
if (openedId) {
  const v = await byName.ev_observe.execute({ sessionId: openedId, op: 'probe', result: 'alice evidence', sourceIds: ['s1'] })
  const lp = losslessProblems(v)
  ok(lp.length === 0, `ev_observe（成功路径）lossless${lp.length ? ` — 违规: ${lp.join('; ')}` : ''}`)
  const sp = schemaProblems(byName.ev_observe.output?.schema, v)
  ok(sp.length === 0, `ev_observe（成功路径）满足 schema${sp.length ? ` — 违规: ${sp.join('; ')}` : ''}`)
}

// ── 第四段：尸体样本（必须有：对照组不失败 = 实验无结论）──
const corpseRegistered = []
let corpseThrew = null
try {
  apply({ logger: ctx.logger, tools: {} }, { enabled: true, storeDir })
} catch (e) {
  corpseThrew = e
}
ok(corpseThrew !== null,
  `尸体样本：ctx 缺 tools.register 时 apply 抛错（${corpseThrew ? `抛了 ✓ ${corpseThrew.name}` : '没抛 ✗ 判据无区分力'}）`)
ok(corpseRegistered.length === 0, `尸体样本未注册任何工具（实际 ${corpseRegistered.length}）`)

// 尸体样本 2：lossless 判据本身必须有区分力（喂一个含 undefined 的对象，断言它确实会报）
ok(losslessProblems({ a: 1, b: undefined }).length === 1,
  '尸体样本：losslessProblems 能抓出 undefined 键（证明该判据有区分力）')

try { rmSync(storeDir, { recursive: true, force: true }) } catch { /* 清理失败不影响判据 */ }

console.log(fail === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
