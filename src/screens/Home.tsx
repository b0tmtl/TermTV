import type { Channel, Item } from '@/core/models';
import { Glyph } from '@/ui/Glyph';
import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { navigate } from '@/navigation/router';
import { isItemLocked, itemByKey, libraryState, nowNext, recentlyAdded, suggestions } from '@/state/library';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { ItemCard, Prompt } from '@/ui/Cards';
import { favoriteToggle, itemMenu, openItem } from '@/ui/actions';
import { Icon } from '@/ui/icons';
import { Row } from '@/ui/Row';
import { stageLabel } from './Sources';

const MAX = 40;

function cardKeys(item: Item) {
  return (k: { key: string }) => {
    if (k.key === 'red') return favoriteToggle(item), true;
    if (k.key === 'yellow' || k.key === 'menu') return itemMenu(item), true;
    return false;
  };
}

export function HomeScreen() {
  const status = useStore(libraryState, (s) => s.status);
  const stage = useStore(libraryState, (s) => s.stage);
  useStore(libraryState, (s) => s.version);
  useStore(libraryState, (s) => s.epgVersion);
  const refreshing = useStore(libraryState, (s) => s.refreshing);
  const errors = useStore(libraryState, (s) => s.errors);
  const data = useStore(user, (s) => s.data);
  const sources = useStore(user, (s) => s.sources);

  if (status !== 'ready') {
    const ids = Object.keys(refreshing);
    const errIds = Object.keys(errors);
    return (
      <div class="screen-pad">
        <Prompt path="~/home" cmd="./init.sh" />
        {status === 'loading' || ids.length ? (
          <div style={{ fontSize: 28, marginTop: 60 }}>
            <span class="spinner" style={{ marginRight: 24 }} />
            {t('home.loading')}
            {stage && (
              <div class="status-line" style={{ marginTop: 16 }}>
                {t(stage === 'readCache' ? 'home.readingCache' : 'home.decodingCache')}
              </div>
            )}
            {ids.map((id) => (
              <div key={id} class="status-line" style={{ marginTop: 16 }}>
                {(sources.find((s) => s.id === id) || { name: id }).name}: {stageLabel(refreshing[id].stage, refreshing[id].loaded, refreshing[id].total)}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 40 }}>
            <div style={{ fontSize: 28, marginBottom: 30 }}>{sources.length ? t('home.emptyLibrary') : t('home.noSources')}</div>
            {errIds.map((id) => (
              <div key={id} class="bad" style={{ marginBottom: 20 }}>
                <Glyph n="cross" gap />{(sources.find((s) => s.id === id) || { name: id }).name}: {errors[id]}
              </div>
            ))}
            <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => navigate({ name: 'addSource' }) })}>
              <Icon name="plus" />
              {t('sources.add')}
            </span>
            {sources.length > 0 && (
              <span class="btn" {...focusable({ onEnter: () => navigate({ name: 'settings', section: 'sources' }) })}>
                {t('settings.sources')}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  const ok = (i: Item | undefined): i is Item => !!i && !isItemLocked(i);

  // Continue watching: movies and series with a resume point, most recent first.
  const continueItems: Array<{ item: Item; progress: number; sub?: string }> = [];
  for (const h of data.history) {
    if (continueItems.length >= MAX) break;
    if (h.kind === 'live') continue;
    const item = itemByKey(h.key);
    if (!ok(item)) continue;
    const r = data.resume[h.kind === 'series' && h.episodeKey ? h.episodeKey : h.key];
    if (!r) continue;
    continueItems.push({ item, progress: r.pos / r.dur });
  }

  const recentChannels = data.settings.showRecent
    ? data.history.filter((h) => h.kind === 'live').map((h) => itemByKey(h.key)).filter(ok).slice(0, MAX) as Channel[]
    : [];
  const favs = data.favorites.map((k) => itemByKey(k)).filter(ok);
  const favChannels = favs.filter((i) => i.kind === 'live') as Channel[];
  const favMovies = favs.filter((i) => i.kind === 'movie');
  const favSeries = favs.filter((i) => i.kind === 'series');
  const suggested = suggestions(MAX);
  const newMovies = recentlyAdded('movie', MAX);
  const newSeries = recentlyAdded('series', MAX);

  const nowSub = (c: Channel) => {
    const n = nowNext(c).now;
    return n ? n.title : '';
  };

  let rowIdx = 0;
  const rid = () => 'r' + rowIdx++;

  return (
    <div class="screen-pad rows" data-scroll="y" data-scroll-pad="160" style={{ height: '100%' }}>
      <Prompt path="~/home" cmd="./init.sh" />
      {continueItems.length > 0 && (
        <Row path="~/continue" cmd="ls" id={rid()}>
          {continueItems.map(({ item, progress }) => (
            <ItemCard key={item.key} id={'cw:' + item.key} item={item} progress={progress} onEnter={() => openItem(item)} onKey={cardKeys(item)} />
          ))}
        </Row>
      )}
      {recentChannels.length > 0 && (
        <Row path="~/recent/channels" cmd="ls" id={rid()}>
          {recentChannels.map((c) => (
            <ItemCard key={c.key} id={'rc:' + c.key} item={c} sub={nowSub(c)} onEnter={() => openItem(c, recentChannels)} onKey={cardKeys(c)} />
          ))}
        </Row>
      )}
      {favChannels.length > 0 && (
        <Row path="~/favorites/channels" cmd="ls" count={favChannels.length} id={rid()}>
          {favChannels.slice(0, MAX * 2).map((c) => (
            <ItemCard key={c.key} id={'fc:' + c.key} item={c} favorite sub={nowSub(c)} onEnter={() => openItem(c, favChannels)} onKey={cardKeys(c)} />
          ))}
        </Row>
      )}
      {favMovies.length > 0 && (
        <Row path="~/favorites/movies" cmd="ls" count={favMovies.length} id={rid()}>
          {favMovies.slice(0, MAX * 2).map((m) => (
            <ItemCard key={m.key} id={'fm:' + m.key} item={m} favorite onEnter={() => openItem(m)} onKey={cardKeys(m)} />
          ))}
        </Row>
      )}
      {favSeries.length > 0 && (
        <Row path="~/favorites/series" cmd="ls" count={favSeries.length} id={rid()}>
          {favSeries.slice(0, MAX * 2).map((m) => (
            <ItemCard key={m.key} id={'fs:' + m.key} item={m} favorite onEnter={() => openItem(m)} onKey={cardKeys(m)} />
          ))}
        </Row>
      )}
      {data.lists.map((l) => {
        const items = l.items.map((k) => itemByKey(k)).filter(ok);
        if (!items.length) return null;
        const chans = items.filter((i) => i.kind === 'live') as Channel[];
        return (
          <Row key={l.id} path={`~/lists/${slug(l.name)}`} cmd="ls" count={items.length} id={rid()}>
            {items.slice(0, MAX).map((i) => (
              <ItemCard key={i.key} id={`l:${l.id}:${i.key}`} item={i} onEnter={() => openItem(i, chans)} onKey={cardKeys(i)} />
            ))}
            <div class="card poster" {...focusable({ id: 'lall:' + l.id, onEnter: () => navigate({ name: 'list', listId: l.id }) })}>
              <div class="art">
                <div class="ph">{t('home.seeAll')} <Glyph n="arrow" /></div>
              </div>
            </div>
          </Row>
        );
      })}
      {suggested.length > 0 && (
        <Row path="~/suggested" cmd="./suggest.sh" id={rid()}>
          {suggested.map((i) => (
            <ItemCard key={i.key} id={'sg:' + i.key} item={i} onEnter={() => openItem(i)} onKey={cardKeys(i)} />
          ))}
        </Row>
      )}
      {newMovies.length > 0 && (
        <Row path="~/movies/new" cmd="ls -t" id={rid()}>
          {newMovies.map((i) => (
            <ItemCard key={i.key} id={'nm:' + i.key} item={i} onEnter={() => openItem(i)} onKey={cardKeys(i)} />
          ))}
        </Row>
      )}
      {newSeries.length > 0 && (
        <Row path="~/series/new" cmd="ls -t" id={rid()}>
          {newSeries.map((i) => (
            <ItemCard key={i.key} id={'ns:' + i.key} item={i} onEnter={() => openItem(i)} onKey={cardKeys(i)} />
          ))}
        </Row>
      )}
      {rowIdx === 0 && (
        <div style={{ marginTop: 30 }}>
          <div class="dim" style={{ fontSize: 26, marginBottom: 26 }}>{t('home.startHint')}</div>
          <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => navigate({ name: 'live' }) })}>
            <Icon name="live" />
            {t('nav.live')}
          </span>
          <span class="btn" {...focusable({ onEnter: () => navigate({ name: 'vod', kind: 'movie' }) })}>
            <Icon name="movie" />
            {t('nav.movies')}
          </span>
        </div>
      )}
    </div>
  );
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list';
}
