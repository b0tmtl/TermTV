// TermTV search engine.
//
// An inverted index over normalized words. Built once per library refresh (in a worker), then
// queried on every key press. Matching per query word, best first:
//   exact word  >  word prefix  >  inside a word (3+ chars)  >  typo (4+ letters: 1 edit, 8+: 2 edits)
// Every query word must match (in any order). Ranking adds bonuses for an exact title, a title that
// starts with the query, the query as a phrase, and caller boosts (favorites, recently watched).
//
// Speed matters more than usual: a 2018 TV is 5-10x slower than a laptop. So:
//  - prefix lookups are a binary search in the sorted word list,
//  - "inside a word" uses a trigram index over the word list instead of scanning it,
//  - typo matching only scans words sharing the first letter (a contiguous range),
//  - only the top results are sorted; the rest are counted.

import { normalizeText, tokenize } from '../normalize';
import { boundedDistance } from './distance';

export const DocKind = { live: 1, movie: 2, series: 4, programme: 8 } as const;
export type DocKindName = keyof typeof DocKind;
export const ALL_KINDS = 0xff;

export interface SearchDocInput {
  kind: DocKindName;
  text: string;
  /** Channel number, matched exactly when the query is only digits. */
  number?: number;
  /** Docs with the same group key are merged into one result (same movie from 2 sources, FHD/4K). */
  group?: string;
}

export interface SearchOptions {
  /** Bitmask of DocKind values; default all. */
  kinds?: number;
  /** Max results returned per kind. Default 300. */
  limitPerKind?: number;
  /** Extra score per doc (favorites, history). */
  boost?: (doc: number) => number;
  /** Docs to leave out (hidden categories, parental locks). */
  exclude?: (doc: number) => boolean;
}

export interface SearchHit {
  doc: number;
  score: number;
  /** Other docs merged into this hit (same group key), best first. */
  variants?: number[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** Total matches per kind (duplicates merged). */
  totals: Record<DocKindName, number>;
  tookMs: number;
}

const Q_EXACT = 4;
const Q_PREFIX = 3;
const Q_INFIX = 2;
const Q_FUZZY = 1;

export interface SerializedIndex {
  words: string[];
  postingOffsets: Uint32Array;
  postings: Uint32Array;
  kinds: Uint8Array;
  numbers: Int32Array;
  groupIds: Int32Array;
  groupCount: number;
  names: string[];
}

export class SearchIndex {
  private words: string[] = [];
  private postingOffsets: Uint32Array = new Uint32Array(1);
  private postings: Uint32Array = new Uint32Array(0);
  private kinds: Uint8Array = new Uint8Array(0);
  private numbers: Int32Array = new Int32Array(0);
  private groupIds: Int32Array = new Int32Array(0);
  private groupCount = 0;
  /** Normalized full text per doc. */
  private names: string[] = [];
  /** trigram -> sorted word indexes containing it */
  private trigrams = new Map<string, Uint32Array>();
  // Scratch buffers reused between queries.
  private matchCount: Uint8Array = new Uint8Array(0);
  private tokenScore: Float32Array = new Float32Array(0);
  private hitDocs: Uint32Array = new Uint32Array(0);
  private hitScores: Float32Array = new Float32Array(0);
  private groupStamp: Int32Array = new Int32Array(0);
  private stamp = 0;

  get size(): number {
    return this.kinds.length;
  }

  static build(docs: SearchDocInput[]): SearchIndex {
    const idx = new SearchIndex();
    const n = docs.length;
    const wordIds = new Map<string, number>();
    const wordList: string[] = [];
    const lists: number[][] = [];
    const lastDoc: number[] = [];
    const groupMap = new Map<string, number>();
    idx.kinds = new Uint8Array(n);
    idx.numbers = new Int32Array(n);
    idx.groupIds = new Int32Array(n);
    idx.names = new Array(n);

    for (let d = 0; d < n; d++) {
      const doc = docs[d];
      idx.kinds[d] = DocKind[doc.kind];
      idx.numbers[d] = doc.number && doc.number > 0 ? doc.number : -1;
      if (doc.group) {
        const gk = `${doc.kind}|${doc.group}`;
        let g = groupMap.get(gk);
        if (g === undefined) {
          g = groupMap.size;
          groupMap.set(gk, g);
        }
        idx.groupIds[d] = g;
      } else {
        idx.groupIds[d] = -1;
      }
      const norm = normalizeText(doc.text);
      idx.names[d] = norm;
      const ws = indexWords(norm);
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        let id = wordIds.get(w);
        if (id === undefined) {
          id = wordList.length;
          wordIds.set(w, id);
          wordList.push(w);
          lists.push([]);
          lastDoc.push(-1);
        }
        if (lastDoc[id] !== d) {
          lists[id].push(d);
          lastDoc[id] = d;
        }
      }
    }
    idx.groupCount = groupMap.size;

