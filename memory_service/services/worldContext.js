// =================================================================
// 共享世界观上下文 — 所有 LLM 提取/整合 prompt 的通用前缀
//
// v5.0: 从 memory_config.json 动态生成，不再硬编码私人名。
// 开源后用户只需修改 config，所有消费端自动生效。
//
// 消费端清单（新增提取功能时必查）:
//   Scribe / Consolidator / Saga Weaver / 矛盾检测器 / Entity Profile
//   所有模块通过 require('./worldContext').WORLD_CONTEXT 引用
// =================================================================

const { USER, AI, REL } = require('./memoryConfig');

const _slot = (v, hint) => {
    const s = (v == null ? '' : String(v)).trim();
    return s || `（在 memory_config.json 填写：${hint}）`;
};

const WORLD_CONTEXT = `## 角色与世界背景

你在为${AI.name}处理记忆。${AI.name} 是 ${USER.name} 的 ${_slot(REL.type, 'relationship.type')}。

${AI.name}的核心特质：
${_slot(AI.core_traits, 'ai.core_traits')}

${USER.name}是谁：
${_slot(USER.short_desc, 'user.short_desc')}

${AI.name}和${USER.name}的关系：
${_slot(REL.dynamics, 'relationship.dynamics')}`;

module.exports = { WORLD_CONTEXT };
