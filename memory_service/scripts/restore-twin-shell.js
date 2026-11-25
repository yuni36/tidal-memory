#!/usr/bin/env node
/**
 * restore-twin-shell.js
 *
 * 1) 从备份恢复被双星状态壳碎片重叠合并吃掉的星座链接与 status
 * 2) 退役双星状态壳（User在 / Assistant在 等）：碎片改挂双星，实体标 superseded
 *
 * 用法（容器内或宿主机）:
 *   node scripts/restore-twin-shell.js \
 *     --live /app/memory_service/data/sanctuary.db \
 *     --backup /app/backups/sanctuary_2026-09-17.db \
 *     [--apply]
 *
 * 默认 dry-run；加 --apply 才写库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return fallback;
}

const LIVE = arg('--live', path.join(__dirname, '../data/sanctuary.db'));
const BACKUP = arg('--backup', '');
const APPLY = process.argv.includes('--apply');

let isTwinStatusShell;
let USER;
let AI;
try {
    ({ isTwinStatusShell, USER, AI } = require('../services/memoryConfig'));
} catch (_) {
    USER = { name: 'User' };
    AI = { name: 'Assistant' };
    isTwinStatusShell = (n) => n === 'User在' || n === 'Assistant在';
}

if (!BACKUP || !fs.existsSync(BACKUP)) {
    console.error('需要 --backup 指向可读的 sanctuary 备份（建议 2026-09-17）');
    process.exit(1);
}
if (!fs.existsSync(LIVE)) {
    console.error('live db 不存在:', LIVE);
    process.exit(1);
}

const live = new Database(LIVE);
const bak = new Database(BACKUP, { readonly: true });

const SHELLS = [USER.name + '在', AI.name + '在'].filter((n) => isTwinStatusShell(n));
const TWIN_OF = {
    [USER.name + '在']: USER.name,
    [AI.name + '在']: AI.name,
};

// 曾被 seedMerge 并进用户状态壳的实体名（按需填写；开源默认可空）
const MERGED_INTO_SHELL = [];
// AI 状态壳也要退役，但不从备份「复活为 active 星座」
const RETIRE_ONLY = [...SHELLS];

function entByName(db, name) {
    return db.prepare('SELECT id, name, status, fragment_count, overview, current_status, aliases, tags FROM entity_profiles WHERE name = ?').get(name);
}

function linksFor(db, entityId) {
    return db.prepare(`
        SELECT fragment_id, relation, confidence, classified_by
        FROM fragment_entities WHERE entity_id = ?
    `).all(entityId);
}

function recalcCount(db, entityId) {
    const c = db.prepare('SELECT COUNT(*) AS c FROM fragment_entities WHERE entity_id = ?').get(entityId).c;
    db.prepare(`UPDATE entity_profiles SET fragment_count = ?, updated_at = datetime('now') WHERE id = ?`).run(c, entityId);
    return c;
}

console.log(`mode=${APPLY ? 'APPLY' : 'dry-run'} live=${LIVE}`);
console.log(`backup=${BACKUP}`);
console.log(`shells=${SHELLS.join(',')}`);

const report = { restored: [], retired: [], skipped: [] };

const restoreTx = live.transaction(() => {
    // ── 1) 恢复被合并星座 ──
    for (const name of MERGED_INTO_SHELL) {
        const b = entByName(bak, name);
        const l = entByName(live, name);
        if (!b) {
            report.skipped.push({ name, reason: 'not in backup' });
            continue;
        }
        if (!l) {
            report.skipped.push({ name, reason: 'not in live' });
            continue;
        }
        const bakLinks = linksFor(bak, b.id);
        let inserted = 0;
        if (APPLY) {
            const ins = live.prepare(`
                INSERT OR IGNORE INTO fragment_entities
                  (fragment_id, entity_id, relation, confidence, classified_by)
                VALUES (?, ?, ?, ?, ?)
            `);
            for (const row of bakLinks) {
                const r = ins.run(row.fragment_id, l.id, row.relation, row.confidence, row.classified_by || 'restore_twin_shell');
                if (r.changes > 0) inserted++;
            }
            live.prepare(`
                UPDATE entity_profiles
                SET status = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(b.status || 'active', l.id);
            const fc = recalcCount(live, l.id);
            report.restored.push({ name, id: l.id, status: b.status, bakLinks: bakLinks.length, inserted, fragment_count: fc });
        } else {
            report.restored.push({ name, id: l.id, wouldStatus: b.status, bakLinks: bakLinks.length, liveStatus: l.status });
        }
    }

    // ── 2) 退役状态壳：链接改挂双星，壳标 superseded ──
    for (const shellName of RETIRE_ONLY) {
        const twinName = TWIN_OF[shellName];
        const shell = entByName(live, shellName);
        const twin = entByName(live, twinName);
        if (!shell) {
            report.skipped.push({ name: shellName, reason: 'shell missing' });
            continue;
        }
        if (!twin) {
            report.skipped.push({ name: shellName, reason: `twin ${twinName} missing` });
            continue;
        }
        const shellLinks = linksFor(live, shell.id);
        let moved = 0;
        if (APPLY) {
            const ins = live.prepare(`
                INSERT OR IGNORE INTO fragment_entities
                  (fragment_id, entity_id, relation, confidence, classified_by)
                VALUES (?, ?, ?, ?, ?)
            `);
            for (const row of shellLinks) {
                const r = ins.run(row.fragment_id, twin.id, row.relation, row.confidence, 'retarget_from_status_shell');
                if (r.changes > 0) moved++;
            }
            // 有用 overview 补到双星 current_status（空才写，不覆盖）
            if (shell.overview && (!twin.current_status || !String(twin.current_status).trim())) {
                live.prepare(`
                    UPDATE entity_profiles
                    SET current_status = ?, status_since = COALESCE(status_since, datetime('now')), updated_at = datetime('now')
                    WHERE id = ?
                `).run(String(shell.overview).slice(0, 240), twin.id);
            }
            live.prepare(`
                UPDATE entity_profiles
                SET status = 'superseded', updated_at = datetime('now')
                WHERE id = ?
            `).run(shell.id);
            const twinFc = recalcCount(live, twin.id);
            const shellFc = recalcCount(live, shell.id);
            report.retired.push({
                shell: shellName, twin: twinName, shellLinks: shellLinks.length, movedToTwin: moved,
                twin_fragment_count: twinFc, shell_fragment_count: shellFc,
            });
        } else {
            report.retired.push({
                shell: shellName, twin: twinName, shellLinks: shellLinks.length, twinId: twin.id,
            });
        }
    }
});

restoreTx();

console.log(JSON.stringify(report, null, 2));
if (!APPLY) {
    console.log('\n(dry-run 完毕。确认后加 --apply 写入。)');
} else {
    console.log('\n已写入。建议重启 memory 容器或等下一 tick 刷新星图缓存。');
}

live.close();
bak.close();
