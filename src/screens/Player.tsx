import { useEffect, useRef, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import { LoadingDots } from '@/ui/LoadingDots';
import type { Channel } from '@/core/models';
import { cleanTitle, splitYear } from '@/core/normalize';
import { formatDuration, formatTime, t } from '@/i18n';
import { focusById, focusable } from '@/navigation/focus';
import { back } from '@/navigation/router';
import type { KeyInfo } from '@/platform/tv';
import { nowNext } from '@/state/library';
import { cancelScrub, commitScrub, nextEpisode, play, player, retry, scrubStep, scrubToFraction, selectAudio, selectText, setAspect, setWindow, stop, togglePause, zap } from '@/state/player';
import { useStore } from '@/state/store';
import { isFavorite, user } from '@/state/user';
import { Img } from '@/ui/Cards';
import { showMenu } from '@/ui/Dialog';
import { favoriteToggle, unlockIfNeeded } from '@/ui/actions';
import { Icon } from '@/ui/icons';
import { VGrid } from '@/ui/VGrid';

const HIDE_AFTER = 5000;

export function PlayerScreen() {
  const st = useStore(player, (s) => s);
  // Once the video plays, repaint the overlay once: TVs can leave stale pieces of what was drawn
  // over the video plane (the loading indicator) on screen.
  useEffect(() => {
    if (st.status !== 'playing') return;
    const el = document.querySelector('.player-ui') as HTMLElement | null;
    if (!el) return;
    // Hide and show again: a full repaint without creating a layer (opacity < 1 would).
    el.style.visibility = 'hidden';
    const id = requestAnimationFrame(() => (el.style.visibility = ''));
    return () => {
      cancelAnimationFrame(id);
      el.style.visibility = '';
    };
  }, [st.status]);
  const settings = useStore(user, (s) => s.data.settings);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState(false);
  const [digits, setDigits] = useState('');
  const [aspect, setAspectState] = useState<'fit' | 'fill' | 'stretch'>('fit');
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const digitTimer = useRef<ReturnType<typeof setTimeout>>();
  const [, tick] = useState(0);

  const target = st.target;
  const live = target && target.kind === 'live';

  useEffect(() => {
    setWindow(null);
    const clock = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(clock);
  }, []);

  // No target (e.g. stopped elsewhere): leave.
  useEffect(() => {
    if (!target) back();
  }, [target]);

  const showControls = (focusId?: string) => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (player.get().status === 'playing') setControls(false);
    }, HIDE_AFTER);
    if (focusId) setTimeout(() => focusById(focusId), 20);
  };

  useEffect(() => {
    showControls(live ? undefined : 'pc:seek');
    return () => clearTimeout(hideTimer.current);
  }, [target && (target.kind === 'live' ? target.channel.key : target.kind === 'movie' ? target.movie.key : target.episode.key)]);

  useEffect(() => {
    if (st.status === 'paused' || st.status === 'error') {
      setControls(true);
      clearTimeout(hideTimer.current);
    }
  }, [st.status]);

  if (!target) return null;

  const list: Channel[] = target.kind === 'live' ? target.list : [];

  const zapToNumber = (num: string) => {
    if (!live) return;
    const n = Number(num);
    const idx = list.findIndex((c, i) => (c.number || i + 1) === n);
    if (idx >= 0) openChannel(list[idx]);
  };

  const openChannel = async (ch: Channel) => {
    if (!(await unlockIfNeeded(ch))) return;
    await play({ kind: 'live', channel: ch, list }, { windowed: null });
    setPanel(false);
    showControls();
  };

  const trackMenu = () => {
    const opts = [
      ...st.text.map((tr) => ({ label: `${t('player.subtitles')}: ${tr.label}`, checked: st.textIndex === tr.index, onSelect: () => selectText(tr.index) })),
      { label: `${t('player.subtitles')}: ${t('player.off')}`, checked: st.textIndex < 0, onSelect: () => selectText(-1) },
      ...st.audio.map((tr) => ({ label: `${t('player.audio')}: ${tr.label}`, checked: st.audioIndex === tr.index, onSelect: () => selectAudio(tr.index) })),
    ];
    showMenu(t('player.tracks'), opts);
  };

  const cycleAspect = () => {
    const next = aspect === 'fit' ? 'fill' : aspect === 'fill' ? 'stretch' : 'fit';
    setAspectState(next);
    setAspect(next);
  };

  const onKey = (k: KeyInfo): boolean => {
    if (panel) {
      if (k.key === 'back' || k.key === 'right') {
        setPanel(false);
        return true;
      }
      return false;
    }
    switch (k.key) {
      case 'back':
        if (cancelScrub()) return showControls('pc:seek'), true;
        if (controls && st.status === 'playing' && !live) {
          setControls(false);
          return true;
        }
        return false;
      case 'digit':
        // Movies and episodes: 0-9 jump to 0%-90% (shown on the bar, seeks a second later).
        if (!live) return scrubToFraction((k.digit || 0) / 10), showControls('pc:seek'), true;
        clearTimeout(digitTimer.current);
        const d = (digits + k.digit).slice(-4);
        setDigits(d);
        digitTimer.current = setTimeout(() => {
          setDigits('');
          zapToNumber(d);
        }, 1600);
        return true;
      case 'chUp':
        if (live) return zap(-1), showControls(), true;
        return nextEpisode(1), true;
      case 'chDown':
        if (live) return zap(1), showControls(), true;
        return nextEpisode(-1), true;
      case 'up':
      case 'down':
        if (live && !controls) return zap(k.key === 'up' ? -1 : 1), showControls(), true;
        if (live) return zap(k.key === 'up' ? -1 : 1), showControls(), true;
        if (!controls) return showControls('pc:seek'), true;
        return false;
      case 'left':
        if (live) {
          setPanel(true);
          setTimeout(() => focusById(`pl:${Math.max(0, list.findIndex((c) => c.key === target.channel.key))}`), 30);
          return true;
        }
        if (!controls) return scrubStep(-1), showControls('pc:seek'), true;
        return false;
      case 'right':
        if (!live && !controls) return scrubStep(1), showControls('pc:seek'), true;
        return false;
      case 'enter':
        if (live) {
          if (!controls) return showControls(), true;
          setPanel(true);
          setTimeout(() => focusById(`pl:${Math.max(0, list.findIndex((c) => c.key === target.channel.key))}`), 30);
          return true;
        }
        if (!controls) return showControls('pc:seek'), true;
        return false;
      case 'play':
      case 'pause':
      case 'playPause':
        togglePause();
        showControls(live ? undefined : 'pc:seek');
        return true;
      case 'ff':
        return scrubStep(1), showControls('pc:seek'), true;
      case 'rw':
        return scrubStep(-1), showControls('pc:seek'), true;
      case 'next':
        return nextEpisode(1), true;
      case 'prev':
        return nextEpisode(-1), true;
      case 'stop':
        stop();
        return true;
      case 'info':
        return controls ? setControls(false) : showControls(), true;
      case 'yellow':
        return trackMenu(), true;
      case 'green':
        return cycleAspect(), true;
      case 'red':
        if (target.kind === 'live') return favoriteToggle(target.channel), true;
        if (target.kind === 'movie') return favoriteToggle(target.movie), true;
        return favoriteToggle(target.series), true;
      default:
        return false;
    }
  };

  // Titles
  let title = '';
  let sub = '';
  let progress = 0;
  let scrubAt: number | null = null;
  let left = '';
  let right = '';
  if (target.kind === 'live') {
    const ch = target.channel;
    title = `${ch.number ? ch.number + '  ' : ''}${cleanTitle(ch.name)}`;
    const nn = nowNext(ch);
    if (nn.now) {
      sub = nn.now.title;
      progress = (Date.now() - nn.now.start) / (nn.now.end - nn.now.start);
      left = formatTime(nn.now.start, settings.clock24h);
      right = formatTime(nn.now.end, settings.clock24h);
    }
    if (nn.next) sub += `   ·   ${t('live.next')}: ${formatTime(nn.next.start, settings.clock24h)} ${nn.next.title}`;
  } else {
    title = target.kind === 'movie' ? splitYear(cleanTitle(target.movie.name)).title : cleanTitle(target.series.name);
    sub = target.kind === 'episode' ? `S${target.episode.season} · E${target.episode.episode}  ${target.episode.title}` : '';
    progress = st.duration ? st.time / st.duration : 0;
    scrubAt = st.scrub !== null && st.duration ? Math.max(0, Math.min(1, st.scrub / st.duration)) : null;
    left = formatDuration(st.time);
    right = st.duration ? '-' + formatDuration(st.duration - st.time) : '';
  }

  const subsClass = `subs ${settings.subtitles.position} ${settings.subtitles.size} ${settings.subtitles.background}`;
  const fav = target.kind === 'live' ? isFavorite(target.channel.key) : target.kind === 'movie' ? isFavorite(target.movie.key) : isFavorite(target.series.key);

  return (
    // The root takes focus when nothing else can (live TV has no buttons), so keys always arrive.
    <div class="player-ui" data-focus-skip="" {...focusable({ id: 'pc:root', onKey })}>
      {st.subtitle && (
        <div class={subsClass} style={{ color: settings.subtitles.color }}>
          <span>{st.subtitle}</span>
        </div>
      )}
      {(st.status === 'loading' || st.status === 'buffering') && (
        <div class="status">
          {st.status === 'loading' && title && <div class="ellipsis" style={{ fontSize: 30, fontWeight: 700, marginBottom: 12 }}>{title}</div>}
          <LoadingDots />
          {st.serverNote ? (
            <div style={{ marginTop: 14, fontSize: 22 }}>{t('player.tryingBackup', { n: st.serverNote.n, total: st.serverNote.total })}</div>
          ) : (
            st.reconnecting > 0 && <div style={{ marginTop: 14, fontSize: 22 }}>{t('player.reconnecting', { n: st.reconnecting })}</div>
          )}
        </div>
      )}
      {st.status === 'error' && (
        <div class="status">
          <div><Glyph n="cross" gap />{t('player.error')}</div>
          <div class="dim" style={{ fontSize: 20, margin: '8px 0 18px' }}>{st.error}</div>
          <span class="btn primary" data-focus-default="" {...focusable({ id: 'pc:retry', onEnter: retry })}>
            <Icon name="refresh" />
            {t('player.retry')}
          </span>
        </div>
      )}
      {digits && <div class="zap">{digits}</div>}
      {controls && (
        <>
          <div class="top">
            <div class="title ellipsis">
              {fav ? <Glyph n="star" gap /> : ''}
              {title}
            </div>
            <div class="subtitle-line ellipsis">{sub}</div>
            <div class="clock">{formatTime(Date.now(), settings.clock24h)}</div>
          </div>
          <div class="bottom">
            {(progress > 0 || !live) && (
              <>
                <div class="bar" {...(!live ? focusable({ id: 'pc:seek', onKey: seekKeys }) : {})} style={{ outline: 'none' }}>
                  <i style={{ width: Math.max(0, Math.min(1, progress)) * 100 + '%' }} />
                  {scrubAt !== null && (
                    <b class="scrub" style={{ left: scrubAt * 100 + '%' }}>
                      <span class="scrub-label" style={{ left: scrubAt < 0.12 ? '-3px' : scrubAt > 0.88 ? '-394px' : '-197px' }}>
                        {formatDuration(st.scrub!)}
                        <span class="dim"> ({st.scrub! >= st.time ? '+' : '-'}{formatDuration(Math.abs(st.scrub! - st.time))})</span>
                      </span>
                    </b>
                  )}
                </div>
                <div class="times">
                  <span>{left}</span>
                  <span class="spacer" />
                  <span>{right}</span>
                </div>
              </>
            )}
            {!live && (
              <div class="controls">
                <span class="btn small" {...focusable({ id: 'pc:rw', onEnter: () => scrubStep(-1) })}>
                  <Icon name="rw" />
                </span>
                <span class="btn small" {...focusable({ id: 'pc:play', onEnter: togglePause })}>
                  <Icon name={st.status === 'paused' ? 'play' : 'pause'} />
                  {st.status === 'paused' ? t('player.play') : t('player.pause')}
                </span>
                <span class="btn small" {...focusable({ id: 'pc:ff', onEnter: () => scrubStep(1) })}>
                  <Icon name="ff" />
                </span>
                <span class="btn small" {...focusable({ id: 'pc:tracks', onEnter: trackMenu })}>
                  <Icon name="subs" />
                  {t('player.tracks')}
                </span>
                <span class="btn small" {...focusable({ id: 'pc:aspect', onEnter: cycleAspect })}>
                  <Icon name="aspect" />
                  {t('player.aspect.' + aspect)}
                </span>
                {target.kind === 'episode' && (
                  <span class="btn small" {...focusable({ id: 'pc:next', onEnter: () => nextEpisode(1) })}>
                    <Icon name="next" />
                    {t('player.nextEpisode')}
                  </span>
                )}
                <span class="spacer" />
                <span class="dim" style={{ fontSize: 20 }}>{st.engine}</span>
              </div>
            )}
            {live && (
              <div class="dim" style={{ fontSize: 20, marginTop: 12 }}>
                {t('player.liveHints')}
                <span class="color-key yellow" />
                {t('player.tracks')}
                <span class="color-key green" />
                {t('player.aspect.' + aspect)}
                <span style={{ marginLeft: 24 }}>{st.engine}</span>
              </div>
            )}
          </div>
        </>
      )}
      {panel && live && (
        <div class="player-side">
          <div class="col-head">
            <span class="accent"><Glyph n="prompt" /></span> {t('player.channels')} <span class="faint">({list.length})</span>
          </div>
          <VGrid
            id="pl"
            items={list}
            columns={1}
            rowHeight={100}
            height={960}
            initialIndex={Math.max(0, list.findIndex((c) => c.key === target.channel.key))}
            leadRows={3}
            render={(ch, i, cell) => {
              const now = nowNext(ch).now;
              return (
                <div key={ch.key} class="list-item chan-item" style={{ width: 616 }} {...focusable({ ...cell, onEnter: () => openChannel(ch) })}>
                  <span class="num">{ch.number || i + 1}</span>
                  <span class="logo">{ch.image ? <Img src={ch.image} alt="" /> : null}</span>
                  <span class="two">
                    <span class="name ellipsis">{cleanTitle(ch.name)}</span>
                    <span class="prog">{now ? now.title : ''}</span>
                  </span>
                  {ch.key === target.channel.key && <span class="playing"><Glyph n="play" /></span>}
                </div>
              );
            }}
          />
        </div>
      )}
    </div>
  );

  function seekKeys(k: KeyInfo): boolean {
    if (k.key === 'left') return scrubStep(-1), showControls(), true;
    if (k.key === 'right') return scrubStep(1), showControls(), true;
    if (k.key === 'enter') return (commitScrub() || togglePause()), showControls(), true;
    if (k.key === 'down') return focusById('pc:play'), showControls(), true;
    showControls();
    return false;
  }
}

