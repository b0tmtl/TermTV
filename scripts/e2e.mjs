// End-to-end walk-through in a desktop Chromium at 1920x1080, driven like a remote (arrow keys,
// Enter, Escape = Back). Takes screenshots into screenshots/ and fails on page errors.
//
//   npm run mock   (terminal 1)
//   npm run dev    (terminal 2)
//   node scripts/e2e.mjs [--chromium /path/to/chrome]

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP_URL || 'http://localhost:5173/';
const MOCK = process.env.MOCK_URL || 'http://localhost:8090';
const exe = process.argv.includes('--chromium') ? process.argv[process.argv.indexOf('--chromium') + 1] : process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/MEDIA_ERR|mpegts|Failed to load resource|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text());
});

const wait = (ms) => page.waitForTimeout(ms);
const key = async (k, n = 1) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(k);
    await wait(90);
  }
};
const shot = async (name) => {
  await wait(400);
  await page.screenshot({ path: `screenshots/${name}.png` });
  console.log('  📸', name);
};
const focusedText = () => page.evaluate(() => (document.querySelector('[data-focused]') || {}).textContent || '');
const step = (s) => console.log('▶', s);

async function typeInPrompt(text) {
  await page.waitForSelector('.overlay .osk');
  await wait(150);
  await page.keyboard.type(text, { delay: 15 });
  await page.getByText('Done', { exact: true }).click();
  await wait(150);
}

step('first launch');
await page.goto(APP);
await page.waitForSelector('.prompt');
await shot('01-welcome');

step('add an Xtream source');
await key('Enter');
await page.waitForSelector('.field');
await page.locator('.field').nth(1).click();
await typeInPrompt(MOCK.replace(/^http:\/\//, ''));
await page.locator('.field').nth(2).click();
await typeInPrompt('demo');
await page.locator('.field').nth(3).click();
await typeInPrompt('demo');
await shot('02-add-source');
await page.getByText('Connect', { exact: true }).click();
await page.waitForSelector('.row-block, .prompt .path:text("~/home")', { timeout: 30000 });
await wait(1500);
await shot('03-home-empty-history');

step('live tv');
await key('Escape'); // root screen: Back focuses the sidebar
await page.click('[data-fid="nav:live"]');
await page.waitForSelector('.chan-item');
await wait(600);
await shot('04-live');
await key('ArrowDown', 3);
await key('ArrowRight');
await key('ArrowDown', 2);
await key('Enter'); // preview
await wait(1500);
await shot('05-live-preview');
await key('F1'); // red = favorite
await key('F2'); // green = sort menu
await wait(200);
await shot('06-live-sort-menu');
await key('Escape');

step('guide');
await page.click('[data-fid="nav:guide"]');
await page.waitForSelector('.g-prog');
await key('ArrowDown');
await key('ArrowRight', 2);
await shot('07-guide');

step('movies');
await page.click('[data-fid="nav:movie"]');
await page.waitForSelector('.card.poster');
await key('ArrowRight');
await key('ArrowRight', 2);
await shot('08-movies');
await key('Enter');
await page.waitForSelector('.details h1');
await wait(800);
await shot('09-movie-details');
await key('Enter'); // Play
await wait(2500);
await shot('10-player-vod');
await key('ArrowRight'); // seek +10
await key('F3'); // yellow: tracks
await wait(300);
await shot('11-player-tracks');
await key('Escape'); // close the menu
await key('Escape'); // hide the controls
await key('Escape'); // leave the player
await key('Escape'); // leave details
await wait(500);

step('series');
await page.click('[data-fid="nav:series"]');
await page.waitForSelector('.card.poster');
await key('ArrowRight');
await key('Enter');
await page.waitForSelector('.details h1');
await wait(1200);
await shot('12-series-details');
await key('Escape');
await wait(300);

step('search');
await page.click('[data-fid="nav:search"]');
await page.waitForSelector('.osk');
await page.keyboard.type('brakeing', { delay: 40 });
await wait(800);
await shot('13-search-typo');
for (let i = 0; i < 8; i++) await key('Backspace');
await page.keyboard.type('cnn', { delay: 40 });
await wait(800);
await shot('14-search-cnn');
for (let i = 0; i < 3; i++) await key('Backspace');
await page.keyboard.type('news', { delay: 40 });
await wait(600);
await page.click('[data-fid="scope:guide"]');
await wait(800);
await shot('15-search-guide');

step('category manager');
await page.click('[data-fid="nav:settings"]');
await page.waitForSelector('.settings');
await page.click('[data-fid="set:categories"]');
await wait(300);
await page.getByText('Live TV categories').click();
await page.waitForSelector('.cat-row');
await wait(400);
await shot('16-categories');
// Hide the whole "AR" group with one press.
await page.locator('.chip', { hasText: 'AR' }).first().click();
await wait(300);
await shot('17-categories-hide-group');
// Pick up the first category and move it down twice.
await page.locator('.cat-row').first().click(); // toggles hidden
await page.locator('.cat-row').first().click(); // and back
await key('F2');
await key('ArrowDown', 2);
await key('Enter');
await shot('18-categories-moved');

step('themes');
await key('Escape');
await page.click('[data-fid="set:appearance"]');
await wait(200);
await page.getByText('Theme', { exact: true }).click();
await page.getByText('Matrix Green').click();
await wait(300);
await page.click('[data-fid="nav:home"]');
await wait(800);
await shot('19-home-matrix');

step('profiles');
await page.click('[data-fid="nav:profile"]');
await page.waitForSelector('.profiles');
await shot('20-profiles');

await browser.close();
if (errors.length) {
  console.error('\nErrors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nDone, no page errors.');
