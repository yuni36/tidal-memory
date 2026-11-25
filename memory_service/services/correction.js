// services/correction.js — 纠正反馈闭环（原 Memory Constellations 完整设计还原）
//
// 闭环链路：
//   ① correct_memory 工具 / 手动 API / 删除记忆碎片 → recordCorrection 写入 correction_log（错题本）
//   ② processChatCorrection：有 memory_id 修正该记忆；无 memory_id 时新增正确记忆（还原原作者设计）
//   ③ getActiveCorrections：近期纠正教训 → 注入 Scribe 提取 prompt，防止再提取错信息
//   ④ mergeGuidelines：active 纠正去重合并为长期准则（status → merged）
//   ⑤ getMergedGuidelines：长期编辑准则 → 注入 Scribe
//   ⑥ lifecycle 每日 runCorrectionFeedback：对 active 纠正的同源碎片降权（×0.5）→ status → applied
//
// 注意：memories.content 为加密存储（encryption.encrypt），读写必须走 encryption，禁止明文。

const { getDb } = require('../database');
const { encryption } = require('../encryption');

// ---------- ① 错题本写入（幂等 + 防堆积） ----------
function recordCorrection({ targetType, targetId = null, wrongSummary, correctSummary, source = 'manual', chatMessageId = null }) {
    const db = getDb();
    // 防堆积：相同 correct_summary 且仍 active 的纠正已存在 → 返回已有 id，不重复插入
    const existing = db.prepare(
        `SELECT id FROM correction_log WHERE correct_summary = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
    ).get(correctSummary);
    if (existing) return existing.id;

    const info = db.prepare(
        `INSERT INTO correction_log (target_type, target_id, wrong_summary, correct_summary, source, chat_message_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).run(targetType, targetId, wrongSummary, correctSummary, source, chatMessageId);
    return info.lastInsertRowid;
}

// ---------- ② correct_memory 工具入口 ----------
async function processChatCorrection({ wrongStatement, correction, memoryId, chatId }) {
    const db = getDb();
    let fixedId = null;

    // 有 memory_id：修正对应记忆（原逻辑保留，补上加密）
    if (memoryId) {
        try {
            const mem = db.prepare('SELECT id, content FROM memories WHERE id = ?').get(memoryId);
            if (mem) {
                db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
                    .run(encryption.encrypt(correction.slice(0, 2000)), new Date().toISOString(), memoryId);
                fixedId = memoryId;
                console.log(`[correction] 记忆 #${memoryId} 已修正`);
            }
        } catch (e) {
            console.error(`[correction] 更新记忆 #${memoryId} 失败:`, e.message);
        }
    }

    // 无 memory_id 或修正失败：新增一条正确记忆（原作者：编造/混淆 → 记为新的正确记忆）
    if (!fixedId) {
        try {
            const title = (correction || '记忆纠正').slice(0, 50);
            const info = db.prepare(
                `INSERT INTO memories (title, content, status, created_at, updated_at)
                 VALUES (?, ?, 'permanent', datetime('now'), datetime('now'))`
            ).run(title, encryption.encrypt((correction || '').slice(0, 2000)));
            fixedId = info.lastInsertRowid;
            console.log(`[correction] 新增正确记忆 #${fixedId}: ${title}`);
        } catch (e) {
            console.error(`[correction] 新增正确记忆失败:`, e.message);
        }
    }

    // 无论是否修到记忆都写错题本（source=chat），供 Scribe 教训注入
    recordCorrection({
        targetType: memoryId && fixedId === memoryId ? 'memory' : 'chat',
        targetId: fixedId || null,
        wrongSummary: (wrongStatement || '').slice(0, 200),
        correctSummary: (correction || '').slice(0, 500),
        source: 'chat',
    });

    return { success: true, formatted: fixedId ? `已修正记忆 #${fixedId}。` : '已记录修正信息。' };
}

// ---------- ③ 近期纠正教训（Scribe 注入「近期纠正教训」） ----------
function getActiveCorrections() {
    const db = getDb();
    const rows = db.prepare(
        `SELECT wrong_summary, correct_summary FROM correction_log
         WHERE status = 'active' ORDER BY id DESC LIMIT 20`
    ).all();
    return rows.map(r => `「你说：${r.wrong_summary}」应为：「${r.correct_summary}」`).join('\n');
}

// ---------- ④ 去重合并：active → 长期准则（status → merged） ----------
async function mergeGuidelines() {
    const db = getDb();
    const rows = db.prepare(
        `SELECT id, wrong_summary, correct_summary FROM correction_log WHERE status = 'active' ORDER BY id ASC`
    ).all();
    if (rows.length === 0) return '';

    const seen = new Set();
    const merged = [];
    const toMark = [];
    for (const r of rows) {
        if (seen.has(r.correct_summary)) continue; // 去重：相同 correct_summary 只保留一条
        seen.add(r.correct_summary);
        merged.push(`「${r.wrong_summary}」应为：「${r.correct_summary}」`);
        toMark.push(r.id);
    }

    // 事务内批量标记 merged
    const markMerged = db.transaction((ids) => {
        for (const id of ids) db.prepare(`UPDATE correction_log SET status = 'merged' WHERE id = ?`).run(id);
    });
    markMerged(toMark);
    return merged.join('\n');
}

// ---------- ⑤ 已合并长期编辑准则（Scribe 注入「长期编辑准则」） ----------
async function getMergedGuidelines() {
    const db = getDb();
    const rows = db.prepare(
        `SELECT wrong_summary, correct_summary FROM correction_log WHERE status = 'merged' ORDER BY id ASC`
    ).all();
    return rows.map(r => `「${r.wrong_summary}」应为：「${r.correct_summary}」`).join('\n');
}

module.exports = { processChatCorrection, recordCorrection, getActiveCorrections, mergeGuidelines, getMergedGuidelines };
