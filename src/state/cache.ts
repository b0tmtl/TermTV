// Library and guide caches in IndexedDB, written from the main thread (the worker compresses).
// Format (see workers/cache-codec.ts): `<key>#0`, `<key>#1`... 1 MB chunks, then `<key>#meta`,
// written last so a half-written cache is never read.

import { dbDelete, dbGet, dbPut } from '@/platform/db';
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

export async function saveCache(store: CacheStore, key: string, chunks: ArrayBuffer[]): Promise<void> {
  if (!chunks.length) return;
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
    let bytes = 0;
    for (const c of chunks) bytes += c.byteLength;
    const meta: CacheMeta = { format: FORMAT, chunks: chunks.length, bytes, savedAt: Date.now(), text: asText || undefined };
    await dbPut(store, metaKey(key), meta);
    // Read it back: some TVs report success and keep nothing.
    const check = await dbGet<CacheMeta>(store, metaKey(key));
    if (!check || check.chunks !== chunks.length) throw new Error('Saved data could not be read back');
    if (old) for (let i = chunks.length; i < old.chunks; i++) await dbDelete(store, chunkKey(key, i)).catch(() => undefined);
    // The one-record format from before 0.1.7.
    await dbDelete(store, key).catch(() => undefined);
    note(store, key, { ok: true, bytes, at: Date.now(), error: undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('cache save failed', store, key, msg);
    note(store, key, { ok: false, at: Date.now(), error: msg });
  }
}

/** The stored chunks, or undefined when there is no complete cache. */
export async function loadCache(store: CacheStore, key: string): Promise<ArrayBuffer[] | undefined> {
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
  const meta = await dbGet<CacheMeta>(store, metaKey(key)).catch(() => undefined);
  await dbDelete(store, metaKey(key)).catch(() => undefined);
  if (meta) for (let i = 0; i < meta.chunks; i++) await dbDelete(store, chunkKey(key, i)).catch(() => undefined);
  await dbDelete(store, key).catch(() => undefined);
}
