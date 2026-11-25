#!/usr/bin/env node
/**
 * rebuild-fts-cjk.js
 *
 * 用 splitCJK 全量重建 memory_fragments_fts（单字粒度）。
 * 正常路径：database.js v94 迁移在服务启动时自动跑。
 * 本脚本供运维手动补跑 / 验收。
 *
 * 用法（容器内）:
 *   node scripts/rebuild-fts-cjk.js
 *   node scripts/rebuild-fts-cjk.js --probe 理财 食堂
 */
'use strict';

const { initDatabase, getDb } = require('../database');

async function main() {
    initDatabase();
    const db = getDb();

    const before = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments_fts').get().c;
    const src = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments').get().c;

    const rebuilt = db.transaction(() => {
        db.exec('DELETE FROM memory_fragments_fts');
        return db.prepare(`
            INSERT INTO memory_fragments_fts(rowid, content, entity)
            SELECT id, splitCJK(content), splitCJK(COALESCE(entity, ''))
            FROM memory_fragments
        `).run().changes;
    })();

    try {
        db.exec("INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES('optimize')");
    } catch (_) { /* ignore */ }

    const after = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments_fts').get().c;
    console.log(JSON.stringify({ src, before, rebuilt, after }, null, 2));

    const probeIdx = process.argv.indexOf('--probe');
    if (probeIdx < 0) return;

    const qs = process.argv.slice(probeIdx + 1).filter((a) => !a.startsWith('--'));
    const { searchFragments, searchHybrid } = require('../services/librarian');
    for (const q of qs) {
        const like = db.prepare(
            "SELECT COUNT(*) AS c FROM memory_fragments WHERE status='active' AND content LIKE ?"
        ).get('%' + q + '%').c;
        const fts = searchFragments(q, 8);
        let hybrid = [];
        try {
            hybrid = (await searchHybrid(q, 8)) || [];
        } catch (e) {
            hybrid = { err: e.message };
        }
        console.log(JSON.stringify({
            q,
            like,
            fts: Array.isArray(fts) ? fts.length : fts,
            hybrid: Array.isArray(hybrid) ? hybrid.length : hybrid,
            sample: Array.isArray(fts) && fts[0] ? String(fts[0].content || '').slice(0, 60) : null,
        }));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
