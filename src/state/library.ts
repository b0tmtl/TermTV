// The library: every enabled source merged into one catalog, plus the guide and search.
//
// Big arrays live outside the store (plain module state) so they aren't copied on each update;
// the store only carries status and version counters that components subscribe to.

import {
  buildCategoryViews, dropHiddenCategories, isHidden, markKnown, sortItems, visibleCategories, type CategoryView, type ItemSort,
} from '@/core/categories';
import type { Category, Channel, Episode, Item, MediaKind, Movie, Programme, Series, SeriesDetails, MovieDetails, Source } from '@/core/models';
import { ALL_KINDS, DocKind, type SearchResult } from '@/core/search/engine';
import { XtreamClient, xtreamServers } from '@/providers/xtream';
import { parseBytes, unpackLibrary } from '@/workers/cache-codec';
import type { EpgChannelRef, SearchBuildDocs, SourceEpg, SourceLibrary } from '@/workers/protocol';
import { cacheState, deleteCache, loadCache, loadSmall, noteStage, saveCache, saveSmall, withTimeout } from './cache';
import { createStore } from './store';
import { hiddenInEveryProfile, updateCategoryPrefs, user } from './user';
import { toast } from '@/ui/ui-state';
import { t } from '@/i18n';
import { libraryWorker, searchWorker } from './workers';

export interface LibraryStatus {
  status: 'empty' | 'loading' | 'ready' | 'error';
  /** Sources currently refreshing, with their stage. */
  refreshing: Record<string, { stage: string; loaded?: number; total?: number }>;
  errors: Record<string, string>;
  version: number;
  epgVersion: number;
  searchReady: boolean;
  /** Startup step while the saved library loads: 'readCache' | 'decodeCache'. */
  stage?: string;
  /** Home is showing the snapshot while the full library loads. */
  partial?: boolean;
}

export const libraryState = createStore<LibraryStatus>({
  status: 'empty',
  refreshing: {},
  errors: {},
  version: 0,
  epgVersion: 0,
  searchReady: false,
});

// ---- In-memory catalog ----------------------------------------------------------------------

const sourceLibs = new Map<string, SourceLibrary>();
const sourceEpgs = new Map<string, SourceEpg>();
let categories: Category[] = [];
let live: Channel[] = [];
let movies: Movie[] = [];
let series: Series[] = [];
const byKey = new Map<string, Item>();
const byCategory = new Map<string, Item[]>();
/** Titles not kept per category key (hidden categories, see dropHiddenCategories). */
const skippedByCategory = new Map<string, number>();
/** Search doc index -> item. */
let docItems: Item[] = [];
const docIndexByKey = new Map<string, number>();

function devProxy(): string | undefined {
  // In a desktop browser the dev server proxies provider requests (they don't send CORS headers).
  return typeof __DEV__ !== 'undefined' && __DEV__ && !(window as any).tizen ? '/proxy?url=' : undefined;
}

function enabledSources(): Source[] {
  return user.get().sources.filter((s) => s.enabled);
}

function combine() {
  // Keep showing the Home snapshot until a real library is there.
  if (snapshot && !sourceLibs.size) return;
  snapshot = null;
  const order = enabledSources().map((s) => s.id);
  categories = [];
  live = [];
  movies = [];
  series = [];
  byKey.clear();
  byCategory.clear();
  skippedByCategory.clear();
  for (const id of order) {
    const l = sourceLibs.get(id);
    if (!l) continue;
    categories = categories.concat(l.categories);
    for (const c of l.categories) if (c.skipped) skippedByCategory.set(c.key, c.skipped);
    live = live.concat(l.live);
    movies = movies.concat(l.movies);
    series = series.concat(l.series);
  }
  const add = (it: Item) => {
    byKey.set(it.key, it);
    const list = byCategory.get(it.categoryKey);
    if (list) list.push(it);
    else byCategory.set(it.categoryKey, [it]);
  };
  live.forEach(add);
  movies.forEach(add);
  series.forEach(add);
  viewCache.clear();
  itemCache.clear();
  derivedCache.clear();
  libraryState.set((s) => ({ version: s.version + 1, partial: false, status: byKey.size ? 'ready' : Object.keys(s.refreshing).length ? 'loading' : 'empty' }));
  scheduleSnapshot();
  rememberKnownCategories();
  scheduleSearch();
}

/** First time a profile sees the library, every category is "known" (only later ones are new). */
function rememberKnownCategories() {
  for (const kind of ['live', 'movie', 'series'] as MediaKind[]) {
    const prefs = user.get().data.categories[kind];
    if (!prefs.known.length) {
      const views = allViews(kind);
      if (views.length) updateCategoryPrefs(kind, (p) => markKnown(p, views));
    }
  }
}

// ---- Loading & refreshing ---------------------------------------------------------------------

