// わたしの暮らしTODO 本体
import { todayKey, addDays, formatJa, formatJaLong, relativeJa, startOfWeek, startOfMonth, addMonths, parts, daysInMonth, weekday, WD_JA, pad } from './dates.js';
import { isRecurring, isRoutine, occursOn, nextAfter, describe, ruleGroup } from './recur.js';
import {
  createInitialState, migrateState, validateState, rollover, todayView, findTask, categoryOf, sortedCategories, otherCategoryId,
  completeTask, skipTask, postponeToNext, moveTo, undoHistory, toggleFocus, focusIds, addTask, updateTask, deleteTask, setActive,
  addCategory, updateCategory, deleteCategory, moveCategory, isScheduledOpen, backupAgeDays, LEVELS, MAX_FOCUS,
} from './state.js';
import { readImportFile, buildPreview, applyImport, makeBackup, readBackup, tasksToCsv, historyToCsv } from './importer.js';
import { loadState, saveState, saveSnapshot, listSnapshots, loadSnapshot, storageInfo, requestPersist } from './db.js';
import { esc, $, toast, showErrorBar, openSheet, closeSheet, closeAllSheets, saveFile, pickFile } from './ui.js';

const APP_VERSION = '1.0.0';
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const LEVEL_ORDER = { must: 0, normal: 1, optional: 2 };

let state = null;
let today = todayKey();
let tab = 'today';
let lastSavedAt = null;
let saveError = null;
let dismissedSafariNote = false;
const ui = {
  routineTab: 'daily',
  filters: { q: '', cat: '', freq: '', status: 'open', when: '' },
  calMode: 'week',
  calCursor: null,
  calSelected: null,
  showDone: false,
};
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// ─────────────────────────────── 保存 ───────────────────────────────
async function persist() {
  try {
    await saveState(state, today);
    lastSavedAt = new Date();
    if (saveError) { saveError = null; $('#error-bar').innerHTML = ''; }
  } catch (e) {
    saveError = e;
    console.error(e);
    showErrorBar(`保存できませんでした（${e.message || e}）。アプリを開き直しても直らない場合は、設定からバックアップを保存してください。`);
  }
}

function commit(fn) {
  let r;
  try { r = fn(state); } catch (e) {
    console.error(e);
    showErrorBar(`操作中にエラーが発生しました: ${e.message || e}`);
    return undefined;
  }
  render();
  persist();
  return r;
}

// ─────────────────────────────── 部品 ───────────────────────────────
function catChip(t) {
  const c = categoryOf(state, t);
  return `<span class="chip cat-chip ${c.kind === 'work' ? 'chip-work' : ''}" style="--c:${esc(c.color)}">${c.kind === 'work' ? '💼 ' : ''}${esc(c.name)}</span>`;
}

function levelChip(t) {
  if (t.level === 'must') return '<span class="chip lvl-must">必須</span>';
  if (t.level === 'optional') return '<span class="chip lvl-opt">任意</span>';
  return '';
}

function taskRow(t, opts = {}) {
  const c = categoryOf(state, t);
  const focused = focusIds(state, today).includes(t.id);
  const meta = [catChip(t), levelChip(t)];
  if (opts.showRule !== false && isRecurring(t.rule)) meta.push(`<span class="meta-txt">${esc(describe(t.rule))}</span>`);
  if (opts.showDate && t.nextDate) meta.push(`<span class="meta-txt ${t.nextDate < today ? 'overdue-txt' : ''}">${esc(relativeJa(t.nextDate, today))}</span>`);
  if (t.duration) meta.push(`<span class="meta-txt">⏱${t.duration}分</span>`);
  if (!t.active) meta.push('<span class="chip chip-paused">一時停止中</span>');
  if (t.needsReview) meta.push('<span class="chip chip-review">要確認</span>');
  if (t.status === 'done') meta.push('<span class="chip chip-done">完了済み</span>');
  if (t.status === 'skipped') meta.push('<span class="chip chip-done">スキップ済み</span>');
  const canCheck = t.status === 'open' && t.active && !t.needsReview && opts.check !== false;
  return `<div class="task ${c.kind === 'work' ? 'kind-work' : 'kind-private'}" style="--c:${esc(c.color)}">
    ${canCheck ? `<button type="button" class="check" data-action="complete" data-id="${t.id}" aria-label="「${esc(t.title)}」を完了"></button>` : opts.check === false ? '<span class="check-gap"></span>' : '<span class="check check-off"></span>'}
    <button type="button" class="task-body" data-action="${opts.tapAction || 'menu'}" data-id="${t.id}">
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-meta">${meta.join('')}</span>
    </button>
    ${opts.star !== false && t.status === 'open' ? `<button type="button" class="star ${focused ? 'on' : ''}" data-action="focus" data-id="${t.id}" aria-label="重点に${focused ? 'しない' : 'する'}">${focused ? '★' : '☆'}</button>` : ''}
  </div>`;
}

function doneRow(h) {
  const t = findTask(state, h.taskId);
  const c = t ? categoryOf(state, t) : (state.categories.find((x) => x.id === h.categoryId) || { kind: 'private', color: '#8c8c8c' });
  const label = h.action === 'skipped' ? 'スキップ' : '完了';
  return `<div class="task done ${c.kind === 'work' ? 'kind-work' : 'kind-private'}" style="--c:${esc(c.color)}">
    <span class="check ${h.action === 'skipped' ? 'check-skip' : 'check-done'}"></span>
    <div class="task-body static"><span class="task-title">${esc(h.title)}</span><span class="task-meta"><span class="meta-txt">${label}</span></span></div>
    <button type="button" class="link-btn" data-action="undo" data-hid="${h.id}">取り消す</button>
  </div>`;
}

function section(title, inner, { sub = '', cls = '' } = {}) {
  return `<section class="sec ${cls}"><h2>${esc(title)}${sub ? `<small>${sub}</small>` : ''}</h2>${inner}</section>`;
}

function sortTasks(list) {
  const order = new Map(sortedCategories(state).map((c, i) => [c.id, i]));
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || ((order.get(a.categoryId) ?? 99) - (order.get(b.categoryId) ?? 99)));
}

