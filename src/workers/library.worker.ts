// Library worker: downloads and parses sources and guides off the main thread, and caches them in
// IndexedDB so the next launch starts instantly.

import { Gunzip } from 'fflate';
import { normalizeText } from '@/core/normalize';
import type { Programme, Source } from '@/core/models';
import { dbDelete, dbGet, dbPut } from '@/platform/db';
import { setUrlRewriter, streamBytes } from '@/platform/http';
import { M3UCollector, M3UParser } from '@/providers/m3u';
import { XmltvParser } from '@/providers/xmltv';
import { XtreamClient } from '@/providers/xtream';
import type { EpgChannelRef, LibraryRequest, LibraryResponse, SourceEpg, SourceLibrary } from './protocol';

const ctx = self as unknown as { postMessage(m: LibraryResponse): void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: LibraryResponse) => ctx.postMessage(m);

// Download progress fires per chunk; tell the UI at most 4 times a second.
let lastProgress = 0;
function progress(id: number, stage: string, loaded?: number, total?: number) {
  const t = Date.now();
  if (t - lastProgress < 250) return;
  lastProgress = t;
  post({ type: 'progress', id, stage, loaded, total });
}

function useProxy(proxy?: string) {
  setUrlRewriter(proxy ? (u) => (/^https?:\/\//.test(u) ? proxy + encodeURIComponent(u) : u) : (u) => u);
}

ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as LibraryRequest;
  handle(req).catch((err: unknown) => post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) }));
};

async function handle(req: LibraryRequest) {
  switch (req.type) {
    case 'load':
      post({ type: 'library', id: req.id, library: (await dbGet<SourceLibrary>('library', req.sourceId)) || null });
      return;
    case 'loadEpg':
      post({ type: 'epg', id: req.id, epg: (await dbGet<SourceEpg>('epg', req.sourceId)) || null });
      return;
    case 'delete':
      await dbDelete('library', req.sourceId);
      await dbDelete('epg', req.sourceId);
      post({ type: 'ok', id: req.id });
      return;
    case 'refresh': {
      useProxy(req.proxy);
      const lib = await refresh(req.source, req.id);
      await dbPut('library', lib.sourceId, lib);
      post({ type: 'library', id: req.id, library: lib });
      return;
    }
    case 'epg': {
      useProxy(req.proxy);
      const epg = await loadEpg(req.source, req.urls, req.channels, req.hoursBack, req.hoursAhead, req.id);
      await dbPut('epg', epg.sourceId, epg);
      post({ type: 'epg', id: req.id, epg });
      return;
    }
  }
}

async function refresh(source: Source, id: number): Promise<SourceLibrary> {
  const cfg = source.config;
  if (cfg.type === 'xtream') {
    const client = new XtreamClient(cfg);
    post({ type: 'progress', id, stage: 'auth' });
    const account = await client.authenticate();
    post({ type: 'progress', id, stage: 'library' });
    const lib = await client.loadLibrary(source.id);
    return { sourceId: source.id, updatedAt: Date.now(), ...lib, epgUrls: [client.xmltvUrl()], account };
  }
  const collector = new M3UCollector(source.id);
  const parser = new M3UParser((entry) => collector.add(entry));
  const decoder = new TextDecoder('utf-8');
  post({ type: 'progress', id, stage: 'download' });
  await streamBytes(
    cfg.url,
    (bytes) => parser.push(decoder.decode(bytes, { stream: true })),
    (loaded, total) => progress(id, 'download', loaded, total),
  );
  parser.push(decoder.decode());
  parser.end();
  const lib = collector.finish(parser.header);
  if (!lib.live.length && !lib.movies.length && !lib.series.length) throw new Error('The playlist is empty or not a valid M3U file');
  return {
    sourceId: source.id,
    updatedAt: Date.now(),
    categories: lib.categories,
    live: lib.live,
    movies: lib.movies,
    series: lib.series,
    episodes: lib.episodes,
    epgUrls: cfg.epgUrl ? [cfg.epgUrl] : lib.epgUrls,
  };
}

async function loadEpg(source: Source, urls: string[], channels: EpgChannelRef[], hoursBack: number, hoursAhead: number, id: number): Promise<SourceEpg> {
  const now = Date.now();
  const from = now - hoursBack * 3600000;
  const to = now + hoursAhead * 3600000;
  const wanted = new Set<string>();
  const byName = new Map<string, string[]>(); // normalized name -> channel keys without epg id
  for (const c of channels) {
    if (c.epgId) wanted.add(c.epgId);
    else {
      const n = normalizeText(c.name);
      const l = byName.get(n);
      if (l) l.push(c.key);
      else byName.set(n, [c.key]);
    }
  }
  const matched: Record<string, string> = {};
  const programmes: Record<string, Programme[]> = {};
  let count = 0;

  for (const url of urls) {
    const parser = new XmltvParser(
      { from, to, channels: wanted },
      (p) => {
        const list = programmes[p.channelEpgId] || (programmes[p.channelEpgId] = []);
        list.push(p);
        count++;
      },
      (ch) => {
        if (wanted.has(ch.id) || !byName.size) return;
        for (const name of ch.names) {
          const keys = byName.get(normalizeText(name));
          if (keys) {
            wanted.add(ch.id);
            for (const k of keys) matched[k] = ch.id;
          }
        }
      },
    );
    const decoder = new TextDecoder('utf-8');
    let gunzip: Gunzip | null = null;
    let first = true;
    const feedText = (bytes: Uint8Array) => parser.push(decoder.decode(bytes, { stream: true }));
    try {
      await streamBytes(
        url,
        (bytes) => {
          if (first) {
            first = false;
            if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
              gunzip = new Gunzip((chunk) => feedText(chunk));
            }
          }
          if (gunzip) gunzip.push(bytes);
          else feedText(bytes);
        },
        (loaded, total) => progress(id, 'epg', loaded, total),
        { timeoutMs: 120000 },
      );
      if (gunzip) (gunzip as Gunzip).push(new Uint8Array(0), true);
      parser.push(decoder.decode());
      parser.end();
    } catch (err) {
      // One broken guide URL shouldn't drop the others.
      if (urls.length === 1) throw err;
    }
  }
  for (const k of Object.keys(programmes)) programmes[k].sort((a, b) => a.start - b.start);
  post({ type: 'progress', id, stage: 'epg-done', loaded: count });
  return { sourceId: source.id, updatedAt: now, from, to, programmes, matched };
}