export async function initLibrary(): Promise<void> {
  const sources = enabledSources();
  if (!sources.length) {
    libraryState.set({ status: 'empty' });
    return;
  }
  libraryState.set({ status: 'loading' });
  if (!byKey.size) await showSnapshot();
  await Promise.all(
    sources.map(async (s) => {
      libraryState.set({ stage: 'readCache' });
      const lib = await loadCache('library', s.id);
      if (lib) {
        libraryState.set({ stage: 'decodeCache' });
        const t0 = Date.now();
        const decoded = await decodeOnUiThread<SourceLibrary>('library', lib).catch((e) => {
          cacheState.set((c) => ({ library: { ...c.library, [s.id]: { ok: false, at: Date.now(), error: 'Decode: ' + String(e && e.message) } } }));
          return null;
        });
        if (decoded) {
          sourceLibs.set(s.id, decoded.value);
          const l = decoded.value;
          const n = l.live.length + l.movies.length + l.series.length;
          const decode = n + ' titles in ' + (Date.now() - t0) + ' ms (' + decoded.info + ')';
          cacheState.set((c) => ({ library: { ...c.library, [s.id]: { ...c.library[s.id], decode } } }));
        }
      }
      const epg = await loadCache('epg', s.id);
      if (epg) {
        const decoded = await decodeOnUiThread<SourceEpg>('epg', epg).catch(() => null);
        if (decoded) sourceEpgs.set(s.id, decoded.value);
      }
    }),
  );
  libraryState.set({ stage: undefined });
  const tc = Date.now();
  combine();
  const combineMs = Date.now() - tc;
  for (const s of sources) cacheState.set((c) => (c.library[s.id] ? { library: { ...c.library, [s.id]: { ...c.library[s.id], decode: (c.library[s.id].decode || '') + ' · ready ' + combineMs + ' ms' } } } : {}));
  libraryState.set((s) => ({ epgVersion: s.epgVersion + 1 }));
  const stale = sources.filter((s) => !sourceLibs.has(s.id) || user.get().app.refreshOnLaunch);
  if (stale.length) refreshSources(stale);
  else if (!byKey.size) libraryState.set({ status: 'empty' });
}

/**
 * Cache bytes -> library: the worker decompresses (bytes come back without a copy), this thread
 * parses. Receiving already-parsed objects from the worker took ~5x longer than JSON.parse here.
 */
async function decodeOnUiThread<T>(store: 'library' | 'epg', chunks: ArrayBuffer[]): Promise<{ value: T; info: string }> {
  const res = await libraryWorker().call({ type: 'gunzip', chunks }, undefined, chunks);
  if (res.type !== 'raw') throw new Error('No data');
  // Let the screen draw once before the parse (the TV is busy for a moment).
  await new Promise((r) => setTimeout(r, 0));
  let t = Date.now();
  const parsed = parseBytes<Record<string, unknown>>(res.bytes);
  const parseMs = Date.now() - t;
  t = Date.now();
  const value = (store === 'library' ? unpackLibrary(parsed) : parsed) as T;
  return { value, info: 'gunzip ' + res.ms + ' · parse ' + parseMs + ' · unpack ' + (Date.now() - t) + ' ms' };
}

/** Has the worker compress the last refresh (or `value`), then stores it (in the background). */
async function persist(store: 'library' | 'epg', sourceId: string, value?: unknown): Promise<void> {
  try {
    noteStage(store, sourceId, 'compressing');
    const res = await withTimeout(libraryWorker().call({ type: 'encode', store, key: sourceId, value }), 180000, 'Compressing');
    if (res.type === 'encoded') await saveCache(store, sourceId, res.chunks);
  } catch (e) {
    if (store === 'library') cacheState.set((c) => ({ library: { ...c.library, [sourceId]: { ok: false, at: Date.now(), error: 'Compress: ' + String(e && (e as Error).message) } } }));
  }
}

export async function refreshSources(sources: Source[] = enabledSources()): Promise<void> {
  await Promise.all(sources.map((s) => refreshSource(s)));
}

export async function refreshSource(source: Source): Promise<boolean> {
  const setStage = (stage: string, loaded?: number, total?: number) =>
    libraryState.set((s) => ({ refreshing: { ...s.refreshing, [source.id]: { stage, loaded, total } } }));
  const done = () =>
    libraryState.set((s) => {
      const refreshing = { ...s.refreshing };
      delete refreshing[source.id];
      return { refreshing };
    });
  if (!byKey.size) libraryState.set({ status: 'loading' });
  setStage('start');
  try {
    const skip = await hiddenInEveryProfile().catch(() => undefined);
    const res = await libraryWorker().call({ type: 'refresh', source, proxy: devProxy(), skip }, (p) => {
      if (p.type === 'progress') setStage(p.stage, p.loaded, p.total);
    });
    if (res.type !== 'library' || !res.library) throw new Error('No data');
    sourceLibs.set(source.id, res.library);
    libraryState.set((s) => {
      const errors = { ...s.errors };
      delete errors[source.id];
      return { errors };
    });
    done();
    combine();
    persist('library', source.id).then(() => refreshEpg(source));
    return true;
  } catch (e) {
    done();
    libraryState.set((s) => ({
      errors: { ...s.errors, [source.id]: e instanceof Error ? e.message : String(e) },
      status: byKey.size ? 'ready' : 'error',
    }));
    return false;
  }
}

