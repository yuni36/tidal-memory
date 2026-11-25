// services/affect/scheduler.js
// 积温心跳 —— 5 分钟 tick；contact 入 pending 队列，真正发送归 proactive_scheduler（P4）
//
// 详见 docs/affect-jiwen-p1-plan.md §8 P1/P4

const engine = require('./engine');
const store = require('./store');
const rate = require('./rate');
const tone = require('./tone');
const toneMeta = require('./toneMeta');
const pending = require('./pending');

const TICK_MS = 5 * 60 * 1000;
const MAX_CATCHUP_MIN = 60;
const PRUNE_MS = 24 * 60 * 60 * 1000;
const MIN_TICK_MIN = 0.1;

let timer = null;
let pruneTimer = null;
let ticking = false;

function minutesSinceLastTick(state) {
    const raw = state && state.lastTick;
    if (!raw) return TICK_MS / 60000;
    const mins = (Date.now() - new Date(raw).getTime()) / 60000;
    if (!Number.isFinite(mins) || mins <= 0) return 0;
    return Math.min(mins, MAX_CATCHUP_MIN);
}

async function resetIfSheSpoke(jiwen, lastMsg) {
    if (!lastMsg || lastMsg.id == null) return false;
    const seen = await jiwen.getLastChatMessageId();
    if (seen === lastMsg.id) return false;

    await jiwen.resetConnection();
    await jiwen.setLastChatMessageId(lastMsg.id);
    return true;
}

async function runTick() {
    if (ticking) return null;
    ticking = true;
    try {
        const jiwen = engine.getEngine();
        const before = await jiwen.getState();
        const mins = minutesSinceLastTick(before);
        if (mins < MIN_TICK_MIN) return null;

        const lastMsg = store.lastUserMessage();
        const didReset = await resetIfSheSpoke(jiwen, lastMsg);

        const triggers = await jiwen.tick(mins);
        const after = await jiwen.getState();

        let styleGuidance = '';
        let description = '';
        try {
            const hasContact = (triggers || []).some(t => t && t.action === 'contact');
            styleGuidance = hasContact
                ? (tone.getStyleGuidance(after, 'proactive') || '')
                : (jiwen.getStyleGuidance() || '');
            description = jiwen.getPromptContext() || '';
        } catch (_) { /* ignore */ }

        const queued = pending.ingest(triggers, after, { styleGuidance, description });

        const why = rate.explain(lastMsg);
        const silent = lastMsg
            ? (Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000
            : null;

        const actions = (triggers || []).map(t => t.action);
        console.log(
            `[积温] tick ${mins.toFixed(1)}min | ` +
            (didReset ? `用户说话了，连接归零 | ` : '') +
            `c:${before.connection.toFixed(3)}→${after.connection.toFixed(3)} ` +
            `p:${after.pride.toFixed(2)} v:${after.valence.toFixed(2)} a:${after.arousal.toFixed(2)} i:${after.immersion.toFixed(2)} | ` +
            `速率:${why.rate.toFixed(4)}/min(${why.reason}) | ` +
            `静默:${silent == null ? '读不到消息' : silent.toFixed(0) + 'min'} | ` +
            `触发:${actions.length ? actions.join(',') : '—'}` +
            (queued ? ` | pending=${queued.id}` : '')
        );

        store.logEvent({
            kind: didReset ? 'reset' : 'tick',
            state: after,
            tone: toneMeta.fromState(after),
            note: `${mins.toFixed(1)}min rate=${why.rate}(${why.reason})` +
                  (didReset ? ' reset(对方说话了)' : '') +
                  (actions.length ? ` triggers=${actions.join(',')}` : '') +
                  (queued ? ` pending=${queued.id}` : ''),
            messageId: lastMsg ? lastMsg.id : null,
        });

        return { minutes: mins, state: after, triggers: triggers || [], rate: why, reset: didReset, pending: queued };
    } catch (e) {
        console.error('[积温] tick 失败:', e.message);
        return null;
    } finally {
        ticking = false;
    }
}

function start() {
    if (timer) return;
    runTick();
    timer = setInterval(runTick, TICK_MS);
    pruneTimer = setInterval(() => store.pruneLog(), PRUNE_MS);
    console.log('[积温] 心跳已启动 (5min)');
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

module.exports = { start, stop, runTick };