    // Sort words so prefix lookups are a binary search + scan.
    const order = wordList.map((_, i) => i).sort((a, b) => (wordList[a] < wordList[b] ? -1 : wordList[a] > wordList[b] ? 1 : 0));
    idx.words = order.map((i) => wordList[i]);
    let total = 0;
    for (const l of lists) total += l.length;
    idx.postings = new Uint32Array(total);
    idx.postingOffsets = new Uint32Array(order.length + 1);
    let off = 0;
    for (let si = 0; si < order.length; si++) {
      idx.postingOffsets[si] = off;
      const l = lists[order[si]];
      for (let k = 0; k < l.length; k++) idx.postings[off++] = l[k];
    }
    idx.postingOffsets[order.length] = off;
    idx.prepare();
    return idx;
  }

  static fromSerialized(s: SerializedIndex): SearchIndex {
    const idx = new SearchIndex();
    idx.words = s.words;
    idx.postingOffsets = s.postingOffsets;
    idx.postings = s.postings;
    idx.kinds = s.kinds;
    idx.numbers = s.numbers;
    idx.groupIds = s.groupIds;
    idx.groupCount = s.groupCount;
    idx.names = s.names;
    idx.prepare();
    return idx;
  }

  /** Other docs in the same duplicate group (same title + year: other sources, FHD / 4K). */
  groupMembers(doc: number): number[] {
    const g = this.groupIds[doc];
    const out: number[] = [];
    if (g === undefined || g < 0) return out;
    for (let d = 0; d < this.groupIds.length; d++) if (d !== doc && this.groupIds[d] === g) out.push(d);
    return out;
  }

  serialize(): SerializedIndex {
    return {
      words: this.words,
      postingOffsets: this.postingOffsets,
      postings: this.postings,
      kinds: this.kinds,
      numbers: this.numbers,
      groupIds: this.groupIds,
      groupCount: this.groupCount,
      names: this.names,
    };
  }

  private prepare() {
    const n = this.kinds.length;
    this.matchCount = new Uint8Array(n);
    this.tokenScore = new Float32Array(n);
    this.hitDocs = new Uint32Array(n);
    this.hitScores = new Float32Array(n);
    this.groupStamp = new Int32Array(this.groupCount);
    this.stamp = 0;
    // Trigram index over the (much smaller) word list, for "inside a word" matches.
    const tri = new Map<string, number[]>();
    for (let w = 0; w < this.words.length; w++) {
      const word = this.words[w];
      if (word.length < 4) continue; // a 3-char token inside a word needs a word of 4+ chars
      let last = '';
      for (let i = 1; i + 3 <= word.length; i++) {
        const g = word.substr(i, 3);
        if (g === last) continue;
        last = g;
        let l = tri.get(g);
        if (!l) tri.set(g, (l = []));
        if (l[l.length - 1] !== w) l.push(w);
      }
    }
    this.trigrams = new Map();
    tri.forEach((l, g) => this.trigrams.set(g, Uint32Array.from(l)));
  }

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const t0 = now();
    const kinds = opts.kinds === undefined ? ALL_KINDS : opts.kinds;
    const limit = opts.limitPerKind || 300;
    const totals: Record<DocKindName, number> = { live: 0, movie: 0, series: 0, programme: 0 };
    const qnorm = normalizeText(query);
    const typed = tokenize(qnorm);
    const tokens = orderTokens(typed).slice(0, 8);
    if (!tokens.length) return { hits: [], totals, tookMs: 0 };

