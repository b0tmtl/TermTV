// Builds dist/ and signs it into build/TermTV.wgt with the Tizen CLI (part of Tizen Studio).
//
//   npm run package                    uses the active security profile
//   TIZEN_PROFILE=termtv npm run package
//   TIZEN_CLI=/path/to/tizen npm run package
//
// See docs/INSTALL.md for creating the Samsung certificate profile and installing on a TV.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  process.env.TIZEN_CLI,
  join(homedir(), 'tizen-studio/tools/ide/bin/tizen'),
  join(homedir(), 'tizen-studio/tools/ide/bin/tizen.bat'),
  'C:\\tizen-studio\\tools\\ide\\bin\\tizen.bat',
  'tizen',
].filter(Boolean);

function findCli() {
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore', shell: c.endsWith('.bat') });
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

const cli = findCli();
if (!cli) {
  console.error('Tizen CLI not found. Install Tizen Studio (see docs/INSTALL.md) or set TIZEN_CLI.');
  process.exit(1);
}

execFileSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
mkdirSync('build', { recursive: true });
const args = ['package', '-t', 'wgt', '-o', 'build'];
if (process.env.TIZEN_PROFILE) args.push('-s', process.env.TIZEN_PROFILE);
args.push('--', 'dist');
execFileSync(cli, args, { stdio: 'inherit', shell: cli.endsWith('.bat') });

const wgt = readdirSync('build').find((f) => f.endsWith('.wgt') && f !== 'TermTV.wgt');
if (wgt) renameSync(join('build', wgt), join('build', 'TermTV.wgt'));
if (!existsSync('build/TermTV.wgt')) {
  console.error('Packaging failed: no .wgt produced.');
  process.exit(1);
}
console.log('\nPackaged build/TermTV.wgt\nInstall: tizen install -n build/TermTV.wgt -t <device-name>   (see docs/INSTALL.md)');
