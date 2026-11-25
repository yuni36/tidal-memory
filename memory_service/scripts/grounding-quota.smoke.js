# groundingQuota — 本地月额度单测（无 DB 依赖的纯函数部分 + mock settings）

const assert = require('assert');

process.env.GROUNDING_MONTHLY_LIMIT = '3000';

// 轻量：只测 shanghaiMonth 格式
const { shanghaiMonth, LIMIT } = require('../services/groundingQuota');

assert.strictEqual(LIMIT, 3000);
const m = shanghaiMonth(new Date('2026-09-12T10:00:00+08:00'));
assert.strictEqual(m, '2026-09');
console.log('groundingQuota.month ok', m);
