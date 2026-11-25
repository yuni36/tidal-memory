// =================================================================
// 时间工具函数（新加坡/北京 UTC+8）
// =================================================================

const SG_TZ = 'Asia/Singapore';

// 逻辑日分界：新加坡时间 04:00。凌晨 0-4 点算作前一天（熬夜的行为归属前一天）
const DAY_START_HOUR = 4;

function parseISO(iso) {
    if (iso == null || iso === '') return null;
    const raw = String(iso).trim();
    if (!raw) return null;
    const normalized = raw.includes('T') ? raw.replace('Z', '+00:00') : raw.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO/UTC 时间戳 → 新加坡时区展示 */
function formatSingaporeFromISO(iso, style = 'HH:mm') {
    const d = parseISO(iso);
    if (!d) return '';
    const opts = { timeZone: SG_TZ, hour12: false };
    if (style === 'HH:mm') {
        return d.toLocaleTimeString('zh-CN', { ...opts, hour: '2-digit', minute: '2-digit' });
    }
    if (style === 'date') {
        return d.toLocaleDateString('en-CA', { timeZone: SG_TZ });
    }
    if (style === 'MD-HM') {
        const month = d.toLocaleString('en-US', { timeZone: SG_TZ, month: '2-digit' });
        const day = d.toLocaleString('en-US', { timeZone: SG_TZ, day: '2-digit' });
        const hm = d.toLocaleTimeString('zh-CN', { ...opts, hour: '2-digit', minute: '2-digit' });
        return `${month}-${day} ${hm}`;
    }
    return '';
}

/**
 * ISO/UTC 时间戳 → 逻辑日 'YYYY-MM-DD'（04:00 为界）
 * SG 墙钟 = UTC+8，再回退 DAY_START_HOUR 小时，落到哪个自然日就是哪个逻辑日。
 */
function logicalDateFromISO(iso) {
    const d = parseISO(iso);
    if (!d) return '';
    const shifted = new Date(d.getTime() + (8 - DAY_START_HOUR) * 3600000);
    return shifted.toISOString().slice(0, 10);
}

/** 当前所处的逻辑日 'YYYY-MM-DD' */
function currentLogicalDate(now = new Date()) {
    return logicalDateFromISO(now.toISOString());
}

/**
 * ISO → UTC+8 法定自然日 'YYYY-MM-DD'（00:00–23:59，与逻辑日 04:00 无关）
 * 日程专用；勿与 logicalDateFromISO 混用。
 */
function calendarDateFromISO(iso) {
    const d = parseISO(iso);
    if (!d) return '';
    return d.toLocaleDateString('en-CA', { timeZone: SG_TZ });
}

/** 当前墙钟自然日 'YYYY-MM-DD'（UTC+8） */
function currentCalendarDate(now = new Date()) {
    return calendarDateFromISO(now.toISOString());
}

/** 自然日加减：'YYYY-MM-DD' + n 天 → 'YYYY-MM-DD'（按日历日，不经 SQLite） */
function addCalendarDays(ymd, days) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    // 用 UTC 正午锚定，避免 DST/本地偏移把日界弄歪（SG 无 DST，仍统一写法）
    const utc = Date.UTC(y, m - 1, d, 12, 0, 0) + (Number(days) || 0) * 86400000;
    const x = new Date(utc);
    const yy = x.getUTCFullYear();
    const mm = String(x.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(x.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

/** 两自然日差（b - a），单位天；非法返回 null */
function calendarDaysBetween(a, b) {
    if (!a || !b) return null;
    const pa = a.split('-').map(Number);
    const pb = b.split('-').map(Number);
    if (pa.length !== 3 || pb.length !== 3) return null;
    const ua = Date.UTC(pa[0], pa[1] - 1, pa[2], 12, 0, 0);
    const ub = Date.UTC(pb[0], pb[1] - 1, pb[2], 12, 0, 0);
    return Math.round((ub - ua) / 86400000);
}

/** 当前墙钟 ISO（带 +08:00），供 created_at / 提示词「现在」 */
function nowISOWithOffset(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: SG_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

/** 自然日 + 可选 HH:mm → ISO+08:00；无时刻则 00:00 */
function calendarDateToISO(ymd, hm = '00:00') {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
    const t = (hm && /^\d{1,2}:\d{2}$/.test(hm)) ? hm.padStart(5, '0') : '00:00';
    return `${ymd}T${t}:00+08:00`;
}

/** ISO → 墙钟星期 1=周一 … 7=周日（ISO） */
function calendarWeekday(isoOrYmd) {
    const ymd = /^\d{4}-\d{2}-\d{2}$/.test(isoOrYmd || '')
        ? isoOrYmd
        : calendarDateFromISO(isoOrYmd);
    if (!ymd) return 0;
    const [y, m, d] = ymd.split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const wd = utc.getUTCDay(); // 0=Sun
    return wd === 0 ? 7 : wd;
}

const getShanghaiTime = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        
        const year = shanghaiTime.getFullYear();
        const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
        const day = String(shanghaiTime.getDate()).padStart(2, '0');
        const hour = String(shanghaiTime.getHours()).padStart(2, '0');
        const minute = String(shanghaiTime.getMinutes()).padStart(2, '0');
        const second = String(shanghaiTime.getSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch (error) {
        console.error('getShanghaiTime failed:', error);
        return new Date().toLocaleString('zh-CN', {
            timeZone: SG_TZ,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).replace(/\//g, '-').replace(/,/g, '');
    }
};

const getTimeOfDay = () => {
    try {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const shanghaiTime = new Date(utc + (8 * 3600000));
        const hour = shanghaiTime.getHours();
        
        if (hour >= 5 && hour < 11) return '早上';
        if (hour >= 11 && hour < 13) return '中午';
        if (hour >= 13 && hour < 17) return '下午';
        if (hour >= 17 && hour < 19) return '傍晚';
        if (hour >= 19 && hour < 23) return '晚上';
        return '深夜';
    } catch (error) {
        console.error('getTimeOfDay failed:', error);
        return '';
    }
};

module.exports = {
    getShanghaiTime, getTimeOfDay, formatSingaporeFromISO, parseISO, SG_TZ,
    logicalDateFromISO, currentLogicalDate, DAY_START_HOUR,
    calendarDateFromISO, currentCalendarDate, addCalendarDays, calendarDaysBetween,
    nowISOWithOffset, calendarDateToISO, calendarWeekday,
};