import { useMemo, useRef, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import { moveCategory, setHidden, sortCategoryViews, type CategoryView, type ItemSort } from '@/core/categories';
import type { Item } from '@/core/models';
import { t } from '@/i18n';
import { focusById, focusable } from '@/navigation/focus';
import { navigate, updateRoute } from '@/navigation/router';
import { allBrowseItems, allViews, browseViews, countInView, invalidateItemCache, isFavoriteCategory, isViewLocked, itemByKey, itemsInView, libraryState, recentlyAdded } from '@/state/library';
import { useStore } from '@/state/store';
import { updateCategoryPrefs, updateData, user } from '@/state/user';
import { PosterCard, Prompt } from '@/ui/Cards';
import { showMenu, type MenuOption } from '@/ui/Dialog';
import { askPin, favoriteCategoryOption, favoriteCategoryToggle, favoriteToggle, itemMenu, openItem } from '@/ui/actions';
import { VGrid } from '@/ui/VGrid';
import { toast } from '@/ui/ui-state';

const FAV = '@favorites';
const CONTINUE = '@continue';
const NEW = '@new';
const ALL = '@all';

interface CatEntry {
  id: string;
  name: string;
  icon?: string;
  view?: CategoryView;
  count: number;
}

export function VodScreen({ kind, categoryId }: { kind: 'movie' | 'series'; categoryId?: string }) {
  useStore(libraryState, (s) => s.version);
  const data = useStore(user, (s) => s.data);
  const unlocked = useStore(user, (s) => s.unlocked);

  const cats = useMemo<CatEntry[]>(() => {
    const out: CatEntry[] = [];
    const favs = data.favorites.filter((k) => k.indexOf(`:${kind}:`) > 0 && itemByKey(k));
    if (favs.length) out.push({ id: FAV, name: t('vod.favorites'), icon: 'star', count: favs.length });
    const cont = continueList(kind);
    if (cont.length) out.push({ id: CONTINUE, name: t('vod.continue'), icon: 'play', count: cont.length });
    const fresh = recentlyAdded(kind, 200);
    if (fresh.length) out.push({ id: NEW, name: t('vod.new'), icon: 'spark', count: fresh.length });
    const views = browseViews(kind);
    let total = 0;
    const entries = views.map((v) => {
      const count = countInView(v);
      total += count;
      return { id: v.id, name: v.name, view: v, count, icon: isFavoriteCategory(v) ? 'star' : undefined };
    });
    out.push({ id: ALL, name: t('vod.all'), count: total });
    return out.concat(entries);
  }, [kind, data.categories[kind], data.favoriteCategories, data.favorites, data.history, data.locked, unlocked, libraryState.get().version]);

  // Kept by id: Favorites / Continue rows come and go and would shift indexes.
  const [catId, setCatId] = useState(categoryId && cats.some((c) => c.id === categoryId) ? categoryId : cats[0] ? cats[0].id : '');
  const found = cats.findIndex((c) => c.id === catId);
  const catIdx = found >= 0 ? found : 0;
  const initialCat = catIdx;
  const cat = cats[catIdx];
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const items = useMemo<Item[]>(() => {
    if (!cat) return [];
    if (cat.id === FAV) return data.favorites.map((k) => itemByKey(k)).filter((i): i is Item => !!i && i.kind === kind);
    if (cat.id === CONTINUE) return continueList(kind);
    if (cat.id === NEW) return recentlyAdded(kind, 200);
    const views = browseViews(kind);
    if (cat.id === ALL) return allBrowseItems(kind);
    const v = views.find((x) => x.id === cat.id);
    return v ? itemsInView(v) : [];
  }, [cat && cat.id, data.categories[kind].itemSort, data.favorites, unlocked, libraryState.get().version]);

  if (!cat) {
    return (
      <div class="screen-pad">
        <Prompt path={kind === 'movie' ? '~/movies' : '~/series'} cmd="ls" />
        <div class="dim">{t('vod.empty')}</div>
      </div>
    );
  }

  const select = (i: number) => {
    if (i === catIdx || !cats[i]) return;
    setCatId(cats[i].id);
    updateRoute({ categoryId: cats[i].id } as never);
  };

  const catMenu = (c: CatEntry) => {
    const v = c.view;
    if (!v) return;
    const options: MenuOption[] = [
      favoriteCategoryOption(v),
      {
        label: t('categories.hide'),
        onSelect: () => {
          updateCategoryPrefs(kind, (p) => setHidden(p, [v], true));
          toast(t('categories.hidden', { name: v.name }));
          setCatId(cats[0] ? cats[0].id : '');
        },
      },
      { label: t('categories.moveTop'), onSelect: () => updateCategoryPrefs(kind, (p) => moveCategory(p, sortCategoryViews(allViews(kind), p), v.id, 'top')) },
      {
        label: isViewLocked(v) ? t('parental.unlockCategory') : t('parental.lockCategory'),
        onSelect: async () => {
          if (!user.get().app.parentalPin) return toast(t('parental.setPinFirst'));
          if (!(await askPin())) return;
          updateData((d) => ({ locked: isViewLocked(v) ? d.locked.filter((id) => id !== v.id) : d.locked.concat([v.id]) }));
        },
      },
      { label: t('categories.manage'), onSelect: () => navigate({ name: 'categories', kind }) },
    ];
    showMenu(v.name, options);
  };

  const sortMenu = () => {
    const cur = data.categories[kind].itemSort;
    const modes: ItemSort[] = ['added', 'provider', 'az', 'za', 'year', 'rating'];
    showMenu(
      t('sort.items'),
      modes.map((m) => ({
        label: t('sort.' + m),
        checked: cur === m,
        onSelect: () => {
          invalidateItemCache();
          updateCategoryPrefs(kind, (p) => ({ ...p, itemSort: m }));
        },
      })),
    );
  };

  const resume = data.resume;

  return (
    <div class="live">
      <div class="col-cats">
        <div class="col-head">
          <span class="accent"><Glyph n="prompt" /></span> {kind === 'movie' ? '~/movies' : '~/series'} <span class="dim">ls</span>
        </div>
        <VGrid
          id="vc"
          items={cats}
          columns={1}
          rowHeight={80}
          height={980}
          initialIndex={initialCat}
          leadRows={2}
          onIndex={(i) => {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => select(i), 250);
          }}
          onKey={(k, i) => {
            if (k.key === 'yellow' || k.key === 'menu') return catMenu(cats[i]), true;
            if (k.key === 'red') return cats[i] && cats[i].view ? (favoriteCategoryToggle(cats[i].view!), true) : false;
            if (k.key === 'green') return sortMenu(), true;
            if (k.key === 'right' || k.key === 'enter') {
              clearTimeout(timer.current);
              select(i);
              setTimeout(() => focusById('vg:0'), 30);
              return true;
            }
            return false;
          }}
          render={(c, i, cell) => (
            <div key={c.id} class={'list-item' + (i === catIdx ? ' active' : '')} style={{ width: 376 }} {...focusable(cell)}>
              <span class="name">
                {c.view && isViewLocked(c.view) ? <Glyph n="lock" gap /> : ''}
                {c.icon && <Glyph n={c.icon} gap />}
                {c.name}
              </span>
              <span class="meta">{c.count}</span>
            </div>
          )}
        />
      </div>
      <div style={{ flex: 1, padding: '26px 0 0 40px', overflow: 'hidden' }}>
        <div class="col-head ellipsis" style={{ padding: '0 0 16px' }}>
          <span class="accent"><Glyph n="prompt" /></span> {cat.name} <span class="faint">({items.length})</span>
        </div>
        {items.length ? (
          <VGrid
            key={cat.id + '|' + data.categories[kind].itemSort}
            id="vg"
            items={items}
            columns={6}
            rowHeight={420}
            height={1000}
            onKey={(k, i) => {
              const it = items[i];
              if (k.key === 'red') return favoriteToggle(it), true;
              if (k.key === 'yellow' || k.key === 'menu') return itemMenu(it), true;
              if (k.key === 'green') return sortMenu(), true;
              if (k.key === 'left' && i % 6 === 0) return focusById(`vc:${catIdx}`), true;
              return false;
            }}
            render={(it, _i, cell) => {
              const r = resume[it.key];
              return (
                <div key={it.key} style={{ padding: '14px 4px 0 6px' }}>
                  <PosterCard
                    item={it}
                    id={cell.id}
                    onFocus={cell.onFocus}
                    favorite={data.favorites.indexOf(it.key) >= 0}
                    progress={r ? r.pos / r.dur : undefined}
                    onEnter={() => openItem(it)}
                  />
                </div>
              );
            }}
          />
        ) : (
          <div class="dim">{t('vod.noItems')}</div>
        )}
      </div>
      <div class="hints" style={{ left: 'auto', right: 60 }}>
        <span class="color-key red" />
        {t('hints.favorite')}
        <span class="color-key green" />
        {t('hints.sort')}
        <span class="color-key yellow" />
        {t('hints.options')}
      </div>
    </div>
  );
}

function continueList(kind: 'movie' | 'series'): Item[] {
  const d = user.get().data;
  const out: Item[] = [];
  for (const h of d.history) {
    if (h.kind !== kind) continue;
    const key = kind === 'series' && h.episodeKey ? h.episodeKey : h.key;
    if (!d.resume[key]) continue;
    const it = itemByKey(h.key);
    if (it) out.push(it);
  }
  return out;
}
