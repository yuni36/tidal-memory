// services/affect/llmConfig.js
// 第五模型分组的内存缓存 —— 绝不写进 api_configs（那是 Scribe/Archivist 共用行）
//
// 故意**不**回退 memory_* / chat_*：情绪分析要用第二个未开 billing 的谷歌免费档
// （或单独的 DS Key）。留空 = 未配置，不是「借用付费管线」。
//
// 开关：
//   affect_analyze_enabled — 每轮 LLM delta（P2）
//   affect_tone_enabled    — 回复语调染色（P3）；与分析分开，失败模式不同
// tick 不受开关影响，始终在跑。
//
// 详见 docs/affect-jiwen-p1-plan.md §6 / §7

let _cfg = {
    base: '',
    key: '',
    model: '',
    analyzeEnabled: false,
    toneEnabled: false,
    source: 'empty',
};

function flagOn(raw) {
    const v = String(raw ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** 由 server.js syncRelaySettings 调用。 */
function setFromRelaySettings(settings) {
    const s = settings || {};
    const base = String(s.affect_api_base_url || '').trim().replace(/\/+$/, '');
    const key = String(s.affect_api_key || '').trim();
    const model = String(s.affect_model || '').trim();
    const analyzeEnabled = flagOn(s.affect_analyze_enabled);
    const toneEnabled = flagOn(s.affect_tone_enabled);

    const prev = JSON.stringify(_cfg);
    _cfg = {
        base,
        key,
        model,
        analyzeEnabled,
        toneEnabled,
        source: (base && key && model) ? 'affect_*' : 'empty',
    };
    if (JSON.stringify(_cfg) !== prev) {
        const keyHint = _cfg.key
            ? `${_cfg.key.slice(0, 4)}…${_cfg.key.slice(-4)}`
            : '(无)';
        console.log(
            `[积温] LLM 配置: analyze=${analyzeEnabled ? 'on' : 'off'} ` +
            `tone=${toneEnabled ? 'on' : 'off'} ` +
            `model=${_cfg.model || '(空)'} @ ${_cfg.base || '(空)'} ` +
            `key=${keyHint}`
        );
    }
    return getConfig();
}

function getConfig() {
    return { ..._cfg };
}

/** 分析用：开关开且三件套齐。 */
function canAnalyze() {
    return Boolean(_cfg.analyzeEnabled && _cfg.base && _cfg.key && _cfg.model);
}

function isAnalyzeEnabled() {
    return Boolean(_cfg.analyzeEnabled);
}

function isToneEnabled() {
    return Boolean(_cfg.toneEnabled);
}

/** @deprecated 用 canAnalyze；保留别名以免旧引用炸掉 */
function isReady() {
    return canAnalyze();
}

module.exports = {
    setFromRelaySettings,
    getConfig,
    canAnalyze,
    isAnalyzeEnabled,
    isToneEnabled,
    isReady,
};
