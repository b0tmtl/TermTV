// Category management: sorting, hiding, bulk-hide by prefix, and keeping user choices stable
// across playlist refreshes (providers often renumber category IDs, names are more stable).

import type { Category, Item, MediaKind } from './models';
import { naturalCompare, normalizeText, sortKey, splitPrefix, splitSuffix } from './normalize';

export type CategorySort = 'provider' | 'az' | 'za' | 'custom' | 'mostWatched';
export type ItemSort = 'provider' | 'az' | 'za' | 'number' | 'added' | 'year' | 'rating' | 'recent';

export interface CategoryPrefs {
  sort: CategorySort;
  /** View ids in the user's custom order. Unknown ids are ignored; missing views go to the end. */
  customOrder: string[];
  /** Hidden view ids. */
  hidden: string[];
  /** View ids the user has already seen, used to flag and auto-hide new categories. */
  known: string[];
  newCategories: 'show' | 'hide';
  /** Merge categories with the same name across sources. */
  mergeSameName: boolean;
  itemSort: ItemSort;
}

export function defaultCategoryPrefs(kind: MediaKind): CategoryPrefs {
  return {
    sort: 'provider',
    customOrder: [],
    hidden: [],
    known: [],
    newCategories: 'show',
    mergeSameName: true,
    itemSort: kind === 'live' ? 'provider' : 'added',
  };
}

/** A category as shown to the user; may combine several provider categories. */
export interface CategoryView {
  /** Stable id: `${sourceId or *}:${kind}:${normalized name}` */
  id: string;
  kind: MediaKind;
  name: string;
  /** Detected prefix ("US", "FR"...), empty when none. */
  prefix: string;
  /** Detected trailing tag ("MULTISUB", "FR"...), empty when none. */
  suffix?: string;
  /** Underlying provider category keys. */
  keys: string[];
  sourceIds: string[];
  /** Provider order: source order first, then position. */
  providerRank: number;
}

export function nameKey(name: string): string {
  return normalizeText(name);
}

/** Builds views from raw categories. `sourceOrder` lists source ids in their configured order. */
export function buildCategoryViews(
  categories: Category[],
  kind: MediaKind,
  sourceOrder: string[],
  merge: boolean,
): CategoryView[] {
  const byId = new Map<string, CategoryView>();
  const list = categories.filter((c) => c.kind === kind);
  for (const c of list) {
    const nk = nameKey(c.name);
    const id = `${merge ? '*' : c.sourceId}:${kind}:${nk}`;
    const srcIdx = Math.max(0, sourceOrder.indexOf(c.sourceId));
    const rank = srcIdx * 1_000_000 + c.order;
    let v = byId.get(id);
    if (!v) {
      v = { id, kind, name: c.name.trim(), prefix: splitPrefix(c.name).prefix, suffix: splitSuffix(c.name), keys: [], sourceIds: [], providerRank: rank };
      byId.set(id, v);
    }
    v.keys.push(c.key);
    if (v.sourceIds.indexOf(c.sourceId) < 0) v.sourceIds.push(c.sourceId);
    if (rank < v.providerRank) v.providerRank = rank;
  }
  return Array.from(byId.values()).sort((a, b) => a.providerRank - b.providerRank);
}

function parseId(id: string): { source: string; rest: string } {
  const i = id.indexOf(':');
  return { source: id.slice(0, i), rest: id.slice(i + 1) };
}

/**
 * True when a stored id refers to this view. Ids match on kind + name, and on source unless one
 * side is a merged ("*") id, so toggling "merge same name" keeps hidden/order choices.
 */
export function idMatches(stored: string, view: CategoryView): boolean {
  if (stored === view.id) return true;
  const a = parseId(stored);
  const b = parseId(view.id);
  if (a.rest !== b.rest) return false;
  if (a.source === '*' || b.source === '*') return a.source === '*' ? true : view.sourceIds.indexOf(a.source) >= 0;
  return false;
}

function indexIds(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i);
    const p = parseId(id);
    const loose = `*:${p.rest}`;
    if (!m.has(loose)) m.set(loose, i);
  });
  return m;
}

function lookup(index: Map<string, number>, view: CategoryView): number | undefined {
  const exact = index.get(view.id);
  if (exact !== undefined) return exact;
  const p = parseId(view.id);
  if (p.source === '*') return index.get(`*:${p.rest}`);
  // A per-source view matches a merged stored id.
  return index.get(`*:${p.rest}`);
}

/**
 * Fast `idMatches` against a whole list of stored ids. Lists like `known` hold every category, and
 * checks run once per item on slow TVs, so a linear scan per check is far too slow.
 */
interface IdSet {
  exact: Set<string>;
  /** rest ("kind:name") -> stored sources ("*" or a source id) */
  byRest: Map<string, string[]>;
}

const idSets = new WeakMap<string[], IdSet>();

