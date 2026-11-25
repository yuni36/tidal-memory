// routes/schedules-api.js — 日程 CRUD / parse / injectable
const express = require('express');
const schedules = require('../services/schedules');

const router = express.Router();

router.get('/schedules/parser-config', (req, res) => {
    try {
        res.json({ ok: true, ...schedules.getParserConfigPublic() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.put('/schedules/parser-config', (req, res) => {
    try {
        const saved = schedules.upsertParserConfig(req.body || {});
        res.json({ ok: true, config: saved });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

router.post('/schedules/parser-config/sync-affect', (req, res) => {
    try {
        const saved = schedules.syncParserFromAffect();
        res.json({ ok: true, config: saved });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

router.post('/schedules/parse', async (req, res) => {
    try {
        const featureFlags = require('../services/featureFlags');
        if (!featureFlags.isOn('feature_schedule_parse_enabled', true)) {
            return res.status(200).json({
                ok: false,
                error: '日程解析已关闭',
                items: [],
                unclear: [],
                disabled: true,
            });
        }
        const text = (req.body && req.body.text) || '';
        const result = await schedules.parseNaturalLanguage(text);
        const ok = !result.error;
        res.status(ok ? 200 : 502).json({ ok, ...result });
    } catch (e) {
        console.error('[schedules] parse:', e.message);
        res.status(500).json({ ok: false, error: e.message, items: [], unclear: [] });
    }
});

router.get('/schedules', (req, res) => {
    try {
        if (req.query.injectable === '1' || req.query.injectable === 'true') {
            return res.json({ ok: true, ...schedules.getInjectable() });
        }
        const items = schedules.listEntries({
            from: req.query.from || undefined,
            to: req.query.to || undefined,
            calendar_date: req.query.calendar_date || undefined,
            status: req.query.status || 'pending',
        });
        res.json({ ok: true, items });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, items: [] });
    }
});

router.post('/schedules', (req, res) => {
    try {
        const body = req.body || {};
        const batch = Array.isArray(body.items) ? body.items : [body];
        const created = [];
        for (const item of batch) {
            if (!item || typeof item !== 'object') continue;
            created.push(schedules.createEntry(item, { source: item.source || body.source || 'manual' }));
        }
        if (!created.length) return res.status(400).json({ ok: false, error: '无有效条目' });
        res.json({ ok: true, items: created });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

router.put('/schedules/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const item = schedules.updateEntry(id, req.body || {});
        res.json({ ok: true, item });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

router.delete('/schedules/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const item = schedules.softDelete(id);
        res.json({ ok: true, item });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

module.exports = router;
