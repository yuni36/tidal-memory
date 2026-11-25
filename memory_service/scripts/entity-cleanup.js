#!/usr/bin/env node
// scripts/entity-cleanup.js — 一次性脏数据剥离（配合 entityGuard 的运行时规则）
// ═══════════════════════════════════════════════════════════════
// 2026-09-08 生产库诊断的两个后果，代码改了规则但存量数据还在库里：
//
//   任务 C  停用通用词/度量衡实体。线上「系统」29 / 「模型」27 /
//           「小时」16 / 「美元」9 条碎片，把本该归 tidalecho、
//           记忆星球 的记忆全截胡了（后者只有 1-2 条）。
//
//   任务 D  拆分「大连」。29 条碎片里混了城市（火车/晕车药）、学校
//           （宿舍/食堂/课题组/校园卡）、资费三类，因为字面匹配让
//           「大连理工大学」的碎片全挂给了「大连」。
//
// 默认 dry-run，只打报告不写库。确认无误后加 --apply。
//
// 本机：  node memory_service\scripts\entity-cleanup.js
// 云上：  sudo docker compose exec memory node scripts/entity-cleanup.js
//        （memory_service/ 整个目录进镜像，脚本无需另外同步）
// ═══════════════════════════════════════════════════════════════

const path = require('path');

// 独立脚本：容器里 env 由 compose 的 env_file 给，容器外要自己载。
// dotenv 不覆盖已有变量，.env 缺失也只是返回错误对象、不抛。
if (!process.env.SANCTUARY_ENCRYPTION_KEY) {
    try {
        require(path.join(__dirname, '..', 'node_modules', 'dotenv'))
            .config({ path: path.join(__dirname, '..', '.env') });
    } catch (_) { /* 容器里没装 dotenv 也无所谓 */ }
}

const { initDatabase } = require(path.join(__dirname, '..', 'database'));
const { GENERIC_ENTITY_NAMES, entityKeys, matchesIndependently } =
    require(path.join(__dirname, '..', 'services', 'entityGuard'));

const SCHOOL_NAME = '大连理工大学';
const SCHOOL_ALIASES = ['大连理工']; // 不收「大工」——两字词容易误命中「大工程」
const CITY_NAME = '大连';
const SPLIT_CLASSIFIER = 'entity_split';
const SPLIT_CONFIDENCE = 0.6;

function header(s) {
    console.log('');
    console.log('─'.repeat(64));
    console.log(s);
    console.log('─'.repeat(64));
}

// ═══════════════════════════════════════════════════════════════
// 任务 C：停用通用词 / 度量衡实体
// ═══════════════════════════════════════════════════════════════

function cleanupGenericEntities(db, APPLY) {
    header('任务 C — 停用通用词 / 度量衡实体');

    const all = db.prepare(`
        SELECT id, name, category, status, fragment_count
        FROM entity_profiles
        WHERE status IN ('active', 'seed')
    `).all();

    const targets = all.filter(e => GENERIC_ENTITY_NAMES.has(String(e.name || '').toLowerCase().trim()));

    if (targets.length === 0) {
        console.log('没有命中的通用词实体 — 干净。');
        return { retired: 0, unlinked: 0 };
    }

    let unlinked = 0;
    for (const e of targets) {
        const links = db.prepare('SELECT COUNT(*) AS c FROM fragment_entities WHERE entity_id = ?').get(e.id).c;
        console.log(`  #${e.id} ${e.name}  [${e.category}/${e.status}]  解绑 ${links} 条碎片 → superseded`);
        unlinked += links;
    }

    if (APPLY) {
        const run = db.transaction(() => {
            const delLinks = db.prepare('DELETE FROM fragment_entities WHERE entity_id = ?');
            const retire = db.prepare(`UPDATE entity_profiles
                SET status = 'superseded', overview = NULL, fragment_count = 0,
                    updated_at = datetime('now')
                WHERE id = ?`);
            for (const e of targets) { delLinks.run(e.id); retire.run(e.id); }
        });
        run();
        console.log(`\n已写入：停用 ${targets.length} 个实体，解绑 ${unlinked} 条关联。`);
    }

    return { retired: targets.length, unlinked };
}

