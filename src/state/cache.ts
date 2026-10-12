// Library and guide caches, written from the main thread (the worker compresses).
// On a TV they are files in the app's private folder: IndexedDB's quota there is only a few MB.
// In a desktop browser, and as a fallback, they go to IndexedDB:
// Format (see workers/cache-codec.ts): `<key>#0`, `<key>#1`... 1 MB chunks, then `<key>#meta`,
// written last so a half-written cache is never read.

import { dbDelete, dbGet, dbKeys, dbPut } from '@/platform/db';
import * as files from '@/platform/filestore';
import { deleteFile, fileStoreAvailable, readFile, writeFile } from '@/platform/filestore';
import { FORMAT, type CacheMeta } from '@/workers/cache-codec';
import { createStore } from './store';

export type CacheStore = 'library' | 'epg';

export interface CacheState {
  /** Per source id: what happened to the last library save / load. */
  library: Record<string, CacheNote>;
}

export interface CacheNote {
  ok: boolean;
  bytes?: number;
  at: number;
  error?: string;
  loaded?: boolean;
  /** Step in progress ("writing file"...), shown in Settings > About while saving. */
  stage?: string;
  /** "read in 1200 ms (direct)", "unpacked 120000 titles in 900 ms". */
  read?: string;
  decode?: string;
  /** Where it is stored. */
  where?: 'file' | 'idb';
}

export const cacheState = createStore<CacheState>({ library: {} });

const metaKey = (key: string) => key + '#meta';
const chunkKey = (key: string, i: number) => key + '#' + i;

/** Rejects when a TV API never calls back, so a hang shows up as an error instead of silence. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function noteStage(store: CacheStore, key: string, stage: string | undefined): void {
  if (store !== 'library') return;
  cacheState.set((s) => ({ library: { ...s.library, [key]: { ...(s.library[key] || { ok: true, at: Date.now() }), stage } } }));
}

function note(store: CacheStore, key: string, v: Partial<CacheNote> & { ok: boolean; at: number }) {
  if (store !== 'library') return;
  cacheState.set((s) => ({ library: { ...s.library, [key]: { ...s.library[key], stage: undefined, ...v } } }));
}

/** Binary as a string, one char per byte: the fallback for TVs that refuse ArrayBuffers. */
function toStr(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < u.length; i += 8192) out += String.fromCharCode.apply(null, u.subarray(i, i + 8192) as unknown as number[]);
  return out;
}

function fromStr(s: string): ArrayBuffer {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

const fileName = (store: CacheStore, key: string) => `${store}-${key}.bin`;
/** Small IndexedDB record describing a file cache (for Settings > About). */
const fileMetaKey = (store: CacheStore, key: string) => `cachefile:${store}:${key}`;

/** Free space in browser storage, or undefined when the TV doesn't say (quickly). */
function idbRoom(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const q = (navigator as any).webkitTemporaryStorage;
    if (!q || !q.queryUsageAndQuota) return resolve(undefined);
    const t = setTimeout(() => resolve(undefined), 2000);
    try {
      q.queryUsageAndQuota(
        (used: number, quota: number) => (clearTimeout(t), resolve(quota - used)),
        () => (clearTimeout(t), resolve(undefined)),
      );
    } catch {
      clearTimeout(t);
      resolve(undefined);
    }
  });
}

/** Room always left in browser storage for settings, favorites and history. */
const IDB_RESERVE = 2 * 1048576;

/**
 * Browser storage when the cache fits (it reads natively and fast), otherwise a file in the app's
 * folder (no size limit, but the TV's file API reads at about 1 MB/s).
 */
