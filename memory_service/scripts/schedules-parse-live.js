// 本地解析链路烟测：纠正 provider 后走真实 LLM（需库里已有 Schedule Parser 或 affect 种子）
// 不打印 Key / endpoint 全文
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { initDatabase, getDb } = require('../database');
initDatabase();

const schedules = require('../services/schedules');

async function main() {
    const db = getDb();
    const before = db.prepare(
        'SELECT id, provider, model_name, endpoint FROM api_configs WHERE name = ? LIMIT 1'
    ).get(schedules.PARSER_CONFIG_NAME);

    if (!before) {
        console.log('NO_PARSER_CONFIG — 尝试 syncParserFromAffect…');
        try {
            const saved = schedules.syncParserFromAffect();
            console.log('synced provider=', saved.provider, 'model=', saved.model_name);
        } catch (e) {
            console.error('SKIP live parse:', e.message);
            process.exit(0);
        }
    } else {
        console.log('before provider=', before.provider, 'model=', before.model_name);
        const fixed = schedules.inferProvider(before.endpoint, before.model_name, before.provider);
        if (fixed !== before.provider) {
            console.log('would_fix', before.provider, '->', fixed);
        }
    }

    const text = process.argv[2] || '9.13早八上课思政实践';
    console.log('parse text:', text);
    const result = await schedules.parseNaturalLanguage(text);
    const after = db.prepare(
        'SELECT provider, model_name FROM api_configs WHERE name = ? LIMIT 1'
    ).get(schedules.PARSER_CONFIG_NAME);
    console.log('after provider=', after && after.provider, 'model=', after && after.model_name);
    console.log(JSON.stringify({
        ok: !result.error,
        error: result.error || null,
        itemCount: (result.items || []).length,
        items: (result.items || []).map((i) => ({
            title: i.title,
            due_at: i.due_at,
            category: i.category,
            time_label: i.time_label,
        })),
        unclear: result.unclear || [],
    }, null, 2));
    process.exit(result.error ? 1 : 0);
}

main().catch((e) => {
    console.error('FATAL', e.message);
    process.exit(1);
});
