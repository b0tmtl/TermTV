import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/i18n/locales/en.json';

function flatten(obj: Record<string, unknown>, prefix = '', out: Set<string> = new Set()): Set<string> {
  for (const k of Object.keys(obj)) {
    if (k === '_meta') continue;
    const v = obj[k] as Record<string, unknown> | string;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || (v && typeof v === 'object' && typeof (v as Record<string, unknown>).other === 'string')) out.add(key);
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).reduce<string[]>((acc, f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? acc.concat(files(p)) : /\.tsx?$/.test(f) ? acc.concat([p]) : acc;
  }, []);
}

const keys = flatten(en as Record<string, unknown>);
const src = files(join(__dirname, '..', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('translations', () => {
  it('has every key used in the code', () => {
    const used = new Set<string>();
    const re = /\bt\('([a-zA-Z0-9_.]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) if (!m[1].endsWith('.') && m[1] !== 'some.key') used.add(m[1]);
    const missing = Array.from(used).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('has every dynamic key', () => {
    const dynamic: Record<string, string[]> = {
      nav: ['home', 'live', 'guide', 'movies', 'series', 'search', 'settings'],
      settings: ['sources', 'categories', 'appearance', 'player', 'subtitles', 'parental', 'guide', 'backup', 'language', 'about'],
      sort: ['provider', 'number', 'az', 'za', 'recent', 'added', 'year', 'rating'],
      'categories.sort': ['provider', 'az', 'za', 'custom', 'mostWatched'],
      'categories.kind': ['live', 'movie', 'series'],
      'player.aspect': ['fit', 'fill', 'stretch'],
      'search.scope': ['all', 'live', 'vod', 'movie', 'series', 'guide'],
      size: ['small', 'medium', 'large', 'xlarge'],
      subbg: ['none', 'shadow', 'box'],
      subpos: ['bottom', 'raised', 'top'],
      theme: ['midnight', 'matrix', 'amber', 'purple', 'synthwave', 'paper'],
    };
    const missing: string[] = [];
    for (const p of Object.keys(dynamic)) for (const k of dynamic[p]) if (!keys.has(`${p}.${k}`)) missing.push(`${p}.${k}`);
    expect(missing).toEqual([]);
  });
});
