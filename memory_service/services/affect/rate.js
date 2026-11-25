// services/affect/rate.js
// 连接需求涨速（connectionRateFn）+ 深夜偏置
//
// 分工：关键词只决定「涨多快」，轴 delta 归 LLM 分析层（analyzer.js）。
// 下面的词表是**中性示例**，按自己的聊天习惯替换；日常改词 / 改速率优先写 DB 的 affect_profile。

const store = require('./store');

// ── tag → 速率（计划 §4 表）。DB profile.connectionRates 覆盖本表 ──
// 单位：connection / 分钟。0.0012 ≈ 4.9h 到 0.35（考虑开口）、6.9h 到 0.50（强制）
// P1 线上实测：0.0007 在真实聊天密度下 43h 峰值仅 0.21，从未越线。
const DEFAULT_RATES = {
    fragile: 0.0018,     // 对方难过，更快惦记
    conflict: 0.0014,
    body_harm: 0.0013,
    affection: 0.0009,
    reject: 0.0006,
    busy: 0.00045,       // 打过招呼，慢
    none: 0.0015,        // ≈3.9h → 0.35；配合冷却 ≈白天 2~4 次
    short: 0.0016,
};

// 优先级（高→低）
const TAG_PRIORITY = ['fragile', 'conflict', 'reject', 'body_harm', 'affection', 'busy'];

// 子串匹配，不做分词。短语宁长勿短——「嗯」「还好」等歧义词一律不收。
const DEFAULT_PATTERNS = {
    fragile: [
        '刚睡醒', '刚醒', '睡醒', '头晕', '好疼', '好哭', '哭了', '委屈', '难过',
        '好难受', '难受', '好累', '睡不着', '好困', '心慌', '无力', '崩溃', '破防',
    ],
    conflict: [
        '语气', '不适', '你刚才', '不该', '生气', '吵架', '过分', '凭什么', '讨厌',
        '凶我', '你凶', '别凶', '烦死', '好烦', '态度', '你错了', '别跟我', '别这样',
    ],
    reject: [
        '不想理你', '不想理', '懒得理', '别烦我', '别理我', '走开', '滚', '闭嘴',
        '够了', '不想聊', '别说了',
    ],
    body_harm: ['熬夜', '通宵', '还没睡', '不睡觉', '凌晨', '还在刷'],
    affection: ['亲亲', '爱你', '抱抱', '好想你', '想你', '喜欢你'],
    busy: ['晚安', '去睡', '去睡了', '睡了', '在忙', '开会', '我去上课', '在上课'],
};

// 深夜：宁可安静。另有 pending/proactive 夜门禁。
const DEFAULT_CIRCADIAN = {
    nightStart: 23,
    nightEnd: 8,
    nightRate: 0.00008,
    nightArousalBias: -0.35,
};

// 无命中时按长度分档的界限（「嗯」「哦」「在吗」这类）
const SHORT_MESSAGE_CHARS = 4;

function cfg() {
    const profile = store.loadProfile();
    return {
        rates: { ...DEFAULT_RATES, ...(profile.connectionRates || {}) },
        patterns: { ...DEFAULT_PATTERNS, ...(profile.tagPatterns || {}) },
        circadian: { ...DEFAULT_CIRCADIAN, ...(profile.circadian || {}) },
    };
}

/** 按 TAG_PRIORITY 取最高 tag；无命中返回 null。 */
function classify(text, patterns) {
    const hay = String(text || '');
    if (!hay) return null;
    const table = patterns || cfg().patterns;
    for (const tag of TAG_PRIORITY) {
        const list = table[tag] || [];
        for (const p of list) {
            if (p && hay.includes(p)) return tag;
        }
    }
    return null;
}

/** 用服务器本地小时的昼夜判断。跨零点用或逻辑。 */
function isNight(date, circadian) {
    const c = circadian || cfg().circadian;
    const h = (date || new Date()).getHours();
    if (c.nightStart === c.nightEnd) return false;
    return c.nightStart > c.nightEnd
        ? (h >= c.nightStart || h < c.nightEnd)   // 23 → 8，跨零点
        : (h >= c.nightStart && h < c.nightEnd);
}

/**
 * jiwen 的 connectionRateFn。入参是 getLastMessage() 的返回值。
 *
 * 深夜整体压到 nightRate（所有 tag 一视同仁）——抑制必须落在这里，
 * 因为 arousal 偏置只改语气、拦不住 contact。
 */
function connectionRateFn(lastMsg) {
    return explain(lastMsg).rate;
}

/** 同一套判断，附带理由。给 tick 日志与 /affect/state 用，避免两处算法漂移。 */
function explain(lastMsg) {
    const { rates, patterns, circadian } = cfg();
    const now = new Date();

    if (isNight(now, circadian)) {
        return { rate: circadian.nightRate, tag: null, night: true, reason: 'night' };
    }

    const text = (lastMsg && lastMsg.content) || '';
    const tag = classify(text, patterns);
    if (tag) {
        const r = rates[tag];
        return {
            rate: typeof r === 'number' ? r : rates.none,
            tag,
            night: false,
            reason: `tag:${tag}`,
        };
    }

    const short = text.trim().length > 0 && text.trim().length <= SHORT_MESSAGE_CHARS;
    return {
        rate: short ? rates.short : rates.none,
        tag: null,
        night: false,
        reason: short ? 'short' : 'none',
    };
}

/**
 * 每 tick 偏置（走 getSagaBias）。
 * 中性默认：等待不改变任何轴，只保留夜间压低 arousal。
 * 想要「越等越软 / 越等越躁」，在 affect_profile.rates 里自己配，不要写死在这里。
 */
function waitingBias(date) {
    const { circadian } = cfg();
    const night = isNight(date || new Date(), circadian);
    return {
        connection: 0,
        pride: 0,
        valence: 0,
        arousal: night ? circadian.nightArousalBias : 0,
        immersion: 0,
    };
}

/** @deprecated 用 waitingBias；保留别名 */
function circadianBias(date) {
    return waitingBias(date);
}

module.exports = {
    connectionRateFn,
    circadianBias,
    waitingBias,
    classify,
    isNight,
    explain,
    defaults: { rates: DEFAULT_RATES, patterns: DEFAULT_PATTERNS, circadian: DEFAULT_CIRCADIAN },
};
