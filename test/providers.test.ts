import { M3UParser, classifyEntry, parseEpisodeName, parseM3U } from '@/providers/m3u';
import { XmltvParser, parseXmltvDate } from '@/providers/xmltv';
import { XtreamClient, decodeBase64Text, normalizeServer, xtreamFromUrl } from '@/providers/xtream';
import type { Programme } from '@/core/models';

const PLAYLIST = `#EXTM3U url-tvg="http://epg.example/guide.xml.gz" x-tvg-url="http://epg2.example/e.xml"
#EXTINF:-1 tvg-id="cnn.us" tvg-name="CNN" tvg-logo="http://logo/cnn.png" group-title="US | News" tvg-chno="206",US | CNN HD
http://iptv.example/live/u/p/1.ts
#EXTINF:-1 tvg-id="tf1.fr" group-title="FR | Général",TF1, la une
http://iptv.example/live/u/p/2.m3u8
#EXTINF:-1 tvg-logo="http://img/dune.jpg" group-title="Movies | Sci-Fi",Dune (2021)
http://iptv.example/movie/u/p/10.mkv
#EXTINF:-1 group-title="Series | Drama",Breaking Bad S01 E02 Cat's in the Bag
http://iptv.example/series/u/p/100.mp4
#EXTINF:-1 group-title="Series | Drama",Breaking Bad S01E01
http://iptv.example/series/u/p/99.mp4
#EXTINF:-1,No group channel
#EXTVLCOPT:http-user-agent=Foo
http://other.example/stream
`;

describe('M3U', () => {
  it('parses and classifies a playlist', () => {
    const lib = parseM3U('src', PLAYLIST);
    expect(lib.epgUrls).toEqual(['http://epg.example/guide.xml.gz', 'http://epg2.example/e.xml']);
    expect(lib.live.map((c) => c.name)).toEqual(['US | CNN HD', 'TF1, la une', 'No group channel']);
    expect(lib.live[0]).toMatchObject({ epgId: 'cnn.us', number: 206, image: 'http://logo/cnn.png' });
    expect(lib.movies.map((m) => [m.name, m.year])).toEqual([['Dune (2021)', 2021]]);
    expect(lib.series).toHaveLength(1);
    const eps = lib.episodes[lib.series[0].key];
    expect(eps.map((e) => [e.season, e.episode])).toEqual([[1, 1], [1, 2]]);
    expect(eps[1].title).toBe("Cat's in the Bag");
    expect(lib.categories.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'live:US | News', 'live:FR | Général', 'movie:Movies | Sci-Fi', 'series:Series | Drama', 'live:Uncategorized',
    ]);
    for (const ch of lib.live) expect(lib.categories.some((c) => c.key === ch.categoryKey)).toBe(true);
  });

  it('handles chunk boundaries anywhere', () => {
    const names: string[] = [];
    const p = new M3UParser((e) => names.push(e.name));
    for (let i = 0; i < PLAYLIST.length; i += 7) p.push(PLAYLIST.slice(i, i + 7));
    p.end();
    expect(names).toHaveLength(6);
  });

  it('parses episode names', () => {
    expect(parseEpisodeName('The Office (US) S03E10 - A Benihana Christmas')).toEqual({ series: 'The Office (US)', season: 3, episode: 10, title: 'A Benihana Christmas' });
    expect(parseEpisodeName('Friends 2x05')).toMatchObject({ series: 'Friends', season: 2, episode: 5 });
    expect(parseEpisodeName('CNN HD')).toBeNull();
  });

  it('classifies by url and extension', () => {
    expect(classifyEntry({ name: 'x', url: 'http://a/b.ts', attrs: {}, duration: -1, group: '' })).toBe('live');
    expect(classifyEntry({ name: 'x', url: 'http://a/b.mp4', attrs: {}, duration: -1, group: '' })).toBe('movie');
  });
});

const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="cnn.us"><display-name>CNN</display-name><icon src="http://logo/cnn.png"/></channel>
  <channel id="empty.ch"/>
  <programme start="20240101100000 +0000" stop="20240101110000 +0000" channel="cnn.us">
    <title lang="en">News &amp; Views</title><desc>Daily news.</desc><category>News</category>
  </programme>
  <programme start="20240101110000 +0100" stop="20240101120000 +0100" channel="cnn.us"><title><![CDATA[Late <Show>]]></title></programme>
  <programme start="20230101110000 +0000" stop="20230101120000 +0000" channel="cnn.us"><title>Old</title></programme>
