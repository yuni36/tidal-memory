// services/weather.js
// 天气：wttr.in 拉取 → weather_cache；1h 刷新；供工具与脑注入共用
// 城市取自设置 weather_city（叶子名）+ weather_city_path（省 市 区县），
// 查询时按 省市区 → 市区 → 区县 逐级回退，避免同名区县串台。

const axios = require('axios');

const DEFAULT_CITY = (process.env.WEATHER_QUERY || '北京').trim() || '北京';
let cityQuery = DEFAULT_CITY;
let cityPath = '';
let cityLabel = (process.env.WEATHER_LABEL || '').trim() || cityQuery;
const REFRESH_MS = Math.max(
  15 * 60 * 1000,
  (parseInt(process.env.WEATHER_REFRESH_HOURS || '1', 10) || 1) * 60 * 60 * 1000,
);
const CACHE_KEY = 'weather_cache';
const STALE_MS = REFRESH_MS; // 注入侧：超过刷新间隔视为偏旧（工具仍可读）

let timer = null;
let refreshing = false;

function _settings() {
  return require('../utils/settings');
}

function _desc(cond) {
  if (!cond) return '';
  const zh = cond.lang_zh?.[0]?.value;
  if (zh) return zh;
  return cond.weatherDesc?.[0]?.value || '';
}

function _windDir(cond) {
  return cond.winddir16Point || cond.winddirDegree || '';
}

function formatCurrentSummary(data) {
  const c = data?.current_condition?.[0];
  if (!c) return null;
  const temp = c.temp_C;
  const feels = c.FeelsLikeC;
  const desc = _desc(c);
  const wind = c.windspeedKmph;
  const dir = _windDir(c);
  const hum = c.humidity;
  const parts = [cityLabel];
  if (desc) parts.push(desc);
  if (temp != null && temp !== '') parts.push(`${temp}°C`);
  if (feels != null && feels !== '' && String(feels) !== String(temp)) {
    parts.push(`体感 ${feels}`);
  }
  if (wind != null && wind !== '') {
    parts.push(dir ? `${dir}风 ${wind}km/h` : `风速 ${wind}km/h`);
  }
  if (hum != null && hum !== '') parts.push(`湿度 ${hum}%`);
  return parts.join(' · ');
}

function formatDayLine(day) {
  if (!day) return '';
  const date = day.date || '';
  const max = day.maxtempC;
  const min = day.mintempC;
  const avg = day.avgtempC;
  const hourly = Array.isArray(day.hourly) ? day.hourly : [];
  const mid = hourly[Math.min(4, hourly.length - 1)] || hourly[0];
  const desc = _desc(mid) || _desc(hourly[0]);
  const rain = mid?.chanceofrain ?? day.hourly?.[0]?.chanceofrain;
  const bits = [];
  if (date) bits.push(date.slice(5)); // MM-DD
  if (desc) bits.push(desc);
  if (min != null && max != null) bits.push(`${min}~${max}°C`);
  else if (avg != null) bits.push(`${avg}°C`);
  if (rain != null && rain !== '') bits.push(`降水概率 ${rain}%`);
  return bits.join(' · ');
}

