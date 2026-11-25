// services/affect/pending.js
// contact 待发送队列 —— tick 只入队，brain 拉走后 ack 才扣 connection
//
// 去重：同时只保留一条 contact（刷新 urgency / forced）
// 冷却：发送成功后 COOLDOWN_MS 内不再入队（forced 也遵守，防连发）
// observation / find_activity：本阶段只打日志，不入队（§11）
//
// 详见 docs/affect-jiwen-p1-plan.md §8 P4

const COOLDOWN_MS = Math.round(2.75 * 60 * 60 * 1000); // ≈2.75h：配合 3~5h 攒温 ≈一天 2~4 次

let _pending = null;
let _lastSentAt = 0;
let _seq = 1;

function list() {
    if (!_pending) return [];
    return [{ ..._pending }];
}

function peek() {
    return _pending ? { ..._pending } : null;
}

/**
 * 从 tick 触发里筛 contact 入队。
 * @returns {object|null} 当前 pending
 */
function ingest(triggers, state, meta = {}) {
    const contacts = (triggers || []).filter(t => t && t.action === 'contact');
    if (!contacts.length) return _pending;

    // 夜里宁可安静：不新入队（已有 pending 仍保留，天亮再发）
    try {
        if (require('./rate').isNight()) {
            return _pending;
        }
    } catch (_) { /* ignore */ }

    const now = Date.now();
    if (_lastSentAt && now - _lastSentAt < COOLDOWN_MS) {
        return _pending; // 冷却中，不刷新也不新建
    }

    const best = contacts.reduce((a, b) => {
        const au = Number(a.urgency) || 0;
        const bu = Number(b.urgency) || 0;
        if (Boolean(b.forced) !== Boolean(a.forced)) return b.forced ? b : a;
        return bu >= au ? b : a;
    });

    const connection = state && typeof state.connection === 'number' ? state.connection : null;
    const forced = Boolean(best.forced) || (connection != null && connection >= 0.50);
    const desperate = forced || (connection != null && connection >= 0.50);

    if (_pending) {
        _pending.urgency = best.urgency;
        _pending.forced = forced;
        _pending.desperate = desperate;
        _pending.connection = connection;
        _pending.updatedAt = new Date().toISOString();
        if (meta.description) _pending.description = meta.description;
        if (meta.styleGuidance) _pending.styleGuidance = meta.styleGuidance;
        return _pending;
    }

    _pending = {
        id: `c${_seq++}_${now}`,
        action: 'contact',
        urgency: best.urgency,
        forced,
        desperate,
        connection,
        description: meta.description || '',
        styleGuidance: meta.styleGuidance || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return _pending;
}

/** 发送成功：清队列 + 记冷却。失败则保留以便重试。 */
function ack(id, { success } = {}) {
    if (!_pending || (_pending.id !== id && id != null)) {
        return { ok: false, reason: 'not_found', pending: peek() };
    }
    if (success) {
        _lastSentAt = Date.now();
        const cleared = _pending;
        _pending = null;
        return { ok: true, cleared, lastSentAt: new Date(_lastSentAt).toISOString() };
    }
    return { ok: true, kept: true, pending: peek() };
}

function cooldownRemainingMs() {
    if (!_lastSentAt) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - _lastSentAt));
}

function status() {
    return {
        pending: peek(),
        cooldownMs: cooldownRemainingMs(),
        lastSentAt: _lastSentAt ? new Date(_lastSentAt).toISOString() : null,
        cooldownHours: COOLDOWN_MS / 3600000,
    };
}

/** 测试用 */
function _resetForTests() {
    _pending = null;
    _lastSentAt = 0;
}

module.exports = {
    list,
    peek,
    ingest,
    ack,
    status,
    COOLDOWN_MS,
    _resetForTests,
};
