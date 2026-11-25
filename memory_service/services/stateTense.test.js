const assert = require('assert');
const { labelStateTense, parseStartFromText } = require('./stateTense');

function bj(s) {
    return new Date(s);
}

// 2026-08-25 12:00 北京 = 2026-08-25T04:00:00Z
const AUG25 = bj('2026-08-25T04:00:00Z');
const AUG27_NOON_BJ = bj('2026-08-27T04:00:00Z');
const SEP01 = bj('2026-09-01T04:00:00Z');

const trip = {
    content: '8月27日去上海',
    expires_at: '2026-08-31T16:00:00Z',
};

assert.strictEqual(labelStateTense(trip, AUG25), '未发生', '出发日前不得当成进行中');
assert.strictEqual(labelStateTense(trip, AUG27_NOON_BJ), '进行中');
assert.strictEqual(labelStateTense(trip, SEP01), '已结束');

assert.strictEqual(
    labelStateTense({ content: '最近有点忙', expires_at: '2026-09-01T00:00:00Z' }, AUG25),
    '安排/时态不明',
    '无开始日禁止默认进行中',
);

assert.strictEqual(
    labelStateTense({ content: '搬家中', starts_at: '2026-08-28T00:00:00+08:00', expires_at: '2026-09-10T00:00:00Z' }, AUG25),
    '未发生',
);

assert.ok(parseStartFromText('2026-08-27 出发', AUG25));
assert.strictEqual(labelStateTense({ content: '2026年8月27日出发', expires_at: '2026-08-31T00:00:00Z' }, AUG25), '未发生');

console.log('stateTense tests passed');
