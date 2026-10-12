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
  const rows = Array.isArray(packed) ? packed : fromColumns(packed);
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

function fromColumns(c: Columns): Row[] {
  const out: Row[] = new Array(c.r.length);
  for (let i = 0; i < c.r.length; i++) {
    const a = c.r[i];
    const o: Row = {};
    for (let j = 0; j < a.length; j++) if (a[j] !== null) o[c.f[j]] = a[j];
    out[i] = o;
  }
  return out;
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

export function decode<T>(chunks: Uint8Array[]): T {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return JSON.parse(strFromU8(gunzipSync(all))) as T;
}
