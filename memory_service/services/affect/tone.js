// services/affect/tone.js
// 语调网格 —— 只注册 getStyleGuidance；此刻描述见 describe.js
//
// 默认文案直接取上游 @clarashafiq/jiwen/tone-grid 的通用版：
// 功能性、不绑定任何角色。用户在感知页覆盖任意格子；留空 = 用内置通用文案。
// 完全不想注入 → 设置页关「启用语调染色」。
// 染色策略（bridge）：中档多靠人设；仅防御姿态明显偏离中档时注入；正事跳过。

const store = require('./store');
const toneMeta = require('./toneMeta');
const {
    DEFAULT_PROFILES,
    DEFAULT_URGENCY,
} = require('@clarashafiq/jiwen/tone-grid');

function _userProfiles() {
    try {
        return (store.loadProfile() || {}).profiles || {};
    } catch (_) {
        return {};
    }
}

function _urgencyBoost() {
    try {
        return (store.loadProfile() || {}).urgencyBoost || {};
    } catch (_) {
        return {};
    }
}

/** 兼容旧调用：配置每次都现读 store，不再缓存 */
function reload() {
    return null;
}

/** 上游通用文案 ← 用户覆盖（按簇浅合并，允许新增簇）。 */
function mergedProfiles() {
    const overrides = _userProfiles();
    const clusters = new Set([
        ...Object.keys(DEFAULT_PROFILES),
        ...Object.keys(overrides),
    ]);
    const out = {};
    for (const cluster of clusters) {
        out[cluster] = {
            ...(DEFAULT_PROFILES[cluster] || {}),
            ...(overrides[cluster] || {}),
        };
    }
    return out;
}

function getStyleGuidance(state, mode = 'reactive') {
    const s = state || {};
    const v = Number(s.valence) || 0;
    const a = Number(s.arousal) || 0;
    const p = Number(s.pride) || 0;
    const c = Number(s.connection) || 0;

    // 阈值 A_HI=0.4，不用 jiwen 内置 0.3
    const cluster = toneMeta.classifyCluster(v, a);
    const tier = toneMeta.classifyPride(p);
    const urg = toneMeta.classifyUrgency(c);

    const profiles = mergedProfiles();
    const profile = profiles[cluster] || profiles.neutral || {};
    // 上游回落规则：缺档回 tier 3，缺簇回 neutral
    const core = profile[tier] || profile[String(tier)] || profile[3] || profile['3'];
    const lines = [];
    if (Array.isArray(core)) lines.push(...core.filter(Boolean));
    else if (core) lines.push(String(core));

    const urgency = { ...DEFAULT_URGENCY, ..._urgencyBoost() };
    const m = mode === 'proactive' ? 'proactive' : 'reactive';
    const urgLine = urgency[urg] && urgency[urg][m];
    if (urgLine) lines.push(urgLine);

    return lines.join('\n');
}

/** 是否「明显染色」：壳很软或偏紧/原则；中档靠人设。正事跳过由 bridge 另判。 */
function shouldEmphasizeTone(state) {
    const p = Number(state && state.pride) || 0;
    return p <= 0.12 || p >= 0.50;
}

module.exports = {
    reload,
    getStyleGuidance,
    shouldEmphasizeTone,
    mergedProfiles,
    DEFAULT_PROFILES,
    DEFAULT_URGENCY,
};
