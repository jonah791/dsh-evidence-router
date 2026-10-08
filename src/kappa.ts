/**
 * dsh-evidence-router · 纯判定层（零 IO，可离线单测）
 *
 * 本层唯一的职责：把「证据是否充分」这个二值断言，拆成两个**可分别复算**的读数——
 *
 *   kappa_self : 产生者自判（由调用方传入；本层不代填、不猜测）
 *   kappa_cov  : 独立覆盖判定（本层算：任务声明的必需槽位在证据语料上是否被命中）
 *
 * 两条不变量（违反即缺陷）：
 *
 *   I1 空语料不得报 covered —— 证据为空时一律 missing，且 reason=empty_corpus。
 *      理由：仪器报「干净」的同时必须说得清「我测到了什么」。空输入上报充分，
 *      与恒真判据、恒空判据一样，都是没有信息量的读数。
 *
 *   I2 无判据的槽位 fail-loud —— 既无 all 也无 any 的槽位不默认 covered，
 *      判 undefined_criteria；且槽位总数为 0 时 covSufficient 恒为 false。
 *      理由：「没有判据」不等于「已覆盖」。
 *
 * 口径声明（诚实边界）：
 *   kappa_cov 是**字面量级**的弱仪器——大小写不敏感的子串命中，不做语义、不做推理。
 *   它的价值不在准确，而在**独立**：它不与证据的产生者同源，因此两者判定的分歧
 *   本身就是一个可观测事实。口径全文与适用边界见 docs/semantic.md。
 */
import { createHash } from 'node:crypto'

/** 一个必需槽位：任务要成立，证据里必须能指认出这些内容。 */
export interface Slot {
  /** 稳定标识（读数与缺口清单都按它索引） */
  id: string
  /** 人读标签（缺省回退为 id） */
  label: string
  /** 必须**全部**命中的模式 */
  all: string[]
  /** 至少命中**一个**的模式（可与 all 并用，先过 all 再过 any） */
  any: string[]
}

/** 未覆盖的原因——必须给出，不许只报 false。 */
export type SlotMissReason =
  | 'empty_corpus'
  | 'missing_all'
  | 'missing_any'
  | 'undefined_criteria'

export interface SlotVerdict {
  id: string
  label: string
  covered: boolean
  hitAll: string[]
  missAll: string[]
  hitAny: string[]
  reason?: SlotMissReason
}

export interface CoverageVector {
  covered: string[]
  missing: string[]
  verdicts: SlotVerdict[]
  /** 覆盖比 = 已覆盖槽位 / 槽位总数；**槽位数为 0 时为 0**（不是 1，见 I2） */
  ratio: number
}

export interface SlotParseResult {
  slots: Slot[]
  errors: string[]
}

/**
 * 解析外部传入的槽位定义。**fail-loud 收集错误**，不静默丢弃：
 * 缺 id / id 重复 / 无判据 / 空模式（恒命中）一律进 errors。
 */
export function normalizeSlots(raw: unknown): SlotParseResult {
  const errors: string[] = []
  if (!Array.isArray(raw)) return { slots: [], errors: ['slots 必须是数组'] }
  const seen = new Set<string>()
  const slots: Slot[] = []
  raw.forEach((item, i) => {
    const where = `slots[${i}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${where} 不是对象`)
      return
    }
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    if (id === '') {
      errors.push(`${where} 缺 id（槽位必须可指认，否则读数无法索引）`)
      return
    }
    if (seen.has(id)) {
      errors.push(`${where} id 重复: ${id}`)
      return
    }
    seen.add(id)
    const all = strList(o.all, `${where}.all`, errors)
    const any = strList(o.any, `${where}.any`, errors)
    if (all.length === 0 && any.length === 0) {
      errors.push(`${where} (${id}) 既无 all 也无 any —— 无判据的槽位无法判定（不默认 covered）`)
    }
    const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : id
    slots.push({ id, label, all, any })
  })
  return { slots, errors }
}

