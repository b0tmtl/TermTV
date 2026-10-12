// Compact, chunked storage format for the library and guide caches.
//
// A big playlist is one huge object graph; the IndexedDB of 2017 TVs refuses to store it in one
// record. So the cache is: fields that can be rebuilt are dropped, the rest is JSON, gzipped, and
// split into 1 MB binary chunks, each written in its own small transaction. A 100k-title library
// shrinks from ~40 MB of objects to a few MB of bytes.

import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import type { Category, Item } from '@/core/models';

export const CHUNK_SIZE = 1024 * 1024;
export const FORMAT = 2;

export interface CacheMeta {
  format: number;
  chunks: number;
  bytes: number;
  savedAt: number;
  /** Chunks stored as strings (TVs whose IndexedDB refuses ArrayBuffers). */
  text?: boolean;
}

type Row = Record<string, unknown>;

/** Drops `key`, `sourceId`, `kind` and the category key prefix when they follow the usual pattern. */
function packRowObjects(rows: Array<Item | Category>, sid: string, kind: string): Row[] {
  const prefix = `${sid}:${kind}:`;
  return rows.map((r) => {
    const o: Row = {};
    const src = r as unknown as Row;
    for (const f in src) {
      const v = src[f];
      if (v === undefined) continue;
      if (f === 'sourceId' && v === sid) continue;
      if (f === 'kind' && v === kind) continue;
      if (f === 'key' && v === prefix + String(src.providerId)) continue;
      if (f === 'categoryKey' && typeof v === 'string' && v.indexOf(prefix) === 0) {
        o.ck = v.slice(prefix.length);
        continue;
      }
      o[f] = v;
    }
    return o;
  });
}

function unpackRows<T>(packed: Row[] | Columns, sid: string, kind: string): T[] {
  if (!Array.isArray(packed)) return unpackColumns<T>(packed, sid, kind);
  const rows = packed;
  const prefix = `${sid}:${kind}:`;
  for (const o of rows) {
    if (o.sourceId === undefined) o.sourceId = sid;
    if (o.kind === undefined) o.kind = kind;
    if (o.key === undefined) o.key = prefix + String(o.providerId);
    if (o.ck !== undefined) {
      o.categoryKey = prefix + String(o.ck);
      delete o.ck;
    }
  }
  return rows as unknown as T[];
}

/**
 * Rows as columns: field names once, then one array of values per row. Half the JSON of objects
 * with repeated keys, and JSON.parse on a TV is about twice as fast.
 */
interface Columns {
  f: string[];
  r: unknown[][];
}

function packRows(rows: Array<Item | Category>, sid: string, kind: string): Columns {
  const objs = packRowObjects(rows, sid, kind);
  const f: string[] = [];
  const idx: Record<string, number> = {};
  for (const o of objs) for (const k in o) if (idx[k] === undefined) idx[k] = f.push(k) - 1;
  const r = objs.map((o) => {
    const a: unknown[] = new Array(f.length);
    for (let i = 0; i < f.length; i++) a[i] = o[f[i]] === undefined ? null : o[f[i]];
    // Trailing empty fields are dropped.
    let n = a.length;
    while (n > 0 && a[n - 1] === null) n--;
    a.length = n;
    return a;
  });
  return { f, r };
}

/**
 * Columns -> items in one pass. The rebuilt fields come first so every item has the same shape
 * (fast property access later), and nothing is deleted (`delete` makes objects slow in V8).
 */