export async function refreshEpg(source: Source): Promise<void> {
  const l = sourceLibs.get(source.id);
  if (!l || !l.epgUrls.length || !l.live.length) return;
  const channels: EpgChannelRef[] = l.live.map((c) => ({ key: c.key, epgId: c.epgId, name: c.name }));
  const app = user.get().app;
  try {
    const res = await libraryWorker().call({
      type: 'epg', source, urls: l.epgUrls, channels, hoursAhead: app.epgHoursAhead, hoursBack: app.epgHoursBack, proxy: devProxy(),
    });
    if (res.type === 'epg' && res.epg) {
      sourceEpgs.set(source.id, res.epg);
      libraryState.set((s) => ({ epgVersion: s.epgVersion + 1 }));
      scheduleSearch();
      persist('epg', source.id);
    }
  } catch (e) {
    console.warn('EPG failed', source.name, e);
  }
}

export async function forgetSource(sourceId: string): Promise<void> {
  sourceLibs.delete(sourceId);
  sourceEpgs.delete(sourceId);
  await deleteCache('library', sourceId);
  await deleteCache('epg', sourceId);
  combine();
}

/** Re-combines after sources were enabled/disabled/reordered. */
export function sourcesChanged(): void {
  combine();
  libraryState.set((s) => ({ epgVersion: s.epgVersion + 1 }));
  scheduleSearch();
}

export function sourceLibrary(sourceId: string): SourceLibrary | undefined {
  return sourceLibs.get(sourceId);
}

// ---- Categories -------------------------------------------------------------------------------

const viewCache = new Map<string, CategoryView[]>();
/** category key -> its view, per `kind|merge` (same lifetime as viewCache). */
const viewByKeyCache = new Map<string, { views: CategoryView[]; map: Map<string, CategoryView> }>();
/**
 * Results that depend on the library and on the user's choices (hidden, locked, history). Cleared
 * when either changes; without it Home and the VOD screens rescanned every title on each render.
 */
const derivedCache = new Map<string, unknown>();

function derived<T>(key: string, make: () => T): T {
  if (derivedCache.has(key)) return derivedCache.get(key) as T;
  const v = make();
  derivedCache.set(key, v);
  return v;
}

export function allViews(kind: MediaKind): CategoryView[] {
  const merge = user.get().data.categories[kind].mergeSameName;
  const ck = `${kind}|${merge}`;
  let v = viewCache.get(ck);
  if (!v) {
    v = buildCategoryViews(categories, kind, enabledSources().map((s) => s.id), merge).filter((view) =>
      view.keys.some((k) => (byCategory.get(k) || []).length > 0 || (skippedByCategory.get(k) || 0) > 0),
    );
    viewCache.set(ck, v);
  }
  return v;
}

export function isViewLocked(view: CategoryView): boolean {
  const locked = user.get().data.locked;
  return locked.some((id) => id === view.id || id.slice(id.indexOf(':')) === view.id.slice(view.id.indexOf(':')));
}

/** Categories to browse: sorted per prefs, hidden ones removed, locked ones removed in "hide" mode. */
export function browseViews(kind: MediaKind): CategoryView[] {
  return derived(`browse|${kind}`, () => computeBrowseViews(kind));
}

function computeBrowseViews(kind: MediaKind): CategoryView[] {
  const s = user.get();
  const prefs = s.data.categories[kind];
  const hideLocked = !!s.app.parentalPin && s.app.lockMode === 'hide' && !s.unlocked;
  return visibleCategories(allViews(kind), prefs, { watchCount: (v) => watchCount(v) }).filter((v) => !(hideLocked && isViewLocked(v)));
}

function watchCount(view: CategoryView): number {
  const perCat = derived('watchPerCat', () => {
    const m = new Map<string, number>();
    for (const h of user.get().data.history) {
      const it = byKey.get(h.key);
      if (it) m.set(it.categoryKey, (m.get(it.categoryKey) || 0) + 1);
    }
    return m;
  });
  let n = 0;
  for (const k of view.keys) n += perCat.get(k) || 0;
  return n;
}

const itemCache = new Map<string, Item[]>();

export function itemsInView(view: CategoryView, sort?: ItemSort): Item[] {
  const mode = sort || user.get().data.categories[view.kind].itemSort;
  const ck = `${view.id}|${mode}`;
  let list = itemCache.get(ck);
  if (!list) {
    let raw: Item[] = [];
    for (const k of view.keys) raw = raw.concat(byCategory.get(k) || []);
    const last = new Map<string, number>();
    if (mode === 'recent') for (const h of user.get().data.history) last.set(h.key, h.at);
    list = sortItems(raw, mode, { lastWatched: (k) => last.get(k) || 0 });
    itemCache.set(ck, list);
  }
  return list;
}