// ═══════════════════════════════════════════════════════════════
// 任务 D：把学校从城市里拆出来
//
// 判据与运行时的 entityGuard 完全一致：先把学校名遮蔽掉，看「大连」
// 是否还独立出现。只提到学校的碎片从城市解绑；两处都提的两边都留。
// 从城市解绑的一律改挂学校 —— 城市名下有一批是 LLM 按语义挂的，正文里
// 没有校名也没有城名，只靠字面扫描接收会把它们解绑成孤儿碎片。
// ═══════════════════════════════════════════════════════════════

function splitDalian(db, APPLY) {
    header('任务 D — 拆分「大连」→ 城市 / 大连理工大学');

    const city = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE name = ?').get(CITY_NAME);
    if (!city) {
        console.log(`库里没有「${CITY_NAME}」实体，跳过。`);
        return { moved: 0, unlinked: 0, created: false };
    }

    const schoolKeys = entityKeys({ name: SCHOOL_NAME, aliases: JSON.stringify(SCHOOL_ALIASES) });

    // ① 全库扫学校碎片（不只是当前挂在城市名下的那些）
    const likeClauses = schoolKeys.map(() => 'mf.content LIKE ?').join(' OR ');
    const schoolFrags = db.prepare(`
        SELECT mf.id, mf.content FROM memory_fragments mf
        WHERE mf.status = 'active' AND (${likeClauses})
        ORDER BY mf.id
    `).all(...schoolKeys.map(k => `%${k}%`));

    let school = db.prepare('SELECT id, name, aliases FROM entity_profiles WHERE name = ?').get(SCHOOL_NAME);
    if (!school && schoolFrags.length === 0) {
        console.log(`库里没有提到「${SCHOOL_NAME}」的碎片，不建空实体，跳过。`);
        return { moved: 0, unlinked: 0, created: false };
    }

    const needCreate = !school;
    if (needCreate) {
        console.log(`将新建实体「${SCHOOL_NAME}」(place, aliases=${JSON.stringify(SCHOOL_ALIASES)})`);
        if (APPLY) {
            const r = db.prepare(`INSERT INTO entity_profiles (name, category, status, aliases, fragment_count)
                VALUES (?, 'place', 'active', ?, 0)`).run(SCHOOL_NAME, JSON.stringify(SCHOOL_ALIASES));
            school = { id: r.lastInsertRowid, name: SCHOOL_NAME, aliases: JSON.stringify(SCHOOL_ALIASES) };
        } else {
            school = { id: null, name: SCHOOL_NAME, aliases: JSON.stringify(SCHOOL_ALIASES) };
        }
    } else {
        console.log(`「${SCHOOL_NAME}」已存在 (#${school.id})，只做重新归属。`);
    }

    const alreadyLinked = school.id
        ? new Set(db.prepare('SELECT fragment_id FROM fragment_entities WHERE entity_id = ?')
            .all(school.id).map(r => r.fragment_id))
        : new Set();

    // ② 城市名下：学校名遮蔽后「大连」不再独立出现的 → 解绑
    const cityLinks = db.prepare(`
        SELECT mf.id, mf.content FROM fragment_entities fe
        JOIN memory_fragments mf ON mf.id = fe.fragment_id
        WHERE fe.entity_id = ? ORDER BY mf.id
    `).all(city.id);

    const toUnlink = cityLinks.filter(f => !matchesIndependently(f.content, city, schoolKeys));

    // 解绑的一律改挂学校，不能只解绑不接收。城市名下有一批是 LLM 按语义挂的
    // （生产实测 draco_flash / draco_rematch），正文里连「大连」都没有，
    // 字面扫描永远捞不到；只跑 ① 的话它们解绑后不属于任何星座。
    const literalIds = new Set(schoolFrags.map(f => f.id));
    const byId = new Map();
    for (const f of [...schoolFrags, ...toUnlink]) {
        if (!alreadyLinked.has(f.id)) byId.set(f.id, f);
    }
    const toLink = [...byId.values()].sort((a, b) => a.id - b.id);
    const rehomed = toLink.filter(f => !literalIds.has(f.id));

    console.log(`\n① 该挂学校的碎片：字面提到学校 ${schoolFrags.length} 条`
        + `${rehomed.length ? ` + 从城市改挂 ${rehomed.length} 条（语义挂载、正文无校名）` : ''}`
        + `，需新建关联 ${toLink.length} 条：`);
    for (const f of toLink) {
        console.log(`   + #${f.id}${literalIds.has(f.id) ? '  ' : ' ↻'}  ${String(f.content).slice(0, 58)}`);
    }

    console.log(`\n② 城市名下 ${cityLinks.length} 条，其中 ${toUnlink.length} 条只在说学校 → 从「${CITY_NAME}」解绑：`);
    for (const f of toUnlink) {
        console.log(`   - #${f.id}  ${String(f.content).slice(0, 58)}`);
    }
    console.log(`   （其余 ${cityLinks.length - toUnlink.length} 条「${CITY_NAME}」独立出现，保留）`);

    if (APPLY) {
        const run = db.transaction(() => {
            const ins = db.prepare(`INSERT OR IGNORE INTO fragment_entities
                (fragment_id, entity_id, relation, confidence, classified_by)
                VALUES (?, ?, NULL, ?, ?)`);
            for (const f of toLink) ins.run(f.id, school.id, SPLIT_CONFIDENCE, SPLIT_CLASSIFIER);

            const del = db.prepare('DELETE FROM fragment_entities WHERE entity_id = ? AND fragment_id = ?');
            for (const f of toUnlink) del.run(city.id, f.id);

            // overview 置空 → Archivist 的 regenerateEntityOverviews 会按
            // never_described 重写两边概述（旧的那份把返校/空气/食堂/比赛揉在一起）
            const refresh = db.prepare(`UPDATE entity_profiles
                SET overview = NULL, overview_updated_at = NULL, last_eval_frag_count = 0,
                    fragment_count = (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = ?),
                    updated_at = datetime('now')
                WHERE id = ?`);
            refresh.run(city.id, city.id);
            refresh.run(school.id, school.id);
        });
        run();
        const cityCount = db.prepare('SELECT fragment_count AS c FROM entity_profiles WHERE id = ?').get(city.id).c;
        const schoolCount = db.prepare('SELECT fragment_count AS c FROM entity_profiles WHERE id = ?').get(school.id).c;
        console.log(`\n已写入：${CITY_NAME} ${cityCount} 条 / ${SCHOOL_NAME} ${schoolCount} 条，两边 overview 已清空待重写。`);
    }

    return { moved: toLink.length, unlinked: toUnlink.length, created: needCreate };
}

// ═══════════════════════════════════════════════════════════════

function main() {
    const argv = process.argv.slice(2);
    const APPLY = argv.includes('--apply');
    const onlyIdx = argv.indexOf('--only');
    const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').toLowerCase() : '';

    const db = initDatabase();

    console.log(`\n模式：${APPLY ? '★ APPLY —— 会写库' : 'dry-run（只看不写，加 --apply 才写）'}`);

    const c = (!ONLY || ONLY === 'c') ? cleanupGenericEntities(db, APPLY) : null;
    const d = (!ONLY || ONLY === 'd') ? splitDalian(db, APPLY) : null;

    header('汇总');
    if (c) console.log(`C  停用通用词实体 ${c.retired} 个，解绑 ${c.unlinked} 条关联`);
    if (d) console.log(`D  学校新增关联 ${d.moved} 条，城市解绑 ${d.unlinked} 条${d.created ? '，新建学校实体' : ''}`);
    if (!APPLY) console.log('\n以上都没有写库。确认无误后重跑并加 --apply。');
    console.log('');
}

if (require.main === module) main();

module.exports = { cleanupGenericEntities, splitDalian, SCHOOL_NAME, SCHOOL_ALIASES, CITY_NAME };
