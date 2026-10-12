// Shared data model. Every provider (Xtream, M3U) is normalized into these shapes.

export type MediaKind = 'live' | 'movie' | 'series';

export type SourceType = 'xtream' | 'm3u';

export interface XtreamSourceConfig {
  type: 'xtream';
  server: string; // e.g. http://provider.example:8080
  username: string;
  password: string;
}

export interface M3USourceConfig {
  type: 'm3u';
  url: string;
  epgUrl?: string; // optional XMLTV override; otherwise read from the playlist header
}

export type SourceConfig = XtreamSourceConfig | M3USourceConfig;

export interface Source {
  id: string;
  name: string;
  enabled: boolean;
  config: SourceConfig;
  addedAt: number;
  lastRefresh?: number;
  lastError?: string;
}

export interface Category {
  /** Globally unique: `${sourceId}:${kind}:${providerId}` */
  key: string;
  sourceId: string;
  kind: MediaKind;
  providerId: string;
  name: string;
  /** Position in the provider's list. */
  order: number;
}

interface BaseItem {
  /** Globally unique: `${sourceId}:${kind}:${providerId}` */
  key: string;
  sourceId: string;
  kind: MediaKind;
  providerId: string;
  name: string;
  categoryKey: string;
  /** Position in the provider's list (within its category). */
  order: number;
  image?: string;
  /** Unix ms; when the provider says it was added. */
  added?: number;
}

export interface Channel extends BaseItem {
  kind: 'live';
  number?: number;
  epgId?: string;
  /** Direct URL for M3U; for Xtream the URL is built at play time. */
  url?: string;
  /** Xtream: catch-up available. */
  archive?: boolean;
}

export interface Movie extends BaseItem {
  kind: 'movie';
  year?: number;
  rating?: number;
  ext?: string;
  url?: string;
}

export interface Series extends BaseItem {
  kind: 'series';
  year?: number;
  rating?: number;
  plot?: string;
}

export type Item = Channel | Movie | Series;

export interface Episode {
  key: string;
  seriesKey: string;
  providerId: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  image?: string;
  duration?: number; // seconds
  ext?: string;
  url?: string;
}

export interface MovieDetails {
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  duration?: number;
  backdrop?: string;
  rating?: number;
  year?: number;
  trailer?: string;
}

export interface SeriesDetails extends MovieDetails {
  seasons: number[];
  episodes: Episode[];
}

export interface Programme {
  channelEpgId: string;
  start: number; // unix ms
  end: number;
  title: string;
  desc?: string;
  category?: string;
}

export function itemKey(sourceId: string, kind: MediaKind, providerId: string | number): string {
  return `${sourceId}:${kind}:${providerId}`;
}
