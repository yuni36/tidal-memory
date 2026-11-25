// 当前状态时态：北京时间 UTC+8 打标。无开始日时禁止默认成「进行中」。
const BJ_MS = 8 * 60 * 60 * 1000;

function beijingNowParts(now = new Date()) {
    const shifted = new Date(now.getTime() + BJ_MS);
    return {
        y: shifted.getUTCFullYear(),
        m: shifted.getUTCMonth() + 1,
        d: shifted.getUTCDate(),
    };
}

/** 北京日历日 00:00 对应的 UTC 毫秒 */
function beijingDayStartMs(y, m, d) {
    return Date.UTC(y, m - 1, d) - BJ_MS;
}

function parseInstant(value) {
    if (!value) return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
}

function resolveYearless(month, day, now) {
    const bj = beijingNowParts(now);
    let y = bj.y;
    let ms = beijingDayStartMs(y, month, day);
    const delta = ms - now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    if (delta > 180 * dayMs) y -= 1;
    else if (delta < -180 * dayMs) y += 1;
    return beijingDayStartMs(y, month, day);
}

/** 文中第一个日历日当作开始；无时刻则取北京当天 00:00。 */
function parseStartFromText(content, now = new Date()) {
    const text = String(content || '');
    const iso = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (iso) {
        const y = Number(iso[1]);
        const m = Number(iso[2]);
        const d = Number(iso[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return new Date(beijingDayStartMs(y, m, d));
        }
    }
    const md = text.match(/(\d{1,2})月(\d{1,2})日?/);
    if (md) {
        const m = Number(md[1]);
        const d = Number(md[2]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return new Date(resolveYearless(m, d, now));
        }
    }
    return null;
}

function labelStateTense(state, now = new Date()) {
    const expires = parseInstant(state && state.expires_at);
    if (expires && now.getTime() > expires.getTime()) return '已结束';

    const start = parseInstant(state && state.starts_at) || parseStartFromText(state && state.content, now);
    if (!start) return '安排/时态不明';
    if (now.getTime() < start.getTime()) return '未发生';
    return '进行中';
}

function formatStateTensePrefix(state, now = new Date()) {
    return `[${labelStateTense(state, now)}]`;
}

module.exports = {
    labelStateTense,
    formatStateTensePrefix,
    parseStartFromText,
};
