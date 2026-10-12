// Samsung AVPlay engine: hardware decoding of HLS, MPEG-TS, MP4, MKV and DASH on the TV.
// Docs: https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html

import { languageName } from '@/core/languages';
import type { LoadOptions, PlayerEngine, PlayerEvents, Rect, Track } from './types';

declare const webapis: any;

export function avplayAvailable(): boolean {
  return typeof webapis !== 'undefined' && !!webapis.avplay;
}

/**
 * Track details from AVPlay's `extra_info`. Depending on the firmware it is a JSON string or an
 * object, and the language key is `language`, `track_lang` or something close.
 */
function parseExtra(extra: unknown): { language: string; label: string } {
  let j: Record<string, unknown> = {};
  if (extra && typeof extra === 'object') j = extra as Record<string, unknown>;
  else if (typeof extra === 'string') {
    try {
      j = JSON.parse(extra);
    } catch {
      const m = /lang\w*"?\s*[:=]\s*"?([A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?)/i.exec(extra);
      if (m) j = { language: m[1] };
    }
  }
  let lang = String(j.language || j.track_lang || j.lang || '').trim();
  if (!lang) for (const k in j) if (/lang/i.test(k) && j[k]) lang = String(j[k]).trim();
  return { language: lang, label: String(j.label || j.title || '').trim() };
}

export class AvPlayEngine implements PlayerEngine {
  readonly name = 'AVPlay';
  private av = webapis.avplay;
  private obj: HTMLObjectElement;
  /** Counts loads: a delayed resume retry must not seek a stream that replaced this one. */
  private loads = 0;
  private rect: Rect | null = null;
  private audio = -1;
  private text = -1;
  private lastTime = 0;
  private aspect: 'fit' | 'fill' | 'stretch' = 'fit';

  constructor(private ev: PlayerEvents) {
    let obj = document.getElementById('av-player') as HTMLObjectElement | null;
    if (!obj) {
      obj = document.createElement('object');
      obj.id = 'av-player';
      obj.setAttribute('type', 'application/avplayer');
      document.body.insertBefore(obj, document.body.firstChild);
    }
    this.obj = obj;
    this.applyRect();
  }

  load(url: string, opts: LoadOptions): Promise<void> {
    const loadId = ++this.loads;
    this.close();
    this.ev.status('loading');
    this.audio = -1;
    this.text = -1;
    return new Promise((resolve, reject) => {
      try {
        this.av.open(url);
        this.av.setListener({
          onbufferingstart: () => this.ev.status('buffering'),
          onbufferingcomplete: () => this.ev.status(this.state() === 'PAUSED' ? 'paused' : 'playing'),
          oncurrentplaytime: (ms: number) => {
            this.lastTime = ms / 1000;
            this.ev.time(this.lastTime);
          },
          onstreamcompleted: () => this.ev.status('ended'),
          onerror: (e: string) => this.ev.error(String(e)),
          onsubtitlechange: (_duration: number, text: string) => this.ev.subtitle(text || ''),
          onevent: () => undefined,
        });
        try {
          // Before playing, and after a stall ("resume"). More = fewer stalls on shaky streams, slower start.
          const play = opts.bufferSeconds || (opts.live ? 3 : 5);
          const resume = opts.bufferSeconds ? Math.min(30, opts.bufferSeconds * 2) : opts.live ? 5 : 10;
          this.av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', play);
          this.av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', resume);
        } catch {
          /* older firmware */
        }
        this.applyRect();
        this.av.prepareAsync(
          () => {
            this.av.play();
            this.ev.status('playing');
            this.ev.tracks();
            resolve();
            // Resume: seek once playing. A seekTo before play() is ignored by some firmware (the
            // movie restarted at 0:00); check that it landed and try again once.
            if (opts.startAt && opts.startAt > 5 && !opts.live) {
              const target = Math.floor(opts.startAt * 1000);
              const landed = () => this.time() * 1000 >= target - 15000;
              const seek = (retry: boolean) => {
                if (loadId !== this.loads) return;
                try {
                  this.av.seekTo(
                    target,
                    () => (this.lastTime = target / 1000),
                    () => retry && setTimeout(() => seek(false), 1500),
                  );
                } catch {
                  if (retry) setTimeout(() => seek(false), 1500);
                }
              };
              seek(true);
              setTimeout(() => {
                if (loadId === this.loads && !landed()) seek(false);
              }, 4000);
            }
          },
          (err: unknown) => {
            const msg = typeof err === 'string' ? err : 'PLAYER_ERROR';
            this.ev.error(msg);
            reject(new Error(msg));
          },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.ev.error(msg);
        reject(new Error(msg));
      }
    });
  }

  private state(): string {
    try {
      return this.av.getState();
    } catch {
      return 'NONE';
    }
  }

  play() {
    const st = this.state();
    if (st === 'PAUSED' || st === 'READY') {
      this.av.play();
      this.ev.status('playing');
    }
  }

  pause() {
    if (this.state() === 'PLAYING') {
      this.av.pause();
      this.ev.status('paused');
    }
  }

  stop() {
    this.close();
    this.ev.status('idle');
  }

  private close() {
    try {
      const st = this.state();
      if (st !== 'NONE' && st !== 'IDLE') this.av.stop();
      if (st !== 'NONE') this.av.close();
    } catch {
      /* ignore */
    }
  }

  seek(seconds: number) {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    try {
      this.av.seekTo(ms, () => undefined, () => undefined);
      this.lastTime = ms / 1000;
    } catch {
      /* not seekable */
    }
  }

  time() {
    try {
      return this.av.getCurrentTime() / 1000;
    } catch {
      return this.lastTime;
    }
  }

  duration() {
    try {
      const d = this.av.getDuration() / 1000;
      return isFinite(d) && d > 0 ? d : 0;
    } catch {
      return 0;
    }
  }

  setRect(rect: Rect | null) {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect() {
    const r = this.rect || { x: 0, y: 0, w: 1920, h: 1080 };
    const s = this.obj.style;
    s.position = 'fixed';
    s.left = r.x + 'px';
    s.top = r.y + 'px';
    s.width = r.w + 'px';
    s.height = r.h + 'px';
    s.zIndex = '0';
    try {
      // AVPlay uses a 1920x1080 coordinate space regardless of the UI resolution.
      const scale = 1920 / window.innerWidth;
      this.av.setDisplayRect(Math.round(r.x * scale), Math.round(r.y * scale), Math.round(r.w * scale), Math.round(r.h * scale));
      this.av.setDisplayMethod(
        this.aspect === 'stretch' ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN' : this.aspect === 'fill' ? 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO' : 'PLAYER_DISPLAY_MODE_LETTER_BOX',
      );
    } catch {
      /* not open yet */
    }
  }

  setAspect(mode: 'fit' | 'fill' | 'stretch') {
    this.aspect = mode;
    this.applyRect();
  }

  private tracksOf(type: 'AUDIO' | 'TEXT'): Track[] {
    try {
      const all: Array<{ index: number; type: string; extra_info: unknown }> = this.av.getTotalTrackInfo();
      const list = all
        .filter((t) => t.type === type)
        .map((t, i) => {
          const x = parseExtra(t.extra_info);
          const name = languageName(x.language);
          const label = x.label && name && x.label.toLowerCase() !== x.language.toLowerCase() ? name + ' · ' + x.label : x.label || name;
          return { index: t.index, language: x.language, label: label || (type === 'AUDIO' ? 'Audio ' : 'Subtitle ') + (i + 1) };
        });
      // Two tracks in the same language: "French", "French 2".
      const seen: Record<string, number> = {};
      for (const t of list) {
        seen[t.label] = (seen[t.label] || 0) + 1;
        if (seen[t.label] > 1) t.label += ' ' + seen[t.label];
      }
      return list;
    } catch {
      return [];
    }
  }

  audioTracks() {
    return this.tracksOf('AUDIO');
  }

  textTracks() {
    return this.tracksOf('TEXT');
  }

  selectAudio(index: number) {
    try {
      this.av.setSelectTrack('AUDIO', index);
      this.audio = index;
    } catch {
      /* ignore */
    }
  }

  selectText(index: number) {
    try {
      if (index < 0) {
        this.av.setSilentSubtitle(true);
        this.ev.subtitle('');
      } else {
        this.av.setSelectTrack('TEXT', index);
        this.av.setSilentSubtitle(false);
      }
      this.text = index;
    } catch {
      /* ignore */
    }
  }

  currentAudio() {
    if (this.audio >= 0) return this.audio;
    try {
      const cur = this.av.getCurrentStreamInfo().filter((t: { type: string }) => t.type === 'AUDIO')[0];
      return cur ? cur.index : -1;
    } catch {
      return -1;
    }
  }

  currentText() {
    return this.text;
  }

  destroy() {
    this.close();
  }
}
