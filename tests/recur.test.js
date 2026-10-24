import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occursOn, nextOnOrAfter, nextAfter, occurrencesBetween, describe } from '../js/recur.js';
import { addDays, weekday } from '../js/dates.js';

test('毎日: 完了すると翌日', () => {
  const r = { type: 'daily' };
  assert.equal(nextAfter(r, '2026-10-23', '2026-10-23'), '2026-10-24');
});

test('毎週月曜: 完了すると翌週月曜', () => {
  const r = { type: 'weekly', days: [1] };
  assert.equal(weekday('2026-10-26'), 1);
  assert.equal(nextOnOrAfter(r, '2026-10-23'), '2026-10-26');
  assert.equal(nextAfter(r, '2026-10-26', '2026-10-26'), '2026-11-02');
});

test('毎週 月水金日: 順に進む', () => {
  const r = { type: 'weekly', days: [1, 3, 5, 0] };
  const seq = [];
  let k = nextOnOrAfter(r, '2026-10-23'); // 金
  for (let i = 0; i < 5; i++) { seq.push(k); k = nextAfter(r, k, k); }
  assert.deepEqual(seq, ['2026-10-23', '2026-10-25', '2026-10-26', '2026-10-28', '2026-10-30']);
});

test('毎月8日: 月ごとに正しく進む（年またぎ含む）', () => {
  const r = { type: 'monthlyDay', day: 8 };
  assert.equal(nextAfter(r, '2026-11-08', '2026-11-08'), '2026-12-08');
  assert.equal(nextAfter(r, '2026-12-08', '2026-12-08'), '2027-01-08');
});

test('毎月31日: 無い月は月末、翌月は31日に戻る（ずれない）', () => {
  const r = { type: 'monthlyDay', day: 31 };
  const seq = [];
  let k = nextOnOrAfter(r, '2027-01-01');
  for (let i = 0; i < 5; i++) { seq.push(k); k = nextAfter(r, k, k); }
  assert.deepEqual(seq, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.equal(nextOnOrAfter(r, '2028-02-01'), '2028-02-29'); // うるう年
});

test('毎月30日: 2月は月末、3月は30日', () => {
  const r = { type: 'monthlyDay', day: 30 };
  assert.deepEqual(occurrencesBetween(r, '2027-02-01', '2027-03-31'), ['2027-02-28', '2027-03-30']);
});

test('遅れて完了しても過去の回を積み上げない', () => {
  const r = { type: 'monthlyDay', day: 8 };
  // 10/8の回を10/23に完了 → 11/8
  assert.equal(nextAfter(r, '2026-10-08', '2026-10-23'), '2026-11-08');
  // 10/8の回を12/20に完了 → 2027/1/8（11/8・12/8を重複生成しない）
  assert.equal(nextAfter(r, '2026-10-08', '2026-12-20'), '2027-01-08');
  // 10/8の回を11/8当日に完了 → 11/8（今日の回として残る）
  assert.equal(nextAfter(r, '2026-10-08', '2026-11-08'), '2026-11-08');
});

test('予定日より前に完了したら、その次の回', () => {
  const r = { type: 'monthlyDay', day: 21 };
  assert.equal(nextAfter(r, '2026-11-21', '2026-11-15'), '2026-12-21');
});

test('第2火曜・最終金曜', () => {
  const r = { type: 'monthlyNth', nth: 2, weekday: 2 };
  assert.deepEqual(occurrencesBetween(r, '2026-11-01', '2026-12-31'), ['2026-11-10', '2026-12-08']);
  const last = { type: 'monthlyNth', nth: -1, weekday: 5 };
  assert.deepEqual(occurrencesBetween(last, '2026-10-01', '2026-11-30'), ['2026-10-30', '2026-11-27']);
});

test('間隔: 3日ごと・2週間ごと・2か月ごと（31日基準）', () => {
  assert.deepEqual(occurrencesBetween({ type: 'interval', every: 3, unit: 'day', anchor: '2026-10-23' }, '2026-10-20', '2026-10-30'), ['2026-10-23', '2026-10-26', '2026-10-29']);
  const w = { type: 'interval', every: 2, unit: 'week', anchor: '2026-10-23' };
  assert.equal(nextAfter(w, '2026-10-23', '2026-10-23'), '2026-11-06');
  const m = { type: 'interval', every: 2, unit: 'month', anchor: '2026-12-31' };
  assert.deepEqual(occurrencesBetween(m, '2026-12-01', '2027-06-30'), ['2026-12-31', '2027-02-28', '2027-04-30', '2027-06-30']);
});

test('単発・要確認は繰り返さない', () => {
  assert.equal(nextOnOrAfter({ type: 'none' }, '2026-10-23'), null);
  assert.equal(nextOnOrAfter({ type: 'unknown', raw: 'x' }, '2026-10-23'), null);
});

test('説明文', () => {
  assert.equal(describe({ type: 'weekly', days: [0, 1, 3, 5] }), '毎週 月・水・金・日');
  assert.equal(describe({ type: 'monthlyDay', day: 31 }), '毎月31日（無い月は月末）');
  assert.equal(describe({ type: 'monthlyNth', nth: -1, weekday: 5 }), '毎月最終金曜日');
});

test('dates: 月末・うるう年の加算', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
