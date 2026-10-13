// Android engine: Media3 ExoPlayer in the Android app, drawn under the (transparent) page like
// AVPlay. Hardware decoding of HLS, MPEG-TS, MP4, MKV, DASH. Calls go to `TermTVNative.player*`;
// the app sends state back through `window.__termtvPlayer(json)`:
//   { e: 'status', s }  { e: 'time', t, d }  { e: 'tracks', audio, text, a, x }
//   { e: 'cues', text }  { e: 'error', message }

import { languageName } from '@/core/languages';
import { native } from '../android';
import type { LoadOptions, PlayerEngine, PlayerEvents, PlayerStatus, Rect, Track } from './types';

export function exoAvailable(): boolean {
  return !!native;
}

interface NativeTrack {
  index: number;
  language: string;
  label: string;
}

type NativeEvent =
  | { e: 'status'; s: PlayerStatus; load: number }
  | { e: 'time'; t: number; d: number; load: number }
  | { e: 'tracks'; audio: NativeTrack[]; text: NativeTrack[]; a: number; x: number; load: number }
  | { e: 'cues'; text: string; load: number }
  | { e: 'error'; message: string; load: number };

/** "fr" -> "French", "French 2" for a second track in the same language. */
export function labelTracks(list: NativeTrack[], kind: 'audio' | 'text'): Track[] {
  const out = list.map((t, i) => {
    const name = languageName(t.language);
    const label = t.label && name && t.label.toLowerCase() !== t.language.toLowerCase() ? name + ' · ' + t.label : t.label || name;
    return { index: t.index, language: t.language, label: label || (kind === 'audio' ? 'Audio ' : 'Subtitle ') + (i + 1) };
  });
  const seen: Record<string, number> = {};
  for (const t of out) {
    seen[t.label] = (seen[t.label] || 0) + 1;
    if (seen[t.label] > 1) t.label += ' ' + seen[t.label];
  }
  return out;
}

export class ExoEngine implements PlayerEngine {
  readonly name = 'ExoPlayer';
  private n = native!;
  /** Each load gets a number; events from an earlier load are ignored. */
  private loads = 0;
  private t = 0;
  private d = 0;
  private audio: Track[] = [];
  private text: Track[] = [];
  private a = -1;
  private x = -1;
  private pending: { resolve(): void; reject(e: Error): void } | null = null;

  constructor(private ev: PlayerEvents) {
    (window as unknown as { __termtvPlayer?: (json: string) => void }).__termtvPlayer = (json) => this.onNative(json);
    // The HTML5 engine's <video> stays in the page: keep it out of the way.
    const html5 = document.getElementById('html5-player');
    if (html5) html5.style.display = 'none';
  }

  private onNative(json: string) {
    let m: NativeEvent;
    try {
      m = JSON.parse(json) as NativeEvent;
    } catch {
      return;
    }
    if (m.load !== this.loads) return;
    switch (m.e) {
      case 'status':
        if ((m.s === 'playing' || m.s === 'paused') && this.pending) {
          this.pending.resolve();
          this.pending = null;
        }
        this.ev.status(m.s);
        break;
      case 'time':
        this.t = m.t;
        if (m.d > 0) this.d = m.d;
        this.ev.time(m.t);
        break;
      case 'tracks':
        this.audio = labelTracks(m.audio, 'audio');
        this.text = labelTracks(m.text, 'text');
        this.a = m.a;
        if (m.x >= 0 || this.x >= 0) this.x = m.x;
        this.ev.tracks();
        break;
      case 'cues':
        this.ev.subtitle(m.text);
        break;
      case 'error':
        if (this.pending) {
          this.pending.reject(new Error(m.message));
          this.pending = null;
        }
        this.ev.error(m.message);
        break;
    }
  }

  load(url: string, opts: LoadOptions): Promise<void> {
    const load = ++this.loads;
    if (this.pending) this.pending.resolve();
    this.t = 0;
    this.d = 0;
    this.audio = [];
    this.text = [];
    this.a = -1;
    this.x = -1;
    this.ev.status('loading');
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.n.playerLoad(
        url,
        JSON.stringify({
          load,
          live: opts.live,
          startMs: opts.startAt && opts.startAt > 5 && !opts.live ? Math.floor(opts.startAt * 1000) : 0,
          bufferMs: (opts.bufferSeconds || 0) * 1000,
        }),
      );
    });
  }

  play() {
    this.n.playerPlay();
  }

  pause() {
    this.n.playerPause();
  }

  stop() {
    this.loads++;
    this.n.playerStop();
    this.ev.status('idle');
  }

  seek(seconds: number) {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    this.t = ms / 1000;
    this.n.playerSeek(ms);
  }

  time() {
    return this.t;
  }

  duration() {
    return this.d;
  }

  setRect(rect: Rect | null) {
    const r = rect || { x: 0, y: 0, w: 1920, h: 1080 };
    this.n.playerRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
  }

  setAspect(mode: 'fit' | 'fill' | 'stretch') {
    this.n.playerAspect(mode);
  }

  audioTracks() {
    return this.audio;
  }

  textTracks() {
    return this.text;
  }

  selectAudio(index: number) {
    this.a = index;
    this.n.playerAudio(index);
  }

  selectText(index: number) {
    this.x = index;
    if (index < 0) this.ev.subtitle('');
    this.n.playerText(index);
  }

  currentAudio() {
    return this.a;
  }

  currentText() {
    return this.x;
  }

  setSpeed(rate: number): number {
    this.n.playerSpeed(rate);
    return rate;
  }

  destroy() {
    this.loads++;
    this.n.playerRelease();
  }
}
