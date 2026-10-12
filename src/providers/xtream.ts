// Xtream Codes API client (player_api.php).

import type { Category, Channel, Episode, MediaKind, Movie, MovieDetails, Programme, Series, SeriesDetails, XtreamSourceConfig } from '@/core/models';
import { itemKey } from '@/core/models';
import { getJson } from '@/platform/http';

export type Fetcher = <T>(url: string) => Promise<T>;

export interface XtreamAccount {
  status: string;
  expiresAt?: number; // unix ms
  maxConnections?: number;
  activeConnections?: number;
  isTrial?: boolean;
  serverTimezone?: string;
}

export interface XtreamLibrary {
  categories: Category[];
  live: Channel[];
  movies: Movie[];
  series: Series[];
}

/** Turns whatever the user typed into a clean server base URL: adds http://, strips paths. */
export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(s);
  if (!m) return s.replace(/\/+$/, '');
  let path = (m[2] || '').replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
  if (path === '/c') path = '';
  return m[1] + path;
}

/**
 * Detects Xtream credentials in a pasted M3U link:
 * http://host:8080/get.php?username=u&password=p&type=m3u_plus
 */
export function xtreamFromUrl(url: string): XtreamSourceConfig | null {
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?\?(.*)$/i.exec(url.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[3].split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
  }
  if (!params.username || !params.password) return null;
  if (m[2] && !/\/(get|player_api|xmltv)\.php$/i.test(m[2])) return null;
  return { type: 'xtream', server: m[1], username: params.username, password: params.password };
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || isNaN(n) ? undefined : n;
};
const secToMs = (v: unknown): number | undefined => {
  const n = num(v);
  return n ? n * 1000 : undefined;
};
const yearOf = (v: unknown): number | undefined => {
  const m = /(19|20)\d{2}/.exec(str(v));
  return m ? Number(m[0]) : undefined;
};

/** Xtream EPG titles/descriptions are usually base64; decode safely (UTF-8). */
export function decodeBase64Text(s: string): string {
  if (!s) return '';
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length % 4 !== 0) return s;
  try {
    const bin = atob(s);
    let out = '';
    try {
      // UTF-8 decode
      out = decodeURIComponent(bin.split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    } catch {
      out = bin;
    }
    return out;
  } catch {
    return s;
  }
}

/** All server URLs of a source, main first, without duplicates. */
export function xtreamServers(config: XtreamSourceConfig): string[] {
  const out: string[] = [];
  for (const s of [config.server].concat(config.backupServers || [])) {
    const n = s && s.trim() ? normalizeServer(s) : '';
    if (n && out.indexOf(n) < 0) out.push(n);
  }
  return out;
}

function timeLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('No answer after ' + Math.round(ms / 1000) + ' s')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Login failed on a server that answered: trying the backup URLs won't help. */
export class XtreamAuthError extends Error {}

export class XtreamClient {
  /** The server in use: the main one, or the first backup that answered. */
  base: string;

  constructor(readonly config: XtreamSourceConfig, private fetcher: Fetcher = (u) => getJson(u)) {
    this.base = normalizeServer(config.server);
  }

  /** Uses a server found earlier by `connect` (e.g. in another thread). */
  useServer(base: string | undefined): this {
    if (base && xtreamServers(this.config).indexOf(base) >= 0) this.base = base;
    return this;
  }

