// services/affect/engine.js
// 积温（jiwen）引擎单例 —— 组装 createJiwen(opts)，参数从 affect_profile 热加载
//
// 分层：jiwen = 数学；本文件 = 适配层（参数 / 人称 / 消息源 / 持久化）。
// 角色文案与速率改动只动 DB 里的 affect_profile，不改这里。

const { createJiwen } = require('@clarashafiq/jiwen');
const store = require('./store');
const rate = require('./rate');
const tone = require('./tone');
const describe = require('./describe');
const { USER } = require('../memoryConfig');

// ── 默认起跑参数：对齐 @clarashafiq/jiwen 0.4.0 上游默认（中性、无人设）──
// 上游所有耦合参数默认关闭；要性格时在 affect_profile.rates 里覆盖。
const DEFAULT_RATES = {
    valenceSetpoint: 0,

    // 时间分段加速：默认关闭（0 = 不因等太久而加速）
    accelDelay: 0,
    connectionAccel: 0,

    // 骄傲防御 / 侵蚀：默认关闭
    prideDefendThreshold: 1.0,
    prideDefendTarget: 0.5,
    prideDefendRate: 0.003,
    prideErosionRate: 0,
    prideRegress: 0.003,

    // 等待不抬唤醒
    arousalConnectionRiseThreshold: 1.0,
    arousalConnectionRiseRate: 0.002,
    arousalSetpoint: 0,

    // 做事不自动缓解连接需求
    activityConnectionRelief: 0,

    valenceDeltaScaling: false,
    valenceDiminishWindow: 0,
    valenceDiminishFactor: 0,
};

// ── 阈值：上游默认 0.20 / 0.35 / 0.50 ──
// prideBlock=1.0 是 Tidal 的刻意偏离（上游 0.5）：无人设默认里不让「面子」拦住开口。
const DEFAULT_THRESHOLDS = {
    observation: 0.20,
    considerContact: 0.35,
    forceContact: 0.50,
    prideBlock: 1.0,
};

const DEFAULT_PERSONA = {
    subjectName: USER.name || 'User',
    selfName: '你',
    subjectPronoun: '对方',
};

// ≈4h 到 0.35；一天约 2~4 次 + 冷却
const FALLBACK_RATE = 0.0015;

let _engine = null;

// 下面三个都有默认实现，setXxx 只用于测试或临时替换。
// 默认值必须留在引擎里：只挂路由、没跑调度器的进程（或调度器启动失败时）
// 若退回占位消息，卡片会把「读不到消息」显示成「刚刚才聊过」，是会骗人的。
let _readLastMessage = null;   // 默认 store.lastUserMessage
let _rateFn = null;            // 默认 rate.connectionRateFn
let _sagaBiasFn = null;        // 默认 rate.waitingBias（夜间压低 arousal）

/**
 * getLastMessage 的防御性包装。
 *
 * jiwen 在 getLastMessage() 返回 null 时把 minutesSinceLastMsg 记为 Infinity，
 * accelDelay 立即失效、加速直接生效（作者 CLAUDE.md 有写）。也就是说
 * 「读不到消息」会被引擎理解成「已经沉默了无限久」，connection 直接飙。
 *
 * 宁可少涨也不能空涨：读不到就返回一条「刚刚」的占位消息，
 * 等价于暂时关掉加速，失败方向是偏克制而不是偏骚扰。
 */
function safeLastMessage() {
    try {
        const msg = (_readLastMessage || store.lastUserMessage)();
        if (msg && msg.timestamp) return msg;
    } catch (e) {
        console.warn('[积温] 读取最后一条消息失败:', e.message);
    }
    return { id: null, content: '', timestamp: new Date().toISOString() };
}

function connectionRate(lastMsg) {
    try {
        const r = (_rateFn || rate.connectionRateFn)(lastMsg);
        if (typeof r === 'number' && Number.isFinite(r) && r >= 0) return r;
    } catch (e) {
        console.warn('[积温] 速率函数异常，回退默认:', e.message);
    }
    return FALLBACK_RATE;
}

