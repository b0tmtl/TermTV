import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import { moveCategory, setHidden, sortCategoryViews, type CategoryView, type ItemSort } from '@/core/categories';
import type { Channel } from '@/core/models';
import { cleanTitle } from '@/core/normalize';
import { formatTime, t } from '@/i18n';
import { focusById, focusable } from '@/navigation/focus';
import { navigate, updateRoute } from '@/navigation/router';
import {
  allViews, browseViews, fetchShortEpg, invalidateItemCache, isViewLocked, itemByKey, itemsInView, libraryState, nowNext,
} from '@/state/library';
import { play, player, setWindow, stop } from '@/state/player';
import { useStore } from '@/state/store';
import { updateCategoryPrefs, updateData, user } from '@/state/user';
import { Img, Prompt } from '@/ui/Cards';
import { showMenu, type MenuOption } from '@/ui/Dialog';
import { askPin, favoriteToggle, itemMenu, unlockIfNeeded } from '@/ui/actions';
import { VGrid } from '@/ui/VGrid';
import { toast } from '@/ui/ui-state';
import type { Programme } from '@/core/models';

export const FAV_ID = '@favorites';
export const RECENT_ID = '@recent';
export const ALL_ID = '@all';

interface CatEntry {
  id: string;
  name: string;
  icon?: string;
  view?: CategoryView;
  count: number;
}

export function liveCategories(): CatEntry[] {
  const d = user.get().data;
  const out: CatEntry[] = [];
  const favCount = d.favorites.filter((k) => k.indexOf(':live:') > 0 && itemByKey(k)).length;
  if (favCount) out.push({ id: FAV_ID, name: t('live.favorites'), icon: 'star', count: favCount });
  const recent = d.history.filter((h) => h.kind === 'live' && itemByKey(h.key)).length;
  if (recent && d.settings.showRecent) out.push({ id: RECENT_ID, name: t('live.recent'), icon: 'recent', count: recent });
  const views = browseViews('live');
  let total = 0;
  const entries = views.map((v) => {
    const count = itemsInView(v).length;
    total += count;
    return { id: v.id, name: v.name, view: v, count };
  });
  out.push({ id: ALL_ID, name: t('live.all'), count: total });
  return out.concat(entries);
}

export function channelsFor(id: string): Channel[] {
  const d = user.get().data;
  if (id === FAV_ID) return d.favorites.map((k) => itemByKey(k)).filter((i) => i && i.kind === 'live') as Channel[];
  if (id === RECENT_ID) return d.history.filter((h) => h.kind === 'live').map((h) => itemByKey(h.key)).filter(Boolean) as Channel[];
  const views = browseViews('live');
  if (id === ALL_ID) return views.reduce<Channel[]>((acc, v) => acc.concat(isViewLocked(v) && !user.get().unlocked ? [] : (itemsInView(v) as Channel[])), []);
  const v = views.find((x) => x.id === id) || allViews('live').find((x) => x.id === id);
  return v ? (itemsInView(v) as Channel[]) : [];
}

const ROW_CAT = 76;
const ROW_CHAN = 96;