function catOptions(selected, { blank } = {}) {
  return (blank ? `<option value="">${esc(blank)}</option>` : '') + sortedCategories(state).map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.kind === 'work' ? '💼 ' : ''}${esc(c.name)}</option>`).join('');
}

// ─────────────────────────────── 画面A：今日 ───────────────────────────────
function viewToday() {
  const v = todayView(state, today);
  const minimal = state.settings.minimalMode;
  const focusSet = new Set(v.focus);
  const keep = (t) => !minimal || t.level === 'must';
  const doneIds = new Set(v.doneToday.map((h) => h.taskId));

  const overdue = sortTasks(v.overdue.filter((t) => !focusSet.has(t.id)));
  const due = sortTasks(v.dueToday.filter((t) => !focusSet.has(t.id)));
  const routines = sortTasks(v.routines.filter((t) => !focusSet.has(t.id)));
  const focusOpen = v.focusTasks.filter((t) => t && t.status === 'open' && !doneIds.has(t.id) && t.active);

  const allOpen = [...focusOpen, ...overdue, ...due, ...routines];
  const shown = allOpen.filter(keep);
  const hiddenCount = allOpen.length - shown.length;
  const doneCount = v.doneToday.filter((h) => h.action === 'done').length;
  const remainingMin = shown.reduce((s, t) => s + (t.duration || 0), 0);
  const noDuration = shown.filter((t) => !t.duration).length;

  const banners = [];
  const reviewCount = state.tasks.filter((t) => t.needsReview).length;
  if (reviewCount) banners.push(`<button type="button" class="banner banner-review" data-action="go-review">⚠️ 要確認のタスクが ${reviewCount} 件あります（予定には出ていません）<b>確認する ›</b></button>`);
  const age = backupAgeDays(state, today);
  if (state.tasks.length && (age == null || age >= (state.settings.backupReminderDays || 7))) {
    banners.push(`<button type="button" class="banner banner-backup" data-action="backup">💾 ${age == null ? 'まだバックアップがありません' : `最後のバックアップから ${age} 日たちました`}<b>今すぐ保存 ›</b></button>`);
  }
  if (!standalone && !dismissedSafariNote) {
    banners.push(`<div class="banner banner-info">📱 Safariで開いています。ホーム画面に追加したアプリから使ってください（Safariとホーム画面アプリは、データが別々に保存されます）。<button type="button" class="link-btn" data-action="dismiss-safari">閉じる</button></div>`);
  }

  // 重点
  const focusItems = v.focus.map((id) => {
    const t = findTask(state, id);
    if (!t) return '';
    const h = v.doneToday.find((x) => x.taskId === id);
    if (h) return doneRow(h);
    if (minimal && t.level !== 'must') return '';
    return taskRow(t, { showDate: t.nextDate !== today });
  }).join('');
  const emptySlots = Math.max(0, MAX_FOCUS - v.focus.length);
  const focusBalance = (() => {
    const kinds = v.focus.map((id) => findTask(state, id)).filter(Boolean).map((t) => categoryOf(state, t).kind);
    const w = kinds.filter((k) => k === 'work').length;
    return kinds.length ? `仕事 ${w}・暮らし ${kinds.length - w}` : '';
  })();
  const focusHtml = `<div class="focus-box">${focusItems}${emptySlots && !minimal ? `<button type="button" class="slot" data-action="pick-focus">＋ 重点を選ぶ（あと${emptySlots}つ）</button>` : ''}</div>`;

  const routineHtml = routines.filter(keep).length
    ? routines.filter(keep).map((t) => taskRow(t)).join('')
    : `<p class="empty">${routines.length ? '' : '今日のルーティンはありません'}</p>`;

  return `
  <div class="today-head">
    <div class="today-date">${esc(formatJaLong(today))}</div>
    <div class="today-stats">
      <span><b>${doneCount}</b> 完了</span>
      <span>残り <b>${shown.length}</b> 件</span>
      <span>目安 <b>${remainingMin ? `${Math.floor(remainingMin / 60) ? `${Math.floor(remainingMin / 60)}時間` : ''}${remainingMin % 60 ? `${remainingMin % 60}分` : ''}` : '—'}</b>${noDuration ? `<small>（時間未設定 ${noDuration}件）</small>` : ''}</span>
    </div>
    <button type="button" class="mode-btn ${minimal ? 'on' : ''}" data-action="toggle-minimal">${minimal ? '🌙 最低限モード中 ─ 通常に戻す' : '🌙 疲れた日は「最低限モード」'}</button>
  </div>
  ${banners.join('')}
  ${minimal ? `<div class="banner banner-minimal">必須のタスクだけを表示しています。ほかの ${hiddenCount} 件は隠しているだけで、消えていません。${state.tasks.some((t) => t.level === 'must') ? '' : '<br>※「必須」のタスクがまだありません。タスクを開いて優先度を「必須」にすると、ここに表示されます。'}</div>` : ''}
  ${section('今日の重点', focusHtml, { sub: `最大${MAX_FOCUS}つ${focusBalance ? '・' + focusBalance : ''}`, cls: 'sec-focus' })}
  ${overdue.filter(keep).length ? section('予定日を過ぎたもの', `<p class="hint">自動では翌日に回しません。タップして、どうするか選んでください。</p>${overdue.filter(keep).map((t) => taskRow(t, { showDate: true })).join('')}`, { cls: 'sec-overdue' }) : ''}
  ${due.filter(keep).length ? section('今日が予定日', due.filter(keep).map((t) => taskRow(t)).join('')) : ''}
  ${section('今日のルーティン', routineHtml)}
  ${v.doneToday.length ? `<section class="sec"><button type="button" class="sec-toggle" data-action="toggle-done">今日できたこと ${v.doneToday.length} 件 ${ui.showDone ? '▲' : '▼'}</button>${ui.showDone ? v.doneToday.map(doneRow).join('') : ''}</section>` : ''}
  <button type="button" class="fab" data-action="add" data-preset="today" aria-label="タスクを追加">＋</button>`;
}

// ─────────────────────────────── 画面B：ルーティン ───────────────────────────────
function viewRoutines() {
  const tabs = [['daily', '毎日'], ['weekly', '曜日ごと'], ['monthly', '毎月'], ['other', 'その他']];
  const list = state.tasks.filter((t) => ruleGroup(t.rule) === ui.routineTab);
  const row = (t) => `<div class="rt-row">${taskRow(t, { tapAction: 'edit', check: false, star: false, showRule: true })}
    <div class="rt-side"><span class="rt-next">${t.active && t.nextDate ? '次回 ' + esc(formatJa(t.nextDate)) : ''}</span>
    <button type="button" class="mini-btn" data-action="toggle-active" data-id="${t.id}">${t.active ? '⏸ 停止' : '▶ 再開'}</button></div></div>`;
  let body = '';
  if (ui.routineTab === 'daily') {
    body = list.length ? sortTasks(list).map(row).join('') : '<p class="empty">毎日のタスクはありません</p>';
  } else if (ui.routineTab === 'weekly') {
    body = WEEK_ORDER.map((d) => {
      const items = sortTasks(list.filter((t) => t.rule.days.includes(d)));
      return `<h3 class="group-h">${WD_JA[d]}曜日 <small>${items.length}件</small></h3>${items.map(row).join('') || '<p class="empty small">なし</p>'}`;
    }).join('');
  } else if (ui.routineTab === 'monthly') {
    const bands = [[1, 7, '1〜7日'], [8, 14, '8〜14日'], [15, 21, '15〜21日'], [22, 28, '22〜28日'], [29, 31, '29〜31日']];
    const byDay = list.filter((t) => t.rule.type === 'monthlyDay').sort((a, b) => a.rule.day - b.rule.day);
    body = bands.map(([a, b, label]) => {
      const items = byDay.filter((t) => t.rule.day >= a && t.rule.day <= b);
      return items.length ? `<h3 class="group-h">${label}</h3>${items.map(row).join('')}` : '';
    }).join('');
    const nth = list.filter((t) => t.rule.type === 'monthlyNth').sort((a, b) => ((a.rule.nth + 10) % 10) - ((b.rule.nth + 10) % 10) || a.rule.weekday - b.rule.weekday);
    if (nth.length) body += `<h3 class="group-h">第◯曜日</h3>${nth.map(row).join('')}`;
    if (!body) body = '<p class="empty">毎月のタスクはありません</p>';
  } else {
    body = list.length ? list.map(row).join('') : '<p class="empty">間隔指定などのタスクはありません</p>';
  }
  return `<div class="seg" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="${ui.routineTab === k ? 'on' : ''}" data-action="routine-tab" data-v="${k}">${l}</button>`).join('')}</div>
    <p class="hint">タップで編集・削除。⏸で一時停止（予定に出なくなります）。</p>
    ${body}
    <button type="button" class="fab" data-action="add" data-preset="${ui.routineTab}" aria-label="ルーティンを追加">＋</button>`;
}

