export type PlayerStatus = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface Track {
  index: number;
  language: string;
  label: string;
}

export interface PlayerEvents {
  status(s: PlayerStatus): void;
  time(seconds: number): void;
  subtitle(text: string): void;
  error(message: string): void;
  tracks(): void;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LoadOptions {
  live: boolean;
  /** Start position in seconds (VOD resume). */
  startAt?: number;
  /** Seconds buffered before playback starts; 0 or absent = the engine's default. */
  bufferSeconds?: number;
}

export interface PlayerEngine {
  readonly name: string;
  load(url: string, opts: LoadOptions): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  time(): number;
  duration(): number;
  /** null = full screen; otherwise a window in 1920x1080 coordinates (live preview). */
  setRect(rect: Rect | null): void;
  setAspect(mode: 'fit' | 'fill' | 'stretch'): void;
  audioTracks(): Track[];
  textTracks(): Track[];
  selectAudio(index: number): void;
  /** -1 = subtitles off. */
  selectText(index: number): void;
  currentAudio(): number;
  currentText(): number;
  /** Playback speed; returns the speed actually applied (engines don't all support every rate). */
  setSpeed(rate: number): number;
  destroy(): void;
}