export function invalidateItemCache(): void {
  itemCache.clear();
  derivedCache.clear();
}

export function viewOfItem(item: Item): CategoryView | undefined {
  const views = allViews(item.kind);
  let c = viewByKeyCache.get(item.kind);
  if (!c || c.views !== views) {
    c = { views, map: new Map() };
    for (const v of views) for (const k of v.keys) c.map.set(k, v);
    viewByKeyCache.set(item.kind, c);
  }
  return c.map.get(item.categoryKey);
}

/** Number of items in a view, without sorting them. */
export function countInView(view: CategoryView): number {
  let n = 0;
  for (const k of view.keys) n += (byCategory.get(k) || []).length + (skippedByCategory.get(k) || 0);
  return n;
}

/** Sources whose titles in this view were not kept (the view was hidden when they loaded). */
function sourcesWithSkipped(view: CategoryView): string[] {
  const out: string[] = [];
  for (const k of view.keys) {
    if (!skippedByCategory.get(k)) continue;
    const sid = k.slice(0, k.indexOf(':'));
    if (out.indexOf(sid) < 0) out.push(sid);
  }
  return out;
}

/** Hiding categories: drop their titles now (and save), instead of at the next update. */
async function dropNewlyHidden(): Promise<void> {
  if (!user.get().app.skipHidden) return;
  const skip = await hiddenInEveryProfile().catch(() => undefined);
  if (!skip) return;
  let changed = false;
  for (const src of enabledSources()) {
    const l = sourceLibs.get(src.id);
    if (!l || libraryState.get().refreshing[src.id]) continue;
    const copy: SourceLibrary = { ...l, categories: l.categories.map((c) => ({ ...c })), episodes: l.episodes ? { ...l.episodes } : undefined };
    if (dropHiddenCategories(copy, src.id, skip) > 0) {
      sourceLibs.set(src.id, copy);
      persist('library', src.id, copy);
      changed = true;
    }
  }
  if (changed) combine();
}

function categoriesChanged(): void {
  reloadUnhidden();
  dropNewlyHidden();
}

/** A category whose titles were dropped is shown again: load the source again to get them back. */
function reloadUnhidden(): void {
  if (!skippedByCategory.size) return;
  const prefs = user.get().data.categories;
  const want: string[] = [];
  for (const kind of ['live', 'movie', 'series'] as MediaKind[]) {
    for (const v of allViews(kind)) {
      if (isHidden(v, prefs[kind])) continue;
      for (const sid of sourcesWithSkipped(v)) if (want.indexOf(sid) < 0) want.push(sid);
    }
  }
  const busy = libraryState.get().refreshing;
  const sources = enabledSources().filter((s) => want.indexOf(s.id) >= 0 && !busy[s.id]);
  if (!sources.length) return;
  toast(t('categories.reloading'));
  refreshSources(sources);
}

/** Every browsable item of a kind ("All"), in category order. */
export function allBrowseItems(kind: MediaKind): Item[] {
  const s = user.get();
  return derived(`all|${kind}|${s.data.categories[kind].itemSort}`, () => {
    const out: Item[] = [];
    const lockedOut = !s.unlocked;
    for (const v of browseViews(kind)) {
      if (lockedOut && isViewLocked(v)) continue;
      const list = itemsInView(v);
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    }
    return out;
  });
}

export function isItemLocked(item: Item): boolean {
  const s = user.get();
  if (!s.app.parentalPin || s.unlocked) return false;
  const v = viewOfItem(item);
  if (!v) return false;
  const locked = derived('locked', () => new Map<string, boolean>());
  let l = locked.get(v.id);
  if (l === undefined) {
    l = isViewLocked(v);
    locked.set(v.id, l);
  }
  return l;
}

export function itemByKey(key: string): Item | undefined {
  return byKey.get(key);
}

export function allChannels(): Channel[] {
  return live;
}

export function counts(): Record<MediaKind, number> {
  return { live: live.length, movie: movies.length, series: series.length };
}

/** Items newest first ("Recently added" rows). */
export function recentlyAdded(kind: 'movie' | 'series', limit = 40): Item[] {
  if (snapshot) return snapshotItems(kind === 'movie' ? snapshot.newMovies : snapshot.newSeries).slice(0, limit);
  const all = derived(`new|${kind}`, () => {
    const list: Item[] = kind === 'movie' ? movies : series;
    return list
      .filter((i) => i.added && !isItemLocked(i) && !hiddenItem(i))
      .sort((a, b) => (b.added || 0) - (a.added || 0))
      .slice(0, 200);
  });
  return all.slice(0, limit);
}

function hiddenItem(item: Item): boolean {
  const v = viewOfItem(item);
  if (!v) return false;
  const hidden = derived(`hidden|${item.kind}`, () => new Map<string, boolean>());
  let h = hidden.get(v.id);
  if (h === undefined) {
    h = isHidden(v, user.get().data.categories[item.kind]);
    hidden.set(v.id, h);
  }
  return h;
}

