// services/affect/toneMeta.js
// 从五轴推导 cluster / pride_tier / urgency
// 高唤醒门槛 0.4（原 0.3 太容易进 restless）

const V_HI = 0.3;
const V_LO = -0.3;
const A_HI = 0.4;   // 0.4，少误伤「沉稳」
const A_LO = -0.3;

function classifyCluster(v, a) {
    if (v > V_HI && a > A_HI) return 'excited';
    if (v > V_HI && a < A_LO) return 'content';
    if (v > V_HI) return 'pleased';
    if (v < V_LO && a > A_HI) return 'agitated';
    if (v < V_LO && a < A_LO) return 'depressed';
    if (v < V_LO) return 'sullen';
    if (a > A_HI) return 'restless';
    if (a < A_LO) return 'calm';
    return 'neutral';
}

function classifyPride(p) {
    if (p > 0.8) return 5;
    if (p > 0.5) return 4;
    if (p > 0.3) return 3;
    if (p > 0.1) return 2;
    return 1;
}

function classifyUrgency(c) {
    if (c >= 0.50) return 'desperate';
    if (c >= 0.35) return 'urgent';
    if (c >= 0.20) return 'aware';
    return 'none';
}

function fromState(state) {
    const s = state || {};
    const v = Number(s.valence) || 0;
    const a = Number(s.arousal) || 0;
    const p = Number(s.pride) || 0;
    const c = Number(s.connection) || 0;
    return {
        cluster: classifyCluster(v, a),
        prideTier: classifyPride(p),
        urgency: classifyUrgency(c),
    };
}

module.exports = {
    classifyCluster,
    classifyPride,
    classifyUrgency,
    fromState,
    THRESHOLDS: { V_HI, V_LO, A_HI, A_LO },
};
