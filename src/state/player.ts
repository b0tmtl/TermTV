// Playback: picks the engine, tracks state, auto-reconnects stalled live streams, saves resume
// points, and handles next episode / channel up-down.

import type { Channel, Episode, Movie, Series } from '@/core/models';
import { avplayAvailable, AvPlayEngine } from '@/platform/player/avplay';
import { exoAvailable, ExoEngine } from '@/platform/player/exoplayer';
import { Html5Engine } from '@/platform/player/html5';
import type { PlayerEngine, PlayerStatus, Rect, Track } from '@/platform/player/types';
import { setScreenSaver } from '@/platform/tv';
import { episodeUrl, playableUrl, sourceServers, streamUrl, switchServer } from './library';
import { createStore } from './store';
import { BUFFER_SECONDS, recordHistory, saveResume, user } from './user';

export type PlaybackTarget =
  | { kind: 'live'; channel: Channel; list: Channel[] }
  | { kind: 'movie'; movie: Movie }
  | { kind: 'episode'; series: Series; episode: Episode; episodes: Episode[] };

export interface PlayerState {
  target: PlaybackTarget | null;
  status: PlayerStatus;
  time: number;
  duration: number;
  subtitle: string;
  error: string;
  audio: Track[];
  text: Track[];
  audioIndex: number;
  textIndex: number;
  /** true when the video plays in a small window (live preview) instead of full screen. */
  windowed: boolean;
  reconnecting: number;
  /** Switched to a backup server URL ("trying backup URL n of total"). */
  serverNote: { n: number; total: number } | null;
  /** Target position while scrubbing with Left/Right (seconds), null when not scrubbing. */
  scrub: number | null;
  /** Playback speed (1 = normal). */
  speed: number;
  engine: string;
}

export const player = createStore<PlayerState>({
  target: null,
  status: 'idle',
  time: 0,
  duration: 0,
  subtitle: '',
  error: '',
  audio: [],
  text: [],
  audioIndex: -1,
  textIndex: -1,
  windowed: false,
  reconnecting: 0,
  serverNote: null,
  scrub: null,
  speed: 1,
  engine: '',
});

let engine: PlayerEngine | null = null;
let engineKind = '';
let currentUrl = '';
let lastProgressAt = 0;
let lastTime = -1;
let watchdog: ReturnType<typeof setInterval> | undefined;
let resumeTimer: ReturnType<typeof setInterval> | undefined;
let triedAltFormat = false;
/** True once the video has advanced in this session (see saveProgress). */
let playedThisSession = false;
let startedAt = 0;
let playStartedAt = 0;
/** Backup server URLs tried since the stream last played. */
let serversTried = 0;
/** Counts stream loads; errors are handled once per load. */
let loadGen = 0;
let handledGen = -1;

const events = {
  status(s: PlayerStatus) {
    player.set({ status: s });
    if (s === 'playing') {
      lastProgressAt = Date.now();
      serversTried = 0;
      player.set({ reconnecting: 0, error: '', serverNote: null });
    }
    if (s === 'ended') onEnded();
  },
  time(t: number) {
    if (t > 0 && lastTime >= 0 && t > lastTime) playedThisSession = true;
    if (Math.abs(t - lastTime) > 0.2) {
      lastTime = t;
      lastProgressAt = Date.now();
    }
    player.set({ time: t, duration: engine ? engine.duration() : 0 });
  },
  subtitle(text: string) {
    player.set({ subtitle: text });
  },
  error(message: string) {
    onError(message);
  },
  tracks() {
    if (!engine) return;
    const audio = engine.audioTracks();
    const text = engine.textTracks();
    player.set({ audio, text, audioIndex: engine.currentAudio(), textIndex: engine.currentText() });
    applyTrackPreferences(audio, text);
  },
};

