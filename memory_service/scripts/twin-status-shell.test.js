#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { isTwinStatusShell, USER, AI } = require('../services/memoryConfig');

assert.strictEqual(isTwinStatusShell(USER.name + '在'), true);
assert.strictEqual(isTwinStatusShell(AI.name + '在'), true);
assert.strictEqual(isTwinStatusShell(USER.name + '近况'), true);
assert.strictEqual(isTwinStatusShell(USER.name), false);
assert.strictEqual(isTwinStatusShell(AI.name), false);
assert.strictEqual(isTwinStatusShell('示例同学'), false);
assert.strictEqual(isTwinStatusShell('大连理工大学'), false);
assert.strictEqual(isTwinStatusShell(USER.name + '的课'), false); // 不当状态壳
assert.strictEqual(isTwinStatusShell(''), false);
assert.strictEqual(isTwinStatusShell(null), false);
console.log('isTwinStatusShell ok', USER.name, AI.name);
