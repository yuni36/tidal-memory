// services/affect/store.js
// 积温（jiwen）状态持久化 —— sanctuary.db 单行表 + 观测日志
//
// 为什么冷启动必须由这里接管：jiwen 的 opts.initialState 有 JSDoc 但没实现
// （作者 CLAUDE.md 自己写明），createJiwen 的默认状态取的是**轴下界**，
// 即 pride / valence / arousal 全是 -1。不接管的话 Assistant 一上线就是
// 「重度低落 + 完全不设防」。onLoad 的返回值是唯一能注入初值的口子。
//
// 详见 docs/affect-jiwen-p1-plan.md §2 #11

const { getDb } = require('../../database');

// 默认静息：五轴全 0（中性、无人设）。
// jiwen 自己的 DEFAULT_STATE 取的是轴下界（pride/valence/arousal = -1），
// 必须由这里接管，否则一上线就是「重度低落 + 完全不设防」。
const NEUTRAL_STATE = {
    connection: 0,
    pride: 0,
    valence: 0,
    arousal: 0,
    immersion: 0,
};

const AXIS_KEYS = ['connection', 'pride', 'valence', 'arousal', 'immersion'];

const LOG_MAX_ROWS = 5000;

// ═══════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════

function seedState() {
    try {
        getDb().prepare(`
            INSERT OR IGNORE INTO affect_state (id, state, updated_at)
            VALUES (1, ?, ?)
        `).run(JSON.stringify(NEUTRAL_STATE), new Date().toISOString());
    } catch (e) {
        console.warn('[积温] 写入初始状态失败:', e.message);
    }
}

/** jiwen 的 onLoad。返回 null 会让引擎用轴下界，所以永不返回 null。 */
function loadState() {
    let row = null;
    try {
        row = getDb().prepare('SELECT state FROM affect_state WHERE id = 1').get();
    } catch (e) {
        console.warn('[积温] 读取状态失败，回退静息态:', e.message);
        return { ...NEUTRAL_STATE };
    }

    if (!row || !row.state) {
        seedState();
        return { ...NEUTRAL_STATE };
    }

    try {
        const parsed = JSON.parse(row.state);
        if (!parsed || typeof parsed !== 'object') throw new Error('状态不是对象');
        // 任一轴缺失或非有限数 → 用静息值补，绝不让 NaN 流进引擎
        for (const k of AXIS_KEYS) {
            if (typeof parsed[k] !== 'number' || !Number.isFinite(parsed[k])) {
                parsed[k] = NEUTRAL_STATE[k];
            }
        }
        return parsed;
    } catch (e) {
        console.warn('[积温] 状态解析失败，回退静息态:', e.message);
        return { ...NEUTRAL_STATE };
    }
}

/** jiwen 的 onSave。引擎每次变更都会调，必须便宜且不抛。 */
function saveState(state) {
    try {
        getDb().prepare(`
            INSERT INTO affect_state (id, state, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
        `).run(JSON.stringify(state), new Date().toISOString());
    } catch (e) {
        console.error('[积温] 保存状态失败:', e.message);
    }
}

function getStateMeta() {
    try {
        const row = getDb().prepare('SELECT updated_at FROM affect_state WHERE id = 1').get();
        return { updatedAt: row ? row.updated_at : null };
    } catch (_) {
        return { updatedAt: null };
    }
}

// ═══════════════════════════════════════════════
// 消息源
// ═══════════════════════════════════════════════

/**
 * 最后一条**用户**消息，供 jiwen 算静默时长与涨速。
 *
 * 只看 sender='user'：connection 的语义是「多久没听见用户」，
 * Assistant 自己说了话（含主动开口）不该把这个时钟拨回去。
 *
 * 时间戳须带时区（ISO `Z` 或 `+00:00`），避免裸本地时间被错解。
 */
function lastUserMessage() {
    let row = null;
    try {
        row = getDb().prepare(`
            SELECT id, content, timestamp, is_encrypted
            FROM messages
            WHERE sender = 'user' AND content IS NOT NULL AND content != ''
            ORDER BY id DESC LIMIT 1
        `).get();
    } catch (e) {
        console.warn('[积温] 读取最后一条消息失败:', e.message);
        return null;
    }
    if (!row || !row.timestamp) return null;

    return { id: row.id, content: plainText(row), timestamp: row.timestamp };
}

