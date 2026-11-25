// services/featureFlags.js
// Relay 设置里的功能开关缓存。各能力本地自查，互不挡路。
// 缺省 fail-open（未同步 / 未配置 = 开），与上线前行为一致。

const DEFAULTS = {
  feature_weather_enabled: '1',
  feature_voyage_enabled: '1',
  feature_daily_events_enabled: '1',
  feature_memory_inject_enabled: '1',
  feature_schedule_inject_enabled: '1',
  feature_schedule_parse_enabled: '1',
  feature_grounding_enabled: '1',
  feature_self_wake_enabled: '1',
  feature_affect_enabled: '1',
};

/** @type {Record<string, string>} */
let _flags = { ...DEFAULTS };
let _voyagePromptOverride = '';
let _dailyPromptOverride = '';
// 事件线独立周期：几轮写一次（5-50，默认 10）；与固化彻底解耦
let _dailyEventsInterval = 10;

function _norm(v, fallback) {
  if (v == null || v === '') return fallback;
  return String(v).trim();
}

function _clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function setFromRelay(settings) {
  if (!settings || typeof settings !== 'object') return;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    _flags[key] = _norm(settings[key], def);
  }
  _voyagePromptOverride = _norm(settings.summary_voyage_prompt, '');
  _dailyPromptOverride = _norm(settings.summary_daily_prompt, '');
  _dailyEventsInterval = _clampInt(settings.daily_events_interval, 5, 50, 10);
}

function isOn(key, defaultOn = true) {
  const def = defaultOn ? '1' : '0';
  const raw = _norm(_flags[key], DEFAULTS[key] != null ? DEFAULTS[key] : def);
  const v = raw.toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function getVoyagePromptOverride() {
  return _voyagePromptOverride;
}

function getDailyPromptOverride() {
  return _dailyPromptOverride;
}

function getDailyEventsInterval() {
  return _dailyEventsInterval;
}

function snapshot() {
  return {
    flags: { ..._flags },
    summary_voyage_prompt: _voyagePromptOverride,
    summary_daily_prompt: _dailyPromptOverride,
    daily_events_interval: _dailyEventsInterval,
  };
}

module.exports = {
  DEFAULTS,
  setFromRelay,
  isOn,
  getVoyagePromptOverride,
  getDailyPromptOverride,
  getDailyEventsInterval,
  snapshot,
};
