import { cleanTitle, dedupeKey, fold, naturalCompare, normalizeText, sortKey, splitPrefix, splitYear } from '@/core/normalize';

describe('fold / normalizeText', () => {
  it('removes accents and case', () => {
    expect(fold('Été Ça Ñandú')).toBe('ete ca nandu');
  });
  it('decomposes stylized letters', () => {
    expect(normalizeText('CNN ᴴᴰ')).toBe('cnn hd');
    expect(normalizeText('ＴＦ１')).toBe('tf1');
    expect(normalizeText('ʀᴀᴡ')).toBe('raw');
  });
  it('handles & and punctuation', () => {
    expect(normalizeText('Law & Order: SVU')).toBe('law and order svu');
    expect(normalizeText('A&E')).toBe('ae');
    expect(normalizeText("Grey's Anatomy")).toBe('greys anatomy');
    expect(normalizeText('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(normalizeText('Canal+')).toBe('canal plus');
  });
});

describe('splitPrefix', () => {
  it.each([
    ['US | CNN', 'US', 'CNN'],
    ['US: CNN', 'US', 'CNN'],
    ['UK - BBC One', 'UK', 'BBC One'],
    ['|FR| TF1', 'FR', 'TF1'],
    ['[AR] MBC 1', 'AR', 'MBC 1'],
    ['4K | Movies', '4K', 'Movies'],
    ['FR ➤ Sport', 'FR', 'Sport'],
  ])('%s', (input, prefix, rest) => {
    expect(splitPrefix(input)).toEqual({ prefix, rest });
  });
  it('does not treat titles as prefixes', () => {
    expect(splitPrefix('Dune: Part Two').prefix).toBe('');
    expect(splitPrefix('X-Men').prefix).toBe('');
    expect(splitPrefix('Movies').prefix).toBe('');
  });
});

describe('titles', () => {
  it('cleans display titles', () => {
    expect(cleanTitle('US | CNN HD')).toBe('CNN');
    expect(cleanTitle('|FR| TF1 FHD 50FPS')).toBe('TF1');
    expect(cleanTitle('★ ESPN 2 ★')).toBe('ESPN 2');
    expect(cleanTitle('Dune [4K]')).toBe('Dune');
    expect(cleanTitle('HD')).toBe('HD');
  });
  it('extracts years', () => {
    expect(splitYear('Dune (2021)')).toEqual({ title: 'Dune', year: 2021 });
    expect(splitYear('Dune - 2021')).toEqual({ title: 'Dune', year: 2021 });
    expect(splitYear('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049' });
    expect(splitYear('Blade Runner 2049', true)).toEqual({ title: 'Blade Runner 2049' });
    expect(splitYear('Dune 2021', true)).toEqual({ title: 'Dune', year: 2021 });
    expect(splitYear('1917')).toEqual({ title: '1917' });
  });
  it('builds dedupe keys that merge quality variants', () => {
    expect(dedupeKey('Dune (2021)')).toBe(dedupeKey('4K | Dune [UHD] (2021)'));
    expect(dedupeKey('Dune', 2021)).toBe(dedupeKey('Dune (2021)'));
    expect(dedupeKey('Dune 2021')).toBe(dedupeKey('Dune (2021)'));
    expect(dedupeKey('Dune (1984)')).not.toBe(dedupeKey('Dune (2021)'));
  });
  it('sorts ignoring prefixes', () => {
    expect(sortKey('US | ABC')).toBe('abc');
    expect(naturalCompare('channel 2', 'channel 10')).toBeLessThan(0);
  });
});
