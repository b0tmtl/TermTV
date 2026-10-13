// "A new version is available": checks the latest GitHub release at most once a day and shows its
// notes. On Samsung TVs TizenBrew installs updates; TermTV can only tell you about them. The
// Android app has its own releases (an APK per release) and installs them itself.

import { androidInfo, isAndroid } from '@/platform/android';
import { createStore } from './store';

const REPO = isAndroid ? 'b0tmtl/TermTV-Android' : 'b0tmtl/TermTV';
const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

/** The installed version: the web app's, or the Android app's ("0.1.23.1": web version + app revision). */
export function installedVersion(): string {
  const a = androidInfo();
  return a && a.versionName ? a.versionName : __VERSION__;
}
const DAY = 24 * 3600 * 1000;
const LS_CHECKED = 'termtv-update-checked';
const LS_SEEN = 'termtv-update-seen';

export interface UpdateState {
  checking: boolean;
  checkedAt?: number;
  /** Latest released version ("0.1.13"), when known. */
  latest?: string;
  notes?: string;
  publishedAt?: number;
  available: boolean;
  error?: string;
  /** Android: the release's APK. */
  apkUrl?: string;
}

export const updateState = createStore<UpdateState>({ checking: false, available: false });

/** -1 / 0 / 1, numeric per part: "0.1.10" is newer than "0.1.9". */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Release notes are Markdown; the TV shows plain text. */
export function plainNotes(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ls(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function checkForUpdate(force = false): Promise<UpdateState> {
  const last = Number(ls(LS_CHECKED) || 0);
  if (!force && Date.now() - last < DAY && updateState.get().checkedAt) return updateState.get();
  updateState.set({ checking: true, error: undefined });
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit' });
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    const j = (await res.json()) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const apk = (j.assets || []).filter((a) => /\.apk$/i.test(a.name))[0];
    const latest = String(j.tag_name || '').replace(/^v/, '');
    ls(LS_CHECKED, String(Date.now()));
    updateState.set({
      checking: false,
      checkedAt: Date.now(),
      latest,
      notes: plainNotes(j.body || ''),
      publishedAt: j.published_at ? Date.parse(j.published_at) : undefined,
      available: !!latest && compareVersions(latest, installedVersion()) > 0,
      apkUrl: apk ? apk.browser_download_url : undefined,
    });
  } catch (e) {
    updateState.set({ checking: false, checkedAt: Date.now(), error: e instanceof Error ? e.message : String(e) });
  }
  return updateState.get();
}

/** True the first time a given new version is announced (so the popup shows once per version). */
export function shouldAnnounce(): boolean {
  const s = updateState.get();
  if (!s.available || !s.latest) return false;
  if (ls(LS_SEEN) === s.latest) return false;
  ls(LS_SEEN, s.latest);
  return true;
}
