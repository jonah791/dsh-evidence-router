/**
 * dsh-evidence-router：证据构建台账 + 充分性双判仪器
 *
 * 它做的事只有一件：让「证据是否充分」变得**可分别复算**。
 *
 * 传统做法里，「够了」是产生者的一句话（RECAST 的 RouterLM 自己发 ACCEPT_CONTEXT，
 * REVEAL 用模型生成的 rubric）。本插件把这句话拆成两个读数并同时落盘：
 *
 *   kappa_self : 调用方（证据的产生者）自报的判定 —— 本插件不代填
 *   kappa_cov  : 插件独立算的覆盖判定 —— 零模型、纯确定性、按 (任务, 槽位) 口径
 *
 * 两者关系分四类（agree_sufficient / agree_insufficient / premature_stop / over_retrieval），
 * 其中 premature_stop（自判够了、覆盖说没够）是本工作预测的分歧方向。
 *
 * 口径指纹（kappaFingerprint）随每次开题冻结并写进每一行读数——**读数与口径同体**，
 * 否则「节省了 X% 轮数」这类结论换一个口径就不可复算。
 *
 * 本插件**不执行任何证据操作**：操作由调用方做，这里只记账、判定、留痕。
 * 不变量、契约、边界与未决问题见 docs/semantic.md。
 *
 * @module dsh-evidence-router
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "evidence-router";
export declare const inject: readonly ["tools"];
export interface Config {
    /** 台账根目录：`sessions.json`（会话）+ `evidence-router-trace.jsonl`（读数留痕） */
    storeDir: string;
    /** 单会话证据语料上限（字符）；超过即 fail-loud，不静默截断（截断会改变覆盖判定） */
    maxCorpusChars: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    storeDir: z<string, string, "defined">;
    maxCorpusChars: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    storeDir: z<string, string, "defined">;
    maxCorpusChars: z<number, number, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config: Config): void;
