// 端末内保存（IndexedDB）
// ・状態全体を1件として保存（書き込みは1回のトランザクションで完結し、途中で壊れない）
// ・日付が変わって最初の保存時に、前日までの状態を「自動控え」として端末内に残す（最大7日分）
//   ※ 自動控えは同じ端末内なので、端末の故障・変更・アプリ削除には備えられない。
//     そのためのバックアップはファイルとして iCloud Drive などに保存する。

const DB_NAME = 'watashi-todo';
const STORE = 'kv';
const MAIN = 'state';
const SNAP_PREFIX = 'snapshot:';
const KEEP_SNAPSHOTS = 7;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('この環境では端末内保存（IndexedDB）が使えません'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('データベースを開けませんでした'));
    req.onblocked = () => reject(new Error('データベースが別の画面で使用中です。アプリを開き直してください'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

// トランザクション内の処理はコールバックだけで書く（Promise を挟むと Safari で自動確定されることがあるため）
function run(mode, body) {
  return open().then((db) => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORE, mode); } catch (e) { dbp = null; reject(e); return; }
    const ctx = { store: t.objectStore(STORE), result: undefined };
    t.oncomplete = () => resolve(ctx.result);
    t.onerror = () => reject(t.error || new Error('保存処理に失敗しました'));
    t.onabort = () => reject(t.error || new Error('保存処理が中断されました（容量不足の可能性があります）'));
    try { body(ctx); } catch (e) { try { t.abort(); } catch { /* 既に終了 */ } reject(e); }
  }));
}

export function loadState() {
  return run('readonly', (ctx) => {
    ctx.store.get(MAIN).onsuccess = (e) => { ctx.result = e.target.result; };
  });
}

// 保存。日付が変わって最初の保存のときは、保存前の状態を自動控えに残す
export function saveState(state, today) {
  return run('readwrite', (ctx) => {
    const s = ctx.store;
    s.get(MAIN).onsuccess = (e) => {
      const prev = e.target.result;
      if (prev && prev.savedDay && prev.savedDay !== today) {
        s.put(prev, SNAP_PREFIX + prev.savedDay);
        s.getAllKeys().onsuccess = (ev) => {
          const keys = ev.target.result.map(String).filter((k) => k.startsWith(SNAP_PREFIX) && /\d{4}-\d{2}-\d{2}$/.test(k)).sort();
          if (!keys.includes(SNAP_PREFIX + prev.savedDay)) keys.push(SNAP_PREFIX + prev.savedDay);
          keys.sort();
          for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_SNAPSHOTS))) s.delete(k);
        };
      }
      s.put({ ...state, savedDay: today, savedAt: new Date().toISOString() }, MAIN);
    };
  });
}

// 復元などで全体を置き換える前に、今の状態を控えとして残す
export function saveSnapshot(state, label) {
  return run('readwrite', (ctx) => {
    ctx.store.put({ ...state, savedAt: new Date().toISOString() }, SNAP_PREFIX + label);
  });
}

export function listSnapshots() {
  return run('readonly', (ctx) => {
    ctx.result = [];
    const req = ctx.store.openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) { ctx.result.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')); return; }
      const k = String(cur.key);
      if (k.startsWith(SNAP_PREFIX)) {
        const v = cur.value;
        ctx.result.push({ key: k, label: k.slice(SNAP_PREFIX.length), savedAt: v?.savedAt, tasks: v?.tasks?.length ?? 0, history: v?.history?.length ?? 0 });
      }
      cur.continue();
    };
  });
}

export function loadSnapshot(key) {
  return run('readonly', (ctx) => {
    ctx.store.get(key).onsuccess = (e) => { ctx.result = e.target.result; };
  });
}

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage; info.quota = e.quota;
    }
  } catch { /* 取得できなくても動作には影響しない */ }
  return info;
}

// ブラウザに「このデータは自動で消さないで」と依頼する（許可されるかはブラウザ次第）
export async function requestPersist() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* 未対応 */ }
  return null;
}
