// Minimal promise wrapper over IndexedDB. Usable from the main thread and from workers.
//
// Stores:
//   kv       small app state (sources, profiles, settings, favorites, history...)
//   library  one record per source: categories + items (can be large)
//   epg      one record per source: programmes in the current window

const DB_NAME = 'termtv';
const DB_VERSION = 1;
export type StoreName = 'kv' | 'library' | 'epg';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['kv', 'library', 'epg']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key));
}

export function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  return tx<void>(store, 'readwrite', (s) => s.put(value, key));
}

export function dbDelete(store: StoreName, key: string): Promise<void> {
  return tx<void>(store, 'readwrite', (s) => s.delete(key));
}

export function dbKeys(store: StoreName): Promise<string[]> {
  // getAllKeys() needs Chromium 58; a cursor works everywhere.
  const keys: string[] = [];
  return tx<void>(store, 'readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        keys.push(String(c.key));
        c.continue();
      }
    };
  }).then(() => keys);
}

export function dbClear(store: StoreName): Promise<void> {
  return tx<void>(store, 'readwrite', (s) => s.clear());
}