function formatForecast(data, days) {
  const list = Array.isArray(data?.weather) ? data.weather : [];
  const n = Math.min(Math.max(parseInt(days, 10) || 0, 0), 3);
  if (n <= 0 || list.length === 0) return '';
  const lines = [];
  for (let i = 0; i < Math.min(n, list.length); i++) {
    const line = formatDayLine(list[i]);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

async function _fetchOne(query) {
  const url = `https://wttr.in/${encodeURIComponent(query)}?format=j1&lang=zh`;
  const resp = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'TidalWeather/1.0',
      Accept: 'application/json',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  if (!resp.data?.current_condition?.[0]) {
    throw new Error('wttr.in 返回缺少 current_condition');
  }
  return resp.data;
}

/** wttr 解析到境外时不算数（避免中文名被模糊匹配到别处） */
const CN_COUNTRIES = new Set(['china', '中国', 'hong kong', '香港', 'macau', 'macao', '澳门', 'taiwan', '台湾']);

function _isChinaPlace(data) {
  const na = data?.nearest_area?.[0];
  if (!na) return true;
  const country = String(na.country?.[0]?.value || '').trim().toLowerCase();
  return !country || CN_COUNTRIES.has(country);
}

function cityKey() {
  return cityPath || cityQuery;
}

/** 查询候选：省 市 区县 → 市 区县 → 区县 */
function queryCandidates() {
  const parts = String(cityPath || '').trim().split(/\s+/).filter(Boolean);
  const list = [];
  if (parts.length >= 3) list.push(parts.join(' '));
  if (parts.length >= 2) list.push(parts.slice(-2).join(' '));
  if (parts.length >= 1) list.push(parts[parts.length - 1]);
  list.push(cityQuery);
  return [...new Set(list.filter(Boolean))];
}

async function fetchWttr() {
  const candidates = queryCandidates();
  let lastErr = null;
  for (const q of candidates) {
    try {
      const data = await _fetchOne(q);
      if (!_isChinaPlace(data)) {
        lastErr = new Error(`「${q}」解析到了境外地点`);
        continue;
      }
      return { data, query: q };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('天气查询失败');
}

async function readCache() {
  try {
    const { getUserSetting } = _settings();
    const raw = await getUserSetting(CACHE_KEY);
    const v = raw?.value;
    if (v == null || v === '' || v === 'null') return null;
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    if (!parsed?.summary || !parsed?.updated_at) return null;
    // 城市换了就别拿旧城市的缓存冒充
    if (parsed.cid && parsed.cid !== cityKey()) return null;
    if (!parsed.cid && parsed.query && parsed.query !== cityQuery) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(summary, extra = {}) {
  const { setUserSetting } = _settings();
  const { usedQuery, ...rest } = extra;
  const payload = {
    summary,
    updated_at: new Date().toISOString(),
    cid: cityKey(),
    query: usedQuery || cityQuery,
    path: cityPath,
    label: cityLabel,
    ...rest,
  };
  await setUserSetting(CACHE_KEY, JSON.stringify(payload));
  return payload;
}

function ageMs(cache) {
  if (!cache?.updated_at) return Infinity;
  const t = Date.parse(cache.updated_at);
  if (Number.isNaN(t)) return Infinity;
  return Date.now() - t;
}

function formatUpdatedLocal(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso || '';
  }
}

/** 脑注入：短一行；无缓存则空字符串 */
async function getInjectPayload() {
  const cache = await readCache();
  if (!cache?.summary) return { text: '', summary: '', updated_at: null, stale: true };
  const stale = ageMs(cache) > STALE_MS * 1.5;
  const when = formatUpdatedLocal(cache.updated_at);
  const text = stale
    ? `${cache.summary}（更新于 ${when}，可能偏旧）`
    : `${cache.summary}（更新于 ${when}）`;
  return {
    text,
    summary: cache.summary,
    updated_at: cache.updated_at,
    stale,
  };
}

/**
 * 刷新缓存。force=false 时若未过期则跳过。
 * @returns {{ ok, skipped?, cache?, error? }}
 */
async function refreshCache({ force = false } = {}) {
  if (refreshing) return { ok: false, skipped: true, reason: 'busy' };
  const existing = await readCache();
  if (!force && existing && ageMs(existing) < REFRESH_MS) {
    return { ok: true, skipped: true, cache: existing };
  }
  refreshing = true;
  try {
    const { data, query } = await fetchWttr();
    const summary = formatCurrentSummary(data);
    if (!summary) throw new Error('无法格式化天气摘要');
    const cache = await writeCache(summary, {
      usedQuery: query,
      temp_C: data.current_condition[0].temp_C,
      feels_C: data.current_condition[0].FeelsLikeC,
    });
    console.log(`[Weather] 已刷新: ${summary}`);
    return { ok: true, cache };
  } catch (e) {
    console.error(`[Weather] 刷新失败: ${e.message}`);
    return { ok: false, error: e.message, cache: existing };
  } finally {
    refreshing = false;
  }
}

/**
 * 工具入口：实况 + 可选未来 N 天（1~3）。
 * 成功后回写缓存。
 */
async function queryWeather({ days = 0 } = {}) {
  const n = Math.min(Math.max(parseInt(days, 10) || 0, 0), 3);
  try {
    const { data, query } = await fetchWttr();
    const summary = formatCurrentSummary(data);
    if (!summary) {
      return { success: false, error: '天气数据不完整', formatted: '天气数据不完整，稍后再试。' };
    }
    await writeCache(summary, {
      usedQuery: query,
      temp_C: data.current_condition[0].temp_C,
      feels_C: data.current_condition[0].FeelsLikeC,
    });
    const lines = [`【天气 · ${cityLabel}】`, summary];
    const forecast = formatForecast(data, n);
    if (forecast) {
      lines.push('', `近 ${n} 天：`, forecast);
    }
    const todayHi = data.weather?.[0];
    if (todayHi && n === 0) {
      const hi = todayHi.maxtempC;
      const lo = todayHi.mintempC;
      if (hi != null && lo != null) lines.push(`今日气温 ${lo}~${hi}°C`);
    }
    return { success: true, formatted: lines.join('\n'), summary };
  } catch (e) {
    const cache = await readCache();
    if (cache?.summary) {
      const when = formatUpdatedLocal(cache.updated_at);
      return {
        success: true,
        formatted:
          `【天气 · ${cityLabel}】（实时拉取失败，用缓存）\n` +
          `${cache.summary}（更新于 ${when}）\n` +
          `失败原因：${e.message}`,
        summary: cache.summary,
        fromCache: true,
      };
    }
    return {
      success: false,
      error: e.message,
      formatted: `查天气失败：${e.message}`,
    };
  }
}

function startScheduler() {
  if (timer) return;
  // 启动先刷一次；失败不挡服务
  refreshCache({ force: true }).catch(() => {});
  timer = setInterval(() => {
    refreshCache({ force: false }).catch(() => {});
  }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[Weather] 调度已启动: ${cityLabel} / 每 ${Math.round(REFRESH_MS / 3600000)}h`);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 设置页切换城市：query=叶子名，path=省 市 区县；立即按新城市重刷 */
function setCity(next, nextPath) {
  const q = String(next == null ? '' : next).trim() || DEFAULT_CITY;
  const p = String(nextPath == null ? '' : nextPath).trim();
  if (q === cityQuery && p === cityPath) return false;
  cityQuery = q;
  cityPath = p;
  cityLabel = q;
  console.log(`[Weather] 城市切换: ${cityLabel}${cityPath ? `（${cityPath}）` : ''}`);
  if (timer) refreshCache({ force: true }).catch(() => {});
  return true;
}

function getCity() {
  return cityQuery;
}

function getCityPath() {
  return cityPath;
}

function getCityLabel() {
  return cityLabel;
}

module.exports = {
  DEFAULT_CITY,
  REFRESH_MS,
  formatCurrentSummary,
  formatForecast,
  readCache,
  writeCache,
  getInjectPayload,
  refreshCache,
  queryWeather,
  setCity,
  getCity,
  getCityPath,
  getCityLabel,
  startScheduler,
  stopScheduler,
};
