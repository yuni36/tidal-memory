// services/entityGuard.js — 实体准入与字面匹配守门
// ═══════════════════════════════════════════════════════════════
// 解决两类线上实测问题（2026-09-08 生产库诊断）：
//
// 1. 通用词成精：「系统」29 条、「模型」27 条、「小时」16 条、「美元」9 条碎片，
//    其中 auto_literal 占大头。这些词不是实体是属性，却因为字面命中率极高，
//    把本该归给 tidalecho / 记忆星球 的碎片全截胡了（后者只有 1-2 条）。
//
// 2. 短名吞并长名：「大连理工大学」包含「大连」，字面匹配让 29 条学校碎片
//    （宿舍/食堂/课题组/校园卡）全挂到城市实体上，overview 因此把返校、
//    空气、食堂、比赛揉成一锅。
//
// 对应两个出口：isGenericEntityName / isAutoLinkable 管准入，
// resolveLiteralMatches 管「最长匹配优先」。
// ═══════════════════════════════════════════════════════════════

// ── 通用词黑名单：这些词是碎片的属性，不该成为实体 ──
// 判定是精确匹配（整个实体名等于表内词），不做子串，避免误伤
// 「个人理财」这类由通用词组成但确有所指的名字。
const GENERIC_ENTITY_NAMES = new Set([
    // 度量衡 / 时间单位
    '小时', '分钟', '秒钟', '毫秒', '天数', '星期', '周末', '月份', '年份', '季度',
    '公斤', '千克', '公克', '厘米', '毫米', '公里', '千米', '英里', '英寸',
    '平方', '立方', '毫升', '摄氏', '华氏', '百分', '千瓦', '兆瓦',
    '字节', '兆字节', '吉字节',
    // 货币
    '美元', '欧元', '日元', '英镑', '港币', '人民币', 'block', '块钱', '毛钱',
    // 通用技术词 —— 会截胡真正的项目实体
    '系统', '模型', '代码', '程序', '数据', '数据库', '功能', '版本', '接口',
    '参数', '变量', '文件', '目录', '日志', '缓存', '内存', '显存', '服务',
    '服务器', '项目', '框架', '算法', '脚本', '命令', '终端', '浏览器',
    '前端', '后端', '插件', '模块', '组件', '页面', '按钮', '窗口', '网页',
    '数组', '对象', '字符串', '函数', '方法名', '报错', '需求', '方案',
    // 通用泛称
    '问题', '事情', '东西', '时间', '地方', '方式', '方法', '办法', '情况',
    '状态', '结果', '原因', '过程', '内容', '信息', '消息', '感觉', '想法',
    '意思', '样子', '习惯', '计划', '目标', '细节', '重点', '思路',
]);

// ── 不参与「零 LLM 字面自动挂载」的类别 ──
// term 是抽象概念，字面命中率高但语义关联弱，交给 LLM 定向分类即可，
// 不该由 0.40 置信度的 auto_literal 批量灌碎片。
// *_aggregate 是听歌/读书流水，原本就排除在星图之外。
const AUTO_LINK_EXCLUDED_CATEGORIES = new Set([
    'term', 'music_aggregate', 'book_aggregate', 'movie_aggregate',
]);

const MIN_ENTITY_NAME_LENGTH = 2;

function normalizeName(name) {
    return String(name == null ? '' : name).toLowerCase().trim();
}

/** 这个名字是通用词 / 度量衡吗？（精确匹配，不做子串） */
function isGenericEntityName(name) {
    const k = normalizeName(name);
    if (k.length < MIN_ENTITY_NAME_LENGTH) return true;
    return GENERIC_ENTITY_NAMES.has(k);
}

/** 这个实体可以参与零 LLM 的字面自动挂载吗？ */
function isAutoLinkable(entity) {
    if (!entity) return false;
    if (isGenericEntityName(entity.name)) return false;
    return !AUTO_LINK_EXCLUDED_CATEGORIES.has(entity.category);
}

/** 实体的全部可匹配键（标准名 + 别名），已过滤黑名单与过短项 */
function entityKeys(entity) {
    const keys = [];
    const push = (raw) => {
        const k = normalizeName(raw);
        if (k.length < MIN_ENTITY_NAME_LENGTH) return;
        if (GENERIC_ENTITY_NAMES.has(k)) return;
        if (!keys.includes(k)) keys.push(k);
    };
    push(entity.name);
    try {
        for (const a of JSON.parse(entity.aliases || '[]')) push(a);
    } catch (_) { /* aliases 非法 JSON — 只用标准名 */ }
    return keys;
}

// ═══════════════════════════════════════════════════════════════
// 最长匹配优先
//
// 「我在大连理工的宿舍」→ 只认「大连理工大学」，不认「大连」。
// 「从大连理工回大连市区」→ 两个都认（「大连」在长名之外另有出现）。
//
// 做法：按命中键长度降序接受，接受后把文中该键的所有出现挖空（等长
// 占位符，保持偏移不变）；短键若在挖空后已不存在，说明它完全被长名
// 吞掉，丢弃。
// ═══════════════════════════════════════════════════════════════

const MASK_CHAR = '\u0000';

function resolveLiteralMatches(text, candidates) {
    const lower = normalizeName(text);
    if (!lower || !candidates || candidates.length === 0) return [];

    // 每个候选取「在文中实际命中的最长键」作为它的代表键
    const hits = [];
    for (const e of candidates) {
        let best = '';
        for (const key of entityKeys(e)) {
            if (key.length > best.length && lower.includes(key)) best = key;
        }
        if (best) hits.push({ entity: e, key: best });
    }
    if (hits.length === 0) return [];

    hits.sort((a, b) => b.key.length - a.key.length);

    let masked = lower;
    const accepted = [];
    for (const h of hits) {
        if (!masked.includes(h.key)) continue; // 已被更长的实体名吞掉
        masked = masked.split(h.key).join(MASK_CHAR.repeat(h.key.length));
        accepted.push(h.entity);
    }
    return accepted;
}

/**
 * 长名遮蔽后，这个实体在文本里还独立出现吗？
 * 供 SQL LIKE 路径（autoLinkLiteralMentions）逐条复核用。
 */
function matchesIndependently(text, entity, longerNames) {
    const lower = normalizeName(text);
    if (!lower) return false;
    let masked = lower;
    for (const n of longerNames || []) {
        const k = normalizeName(n);
        if (k.length >= MIN_ENTITY_NAME_LENGTH && masked.includes(k)) {
            masked = masked.split(k).join(MASK_CHAR.repeat(k.length));
        }
    }
    return entityKeys(entity).some(k => masked.includes(k));
}

module.exports = {
    GENERIC_ENTITY_NAMES,
    AUTO_LINK_EXCLUDED_CATEGORIES,
    MIN_ENTITY_NAME_LENGTH,
    isGenericEntityName,
    isAutoLinkable,
    entityKeys,
    resolveLiteralMatches,
    matchesIndependently,
};
