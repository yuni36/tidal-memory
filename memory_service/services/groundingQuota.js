// services/groundingQuota.js
// Gemini Google Search grounding 月额度（本地硬顶，默认 3000）

const { getUserSetting, setUserSetting } = require('../utils/settings');

const CACHE_KEY = 'gemini_grounding_quota';
const LIMIT = Math.max(
  1,
  parseInt(process.env.GROUNDING_MONTHLY_LIMIT || '3000', 10) || 3000,
);

function shanghaiMonth(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}

async function _readRaw() {
  const raw = await getUserSetting(CACHE_KEY);
  const v = raw?.value;
  if (v == null || v === '' || v === 'null') return null;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return null;
  }
}

async function getQuota() {
  const month = shanghaiMonth();
  const parsed = await _readRaw();
  let used = 0;
  if (parsed && parsed.month === month) {
    used = Math.max(0, parseInt(parsed.used, 10) || 0);
  } else if (parsed && parsed.month !== month) {
    await setUserSetting(CACHE_KEY, JSON.stringify({ month, used: 0 }));
  }
  const remaining = Math.max(0, LIMIT - used);
  return {
    month,
    used,
    limit: LIMIT,
    remaining,
    allowed: used < LIMIT,
  };
}

async function consume(count) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  if (n <= 0) return getQuota();
  const month = shanghaiMonth();
  const cur = await getQuota();
  const used = cur.month === month ? cur.used + n : n;
  await setUserSetting(CACHE_KEY, JSON.stringify({ month, used }));
  return {
    month,
    used,
    limit: LIMIT,
    remaining: Math.max(0, LIMIT - used),
    allowed: used < LIMIT,
    added: n,
  };
}

module.exports = { getQuota, consume, LIMIT, shanghaiMonth, CACHE_KEY };
