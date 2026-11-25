// 日程自然日 / injectable 纯逻辑烟测（不启 HTTP）
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { initDatabase } = require('../database');
initDatabase();

const {
    calendarDateFromISO,
    currentCalendarDate,
    addCalendarDays,
    calendarDaysBetween,
} = require('../utils/time');
const schedules = require('../services/schedules');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

// 凌晨 01:00 仍属当天自然日（≠ 逻辑日）
assert(calendarDateFromISO('2026-09-10T01:00:00+08:00') === '2026-09-10', 'cal date midnight');
assert(calendarDateFromISO('2026-09-10T01:00:00Z') === '2026-09-10', 'cal date UTC morning → +8 afternoon same day?');
// 01:00Z = 09:00+08 → still 09-10
assert(calendarDateFromISO('2026-09-09T17:00:00Z') === '2026-09-10', '17Z = 01+08 next cal day');

const today = currentCalendarDate();
assert(/^\d{4}-\d{2}-\d{2}$/.test(today), 'today ymd');
assert(addCalendarDays(today, 1) > today, 'add day');
assert(calendarDaysBetween(today, addCalendarDays(today, 7)) === 7, 'between 7');

const stamp = Date.now();
const examDue = `${addCalendarDays(today, 5)}T09:00:00+08:00`;
const created = schedules.createEntry({
    title: `测考试-${stamp}`,
    due_at: examDue,
    category: 'exam',
    all_day: false,
});
assert(created.lead_days === 7, 'exam lead 7');
assert(created.calendar_date === addCalendarDays(today, 5), 'cal from due');

const inj = schedules.getInjectable();
assert(inj.items.some((i) => i.id === created.id), 'exam in injectable window');
assert(inj.text.includes('[日程]'), 'inject header');
assert(inj.text.includes('测考试-'), 'inject title');

const far = schedules.createEntry({
    title: `远作业-${stamp}`,
    due_at: `${addCalendarDays(today, 20)}T00:00:00+08:00`,
    category: 'homework',
    all_day: true,
});
const inj2 = schedules.getInjectable();
assert(!inj2.items.some((i) => i.id === far.id), 'homework lead3 不进 20 天外');

schedules.softDelete(created.id);
schedules.softDelete(far.id);

console.log('schedules smoke OK', { today, sample: inj.text.split('\n').slice(0, 3) });
