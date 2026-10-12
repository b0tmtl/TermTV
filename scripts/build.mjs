// TermTV build script.
//
// Produces a static app in dist/ that runs on Tizen 4.0+ (Chromium 56):
//  - one IIFE bundle (Chromium 56 has no ES module support)
//  - one IIFE bundle per Web Worker
//  - CSS lowered to chrome56
//  - the fallback player libraries copied as standalone scripts (loaded on demand)
//
// Usage: node scripts/build.mjs            production build
//        node scripts/build.mjs --serve    dev server with rebuild on change

import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const serve = process.argv.includes('--serve');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const TARGET = ['chrome56'];

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

const builds = [
  { ...common, entryPoints: [join(root, 'src/main.tsx')], outfile: join(dist, 'js/app.js') },
  { ...common, entryPoints: workerEntries, outdir: join(dist, 'js/workers'), entryNames: '[name]' },
  { ...common, entryPoints: [join(root, 'src/styles/main.css')], outfile: join(dist, 'css/app.css'), external: ['../fonts/*'] },
];

rmSync(dist, { recursive: true, force: true });
copyStatic();

if (serve) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
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
