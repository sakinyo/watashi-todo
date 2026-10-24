// データの取り込み（Todoist CSV・このアプリの取り込み用JSON）とバックアップ形式
import { isValidKey, todayKey, pad, addDays } from './dates.js';
import { isRecurring, nextOnOrAfter, validateRule } from './recur.js';
import { otherCategoryId, uid, LEVELS, validateState, migrateState, SCHEMA_VERSION } from './state.js';

export const BACKUP_FORMAT = 'watashi-todo-backup';
export const IMPORT_FORMAT = 'watashi-todo-import';

// ─── CSV ───
export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function toCSV(rows) {
  return '﻿' + rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

// ─── Todoist の日付・繰り返し文字列の解釈 ───
// 確実に解釈できる書き方だけを対応し、それ以外は「要確認」にする（単発扱いにはしない）。
const WD_EN = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const WD_JA = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const ORD_EN = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 };

function z2h(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

export function parseTodoistDate(raw, today = todayKey()) {
  const s0 = z2h(String(raw || '')).trim();
  if (!s0) return { rule: { type: 'none' }, nextDate: null };
  const s = s0.toLowerCase().replace(/^every!/, 'every').replace(/\s+/g, ' ');

  // 単発の日付
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) {
    const k = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if (isValidKey(k)) return { rule: { type: 'none' }, nextDate: k };
  }
  if ((m = s.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/))) {
    const y = m[1] || today.slice(0, 4);
    const k = `${y}-${pad(+m[2])}-${pad(+m[3])}`;
    if (isValidKey(k)) return { rule: { type: 'none' }, nextDate: k };
  }
  if (s === '今日' || s === 'today') return { rule: { type: 'none' }, nextDate: today };
  if (s === '明日' || s === 'tomorrow') return { rule: { type: 'none' }, nextDate: addDays(today, 1) };

  // 繰り返し
  let rule = null;
  if (/^(毎日|every day|daily|every 1 day)$/.test(s)) rule = { type: 'daily' };
  else if (/^(平日|毎平日|毎週平日|every weekday|every workday)$/.test(s)) rule = { type: 'weekly', days: [1, 2, 3, 4, 5] };
  else if ((m = s.match(/^毎週\s*((?:[日月火水木金土](?:曜日?)?\s*[、,・ ]?\s*)+)$/))) {
    const days = [...m[1].replace(/曜日?/g, '').matchAll(/[日月火水木金土]/g)].map((x) => WD_JA[x[0]]);
    rule = { type: 'weekly', days: [...new Set(days)] };
  } else if ((m = s.match(/^every ((?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?\s*(?:,|and)?\s*)+)$/))) {
    const days = m[1].split(/[\s,]+|and/).filter(Boolean).map((w) => WD_EN[w]);
    if (days.every((d) => d != null)) rule = { type: 'weekly', days: [...new Set(days)] };
  } else if ((m = s.match(/^毎月\s*(\d{1,2})日$/)) || (m = s.match(/^every month on the (\d{1,2})(?:st|nd|rd|th)?$/)) || (m = s.match(/^every (\d{1,2})(?:st|nd|rd|th)?$/))) {
    const day = +m[1];
    if (day >= 1 && day <= 31) rule = { type: 'monthlyDay', day };
  } else if ((m = s.match(/^毎月\s*第([1-4])\s*([日月火水木金土])曜日?$/))) {
    rule = { type: 'monthlyNth', nth: +m[1], weekday: WD_JA[m[2]] };
  } else if ((m = s.match(/^毎月\s*最終\s*([日月火水木金土])曜日?$/))) {
    rule = { type: 'monthlyNth', nth: -1, weekday: WD_JA[m[1]] };
  } else if ((m = s.match(/^every (first|1st|second|2nd|third|3rd|fourth|4th|last) (sun|mon|tue|wed|thu|fri|sat)[a-z]*$/))) {
    rule = { type: 'monthlyNth', nth: ORD_EN[m[1]], weekday: WD_EN[m[2]] };
  } else if (/^(every month|毎月)$/.test(s)) {
    rule = null; // 何日か不明 → 要確認
  } else if ((m = s.match(/^every (\d+) (day|week|month)s?$/)) || (m = s.match(/^(\d+)\s*(日|週間|か月|ヶ月|カ月)ごと$/))) {
    // 間隔は基準日が分からないため要確認とし、候補だけ示す
    const unit = { day: 'day', week: 'week', month: 'month', 日: 'day', 週間: 'week', か月: 'month', ヶ月: 'month', カ月: 'month' }[m[2]];
    return { rule: { type: 'unknown', raw: s0 }, nextDate: null, review: `「${s0}」の基準日（最初の実施日）が分かりません`, suggestion: { type: 'interval', every: +m[1], unit, anchor: today } };
  }
  if (rule && !validateRule(rule)) return { rule, nextDate: nextOnOrAfter(rule, today) };
  return { rule: { type: 'unknown', raw: s0 }, nextDate: null, review: `繰り返し「${s0}」を解釈できませんでした` };
}

