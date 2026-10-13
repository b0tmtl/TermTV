// TV Guide: a timeline grid. Only visible channel rows and programmes in the visible time window
// are rendered. Arrow keys move a (row, time) cursor; the grid scrolls in 30 minute steps.

import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import type { Channel } from '@/core/models';
import { cleanTitle } from '@/core/normalize';
import { formatDate, formatTime, t } from '@/i18n';
import { focus, focusable, registerHandlers } from '@/navigation/focus';
import type { KeyInfo } from '@/platform/tv';
import { hasGuide, libraryState, programmes } from '@/state/library';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { Img, Prompt } from '@/ui/Cards';
import { favoriteToggle, startPlayback, unlockIfNeeded, favoriteCategoryToggle } from '@/ui/actions';
import { toast } from '@/ui/ui-state';
import { channelsFor, liveCategories } from './Live';

const PX_PER_MIN = 8;
const STEP = 30 * 60000;
const ROW_H = 86;
const CHAN_W = 300;
const GRID_TOP = 300;
const GRID_W = 1920 - 112 - CHAN_W;
const SPAN = (GRID_W / PX_PER_MIN) * 60000;
const VISIBLE_ROWS = Math.floor((1080 - GRID_TOP - 52) / ROW_H);

interface Block {
  start: number;
  end: number;
  title: string;
  desc?: string;
  empty?: boolean;
}

function blocksFor(ch: Channel, from: number, to: number): Block[] {
  const list = programmes(ch).filter((p) => p.end > from && p.start < to);
  if (!list.length) return [{ start: from, end: to, title: t('guide.noInfo'), empty: true }];
  const out: Block[] = [];
  let cursor = from;
  for (const p of list) {
    if (p.start > cursor + 60000) out.push({ start: cursor, end: p.start, title: '', empty: true });
    out.push(p);
    cursor = Math.max(cursor, p.end);
  }
  if (cursor < to) out.push({ start: cursor, end: to, title: '', empty: true });
  return out;
}

