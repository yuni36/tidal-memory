// routes/affect-api.js
// 情绪（积温）对外接口
//
// P1：GET /affect/state、GET /affect/log
// P2：POST /affect/observe（开关 + 显式 Key；不回退付费管线）
// P3：state 附带 styleGuidance；染色是否注入由 brain 读 affect_tone_enabled
//
// 详见 docs/affect-jiwen-p1-plan.md §7

const express = require('express');
const engine = require('../services/affect/engine');
const store = require('../services/affect/store');
const rate = require('../services/affect/rate');
const analyzer = require('../services/affect/analyzer');
const toneMeta = require('../services/affect/toneMeta');
const tone = require('../services/affect/tone');
const llmConfig = require('../services/affect/llmConfig');

const router = express.Router();

router.get('/affect/state', async (req, res) => {
    try {
        const snap = await engine.snapshot();
        const why = rate.explain(store.lastUserMessage());
        const cfg = llmConfig.getConfig();
        res.json({
            ok: true,
            state: snap.state,
            summary: snap.summary,
            description: snap.promptContext,
            styleGuidance: snap.styleGuidance,
            emphasize: tone.shouldEmphasizeTone(snap.state),
            triggers: snap.triggers,
            lastMessage: snap.lastMessage,
            lastDelta: snap.lastDelta,
            rate: why,
            thresholds: snap.config && snap.config.thresholds,
            flags: {
                analyzeEnabled: cfg.analyzeEnabled,
                toneEnabled: cfg.toneEnabled,
                canAnalyze: llmConfig.canAnalyze(),
            },
            pending: require('../services/affect/pending').status(),
            updatedAt: snap.meta && snap.meta.updatedAt,
        });
    } catch (e) {
        console.error('[积温] /affect/state 失败:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.get('/affect/log', (req, res) => {
    try {
        res.json({ ok: true, items: store.recentLog(req.query.limit) });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, items: [] });
    }
});

/**
 * POST /affect/observe
 * body: { text, message_id?, context?, reset? }
 *
 * 开关关 → 跳过 LLM，仍可 reset（她说话了）。
 * 开关开但未配齐 affect_* → 跳过 LLM（不回退 DS/聊天 Key），仍可 reset。
 */