export function normTitle(s) {
  return z2h(String(s || '')).toLowerCase().replace(/[\s　、。,.・!！?？()（）「」]/g, '');
}

// Todoist の「テンプレートとしてエクスポート」CSV → 取り込み候補
export function todoistCsvToItems(text, fileName, today = todayKey()) {
  const rows = parseCSV(text);
  if (!rows.length) return { items: [], warnings: ['CSVが空です'], sourceCount: 0 };
  const head = rows[0].map((h) => h.trim().toUpperCase());
  const col = (name) => head.indexOf(name);
  const iType = col('TYPE'), iContent = col('CONTENT');
  if (iType < 0 || iContent < 0) return { items: [], warnings: ['TodoistのCSV形式（TYPE, CONTENT 列）ではありません'], sourceCount: 0, error: true };
  const iDesc = col('DESCRIPTION'), iPri = col('PRIORITY'), iIndent = col('INDENT'), iDate = col('DATE');
  const iDur = col('DURATION'), iDurUnit = col('DURATION_UNIT'), iDeadline = col('DEADLINE');
  const project = String(fileName || 'Todoist').replace(/\.csv$/i, '');
  const known = new Set(['TYPE', 'CONTENT', 'DESCRIPTION', 'PRIORITY', 'INDENT', 'AUTHOR', 'RESPONSIBLE', 'DATE', 'DATE_LANG', 'TIMEZONE', 'DURATION', 'DURATION_UNIT', 'DEADLINE', 'DEADLINE_LANG']);
  const warnings = [];
  const unknownCols = head.filter((h) => h && !known.has(h));
  if (unknownCols.length) warnings.push(`未対応の列（取り込みません）: ${unknownCols.join(', ')}`);
  const items = [];
  let section = '';
  let sourceCount = 0;
  for (const r of rows.slice(1)) {
    const type = (r[iType] || '').trim().toLowerCase();
    if (type === 'section') { section = (r[iContent] || '').trim(); continue; }
    if (type !== 'task') continue;
    sourceCount++;
    const content = (r[iContent] || '').trim();
    const notes = [];
    const desc = iDesc >= 0 ? (r[iDesc] || '').trim() : '';
    if (desc) notes.push(desc);
    if (section) notes.push(`[Todoist] セクション: ${section}`);
    const pri = iPri >= 0 ? (r[iPri] || '').trim() : '';
    if (pri) notes.push(`[Todoist] PRIORITY: ${pri}`);
    const indent = iIndent >= 0 ? +(r[iIndent] || 1) : 1;
    const issues = [];
    if (indent > 1) issues.push('サブタスク（親子の階層は取り込まれません）');
    const deadline = iDeadline >= 0 ? (r[iDeadline] || '').trim() : '';
    if (deadline) notes.push(`[Todoist] 締切: ${deadline}`);
    let duration = null;
    if (iDur >= 0 && r[iDur]) {
      const n = Number(r[iDur]);
      const unit = iDurUnit >= 0 ? (r[iDurUnit] || '').toLowerCase() : 'minute';
      if (Number.isFinite(n)) duration = unit.startsWith('day') ? null : n;
      if (unit.startsWith('day')) issues.push('所要時間が日単位のため取り込みません');
    }
    const rawDate = iDate >= 0 ? (r[iDate] || '').trim() : '';
    const parsed = parseTodoistDate(rawDate, today);
    if (!content) { items.push({ error: '空のタスク名', raw: r.join(',') }); continue; }
    items.push({
      importKey: `todoist-csv:${normTitle(project)}:${normTitle(content)}:${normTitle(rawDate)}`,
      title: content,
      categoryName: null,
      origin: project,
      rule: parsed.rule,
      nextDate: parsed.nextDate,
      duration,
      level: 'normal',
      memo: notes.join('\n'),
      needsReview: parsed.rule.type === 'unknown',
      reviewNote: parsed.review || null,
      issues,
      rawDate,
    });
  }
  return { items, warnings, sourceCount, sourceLabel: `Todoist CSV（${project}）` };
}

