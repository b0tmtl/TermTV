import { DocKind, SearchIndex, type SearchDocInput } from '@/core/search/engine';
import { boundedDistance } from '@/core/search/distance';
import { dedupeKey } from '@/core/normalize';

const docs: SearchDocInput[] = [
  { kind: 'live', text: 'US | CNN HD', number: 206 },
  { kind: 'live', text: 'US | CNN International', number: 207 },
  { kind: 'live', text: 'US | FOX NEWS ᴴᴰ', number: 300 },
  { kind: 'live', text: 'UK: BBC1 FHD', number: 101 },
  { kind: 'live', text: '|FR| TF1', number: 1 },
  { kind: 'live', text: 'CA | TSN 4', number: 44 },
  { kind: 'live', text: 'US | A&E', number: 50 },
  { kind: 'movie', text: 'Dune (2021)', group: dedupeKey('Dune (2021)') },
  { kind: 'movie', text: '4K | Dune [UHD] (2021)', group: dedupeKey('4K | Dune [UHD] (2021)') },
  { kind: 'movie', text: 'Dune: Part Two (2024)', group: dedupeKey('Dune: Part Two (2024)') },
  { kind: 'movie', text: 'The Batman (2022)', group: dedupeKey('The Batman (2022)') },
  { kind: 'movie', text: 'Spider-Man: No Way Home (2021)', group: dedupeKey('Spider-Man: No Way Home (2021)') },
  { kind: 'movie', text: 'Amélie (2001)', group: dedupeKey('Amélie (2001)') },
  { kind: 'series', text: 'Breaking Bad', group: dedupeKey('Breaking Bad') },
  { kind: 'series', text: 'Law & Order: Special Victims Unit', group: dedupeKey('Law & Order: Special Victims Unit') },
  { kind: 'series', text: "Grey's Anatomy", group: dedupeKey("Grey's Anatomy") },
  { kind: 'series', text: 'Batman: The Animated Series', group: dedupeKey('Batman: The Animated Series') },
];

const idx = SearchIndex.build(docs);
const names = (q: string, kinds?: number) => idx.search(q, { kinds }).hits.map((h) => docs[h.doc].text);

describe('search engine', () => {
  it('matches word prefixes while typing', () => {
    expect(names('brea')).toEqual(['Breaking Bad']);
    expect(names('brea bad')).toEqual(['Breaking Bad']);
  });
  it('ignores word order', () => {
    expect(names('news fox')[0]).toBe('US | FOX NEWS ᴴᴰ');
  });
  it('tolerates typos', () => {
    expect(names('braking')).toContain('Breaking Bad');
    expect(names('brakeing bad')).toContain('Breaking Bad');
    expect(names('anatmy')).toContain("Grey's Anatomy");
  });
  it('ignores accents and punctuation', () => {
    expect(names('amelie')).toEqual(['Amélie (2001)']);
    expect(names('greys')).toEqual(["Grey's Anatomy"]);
    expect(names('spiderman')).toContain('Spider-Man: No Way Home (2021)');
    expect(names('spider man')).toContain('Spider-Man: No Way Home (2021)');
    expect(names('law & order')).toContain('Law & Order: Special Victims Unit');
    expect(names('a&e')).toEqual(['US | A&E']);
  });
  it('finds words joined or split', () => {
    expect(names('foxnews')[0]).toBe('US | FOX NEWS ᴴᴰ');
    expect(names('bbc 1')[0]).toBe('UK: BBC1 FHD');
    expect(names('bbc1')[0]).toBe('UK: BBC1 FHD');
  });
  it('finds text inside words', () => {
    expect(names('batman')).toEqual(expect.arrayContaining(['The Batman (2022)', 'Batman: The Animated Series']));
  });
  it('ranks the exact / shortest match first', () => {
    expect(names('cnn')[0]).toBe('US | CNN HD');
    expect(names('dune')[0]).toBe('Dune (2021)');
  });
  it('merges duplicate versions', () => {
    const r = idx.search('dune 2021');
    const hit = r.hits.find((h) => docs[h.doc].text.indexOf('Part Two') < 0)!;
    expect(hit.variants).toHaveLength(1);
    expect(r.totals.movie).toBe(1);
  });
  it('filters by scope', () => {
    expect(names('batman', DocKind.series)).toEqual(['Batman: The Animated Series']);
    expect(names('batman', DocKind.movie)).toEqual(['The Batman (2022)']);
    expect(names('cnn', DocKind.movie | DocKind.series)).toEqual([]);
  });
  it('finds channels by number', () => {
    expect(names('206')[0]).toBe('US | CNN HD');
  });
  it('honours exclusions and boosts', () => {
    const cnn = docs.findIndex((d) => d.text === 'US | CNN HD');
    expect(idx.search('cnn', { exclude: (d) => d === cnn }).hits.map((h) => h.doc)).not.toContain(cnn);
    const intl = docs.findIndex((d) => d.text === 'US | CNN International');
    expect(idx.search('cnn', { boost: (d) => (d === intl ? 100 : 0) }).hits[0].doc).toBe(intl);
  });
  it('returns nothing for an empty query', () => {
    expect(names('   ')).toEqual([]);
  });
  it('can be serialized and restored', () => {
    const copy = SearchIndex.fromSerialized(idx.serialize());
    expect(copy.search('brea').hits.map((h) => h.doc)).toEqual(idx.search('brea').hits.map((h) => h.doc));
  });
});

describe('boundedDistance', () => {
  it('computes edits including swaps', () => {
    expect(boundedDistance('kitten', 'sitting', 3)).toBe(3);
    expect(boundedDistance('braeking', 'breaking', 2)).toBe(1);
    expect(boundedDistance('abc', 'xyzabc', 1)).toBe(2);
  });
});

describe('search performance', () => {
  it('queries 150k items quickly', () => {
    const words = ['news', 'sport', 'movie', 'kids', 'world', 'live', 'premier', 'league', 'football', 'drama', 'action', 'comedy', 'night', 'star', 'city', 'love', 'war', 'dark', 'king', 'house'];
    const big: SearchDocInput[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 150000; i++) {
      const n = 2 + Math.floor(rnd() * 3);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) parts.push(words[Math.floor(rnd() * words.length)] + (rnd() < 0.3 ? Math.floor(rnd() * 500) : ''));
      big.push({ kind: i % 3 === 0 ? 'live' : i % 3 === 1 ? 'movie' : 'series', text: parts.join(' ') });
    }
    const t0 = Date.now();
    const bigIdx = SearchIndex.build(big);
    const buildMs = Date.now() - t0;
    const times = ['p', 'pr', 'pre', 'prem', 'premi', 'premier l', 'premier leag', 'footbal', 'fotball', 'xyzzy'].map((q) => bigIdx.search(q).tookMs);
    // eslint-disable-next-line no-console
    console.log(`build ${buildMs}ms, query max ${Math.max(...times).toFixed(1)}ms`, times.map((t) => t.toFixed(1)).join(' '));
    // Desktop budget; a 2018 TV is roughly 5-10x slower.
    expect(Math.max(...times)).toBeLessThan(60);
  });
});