// ─────────────────────────────── 画面C：すべてのタスク ───────────────────────────────
function filteredTasks() {
  const f = ui.filters;
  const q = f.q.trim().toLowerCase();
  const weekEnd = addDays(startOfWeek(today), 6);
  return state.tasks.filter((t) => {
    if (q && !(t.title.toLowerCase().includes(q) || (t.memo || '').toLowerCase().includes(q))) return false;
    if (f.cat && t.categoryId !== f.cat) return false;
    if (f.freq) {
      const g = t.rule.type === 'none' ? 'none' : ruleGroup(t.rule);
      if (g !== f.freq) return false;
    }
    if (f.status === 'open' && !(t.status === 'open' && t.active && !t.needsReview)) return false;
    if (f.status === 'done' && t.status === 'open') return false;
    if (f.status === 'paused' && t.active) return false;
    if (f.status === 'review' && !t.needsReview) return false;
    if (f.when === 'overdue' && !(t.status === 'open' && t.nextDate && t.nextDate < today)) return false;
    if (f.when === 'today' && t.nextDate !== today) return false;
    if (f.when === 'week' && !(t.nextDate && t.nextDate >= today && t.nextDate <= weekEnd)) return false;
    if (f.when === 'nodate' && t.nextDate) return false;
    return true;
  }).sort((a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999') || a.title.localeCompare(b.title, 'ja'));
}

function allListHtml() {
  const list = filteredTasks();
  return `<p class="count">${list.length} 件</p>` + (list.map((t) => taskRow(t, { showDate: true, tapAction: 'edit', star: false })).join('') || '<p class="empty">該当するタスクはありません</p>');
}

function viewAll() {
  const f = ui.filters;
  const sel = (name, opts) => `<select data-filter="${name}">${opts.map(([v, l]) => `<option value="${v}" ${f[name] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="search"><input type="search" placeholder="🔍 タスク名・メモで検索" value="${esc(f.q)}" data-filter="q" enterkeyhint="search"></div>
  <div class="filters">
    <select data-filter="cat">${catOptions(f.cat, { blank: '分類：すべて' })}</select>
    ${sel('freq', [['', '頻度：すべて'], ['none', '単発'], ['daily', '毎日'], ['weekly', '曜日ごと'], ['monthly', '毎月'], ['other', 'その他']])}
    ${sel('status', [['open', '状態：予定中'], ['', '状態：すべて'], ['done', '完了・スキップ済み'], ['paused', '一時停止中'], ['review', '要確認']])}
    ${sel('when', [['', '実施日：すべて'], ['overdue', '過ぎたもの'], ['today', '今日'], ['week', '今週'], ['nodate', '日付なし']])}
  </div>
  <div id="all-list">${allListHtml()}</div>
  <button type="button" class="fab" data-action="add" data-preset="none" aria-label="タスクを追加">＋</button>`;
}

// ─────────────────────────────── 画面D：カレンダー ───────────────────────────────
function plannedOn(day) {
  const out = [];
  for (const t of state.tasks) {
    if (!isScheduledOpen(t)) continue;
    if (t.nextDate === day) out.push(t);
    else if (isRecurring(t.rule) && day > t.nextDate && day >= today && occursOn(t.rule, day)) out.push(t);
  }
  return sortTasks(out);
}

function historyIn(from, to) {
  return state.history.filter((h) => h.date >= from && h.date <= to);
}

function dayBlock(day) {
  const planned = plannedOn(day);
  const hist = historyIn(day, day);
  const daily = planned.filter((t) => isRoutine(t.rule) && t.rule.type === 'daily');
  const others = planned.filter((t) => !(isRoutine(t.rule) && t.rule.type === 'daily'));
  const mark = { done: '✓', skipped: '⤼', postponed: '→', moved: '→' };
  const items = [
    ...hist.map((h) => `<li class="h-${h.action}">${mark[h.action]} ${esc(h.title)}${h.toDate ? ` <small>（${esc(formatJa(h.toDate, false))}へ）</small>` : ''}</li>`),
    ...others.map((t) => `<li class="${t.nextDate < today ? 'overdue-txt' : ''}" style="--c:${esc(categoryOf(state, t).color)}"><span class="dot"></span>${esc(t.title)}${t.nextDate < today ? ' <small>（未処理）</small>' : ''}</li>`),
  ];
  if (daily.length) items.push(`<li class="muted">毎日のルーティン ${daily.length} 件</li>`);
  return `<div class="day ${day === today ? 'is-today' : ''}"><div class="day-h">${esc(formatJa(day))}${day === today ? ' <span class="chip">今日</span>' : ''}</div>
    ${items.length ? `<ul class="day-list">${items.join('')}</ul>` : '<p class="empty small">予定なし</p>'}</div>`;
}

function summaryHtml(from, to, label) {
  const hist = historyIn(from, to);
  const done = hist.filter((h) => h.action === 'done');
  const moved = hist.filter((h) => h.action === 'postponed' || h.action === 'moved');
  const skipped = hist.filter((h) => h.action === 'skipped');
  const byCat = {};
  for (const h of done) {
    const c = state.categories.find((x) => x.id === h.categoryId);
    const k = c ? c.name : '（削除済みの分類）';
    byCat[k] = (byCat[k] || 0) + 1;
  }
  const work = done.filter((h) => state.categories.find((c) => c.id === h.categoryId)?.kind === 'work').length;
  return `<div class="summary">
    <h3>${label}できたこと <b>${done.length}</b> 件 <small>（仕事 ${work}・暮らし ${done.length - work}）</small></h3>
    ${Object.keys(byCat).length ? `<p class="cat-counts">${Object.entries(byCat).map(([k, n]) => `${esc(k)} ${n}`).join('　')}</p>` : ''}
    ${moved.length ? `<h3>先に回したこと ${moved.length} 件</h3><ul class="day-list">${moved.map((h) => `<li>→ ${esc(h.title)} <small>${esc(formatJa(h.scheduled || h.date, false))} → ${esc(formatJa(h.toDate, false))}</small></li>`).join('')}</ul>` : ''}
    ${skipped.length ? `<h3>スキップしたこと ${skipped.length} 件</h3><ul class="day-list">${skipped.map((h) => `<li>⤼ ${esc(h.title)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function viewCalendar() {
  if (!ui.calCursor) ui.calCursor = today;
  const seg = `<div class="seg">${[['week', '週'], ['month', '月']].map(([k, l]) => `<button type="button" class="${ui.calMode === k ? 'on' : ''}" data-action="cal-mode" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (ui.calMode === 'week') {
    const ws = startOfWeek(ui.calCursor);
    const we = addDays(ws, 6);
    const thisWeek = ws === startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    return `${seg}<div class="cal-nav"><button type="button" data-action="cal-move" data-v="-1" aria-label="前の週">‹</button>
      <span>${esc(formatJa(ws, false))} 〜 ${esc(formatJa(we, false))}${thisWeek ? '（今週）' : ''}</span>
      <button type="button" data-action="cal-move" data-v="1" aria-label="次の週">›</button></div>
      ${thisWeek ? '' : '<button type="button" class="link-btn center" data-action="cal-today">今週に戻る</button>'}
      ${we >= addDays(today, -60) && ws <= today ? summaryHtml(ws, we, thisWeek ? '今週' : 'この週') : ''}
      ${days.map(dayBlock).join('')}`;
  }
  const ms = startOfMonth(ui.calCursor);
  const { y, m } = parts(ms);
  const dim = daysInMonth(y, m);
  const me = `${y}-${pad(m)}-${pad(dim)}`;
  const lead = (weekday(ms) + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="mc empty-cell"></div>');
  for (let d = 1; d <= dim; d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    const planned = plannedOn(k).filter((t) => !(t.rule.type === 'daily'));
    const done = historyIn(k, k).filter((h) => h.action === 'done').length;
    cells.push(`<button type="button" class="mc ${k === today ? 'is-today' : ''} ${k === ui.calSelected ? 'sel' : ''}" data-action="cal-select" data-v="${k}">
      <span class="mc-d">${d}</span>
      ${planned.length ? `<span class="mc-p">${planned.slice(0, 3).map((t) => `<i style="background:${esc(categoryOf(state, t).color)}"></i>`).join('')}${planned.length > 3 ? '+' : ''}</span>` : ''}
      ${done ? `<span class="mc-done">✓${done}</span>` : ''}</button>`);
  }
  const thisMonth = ms === startOfMonth(today);
  return `${seg}<div class="cal-nav"><button type="button" data-action="cal-move" data-v="-1" aria-label="前の月">‹</button>
    <span>${y}年${m}月${thisMonth ? '（今月）' : ''}</span>
    <button type="button" data-action="cal-move" data-v="1" aria-label="次の月">›</button></div>
    <div class="mgrid">${WEEK_ORDER.map((d) => `<div class="mh">${WD_JA[d]}</div>`).join('')}${cells.join('')}</div>
    <p class="hint">● 予定（毎日のルーティン以外）　✓ 完了数。日付をタップすると詳細を表示します。</p>
    ${ui.calSelected && ui.calSelected >= ms && ui.calSelected <= me ? dayBlock(ui.calSelected) : ''}
    ${ms <= today ? summaryHtml(ms, me, thisMonth ? '今月' : 'この月') : ''}`;
}

// ─────────────────────────────── 画面E：設定・データ管理 ───────────────────────────────
function viewSettings() {
  const age = backupAgeDays(state, today);
  const cats = sortedCategories(state).map((c, i, arr) => `<div class="cat-row">
      <input type="color" value="${esc(c.color)}" data-cat="${c.id}" data-field="color" aria-label="色">
      <input type="text" value="${esc(c.name)}" data-cat="${c.id}" data-field="name" aria-label="分類名">
      <select data-cat="${c.id}" data-field="kind"><option value="private" ${c.kind !== 'work' ? 'selected' : ''}>暮らし</option><option value="work" ${c.kind === 'work' ? 'selected' : ''}>💼 仕事</option></select>
      <button type="button" class="mini-btn" data-action="cat-up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
      <button type="button" class="mini-btn" data-action="cat-down" data-id="${c.id}" ${i === arr.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
      <button type="button" class="mini-btn danger" data-action="cat-delete" data-id="${c.id}" aria-label="削除">🗑</button>
    </div>`).join('');
  return `
  <section class="sec card">
    <h2>データの保存状態</h2>
    <dl class="kv" id="storage-info">
      <dt>保存場所</dt><dd>このiPhoneの中（このアプリ専用の保存領域）。サーバーには送っていません。</dd>
      <dt>開き方</dt><dd>${standalone ? '✅ ホーム画面のアプリとして起動中' : '⚠️ Safariのタブで開いています（ホーム画面のアプリとはデータが別です）'}</dd>
      <dt>タスク／完了履歴</dt><dd>${state.tasks.length} 件／${state.history.length} 件</dd>
      <dt>最後に保存</dt><dd>${lastSavedAt ? esc(lastSavedAt.toLocaleString('ja-JP')) : '—'}${saveError ? ' <b class="overdue-txt">（保存エラーあり）</b>' : ''}</dd>
      <dt>最後のバックアップ</dt><dd>${state.settings.lastBackupAt ? `${esc(new Date(state.settings.lastBackupAt).toLocaleString('ja-JP'))}（${age}日前）` : '<b class="overdue-txt">まだありません</b>'}</dd>
      <dt>自動削除の防止</dt><dd data-slot="persist">確認中…</dd>
      <dt>使用量</dt><dd data-slot="usage">確認中…</dd>
    </dl>
    <p class="hint">iPhoneの中だけに保存しているため、<b>アプリをホーム画面から削除したとき・機種変更・故障・Safariのデータ消去</b>でデータが消えます。週に1回ほど、下の「バックアップを保存」で iCloud Drive に保存してください。</p>
  </section>

  <section class="sec card">
    <h2>バックアップと復元</h2>
    <button type="button" class="btn primary" data-action="backup">💾 バックアップを保存</button>
    <p class="hint">共有の画面が開いたら「"ファイル"に保存」→「iCloud Drive」を選んでください。</p>
    <button type="button" class="btn" data-action="restore">↩️ バックアップから復元</button>
    <button type="button" class="btn" data-action="snapshots">🗂 端末内の自動控え（7日分）</button>
  </section>

  <section class="sec card">
    <h2>取り込み・書き出し</h2>
    <button type="button" class="btn" data-action="import">📥 ファイルから取り込む</button>
    <p class="hint">TodoistのCSV（テンプレートとしてエクスポートしたもの）や、取り込み用JSONに対応しています。取り込む前に確認画面が出ます。同じタスクは二重に登録されません。</p>
    <button type="button" class="btn" data-action="export-tasks">📤 タスク一覧をCSVで書き出す</button>
    <button type="button" class="btn" data-action="export-history">📤 完了履歴をCSVで書き出す</button>
  </section>

  <section class="sec card">
    <h2>分類の編集</h2>
    <p class="hint">「💼 仕事」にした分類は、青い印で暮らしのタスクと区別して表示します。</p>
    <div class="cats">${cats}</div>
    <div class="cat-add"><input type="text" id="new-cat" placeholder="新しい分類名"><button type="button" class="btn small" data-action="cat-add">追加</button></div>
  </section>

  <section class="sec card">
    <h2>基本設定</h2>
    <label class="field"><span>アプリの名前</span><input type="text" id="app-name" value="${esc(state.settings.appName)}"></label>
    <label class="field"><span>バックアップのお知らせ（日数）</span><input type="number" id="backup-days" min="1" max="60" value="${esc(state.settings.backupReminderDays || 7)}" inputmode="numeric"></label>
    <button type="button" class="btn small" data-action="save-settings">保存</button>
    <p class="hint">ホーム画面のアイコン下の名前は、ホーム画面に追加するときに決まります（あとで変えるには、追加し直す必要があります）。</p>
  </section>
  <p class="version">バージョン ${APP_VERSION}</p>`;
}

async function fillStorageInfo() {
  const box = $('#storage-info');
  if (!box) return;
  const info = await storageInfo();
  const p = box.querySelector('[data-slot="persist"]');
  const u = box.querySelector('[data-slot="usage"]');
  if (p) p.textContent = info.persisted === true ? '✅ 許可されています（ブラウザが容量整理で自動削除しない設定）' : info.persisted === false ? '未許可（ホーム画面から開くと許可されやすくなります）。バックアップを必ず取ってください' : 'この環境では確認できません';
  if (u) u.textContent = info.usage != null ? `${(info.usage / 1024 / 1024).toFixed(2)} MB 使用中` : '確認できません';
}

// ─────────────────────────────── 描画 ───────────────────────────────
const TITLES = { today: '今日', routines: 'ルーティン', all: 'すべてのタスク', calendar: 'カレンダー', settings: '設定・データ' };

function render() {
  if (!state) return;
  document.title = state.settings.appName;
  $('#topbar').innerHTML = `<div class="app-name">${esc(state.settings.appName)}</div><h1>${TITLES[tab]}</h1>`;
  const views = { today: viewToday, routines: viewRoutines, all: viewAll, calendar: viewCalendar, settings: viewSettings };
  const scroll = window.scrollY;
  $('#view').innerHTML = views[tab]();
  window.scrollTo(0, scroll);
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'settings') fillStorageInfo();
}

function goTab(t) {
  tab = t;
  window.scrollTo(0, 0);
  render();
}

// ─────────────────────────────── 操作：タスク ───────────────────────────────
function doComplete(id) {
  const t = findTask(state, id);
  if (!t) return;
  const h = commit((s) => completeTask(s, id, today));
  if (h) toast(`「${t.title}」完了`, { action: '取り消す', onAction: () => commit((s) => undoHistory(s, h.id)) });
}

function doFocus(id) {
  const r = commit((s) => toggleFocus(s, today, id));
  if (r && !r.ok) toast(r.reason + '。ほかの重点を外してから選んでください。');
}

function openTaskMenu(id) {
  const t = findTask(state, id);
  if (!t) return;
  const rec = isRecurring(t.rule);
  const overdue = t.nextDate && t.nextDate < today;
  const focused = focusIds(state, today).includes(id);
  const nextPreview = rec && t.nextDate ? nextAfter(t.rule, t.nextDate, addDays(today, 1)) : null;
  const skipPreview = rec && t.nextDate ? nextAfter(t.rule, t.nextDate, today) : null;
  openSheet(`
    <div class="sheet-h"><div class="sheet-title">${esc(t.title)}</div>
      <div class="task-meta">${catChip(t)}${levelChip(t)}<span class="meta-txt">${esc(describe(t.rule))}</span>${t.nextDate ? `<span class="meta-txt">予定 ${esc(formatJa(t.nextDate))}</span>` : ''}</div>
      ${t.memo ? `<p class="memo">${esc(t.memo)}</p>` : ''}
      ${overdue ? `<p class="notice">予定日を過ぎています。どうするか選んでください。</p>` : ''}</div>
    <div class="menu">
      ${t.status === 'open' && t.active && !t.needsReview ? '<button type="button" data-m="complete">✓ 完了にする</button>' : ''}
      ${t.status === 'open' ? `<button type="button" data-m="focus">${focused ? '☆ 今日の重点から外す' : '★ 今日の重点にする'}</button>` : ''}
      ${rec && t.status === 'open' && t.active && !t.needsReview ? `<button type="button" data-m="postpone">⏭ 次の予定日に実施する <small>→ ${esc(formatJa(nextPreview))}</small></button>` : ''}
      ${t.status === 'open' && t.active && !t.needsReview ? '<button type="button" data-m="move">📅 別の日に変更する</button>' : ''}
      ${t.status === 'open' && t.active && !t.needsReview ? `<button type="button" data-m="skip">⤼ 今回はスキップする ${rec ? `<small>→ 次回 ${esc(formatJa(skipPreview))}</small>` : '<small>（やらないことにする）</small>'}</button>` : ''}
      <button type="button" data-m="edit">✎ 必要性を見直す・編集 <small>（一時停止・削除もここ）</small></button>
      <div class="move-box" hidden>
        <input type="date" class="move-date" value="${esc(addDays(today, 1))}" min="${esc(today)}">
        <div class="row"><button type="button" class="btn small" data-m="move-tomorrow">明日</button><button type="button" class="btn small" data-m="move-week">1週間後</button><button type="button" class="btn small primary" data-m="move-ok">この日にする</button></div>
      </div>
      <button type="button" class="cancel" data-m="close">閉じる</button>
    </div>`, {
    onMount(sheet) {
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        const m = b.dataset.m;
        const doMove = (date) => {
          if (!date || date < today) { toast('今日以降の日付を選んでください', { error: true }); return; }
          closeSheet();
          commit((s) => moveTo(s, id, date, today));
          toast(`「${t.title}」を ${formatJa(date)} に変更しました`);
        };
        if (m === 'close') closeSheet();
        else if (m === 'complete') { closeSheet(); doComplete(id); }
        else if (m === 'focus') { closeSheet(); doFocus(id); }
        else if (m === 'postpone') {
          closeSheet();
          const h = commit((s) => postponeToNext(s, id, today));
          if (h) toast(`次回（${formatJa(h.toDate)}）に実施します`, { action: '取り消す', onAction: () => commit((s) => undoHistory(s, h.id)) });
        } else if (m === 'move') sheet.querySelector('.move-box').hidden = false;
        else if (m === 'move-tomorrow') doMove(addDays(today, 1));
        else if (m === 'move-week') doMove(addDays(today, 7));
        else if (m === 'move-ok') doMove(sheet.querySelector('.move-date').value);
        else if (m === 'skip') {
          closeSheet();
          const h = commit((s) => skipTask(s, id, today));
          if (h) toast(`「${t.title}」を今回スキップしました`, { action: '取り消す', onAction: () => commit((s) => undoHistory(s, h.id)) });
        } else if (m === 'edit') { closeSheet(); openEditor(id); }
      });
    },
  });
}

function openFocusPicker() {
  const v = todayView(state, today);
  const focus = new Set(v.focus);
  const doneIds = new Set(v.doneToday.map((h) => h.taskId));
  const todays = sortTasks([...v.overdue, ...v.dueToday, ...v.routines]).filter((t) => !focus.has(t.id) && !doneIds.has(t.id));
  const later = state.tasks.filter((t) => t.status === 'open' && t.active && !t.needsReview && !focus.has(t.id) && (!t.nextDate || (t.nextDate > today && t.nextDate <= addDays(today, 14))));
  const item = (t) => `<button type="button" class="pick ${categoryOf(state, t).kind === 'work' ? 'kind-work' : 'kind-private'}" style="--c:${esc(categoryOf(state, t).color)}" data-pick="${t.id}">
      <span class="task-title">${esc(t.title)}</span><span class="task-meta">${catChip(t)}${t.nextDate && t.nextDate !== today ? `<span class="meta-txt">${esc(relativeJa(t.nextDate, today))}</span>` : ''}</span></button>`;
  openSheet(`<div class="sheet-h"><div class="sheet-title">今日の重点を選ぶ</div><p class="hint">大切なことを${MAX_FOCUS}つまで。仕事だけでなく、暮らしのことも選べます。</p></div>
    <div class="pick-list">
      <h3 class="group-h">今日のタスク</h3>${todays.map(item).join('') || '<p class="empty small">なし</p>'}
      ${later.length ? `<h3 class="group-h">近日・日付なしのタスク</h3>${later.map(item).join('')}` : ''}
      <button type="button" class="btn" data-pick="__new">＋ 新しいタスクを作って重点にする</button>
    </div><button type="button" class="cancel" data-pick="__close">閉じる</button>`, {
    full: true,
    onMount(sheet) {
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        const id = b.dataset.pick;
        closeSheet();
        if (id === '__close') return;
        if (id === '__new') { openEditor(null, { preset: 'today', focusAfter: true }); return; }
        doFocus(id);
      });
    },
  });
}

// ─── タスクの編集画面 ───
function ruleFieldsHtml(rule, nextDate) {
  const r = rule || { type: 'none' };
  switch (r.type) {
    case 'weekly':
      return `<div class="field"><span>曜日</span><div class="wd-chips">${WEEK_ORDER.map((d) => `<label class="wd"><input type="checkbox" name="wd" value="${d}" ${r.days?.includes(d) ? 'checked' : ''}><span>${WD_JA[d]}</span></label>`).join('')}</div></div>`;
    case 'monthlyDay':
      return `<label class="field"><span>毎月の日付</span><select name="mday">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${r.day === d ? 'selected' : ''}>${d}日</option>`).join('')}</select></label>
        <p class="hint">29〜31日を選んだ場合、その日が無い月は<b>月末</b>に実施します（翌月以降は元の日付に戻ります）。</p>`;
    case 'monthlyNth':
      return `<div class="field"><span>毎月の</span><div class="row"><select name="nth">${[[1, '第1'], [2, '第2'], [3, '第3'], [4, '第4'], [-1, '最終']].map(([v, l]) => `<option value="${v}" ${r.nth === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select name="nwd">${WEEK_ORDER.map((d) => `<option value="${d}" ${r.weekday === d ? 'selected' : ''}>${WD_JA[d]}曜日</option>`).join('')}</select></div></div>`;
    case 'interval':
      return `<div class="field"><span>間隔</span><div class="row"><input type="number" name="every" min="1" max="366" value="${r.every || 2}" inputmode="numeric">
        <select name="unit">${[['day', '日ごと'], ['week', '週間ごと'], ['month', 'か月ごと']].map(([v, l]) => `<option value="${v}" ${r.unit === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <label class="field"><span>基準日（この日から数えます）</span><input type="date" name="anchor" value="${esc(r.anchor || nextDate || today)}"></label>`;
    case 'unknown':
      return `<p class="notice">元の繰り返し設定「${esc(r.raw || '不明')}」を解釈できませんでした。上の「繰り返し」から正しい設定を選んで保存すると、予定に表示されるようになります。</p>`;
  }
  return '';
}

function readRule(form, prevRule) {
  const type = form.elements.rtype.value;
  switch (type) {
    case 'none': return { type: 'none' };
    case 'daily': return { type: 'daily' };
    case 'weekly': return { type: 'weekly', days: [...form.querySelectorAll('input[name="wd"]:checked')].map((x) => Number(x.value)) };
    case 'monthlyDay': return { type: 'monthlyDay', day: Number(form.elements.mday.value) };
    case 'monthlyNth': return { type: 'monthlyNth', nth: Number(form.elements.nth.value), weekday: Number(form.elements.nwd.value) };
    case 'interval': return { type: 'interval', every: Number(form.elements.every.value), unit: form.elements.unit.value, anchor: form.elements.anchor.value };
    case 'unknown': return prevRule;
  }
  return { type: 'none' };
}

function presetFor(kind) {
  const wd = weekday(today);
  switch (kind) {
    case 'today': return { rule: { type: 'none' }, nextDate: today };
    case 'daily': return { rule: { type: 'daily' }, nextDate: '' };
    case 'weekly': return { rule: { type: 'weekly', days: [wd] }, nextDate: '' };
    case 'monthly': return { rule: { type: 'monthlyDay', day: parts(today).d }, nextDate: '' };
    case 'other': return { rule: { type: 'interval', every: 2, unit: 'week', anchor: today }, nextDate: '' };
    default: return { rule: { type: 'none' }, nextDate: '' };
  }
}

function openEditor(id, { preset, focusAfter } = {}) {
  const t = id ? findTask(state, id) : null;
  const p = presetFor(preset);
  const d = t ? { ...t } : { title: '', categoryId: otherCategoryId(state), rule: p.rule, nextDate: p.nextDate, duration: null, level: 'normal', memo: '', active: true };
  let currentRule = d.rule;
  const ruleTypes = [['none', '単発（繰り返さない）'], ['daily', '毎日'], ['weekly', '毎週（曜日を指定）'], ['monthlyDay', '毎月（日付を指定）'], ['monthlyNth', '毎月（第◯◯曜日）'], ['interval', '間隔を指定（◯日・週・か月ごと）']];
  if (d.rule.type === 'unknown') ruleTypes.unshift(['unknown', '要確認（未設定）']);
  openSheet(`<form class="editor" novalidate>
    <div class="sheet-h"><div class="sheet-title">${t ? 'タスクを編集' : 'タスクを追加'}</div></div>
    ${t?.needsReview ? `<p class="notice">要確認のタスクです。${esc(t.reviewNote || '')}</p>` : ''}
    <label class="field"><span>タスク名</span><input type="text" name="title" value="${esc(d.title)}" required enterkeyhint="done"></label>
    <label class="field"><span>分類</span><select name="categoryId">${catOptions(d.categoryId)}</select></label>
    <label class="field"><span>繰り返し</span><select name="rtype">${ruleTypes.map(([v, l]) => `<option value="${v}" ${d.rule.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="rule-fields">${ruleFieldsHtml(d.rule, d.nextDate)}</div>
    <label class="field"><span class="date-label">${isRecurring(d.rule) ? '次回実施日（空欄なら自動で計算）' : '実施日（空欄なら日付なし）'}</span><input type="date" name="nextDate" value="${esc(d.nextDate || '')}"></label>
    <div class="row2">
      <label class="field"><span>所要時間（分）</span><input type="number" name="duration" min="0" max="1440" inputmode="numeric" value="${d.duration ?? ''}"></label>
      <div class="field"><span>優先度</span><div class="seg seg-sm">${Object.entries(LEVELS).map(([k, l]) => `<label><input type="radio" name="level" value="${k}" ${d.level === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    </div>
    <p class="hint">「必須」にしたタスクは、最低限モードでも表示されます。</p>
    <label class="field"><span>メモ</span><textarea name="memo" rows="3">${esc(d.memo || '')}</textarea></label>
    ${t ? `<label class="switch"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}><span>有効（オフにすると一時停止して予定に出なくなります）</span></label>` : ''}
    <div class="form-err" role="alert"></div>
    <div class="row sticky-actions">
      <button type="button" class="btn" data-e="cancel">キャンセル</button>
      <button type="submit" class="btn primary">保存</button>
    </div>
    ${t ? `<button type="button" class="btn danger" data-e="delete">このタスクを削除</button>
      ${t.origin ? `<p class="hint">移行元: ${esc(t.origin)}</p>` : ''}` : ''}
  </form>`, {
    full: true,
    onMount(sheet) {
      const form = sheet.querySelector('form');
      if (!t) setTimeout(() => form.elements.title.focus(), 50);
      form.elements.rtype.addEventListener('change', () => {
        const type = form.elements.rtype.value;
        const base = type === currentRule.type ? currentRule : presetFor({ daily: 'daily', weekly: 'weekly', monthlyDay: 'monthly', interval: 'other' }[type] || 'none').rule;
        if (type === 'monthlyNth') Object.assign(base, { type: 'monthlyNth', nth: 1, weekday: weekday(today) });
        sheet.querySelector('.rule-fields').innerHTML = ruleFieldsHtml(type === 'unknown' ? d.rule : base, form.elements.nextDate.value);
        sheet.querySelector('.date-label').textContent = type === 'none' || type === 'unknown' ? '実施日（空欄なら日付なし）' : '次回実施日（空欄なら自動で計算）';
        // 繰り返しを変えたら次回日は空欄に戻し、新しい繰り返しで自動計算する
        if (type !== 'none' && type !== 'unknown' && (!t || JSON.stringify(t.rule) !== JSON.stringify(base))) form.elements.nextDate.value = '';
      });
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('[data-e]');
        if (!b) return;
        if (b.dataset.e === 'cancel') closeSheet();
        if (b.dataset.e === 'delete') {
          if (!confirm(`「${t.title}」を削除します。\n（これまでの完了履歴は残ります）\nよろしいですか？`)) return;
          closeSheet();
          commit((s) => deleteTask(s, t.id));
          toast('削除しました');
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const rule = readRule(form, d.rule);
        currentRule = rule;
        const input = {
          title: form.elements.title.value,
          categoryId: form.elements.categoryId.value,
          rule,
          nextDate: form.elements.nextDate.value || null,
          duration: form.elements.duration.value,
          level: form.querySelector('input[name="level"]:checked')?.value || 'normal',
          memo: form.elements.memo.value,
          active: t ? form.elements.active.checked : true,
          needsReview: false,
        };
        let res;
        try {
          res = t ? updateTask(state, t.id, input, today) : addTask(state, input, today);
        } catch (err) { res = { errors: [err.message] }; }
        if (res.errors?.length) { sheet.querySelector('.form-err').textContent = res.errors.join(' / '); return; }
        if (t && res.task.reviewNote && !res.task.needsReview) delete res.task.reviewNote;
        if (focusAfter) toggleFocus(state, today, res.task.id);
        closeSheet();
        render();
        persist();
        toast(t ? '保存しました' : `「${res.task.title}」を追加しました`);
      });
    },
  });
}

// ─────────────────────────────── 操作：データ ───────────────────────────────
async function doBackup() {
  const name = `kurashi-todo-backup-${today}.json`;
  let res;
  try {
    res = await saveFile(name, JSON.stringify(makeBackup(state), null, 1), 'application/json');
  } catch (e) { toast('バックアップを作れませんでした: ' + e.message, { error: true }); return; }
  if (res === 'cancelled') { toast('バックアップの保存を取りやめました'); return; }
  state.settings.lastBackupAt = new Date().toISOString();
  render();
  await persist();
  toast(res === 'shared' ? 'バックアップを書き出しました（保存先を選んだ場所に保存されます）' : 'バックアップをダウンロードしました');
}

async function doExport(kind) {
  const csv = kind === 'tasks' ? tasksToCsv(state) : historyToCsv(state);
  const name = kind === 'tasks' ? `kurashi-todo-tasks-${today}.csv` : `kurashi-todo-history-${today}.csv`;
  try { await saveFile(name, csv, 'text/csv'); } catch (e) { toast('書き出せませんでした: ' + e.message, { error: true }); }
}

function openRestoreConfirm(backupObj, sourceLabel) {
  const r = readBackup(backupObj);
  if (r.error) { toast(r.error, { error: true }); return; }
  openSheet(`<div class="sheet-h"><div class="sheet-title">バックアップから復元</div></div>
    <dl class="kv"><dt>復元するデータ</dt><dd>${esc(sourceLabel)}${r.exportedAt ? `（${esc(new Date(r.exportedAt).toLocaleString('ja-JP'))} 保存）` : ''}</dd>
    <dt>その中身</dt><dd>タスク ${r.state.tasks.length} 件・完了履歴 ${r.state.history.length} 件</dd>
    <dt>今のデータ</dt><dd>タスク ${state.tasks.length} 件・完了履歴 ${state.history.length} 件</dd></dl>
    <p class="notice">今のデータは、復元したデータに<b>置き換わります</b>。念のため、今のデータは端末内の自動控えに残します。</p>
    <div class="row"><button type="button" class="btn" data-r="no">やめる</button><button type="button" class="btn primary" data-r="yes">復元する</button></div>`, {
    onMount(sheet) {
      sheet.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        closeSheet();
        if (b.dataset.r !== 'yes') return;
        try {
          await saveSnapshot(state, `復元前-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        } catch (err) {
          toast('今のデータの控えを作れなかったため、復元を中止しました: ' + err.message, { error: true });
          return;
        }
        delete r.state.savedDay; delete r.state.savedAt;
        state = r.state;
        rollover(state, today);
        render();
        await persist();
        toast('復元しました');
      });
    },
  });
}

async function doRestore() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  if (f.error) { toast('ファイルを読めませんでした', { error: true }); return; }
  let obj;
  try { obj = JSON.parse(f.text.replace(/^﻿/, '')); } catch { toast('バックアップファイルを読み取れませんでした（壊れているか、別のファイルです）', { error: true }); return; }
  openRestoreConfirm(obj, f.name);
}

