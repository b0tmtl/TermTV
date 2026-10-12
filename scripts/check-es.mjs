// Fails the build if the output uses syntax newer than ES2015 (Chromium 47 on 2017 Samsung TVs).
// Vendor libraries are checked too, since they run on the TV as well.
import { parse } from 'acorn';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Chromium 47 has no CSS variables: they must all be resolved at build time.
for (const f of readdirSync('dist/css')) {
  if (/var\(--/.test(readFileSync(join('dist/css', f), 'utf8'))) {
    console.error(`FAIL   dist/css/${f}: unresolved CSS variable`);
    process.exitCode = 1;
  }
}
const files = ['dist/js/app.js', ...readdirSync('dist/js/workers').map((f) => join('dist/js/workers', f)), 'dist/vendor/hls.min.js', 'dist/vendor/mpegts.js'];
let failed = false;
for (const f of files) {
  try {
    parse(readFileSync(f, 'utf8'), { ecmaVersion: 2015, sourceType: 'script' });
    console.log(`ok     ES2015  ${f}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL   ${f}: ${e.message}`);
  }
}
process.exit(failed || process.exitCode ? 1 : 0);
