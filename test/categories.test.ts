import {
  anyIdMatches, idMatches,
  buildCategoryViews, defaultCategoryPrefs, filterViews, isHidden, isNew, markKnown, moveCategory,
  prefixGroups, setHidden, sortCategoryViews, sortItems, visibleCategories, type CategoryView,
} from '@/core/categories';
import type { Category, Channel } from '@/core/models';

function cat(sourceId: string, providerId: string, name: string, order: number): Category {
  return { key: `${sourceId}:live:${providerId}`, sourceId, kind: 'live', providerId, name, order };
}

const cats: Category[] = [
  cat('a', '10', 'US | News', 0),
  cat('a', '11', 'US | Sports', 1),
  cat('a', '12', 'FR | Général', 2),
  cat('a', '13', 'FR | Sport', 3),
  cat('a', '14', 'AR | MBC', 4),
  cat('a', '15', 'Kids', 5),
  cat('b', '1', 'US | News', 0),
  cat('b', '2', 'UK | Entertainment', 1),
];

describe('category views', () => {
  it('merges same-name categories across sources when asked', () => {
    const merged = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    expect(merged).toHaveLength(7);
    expect(merged[0].keys).toEqual(['a:live:10', 'b:live:1']);
    const separate = buildCategoryViews(cats, 'live', ['a', 'b'], false);
    expect(separate).toHaveLength(8);
  });

  it('sorts A-Z ignoring prefixes and accents', () => {
    const views = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    const prefs = { ...defaultCategoryPrefs('live'), sort: 'az' as const };
    expect(sortCategoryViews(views, prefs).map((v) => v.name)).toEqual([
      'UK | Entertainment', 'FR | Général', 'Kids', 'AR | MBC', 'US | News', 'FR | Sport', 'US | Sports',
    ]);
  });

  it('hides categories and survives provider id renumbering', () => {
    let views = buildCategoryViews(cats, 'live', ['a', 'b'], false);
    let prefs = setHidden(defaultCategoryPrefs('live'), [views.find((v) => v.name === 'Kids')!], true);
    // The provider renumbers every category on refresh.
    const renumbered = cats.map((c) => ({ ...c, providerId: c.providerId + '0', key: c.key + '0' }));
    views = buildCategoryViews(renumbered, 'live', ['a', 'b'], false);
    expect(visibleCategories(views, prefs).map((v) => v.name)).not.toContain('Kids');
    // Toggling merge keeps the hidden state too.
    views = buildCategoryViews(renumbered, 'live', ['a', 'b'], true);
    expect(visibleCategories(views, prefs).map((v) => v.name)).not.toContain('Kids');
    prefs = setHidden(prefs, views.filter((v) => v.name === 'Kids'), false);
    expect(visibleCategories(views, prefs).map((v) => v.name)).toContain('Kids');
  });

  it('groups by prefix for bulk hide', () => {
    const views = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    const prefs = defaultCategoryPrefs('live');
    const groups = prefixGroups(views, prefs);
    expect(groups.map((g) => g.prefix)).toEqual(['FR', 'US']);
    const fr = views.filter((v) => groups[0].ids.indexOf(v.id) >= 0);
    const hidden = setHidden(prefs, fr, true);
    expect(visibleCategories(views, hidden).map((v) => v.prefix)).not.toContain('FR');
    expect(prefixGroups(views, hidden)[0].hiddenCount).toBe(2);
  });

  it('filters by text', () => {
    const views = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    expect(filterViews(views, 'sport').map((v) => v.name)).toEqual(['US | Sports', 'FR | Sport']);
    expect(filterViews(views, 'general').map((v) => v.name)).toEqual(['FR | Général']);
  });

  it('moves categories in a custom order', () => {
    const views = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    let prefs = defaultCategoryPrefs('live');
    const kids = views.find((v) => v.name === 'Kids')!;
    prefs = moveCategory(prefs, sortCategoryViews(views, prefs), kids.id, 'top');
    expect(prefs.sort).toBe('custom');
    let order = sortCategoryViews(views, prefs);
    expect(order[0].name).toBe('Kids');
    prefs = moveCategory(prefs, order, kids.id, 'down');
    order = sortCategoryViews(views, prefs);
    expect(order[1].name).toBe('Kids');
    prefs = moveCategory(prefs, order, kids.id, 'bottom');
    expect(sortCategoryViews(views, prefs).slice(-1)[0].name).toBe('Kids');
  });

  it('flags and optionally hides new categories', () => {
    const views = buildCategoryViews(cats, 'live', ['a', 'b'], true);
    let prefs = markKnown(defaultCategoryPrefs('live'), views);
    const extra = buildCategoryViews(cats.concat(cat('a', '99', 'PPV Events', 9)), 'live', ['a', 'b'], true);
    const ppv = extra.find((v) => v.name === 'PPV Events')!;
    expect(isNew(ppv, prefs)).toBe(true);
    expect(isHidden(ppv, prefs)).toBe(false);
    prefs = { ...prefs, newCategories: 'hide' };
    expect(isHidden(ppv, prefs)).toBe(true);
  });
});

