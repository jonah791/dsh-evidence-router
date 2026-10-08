import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSlots, coverageOf, covSufficient, classify, kappaFingerprint, } from "./kappa.js";
export const name = 'evidence-router';
export const inject = ['tools'];
export const Config = z.object({
    storeDir: z.string().default('E:/alice/.dsh/evidence-router'),
    maxCorpusChars: z.number().default(1_000_000),
});
// ---------- 存储层（原子写 + 吞错留痕） ----------
function storePath(dir) {
    return join(dir, 'sessions.json');
}
function loadStore(dir) {
    const p = storePath(dir);
    if (!existsSync(p))
        return { store: { sessions: {} } };
    try {
        const raw = readFileSync(p, 'utf-8');
        const s = JSON.parse(raw);
        if (typeof s !== 'object' || s === null || typeof s.sessions !== 'object' || s.sessions === null) {
            return { store: { sessions: {} }, error: `台账格式错误（缺 sessions 对象）: ${p}` };
        }
        return { store: s };
    }
    catch (e) {
        return { store: { sessions: {} }, error: `读取台账失败: ${e.message}` };
    }
}
function saveStore(dir, store) {
    try {
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, '.sessions.tmp.json');
        writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
        renameSync(tmp, storePath(dir));
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
/**
 * 读数留痕：一行一次真实判定/收口，落 `evidence-router-trace.jsonl`。
 * **吞错**——观测绝不反噬主流程（写失败只把原因回报给出参 traceError）。
 */
function appendTrace(dir, rec) {
    try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'evidence-router-trace.jsonl'), JSON.stringify({ ...rec, atMs: Date.now() }) + '\n', 'utf-8');
        return undefined;
    }
    catch (e) {
        return e.message;
    }
}
/** 会话 id：时间序 + 随机后缀（同毫秒并发也不撞） */
function newSessionId(nowMs) {
    const d = new Date(nowMs);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `ev-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}
/** 缺口明细：只报未覆盖的槽位与它们缺什么（供调用方决定下一步找什么）。 */
function missingDetail(slots, cov) {
    const byId = new Map(slots.map((s) => [s.id, s]));
    const out = [];
    for (const v of cov.verdicts) {
        if (v.covered)
            continue;
        const s = byId.get(v.id);
        out.push({
            id: v.id,
            label: v.label,
            reason: (v.reason ?? 'missing_all'),
            missAll: s ? s.all.filter((p) => !v.hitAll.includes(p)) : [],
        });
    }
    return out;
}
// ---------- 工具输出契约 ----------
/**
 * 递归剔除值为 `undefined` 的键。
 *
 * **为什么必须**：宿主对工具输出做 **lossless JSON** 校验——`JSON.stringify` 会丢掉 undefined 键，
 * 序列化往返后与原值不等，于是运行期报 `value is not lossless JSON` 并**拒绝这次工具调用**。
 * 2026-10-08 线上实测（ev_observe 的第一次真调就炸），离线由 `tests/apply-smoke.mjs` 复现到字段级
 * （`$.error = undefined`）。
 *
 * **教训**：类型层用 `error: string | undefined` 让泛型收敛**是对的**（否则错误路径与成功路径
 * 形状不一致会同时撞 TS2322 与 output.schema 两道门），但**值**不能带 undefined 出去。
 * 「能编译」「离线 apply 不抛」「过宿主运行期契约」是三件不同的事，三件都要过。
 */
function dropUndefined(v) {
    if (Array.isArray(v))
        return v.map((x) => dropUndefined(x));
    if (v !== null && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (x !== undefined)
                out[k] = dropUndefined(x);
        }
        return out;
    }
    return v;
}
// ---------- 工具 ----------
export function apply(ctx, config) {
    const logger = ctx.logger('dsh-evidence-router');
    const dir = config.storeDir;
    /**
     * 读一个会话并把逻辑跑掉。错误路径**也必须返回完整形状**——
     * `output.schema` 里 required 的字段在运行期会被校验，裸 `{error}` 会同时撞
     * 类型与 schema 两道门（2026-10-08 实测：这正是本次 TS2322 的根因，
     * 也说明「能编译」与「能跑」是两件事，两者都要过）。
     */
    function withSession(sessionId, onError, fn) {
        const { store, error } = loadStore(dir);
        if (error)
            return onError(error);
        const s = store.sessions[sessionId];
        if (!s)
            return onError(`会话不存在: ${sessionId}（当前 ${Object.keys(store.sessions).length} 个会话）`);
        return fn(s, store);
    }
    // 三个失败构造器：**形状必须与成功路径一致**（error 的类型也一致为 string|undefined），
    // 否则泛型推断会把 error 收紧成必填，成功路径就再也赋不进去。
    const failObserve = (sessionId, error) => ({
        sessionId, seq: 0, op: '', corpusChars: 0,
        newlyCovered: [], covered: [], missing: [],
        error: error,
    });
    const failAssess = (sessionId, error) => ({
        sessionId, round: 0, disagreement: '', kappa: '',
        covered: [], missing: [],
        missingDetail: [],
        ratio: 0,
        error: error,
    });
    const failClose = (sessionId, error) => ({
        sessionId, kappa: '', observations: 0, rounds: 0, corpusChars: 0,
        assessed: false, selfSufficient: null, covSufficient: null,
        disagreement: '', covered: [], missing: [], ratio: 0,
        outcome: '', ops: [],
        error: error,
    });
    ctx.tools.register(defineTool({
        name: 'ev_open',
        description: '开一次证据构建会话：声明任务与必需槽位（slots）。返回会话 id 与**口径指纹**。'
            + '口径一旦开题即冻结（槽位不可改；要改就重开一个新会话）。'
            + '本插件不执行任何证据操作——它只记账与判定。',
        parameters: {
            task: { type: 'string', description: '任务陈述（冻进口径指纹）', required: true },
            slots: {
                type: 'array',
                description: '必需槽位数组，每项 {id, label?, all?:[模式], any?:[模式]}；all=必须全部命中，any=至少命中一个。'
                    + '例：[{"id":"period","all":["2022","april"]},{"id":"margin","all":["operating","margin"]}]',
                required: true,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string', required: true },
                    kappa: { type: 'string', required: true },
                    slotCount: { type: 'number', required: true },
                    slots: { type: 'array', required: true },
                    warnings: { type: 'array', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                if (v?.error)
                    return [{ type: 'text', text: `开题失败: ${v.error}` }];
                const lines = [
                    `证据会话 ${v.sessionId}`,
                    `口径指纹 ${v.kappa} · ${v.slotCount} 个必需槽位`,
                    ...(v.slots ?? []).map((s) => `  • ${s.id}${s.label !== s.id ? `（${s.label}）` : ''}: all=[${s.all.join(', ')}]${s.any.length > 0 ? ` any=[${s.any.join(', ')}]` : ''}`),
                ];
                if ((v.warnings ?? []).length > 0)
                    lines.push(`⚠ 槽位定义问题（已计入，未静默丢弃）:`, ...v.warnings.map((w) => `  - ${w}`));
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args) {
            const task = typeof args.task === 'string' ? args.task : '';
            if (task.trim() === '') {
                return { sessionId: '', kappa: '', slotCount: 0, slots: [], warnings: [], error: 'task 不能为空' };
            }
            const { slots, errors } = normalizeSlots(args.slots);
            if (slots.length === 0) {
                return { sessionId: '', kappa: '', slotCount: 0, slots: [], warnings: errors, error: '没有可用槽位（槽位是判定的前提，见 docs/semantic.md I2）' };
            }
            const { store, error: loadError } = loadStore(dir);
            if (loadError)
                logger.warn(`台账读取异常，将以空台账继续: ${loadError}`);
            const nowMs = Date.now();
            const id = newSessionId(nowMs);
            const kappa = kappaFingerprint(task, slots);
            store.sessions[id] = {
                id, task, slots, kappa, createdAtMs: nowMs,
                corpus: '', observations: [], assessments: [],
            };
            const saved = saveStore(dir, store);
            const traceError = appendTrace(dir, { kind: 'open', sessionId: id, kappa, slotCount: slots.length, warnings: errors.length });
            if (!saved.ok)
                logger.warn(`台账写入失败: ${saved.error}`);
            return dropUndefined({
                sessionId: id,
                kappa,
                slotCount: slots.length,
                slots: slots.map((s) => ({ id: s.id, label: s.label, all: s.all, any: s.any })),
                warnings: [...errors, ...(saved.ok ? [] : [`台账写入失败: ${saved.error}`]), ...(traceError ? [`留痕写入失败: ${traceError}`] : [])],
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'ev_observe',
        description: '登记一次证据操作及其返回（操作由你执行，本工具只记账）。'
            + '返回本轮的覆盖增量与缺口——这是决定「下一步还要找什么」的依据。',
        parameters: {
            sessionId: { type: 'string', description: '会话 id', required: true },
            op: { type: 'string', description: '操作名（lexical/semantic/relational/code/search 或自由文本）', required: true },
            result: { type: 'string', description: '该操作返回的证据文本（只进台账，不外发）', required: true },
            args: { type: 'string', description: '操作参数摘要' },
            sourceIds: { type: 'array', items: { type: 'string' }, description: '来源标识列表' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string', required: true },
                    seq: { type: 'number', required: true },
                    op: { type: 'string', required: true },
                    corpusChars: { type: 'number', required: true },
                    newlyCovered: { type: 'array', required: true },
                    covered: { type: 'array', required: true },
                    missing: { type: 'array', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                if (v?.error)
                    return [{ type: 'text', text: `登记失败: ${v.error}` }];
                const nw = (v.newlyCovered ?? []);
                const text = [
                    `第 ${v.seq} 轮登记（${v.op}）· 累计证据 ${v.corpusChars} 字符`,
                    nw.length > 0 ? `✓ 本轮新覆盖: ${nw.join(', ')}` : `（本轮未产生新的槽位覆盖）`,
                    `覆盖 ${(v.covered ?? []).length} / 缺口 ${(v.missing ?? []).length}`,
                    (v.missing ?? []).length > 0 ? `仍缺: ${v.missing.join(', ')}` : '',
                ].filter(Boolean);
                return [{ type: 'text', text: text.join('\n') }];
            },
        },
        async execute(args) {
            const r = withSession(args.sessionId, (e) => failObserve(args.sessionId, e), (s, store) => {
                const result = typeof args.result === 'string' ? args.result : '';
                if (s.corpus.length + result.length > config.maxCorpusChars) {
                    return {
                        sessionId: s.id, seq: s.observations.length, op: args.op ?? '',
                        corpusChars: s.corpus.length, newlyCovered: [], covered: [], missing: [],
                        error: `证据语料将超过上限 ${config.maxCorpusChars} 字符（现 ${s.corpus.length} + 本轮 ${result.length}）——`
                            + `不静默截断（截断会改变覆盖判定）。请收口本会话后另开，或提高 maxCorpusChars。`,
                    };
                }
                const before = coverageOf(s.slots, s.corpus);
                const beforeCovered = new Set(before.covered);
                s.corpus += (s.corpus === '' ? '' : '\n') + result;
                const after = coverageOf(s.slots, s.corpus);
                const newlyCovered = after.covered.filter((id) => !beforeCovered.has(id));
                const obs = {
                    seq: s.observations.length + 1,
                    op: args.op ?? '',
                    args: typeof args.args === 'string' ? args.args : '',
                    atMs: Date.now(),
                    resultChars: result.length,
                    sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds.filter((x) => typeof x === 'string') : [],
                    newlyCovered,
                };
                s.observations.push(obs);
                saveStore(dir, store);
                return {
                    sessionId: s.id, seq: obs.seq, op: obs.op,
                    corpusChars: s.corpus.length,
                    newlyCovered,
                    covered: after.covered,
                    missing: after.missing,
                    error: undefined,
                };
            });
            return dropUndefined(r);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'ev_assess',
        description: '双判读数：你给出自判（kappa_self），本工具给出独立覆盖判定（kappa_cov），返回两者的关系。'
            + '四种关系：agree_sufficient（都够）/ agree_insufficient（都不够）/ '
            + 'premature_stop（你认为够了、覆盖说没够）/ over_retrieval（你认为不够、覆盖说够了）。'
            + '自判必须你自己给——本工具不代填（判断不可代填）。',
        parameters: {
            sessionId: { type: 'string', description: '会话 id', required: true },
            selfSufficient: { type: 'boolean', description: '你的自判：证据是否已充分（必填，不可省略）', required: true },
            selfReason: { type: 'string', description: '自判理由（写清你依据什么认为够/不够）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string', required: true },
                    round: { type: 'number', required: true },
                    disagreement: { type: 'string', required: true },
                    kappa: { type: 'string', required: true },
                    covered: { type: 'array', required: true },
                    missing: { type: 'array', required: true },
                    missingDetail: { type: 'array', required: true },
                    ratio: { type: 'number', required: true },
                    traceError: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                if (v?.error)
                    return [{ type: 'text', text: `判定失败: ${v.error}` }];
                const head = {
                    agree_sufficient: '✓ 两判一致：够了',
                    agree_insufficient: '· 两判一致：还不够',
                    premature_stop: '⚠ 分歧（premature_stop）：你判够了，独立覆盖判没够',
                    over_retrieval: '· 分歧（over_retrieval）：你判不够，独立覆盖判够了',
                };
                const lines = [
                    head[v.disagreement] ?? `关系: ${v.disagreement}`,
                    `覆盖比 ${(v.ratio * 100).toFixed(1)}%（${(v.covered ?? []).length} 槽已覆盖 / ${(v.missing ?? []).length} 槽缺口）· 口径 ${v.kappa}`,
                ];
                const md = (v.missingDetail ?? []);
                if (md.length > 0) {
                    lines.push('缺口明细（决定下一步找什么）:');
                    for (const d of md) {
                        lines.push(`  • ${d.id}（${d.reason}）${d.missAll.length > 0 ? ` 缺: ${d.missAll.join(', ')}` : ''}`);
                    }
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args) {
            if (typeof args.selfSufficient !== 'boolean') {
                return { sessionId: args.sessionId ?? '', round: 0, disagreement: '', kappa: '', covered: [], missing: [], missingDetail: [], ratio: 0, error: 'selfSufficient 必须显式给布尔值（判断不可代填）' };
            }
            const r = withSession(args.sessionId, (e) => failAssess(args.sessionId, e), (s, store) => {
                const cov = coverageOf(s.slots, s.corpus);
                const covOk = covSufficient(cov);
                const kind = classify(args.selfSufficient, covOk);
                const a = {
                    round: s.assessments.length + 1,
                    atMs: Date.now(),
                    selfSufficient: args.selfSufficient,
                    selfReason: typeof args.selfReason === 'string' ? args.selfReason : '',
                    covSufficient: covOk,
                    disagreement: kind,
                    covered: cov.covered,
                    missing: cov.missing,
                    ratio: cov.ratio,
                };
                s.assessments.push(a);
                saveStore(dir, store);
                const traceError = appendTrace(dir, {
                    kind: 'assess', sessionId: s.id, kappa: s.kappa, round: a.round,
                    selfSufficient: a.selfSufficient, covSufficient: a.covSufficient,
                    disagreement: kind, covered: cov.covered, missing: cov.missing, ratio: cov.ratio,
                    corpusChars: s.corpus.length, observations: s.observations.length,
                });
                return {
                    sessionId: s.id, round: a.round, disagreement: kind, kappa: s.kappa,
                    covered: cov.covered, missing: cov.missing,
                    missingDetail: missingDetail(s.slots, cov),
                    ratio: cov.ratio,
                    error: undefined,
                    ...(traceError ? { traceError } : {}),
                };
            });
            return dropUndefined(r);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'ev_close',
        description: '收口一次证据构建会话，落一行完整读数（口径指纹、轮数、证据字符数、两判与分歧类型）。'
            + '若从未调用 ev_assess，会在读数里显式标 assessed=false（不默认有自判）。',
        parameters: {
            sessionId: { type: 'string', description: '会话 id', required: true },
            outcome: { type: 'string', description: '最终结论或答案摘要', required: true },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionId: { type: 'string', required: true },
                    kappa: { type: 'string', required: true },
                    observations: { type: 'number', required: true },
                    rounds: { type: 'number', required: true },
                    corpusChars: { type: 'number', required: true },
                    assessed: { type: 'boolean', required: true },
                    selfSufficient: { type: 'json' },
                    covSufficient: { type: 'json' },
                    disagreement: { type: 'string', required: true },
                    covered: { type: 'array', required: true },
                    missing: { type: 'array', required: true },
                    ratio: { type: 'number', required: true },
                    outcome: { type: 'string', required: true },
                    ops: { type: 'array', required: true },
                    traceError: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                if (v?.error)
                    return [{ type: 'text', text: `收口失败: ${v.error}` }];
                const lines = [
                    `收口 ${v.sessionId} · 口径 ${v.kappa}`,
                    `操作 ${v.observations} 次 · 判定 ${v.rounds} 次 · 证据 ${v.corpusChars} 字符`,
                    v.assessed
                        ? `两判：self=${v.selfSufficient ? '够' : '不够'} / cov=${v.covSufficient ? '够' : '不够'} → ${v.disagreement}`
                        : `⚠ 从未做自判（assessed=false）——本会话只有覆盖读数，没有可比较的自判断言`,
                    `覆盖 ${(v.covered ?? []).length} / 缺口 ${(v.missing ?? []).length}（比 ${(v.ratio * 100).toFixed(1)}%）`,
                ];
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args) {
            const r = withSession(args.sessionId, (e) => failClose(args.sessionId, e), (s, store) => {
                const cov = coverageOf(s.slots, s.corpus);
                const last = s.assessments[s.assessments.length - 1];
                const nowMs = Date.now();
                s.closed = { atMs: nowMs, outcome: typeof args.outcome === 'string' ? args.outcome : '', rounds: s.assessments.length, corpusChars: s.corpus.length };
                saveStore(dir, store);
                const row = {
                    sessionId: s.id, kappa: s.kappa,
                    observations: s.observations.length,
                    rounds: last?.round ?? 0,
                    corpusChars: s.corpus.length,
                    assessed: Boolean(last),
                    selfSufficient: last ? last.selfSufficient : null,
                    covSufficient: last ? last.covSufficient : covSufficient(cov),
                    disagreement: last ? last.disagreement : 'no_assessment',
                    covered: cov.covered, missing: cov.missing, ratio: cov.ratio,
                    outcome: typeof args.outcome === 'string' ? args.outcome : '',
                    ops: s.observations.map((o) => o.op),
                };
                const traceError = appendTrace(dir, { kind: 'close', ...row });
                return { ...row, error: undefined, ...(traceError ? { traceError } : {}) };
            });
            return dropUndefined(r);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'ev_report',
        description: '读数汇总：给 sessionId 返回该会话详情；省略则汇总全部会话——'
            + '含分歧率（premature_stop 占已判定会话之比）、平均轮数与平均证据字符数。',
        parameters: {
            sessionId: { type: 'string', description: '会话 id（省略=汇总全部）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    total: { type: 'number', required: true },
                    summary: { type: 'json' },
                    sessions: { type: 'array', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_a, v) => {
                if (v?.error)
                    return [{ type: 'text', text: `汇总失败: ${v.error}` }];
                const s = v.summary ?? {};
                const lines = [
                    `证据会话 ${v.total} 个 · 已判定 ${s.assessed ?? 0} 个 · 已收口 ${s.closed ?? 0} 个`,
                    `分歧: premature_stop ${s.prematureStop ?? 0} · over_retrieval ${s.overRetrieval ?? 0} · 一致 ${s.agree ?? 0}`,
                    `分歧率 ${((s.disagreementRate ?? 0) * 100).toFixed(1)}%（分母 = 已判定会话数）`,
                    `平均: 操作 ${(s.avgObservations ?? 0).toFixed(2)} 次 / 判定 ${(s.avgRounds ?? 0).toFixed(2)} 轮 / 证据 ${Math.round(s.avgCorpusChars ?? 0)} 字符`,
                    `口径指纹数 ${s.kappaCount ?? 0}（>1 表示这批读数跨了多个口径，不可直接合并比较）`,
                ];
                const rows = (v.sessions ?? []);
                if (rows.length > 0) {
                    lines.push('逐会话:');
                    for (const r of rows) {
                        lines.push(`  • ${r.sessionId} [${r.kappa}] obs=${r.observations} rounds=${r.rounds} cov=${(r.ratio * 100).toFixed(0)}% ${r.disagreement}`);
                    }
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args) {
            const { store, error } = loadStore(dir);
            if (error)
                return { total: 0, summary: null, sessions: [], error };
            const all = Object.values(store.sessions);
            const one = typeof args.sessionId === 'string' && args.sessionId !== '' ? store.sessions[args.sessionId] : undefined;
            if (typeof args.sessionId === 'string' && args.sessionId !== '' && !one) {
                return { total: all.length, summary: null, sessions: [], error: `会话不存在: ${args.sessionId}` };
            }
            const rows = (one ? [one] : all).map((s) => {
                const last = s.assessments[s.assessments.length - 1];
                const cov = coverageOf(s.slots, s.corpus);
                return {
                    sessionId: s.id, kappa: s.kappa, task: s.task,
                    observations: s.observations.length,
                    rounds: s.assessments.length,
                    corpusChars: s.corpus.length,
                    closed: Boolean(s.closed),
                    assessed: Boolean(last),
                    disagreement: last ? last.disagreement : 'no_assessment',
                    selfSufficient: last ? last.selfSufficient : null,
                    covSufficient: last ? last.covSufficient : covSufficient(cov),
                    covered: cov.covered, missing: cov.missing, ratio: cov.ratio,
                    ops: s.observations.map((o) => o.op),
                };
            });
            const assessed = rows.filter((r) => r.assessed);
            const pre = assessed.filter((r) => r.disagreement === 'premature_stop').length;
            const over = assessed.filter((r) => r.disagreement === 'over_retrieval').length;
            const agree = assessed.filter((r) => r.disagreement === 'agree_sufficient' || r.disagreement === 'agree_insufficient').length;
            const avg = (ns) => (ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length);
            const summary = {
                total: rows.length,
                assessed: assessed.length,
                closed: rows.filter((r) => r.closed).length,
                prematureStop: pre,
                overRetrieval: over,
                agree,
                disagreementRate: assessed.length === 0 ? 0 : (pre + over) / assessed.length,
                avgObservations: avg(rows.map((r) => r.observations)),
                avgRounds: avg(rows.map((r) => r.rounds)),
                avgCorpusChars: avg(rows.map((r) => r.corpusChars)),
                kappaCount: new Set(rows.map((r) => r.kappa)).size,
            };
            return dropUndefined({ total: rows.length, summary, sessions: rows });
        },
    }));
}
