// Fails the build if the output uses syntax newer than ES2017 (Chromium 56 on 2018 Samsung TVs).
// Vendor libraries are checked too, since they run on the TV as well.
import { parse } from 'acorn';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = ['dist/js/app.js', ...readdirSync('dist/js/workers').map((f) => join('dist/js/workers', f)), 'dist/vendor/hls.min.js', 'dist/vendor/mpegts.js'];
let failed = false;
for (const f of files) {
  try {
    parse(readFileSync(f, 'utf8'), { ecmaVersion: 2017, sourceType: 'script' });
    console.log(`ok     ES2017  ${f}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL   ${f}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