export function importJsonToItems(obj) {
  if (!obj || obj.format !== IMPORT_FORMAT || !Array.isArray(obj.tasks)) return { items: [], warnings: ['取り込み用JSONの形式ではありません'], error: true };
  const items = obj.tasks.map((t, i) => {
    if (!t || !String(t.title || '').trim()) return { error: `${i + 1}件目: タスク名がありません` };
    const rule = t.rule || { type: 'none' };
    const ruleErr = validateRule(rule);
    return {
      importKey: t.importKey || null,
      title: String(t.title).trim(),
      categoryName: t.category || null,
      origin: t.origin || '',
      rule: ruleErr ? { type: 'unknown', raw: JSON.stringify(rule) } : rule,
      nextDate: isValidKey(t.nextDate) ? t.nextDate : null,
      duration: Number.isFinite(t.duration) ? t.duration : null,
      level: LEVELS[t.level] ? t.level : 'normal',
      memo: t.memo || '',
      needsReview: !!t.needsReview || !!ruleErr || rule.type === 'unknown',
      reviewNote: ruleErr || t.reviewNote || null,
      issues: [],
    };
  });
  return { items, warnings: [], sourceCount: obj.sourceCount ?? obj.tasks.length, sourceLabel: obj.source || '取り込み用JSON', note: obj.note || '' };
}

// ファイル内容から取り込み候補を作る
export function readImportFile(name, text, today = todayKey()) {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (/\.json$/i.test(name) || trimmed.startsWith('{')) {
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return { items: [], warnings: ['JSONを読み取れませんでした（ファイルが壊れている可能性があります）'], error: true }; }
    if (obj.format === BACKUP_FORMAT) return { isBackup: true, backup: obj, items: [], warnings: [] };
    return importJsonToItems(obj);
  }
  return todoistCsvToItems(text, name, today);
}

// 取り込みプレビュー：重複・重複候補・要確認を判定
export function buildPreview(state, src) {
  const existingKeys = new Set(state.tasks.map((t) => t.importKey).filter(Boolean));
  const existingTitles = new Map(state.tasks.map((t) => [normTitle(t.title), t]));
  const seenKeys = new Set();
  const rows = (src.items || []).map((it, idx) => {
    if (it.error) return { idx, status: 'error', message: it.error, include: false };
    const cat = it.categoryName ? state.categories.find((c) => c.name === it.categoryName) : null;
    const row = { idx, item: it, categoryId: cat ? cat.id : otherCategoryId(state), categoryMissing: !!it.categoryName && !cat, include: true, status: 'new' };
    if (it.importKey && (existingKeys.has(it.importKey) || seenKeys.has(it.importKey))) {
      row.status = 'duplicate'; row.include = false;
      row.message = '取り込み済みのタスクです（重複登録しません）';
    } else if (existingTitles.has(normTitle(it.title))) {
      row.status = 'similar'; row.include = false;
      row.message = '同じ名前のタスクがすでにあります（重複候補）';
    } else if (it.needsReview) {
      row.status = 'review';
      row.message = it.reviewNote || '繰り返し設定の確認が必要です';
    }
    if (it.importKey) seenKeys.add(it.importKey);
    return row;
  });
  return { rows, warnings: src.warnings || [], sourceCount: src.sourceCount ?? rows.length, sourceLabel: src.sourceLabel || '', note: src.note || '' };
}