router.post('/affect/observe', async (req, res) => {
    try {
        const body = req.body || {};
        const text = String(body.text || '').trim();
        const context = String(body.context || '').slice(0, 1500);
        const reset = body.reset !== false;
        let messageId = body.message_id;
        if (messageId != null) {
            messageId = parseInt(messageId, 10);
            if (!Number.isInteger(messageId)) messageId = null;
        }

        if (!text) {
            return res.status(400).json({ ok: false, error: 'text required' });
        }

        const jiwen = engine.getEngine();

        // 分析关闭：不调 LLM，连接仍归零
        if (!llmConfig.isAnalyzeEnabled()) {
            if (reset) await jiwen.resetConnection();
            const snap = await engine.snapshot();
            return res.json({
                ok: true,
                skipped: true,
                reason: 'analyze_disabled',
                state: snap.state,
                styleGuidance: snap.styleGuidance,
                lastDelta: snap.lastDelta,
            });
        }

        // 未配齐第五组：不借用付费管线
        if (!llmConfig.canAnalyze()) {
            if (reset) await jiwen.resetConnection();
            const snap = await engine.snapshot();
            console.warn('[积温] observe 跳过：affect_* 未配齐（不回退 memory/chat）');
            return res.json({
                ok: true,
                skipped: true,
                reason: 'config_incomplete',
                state: snap.state,
                styleGuidance: snap.styleGuidance,
                lastDelta: snap.lastDelta,
            });
        }

        if (messageId != null && store.hasDeltaForMessage(messageId)) {
            if (reset) await jiwen.resetConnection();
            const snap = await engine.snapshot();
            return res.json({
                ok: true,
                skipped: true,
                reason: 'already_analyzed',
                state: snap.state,
                styleGuidance: snap.styleGuidance,
                lastDelta: snap.lastDelta,
            });
        }

        const before = await jiwen.getState();
        const result = await analyzer.analyze(text, context, before);

        await jiwen.applyDelta(result.delta);
        if (reset) await jiwen.resetConnection();

        let after = await jiwen.getState();

        store.logEvent({
            kind: 'delta',
            state: after,
            delta: result.delta,
            tone: toneMeta.fromState(after),
            note: [
                result.fallback ? 'fallback' : 'llm',
                result.meta ? 'meta' : null,
                result.note || null,
            ].filter(Boolean).join(' | '),
            messageId,
        });

        console.log(
            `[积温] observe #${messageId ?? '?'} ` +
            `Δp=${result.delta.pride} Δv=${result.delta.valence} Δa=${result.delta.arousal} ` +
            `Δc=${result.delta.connection}` +
            (result.fallback ? ' [fallback]' : '') +
            (result.meta ? ' [meta]' : '') +
            ` | c:${before.connection.toFixed(3)}→${after.connection.toFixed(3)}`
        );

        const styleGuidance = (() => {
            try { return tone.getStyleGuidance(after) || ''; } catch (_) { return ''; }
        })();

        res.json({
            ok: true,
            skipped: false,
            delta: result.delta,
            meta: result.meta,
            fallback: result.fallback,
            note: result.note,
            state: after,
            styleGuidance,
            emphasize: tone.shouldEmphasizeTone(after),
        });
    } catch (e) {
        console.error('[积温] /affect/observe 失败:', e.message);
        try {
            const jiwen = engine.getEngine();
            await jiwen.applyDelta(analyzer.FALLBACK_DELTA);
            await jiwen.resetConnection();
            store.logEvent({
                kind: 'delta',
                state: await jiwen.getState(),
                delta: analyzer.FALLBACK_DELTA,
                note: `observe_error: ${e.message}`.slice(0, 200),
                messageId: null,
            });
        } catch (_) { /* ignore */ }
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── P4：pending contact ──
const pending = require('../services/affect/pending');

router.get('/affect/triggers', (_req, res) => {
    try {
        res.json({ ok: true, ...pending.status() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * POST /affect/triggers/ack
 * body: { id, success }
 * success=true → applyDelta({connection:-0.35}) + 清队列 + 冷却
 * success=false → 保留 pending 下轮重试
 */
router.post('/affect/triggers/ack', async (req, res) => {
    try {
        const body = req.body || {};
        const id = body.id;
        const success = body.success !== false;
        const result = pending.ack(id, { success });
        if (!result.ok && result.reason === 'not_found') {
            return res.status(404).json({ ok: false, error: 'pending not found', ...pending.status() });
        }
        if (success && result.cleared) {
            const jiwen = engine.getEngine();
            await jiwen.applyDelta({ connection: -0.35 });
            const after = await jiwen.getState();
            store.logEvent({
                kind: 'contact',
                state: after,
                delta: { connection: -0.35 },
                tone: toneMeta.fromState(after),
                note: `ack ${result.cleared.id} sent`,
            });
            console.log(`[积温] contact ack ${result.cleared.id} → connection-0.35`);
            return res.json({ ok: true, ...pending.status(), state: after });
        }
        res.json({ ok: true, ...pending.status() });
    } catch (e) {
        console.error('[积温] triggers/ack 失败:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── 分析提示词：默认 + 当前生效 ──
router.get('/affect/prompt', (_req, res) => {
    try {
        const analyzer = require('../services/affect/analyzer');
        res.json({
            ok: true,
            default: analyzer.getDefaultSystemPrompt(),
            active: analyzer.getSystemPrompt(),
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── P5：profile 维护 ──
router.get('/affect/profile', (_req, res) => {    try {
        const profile = store.loadProfile();
        res.json({
            ok: true,
            profile,
            defaults: {
                connectionRates: rate.defaults.rates,
                circadian: rate.defaults.circadian,
                engineRates: engine.defaults.rates,
                thresholds: engine.defaults.thresholds,
                profiles: require('../services/affect/tone').DEFAULT_PROFILES,
                urgencyBoost: require('../services/affect/tone').DEFAULT_URGENCY,
            },
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.put('/affect/profile', (req, res) => {
    try {
        const body = req.body || {};
        // 整包替换或 patch：{ patch: true, ...fields }
        let next;
        if (body.patch) {
            const { patch: _p, ...fields } = body;
            next = store.patchProfile(fields);
        } else if (body.profile && typeof body.profile === 'object') {
            store.saveProfile(body.profile);
            next = store.loadProfile();
        } else {
            store.saveProfile(body);
            next = store.loadProfile();
        }
        engine.reloadEngine();
        res.json({ ok: true, profile: next });
    } catch (e) {
        console.error('[积温] profile 写入失败:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
