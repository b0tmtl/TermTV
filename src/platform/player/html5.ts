// HTML5 <video> engine with hls.js (HLS) and mpegts.js (raw MPEG-TS live streams).
// The fallback for TVs where AVPlay stutters on some streams, and the engine used in a desktop
// browser during development. The libraries are loaded on demand.

import { languageName } from '@/core/languages';
import type { LoadOptions, PlayerEngine, PlayerEvents, Rect, Track } from './types';

const loaded: Record<string, Promise<void>> = {};

function loadScript(src: string): Promise<void> {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => {
        delete loaded[src];
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}

type Kind = 'hls' | 'ts' | 'native';

function kindOf(url: string, live: boolean): Kind {
  const path = decodeURIComponent(url).split('?')[0].toLowerCase();
  if (/\.m3u8$/.test(path) || /\/hls\//.test(path)) return 'hls';
  if (/\.ts$/.test(path) || (live && !/\.(mp4|mkv|webm|m4v|mov)$/.test(path))) return 'ts';
  return 'native';
}

export class Html5Engine implements PlayerEngine {
  /** Counts loads, so a late error from a replaced stream is ignored. */
  private gen = 0;
  readonly name = 'HTML5';
  private video: HTMLVideoElement;
  private hls: any = null;
  private ts: any = null;
  private textIndex = -1;
  private onCue = () => this.emitCue();

  constructor(private ev: PlayerEvents) {
    let v = document.getElementById('html5-player') as HTMLVideoElement | null;
    if (!v) {
      v = document.createElement('video');
      v.id = 'html5-player';
      v.setAttribute('playsinline', '');
      document.body.insertBefore(v, document.body.firstChild);
    }
    this.video = v;
    this.video.style.display = 'block';
    const av = document.getElementById('av-player');
    if (av) av.style.display = 'none';
    this.setRect(null);
    v.onwaiting = () => this.ev.status('buffering');
    v.onplaying = () => this.ev.status('playing');
    v.onpause = () => !v!.ended && this.ev.status('paused');
    v.onended = () => this.ev.status('ended');
    v.ontimeupdate = () => this.ev.time(v!.currentTime);
    v.onerror = () => this.ev.error(v!.error ? `MEDIA_ERR_${v!.error.code}` : 'MEDIA_ERROR');
    v.onloadedmetadata = () => this.ev.tracks();
  }

  async load(url: string, opts: LoadOptions): Promise<void> {
    const gen = ++this.gen;
    this.teardown();
    this.ev.status('loading');
    const v = this.video;
    const kind = kindOf(url, opts.live);
    const w = window as any;
    if (kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
      await loadScript('vendor/hls.min.js');
      if (w.Hls && w.Hls.isSupported()) {
        const ahead = opts.bufferSeconds ? Math.max(10, opts.bufferSeconds * 3) : 30;
        this.hls = new w.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: ahead });
        this.hls.on(w.Hls.Events.ERROR, (_e: unknown, data: { fatal: boolean; details: string }) => {
          if (data.fatal) this.ev.error(data.details);
        });
        this.hls.on(w.Hls.Events.MANIFEST_PARSED, () => this.ev.tracks());
        this.hls.on(w.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.ev.tracks());
        this.hls.loadSource(url);
        this.hls.attachMedia(v);
      } else v.src = url;
    } else if (kind === 'ts') {
      await loadScript('vendor/mpegts.js');
      if (w.mpegts && w.mpegts.isSupported()) {
        this.ts = w.mpegts.createPlayer({ type: 'mpegts', isLive: opts.live, url }, { enableWorker: true, liveBufferLatencyChasing: opts.live && (opts.bufferSeconds || 0) <= 5, lazyLoad: false });
        this.ts.on(w.mpegts.Events.ERROR, (type: string, detail: string) => this.ev.error(`${type}: ${detail}`));
        this.ts.attachMediaElement(v);
        this.ts.load();
      } else v.src = url;
    } else {
      v.src = url;
    }
    if (opts.startAt && opts.startAt > 5 && !opts.live) {
      const seekOnce = () => {
        v.removeEventListener('loadedmetadata', seekOnce);
        v.currentTime = opts.startAt!;
      };
      v.addEventListener('loadedmetadata', seekOnce);
    }
    try {
      await v.play();
    } catch (e) {
      // Autoplay may be blocked in a desktop browser until the user interacts; not fatal.
      // Not when another stream replaced this one meanwhile: that rejection is about the old one.
      if (gen === this.gen && e instanceof Error && e.name !== 'NotAllowedError' && e.name !== 'AbortError') this.ev.error(e.message);
    }
    v.textTracks.addEventListener ? v.textTracks.addEventListener('change', this.onCue) : undefined;
  }

  play() {
    this.video.play().catch(() => undefined);
  }

  pause() {
    this.video.pause();
  }

  stop() {
    this.teardown();
    this.ev.status('idle');
  }

  private teardown() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.ts) {
      try {
        this.ts.unload();
        this.ts.detachMediaElement();
        this.ts.destroy();
      } catch {
        /* ignore */
      }
      this.ts = null;
    }
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    try {
      v.load();
    } catch {
      /* ignore */
    }
    this.textIndex = -1;
    this.ev.subtitle('');
  }

  seek(seconds: number) {
    try {
      this.video.currentTime = Math.max(0, seconds);
    } catch {
      /* not seekable */
    }
  }

  time() {
    return this.video.currentTime || 0;
  }

  duration() {
    const d = this.video.duration;
    return isFinite(d) && d > 0 ? d : 0;
  }

  setRect(rect: Rect | null) {
    const s = this.video.style;
    const r = rect || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    s.position = 'fixed';
    s.left = r.x + 'px';
    s.top = r.y + 'px';
    s.width = r.w + 'px';
    s.height = r.h + 'px';
    s.zIndex = '0';
    s.background = '#000';
  }

  setAspect(mode: 'fit' | 'fill' | 'stretch') {
    this.video.style.objectFit = mode === 'fit' ? 'contain' : mode === 'fill' ? 'cover' : 'fill';
  }

  audioTracks(): Track[] {
    if (this.hls && this.hls.audioTracks) {
      return this.hls.audioTracks.map((t: { lang?: string; name?: string }, i: number) => ({ index: i, language: t.lang || '', label: t.name || languageName(t.lang || '') || `Audio ${i + 1}` }));
    }
    const at = (this.video as any).audioTracks;
    if (!at) return [];
    const out: Track[] = [];
    for (let i = 0; i < at.length; i++) out.push({ index: i, language: at[i].language || '', label: at[i].label || languageName(at[i].language || '') || `Audio ${i + 1}` });
    return out;
  }

  textTracks(): Track[] {
    if (this.hls && this.hls.subtitleTracks && this.hls.subtitleTracks.length) {
      return this.hls.subtitleTracks.map((t: { lang?: string; name?: string }, i: number) => ({ index: i, language: t.lang || '', label: t.name || languageName(t.lang || '') || `Subtitle ${i + 1}` }));
    }
    const tt = this.video.textTracks;
    const out: Track[] = [];
    for (let i = 0; i < tt.length; i++) {
      if (tt[i].kind === 'subtitles' || tt[i].kind === 'captions') out.push({ index: i, language: tt[i].language || '', label: tt[i].label || languageName(tt[i].language || '') || `Subtitle ${i + 1}` });
    }
    return out;
  }

  selectAudio(index: number) {
    if (this.hls) this.hls.audioTrack = index;
    else {
      const at = (this.video as any).audioTracks;
      if (at) for (let i = 0; i < at.length; i++) at[i].enabled = i === index;
    }
  }

  selectText(index: number) {
    this.textIndex = index;
    if (this.hls && this.hls.subtitleTracks && this.hls.subtitleTracks.length) {
      this.hls.subtitleTrack = index;
      this.hls.subtitleDisplay = false; // we render cues ourselves, with the user's style
    }
    const tt = this.video.textTracks;
    for (let i = 0; i < tt.length; i++) {
      // "hidden" keeps cues flowing without the browser drawing them.
      tt[i].mode = (this.hls ? i === index || tt[i].mode !== 'disabled' : i === index) && index >= 0 ? 'hidden' : 'disabled';
      tt[i].oncuechange = this.onCue;
    }
    if (index < 0) this.ev.subtitle('');
  }

  private emitCue() {
    if (this.textIndex < 0) return this.ev.subtitle('');
    const tt = this.video.textTracks;
    const lines: string[] = [];
    for (let i = 0; i < tt.length; i++) {
      if (tt[i].mode !== 'hidden' || !tt[i].activeCues) continue;
      const cues = tt[i].activeCues!;
      for (let c = 0; c < cues.length; c++) lines.push(((cues[c] as VTTCue).text || '').replace(/<[^>]+>/g, ''));
    }
    this.ev.subtitle(lines.join('\n'));
  }

  currentAudio() {
    return this.hls ? this.hls.audioTrack : 0;
  }

  currentText() {
    return this.textIndex;
  }

  destroy() {
    this.teardown();
    this.video.style.display = 'none';
  }
}