export async function saveCache(store: CacheStore, key: string, chunks: ArrayBuffer[]): Promise<void> {
  if (!chunks.length) return;
  let bytes = 0;
  for (const c of chunks) bytes += c.byteLength;
  const errors: string[] = [];
  let preferIdb = true;
  if (fileStoreAvailable()) {
    // Without our own old copy: it is replaced.
    const old = await dbGet<CacheMeta>(store, metaKey(key)).catch(() => undefined);
    const room = await idbRoom();
    preferIdb = room !== undefined && room + (old ? old.bytes : 0) - bytes > IDB_RESERVE;
  }
  const order = preferIdb ? ['idb', 'file'] : ['file', 'idb'];
  for (const where of order) {
    if (where === 'file' && !fileStoreAvailable()) continue;
    try {
      if (where === 'idb') {
        await saveIdb(store, key, chunks, bytes);
        if (fileStoreAvailable()) await withTimeout(deleteFile(fileName(store, key)), 10000, 'Deleting file').catch(() => undefined);
      } else {
        await saveFile(store, key, chunks, bytes);
      }
      note(store, key, { ok: true, bytes, at: Date.now(), error: undefined, loaded: false, where: where as 'idb' | 'file' });
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push((where === 'idb' ? 'Browser storage: ' : 'File: ') + msg);
      console.warn('cache save failed in', where, msg);
      if (where === 'idb') await withTimeout(deleteIdbCache(store, key), 30000, 'Cleaning up').catch(() => undefined);
      else await withTimeout(deleteFile(fileName(store, key)), 10000, 'Deleting file').catch(() => undefined);
    }
  }
  console.warn('cache save failed', store, key, errors.join(' · '));
  note(store, key, { ok: false, at: Date.now(), error: errors.join(' · ') });
}

async function saveFile(store: CacheStore, key: string, chunks: ArrayBuffer[], bytes: number): Promise<void> {
  const name = fileName(store, key);
  // Free what earlier versions left in IndexedDB first: it shares the quota with settings.
  noteStage(store, key, 'cleaning up old data');
  await withTimeout(deleteIdbCache(store, key), 30000, 'Cleaning up').catch((e) => console.warn(e));
  noteStage(store, key, 'writing file (' + (bytes / 1048576).toFixed(1) + ' MB)');
  await withTimeout(writeFile(name, chunks), 60000, 'Writing file');
  noteStage(store, key, 'checking file');
  const back = await withTimeout(readFile(name), 60000, 'Reading file back');
  if (!back || back.byteLength !== bytes) throw new Error('File read back ' + (back ? back.byteLength : 0) + ' of ' + bytes + ' bytes');
  await dbPut('kv', fileMetaKey(store, key), { bytes, savedAt: Date.now() }).catch(() => undefined);
}

async function saveIdb(store: CacheStore, key: string, chunks: ArrayBuffer[], bytes: number): Promise<void> {
  noteStage(store, key, 'saving to browser storage (' + (bytes / 1048576).toFixed(1) + ' MB)');
  const old = await dbGet<CacheMeta>(store, metaKey(key)).catch(() => undefined);
  await dbDelete(store, metaKey(key));
  let asText = false;
  try {
    await dbPut(store, chunkKey(key, 0), chunks[0]);
  } catch (e) {
    if (/Quota/i.test(String(e && (e as Error).message))) throw e;
    console.warn('binary cache refused, saving as text', e);
    asText = true;
  }
  for (let i = asText ? 0 : 1; i < chunks.length; i++) await dbPut(store, chunkKey(key, i), asText ? toStr(chunks[i]) : chunks[i]);
  const meta: CacheMeta = { format: FORMAT, chunks: chunks.length, bytes, savedAt: Date.now(), text: asText || undefined };
  await dbPut(store, metaKey(key), meta);
  // Read it back: some TVs report success and keep nothing.
  const check = await dbGet<CacheMeta>(store, metaKey(key));
  if (!check || check.chunks !== chunks.length) throw new Error('Saved data could not be read back');
  if (old) for (let i = chunks.length; i < old.chunks; i++) await dbDelete(store, chunkKey(key, i)).catch(() => undefined);
  // The one-record format from before 0.1.7.
  await dbDelete(store, key).catch(() => undefined);
}

