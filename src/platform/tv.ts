// Samsung TV platform glue: remote keys, device info, app exit. Everything degrades gracefully in a
// desktop browser so the app can be developed with a keyboard.

export type Key =
  | 'up' | 'down' | 'left' | 'right' | 'enter' | 'back'
  | 'play' | 'pause' | 'playPause' | 'stop' | 'ff' | 'rw' | 'next' | 'prev'
  | 'chUp' | 'chDown' | 'red' | 'green' | 'yellow' | 'blue' | 'info' | 'guide' | 'menu'
  | 'digit' | 'del' | 'char';

export interface KeyInfo {
  key: Key;
  digit?: number;
  char?: string;
  repeat: boolean;
}

declare const tizen: any;
declare const webapis: any;

export const isTizen = typeof (window as any).tizen !== 'undefined';
// Lets the CSS drop effects that are slow on TV GPUs (see `html.tv` in main.css).
if (isTizen) document.documentElement.className += ' tv';

/** Remote keys that must be registered to receive events (others arrive by default). */
const TIZEN_KEYS = [
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
  'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green',
  'ColorF2Yellow', 'ColorF3Blue', 'Info', 'Guide', 'Menu', 'Exit',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

export function registerKeys(): void {
  if (!isTizen) return;
  try {
    const supported: string[] = tizen.tvinputdevice.getSupportedKeys().map((k: { name: string }) => k.name);
    for (const k of TIZEN_KEYS) {
      if (supported.indexOf(k) >= 0) {
        try {
          tizen.tvinputdevice.registerKey(k);
        } catch {
          /* key not available on this model */
        }
      }
    }
  } catch (e) {
    console.warn('key registration failed', e);
  }
}

const CODES: Record<number, Key> = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 29443: 'enter', 65376: 'enter',
  10009: 'back', 8: 'del', 27: 'back', 461: 'back',
  415: 'play', 19: 'pause', 10252: 'playPause', 413: 'stop', 417: 'ff', 412: 'rw',
  10233: 'next', 10232: 'prev', 427: 'chUp', 428: 'chDown', 33: 'chUp', 34: 'chDown',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info', 458: 'guide', 18: 'menu', 10133: 'menu',
};

/** Maps a keyboard event to a remote key. Desktop shortcuts: Esc = back (Backspace too, when not typing), PageUp/Down = channel, F1-F4 = colors, F9 = Info. */
export function mapKey(e: KeyboardEvent): KeyInfo | null {
  const code = e.keyCode;
  const repeat = !!e.repeat;
  if (code >= 48 && code <= 57 && !e.shiftKey) return { key: 'digit', digit: code - 48, repeat };
  if (code >= 96 && code <= 105) return { key: 'digit', digit: code - 96, repeat };
  if (!isTizen) {
    if (code >= 112 && code <= 115) return { key: (['red', 'green', 'yellow', 'blue'] as Key[])[code - 112], repeat };
    if (code === 32) return { key: 'playPause', repeat };
    if (code === 120) return { key: 'info', repeat }; // F9
  }
  const k = CODES[code];
  if (k) return { key: k, repeat };
  if (e.key && e.key.length === 1) return { key: 'char', char: e.key, repeat };
  return null;
}

export function exitApp(): void {
  if (isTizen) {
    try {
      tizen.application.getCurrentApplication().exit();
      return;
    } catch {
      /* fall through */
    }
  }
  window.close();
}

export interface DeviceInfo {
  model: string;
  firmware: string;
  tizenVersion: string;
  duid: string;
}

export function deviceInfo(): DeviceInfo {
  const info: DeviceInfo = { model: 'Browser', firmware: navigator.userAgent, tizenVersion: '', duid: '' };
  if (typeof webapis !== 'undefined' && webapis.productinfo) {
    try {
      info.model = webapis.productinfo.getRealModel ? webapis.productinfo.getRealModel() : webapis.productinfo.getModel();
      info.firmware = webapis.productinfo.getFirmware();
      info.duid = webapis.productinfo.getDuid();
    } catch {
      /* ignore */
    }
  }
  if (isTizen) {
    try {
      info.tizenVersion = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
    } catch {
      /* ignore */
    }
  }
  return info;
}

/** Keeps the screen saver off during playback. */
export function setScreenSaver(on: boolean): void {
  if (typeof webapis === 'undefined' || !webapis.appcommon) return;
  try {
    webapis.appcommon.setScreenSaver(on ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
  } catch {
    /* ignore */
  }
}