async function openSnapshots() {
  let list;
  try { list = await listSnapshots(); } catch (e) { toast('控えを読み込めませんでした: ' + e.message, { error: true }); return; }
  openSheet(`<div class="sheet-h"><div class="sheet-title">端末内の自動控え</div>
    <p class="hint">日付が変わったとき（最大7日分）と、復元の直前に自動で残しています。間違えて消したときなどに戻せます。<br>※iPhone本体の中にあるため、機種変更や故障には備えられません。</p></div>
    ${list.length ? list.map((s) => `<div class="snap"><div><b>${esc(s.label)}</b><br><small>${s.savedAt ? esc(new Date(s.savedAt).toLocaleString('ja-JP')) : ''}・タスク ${s.tasks} 件・履歴 ${s.history} 件</small></div>
      <button type="button" class="btn small" data-snap="${esc(s.key)}">この状態に戻す</button></div>`).join('') : '<p class="empty">まだ控えはありません（明日以降に作られます）</p>'}
    <button type="button" class="cancel" data-snap="__close">閉じる</button>`, {
    full: true,
    onMount(sheet) {
      sheet.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-snap]');
        if (!b) return;
        closeSheet();
        if (b.dataset.snap === '__close') return;
        const snap = await loadSnapshot(b.dataset.snap);
        if (!snap) { toast('控えが見つかりません', { error: true }); return; }
        openRestoreConfirm(makeBackup(snap), `自動控え ${b.dataset.snap.replace('snapshot:', '')}`);
      });
    },
  });
}

