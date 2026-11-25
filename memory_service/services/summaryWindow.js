/**
 * 事件线近/远窗 + 分卷（每次固化按 endTs 重算）
 * 远卷：整点 1h → key 远|HH，区间 HH:00-(HH+1):00
 * 近卷：20min → key 近|HH:MM，区间 start-(start+20)
 */
const { parseISO, formatSingaporeFromISO } = require('../utils/time');

const DEFAULT_WINDOW_HOURS = 2;
const NEAR_BUCKET_MINUTES = 20;

function toMs(isoOrDate) {
    if (isoOrDate instanceof Date) {
        return Number.isNaN(isoOrDate.getTime()) ? null : isoOrDate.getTime();
    }
    const d = parseISO(isoOrDate);
    return d ? d.getTime() : null;
}

function isNear(ts, endTs, windowHours = DEFAULT_WINDOW_HOURS) {
    const t = toMs(ts);
    const end = toMs(endTs);
    if (t == null || end == null) return false;
    const windowMs = Math.max(0, Number(windowHours) || DEFAULT_WINDOW_HOURS) * 3600000;
    return t > end - windowMs;
}

function windowTag(ts, endTs, windowHours = DEFAULT_WINDOW_HOURS) {
    return isNear(ts, endTs, windowHours) ? '近' : '远';
}