function idSet(ids: string[]): IdSet {
  let s = idSets.get(ids);
  if (!s) {
    s = { exact: new Set(ids), byRest: new Map() };
    for (const id of ids) {
      const p = parseId(id);
      const l = s.byRest.get(p.rest);
      if (l) l.push(p.source);
      else s.byRest.set(p.rest, [p.source]);
    }
    idSets.set(ids, s);
  }
  return s;
}

/** True when any stored id matches the view (same rule as `idMatches`). */
export function anyIdMatches(ids: string[], view: CategoryView): boolean {
  if (!ids.length) return false;
  const s = idSet(ids);
  if (s.exact.has(view.id)) return true;
  const p = parseId(view.id);
  const sources = s.byRest.get(p.rest);
  if (!sources) return false;
  for (const src of sources) {
    if (src === '*') return true;
    if (p.source === '*' && view.sourceIds.indexOf(src) >= 0) return true;
  }
  return false;
}

export function isHidden(view: CategoryView, prefs: CategoryPrefs): boolean {
  if (anyIdMatches(prefs.hidden, view)) return true;
  if (prefs.newCategories === 'hide' && prefs.known.length > 0 && isNew(view, prefs)) return true;
  return false;
}

export function isNew(view: CategoryView, prefs: CategoryPrefs): boolean {
  return prefs.known.length > 0 && !anyIdMatches(prefs.known, view);
}

export interface SortContext {
  /** Watch count per view id. */
  watchCount?: (view: CategoryView) => number;
}

export function sortCategoryViews(views: CategoryView[], prefs: CategoryPrefs, ctx: SortContext = {}): CategoryView[] {
  const out = views.slice();
  switch (prefs.sort) {
    case 'az':
      out.sort((a, b) => naturalCompare(sortKey(a.name), sortKey(b.name)) || a.providerRank - b.providerRank);
      break;
    case 'za':
      out.sort((a, b) => naturalCompare(sortKey(b.name), sortKey(a.name)) || a.providerRank - b.providerRank);
      break;
    case 'custom': {
      const idx = indexIds(prefs.customOrder);
      const big = Number.MAX_SAFE_INTEGER;
      out.sort((a, b) => {
        const ia = lookup(idx, a);
        const ib = lookup(idx, b);
        return (ia === undefined ? big : ia) - (ib === undefined ? big : ib) || a.providerRank - b.providerRank;
      });
      break;
    }
    case 'mostWatched': {
      const wc = ctx.watchCount || (() => 0);
      out.sort((a, b) => wc(b) - wc(a) || a.providerRank - b.providerRank);
      break;
    }
    default:
      out.sort((a, b) => a.providerRank - b.providerRank);
  }
  return out;
}

/** Sorted, visible categories for browsing. */
export function visibleCategories(views: CategoryView[], prefs: CategoryPrefs, ctx: SortContext = {}): CategoryView[] {
  return sortCategoryViews(views, prefs, ctx).filter((v) => !isHidden(v, prefs));
}

export interface PrefixGroup {
  /** "VOD" for a prefix group, "[FR]" for a trailing-tag group. */
  prefix: string;
  type?: 'prefix' | 'suffix';
  ids: string[];
  hiddenCount: number;
}

/**
 * Groups views by detected prefix ("US", "VOD"...) and by trailing tag ("[FR]", "[MULTISUB]"...),
 * prefixes first, biggest first. Groups used once are skipped.
 */
export function prefixGroups(views: CategoryView[], prefs: CategoryPrefs): PrefixGroup[] {
  const map = new Map<string, PrefixGroup>();
  const add = (key: string, label: string, type: 'prefix' | 'suffix', v: CategoryView, hidden: boolean) => {
    let g = map.get(key);
    if (!g) {
      g = { prefix: label, type, ids: [], hiddenCount: 0 };
      map.set(key, g);
    }
    g.ids.push(v.id);
    if (hidden) g.hiddenCount++;
  };
  for (const v of views) {
    if (!v.prefix && !v.suffix) continue;
    const hidden = isHidden(v, prefs);
    if (v.prefix) add('p:' + v.prefix, v.prefix, 'prefix', v, hidden);
    if (v.suffix) add('s:' + v.suffix, '[' + v.suffix + ']', 'suffix', v, hidden);
  }
  const rank = (g: PrefixGroup) => (g.type === 'suffix' ? 1 : 0);
  return Array.from(map.values())
    .filter((g) => g.ids.length > 1)
    .sort((a, b) => rank(a) - rank(b) || b.ids.length - a.ids.length || (a.prefix < b.prefix ? -1 : 1));
}

/** Returns new prefs with the given views hidden or shown. */
export function setHidden(prefs: CategoryPrefs, views: CategoryView[], hidden: boolean): CategoryPrefs {
  let list = prefs.hidden.filter((h) => !views.some((v) => idMatches(h, v)));
  if (hidden) list = list.concat(views.map((v) => v.id));
  return { ...prefs, hidden: list };
}