async function doImport() {
  const f = await pickFile('.csv,.json,text/csv,application/json');
  if (!f) return;
  if (f.error) { toast('ファイルを読めませんでした', { error: true }); return; }
  let src;
  try { src = readImportFile(f.name, f.text, today); } catch (e) { toast('取り込みの準備でエラー: ' + e.message, { error: true }); return; }
  if (src.isBackup) {
    toast('これはバックアップファイルです。「バックアップから復元」の確認画面を開きます。');
    openRestoreConfirm(src.backup, f.name);
    return;
  }
  if (src.error) { toast(src.warnings[0] || '対応していないファイルです', { error: true }); return; }
  openImportPreview(buildPreview(state, src), f.name);
}

function openImportPreview(preview, fileName) {
  const STATUS = { new: ['新規', 'st-new'], duplicate: ['重複（登録しません）', 'st-dup'], similar: ['重複候補', 'st-sim'], review: ['要確認', 'st-rev'], error: ['エラー', 'st-err'] };
  const count = (s) => preview.rows.filter((r) => r.status === s).length;
  const rowsHtml = () => preview.rows.map((r) => {
    if (r.status === 'error') return `<div class="imp-row st-err"><b>エラー</b> ${esc(r.message)}</div>`;
    const it = r.item;
    return `<div class="imp-row ${STATUS[r.status][1]}">
      <label class="imp-check"><input type="checkbox" data-inc="${r.idx}" ${r.include ? 'checked' : ''} ${r.status === 'duplicate' ? 'disabled' : ''}>
        <span><b>${esc(it.title)}</b><br><small>${esc(describe(it.rule))}${it.nextDate ? `・${esc(formatJa(it.nextDate))}` : ''}${it.origin ? `・元: ${esc(it.origin)}` : ''}</small></span></label>
      <span class="chip ${STATUS[r.status][1]}">${STATUS[r.status][0]}</span>
      ${r.message ? `<p class="imp-msg">${esc(r.message)}</p>` : ''}
      ${it.issues?.length ? `<p class="imp-msg">未対応: ${esc(it.issues.join('、'))}</p>` : ''}
      ${r.categoryMissing ? `<p class="imp-msg">分類「${esc(it.categoryName)}」が無いため、選び直してください</p>` : ''}
      ${it.memo ? `<p class="imp-memo">${esc(it.memo)}</p>` : ''}
      ${r.status !== 'duplicate' ? `<select data-cat-row="${r.idx}">${catOptions(r.categoryId)}</select>` : ''}
    </div>`;
  }).join('');
  openSheet(`<div class="sheet-h"><div class="sheet-title">取り込みの確認</div>
      <p class="hint">${esc(preview.sourceLabel || fileName)}</p>
      ${preview.note ? `<p class="hint">${esc(preview.note)}</p>` : ''}
      <div class="imp-sum"><span>元データ <b>${preview.sourceCount}</b></span><span>新規 <b>${count('new')}</b></span><span>要確認 <b>${count('review')}</b></span><span>重複 <b>${count('duplicate')}</b></span><span>重複候補 <b>${count('similar')}</b></span>${count('error') ? `<span>エラー <b>${count('error')}</b></span>` : ''}</div>
      ${preview.warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join('')}
      <p class="hint">チェックを外したものは取り込みません。「要確認」は登録しますが、繰り返し設定を直すまで予定には出ません。重複候補は、チェックを入れたときだけ登録します。</p></div>
    <div class="imp-list">${rowsHtml()}</div>
    <div class="row sticky-actions"><button type="button" class="btn" data-i="cancel">やめる</button><button type="button" class="btn primary" data-i="go">取り込む（<span class="imp-n"></span>件）</button></div>`, {
    full: true,
    onMount(sheet) {
      const upd = () => { sheet.querySelector('.imp-n').textContent = preview.rows.filter((r) => r.include && r.status !== 'duplicate' && r.status !== 'error').length; };
      upd();
      sheet.addEventListener('change', (e) => {
        const inc = e.target.closest('[data-inc]');
        if (inc) { preview.rows.find((r) => r.idx === Number(inc.dataset.inc)).include = inc.checked; upd(); }
        const cs = e.target.closest('[data-cat-row]');
        if (cs) { const r = preview.rows.find((x) => x.idx === Number(cs.dataset.catRow)); r.categoryId = cs.value; r.categoryMissing = false; }
      });
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b) return;
        if (b.dataset.i === 'cancel') { closeSheet(); return; }
        closeSheet();
        const result = commit((s) => applyImport(s, preview, today));
        if (!result) return;
        openSheet(`<div class="sheet-h"><div class="sheet-title">取り込みが完了しました</div></div>
          <dl class="kv"><dt>元データの件数</dt><dd>${result.source} 件</dd><dt>登録した件数</dt><dd>${result.added} 件${result.review ? `（うち要確認 ${result.review} 件）` : ''}</dd>
          <dt>重複のため登録しなかった件数</dt><dd>${result.duplicate} 件</dd><dt>重複候補で登録しなかった件数</dt><dd>${result.similarSkipped} 件</dd>
          <dt>自分で除外した件数</dt><dd>${result.excluded} 件</dd>${result.errors ? `<dt>エラー</dt><dd>${result.errors} 件</dd>` : ''}</dl>
          ${preview.note ? `<p class="hint">${esc(preview.note)}</p>` : ''}
          <p class="hint">元のファイル（Todoistのデータ）は変更していません。</p>
          <button type="button" class="btn primary" data-done="1">OK</button>`, { onMount(sh) { sh.querySelector('[data-done]').onclick = () => { closeSheet(); goTab('today'); }; } });
      });
    },
  });
}

