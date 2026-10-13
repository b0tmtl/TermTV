// Android glue (phones, tablets, Android TV / Google TV boxes). The Android app
// (github.com/b0tmtl/TermTV-Android) is a WebView around this same web app plus a native side:
//  - `window.TermTVNative`: methods the page calls (player, exit, screen on, files, updates);
//  - `window.__termtvKey(name, repeat)`: remote keys the WebView doesn't deliver (Back, colors, media);
//  - `window.__termtvPlayer(json)`: player events (see player/exoplayer.ts);
//  - `/proxy?url=...`: provider requests, fetched natively (providers send no CORS headers).
// Everything here is a no-op in a browser or on a Samsung TV.

import { setUrlRewriter } from './http';

export interface NativeBridge {
  /** JSON: { model, android, sdk, tv, touch, versionName, versionCode } */
  info(): string;
  exit(): void;
  keepScreenOn(on: boolean): void;
  /** Saves a text file to Downloads; returns where it went, or "" on failure. */
  saveText(name: string, text: string): string;
  /** Downloads an APK and opens the system installer. */
  installApk(url: string): void;
  // Player (all asynchronous on the native side; state comes back through __termtvPlayer).
  playerLoad(url: string, optsJson: string): void;
  playerPlay(): void;
  playerPause(): void;
  playerStop(): void;
  playerSeek(ms: number): void;
  playerRect(x: number, y: number, w: number, h: number): void;
  playerAspect(mode: string): void;
  playerAudio(index: number): void;
  playerText(index: number): void;
  playerSpeed(rate: number): void;
  playerRelease(): void;
}

export interface AndroidInfo {
  model: string;
  android: string;
  sdk: number;
  /** Leanback (Android TV / Google TV). */
  tv: boolean;
  touch: boolean;
  versionName: string;
  versionCode: number;
}

const w = typeof window !== 'undefined' ? (window as unknown as { TermTVNative?: NativeBridge }) : {};

export const native: NativeBridge | undefined = w.TermTVNative;
export const isAndroid = !!native;

let infoCache: AndroidInfo | null = null;
export function androidInfo(): AndroidInfo | null {
  if (!native) return null;
  if (!infoCache) {
    try {
      infoCache = JSON.parse(native.info()) as AndroidInfo;
    } catch {
      infoCache = { model: 'Android', android: '', sdk: 0, tv: false, touch: true, versionName: '', versionCode: 0 };
    }
  }
  return infoCache;
}

/** Provider requests go through the app (same origin, so no CORS); videos are played natively, unproxied. */
export const ANDROID_PROXY = '/proxy?url=';

// Main-thread provider requests (details, short EPG, account info) too; the library worker sets
// its own from the `proxy` field of its requests.
if (isAndroid) setUrlRewriter((u) => (/^https?:\/\//.test(u) ? ANDROID_PROXY + encodeURIComponent(u) : u));

if (isAndroid && typeof document !== 'undefined') {
  const info = androidInfo();
  // TV boxes have slow GPUs too: drop the same effects as on Samsung TVs.
  if (info && info.tv) document.documentElement.className += ' tv';
  // The video is drawn under the page: the page itself must not be opaque (.backdrop covers it
  // when nothing plays).
  const clear = () => {
    if (document.body) document.body.style.background = 'transparent';
  };
  if (document.body) clear();
  else document.addEventListener('DOMContentLoaded', clear);
}

/**
 * Touch screens: a swipe becomes arrow keys sent to the element under the finger, so every list,
 * row and guide scrolls with the same code as the remote. A tap is a click (focus + OK).
 */
export function installTouch(dispatch: (key: 'up' | 'down' | 'left' | 'right') => void, focusAt: (el: HTMLElement) => void): void {
  const info = androidInfo();
  if (!info || !info.touch) return;
  // The page is 1920 CSS px wide whatever the screen: one step per ~110 px of finger travel.
  const STEP = 110;
  let x = 0;
  let y = 0;
  let moved = false;
  let axis: 'x' | 'y' | '' = '';
  document.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      x = t.clientX;
      y = t.clientY;
      moved = false;
      axis = '';
      const target = (e.target as HTMLElement).closest ? ((e.target as HTMLElement).closest('[data-focus]') as HTMLElement | null) : null;
      if (target) focusAt(target);
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      const dx = t.clientX - x;
      const dy = t.clientY - y;
      if (!axis && (Math.abs(dx) > 24 || Math.abs(dy) > 24)) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y' && Math.abs(dy) >= STEP) {
        // Finger up = content up = next items below.
        dispatch(dy < 0 ? 'down' : 'up');
        y += dy < 0 ? -STEP : STEP;
        moved = true;
      } else if (axis === 'x' && Math.abs(dx) >= STEP) {
        dispatch(dx < 0 ? 'right' : 'left');
        x += dx < 0 ? -STEP : STEP;
        moved = true;
      }
      if (axis) e.preventDefault();
    },
    { passive: false },
  );
  // A swipe must not end as a click on whatever is under the finger.
  document.addEventListener(
    'click',
    (e) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    },
    true,
  );
}
