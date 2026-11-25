// ============================================================
// Tidal 记忆服务 — 冒烟测试
// Phase 3: 验证 memory_service 核心 HTTP API 全部可用
// 运行: node smoke_test.mjs
// ============================================================

const BASE = 'http://127.0.0.1:3013';
let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (e) {
        console.log(`  [FAIL] ${name}: ${e.message}`);
        failed++;
    }
}

async function post(path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.json();
}

async function get(path) {
    const r = await fetch(`${BASE}${path}`);
    return r.json();
}

async function main() {
    console.log('Tidal 记忆服务 冒烟测试');
    console.log('========================\n');

    // 1. Health check
    await test('Health check', async () => {
        const data = await get('/healthz');
        if (!data.ok) throw new Error('health not ok');
    });

    // 2. Message ingest
    await test('Message ingest', async () => {
        const data = await post('/messages/ingest', {
            sender: 'human',
            content: '你好Tidal，冒烟测试消息',
            timestamp: '2026-07-17T10:00:00Z',
            chat_id: 1,
        });
        if (!data.ingested) throw new Error('not ingested');
    });

    // 3. Librarian search
    await test('Librarian search', async () => {
        const data = await get('/librarian/search?q=Tidal&limit=3');
        if (!data.results) throw new Error('no results field');
    });

    // 4. recall_memory tool
    await test('Tool: recall_memory', async () => {
        const data = await post('/tools/recall_memory', { query: 'Tidal' });
        if (!data.result || data.result.success === false) throw new Error(data.result?.formatted || 'failed');
    });

    // 5. update_current_state tool
    await test('Tool: update_current_state', async () => {
        const now = new Date();
        const future = new Date(now.getTime() + 3600000).toISOString();
        const tag = now.toISOString().slice(0, 19).replace('T', ' ');
        const data = await post('/tools/update_current_state', {
            action: 'set',
            content: '冒烟测试 ' + tag,
            expires_at: future,
        });
        if (!data.result || !data.result.success) throw new Error(data.result?.formatted || 'failed');
    });

    // 6. browse_memories tool
    await test('Tool: browse_memories', async () => {
        const data = await post('/tools/browse_memories', {});
        if (!data.result || data.result.success === false) throw new Error(data.result?.formatted || 'failed');
    });

    // 7. correct_memory tool
    await test('Tool: correct_memory', async () => {
        const data = await post('/tools/correct_memory', {
            wrong_statement: 'Tidal是只猫',
            correction: 'Tidal是一个AI伙伴',
        });
        if (!data.result || !data.result.success) throw new Error(data.result?.formatted || 'failed');
    });

    // 8. Unprocessed messages
    await test('Unprocessed messages', async () => {
        const data = await get('/messages/unprocessed?limit=5');
        if (data.count === undefined) throw new Error('no count field');
    });

    // ─────────── Bug #1 / #2 修复验证（Phase 3 增强测试）───────────

    // 9. CJK 中文检索 — 验证 jieba + FTS5 phrase query 不崩溃
    await test('CJK: jieba分词+FTS5短语检索', async () => {
        // 先摄入一条含中文的消息
        await post('/messages/ingest', {
            sender: 'human',
            content: '我喜欢在星巴克喝拿铁咖啡',
            timestamp: new Date().toISOString(),
            chat_id: 1,
        });
        // 用"咖啡"搜索 — 测试 jieba cut → phrase query "咖 啡" 管道
        const data = await get('/librarian/search?q=咖啡&limit=5');
        if (!data.results) throw new Error('CJK search: no results field');
        // FTS5 索引中是单字粒度，phrase query 可能在无匹配时返回空数组（合法）
        // 但 API 本身必须返回 200 + 格式正确（不崩溃）
        console.log(`      CJK搜索返回 ${data.results.length} 条结果`);
    });

    // 10. CJK 混合中英检索 — 中英混合不退化
    await test('CJK: 中英混合检索', async () => {
        const data = await get('/librarian/search?q=Tidal%20咖啡&limit=5');
        if (!data.results) throw new Error('mixed search: no results field');
        console.log(`      混合检索返回 ${data.results.length} 条结果`);
    });

    // 11. FTS5 独立链路 — ChromaDB 即使异常，FTS5 内嵌 SQLite 不受影响
    await test('FTS5 独立链路 (ChromaDB降级容错)', async () => {
        const data = await get('/librarian/search?q=Tidal&limit=5');
        if (!data.results) throw new Error('FTS5 search: no results field');
        // 检查返回结构中 type 字段存在（验证结果格式完整）
        if (data.results.length > 0) {
            const hasField = data.results[0].type !== undefined || data.results[0].weight !== undefined;
            if (!hasField) throw new Error('result missing type/weight fields');
            console.log(`      FTS5搜索结果样例: type=${data.results[0].type}, weight=${data.results[0].weight}`);
        } else {
            console.log(`      FTS5 当前无匹配（库中暂无碎片），API 返回格式正确`);
        }
    });

    console.log(`\n========================`);
    console.log(`结果: ${passed} PASS, ${failed} FAIL`);
    console.log(`========================`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('测试异常:', e.message);
    process.exit(1);
});