/** Suggestions from watch history: unwatched titles from the categories this profile watches most. */
export function suggestions(limit = 30): Item[] {
  if (snapshot) return snapshotItems(snapshot.suggested).slice(0, limit);
  return derived(`suggest|${limit}`, () => computeSuggestions(limit));
}

function computeSuggestions(limit: number): Item[] {
  const s = user.get();
  const watched = new Set(s.data.history.map((h) => h.key));
  const weight = new Map<string, number>();
  for (const h of s.data.history.slice(0, 60)) {
    const it = byKey.get(h.key);
    if (it && it.kind !== 'live') weight.set(it.categoryKey, (weight.get(it.categoryKey) || 0) + 1);
  }
  const pool: Item[] = [];
  const cats = Array.from(weight.keys());
  const candidates: Item[] = [];
  if (cats.length) {
    for (const c of cats) {
      const l = byCategory.get(c) || [];
      for (let i = 0; i < l.length && i < 400; i++) candidates.push(l[i]);
    }
  } else {
    for (const list of [movies, series] as Item[][]) for (const i of list) if (((i as Movie).rating || 0) >= 7) candidates.push(i);
  }
  for (const it of candidates) {
    if (watched.has(it.key) || isItemLocked(it) || hiddenItem(it)) continue;
    pool.push(it);
  }
  const score = (i: Item) =>
    (weight.get(i.categoryKey) || 0) * 2 + ((i as Movie).rating || 0) + ((i.added || 0) > Date.now() - 60 * 86400000 ? 3 : 0);
  const picked = pool.sort((a, b) => score(b) - score(a)).slice(0, limit);
  if (picked.length) return picked;
  // No history and no ratings (typical for M3U playlists): a mix of the first titles of each category.
  const mix: Item[] = [];
  for (const kind of ['movie', 'series'] as const) {
    for (const v of allViews(kind)) {
      const first = (byCategory.get(v.keys[0]) || []).find((i) => !watched.has(i.key) && !isItemLocked(i) && !hiddenItem(i));
      if (first) mix.push(first);
      if (mix.length >= limit) break;
    }
  }
  return mix.slice(0, limit);
}

// ---- Sources: clients, URLs, details ---------------------------------------------------------

const clients = new Map<string, XtreamClient>();

export function xtreamClient(sourceId: string): XtreamClient | null {
  const src = user.get().sources.find((s) => s.id === sourceId);
  if (!src || src.config.type !== 'xtream') return null;
  let c = clients.get(sourceId);
  const lib = sourceLibs.get(sourceId);
  if (!c || c.config !== src.config) {
    c = new XtreamClient(src.config);
    clients.set(sourceId, c);
  }
  // The server that worked last in this session, else the one that answered at the last update
  // (a backup URL when the main one was down).
  return c.useServer(activeServer.get(sourceId) || (lib && lib.server));
}

/** Server URL that worked last, per source (switches when one goes down while watching). */
const activeServer = new Map<string, string>();

/** All server URLs of an Xtream source (main + backups), or [] for other sources. */
export function sourceServers(sourceId: string): string[] {
  const src = user.get().sources.find((s) => s.id === sourceId);
  return src && src.config.type === 'xtream' ? xtreamServers(src.config) : [];
}

/**
 * Moves an Xtream source to its next server URL (wrapping around). Returns the new position
 * (1-based) and the count, or null when the source has a single URL.
 */
export function switchServer(sourceId: string, currentFailed = true): { n: number; total: number } | null {
  const servers = sourceServers(sourceId);
  const c = xtreamClient(sourceId);
  if (!c || servers.length < 2) return null;
  const i = Math.max(0, servers.indexOf(c.base));
  if (currentFailed) failedAt.set(c.base, Date.now());
  // Next URL that hasn't failed in the last minutes; if all have, the one that failed longest ago.
  let pick = -1;
  let oldest = Infinity;
  for (let k = 1; k < servers.length; k++) {
    const j = (i + k) % servers.length;
    const f = failedAt.get(servers[j]) || 0;
    if (Date.now() - f > FAILED_FOR) {
      pick = j;
      break;
    }
    if (f < oldest) {
      oldest = f;
      pick = j;
    }
  }
  activeServer.set(sourceId, servers[pick]);
  c.useServer(servers[pick]);
  return { n: pick + 1, total: servers.length };
}

/** When a server URL last failed (a stream or an API call), so it isn't retried right away. */
const failedAt = new Map<string, number>();
const FAILED_FOR = 3 * 60 * 1000;

/** Runs an Xtream API call, trying the other server URLs when it fails. */
async function withServers<T>(sourceId: string, call: (c: XtreamClient) => Promise<T>): Promise<T> {
  const c = xtreamClient(sourceId)!;
  try {
    return await call(c);
  } catch (e) {
    const servers = sourceServers(sourceId);
    for (let k = 1; k < servers.length; k++) {
      switchServer(sourceId);
      try {
        return await call(c);
      } catch {
        /* next one */
      }
    }
    throw e;
  }
}

