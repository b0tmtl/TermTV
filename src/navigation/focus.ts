// Focus engine for the remote control.
//
// Any element with `data-focus` can take focus. Key presses go, in order, to:
//   1. the focused element's handler, then its ancestors' handlers (bubbling),
//   2. spatial navigation (arrows) inside the top layer,
//   3. global handlers (Back -> router).
// Layers isolate dialogs: arrows never leave the top layer, and closing it restores focus.
// Containers marked `data-focus-memory` remember their last focused child, so coming back to the
// sidebar or a row lands where you left it.

import type { KeyInfo } from '@/platform/tv';

export interface FocusHandlers {
  /** OK pressed. */
  onEnter?: () => void;
  /** Any key. Return true when handled (stops bubbling and spatial navigation). */
  onKey?: (k: KeyInfo) => boolean | void;
  /** Got focus. */
  onFocus?: () => void;
  onBlur?: () => void;
}

const handlers = new WeakMap<Element, FocusHandlers>();
let current: HTMLElement | null = null;
/** data-fid of the focused element, to find it again if a re-render replaces the node. */
let currentFid: string | null = null;
const layers: Array<{ root: HTMLElement; restore: HTMLElement | null }> = [];
const memory = new WeakMap<Element, HTMLElement>();
let globalHandler: ((k: KeyInfo) => boolean) | null = null;
const listeners = new Set<(el: HTMLElement | null) => void>();

/** Props for a focusable element: `<div {...focusable({ onEnter })}>`. */
export function focusable(h: FocusHandlers & { id?: string; className?: string } = {}) {
  return {
    'data-focus': '',
    'data-fid': h.id,
    ref: (el: Element | null) => {
      if (el) handlers.set(el, h);
    },
    onClick: (e: Event) => {
      // Mouse / touch in a desktop browser.
      const el = e.currentTarget as HTMLElement;
      focus(el);
      if (h.onEnter) h.onEnter();
    },
    onMouseEnter: (e: Event) => {
      if (mouseMoved) focus(e.currentTarget as HTMLElement, { scroll: false });
    },
  };
}

/** Attaches handlers to an element directly (when the element also needs its own ref). */
export function registerHandlers(el: Element, h: FocusHandlers): void {
  handlers.set(el, h);
}

/** Props for a container that handles keys for everything inside it. */
export function keyHandler(onKey: (k: KeyInfo) => boolean | void) {
  return {
    ref: (el: Element | null) => {
      if (el) handlers.set(el, { onKey });
    },
  };
}

let mouseMoved = false;
document.addEventListener('mousemove', () => (mouseMoved = true), { passive: true });
document.addEventListener('keydown', () => (mouseMoved = false), true);

export function focused(): HTMLElement | null {
  if (current && document.body.contains(current)) return current;
  // The node was replaced by a re-render: follow it by its id.
  if (currentFid) {
    const el = layerRoot().querySelector(`[data-fid="${cssEscape(currentFid)}"]`) as HTMLElement | null;
    if (el) {
      current = el;
      el.setAttribute('data-focused', '');
      return el;
    }
  }
  return null;
}

export function onFocusChange(fn: (el: HTMLElement | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function focus(el: HTMLElement | null, opts: { scroll?: boolean } = {}): void {
  if (!el || el === current) {
    if (el && opts.scroll !== false) ensureVisible(el);
    return;
  }
  const prev = current;
  if (prev) {
    prev.removeAttribute('data-focused');
    const h = handlers.get(prev);
    if (h && h.onBlur) h.onBlur();
  }
  current = el;
  currentFid = el.getAttribute('data-fid');
  // An attribute, not a class: Preact rewrites `class` on re-render and would drop it.
  el.setAttribute('data-focused', '');
  // Remember the last child in every memory container above.
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.hasAttribute('data-focus-memory')) memory.set(p, el);
  }
  if (opts.scroll !== false) ensureVisible(el);
  const h = handlers.get(el);
  if (h && h.onFocus) h.onFocus();
  listeners.forEach((fn) => fn(el));
}

export function focusById(fid: string, root: ParentNode = layerRoot()): boolean {
  const el = root.querySelector(`[data-fid="${cssEscape(fid)}"]`) as HTMLElement | null;
  if (el) focus(el);
  return !!el;
}

export function focusFirst(root: ParentNode = layerRoot()): boolean {
  const el = (root.querySelector('[data-focus-default]') || root.querySelector('[data-focus]')) as HTMLElement | null;
  if (el) focus(el);
  return !!el;
}

/** Focuses inside a container, preferring the element it remembers. */
export function focusInto(container: HTMLElement): boolean {
  const remembered = memory.get(container);
  if (remembered && container.contains(remembered) && isVisible(remembered)) {
    focus(remembered);
    return true;
  }
  return focusFirst(container);
}