function buildEngine() {
    const profile = store.loadProfile();
    const rates = { ...DEFAULT_RATES, ...(profile.rates || {}) };
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(profile.thresholds || {}) };

    return createJiwen({
        rates,
        thresholds,
        persona: { ...DEFAULT_PERSONA, ...(profile.persona || {}) },

        onLoad: () => store.loadState(),
        onSave: (state) => store.saveState(state),

        getLastMessage: safeLastMessage,
        connectionRateFn: connectionRate,
        getSagaBias: () => {
            try {
                return (_sagaBiasFn || rate.waitingBias)();
            } catch (e) {
                console.warn('[积温] 偏置函数异常，本次 tick 无偏置:', e.message);
                return null;
            }
        },

        getStyleGuidance: (state) => {
            try {
                return tone.getStyleGuidance(state);
            } catch (e) {
                console.warn('[积温] 语调查表失败:', e.message);
                return '';
            }
        },

        // 此刻的状态旁白（describe.js）；不是 tone-grid 的 proactive 指引
        getPromptContext: (state) => {
            try {
                const profile = store.loadProfile();
                const persona = { ...DEFAULT_PERSONA, ...(profile.persona || {}) };
                return describe.buildPromptContext(state, persona);
            } catch (e) {
                console.warn('[积温] 描述失败:', e.message);
                return '';
            }
        },

        onLog: (msg) => console.log('[Tidal Memory]', msg),
    });
}

function getEngine() {
    if (!_engine) _engine = buildEngine();
    return _engine;
}

/**
 * 配置热重载。
 * jiwen 在 createJiwen 时就把 rates/thresholds 固化进闭包，改配置只能重建实例。
 * 状态在 DB 里且每次变更都已落盘，重建后由 onLoad 读回，不会丢。
 */
function reloadEngine() {
    _engine = null;
    try { tone.reload(); } catch (_) { /* ignore */ }
    return getEngine();
}

function setMessageReader(fn) {
    _readLastMessage = typeof fn === 'function' ? fn : null;
}

function setRateFn(fn) {
    _rateFn = typeof fn === 'function' ? fn : null;
}

function setSagaBiasFn(fn) {
    _sagaBiasFn = typeof fn === 'function' ? fn : null;
}

/**
 * 给 API / 身份卡片用的快照。
 *
 * 必须先 await getState()：它内部会 ensureLoaded()，而 getStateSummary()
 * 和 getPromptContext() 都不会——在首次加载前直接调，读到的是引擎的
 * 轴下界默认值（pride/valence/arousal = -1），显示出来是假的。
 */
async function snapshot() {
    const engine = getEngine();
    const state = await engine.getState();
    const lastMsg = safeLastMessage();
    let styleGuidance = '';
    try {
        styleGuidance = tone.getStyleGuidance(state) || '';
    } catch (_) { /* ignore */ }
    return {
        state,
        lastMessage: {
            id: lastMsg.id,
            timestamp: lastMsg.timestamp,
            // 与 jiwen tick 内部同一个算法（见 jiwen.js minutesSinceLastMsg），
            // 卡片上要能直接对照真实静默时长
            minutesSince: (Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000,
            placeholder: lastMsg.id == null,
        },
        summary: engine.getStateSummary(),
        promptContext: engine.getPromptContext(),
        styleGuidance,
        triggers: engine.checkThresholds(),
        config: engine.config,
        meta: store.getStateMeta(),
        lastDelta: store.lastDelta(),
    };
}

module.exports = {
    getEngine,
    reloadEngine,
    setMessageReader,
    setRateFn,
    setSagaBiasFn,
    snapshot,
    defaults: { rates: DEFAULT_RATES, thresholds: DEFAULT_THRESHOLDS, persona: DEFAULT_PERSONA },
};
