// services/affect/composeCare.js
// 手动/调试：按积温状态写 1~2 条主动关心短句（与 brain proactive_scheduler 口吻对齐）

const engine = require('./engine');
const { callLLM } = require('../llm');
const { getDb } = require('../../database');
const { formatStateTensePrefix } = require('../stateTense');

function beijingNowLabel() {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: 'numeric',
            day: 'numeric',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date());
    } catch (_) {
        return new Date().toISOString();
    }
}

function recentStates(limit = 3) {
    const db = getDb();
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const items = [];
    try {
        const rows = db.prepare(`
            SELECT content, created_at, last_evidence_at, updated_at, expires_at
            FROM clara_model
            WHERE type = 'current_state' AND status = 'active'
              AND COALESCE(last_evidence_at, updated_at, created_at) >= ?
            ORDER BY COALESCE(last_evidence_at, updated_at, created_at) DESC
            LIMIT ?
        `).all(cutoff, limit);
        for (const s of rows) {
            if (s.content) {
                items.push({ content: `${formatStateTensePrefix(s)} ${String(s.content).slice(0, 200)}` });
            }
        }
    } catch (_) { /* ignore */ }
    return items;
}

function parseLines(raw, n) {
    let parts = String(raw || '')
        .split(/\n+/)
        .map((p) => p.replace(/^[\s「」"'“”‘’\-•·\d.、)）]+|[\s「」"'“”‘’]+$/g, '').trim())
        .filter(Boolean);
    if (!parts.length) parts = ['这两天怎么样？'];
    if (n === 1) return parts.slice(0, 1);
    if (parts.length === 1) {
        const chunks = parts[0].replace(/。/g, '。\n').split(/\n+/).map((c) => c.trim()).filter(Boolean);
        if (chunks.length >= 2) parts = chunks;
    }
    return parts.slice(0, 2);
}

/**
 * @param {{ desperate?: boolean }} opts
 * @returns {Promise<{ lines: string[], description: string, styleGuidance: string }>}
 */
async function compose(opts = {}) {
    const desperate = Boolean(opts.desperate);
    const snap = await engine.snapshot();
    const description = String(snap.promptContext || snap.description || '').trim();
    const style = String(snap.styleGuidance || '').trim();
    const states = recentStates(3);
    const n = desperate ? 1 : 2;
    const bullets = states.map((s) => `- ${s.content}`).join('\n') || '（暂无近期状态）';
    const nowLabel = beijingNowLabel();

    const { USER, AI } = require('../memoryConfig');
    const userName = USER.name || 'User';
    const aiName = AI.name || 'Assistant';
    const systemPrompt =
        `你是${aiName}，在给${userName}发主动关心。输出必须短、像手机聊天；严格按用户要求的条数。`;
    const userText =
        `现在是${nowLabel}（北京时间）。\n` +
        `请以${aiName}的口吻写 ${n} 条主动关心短句` +
        `（每条不超过 28 字；${desperate ? '只写 1 条' : '写 2 条，用空行分隔'}）。\n` +
        '规则：有由头、不连续追问、不要 emoji、不要自称 AI、不要时间戳。\n' +
        '按当前情绪状态调整直接程度：防御偏高时收一点，用日常由头；放松时可以直接些。\n' +
        `【此刻状态】\n${description || '（无）'}\n` +
        `【当前情绪】\n${style || '（无）'}\n` +
        `【近期状态/事实】\n${bullets}\n` +
        '只输出短句正文，不要序号、不要引号。';

    const geminiMessages = [{ role: 'user', parts: [{ text: userText }] }];
    const result = await callLLM(geminiMessages, systemPrompt, null, {
        temperature: 0.9,
        maxOutputTokens: 256,
    });
    const text = typeof result === 'string'
        ? result
        : (result && (result.reply || result.text || result.content)) || '';
    const lines = parseLines(text, n);
    return { lines, description, styleGuidance: style };
}

module.exports = { compose };
