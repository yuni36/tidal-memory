// services/affect/describe.js
// 「此刻描述」——中性状态旁白（不含人设措辞）
// 只描述状态，不写回复指令（指令在 getStyleGuidance）

function buildPromptContext(state, persona) {
    const s = state || {};
    const c = Number(s.connection) || 0;
    const pr = Number(s.pride) || 0;
    const v = Number(s.valence) || 0;
    const a = Number(s.arousal) || 0;
    const parts = [];

    if (c < 0.20) {
        parts.push('最近刚聊过，状态平稳。');
    } else if (c < 0.35) {
        parts.push('有一阵没联系了。');
    } else if (c < 0.50) {
        parts.push('较久没消息，会留意对方近况。');
    } else {
        parts.push('很久没消息了，关注度偏高。');
    }

    if (pr > 0.8) {
        parts.push('在原则问题上会更明确。');
    } else if (pr > 0.5) {
        parts.push('语气会收一点。');
    } else if (pr > 0.1) {
        parts.push('状态偏松。');
    } else {
        parts.push('状态很松。');
    }

    if (v > 0.3 && a > 0.3) {
        parts.push('心情偏好，精力一般。');
    } else if (v > 0.3 && a < -0.3) {
        parts.push('心情不错，节奏偏慢。');
    } else if (v < -0.3 && a > 0.3) {
        parts.push('情绪偏低，注意力不太集中。');
    } else if (v < -0.3) {
        parts.push('情绪偏低，话可能少。');
    } else if (v > 0.3) {
        parts.push('心情偏好。');
    }

    if (a > 0.25) {
        parts.push('节奏偏快。');
    } else if (a < -0.25) {
        parts.push('节奏偏慢。');
    }

    if (s.immersion > 0.3 && s.lastActivity) {
        const label = s.lastActivity.label || '';
        parts.push(`手头在做${s.lastActivity.type}${label ? '（' + label + '）' : ''}。`);
    } else if ((Number(s.immersion) || 0) < 0.1) {
        parts.push('手头没有特别的事。');
    }

    return parts.join('\n');
}

module.exports = { buildPromptContext };