export function streamUrl(item: Channel | Movie, liveFormat: 'ts' | 'm3u8' = 'ts'): string {
  const c = xtreamClient(item.sourceId);
  if (c) return item.kind === 'live' ? c.liveUrl(item, liveFormat) : c.movieUrl(item);
  return item.url || '';
}

export function episodeUrl(series: Series, ep: Episode): string {
  const c = xtreamClient(series.sourceId);
  return c ? c.episodeUrl(ep) : ep.url || '';
}

/** URL to give the player; in desktop dev mode it goes through the proxy. */
export function playableUrl(url: string): string {
  const proxy = devProxy();
  return proxy && /^https?:\/\//.test(url) ? proxy + encodeURIComponent(url) : url;
}

const detailsCache = new Map<string, MovieDetails | SeriesDetails>();

export async function movieDetails(movie: Movie): Promise<MovieDetails> {
  const cached = detailsCache.get(movie.key);
  if (cached) return cached;
  const c = xtreamClient(movie.sourceId);
  const d: MovieDetails = c ? await withServers(movie.sourceId, (x) => x.movieDetails(movie)).catch(() => ({})) : {};
  if (!d.year && movie.year) d.year = movie.year;
  detailsCache.set(movie.key, d);
  return d;
}

export async function seriesDetails(s: Series): Promise<SeriesDetails> {
  const cached = detailsCache.get(s.key) as SeriesDetails | undefined;
  if (cached) return cached;
  const c = xtreamClient(s.sourceId);
  let d: SeriesDetails;
  if (c) d = await withServers(s.sourceId, (x) => x.seriesDetails(s));
  else {
    const eps = (sourceLibs.get(s.sourceId)?.episodes || {})[s.key] || [];
    const seasons: number[] = [];
    for (const e of eps) if (seasons.indexOf(e.season) < 0) seasons.push(e.season);
    d = { seasons, episodes: eps, plot: s.plot };
  }
  detailsCache.set(s.key, d);
  return d;
}

// ---- Guide ------------------------------------------------------------------------------------

function epgIdFor(ch: Channel): string | undefined {
  const e = sourceEpgs.get(ch.sourceId);
  if (!e) return undefined;
  return ch.epgId && e.programmes[ch.epgId] ? ch.epgId : e.matched[ch.key] || ch.epgId;
}

export function programmes(ch: Channel): Programme[] {
  const e = sourceEpgs.get(ch.sourceId);
  const id = epgIdFor(ch);
  return (e && id && e.programmes[id]) || [];
}

export function nowNext(ch: Channel, at = Date.now()): { now?: Programme; next?: Programme } {
  const list = programmes(ch);
  for (let i = 0; i < list.length; i++) {
    if (list[i].start <= at && list[i].end > at) return { now: list[i], next: list[i + 1] };
    if (list[i].start > at) return { next: list[i] };
  }
  return {};
}

export function hasGuide(): boolean {
  let any = false;
  sourceEpgs.forEach((e) => {
    if (Object.keys(e.programmes).length) any = true;
  });
  return any;
}

/** Fills in "now playing" for an Xtream channel with no XMLTV data, using the short EPG API. */
export async function fetchShortEpg(ch: Channel): Promise<Programme[]> {
  const local = programmes(ch);
  if (local.length) return local;
  const c = xtreamClient(ch.sourceId);
  return c ? withServers(ch.sourceId, (x) => x.shortEpg(ch)).catch(() => []) : [];
}

// ---- Search -----------------------------------------------------------------------------------

export type SearchScope = 'all' | 'live' | 'vod' | 'movie' | 'series' | 'guide';

export const SCOPE_KINDS: Record<SearchScope, number> = {
  all: ALL_KINDS,
  live: DocKind.live,
  vod: DocKind.movie | DocKind.series,
  movie: DocKind.movie,
  series: DocKind.series,
  guide: DocKind.programme,
};

let guideDocs: Array<{ channel: Channel; programme: Programme }> = [];
let searchBuild = 0;

