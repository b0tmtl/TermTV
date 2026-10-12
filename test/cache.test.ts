import { parseM3U } from '@/providers/m3u';
import { CHUNK_SIZE, decode, encode, packLibrary, unpackLibrary } from '@/workers/cache-codec';

function bigLibrary(n: number) {
  let text = '#EXTM3U\n';
  for (let i = 0; i < n; i++) {
    text += `#EXTINF:-1 tvg-logo="http://img.example/p/${i}.jpg" group-title="Movies | Group ${i % 300}",Movie number ${i} (20${10 + (i % 15)})\nhttp://iptv.example/movie/u/p/${i}.mkv\n`;
  }
  text += '#EXTINF:-1 tvg-id="cnn.us" group-title="US | News",CNN\nhttp://iptv.example/live/1.ts\n';
  text += '#EXTINF:-1 group-title="Series | Drama",Breaking Bad S01E01\nhttp://iptv.example/series/99.mp4\n';
  const lib = parseM3U('src1', text);
  return { sourceId: 'src1', updatedAt: 1, ...lib };
}

describe('cache codec', () => {
  it('round-trips a library exactly', () => {
    const lib = bigLibrary(500);
    const back = unpackLibrary<typeof lib>(decode(encode(packLibrary(lib))));
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x));
    const sortCats = (l: typeof lib) => ({ ...norm(l), categories: norm(l.categories).sort((a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1)) });
    expect(sortCats(back)).toEqual(sortCats(lib));
  });

  it('keeps foreign keys untouched', () => {
    const lib = bigLibrary(3);
    lib.movies[0].categoryKey = 'other:movie:x';
    const back = unpackLibrary<typeof lib>(decode(encode(packLibrary(lib))));
    expect(back.movies[0].categoryKey).toBe('other:movie:x');
    expect(back.movies[1].key).toBe(lib.movies[1].key);
  });

  it('is small and split into chunks', () => {
    const lib = bigLibrary(100000);
    const raw = JSON.stringify(lib).length;
    const chunks = encode(packLibrary(lib));
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    expect(bytes).toBeLessThan(raw / 8);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
    console.log(`100k titles: ${(raw / 1e6).toFixed(1)} MB JSON -> ${(bytes / 1e6).toFixed(2)} MB in ${chunks.length} chunks`);
  });
});

describe('cache codec compatibility', () => {
  it('still reads rows saved as objects (0.1.7 - 0.1.10)', () => {
    const lib = bigLibrary(20);
    const packed = packLibrary(lib) as Record<string, any>;
    const fromCols = (c: { f: string[]; r: unknown[][] }) =>
      c.r.map((a) => Object.fromEntries(a.map((v, i) => [c.f[i], v]).filter(([, v]) => v !== null)));
    const old: Record<string, any> = { ...packed, live: fromCols(packed.live), movies: fromCols(packed.movies), series: fromCols(packed.series) };
    old.cats = { live: fromCols(packed.cats.live), movie: fromCols(packed.cats.movie), series: fromCols(packed.cats.series) };
    const back = unpackLibrary<typeof lib>(decode(encode(old)));
    expect(JSON.parse(JSON.stringify(back.movies))).toEqual(JSON.parse(JSON.stringify(lib.movies)));
  });
});
