/**
 * summary 解析验收（不调 LLM / 不需加密密钥）
 * 运行：tools\nodejs\node.exe memory_service\scripts\summary.fence.test.js
 */
const assert = require('assert');
const {
    extractFencedBlock,
    normalizeDailyEventsText,
    enforceVolumeDensity,
} = require('../services/summaryParse');

function testExtractFenced() {
    const sample = `废话

\`\`\`voyage_log
[2026-09-10 对话回顾 | 第1-10轮 | 12:00-13:00]

12:01 · Clara 说要吃生煎包
\`\`\`

\`\`\`daily_events
- 12:01 [生活]: User打算吃生煎包
- 12:30 [话题]: 讨论记忆库改造
\`\`\`
`;
    const voyage = extractFencedBlock(sample, 'voyage_log');
    const daily = extractFencedBlock(sample, 'daily_events');
    assert.ok(voyage.includes('生煎包'), 'voyage 应含正文');
    assert.ok(daily.includes('[生活]'), 'daily 应含分类');
    assert.strictEqual(extractFencedBlock('no fences', 'daily_events'), '');
    console.log('[OK] extractFencedBlock');
}

function testNormalizeDaily() {
    const raw = `12:01 [生活]: 吃了生煎包
- 12:30 [话题]: 讨论改造
* 18:00 [计划]: 十点前休息
## 重要
- 18:30 [计划]: 约见面
- （无）`;
    const out = normalizeDailyEventsText(raw);
    assert.ok(out.includes('## 时序'));
    assert.ok(!out.includes('## 重要'), '应砍掉重要标题');
    assert.ok(out.includes('- 12:01 [生活]: 吃了生煎包'));
    assert.ok(out.includes('- 18:30 [计划]: 约见面'), '重要区事件应并入时序');
    assert.ok(!out.includes('（无）'));
    assert.strictEqual(normalizeDailyEventsText(''), '');
    console.log('[OK] normalizeDailyEventsText');
}

function testEnforceVolume() {
    // end=21:48 → 近窗 >19:48；21:00/21:20/21:40 各为一近卷，每卷最多1
    const end = '2026-09-14T21:48:00+08:00';
    const raw = `## 时序
- 21:00 [话题]: A第一
- 21:05 [话题]: A第二同卷应砍
- 21:20 [话题]: B
- 21:40 [话题]: C
- 09:00 [生活]: 早课
- 09:30 [生活]: 同远卷应砍
- 20:20-20:40 [话题]: 区间行`;
    const out = enforceVolumeDensity(raw, end, { logicalDate: '2026-09-14' });
    assert.ok(!out.includes('## 重要'));
    const lines = out.split('\n').filter((l) => /^- /.test(l));
    assert.strictEqual(lines.filter((l) => /^- 21:0/.test(l)).length, 1);
    assert.ok(out.includes('A第一'));
    assert.ok(!out.includes('A第二同卷应砍'));
    assert.ok(out.includes('- 21:20'));
    assert.ok(out.includes('- 21:40'));
    assert.ok(out.includes('早课'));
    assert.ok(!out.includes('同远卷应砍'));
    assert.ok(out.includes('20:20-20:40'));
    console.log('[OK] enforceVolumeDensity');
}

testExtractFenced();
testNormalizeDaily();
testEnforceVolume();
console.log('summary.fence.test.js 全部通过');
