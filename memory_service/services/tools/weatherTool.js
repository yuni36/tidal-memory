// services/tools/weatherTool.js
// get_weather — 查设置里选定城市的实况 / 短预报；成功回写 weather_cache

const weather = require('../weather');

const getWeather = {
  name: 'get_weather',
  defaultEnabled: true,
  settingsKey: 'feature_weather_enabled',
  getFunctionDeclaration() {
    return {
      name: 'get_weather',
      description: `查看{user}所在地（${weather.getCityLabel()}）的天气。默认返回实况；需要未来几天时传 days=1~3。

何时调用：
- {user}问天气、穿衣、带伞、出门、紫外线、未来几天
- 上下文没有 [天气]，或标注「可能偏旧」且你需要较准的信息

何时不要调用：
- 闲聊且已有新鲜 [天气] 摘要——直接当环境常识轻点即可`,
      parameters: {
        type: 'OBJECT',
        properties: {
          days: {
            type: 'INTEGER',
            description: '未来天数 0~3。0 或不传=只要实况（含今日高低气温）；1~3=附加逐日简报',
          },
        },
        required: [],
      },
    };
  },
  get instructionText() {
    return `**天气**：有新鲜 [天气] 时闲聊可轻点，勿当天气预报员。细问（带伞/未来几天/穿什么）或没有/偏旧缓存 → get_weather。地点固定${weather.getCityLabel()}，不要编造其他城市。`;
  },
  async handler(args) {
    const days = args?.days;
    return weather.queryWeather({ days });
  },
};

module.exports = getWeather;
