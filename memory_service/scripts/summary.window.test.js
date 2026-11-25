/**
 * 近/远窗 + 分卷重算 / merge B 验收
 * 运行：tools\nodejs\node.exe memory_service\scripts\summary.window.test.js
 */
const assert = require('assert');
const {
    isNear,
    windowTag,
    extractLineHm,
    hmOnLogicalDateToISO,
    floorNearBucket,
    volumeKeyFromHm,
    volumeKeyFromTs,
    volumeRangeLabel,
    tagExistingDailyLines,
    formatConversationWithVolumeTags,
    stripWindowTags,
    buildVolumeBundles,
    mergeDailyByVolume,
} = require('../services/summaryWindow');
const { normalizeDailyEventsText } = require('../services/summaryParse');

function testNearFar() {
    const end = '2026-09-11T16:48:00+08:00';
    assert.strictEqual(isNear('2026-09-11T15:00:00+08:00', end), true);
    assert.strictEqual(isNear('2026-09-11T14:48:01+08:00', end), true);
    assert.strictEqual(isNear('2026-09-11T14:48:00+08:00', end), false);
    assert.strictEqual(windowTag('2026-09-11T16:00:00+08:00', end), '近');
    assert.strictEqual(windowTag('2026-09-11T07:02:00+08:00', end), '远');
    console.log('[OK] near/far boundary');
}

function testVolumeKeys() {
    assert.strictEqual(floorNearBucket('21:05'), '21:00');
    assert.strictEqual(floorNearBucket('21:20'), '21:20');
    assert.strictEqual(floorNearBucket('21:39'), '21:20');
    assert.strictEqual(floorNearBucket('21:40'), '21:40');
    assert.strictEqual(volumeKeyFromHm('09:37', false), '远|09');
    assert.strictEqual(volumeKeyFromHm('21:05', true), '近|21:00');
    assert.strictEqual(volumeRangeLabel('远|08'), '08:00-09:00');
    assert.strictEqual(volumeRangeLabel('近|20:20'), '20:20-20:40');
    const end = '2026-09-14T21:48:00+08:00';
    assert.strictEqual(volumeKeyFromTs('2026-09-14T13:10:00+08:00', end), '远|13');
    assert.strictEqual(volumeKeyFromTs('2026-09-14T21:05:00+08:00', end), '近|21:00');
    console.log('[OK] volume keys');
}

function testTagExisting() {
    const end = '2026-09-11T16:48:00+08:00';
    const existing = `## 时序
- 07:02 [生活]: 被吵醒
- 16:36 [话题]: 陆离回复
## 重要
- （无）`;
    const tagged = tagExistingDailyLines(existing, end, { logicalDate: '2026-09-11' });
    assert.ok(/\[远\|07\]/.test(tagged));
    assert.ok(/\[近\|16:20\]/.test(tagged));
    assert.ok(tagged.includes('## 时序'));
    console.log('[OK] tagExistingDailyLines volumes');
}

function testFormatConversation() {
    const end = '2026-09-14T21:48:00+08:00';
    const text = formatConversationWithVolumeTags([
        { timestamp: '2026-09-14T09:10:00+08:00', line: '[09:10] User: 早' },
        { timestamp: '2026-09-14T21:05:00+08:00', line: '[21:05] User: 近' },
    ], end);
    assert.ok(text.includes('[远|09] [09:10]'));
    assert.ok(text.includes('[近|21:00] [21:05]'));
    console.log('[OK] formatConversationWithVolumeTags');
}

function testNormalizeSections() {
    const body = `## 时序
[近|21:00] - 21:00 [生活]: 发了微信
- 07:02 [生活]: 起床
## 重要
- 16:36 [计划]: 约下周见面`;
    const out = normalizeDailyEventsText(body);
    assert.ok(out.startsWith('## 时序'));
    assert.ok(!out.includes('## 重要'));
    assert.ok(!out.includes('[近|'));
    assert.ok(out.includes('- 21:00 [生活]: 发了微信'));
    assert.ok(out.includes('- 16:36 [计划]: 约下周见面'));
    console.log('[OK] normalizeDailyEventsText sections');
}

function testHmHelpers() {
    assert.strictEqual(extractLineHm('- 07:02 [生活]: x'), '07:02');
    assert.strictEqual(extractLineHm('- 08:00-09:00 [生活]: x'), '08:00');
    const iso = hmOnLogicalDateToISO('2026-09-11', '01:03');
    assert.ok(iso.startsWith('2026-09-12T01:03'));
    assert.strictEqual(stripWindowTags('[近|21:00] - 21:00 [生活]: a'), '- 21:00 [生活]: a');
    console.log('[OK] hm helpers');
}

function testBuildBundlesAndMerge() {
    const end = '2026-09-14T21:48:00+08:00';
    const existing = `## 时序
- 08:00-09:00 [生活]: 早课
- 21:20-21:40 [话题]: 旧近`;
    const { dirty, all } = buildVolumeBundles({
        dialogEntries: [
            { timestamp: '2026-09-14T21:25:00+08:00', line: '[21:25] User: 新近' },
        ],
        existingText: existing,
        endTs: end,
        logicalDate: '2026-09-14',
    });
    assert.ok(all.some((b) => b.key === '远|08'));
    assert.ok(dirty.some((b) => b.key === '近|21:20'));
    // 早课远卷无新对话且仅 1 条 → 非 dirty
    assert.ok(!dirty.some((b) => b.key === '远|08'));

    const merged = mergeDailyByVolume(
        existing,
        `- 21:20-21:40 [话题]: 新近进展`,
        end,
        '2026-09-14',
    );
    assert.ok(merged.includes('08:00-09:00'), 'merge B 应保留未触碰远卷');
    assert.ok(merged.includes('新近进展'));
    assert.ok(!merged.includes('旧近'), '同近窗应被新输出覆盖');
    console.log('[OK] buildVolumeBundles + merge B');
}

function testNearToFarFold() {
    const end = '2026-09-14T23:00:00+08:00';
    // 原先三条近卷，现在都已远 → 并入 远|20，existing>1 → dirty
    const existing = `## 时序
- 20:00-20:20 [话题]: A
- 20:20-20:40 [话题]: B
- 20:40-21:00 [话题]: C`;
    const { dirty } = buildVolumeBundles({
        dialogEntries: [],
        existingText: existing,
        endTs: end,
        logicalDate: '2026-09-14',
    });
    const far20 = dirty.find((b) => b.key === '远|20');
    assert.ok(far20, '近→远折叠后应进 dirty');
    assert.ok(far20.existing.length >= 3);
    console.log('[OK] near→far fold dirty');
}

testNearFar();
testVolumeKeys();
testTagExisting();
testFormatConversation();
testNormalizeSections();
testHmHelpers();
testBuildBundlesAndMerge();
testNearToFarFold();
console.log('summary.window.test.js 全部通过');
