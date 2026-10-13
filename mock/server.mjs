// Mock IPTV provider for development and testing. No real content: everything is generated.
//
//   npm run mock                      -> http://localhost:8090  (user: demo / pass: demo)
//   MOCK_SCALE=big npm run mock       -> ~20k channels, ~80k movies, ~10k series (performance testing)
//
// Endpoints (Xtream Codes compatible):
//   /player_api.php?username&password[&action=...]
//   /xmltv.php?username&password                 guide for every channel (now -2h .. +26h)
//   /get.php?username&password&type=m3u_plus     the same library as an M3U playlist
//   /playlist.m3u                                plain M3U with series episodes (S01E01) and a WebM live channel
//   /live|movie|series/<user>/<pass>/<id>.<ext>  test media generated with ffmpeg on first run
// Reachable from a TV on the same network: use http://<this-computer-ip>:8090 as the server.

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 8090);
const USER = 'demo';
const PASS = 'demo';
const BIG = process.env.MOCK_SCALE === 'big';

// ---------------------------------------------------------------------------------------------
// Deterministic data
let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];

const LIVE_GROUPS = {
  US: ['News', 'Sports', 'Entertainment', 'Kids', 'Movies', 'Documentary', 'Music', 'Local'],
  UK: ['News', 'Sports', 'Entertainment', 'Kids'],
  CA: ['News', 'Sports', 'Général', 'Jeunesse'],
  FR: ['Général', 'Sport', 'Cinéma', 'Info'],
  AR: ['News', 'Sports', 'Drama', 'Kids'],
  DE: ['Allgemein', 'Sport'],
  ES: ['General', 'Deportes'],
};
const CHANNEL_NAMES = {
  News: ['CNN', 'Fox News', 'MSNBC', 'CNBC', 'BBC News', 'Sky News', 'Bloomberg', 'Euronews', 'NewsNation', 'CBC News', 'Al Jazeera', 'France 24'],
  Sports: ['ESPN', 'ESPN 2', 'FS1', 'TSN 1', 'TSN 4', 'Sportsnet One', 'beIN Sports 1', 'Sky Sports Main Event', 'NBA TV', 'NFL Network', 'DAZN 1', 'Eurosport 1'],
  Entertainment: ['AMC', 'FX', 'TNT', 'TBS', 'A&E', 'Bravo', 'E!', 'USA Network', 'Comedy Central', 'Paramount Network'],
  Kids: ['Nickelodeon', 'Cartoon Network', 'Disney Channel', 'Disney Junior', 'Boomerang', 'PBS Kids', 'Treehouse'],
  Movies: ['HBO', 'Showtime', 'Starz', 'TCM', 'Cinemax', 'MGM+', 'Hallmark Movies'],
  Documentary: ['Discovery', 'National Geographic', 'History', 'Smithsonian', 'Animal Planet'],
  Music: ['MTV', 'VH1', 'CMT', 'MTV Live'],
  Local: ['ABC 7', 'NBC 4', 'CBS 2', 'FOX 5', 'PBS 13'],
  Général: ['TF1', 'France 2', 'France 3', 'M6', 'TVA', 'Radio-Canada', 'Noovo'],
  Sport: ['RMC Sport 1', 'L\'Équipe', 'Canal+ Sport', 'RDS', 'TVA Sports'],
  Cinéma: ['Canal+ Cinéma', 'OCS Max', 'Ciné+ Premier', 'Super Écran'],
  Info: ['BFM TV', 'LCI', 'franceinfo', 'RDI', 'LCN'],
  Jeunesse: ['Télétoon', 'Gulli', 'Vrak', 'Yoopa'],
  Drama: ['MBC 1', 'MBC Drama', 'Rotana Drama', 'OSN Yahala'],
  Allgemein: ['Das Erste', 'ZDF', 'RTL', 'ProSieben', 'Sat.1'],
  General: ['La 1', 'Antena 3', 'Telecinco', 'Cuatro'],
  Deportes: ['Movistar LaLiga', 'DAZN LaLiga', 'Teledeporte'],
};
const QUALITY = ['', ' HD', ' FHD', ' ᴴᴰ', ' 4K', ' HEVC'];
const SHOWS = {
  News: ['Morning Report', 'World News Tonight', 'The Situation Room', 'Market Watch', 'Evening Edition', 'Newsroom Live', 'Global Update'],
  // Realistic match titles (EN / FR, separators "vs", "v", "@", "-", "contre"), so the Sports
  // section can find, classify and group them; plus studio shows it must leave out.
  Sports: [
    'NHL: Canadiens vs Maple Leafs', 'Premier League: Arsenal v Chelsea', 'SportsCenter', 'NBA Basketball: Lakers @ Celtics',
    'LNH : Canadiens contre Maple Leafs', 'Ligue 1: PSG - Marseille', 'NHL Highlights', 'NFL Football: Bills vs Chiefs',
    'MLB: Blue Jays at Yankees', 'UFC Fight Night: Pantoja vs Asakura', 'Formula 1: Grand Prix du Mexique', 'Roland-Garros: Alcaraz vs Sinner',
  ],
  Kids: ['Paw Patrol', 'SpongeBob SquarePants', 'Bluey', 'Peppa Pig', 'Teen Titans Go!', 'The Loud House'],
  default: ['The Big Bang Theory', 'Friends', 'Seinfeld', 'Law & Order: SVU', 'Chicago Fire', 'Movie: The Matrix', 'Documentary: Planet Earth', 'Late Night Show', 'Cooking With Love', 'House Hunters', 'Pawn Stars'],
};
const MOVIE_GROUPS = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Horror', 'Kids & Family', 'Documentary', '4K | Movies', 'FR | Films', 'Netflix Movies', 'New Releases'];
const MOVIE_TITLES = [
  'Dune', 'Dune: Part Two', 'The Batman', 'Spider-Man: No Way Home', 'Oppenheimer', 'Barbie', 'Top Gun: Maverick', 'Avatar: The Way of Water',
  'Everything Everywhere All at Once', 'The Matrix', 'Inception', 'Interstellar', 'Amélie', 'Parasite', 'Joker', 'Gladiator', 'The Godfather',
  'Pulp Fiction', 'Blade Runner 2049', 'Mad Max: Fury Road', 'John Wick', 'Knives Out', 'Arrival', 'La La Land', 'Whiplash', 'Coco', 'Up',
  'Inside Out', 'Toy Story', 'Finding Nemo', 'The Lion King', 'Frozen', 'Encanto', 'Moana', 'Ratatouille', 'WALL-E', 'Shrek', 'Paddington 2',
  'Night of the Living Dead', 'Nosferatu', 'Metropolis', 'The General', 'His Girl Friday', 'Charade', 'Le Fabuleux Destin', 'Intouchables',
];
const SERIES_GROUPS = ['Drama Series', 'Comedy Series', 'Crime', 'Sci-Fi & Fantasy', 'Kids Series', 'Documentary Series', 'FR | Séries', 'Netflix Series'];
const SERIES_TITLES = [
  'Breaking Bad', 'Better Call Saul', 'The Office (US)', 'Friends', 'Seinfeld', 'Stranger Things', 'The Crown', 'Succession', 'The Bear', 'Severance',
  'Law & Order: Special Victims Unit', "Grey's Anatomy", 'Chicago Fire', 'The Mandalorian', 'House of the Dragon', 'Ted Lasso', 'The Last of Us',
  'Batman: The Animated Series', 'Bluey', 'Avatar: The Last Airbender', 'Planet Earth', 'Dix pour cent', 'Lupin', 'Le Bureau des Légendes',
];

