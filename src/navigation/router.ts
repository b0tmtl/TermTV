// Screen stack. Back pops; each entry remembers which element had focus so going back restores it.

import { createStore } from '@/state/store';
import { focused } from './focus';

export type Route =
  | { name: 'profiles' }
  | { name: 'welcome' }
  | { name: 'addSource'; editId?: string }
  | { name: 'home' }
  | { name: 'live'; categoryId?: string; channelKey?: string }
  | { name: 'guide' }
  | { name: 'sports' }
  | { name: 'vod'; kind: 'movie' | 'series'; categoryId?: string }
  | { name: 'details'; key: string }
  | { name: 'search'; scope?: string; q?: string }
  | { name: 'player' }
  | { name: 'list'; listId: string }
  | { name: 'settings'; section?: string }
  | { name: 'categories'; kind: 'live' | 'movie' | 'series' };

export interface RouteEntry {
  route: Route;
  /** data-fid of the element focused when we left this screen. */
  focus?: string;
}

export const router = createStore<{ stack: RouteEntry[] }>({ stack: [{ route: { name: 'profiles' } }] });

export function currentRoute(): Route {
  const s = router.get().stack;
  return s[s.length - 1].route;
}

function rememberFocus(stack: RouteEntry[]): RouteEntry[] {
  const el = focused();
  const fid = el && el.getAttribute('data-fid');
  const top = stack[stack.length - 1];
  return stack.slice(0, -1).concat([{ ...top, focus: fid || undefined }]);
}

export function navigate(route: Route): void {
  router.set((s) => ({ stack: rememberFocus(s.stack).concat([{ route }]) }));
}

/** Replaces the current screen (no back entry). */
export function replace(route: Route): void {
  router.set((s) => ({ stack: s.stack.slice(0, -1).concat([{ route }]) }));
}

/** Resets the stack to a single screen ("Home" in the sidebar). */
export function resetTo(route: Route): void {
  router.set({ stack: [{ route }] });
}

/** Switches between top-level sections, keeping Home underneath so Back returns there. */
export function goSection(route: Route): void {
  if (route.name === 'home') return resetTo(route);
  router.set({ stack: [{ route: { name: 'home' } }, { route }] });
}

export function back(): boolean {
  const s = router.get().stack;
  if (s.length <= 1) return false;
  router.set({ stack: s.slice(0, -1) });
  return true;
}

export function updateRoute(patch: Partial<Route>): void {
  router.set((s) => {
    const top = s.stack[s.stack.length - 1];
    return { stack: s.stack.slice(0, -1).concat([{ ...top, route: { ...top.route, ...patch } as Route }]) };
  });
}
