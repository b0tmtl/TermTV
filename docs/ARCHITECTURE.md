# TermTV architecture

## Platform facts that shape the design

| Fact | Consequence |
|---|---|
| Tizen apps are web apps packaged as signed `.wgt` files | HTML / CSS / TypeScript, no native code |
| 2017 TVs run Chromium 47 | one IIFE bundle (no ES modules), Babel down to Chromium 47, polyfills for newer APIs, no CSS grid, CSS variables resolved per theme at build time |
| Samsung's native player is AVPlay (`webapis.avplay`) | hardware decoding of HLS, MPEG-TS, MP4, MKV; the default engine. HTML5 + hls.js / mpegts.js is the fallback |
| AVPlay draws video *under* the web page | the page is transparent where video shows (full screen, or the live preview "hole") |
| 1-2.5 GB RAM shared, slow CPUs | parsing in workers, compact search index, virtualized lists, guide kept to a time window |
| No background services | no local DVR |
| Cross-origin, plain-HTTP requests are allowed by `config.xml` | the app talks to any provider directly; no server of our own |

## Layers

```
screens/         Home · Live · Guide · Vod · Details · Search · Player · Settings · Categories · Profiles · Sources
ui/              cards, rows, VGrid (virtualized), dialogs, on-screen keyboard, PIN pad, actions
navigation/      focus engine (spatial navigation, layers, focus memory) · router (screen stack)
state/           user (sources, profiles, per-profile data) · library (catalog, categories, guide, search) · player
workers/         library.worker (download, parse, cache) · search.worker (index + queries)
core/            models · normalize · categories · search engine        (pure, unit-tested)
providers/       xtream · m3u (streaming) · xmltv (streaming, gzip)       (pure, unit-tested)
platform/        tv keys & device · AVPlay / HTML5 engines · IndexedDB · HTTP · USB files
```

`platform/` is the only layer that knows about Tizen. Everything else runs in a desktop browser, which is how
the app is developed and tested (`npm run mock` + `npm run dev` + `scripts/e2e.mjs`). A future LG webOS port
would replace `platform/` only.

## Data flow

**Startup.** Load settings (IndexedDB `kv`), pick the profile, render Home from the cached library
(IndexedDB `library`, `epg`), then refresh sources in the background when "Update on launch" is on.

**Refreshing a source** (library worker):
- Xtream: `player_api.php` → account check → categories + streams for live, movies, series (6 requests in parallel);
- M3U: streamed download → `M3UParser` (line by line, chunk boundaries anywhere) → `M3UCollector`
  classifies entries as live / movie / episode, groups `Show S01E02` episodes into series;
- result normalized to `core/models.ts`, written to IndexedDB, sent to the main thread.

**Guide** (library worker): XMLTV URLs from the playlist header, the M3U source settings, or Xtream's
`xmltv.php`. Gzip detected by magic bytes and inflated with fflate (Chromium 47 has no
`DecompressionStream`). `XmltvParser` keeps only channels in the library and programmes inside the window
(2 h back, 24 h ahead by default). Channels without `tvg-id` are matched by display name. Xtream channels
without XMLTV data fall back to `get_short_epg`.

**Search** (search worker): rebuilt after each library change; queries go over `postMessage`.

**Playback** (`state/player.ts`): picks the engine, builds the URL (Xtream URLs are built at play time),
tries the other live format (`.ts` ⇄ `.m3u8`) when a stream fails, reconnects stalled live streams
(15 s without progress), saves resume points every 10 s, plays the next episode at the end.

## Focus and remote control

Every focusable element carries `data-focus` (helper: `focusable({...})`). A key press goes:

1. to the focused element's handler, then its ancestors' (bubbling): screens and grids handle their keys;
2. else, for arrows, to **spatial navigation** inside the top layer (nearest element in that direction,
   scoring distance along the axis plus off-axis drift);
3. else to the global handler (Back, Guide).

Dialogs are **layers**: arrows never leave them, closing restores the previous focus. Containers marked
`data-focus-memory` (sidebar, rows, columns) remember their last focused child. The focused element is
marked with a `data-focused` attribute, not a class, because Preact rewrites `class` on re-render.

Long lists use `ui/VGrid.tsx`: only visible rows are in the DOM; arrows move an index inside the grid and
are handed back to spatial navigation at the edges.

## Category management

`core/categories.ts`, per profile and per section (live / movie / series):

- **Views**: provider categories become *views*; with "merge same names" on, categories with the same
  normalized name across sources become one view.
- **Stable ids**: `source:kind:normalized-name` (or `*:kind:name` when merged). Providers often renumber
  category ids on refresh; names are far more stable, so hidden lists and custom orders survive.
  Ids match across merged / unmerged modes, so toggling merge keeps choices.
- **Sort**: provider order, A → Z / Z → A (ignoring prefixes, accents, decorations; natural number order),
  custom (explicit id list), most watched (from history).
- **Hide**: explicit list; bulk by detected group, from the start of the name (`US`, `VOD`, `4K`...) or its end
  (`[FR]`, `(EN)`, `- VOSTFR`...), or by filter text.
