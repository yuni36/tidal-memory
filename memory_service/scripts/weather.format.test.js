// scripts/weather.format.test.js
// 无网络：校验 wttr j1 片段格式化

const assert = require('assert');
const {
  formatCurrentSummary,
  formatForecast,
  getCityLabel,
} = require('../services/weather');

const sample = {
  current_condition: [{
    temp_C: '18',
    FeelsLikeC: '16',
    humidity: '55',
    windspeedKmph: '12',
    winddir16Point: 'NE',
    lang_zh: [{ value: '多云' }],
    weatherDesc: [{ value: 'Partly cloudy' }],
  }],
  weather: [
    {
      date: '2026-09-12',
      maxtempC: '20',
      mintempC: '14',
      hourly: [
        { chanceofrain: '10', lang_zh: [{ value: '晴' }] },
        {}, {}, {}, { chanceofrain: '20', lang_zh: [{ value: '多云' }] },
      ],
    },
    {
      date: '2026-09-13',
      maxtempC: '19',
      mintempC: '13',
      hourly: [{ chanceofrain: '40', lang_zh: [{ value: '小雨' }] }],
    },
  ],
};

const summary = formatCurrentSummary(sample);
assert.ok(summary.includes(getCityLabel()));
assert.ok(summary.includes('多云'));
assert.ok(summary.includes('18°C'));
assert.ok(summary.includes('体感 16'));

const forecast = formatForecast(sample, 2);
assert.ok(forecast.includes('09-12'));
assert.ok(forecast.includes('09-13'));
assert.ok(forecast.includes('小雨'));

console.log('[OK] weather.format.test.js');