/**
 * Building the search indexes walks every title and guide entry on the UI thread, and right after
 * the library appears that made the first seconds of navigation sluggish on TVs. So it waits until
 * the remote has been quiet for a moment, or until search is actually needed.
 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchPending = false;
let lastKeyAt = 0;
if (typeof document !== 'undefined') document.addEventListener('keydown', () => (lastKeyAt = Date.now()), true);

function scheduleSearch(): void {
  searchPending = true;
  clearTimeout(searchTimer);
  const tick = () => {
    if (!searchPending) return;
    if (Date.now() - lastKeyAt < 2500) {
      searchTimer = setTimeout(tick, 1000);
      return;
    }
    flushSearch();
  };
  searchTimer = setTimeout(tick, 3000);
}

function flushSearch(): void {
  if (!searchPending) return;
  searchPending = false;
  clearTimeout(searchTimer);
  buildSearch();
}

function buildSearch() {
  docItems = (live as Item[]).concat(movies, series);
  docIndexByKey.clear();
  const n = docItems.length;
  const docs: SearchBuildDocs = { texts: new Array(n), kinds: new Uint8Array(n), numbers: new Int32Array(n), years: new Int16Array(n) };
  for (let i = 0; i < n; i++) {
    const it = docItems[i];
    docIndexByKey.set(it.key, i);
    docs.texts[i] = it.name;
    docs.kinds[i] = DocKind[it.kind];
    if (it.kind === 'live') docs.numbers![i] = it.number || 0;
    else docs.years![i] = it.year || 0;
  }
  const build = ++searchBuild;
  libraryState.set({ searchReady: false });
  searchWorker()
    .call({ type: 'build', docs }, undefined, [docs.kinds.buffer, docs.numbers!.buffer, docs.years!.buffer])
    .then(() => {
      if (build !== searchBuild) return;
      libraryState.set({ searchReady: true });
      updateSearchFilters();
    })
    .catch((e) => console.warn('search build failed', e));
  buildGuideSearch();
}

function buildGuideSearch() {
  const now = Date.now();
  guideDocs = [];
  for (const ch of live) {
    for (const p of programmes(ch)) if (p.end > now) guideDocs.push({ channel: ch, programme: p });
  }
  searchWorker()
    .call({
      type: 'build',
      guide: true,
      docs: { texts: guideDocs.map((g) => g.programme.title), kinds: new Uint8Array(guideDocs.length).fill(DocKind.programme) },
    })
    .catch(() => undefined);
}

/** Pushes hidden/locked exclusions and favorite/history boosts to the search worker. */
export function updateSearchFilters(): void {
  if (!docItems.length) return;
  const s = user.get();
  const mask = new Uint8Array(docItems.length);
  const hiddenCats = new Set<string>();
  const lockedCats = new Set<string>();
  const hideLocked = !!s.app.parentalPin && !s.unlocked;
  for (const kind of ['live', 'movie', 'series'] as MediaKind[]) {
    for (const v of allViews(kind)) {
      if (!s.data.settings.searchHidden && isHidden(v, s.data.categories[kind])) v.keys.forEach((k) => hiddenCats.add(k));
      if (hideLocked && isViewLocked(v)) v.keys.forEach((k) => lockedCats.add(k));
    }
  }
  let any = false;
  docItems.forEach((it, i) => {
    if (hiddenCats.has(it.categoryKey) || lockedCats.has(it.categoryKey)) {
      mask[i] = 1;
      any = true;
    }
  });
  const boosts: Array<[number, number]> = [];
  s.data.favorites.forEach((k) => {
    const d = docIndexByKey.get(k);
    if (d !== undefined) boosts.push([d, 15]);
  });
  s.data.history.slice(0, 100).forEach((h, i) => {
    const d = docIndexByKey.get(h.key);
    if (d !== undefined) boosts.push([d, Math.max(2, 10 - i / 10)]);
  });
  searchWorker().call({ type: 'exclude', mask: any ? mask : null }).catch(() => undefined);
  searchWorker().call({ type: 'boost', boosts }).catch(() => undefined);
}

export interface SearchItemHit {
  item: Item;
  variants: Item[];
}

export interface SearchGuideHit {
  channel: Channel;
  programme: Programme;
}

export interface SearchOutput {
  items: SearchItemHit[];
  guide: SearchGuideHit[];
  totals: SearchResult['totals'];
  tookMs: number;
}

export async function search(q: string, scope: SearchScope, limit = 200): Promise<SearchOutput> {
  flushSearch();
  const out: SearchOutput = { items: [], guide: [], totals: { live: 0, movie: 0, series: 0, programme: 0 }, tookMs: 0 };
  if (!q.trim()) return out;
  const wantGuide = scope === 'all' || scope === 'guide';
  const wantItems = scope !== 'guide';
  const [itemsRes, guideRes] = await Promise.all([
    wantItems ? searchWorker().call({ type: 'query', q, kinds: SCOPE_KINDS[scope], limit }) : Promise.resolve(null),
    wantGuide ? searchWorker().call({ type: 'query', q, kinds: ALL_KINDS, limit: scope === 'guide' ? limit : 30, guide: true }) : Promise.resolve(null),
  ]);
  if (itemsRes && itemsRes.type === 'result') {
    out.totals = { ...itemsRes.result.totals };
    out.tookMs = itemsRes.result.tookMs;
    for (const h of itemsRes.result.hits) {
      const item = docItems[h.doc];
      if (!item) continue;
      out.items.push({ item, variants: (h.variants || []).map((d) => docItems[d]).filter(Boolean) });
    }
  }
  if (guideRes && guideRes.type === 'result') {
    const now = Date.now();
    out.guide = guideRes.result.hits
      .map((h) => guideDocs[h.doc])
      .filter((g) => g && !isItemLocked(g.channel) && !hiddenItem(g.channel))
      // On now first, then by start time.
      .sort((a, b) => (a.programme.start <= now ? 0 : 1) - (b.programme.start <= now ? 0 : 1) || a.programme.start - b.programme.start);
    out.totals.programme = out.guide.length;
    out.tookMs = Math.max(out.tookMs, guideRes.result.tookMs);
  }
  return out;
}

