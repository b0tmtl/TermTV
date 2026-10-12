// Sources, profiles and per-profile data (favorites, lists, history, category choices, settings).
// Everything lives on the TV in IndexedDB; Backup / Restore exports it as one JSON file.

import { defaultCategoryPrefs, type CategoryPrefs } from '@/core/categories';
import type { MediaKind, Source } from '@/core/models';
import { dbGet, dbPut } from '@/platform/db';
import { createStore } from './store';

export type ThemeId = 'midnight' | 'matrix' | 'amber' | 'purple' | 'synthwave' | 'paper';
export type PlayerEngine = 'native' | 'html5';

export interface SubtitleStyle {
  size: 'small' | 'medium' | 'large' | 'xlarge';
  color: string;
  background: 'none' | 'shadow' | 'box';
  position: 'bottom' | 'raised' | 'top';
}

export interface ProfileSettings {
  theme: ThemeId;
  playerEngine: PlayerEngine;
  liveFormat: 'ts' | 'm3u8';
  autoplayNext: boolean;
  showRecent: boolean;
  /** Include hidden categories in search results. */
  searchHidden: boolean;
  subtitles: SubtitleStyle;
  subtitleLanguage: string;
  subtitlesAuto: boolean;
  audioLanguage: string;
  clock24h: boolean;
}

export interface FavoriteList {
  id: string;
  name: string;
  items: string[];
}

export interface HistoryEntry {
  key: string; // item key (channel, movie or series)
  kind: MediaKind;
  at: number;
  /** Series: last episode key watched. */
  episodeKey?: string;
}

export interface ResumePoint {
  pos: number; // seconds
  dur: number;
  at: number;
}

export interface Profile {
  id: string;
  name: string;
  avatar: number;
  pin?: string;
  kids?: boolean;
}

export interface ProfileData {
  favorites: string[];
  lists: FavoriteList[];
  history: HistoryEntry[];
  resume: Record<string, ResumePoint>;
  recentSearches: string[];
  categories: Record<MediaKind, CategoryPrefs>;
  /** Category view ids locked by parental control. */
  locked: string[];
  settings: ProfileSettings;
}

export interface AppSettings {
  language: string;
  /** Parental control PIN (global). Empty = not set. */
  parentalPin: string;
  /** Locked categories are hidden completely, or shown and PIN-gated. */
  lockMode: 'hide' | 'pin';
  refreshOnLaunch: boolean;
  /** Hours of guide to keep ahead / behind. */
  epgHoursAhead: number;
  epgHoursBack: number;
  lastProfileId?: string;
  /** New categories after a refresh: shown or hidden automatically. */
  newCategories: 'show' | 'hide';
}

export function defaultSettings(): ProfileSettings {
  return {
    theme: 'midnight',
    playerEngine: 'native',
    liveFormat: 'ts',
    autoplayNext: true,
    showRecent: true,
    searchHidden: false,
    subtitles: { size: 'medium', color: '#ffffff', background: 'shadow', position: 'bottom' },
    subtitleLanguage: 'en',
    subtitlesAuto: false,
    audioLanguage: '',
    clock24h: false,
  };
}

export function defaultProfileData(): ProfileData {
  return {
    favorites: [],
    lists: [],
    history: [],
    resume: {},
    recentSearches: [],
    categories: { live: defaultCategoryPrefs('live'), movie: defaultCategoryPrefs('movie'), series: defaultCategoryPrefs('series') },
    locked: [],
    settings: defaultSettings(),
  };
}

export function defaultAppSettings(): AppSettings {
  return { language: 'en', parentalPin: '', lockMode: 'hide', refreshOnLaunch: true, epgHoursAhead: 24, epgHoursBack: 2, newCategories: 'show' };
}

export interface UserState {
  loaded: boolean;
  sources: Source[];
  profiles: Profile[];
  app: AppSettings;
  activeProfileId: string | null;
  data: ProfileData;
  /** Parental PIN entered this session. */
  unlocked: boolean;
}

export const user = createStore<UserState>({
  loaded: false,
  sources: [],
  profiles: [],
  app: defaultAppSettings(),
  activeProfileId: null,
  data: defaultProfileData(),
  unlocked: false,
});

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Merges stored data over defaults so new settings get default values after an update. */
function withDefaults(d: Partial<ProfileData> | undefined): ProfileData {
  const def = defaultProfileData();
  if (!d) return def;
  return {
    ...def,
    ...d,
    categories: {
      live: { ...def.categories.live, ...(d.categories && d.categories.live) },
      movie: { ...def.categories.movie, ...(d.categories && d.categories.movie) },
      series: { ...def.categories.series, ...(d.categories && d.categories.series) },
    },
    settings: { ...def.settings, ...d.settings, subtitles: { ...def.settings.subtitles, ...(d.settings && d.settings.subtitles) } },
  };
}

export async function loadUser(): Promise<void> {
  const [sources, profiles, app] = await Promise.all([
    dbGet<Source[]>('kv', 'sources'),
    dbGet<Profile[]>('kv', 'profiles'),
    dbGet<AppSettings>('kv', 'app'),
  ]);
  let list = profiles || [];
  if (!list.length) list = [{ id: uid(), name: 'Me', avatar: 0 }];
  user.set({ sources: sources || [], profiles: list, app: { ...defaultAppSettings(), ...app }, loaded: true });
}

