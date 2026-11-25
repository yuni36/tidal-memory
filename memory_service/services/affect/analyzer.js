// services/affect/analyzer.js
// 情绪分析层 —— 用户本轮消息 → 五轴 delta → applyDelta
//
// 分工：关键词管涨速（rate.js），LLM 管 delta（本文件）。
// 默认提示词是**中性模板**：只描述五轴与规则，不绑定任何角色。
// 想复刻某种性格，在设置页或 settings.affect_prompt 里填自己的规则。
// direction=in：只分析用户消息对 Assistant 侧状态的冲击。

const { fetchWithRetry, needsProxy, getProxyDispatcher } = require('../llm');
const llmConfig = require('./llmConfig');
const { USER, AI } = require('../memoryConfig');

// 单轮硬顶：数值小幅，避免密聊半小时贴 ±1（与人设「日常温和」不是一回事）
const CLAMP = {
    pride: [-0.15, 0.15],
    valence: [-0.2, 0.2],
    arousal: [-0.2, 0.2],
    connection: [-0.5, 0.3],
    immersion: [-0.2, 0.2],
};

// 上游 GUIDE 推荐的保守兜底：LLM 失败时给 connection 一个小降幅，
// 防止「只涨不降」把角色越推越急。
const FALLBACK_DELTA = { connection: -0.15 };

function buildSystemPrompt() {
    const user = USER.name || 'User';
    const ai = AI.name || 'Assistant';
    return `你是情绪状态分析器。根据「${user}」刚发来的一条消息，估计它对「${ai}」五维情绪状态的瞬时冲击（delta）。

只输出 JSON，不要 markdown，不要解释：
{"pride":0,"valence":0,"arousal":0,"connection":0,"immersion":0,"meta":false,"note":"一句话理由"}

轴定义（delta 必须落在给定区间）：
- pride（-0.15~+0.15）：自尊 / 防御姿态。正 = 更防御、更端着；负 = 更放松、更不设防。
- valence（-0.2~+0.2）：愉悦度。正 = 好受；负 = 难受。
- arousal（-0.2~+0.2）：唤醒度。正 = 兴奋 / 焦躁；负 = 平静 / 慵懒。
- connection（-0.5~+0.3）：关系需求。对方出现 / 回应通常为负（需求被满足）；被推开或突然中断可为正。
- immersion（-0.2~+0.2）：投入度。正在忙时被分心可为负。

规则：
- 情绪状态是持续的，不随对方情绪简单镜像；对方激动时不放大。
- 多数普通轮次 delta 应接近 0。
- 单轮幅度要小，不要因为一句话把轴推到极端。
- 本轮若主要是工作 / 技术 / 系统 / 代码 / 部署 / 学业事务叙述，设 meta=true，所有轴为 0。
- note 必须与数值同向。

只输出 JSON。`;
}

const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt();
let SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;

/** 设置页覆盖分析提示词；空串 = 用内置默认 */
function setSystemPrompt(text) {
    const raw = String(text || '').trim();
    SYSTEM_PROMPT = raw || getDefaultSystemPrompt();
}

function getSystemPrompt() {
    return SYSTEM_PROMPT;
}

/** 内置默认提示词（每次都按当前称呼重建，避免改名后仍显示旧名字）。 */
function getDefaultSystemPrompt() {
    return buildSystemPrompt();
}

function clampDelta(raw) {
    const out = {};
    for (const [k, [lo, hi]] of Object.entries(CLAMP)) {
        let v = Number(raw && raw[k]);
        if (!Number.isFinite(v)) v = 0;
        out[k] = Math.max(lo, Math.min(hi, v));
    }
    return out;
}

function round4(v) {
    return Math.round(v * 10000) / 10000;
}

/**
 * 近极端同向打折：状态已在低位再负 / 已在高位再正 → 效果减弱，
 * 避免密聊叠穿 ±1。五轴一视同仁，没有哪根轴带「人设软底」。
 */
