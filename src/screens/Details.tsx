import { useEffect, useRef, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import type { Episode, Item, Movie, MovieDetails, Series, SeriesDetails } from '@/core/models';
import { cleanTitle, splitYear } from '@/core/normalize';
import { formatDuration, formatMinutes, t } from '@/i18n';
import { focusable, focused, focusFirst } from '@/navigation/focus';
import { navigate, replace } from '@/navigation/router';
import { itemByKey, libraryState, movieDetails, seriesDetails, variantsOf } from '@/state/library';
import { play } from '@/state/player';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { Img, Prompt } from '@/ui/Cards';
import { showMenu } from '@/ui/Dialog';
import { favoriteToggle, itemMenu } from '@/ui/actions';
import { Icon } from '@/ui/icons';

export function DetailsScreen({ itemKey }: { itemKey: string }) {
  const item = itemByKey(itemKey);
  const data = useStore(user, (s) => s.data);
  const sources = useStore(user, (s) => s.sources);
  const searchReady = useStore(libraryState, (s) => s.searchReady);
  const [details, setDetails] = useState<MovieDetails | SeriesDetails | null>(null);
  const [error, setError] = useState('');
  const [season, setSeason] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const autoFocused = useRef<HTMLElement | null>(null);

  // The Play / Resume button only exists once details load: move there unless the user already moved.
  useEffect(() => {
    autoFocused.current = focused();
  }, []);
  useEffect(() => {
    if (details && root.current && focused() === autoFocused.current) setTimeout(() => focusFirst(root.current!), 0);
  }, [details]);

  const [variants, setVariants] = useState<Item[]>([]);
  useEffect(() => {
    setVariants([]);
    if (!item || item.kind === 'live') return;
    let alive = true;
    variantsOf(item).then((v) => alive && setVariants(v));
    return () => {
      alive = false;
    };
  }, [itemKey, searchReady]);

  useEffect(() => {
    if (!item || item.kind === 'live') return;
    setDetails(null);
    const p = item.kind === 'movie' ? movieDetails(item) : seriesDetails(item);
    p.then(setDetails).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [itemKey]);

  if (!item || item.kind === 'live') {
    return <div class="center-msg">{t('details.notFound')}</div>;
  }

  const title = splitYear(cleanTitle(item.name)).title;
  const year = (details && details.year) || item.year || splitYear(item.name).year;
  const rating = (details && details.rating) || item.rating;
  const fav = data.favorites.indexOf(item.key) >= 0;

  const sourceName = (id: string) => (sources.find((s) => s.id === id) || { name: '' }).name;

  const meta: string[] = [];
  if (year) meta.push(String(year));
  if (rating) meta.push(t('details.rating', { value: (Math.round(rating * 10) / 10).toFixed(1) }));
  if (details && details.duration && item.kind === 'movie') meta.push(formatMinutes(details.duration));
  if (details && details.genre) meta.push(details.genre);
  if (sources.length > 1) meta.push(sourceName(item.sourceId));

  const versionsButton = variants.length > 0 && (
    <span
      class="btn"
      {...focusable({
        onEnter: () =>
          showMenu(
            t('details.versions'),
            ([item] as Item[]).concat(variants).map((v) => ({
              label: v.name,
              hint: sourceName(v.sourceId),
              checked: v.key === item.key,
              onSelect: () => replace({ name: 'details', key: v.key }),
            })),
          ),
      })}
    >
      {t('details.versionsCount', { count: variants.length + 1 })}
    </span>
  );

  let body;
  let seasonEps: Episode[] = [];
  let playEp: ((e: Episode, startAt?: number) => void) | null = null;
  if (item.kind === 'movie') {
    const movie = item as Movie;
    const r = data.resume[movie.key];
    body = (
      <div class="actions">
        {r ? (
          <>
            <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => play({ kind: 'movie', movie }, { startAt: r.pos }).then(() => navigate({ name: 'player' })) })}>
              <Icon name="play" />
              {t('details.resume', { time: formatDuration(r.pos) })}
            </span>
            <span class="btn" {...focusable({ onEnter: () => play({ kind: 'movie', movie }).then(() => navigate({ name: 'player' })) })}>
              <Icon name="replay" />
              {t('details.fromStart')}
            </span>
          </>
        ) : (
          <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => play({ kind: 'movie', movie }).then(() => navigate({ name: 'player' })) })}>
            <Icon name="play" />
            {t('details.play')}
          </span>
        )}
        <span class="btn" {...focusable({ onEnter: () => favoriteToggle(item) })}>
          <Icon name="star" />
          {fav ? t('fav.remove') : t('fav.add')}
        </span>
        <span class="btn" {...focusable({ onEnter: () => itemMenu(item) })}>
          <Icon name="list" />
          {t('details.more')}
        </span>
        {versionsButton}
      </div>
    );
  } else {
    const series = item as Series;
    const d = details as SeriesDetails | null;
    const episodes = d ? d.episodes : [];
    const seasons = d ? d.seasons : [];
    const last = data.history.find((h) => h.key === series.key);
    const lastEp = last && last.episodeKey ? episodes.find((e) => e.key === last.episodeKey) : undefined;
    const currentSeason = season !== null ? season : lastEp ? lastEp.season : seasons[0];
    seasonEps = episodes.filter((e) => e.season === currentSeason);
    const playEpisode = (ep: Episode, startAt?: number) => play({ kind: 'episode', series, episode: ep, episodes }, { startAt }).then(() => navigate({ name: 'player' }));
    playEp = playEpisode;
    // Resume the last episode, or start the next one when it was finished.
    let resumeEp: Episode | undefined;
    let resumeAt: number | undefined;
    if (lastEp) {
      const r = data.resume[lastEp.key];
      if (r) {
        resumeEp = lastEp;
        resumeAt = r.pos;
      } else resumeEp = episodes[episodes.indexOf(lastEp) + 1] || lastEp;
    }
    const shuffle = () => {
      if (!episodes.length) return;
      const shuffled = episodes.slice().sort(() => Math.random() - 0.5);
      play({ kind: 'episode', series, episode: shuffled[0], episodes: shuffled }).then(() => navigate({ name: 'player' }));
    };
    body = (
      <>
        <div class="actions">
          {!d && !error && <span class="spinner" />}
          {d && episodes.length === 0 && <div class="dim">{t('details.noEpisodes')}</div>}
          {resumeEp ? (
            <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => playEpisode(resumeEp!, resumeAt) })}>
              <Icon name="play" />
              {resumeAt ? t('details.resumeEp', { s: resumeEp.season, e: resumeEp.episode, time: formatDuration(resumeAt) }) : t('details.playEp', { s: resumeEp.season, e: resumeEp.episode })}
            </span>
          ) : (
            episodes.length > 0 && (
              <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => playEpisode(episodes[0]) })}>
                <Icon name="play" />
                {t('details.playEp', { s: episodes[0].season, e: episodes[0].episode })}
              </span>
            )
          )}
          <span class="btn" {...focusable({ onEnter: () => favoriteToggle(item) })}>
            <Icon name="star" />
            {fav ? t('fav.remove') : t('fav.add')}
          </span>
          {episodes.length > 1 && (
            <span class="btn" {...focusable({ onEnter: shuffle })}>
              {t('details.shuffle')}
            </span>
          )}
          <span class="btn" {...focusable({ onEnter: () => itemMenu(item) })}>
            <Icon name="list" />
            {t('details.more')}
          </span>
          {versionsButton}
        </div>
        {seasons.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div class="chips" data-scroll="x" data-focus-memory="">
              {seasons.map((s) => (
                <span key={s} class={'chip' + (s === currentSeason ? ' active' : '')} {...focusable({ id: 'season:' + s, onEnter: () => setSeason(s), onFocus: () => setSeason(s) })}>
                  {t('details.season', { n: s })}
                  <span class="n">{episodes.filter((e) => e.season === s).length}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  const backdrop = details && details.backdrop ? details.backdrop : item.image;

  return (
    <div class="details" ref={root}>
      {backdrop && <div class="bg" style={{ backgroundImage: `url("${backdrop}")` }} />}
      <div class="bg-fade" />
      <div class="content">
        <div class="poster">
          <Img src={item.image} alt={title} />
        </div>
        <div class="info">
          <Prompt path={item.kind === 'movie' ? '~/movies' : '~/series'} cmd={'cat ' + slugify(title)} small />
          <h1>{title}</h1>
          <div class="meta">
            {meta.map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </div>
          {error && <div class="bad"><Glyph n="cross" gap />{error}</div>}
          {(details && details.plot) || (item.kind === 'series' && (item as Series).plot) ? (
            <div class="plot clamp4">{(details && details.plot) || (item as Series).plot}</div>
          ) : null}
          {details && (details.cast || details.director) && (
            <div class="people ellipsis">
              {details.director && `${t('details.director')}: ${details.director}   `}
              {details.cast && `${t('details.cast')}: ${details.cast}`}
            </div>
          )}
          {body}
        </div>
      </div>
      {seasonEps.length > 0 && playEp && (
        <div class="episodes" style={{ marginTop: 26 }}>
          <div class="row" data-scroll="x" data-scroll-pad="200" data-focus-memory="">
            <div class="row-inner">
              {seasonEps.map((e) => {
                const r = data.resume[e.key];
                return (
                  <div key={e.key} class="ep-item" {...focusable({ id: 'ep:' + e.key, onEnter: () => playEp!(e) })}>
                    <div class="thumb">
                      <Img src={e.image || item.image} alt="" />
                      {r && (
                        <div class="progress">
                          <i style={{ width: (r.pos / r.dur) * 100 + '%' }} />
                        </div>
                      )}
                    </div>
                    <div class="txt">
                      <div class="n">
                        S{e.season} · E{e.episode}
                        {e.duration ? ' · ' + formatMinutes(e.duration) : ''}
                      </div>
                      <div class="t ellipsis">{e.title}</div>
                      {e.plot && <div class="d clamp2">{e.plot}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.nfo';
}