</tv>`;

describe('XMLTV', () => {
  it('parses dates with offsets', () => {
    expect(parseXmltvDate('20240101120000 +0100')).toBe(Date.UTC(2024, 0, 1, 11));
    expect(parseXmltvDate('20240101120000 -0130')).toBe(Date.UTC(2024, 0, 1, 13, 30));
    expect(parseXmltvDate('20240101120000')).toBe(Date.UTC(2024, 0, 1, 12));
  });

  it('streams programmes in a time window, across chunk boundaries', () => {
    for (const step of [1, 13, 100000]) {
      const progs: Programme[] = [];
      const chans: string[] = [];
      const p = new XmltvParser({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 0, 2) }, (x) => progs.push(x), (c) => chans.push(c.id));
      for (let i = 0; i < XMLTV.length; i += step) p.push(XMLTV.slice(i, i + step));
      p.end();
      expect(chans).toEqual(['cnn.us', 'empty.ch']);
      expect(progs.map((x) => x.title)).toEqual(['News & Views', 'Late <Show>']);
      expect(progs[0]).toMatchObject({ desc: 'Daily news.', category: 'News', start: Date.UTC(2024, 0, 1, 10) });
    }
  });
});

describe('Xtream', () => {
  it('normalizes server input', () => {
    expect(normalizeServer('provider.tv:8080')).toBe('http://provider.tv:8080');
    expect(normalizeServer('http://provider.tv:8080/player_api.php')).toBe('http://provider.tv:8080');
    expect(normalizeServer('https://provider.tv/')).toBe('https://provider.tv');
  });

  it('detects credentials in a pasted m3u link', () => {
    expect(xtreamFromUrl('http://host:8080/get.php?username=bob&password=s%3Acret&type=m3u_plus&output=ts')).toEqual({
      type: 'xtream', server: 'http://host:8080', username: 'bob', password: 's:cret',
    });
    expect(xtreamFromUrl('http://host/playlist.m3u')).toBeNull();
  });

  it('decodes base64 EPG text', () => {
    expect(decodeBase64Text(btoa('Hello'))).toBe('Hello');
    expect(decodeBase64Text('Plain text!')).toBe('Plain text!');
    expect(decodeBase64Text(btoa(unescape(encodeURIComponent('Été'))))).toBe('Été');
  });

  it('maps the library', async () => {
    const responses: Record<string, unknown> = {
      get_live_categories: [{ category_id: '1', category_name: 'US | News' }],
      get_vod_categories: [{ category_id: '5', category_name: 'Action' }],
      get_series_categories: [],
      get_live_streams: [{ num: 1, name: 'CNN', stream_id: 11, category_id: '1', epg_channel_id: 'cnn.us', added: '1700000000', tv_archive: 1 }],
      get_vod_streams: [{ name: 'Dune (2021)', stream_id: 22, category_id: '9', container_extension: 'mkv', rating_5based: 4 }],
      get_series: [{ name: 'Breaking Bad', series_id: 33, category_id: null, cover: 'c.jpg', releaseDate: '2008-01-20' }],
    };
    const client = new XtreamClient({ type: 'xtream', server: 'http://h:80', username: 'u', password: 'p' }, async <T,>(url: string) => {
      const action = /action=([a-z_]+)/.exec(url)![1];
      return responses[action] as T;
    });
    const lib = await client.loadLibrary('s');
    expect(lib.live[0]).toMatchObject({ key: 's:live:11', number: 1, epgId: 'cnn.us', archive: true, added: 1700000000000 });
    expect(lib.movies[0]).toMatchObject({ ext: 'mkv', rating: 8, year: 2021, categoryKey: 's:movie:9' });
    expect(lib.series[0]).toMatchObject({ year: 2008, categoryKey: 's:series:none' });
    // Unknown categories are created so nothing is orphaned.
    expect(lib.categories.map((c) => c.key)).toEqual(['s:live:1', 's:movie:5', 's:movie:9', 's:series:none']);
    expect(client.liveUrl(lib.live[0])).toBe('http://h:80/live/u/p/11.ts');
    expect(client.movieUrl(lib.movies[0])).toBe('http://h:80/movie/u/p/22.mkv');
  });
});