function extractLineHm(line) {
    // 优先取区间起点 08:00-09:00 / 08:00～09:00
    const range = String(line || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*[-～~]\s*(?:[01]?\d|2[0-3]):[0-5]\d\b/);
    if (range) return `${range[1].padStart(2, '0')}:${range[2]}`;
    const m = String(line || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!m) return '';
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function hmOnLogicalDateToISO(logicalDate, hm) {
    if (!logicalDate || !hm || !/^\d{4}-\d{2}-\d{2}$/.test(logicalDate)) return '';
    const [hh, mm] = hm.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '';
    let cal = logicalDate;
    if (hh < 4) {
        const [y, m, d] = logicalDate.split('-').map(Number);
        const utc = Date.UTC(y, m - 1, d, 12, 0, 0) + 86400000;
        const x = new Date(utc);
        cal = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
    }
    return `${cal}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`;
}

function floorNearBucket(hm) {
    const [h, m] = String(hm).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
    const bucket = Math.floor(m / NEAR_BUCKET_MINUTES) * NEAR_BUCKET_MINUTES;
    return `${String(h).padStart(2, '0')}:${String(bucket).padStart(2, '0')}`;
}

function addMinutesToHm(hm, deltaMin) {
    const [h, m] = String(hm).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
    let total = h * 60 + m + deltaMin;
    total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    const nh = Math.floor(total / 60);
    const nm = total % 60;
    return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/** @returns {string} '远|09' | '近|21:00' | '' */
function volumeKeyFromHm(hm, near) {
    if (!hm) return '';
    const [h] = hm.split(':');
    if (near) {
        const start = floorNearBucket(hm);
        return start ? `近|${start}` : '';
    }
    return `远|${String(h).padStart(2, '0')}`;
}

function volumeKeyFromTs(ts, endTs, windowHours = DEFAULT_WINDOW_HOURS) {
    const hm = formatSingaporeFromISO(ts, 'HH:mm');
    if (!hm) return '';
    return volumeKeyFromHm(hm, isNear(ts, endTs, windowHours));
}

/** '远|08' → '08:00-09:00'；'近|20:20' → '20:20-20:40' */
function volumeRangeLabel(key) {
    const far = String(key || '').match(/^远\|(\d{2})$/);
    if (far) {
        const start = `${far[1]}:00`;
        return `${start}-${addMinutesToHm(start, 60)}`;
    }
    const near = String(key || '').match(/^近\|(\d{2}:\d{2})$/);
    if (near) {
        return `${near[1]}-${addMinutesToHm(near[1], NEAR_BUCKET_MINUTES)}`;
    }
    return '';
}

function stripWindowTags(text) {
    return String(text || '')
        .replace(/\[远\|\d{2}\]\s*/g, '')
        .replace(/\[近\|\d{2}:\d{2}\]\s*/g, '')
        .replace(/\[近\]\s*/g, '')
        .replace(/\[远\]\s*/g, '')
        .trim();
}

function sortVolumeKeys(keys) {
    return [...keys].sort((a, b) => {
        const ha = a.match(/(\d{2})(?::(\d{2}))?/);
        const hb = b.match(/(\d{2})(?::(\d{2}))?/);
        const ra = ha ? (Number(ha[1]) < 4 ? Number(ha[1]) + 24 : Number(ha[1])) * 60 + Number(ha[2] || 0) : 0;
        const rb = hb ? (Number(hb[1]) < 4 ? Number(hb[1]) + 24 : Number(hb[1])) * 60 + Number(hb[2] || 0) : 0;
        return ra - rb;
    });
}

function lineToVolumeKey(line, endTs, logicalDate, windowHours = DEFAULT_WINDOW_HOURS) {
    const cleaned = stripWindowTags(line);
    const hm = extractLineHm(cleaned);
    if (!hm) return '';
    let near = false;
    if (logicalDate && endTs) {
        const iso = hmOnLogicalDateToISO(logicalDate, hm);
        near = isNear(iso, endTs, windowHours);
    }
    return volumeKeyFromHm(hm, near);
}

/**
 * 每次固化重算分卷：已有行按当前近远界挂卷（近→远自动并入整点卷）；
 * 本批消息按时间落入卷；空卷跳过。
 * dirty = 有新对话，或同卷已有 >1 条（需再压）。
 */
function buildVolumeBundles({ dialogEntries, existingText, endTs, logicalDate, windowHours = DEFAULT_WINDOW_HOURS }) {
    /** @type {Map<string, {key:string, near:boolean, rangeLabel:string, existing:string[], dialog:string[]}>} */
    const map = new Map();
    const ensure = (key) => {
        if (!map.has(key)) {
            map.set(key, {
                key,
                near: key.startsWith('近'),
                rangeLabel: volumeRangeLabel(key),
                existing: [],
                dialog: [],
            });
        }
        return map.get(key);
    };

    const rawExisting = String(existingText || '').trim();
    if (rawExisting && rawExisting !== '（尚无）' && rawExisting !== '（尚无记录）') {
        for (const line of rawExisting.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || /^##\s/.test(trimmed)) continue;
            const cleaned = stripWindowTags(trimmed).replace(/^[-*]\s+/, '');
            if (!cleaned || cleaned === '（无）' || cleaned === '(无)') continue;
            const key = lineToVolumeKey(cleaned, endTs, logicalDate, windowHours);
            if (!key) continue;
            const body = cleaned.startsWith('-') ? cleaned : `- ${cleaned}`;
            ensure(key).existing.push(body);
        }
    }

    for (const e of dialogEntries || []) {
        if (!e || e.isMarker) continue;
        const line = String(e.line || '').trim();
        if (!line) continue;
        const key = volumeKeyFromTs(e.timestamp, endTs, windowHours);
        if (!key) continue;
        ensure(key).dialog.push(line);
    }

    const all = sortVolumeKeys([...map.keys()]).map((k) => map.get(k));
    const nonEmpty = all.filter((b) => b.existing.length > 0 || b.dialog.length > 0);
    const dirty = nonEmpty.filter((b) => b.dialog.length > 0 || b.existing.length > 1);
    return { all: nonEmpty, dirty };
}

function formatVolumeBlocksForPrompt(bundles) {
    if (!bundles || !bundles.length) return '（本批无需更新的卷）';
    return bundles.map((b) => {
        const tag = b.near ? '近' : '远';
        const existing = b.existing.length ? b.existing.join('\n') : '（无）';
        const dialog = b.dialog.length ? b.dialog.join('\n') : '（无）';
        return `【卷 ${tag}|${b.rangeLabel}】\n已有：\n${existing}\n本卷对话：\n${dialog}`;
    }).join('\n\n');
}

/**
 * 策略 B：新输出按卷覆盖；未出现的旧卷保留。
 */
function mergeDailyByVolume(oldText, newText, endTs, logicalDate, windowHours = DEFAULT_WINDOW_HOURS) {
    /** @type {Map<string, string>} */
    const byKey = new Map();

    const ingest = (text, overwrite) => {
        const raw = String(text || '').trim();
        if (!raw) return;
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || /^##\s/.test(trimmed)) continue;
            const cleaned = stripWindowTags(trimmed).replace(/^[-*]\s+/, '');
            if (!cleaned || cleaned === '（无）') continue;
            const key = lineToVolumeKey(cleaned, endTs, logicalDate, windowHours);
            if (!key) continue;
            const range = volumeRangeLabel(key);
            let body = cleaned;
            const cat = body.match(/\[(起居|生活|话题|计划)\]\s*[:：]\s*(.*)$/);
            if (cat && range) {
                body = `${range} [${cat[1]}]: ${cat[2]}`;
            } else if (range && !/\d{2}:\d{2}\s*[-～~]\s*\d{2}:\d{2}/.test(body)) {
                body = body.replace(/^\d{1,2}:\d{2}\s*/, `${range} `);
            }
            const finalLine = body.startsWith('-') ? body : `- ${body}`;
            if (overwrite) byKey.set(key, finalLine);
            else if (!byKey.has(key)) byKey.set(key, finalLine);
        }
    };

    ingest(oldText, false);
    ingest(newText, true);

    if (!byKey.size) return '';
    const lines = sortVolumeKeys([...byKey.keys()]).map((k) => byKey.get(k));
    return ['## 时序', ...lines].join('\n');
}

/** @deprecated */
function tagExistingDailyLines(existingText, endTs, opts = {}) {
    const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
    const logicalDate = opts.logicalDate || '';
    const raw = String(existingText || '').trim();
    if (!raw || raw === '（尚无）' || raw === '（尚无记录）') return '（尚无）';
    return raw
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return '';
            if (/^##\s/.test(trimmed)) return stripWindowTags(trimmed);
            const cleaned = stripWindowTags(trimmed);
            const key = lineToVolumeKey(cleaned, endTs, logicalDate, windowHours);
            return key ? `[${key}] ${cleaned}` : cleaned;
        })
        .filter(Boolean)
        .join('\n');
}