function scaleDeltaByState(delta, state) {
    const s = state || {};
    const out = { ...(delta || {}) };

    const dampenToward = (value, axisVal, negLo, posHi) => {
        let v = Number(value) || 0;
        const cur = Number(axisVal) || 0;
        if (v < 0 && cur < negLo) {
            const span = Math.abs(-1 - negLo) || 0.7;
            const dampen = Math.min(0.75, ((-cur - Math.abs(negLo)) / span) * 0.75);
            v *= (1 - Math.max(0, dampen));
        } else if (v > 0 && cur > posHi) {
            const span = Math.abs(1 - posHi) || 0.7;
            const dampen = Math.min(0.75, ((cur - posHi) / span) * 0.75);
            v *= (1 - Math.max(0, dampen));
        }
        return round4(v);
    };

    if (out.pride !== undefined) {
        out.pride = dampenToward(out.pride, s.pride, -0.5, 0.5);
    }
    if (out.valence !== undefined) {
        out.valence = dampenToward(out.valence, s.valence, -0.3, 0.3);
    }
    if (out.arousal !== undefined) {
        out.arousal = dampenToward(out.arousal, s.arousal, -0.3, 0.3);
    }

    return clampDelta(out);
}

function parseDeltaJson(text) {
    const raw = String(text || '').trim();
    let jsonStr = raw;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) jsonStr = fence[1].trim();
    else {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) jsonStr = raw.slice(start, end + 1);
    }
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') throw new Error('delta 不是对象');
    return {
        delta: clampDelta(parsed),
        meta: Boolean(parsed.meta),
        note: String(parsed.note || '').slice(0, 200),
    };
}

/**
 * 调第五组 LLM。不走 api_configs / 全局 LLM 队列，避免挡住 Scribe，
 * 也避免把记忆管线模型改成分析模型。
 */
async function callAffectLLM(userText, recentContext) {
    if (!llmConfig.isReady()) {
        throw new Error('affect LLM 未配置或分析未启用');
    }
    const cfg = llmConfig.getConfig();
    const url = `${cfg.base}/chat/completions`;
    const userContent = [
        recentContext ? `最近几轮上下文（仅供消歧，delta 只针对「本轮」）：\n${recentContext}\n` : '',
        `本轮${USER.name || 'User'}说：\n${userText}`,
    ].join('');

    const body = {
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
    };

    // DeepSeek 等国内站不需要代理；海外才借 llm.js 的 ProxyAgent
    const dispatcher = needsProxy(url) ? getProxyDispatcher() : undefined;
    // 超时/失败本轮就算了，不重试（主链已旁路；重试只会拖积温、无助于回复）
    const resp = await fetchWithRetry(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
    }, 0);

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`affect LLM HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('affect LLM 空响应');
    return parseDeltaJson(content);
}

/**
 * 分析一条用户消息。永不抛到路由外：失败返回 fallback。
 * @param {string} userText
 * @param {string} [recentContext]
 * @param {object} [currentState] 若传入，会按近极端对 delta 再打折
 * @returns {{ delta, meta, note, fallback: boolean }}
 */
async function analyze(userText, recentContext = '', currentState = null) {
    const text = String(userText || '').trim();
    if (!text) {
        return {
            delta: { ...FALLBACK_DELTA },
            meta: false,
            note: '空消息兜底',
            fallback: true,
        };
    }
    try {
        const result = await callAffectLLM(text, recentContext);
        // 元讨论：强制清零（模型偶发漏标）
        if (result.meta) {
            result.delta = clampDelta({});
            result.note = result.note || '元讨论';
        } else if (currentState) {
            result.delta = scaleDeltaByState(result.delta, currentState);
        }
        return { ...result, fallback: false };
    } catch (e) {
        console.warn('[积温] 分析失败，兜底 connection-0.15:', e.message);
        return {
            delta: { ...FALLBACK_DELTA },
            meta: false,
            note: `fallback: ${e.message}`.slice(0, 200),
            fallback: true,
        };
    }
}

module.exports = {
    analyze,
    clampDelta,
    scaleDeltaByState,
    FALLBACK_DELTA,
    setSystemPrompt,
    getSystemPrompt,
    getDefaultSystemPrompt,
    CLAMP,
};
