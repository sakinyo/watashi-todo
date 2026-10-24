import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseTodoistDate, readImportFile, buildPreview, applyImport, makeBackup, readBackup } from '../js/importer.js';
import { createInitialState, completeTask } from '../js/state.js';

const T = '2026-10-23';

test('CSV: 引用符・改行・カンマ入り', () => {
  const rows = parseCSV('﻿a,b\r\n"x,1","line1\nline2"\r\n"say ""hi""",z\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'line1\nline2'], ['say "hi"', 'z']]);
});

test('Todoist日付の解釈（日本語・英語）', () => {
  assert.deepEqual(parseTodoistDate('毎日', T).rule, { type: 'daily' });
  assert.deepEqual(parseTodoistDate('every day', T).rule, { type: 'daily' });
  assert.deepEqual(parseTodoistDate('毎週月曜日', T).rule, { type: 'weekly', days: [1] });
  assert.deepEqual(parseTodoistDate('毎週月、水、金', T).rule, { type: 'weekly', days: [1, 3, 5] });
  assert.deepEqual(parseTodoistDate('every mon, wed', T).rule, { type: 'weekly', days: [1, 3] });
  assert.deepEqual(parseTodoistDate('every monday', T).rule, { type: 'weekly', days: [1] });
  assert.deepEqual(parseTodoistDate('every weekday', T).rule, { type: 'weekly', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseTodoistDate('毎月8日', T).rule, { type: 'monthlyDay', day: 8 });
  assert.equal(parseTodoistDate('毎月8日', T).nextDate, '2026-11-08');
  assert.deepEqual(parseTodoistDate('every month on the 21st', T).rule, { type: 'monthlyDay', day: 21 });
  assert.deepEqual(parseTodoistDate('every 15th', T).rule, { type: 'monthlyDay', day: 15 });
  assert.deepEqual(parseTodoistDate('毎月第2火曜日', T).rule, { type: 'monthlyNth', nth: 2, weekday: 2 });
  assert.deepEqual(parseTodoistDate('every last fri', T).rule, { type: 'monthlyNth', nth: -1, weekday: 5 });
  assert.deepEqual(parseTodoistDate('2026-11-01', T), { rule: { type: 'none' }, nextDate: '2026-11-01' });
  assert.deepEqual(parseTodoistDate('11月1日', T), { rule: { type: 'none' }, nextDate: '2026-11-01' });
  assert.deepEqual(parseTodoistDate('', T), { rule: { type: 'none' }, nextDate: null });
});

test('解釈できない繰り返しは単発にせず要確認', () => {
  for (const s of ['every other week', '毎月', 'every 3 days', '隔週金曜', 'every 2nd workday']) {
    const r = parseTodoistDate(s, T);
    assert.equal(r.rule.type, 'unknown', s);
    assert.ok(r.review, s);
  }
});

const CSV = [
  'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
  'section,朝,,,,,,,,,,',
  'task,メールの確認,,4,1,,,every day,en,,10,minute',
  'task,ゴミ出し,燃えるゴミ,1,1,,,毎週月、木,ja,,,',
  'task,謎の繰り返し,,1,1,,,every other week,en,,,',
  'task,書類,,1,2,,,2026-11-01,en,,,',
].join('\n');

test('Todoist CSV → プレビュー → 取り込み → 再取り込みで重複しない', () => {
  const s = createInitialState();
  const src = readImportFile('毎日.csv', CSV, T);
  assert.equal(src.sourceCount, 4);
  const p1 = buildPreview(s, src);
  assert.deepEqual(p1.rows.map((r) => r.status), ['new', 'new', 'review', 'new']);
  assert.match(p1.rows[0].item.memo, /セクション: 朝/);
  assert.equal(p1.rows[0].item.duration, 10);
  assert.ok(p1.rows[3].item.issues.length); // サブタスクの注意
  const r1 = applyImport(s, p1, T);
  assert.deepEqual(r1, { source: 4, added: 4, duplicate: 0, similarSkipped: 0, review: 1, excluded: 0, errors: 0 });
  // 同じファイルをもう一度
  const p2 = buildPreview(s, readImportFile('毎日.csv', CSV, T));
  assert.ok(p2.rows.every((r) => r.status === 'duplicate'));
  const r2 = applyImport(s, p2, T);
  assert.equal(r2.added, 0);
  assert.equal(r2.duplicate, 4);
  assert.equal(s.tasks.length, 4);
});

test('同名タスクは重複候補（既定で取り込まない）', () => {
  const s = createInitialState();
  s.tasks.push({ id: 'x', title: 'メールの 確認', rule: { type: 'none' }, status: 'open', active: true });
  const p = buildPreview(s, readImportFile('a.csv', CSV, T));
  assert.equal(p.rows[0].status, 'similar');
  assert.equal(p.rows[0].include, false);
});

test('取り込み用JSON: 分類名で振り分け・ファイル内の重複も除外', () => {
  const s = createInitialState();
  const json = JSON.stringify({
    format: 'watashi-todo-import', sourceCount: 2, tasks: [
      { importKey: 'k1', title: '給与振り込み', category: '仕事・クリニック運営', rule: { type: 'monthlyDay', day: 23 }, nextDate: '2026-10-23' },
      { importKey: 'k1', title: '給与振り込み', category: '仕事・クリニック運営', rule: { type: 'monthlyDay', day: 23 }, nextDate: '2026-10-23' },
      { importKey: 'k2', title: 'x', category: '存在しない分類', rule: { type: 'weekly', days: [] } },
    ],
  });
  const p = buildPreview(s, readImportFile('m.json', json, T));
  assert.equal(p.rows[0].status, 'new');
  assert.equal(p.rows[1].status, 'duplicate');
  assert.equal(p.rows[2].status, 'review'); // 不正なルール → 要確認
  assert.equal(p.rows[2].categoryMissing, true);
  applyImport(s, p, T);
  const work = s.categories.find((c) => c.name === '仕事・クリニック運営').id;
  assert.equal(s.tasks[0].categoryId, work);
  assert.equal(s.tasks.length, 2);
});

test('バックアップ → 復元で同じ内容（完了履歴も）', () => {
  const s = createInitialState();
  const p = buildPreview(s, readImportFile('毎日.csv', CSV, T));
  applyImport(s, p, T);
  completeTask(s, s.tasks[0].id, T);
  const text = JSON.stringify(makeBackup(s));
  const file = readImportFile('backup.json', text, T);
  assert.equal(file.isBackup, true);
  const restored = readBackup(file.backup);
  assert.ok(!restored.error);
  assert.deepEqual(restored.state.tasks, s.tasks);
  assert.deepEqual(restored.state.history, s.history);
  assert.ok(readBackup({ format: 'other' }).error);
  assert.ok(readBackup({ format: 'watashi-todo-backup', state: { tasks: 'x' } }).error);
});