// ─────────────────────────────── イベント ───────────────────────────────
const actions = {
  tab: (el) => goTab(el.dataset.tab),
  complete: (el) => doComplete(el.dataset.id),
  focus: (el) => doFocus(el.dataset.id),
  menu: (el) => openTaskMenu(el.dataset.id),
  edit: (el) => openEditor(el.dataset.id),
  undo: (el) => commit((s) => undoHistory(s, el.dataset.hid)),
  add: (el) => openEditor(null, { preset: el.dataset.preset }),
  'pick-focus': () => openFocusPicker(),
  'toggle-minimal': () => commit((s) => { s.settings.minimalMode = !s.settings.minimalMode; }),
  'toggle-done': () => { ui.showDone = !ui.showDone; render(); },
  'go-review': () => { ui.filters = { q: '', cat: '', freq: '', status: 'review', when: '' }; goTab('all'); },
  'dismiss-safari': () => { dismissedSafariNote = true; render(); },
  'routine-tab': (el) => { ui.routineTab = el.dataset.v; render(); },
  'toggle-active': (el) => {
    const t = findTask(state, el.dataset.id);
    commit((s) => setActive(s, el.dataset.id, !t.active, today));
    toast(t.active ? `「${t.title}」を再開しました` : `「${t.title}」を一時停止しました`);
  },
  'cal-mode': (el) => { ui.calMode = el.dataset.v; ui.calCursor = today; render(); },
  'cal-move': (el) => {
    const n = Number(el.dataset.v);
    ui.calCursor = ui.calMode === 'week' ? addDays(ui.calCursor, 7 * n) : addMonths(ui.calCursor, n);
    render();
  },
  'cal-today': () => { ui.calCursor = today; render(); },
  'cal-select': (el) => { ui.calSelected = el.dataset.v; render(); },
  backup: () => doBackup(),
  restore: () => doRestore(),
  snapshots: () => openSnapshots(),
  import: () => doImport(),
  'export-tasks': () => doExport('tasks'),
  'export-history': () => doExport('history'),
  'cat-up': (el) => commit((s) => moveCategory(s, el.dataset.id, -1)),
  'cat-down': (el) => commit((s) => moveCategory(s, el.dataset.id, 1)),
  'cat-add': () => {
    const input = $('#new-cat');
    const r = commit((s) => addCategory(s, input.value));
    if (r?.error) toast(r.error, { error: true });
  },
  'cat-delete': (el) => {
    const c = state.categories.find((x) => x.id === el.dataset.id);
    const n = state.tasks.filter((t) => t.categoryId === c.id).length;
    openSheet(`<div class="sheet-h"><div class="sheet-title">分類「${esc(c.name)}」を削除</div>
      <p class="hint">この分類のタスク ${n} 件は削除せず、下で選んだ分類に移します。</p></div>
      <label class="field"><span>移動先</span><select class="move-to">${catOptions(otherCategoryId(state) === c.id ? sortedCategories(state).find((x) => x.id !== c.id).id : otherCategoryId(state)).replace(`<option value="${c.id}"`, `<option disabled value="${c.id}"`)}</select></label>
      <div class="row"><button type="button" class="btn" data-c="no">やめる</button><button type="button" class="btn danger" data-c="yes">削除する</button></div>`, {
      onMount(sheet) {
        sheet.addEventListener('click', (e) => {
          const b = e.target.closest('[data-c]');
          if (!b) return;
          const to = sheet.querySelector('.move-to').value;
          closeSheet();
          if (b.dataset.c !== 'yes') return;
          const r = commit((s) => deleteCategory(s, c.id, to));
          if (r?.error) toast(r.error, { error: true }); else toast(`削除しました（${r.moved}件を移動）`);
        });
      },
    });
  },
  'save-settings': () => {
    const name = $('#app-name').value.trim();
    const days = Number($('#backup-days').value);
    if (!name) { toast('アプリの名前を入力してください', { error: true }); return; }
    commit((s) => { s.settings.appName = name; if (days >= 1 && days <= 60) s.settings.backupReminderDays = days; });
    toast('保存しました');
  },
};

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !state) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  });
  document.addEventListener('input', (e) => {
    const f = e.target.closest('#view [data-filter="q"]');
    if (f) { ui.filters.q = f.value; $('#all-list').innerHTML = allListHtml(); }
  });
  document.addEventListener('change', (e) => {
    const f = e.target.closest('#view select[data-filter]');
    if (f) { ui.filters[f.dataset.filter] = f.value; $('#all-list').innerHTML = allListHtml(); return; }
    const c = e.target.closest('#view [data-cat]');
    if (c) {
      const r = commit((s) => updateCategory(s, c.dataset.cat, { [c.dataset.field]: c.value }));
      if (r?.error) toast(r.error, { error: true });
    }
  });
  // 日付が変わったら更新（アプリを開いたまま日付をまたいだとき・久しぶりに開いたとき）
  const checkDay = () => {
    const now = todayKey();
    if (now !== today && state) {
      today = now;
      ui.calCursor = null;
      rollover(state, today);
      persist();
      render();
    }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
  window.addEventListener('focus', checkDay);
  setInterval(checkDay, 30000);
}

