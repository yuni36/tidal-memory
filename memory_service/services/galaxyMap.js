// galaxyMap — 星图五星系与 browse_memories / universe 共用映射
// 不碰 memory_ontology 表；旧分区名仅作别名。

const { USER } = require('./memoryConfig');

function ownGalaxyId() {
    return '创作';
}

function galaxyLabels() {
    const own = ownGalaxyId();
    return {
        person: '社交',
        pet: '社交',
        organization: '社交',
        place: '地点',
        event: '事件',
        project: own,
        work: own,
        term: own,
        hobby: '爱好',
        consumed: '爱好',
        // 历史残留类别（旧流水线曾写 book/music/movie，不进 aggregate）
        book: '爱好',
        music: '爱好',
        movie: '爱好',
        music_aggregate: '爱好',
        book_aggregate: '爱好',
        movie_aggregate: '爱好',
    };
}

function galaxyOrder() {
    return ['爱好', '社交', ownGalaxyId(), '事件', '地点'];
}

function galaxyLabelForCategory(category) {
    const labels = galaxyLabels();
    return labels[category] || null;
}

function categoriesForGalaxy(galaxyId) {
    const labels = galaxyLabels();
    return Object.keys(labels).filter((cat) => labels[cat] === galaxyId);
}

function pathAliases() {
    const own = ownGalaxyId();
    return {
        人际关系: '社交',
        社交: '社交',
        爱好: '爱好',
        音乐: '爱好',
        事件: '事件',
        地点: '地点',
        创作: own,
        工作: own,
        项目: own,
        你的: own,
        [`${USER.name}的`]: own,
        [own]: own,
    };
}

/** 把工具 path（含旧分区如「人际关系/关于我们」）解析为五星系之一；无法识别则 null */
function resolveGalaxyPath(path) {
    if (!path) return null;
    const raw = String(path).trim().replace(/^\/+|\/+$/g, '');
    if (!raw) return null;
    const first = raw.split('/')[0];
    const order = galaxyOrder();
    if (order.includes(raw)) return raw;
    if (order.includes(first)) return first;
    const aliases = pathAliases();
    const mapped = aliases[raw] || aliases[first];
    if (mapped && order.includes(mapped)) return mapped;
    return null;
}

function galaxyEntities(db, galaxyId) {
    const cats = categoriesForGalaxy(galaxyId);
    if (!cats.length) return [];
    const placeholders = cats.map(() => '?').join(',');
    return db.prepare(`
        SELECT ep.id, ep.name, ep.category, ep.overview, ep.fragment_count,
               (SELECT COUNT(*) FROM fragment_entities fe WHERE fe.entity_id = ep.id) AS link_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND ep.category IN (${placeholders})
        ORDER BY link_count DESC, ep.fragment_count DESC, ep.name
    `).all(...cats).filter((e) => (e.link_count || 0) > 0);
}

function galaxyFragmentIds(db, galaxyId) {
    const cats = categoriesForGalaxy(galaxyId);
    if (!cats.length) return [];
    const placeholders = cats.map(() => '?').join(',');
    return db.prepare(`
        SELECT DISTINCT fe.fragment_id AS id
        FROM fragment_entities fe
        JOIN entity_profiles ep ON ep.id = fe.entity_id
        JOIN memory_fragments mf ON mf.id = fe.fragment_id
        WHERE ep.status = 'active'
          AND mf.status = 'active'
          AND ep.category IN (${placeholders})
    `).all(...cats).map((r) => r.id);
}

function galaxyRecentFragments(db, galaxyId, limit) {
    const cats = categoriesForGalaxy(galaxyId);
    if (!cats.length) return [];
    const placeholders = cats.map(() => '?').join(',');
    return db.prepare(`
        SELECT mf.id, mf.content, mf.source_date, mf.insight
        FROM memory_fragments mf
        JOIN fragment_entities fe ON fe.fragment_id = mf.id
        JOIN entity_profiles ep ON ep.id = fe.entity_id
        WHERE ep.status = 'active'
          AND mf.status = 'active'
          AND ep.category IN (${placeholders})
        GROUP BY mf.id
        ORDER BY mf.source_date DESC
        LIMIT ?
    `).all(...cats, limit);
}

function hallStats(db) {
    const labels = galaxyLabels();
    const stats = {};
    for (const id of galaxyOrder()) {
        stats[id] = { entities: 0, fragments: 0 };
    }
    const rows = db.prepare(`
        SELECT ep.category,
               COUNT(*) AS entity_count,
               COALESCE(SUM(
                   (SELECT COUNT(*) FROM fragment_entities fe WHERE fe.entity_id = ep.id)
               ), 0) AS fragment_count
        FROM entity_profiles ep
        WHERE ep.status = 'active'
          AND (SELECT COUNT(*) FROM fragment_entities fe2 WHERE fe2.entity_id = ep.id) > 0
        GROUP BY ep.category
    `).all();
    for (const row of rows) {
        const galaxy = labels[row.category];
        if (!galaxy || !stats[galaxy]) continue;
        stats[galaxy].entities += row.entity_count || 0;
        stats[galaxy].fragments += row.fragment_count || 0;
    }
    return stats;
}

function formatHall(db) {
    const stats = hallStats(db);
    let output = '【记忆宫殿 · 大厅】\n\n与星图相同的五个星系：\n\n';
    for (const id of galaxyOrder()) {
        const s = stats[id] || { entities: 0, fragments: 0 };
        output += `📂 ${id}（${s.entities} 个星座 / ${s.fragments} 条碎片）\n`;
    }
    output += '\n用 browse_memories path="社交" 进入某个星系；或 path="人名" 查看具体星座。';
    return output;
}

module.exports = {
    ownGalaxyId,
    galaxyLabels,
    galaxyOrder,
    galaxyLabelForCategory,
    categoriesForGalaxy,
    resolveGalaxyPath,
    galaxyEntities,
    galaxyFragmentIds,
    galaxyRecentFragments,
    hallStats,
    formatHall,
};
