// =================================================================
// 日程（timeline_entries kind=schedule）
// 自然日 00:00–23:59 UTC+8；禁止 SQLite now/julianday 做业务判断
// =================================================================

const { getDb } = require('../database');
const { encryption } = require('../encryption');
const { callLLM } = require('./llm');
const {
    parseISO,
    calendarDateFromISO,
    currentCalendarDate,
    addCalendarDays,
    calendarDaysBetween,
    nowISOWithOffset,
    calendarWeekday,
    formatSingaporeFromISO,
} = require('../utils/time');

const PARSER_CONFIG_NAME = 'Schedule Parser';

const LEAD_BY_CATEGORY = {
    exam: 7,
    homework: 3,
    deadline: 3,
    trip: 2,
    birthday: 3,
    appointment: 1,
    class: 0,
    reminder: 1,
};

const VALID_CATEGORIES = new Set(Object.keys(LEAD_BY_CATEGORY));
const TIME_LABEL_ANCHOR = { 上午: '09:00', 下午: '14:00', 晚上: '19:00', 晚自习: '19:00', 中午: '12:00' };

function leadFor(category) {
    const c = String(category || 'reminder').toLowerCase();
    return LEAD_BY_CATEGORY[c] != null ? LEAD_BY_CATEGORY[c] : 1;
}

function normalizeDueAt(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+08:00`;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?::\d{2})?$/);
    if (m) {
        const hm = m[2].length === 4 ? `0${m[2]}` : m[2];
        return `${m[1]}T${hm}:00+08:00`;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/.test(s)
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/i.test(s)) {
        const d = parseISO(s);
        if (!d) return null;
        const ymd = calendarDateFromISO(d.toISOString());
        const hm = formatSingaporeFromISO(d.toISOString(), 'HH:mm') || '00:00';
        return `${ymd}T${hm}:00+08:00`;
    }
    // bare ISO-ish without tz
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
        const base = s.replace(/Z$/i, '').replace(/[+-]\d{2}:\d{2}$/, '');
        const parts = base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        if (parts) return `${parts[1]}T${parts[2]}:00+08:00`;
    }
    return null;
}

function normalizeEndAt(raw) {
    if (raw == null || raw === '') return null;
    return normalizeDueAt(raw);
}

function parseRecurMeta(meta) {
    if (!meta) return [];
    if (Array.isArray(meta)) return meta.map(Number).filter((n) => n >= 1 && n <= 7);
    return String(meta)
        .split(/[,，\s]+/)
        .map((x) => parseInt(x, 10))
        .filter((n) => n >= 1 && n <= 7);
}

function rowFromInput(input, { source = 'manual', existing = null } = {}) {
    const title = String(input.title || '').trim().slice(0, 50);
    if (!title) throw new Error('title 必填');

    let dueAt = normalizeDueAt(input.due_at);
    if (!dueAt) throw new Error('due_at 无效');

    const timeLabel = input.time_label ? String(input.time_label).trim().slice(0, 20) : null;
    if (timeLabel && TIME_LABEL_ANCHOR[timeLabel]) {
        const ymd = calendarDateFromISO(dueAt);
        dueAt = `${ymd}T${TIME_LABEL_ANCHOR[timeLabel]}:00+08:00`;
    }

    const endAt = normalizeEndAt(input.end_at);
    const allDay = input.all_day === true || input.all_day === 1 || input.all_day === '1' ? 1 : 0;
    let category = String(input.category || existing?.category || 'reminder').toLowerCase();
    if (!VALID_CATEGORIES.has(category)) category = 'reminder';
    const leadDays = input.lead_days != null ? Math.max(0, parseInt(input.lead_days, 10) || 0) : leadFor(category);
    const calendarDate = calendarDateFromISO(dueAt);
    if (!calendarDate) throw new Error('无法计算 calendar_date');

    const recur = ['none', 'weekly', 'yearly'].includes(input.recur) ? input.recur : (existing?.recur || 'none');
    const recurMeta = input.recur_meta != null
        ? (typeof input.recur_meta === 'string' ? input.recur_meta : JSON.stringify(input.recur_meta))
        : (existing?.recur_meta || null);

    const body = input.body != null ? String(input.body).slice(0, 2000)
        : (input.note != null ? String(input.note).slice(0, 2000) : (existing?.body || null));

    const status = ['pending', 'done', 'cancelled'].includes(input.status)
        ? input.status
        : (existing?.status || 'pending');

    const now = nowISOWithOffset();
    return {
        kind: 'schedule',
        title,
        body,
        due_at: dueAt,
        end_at: endAt,
        time_label: timeLabel,
        all_day: allDay,
        category,
        lead_days: leadDays,
        calendar_date: calendarDate,
        status,
        recur,
        recur_meta: recurMeta,
        source: source || existing?.source || 'manual',
        meta_json: input.meta_json != null
            ? (typeof input.meta_json === 'string' ? input.meta_json : JSON.stringify(input.meta_json))
            : (existing?.meta_json || null),
        created_at: existing?.created_at || now,
        updated_at: now,
    };
}

function createEntry(input, { source = 'manual' } = {}) {
    const db = getDb();
    const row = rowFromInput(input, { source });
    const r = db.prepare(`
        INSERT INTO timeline_entries (
            kind, title, body, due_at, end_at, time_label, all_day, category, lead_days,
            calendar_date, status, recur, recur_meta, source, meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.kind, row.title, row.body, row.due_at, row.end_at, row.time_label, row.all_day,
        row.category, row.lead_days, row.calendar_date, row.status, row.recur, row.recur_meta,
        row.source, row.meta_json, row.created_at, row.updated_at
    );
    return getById(r.lastInsertRowid);
}

