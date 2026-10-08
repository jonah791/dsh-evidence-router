/**
 * dsh-evidence-router 纯判定层测试
 *
 * 本文件里的 **T1/T2/T6 是尸体样本**——它们不测「功能正常」，而测
 * 「仪器在坏输入上会不会报 clean」。判据纪律：恒为空的输出不是证据，
 * 恒为真的判据同样不是证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSlots, judgeSlot, coverageOf, covSufficient, classify, kappaFingerprint,
} from '../lib/kappa.js'

// ---- 尸体样本 1：空语料不得报 covered ----

test('空语料：全部 missing，且原因必须是 empty_corpus（不报 clean）', () => {
  const { slots } = normalizeSlots([{ id: 'a', all: ['x'] }, { id: 'b', any: ['y'] }])
  const cov = coverageOf(slots, '')
  assert.equal(cov.covered.length, 0)
  assert.deepEqual(cov.missing, ['a', 'b'])
  assert.equal(cov.verdicts[0].reason, 'empty_corpus')
  assert.equal(cov.verdicts[1].reason, 'empty_corpus')
  assert.equal(cov.ratio, 0)
  assert.equal(covSufficient(cov), false, '空证据绝不能判充分')
})

test('纯空白语料也算空（trim 后判）', () => {
  const { slots } = normalizeSlots([{ id: 'a', all: ['x'] }])
  const v = judgeSlot(slots[0], '   \n\t  ')
  assert.equal(v.covered, false)
  assert.equal(v.reason, 'empty_corpus')
})

// ---- 尸体样本 2：空模式不得变成恒真判据 ----

test('空模式被拒并报错，且该槽位判 undefined_criteria 而非 covered', () => {
  const r = normalizeSlots([{ id: 'a', all: ['   '] }])
  assert.ok(r.errors.some((e) => e.includes('空模式')), `应报空模式错误，实际: ${JSON.stringify(r.errors)}`)
  assert.ok(r.errors.some((e) => e.includes('既无 all 也无 any')), '空模式清空后应触发无判据错误')
  // 关键：即使拿一段必然包含大量文字的语料，也不得判 covered
  const v = judgeSlot(r.slots[0], 'anything at all, quite long indeed')
  assert.equal(v.covered, false)
  assert.equal(v.reason, 'undefined_criteria')
})

// ---- 尸体样本 3：零槽位不得判充分 ----

test('零槽位：covSufficient 必须为 false（没有判据 ≠ 已覆盖）', () => {
  assert.equal(covSufficient({ covered: [], missing: [], verdicts: [], ratio: 0 }), false)
})

// ---- 陷阱样本：题面相关但约束缺失（对应 RECAST §E.2 的失败模式）----

test('陷阱：语料谈到了主题却缺约束 ⇒ 缺口被指认，判不充分', () => {
  const { slots } = normalizeSlots([
    { id: 'fy', all: ['2022'] },
    { id: 'opinc', all: ['operating_income'] },
    { id: 'rev', all: ['revenue'] },
  ])
  // 「题面相关」：主题词在；「约束未满足」：revenue 完全缺席（无法构成利润率）
  const corpus = 'In 2022 the company discussed operating_income trends at length.'
  const cov = coverageOf(slots, corpus)
  assert.deepEqual(cov.covered, ['fy', 'opinc'])
  assert.deepEqual(cov.missing, ['rev'])
  assert.equal(covSufficient(cov), false)
})

test('口径边界（已知，非缺陷）：字面匹配对书写形态敏感——同一概念两种写法判定不同', () => {
  // 这条测试的存在本身就是论文的一条读数：κ_cov 是**字面量级**仪器，
  // 它的判定只在**同一书写形态**内可解释。跨形态（下划线/空格/拼写变体）不成立。
  // 因此插件报告的分歧必须连同口径指纹一起读，不能外推成「模型判断力差」。
  const { slots } = normalizeSlots([{ id: 'opinc', all: ['operating_income'] }])
  assert.equal(judgeSlot(slots[0], 'operating_income 12').covered, true)
  assert.equal(judgeSlot(slots[0], 'operating income 12').covered, false, '空格写法不被字面判据认作同一概念')
})

test('陷阱补足后转为充分（证明该判据不是恒假）', () => {
  const { slots } = normalizeSlots([
    { id: 'fy', all: ['2022'] },
    { id: 'opinc', all: ['operating_income'] },
    { id: 'rev', all: ['revenue'] },
  ])
  const corpus = '2022: revenue 100, operating_income 12; 2022-04..06 revenue 120, operating_income 20'
  const cov = coverageOf(slots, corpus)
  assert.deepEqual(cov.missing, [])
  assert.equal(cov.ratio, 1)
  assert.equal(covSufficient(cov), true)
})

// ---- any 语义 ----

test('any：至少命中一个才算覆盖，全不中报 missing_any', () => {
  const { slots } = normalizeSlots([{ id: 'x', all: ['a'], any: ['b', 'c'] }])
  assert.equal(judgeSlot(slots[0], 'a b').covered, true)
  const bad = judgeSlot(slots[0], 'a d')
  assert.equal(bad.covered, false)
  assert.equal(bad.reason, 'missing_any')
})

test('all 未满足时报 missing_all 并列出缺哪个模式', () => {
  const { slots } = normalizeSlots([{ id: 'x', all: ['a', 'b'] }])
  const v = judgeSlot(slots[0], 'only a here')
  assert.equal(v.covered, false)
  assert.equal(v.reason, 'missing_all')
  assert.deepEqual(v.missAll, ['b'])
})

// ---- 分歧分类：四态 + 预测方向 ----

test('分歧四态分类正确，且 premature_stop 是「自判够、覆盖说没够」', () => {
  assert.equal(classify(true, true), 'agree_sufficient')
  assert.equal(classify(false, false), 'agree_insufficient')
  assert.equal(classify(true, false), 'premature_stop')
  assert.equal(classify(false, true), 'over_retrieval')
})

// ---- 口径指纹：顺序无关、异口径必须异指纹 ----

test('口径指纹对槽位顺序与模式顺序不敏感', () => {
  const a = normalizeSlots([{ id: 'b', all: ['Y', 'x'] }, { id: 'a', any: ['Z'] }]).slots
  const b = normalizeSlots([{ id: 'a', any: ['z'] }, { id: 'b', all: ['x', 'y'] }]).slots
  assert.equal(kappaFingerprint('Task T', a), kappaFingerprint('Task T', b))
})

test('口径指纹对任务与槽位定义敏感（换口径必须换指纹）', () => {
  const s = normalizeSlots([{ id: 'a', all: ['x'] }]).slots
  const base = kappaFingerprint('Task T', s)
  assert.notEqual(base, kappaFingerprint('Task U', s), '任务不同 ⇒ 口径不同')
  const s2 = normalizeSlots([{ id: 'a', all: ['x', 'y'] }]).slots
  assert.notEqual(base, kappaFingerprint('Task T', s2), '槽位判据不同 ⇒ 口径不同')
})

// ---- 解析层 fail-loud ----

test('解析层 fail-loud：非数组 / 缺 id / 重复 id 全部进 errors', () => {
  assert.ok(normalizeSlots('nope').errors.length > 0)
  assert.ok(normalizeSlots([{ all: ['x'] }]).errors.some((e) => e.includes('缺 id')))
  const dup = normalizeSlots([{ id: 'a', all: ['x'] }, { id: 'a', all: ['y'] }])
  assert.equal(dup.slots.length, 1)
  assert.ok(dup.errors.some((e) => e.includes('重复')))
})
