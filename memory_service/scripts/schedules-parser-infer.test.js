// Schedule Parser provider 推断 / 纠偏（不调外网）
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const {
    inferProvider,
    normalizeParserEndpoint,
} = require('../services/schedules');

function assert(c, m) {
    if (!c) throw new Error(m);
}

assert(inferProvider('https://api.deepseek.com', 'deepseek-chat') === 'openai_compatible', 'ds');
assert(
    inferProvider('https://api.deepseek.com', 'deepseek-flash', 'gemini') === 'openai_compatible',
    'ds host overrides wrong gemini'
);
assert(
    inferProvider('https://generativelanguage.googleapis.com/v1beta/models/', 'gemini-2.0-flash-lite') === 'gemini',
    'gemini native'
);
assert(
    inferProvider('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash') === 'openai_compatible',
    'gemini openai compat'
);
assert(
    inferProvider('https://generativelanguage.googleapis.com/v1beta/openai', 'x', 'gemini') === 'openai_compatible',
    'openai shim overrides gemini label'
);

const ep = normalizeParserEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini');
assert(ep.includes('/models/'), 'gemini models path: ' + ep);

const epDs = normalizeParserEndpoint('https://api.deepseek.com/', 'openai_compatible');
assert(epDs === 'https://api.deepseek.com', 'ds strip slash');

console.log('parser-config infer OK');
