import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { goSection, resetTo, type Route } from '@/navigation/router';
import { stop } from '@/state/player';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { Avatar } from '@/ui/Cards';
import { Icon } from '@/ui/icons';
import { ui } from '@/ui/ui-state';

const ITEMS: Array<{ id: string; icon: string; label: string; route: Route }> = [
  { id: 'home', icon: 'home', label: 'nav.home', route: { name: 'home' } },
  { id: 'live', icon: 'live', label: 'nav.live', route: { name: 'live' } },
  { id: 'guide', icon: 'guide', label: 'nav.guide', route: { name: 'guide' } },
  { id: 'movie', icon: 'movie', label: 'nav.movies', route: { name: 'vod', kind: 'movie' } },
  { id: 'series', icon: 'series', label: 'nav.series', route: { name: 'vod', kind: 'series' } },
  { id: 'search', icon: 'search', label: 'nav.search', route: { name: 'search' } },
  { id: 'settings', icon: 'settings', label: 'nav.settings', route: { name: 'settings' } },
];

function activeId(r: Route): string {
  if (r.name === 'vod') return r.kind;
  if (r.name === 'categories' || r.name === 'addSource') return 'settings';
  if (r.name === 'list') return 'home';
  return r.name;
}

export function Sidebar({ route }: { route: Route }) {
  const expanded = useStore(ui, (s) => s.sidebarExpanded);
  const profile = useStore(user, (s) => s.profiles.find((p) => p.id === s.activeProfileId));
  const active = activeId(route);
  return (
    <div class={'sidebar' + (expanded ? ' expanded' : '')} data-focus-memory="">
      <div class="logo">
        <div class="mark">&gt;_</div>
        <div class="word">TermTV</div>
      </div>
      {ITEMS.map((it) => (
        <div
          key={it.id}
          class={'nav-item' + (active === it.id ? ' active' : '')}
          data-focus-default={active === it.id ? '' : undefined}
          {...focusable({
            id: 'nav:' + it.id,
            onEnter: () => {
              stop();
              goSection(it.route);
            },
          })}
        >
          <Icon name={it.icon} />
          <span class="label">{t(it.label)}</span>
        </div>
      ))}
      {profile && (
        <div
          class="nav-item profile-chip"
          {...focusable({
            id: 'nav:profile',
            onEnter: () => {
              stop();
              resetTo({ name: 'profiles' });
            },
          })}
        >
          <span class="ico">
            <Avatar name={profile.name} avatar={profile.avatar} small />
          </span>
          <span class="label">{profile.name}</span>
        </div>
      )}
    </div>
  );
}
