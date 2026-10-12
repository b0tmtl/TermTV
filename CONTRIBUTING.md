# Contributing to TermTV

Thanks for helping! Bug reports from real TVs are the most valuable contribution right now: please include
your **TV model**, **year**, and what you were doing.

## Development setup

```bash
npm install
npm run mock     # fake provider on http://localhost:8090 (user demo / pass demo)
npm run dev      # http://localhost:5173
```

Open the app in a desktop Chromium browser at 1920×1080 (full screen or device emulation). The keyboard
acts as the remote:

| Keyboard | Remote |
|---|---|
| Arrows, Enter | Arrows, OK |
| Esc | Back |
| F1 / F2 / F3 / F4 | Red / Green / Yellow / Blue |
| Page Up / Page Down | Channel + / − |
| F9 | Info |
| Space | Play / Pause |

`MOCK_SCALE=big npm run mock` generates ~12k channels and ~100k titles for performance work.

Before opening a pull request:

```bash
npm run check          # typecheck, unit tests, build, ES2017 output check
node scripts/e2e.mjs   # needs `npm run mock` and `npm run dev` running
```

## Rules of the road

**The oldest supported TV runs Chromium 56** (Samsung 2018, Tizen 4.0). That shapes the code:

- esbuild lowers syntax to `chrome56` and `npm run check:es` verifies the output parses as ES2017;
- runtime APIs newer than Chromium 56 need a polyfill in `src/polyfills.ts` or a fallback
  (no `AbortController`, `IntersectionObserver`, `ResizeObserver`, `getAllKeys`, `Intl.PluralRules` guaranteed);
- CSS: no grid, no flex `gap`, no `:focus-within`, no `aspect-ratio`;
- TVs are slow and short on memory: virtualize long lists (`ui/VGrid.tsx`), keep parsing in workers,
  never block the main thread for more than a few milliseconds.

Code style: TypeScript strict, small modules, comments that explain *why*. Every visible string goes through `t()`.

## Adding a language

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/<code>.json` (for example `fr.json`).
2. Set `"_meta": { "name": "Français", "code": "fr" }`.
3. Translate the values. Keep the keys and the `{placeholders}` as they are.
4. Plurals use objects: `{ "one": "{count} épisode", "other": "{count} épisodes" }`. Add forms like
   `"few"` / `"many"` if your language needs them (they follow `Intl.PluralRules`).
5. Run `npm run dev`: the language appears in **Settings → Language** automatically.

Missing keys fall back to English, so you can send a partial translation. `npm test` checks that every key
used in the code exists in `en.json`.

## Project layout

```
src/
  core/          pure logic, fully unit-tested: models, name normalization, categories, search engine
  providers/     Xtream API client, streaming M3U and XMLTV parsers
  platform/      TV glue: remote keys, AVPlay / HTML5 players, IndexedDB, HTTP, USB files
  workers/       library worker (download + parse + cache) and search worker
  state/         stores: user data, library, player
  navigation/    focus engine (spatial navigation) and screen router
  ui/            reusable components (cards, rows, virtual grid, dialogs, keyboard)
  screens/       one file per screen
  i18n/          t(), locales/*.json
  styles/        main.css (themes are CSS variables)
mock/            fake provider for development
scripts/         build, packaging, end-to-end walk-through
tizen/           config.xml and icon
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.
