// TermTV build script.
//
// Produces a static app in dist/ that runs on Tizen 3.0+ (2017 TVs, Chromium 47):
//  - one IIFE bundle (no ES module support on those engines), then Babel down to Chromium 47
//    (destructuring, block scoping, async functions -> generators)
//  - one IIFE bundle per Web Worker, same treatment
//  - one stylesheet per theme with CSS variables resolved (Chromium 47 has no CSS variables)
//  - the fallback player libraries copied as standalone scripts (loaded on demand)
//
// Usage: node scripts/build.mjs            production build
//        node scripts/build.mjs --serve    dev server with rebuild on change

import * as esbuild from 'esbuild';
import { transformSync } from '@babel/core';
import { watch } from 'node:fs';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const serve = process.argv.includes('--serve');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// esbuild bundles to ES2017; Babel then lowers JavaScript to the oldest supported engine.
const TARGET = ['es2017'];
const CSS_TARGET = ['chrome47'];
const OLDEST = { chrome: '47' };

const define = {
  __DEV__: JSON.stringify(serve),
  __VERSION__: JSON.stringify(pkg.version),
};

const common = {
  bundle: true,
  target: TARGET,
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias: { '@': join(root, 'src') },
  define,
  sourcemap: serve ? 'inline' : false,
  minify: !serve,
  legalComments: 'none',
  logLevel: 'info',
};

const workerEntries = readdirSync(join(root, 'src/workers'))
  .filter((f) => f.endsWith('.worker.ts'))
  .map((f) => join(root, 'src/workers', f));

function copyStatic() {
  mkdirSync(join(dist, 'vendor'), { recursive: true });
  cpSync(join(root, 'public'), dist, { recursive: true });
  cpSync(join(root, 'tizen/config.xml'), join(dist, 'config.xml'));
  if (existsSync(join(root, 'tizen/icon.png'))) cpSync(join(root, 'tizen/icon.png'), join(dist, 'icon.png'));
  cpSync(join(root, 'node_modules/hls.js/dist/hls.min.js'), join(dist, 'vendor/hls.min.js'));
  cpSync(join(root, 'node_modules/mpegts.js/dist/mpegts.js'), join(dist, 'vendor/mpegts.js'));
  // JetBrains Mono (SIL Open Font License 1.1).
  const fonts = join(root, 'node_modules/@fontsource/jetbrains-mono');
  mkdirSync(join(dist, 'fonts'), { recursive: true });
  for (const w of ['400', '700']) {
    for (const sub of ['latin', 'latin-ext']) {
      cpSync(join(fonts, `files/jetbrains-mono-${sub}-${w}-normal.woff2`), join(dist, `fonts/jbm-${sub}-${w}.woff2`));
    }
  }
  cpSync(join(fonts, 'LICENSE'), join(dist, 'fonts/OFL.txt'));
  // Keep config.xml version in sync with package.json.
  const cfgPath = join(dist, 'config.xml');
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/version="[^"]*"(\s+viewmodes)/, `version="${pkg.version}"$1`));
}

// ---- Themes: one stylesheet per theme with every var(--x) replaced by its value ----------------
const themeCache = join(root, 'node_modules/.cache/termtv-themes');
const THEME_BLOCK = /(?::root,\s*)?\[data-theme='([\w-]+)'\]\s*\{([^}]*)\}/g;

function writeThemeSources() {
  const src = readFileSync(join(root, 'src/styles/main.css'), 'utf8');
  const themes = {};
  let m;
  THEME_BLOCK.lastIndex = 0;
  while ((m = THEME_BLOCK.exec(src))) {
    const vars = {};
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) vars[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    themes[m[1]] = vars;
  }
  const body = src.replace(THEME_BLOCK, '');
  mkdirSync(themeCache, { recursive: true });
  return Object.keys(themes).map((id) => {
    const vars = { ...themes.midnight, ...themes[id] };
    const css = body.replace(/var\((--[\w-]+)\)/g, (whole, name) => {
      if (!(name in vars)) throw new Error(`Theme ${id}: unknown CSS variable ${name}`);
      return vars[name];
    });
    const file = join(themeCache, `theme-${id}.css`);
    writeFileSync(file, css);
    return file;
  });
}

// ---- Babel pass for the JavaScript bundles ----------------------------------------------------
const babelPlugin = {
  name: 'babel-oldest-tv',
  setup(build) {
    build.onEnd((result) => {
      // Dev runs in a modern browser; TV_BUILD=1 npm run dev serves the exact TV output instead.
      if (result.errors.length || (serve && !process.env.TV_BUILD)) return;
      const outs = build.initialOptions.outfile
        ? [build.initialOptions.outfile]
        : readdirSync(build.initialOptions.outdir).filter((f) => f.endsWith('.js')).map((f) => join(build.initialOptions.outdir, f));
      for (const file of outs) {
        const out = transformSync(readFileSync(file, 'utf8'), {
          babelrc: false,
          configFile: false,
          sourceType: 'script',
          compact: true,
          comments: false,
          presets: [['@babel/preset-env', { targets: OLDEST, modules: false, bugfixes: true }]],
        });
        writeFileSync(file, out.code);
      }
    });
  },
};

const themeEntries = writeThemeSources();

const builds = [
  { ...common, entryPoints: [join(root, 'src/main.tsx')], outfile: join(dist, 'js/app.js'), plugins: [babelPlugin] },
  { ...common, entryPoints: workerEntries, outdir: join(dist, 'js/workers'), entryNames: '[name]', plugins: [babelPlugin] },
  { ...common, target: CSS_TARGET, entryPoints: themeEntries, outdir: join(dist, 'css'), entryNames: '[name]', external: ['../fonts/*'] },
];

rmSync(dist, { recursive: true, force: true });
copyStatic();

if (serve) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  // Regenerate the theme sources when the stylesheet changes (esbuild then rebuilds them).
  watch(join(root, 'src/styles/main.css'), () => {
    try {
      writeThemeSources();
    } catch (e) {
      console.error(e.message);
    }
  });
  const inner = await ctxs[0].serve({ servedir: dist, port: 0, host: '127.0.0.1' });
  const port = Number(process.env.PORT || 5173);
  createServer((req, res) => {
    if (req.url.startsWith('/proxy?url=')) return proxy(req, res, decodeURIComponent(req.url.slice(11)));
    const up = httpRequest({ host: '127.0.0.1', port: inner.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  }).listen(port, '0.0.0.0');
  console.log(`\n  TermTV dev server: http://localhost:${port}\n  (provider requests go through /proxy?url=... because providers don't send CORS headers)\n`);
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`Built TermTV ${pkg.version} into dist/`);
}

// Dev only: forwards a provider request (API, playlist, guide or stream), following redirects.
function proxy(req, res, target, hops = 0) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return res.writeHead(400).end('bad url');
  }
  const headers = { 'user-agent': req.headers['user-agent'] || 'TermTV' };
  if (req.headers.range) headers.range = req.headers.range;
  const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = fn(u, { method: 'GET', headers }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
      r.resume();
      return proxy(req, res, new URL(r.headers.location, u).toString(), hops + 1);
    }
    const out = { 'access-control-allow-origin': '*' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-encoding']) if (r.headers[h]) out[h] = r.headers[h];
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' });
    res.end(String(e.message));
  });
  req.on('close', () => up.destroy());
  up.end();
}