    const matchCount = this.matchCount;
    const tokenScore = this.tokenScore;
    const docKinds = this.kinds;
    const postings = this.postings;
    const offsets = this.postingOffsets;
    const touched: number[] = [];

    for (let ti = 0; ti < tokens.length; ti++) {
      const candidates = this.candidateWords(tokens[ti]);
      for (let c = 0; c < candidates.length; c += 2) {
        const wordIdx = candidates[c];
        const quality = candidates[c + 1];
        const end = offsets[wordIdx + 1];
        for (let p = offsets[wordIdx]; p < end; p++) {
          const d = postings[p];
          if (matchCount[d] !== ti) continue; // missed an earlier token, or already matched this one
          if (!(docKinds[d] & kinds)) continue;
          matchCount[d] = ti + 1;
          // Candidates come best quality first, so the first match is this token's best.
          if (ti === 0) {
            tokenScore[d] = quality;
            touched.push(d);
          } else {
            tokenScore[d] += quality;
          }
        }
      }
    }

    // Channel number search: "206" finds channel 206.
    const numeric = /^\d+$/.test(qnorm) ? Number(qnorm) : -1;
    if (numeric >= 0 && kinds & DocKind.live) {
      for (let d = 0; d < this.numbers.length; d++) {
        if (this.numbers[d] === numeric && matchCount[d] !== tokens.length) {
          if (matchCount[d] === 0) touched.push(d);
          matchCount[d] = tokens.length;
          tokenScore[d] = 0;
        }
      }
    }

    // Score every match; count totals with duplicates merged.
    const full = tokens.length;
    const stamp = ++this.stamp;
    let count = 0;
    for (let i = 0; i < touched.length; i++) {
      const d = touched[i];
      if (matchCount[d] === full && !(opts.exclude && opts.exclude(d))) {
        this.hitDocs[count] = d;
        this.hitScores[count] = this.finalScore(d, tokenScore[d], typed[0], qnorm, numeric) + (opts.boost ? opts.boost(d) : 0);
        count++;
        const g = this.groupIds[d];
        if (g < 0 || this.groupStamp[g] !== stamp) {
          if (g >= 0) this.groupStamp[g] = stamp;
          totals[kindName(docKinds[d])]++;
        }
      }
      matchCount[d] = 0;
      tokenScore[d] = 0;
    }

    // Only the best ones get sorted. Keep a generous margin for duplicates that merge away.
    const kindCount = bitCount(kinds & ALL_KINDS) || 1;
    const cap = limit * kindCount * 3;
    let threshold = -Infinity;
    if (count > cap) {
      const sorted = this.hitScores.slice(0, count).sort();
      threshold = sorted[count - cap];
    }
    const top: SearchHit[] = [];
    for (let i = 0; i < count; i++) {
      if (this.hitScores[i] >= threshold) top.push({ doc: this.hitDocs[i], score: this.hitScores[i] });
    }
    top.sort((a, b) => b.score - a.score || this.names[a.doc].length - this.names[b.doc].length || a.doc - b.doc);

