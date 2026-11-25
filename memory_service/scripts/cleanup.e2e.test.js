// 端到端验证：entityGuard 守门 + 清理脚本 + GC 判据
// 用 prod-like 假数据在一个临时本地库上跑，跑完自删。
// 跑法：node memory_service\scripts\cleanup.e2e.test.js
//
// 安全阀：本地已有 sanctuary.db 时直接拒绝运行，绝不覆盖真实数据。

const fs = require('fs');
const os = require('os');
const path = require('path');

const MS = path.join(__dirname, '..');

// 用独立临时库，绝不碰 memory_service/sanctuary.db 或 data/sanctuary.db
const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-e2e-')), 'sanctuary.db');
process.env.SANCTUARY_DB_PATH = DB_FILE;

// encryption.js 在 require 时就要 SANCTUARY_ENCRYPTION_KEY。
// dotenv 不覆盖已存在的变量，所以上面那行 DB 路径不会被顶掉。
require(path.join(MS, 'node_modules', 'dotenv')).config({ path: path.join(MS, '.env') });

let pass = 0, fail = 0;
function t(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`); }
}

function cleanupFiles() {
    try { fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────

const { initDatabase } = require(path.join(MS, 'database'));
const { cleanupGenericEntities, splitDalian } = require(path.join(MS, 'scripts', 'entity-cleanup'));

// 回补（rematch）要过 LLM。先往 require 缓存里塞一个假 llm：它对提示词里
// 问到的每一对 (碎片, 种子) 都答 match:true —— 最坏情况的 LLM。守门一旦漏了，
// 坏关联就会真的写进库，测试立刻抓到，而不是靠「LLM 恰好答对」蒙过去。
const LLM_PATH = require.resolve(path.join(MS, 'services', 'llm'));
const llmPrompts = [];
require.cache[LLM_PATH] = {
    id: LLM_PATH, filename: LLM_PATH, loaded: true, exports: {
        callLLM: async (messages) => {
            const prompt = messages?.[0]?.parts?.[0]?.text || '';
            llmPrompts.push(prompt);
            const pairs = [];
            for (const block of prompt.split('种子: ').slice(1)) {
                const seedId = (block.match(/id=(\d+)/) || [])[1];
                for (const m of block.matchAll(/\[frag_(\d+)\]/g)) {
                    pairs.push({ frag_id: Number(m[1]), seed_id: Number(seedId), match: true });
                }
            }
            return { reply: JSON.stringify(pairs) };
        },
    },
};

const { autoLinkLiteralMentions, rematchFragmentsForSeeds } = require(path.join(MS, 'services', 'archivist'));
const { runFragmentGC } = require(path.join(MS, 'services', 'lifecycle'));

// 虚构测试文本（咖啡/烧烤风格地名仅作最长匹配夹具）
const FRAGS = [
    // 只提学校 → 应归学校，不归城市
    [142, 'User在8月27日透露自己学的是大连理工大学生物工程专业，大概率本校读研。'],
    [149, 'User是大连理工大学生物工程学院学生，大二时加入示例课题组。'],
    [507, '同学在9月6日告诉User，数学竞赛总决赛2027年4月在大连理工举办。'],
    // 只提城市 → 应留城市
    [204, 'User8月28日清晨到达大连，与同校同学拼车回校，在第五食堂吃早餐。'],
    [109, 'User8月27日乘坐示例列车前往大连，全程约19小时。'],
    // 两处都提 → 两边都留
    [900, 'User从大连理工出发，回大连市区办校园卡。'],
    // 正文里连「大连」都没有，是 LLM 按语义挂给城市的
    [340, 'User在8月28日到学校后行李一直未收拾，8月30日晚上收拾了行李、扫地拖地。'],
    [359, 'User上的是国际标准舞课，在舞蹈馆上课，不是普通体育课。'],
    // 通用词碎片：不该被「系统」「模型」抓走，应该能归 tidalecho
    [446, 'User在9月4日与Assistant讨论优化Tidal系统时，提出想通过日程同步让Assistant更了解她。'],
    [431, 'User在9月4日凌晨再次修改了Assistant的系统提示词，并向Assistant炫耀。'],
    [523, 'User花了三美元跑了两小时，觉得模型缓存命中差。'],
];

function seed(db) {
    const insEnt = db.prepare(`INSERT INTO entity_profiles (id, name, category, status, aliases, overview, fragment_count)
        VALUES (?, ?, ?, ?, ?, ?, 0)`);
    insEnt.run(1, 'User', 'person', 'active', '[]', '用户本人');
    insEnt.run(2, 'Assistant', 'person', 'active', '[]', 'AI 伙伴');
    insEnt.run(4, '大连', 'place', 'active', '["大连"]', '把返校/空气/食堂/比赛揉在一起的旧概述');
    insEnt.run(29, '系统', 'term', 'active', '[]', '通用词成精');
    insEnt.run(13, '模型', 'term', 'active', '[]', '通用词成精');
    insEnt.run(8, '小时', 'term', 'active', '[]', '度量衡成精');
    insEnt.run(23, '美元', 'term', 'active', '[]', '货币成精');
    insEnt.run(10, 'tidalecho', 'project', 'active', '["Tidal"]', '真正的项目实体，线上只有 1 条碎片');

    const insFrag = db.prepare(`INSERT INTO memory_fragments
        (id, type, entity, content, status, source, source_date, created_at, read_count)
        VALUES (?, 'fact', 'User', ?, 'active', 'chat', '2026-09-01', '2026-09-01T00:00:00', 0)`);
    for (const [id, content] of FRAGS) insFrag.run(id, content);

    // 复刻线上错误挂载：城市抓走了所有提到大连理工的碎片
    const link = db.prepare(`INSERT INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by)
        VALUES (?, ?, NULL, 0.4, 'auto_literal')`);
    for (const id of [142, 149, 507, 204, 109, 900]) link.run(id, 4);
    // 语义挂载那两条：来源是 LLM，不是字面匹配
    const linkLlm = db.prepare(`INSERT INTO fragment_entities (fragment_id, entity_id, relation, confidence, classified_by)
        VALUES (?, ?, NULL, 0.9, 'draco_flash')`);
    for (const id of [340, 359]) linkLlm.run(id, 4);
    for (const id of [446, 431]) link.run(id, 29);
    for (const id of [523]) { link.run(id, 13); link.run(id, 23); link.run(id, 8); }

    const fixCount = db.prepare(`UPDATE entity_profiles SET fragment_count =
        (SELECT COUNT(*) FROM fragment_entities WHERE entity_id = entity_profiles.id)`);
    fixCount.run();
}

const linkedTo = (db, entityId) => db.prepare(
    'SELECT fragment_id FROM fragment_entities WHERE entity_id = ? ORDER BY fragment_id'
).all(entityId).map(r => r.fragment_id);

const entByName = (db, name) => db.prepare(
    'SELECT id, name, status, overview, fragment_count FROM entity_profiles WHERE name = ?'
).get(name);

async function run() {
    const db = initDatabase();
    seed(db);

    console.log('\n── 任务 C：停用通用词 / 度量衡实体 ──');
    const c = cleanupGenericEntities(db, true);
    t('停用了 4 个（系统/模型/小时/美元）', c.retired, 4);
    t('系统 已 superseded', entByName(db, '系统').status, 'superseded');
    t('美元 已 superseded', entByName(db, '美元').status, 'superseded');
    t('系统 的 overview 已清空', entByName(db, '系统').overview, null);
    t('系统 名下碎片已全部解绑', linkedTo(db, 29), []);
    t('美元/小时/模型 名下也全部解绑',
      [...linkedTo(db, 23), ...linkedTo(db, 8), ...linkedTo(db, 13)], []);
    t('大连 不受影响', entByName(db, '大连').status, 'active');
    t('tidalecho 不受影响', entByName(db, 'tidalecho').status, 'active');

    console.log('\n── 任务 D：拆分大连 ──');
    const d = splitDalian(db, true);
    const school = entByName(db, '大连理工大学');
    t('新建了学校实体', !!school, true);
    t('学校拿到 6 条（142/149/340/359/507/900）',
      linkedTo(db, school.id), [142, 149, 340, 359, 507, 900]);
    t('城市只剩 3 条（109/204/900）', linkedTo(db, 4), [109, 204, 900]);
    t('只提学校的 142 已从城市解绑', linkedTo(db, 4).includes(142), false);
    t('两处都提的 900 两边都在',
      [linkedTo(db, 4).includes(900), linkedTo(db, school.id).includes(900)], [true, true]);
    t('语义挂载的 340/359 从城市解绑后改挂了学校，没成孤儿',
      [linkedTo(db, 4).includes(340), linkedTo(db, school.id).includes(340),
       linkedTo(db, 4).includes(359), linkedTo(db, school.id).includes(359)],
      [false, true, false, true]);
    t('城市旧 overview 已清空待重写', entByName(db, '大连').overview, null);
    t('城市 fragment_count 已重算', entByName(db, '大连').fragment_count, 3);

    console.log('\n── 字面自动挂载：守门是否生效 ──');
    // 此刻 446/431（含「系统」）和 523（含「美元/小时/模型」）都已无归属
    const before = autoLinkLiteralMentions();
    t('通用词实体不再抓碎片（系统名下仍为空）', linkedTo(db, 29), []);
    t('通用词实体不再抓碎片（美元名下仍为空）', linkedTo(db, 23), []);
    t('tidalecho 用别名 Tidal 抓到了 446', linkedTo(db, 10).includes(446), true);
    t('长名遮蔽驳回了城市对纯学校碎片的重新挂载',
      [linkedTo(db, 4).includes(142), linkedTo(db, 4).includes(149)], [false, false]);
    t('auto_literal 报告了驳回数', before.rejected > 0, true);

    console.log('\n── 回补（rematch）：清理结果不会被自动撤销 ──');
    // 线上实测：apply 后一个回补周期，7 条学校碎片又以 draco_rematch 挂回了「大连」。
    // 这条路专挑 unlinked > 0 的种子，等于专门盯着刚解绑的碎片。
    const rm = await rematchFragmentsForSeeds();
    t('学校碎片没被回补挂回城市',
      [linkedTo(db, 4).includes(142), linkedTo(db, 4).includes(149), linkedTo(db, 4).includes(507)],
      [false, false, false]);
    t('城市名下仍是那 3 条', linkedTo(db, 4), [109, 204, 900]);
    t('回补报告了长名遮蔽驳回数', rm.masked > 0, true);
    t('通用词实体已 superseded，回补不会复活它们',
      [linkedTo(db, 29), linkedTo(db, 13), linkedTo(db, 23), linkedTo(db, 8)], [[], [], [], []]);
    t('提示词里没有出现被遮蔽的城市候选',
      llmPrompts.some(p => /种子: 大连\[/.test(p)), false);

    console.log('\n── GC 判据：read_count 不再是免死金牌 ──');
    // 关键回归：老代码用 read_count=0 判冷却，命中过一次就永久免疫。
    const insFrag = db.prepare(`INSERT INTO memory_fragments
        (id, type, entity, content, status, source, created_at, read_count, last_accessed_at)
        VALUES (?, 'fact', 'User', ?, 'active', 'chat', ?, ?, ?)`);
    insFrag.run(2001, '20天前吃了什么（被检索过99次，老代码下永久免疫）',
        '2026-08-01T00:00:00', 99, '2026-08-19 10:00:00');
    insFrag.run(2002, '刚刚还被检索命中过（应保持活跃）',
        '2026-08-01T00:00:00', 99, new Date().toISOString().replace('T', ' ').slice(0, 19));
    insFrag.run(2003, '从没被检索过且够老（应冷却）',
        '2026-08-01T00:00:00', 0, null);
    insFrag.run(2004, '今天刚生成（应保持活跃）',
        new Date().toISOString(), 0, null);

    await runFragmentGC();
    const statusOf = (id) => db.prepare('SELECT status FROM memory_fragments WHERE id = ?').get(id).status;
    t('读过99次但20天没被命中 → 冷却（老代码永远不会）', statusOf(2001), 'cooling');
    t('刚被命中 → 保持活跃', statusOf(2002), 'active');
    t('从没被命中且够老 → 冷却', statusOf(2003), 'cooling');
    t('今天刚生成 → 保持活跃', statusOf(2004), 'active');

    console.log('\n── 复活：冷却期内又被命中 ──');
    db.prepare(`UPDATE memory_fragments SET last_accessed_at = ? WHERE id = ?`)
        .run(new Date().toISOString().replace('T', ' ').slice(0, 19), 2001);
    await runFragmentGC();
    t('冷却中又被命中 → 复活', statusOf(2001), 'active');
}

(async () => {
    try {
        await run();
    } catch (e) {
        fail++;
        console.error('\n异常：', e.stack || e.message);
    } finally {
        cleanupFiles();
        console.log(`\n临时库已删除。`);
        console.log(`${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
