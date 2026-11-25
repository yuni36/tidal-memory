// services/claraModel.js — Tidal Phase 3 安全桩
// 原 Memory Constellations 中实现认知模型维护循环：
//   证据匹配 → 事实收割 → 模型衰减 → 过期状态解析
// Phase 3: 仅提供接口签名，实际逻辑为后续迭代预留。

const { getDb } = require('../database');

const MIN_GAP_CLARA_MODEL = 10 * 60 * 1000; // 10分钟最小间隔

async function runClaraModelCycle() {
    const db = getDb();
    // 简单整理：检查是否有孤立的 current_state
    try {
        const expired = db.prepare(
            "UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'), resolve_reason = 'auto-expired by lifecycle' WHERE type = 'current_state' AND status = 'active' AND expires_at < datetime('now')"
        ).run();
        if (expired.changes > 0) {
            console.log(`[claraModel] 自动过期 ${expired.changes} 条 current_state`);
        }
    } catch (e) {
        console.error('[claraModel] 周期维护失败:', e.message);
    }
    return { cycles: 1, expired: 0 };
}

function matchEvidenceFromFragments() {
    console.log('[claraModel] matchEvidence 跳过（Phase 3 桩）');
}

function harvestFacts() {
    console.log('[claraModel] harvestFacts 已退役（v4.8）');
}

function processModelDecay() {
    console.log('[claraModel] processModelDecay 跳过（Phase 3 桩）');
    return { decayed: 0 };
}

function resolveExpiredStates() {
    const db = getDb();
    try {
        const result = db.prepare(
            "UPDATE clara_model SET status = 'resolved', resolved_at = datetime('now'), resolve_reason = 'auto-resolved by lifecycle' WHERE type = 'current_state' AND status = 'active' AND expires_at < datetime('now')"
        ).run();
        console.log(`[claraModel] resolveExpiredStates: ${result.changes} 条过期`);
        return { resolved: result.changes };
    } catch (e) {
        console.error('[claraModel] resolveExpiredStates 失败:', e.message);
        return { resolved: 0 };
    }
}

module.exports = {
    runClaraModelCycle,
    matchEvidenceFromFragments,
    harvestFacts,
    processModelDecay,
    resolveExpiredStates,
    MIN_GAP_CLARA_MODEL,
};