function updateEntry(id, input) {
    const db = getDb();
    const existing = getById(id);
    if (!existing || existing.kind !== 'schedule') throw new Error('未找到日程');
    const merged = {
        ...existing,
        ...input,
        due_at: input.due_at != null ? input.due_at : existing.due_at,
        end_at: input.end_at !== undefined ? input.end_at : existing.end_at,
        time_label: input.time_label !== undefined ? input.time_label : existing.time_label,
        all_day: input.all_day !== undefined ? input.all_day : existing.all_day,
        category: input.category != null ? input.category : existing.category,
        body: input.body !== undefined ? input.body : (input.note !== undefined ? input.note : existing.body),
        status: input.status != null ? input.status : existing.status,
        recur: input.recur != null ? input.recur : existing.recur,
        recur_meta: input.recur_meta !== undefined ? input.recur_meta : existing.recur_meta,
        lead_days: input.lead_days !== undefined ? input.lead_days : undefined,
    };
    const row = rowFromInput(merged, { source: existing.source, existing });
    db.prepare(`
        UPDATE timeline_entries SET
            title=?, body=?, due_at=?, end_at=?, time_label=?, all_day=?, category=?, lead_days=?,
            calendar_date=?, status=?, recur=?, recur_meta=?, meta_json=?, updated_at=?
        WHERE id=?
    `).run(
        row.title, row.body, row.due_at, row.end_at, row.time_label, row.all_day, row.category,
        row.lead_days, row.calendar_date, row.status, row.recur, row.recur_meta, row.meta_json,
        row.updated_at, id
    );
    return getById(id);
}

function softDelete(id) {
    return updateEntry(id, { status: 'cancelled' });
}

function getById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM timeline_entries WHERE id = ?').get(id) || null;
}

function listEntries({ from, to, calendar_date, status = 'pending', kind = 'schedule' } = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM timeline_entries WHERE kind = ?';
    const params = [kind];
    if (status && status !== 'all') {
        sql += ' AND status = ?';
        params.push(status);
    }
    if (calendar_date) {
        sql += ' AND calendar_date = ?';
        params.push(calendar_date);
    } else {
        if (from) {
            sql += ' AND calendar_date >= ?';
            params.push(from);
        }
        if (to) {
            sql += ' AND calendar_date <= ?';
            params.push(to);
        }
    }
    sql += ' ORDER BY due_at ASC, id ASC';
    return db.prepare(sql).all(...params);
}

/** 展开 weekly：在 [from, to] 自然日内生成虚拟实例（带 occurrence_date） */
function expandWeekly(row, from, to) {
    const days = parseRecurMeta(row.recur_meta);
    if (!days.length) return [];
    const out = [];
    let cur = from;
    while (cur && cur <= to) {
        const wd = calendarWeekday(cur);
        if (days.includes(wd)) {
            const hm = row.all_day ? '00:00' : (formatSingaporeFromISO(row.due_at, 'HH:mm') || '00:00');
            const endHm = row.end_at ? (formatSingaporeFromISO(row.end_at, 'HH:mm') || null) : null;
            out.push({
                ...row,
                occurrence_date: cur,
                due_at: `${cur}T${hm}:00+08:00`,
                end_at: endHm ? `${cur}T${endHm}:00+08:00` : null,
                calendar_date: cur,
            });
        }
        cur = addCalendarDays(cur, 1);
    }
    return out;
}