export function applyImport(state, preview, today = todayKey()) {
  const now = new Date().toISOString();
  const result = { source: preview.sourceCount, added: 0, duplicate: 0, similarSkipped: 0, review: 0, excluded: 0, errors: 0 };
  const keys = new Set(state.tasks.map((t) => t.importKey).filter(Boolean));
  for (const row of preview.rows) {
    if (row.status === 'error') { result.errors++; continue; }
    if (row.status === 'duplicate' || (row.item.importKey && keys.has(row.item.importKey))) { result.duplicate++; continue; }
    if (!row.include) { if (row.status === 'similar') result.similarSkipped++; else result.excluded++; continue; }
    const it = row.item;
    let nextDate = it.nextDate;
    if (isRecurring(it.rule) && !nextDate) nextDate = nextOnOrAfter(it.rule, today);
    state.tasks.push({
      id: uid('t'),
      title: it.title,
      categoryId: row.categoryId,
      rule: it.rule,
      nextDate,
      duration: it.duration,
      level: it.level,
      memo: it.memo,
      active: true,
      needsReview: !!it.needsReview,
      reviewNote: it.reviewNote || null,
      status: 'open',
      importKey: it.importKey || null,
      origin: it.origin || '',
      createdAt: now,
      updatedAt: now,
    });
    if (it.importKey) keys.add(it.importKey);
    result.added++;
    if (it.needsReview) result.review++;
  }
  return result;
}

// ─── バックアップ ───
export function makeBackup(state) {
  return { format: BACKUP_FORMAT, version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), state };
}

export function readBackup(obj) {
  if (!obj || obj.format !== BACKUP_FORMAT) return { error: 'このアプリのバックアップファイルではありません' };
  const s = obj.state;
  const errs = validateState(s);
  if (errs.length) return { error: 'バックアップの内容に問題があります: ' + errs.slice(0, 3).join(' / ') };
  return { state: migrateState(JSON.parse(JSON.stringify(s))), exportedAt: obj.exportedAt };
}

export function tasksToCsv(state) {
  const cat = (id) => state.categories.find((c) => c.id === id)?.name || '';
  const rows = [['タスク名', '分類', '繰り返し(JSON)', '次回実施日', '所要時間(分)', '優先度', '状態', '有効', '要確認', 'メモ']];
  for (const t of state.tasks) rows.push([t.title, cat(t.categoryId), JSON.stringify(t.rule), t.nextDate || '', t.duration ?? '', LEVELS[t.level] || '', t.status, t.active ? '有効' : '一時停止', t.needsReview ? '要確認' : '', t.memo || '']);
  return toCSV(rows);
}

export function historyToCsv(state) {
  const label = { done: '完了', skipped: 'スキップ', postponed: '次回に回した', moved: '日付変更' };
  const cat = (id) => state.categories.find((c) => c.id === id)?.name || '';
  const rows = [['操作日', '予定日', '操作', '変更先', 'タスク名', '分類', '日時']];
  for (const h of state.history) rows.push([h.date, h.scheduled || '', label[h.action] || h.action, h.toDate || '', h.title, cat(h.categoryId), h.at]);
  return toCSV(rows);
}
