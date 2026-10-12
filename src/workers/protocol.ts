// Messages between the main thread and the workers.

import type { Category, Channel, Episode, Movie, Programme, Series, Source } from '@/core/models';
import type { SearchDocInput, SearchResult } from '@/core/search/engine';
import type { XtreamAccount } from '@/providers/xtream';

export interface SourceLibrary {
  sourceId: string;
  updatedAt: number;
  categories: Category[];
  live: Channel[];
  movies: Movie[];
  series: Series[];
  /** M3U only: episodes per series key. */
  episodes?: Record<string, Episode[]>;
  epgUrls: string[];
  account?: XtreamAccount;
}

export interface SourceEpg {
  sourceId: string;
  updatedAt: number;
  from: number;
  to: number;
  /** epg channel id -> programmes sorted by start */
  programmes: Record<string, Programme[]>;
  /** channel key -> epg channel id, for channels matched by display name */
  matched: Record<string, string>;
}

export interface EpgChannelRef {
  key: string;
  epgId?: string;
  name: string;
}

export type LibraryRequest =
  | { type: 'refresh'; id: number; source: Source; proxy?: string }
  | { type: 'load'; id: number; sourceId: string }
  | { type: 'epg'; id: number; source: Source; urls: string[]; channels: EpgChannelRef[]; hoursBack: number; hoursAhead: number; proxy?: string }
  | { type: 'loadEpg'; id: number; sourceId: string }
  | { type: 'delete'; id: number; sourceId: string };

export type LibraryResponse =
  | { type: 'progress'; id: number; stage: string; loaded?: number; total?: number }
  | { type: 'library'; id: number; library: SourceLibrary | null }
  | { type: 'epg'; id: number; epg: SourceEpg | null }
  | { type: 'ok'; id: number }
  | { type: 'error'; id: number; message: string };

export type SearchRequest =
  | { type: 'build'; id: number; docs: SearchDocInput[]; guide?: boolean }
  | { type: 'query'; id: number; q: string; kinds: number; limit: number; guide?: boolean }
  | { type: 'exclude'; id: number; mask: Uint8Array | null }
  | { type: 'boost'; id: number; boosts: Array<[number, number]> };

export type SearchResponse =
  | { type: 'built'; id: number; size: number; ms: number }
  | { type: 'result'; id: number; result: SearchResult }
  | { type: 'ok'; id: number }
  | { type: 'error'; id: number; message: string };