function collectInjectable(now = new Date()) {
    const today = currentCalendarDate(now);
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM timeline_entries
        WHERE kind = 'schedule' AND status = 'pending'
        ORDER BY due_at ASC, id ASC
    `).all();

    const items = [];
    for (const row of rows) {
        const lead = row.lead_days != null ? row.lead_days : leadFor(row.category);
        const horizon = addCalendarDays(today, lead);

        if (row.recur === 'weekly') {
            const occ = expandWeekly(row, today, horizon);
            for (const o of occ) items.push(o);
            continue;
        }
        if (row.recur === 'yearly') {
            // 简化：仅当本自然年的 calendar_date 月日匹配且落在窗口
            const md = (row.calendar_date || '').slice(5);
            const thisYear = `${today.slice(0, 4)}-${md}`;
            if (thisYear >= today && thisYear <= horizon) {
                items.push({
                    ...row,
                    occurrence_date: thisYear,
                    calendar_date: thisYear,
                    due_at: row.due_at.replace(/^\d{4}-\d{2}-\d{2}/, thisYear),
                });
            }
            continue;
        }

        if (row.calendar_date >= today && row.calendar_date <= horizon) {
            items.push({ ...row, occurrence_date: row.calendar_date });
        }
    }

    items.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)) || (a.id - b.id));
    return { today, items };
}

function formatOneLine(item, today) {
    const occ = item.occurrence_date || item.calendar_date;
    const diff = calendarDaysBetween(today, occ);
    const title = item.title;
    const md = String(occ || '').slice(5).replace('-', '/'); // MM/DD

    let when;
    if (item.all_day) {
        when = md;
    } else if (item.time_label) {
        when = `${md} ${item.time_label}`;
    } else {
        const start = formatSingaporeFromISO(item.due_at, 'HH:mm');
        const end = item.end_at ? formatSingaporeFromISO(item.end_at, 'HH:mm') : '';
        when = end ? `${md} ${start}–${end}` : `${md} ${start}`;
    }

    // 更远的考试/作业/截止：补「还有 N 天」（当天不变；相对日数按注入时墙钟算）
    if (diff != null && diff > 1 && ['exam', 'homework', 'deadline'].includes(item.category)) {
        return `${when} ${title}（还有 ${diff} 天）`;
    }
    return `${when} ${title}`;
}

function formatInjectText(items, today) {
    if (!items.length) return '';
    // 按自然日分组；一律绝对日期（不用「今天/明天」——对照当轮 [输入时间]）
    const groups = new Map();
    const order = [];
    for (const it of items) {
        const occ = it.occurrence_date || it.calendar_date;
        const key = `d:${occ}`;
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key).push(it);
    }
    const lines = [];
    for (const key of order) {
        const list = groups.get(key);
        const occ = key.slice(2);
        const md = String(occ || '').slice(5).replace('-', '/');
        const parts = list.map((it) => {
            const title = it.title;
            if (it.all_day) return title;
            if (it.time_label) return `${it.time_label} ${title}`;
            const start = formatSingaporeFromISO(it.due_at, 'HH:mm');
            const end = it.end_at ? formatSingaporeFromISO(it.end_at, 'HH:mm') : '';
            return end ? `${start}–${end} ${title}` : `${start} ${title}`;
        });
        // 同行多条：09/11 08:00 A · 14:30 B；单条且带 lead 文案走 formatOneLine
        if (list.length === 1) {
            lines.push(formatOneLine(list[0], today));
        } else {
            lines.push(`${md} ${parts.join(' · ')}`);
        }
    }
    return lines.join('\n');
}

function getInjectable(now = new Date()) {
    const { today, items } = collectInjectable(now);
    const text = formatInjectText(items, today);
    return {
        today,
        items: items.map((it) => ({
            id: it.id,
            title: it.title,
            due_at: it.due_at,
            end_at: it.end_at,
            time_label: it.time_label,
            all_day: !!it.all_day,
            category: it.category,
            lead_days: it.lead_days,
            calendar_date: it.occurrence_date || it.calendar_date,
            status: it.status,
        })),
        text: text ? `[日程]\n${text}` : '',
    };
}

function bigramOverlap(a, b) {
    const tok = (t) => {
        const s = String(t || '').replace(/[，。、！？\n,.\s]+/g, '');
        const out = [];
        for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
        return out;
    };
    const setA = new Set(tok(a));
    const tb = tok(b);
    if (!tb.length) return 0;
    let n = 0;
    for (const x of tb) if (setA.has(x)) n++;
    return n / tb.length;
}

function findConflicts(items) {
    const db = getDb();
    const pending = db.prepare(`
        SELECT id, title, calendar_date FROM timeline_entries
        WHERE kind = 'schedule' AND status = 'pending'
    `).all();
    return items.map((it) => {
        const cal = calendarDateFromISO(normalizeDueAt(it.due_at) || '') || it.calendar_date;
        const hits = pending.filter(
            (p) => p.calendar_date === cal && bigramOverlap(p.title, it.title) > 0.6
        );
        return { ...it, conflicts: hits.map((h) => ({ id: h.id, title: h.title })) };
    });
}

function sanitizeParsedItem(raw, { now = new Date() } = {}) {
    const today = currentCalendarDate(now);
    const title = String(raw.title || '').trim().slice(0, 50);
    if (!title) return { drop: true, reason: '空标题' };

    let dueAt = normalizeDueAt(raw.due_at);
    if (!dueAt) return { drop: true, reason: 'due_at 无效' };

    const cal = calendarDateFromISO(dueAt);
    if (cal < today) return { drop: true, reason: '已过期' };

    const far = calendarDaysBetween(today, cal);
    const suspicious = far != null && far > 400;

    let category = String(raw.category || 'reminder').toLowerCase();
    if (!VALID_CATEGORIES.has(category)) category = 'reminder';

    const timeLabel = raw.time_label ? String(raw.time_label).trim().slice(0, 20) : null;
    const allDay = !!(raw.all_day === true || raw.all_day === 1);
    const endAt = normalizeEndAt(raw.end_at);
    const note = raw.note != null ? String(raw.note).slice(0, 500) : null;

    return {
        drop: false,
        item: {
            title,
            due_at: dueAt,
            end_at: endAt,
            time_label: timeLabel,
            all_day: allDay,
            category,
            lead_days: leadFor(category),
            calendar_date: cal,
            note,
            suspicious,
        },
    };
}

function extractJson(text) {
    const raw = String(text || '').trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('模型未返回 JSON');
    return JSON.parse(body.slice(start, end + 1));
}

/** 按 endpoint / 模型名推断 provider（前端曾写死 gemini，DS 会 401） */
function inferProvider(endpoint, modelName, explicit) {
    const ep = String(endpoint || '').toLowerCase();
    const model = String(modelName || '').toLowerCase();

    let fromHost = 'openai_compatible';
    if (ep.includes('generativelanguage.googleapis.com') && !ep.includes('/openai')) {
        fromHost = 'gemini';
    } else if (
        ep.includes('deepseek.com')
        || ep.includes('openrouter.ai')
        || ep.includes('/v1beta/openai')
        || ep.includes('openai.com')
        || ep.includes('/chat/completions')
        || model.startsWith('deepseek')
        || model.includes('gpt-')
    ) {
        fromHost = 'openai_compatible';
    } else if (ep.includes('googleapis.com')) {
        fromHost = 'gemini';
    }

    const p = String(explicit || '').trim().toLowerCase();
    if (p === 'gemini' || p === 'openai_compatible') {
        // 域名明显是 DS/兼容口时，覆盖错误写死的 gemini
        if (p === 'gemini' && fromHost === 'openai_compatible' && (
            ep.includes('deepseek.com') || ep.includes('/v1beta/openai') || ep.includes('openrouter.ai')
        )) {
            return 'openai_compatible';
        }
        return p;
    }
    return fromHost;
}

function normalizeParserEndpoint(endpoint, provider) {
    let ep = String(endpoint || '').trim();
    if (!ep) {
        return provider === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta/models/'
            : 'https://api.deepseek.com';
    }
    if (provider === 'gemini') {
        // 补 models/，避免 …/v1beta/gemini-xxx:generateContent → 404
        if (ep.includes('generativelanguage.googleapis.com') && !ep.includes('/models')) {
            ep = ep.replace(/\/+$/, '') + '/models/';
        }
        if (!ep.endsWith('/')) ep += '/';
    } else {
        ep = ep.replace(/\/+$/, '');
        // 情绪管线常用 …/v1beta/openai；DS 用根或 /v1
    }
    return ep;
}

function formatLlmHttpError(err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    let detail = '';
    try {
        detail = typeof data === 'string' ? data : JSON.stringify(data);
    } catch (_) {
        detail = String(data || '');
    }
    detail = (detail || err?.message || '').slice(0, 300);
    if (status === 401) {
        return `鉴权失败 401（Key 无效，或 provider 与 endpoint 不匹配：DS 必须用 openai_compatible + Bearer，不能走 Gemini generateContent）。${detail}`;
    }
    if (status === 404) {
        return `上游 404（模型名或 Gemini URL 缺 /models/）。${detail}`;
    }
    if (status) return `上游 HTTP ${status}：${detail}`;
    return err?.message || 'LLM 调用失败';
}

async function parseNaturalLanguage(text, { now = new Date() } = {}) {
    const input = String(text || '').trim();
    if (!input) return { items: [], unclear: ['空输入'], raw: null, error: null };

    const db = getDb();
    let cfg = db.prepare('SELECT * FROM api_configs WHERE name = ? LIMIT 1')
        .get(PARSER_CONFIG_NAME);

    // 未配 Schedule Parser 时，复用积温 affect_*（与情绪同一套 OpenAI 兼容口）
    if (!cfg) {
        try {
            const affect = require('./affect/llmConfig').getConfig();
            if (affect.base && affect.key && affect.model) {
                const provider = inferProvider(affect.base, affect.model);
                const endpoint = normalizeParserEndpoint(affect.base, provider);
                const encryptedKey = encryption.encrypt(affect.key);
                const r = db.prepare(`
                    INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
                    VALUES (?, ?, ?, ?, ?, 0, 0)
                `).run(PARSER_CONFIG_NAME, provider, endpoint, encryptedKey, affect.model);
                cfg = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(r.lastInsertRowid);
                console.log(`[schedules] 已从积温 affect_* 种子 Schedule Parser id=${cfg.id} provider=${provider}`);
            }
        } catch (e) {
            console.warn('[schedules] affect 种子失败:', e.message);
        }
    }

    if (!cfg) {
        return {
            items: [],
            unclear: [],
            error: `请先配置「${PARSER_CONFIG_NAME}」，或在设置页配好情绪分析 API（可自动同步）`,
            raw: null,
        };
    }

    // 热修：库里若仍是 gemini + deepseek 域名，纠正后再调
    const fixedProvider = inferProvider(cfg.endpoint, cfg.model_name, cfg.provider);
    if (fixedProvider !== cfg.provider) {
        console.warn(`[schedules] 纠正 provider ${cfg.provider} → ${fixedProvider}`);
        db.prepare('UPDATE api_configs SET provider = ? WHERE id = ?').run(fixedProvider, cfg.id);
        cfg.provider = fixedProvider;
    }

    const wall = nowISOWithOffset(now);
    const ymd = currentCalendarDate(now);
    const wdNames = ['一', '二', '三', '四', '五', '六', '日'];
    const wd = calendarWeekday(ymd);
    const weekdayLabel = `星期${wdNames[wd - 1]}`;

    const prompt = `你是日程解析器。根据用户一句话，提取临时日程（不要课表重复规则）。

现在是 ${wall}（北京/新加坡 UTC+8），自然日 ${ymd} ${weekdayLabel}。

规则：
1. 「下周X」= 下一个自然周（周一起算）的星期X；「周X / 这周X」= 本周内尚未到来的那个X，已过则顺延到下周。
2. 只输出绝对时间 ISO8601 带 +08:00；禁止「+7天」「下周」等相对词留在 due_at 里。
3. 说了「几点到几点」才填 end_at；只说一个时刻 end_at=null；说「上午/下午/晚上/晚自习」填 time_label，due_at 用约定钟点（上午09:00/下午14:00/晚上19:00），all_day=false；什么时刻都没说则 all_day=true，due_at 当天 00:00。
4. category 只能是：exam|homework|deadline|trip|birthday|appointment|class|reminder
5. 拿不准日期的放进 unclear，不要硬编。
6. 不要输出 recur。

只输出 JSON：
{"items":[{"title":"","due_at":"","end_at":null,"time_label":null,"category":"reminder","all_day":false,"note":null}],"unclear":[]}

用户说：
${input}`;

    let result;
    try {
        result = await callLLM(
            [{ role: 'user', parts: [{ text: prompt }] }],
            '你只输出合法 JSON，不要 markdown 围栏外的解释。',
            null,
            { temperature: 0.2, maxOutputTokens: 800 },
            cfg.id
        );
    } catch (e) {
        const msg = formatLlmHttpError(e);
        console.error('[schedules] parse LLM:', msg);
        return { items: [], unclear: [], error: msg, raw: null };
    }

    if (!result || !result.reply) {
        return { items: [], unclear: [], error: '解析模型无响应', raw: null };
    }

    let parsed;
    try {
        parsed = extractJson(result.reply);
    } catch (e) {
        return { items: [], unclear: [`JSON 解析失败: ${e.message}`], error: null, raw: result.reply };
    }

    const unclear = Array.isArray(parsed.unclear) ? parsed.unclear.map(String) : [];
    const items = [];
    for (const raw of (parsed.items || [])) {
        const r = sanitizeParsedItem(raw, { now });
        if (r.drop) {
            unclear.push(`${raw.title || '?'}: ${r.reason}`);
            continue;
        }
        items.push(r.item);
    }

    return { items: findConflicts(items), unclear, error: null, raw: result.reply };
}

function upsertParserConfig({ api_key, model_name, endpoint, provider }) {
    const db = getDb();
    const model = String(model_name || '').trim();
    if (!model) throw new Error('需要 model_name');

    const existing = db.prepare('SELECT id, api_key, endpoint, provider FROM api_configs WHERE name = ? LIMIT 1')
        .get(PARSER_CONFIG_NAME);

    const keyIn = String(api_key || '').trim();
    let encryptedKey;
    if (keyIn) {
        encryptedKey = encryption.encrypt(keyIn);
    } else if (existing?.api_key) {
        encryptedKey = existing.api_key; // 保留已存 Key（前端不回显）
    } else {
        throw new Error('需要 api_key（首次配置）');
    }

    const prov = inferProvider(endpoint || existing?.endpoint, model, provider);
    const ep = normalizeParserEndpoint(endpoint || existing?.endpoint, prov);

    if (existing) {
        db.prepare(`
            UPDATE api_configs SET api_key=?, model_name=?, endpoint=?, provider=? WHERE id=?
        `).run(encryptedKey, model, ep, prov, existing.id);
        return { id: existing.id, name: PARSER_CONFIG_NAME, model_name: model, provider: prov, endpoint: ep };
    }
    const r = db.prepare(`
        INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
        VALUES (?, ?, ?, ?, ?, 0, 0)
    `).run(PARSER_CONFIG_NAME, prov, ep, encryptedKey, model);
    return { id: r.lastInsertRowid, name: PARSER_CONFIG_NAME, model_name: model, provider: prov, endpoint: ep };
}

function getParserConfigPublic() {
    const db = getDb();
    const row = db.prepare(`
        SELECT id, name, provider, endpoint, model_name FROM api_configs WHERE name = ? LIMIT 1
    `).get(PARSER_CONFIG_NAME);
    if (!row) return { configured: false };
    return { configured: true, ...row, has_key: true };
}

/** 一键从积温 affect_* 覆盖 Schedule Parser（同 Key / base / model） */
function syncParserFromAffect() {
    const affect = require('./affect/llmConfig').getConfig();
    if (!affect.base || !affect.key || !affect.model) {
        throw new Error('情绪分析 API 未配置齐全（设置页 affect_*）');
    }
    return upsertParserConfig({
        api_key: affect.key,
        model_name: affect.model,
        endpoint: affect.base,
    });
}

/** relay 配置库里选中的「日程解析」配置 → 写入 Schedule Parser */
function setParserConfigFromRelay({ base, key, model } = {}) {
    const b = String(base || '').trim();
    const k = String(key || '').trim();
    const m = String(model || '').trim();
    if (!b || !k || !m) return null;
    return upsertParserConfig({ api_key: k, model_name: m, endpoint: b });
}

module.exports = {
    LEAD_BY_CATEGORY,
    PARSER_CONFIG_NAME,
    createEntry,
    updateEntry,
    softDelete,
    getById,
    listEntries,
    getInjectable,
    parseNaturalLanguage,
    upsertParserConfig,
    getParserConfigPublic,
    syncParserFromAffect,
    setParserConfigFromRelay,
    inferProvider,
    normalizeParserEndpoint,
    formatInjectText,
    formatOneLine,
    leadFor,
};