    // Merge duplicates, then apply per-kind limits.
    const groupHit = new Map<number, SearchHit>();
    const hits: SearchHit[] = [];
    const perKind: Record<number, number> = {};
    for (const h of top) {
      const g = this.groupIds[h.doc];
      if (g >= 0) {
        const existing = groupHit.get(g);
        if (existing) {
          (existing.variants || (existing.variants = [])).push(h.doc);
          continue;
        }
        groupHit.set(g, h);
      }
      const kindBit = docKinds[h.doc];
      const c = perKind[kindBit] || 0;
      if (c < limit) {
        hits.push(h);
        perKind[kindBit] = c + 1;
      }
    }
    return { hits, totals, tookMs: now() - t0 };
  }

  /** Candidate words for one query token, best quality first, as flat [wordIndex, quality, ...]. */
  private candidateWords(t: string): number[] {
    const out: number[] = [];
    const words = this.words;
    const seen = new Set<number>();
    // Exact + prefix via binary search.
    let i = lowerBound(words, t);
    const prefixStart = i;
    if (i < words.length && words[i] === t) {
      out.push(i, Q_EXACT);
      i++;
    }
    for (; i < words.length && words[i].lastIndexOf(t, 0) === 0; i++) out.push(i, Q_PREFIX);
    const prefixEnd = i;
    const inPrefix = (w: number) => w >= prefixStart && w < prefixEnd;

    // Inside a word ("man" in "batman"), 3+ chars, through the trigram index.
    if (t.length >= 3) {
      let best: Uint32Array | undefined;
      for (let k = 0; k + 3 <= t.length; k++) {
        const l = this.trigrams.get(t.substr(k, 3));
        if (!l) {
          best = undefined;
          break;
        }
        if (!best || l.length < best.length) best = l;
      }
      if (best) {
        for (let k = 0; k < best.length; k++) {
          const w = best[k];
          if (inPrefix(w)) continue;
          if (words[w].indexOf(t, 1) > 0) {
            out.push(w, Q_INFIX);
            seen.add(w);
          }
        }
      }
    }

    // Typos: letters only (a typo in "2021" would match "2024"), 4+ chars.
    const maxEdits = /\d/.test(t) ? 0 : t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0;
    if (maxEdits) {
      // Typos rarely hit the first letter. Scan words starting with it, plus words starting
      // with the first two letters swapped; both are contiguous ranges of the sorted list.
      const ranges: Array<[number, number]> = [this.prefixRange(t[0])];
      if (t[0] !== t[1]) ranges.push(this.prefixRange(t[1] + t[0]));
      for (const [from, to] of ranges) {
        for (let w = from; w < to; w++) {
          if (inPrefix(w) || seen.has(w)) continue;
          const word = words[w];
          if (word.length < t.length - maxEdits) continue;
          // Against the whole word, then against its start (the user may still be typing).
          if (word.length <= t.length + maxEdits && boundedDistance(t, word, maxEdits) <= maxEdits) {
            out.push(w, Q_FUZZY);
          } else if (word.length > t.length && boundedDistance(t, word.slice(0, t.length), maxEdits) <= maxEdits) {
            out.push(w, Q_FUZZY * 0.9);
          }
        }
      }
    }
    return out;
  }

  private prefixRange(p: string): [number, number] {
    const from = lowerBound(this.words, p);
    const to = lowerBound(this.words, p + '￿');
    return [from, to];
  }

  private finalScore(d: number, tokenSum: number, firstTyped: string, qnorm: string, numeric: number): number {
    const name = this.names[d];
    let s = tokenSum * 10;
    if (name === qnorm) s += 100;
    else if (name.lastIndexOf(qnorm, 0) === 0) s += 45;
    else if ((' ' + name).indexOf(' ' + qnorm) >= 0) s += 25; // the query appears as a phrase
    if (name.lastIndexOf(firstTyped, 0) === 0) s += 10;
    if (numeric >= 0 && this.numbers[d] === numeric) s += 120;
    // Prefer shorter names: "CNN" before "CNN International Europe".
    s -= Math.min(20, name.length * 0.15);
    return s;
  }

  /** Normalized text of a doc (debugging and tests). */
  text(doc: number): string {
    return this.names[doc];
  }

  kindOf(doc: number): DocKindName {
    return kindName(this.kinds[doc]);
  }
}

/** Words indexed for a normalized name: words, letter/digit parts ("bbc1" -> "bbc","1"), and joined neighbours ("fox news" -> "foxnews"). */
export function indexWords(norm: string): string[] {
  const words = tokenize(norm);
  const out = words.slice();
  for (const w of words) {
    if (/\d/.test(w) && /[a-z]/.test(w)) {
      const parts = w.match(/[a-z]+|\d+/g);
      if (parts && parts.length > 1) for (const p of parts) out.push(p);
    }
  }
  for (let i = 0; i + 1 < words.length; i++) out.push(words[i] + words[i + 1]);
  return out;
}

/** Unique tokens, longest first: rarer words narrow the candidate set sooner. */
function orderTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) if (out.indexOf(t) < 0) out.push(t);
  return out.sort((a, b) => b.length - a.length);
}

function lowerBound(arr: string[], x: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bitCount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

function kindName(bit: number): DocKindName {
  return bit === 1 ? 'live' : bit === 2 ? 'movie' : bit === 4 ? 'series' : 'programme';
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