export function LiveScreen({ categoryId, channelKey }: { categoryId?: string; channelKey?: string }) {
  useStore(libraryState, (s) => s.version);
  useStore(libraryState, (s) => s.epgVersion);
  const data = useStore(user, (s) => s.data);
  const unlocked = useStore(user, (s) => s.unlocked);
  const playingKey = useStore(player, (s) => (s.target && s.target.kind === 'live' ? s.target.channel.key : ''));
  const playStatus = useStore(player, (s) => s.status);
  const clock24 = data.settings.clock24h;

  const cats = useMemo(() => liveCategories(), [data.categories.live, data.favorites, data.history, data.locked, unlocked, libraryState.get().version]);
  // The selection is kept by id: pseudo-categories (Favorites, Recent) come and go and shift indexes.
  const [catId, setCatId] = useState(categoryId && cats.some((c) => c.id === categoryId) ? categoryId : cats[0] ? cats[0].id : '');
  const found = cats.findIndex((c) => c.id === catId);
  const catIdx = found >= 0 ? found : 0;
  const initialCat = catIdx;
  const cat = cats[catIdx];
  const channels = useMemo(() => (cat ? channelsFor(cat.id) : []), [cat && cat.id, data.categories.live.itemSort, data.favorites, libraryState.get().version]);
  const initialChan = channelKey ? Math.max(0, channels.findIndex((c) => c.key === channelKey)) : 0;
  const [chanIdx, setChanIdx] = useState(initialChan);
  const focusedChannel = channels[Math.min(chanIdx, channels.length - 1)];
  const [epg, setEpg] = useState<Programme[]>([]);
  const hole = useRef<HTMLDivElement>(null);
  const catTimer = useRef<ReturnType<typeof setTimeout>>();

  // Preview window follows the hole in the layout.
  const placeWindow = () => {
    if (!hole.current) return;
    const r = hole.current.getBoundingClientRect();
    setWindow({ x: r.left, y: r.top, w: r.width, h: r.height });
  };
  useLayoutEffect(() => {
    if (player.get().target) placeWindow();
  });
  useEffect(() => () => {
    if (player.get().windowed) stop();
  }, []);

  // Guide info for the focused channel (Xtream short EPG when there is no XMLTV).
  useEffect(() => {
    if (!focusedChannel) return setEpg([]);
    let live = true;
    const t0 = setTimeout(() => {
      fetchShortEpg(focusedChannel).then((p) => live && setEpg(p));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t0);
    };
  }, [focusedChannel && focusedChannel.key, libraryState.get().epgVersion]);

  useEffect(() => {
    if (cat) updateRoute({ categoryId: cat.id } as never);
  }, [cat && cat.id]);

  if (!cats.length || !cat) {
    return (
      <div class="screen-pad">
        <Prompt path="~/live" cmd="ls" />
        <div class="dim">{t('live.empty')}</div>
      </div>
    );
  }

  const selectCat = (i: number) => {
    if (i === catIdx || !cats[i]) return;
    setCatId(cats[i].id);
    setChanIdx(0);
  };

  const openChannel = async (ch: Channel) => {
    if (!(await unlockIfNeeded(ch))) return;
    if (playingKey === ch.key) {
      setWindow(null);
      navigate({ name: 'player' });
      return;
    }
    const r = hole.current ? hole.current.getBoundingClientRect() : null;
    await play({ kind: 'live', channel: ch, list: channels }, { windowed: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null });
  };

  const catMenu = (c: CatEntry) => {
    const v = c.view;
    if (!v) return;
    const options: MenuOption[] = [
      {
        label: t('categories.hide'),
        onSelect: () => {
          updateCategoryPrefs('live', (p) => setHidden(p, [v], true));
          toast(t('categories.hidden', { name: v.name }));
          setCatId(cats[0] ? cats[0].id : '');
        },
      },
      { label: t('categories.moveTop'), onSelect: () => updateCategoryPrefs('live', (p) => moveCategory(p, sortCategoryViews(allViews('live'), p), v.id, 'top')) },
      {
        label: isViewLocked(v) ? t('parental.unlockCategory') : t('parental.lockCategory'),
        onSelect: async () => {
          if (!user.get().app.parentalPin) return toast(t('parental.setPinFirst'));
          if (!(await askPin())) return;
          updateData((d) => ({ locked: isViewLocked(v) ? d.locked.filter((id) => id !== v.id) : d.locked.concat([v.id]) }));
        },
      },
      { label: t('categories.manage'), onSelect: () => navigate({ name: 'categories', kind: 'live' }) },
    ];
    showMenu(v.name, options);
  };

  const sortMenu = () => {
    const cur = data.categories.live.itemSort;
    const modes: ItemSort[] = ['provider', 'number', 'az', 'za', 'recent'];
    showMenu(
      t('sort.channels'),
      modes.map((m) => ({
        label: t('sort.' + m),
        checked: cur === m,
        onSelect: () => {
          invalidateItemCache();
          updateCategoryPrefs('live', (p) => ({ ...p, itemSort: m }));
          setChanIdx(0);
        },
      })),
    );
  };

  const nn = focusedChannel ? nowNextFrom(epg, focusedChannel) : {};
  const width = 688;

  return (
    <div class="live">
      <div class="col-cats">
        <div class="col-head">
          <span class="accent"><Glyph n="prompt" /></span> ~/live <span class="dim">ls</span>
        </div>
        <VGrid
          key={'cats'}
          id="lc"
          items={cats}
          columns={1}
          rowHeight={ROW_CAT + 4}
          height={980}
          initialIndex={initialCat}
          leadRows={2}
          onIndex={(i) => {
            clearTimeout(catTimer.current);
            catTimer.current = setTimeout(() => selectCat(i), 250);
          }}
          onKey={(k, i) => {
            if (k.key === 'yellow' || k.key === 'menu') return catMenu(cats[i]), true;
            if (k.key === 'right' || k.key === 'enter') {
              clearTimeout(catTimer.current);
              if (i !== catIdx) {
                selectCat(i);
                setTimeout(() => focusById('lch:0'), 30);
              } else focusById(`lch:${chanIdx}`);
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
      <div class="col-chans">
        <div class="col-head ellipsis">
          <span class="accent"><Glyph n="prompt" /></span> {cat.name} <span class="faint">({channels.length})</span>
        </div>
        {channels.length ? (
          <VGrid
            key={cat.id}
            id="lch"
            items={channels}
            columns={1}
            rowHeight={ROW_CHAN + 4}
            height={980}
            initialIndex={initialChan}
            leadRows={2}
            onIndex={setChanIdx}
            onKey={(k, i) => {
              const ch = channels[i];
              if (k.key === 'red') return favoriteToggle(ch), true;
              if (k.key === 'yellow' || k.key === 'menu') return itemMenu(ch), true;
              if (k.key === 'green') return sortMenu(), true;
              if (k.key === 'left') return focusById(`lc:${catIdx}`), true;
              return false;
            }}
            render={(ch, i, cell) => {
              const now = nowNext(ch).now;
              return (
                <div key={ch.key} class="list-item chan-item" style={{ width: 616 }} {...focusable({ ...cell, onEnter: () => openChannel(ch) })}>
                  <span class="num">{ch.number || i + 1}</span>
                  <span class="logo">{ch.image ? <Img src={ch.image} alt="" /> : null}</span>
                  <span class="two">
                    <span class="name ellipsis">
                      {data.favorites.indexOf(ch.key) >= 0 ? <Glyph n="star" gap /> : ''}
                      {cleanTitle(ch.name)}
                    </span>
                    <span class="prog">{now ? `${formatTime(now.start, clock24)} ${now.title}` : ''}</span>
                  </span>
                  {playingKey === ch.key && <span class="playing"><Glyph n="play" /></span>}
                </div>
              );
            }}
          />
        ) : (
          <div class="dim" style={{ padding: 28 }}>{t('live.noChannels')}</div>
        )}
      </div>
      <div class="col-preview">
        <div ref={hole} class="preview-hole" style={{ left: 40, top: 34, width, height: Math.round((width * 9) / 16), boxShadow: playingKey ? undefined : 'none', background: playingKey ? 'transparent' : 'var(--panel)' }}>
          {playingKey && (playStatus === 'loading' || playStatus === 'buffering') && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <span class="spinner" />
            </div>
          )}
          {playingKey && playStatus === 'error' && (
            <div class="bad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 22, textAlign: 'center', padding: 30 }}>
              <Glyph n="cross" gap />{t('player.error')}
            </div>
          )}
          {!playingKey && (
            <div class="ph dim" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 22, textAlign: 'center', padding: 30 }}>
              {t('live.previewHint')}
            </div>
          )}
        </div>
        {focusedChannel && (
          <div class="preview-info" style={{ top: 34 + Math.round((width * 9) / 16) + 30 }}>
            <h2 class="ellipsis">{cleanTitle(focusedChannel.name)}</h2>
            {nn.now ? (
              <>
                <div class="when">
                  {formatTime(nn.now.start, clock24)} – {formatTime(nn.now.end, clock24)} · {nn.now.title}
                </div>
                <div class="progressbar">
                  <i style={{ width: Math.max(0, Math.min(100, ((Date.now() - nn.now.start) / (nn.now.end - nn.now.start)) * 100)) + '%' }} />
                </div>
                {nn.now.desc && <div class="desc clamp4">{nn.now.desc}</div>}
                {nn.next && (
                  <div class="next ellipsis">
                    {t('live.next')}: {formatTime(nn.next.start, clock24)} {nn.next.title}
                  </div>
                )}
              </>
            ) : (
              <div class="dim">{t('live.noGuide')}</div>
            )}
          </div>
        )}
        <div class="hints" style={{ left: 40 }}>
          <span class="color-key red" />
          {t('hints.favorite')}
          <span class="color-key green" />
          {t('hints.sort')}
          <span class="color-key yellow" />
          {t('hints.options')}
        </div>
      </div>
    </div>
  );
}

function nowNextFrom(list: Programme[], ch: Channel): { now?: Programme; next?: Programme } {
  if (!list.length) return nowNext(ch);
  const at = Date.now();
  for (let i = 0; i < list.length; i++) {
    if (list[i].start <= at && list[i].end > at) return { now: list[i], next: list[i + 1] };
    if (list[i].start > at) return { next: list[i] };
  }
  return {};
}