export function GuideScreen() {
  useStore(libraryState, (s) => s.version);
  const epgVersion = useStore(libraryState, (s) => s.epgVersion);
  const data = useStore(user, (s) => s.data);
  const clock24 = data.settings.clock24h;
  const tabs = useMemo(() => liveCategories(), [data.categories.live, data.favoriteCategories, data.favorites, data.locked, libraryState.get().version]);
  const [tab, setTab] = useState(0);
  const tabId = tabs[Math.min(tab, tabs.length - 1)] ? tabs[Math.min(tab, tabs.length - 1)].id : '';
  const channels = useMemo(() => channelsFor(tabId), [tabId, data.categories.live.itemSort, libraryState.get().version]);
  const now = Date.now();
  const [winStart, setWinStart] = useState(Math.floor(now / STEP) * STEP);
  const [row, setRow] = useState(0);
  const [top, setTop] = useState(0);
  const [cursor, setCursor] = useState(now);
  const [gridFocused, setGridFocused] = useState(false);

  const winEnd = winStart + SPAN;
  const ch = channels[row];
  const rowBlocks = ch ? blocksFor(ch, winStart, winEnd) : [];
  const current = rowBlocks.find((b) => b.start <= cursor && b.end > cursor) || rowBlocks[0];

  useLayoutEffect(() => {
    if (!gridFocused) return;
    const el = document.querySelector(`[data-fid="gp:${row}:${current ? current.start : 0}"]`) as HTMLElement | null;
    if (el) focus(el, { scroll: false });
  });

  if (!channels.length) {
    return (
      <div class="screen-pad">
        <Prompt path="~/tv-guide" cmd="cat epg.xml" />
        <div class="dim">{t('live.empty')}</div>
      </div>
    );
  }

  const moveRow = (r: number) => {
    r = Math.max(0, Math.min(channels.length - 1, r));
    let tp = top;
    if (r < tp) tp = r;
    else if (r >= tp + VISIBLE_ROWS) tp = r - VISIBLE_ROWS + 1;
    setTop(tp);
    setRow(r);
  };

  const setTime = (time: number) => {
    let ws = winStart;
    while (time < ws) ws -= STEP;
    while (time >= ws + SPAN - STEP) ws += STEP;
    setWinStart(ws);
    setCursor(time);
  };

  const onKey = (k: KeyInfo): boolean => {
    if (!current) return false;
    switch (k.key) {
      case 'up':
        if (row === 0) {
          setGridFocused(false);
          return false; // to the tabs
        }
        moveRow(row - 1);
        return true;
      case 'down':
        moveRow(row + 1);
        return true;
      case 'chUp':
        moveRow(row - VISIBLE_ROWS);
        return true;
      case 'chDown':
        moveRow(row + VISIBLE_ROWS);
        return true;
      case 'right': {
        const next = rowBlocks[rowBlocks.indexOf(current) + 1];
        setTime(next ? Math.max(next.start, winStart) : winEnd);
        return true;
      }
      case 'left': {
        const prev = rowBlocks[rowBlocks.indexOf(current) - 1];
        if (prev) setTime(Math.max(prev.start, winStart));
        else if (winStart - STEP >= Date.now() - 3 * 3600000) setTime(winStart - STEP);
        else return false; // to the sidebar
        return true;
      }
      case 'ff':
        setTime(cursor + 3 * 3600000);
        return true;
      case 'rw':
        setTime(Math.max(Date.now() - 2 * 3600000, cursor - 3 * 3600000));
        return true;
      case 'red':
        favoriteToggle(ch);
        return true;
      case 'enter':
        openBlock(ch, current);
        return true;
      default:
        return false;
    }
  };

  const openBlock = async (c: Channel, b: Block) => {
    const tnow = Date.now();
    if (b.empty || (b.start <= tnow && b.end > tnow)) {
      if (!(await unlockIfNeeded(c))) return;
      startPlayback({ kind: 'live', channel: c, list: channels });
    } else if (b.start > tnow) {
      toast(t('guide.startsAt', { time: formatTime(b.start, clock24), date: formatDate(b.start) }));
    } else {
      toast(t('guide.ended'));
    }
  };

  // Time ticks every 30 minutes.
  const ticks: number[] = [];
  for (let x = winStart; x < winEnd; x += STEP) ticks.push(x);
  const nowX = ((now - winStart) / 60000) * PX_PER_MIN;
  const focusedProg: Block | undefined = gridFocused ? current : undefined;

  const rows = [];
  for (let r = top; r < Math.min(channels.length, top + VISIBLE_ROWS + 1); r++) {
    const c = channels[r];
    const blocks = blocksFor(c, winStart, winEnd);
    rows.push(
      <div class="g-row" key={c.key} style={{ top: (r - top) * ROW_H + 'px' }}>
        <div class="g-chan">
          <span class="logo">{c.image ? <Img src={c.image} alt="" /> : null}</span>
          <span class="nm">
            {data.favorites.indexOf(c.key) >= 0 ? <Glyph n="star" gap /> : ''}
            {cleanTitle(c.name)}
          </span>
        </div>
        <div class="g-progs">
          {blocks.map((b) => {
            const x = Math.max(0, ((b.start - winStart) / 60000) * PX_PER_MIN);
            const w = Math.min(GRID_W, ((b.end - winStart) / 60000) * PX_PER_MIN) - x;
            if (w < 4) return null;
            const isNow = b.start <= now && b.end > now;
            return (
              <div
                key={b.start}
                class={'g-prog' + (isNow ? ' live' : '') + (b.empty ? ' empty' : '')}
                style={{ left: x + 2 + 'px', width: w - 4 + 'px' }}
                {...focusable({
                  id: `gp:${r}:${b.start}`,
                  onFocus: () => {
                    setGridFocused(true);
                    if (r !== row) moveRow(r);
                    if (!(b.start <= cursor && b.end > cursor)) setCursor(Math.max(b.start, winStart));
                  },
                })}
              >
                <div class="tt">{b.title}</div>
                {!b.empty && (
                  <div class="tm">
                    {formatTime(b.start, clock24)} – {formatTime(b.end, clock24)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>,
    );
  }

  return (
    <div class="guide">
      <div class="screen-pad" style={{ paddingBottom: 0 }}>
        <Prompt path="~/tv-guide" cmd="cat epg.xml" count={!hasGuide() ? t('guide.noGuideData') : undefined} />
      </div>
      <div class="tabs">
        <div class="chips" data-scroll="x" data-focus-memory="">
          {tabs.map((tb, i) => (
            <span
              key={tb.id}
              class={'chip' + (i === tab ? ' active' : '')}
              {...focusable({
                id: 'gt:' + tb.id,
                onEnter: () => {
                  setTab(i);
                  setRow(0);
                  setTop(0);
                },
                onFocus: () => setGridFocused(false),
                onKey: (k) => (k.key === 'red' && tb.view ? (favoriteCategoryToggle(tb.view), true) : false),
              })}
            >
              {tb.icon && <Glyph n={tb.icon} gap />}
              {tb.name}
              <span class="n">{tb.count}</span>
            </span>
          ))}
        </div>
      </div>
      <div class="g-detail" style={{ top: 186 }}>
        {focusedProg && !focusedProg.empty ? (
          <>
            <h2 class="ellipsis">{focusedProg.title}</h2>
            <div class="accent" style={{ fontSize: 22 }}>
              {formatDate(focusedProg.start)} · {formatTime(focusedProg.start, clock24)} – {formatTime(focusedProg.end, clock24)} · {ch ? cleanTitle(ch.name) : ''}
            </div>
            {focusedProg.desc && <div class="dim clamp2" style={{ fontSize: 21, marginTop: 6 }}>{focusedProg.desc}</div>}
          </>
        ) : (
          <div class="dim" style={{ fontSize: 22, paddingTop: 10 }}>{t('guide.hint')}</div>
        )}
      </div>
      <div class="timebar" style={{ top: GRID_TOP - 52 + 'px' }}>
        <span class="day">{formatDate(cursor)}</span>
        {ticks.map((x) => (
          <span key={x} class="tick" style={{ left: CHAN_W + ((x - winStart) / 60000) * PX_PER_MIN + 8 + 'px' }}>
            {formatTime(x, clock24)}
          </span>
        ))}
      </div>
      <div
        class="grid"
        style={{ top: GRID_TOP + 'px' }}
        ref={(el) => {
          if (el) registerHandlers(el, { onKey });
        }}
      >
        {rows}
        {nowX >= 0 && nowX <= GRID_W && <div class="nowline" style={{ left: CHAN_W + nowX + 'px' }} />}
      </div>
      <span class="hidden">{epgVersion}</span>
    </div>
  );
}