- **Don't load hidden categories** (on by default): titles of categories hidden in *every* profile are
  dropped when a source loads (`dropHiddenCategories`) and are never saved; the category stays with a
  `skipped` count so it can be shown again, which reloads that source.
- **New categories**: ids seen are remembered; later ones are flagged and optionally auto-hidden.
- **Items inside a category**: provider order, number, A → Z / Z → A, recently added, year, rating, recently watched.
- Hidden categories disappear from browsing, Home, the guide and search (search can include them via a setting).
  Parental locks are separate: hidden entirely, or shown and PIN-gated.

## Search engine

`core/search/engine.ts`, an inverted index designed for IPTV names on slow hardware.

**Normalization** (`core/normalize.ts`), applied to names and queries alike: NFKD + accent removal,
stylized letters (`ᴴᴰ`, small caps, full width), `&` → `and` (`AT&T` → `att`), apostrophes dropped,
punctuation → spaces.

**Indexed words** per title: its words, letter/digit parts (`bbc1` → `bbc`, `1`), and each pair of
neighbours joined (`fox news` → `foxnews`), so `bbc 1`, `bbc1`, `foxnews` and `fox news` all match.

**Matching**, per query word, best first:

| Match | Example | How |
|---|---|---|
| exact word | `cnn` | binary search in the sorted word list |
| word prefix | `brea` → breaking | contiguous range after the binary search |
| inside a word (3+ chars) | `man` → batman | trigram index over the word list, then `indexOf` |
| typo (4+ letters: 1 edit, 8+: 2) | `brakeing` → breaking | bounded Damerau-Levenshtein over words sharing the first letter (or the first two swapped); never on numbers |

All query words must match, in any order. **Ranking**: sum of match qualities, plus bonuses for the exact
title, a title starting with the query, the query as a phrase, the first word, channel number; shorter
names first; caller boosts for favorites and recently watched.

**Results**: duplicates (same normalized title + year: other sources, FHD / 4K copies) are merged, with the
variants kept for the "Versions" menu. Only the top results are sorted (typed-array threshold), the rest
are counted. Scopes are a kind bitmask: All, Channels, VOD (movies + series), Movies, Series; the TV Guide
scope uses a second index over upcoming programme titles. Hidden categories and parental locks are an
exclusion mask pushed to the worker.

**Performance** (unit test, desktop): 150k titles, query worst case ~25 ms, typical 3-12 ms. Under 4× CPU
throttling in the browser with 100k titles: 1-30 ms per key press.

## Storage

| Store | Content |
|---|---|
| `kv/sources` | configured sources (credentials stay on the TV) |
| `kv/profiles`, `kv/app` | profiles, global settings (language, parental PIN, guide length) |
| `kv/profile:<id>` | favorites, lists, history, resume points, category choices, locks, settings |
| `wgt-private/library-<sourceId>.bin` (TV) or `library/<sourceId>#meta`, `#0`, `#1`... | categories + items (+ M3U episodes), compact and chunked (below) |
| `wgt-private/epg-<sourceId>.bin` (TV) or `epg/<sourceId>#meta`, `#0`... | programmes in the window, same format |

The IndexedDB of 2017 TVs refuses one huge record, so caches use `workers/cache-codec.ts`: fields that can
be rebuilt (`key`, `sourceId`, `kind`, the category key prefix) are dropped, the rest is JSON, gzipped with
fflate and split into 1 MB `ArrayBuffer` chunks, each written in its own transaction; the `#meta` record is
written last so a half-written cache is never read. The worker only compresses and decompresses; the main
thread stores (`state/cache.ts`). **On a TV the cache is a file** in the app's private folder
(`platform/filestore.ts`, `wgt-private/library-<source>.bin`): IndexedDB's quota on 2017 TVs is only a few MB
(QuotaExceededError). IndexedDB is the desktop path and the fallback; a TV that refuses `ArrayBuffer` values
gets the chunks as strings. Settings → About shows whether
each source's library was saved or loaded from the cache, or why saving failed. 100k titles: 26 MB of JSON become under 2 MB.

**Home snapshot.** The titles Home shows are saved in a small file (`home-<profile>.json`); at launch Home
renders from it at once while the full library loads, and screens that need the whole library show a
spinner until then.

**Keeping the UI thread light.** Anything that touches every title runs once per library or settings change,
not per render: category lookups are maps, hidden / locked checks are cached per category, "Recently added",
suggestions and "All" are cached until the library or the profile data changes. Search documents go to the
worker as parallel arrays, and duplicate groups are computed in the worker. `VGrid` slides one layer with
`translate3d` instead of moving rows, and Home rows mount 12 cards and grow as focus moves right.

Backup / restore writes `kv` to `termtv-backup.json` on a USB drive.

## Not yet / ideas

- Catch-up (timeshift) playback from the guide for Xtream channels with archive (URL builder exists).
- Sports page (fixtures from the guide, then channels carrying them).
- Smart Hub preview tiles.
- Samsung store release.
- LG webOS port (replace `platform/`).