function unpackColumns<T>(c: Columns, sid: string, kind: string): T[] {
  const prefix = sid + ':' + kind + ':';
  const f = c.f;
  const n = c.r.length;
  const out: Row[] = new Array(n);
  const ckAt = f.indexOf('ck');
  const keyAt = f.indexOf('key');
  const pidAt = f.indexOf('providerId');
  const srcAt = f.indexOf('sourceId');
  const kindAt = f.indexOf('kind');
  for (let i = 0; i < n; i++) {
    const a = c.r[i];
    const pid = pidAt >= 0 ? a[pidAt] : undefined;
    const o: Row = {
      key: keyAt >= 0 && a[keyAt] !== null && a[keyAt] !== undefined ? a[keyAt] : prefix + String(pid),
      sourceId: srcAt >= 0 && a[srcAt] !== null && a[srcAt] !== undefined ? a[srcAt] : sid,
      kind: kindAt >= 0 && a[kindAt] !== null && a[kindAt] !== undefined ? a[kindAt] : kind,
    };
    if (ckAt >= 0 && a[ckAt] !== null && a[ckAt] !== undefined) o.categoryKey = prefix + String(a[ckAt]);
    for (let j = 0; j < a.length; j++) {
      if (j === ckAt || j === keyAt || j === srcAt || j === kindAt) continue;
      const v = a[j];
      if (v !== null) o[f[j]] = v;
    }
    out[i] = o;
  }
  return out as unknown as T[];
}

interface LibraryLike {
  sourceId: string;
  categories: Category[];
  live: Item[];
  movies: Item[];
  series: Item[];
}

/** Library -> plain object with compact rows. Categories are grouped by kind for the same reason. */
export function packLibrary<L extends LibraryLike>(lib: L): Row {
  const sid = lib.sourceId;
  const out: Row = { ...(lib as unknown as Row) };
  out.categories = undefined;
  out.cats = {
    live: packRows(lib.categories.filter((c) => c.kind === 'live'), sid, 'live'),
    movie: packRows(lib.categories.filter((c) => c.kind === 'movie'), sid, 'movie'),
    series: packRows(lib.categories.filter((c) => c.kind === 'series'), sid, 'series'),
  };
  out.live = packRows(lib.live, sid, 'live');
  out.movies = packRows(lib.movies, sid, 'movie');
  out.series = packRows(lib.series, sid, 'series');
  out.packed = 1;
  return out;
}

export function unpackLibrary<L>(o: Row): L {
  if (!o.packed) return o as unknown as L;
  const sid = o.sourceId as string;
  const cats = o.cats as Record<string, Row[] | Columns>;
  o.categories = unpackRows<Category>(cats.live, sid, 'live')
    .concat(unpackRows<Category>(cats.movie, sid, 'movie'), unpackRows<Category>(cats.series, sid, 'series'));
  delete o.cats;
  delete o.packed;
  o.live = unpackRows(o.live as Row[] | Columns, sid, 'live');
  o.movies = unpackRows(o.movies as Row[] | Columns, sid, 'movie');
  o.series = unpackRows(o.series as Row[] | Columns, sid, 'series');
  return o as unknown as L;
}

/** Any JSON value -> gzipped chunks. */
export function encode(value: unknown): Uint8Array[] {
  const bytes = gzipSync(strToU8(JSON.stringify(value)), { level: 4 });
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) chunks.push(bytes.slice(i, i + CHUNK_SIZE));
  if (!chunks.length) chunks.push(new Uint8Array(0));
  return chunks;
}

export function gunzipBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return gunzipSync(all);
}

/** JSON bytes (from gunzipBytes) -> value. */
export function parseBytes<T>(bytes: ArrayBuffer): T {
  return JSON.parse(strFromU8(new Uint8Array(bytes))) as T;
}

/** Milliseconds per step of the last decode (Settings > About). */
export const decodeTimes = { gunzip: 0, text: 0, parse: 0 };

export function decode<T>(chunks: Uint8Array[]): T {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  let t = Date.now();
  const raw = gunzipSync(all);
  decodeTimes.gunzip = Date.now() - t;
  t = Date.now();
  const text = strFromU8(raw);
  decodeTimes.text = Date.now() - t;
  t = Date.now();
  const value = JSON.parse(text) as T;
  decodeTimes.parse = Date.now() - t;
  return value;
}