function getEngine(): PlayerEngine {
  const native = user.get().data.settings.playerEngine === 'native';
  const want = native && avplayAvailable() ? 'native' : native && exoAvailable() ? 'exo' : 'html5';
  AvPlayEngine.minimalSurface = user.get().data.settings.videoSurface !== 'full';
  if (engine && engineKind === want) return engine;
  if (engine) engine.destroy();
  engine = want === 'native' ? new AvPlayEngine(events) : want === 'exo' ? new ExoEngine(events) : new Html5Engine(events);
  engineKind = want;
  player.set({ engine: engine.name });
  return engine;
}

function applyTrackPreferences(audio: Track[], text: Track[]) {
  const s = user.get().data.settings;
  if (!engine) return;
  const pick = (tracks: Track[], lang: string) =>
    lang ? tracks.find((t) => t.language.toLowerCase().indexOf(lang.toLowerCase()) === 0 || t.label.toLowerCase().indexOf(lang.toLowerCase()) >= 0) : undefined;
  const a = pick(audio, s.audioLanguage);
  if (a && a.index !== engine.currentAudio()) engine.selectAudio(a.index);
  if (s.subtitlesAuto && engine.currentText() < 0) {
    const t = pick(text, s.subtitleLanguage) || text[0];
    if (t) {
      engine.selectText(t.index);
      player.set({ textIndex: t.index });
    }
  }
}

function urlFor(target: PlaybackTarget, altFormat = false): string {
  if (target.kind === 'live') {
    const fmt = user.get().data.settings.liveFormat;
    return streamUrl(target.channel, altFormat ? (fmt === 'ts' ? 'm3u8' : 'ts') : fmt);
  }
  if (target.kind === 'movie') return streamUrl(target.movie);
  return episodeUrl(target.series, target.episode);
}

function resumeKey(target: PlaybackTarget): string | null {
  if (target.kind === 'movie') return target.movie.key;
  if (target.kind === 'episode') return target.episode.key;
  return null;
}

export async function play(target: PlaybackTarget, opts: { startAt?: number; windowed?: Rect | null } = {}): Promise<void> {
  saveProgress();
  triedAltFormat = false;
  serversTried = 0;
  playedThisSession = false;
  startedAt = opts.startAt || 0;
  playStartedAt = Date.now();
  clearTimeout(scrubTimer);
  const e = getEngine();
  player.set({
    target, status: 'loading', time: 0, duration: 0, subtitle: '', error: '', audio: [], text: [],
    audioIndex: -1, textIndex: -1, windowed: !!opts.windowed, reconnecting: 0, serverNote: null, scrub: null, speed: 1,
  });
  e.setRect(opts.windowed || null);
  currentUrl = urlFor(target);
  if (target.kind === 'live') recordHistory({ key: target.channel.key, kind: 'live' });
  else if (target.kind === 'movie') recordHistory({ key: target.movie.key, kind: 'movie' });
  else recordHistory({ key: target.series.key, kind: 'series', episodeKey: target.episode.key });
  setScreenSaver(false);
  startTimers();
  await load(opts.startAt);
}

async function load(startAt?: number) {
  const st = player.get();
  if (!st.target || !engine) return;
  loadGen++;
  lastProgressAt = Date.now();
  lastTime = -1;
  try {
    const bufferSeconds = BUFFER_SECONDS[user.get().data.settings.buffer || 'auto'] || 0;
    await engine.load(playableUrl(currentUrl), { live: st.target.kind === 'live', startAt, bufferSeconds });
  } catch {
    /* reported through events.error */
  }
}

function sourceOf(target: PlaybackTarget): string {
  return target.kind === 'live' ? target.channel.sourceId : target.kind === 'movie' ? target.movie.sourceId : target.series.sourceId;
}

/** Next backup server URL for this stream, if any is left untried. True when switched. */
function tryNextServer(st: PlayerState): boolean {
  if (!st.target) return false;
  const sid = sourceOf(st.target);
  const total = sourceServers(sid).length;
  if (total < 2 || serversTried >= total - 1) return false;
  const sw = switchServer(sid, true);
  if (!sw) return false;
  serversTried++;
  triedAltFormat = false;
  currentUrl = urlFor(st.target);
  player.set({ status: 'buffering', serverNote: { n: sw.n, total: sw.total } });
  load(st.target.kind !== 'live' && st.time > 5 ? st.time : undefined);
  return true;
}