// Keep search filters in sync with the user's category choices.
let lastData = user.get().data;
let lastApp = user.get().app;
let lastUnlocked = user.get().unlocked;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let unhideTimer: ReturnType<typeof setTimeout> | undefined;
user.subscribe((s) => {
  if (s.data.categories !== lastData.categories) {
    if (
      s.data.categories.live.mergeSameName !== lastData.categories.live.mergeSameName ||
      s.data.categories.movie.mergeSameName !== lastData.categories.movie.mergeSameName ||
      s.data.categories.series.mergeSameName !== lastData.categories.series.mergeSameName
    )
      viewCache.clear();
    itemCache.clear();
  }
  if (s.data.favorites !== lastData.favorites || s.data.history !== lastData.history || s.data.lists !== lastData.lists) scheduleSnapshot();
  if (s.data.categories !== lastData.categories) {
    clearTimeout(unhideTimer);
    unhideTimer = setTimeout(categoriesChanged, 2000);
  }
  if (s.data !== lastData || s.app !== lastApp || s.unlocked !== lastUnlocked) {
    derivedCache.clear();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(updateSearchFilters, 300);
  }
  lastData = s.data;
  lastApp = s.app;
  lastUnlocked = s.unlocked;
});

// ---- Versions of the same title (other sources, FHD / 4K) ---------------------------------------

/**
 * Other items with the same title + year. The search worker already grouped them while indexing;
 * computing it here meant normalizing every title on the UI thread (a 10 s freeze on old TVs).
 */
export async function variantsOf(item: Item): Promise<Item[]> {
  if (item.kind === 'live') return [];
  flushSearch();
  const doc = docIndexByKey.get(item.key);
  if (doc === undefined) return [];
  const res = await searchWorker().call({ type: 'variants', doc }).catch(() => null);
  if (!res || res.type !== 'variants') return [];
  return res.docs.map((d) => docItems[d]).filter((i): i is Item => !!i && i.kind === item.kind);
}

// ---- Home snapshot ----------------------------------------------------------------------------
// The titles Home shows (continue watching, favorites, lists, suggestions, new titles) are saved in
// a small file. At launch Home appears from it in a moment, while the full library (which can take
// 10 s or more to read on an old TV) loads behind it. Other screens wait for the full library.

interface HomeSnapshot {
  v: 1;
  savedAt: number;
  items: Item[];
  suggested: string[];
  newMovies: string[];
  newSeries: string[];
}

let snapshot: HomeSnapshot | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

const snapshotName = () => 'home-' + (user.get().activeProfileId || 'default');

function snapshotItems(keys: string[]): Item[] {
  const out: Item[] = [];
  for (const k of keys) {
    const it = byKey.get(k);
    if (it) out.push(it);
  }
  return out;
}

async function showSnapshot(): Promise<void> {
  const snap = await loadSmall<HomeSnapshot>(snapshotName());
  if (!snap || snap.v !== 1 || !snap.items || !snap.items.length || byKey.size) return;
  snapshot = snap;
  for (const it of snap.items) byKey.set(it.key, it);
  libraryState.set((s) => ({ status: 'ready', partial: true, version: s.version + 1 }));
}

function scheduleSnapshot(): void {
  if (snapshot || !byKey.size) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    saveSnapshot().catch((e) => console.warn('home snapshot failed', e));
  }, 8000);
}

async function saveSnapshot(): Promise<void> {
  if (snapshot || !byKey.size) return;
  const s = user.get();
  const keys: string[] = [];
  const add = (k: string) => {
    if (keys.indexOf(k) < 0 && byKey.has(k)) keys.push(k);
  };
  s.data.history.slice(0, 60).forEach((h) => add(h.key));
  s.data.favorites.slice(0, 300).forEach(add);
  s.data.lists.forEach((l) => l.items.slice(0, 40).forEach(add));
  const suggested = suggestions(40).map((i) => i.key);
  const newMovies = recentlyAdded('movie', 40).map((i) => i.key);
  const newSeries = recentlyAdded('series', 40).map((i) => i.key);
  suggested.concat(newMovies, newSeries).forEach(add);
  // Never put parental-locked titles in a file that is read before any PIN is asked.
  const pin = !!s.app.parentalPin;
  const items = keys
    .map((k) => byKey.get(k)!)
    .filter((it) => {
      if (!pin) return true;
      const v = viewOfItem(it);
      return !(v && isViewLocked(v));
    });
  const ok = new Set(items.map((i) => i.key));
  const only = (l: string[]) => l.filter((k) => ok.has(k));
  const snap: HomeSnapshot = { v: 1, savedAt: Date.now(), items, suggested: only(suggested), newMovies: only(newMovies), newSeries: only(newSeries) };
  await saveSmall(snapshotName(), snap);
}