/** The stored chunks, or undefined when there is no complete cache. */
export async function loadCache(store: CacheStore, key: string): Promise<ArrayBuffer[] | undefined> {
  const t0 = Date.now();
  try {
    const meta = await dbGet<CacheMeta>(store, metaKey(key));
    if (meta && meta.format === FORMAT) {
      const chunks: ArrayBuffer[] = [];
      for (let i = 0; i < meta.chunks; i++) {
        const buf = await dbGet<ArrayBuffer | string>(store, chunkKey(key, i));
        if (!buf) throw new Error('Saved data is incomplete');
        chunks.push(typeof buf === 'string' ? fromStr(buf) : buf);
      }
      note(store, key, { ok: true, bytes: meta.bytes, at: meta.savedAt, loaded: true, where: 'idb', read: 'read in ' + (Date.now() - t0) + ' ms' });
      return chunks;
    }
  } catch (e) {
    console.warn('cache read from browser storage failed', e);
  }
  if (fileStoreAvailable()) {
    try {
      const buf = await withTimeout(readFile(fileName(store, key)), 60000, 'Reading cache file');
      if (buf && buf.byteLength) {
        const m = await dbGet<{ bytes: number; savedAt: number }>('kv', fileMetaKey(store, key)).catch(() => undefined);
        note(store, key, { ok: true, bytes: buf.byteLength, at: m ? m.savedAt : Date.now(), loaded: true, where: 'file', read: 'read ' + files.lastReadMethod });
        return [buf];
      }
    } catch (e) {
      note(store, key, { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return undefined;
}

export async function deleteCache(store: CacheStore, key: string): Promise<void> {
  await deleteFile(fileName(store, key));
  await dbDelete('kv', fileMetaKey(store, key)).catch(() => undefined);
  await deleteIdbCache(store, key);
}

/** Every record of this cache, including chunks of a save that failed halfway (no meta). */
async function deleteIdbCache(store: CacheStore, key: string): Promise<void> {
  const keys = await dbKeys(store).catch(() => [] as string[]);
  for (const k of keys) if (k === key || k.indexOf(key + '#') === 0) await dbDelete(store, k).catch(() => undefined);
}

/** Settings > About > Test storage: writes and reads back a 3 MB file and a small IndexedDB record. */
export async function testStorage(): Promise<string[]> {
  const lines: string[] = [];
  const size = 3 * 1048576 + 7;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  const time = async (label: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      lines.push(label + ': ' + r + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) {
      lines.push(label + ': FAILED ' + (e instanceof Error ? e.message : String(e)) + ' (' + (Date.now() - t0) + ' ms)');
    }
  };
  lines.push('File API: ' + (fileStoreAvailable() ? 'available' : 'not available'));
  if (fileStoreAvailable()) {
    await time('Write 3 MB file', async () => (await withTimeout(writeFile('storage-test.bin', [data.buffer]), 60000, 'write'), 'ok'));
    await time('Read it back', async () => {
      const back = await withTimeout(readFile('storage-test.bin'), 60000, 'read');
      if (!back) return 'file missing';
      const u = new Uint8Array(back);
      if (u.length !== size) return 'wrong size ' + u.length;
      for (let i = 0; i < size; i += 4099) if (u[i] !== data[i]) return 'wrong byte at ' + i;
      return 'ok, identical';
    });
    await time('Delete it', async () => (await withTimeout(deleteFile('storage-test.bin'), 10000, 'delete'), 'ok'));
  }
  await time('Browser storage, small record', async () => {
    await withTimeout(dbPut('kv', 'storage-test', { at: Date.now() }), 10000, 'put');
    await dbDelete('kv', 'storage-test');
    return 'ok';
  });
  await time('Browser storage quota', () =>
    new Promise<string>((resolve) => {
      const q = (navigator as any).webkitTemporaryStorage;
      if (!q || !q.queryUsageAndQuota) return resolve('unknown');
      q.queryUsageAndQuota(
        (used: number, quota: number) => resolve(`${(used / 1048576).toFixed(1)} MB used of ${(quota / 1048576).toFixed(1)} MB`),
        () => resolve('unknown'),
      );
    }),
  );
  const keys = await dbKeys('library').catch(() => [] as string[]);
  lines.push('Old cache records in browser storage: ' + keys.length);
  return lines;
}

// ---- Small JSON records (the Home snapshot) -----------------------------------------------------
// A file on the TV (IndexedDB's quota is shared with settings), IndexedDB elsewhere.

export async function saveSmall(name: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  if (fileStoreAvailable()) {
    const bytes = new TextEncoder().encode(text);
    await withTimeout(writeFile(name + '.json', [bytes.buffer as ArrayBuffer]), 30000, 'Writing ' + name);
    return;
  }
  await dbPut('kv', 'small:' + name, text);
}

export async function loadSmall<T>(name: string): Promise<T | undefined> {
  try {
    if (fileStoreAvailable()) {
      const buf = await withTimeout(readFile(name + '.json'), 15000, 'Reading ' + name);
      return buf && buf.byteLength ? (JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf))) as T) : undefined;
    }
    const text = await dbGet<string>('kv', 'small:' + name);
    return text ? (JSON.parse(text) as T) : undefined;
  } catch (e) {
    console.warn('loadSmall failed', name, e);
    return undefined;
  }
}
