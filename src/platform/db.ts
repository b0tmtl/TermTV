// Minimal promise wrapper over IndexedDB. Usable from the main thread and from workers.
//
// Stores:
//   kv       small app state (sources, profiles, settings, favorites, history...)
//   library  one record per source: categories + items (can be large)
//   epg      one record per source: programmes in the current window

const DB_NAME = 'termtv';
const DB_VERSION = 1;
export type StoreName = 'kv' | 'library' | 'epg';

/** Old TVs reject with DOMError objects that print as "[object DOMError]". */
function asError(e: unknown): Error {
  const d = (e || {}) as { name?: string; message?: string };
  return new Error(`Storage error${d.name ? ` (${d.name})` : ''}${d.message ? `: ${d.message}` : ''}`);
}

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
      reject(asError(req.error));
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
        t.onerror = () => reject(asError(t.error));
        t.onabort = () => reject(asError(t.error));
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

const BACKUP_KEY = 'termtv-kv-backup';

/**
 * Deletes and recreates the database, keeping the small `kv` store (settings, profiles, favorites).
 * Old TVs don't give back the space of deleted records: after the big library caches of earlier
 * versions, the database stayed over its quota and even settings could no longer be saved.
 * The kv records are copied to localStorage first, so closing the app midway loses nothing.
 */
export async function rebuildDatabase(): Promise<number> {
  const entries: Array<[string, unknown]> = [];
  await tx<void>('kv', 'readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        entries.push([String(c.key), c.value]);
        c.continue();
      }
    };
  });
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(entries));
  } catch {
    /* no backup possible: still safe unless the app is closed in the next second */
  }
  const db = await open();
  db.close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(asError(req.error));
    req.onblocked = () => resolve(); // completes once other connections close
  });
  await restoreEntries(entries);
  return entries.length;
}

async function restoreEntries(entries: Array<[string, unknown]>): Promise<void> {
  for (const [k, v] of entries) await dbPut('kv', k, v);
  try {
    localStorage.removeItem(BACKUP_KEY);
  } catch {
    /* ignore */
  }
}

/** Restores settings if a rebuild was interrupted. */
export async function recoverInterruptedRebuild(): Promise<boolean> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BACKUP_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  await restoreEntries(JSON.parse(raw) as Array<[string, unknown]>);
  return true;
}
