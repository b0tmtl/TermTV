// Search worker: holds the search indexes (library + guide) so typing never blocks the UI.

import { SearchIndex } from '@/core/search/engine';
import type { SearchRequest, SearchResponse } from './protocol';

const ctx = self as unknown as { postMessage(m: SearchResponse): void; onmessage: ((e: MessageEvent) => void) | null };
const post = (m: SearchResponse) => ctx.postMessage(m);

let library: SearchIndex | null = null;
let guide: SearchIndex | null = null;
let exclude: Uint8Array | null = null;
let boosts = new Map<number, number>();

ctx.onmessage = (e: MessageEvent) => {
  const req = e.data as SearchRequest;
  try {
    switch (req.type) {
      case 'build': {
        const t0 = Date.now();
        const idx = SearchIndex.build(req.docs);
        if (req.guide) guide = idx;
        else {
          library = idx;
          exclude = null;
        }
        post({ type: 'built', id: req.id, size: idx.size, ms: Date.now() - t0 });
        return;
      }
      case 'exclude':
        exclude = req.mask;
        post({ type: 'ok', id: req.id });
        return;
      case 'boost':
        boosts = new Map(req.boosts);
        post({ type: 'ok', id: req.id });
        return;
      case 'query': {
        const idx = req.guide ? guide : library;
        if (!idx) {
          post({ type: 'result', id: req.id, result: { hits: [], totals: { live: 0, movie: 0, series: 0, programme: 0 }, tookMs: 0 } });
          return;
        }
        const mask = req.guide ? null : exclude;
        const result = idx.search(req.q, {
          kinds: req.kinds,
          limitPerKind: req.limit,
          exclude: mask ? (d) => mask[d] === 1 : undefined,
          boost: !req.guide && boosts.size ? (d) => boosts.get(d) || 0 : undefined,
        });
        post({ type: 'result', id: req.id, result });
        return;
      }
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