// Saving is debounced: many small changes (resume position, focus history) become one write.
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
function saveLater(key: string, value: () => unknown, ms = 400) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    dbPut('kv', key, value()).catch((e) => console.warn('save failed', key, e));
  }, ms);
}

export function saveSources(sources: Source[]): void {
  user.set({ sources });
  saveLater('sources', () => user.get().sources, 0);
}

export function saveProfiles(profiles: Profile[]): void {
  user.set({ profiles });
  saveLater('profiles', () => user.get().profiles, 0);
}

export function updateApp(patch: Partial<AppSettings>): void {
  user.set((s) => ({ app: { ...s.app, ...patch } }));
  saveLater('app', () => user.get().app, 0);
}

export async function activateProfile(id: string): Promise<void> {
  const data = withDefaults(await dbGet<ProfileData>('kv', `profile:${id}`));
  data.categories.live.newCategories = user.get().app.newCategories;
  data.categories.movie.newCategories = user.get().app.newCategories;
  data.categories.series.newCategories = user.get().app.newCategories;
  user.set({ activeProfileId: id, data, unlocked: false });
  updateApp({ lastProfileId: id });
}

export function updateData(fn: (d: ProfileData) => Partial<ProfileData>): void {
  const id = user.get().activeProfileId;
  user.set((s) => ({ data: { ...s.data, ...fn(s.data) } }));
  if (id) saveLater(`profile:${id}`, () => user.get().data);
}

export function updateSettings(patch: Partial<ProfileSettings>): void {
  updateData((d) => ({ settings: { ...d.settings, ...patch } }));
}

export function updateCategoryPrefs(kind: MediaKind, fn: (p: CategoryPrefs) => CategoryPrefs): void {
  updateData((d) => ({ categories: { ...d.categories, [kind]: fn(d.categories[kind]) } }));
}

export function activeProfile(): Profile | undefined {
  const s = user.get();
  return s.profiles.find((p) => p.id === s.activeProfileId);
}

// ---- Favorites, lists, history -------------------------------------------------------------

export function isFavorite(key: string): boolean {
  return user.get().data.favorites.indexOf(key) >= 0;
}

export function toggleFavorite(key: string): boolean {
  const fav = isFavorite(key);
  updateData((d) => ({ favorites: fav ? d.favorites.filter((k) => k !== key) : [key].concat(d.favorites) }));
  return !fav;
}

export function addToList(listId: string, key: string): void {
  updateData((d) => ({
    lists: d.lists.map((l) => (l.id === listId && l.items.indexOf(key) < 0 ? { ...l, items: [key].concat(l.items) } : l)),
  }));
}

export function removeFromList(listId: string, key: string): void {
  updateData((d) => ({ lists: d.lists.map((l) => (l.id === listId ? { ...l, items: l.items.filter((k) => k !== key) } : l)) }));
}

export function createList(name: string): string {
  const id = uid();
  updateData((d) => ({ lists: d.lists.concat([{ id, name, items: [] }]) }));
  return id;
}

export function deleteList(id: string): void {
  updateData((d) => ({ lists: d.lists.filter((l) => l.id !== id) }));
}

export function recordHistory(entry: Omit<HistoryEntry, 'at'>): void {
  updateData((d) => ({
    history: [{ ...entry, at: Date.now() }].concat(d.history.filter((h) => h.key !== entry.key)).slice(0, 300),
  }));
}

export function saveResume(key: string, pos: number, dur: number): void {
  // Finished (>95%) or barely started (<30s): nothing to resume.
  updateData((d) => {
    const resume = { ...d.resume };
    if (dur > 0 && (pos / dur > 0.95 || pos < 30)) delete resume[key];
    else resume[key] = { pos, dur, at: Date.now() };
    return { resume };
  });
}

export function addRecentSearch(q: string): void {
  const t = q.trim();
  if (t.length < 2) return;
  updateData((d) => ({ recentSearches: [t].concat(d.recentSearches.filter((x) => x.toLowerCase() !== t.toLowerCase())).slice(0, 12) }));
}

// ---- Backup / restore ------------------------------------------------------------------------

export interface Backup {
  app: 'termtv';
  version: 1;
  exportedAt: number;
  sources: Source[];
  profiles: Profile[];
  settings: AppSettings;
  data: Record<string, ProfileData>;
}

export async function exportBackup(): Promise<Backup> {
  const s = user.get();
  const data: Record<string, ProfileData> = {};
  for (const p of s.profiles) {
    data[p.id] = p.id === s.activeProfileId ? s.data : withDefaults(await dbGet<ProfileData>('kv', `profile:${p.id}`));
  }
  return { app: 'termtv', version: 1, exportedAt: Date.now(), sources: s.sources, profiles: s.profiles, settings: s.app, data };
}

export async function importBackup(b: Backup): Promise<void> {
  if (!b || b.app !== 'termtv' || !Array.isArray(b.profiles)) throw new Error('This is not a TermTV backup file');
  await dbPut('kv', 'sources', b.sources || []);
  await dbPut('kv', 'profiles', b.profiles);
  await dbPut('kv', 'app', { ...defaultAppSettings(), ...b.settings });
  for (const id of Object.keys(b.data || {})) await dbPut('kv', `profile:${id}`, b.data[id]);
}
