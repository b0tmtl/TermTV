// Streaming M3U / M3U8 playlist parser.
//
// Playlists can be 100+ MB, so text is fed in chunks and entries come out as they complete.
// Each entry is classified as live, movie or series episode from its URL and name, and episodes
// ("Show S01 E02") are grouped into series.

import type { Category, Channel, Episode, Movie, Series } from '@/core/models';
import { itemKey } from '@/core/models';

export interface M3UEntry {
  name: string;
  url: string;
  attrs: Record<string, string>;
  duration: number;
  group: string;
}

export interface M3UHeader {
  epgUrls: string[];
}

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

export class M3UParser {
  private buf = '';
  private pending: { info: string; group: string; opts: Record<string, string> } | null = null;
  readonly header: M3UHeader = { epgUrls: [] };
  private sawHeader = false;

  constructor(private onEntry: (e: M3UEntry) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    let start = 0;
    while ((nl = this.buf.indexOf('\n', start)) >= 0) {
      this.line(this.buf.slice(start, nl));
      start = nl + 1;
    }
    this.buf = this.buf.slice(start);
  }

  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = '';
  }

  private line(raw: string) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line) return;
    if (line.charCodeAt(0) === 35 /* # */) {
      if (line.lastIndexOf('#EXTM3U', 0) === 0) {
        this.sawHeader = true;
        const attrs = parseAttrs(line);
        for (const k of ['url-tvg', 'x-tvg-url', 'tvg-url']) {
          for (const u of (attrs[k] || '').split(',')) {
            if (u.trim() && this.header.epgUrls.indexOf(u.trim()) < 0) this.header.epgUrls.push(u.trim());
          }
        }
      } else if (line.lastIndexOf('#EXTINF', 0) === 0) {
        this.pending = { info: line, group: '', opts: {} };
      } else if (line.lastIndexOf('#EXTGRP:', 0) === 0 && this.pending) {
        this.pending.group = line.slice(8).trim();
      } else if (line.lastIndexOf('#EXTVLCOPT:', 0) === 0 && this.pending) {
        const kv = line.slice(11);
        const eq = kv.indexOf('=');
        if (eq > 0) this.pending.opts[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      return;
    }
    // A URL line.
    const p = this.pending;
    this.pending = null;
    if (!p) {
      if (!this.sawHeader && /^https?:\/\//.test(line)) this.onEntry({ name: line, url: line, attrs: {}, duration: -1, group: '' });
      return;
    }
    const info = p.info;
    // The display name follows the first comma outside quotes (names may contain commas).
    let inQuote = false;
    let comma = -1;
    for (let i = 7; i < info.length; i++) {
      const c = info.charCodeAt(i);
      if (c === 34) inQuote = !inQuote;
      else if (c === 44 && !inQuote) {
        comma = i;
        break;
      }
    }
    const head = comma >= 0 ? info.slice(0, comma) : info;
    const name = comma >= 0 ? info.slice(comma + 1).trim() : '';
    const attrs = parseAttrs(head);
    const dm = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)/.exec(head);
    const group = attrs['group-title'] || p.group || '';
    this.onEntry({
      name: name || attrs['tvg-name'] || line,
      url: line,
      attrs,
      duration: dm ? Number(dm[1]) : -1,
      group,
    });
  }
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

const VOD_EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|m4v|webm|mpg|mpeg|divx)(\?|$)/i;
// "Show S01E02", "Show S1 E2", "Show 1x02", "Show - S01 - E02 - Title"
const EPISODE_RE = /^(.*?)[\s._-]*\bS(\d{1,2})\s*[._-]?\s*E(\d{1,3})\b(.*)$/i;
const EPISODE_X_RE = /^(.*?)[\s._-]+(\d{1,2})x(\d{2,3})\b(.*)$/i;

export type EntryKind = 'live' | 'movie' | 'episode';

