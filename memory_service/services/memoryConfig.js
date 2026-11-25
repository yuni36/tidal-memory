// =================================================================
// memoryConfig — 记忆子系统配置加载器
//
// 读取 memory_config.json，提供 {{user.name}} 等模板变量替换。
// 所有硬编码的 Clara/Draco 引用应通过此模块获取，而不是直接写字符串。
//
// 消费端用法:
//   const { USER, AI, REL, PROJ, fillTemplate } = require('./memoryConfig');
//   const prompt = fillTemplate(`你是${AI.name}，${USER.name}的${REL.type}`);
// =================================================================

// Fall back to .example.json if memory_config.json doesn't exist (fresh clone)
let config;
try {
    config = require('../memory_config.json');
} catch (_) {
    console.log('[memoryConfig] memory_config.json 未找到，使用 memory_config.example.json');
    config = require('../memory_config.example.json');
}

// Flatten template variables from config (recursive {{key.subkey}} resolution)
function resolveTemplate(template) {
    let result = template;
    // Support {{user.name}}, {{ai.name}}, {{project.name}}
    result = result.replace(/\{\{user\.name\}\}/g, config.user.name);
    result = result.replace(/\{\{user\.pronoun\}\}/g, config.user.pronoun);
    result = result.replace(/\{\{user\.short_desc\}\}/g, config.user.short_desc);
    result = result.replace(/\{\{ai\.name\}\}/g, config.ai.name);
    result = result.replace(/\{\{ai\.pronoun\}\}/g, config.ai.pronoun);
    result = result.replace(/\{\{project\.name\}\}/g, config.project.name);
    return result;
}

// Resolve nested templates within config values
function resolveConfig() {
    const resolved = JSON.parse(JSON.stringify(config));
    for (const section of Object.values(resolved)) {
        if (typeof section === 'object') {
            for (const [key, val] of Object.entries(section)) {
                if (typeof val === 'string') {
                    section[key] = resolveTemplate(val);
                }
            }
        }
    }
    return resolved;
}

const resolved = resolveConfig();

// Entity names to skip in queries (twin stars are managed separately).
// Keep legacy names so Scribe/Archivist 不会再种出「你 / Clara / Tidal」星。
const SKIP_NAMES = [...new Set([
    resolved.user.name,
    resolved.ai.name,
    resolved.user.name.toLowerCase(),
    resolved.ai.name.toLowerCase(),
    'Tidal',
    'tidal',
    '你',
    'Clara',
    'clara',
    'Draco',
    'draco',
])];

/**
 * 双星「状态壳」：User在 / Assistant在 这类平行本人星座。
 * 不是「名字里出现双星就杀」——只拦 双星名 + 状态尾巴。
 * 状态信息应挂在双星 core 的 current_status / overview，不当普通星座。
 */
function isTwinStatusShell(name) {
    if (typeof name !== 'string') return false;
    const n = name.trim();
    if (!n) return false;
    const twins = [resolved.user.name, resolved.ai.name].filter(Boolean);
    const tails = ['在', '近况', '的近况', '状态', '的状态', '动态', '的动态'];
    for (const t of twins) {
        if (n === t) return false; // 双星本体由 SKIP_NAMES 管
        for (const tail of tails) {
            if (n === t + tail) return true;
        }
    }
    return false;
}

module.exports = {
    config: resolved,
    USER: resolved.user,
    AI: resolved.ai,
    SKIP_NAMES,
    isTwinStatusShell,
    REL: resolved.relationship,
    PROJ: resolved.project,
    UI: resolved.ui,
    resolveTemplate,
};
