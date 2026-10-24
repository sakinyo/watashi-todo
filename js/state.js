// アプリの状態と操作（画面や保存から独立した純粋なロジック）
import { addDays, isValidKey, diffDays } from './dates.js';
import { isRecurring, isRoutine, nextOnOrAfter, nextAfter, validateRule, occursOn } from './recur.js';

export const SCHEMA_VERSION = 1;
export const MAX_FOCUS = 3;

export const DEFAULT_CATEGORIES = [
  { name: '家事', kind: 'private', color: '#d9822b' },
  { name: '料理', kind: 'private', color: '#c8553d' },
  { name: '整理整頓', kind: 'private', color: '#8a9a5b' },
  { name: '自分メンテナンス', kind: 'private', color: '#c06c84' },
  { name: 'ノート・振り返り', kind: 'private', color: '#7b6fa8' },
  { name: '仕事・クリニック運営', kind: 'work', color: '#2f5d8a' },
  { name: '育児・家族', kind: 'private', color: '#e0a526' },
  { name: 'その他', kind: 'private', color: '#8c8c8c' },
];

export const LEVELS = { must: '必須', normal: 'ふつう', optional: '任意' };

export function uid(prefix = 'id') {
  const rnd = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${rnd}`;
}

export function createInitialState() {
  return {
    schema: SCHEMA_VERSION,
    settings: { appName: 'わたしの暮らしTODO', minimalMode: false, lastBackupAt: null, backupReminderDays: 7 },
    categories: DEFAULT_CATEGORIES.map((c, i) => ({ id: uid('cat'), ...c, order: i })),
    tasks: [],
    history: [],
    dayPlans: {},
    lastRollover: null,
  };
}

export function otherCategoryId(state) {
  const other = state.categories.find((c) => c.name === 'その他');
  return other ? other.id : sortedCategories(state)[0]?.id;
}

export function sortedCategories(state) {
  return [...state.categories].sort((a, b) => a.order - b.order);
}

export function categoryOf(state, task) {
  return state.categories.find((c) => c.id === task.categoryId) || { id: '', name: '未分類', kind: 'private', color: '#8c8c8c' };
}

export function findTask(state, id) {
  return state.tasks.find((t) => t.id === id);
}

// 予定に乗っている（今日の画面などに出てよい）タスクか
export function isScheduledOpen(task) {
  return task.active && task.status === 'open' && !task.needsReview && !!task.nextDate;
}

// ─── 日付が変わったときの処理 ───
// 毎日・曜日ルーティンの予定日が過去になっていたら、今日以降の次の実施日に進める（積み上げない）。
// 毎月・単発などは期限切れのまま残し、本人が処理を選ぶ。
// 何度呼んでも結果は同じ（重複を作らない）。
export function rollover(state, today) {
  let changed = 0;
  for (const t of state.tasks) {
    if (!t.active || t.status !== 'open' || t.needsReview) continue;
    if (!isRecurring(t.rule)) continue;
    if (!t.nextDate) { t.nextDate = nextOnOrAfter(t.rule, today); changed++; continue; }
    if (isRoutine(t.rule) && t.nextDate < today) {
      t.nextDate = nextOnOrAfter(t.rule, today);
      changed++;
    }
  }
  // 古い重点設定は30日で整理
  for (const k of Object.keys(state.dayPlans)) {
    if (k < addDays(today, -30)) delete state.dayPlans[k];
  }
  state.lastRollover = today;
  return changed;
}

function logHistory(state, task, action, today, extra = {}) {
  const entry = {
    id: uid('h'),
    taskId: task.id,
    title: task.title,
    categoryId: task.categoryId,
    action, // done | skipped | postponed | moved
    date: today, // 操作した日
    scheduled: task.nextDate || null, // 本来の予定日
    at: new Date().toISOString(),
    prev: { nextDate: task.nextDate, status: task.status },
    ...extra,
  };
  state.history.push(entry);
  return entry;
}

export function completeTask(state, id, today) {
  const t = findTask(state, id);
  if (!t || t.status !== 'open') return null;
  const entry = logHistory(state, t, 'done', today);
  if (isRecurring(t.rule)) {
    t.nextDate = nextAfter(t.rule, t.nextDate, today);
  } else {
    t.status = 'done';
    t.doneAt = entry.at;
  }
  t.updatedAt = entry.at;
  return entry;
}

// 「次の予定日に実施する」：今回はやらず、次の実施日へ
export function postponeToNext(state, id, today) {
  const t = findTask(state, id);
  if (!t || !isRecurring(t.rule)) return null;
  const to = nextAfter(t.rule, t.nextDate, addDays(today, 1));
  const entry = logHistory(state, t, 'postponed', today, { toDate: to });
  t.nextDate = to;
  t.updatedAt = entry.at;
  return entry;
}

// 「別の日に変更する」：今回の回だけ日付を変える（繰り返しのルールは変えない）
export function moveTo(state, id, date, today) {
  const t = findTask(state, id);
  if (!t || !isValidKey(date)) return null;
  const entry = logHistory(state, t, 'moved', today, { toDate: date });
  t.nextDate = date;
  t.updatedAt = entry.at;
  return entry;
}

// 「今回はスキップする」
export function skipTask(state, id, today) {
  const t = findTask(state, id);
  if (!t || t.status !== 'open') return null;
  const entry = logHistory(state, t, 'skipped', today);
  if (isRecurring(t.rule)) {
    t.nextDate = nextAfter(t.rule, t.nextDate, today);
  } else {
    t.status = 'skipped';
  }
  t.updatedAt = entry.at;
  return entry;
}

// 直前の操作を取り消す（履歴を消してタスクを元に戻す）
export function undoHistory(state, historyId) {
  const idx = state.history.findIndex((h) => h.id === historyId);
  if (idx < 0) return false;
  const h = state.history[idx];
  const t = findTask(state, h.taskId);
  if (t) {
    t.nextDate = h.prev.nextDate;
    t.status = h.prev.status;
    if (t.status === 'open') delete t.doneAt;
    t.updatedAt = new Date().toISOString();
  }
  state.history.splice(idx, 1);
  return true;
}

// ─── 重点タスク（1日最大3つ） ───
export function focusIds(state, day) {
  const ids = state.dayPlans[day]?.focus || [];
  return ids.filter((id) => findTask(state, id));
}

export function toggleFocus(state, day, id) {
  const plan = state.dayPlans[day] || (state.dayPlans[day] = { focus: [] });
  plan.focus = plan.focus.filter((x) => findTask(state, x));
  if (plan.focus.includes(id)) {
    plan.focus = plan.focus.filter((x) => x !== id);
    return { ok: true, on: false };
  }
  if (plan.focus.length >= MAX_FOCUS) return { ok: false, reason: `重点は${MAX_FOCUS}つまでです` };
  plan.focus.push(id);
  return { ok: true, on: true };
}

// ─── タスクの追加・編集・削除 ───
export function normalizeTaskInput(input, state, today) {
  const errors = [];
  const title = String(input.title || '').trim();
  if (!title) errors.push('タスク名を入力してください');
  const rule = input.rule || { type: 'none' };
  const ruleErr = validateRule(rule);
  if (ruleErr) errors.push(ruleErr);
  let nextDate = input.nextDate || null;
  if (nextDate && !isValidKey(nextDate)) errors.push('次回実施日が不正です');
  const duration = input.duration === '' || input.duration == null ? null : Number(input.duration);
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 1440)) errors.push('所要時間は0〜1440分で入力してください');
  const level = LEVELS[input.level] ? input.level : 'normal';
  const categoryId = state.categories.some((c) => c.id === input.categoryId) ? input.categoryId : otherCategoryId(state);
  if (!errors.length && isRecurring(rule) && !nextDate) nextDate = nextOnOrAfter(rule, today);
  return {
    errors,
    value: {
      title, rule, nextDate, duration, level, categoryId,
      memo: String(input.memo || ''),
      active: input.active !== false,
      needsReview: rule.type === 'unknown' ? true : !!input.needsReview,
    },
  };
}

export function addTask(state, input, today, extra = {}) {
  const { errors, value } = normalizeTaskInput(input, state, today);
  if (errors.length) return { errors };
  // 新規の繰り返しタスクで、指定日が繰り返しの日に当たらないときは、その日以降の最初の実施日にする
  if (isRecurring(value.rule) && value.nextDate && !occursOn(value.rule, value.nextDate)) value.nextDate = nextOnOrAfter(value.rule, value.nextDate);
  const now = new Date().toISOString();
  const task = { id: uid('t'), ...value, status: 'open', createdAt: now, updatedAt: now, ...extra };
  state.tasks.push(task);
  return { task };
}

export function updateTask(state, id, input, today) {
  const t = findTask(state, id);
  if (!t) return { errors: ['タスクが見つかりません'] };
  const ruleChanged = JSON.stringify(t.rule) !== JSON.stringify(input.rule);
  const dateChanged = (input.nextDate || null) !== (t.nextDate || null);
  const wasActive = t.active;
  // 繰り返しを変えたのに日付を変えていなければ、新しいルールで次回を計算し直す
  const data = { ...input };
  if (ruleChanged && !dateChanged) data.nextDate = isRecurring(input.rule) ? null : input.nextDate;
  // 一時停止から再開したときは、今日以降の次の実施日から再開する
  if (!wasActive && input.active !== false && isRecurring(input.rule) && !dateChanged) data.nextDate = null;
  const { errors, value } = normalizeTaskInput(data, state, today);
  if (errors.length) return { errors };
  if (t.status !== 'open' && dateChanged && value.nextDate) t.status = 'open'; // 完了済みの単発に新しい日付を入れたら再開
  Object.assign(t, value, { updatedAt: new Date().toISOString() });
  return { task: t };
}

export function deleteTask(state, id) {
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  state.tasks.splice(idx, 1);
  for (const plan of Object.values(state.dayPlans)) plan.focus = (plan.focus || []).filter((x) => x !== id);
  // 完了履歴は残す（タスク名は履歴側に記録済み）
  return true;
}

export function setActive(state, id, active, today) {
  const t = findTask(state, id);
  if (!t) return false;
  t.active = active;
  if (active && isRecurring(t.rule)) t.nextDate = nextOnOrAfter(t.rule, today);
  t.updatedAt = new Date().toISOString();
  return true;
}

// ─── 分類 ───
export function addCategory(state, name, kind = 'private', color = '#8c8c8c') {
  name = String(name || '').trim();
  if (!name) return { error: '分類名を入力してください' };
  if (state.categories.some((c) => c.name === name)) return { error: '同じ名前の分類があります' };
  const order = Math.max(-1, ...state.categories.map((c) => c.order)) + 1;
  const cat = { id: uid('cat'), name, kind, color, order };
  state.categories.push(cat);
  return { category: cat };
}

export function updateCategory(state, id, patch) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return { error: '分類が見つかりません' };
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) return { error: '分類名を入力してください' };
    if (state.categories.some((x) => x.id !== id && x.name === name)) return { error: '同じ名前の分類があります' };
    c.name = name;
  }
  if (patch.kind) c.kind = patch.kind === 'work' ? 'work' : 'private';
  if (patch.color) c.color = patch.color;
  return { category: c };
}

// 削除した分類のタスクは移動先へ（タスク自体は消さない）
export function deleteCategory(state, id, moveToId) {
  if (state.categories.length <= 1) return { error: '分類は最低1つ必要です' };
  if (id === moveToId) return { error: '移動先が同じ分類です' };
  if (!state.categories.some((c) => c.id === moveToId)) return { error: '移動先の分類を選んでください' };
  let moved = 0;
  for (const t of state.tasks) if (t.categoryId === id) { t.categoryId = moveToId; moved++; }
  state.categories = state.categories.filter((c) => c.id !== id);
  return { moved };
}

export function moveCategory(state, id, dir) {
  const list = sortedCategories(state);
  const i = list.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((c, k) => { c.order = k; });
  return true;
}

// ─── 今日の画面の内容 ───
export function todayView(state, today) {
  const focus = focusIds(state, today);
  const open = state.tasks.filter((t) => isScheduledOpen(t) && t.nextDate <= today);
  const overdue = open.filter((t) => t.nextDate < today);
  const dueToday = open.filter((t) => t.nextDate === today && !isRoutine(t.rule));
  const routines = open.filter((t) => t.nextDate === today && isRoutine(t.rule));
  const doneToday = state.history.filter((h) => h.date === today && (h.action === 'done' || h.action === 'skipped'));
  const focusTasks = focus.map((id) => findTask(state, id));
  return { focus, focusTasks, overdue, dueToday, routines, doneToday };
}

export function backupAgeDays(state, today) {
  if (!state.settings.lastBackupAt) return null;
  const d = new Date(state.settings.lastBackupAt);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return diffDays(key, today);
}

// 保存データの検証（復元・読み込み時）
export function validateState(s) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['データの形式が不正です'];
  if (!Array.isArray(s.tasks)) errs.push('tasks がありません');
  if (!Array.isArray(s.categories) || !s.categories.length) errs.push('categories がありません');
  if (!Array.isArray(s.history)) errs.push('history がありません');
  if (!s.settings || typeof s.settings !== 'object') errs.push('settings がありません');
  if (errs.length) return errs;
  s.tasks.forEach((t, i) => {
    if (!t.id || typeof t.title !== 'string') errs.push(`タスク${i + 1}件目の形式が不正です`);
    else if (validateRule(t.rule)) errs.push(`「${t.title}」の繰り返し設定が不正です`);
  });
  return errs;
}

export function migrateState(s) {
  s.schema = s.schema || 1;
  s.dayPlans = s.dayPlans || {};
  s.settings = { ...createInitialState().settings, ...s.settings };
  return s;
}
