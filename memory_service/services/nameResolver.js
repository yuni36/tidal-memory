// services/nameResolver.js — v5.3 OSS
// Centralized user/AI display name resolution.

const { USER, AI, SKIP_NAMES, resolveTemplate } = require('./memoryConfig');

/**
 * Replace name placeholders with configured names in prompt strings.
 * 先解析 {{user.name}}/{{user.pronoun}}/{{ai.name}}，再处理 {user}/{ai}，最后兼容旧 Clara/Draco 字面量。
 */
function fillPrompt(str) {
    if (typeof str !== 'string') return str;
    return resolveTemplate(str)
        .replace(/\{user\}/g, USER.name)
        .replace(/\{ai\}/g, AI.name)
        .replace(/Clara/g, USER.name)
        .replace(/Draco/g, AI.name);
}

function senderName(sender) {
    if (sender === 'user') return USER.name;
    return AI.name;
}

function entityDisplayName(entity) {
    if (entity === 'Clara' || entity === '你' || entity === 'user') return USER.name;
    if (entity === 'Draco' || entity === 'Tidal' || entity === 'ai') return AI.name;
    return entity;
}

module.exports = { fillPrompt, senderName, entityDisplayName, USER, AI, SKIP_NAMES };