function onError(message: string) {
  const st = player.get();
  if (!st.target) return;
  // One failure often arrives as two errors (media error + rejected play()): handle it once.
  if (handledGen === loadGen) return;
  handledGen = loadGen;
  // Live: an Xtream stream that fails as .ts often works as .m3u8 (and the other way round).
  if (st.target.kind === 'live' && !triedAltFormat && st.target.channel.sourceId && /\/live\//.test(currentUrl)) {
    triedAltFormat = true;
    currentUrl = urlFor(st.target, true);
    load();
    return;
  }
  // The server may be down: try the source's backup URLs before giving up.
  if (tryNextServer(st)) return;
  if (st.target.kind === 'live' && st.reconnecting < 5) {
    reconnect();
    return;
  }
  player.set({ status: 'error', error: message });
}

function reconnect() {
  const st = player.get();
  if (!st.target) return;
  const n = st.reconnecting + 1;
  // A live stream that keeps stalling: its server may be failing, move to a backup URL.
  if (n >= 3 && tryNextServer(st)) return;
  player.set({ reconnecting: n, status: 'buffering' });
  setTimeout(() => {
    if (player.get().target === st.target) load(st.target && st.target.kind !== 'live' ? player.get().time : undefined);
  }, Math.min(8000, 1000 * n));
}

function startTimers() {
  clearInterval(watchdog);
  clearInterval(resumeTimer);
  // Auto-reconnect: a live stream that stops moving for 15s is reloaded.
  watchdog = setInterval(() => {
    const st = player.get();
    if (!st.target || st.target.kind !== 'live') return;
    if ((st.status === 'playing' || st.status === 'buffering') && Date.now() - lastProgressAt > 15000 && st.reconnecting < 10) {
      lastProgressAt = Date.now();
      reconnect();
    }
  }, 3000);
  resumeTimer = setInterval(saveProgress, 10000);
}

/**
 * Saves the resume point. Only once the video has really played in this session: backing out while
 * it is still loading (position 0) used to erase the resume point (under 30 s counts as "not
 * started").
 */
function saveProgress() {
  const st = player.get();
  if (!st.target || !engine || !playedThisSession) return;
  const key = resumeKey(st.target);
  const dur = engine.duration();
  const pos = engine.time();
  if (!key || !(dur > 0) || !(pos >= 0)) return;
  // Still before the position we started from: the jump to it hasn't happened yet.
  if (startedAt > 30 && pos < startedAt - 30 && Date.now() - playStartedAt < 60000) return;
  saveResume(key, pos, dur);
}

function onEnded() {
  const st = player.get();
  saveProgress();
  if (st.target && st.target.kind === 'episode' && user.get().data.settings.autoplayNext) {
    if (nextEpisode()) return;
  }
  if (st.target && st.target.kind === 'live') reconnect();
}

export function stop(): void {
  saveProgress();
  clearInterval(watchdog);
  clearInterval(resumeTimer);
  if (engine) engine.stop();
  setScreenSaver(true);
  player.set({ target: null, status: 'idle', subtitle: '', windowed: false });
}

export function setWindow(rect: Rect | null): void {
  if (engine) engine.setRect(rect);
  player.set({ windowed: !!rect });
}

export const SPEEDS = [1, 1.25, 1.5, 2, 4, 10];

/** Sets the playback speed (movies and episodes); returns the speed the engine actually uses. */
export function setSpeed(rate: number): number {
  const st = player.get();
  if (!engine || !st.target || st.target.kind === 'live') return 1;
  const applied = engine.setSpeed(rate);
  player.set({ speed: applied });
  return applied;
}

export function togglePause(): void {
  if (!engine) return;
  if (player.get().status === 'paused') engine.play();
  else engine.pause();
}

// ---- Scrubbing: Left/Right move a target, one seek when you stop ------------------------------
// Each seek on an IPTV stream reconnects and buffers (2-3 s), so seeking on every press made going
// to the middle of a movie take minutes. Presses now move a marker, faster the longer you hold, and
// the player seeks once.

