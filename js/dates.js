// 日付は 'YYYY-MM-DD' 文字列（日付キー）で扱う。計算は UTC で行い、夏時間等のずれを避ける。

export const pad = (n) => String(n).padStart(2, '0');

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toKey(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// 端末のローカル時刻での「今日」
export function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return toKey(fromKey(key)) === key;
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}

export function diffDays(a, b) {
  return Math.round((fromKey(b) - fromKey(a)) / 86400000);
}

export function weekday(key) {
  return fromKey(key).getUTCDay(); // 0=日 … 6=土
}

export function daysInMonth(year, month) { // month: 1-12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

export function maxKey(a, b) { return a > b ? a : b; }

// 月曜始まりの週の初日
export function startOfWeek(key) {
  const wd = weekday(key);
  return addDays(key, -((wd + 6) % 7));
}

export function startOfMonth(key) {
  const { y, m } = parts(key);
  return `${y}-${pad(m)}-01`;
}

export function addMonths(key, n) {
  const { y, m } = parts(key);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}-01`;
}

export const WD_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function formatJa(key, withWeekday = true) {
  const { m, d } = parts(key);
  return withWeekday ? `${m}月${d}日（${WD_JA[weekday(key)]}）` : `${m}月${d}日`;
}

export function formatJaLong(key) {
  const { y } = parts(key);
  return `${y}年${formatJa(key)}`;
}

// 今日からの相対表示
export function relativeJa(key, today) {
  const diff = diffDays(today, key);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  if (diff < 0) return `${formatJa(key)}・${-diff}日前`;
  return formatJa(key);
}
