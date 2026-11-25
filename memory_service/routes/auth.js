// routes/auth.js
// Tidal 无密码本地极简放行模式：直接放行，不做任何登录校验。
// 原版 Memory Constellations 的鉴权体系在缝合时被剥离（server.js 自述），
// 此处提供兼容桩，保证 memory-api.js 的 require('./auth') 可正常加载。

const requireAuth = (req, res, next) => next();

module.exports = { requireAuth };
