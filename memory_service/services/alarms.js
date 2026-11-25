// =================================================================
// 自醒闹钟（复用/改造 alarms 表）
// 自然日 UTC+8 占坑限额；禁止 SQLite now 做业务判断
// =================================================================

const { getDb } = require('../database');
const {
    parseISO,
    calendarDateFromISO,
    nowISOWithOffset,
} = require('../utils/time');

const DAILY_CAP = 20;
const PENDING_CAP = 10;
const NOTE_MIN = 8;
const NOTE_MAX = 40;

function toISOPlus08(d) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Singapore',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

function normalizeAt(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+08:00`;
    const loose = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?::(\d{2}))?$/);
    if (loose) {
        const hm = loose[2].length === 4 ? `0${loose[2]}` : loose[2];
        const sec = loose[3] || '00';
        return `${loose[1]}T${hm}:${sec}+08:00`;
    }
    const d = parseISO(s);
    if (!d) return null;
    return toISOPlus08(d);
}

function normalizeNote(raw) {
    const note = String(raw == null ? '' : raw).trim();
    if (note.length < NOTE_MIN) {
        return { error: `留言至少 ${NOTE_MIN} 字（现在 ${note.length}）` };
    }
    if (note.length > NOTE_MAX) {
        return { error: `留言最多 ${NOTE_MAX} 字（现在 ${note.length}）` };
    }
    return { note };
}

function countOccupying(calendarDate) {
    const db = getDb();
    const row = db.prepare(`
        SELECT COUNT(*) AS c FROM alarms
        WHERE calendar_date = ? AND status IN ('pending','firing','fired')
    `).get(calendarDate);
    return Number(row?.c || 0);
}

function countPending() {
    const db = getDb();
    const row = db.prepare(`
        SELECT COUNT(*) AS c FROM alarms WHERE status = 'pending'
    `).get();
    return Number(row?.c || 0);
}

function remainingToday(calendarDate) {
    return Math.max(0, DAILY_CAP - countOccupying(calendarDate));
}

function rowPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        at: row.trigger_at,
        note: row.message,
        calendar_date: row.calendar_date,
        status: row.status,
        created_at: row.created_at,
        fired_at: row.fired_at || null,
        updated_at: row.updated_at,
    };
}

/**
 * 设自醒。占坑按 trigger 所在自然日计。
 * @returns {{ ok: true, alarm, remaining_today } | { ok: false, error }}
 */
function create({ at, note } = {}) {
    const triggerAt = normalizeAt(at);
    if (!triggerAt) return { ok: false, error: 'at 无效，请用 ISO+08:00 绝对时间' };

    const when = parseISO(triggerAt);
    if (!when) return { ok: false, error: 'at 无法解析' };
    if (when.getTime() <= Date.now() + 15_000) {
        return { ok: false, error: '唤醒时间须在约 15 秒之后' };
    }

    const nn = normalizeNote(note);
    if (nn.error) return { ok: false, error: nn.error };

    const cal = calendarDateFromISO(triggerAt);
    if (!cal) return { ok: false, error: '无法计算自然日' };

    if (countPending() >= PENDING_CAP) {
        return { ok: false, error: `待响闹钟已满 ${PENDING_CAP} 个，先取消几个` };
    }
    const used = countOccupying(cal);
    if (used >= DAILY_CAP) {
        return { ok: false, error: `该日（${cal}）自醒已满 ${DAILY_CAP} 次` };
    }

    const now = nowISOWithOffset();
    const db = getDb();
    const info = db.prepare(`
        INSERT INTO alarms (trigger_at, message, calendar_date, status, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(triggerAt, nn.note, cal, now, now);

    const alarm = rowPublic(db.prepare('SELECT * FROM alarms WHERE id = ?').get(info.lastInsertRowid));
    return {
        ok: true,
        alarm,
        remaining_today: remainingToday(cal),
    };
}

function cancel(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM alarms WHERE id = ?').get(Number(id));
    if (!row) return { ok: false, error: '未找到该闹钟' };
    if (row.status !== 'pending') {
        return { ok: false, error: `只有 pending 可取消（当前 ${row.status}）` };
    }
    const now = nowISOWithOffset();
    db.prepare(`UPDATE alarms SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, row.id);
    return {
        ok: true,
        alarm: rowPublic({ ...row, status: 'cancelled', updated_at: now }),
        remaining_today: remainingToday(row.calendar_date),
    };
}

function listPending() {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM alarms WHERE status = 'pending'
        ORDER BY trigger_at ASC, id ASC
    `).all().map(rowPublic);
}

/** 到期且仍 pending 的闹钟（nowISO 由调用方传入，默认当前） */
function listDue(nowIso) {
    const now = normalizeAt(nowIso) || nowISOWithOffset();
    const db = getDb();
    return db.prepare(`
        SELECT * FROM alarms
        WHERE status = 'pending' AND trigger_at <= ?
        ORDER BY trigger_at ASC, id ASC
        LIMIT 5
    `).all(now).map(rowPublic);
}

/** pending → firing；失败返回 null */
function claim(id) {
    const db = getDb();
    const now = nowISOWithOffset();
    const info = db.prepare(`
        UPDATE alarms SET status = 'firing', updated_at = ?
        WHERE id = ? AND status = 'pending'
    `).run(now, Number(id));
    if (!info.changes) return null;
    return rowPublic(db.prepare('SELECT * FROM alarms WHERE id = ?').get(Number(id)));
}

/** firing → fired | missed */
function ack(id, success) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM alarms WHERE id = ?').get(Number(id));
    if (!row) return { ok: false, error: '未找到' };
    if (row.status !== 'firing' && row.status !== 'pending') {
        return { ok: false, error: `状态不可 ack（${row.status}）` };
    }
    const now = nowISOWithOffset();
    if (success) {
        db.prepare(`
            UPDATE alarms SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, row.id);
    } else {
        db.prepare(`
            UPDATE alarms SET status = 'missed', updated_at = ? WHERE id = ?
        `).run(now, row.id);
    }
    return { ok: true, alarm: rowPublic(db.prepare('SELECT * FROM alarms WHERE id = ?').get(row.id)) };
}

function getById(id) {
    const db = getDb();
    return rowPublic(db.prepare('SELECT * FROM alarms WHERE id = ?').get(Number(id)));
}

module.exports = {
    DAILY_CAP,
    PENDING_CAP,
    NOTE_MIN,
    NOTE_MAX,
    create,
    cancel,
    listPending,
    listDue,
    claim,
    ack,
    getById,
    countOccupying,
    remainingToday,
    normalizeAt,
    normalizeNote,
};
