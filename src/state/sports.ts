// The Sports screen's data: sport events found in the guide, grouped into matches.
// Built on demand (and again when the guide or the library changes), in slices so the TV keeps
// responding while it works.

import type { Channel } from '@/core/models';
import { classifyProgramme, groupEvents, isSportsChannel, type Airing, type SportEvent, type SportId, type SportMatch } from '@/core/sports';
import { allChannels, isItemLocked, libraryState, programmes, viewOfItem } from './library';
import { createStore } from './store';
import { isHidden } from '@/core/categories';
import { user } from './user';

export type Match = SportMatch<Channel>;

export interface SportsState {
  status: 'idle' | 'building' | 'ready';
  matches: Match[];
  /** Library + guide versions the matches were built from. */
  builtFor: string;
}

export const sportsState = createStore<SportsState>({ status: 'idle', matches: [], builtFor: '' });

const versionKey = () => {
  const s = libraryState.get();
  const u = user.get();
  return s.version + ':' + s.epgVersion + ':' + (u.data.categories.live === undefined ? 0 : u.data.categories.live.hidden.length) + ':' + (u.unlocked ? 1 : 0);
};

let building: Promise<void> | null = null;

/** Builds the matches if the guide or library changed since the last build. */
export function ensureSports(): Promise<void> {
  const key = versionKey();
  if (sportsState.get().builtFor === key && sportsState.get().status === 'ready') return Promise.resolve();
  if (building) return building;
  building = build(key).then(
    () => {
      building = null;
      // Something changed while building: go again.
      if (versionKey() !== key) return ensureSports();
    },
    (e) => {
      building = null;
      console.warn('sports build failed', e);
    },
  );
  return building;
}

async function build(key: string): Promise<void> {
  sportsState.set({ status: 'building' });
  const now = Date.now();
  const prefs = user.get().data.categories.live;
  const entries: Array<{ event: SportEvent; airing: Airing<Channel> }> = [];
  const channels = allChannels();
  let sliceStart = Date.now();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const progs = programmes(ch);
    if (progs.length && !isItemLocked(ch)) {
      const view = viewOfItem(ch);
      if (!view || !isHidden(view, prefs)) {
        const ctx = { name: ch.name, category: view ? view.name : '' };
        const sportsCh = isSportsChannel(ctx.name, ctx.category);
        for (const p of progs) {
          if (p.end <= now) continue;
          const event = classifyProgramme(p, { ...ctx, isSportsChannel: sportsCh });
          if (event) entries.push({ event, airing: { channel: ch, start: p.start, end: p.end, title: p.title } });
        }
      }
    }
    // Let the screen draw every ~40 ms of work.
    if (Date.now() - sliceStart > 40) {
      await new Promise((r) => setTimeout(r, 0));
      sliceStart = Date.now();
    }
  }
  sportsState.set({ status: 'ready', matches: groupEvents(entries), builtFor: key });
}

export function isLive(m: Match, at = Date.now()): boolean {
  return m.start <= at && m.end > at;
}

/** Live first (by start), then upcoming by start. */
export function matchesFor(sport: SportId | 'all', at = Date.now()): Match[] {
  const list = sportsState.get().matches.filter((m) => m.end > at && (sport === 'all' || m.sport === sport));
  const live = list.filter((m) => isLive(m, at));
  const later = list.filter((m) => !isLive(m, at));
  return live.concat(later);
}
