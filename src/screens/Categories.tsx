// Manage categories for Live TV, Movies or Series: sort, hide / show (one by one, by prefix group,
// or everything matching a filter), reorder by hand, and lock with the parental PIN.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import {
  filterViews, isHidden, isNew, markKnown, moveCategory, prefixGroups, setHidden, sortCategoryViews, type CategorySort, type CategoryView,
} from '@/core/categories';
import type { MediaKind } from '@/core/models';
import { t } from '@/i18n';
import { focusById, focusable } from '@/navigation/focus';
import { replace } from '@/navigation/router';
import type { KeyInfo } from '@/platform/tv';
import { allViews, isViewLocked, countInView, libraryState } from '@/state/library';
import { useStore } from '@/state/store';
import { updateCategoryPrefs, updateData, user } from '@/state/user';
import { Prompt } from '@/ui/Cards';
import { promptText, showMenu } from '@/ui/Dialog';
import { askPin, favoriteCategoryOption } from '@/ui/actions';
import { VGrid } from '@/ui/VGrid';
import { toast } from '@/ui/ui-state';

const KINDS: MediaKind[] = ['live', 'movie', 'series'];
const SORTS: CategorySort[] = ['provider', 'az', 'za', 'custom', 'mostWatched'];

export function CategoriesScreen({ kind }: { kind: MediaKind }) {
  useStore(libraryState, (s) => s.version);
  const prefs = useStore(user, (s) => s.data.categories[kind]);
  const locked = useStore(user, (s) => s.data.locked);
  const hasPin = useStore(user, (s) => !!s.app.parentalPin);
  const [filter, setFilter] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const views = allViews(kind);
  const sorted = useMemo(() => sortCategoryViews(views, prefs), [views, prefs]);
  const shown = useMemo(() => filterViews(sorted, filter), [sorted, filter]);
  const groups = useMemo(() => prefixGroups(views, prefs), [views, prefs]);
  const hiddenCount = views.filter((v) => isHidden(v, prefs)).length;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const v of views) m[v.id] = countInView(v);
    return m;
  }, [views]);

  // Leaving the screen: everything seen here is no longer "new".
  useEffect(() => () => updateCategoryPrefs(kind, (p) => markKnown(p, allViews(kind))), [kind]);

  const toggle = (v: CategoryView) => updateCategoryPrefs(kind, (p) => setHidden(p, [v], !isHidden(v, p)));

  const toggleGroup = (ids: string[], hide: boolean) => {
    const list = views.filter((v) => ids.indexOf(v.id) >= 0);
    updateCategoryPrefs(kind, (p) => setHidden(p, list, hide));
  };

  const move = (v: CategoryView, op: 'up' | 'down' | 'top' | 'bottom') => {
    if (filter) return toast(t('categories.clearFilterToMove'));
    updateCategoryPrefs(kind, (p) => moveCategory(p, sortCategoryViews(allViews(kind), p), v.id, op));
    const order = sortCategoryViews(allViews(kind), user.get().data.categories[kind]);
    const ni = order.findIndex((x) => x.id === v.id);
    setIndex(ni);
    setTimeout(() => focusById('cm:' + ni), 20);
  };

  const toggleLock = async (v: CategoryView) => {
    if (!hasPin) return toast(t('parental.setPinFirst'));
    if (!(await askPin())) return;
    updateData((d) => ({ locked: isViewLocked(v) ? d.locked.filter((id) => id !== v.id) : d.locked.concat([v.id]) }));
  };

  const rowMenu = (v: CategoryView) =>
    showMenu(v.name, [
      favoriteCategoryOption(v),
      { label: isHidden(v, prefs) ? t('categories.show') : t('categories.hide'), onSelect: () => toggle(v) },
      { label: t('categories.pickUp'), onSelect: () => (filter ? toast(t('categories.clearFilterToMove')) : setMoving(v.id)) },
      { label: t('categories.moveTop'), onSelect: () => move(v, 'top') },
      { label: t('categories.moveBottom'), onSelect: () => move(v, 'bottom') },
      { label: isViewLocked(v) ? t('parental.unlockCategory') : t('parental.lockCategory'), onSelect: () => toggleLock(v) },
      ...(v.prefix
        ? [{ label: t('categories.hideGroup', { prefix: v.prefix }), onSelect: () => toggleGroup(views.filter((x) => x.prefix === v.prefix).map((x) => x.id), true) }]
        : []),
      ...(v.suffix
        ? [{ label: t('categories.hideGroup', { prefix: '[' + v.suffix + ']' }), onSelect: () => toggleGroup(views.filter((x) => x.suffix === v.suffix).map((x) => x.id), true) }]
        : []),
    ]);

  const onRowKey = (k: KeyInfo, i: number): boolean => {
    const v = shown[i];
    if (!v) return false;
    if (moving) {
      if (k.key === 'up' || k.key === 'down') {
        move(v, k.key);
        return true;
      }
      if (k.key === 'enter' || k.key === 'back' || k.key === 'green') {
        setMoving(null);
        return true;
      }
      return true; // nothing else while moving
    }
    if (k.key === 'green') {
      if (filter) return toast(t('categories.clearFilterToMove')), true;
      setMoving(v.id);
      return true;
    }
    if (k.key === 'yellow' || k.key === 'menu') return rowMenu(v), true;
    if (k.key === 'blue') return toggleLock(v), true;
    return false;
  };

  return (
    <div class="screen-pad" style={{ paddingTop: 30 }}>
      <Prompt path={`~/settings/categories/${kind}`} cmd="ls -la" count={t('categories.counts', { total: views.length, hidden: hiddenCount })} />
      <div class="chips" data-focus-memory="" style={{ marginBottom: 6 }}>
        {KINDS.map((k) => (
          <span key={k} class={'chip' + (k === kind ? ' active' : '')} {...focusable({ id: 'ck:' + k, onEnter: () => replace({ name: 'categories', kind: k }) })}>
            {t('categories.kind.' + k)}
          </span>
        ))}
        <span style={{ width: 40, flexShrink: 0 }} />
        <span
          class="chip"
          {...focusable({
            onEnter: () =>
              showMenu(
                t('categories.sortBy'),
                SORTS.map((s) => ({ label: t('categories.sort.' + s), checked: prefs.sort === s, onSelect: () => updateCategoryPrefs(kind, (p) => ({ ...p, sort: s })) })),
              ),
          })}
        >
          {t('categories.sortLabel')}: {t('categories.sort.' + prefs.sort)}
        </span>
        <span class="chip" {...focusable({ onEnter: () => updateCategoryPrefs(kind, (p) => ({ ...p, mergeSameName: !p.mergeSameName })) })}>
          {t('categories.merge')}: {prefs.mergeSameName ? t('common.on') : t('common.off')}
        </span>
        <span class="chip" {...focusable({ onEnter: () => updateCategoryPrefs(kind, (p) => setHidden(p, filter ? shown : views, false)) })}>
          {filter ? t('categories.showMatching') : t('categories.showAll')}
        </span>
        <span class="chip" {...focusable({ onEnter: () => updateCategoryPrefs(kind, (p) => setHidden(p, filter ? shown : views, true)) })}>
          {filter ? t('categories.hideMatching') : t('categories.hideAll')}
        </span>
        <span
          class={'chip' + (filter ? ' active' : '')}
          {...focusable({
            onEnter: async () => {
              const v = await promptText(t('categories.filter'), filter);
              if (v !== null) setFilter(v);
            },
          })}
        >
          <Glyph n="search" gap />{filter ? `"${filter}"` : t('categories.filter')}
        </span>
      </div>
      {groups.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div class="dim" style={{ fontSize: 20, margin: '4px 0 4px 4px' }}>{t('categories.groups')}</div>
          <div class="chips" data-scroll="x" data-focus-memory="">
            {groups.map((g) => {
              const allHidden = g.hiddenCount === g.ids.length;
              return (
                <span key={(g.type || 'prefix') + g.prefix} class={'chip' + (allHidden ? '' : ' active')} {...focusable({ onEnter: () => toggleGroup(g.ids, !allHidden) })}>
                  <Glyph n={allHidden ? 'box' : g.hiddenCount ? 'boxHalf' : 'boxCheck'} gap />{g.prefix}
                  <span class="n">{g.ids.length - g.hiddenCount}/{g.ids.length}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
      {shown.length ? (
        <VGrid
          key={kind + '|' + filter}
          id="cm"
          items={shown}
          columns={1}
          rowHeight={80}
          height={groups.length ? 640 : 740}
          initialIndex={index}
          leadRows={2}
          onIndex={setIndex}
          onKey={onRowKey}
          render={(v, _i, cell) => {
            const hidden = isHidden(v, prefs);
            return (
              <div
                key={v.id}
                class={'cat-row' + (hidden ? ' off' : '') + (moving === v.id ? ' moving' : '')}
                style={{ width: 1600 }}
                {...focusable({ ...cell, onEnter: () => (moving ? setMoving(null) : toggle(v)) })}
              >
                <span class="box">{hidden ? '' : <Glyph n="check" />}</span>
                <span class="nm">
                  {moving === v.id ? <Glyph n="updown" gap /> : ''}
                  {v.name}
                </span>
                {locked.some((id) => id === v.id) || isViewLocked(v) ? <span class="cnt"><Glyph n="lock" /></span> : null}
                {isNew(v, prefs) && <span class="tag">{t('categories.new')}</span>}
                {v.sourceIds.length > 1 && <span class="cnt">{t('categories.sources', { count: v.sourceIds.length })}</span>}
                <span class="cnt">{counts[v.id] || 0}</span>
              </div>
            );
          }}
        />
      ) : (
        <div class="dim" style={{ marginTop: 20 }}>{t('categories.none')}</div>
      )}
      <div class="hints">
        {moving ? (
          t('categories.movingHint')
        ) : (
          <>
            <span class="kbd">OK</span> {t('categories.hintToggle')}
            <span class="color-key green" />
            {t('categories.hintMove')}
            <span class="color-key yellow" />
            {t('hints.options')}
            <span class="color-key blue" />
            {t('categories.hintLock')}
          </>
        )}
      </div>
    </div>
  );
}