/** 解密 + 剥掉富文本封装；失败一律退成空串（只用于关键词粗分类，丢了不致命）。 */
function plainText(row) {
    let text = row.content || '';
    if (row.is_encrypted || text.startsWith('enc:')) {
        try {
            const { encryption } = require('../../encryption');
            text = encryption.decrypt(text, { silent: true }) || '';
        } catch (_) {
            return '';
        }
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.components)) {
            text = parsed.components
                .filter(c => c && c.type === 'text')
                .map(c => c.content || c.text || '')
                .join(' ');
        }
    } catch (_) { /* 普通文本，不是 JSON */ }
    return String(text || '');
}

// ═══════════════════════════════════════════════
// 可维护配置（感知页维护表读写的对象）
// { profiles, urgencyBoost, rates, thresholds, connectionRates, circadian }
// ═══════════════════════════════════════════════

function loadProfile() {
    try {
        const row = getDb().prepare('SELECT profile FROM affect_profile WHERE id = 1').get();
        if (!row || !row.profile) return {};
        const parsed = JSON.parse(row.profile);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        console.warn('[积温] 读取配置失败，用内置默认:', e.message);
        return {};
    }
}

/** 整体替换配置。 */
function saveProfile(profile) {
    const body = JSON.stringify(profile || {});
    getDb().prepare(`
        INSERT INTO affect_profile (id, profile, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at
    `).run(body, new Date().toISOString());
}

/** 按顶层键合并（维护表只改其中一段时用）。 */
function patchProfile(patch) {
    const next = { ...loadProfile(), ...(patch || {}) };
    saveProfile(next);
    return next;
}

// ═══════════════════════════════════════════════
// 观测日志
// 调参时要能回查「这句语气不对」的那一刻数值落在哪一格，
// 所以 delta 与命中的语调格都要留痕（GUIDE 第二步的工作流）。
// ═══════════════════════════════════════════════

function logEvent(entry) {
    const e = entry || {};
    const s = e.state || {};
    const tone = e.tone || {};
    try {
        getDb().prepare(`
            INSERT INTO affect_log
                (at, kind, connection, pride, valence, arousal, immersion,
                 delta, cluster, pride_tier, urgency, note, message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            new Date().toISOString(),
            String(e.kind || 'tick'),
            num(s.connection), num(s.pride), num(s.valence), num(s.arousal), num(s.immersion),
            e.delta ? JSON.stringify(e.delta) : null,
            tone.cluster || null,
            Number.isInteger(tone.prideTier) ? tone.prideTier : null,
            tone.urgency || null,
            e.note || null,
            Number.isInteger(e.messageId) ? e.messageId : null,
        );
    } catch (err) {
        // 观测失败绝不能打断 tick
        console.warn('[积温] 写日志失败:', err.message);
    }
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function recentLog(limit = 50) {
    try {
        const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        return getDb().prepare(`
            SELECT * FROM affect_log ORDER BY id DESC LIMIT ?
        `).all(n);
    } catch (_) {
        return [];
    }
}

/** 最近一次 delta，给身份卡片显示「本轮变化」。 */
function lastDelta() {
    try {
        const row = getDb().prepare(`
            SELECT delta, at FROM affect_log WHERE kind = 'delta' ORDER BY id DESC LIMIT 1
        `).get();
        if (!row || !row.delta) return null;
        return { delta: JSON.parse(row.delta), at: row.at };
    } catch (_) {
        return null;
    }
}

/** 同一条消息是否已经写过 delta（防 regen / 重试双计）。messageId 用 relay 侧 id。 */
function hasDeltaForMessage(messageId) {
    if (!Number.isInteger(messageId)) return false;
    try {
        const row = getDb().prepare(`
            SELECT id FROM affect_log
            WHERE kind = 'delta' AND message_id = ?
            ORDER BY id DESC LIMIT 1
        `).get(messageId);
        return Boolean(row);
    } catch (_) {
        return false;
    }
}

/** 有界增长：tick 每 5 分钟一条，不修剪会无限长。 */
function pruneLog(maxRows = LOG_MAX_ROWS) {
    try {
        getDb().prepare(`
            DELETE FROM affect_log WHERE id NOT IN (
                SELECT id FROM affect_log ORDER BY id DESC LIMIT ?
            )
        `).run(maxRows);
    } catch (e) {
        console.warn('[积温] 修剪日志失败:', e.message);
    }
}

module.exports = {
    NEUTRAL_STATE,
    loadState,
    saveState,
    getStateMeta,
    lastUserMessage,
    loadProfile,
    saveProfile,
    patchProfile,
    logEvent,
    recentLog,
    lastDelta,
    hasDeltaForMessage,
    pruneLog,
};