function buildLibrary() {
  const liveCats = [];
  const live = [];
  let catId = 1;
  let streamId = 1000;
  const mult = BIG ? 60 : 1;
  for (const prefix of Object.keys(LIVE_GROUPS)) {
    for (const g of LIVE_GROUPS[prefix]) {
      const cat = { category_id: String(catId++), category_name: `${prefix} | ${g}`, parent_id: 0 };
      liveCats.push(cat);
      const names = CHANNEL_NAMES[g] || CHANNEL_NAMES.Entertainment;
      for (let r = 0; r < mult; r++) {
        for (const n of names) {
          const q = pick(QUALITY);
          const name = `${prefix} | ${n}${q}${r ? ' ' + (r + 1) : ''}`;
          live.push({
            num: live.length + 1, name, stream_type: 'live', stream_id: streamId++, stream_icon: `/logo/${encodeURIComponent(n)}.svg`,
            epg_channel_id: `${n.toLowerCase().replace(/[^a-z0-9]+/g, '')}.${prefix.toLowerCase()}`, added: String(1700000000 + live.length * 3600),
            category_id: cat.category_id, tv_archive: rnd() < 0.2 ? 1 : 0, _group: g,
          });
        }
      }
    }
  }
  liveCats.push({ category_id: String(catId++), category_name: 'PPV Events', parent_id: 0 });
  for (let i = 1; i <= 6; i++) {
    live.push({ num: live.length + 1, name: `PPV ${i}: UFC Fight Night`, stream_id: streamId++, stream_icon: '', epg_channel_id: '', added: '1700000000', category_id: liveCats[liveCats.length - 1].category_id, _group: 'Sports' });
  }

  const vodCats = MOVIE_GROUPS.map((n) => ({ category_id: String(catId++), category_name: n, parent_id: 0 }));
  const vod = [];
  const movieCount = BIG ? 80000 : 400;
  for (let i = 0; i < movieCount; i++) {
    const base = MOVIE_TITLES[i % MOVIE_TITLES.length];
    const year = 1960 + Math.floor(rnd() * 64);
    const round = Math.floor(i / MOVIE_TITLES.length);
    const title = round ? `${base} ${round + 1}` : base;
    const cat = vodCats[i % vodCats.length];
    const fourK = cat.category_name.indexOf('4K') === 0;
    vod.push({
      num: i + 1, name: `${fourK ? '4K | ' : ''}${title} (${year})`, stream_type: 'movie', stream_id: 50000 + i,
      stream_icon: `/poster/${encodeURIComponent(title)}.svg`, rating: (5 + rnd() * 5).toFixed(1), rating_5based: (2.5 + rnd() * 2.5).toFixed(1),
      added: String(1700000000 + i * 1800), category_id: cat.category_id, container_extension: 'webm',
    });
  }

  const seriesCats = SERIES_GROUPS.map((n) => ({ category_id: String(catId++), category_name: n, parent_id: 0 }));
  const series = [];
  const seriesCount = BIG ? 10000 : 80;
  for (let i = 0; i < seriesCount; i++) {
    const base = SERIES_TITLES[i % SERIES_TITLES.length];
    const round = Math.floor(i / SERIES_TITLES.length);
    const title = round ? `${base} ${round + 1}` : base;
    series.push({
      num: i + 1, name: title, series_id: 90000 + i, cover: `/poster/${encodeURIComponent(title)}.svg`,
      plot: `${title} is a test series generated by the TermTV mock server.`, cast: 'Jane Doe, John Smith', director: 'A. Director',
      genre: SERIES_GROUPS[i % SERIES_GROUPS.length], releaseDate: `${1990 + (i % 34)}-01-01`, last_modified: String(1700000000 + i * 7200),
      rating: (6 + rnd() * 4).toFixed(1), rating_5based: (3 + rnd() * 2).toFixed(1), category_id: seriesCats[i % seriesCats.length].category_id,
      _seasons: 1 + (i % 4),
    });
  }
  return { liveCats, live, vodCats, vod, seriesCats, series };
}

