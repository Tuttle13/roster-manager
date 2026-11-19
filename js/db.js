// IndexedDB storage. Holds settings, captures (raw + processed duties), and sync/backup logs.
// No credentials are ever stored here (work logins live in Safari/iCloud Keychain;
// the Google access token is short-lived and kept in localStorage only).

const DB_NAME = 'roster-manager';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('captures')) {
        const s = db.createObjectStore('captures', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('log')) {
        const s = db.createObjectStore('log', { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const kv = {
  get: (key, fallback = undefined) =>
    tx('kv', 'readonly', s => reqP(s.get(key))).then(v => (v === undefined ? fallback : v)),
  set: (key, value) => tx('kv', 'readwrite', s => { s.put(value, key); }),
  del: key => tx('kv', 'readwrite', s => { s.delete(key); }),
  all: () => tx('kv', 'readonly', async s => {
    const keys = await reqP(s.getAllKeys());
    const vals = await reqP(s.getAll());
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  }),
};

export const captures = {
  put: c => tx('captures', 'readwrite', s => { s.put(c); }),
  get: id => tx('captures', 'readonly', s => reqP(s.get(id))),
  del: id => tx('captures', 'readwrite', s => { s.delete(id); }),
  list: () => tx('captures', 'readonly', s => reqP(s.getAll()))
    .then(a => a.sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''))),
};

export const log = {
  add: entry => {
    const e = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
    return tx('log', 'readwrite', s => { s.put(e); }).then(() => e);
  },
  list: () => tx('log', 'readonly', s => reqP(s.getAll()))
    .then(a => a.sort((x, y) => y.at.localeCompare(x.at))),
};

// Full export/import for Drive backups and manual backup files.
export async function exportAll() {
  const [settings, caps, logs] = await Promise.all([kv.all(), captures.list(), log.list()]);
  // Defensive: never export anything token-like even if it somehow got into kv.
  for (const k of Object.keys(settings)) if (/token|secret|password/i.test(k)) delete settings[k];
  return { format: 'prm-backup', version: 1, exportedAt: new Date().toISOString(), settings, captures: caps, log: logs };
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.format !== 'prm-backup') throw new Error('Not a Roster Manager backup file.');
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['kv', 'captures', 'log'], 'readwrite');
    if (replace) { t.objectStore('kv').clear(); t.objectStore('captures').clear(); t.objectStore('log').clear(); }
    for (const [k, v] of Object.entries(data.settings || {})) {
      if (/token|secret|password/i.test(k)) continue;
      t.objectStore('kv').put(v, k);
    }
    for (const c of data.captures || []) t.objectStore('captures').put(c);
    for (const l of data.log || []) t.objectStore('log').put(l);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function wipeAll() {
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['kv', 'captures', 'log'], 'readwrite');
    t.objectStore('kv').clear(); t.objectStore('captures').clear(); t.objectStore('log').clear();
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}

export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
