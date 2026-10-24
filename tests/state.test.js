import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, addTask, updateTask, deleteTask, completeTask, skipTask, postponeToNext, moveTo,
  undoHistory, rollover, todayView, toggleFocus, setActive, addCategory, deleteCategory, moveCategory, sortedCategories,
} from '../js/state.js';

const T = '2026-10-23'; // 金曜
const catId = (s, name) => s.categories.find((c) => c.name === name).id;

function setup() {
  const s = createInitialState();
  return s;
}

test('初期分類8つ・仕事だけ work', () => {
  const s = setup();
  assert.equal(s.categories.length, 8);
  assert.deepEqual(s.categories.filter((c) => c.kind === 'work').map((c) => c.name), ['仕事・クリニック運営']);
});

test('新規登録: 名前必須・繰り返しなら次回日を自動計算', () => {
  const s = setup();
  assert.ok(addTask(s, { title: '  ' }, T).errors.length);
  const { task } = addTask(s, { title: '爪切り', rule: { type: 'weekly', days: [1, 3, 5, 0] }, categoryId: catId(s, '育児・家族') }, T);
  assert.equal(task.nextDate, '2026-10-23');
  assert.equal(task.status, 'open');
});

test('新規の繰り返しで、指定日が曜日に合わないときは次の該当日に合わせる', () => {
  const s = setup();
  const { task } = addTask(s, { title: '火土', rule: { type: 'weekly', days: [2, 6] }, nextDate: T }, T); // 金曜を指定
  assert.equal(task.nextDate, '2026-10-24'); // 土曜
});

test('編集・削除（削除しても履歴は残る）', () => {
  const s = setup();
  const { task } = addTask(s, { title: 'A', rule: { type: 'daily' } }, T);
  updateTask(s, task.id, { ...task, title: 'B', duration: 15 }, T);
  assert.equal(s.tasks[0].title, 'B');
  assert.equal(s.tasks[0].duration, 15);
  completeTask(s, task.id, T);
  deleteTask(s, task.id);
  assert.equal(s.tasks.length, 0);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].title, 'B');
});

test('単発の完了 → 完了済み、取り消しで元に戻る', () => {
  const s = setup();
  const { task } = addTask(s, { title: '書類提出', nextDate: T }, T);
  const h = completeTask(s, task.id, T);
  assert.equal(task.status, 'done');
  assert.equal(todayView(s, T).dueToday.length, 0);
  assert.equal(todayView(s, T).doneToday.length, 1);
  undoHistory(s, h.id);
  assert.equal(task.status, 'open');
  assert.equal(s.history.length, 0);
});

test('毎週月曜を完了 → 翌週月曜。履歴に完了記録', () => {
  const s = setup();
  const { task } = addTask(s, { title: '週次', rule: { type: 'weekly', days: [1] }, nextDate: '2026-10-26' }, T);
  completeTask(s, task.id, '2026-10-26');
  assert.equal(task.nextDate, '2026-11-02');
  assert.equal(s.history[0].scheduled, '2026-10-26');
  assert.equal(s.history[0].action, 'done');
});

test('数日開かなかった: ルーティンは今日へ進み、毎月は期限切れで残る。何度処理しても重複しない', () => {
  const s = setup();
  const d = addTask(s, { title: '毎日', rule: { type: 'daily' }, nextDate: '2026-10-20' }, T).task;
  const w = addTask(s, { title: '月水金日', rule: { type: 'weekly', days: [1, 3, 5, 0] }, nextDate: '2026-10-19' }, T).task;
  const m = addTask(s, { title: '毎月8日', rule: { type: 'monthlyDay', day: 8 }, nextDate: '2026-10-08' }, T).task;
  rollover(s, T);
  rollover(s, T);
  assert.equal(d.nextDate, T);
  assert.equal(w.nextDate, T); // 金曜
  assert.equal(m.nextDate, '2026-10-08');
  assert.equal(s.tasks.length, 3);
  const v = todayView(s, T);
  assert.deepEqual(v.overdue.map((t) => t.title), ['毎月8日']);
  assert.deepEqual(v.routines.map((t) => t.title).sort(), ['月水金日', '毎日'].sort());
  // 翌日に日付が変わる
  completeTask(s, d.id, T);
  rollover(s, '2026-10-24');
  assert.equal(d.nextDate, '2026-10-24');
  assert.equal(w.nextDate, '2026-10-25'); // 土曜は対象外 → 日曜
});

test('期限切れの処理: 次回に回す・日付変更・スキップ（自動で翌日には回らない）', () => {
  const s = setup();
  const m = addTask(s, { title: '毎月8日', rule: { type: 'monthlyDay', day: 8 }, nextDate: '2026-10-08' }, T).task;
  postponeToNext(s, m.id, T);
  assert.equal(m.nextDate, '2026-11-08');
  moveTo(s, m.id, '2026-11-10', T);
  assert.equal(m.nextDate, '2026-11-10');
  completeTask(s, m.id, '2026-11-10');
  assert.equal(m.nextDate, '2026-12-08'); // 日付変更は今回だけ。ルールは毎月8日のまま
  const one = addTask(s, { title: '単発', nextDate: '2026-10-20' }, T).task;
  skipTask(s, one.id, T);
  assert.equal(one.status, 'skipped');
  assert.deepEqual(s.history.map((h) => h.action), ['postponed', 'moved', 'done', 'skipped']);
});

test('重点は最大3つ', () => {
  const s = setup();
  const ids = ['a', 'b', 'c', 'd'].map((t) => addTask(s, { title: t, nextDate: T }, T).task.id);
  assert.ok(toggleFocus(s, T, ids[0]).ok);
  assert.ok(toggleFocus(s, T, ids[1]).ok);
  assert.ok(toggleFocus(s, T, ids[2]).ok);
  assert.equal(toggleFocus(s, T, ids[3]).ok, false);
  toggleFocus(s, T, ids[0]);
  assert.ok(toggleFocus(s, T, ids[3]).ok);
});

test('一時停止中は今日に出ない／再開で今日以降から', () => {
  const s = setup();
  const t = addTask(s, { title: '毎日', rule: { type: 'daily' }, nextDate: '2026-10-01' }, T).task;
  setActive(s, t.id, false, T);
  rollover(s, T);
  assert.equal(todayView(s, T).routines.length, 0);
  setActive(s, t.id, true, T);
  assert.equal(t.nextDate, T);
});

test('要確認タスクは予定に出ない', () => {
  const s = setup();
  addTask(s, { title: '謎', rule: { type: 'unknown', raw: 'every other something' } }, T);
  assert.equal(s.tasks[0].needsReview, true);
  rollover(s, T);
  const v = todayView(s, T);
  assert.equal(v.routines.length + v.dueToday.length + v.overdue.length, 0);
});

test('分類の追加・削除（タスクは移動先へ）・並べ替え', () => {
  const s = setup();
  const { category } = addCategory(s, '勉強', 'private');
  const t = addTask(s, { title: 'x', categoryId: category.id }, T).task;
  const other = catId(s, 'その他');
  assert.equal(deleteCategory(s, category.id, other).moved, 1);
  assert.equal(t.categoryId, other);
  const first = sortedCategories(s)[0].id;
  moveCategory(s, first, 1);
  assert.equal(sortedCategories(s)[1].id, first);
});
