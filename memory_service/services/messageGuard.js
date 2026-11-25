// services/messageGuard.js — Tidal Phase 3 简化版
// 原 Memory Constellations 中用于捕获"记忆空白"（搜索无结果时记录）。
// Phase 3 安全桩：纯日志，零 DB 依赖，防止未知工具调用时服务崩溃。

function captureMemoryGap(chatId, lastMessage, toolName, result) {
    console.log(`[messageGuard] 记忆空白: tool=${toolName} chat=${chatId}`);
}

module.exports = { captureMemoryGap };