const lib = buildLibrary();
// Drops internal fields and makes image URLs absolute, like a real provider.
let currentHost = 'localhost';
const strip = (o) => {
  const c = { ...o };
  for (const k of Object.keys(c)) if (k[0] === '_') delete c[k];
  for (const k of ['stream_icon', 'cover']) if (c[k] && c[k][0] === '/') c[k] = `http://${currentHost}${c[k]}`;
  return c;
};

// Guide: deterministic per channel, 30/60/90 minute slots from now-2h to now+26h.
function programmesFor(ch, from, to) {
  if (!ch.epg_channel_id) return [];
  let s = 0;
  for (const c of ch.epg_channel_id) s = (s * 31 + c.charCodeAt(0)) % 100000;
  const shows = SHOWS[ch._group] || SHOWS.default;
  const slot = 30 * 60000;
  const out = [];
  let t = Math.floor(from / slot) * slot - (s % 3) * slot;
  let i = s;
  while (t < to) {
    const len = slot * (1 + (i % 3));
    out.push({ start: t, end: t + len, title: shows[i % shows.length], desc: `${shows[i % shows.length]} on ${ch.name.replace(/^\w+ \| /, '')}. Episode ${1 + (i % 20)}.`, category: ch._group });
    t += len;
    i = (i * 7 + 3) % 9973;
  }
  return out;
}

function xmltvDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function* xmltv() {
  const now = Date.now();
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="termtv-mock">\n';
  const seen = new Set();
  for (const ch of lib.live) {
    if (!ch.epg_channel_id || seen.has(ch.epg_channel_id)) continue;
    seen.add(ch.epg_channel_id);
    yield `  <channel id="${esc(ch.epg_channel_id)}"><display-name>${esc(ch.name.replace(/^\w+ \| /, ''))}</display-name></channel>\n`;
  }
  seen.clear();
  for (const ch of lib.live) {
    if (!ch.epg_channel_id || seen.has(ch.epg_channel_id)) continue;
    seen.add(ch.epg_channel_id);
    let chunk = '';
    for (const p of programmesFor(ch, now - 2 * 3600000, now + 26 * 3600000)) {
      chunk += `  <programme start="${xmltvDate(p.start)}" stop="${xmltvDate(p.end)}" channel="${esc(ch.epg_channel_id)}"><title lang="en">${esc(p.title)}</title><desc>${esc(p.desc)}</desc><category>${esc(p.category)}</category></programme>\n`;
    }
    yield chunk;
  }
  yield '</tv>\n';
}

function m3u(host, plain) {
  const lines = [`#EXTM3U url-tvg="http://${host}/xmltv.php?username=${USER}&password=${PASS}"`];
  const catName = (list, id) => (list.find((c) => c.category_id === id) || { category_name: 'Other' }).category_name;
  for (const ch of lib.live) {
    lines.push(`#EXTINF:-1 tvg-id="${ch.epg_channel_id}" tvg-name="${ch.name}" tvg-logo="http://${host}${ch.stream_icon}" tvg-chno="${ch.num}" group-title="${catName(lib.liveCats, ch.category_id)}",${ch.name}`);
    lines.push(`http://${host}/live/${USER}/${PASS}/${ch.stream_id}.ts`);
  }
  if (plain) {
    lines.push(`#EXTINF:-1 tvg-id="" tvg-logo="" group-title="Test",Test Pattern (WebM)`);
    lines.push(`http://${host}/media/sample.webm`);
  }
  for (const m of lib.vod.slice(0, plain ? 200 : lib.vod.length)) {
    lines.push(`#EXTINF:-1 tvg-logo="http://${host}${m.stream_icon}" group-title="${catName(lib.vodCats, m.category_id)}",${m.name}`);
    lines.push(`http://${host}/movie/${USER}/${PASS}/${m.stream_id}.webm`);
  }
  for (const s of lib.series.slice(0, plain ? 20 : lib.series.length)) {
    for (let season = 1; season <= s._seasons; season++) {
      for (let e = 1; e <= 6; e++) {
        lines.push(`#EXTINF:-1 tvg-logo="http://${host}${s.cover}" group-title="${catName(lib.seriesCats, s.category_id)}",${s.name} S${String(season).padStart(2, '0')}E${String(e).padStart(2, '0')}`);
        lines.push(`http://${host}/series/${USER}/${PASS}/${s.series_id * 100 + season * 10 + e}.webm`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Media (generated once with ffmpeg)
const mediaDir = join(here, 'media');
function ensureMedia() {
  mkdirSync(mediaDir, { recursive: true });
  const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  const webm = join(mediaDir, 'sample.webm');
  if (!existsSync(webm)) {
    console.log('Generating test media (one time)…');
    // VP8 + Vorbis plays in every desktop Chromium build (no proprietary codecs needed).
    run(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '120',
      '-c:v', 'libvpx', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '64k', webm]);
  }
  const ts = join(mediaDir, 'sample.ts');
  if (!existsSync(ts)) {
    // H.264 + AAC in MPEG-TS: what IPTV live channels look like (plays on the TV).
    run(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '60',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '50', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', ts]);
  }
  const vtt = join(mediaDir, 'sample.vtt');
  if (!existsSync(vtt)) {
    let s = 'WEBVTT\n\n';
    for (let i = 0; i < 60; i++) s += `00:${String(Math.floor(i * 2 / 60)).padStart(2, '0')}:${String((i * 2) % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i * 2 + 1.5) / 60)).padStart(2, '0')}:${String(Math.floor((i * 2 + 1.5) % 60)).padStart(2, '0')}.500\nSubtitle line ${i + 1}\n\n`;
    writeFileSync(vtt, s);
  }
}

function sendFile(req, res, path, type) {
  const size = statSync(path).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(path).pipe(res);
  }
}

function svg(text, w, h, hue) {
  const lines = String(text).split(/(?<=^.{0,14})\s|:\s/).slice(0, 3);
  const tspans = lines.map((l, i) => `<tspan x="50%" dy="${i ? '1.2em' : 0}">${esc(l)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,32%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,14%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="${h / 2 - (lines.length - 1) * 14}" fill="#fff" font-family="monospace" font-weight="bold" font-size="${w > 300 ? 34 : 24}" text-anchor="middle">${tspans}</text></svg>`;
}
const hueOf = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

// ---------------------------------------------------------------------------------------------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function api(q, res, host) {
  if (q.get('username') !== USER || q.get('password') !== PASS) return json(res, { user_info: { auth: 0 } });
  const action = q.get('action');
  const now = Date.now();
  switch (action) {
    case null:
    case '':
      return json(res, {
        user_info: { username: USER, password: PASS, auth: 1, status: 'Active', exp_date: String(Math.floor(now / 1000) + 86400 * 90), is_trial: '0', active_cons: '0', max_connections: '2' },
        server_info: { url: host.split(':')[0], port: String(PORT), server_protocol: 'http', timezone: 'UTC', timestamp_now: Math.floor(now / 1000) },
      });
    case 'get_live_categories': return json(res, lib.liveCats);
    case 'get_vod_categories': return json(res, lib.vodCats);
    case 'get_series_categories': return json(res, lib.seriesCats);
    case 'get_live_streams': return json(res, lib.live.map(strip));
    case 'get_vod_streams': return json(res, lib.vod.map(strip));
    case 'get_series': return json(res, lib.series.map(strip));
    case 'get_vod_info': {
      const m = lib.vod.find((x) => String(x.stream_id) === q.get('vod_id'));
      if (!m) return json(res, {});
      return json(res, {
        info: { plot: `${m.name} — a test movie from the TermTV mock server. The picture is a test pattern.`, cast: 'Jane Doe, John Smith, Alex Martin', director: 'A. Director', genre: 'Test', duration_secs: 120, rating: m.rating, releasedate: (/(\d{4})/.exec(m.name) || ['', '2020'])[1] + '-06-01', backdrop_path: [`http://${host}/poster/${encodeURIComponent(m.name)}.svg?w=1280`] },
        movie_data: { stream_id: m.stream_id, container_extension: 'webm' },
      });
    }
    case 'get_series_info': {
      const s = lib.series.find((x) => String(x.series_id) === q.get('series_id'));
      if (!s) return json(res, {});
      const episodes = {};
      for (let season = 1; season <= s._seasons; season++) {
        episodes[season] = [];
        for (let e = 1; e <= 6 + season; e++) {
          episodes[season].push({ id: String(s.series_id * 100 + season * 10 + e), episode_num: e, title: `${s.name} - S${season}E${e} - Episode ${e}`, container_extension: 'webm', season, info: { plot: `Episode ${e} of season ${season}.`, duration_secs: 120 } });
        }
      }
      return json(res, { info: strip(s), seasons: Object.keys(episodes).map((n) => ({ season_number: Number(n) })), episodes });
    }
    case 'get_short_epg': {
      const ch = lib.live.find((x) => String(x.stream_id) === q.get('stream_id'));
      const list = ch ? programmesFor(ch, now - 3600000, now + 12 * 3600000).slice(0, Number(q.get('limit') || 4)) : [];
      return json(res, {
        epg_listings: list.map((p) => ({ title: b64(p.title), description: b64(p.desc), start_timestamp: String(p.start / 1000), stop_timestamp: String(p.end / 1000) })),
      });
    }
    default:
      return json(res, []);
  }
}

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

ensureMedia();

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  const host = req.headers.host || `localhost:${PORT}`;
  const p = url.pathname;
  currentHost = host;
  if (p === '/player_api.php') return api(url.searchParams, res, host);
  if (p === '/xmltv.php') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    for (const chunk of xmltv()) res.write(chunk);
    return res.end();
  }
  if (p === '/get.php') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8' });
    return res.end(m3u(host, false));
  }
  if (p === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8' });
    return res.end(m3u(host, true));
  }
  if (p.startsWith('/logo/') || p.startsWith('/poster/')) {
    const name = decodeURIComponent(p.split('/')[2].replace(/\.svg$/, ''));
    const logo = p.startsWith('/logo/');
    const w = url.searchParams.get('w') ? Number(url.searchParams.get('w')) : logo ? 300 : 400;
    const h = logo ? 200 : w === 1280 ? 720 : 600;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    return res.end(svg(name, w, h, hueOf(name)));
  }
  if (p === '/media/sample.webm') return sendFile(req, res, join(mediaDir, 'sample.webm'), 'video/webm');
  if (p === '/media/sample.vtt') return sendFile(req, res, join(mediaDir, 'sample.vtt'), 'text/vtt');
  const m = /^\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\/.*?(\d+)\.(\w+)$/.exec(p);
  if (m) {
    const ext = m[3];
    if (ext === 'ts') return sendFile(req, res, join(mediaDir, 'sample.ts'), 'video/mp2t');
    if (ext === 'm3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:60.0,\n/media/sample.ts\n#EXT-X-ENDLIST\n`);
    }
    return sendFile(req, res, join(mediaDir, 'sample.webm'), 'video/webm');
  }
  if (p === '/media/sample.ts') return sendFile(req, res, join(mediaDir, 'sample.ts'), 'video/mp2t');
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`TermTV mock provider on http://localhost:${PORT}  (${lib.live.length} channels, ${lib.vod.length} movies, ${lib.series.length} series)`);
  console.log(`  Xtream: server http://<this-ip>:${PORT}  user ${USER}  pass ${PASS}`);
  console.log(`  M3U:    http://<this-ip>:${PORT}/playlist.m3u`);
});
