// services/whisper.js
// 极简桩：Tidal 未接入 whisper 服务（无语音转写），返回 null 保证原版 API 端点可用。

function getLastWhisper() {
    return null;
}

module.exports = { getLastWhisper };