// ─────────────────────────────── 起動 ───────────────────────────────
function fatal(message, detail) {
  $('#view').innerHTML = `<div class="fatal"><h2>⚠️ アプリを開けませんでした</h2><p>${esc(message)}</p>${detail ? `<pre>${esc(detail)}</pre>` : ''}
    <p>データは消していません。アプリを完全に閉じてから、もう一度開いてみてください。直らない場合は、この画面のスクリーンショットを保存してください。</p>
    <button type="button" class="btn" onclick="location.reload()">再読み込み</button></div>`;
}

async function init() {
  window.__appStarted = true;
  window.addEventListener('error', (e) => showErrorBar(`エラーが発生しました: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => showErrorBar(`エラーが発生しました: ${e.reason?.message || e.reason}`));
  bindEvents();
  let loaded;
  try {
    loaded = await loadState();
  } catch (e) {
    fatal('保存データを読み込めませんでした。', e.message || String(e));
    return;
  }
  if (loaded) {
    const errs = validateState(loaded);
    if (errs.length) {
      // 壊れたデータを上書きしない
      fatal('保存データに問題が見つかりました。上書きはしていません。', errs.join('\n'));
      return;
    }
    delete loaded.savedDay; delete loaded.savedAt;
    state = migrateState(loaded);
  } else {
    state = createInitialState();
  }
  rollover(state, today);
  render();
  await persist();
  requestPersist();
  registerSW();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('新しいバージョンがあります', { action: '更新する', ms: 30000, onAction: () => { nw.postMessage('skipWaiting'); } });
        }
      });
    });
  }).catch((e) => console.warn('SW登録失敗', e));
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return; // 初回のインストール時は再読み込みしない
    reloaded = true;
    closeAllSheets();
    location.reload();
  });
}

init();