let scrubTimer: ReturnType<typeof setTimeout> | undefined;
let lastScrubKeyAt = 0;
let scrubRun = 0;

const SCRUB_STEPS = [10, 10, 10, 30, 30, 30, 60, 60, 60, 60, 120, 120, 120, 120, 300];

function scrubbable(): boolean {
  const st = player.get();
  return !!engine && !!st.target && st.target.kind !== 'live' && engine.duration() > 0;
}

/** Moves the scrub target one step back (-1) or forward (1); steps grow while the key is held. */
export function scrubStep(dir: 1 | -1): void {
  if (!scrubbable()) return;
  const now = Date.now();
  scrubRun = now - lastScrubKeyAt < 700 ? scrubRun + 1 : 0;
  lastScrubKeyAt = now;
  const step = SCRUB_STEPS[Math.min(scrubRun, SCRUB_STEPS.length - 1)];
  const st = player.get();
  const from = st.scrub !== null ? st.scrub : engine!.time();
  scrubSet(from + dir * step);
}

/** Jumps the scrub target to a fraction of the duration (number keys: 0 = start, 5 = half). */
export function scrubToFraction(f: number): void {
  if (!scrubbable()) return;
  scrubSet(engine!.duration() * f);
}

function scrubSet(t: number): void {
  const dur = engine!.duration();
  player.set({ scrub: Math.max(0, Math.min(dur - 3, t)) });
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(commitScrub, 1000);
}

/** Seeks to the scrub target now (OK, or one second after the last press). */
export function commitScrub(): boolean {
  clearTimeout(scrubTimer);
  const t = player.get().scrub;
  if (t === null) return false;
  player.set({ scrub: null });
  seekTo(t);
  return true;
}

export function cancelScrub(): boolean {
  clearTimeout(scrubTimer);
  if (player.get().scrub === null) return false;
  player.set({ scrub: null });
  return true;
}

export function seekBy(seconds: number): void {
  if (!engine || !player.get().target || player.get().target!.kind === 'live') return;
  const t = Math.max(0, Math.min(engine.duration() - 2, engine.time() + seconds));
  engine.seek(t);
  player.set({ time: t });
}

export function seekTo(seconds: number): void {
  if (!engine) return;
  engine.seek(seconds);
  player.set({ time: seconds });
}

export function retry(): void {
  player.set({ reconnecting: 0, error: '' });
  load(player.get().time || undefined);
}

export function nextEpisode(dir = 1): boolean {
  const st = player.get();
  if (!st.target || st.target.kind !== 'episode') return false;
  const list = st.target.episodes;
  const i = list.findIndex((e) => e.key === (st.target as { episode: Episode }).episode.key);
  const next = list[i + dir];
  if (!next) return false;
  play({ kind: 'episode', series: st.target.series, episode: next, episodes: list });
  return true;
}

/** Channel up/down within the list the channel was opened from. */
export function zap(dir: number): Channel | null {
  const st = player.get();
  if (!st.target || st.target.kind !== 'live') return null;
  const list = st.target.list;
  if (!list.length) return null;
  const i = list.findIndex((c) => c.key === (st.target as { channel: Channel }).channel.key);
  const next = list[(i + dir + list.length) % list.length];
  play({ kind: 'live', channel: next, list }, { windowed: null });
  return next;
}

export function selectAudio(index: number): void {
  if (!engine) return;
  engine.selectAudio(index);
  player.set({ audioIndex: index });
}

export function selectText(index: number): void {
  if (!engine) return;
  engine.selectText(index);
  player.set({ textIndex: index });
}

export function setAspect(mode: 'fit' | 'fill' | 'stretch'): void {
  if (engine) engine.setAspect(mode);
}

// Pause/resume with the app (Home button, input switch).
document.addEventListener('visibilitychange', () => {
  if (!engine || !player.get().target) return;
  if (document.hidden) {
    saveProgress();
    if (player.get().target!.kind === 'live') engine.stop();
    else engine.pause();
  } else if (player.get().target!.kind === 'live') {
    load();
  }
});