export function pushLayer(root: HTMLElement): void {
  layers.push({ root, restore: focused() });
  if (!focusFirst(root)) {
    current && current.removeAttribute('data-focused');
    current = null;
  }
}

export function popLayer(root: HTMLElement): void {
  const i = layers.findIndex((l) => l.root === root);
  if (i < 0) return;
  const [l] = layers.splice(i, 1);
  if (l.restore && document.body.contains(l.restore)) focus(l.restore);
  else focusFirst();
}

export function layerRoot(): HTMLElement {
  return layers.length ? layers[layers.length - 1].root : (document.getElementById('app') as HTMLElement) || document.body;
}

export function setGlobalHandler(fn: (k: KeyInfo) => boolean): void {
  globalHandler = fn;
}

/** Entry point for every key press. */
export function dispatchKey(k: KeyInfo): boolean {
  let el = focused();
  const root = layerRoot();
  if (el && !root.contains(el)) el = null;
  if (!el) {
    if (focusFirst(root) && isArrow(k)) return true;
    el = focused();
  }
  // 1. Handlers, from the focused element up to the layer root.
  for (let node: Element | null = el; node; node = node.parentElement) {
    const h = handlers.get(node);
    if (h) {
      if (h.onKey && h.onKey(k)) return true;
      if (node === el && k.key === 'enter' && h.onEnter) {
        h.onEnter();
        return true;
      }
    }
    if (node === root) break;
  }
  // 2. Spatial navigation.
  if (isArrow(k) && el) {
    const next = findNext(el, k.key as Dir, root);
    if (next) {
      enter(next);
      return true;
    }
    return true; // nothing that way: stay put
  }
  // 3. Global.
  return globalHandler ? globalHandler(k) : false;
}

function isArrow(k: KeyInfo): boolean {
  return k.key === 'up' || k.key === 'down' || k.key === 'left' || k.key === 'right';
}

/** Moves focus to an element, or into the memory container that holds it. */
function enter(target: HTMLElement) {
  const from = current;
  for (let p = target.parentElement; p; p = p.parentElement) {
    if (p.hasAttribute('data-focus-memory') && !(from && p.contains(from))) {
      if (focusInto(p)) return;
      break;
    }
  }
  focus(target);
}

type Dir = 'up' | 'down' | 'left' | 'right';

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Nearest focusable in a direction, scoring distance along the axis plus off-axis drift. */
export function findNext(from: HTMLElement, dir: Dir, root: HTMLElement): HTMLElement | null {
  const fr = from.getBoundingClientRect();
  const fcx = fr.left + fr.width / 2;
  const fcy = fr.top + fr.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  const all = root.querySelectorAll('[data-focus]');
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    if (el === from || el.hasAttribute('data-focus-skip')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let main: number;
    let cross: number;
    switch (dir) {
      case 'right':
        if (r.left < fr.right - 2 && cx <= fcx + 1) continue;
        main = Math.max(0, r.left - fr.right);
        cross = overlap(fr.top, fr.bottom, r.top, r.bottom) ? 0 : Math.abs(cy - fcy);
        break;
      case 'left':
        if (r.right > fr.left + 2 && cx >= fcx - 1) continue;
        main = Math.max(0, fr.left - r.right);
        cross = overlap(fr.top, fr.bottom, r.top, r.bottom) ? 0 : Math.abs(cy - fcy);
        break;
      case 'down':
        if (r.top < fr.bottom - 2 && cy <= fcy + 1) continue;
        main = Math.max(0, r.top - fr.bottom);
        cross = overlap(fr.left, fr.right, r.left, r.right) ? Math.abs(r.left - fr.left) * 0.1 : Math.abs(cx - fcx);
        break;
      default:
        if (r.bottom > fr.top + 2 && cy >= fcy - 1) continue;
        main = Math.max(0, fr.top - r.bottom);
        cross = overlap(fr.left, fr.right, r.left, r.right) ? Math.abs(r.left - fr.left) * 0.1 : Math.abs(cx - fcx);
    }
    const score = main + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function overlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a2, b2) - Math.max(a1, b1) > 4;
}

/** Scrolls the nearest `data-scroll` containers so the element is visible (no smooth scroll: TVs are slow). */
export function ensureVisible(el: HTMLElement): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const axis = p.getAttribute('data-scroll');
    if (!axis) continue;
    const pr = p.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = Number(p.getAttribute('data-scroll-pad') || 60);
    if (axis === 'x' || axis === 'both') {
      if (r.left < pr.left + pad) p.scrollLeft -= pr.left + pad - r.left;
      else if (r.right > pr.right - pad) p.scrollLeft += r.right - (pr.right - pad);
    }
    if (axis === 'y' || axis === 'both') {
      if (r.top < pr.top + pad) p.scrollTop -= pr.top + pad - r.top;
      else if (r.bottom > pr.bottom - pad) p.scrollTop += r.bottom - (pr.bottom - pad);
    }
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