function strList(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    errors.push(`${where} 必须是字符串数组`)
    return []
  }
  const out: string[] = []
  v.forEach((p, i) => {
    if (typeof p !== 'string') {
      errors.push(`${where}[${i}] 不是字符串`)
      return
    }
    const t = p.trim()
    if (t === '') {
      errors.push(`${where}[${i}] 是空模式 —— 空模式恒命中，等于没有判据`)
      return
    }
    out.push(t)
  })
  return out
}

/** 判一个槽位在语料上是否被覆盖。口径：大小写不敏感子串命中。 */
export function judgeSlot(slot: Slot, corpus: string): SlotVerdict {
  const base = { id: slot.id, label: slot.label }
  const text = (corpus ?? '').toLowerCase()
  if (text.trim() === '') {
    return { ...base, covered: false, hitAll: [], missAll: [...slot.all], hitAny: [], reason: 'empty_corpus' }
  }
  if (slot.all.length === 0 && slot.any.length === 0) {
    return { ...base, covered: false, hitAll: [], missAll: [], hitAny: [], reason: 'undefined_criteria' }
  }
  const hitAll = slot.all.filter((p) => text.includes(p.toLowerCase()))
  const missAll = slot.all.filter((p) => !text.includes(p.toLowerCase()))
  if (missAll.length > 0) {
    return { ...base, covered: false, hitAll, missAll, hitAny: [], reason: 'missing_all' }
  }
  const hitAny = slot.any.filter((p) => text.includes(p.toLowerCase()))
  if (slot.any.length > 0 && hitAny.length === 0) {
    return { ...base, covered: false, hitAll, missAll: [], hitAny: [], reason: 'missing_any' }
  }
  return { ...base, covered: true, hitAll, missAll: [], hitAny }
}

/** 全覆盖向量：逐槽判定 + 汇总已覆盖/缺口清单。 */
export function coverageOf(slots: Slot[], corpus: string): CoverageVector {
  const verdicts = slots.map((s) => judgeSlot(s, corpus))
  const covered = verdicts.filter((v) => v.covered).map((v) => v.id)
  const missing = verdicts.filter((v) => !v.covered).map((v) => v.id)
  return {
    covered,
    missing,
    verdicts,
    ratio: verdicts.length === 0 ? 0 : covered.length / verdicts.length,
  }
}

/**
 * kappa_cov 的充分性判定：**缺口为空 且 至少覆盖了一个槽位**。
 * 后半个条件是 I2 的防线——零槽位、或全部槽位无判据时，不得判充分。
 */
export function covSufficient(c: CoverageVector): boolean {
  return c.missing.length === 0 && c.covered.length > 0
}

/** 两个判定的四种关系。`premature_stop` 是本工作预测的分歧方向（P1）。 */
export type DisagreementKind =
  | 'agree_sufficient'
  | 'agree_insufficient'
  | 'premature_stop'
  | 'over_retrieval'

export function classify(selfSufficient: boolean, covSufficientNow: boolean): DisagreementKind {
  if (selfSufficient && covSufficientNow) return 'agree_sufficient'
  if (!selfSufficient && !covSufficientNow) return 'agree_insufficient'
  return selfSufficient ? 'premature_stop' : 'over_retrieval'
}

/**
 * 口径指纹：把 (任务陈述, 槽位定义) 规范化后哈希。
 * 规范化必须使**槽位顺序与模式顺序不影响结果**——否则同一个口径会算出不同指纹。
 */
export function kappaFingerprint(task: string, slots: Slot[]): string {
  const canon = JSON.stringify({
    task: task.trim().replace(/\s+/g, ' '),
    slots: [...slots]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((s) => ({
        id: s.id,
        all: s.all.map((p) => p.toLowerCase()).sort(),
        any: s.any.map((p) => p.toLowerCase()).sort(),
      })),
  })
  return createHash('sha256').update(canon, 'utf-8').digest('hex').slice(0, 16)
}