describe('sortItems', () => {
  const ch = (name: string, order: number, number?: number): Channel => ({
    key: `a:live:${order}`, sourceId: 'a', kind: 'live', providerId: String(order), name, categoryKey: 'a:live:1', order, number,
  });
  const items = [ch('US | NBC', 0, 4), ch('US | ABC', 1, 2), ch('US | CBS', 2, 10)];
  it('sorts by name, number and provider order', () => {
    expect(sortItems(items, 'az').map((c) => c.name)).toEqual(['US | ABC', 'US | CBS', 'US | NBC']);
    expect(sortItems(items, 'number').map((c) => c.number)).toEqual([2, 4, 10]);
    expect(sortItems(items, 'provider').map((c) => c.order)).toEqual([0, 1, 2]);
  });
});

describe('anyIdMatches', () => {
  it('agrees with idMatches on every combination', () => {
    const stored = ['a:live:news', '*:live:sports', 'b:movie:drama', '*:movie:kids', 'c:live:music'];
    const views: CategoryView[] = [];
    for (const src of ['a', 'b', 'c', '*'])
      for (const rest of ['live:news', 'live:sports', 'movie:drama', 'movie:kids', 'live:music', 'live:other'])
        views.push({ id: `${src}:${rest}`, kind: 'live', name: rest, prefix: '', keys: [], sourceIds: src === '*' ? ['a', 'b'] : [src], providerRank: 0 });
    for (const v of views) expect(anyIdMatches(stored, v)).toBe(stored.some((s) => idMatches(s, v)));
  });
});

describe('suffix groups', () => {
  it('groups VOD - X [FR] by prefix and by trailing tag', async () => {
    const { splitSuffix } = await import('@/core/normalize');
    expect(splitSuffix('VOD - ACTION [MULTISUB]')).toBe('MULTISUB');
    expect(splitSuffix('SRS - DRAMA [fr]')).toBe('FR');
    expect(splitSuffix('Action (EN)')).toBe('EN');
    expect(splitSuffix('Kids | VOSTFR')).toBe('VOSTFR');
    expect(splitSuffix('Movies (2023)')).toBe('');
    expect(splitSuffix('X-Men')).toBe('');
    expect(splitSuffix('VOD - ACTION')).toBe('');
    expect(splitSuffix('VOD - KIDS')).toBe('');
    expect(splitSuffix('Drama - FR')).toBe('FR');
    expect(splitSuffix('Action')).toBe('');
    const names = ['VOD - ACTION [MULTISUB]', 'VOD - ACTION [FR]', 'VOD - ACTION [EN]', 'VOD - DRAMA [FR]', 'VOD - DRAMA [EN]', 'VOD - KIDS [MULTISUB]'];
    const cats: Category[] = names.map((name, i) => ({ key: 's:movie:' + i, sourceId: 's', kind: 'movie', providerId: String(i), name, order: i }));
    const views = buildCategoryViews(cats, 'movie', ['s'], true);
    const groups = prefixGroups(views, defaultCategoryPrefs('movie'));
    expect(groups.map((g) => [g.prefix, g.ids.length])).toEqual([['VOD', 6], ['[EN]', 2], ['[FR]', 2], ['[MULTISUB]', 2]]);
  });
});

describe('dropHiddenCategories', () => {
  it('drops titles of hidden categories and remembers how many', async () => {
    const { dropHiddenCategories } = await import('@/core/categories');
    const cat = (id: string, name: string): Category => ({ key: `s:movie:${id}`, sourceId: 's', kind: 'movie', providerId: id, name, order: Number(id) });
    const mv = (id: number, c: string) => ({ key: `s:movie:${id}`, sourceId: 's', kind: 'movie' as const, providerId: String(id), name: 'M' + id, categoryKey: `s:movie:${c}`, order: id });
    const lib = { categories: [cat('1', 'VOD - ACTION [FR]'), cat('2', 'VOD - ACTION [EN]')], live: [], movies: [mv(1, '1'), mv(2, '1'), mv(3, '2')], series: [] };
    // Hidden as a merged id (what "merge same names" stores) still matches the source's category.
    const n = dropHiddenCategories(lib, 's', { movie: ['*:movie:vod action fr'] });
    expect(n).toBe(2);
    expect(lib.movies.map((m) => m.providerId)).toEqual(['3']);
    expect(lib.categories[0].skipped).toBe(2);
    expect(lib.categories[1].skipped).toBeUndefined();
    expect(dropHiddenCategories(lib, 's', {})).toBe(0);
  });
});
