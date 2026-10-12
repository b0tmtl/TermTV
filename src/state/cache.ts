// Library and guide caches, written from the main thread (the worker compresses).
// On a TV they are files in the app's private folder: IndexedDB's quota there is only a few MB.
// In a desktop browser, and as a fallback, they go to IndexedDB:
// Format (see workers/cache-codec.ts): `<key>#0`, `<key>#1`... 1 MB chunks, then `<key>#meta`,
// written last so a half-written cache is never read.

import { dbDelete, dbGet, dbKeys, dbPut } from '@/platform/db';
import { deleteFile, fileStoreAvailable, readFile, writeFile } from '@/platform/filestore';
import { FORMAT, type CacheMeta } from '@/workers/cache-codec';
import { createStore } from './store';

export type CacheStore = 'library' | 'epg';

export interface CacheState {
  /** Per source id: what happened to the last library save / load. */
  library: Record<string, { ok: boolean; bytes?: number; at: number; error?: string; loaded?: boolean }>;
}

export const cacheState = createStore<CacheState>({ library: {} });

const metaKey = (key: string) => key + '#meta';
const chunkKey = (key: string, i: number) => key + '#' + i;

function note(store: CacheStore, key: string, v: CacheState['library'][string]) {
  if (store !== 'library') return;
  cacheState.set((s) => ({ library: { ...s.library, [key]: { ...s.library[key], ...v } } }));
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

export async function saveCache(store: CacheStore, key: string, chunks: ArrayBuffer[]): Promise<void> {
  if (!chunks.length) return;
  let bytes = 0;
  for (const c of chunks) bytes += c.byteLength;
  if (fileStoreAvailable()) {
    try {
      // Free what earlier versions left in IndexedDB first: it shares the quota with settings.
      await deleteIdbCache(store, key);
      await writeFile(fileName(store, key), chunks);
      const back = await readFile(fileName(store, key));
      if (!back || back.byteLength !== bytes) throw new Error('Saved file could not be read back');
      await dbPut('kv', fileMetaKey(store, key), { bytes, savedAt: Date.now() }).catch(() => undefined);
      note(store, key, { ok: true, bytes, at: Date.now(), error: undefined, loaded: false });
      return;
    } catch (e) {
      console.warn('file cache failed, trying IndexedDB', e);
      await deleteFile(fileName(store, key));
    }
  }
  try {
    const old = await dbGet<CacheMeta>(store, metaKey(key)).catch(() => undefined);
    await dbDelete(store, metaKey(key));
    let asText = false;
    try {
      await dbPut(store, chunkKey(key, 0), chunks[0]);
    } catch (e) {
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
    note(store, key, { ok: true, bytes, at: Date.now(), error: undefined, loaded: false });
  } catch (e) {
    // Don't leave half a cache behind: it would fill the quota that settings need.
    await deleteIdbCache(store, key);
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('cache save failed', store, key, msg);
    note(store, key, { ok: false, at: Date.now(), error: msg });
  }
}

/** The stored chunks, or undefined when there is no complete cache. */
export async function loadCache(store: CacheStore, key: string): Promise<ArrayBuffer[] | undefined> {
  if (fileStoreAvailable()) {
    try {
      const buf = await readFile(fileName(store, key));
      if (buf && buf.byteLength) {
        const m = await dbGet<{ bytes: number; savedAt: number }>('kv', fileMetaKey(store, key)).catch(() => undefined);
        note(store, key, { ok: true, bytes: buf.byteLength, at: m ? m.savedAt : Date.now(), loaded: true });
        return [buf];
      }
    } catch (e) {
      note(store, key, { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) });
    }
  }
  try {
    const meta = await dbGet<CacheMeta>(store, metaKey(key));
    if (!meta || meta.format !== FORMAT) return undefined;
    const chunks: ArrayBuffer[] = [];
    for (let i = 0; i < meta.chunks; i++) {
      const buf = await dbGet<ArrayBuffer | string>(store, chunkKey(key, i));
      if (!buf) return undefined;
      chunks.push(typeof buf === 'string' ? fromStr(buf) : buf);
    }
    note(store, key, { ok: true, bytes: meta.bytes, at: meta.savedAt, loaded: true });
    return chunks;
  } catch (e) {
    note(store, key, { ok: false, at: Date.now(), error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
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
