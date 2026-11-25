// services/tools/selfWakeTool.js
// set_self_wake / cancel_self_wake — Assistant 给自己设唤醒，必填短留言

const alarms = require('../alarms');

const setSelfWake = {
  name: 'set_self_wake',
  defaultEnabled: true,
  settingsKey: 'feature_self_wake_enabled',
  getFunctionDeclaration() {
    return {
      name: 'set_self_wake',
      description: `给未来的自己设一个唤醒闹钟。到点系统只会把你写的短留言交还给你，不规定你醒来必须做什么（可以开口，也可以先想再说话）。

必填 note：8～40 字，只写「当时为什么设」，不要写完整台词或行动清单。
at：绝对时间 ISO8601 带 +08:00（禁止「过一会儿」「明天」等相对词落库——先自己换成绝对时刻）。
每日（闹钟响起的那一天）最多 20 个占坑；同时最多 10 个待响。`,
      parameters: {
        type: 'OBJECT',
        properties: {
          at: {
            type: 'STRING',
            description: '唤醒时刻，ISO+08:00，如 2026-09-12T22:30:00+08:00',
          },
          note: {
            type: 'STRING',
            description: '留给醒来自己的短留言（8～40 字）',
          },
        },
        required: ['at', 'note'],
      },
    };
  },
  instructionText:
    `**自醒**：想稍后再想起某事 → set_self_wake（at 绝对时间 + note 短留言）。到点只交还留言，不规定你开口。取消用 cancel_self_wake。不要用自醒代替对用户的日程提醒。`,
  async handler(args) {
    const result = alarms.create({ at: args?.at, note: args?.note });
    if (!result.ok) {
      return { success: false, error: result.error, formatted: result.error };
    }
    const a = result.alarm;
    const formatted =
      `已设自醒 #${a.id} → ${a.at}\n留言：「${a.note}」\n该日剩余名额 ${result.remaining_today}`;
    return {
      success: true,
      id: a.id,
      at: a.at,
      note: a.note,
      remaining_today: result.remaining_today,
      formatted,
    };
  },
};

const cancelSelfWake = {
  name: 'cancel_self_wake',
  defaultEnabled: true,
  settingsKey: 'feature_self_wake_enabled',
  getFunctionDeclaration() {
    return {
      name: 'cancel_self_wake',
      description: '取消一个尚未响起的自醒闹钟（仅 pending）。取消后释放该日占坑。',
      parameters: {
        type: 'OBJECT',
        properties: {
          id: {
            type: 'INTEGER',
            description: '闹钟 id（设醒时返回的 #数字）',
          },
        },
        required: ['id'],
      },
    };
  },
  async handler(args) {
    const result = alarms.cancel(args?.id);
    if (!result.ok) {
      return { success: false, error: result.error, formatted: result.error };
    }
    const formatted = `已取消自醒 #${result.alarm.id}；该日剩余名额 ${result.remaining_today}`;
    return {
      success: true,
      id: result.alarm.id,
      remaining_today: result.remaining_today,
      formatted,
    };
  },
};

module.exports = [setSelfWake, cancelSelfWake];
