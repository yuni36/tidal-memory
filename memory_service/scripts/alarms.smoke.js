// scripts/alarms.smoke.js — 自醒占坑 / 取消 / due·claim·ack
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = path.join(os.tmpdir(), `tidal-alarms-${Date.now()}.db`);
process.env.SANCTUARY_DB_PATH = tmp;

const { initDatabase, getDb } = require('../database');
const alarms = require('../services/alarms');
const { nowISOWithOffset, addCalendarDays, currentCalendarDate } = require('../utils/time');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function futureISO(sec = 120) {
  return nowISOWithOffset(new Date(Date.now() + sec * 1000));
}

function main() {
  initDatabase();
  getDb();

  const note = '出门前再看一眼消息';
  assert(note.length >= alarms.NOTE_MIN);

  const r1 = alarms.create({ at: futureISO(90), note });
  assert(r1.ok, r1.error);
  assert(r1.alarm.id);
  console.log('create ok', r1.alarm.id, 'remaining', r1.remaining_today);

  const bad = alarms.create({ at: futureISO(90), note: '短' });
  assert(!bad.ok, '短留言应拒绝');

  const past = alarms.create({ at: nowISOWithOffset(new Date(Date.now() - 60_000)), note });
  assert(!past.ok, '过去时间应拒绝');

  // pending 上限 10：先填满 pending
  let pendingIds = [r1.alarm.id];
  while (pendingIds.length < alarms.PENDING_CAP) {
    const r = alarms.create({ at: futureISO(120 + pendingIds.length), note: `${note}${pendingIds.length}` });
    assert(r.ok, r.error || `pending #${pendingIds.length + 1}`);
    pendingIds.push(r.alarm.id);
  }
  const pendFull = alarms.create({ at: futureISO(400), note: `${note}满` });
  assert(!pendFull.ok && /待响/.test(pendFull.error || ''), pendFull.error);

  // 把已占坑的响掉，腾出 pending，但仍占日限额
  for (const id of pendingIds) {
    const db = getDb();
    const dueAt = nowISOWithOffset(new Date(Date.now() - 5_000));
    db.prepare(`UPDATE alarms SET trigger_at = ? WHERE id = ?`).run(dueAt, id);
    assert(alarms.claim(id), `claim ${id}`);
    assert(alarms.ack(id, true).ok, `ack ${id}`);
  }

  // 再占满到日限额 20
  let made = pendingIds.length;
  const moreIds = [];
  while (made < alarms.DAILY_CAP) {
    const r = alarms.create({ at: futureISO(500 + made), note: `${note}续${made}` });
    assert(r.ok, r.error || `日限第 ${made + 1}`);
    moreIds.push(r.alarm.id);
    made++;
  }
  const dayFull = alarms.create({ at: futureISO(900), note: `${note}日满` });
  assert(!dayFull.ok && /已满/.test(dayFull.error || ''), dayFull.error);

  // 取消一条 pending → 释放坑
  const cancel = alarms.cancel(moreIds[0]);
  assert(cancel.ok);
  const again = alarms.create({ at: futureISO(950), note: `${note}再占` });
  assert(again.ok, again.error);

  // due 路径
  const db = getDb();
  const dueAt = nowISOWithOffset(new Date(Date.now() - 5_000));
  db.prepare(`UPDATE alarms SET trigger_at = ?, calendar_date = ? WHERE id = ?`).run(
    dueAt,
    currentCalendarDate(),
    again.alarm.id,
  );
  const due = alarms.listDue();
  assert(due.some((x) => x.id === again.alarm.id), '应出现在 due');
  assert(alarms.claim(again.alarm.id)?.status === 'firing');
  assert(alarms.ack(again.alarm.id, true).ok);

  // 清空剩余 pending，明天不占今天坑
  for (const row of alarms.listPending()) alarms.cancel(row.id);
  const tomorrow = addCalendarDays(currentCalendarDate(), 1);
  const tm = alarms.create({ at: `${tomorrow}T10:00:00+08:00`, note });
  assert(tm.ok, tm.error);
  assert(tm.alarm.calendar_date === tomorrow);

  console.log('alarms.smoke OK');
  try { fs.unlinkSync(tmp); } catch (_) {}
}

try {
  main();
} catch (e) {
  console.error(e);
  try { fs.unlinkSync(tmp); } catch (_) {}
  process.exit(1);
}
