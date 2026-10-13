// Sports: matches found in the TV guide, by sport. Live now first, then upcoming. OK on a match
// lists the channels carrying it (OK on a channel plays it).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SPORT_ORDER, type SportId } from '@/core/sports';
import { cleanTitle } from '@/core/normalize';
import { formatDate, formatTime, t } from '@/i18n';
import { focusById, focusable } from '@/navigation/focus';
import { hasGuide, libraryState } from '@/state/library';
import { ensureSports, isLive, matchesFor, sportsState, type Match } from '@/state/sports';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { Prompt } from '@/ui/Cards';
import { showMenu } from '@/ui/Dialog';
import { Glyph } from '@/ui/Glyph';
import { VGrid } from '@/ui/VGrid';
import { startPlayback, unlockIfNeeded } from '@/ui/actions';

type Tab = SportId | 'all';

/** ("other" can't be a translation key: an object with "other" reads as plural forms.) */
const sportName = (id: Tab) => t('sports.name.' + (id === 'other' ? 'others' : id));

export function SportsScreen() {
  const version = useStore(libraryState, (s) => s.version);
  const epgVersion = useStore(libraryState, (s) => s.epgVersion);
  const status = useStore(sportsState, (s) => s.status);
  const all = useStore(sportsState, (s) => s.matches);
  const clock24 = useStore(user, (s) => s.data.settings.clock24h);
  const [tab, setTab] = useState<Tab>('all');
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    ensureSports();
  }, [version, epgVersion]);
  useEffect(() => {
    // Live / upcoming changes with time: refresh the view every minute.
    const id = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const tabs = useMemo(() => {
    const count: Record<string, { live: number; total: number }> = { all: { live: 0, total: 0 } };
    for (const m of all) {
      if (m.end <= now) continue;
      const c = count[m.sport] || (count[m.sport] = { live: 0, total: 0 });
      c.total++;
      count.all.total++;
      if (isLive(m, now)) {
        c.live++;
        count.all.live++;
      }
    }
    return (['all'] as Tab[]).concat(SPORT_ORDER.filter((s) => count[s])).map((id) => ({ id, ...(count[id] || { live: 0, total: 0 }) }));
  }, [all, Math.floor(now / 60000)]);

  const current = tabs.some((x) => x.id === tab) ? tab : 'all';
  const list = useMemo(() => matchesFor(current, now), [all, current, Math.floor(now / 60000)]);

  const when = (m: Match): string => {
    if (isLive(m, now)) return t('sports.liveNow');
    const d = new Date(m.start);
    const today = new Date(now);
    const tomorrow = new Date(now + 86400000);
    const time = formatTime(m.start, clock24);
    if (d.toDateString() === today.toDateString()) return time;
    if (d.toDateString() === tomorrow.toDateString()) return t('sports.tomorrow', { time });
    return formatDate(m.start) + ' ' + time;
  };

  const open = async (m: Match) => {
    const live = isLive(m);
    const play = async (a: Match['airings'][number]) => {
      if (!(await unlockIfNeeded(a.channel))) return;
      startPlayback({ kind: 'live', channel: a.channel, list: m.airings.map((x) => x.channel) });
    };
    if (live && m.airings.length === 1) return play(m.airings[0]);
    showMenu(
      m.title,
      m.airings.map((a) => ({
        label: cleanTitle(a.channel.name),
        hint: a.start <= Date.now() && a.end > Date.now() ? t('sports.onNow') : formatTime(a.start, clock24),
        onSelect: () => play(a),
      })),
      live ? t('sports.chooseChannel') : t('sports.startsAt', { when: when(m) }),
    );
  };

  if (!hasGuide()) {
    return (
      <div class="screen-pad">
        <Prompt path="~/sports" cmd="ls" />
        <div class="dim" style={{ fontSize: 26 }}>{t('sports.noGuide')}</div>
      </div>
    );
  }

  return (
    <div class="live">
      <div class="col-cats">
        <div class="col-head">
          <span class="accent"><Glyph n="prompt" /></span> ~/sports <span class="dim">ls</span>
        </div>
        <VGrid
          id="sp"
          items={tabs}
          columns={1}
          rowHeight={80}
          height={980}
          onIndex={(i) => {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setTab(tabs[i].id), 200);
          }}
          onKey={(k, i) => {
            if (k.key === 'right' || k.key === 'enter') {
              clearTimeout(timer.current);
              setTab(tabs[i].id);
              setTimeout(() => focusById('sm:0'), 30);
              return true;
            }
            return false;
          }}
          render={(c, _i, cell) => (
            <div key={c.id} class={'list-item' + (c.id === current ? ' active' : '')} style={{ width: 376 }} {...focusable(cell)}>
              <span class="name">{sportName(c.id)}</span>
              <span class="meta">
                {c.live > 0 && <span class="live-dot">● {c.live}</span>}
                {c.live > 0 ? ' / ' : ''}
                {c.total}
              </span>
            </div>
          )}
        />
      </div>
      <div style={{ flex: 1, padding: '26px 40px 0 40px', overflow: 'hidden' }}>
        <div class="col-head ellipsis" style={{ padding: '0 0 16px' }}>
          <span class="accent"><Glyph n="prompt" /></span> {sportName(current)} <span class="faint">({list.length})</span>
        </div>
        {status !== 'ready' && !all.length ? (
          <div class="dim" style={{ fontSize: 26 }}>
            <span class="spinner" style={{ marginRight: 20 }} />
            {t('sports.building')}
          </div>
        ) : list.length ? (
          <VGrid
            key={current}
            id="sm"
            items={list}
            columns={1}
            rowHeight={118}
            height={980}
            onKey={(k, i) => {
              if (k.key === 'left') return focusById('sp:' + Math.max(0, tabs.findIndex((x) => x.id === current))), true;
              if (k.key === 'enter') return open(list[i]), true;
              return false;
            }}
            render={(m, _i, cell) => {
              const live = isLive(m, now);
              const progress = live ? Math.min(1, (now - m.start) / Math.max(1, m.end - m.start)) : 0;
              return (
                <div key={m.key} class="match" {...focusable(cell)}>
                  <div class={'when' + (live ? ' live' : '')}>{when(m)}</div>
                  <div class="what">
                    <div class="title ellipsis">{m.title}</div>
                    <div class="sub ellipsis">
                      {sportName(m.sport)}
                      {m.league ? ' · ' + m.league : ''}
                      {' · '}
                      {t('sports.channels', { count: m.airings.length })}
                    </div>
                    {live && (
                      <div class="match-bar">
                        <i style={{ width: progress * 100 + '%' }} />
                      </div>
                    )}
                  </div>
                </div>
              );
            }}
          />
        ) : (
          <div class="dim" style={{ fontSize: 26 }}>{t('sports.empty')}</div>
        )}
      </div>
    </div>
  );
}
