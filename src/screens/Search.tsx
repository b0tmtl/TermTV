import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel, Item } from '@/core/models';
import { cleanTitle } from '@/core/normalize';
import { formatTime, t } from '@/i18n';
import { focusById, focusable, keyHandler } from '@/navigation/focus';
import { navigate, updateRoute } from '@/navigation/router';
import { libraryState, search, viewOfItem, type SearchOutput, type SearchScope } from '@/state/library';
import { play } from '@/state/player';
import { useStore } from '@/state/store';
import { addRecentSearch, updateData, user } from '@/state/user';
import { Img, ItemCard, Prompt } from '@/ui/Cards';
import { favoriteToggle, itemMenu, openItem, unlockIfNeeded } from '@/ui/actions';
import { Keyboard } from '@/ui/Keyboard';
import { Row } from '@/ui/Row';
import { typedChar } from '@/ui/typing';
import { VGrid } from '@/ui/VGrid';

const SCOPES: SearchScope[] = ['all', 'live', 'vod', 'movie', 'series', 'guide'];
const ROW_LIMIT = 30;

export function SearchScreen(props: { scope?: string; q?: string }) {
  const [q, setQ] = useState(props.q || '');
  const [scope, setScope] = useState<SearchScope>((SCOPES.indexOf(props.scope as SearchScope) >= 0 ? props.scope : 'all') as SearchScope);
  const [res, setRes] = useState<SearchOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = useStore(libraryState, (s) => s.searchReady);
  const recent = useStore(user, (s) => s.data.recentSearches);
  const clock24 = useStore(user, (s) => s.data.settings.clock24h);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!q.trim()) {
      setRes(null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      search(q, scope, scope === 'all' ? ROW_LIMIT : 400).then((r) => {
        if (n !== seq.current) return; // a newer query is on its way
        setRes(r);
        setBusy(false);
      });
    }, 120);
    updateRoute({ q, scope } as never);
    return () => clearTimeout(timer);
  }, [q, scope, ready]);

  const open = (item: Item, list?: Channel[]) => {
    addRecentSearch(q);
    openItem(item, list);
  };
  const playGuide = async (ch: Channel) => {
    addRecentSearch(q);
    if (!(await unlockIfNeeded(ch))) return;
    await play({ kind: 'live', channel: ch, list: [ch] });
    navigate({ name: 'player' });
  };
  const cardKeys = (item: Item) => (k: { key: string }) => {
    if (k.key === 'red') return favoriteToggle(item), true;
    if (k.key === 'yellow' || k.key === 'menu') return itemMenu(item), true;
    return false;
  };

  const items = res ? res.items : [];
  const byKind = (kind: Item['kind']) => items.filter((h) => h.item.kind === kind);
  const totals = res ? res.totals : { live: 0, movie: 0, series: 0, programme: 0 };
  const count = (s: SearchScope) =>
    s === 'all' ? totals.live + totals.movie + totals.series + totals.programme
      : s === 'vod' ? totals.movie + totals.series
      : s === 'guide' ? totals.programme
      : totals[s as 'live' | 'movie' | 'series'];

  const results = () => {
    if (!q.trim()) {
      return (
        <div class="empty">
          {t('search.hint')}
          {!ready && <div class="faint" style={{ marginTop: 14 }}>{t('search.indexing')}</div>}
        </div>
      );
    }
    if (!res) return <div class="empty"><span class="spinner" /></div>;
    if (!items.length && !res.guide.length) return <div class="empty">{t('search.noResults', { q })}</div>;

    if (scope === 'all') {
      const live = byKind('live');
      const movies = byKind('movie');
      const series = byKind('series');
      return (
        <div class="rows" data-scroll="y" data-scroll-pad="140" style={{ height: '100%' }}>
          {live.length > 0 && (
            <Row path={t('search.channels')} count={totals.live} id="sr-live">
              {live.map((h) => (
                <ItemCard key={h.item.key} id={'s:' + h.item.key} item={h.item} sub={categoryName(h.item)} onEnter={() => open(h.item, live.map((x) => x.item) as Channel[])} onKey={cardKeys(h.item)} />
              ))}
              {totals.live > live.length && <SeeAll onEnter={() => switchScope('live')} />}
            </Row>
          )}
          {movies.length > 0 && (
            <Row path={t('search.movies')} count={totals.movie} id="sr-movie">
              {movies.map((h) => (
                <ItemCard key={h.item.key} id={'s:' + h.item.key} item={h.item} badge={h.variants.length ? `×${h.variants.length + 1}` : undefined} onEnter={() => open(h.item)} onKey={cardKeys(h.item)} />
              ))}
              {totals.movie > movies.length && <SeeAll onEnter={() => switchScope('movie')} />}
            </Row>
          )}
          {series.length > 0 && (
            <Row path={t('search.series')} count={totals.series} id="sr-series">
              {series.map((h) => (
                <ItemCard key={h.item.key} id={'s:' + h.item.key} item={h.item} badge={h.variants.length ? `×${h.variants.length + 1}` : undefined} onEnter={() => open(h.item)} onKey={cardKeys(h.item)} />
              ))}
              {totals.series > series.length && <SeeAll onEnter={() => switchScope('series')} />}
            </Row>
          )}
          {res.guide.length > 0 && (
            <Row path={t('search.guide')} count={res.guide.length} id="sr-guide">
              {res.guide.slice(0, ROW_LIMIT).map((g, i) => (
                <GuideHit key={i} g={g} clock24={clock24} onEnter={() => playGuide(g.channel)} />
              ))}
            </Row>
          )}
        </div>
      );
    }
    if (scope === 'guide') {
      return (
        <VGrid
          id="sg"
          items={res.guide}
          columns={1}
          rowHeight={106}
          height={860}
          render={(g, i, cell) => <GuideHit key={i} g={g} clock24={clock24} cell={cell} onEnter={() => playGuide(g.channel)} />}
        />
      );
    }
    const list = items.map((h) => h.item);
    const live = scope === 'live';
    return (
      <VGrid
        key={scope}
        id="sg"
        items={list}
        columns={4}
        rowHeight={live ? 230 : 420}
        height={860}
        onKey={(k, i) => cardKeys(list[i])(k)}
        render={(it, _i, cell) => (
          <div key={it.key} style={{ padding: '12px 2px 0 6px' }}>
            <ItemCard item={it} id={cell.id} onFocus={cell.onFocus} sub={live ? categoryName(it) : undefined} onEnter={() => open(it, live ? (list as Channel[]) : undefined)} />
          </div>
        )}
      />
    );
  };

  const switchScope = (s: SearchScope) => {
    setScope(s);
    setTimeout(() => focusById('scope:' + s), 30);
  };

  return (
    <div
      class="search"
      {...keyHandler((k) => {
        // Typing on a physical keyboard works anywhere on this screen.
        const c = typedChar(k);
        if (c) {
          setQ((v) => v + c);
          return true;
        }
        if (k.key === 'del') {
          setQ((v) => v.slice(0, -1));
          return true;
        }
        return false;
      })}
    >
      <div class="left">
        <Prompt path="~/search" cmd={`grep -ri "${q}"`} small />
        <div class="query">
          {q ? q : <span class="ph">{t('search.placeholder')}</span>}
          <span class="cursor-blink" />
          {res && <span class="took">{busy ? '…' : `${Math.round(res.tookMs)} ms`}</span>}
        </div>
        <div class="chips" style={{ flexWrap: 'wrap', marginBottom: 18 }} data-focus-memory="">
          {SCOPES.map((s) => (
            <span
              key={s}
              class={'chip' + (s === scope ? ' active' : '')}
              style={{ marginBottom: 12 }}
              {...focusable({ id: 'scope:' + s, onEnter: () => setScope(s) })}
            >
              {t('search.scope.' + s)}
              {res && <span class="n">{count(s)}</span>}
            </span>
          ))}
        </div>
        <Keyboard value={q} onChange={setQ} />
        {recent.length > 0 && !q && (
          <div class="recent">
            <div class="dim" style={{ fontSize: 21, marginBottom: 10 }}>
              {t('search.recent')}
            </div>
            <div class="chips" style={{ flexWrap: 'wrap' }}>
              {recent.slice(0, 8).map((r) => (
                <span key={r} class="chip" style={{ marginBottom: 12 }} {...focusable({ onEnter: () => setQ(r) })}>
                  {r}
                </span>
              ))}
              <span class="chip" style={{ marginBottom: 12 }} {...focusable({ onEnter: () => updateData(() => ({ recentSearches: [] })) })}>
                {t('search.clearRecent')}
              </span>
            </div>
          </div>
        )}
      </div>
      <div class="right">{results()}</div>
    </div>
  );
}