/** @deprecated */
function formatConversationWithVolumeTags(entries, endTs, windowHours = DEFAULT_WINDOW_HOURS) {
    const lines = [];
    for (const e of entries || []) {
        const line = String(e.line || '').trim();
        if (!line) continue;
        const key = volumeKeyFromTs(e.timestamp, endTs, windowHours);
        lines.push(key ? `[${key}] ${line}` : line);
    }
    return lines.join('\n') || '（无）';
}

function splitTaggedConversation(entries, endTs, windowHours = DEFAULT_WINDOW_HOURS) {
    const near = [];
    const far = [];
    for (const e of entries || []) {
        const line = String(e.line || '').trim();
        if (!line) continue;
        const tag = windowTag(e.timestamp, endTs, windowHours);
        const stamped = `[${tag}]${line}`;
        if (tag === '近') near.push(stamped);
        else far.push(stamped);
    }
    return {
        nearText: near.join('\n\n') || '（无）',
        farText: far.join('\n\n') || '（无）',
        nearCount: near.length,
        farCount: far.length,
    };
}

module.exports = {
    DEFAULT_WINDOW_HOURS,
    NEAR_BUCKET_MINUTES,
    isNear,
    windowTag,
    extractLineHm,
    hmOnLogicalDateToISO,
    floorNearBucket,
    addMinutesToHm,
    volumeKeyFromHm,
    volumeKeyFromTs,
    volumeRangeLabel,
    stripWindowTags,
    sortVolumeKeys,
    lineToVolumeKey,
    buildVolumeBundles,
    formatVolumeBlocksForPrompt,
    mergeDailyByVolume,
    tagExistingDailyLines,
    formatConversationWithVolumeTags,
    splitTaggedConversation,
};
