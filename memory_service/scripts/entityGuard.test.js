// entityGuard 单测 — 纯逻辑，不碰 DB
// 跑法：node memory_service\scripts\entityGuard.test.js
const path = require('path');
const g = require(path.join(__dirname, '..', 'services', 'entityGuard'));

let pass = 0, fail = 0;
function t(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`); }
}

const ent = (id, name, aliases = [], category = 'place') =>
    ({ id, name, aliases: JSON.stringify(aliases), category });

console.log('\n── 黑名单准入 ──');
t('美元 是通用词', g.isGenericEntityName('美元'), true);
t('小时 是通用词', g.isGenericEntityName('小时'), true);
t('系统 是通用词', g.isGenericEntityName('系统'), true);
t('模型 是通用词', g.isGenericEntityName('模型'), true);
t('大连 不是通用词', g.isGenericEntityName('大连'), false);
t('个人理财 不是通用词（组合词不误伤）', g.isGenericEntityName('个人理财'), false);
t('单字一律拒', g.isGenericEntityName('钱'), true);
t('空值一律拒', g.isGenericEntityName(null), true);

console.log('\n── 字面自动挂载准入 ──');
t('term 类别不参与', g.isAutoLinkable(ent(1, 'tidalecho', [], 'term')), false);
t('project 类别参与', g.isAutoLinkable(ent(1, 'tidalecho', [], 'project')), true);
t('通用词即使是 place 也拒', g.isAutoLinkable(ent(1, '系统', [], 'place')), false);
t('music_aggregate 拒', g.isAutoLinkable(ent(1, '听歌流水', [], 'music_aggregate')), false);

console.log('\n── 最长匹配优先（大连 vs 大连理工大学）──');
const city = ent(4, '大连');
const school = ent(99, '大连理工大学', ['大连理工']);
const both = [city, school];
const names = (arr) => arr.map(e => e.name);

t('只提学校 → 只认学校',
  names(g.resolveLiteralMatches('User透露自己学的是大连理工大学生物工程专业', both)),
  ['大连理工大学']);

t('用别名提学校 → 只认学校',
  names(g.resolveLiteralMatches('数学竞赛总决赛在大连理工举办', both)),
  ['大连理工大学']);

t('只提城市 → 只认城市',
  names(g.resolveLiteralMatches('User8月28日清晨到达大连，与同学拼车回校', both)),
  ['大连']);

t('两处都提 → 两个都认',
  names(g.resolveLiteralMatches('从大连理工出发回大连市区', both).sort((a,b)=>a.id-b.id)),
  ['大连', '大连理工大学']);

t('都没提 → 空',
  names(g.resolveLiteralMatches('今天食堂的疙瘩汤不错', both)), []);

t('通用词实体永不命中',
  names(g.resolveLiteralMatches('我改了系统提示词，模型花了三美元跑了两小时',
      [ent(29,'系统',[], 'term'), ent(13,'模型',[], 'term'), ent(23,'美元',[], 'term'), ent(8,'小时',[], 'term')])),
  []);

console.log('\n── matchesIndependently（SQL LIKE 路径的复核）──');
t('学校名遮蔽后城市不再独立出现',
  g.matchesIndependently('User透露自己学的是大连理工大学生物工程专业', city, ['大连理工大学', '大连理工']),
  false);
t('城市独立出现 → 保留',
  g.matchesIndependently('User8月28日清晨到达大连', city, ['大连理工大学', '大连理工']),
  true);
t('两处都提 → 保留',
  g.matchesIndependently('从大连理工出发回大连市区', city, ['大连理工大学', '大连理工']),
  true);
t('别名先命中也能正确遮蔽',
  g.matchesIndependently('决赛地点在大连理工', city, ['大连理工大学', '大连理工']),
  false);

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
