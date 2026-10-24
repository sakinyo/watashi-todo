// 繰り返しルールの計算
//
// rule の形:
//   { type: 'none' }                                   単発
//   { type: 'daily' }                                  毎日
//   { type: 'weekly', days: [0..6] }                   毎週・指定曜日（0=日）
//   { type: 'monthlyDay', day: 1..31 }                 毎月・指定日
//       その月に該当日が無いとき（例: 31日・2月30日）は、その月の「最終日」に実施する
//   { type: 'monthlyNth', nth: 1..4 | -1, weekday }    毎月・第n（-1=最終）◯曜日
//   { type: 'interval', every: n, unit: 'day'|'week'|'month', anchor: 'YYYY-MM-DD' }
//       基準日から n 日／週／か月ごと（月単位で該当日が無い月は最終日）
//   { type: 'unknown', raw: '...' }                    解釈できなかった繰り返し（要確認）

import { addDays, diffDays, weekday, daysInMonth, parts, maxKey, WD_JA, isValidKey } from './dates.js';

export const RULE_TYPES = ['none', 'daily', 'weekly', 'monthlyDay', 'monthlyNth', 'interval', 'unknown'];

export function isRecurring(rule) {
  return !!rule && ['daily', 'weekly', 'monthlyDay', 'monthlyNth', 'interval'].includes(rule.type);
}

// 毎日・曜日のルーティン：やれなかった日は翌日に積み上げず、次の予定日へ自動で進む
export function isRoutine(rule) {
  return !!rule && (rule.type === 'daily' || rule.type === 'weekly');
}

export function validateRule(rule) {
  if (!rule || !RULE_TYPES.includes(rule.type)) return '繰り返しの種類が不正です';
  switch (rule.type) {
    case 'weekly':
      if (!Array.isArray(rule.days) || rule.days.length === 0) return '曜日を1つ以上選んでください';
      if (rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return '曜日が不正です';
      break;
    case 'monthlyDay':
      if (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31) return '日付は1〜31で指定してください';
      break;
    case 'monthlyNth':
      if (![1, 2, 3, 4, -1].includes(rule.nth)) return '第何週かが不正です';
      if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) return '曜日が不正です';
      break;
    case 'interval':
      if (!Number.isInteger(rule.every) || rule.every < 1 || rule.every > 366) return '間隔は1以上で指定してください';
      if (!['day', 'week', 'month'].includes(rule.unit)) return '間隔の単位が不正です';
      if (!isValidKey(rule.anchor)) return '基準日を指定してください';
      break;
  }
  return null;
}

export function occursOn(rule, key) {
  if (!isRecurring(rule)) return false;
  const { y, m, d } = parts(key);
  const dim = daysInMonth(y, m);
  switch (rule.type) {
    case 'daily':
      return true;
    case 'weekly':
      return rule.days.includes(weekday(key));
    case 'monthlyDay':
      return d === Math.min(rule.day, dim);
    case 'monthlyNth':
      if (weekday(key) !== rule.weekday) return false;
      return rule.nth === -1 ? d + 7 > dim : Math.ceil(d / 7) === rule.nth;
    case 'interval': {
      const diff = diffDays(rule.anchor, key);
      if (diff < 0) return false;
      if (rule.unit === 'day') return diff % rule.every === 0;
      if (rule.unit === 'week') return diff % (7 * rule.every) === 0;
      const a = parts(rule.anchor);
      const months = (y - a.y) * 12 + (m - a.m);
      return months % rule.every === 0 && d === Math.min(a.d, dim);
    }
  }
  return false;
}

// key 以降（key を含む）で最初の実施日
export function nextOnOrAfter(rule, key) {
  if (!isRecurring(rule)) return null;
  let k = key;
  if (rule.type === 'interval' && k < rule.anchor) k = rule.anchor;
  // 最長でも 366日×12か月相当を超えることはないが、安全のため上限を設ける
  for (let i = 0; i < 4500; i++) {
    if (occursOn(rule, k)) return k;
    k = addDays(k, 1);
  }
  return null;
}

// 予定日 scheduled の回を完了（またはスキップ）したあとの次回予定日。
// ・予定日より後で、かつ今日以降の最初の実施日。
// ・遅れて完了しても、過ぎた回を積み上げない（例: 10/8の回を10/23に完了 → 次回 11/8）。
export function nextAfter(rule, scheduled, today) {
  if (!isRecurring(rule)) return null;
  const from = scheduled ? maxKey(addDays(scheduled, 1), today) : today;
  return nextOnOrAfter(rule, from);
}

// 期間内の実施日（カレンダー表示用）
export function occurrencesBetween(rule, from, to) {
  const out = [];
  if (!isRecurring(rule)) return out;
  for (let k = from; k <= to; k = addDays(k, 1)) if (occursOn(rule, k)) out.push(k);
  return out;
}

const NTH_JA = { 1: '第1', 2: '第2', 3: '第3', 4: '第4', '-1': '最終' };

export function describe(rule) {
  if (!rule) return '—';
  switch (rule.type) {
    case 'none': return '単発';
    case 'daily': return '毎日';
    case 'weekly': {
      const order = [1, 2, 3, 4, 5, 6, 0];
      const days = order.filter((d) => rule.days.includes(d));
      if (days.length === 7) return '毎週 全曜日';
      if (days.length === 5 && !days.includes(0) && !days.includes(6)) return '毎週 平日';
      return '毎週 ' + days.map((d) => WD_JA[d]).join('・');
    }
    case 'monthlyDay': return `毎月${rule.day}日` + (rule.day >= 29 ? '（無い月は月末）' : '');
    case 'monthlyNth': return `毎月${NTH_JA[rule.nth]}${WD_JA[rule.weekday]}曜日`;
    case 'interval': {
      const unit = { day: '日', week: '週間', month: 'か月' }[rule.unit];
      return `${rule.every}${unit}ごと`;
    }
    case 'unknown': return `要確認（${rule.raw || '不明'}）`;
  }
  return '—';
}

// ルーティン画面のタブ分け
export function ruleGroup(rule) {
  if (!rule) return 'none';
  if (rule.type === 'daily') return 'daily';
  if (rule.type === 'weekly') return rule.days.length === 7 ? 'daily' : 'weekly';
  if (rule.type === 'monthlyDay' || rule.type === 'monthlyNth') return 'monthly';
  if (rule.type === 'interval' || rule.type === 'unknown') return 'other';
  return 'none';
}