/** Views whose name contains the filter text (normalized). */
export function filterViews(views: CategoryView[], text: string): CategoryView[] {
  const q = normalizeText(text);
  if (!q) return views;
  return views.filter((v) => normalizeText(v.name).indexOf(q) >= 0);
}

/** Marks every current view as known (call after the user opens category management). */
export function markKnown(prefs: CategoryPrefs, views: CategoryView[]): CategoryPrefs {
  const known = prefs.known.slice();
  for (const v of views) if (!anyIdMatches(prefs.known, v)) known.push(v.id);
  return { ...prefs, known };
}

export type MoveOp = 'up' | 'down' | 'top' | 'bottom' | { to: number };

/**
 * Moves a view in the custom order. `current` is the full list in its currently displayed order;
 * the result switches the sort mode to custom so the move is visible.
 */
export function moveCategory(prefs: CategoryPrefs, current: CategoryView[], id: string, op: MoveOp): CategoryPrefs {
  const ids = current.map((v) => v.id);
  const from = ids.indexOf(id);
  if (from < 0) return prefs;
  let to: number;
  if (op === 'up') to = Math.max(0, from - 1);
  else if (op === 'down') to = Math.min(ids.length - 1, from + 1);
  else if (op === 'top') to = 0;
  else if (op === 'bottom') to = ids.length - 1;
  else to = Math.max(0, Math.min(ids.length - 1, op.to));
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return { ...prefs, sort: 'custom', customOrder: ids };
}

export interface ItemSortContext {
  /** Last-watched timestamp per item key. */
  lastWatched?: (key: string) => number;
}

/** Sorts items inside a category. Keeps the input untouched. */
export function sortItems<T extends Item>(items: T[], mode: ItemSort, ctx: ItemSortContext = {}): T[] {
  const out = items.slice();
  const byOrder = (a: T, b: T) => a.order - b.order;
  switch (mode) {
    case 'az':
      out.sort((a, b) => naturalCompare(sortKey(a.name), sortKey(b.name)) || byOrder(a, b));
      break;
    case 'za':
      out.sort((a, b) => naturalCompare(sortKey(b.name), sortKey(a.name)) || byOrder(a, b));
      break;
    case 'number':
      out.sort((a, b) => num(a) - num(b) || byOrder(a, b));
      break;
    case 'added':
      out.sort((a, b) => (b.added || 0) - (a.added || 0) || byOrder(a, b));
      break;
    case 'year':
      out.sort((a, b) => yearOf(b) - yearOf(a) || byOrder(a, b));
      break;
    case 'rating':
      out.sort((a, b) => ratingOf(b) - ratingOf(a) || byOrder(a, b));
      break;
    case 'recent': {
      const lw = ctx.lastWatched || (() => 0);
      out.sort((a, b) => lw(b.key) - lw(a.key) || byOrder(a, b));
      break;
    }
    default:
      out.sort(byOrder);
  }
  return out;
}

function num(i: Item): number {
  return i.kind === 'live' && i.number ? i.number : Number.MAX_SAFE_INTEGER;
}
function yearOf(i: Item): number {
  return i.kind !== 'live' && i.year ? i.year : 0;
}
function ratingOf(i: Item): number {
  return i.kind !== 'live' && i.rating ? i.rating : 0;
}

export interface DroppableLibrary {
  categories: Category[];
  live: Item[];
  movies: Item[];
  series: Item[];
  episodes?: Record<string, unknown>;
}

/**
 * Removes the titles of hidden categories from a freshly loaded source (`hidden`: stored view ids
 * per kind). Categories stay, with `skipped` set to how many titles were dropped, so they can still
 * be shown again in category management. Returns the number of titles dropped.
 */
export function dropHiddenCategories(lib: DroppableLibrary, sourceId: string, hidden: Partial<Record<MediaKind, string[]>>): number {
  const drop = new Set<string>();
  for (const kind of ['live', 'movie', 'series'] as MediaKind[]) {
    const ids = hidden[kind];
    if (!ids || !ids.length) continue;
    for (const v of buildCategoryViews(lib.categories, kind, [sourceId], false)) if (anyIdMatches(ids, v)) v.keys.forEach((k) => drop.add(k));
  }
  if (!drop.size) return 0;
  const counts = new Map<string, number>();
  const keep = <T extends Item>(list: T[]): T[] =>
    list.filter((it) => {
      if (!drop.has(it.categoryKey)) return true;
      counts.set(it.categoryKey, (counts.get(it.categoryKey) || 0) + 1);
      return false;
    });
  lib.live = keep(lib.live);
  lib.movies = keep(lib.movies);
  const keptSeries = keep(lib.series);
  if (lib.episodes) {
    const kept = new Set(keptSeries.map((s) => s.key));
    for (const s of lib.series) if (!kept.has(s.key)) delete lib.episodes[s.key];
  }
  lib.series = keptSeries;
  let n = 0;
  for (const c of lib.categories) {
    const k = counts.get(c.key);
    if (k) {
      c.skipped = k;
      n += k;
    }
  }
  return n;
}
