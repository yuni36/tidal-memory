// services/ontology.js — Tidal Phase 3 简化版
// 原 Memory Constellations 中实现记忆宫殿层级分类体系。
// Phase 3 安全桩：返回空结果，不依赖 DB 表。记忆分区功能为后续迭代预留。

const { getDb } = require('../database');

function getChildren(parentId) {
    try {
        const db = getDb();
        const pid = parentId || null;
        if (pid === null) {
            return db.prepare(
                'SELECT id, label, description FROM memory_ontology WHERE parent_id IS NULL ORDER BY label'
            ).all();
        }
        return db.prepare(
            'SELECT id, label, description FROM memory_ontology WHERE parent_id = ? ORDER BY label'
        ).all(pid);
    } catch (e) {
        return [];
    }
}

function getCategoryFragments(catId, limit, offset) {
    try {
        const db = getDb();
        return db.prepare(`
            SELECT mf.id, mf.content, mf.source_date, mf.insight
            FROM memory_fragments mf
            JOIN fragment_categories fc ON fc.fragment_id = mf.id
            WHERE fc.category_id = ? AND mf.status = 'active'
            ORDER BY mf.source_date DESC
            LIMIT ? OFFSET ?
        `).all(catId, limit || 20, offset || 0);
    } catch (e) {
        return [];
    }
}

function getCategoryFragmentCountRecursive(catId) {
    try {
        const db = getDb();
        const direct = db.prepare(
            'SELECT COUNT(*) as cnt FROM fragment_categories WHERE category_id = ?'
        ).get(catId)?.cnt || 0;
        const children = db.prepare(
            'SELECT id FROM memory_ontology WHERE parent_id = ?'
        ).all(catId);
        let childTotal = 0;
        for (const child of children) {
            childTotal += getCategoryFragmentCountRecursive(child.id);
        }
        return direct + childTotal;
    } catch (e) {
        return 0;
    }
}

function getByPath(path) {
    try {
        const db = getDb();
        if (!path) return null;
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 0) return null;
        let parentId = null;
        let current = null;
        for (const part of parts) {
            current = db.prepare(
                'SELECT id, label, description, parent_id FROM memory_ontology WHERE label = ? AND parent_id IS ?'
            ).get(part, parentId);
            if (!current) {
                current = db.prepare(
                    'SELECT id, label, description, parent_id FROM memory_ontology WHERE label LIKE ? AND (parent_id IS ? OR ? IS NULL) LIMIT 1'
                ).get(`%${part}%`, parentId, parentId);
            }
            if (!current) return null;
            parentId = current.id;
        }
        return current;
    } catch (e) {
        return null;
    }
}

// 刷新分类碎片计数（直计，不含子孙分类）；archivist 在分类/合并后调用，失败仅记日志不中断调用方
function refreshFragmentCount(catId) {
    try {
        const db = getDb();
        const count = db.prepare(
            'SELECT COUNT(*) as c FROM fragment_categories WHERE category_id = ?'
        ).get(catId)?.c || 0;
        db.prepare("UPDATE memory_ontology SET fragment_count = ?, updated_at = datetime('now') WHERE id = ?")
            .run(count, catId);
        return count;
    } catch (e) {
        console.error('[Ontology] refreshFragmentCount 失败:', e.message);
        return 0;
    }
}

module.exports = { getChildren, getCategoryFragments, getCategoryFragmentCountRecursive, getByPath, refreshFragmentCount };