  /**
   * Logs in on the main server, or on the next backup URL when a server is down. A server that
   * answers "wrong login" stops the search (the others would say the same).
   */
  async connect(onTry?: (server: string, i: number, total: number) => void): Promise<XtreamAccount> {
    const servers = xtreamServers(this.config);
    const failures: string[] = [];
    for (let i = 0; i < servers.length; i++) {
      this.base = servers[i];
      if (onTry) onTry(servers[i], i, servers.length);
      try {
        // A dead server can take 30 s to time out; with backups, move on sooner.
        return await (servers.length > 1 ? timeLimit(this.authenticate(), 12000) : this.authenticate());
      } catch (e) {
        if (e instanceof XtreamAuthError) throw e;
        failures.push(servers[i] + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    this.base = servers[0];
    if (servers.length === 1) throw new Error(failures[0] ? failures[0].slice(servers[0].length + 2) : 'Server unreachable');
    throw new Error('None of the ' + servers.length + ' server URLs answered:\n' + failures.join('\n'));
  }

  private api(params: Record<string, string | number> = {}): string {
    let url = `${this.base}/player_api.php?username=${encodeURIComponent(this.config.username)}&password=${encodeURIComponent(this.config.password)}`;
    for (const k of Object.keys(params)) url += `&${k}=${encodeURIComponent(String(params[k]))}`;
    return url;
  }

  async authenticate(): Promise<XtreamAccount> {
    const res = await this.fetcher<any>(this.api());
    const ui = res && res.user_info;
    if (!ui || Number(ui.auth) === 0) {
      // A JSON answer without user_info is a working server refusing the login.
      if (res && typeof res === 'object') throw new XtreamAuthError('Login failed: check the username and password');
      throw new Error('Not an Xtream server');
    }
    if (ui.status && String(ui.status).toLowerCase() !== 'active') throw new XtreamAuthError(`Account is ${ui.status}`);
    return {
      status: str(ui.status) || 'Active',
      expiresAt: secToMs(ui.exp_date),
      maxConnections: num(ui.max_connections),
      activeConnections: num(ui.active_cons),
      isTrial: str(ui.is_trial) === '1',
      serverTimezone: res.server_info ? str(res.server_info.timezone) : undefined,
    };
  }

  async loadLibrary(sourceId: string): Promise<XtreamLibrary> {
    const [lc, vc, sc, live, vod, series] = await Promise.all([
      this.fetcher<any[]>(this.api({ action: 'get_live_categories' })),
      this.fetcher<any[]>(this.api({ action: 'get_vod_categories' })),
      this.fetcher<any[]>(this.api({ action: 'get_series_categories' })),
      this.fetcher<any[]>(this.api({ action: 'get_live_streams' })),
      this.fetcher<any[]>(this.api({ action: 'get_vod_streams' })),
      this.fetcher<any[]>(this.api({ action: 'get_series' })),
    ]);
    const categories: Category[] = [];
    const known = new Set<string>();
    const addCats = (list: any[], kind: MediaKind) => {
      (Array.isArray(list) ? list : []).forEach((c, i) => {
        const pid = str(c.category_id);
        const key = itemKey(sourceId, kind, pid);
        known.add(key);
        categories.push({ key, sourceId, kind, providerId: pid, name: str(c.category_name) || 'Uncategorized', order: i });
      });
    };
    addCats(lc, 'live');
    addCats(vc, 'movie');
    addCats(sc, 'series');
    // Items can reference categories the provider didn't list.
    const catKey = (kind: MediaKind, raw: unknown) => {
      const pid = str(raw) || 'none';
      const key = itemKey(sourceId, kind, pid);
      if (!known.has(key)) {
        known.add(key);
        categories.push({ key, sourceId, kind, providerId: pid, name: 'Uncategorized', order: 100000 + categories.length });
      }
      return key;
    };

    const liveItems: Channel[] = (Array.isArray(live) ? live : []).map((s, i) => ({
      key: itemKey(sourceId, 'live', s.stream_id),
      sourceId,
      kind: 'live',
      providerId: str(s.stream_id),
      name: str(s.name).trim() || `Channel ${i + 1}`,
      categoryKey: catKey('live', s.category_id),
      order: i,
      image: str(s.stream_icon) || undefined,
      added: secToMs(s.added),
      number: num(s.num),
      epgId: str(s.epg_channel_id) || undefined,
      archive: Number(s.tv_archive) === 1,
    }));
    const movieItems: Movie[] = (Array.isArray(vod) ? vod : []).map((s, i) => ({
      key: itemKey(sourceId, 'movie', s.stream_id),
      sourceId,
      kind: 'movie',
      providerId: str(s.stream_id),
      name: str(s.name).trim() || `Movie ${i + 1}`,
      categoryKey: catKey('movie', s.category_id),
      order: i,
      image: str(s.stream_icon) || undefined,
      added: secToMs(s.added),
      rating: num(s.rating_5based) ? num(s.rating_5based)! * 2 : num(s.rating),
      year: num(s.year) || yearOf(s.release_date) || yearOf(s.name),
      ext: str(s.container_extension) || 'mp4',
    }));
    const seriesItems: Series[] = (Array.isArray(series) ? series : []).map((s, i) => ({
      key: itemKey(sourceId, 'series', s.series_id),
      sourceId,
      kind: 'series',
      providerId: str(s.series_id),
      name: str(s.name).trim() || `Series ${i + 1}`,
      categoryKey: catKey('series', s.category_id),
      order: i,
      image: str(s.cover) || undefined,
      added: secToMs(s.last_modified),
      rating: num(s.rating_5based) ? num(s.rating_5based)! * 2 : num(s.rating),
      year: num(s.year) || yearOf(s.releaseDate) || yearOf(s.release_date),
      plot: str(s.plot) || undefined,
    }));
    return { categories, live: liveItems, movies: movieItems, series: seriesItems };
  }

  async movieDetails(movie: Movie): Promise<MovieDetails> {
    const res = await this.fetcher<any>(this.api({ action: 'get_vod_info', vod_id: movie.providerId }));
    const info = (res && res.info) || {};
    return mapDetails(info);
  }

  async seriesDetails(series: Series): Promise<SeriesDetails> {
    const res = await this.fetcher<any>(this.api({ action: 'get_series_info', series_id: series.providerId }));
    const info = (res && res.info) || {};
    const episodes: Episode[] = [];
    const eps = (res && res.episodes) || {};
    const seasonKeys = Array.isArray(eps) ? eps.map((_: unknown, i: number) => String(i)) : Object.keys(eps);
    for (const sk of seasonKeys) {
      const list = (Array.isArray(eps) ? eps[Number(sk)] : eps[sk]) || [];
      for (const e of list) {
        const season = num(e.season) || num(sk) || 1;
        episodes.push({
          key: itemKey(series.sourceId, 'series', `ep${e.id}`),
          seriesKey: series.key,
          providerId: str(e.id),
          season,
          episode: num(e.episode_num) || episodes.length + 1,
          title: str(e.title) || `Episode ${e.episode_num}`,
          plot: e.info ? str(e.info.plot) || undefined : undefined,
          image: e.info ? str(e.info.movie_image) || undefined : undefined,
          duration: e.info ? num(e.info.duration_secs) : undefined,
          ext: str(e.container_extension) || 'mp4',
        });
      }
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const seasons: number[] = [];
    for (const e of episodes) if (seasons.indexOf(e.season) < 0) seasons.push(e.season);
    return { ...mapDetails(info), seasons, episodes };
  }

  async shortEpg(channel: Channel, limit = 10): Promise<Programme[]> {
    const res = await this.fetcher<any>(this.api({ action: 'get_short_epg', stream_id: channel.providerId, limit }));
    const list: any[] = (res && res.epg_listings) || [];
    return list
      .map((p) => ({
        channelEpgId: channel.epgId || channel.key,
        start: secToMs(p.start_timestamp) || Date.parse(str(p.start).replace(' ', 'T')),
        end: secToMs(p.stop_timestamp) || Date.parse(str(p.end).replace(' ', 'T')),
        title: decodeBase64Text(str(p.title)),
        desc: decodeBase64Text(str(p.description)) || undefined,
      }))
      .filter((p) => p.start && p.end && p.title);
  }

  xmltvUrl(): string {
    return `${this.base}/xmltv.php?username=${encodeURIComponent(this.config.username)}&password=${encodeURIComponent(this.config.password)}`;
  }

  liveUrl(channel: Channel, format: 'ts' | 'm3u8' = 'ts'): string {
    return `${this.base}/live/${enc(this.config.username)}/${enc(this.config.password)}/${channel.providerId}.${format}`;
  }

  movieUrl(movie: Movie): string {
    return `${this.base}/movie/${enc(this.config.username)}/${enc(this.config.password)}/${movie.providerId}.${movie.ext || 'mp4'}`;
  }

  episodeUrl(ep: Episode): string {
    return `${this.base}/series/${enc(this.config.username)}/${enc(this.config.password)}/${ep.providerId}.${ep.ext || 'mp4'}`;
  }

  /** Catch-up (timeshift) URL for a past programme. */
  catchupUrl(channel: Channel, start: number, durationMin: number): string {
    const d = new Date(start);
    const p = (n: number) => (n < 10 ? '0' : '') + n;
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}:${p(d.getHours())}-${p(d.getMinutes())}`;
    return `${this.base}/timeshift/${enc(this.config.username)}/${enc(this.config.password)}/${Math.ceil(durationMin)}/${ts}/${channel.providerId}.ts`;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function mapDetails(info: any): MovieDetails {
  const backdrop = Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path;
  const rating = num(info.rating_5based) ? num(info.rating_5based)! * 2 : num(info.rating);
  return {
    plot: str(info.plot || info.description) || undefined,
    cast: str(info.cast || info.actors) || undefined,
    director: str(info.director) || undefined,
    genre: str(info.genre) || undefined,
    duration: num(info.duration_secs) || (num(info.episode_run_time) ? num(info.episode_run_time)! * 60 : undefined),
    backdrop: str(backdrop) || undefined,
    rating: rating || undefined,
    year: yearOf(info.releasedate || info.releaseDate || info.release_date),
    trailer: str(info.youtube_trailer) || undefined,
  };
}
