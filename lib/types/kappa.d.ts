/** 一个必需槽位：任务要成立，证据里必须能指认出这些内容。 */
export interface Slot {
    /** 稳定标识（读数与缺口清单都按它索引） */
    id: string;
    /** 人读标签（缺省回退为 id） */
    label: string;
    /** 必须**全部**命中的模式 */
    all: string[];
    /** 至少命中**一个**的模式（可与 all 并用，先过 all 再过 any） */
    any: string[];
}
/** 未覆盖的原因——必须给出，不许只报 false。 */
export type SlotMissReason = 'empty_corpus' | 'missing_all' | 'missing_any' | 'undefined_criteria';
export interface SlotVerdict {
    id: string;
    label: string;
    covered: boolean;
    hitAll: string[];
    missAll: string[];
    hitAny: string[];
    reason?: SlotMissReason;
}
export interface CoverageVector {
    covered: string[];
    missing: string[];
    verdicts: SlotVerdict[];
    /** 覆盖比 = 已覆盖槽位 / 槽位总数；**槽位数为 0 时为 0**（不是 1，见 I2） */
    ratio: number;
}
export interface SlotParseResult {
    slots: Slot[];
    errors: string[];
}
/**
 * 解析外部传入的槽位定义。**fail-loud 收集错误**，不静默丢弃：
 * 缺 id / id 重复 / 无判据 / 空模式（恒命中）一律进 errors。
 */
export declare function normalizeSlots(raw: unknown): SlotParseResult;
/** 判一个槽位在语料上是否被覆盖。口径：大小写不敏感子串命中。 */
export declare function judgeSlot(slot: Slot, corpus: string): SlotVerdict;
/** 全覆盖向量：逐槽判定 + 汇总已覆盖/缺口清单。 */
export declare function coverageOf(slots: Slot[], corpus: string): CoverageVector;
/**
 * kappa_cov 的充分性判定：**缺口为空 且 至少覆盖了一个槽位**。
 * 后半个条件是 I2 的防线——零槽位、或全部槽位无判据时，不得判充分。
 */
export declare function covSufficient(c: CoverageVector): boolean;
/** 两个判定的四种关系。`premature_stop` 是本工作预测的分歧方向（P1）。 */
export type DisagreementKind = 'agree_sufficient' | 'agree_insufficient' | 'premature_stop' | 'over_retrieval';
export declare function classify(selfSufficient: boolean, covSufficientNow: boolean): DisagreementKind;
/**
 * 口径指纹：把 (任务陈述, 槽位定义) 规范化后哈希。
 * 规范化必须使**槽位顺序与模式顺序不影响结果**——否则同一个口径会算出不同指纹。
 */
export declare function kappaFingerprint(task: string, slots: Slot[]): string;
