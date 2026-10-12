// The library: every enabled source merged into one catalog, plus the guide and search.
//
// Big arrays live outside the store (plain module state) so they aren't copied on each update;
// the store only carries status and version counters that components subscribe to.

import {
  buildCategoryViews, isHidden, markKnown, sortItems, visibleCategories, type CategoryView, type ItemSort,
} from '@/core/categories';
import type { Category, Channel, Episode, Item, MediaKind, Movie, Programme, Series, SeriesDetails, MovieDetails, Source } from '@/core/models';
import { dedupeKey } from '@/core/normalize';
import { ALL_KINDS, DocKind, type SearchDocInput, type SearchResult } from '@/core/search/engine';
import { XtreamClient } from '@/providers/xtream';
import type { EpgChannelRef, SourceEpg, SourceLibrary } from '@/workers/protocol';
import { createStore } from './store';
import { updateCategoryPrefs, user } from './user';
import { libraryWorker, searchWorker } from './workers';

export interface LibraryStatus {
  status: 'empty' | 'loading' | 'ready' | 'error';
  /** Sources currently refreshing, with their stage. */
  refreshing: Record<string, { stage: string; loaded?: number; total?: number }>;
  errors: Record<string, string>;
  version: number;
  epgVersion: number;
  searchReady: boolean;
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
  const order = enabledSources().map((s) => s.id);
  categories = [];
  live = [];
  movies = [];
  series = [];
  byKey.clear();
  byCategory.clear();
  for (const id of order) {
    const l = sourceLibs.get(id);
    if (!l) continue;
    categories = categories.concat(l.categories);
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
  libraryState.set((s) => ({ version: s.version + 1, status: byKey.size ? 'ready' : Object.keys(s.refreshing).length ? 'loading' : 'empty' }));
  rememberKnownCategories();
  buildSearch();
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
  await Promise.all(
    sources.map(async (s) => {
      const res = await libraryWorker().call({ type: 'load', sourceId: s.id }).catch(() => null);
      if (res && res.type === 'library' && res.library) sourceLibs.set(s.id, res.library);
      const epg = await libraryWorker().call({ type: 'loadEpg', sourceId: s.id }).catch(() => null);
      if (epg && epg.type === 'epg' && epg.epg) sourceEpgs.set(s.id, epg.epg);
    }),
  );
  combine();
  libraryState.set((s) => ({ epgVersion: s.epgVersion + 1 }));
  const stale = sources.filter((s) => !sourceLibs.has(s.id) || user.get().app.refreshOnLaunch);
  if (stale.length) refreshSources(stale);
  else if (!byKey.size) libraryState.set({ status: 'empty' });
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
    const res = await libraryWorker().call({ type: 'refresh', source, proxy: devProxy() }, (p) => {
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
    refreshEpg(source);
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
      buildGuideSearch();
    }
  } catch (e) {
    console.warn('EPG failed', source.name, e);
  }
}

export async function forgetSource(sourceId: string): Promise<void> {
  sourceLibs.delete(sourceId);
  sourceEpgs.delete(sourceId);
  await libraryWorker().call({ type: 'delete', sourceId }).catch(() => undefined);
  combine();
}

/** Re-combines after sources were enabled/disabled/reordered. */
export function sourcesChanged(): void {
  combine();
  libraryState.set((s) => ({ epgVersion: s.epgVersion + 1 }));
  buildGuideSearch();
}

export function sourceLibrary(sourceId: string): SourceLibrary | undefined {
  return sourceLibs.get(sourceId);
}

// ---- Categories -------------------------------------------------------------------------------

const viewCache = new Map<string, CategoryView[]>();

export function allViews(kind: MediaKind): CategoryView[] {
  const merge = user.get().data.categories[kind].mergeSameName;
  const ck = `${kind}|${merge}`;
  let v = viewCache.get(ck);
  if (!v) {
    v = buildCategoryViews(categories, kind, enabledSources().map((s) => s.id), merge).filter((view) =>
      view.keys.some((k) => (byCategory.get(k) || []).length > 0),
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
  const s = user.get();
  const prefs = s.data.categories[kind];
  const hideLocked = !!s.app.parentalPin && s.app.lockMode === 'hide' && !s.unlocked;
  return visibleCategories(allViews(kind), prefs, { watchCount: (v) => watchCount(v) }).filter((v) => !(hideLocked && isViewLocked(v)));
}

function watchCount(view: CategoryView): number {
  let n = 0;
  for (const h of user.get().data.history) {
    const it = byKey.get(h.key);
    if (it && view.keys.indexOf(it.categoryKey) >= 0) n++;
  }
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
}

export function viewOfItem(item: Item): CategoryView | undefined {
  return allViews(item.kind).find((v) => v.keys.indexOf(item.categoryKey) >= 0);
}

export function isItemLocked(item: Item): boolean {
  const s = user.get();
  if (!s.app.parentalPin || s.unlocked) return false;
  const v = viewOfItem(item);
  return !!v && isViewLocked(v);
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
  const list: Item[] = kind === 'movie' ? movies : series;
  return list
    .filter((i) => i.added && !isItemLocked(i) && !hiddenItem(i))
    .sort((a, b) => (b.added || 0) - (a.added || 0))
    .slice(0, limit);
}

function hiddenItem(item: Item): boolean {
  const v = viewOfItem(item);
  return !!v && isHidden(v, user.get().data.categories[item.kind]);
}

/** Suggestions from watch history: unwatched titles from the categories this profile watches most. */
export function suggestions(limit = 30): Item[] {
  const s = user.get();
  const watched = new Set(s.data.history.map((h) => h.key));
  const weight = new Map<string, number>();
  for (const h of s.data.history.slice(0, 60)) {
    const it = byKey.get(h.key);
    if (it && it.kind !== 'live') weight.set(it.categoryKey, (weight.get(it.categoryKey) || 0) + 1);
  }
  const pool: Item[] = [];
  const cats = Array.from(weight.keys());
  const candidates: Item[] = cats.length
    ? cats.reduce<Item[]>((acc, c) => acc.concat((byCategory.get(c) || []).slice(0, 400)), [])
    : (movies as Item[]).concat(series).filter((i) => (i.kind === 'movie' || i.kind === 'series') && (i.rating || 0) >= 7);
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
  if (!c || c.config !== src.config) {
    c = new XtreamClient(src.config);
    clients.set(sourceId, c);
  }
  return c;
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
  const d: MovieDetails = c ? await c.movieDetails(movie).catch(() => ({})) : {};
  if (!d.year && movie.year) d.year = movie.year;
  detailsCache.set(movie.key, d);
  return d;
}

export async function seriesDetails(s: Series): Promise<SeriesDetails> {
  const cached = detailsCache.get(s.key) as SeriesDetails | undefined;
  if (cached) return cached;
  const c = xtreamClient(s.sourceId);
  let d: SeriesDetails;
  if (c) d = await c.seriesDetails(s);
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
  return c ? c.shortEpg(ch).catch(() => []) : [];
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

function buildSearch() {
  docItems = (live as Item[]).concat(movies, series);
  docIndexByKey.clear();
  const docs: SearchDocInput[] = docItems.map((it, i) => {
    docIndexByKey.set(it.key, i);
    return {
      kind: it.kind,
      text: it.name,
      number: it.kind === 'live' ? it.number : undefined,
      group: it.kind === 'live' ? undefined : dedupeKey(it.name, it.year),
    };
  });
  const build = ++searchBuild;
  libraryState.set({ searchReady: false });
  searchWorker()
    .call({ type: 'build', docs })
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
    .call({ type: 'build', guide: true, docs: guideDocs.map((g) => ({ kind: 'programme' as const, text: g.programme.title })) })
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
  if (s.data !== lastData || s.app !== lastApp || s.unlocked !== lastUnlocked) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(updateSearchFilters, 300);
  }
  lastData = s.data;
  lastApp = s.app;
  lastUnlocked = s.unlocked;
});

// ---- Versions of the same title (other sources, FHD / 4K) ---------------------------------------

let variantIndex: Map<string, string[]> | null = null;
let variantVersion = -1;

/** Other items with the same title + year (same movie in another source or quality). */
export function variantsOf(item: Item): Item[] {
  if (item.kind === 'live') return [];
  const v = libraryState.get().version;
  if (!variantIndex || variantVersion !== v) {
    variantIndex = new Map();
    variantVersion = v;
    for (const list of [movies, series] as Item[][]) {
      for (const it of list) {
        const k = it.kind + '|' + dedupeKey(it.name, it.kind !== 'live' ? it.year : undefined);
        const l = variantIndex.get(k);
        if (l) l.push(it.key);
        else variantIndex.set(k, [it.key]);
      }
    }
  }
  const keys = variantIndex.get(item.kind + '|' + dedupeKey(item.name, item.year)) || [];
  return keys.filter((k) => k !== item.key).map((k) => byKey.get(k)).filter((i): i is Item => !!i);
}
