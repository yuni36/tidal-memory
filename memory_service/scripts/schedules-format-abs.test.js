// injectable 文案：绝对日期（无「今天/明天」）
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { initDatabase } = require('../database');
initDatabase();

const { formatInjectText, addCalendarDays: _x } = require('../services/schedules');
const { addCalendarDays, currentCalendarDate } = require('../utils/time');

function assert(c, m) {
    if (!c) throw new Error(m);
}

const today = currentCalendarDate();
const tomorrow = addCalendarDays(today, 1);
const later = addCalendarDays(today, 9);
const mdToday = today.slice(5).replace('-', '/');
const mdTom = tomorrow.slice(5).replace('-', '/');
const mdLater = later.slice(5).replace('-', '/');

const items = [
    {
        title: '思政',
        due_at: `${today}T08:00:00+08:00`,
        end_at: null,
        time_label: null,
        all_day: 0,
        category: 'class',
        occurrence_date: today,
        calendar_date: today,
    },
    {
        title: '见导师',
        due_at: `${today}T14:30:00+08:00`,
        end_at: null,
        time_label: null,
        all_day: 0,
        category: 'appointment',
        occurrence_date: today,
        calendar_date: today,
    },
    {
        title: '线代考',
        due_at: `${tomorrow}T09:00:00+08:00`,
        end_at: null,
        time_label: null,
        all_day: 0,
        category: 'exam',
        occurrence_date: tomorrow,
        calendar_date: tomorrow,
    },
    {
        title: '作业',
        due_at: `${later}T00:00:00+08:00`,
        end_at: null,
        time_label: null,
        all_day: 1,
        category: 'homework',
        occurrence_date: later,
        calendar_date: later,
    },
];

const text = formatInjectText(items, today);
assert(!/今天|明天/.test(text), 'must not use relative day words: ' + text);
assert(text.includes(mdToday), 'today md: ' + text);
assert(text.includes('08:00'), text);
assert(text.includes('见导师'), text);
assert(text.includes(mdTom), text);
assert(text.includes(mdLater), text);
assert(text.includes('还有 9 天') || text.includes('还有9天'), 'lead days: ' + text);
console.log('format abs OK\n' + text);
