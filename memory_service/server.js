// =================================================================
// Tidal 记忆服务 — 简化的入口文件
// Phase 3: 基于 Memory Constellations 核心管线，剥离 Web UI/鉴权，
//          暴露纯 HTTP API 供 AI 大脑调用。
// =================================================================

require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const { initDatabase } = require('./database');
const { CONFIG } = require('./config');
const { formatStateTensePrefix } = require('./services/stateTense');

// ── 数据库初始化 ──
const db = initDatabase();
console.log('[Tidal Memory] 数据库已初始化');

const app = express();
app.use(express.json({ limit: CONFIG.JSON_LIMIT }));

// ── 跨域（内部服务，宽松放行）──
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ── 从 relay 拉取设置，同步 Scribe 门槛 + 记忆管线 API ──
const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:3011';
const RELAY_SECRET = process.env.RELAY_SECRET || '0';

function _fetchRelaySettings() {
    const http = require('http');
    const target = new URL('/channel/settings', RELAY_URL);
    return new Promise((resolve, reject) => {
        const req = http.get({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            headers: { Authorization: `Bearer ${RELAY_SECRET}` },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
    });
}

function _inferProvider(model, base) {
    const hay = `${model || ''} ${base || ''}`.toLowerCase();
    if (hay.includes('gemini') || hay.includes('google') || hay.includes('generativelanguage')) {
        return 'gemini';
    }
    return 'openai_compatible';
}

function _syncMemoryApiConfig(settings) {
    const { encryption } = require('./encryption');
    const row = db.prepare('SELECT id FROM api_configs WHERE is_default = 1').get();
    if (!row) return;

    // 记忆管线独立字段优先；空则回退聊天大脑（向后兼容旧库只有一套 Key）
    const model = (settings.memory_model || settings.chat_model || '').trim();
    const key = (settings.memory_api_key || settings.api_key || '').trim();
    const base = (settings.memory_api_base_url || settings.api_base_url || '').trim();
    if (!model && !key && !base) return;

    const provider = _inferProvider(model, base);
    if (key) {
        db.prepare(`
            UPDATE api_configs
            SET model_name = COALESCE(NULLIF(?, ''), model_name),
                endpoint = COALESCE(NULLIF(?, ''), endpoint),
                api_key = ?,
                provider = ?
            WHERE id = ?
        `).run(model, base, encryption.encrypt(key), provider, row.id);
    } else {
        db.prepare(`
            UPDATE api_configs
            SET model_name = COALESCE(NULLIF(?, ''), model_name),
                endpoint = COALESCE(NULLIF(?, ''), endpoint),
                provider = ?
            WHERE id = ?
        `).run(model, base, provider, row.id);
    }
    console.log(`[Tidal Memory] api_configs 已同步: ${model || '(保留)'} @ ${base || '(保留)'}`);
}

/**
 * 航海 / 事件线各用各的 voyage_* / daily_*（openai 兼容口）。
 * 不再从积温 affect_* 覆盖——三者解耦。
 * 某路 base+key 未填则跳过该行（保留已有 api_configs，不互相回退）。
 */
function _upsertNamedApiConfig(name, base, key, model) {
    const b = String(base || '').trim().replace(/\/+$/, '');
    const k = String(key || '').trim();
    const m = String(model || '').trim();
    if (!b || !k) return false;

    const { encryption } = require('./encryption');
    let normalizeEndpoint = (ep) => String(ep || '').replace(/\/+$/, '');
    try {
        const schedules = require('./services/schedules');
        normalizeEndpoint = (ep) => schedules.normalizeParserEndpoint(ep, 'openai_compatible');
    } catch (_) {}

    const endpoint = normalizeEndpoint(b);
    const encryptedKey = encryption.encrypt(k);
    const provider = 'openai_compatible';
    const modelName = m || String(process.env.SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim() || 'gemini-3.5-flash-lite';

    const existing = db.prepare('SELECT id FROM api_configs WHERE name = ? LIMIT 1').get(name);
    if (existing) {
        db.prepare(`
            UPDATE api_configs
            SET api_key = ?, model_name = ?, endpoint = ?, provider = ?
            WHERE id = ?
        `).run(encryptedKey, modelName, endpoint, provider, existing.id);
    } else {
        db.prepare(`
            INSERT INTO api_configs (name, provider, endpoint, api_key, model_name, is_default, supports_tools)
            VALUES (?, ?, ?, ?, ?, 0, 0)
        `).run(name, provider, endpoint, encryptedKey, modelName);
    }
    console.log(`[Tidal Memory] api_configs 已同步: ${name} → ${modelName} @ ${endpoint}`);
    return true;
}

function _syncSummaryApiConfigs(settings) {
    const defaultModel = String(process.env.SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim()
        || 'gemini-3.5-flash-lite';
    _upsertNamedApiConfig(
        'summary-voyage',
        settings.voyage_api_base_url,
        settings.voyage_api_key,
        settings.voyage_model || process.env.SUMMARY_VOYAGE_MODEL || defaultModel,
    );
    // 事件线双候选：daily_api_active 选当前生效（'1'|'2'）；活跃候选未填则回退另一个。
    const active = String(settings.daily_api_active || '1').trim() === '2' ? '2' : '1';
    const c1 = {
        base: settings.daily_api_base_url,
        key: settings.daily_api_key,
        model: settings.daily_model,
    };
    const c2 = {
        base: settings.daily_api_base_url_2,
        key: settings.daily_api_key_2,
        model: settings.daily_model_2,
    };
    let pick = active === '2' ? c2 : c1;
    if (!pick.base || !pick.key) pick = active === '2' ? c1 : c2;
    const chosenName = (pick === c2) ? '候选2' : '候选1';
    _upsertNamedApiConfig(
        'summary-daily',
        pick.base,
        pick.key,
        pick.model || process.env.SUMMARY_DAILY_MODEL || defaultModel,
    );
    if (pick.base && pick.key) {
        console.log(`[Tidal Memory] 事件线活跃候选: ${chosenName}(${active})`);
    }
}

/**
 * 事件线独立后台：与固化彻底解耦，全局（合并所有会话）每逻辑日一行。
 * 按「几轮一次」(daily_events_interval) 统计【本逻辑日全局轮数】，达标则重写。
 * 关闭 feature_daily_events_enabled 则完全不提取。
 */
async function checkAndRunDailyEvents() {
    try {
        const featureFlags = require('./services/featureFlags');
        if (!featureFlags.isOn('feature_daily_events_enabled', true)) return;
        const interval = featureFlags.getDailyEventsInterval();
        const { currentLogicalDate, logicalDateFromISO } = require('./utils/time');
        const { regenerateDailyEvents } = require('./services/summary');
        const day = currentLogicalDate();

        // 全局游标：本逻辑日已写事件线的最大 end_message_id
        const cur = db.prepare(`
            SELECT MAX(end_message_id) AS m FROM chat_summaries
            WHERE kind = 'activity' AND is_enabled = 1 AND event_date = ?
        `).get(day);
        const lastId = (cur && cur.m) ? cur.m : 0;

        // 全局轮数：本逻辑日、id>lastId 的所有会话 AI 消息数
        const rows = db.prepare(`
            SELECT id, timestamp FROM messages
            WHERE id > ? AND sender IN ('draco', 'ai')
            ORDER BY id DESC LIMIT 3000
        `).all(lastId);
        let cnt = 0;
        for (const r of rows) {
            if (logicalDateFromISO(r.timestamp) === day) cnt++;
        }
        if (cnt < interval) return;

        console.log(`[Tidal Memory] 事件线后台: 逻辑日 ${day} 距上次 ${cnt} 轮 ≥ ${interval}，全局重写`);
        await regenerateDailyEvents({ eventDate: day });
    } catch (e) {
        console.error('[Tidal Memory] 事件线后台检查失败:', e.message);
    }
}

async function syncRelaySettings() {
    try {
        const settings = await _fetchRelaySettings();

        const { SCRIBE_CONFIG } = require('./services/scribe');
        if (settings.scribe_min_messages) {
            const v = parseInt(settings.scribe_min_messages);
            if (v >= 3) {
                SCRIBE_CONFIG.MIN_MESSAGES = v;
                console.log(`[Tidal Memory] Scribe 门槛: ${v} 条消息后触发`);
            }
        }
        if (settings.scribe_silence_minutes) {
            const v = parseInt(settings.scribe_silence_minutes);
            if (v >= 1) {
                SCRIBE_CONFIG.SILENCE_MINUTES = v;
                console.log(`[Tidal Memory] Scribe 沉默等待: ${v} 分钟`);
            }
        }
        _syncMemoryApiConfig(settings);
        try {
            const affectLlm = require('./services/affect/llmConfig');
            affectLlm.setFromRelaySettings(settings);
        } catch (e) {
            console.warn('[积温] 同步 LLM 配置跳过:', e.message);
        }
        try {
            const analyzer = require('./services/affect/analyzer');
            analyzer.setSystemPrompt(settings.affect_prompt || '');
        } catch (e) {
            console.warn('[积温] 同步分析提示词跳过:', e.message);
        }
        try {
            _syncSummaryApiConfigs(settings);
        } catch (e) {
            console.warn('[Tidal Memory] summary api 同步跳过:', e.message);
        }
        try {
            const featureFlags = require('./services/featureFlags');
            featureFlags.setFromRelay(settings);
            const { setUserSetting } = require('./utils/settings');
            for (const key of Object.keys(featureFlags.DEFAULTS)) {
                if (settings[key] != null && settings[key] !== '') {
                    await setUserSetting(key, String(settings[key]));
                }
            }
            // 天气调度：城市跟随设置；关则停刷；开则确保在跑（不挡主路径）
            try {
                const weather = require('./services/weather');
                if (featureFlags.isOn('feature_weather_enabled', true)) {
                    weather.setCity(settings.weather_city, settings.weather_city_path);
                    weather.startScheduler();
                } else {
                    weather.stopScheduler();
                }
            } catch (we) {
                console.warn('[Tidal Memory] 天气调度同步跳过:', we.message);
            }
        } catch (e) {
            console.warn('[Tidal Memory] featureFlags 同步跳过:', e.message);
        }
        // 日程解析：配置库选中的那套（按 revision 去重，避免每分钟重复加密写库）
        try {
            const rev = String(settings.schedule_parser_rev || '').trim();
            const base = String(settings.schedule_parser_api_base_url || '').trim();
            const key = String(settings.schedule_parser_api_key || '').trim();
            const model = String(settings.schedule_parser_api_model || '').trim();
            if (rev && base && key && model) {
                const { getUserSetting, setUserSetting } = require('./utils/settings');
                const cur = await getUserSetting('schedule_parser_rev');
                if (String(cur?.value == null ? '' : cur.value) !== rev) {
                    require('./services/schedules').setParserConfigFromRelay({ base, key, model });
                    await setUserSetting('schedule_parser_rev', rev);
                    console.log('[Tidal Memory] Schedule Parser 已按配置库更新');
                }
            }
        } catch (se) {
            console.warn('[Tidal Memory] 日程解析配置同步跳过:', se.message);
        }
    } catch (e) {
        console.warn('[Tidal Memory] 无法从 relay 同步设置，使用默认 Scribe 配置:', e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 服务初始化（延迟启动，等数据库就绪）
// ═══════════════════════════════════════════════════════

let archivist = null;
let lifecycleTimer = null;

async function startServices() {
    // 启动 Archivist 自主循环（2 分钟 tick）
    try {
        archivist = require('./services/archivist');
        archivist.start();
        console.log('[Tidal Memory] Archivist 已启动');
    } catch (e) {
        console.error('[Tidal Memory] Archivist 启动失败:', e.message);
    }

    // 每日生命周期维护（24h 间隔）
    try {
        const { runLifecycleMaintenance, backupSanctuaryDb } = require('./services/lifecycle');
        try {
            backupSanctuaryDb();
        } catch (e) {
            console.warn('[Tidal Memory] 启动时备份跳过:', e.message);
        }
        lifecycleTimer = setInterval(async () => {
            console.log('[Tidal Memory] 每日生命周期维护...');
            try {
                const stats = await runLifecycleMaintenance();
                console.log('[Tidal Memory] 生命周期完成:', JSON.stringify(stats));
            } catch (e) {
                console.error('[Tidal Memory] 生命周期失败:', e.message);
            }
        }, 24 * 60 * 60 * 1000);
        console.log('[Tidal Memory] 生命周期调度已设置 (24h)');
    } catch (e) {
        console.error('[Tidal Memory] 生命周期调度失败:', e.message);
    }

    // Scribe 轮询（2 分钟间隔）：周期评估是否需要提取记忆。
    // 触发条件（沉默 20min / 0.5h 兜底 / 100 条强制）由 checkAndRunScribe 内部裁决。
    // 与 Archivist 的 2min tick 同频，失败时重试频率适中。
    try {
        const { checkAndRunScribe } = require('./services/scribe');
        setInterval(async () => {
            try {
                await checkAndRunScribe();
            } catch (e) {
                console.error('[Tidal Memory] Scribe 轮询失败:', e.message);
            }
        }, 2 * 60 * 1000);
        console.log('[Tidal Memory] Scribe 轮询已设置 (2min)');
    } catch (e) {
        console.error('[Tidal Memory] Scribe 轮询设置失败:', e.message);
    }

    // 事件线独立后台（2min 检查）：与固化彻底解耦；关闭开关则完全不提取。
    try {
        setInterval(async () => {
            try { await checkAndRunDailyEvents(); } catch (e) {
                console.error('[Tidal Memory] 事件线后台轮询失败:', e.message);
            }
        }, 2 * 60 * 1000);
        console.log('[Tidal Memory] 事件线后台轮询已设置 (2min, 周期由滑动条控制)');
    } catch (e) {
        console.error('[Tidal Memory] 事件线后台调度失败:', e.message);
    }

    // 对话航海日志改为完全手动触发（2026-08-14）：前端「会话列表 → 航海日志按钮」
    // 经 relay 代理调 /summary/run 生成。不再 15 分钟自动轮询，避免每次遍历全部会话调 LLM。

    // 情绪（积温）心跳（5 分钟 tick）。P1 只积累与观测，不发消息——
    // 主动开口走 ai_brain 积温调度器；本处只维护积温状态与观察。
    try {
        require('./services/affect/scheduler').start();
    } catch (e) {
        console.error('[Tidal Memory] 积温心跳启动失败:', e.message);
    }

    // 天气缓存：启动拉一次 + 默认每 1h 刷新（城市来自设置，默认北京 / wttr.in）
    try {
        const featureFlags = require('./services/featureFlags');
        if (featureFlags.isOn('feature_weather_enabled', true)) {
            require('./services/weather').startScheduler();
        } else {
            console.log('[Tidal Memory] 天气功能已关闭，跳过调度');
        }
    } catch (e) {
        console.error('[Tidal Memory] 天气调度启动失败:', e.message);
    }
}

// ═══════════════════════════════════════════════════════
// Tidal 专用 API
// ═══════════════════════════════════════════════════════

// ── 健康检查 ──
app.get('/healthz', (req, res) => {
    const status = archivist ? archivist.getStatus() : { state: 'not_started' };
    res.json({ ok: true, archivist: status });
});

// ── 天气缓存（供 AI 脑当轮 [天气] 注入；只读）──
app.get('/grounding/quota', async (req, res) => {
    try {
        const groundingQuota = require('./services/groundingQuota');
        res.json(await groundingQuota.getQuota());
    } catch (e) {
        console.error('[grounding/quota]', e);
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.post('/grounding/quota/consume', async (req, res) => {
    try {
        const groundingQuota = require('./services/groundingQuota');
        const count = req.body?.count;
        res.json(await groundingQuota.consume(count));
    } catch (e) {
        console.error('[grounding/quota/consume]', e);
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.get('/weather/cache', async (req, res) => {
    try {
        const { getInjectPayload } = require('./services/weather');
        const payload = await getInjectPayload();
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message, text: '' });
    }
});

// ── 手动刷新天气（调试）──
app.post('/weather/refresh', async (req, res) => {
    try {
        const { refreshCache } = require('./services/weather');
        const result = await refreshCache({ force: true });
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── 自醒闹钟：到期列表 / 认领 / 确认 ──
app.get('/alarms/due', (req, res) => {
    try {
        const alarms = require('./services/alarms');
        const items = alarms.listDue(req.query.now);
        res.json({ items });
    } catch (e) {
        res.status(500).json({ error: e.message, items: [] });
    }
});

app.get('/alarms/pending', (req, res) => {
    try {
        const alarms = require('./services/alarms');
        res.json({ items: alarms.listPending() });
    } catch (e) {
        res.status(500).json({ error: e.message, items: [] });
    }
});

app.post('/alarms/:id/claim', (req, res) => {
    try {
        const alarms = require('./services/alarms');
        const alarm = alarms.claim(req.params.id);
        if (!alarm) return res.status(409).json({ ok: false, error: '无法认领（不存在或非 pending）' });
        res.json({ ok: true, alarm });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/alarms/:id/ack', (req, res) => {
    try {
        const alarms = require('./services/alarms');
        const success = !!(req.body && req.body.success);
        const result = alarms.ack(req.params.id, success);
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── 主动关怀：最近 24h 的 current_state / state|fact 碎片（轻量）──
app.get('/proactive/recent-states', (req, res) => {
    try {
        const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10) || 24, 1), 72);
        const limit = Math.min(Math.max(parseInt(req.query.limit || '3', 10) || 3, 1), 10);
        const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const items = [];

        try {
            const states = db.prepare(`
                SELECT content, created_at, last_evidence_at, updated_at, expires_at
                FROM clara_model
                WHERE type = 'current_state' AND status = 'active'
                  AND COALESCE(last_evidence_at, updated_at, created_at) >= ?
                ORDER BY COALESCE(last_evidence_at, updated_at, created_at) DESC
                LIMIT ?
            `).all(cutoff, limit);
            for (const s of states) {
                if (s.content) {
                    const tagged = `${formatStateTensePrefix(s)} ${String(s.content).slice(0, 200)}`;
                    items.push({ source: 'current_state', content: tagged });
                }
            }
        } catch (_) { /* 表结构差异时跳过 */ }

        if (items.length < limit) {
            const need = limit - items.length;
            const frags = db.prepare(`
                SELECT content, type, created_at FROM memory_fragments
                WHERE status = 'active'
                  AND type IN ('state', 'fact')
                  AND created_at >= ?
                ORDER BY created_at DESC
                LIMIT ?
            `).all(cutoff, need);
            for (const f of frags) {
                if (f.content) items.push({ source: f.type, content: String(f.content).slice(0, 200) });
            }
        }

        res.json({ ok: true, hours, items: items.slice(0, limit) });
    } catch (e) {
        console.error('[Tidal Memory] recent-states 失败:', e.message);
        res.status(500).json({ ok: false, error: e.message, items: [] });
    }
});

// ── 主动关怀：手动/调试生成短句（不发送；由 relay /app/proactive_now 落库+推送）──
app.post('/proactive/compose', async (req, res) => {
    try {
        const composeCare = require('./services/affect/composeCare');
        const desperate = !!(req.body && req.body.desperate);
        const out = await composeCare.compose({ desperate });
        res.json({ ok: true, ...out });
    } catch (e) {
        console.error('[Tidal Memory] proactive/compose 失败:', e.message);
        res.status(500).json({ ok: false, error: e.message, lines: [] });
    }
});

// ── 当前状态 / 直觉上下文：供 AI 大脑注入 system prompt ──
app.get('/intuition/context', (req, res) => {
    try {
        const { getTriggeredIntuition } = require('./services/intuition');
        const q = String(req.query.q || '');
        const stickyRaw = String(req.query.sticky ?? '1').toLowerCase();
        const stickyEntities = !['0', 'false', 'off', 'no'].includes(stickyRaw);
        const result = getTriggeredIntuition(q, 500, { stickyEntities });
        res.json({ ok: true, text: (result && result.text) || '' });
    } catch (e) {
        console.error('[Tidal Memory] intuition/context 失败:', e.message);
        res.status(500).json({ ok: false, text: '', error: e.message });
    }
});

// ── 消息摄入：AI 大脑把新消息推到这里 ──
app.post('/messages/ingest', (req, res) => {
    try {
        const { sender, content, timestamp, chat_id } = req.body;
        if (!sender || !content) {
            return res.status(400).json({ error: 'sender and content required' });
        }
        const cid = chat_id || '__legacy__';
        // 确保 chat 存在（name = 会话标识，前端会话名即 id 名）
        db.prepare('INSERT OR IGNORE INTO chats (id, name) VALUES (?, ?)').run(cid, cid);
        const stmt = db.prepare(
            'INSERT INTO messages (chat_id, sender, content, timestamp, is_encrypted) VALUES (?, ?, ?, ?, 0)'
        );
        const info = stmt.run(cid, sender, content, timestamp || new Date().toISOString());
        res.json({ id: info.lastInsertRowid, ingested: true });
    } catch (e) {
        console.error('[Tidal Memory] 消息摄入失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 消息截断：编辑/停止/重生成时删掉 after_ts 及之后的摄入行（best-effort）──
app.post('/messages/truncate', (req, res) => {
    try {
        const { chat_id, after_ts } = req.body || {};
        const cid = chat_id || '__legacy__';
        if (!after_ts) {
            return res.status(400).json({ error: 'after_ts required' });
        }
        const info = db.prepare(
            'DELETE FROM messages WHERE chat_id = ? AND timestamp >= ?'
        ).run(cid, after_ts);
        res.json({ ok: true, deleted: info.changes || 0 });
    } catch (e) {
        console.error('[Tidal Memory] 消息截断失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Scribe 手动触发 ──
app.post('/scribe/trigger', async (req, res) => {
    try {
        const { checkAndRunScribe } = require('./services/scribe');
        const result = await checkAndRunScribe();
        res.json({ triggered: true, result });
    } catch (e) {
        console.error('[Tidal Memory] Scribe 触发失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Scribe 强制触发（跳过条件检查，测试用）──
app.post('/scribe/force', async (req, res) => {
    try {
        const db = require('./database').getDb();
        const messages = db.prepare(`
            SELECT id, sender, content, timestamp, message_type, is_encrypted
            FROM messages WHERE is_tagged = 0 ORDER BY timestamp ASC LIMIT 60
        `).all();
        if (!messages.length) return res.json({ forced: true, written: 0, reason: 'no messages' });

        const { runScribe } = require('./services/scribe');
        const since = '2000-01-01'; // 全量处理
        db.prepare("DELETE FROM scribe_runs").run(); // 清除上次记录
        await runScribe(messages, since);
        res.json({ forced: true, written: 'check fragments' });
    } catch (e) {
        console.error('[Tidal Memory] 强制触发失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Librarian 记忆检索（AI 大脑记忆注入用）──
app.get('/librarian/search', async (req, res) => {
    try {
        const { searchHybrid, formatHybridContext } = require('./services/librarian');
        const q = req.query.q || '';
        const limit = parseInt(req.query.limit) || 5;
        const results = await searchHybrid(q, limit);
        // 工作记忆池写入：检索命中 → 碎片入池（原作者 updatePool 本在无人调用的
        // buildSmartContext 里，此处为最小接入点，解决池空导致 getBoostMap 失效）
        try {
            const { updatePool } = require('./services/workingMemory');
            updatePool(results);
        } catch (e) {
            console.error('[Tidal Memory] 工作记忆池写入失败:', e.message);
        }
        const context = formatHybridContext(results, q);
        const formatted = results.map(r => ({
            id: r.id, type: r.type, content: r.content,
            entity: r.entity, weight: r.weight, score: r.combined_score,
        }));
        res.json({ query: q, results: formatted, context });
    } catch (e) {
        console.error('[Tidal Memory] 检索失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 工具定义拉取（AI 大脑侧工具定义+教导的单一数据源）──
// format=gemini   → 大写 schema（OBJECT/STRING/INTEGER），供 Gemini function calling
// format=openai   → 小写 schema（object/string/integer）+ required 数组，供 OpenAI 兼容 API
// 所有描述统一过 fillPrompt 替换 Clara/Draco/{user}/{ai}
//
// 记忆屏障块：源自原作者 context.js 的记忆使用规则（权限/时间/纠正），
// 由 AI 大脑放入 system prompt，指导如何解读检索出的记忆标签。
const MEMORY_BARRIER_PROMPT = `[已存储记忆库 — 以下是你自己的记忆，不是{user}刚说的新信息]

每条记忆标注了「引用权限」和「距今时间」：

【可引用】→ 确定的事实，可以直接引用
【需谨慎】→ 用"我印象里""好像是……"开头，留纠正空间
【仅联想】→ 仅供你自己联想参考，不要当作确定事实告诉{user}。如果想提，说"我好像突然想起……但不太确定"

时间感觉：
- 15天以内 → "最近"
- 1-3个月 → "之前"或"有一阵了"
- 超过3个月 → 别表现出刚发生的感觉

关于纠正：如果{user}说"不对"或"不是那次"，接受{user}的纠正，不要搬出记忆库辩解——记忆库本来就是碎片化的，{user}比你清楚。`;

app.get('/tools/definitions', async (req, res) => {
    try {
        const { getEnabledTools } = require('./services/tools/index');
        const { fillPrompt } = require('./services/nameResolver');
        const { getUserSetting } = require('./utils/settings');
        const format = (req.query.format || 'gemini').toLowerCase();

        const { functionDeclarations, instructionText } = await getEnabledTools({ getUserSetting });

        // 统一替换硬编码人名变量
        const fill = (s) => fillPrompt(s);
        const declarations = functionDeclarations.map(d => {
            const params = d.parameters || { type: 'OBJECT', properties: {} };
            const properties = {};
            for (const [k, v] of Object.entries(params.properties || {})) {
                properties[k] = { ...v, description: fill(v.description) };
            }
            return {
                name: d.name,
                description: fill(d.description),
                parameters: { ...params, properties },
            };
        });

        if (format === 'openai') {
            // OpenAI 兼容：类型小写 + required 数组（缺省视为全部可选）
            const openaiDecls = declarations.map(d => ({
                name: d.name,
                description: d.description,
                parameters: {
                    type: 'object',
                    properties: Object.fromEntries(
                        Object.entries(d.parameters.properties || {}).map(([k, v]) => [
                            k, { ...v, type: String(v.type).toLowerCase() }
                        ])
                    ),
                    required: Array.isArray(d.parameters.required) ? d.parameters.required : [],
                },
            }));
            return res.json({
                format: 'openai',
                tools: openaiDecls,
                instructionText: fill(instructionText),
                barrierPrompt: fill(MEMORY_BARRIER_PROMPT),
            });
        }

        // 默认 Gemini：保留原版大写 schema 原样透传（与 llm.js 现有行为一致）
        return res.json({
            format: 'gemini',
            tools: declarations,
            instructionText: fill(instructionText),
            barrierPrompt: fill(MEMORY_BARRIER_PROMPT),
        });
    } catch (e) {
        console.error('[Tidal Memory] 工具定义拉取失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 记忆工具调度（对应 AI 大脑的四个工具）──
app.post('/tools/:toolName', async (req, res) => {
    try {
        const { executeTool } = require('./services/tools/index');
        const toolName = req.params.toolName;
        const args = req.body || {};

        // 构建工具执行上下文（chatId 兼容旧代码）
        const context = { chatId: 1, lastClaraMessage: null };

        const result = await executeTool(toolName, args, context);
        res.json({ tool: toolName, result });
    } catch (e) {
        console.error(`[Tidal Memory] 工具 '${req.params.toolName}' 执行失败:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Archivist 状态 ──
app.get('/archivist/status', (req, res) => {
    try {
        const status = archivist ? archivist.getStatus() : { error: 'not_started' };
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── 生命周期手动触发 ──
app.post('/lifecycle/run', async (req, res) => {
    try {
        const { runLifecycleMaintenance } = require('./services/lifecycle');
        const stats = await runLifecycleMaintenance();
        res.json({ triggered: true, stats });
    } catch (e) {
        console.error('[Tidal Memory] 生命周期失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 对话航海日志（短期记忆）· 手动强制总结 ──
app.get('/summary/prompts', (req, res) => {
    try {
        const { getPromptDefaults } = require('./services/summary');
        res.json({ ok: true, ...getPromptDefaults() });
    } catch (e) {
        console.error('[Tidal Memory] summary prompts:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/summary/run', async (req, res) => {
    try {
        const { generateChatSummary } = require('./services/summary');
        const chatId = (req.body && req.body.chat_id) || '__legacy__';
        const result = await generateChatSummary(chatId);
        res.json({ triggered: true, chat_id: chatId, result });
    } catch (e) {
        console.error('[Tidal Memory] Summary 生成失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 仅重写事件线（全局，不写航海日志）
app.post('/summary/activity/rewrite', async (req, res) => {
    try {
        const { regenerateDailyEvents } = require('./services/summary');
        const eventDate = (req.body && req.body.event_date) || undefined;
        const result = await regenerateDailyEvents({ eventDate });
        res.json({ ok: !!result.success, result });
    } catch (e) {
        console.error('[Tidal Memory] activity rewrite 失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 约每 N 轮后台整理（wait=true 时同步跑完并返回 result）──
app.post('/summary/maybe', async (req, res) => {
    try {
        const { checkAndTriggerSummary, generateChatSummary, DEFAULT_SUMMARY_INTERVAL } = require('./services/summary');
        const chatId = (req.body && req.body.chat_id) || '__legacy__';
        const wait = !!(req.body && req.body.wait);

        if (!wait) {
            const status = await checkAndTriggerSummary(chatId, 'maybe');
            return res.json({ ok: true, chat_id: chatId, ...status });
        }

        // wait=true：由 brain 固化任务调用，达标则 await 生成
        const db = require('./database').getDb();
        const chatConfig = db.prepare(
            'SELECT last_summary_message_id, summary_interval FROM chats WHERE id = ?'
        ).get(chatId);
        if (!chatConfig) {
            return res.json({
                ok: true, chat_id: chatId, triggered: false,
                roundsSince: 0, interval: DEFAULT_SUMMARY_INTERVAL,
            });
        }
        const lastSummaryId = chatConfig.last_summary_message_id || 0;
        let interval = chatConfig.summary_interval;
        if (interval == null || interval <= 0) interval = DEFAULT_SUMMARY_INTERVAL;
        const roundsSince = db.prepare(`
            SELECT COUNT(*) as count FROM messages
            WHERE chat_id = ? AND id > ? AND sender IN ('draco', 'ai')
        `).get(chatId, lastSummaryId).count;

        if (roundsSince < interval) {
            return res.json({
                ok: true, chat_id: chatId, triggered: false,
                roundsSince, interval,
            });
        }

        const result = await generateChatSummary(chatId);
        res.json({
            ok: true, chat_id: chatId, triggered: true,
            roundsSince, interval, result,
        });
    } catch (e) {
        console.error('[Tidal Memory] Summary maybe 失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── 对话航海日志 · 最近一条（AI 大脑短期记忆注入）──
app.get('/summary/latest', (req, res) => {
    try {
        const chatId = req.query.chat_id || '__legacy__';
        const row = db.prepare(`
            SELECT summary_text FROM chat_summaries
            WHERE chat_id = ? AND is_enabled = 1
              AND (kind = 'log' OR kind IS NULL)
            ORDER BY id DESC LIMIT 1
        `).get(chatId);
        if (!row) return res.json({ has_summary: false });
        const { encryption } = require('./encryption');
        let text = row.summary_text;
        try { text = encryption.decrypt(text); } catch (_) {}
        res.json({ has_summary: true, summary: text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── 今日事件线 · 当前逻辑日全量（04:00→次日04:00，覆盖写后至多一行）──
// 本日尚无数据时回退到最近有数据的那一天，避免清晨断片
// 显示/注入：并入「上一逻辑日里属于本日凌晨(00:00-04:00)的行」，并按自然日分组标注
function _parseActivityLines(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
        const t = raw.trim();
        if (!t || /^##/.test(t)) continue;
        const m = t.match(/(\d{1,2}):(\d{2})/);
        if (!m) continue;
        const h = Number(m[1]);
        const mi = Number(m[2]);
        if (!Number.isFinite(h) || !Number.isFinite(mi)) continue;
        out.push({ line: t.replace(/^[-*]\s+/, ''), min: h * 60 + mi });
    }
    return out;
}

function _groupActivityByCalendarDate(currText, prevText, day) {
    const { addCalendarDays } = require('./utils/time');
    const groups = new Map();
    const push = (ymd, entry) => {
        if (!groups.has(ymd)) groups.set(ymd, []);
        groups.get(ymd).push(entry);
    };
    // 上一逻辑日里「当天凌晨 00:00-04:00」的行 → 归到 day
    for (const e of _parseActivityLines(prevText)) {
        if (e.min < 4 * 60) push(day, e);
    }
    for (const e of _parseActivityLines(currText)) {
        const cal = e.min < 4 * 60 ? addCalendarDays(day, 1) : day;
        push(cal, e);
    }
    const lines = [];
    for (const ymd of [...groups.keys()].sort()) {
        const arr = groups.get(ymd).sort((a, b) => a.min - b.min);
        lines.push(`[${ymd.slice(5)}]`);
        for (const e of arr) lines.push(e.line);
    }
    return lines.join('\n');
}

app.get('/summary/activity', (req, res) => {
    try {
        const { currentLogicalDate } = require('./utils/time');
        const { encryption } = require('./encryption');
        const today = currentLogicalDate();

        const pickRow = (d) => db.prepare(`
            SELECT summary_text FROM chat_summaries
            WHERE kind = 'activity' AND is_enabled = 1 AND event_date = ?
            ORDER BY id DESC LIMIT 1
        `).get(d);
        const decrypt = (row) => {
            let t = row ? row.summary_text : '';
            try { t = encryption.decrypt(t); } catch (_) {}
            return (t || '').trim();
        };

        let day = today;
        let text = decrypt(pickRow(day));
        if (!text) {
            const prev = db.prepare(`
                SELECT MAX(event_date) d FROM chat_summaries
                WHERE kind = 'activity' AND is_enabled = 1
                  AND event_date IS NOT NULL AND event_date < ?
            `).get(today).d;
            if (!prev) return res.json({ has_activity: false, text: '', day: today });
            day = prev;
            text = decrypt(pickRow(day));
        }
        if (!text) return res.json({ has_activity: false, text: '', day: today });

        // 仅当前逻辑日才把「上一逻辑日的凌晨」并入（跨日标注由分组完成）
        let merged = text;
        if (day === today) {
            const prevDay = db.prepare(`
                SELECT MAX(event_date) d FROM chat_summaries
                WHERE kind = 'activity' AND is_enabled = 1
                  AND event_date IS NOT NULL AND event_date < ?
            `).get(day).d;
            const prevText = prevDay ? decrypt(pickRow(prevDay)) : '';
            merged = _groupActivityByCalendarDate(text, prevText, day);
        }

        res.json({ has_activity: true, text: merged, day, stale: day !== today });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── 聊天消息批量获取（给 Scribe 提供消息源）──
app.get('/messages/unprocessed', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const rows = db.prepare(`
            SELECT id, chat_id, sender, content, timestamp
            FROM messages WHERE is_tagged = 0
            ORDER BY id ASC LIMIT ?
        `).all(limit);
        res.json({ count: rows.length, messages: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════
// 星图 API — 挂载 Memory Constellations 完整版路由
// 原版 routes/memory-api.js（含完整星图：双星核心/五星系/观星手记/合并提案）
// 鉴权经 routes/auth.js 极简放行桩（Tidal 本地无密码模式）
// ═══════════════════════════════════════════════════════

app.use(require('./routes/memory-api'));

// 情绪（积温）只读接口：/affect/state、/affect/log
app.use(require('./routes/affect-api'));

// 日程：/schedules CRUD + parse + injectable
app.use(require('./routes/schedules-api'));

// ═══════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════

const PORT = process.env.MEMORY_PORT || 3013;
app.listen(PORT, async () => {
    console.log(`[Tidal Memory] 记忆服务启动: http://127.0.0.1:${PORT}`);
    console.log(`   健康检查: http://127.0.0.1:${PORT}/healthz`);

    // 从 relay 拉取用户设置（Scribe 门槛 + 记忆管线 API）
    await syncRelaySettings();
    setInterval(syncRelaySettings, 60 * 1000);

    // 延迟 500ms 启动后台服务（等数据库完全就绪）
    setTimeout(startServices, 500);
});