export function classifyEntry(e: M3UEntry): EntryKind {
  const url = e.url;
  if (/\/series\//i.test(url)) return 'episode';
  if (/\/movies?\//i.test(url)) return 'movie';
  if (EPISODE_RE.test(e.name) && (VOD_EXT_RE.test(url) || e.duration > 0)) return 'episode';
  if (VOD_EXT_RE.test(url)) return EPISODE_RE.test(e.name) ? 'episode' : 'movie';
  if (e.duration > 0 && !/\.m3u8|\.ts(\?|$)/i.test(url)) return 'movie';
  return 'live';
}

export function parseEpisodeName(name: string): { series: string; season: number; episode: number; title: string } | null {
  const m = EPISODE_RE.exec(name) || EPISODE_X_RE.exec(name);
  if (!m) return null;
  const series = m[1].replace(/[\s._-]+$/, '').trim();
  if (!series) return null;
  return {
    series,
    season: Number(m[2]),
    episode: Number(m[3]),
    title: m[4].replace(/^[\s._:-]+/, '').trim(),
  };
}

export interface M3ULibrary {
  categories: Category[];
  live: Channel[];
  movies: Movie[];
  series: Series[];
  /** Episodes per series key (M3U has no series API, so we keep them). */
  episodes: Record<string, Episode[]>;
  epgUrls: string[];
}

/** Collects parsed entries into the normalized model. */
export class M3UCollector {
  private lib: M3ULibrary = { categories: [], live: [], movies: [], series: [], episodes: {}, epgUrls: [] };
  private cats = new Map<string, Category>();
  private seriesByName = new Map<string, Series>();
  private n = 0;

  constructor(private sourceId: string) {}

  add(e: M3UEntry): void {
    const kind = classifyEntry(e);
    const n = this.n++;
    const logo = e.attrs['tvg-logo'] || e.attrs['logo'] || undefined;
    if (kind === 'episode') {
      const ep = parseEpisodeName(e.name);
      if (ep) {
        const cat = this.category('series', e.group || 'Series');
        let s = this.seriesByName.get(cat.key + '|' + ep.series.toLowerCase());
        if (!s) {
          const pid = 's' + this.seriesByName.size;
          s = {
            key: itemKey(this.sourceId, 'series', pid), sourceId: this.sourceId, kind: 'series', providerId: pid,
            name: ep.series, categoryKey: cat.key, order: this.lib.series.length, image: logo,
          };
          this.seriesByName.set(cat.key + '|' + ep.series.toLowerCase(), s);
          this.lib.series.push(s);
          this.lib.episodes[s.key] = [];
        }
        const pid = 'e' + n;
        this.lib.episodes[s.key].push({
          key: itemKey(this.sourceId, 'series', pid), seriesKey: s.key, providerId: pid, season: ep.season,
          episode: ep.episode, title: ep.title || `Episode ${ep.episode}`, image: logo, url: e.url,
          duration: e.duration > 0 ? e.duration : undefined,
        });
        return;
      }
    }
    if (kind === 'movie' || kind === 'episode') {
      const cat = this.category('movie', e.group || 'Movies');
      const pid = 'm' + n;
      const ym = /\((\d{4})\)\s*$/.exec(e.name);
      this.lib.movies.push({
        key: itemKey(this.sourceId, 'movie', pid), sourceId: this.sourceId, kind: 'movie', providerId: pid,
        name: e.name, categoryKey: cat.key, order: n, image: logo, url: e.url, year: ym ? Number(ym[1]) : undefined,
      });
      return;
    }
    const cat = this.category('live', e.group || 'Uncategorized');
    const pid = 'l' + n;
    const chno = Number(e.attrs['tvg-chno'] || e.attrs['channel-number'] || e.attrs['tvg-num'] || 0);
    this.lib.live.push({
      key: itemKey(this.sourceId, 'live', pid), sourceId: this.sourceId, kind: 'live', providerId: pid,
      name: e.name, categoryKey: cat.key, order: n, image: logo, url: e.url,
      epgId: e.attrs['tvg-id'] || e.attrs['tvg-name'] || undefined,
      number: chno > 0 ? chno : undefined,
      archive: !!(e.attrs['catchup'] || e.attrs['catchup-days'] || e.attrs['timeshift']),
    });
  }

  private category(kind: 'live' | 'movie' | 'series', name: string): Category {
    const id = `${kind}|${name}`;
    let c = this.cats.get(id);
    if (!c) {
      const providerId = 'c' + this.cats.size;
      c = { key: itemKey(this.sourceId, kind, providerId), sourceId: this.sourceId, kind, providerId, name, order: this.cats.size };
      this.cats.set(id, c);
      this.lib.categories.push(c);
    }
    return c;
  }

  finish(header: M3UHeader): M3ULibrary {
    for (const key of Object.keys(this.lib.episodes)) {
      this.lib.episodes[key].sort((a, b) => a.season - b.season || a.episode - b.episode);
    }
    this.lib.epgUrls = header.epgUrls;
    return this.lib;
  }
}

/** Parses a whole playlist string (tests, small playlists). */
export function parseM3U(sourceId: string, text: string): M3ULibrary {
  const collector = new M3UCollector(sourceId);
  const parser = new M3UParser((e) => collector.add(e));
  parser.push(text);
  parser.end();
  return collector.finish(parser.header);
}
