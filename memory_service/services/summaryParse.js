/**
 * summary 输出解析（无 DB / 无加密依赖，可供单测）
 */

const {
    isNear,
    hmOnLogicalDateToISO,
    extractLineHm,
    volumeKeyFromHm,
    DEFAULT_WINDOW_HOURS,
} = require('./summaryWindow');

/** 每卷最多 1 条（远整点 / 近20min） */
const MAX_PER_VOLUME = 1;
/** 单条描述字数硬顶 */
const LINE_MAX_CHARS = 50;

function extractFencedBlock(text, fence) {
    if (!text || !fence) return '';
    const re = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)```', 'i');
    const m = String(text).match(re);
    return m ? m[1].trim() : '';
}

function stripNearFarTags(text) {
    return String(text || '')
        .replace(/\[远\|\d{2}\]\s*/g, '')
        .replace(/\[近\|\d{2}:\d{2}\]\s*/g, '')
        .replace(/\[近\]\s*/g, '')
        .replace(/\[远\]\s*/g, '');
}

function charLen(s) {
    return [...String(s || '')].length;
}

function truncateLineDesc(line, maxChars = LINE_MAX_CHARS) {
    const m = String(line).match(/^-\s*(\d{1,2}:\d{2}(?:\s*[-～~]\s*\d{1,2}:\d{2})?)\s*(\[[^\]]+\]:\s*)(.*)$/);
    if (!m) {
        const body = String(line).replace(/^[-*]\s+/, '');
        return body ? `- ${body}` : line;
    }
    let time = m[1].replace(/\s*[-～~]\s*/, '-');
    time = time.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, min) => `${String(h).padStart(2, '0')}:${min}`);
    let desc = m[3];
    if (charLen(desc) > maxChars) {
        desc = [...desc].slice(0, Math.max(1, maxChars - 1)).join('') + '…';
    }
    return `- ${time} ${m[2]}${desc}`;
}

/**
 * 规范化 daily_events：只保留 ## 时序；丢弃 ## 重要；去掉卷标泄漏
 */
function normalizeDailyEventsText(raw) {
    if (!raw || !String(raw).trim()) return '';
    const lines = String(raw).split('\n').map((l) => stripNearFarTags(l).trim()).filter(Boolean);
    const events = [];

    for (const line of lines) {
        if (/^##\s*时序\s*$/i.test(line)) continue;
        if (/^##\s*重要\s*$/i.test(line)) continue;
        if (/^##\s/.test(line)) continue;
        const body = line.replace(/^[-*]\s+/, '');
        if (!body) continue;
        if (body === '（无）' || body === '(无)') continue;
        events.push(`- ${body}`);
    }

    if (!events.length) return '';
    return ['## 时序', ...events].join('\n');
}

/**
 * 按卷截断：远=整点卷、近=20min 卷，每卷最多 1 条；保留模型顺序的首条。
 */
function enforceVolumeDensity(text, endTs, opts = {}) {
    const maxPer = opts.maxPerVolume ?? MAX_PER_VOLUME;
    const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
    const logicalDate = opts.logicalDate || '';
    const maxChars = opts.maxChars ?? LINE_MAX_CHARS;

    const normalized = normalizeDailyEventsText(text);
    if (!normalized) return '';

    const eventLines = normalized
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^##\s/.test(l));

    /** @type {Map<string, string[]>} volumeKey -> lines */
    const buckets = new Map();
    const orphans = [];

    for (const line of eventLines) {
        const hm = extractLineHm(line);
        if (!hm) {
            orphans.push(truncateLineDesc(line, maxChars));
            continue;
        }
        let near = false;
        if (endTs && logicalDate) {
            const iso = hmOnLogicalDateToISO(logicalDate, hm);
            near = isNear(iso, endTs, windowHours);
        }
        const key = volumeKeyFromHm(hm, near) || `远|${hm.slice(0, 2)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(truncateLineDesc(line, maxChars));
    }

    const keys = [...buckets.keys()].sort((a, b) => {
        const ha = a.match(/(\d{2})(?::(\d{2}))?/);
        const hb = b.match(/(\d{2})(?::(\d{2}))?/);
        const ra = ha ? (Number(ha[1]) < 4 ? Number(ha[1]) + 24 : Number(ha[1])) * 60 + Number(ha[2] || 0) : 0;
        const rb = hb ? (Number(hb[1]) < 4 ? Number(hb[1]) + 24 : Number(hb[1])) * 60 + Number(hb[2] || 0) : 0;
        return ra - rb;
    });

    const out = ['## 时序'];
    for (const key of keys) {
        const lines = buckets.get(key) || [];
        out.push(...lines.slice(0, maxPer));
    }
    out.push(...orphans);
    return out.length > 1 ? out.join('\n') : '';
}

/** @deprecated 旧名；等价于 enforceVolumeDensity */
function enforceHourDensity(text, endTs, opts = {}) {
    return enforceVolumeDensity(text, endTs, {
        ...opts,
        maxPerVolume: opts.nearMax != null || opts.farMax != null
            ? Math.min(opts.nearMax ?? 1, opts.farMax ?? 1)
            : MAX_PER_VOLUME,
    });
}

function dailyEventsForInject(raw) {
    return normalizeDailyEventsText(raw);
}

function filterAiSubjectLines(text, aiNames = []) {
    const names = (aiNames || []).map((n) => String(n || '').trim()).filter(Boolean);
    if (!names.length) {
        try {
            const { AI } = require('./memoryConfig');
            if (AI?.name) names.push(AI.name);
        } catch (_) { /* keep empty → fallback below */ }
        if (!names.length) names.push('Assistant');
    }
    const nameRe = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const timePrefix = String.raw`\s*-\s*\d{1,2}:\d{2}(?:\s*[-～~]\s*\d{1,2}:\d{2})?\s*\[[^\]]+\]:\s*`;
    const subj = new RegExp(`^(${timePrefix})(?:${nameRe})(?![\\u4e00-\\u9fff])`);
    let userName = 'User';
    try {
        const { USER } = require('./memoryConfig');
        if (USER?.name) userName = USER.name;
    } catch (_) { /* keep default */ }
    const userRe = new RegExp(`^(${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Clara)`);
    const lines = String(text || '').split('\n');
    const kept = [];
    for (const line of lines) {
        if (/^##\s/.test(line.trim())) {
            kept.push(line);
            continue;
        }
        if (subj.test(line)) continue;
        const m = line.match(new RegExp(`^${timePrefix}(.*)$`));
        if (m) {
            const body = m[1];
            const startsUser = userRe.test(body);
            if (!startsUser && new RegExp(`^(?:${nameRe})`).test(body)) continue;
        }
        kept.push(line);
    }
    return kept.join('\n');
}

module.exports = {
    extractFencedBlock,
    normalizeDailyEventsText,
    enforceVolumeDensity,
    enforceHourDensity,
    stripNearFarTags,
    dailyEventsForInject,
    filterAiSubjectLines,
    MAX_PER_VOLUME,
    LINE_MAX_CHARS,
};