/** Channels often share a name across countries ("CNN" in US, UK, CA): show where each one lives. */
function categoryName(item: Item): string {
  const v = viewOfItem(item);
  return v ? v.name : '';
}

function SeeAll({ onEnter }: { onEnter: () => void }) {
  return (
    <div class="card poster" {...focusable({ onEnter })}>
      <div class="art">
        <div class="ph">{t('home.seeAll')} →</div>
      </div>
    </div>
  );
}

function GuideHit({ g, clock24, onEnter, cell }: { g: { channel: Channel; programme: { start: number; end: number; title: string } }; clock24: boolean; onEnter: () => void; cell?: { id: string; onFocus: () => void } }) {
  const now = Date.now();
  const on = g.programme.start <= now && g.programme.end > now;
  return (
    <div class="guide-hit" {...focusable({ ...(cell || {}), onEnter })}>
      <span class="logo">{g.channel.image ? <Img src={g.channel.image} alt="" /> : null}</span>
      <span class="tx">
        <div class="t">
          {on && <span class="on">● {t('search.onNow')}</span>}
          {g.programme.title}
        </div>
        <div class="s">
          {formatTime(g.programme.start, clock24)} – {formatTime(g.programme.end, clock24)} · {cleanTitle(g.channel.name)}
        </div>
      </span>
    </div>
  );
}
