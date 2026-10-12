import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { setLanguage, t } from '@/i18n';
import { dispatchKey, focusById, focusFirst, focusInto, onFocusChange, setGlobalHandler } from '@/navigation/focus';
import { back, currentRoute, goSection, router, type Route } from '@/navigation/router';
import { exitApp, mapKey, registerKeys } from '@/platform/tv';
import { libraryState } from '@/state/library';
import { player, stop } from '@/state/player';
import { useStore } from '@/state/store';
import { user } from '@/state/user';
import { confirmDialog } from '@/ui/Dialog';
import { dismissTopDialog, hasDialog, ui } from '@/ui/ui-state';
import { Sidebar } from './Sidebar';
import { CategoriesScreen } from '@/screens/Categories';
import { DetailsScreen } from '@/screens/Details';
import { GuideScreen } from '@/screens/Guide';
import { HomeScreen } from '@/screens/Home';
import { ListScreen } from '@/screens/ListScreen';
import { LiveScreen } from '@/screens/Live';
import { PlayerScreen } from '@/screens/Player';
import { ProfilesScreen } from '@/screens/Profiles';
import { SearchScreen } from '@/screens/Search';
import { SettingsScreen } from '@/screens/Settings';
import { AddSourceScreen, WelcomeScreen } from '@/screens/Sources';
import { VodScreen } from '@/screens/Vod';

const NO_SIDEBAR = ['profiles', 'welcome', 'addSource', 'player', 'details'];

/** Screens that need the full library (while Home shows its snapshot). */
const NEEDS_LIBRARY = ['live', 'guide', 'vod', 'search', 'categories', 'list'];

function LibraryLoading() {
  return (
    <div class="screen-pad">
      <div style={{ fontSize: 28, marginTop: 60 }}>
        <span class="spinner" style={{ marginRight: 24 }} />
        {t('home.loading')}
      </div>
    </div>
  );
}

function renderRoute(r: Route, partial?: boolean) {
  if (partial && NEEDS_LIBRARY.indexOf(r.name) >= 0) return <LibraryLoading />;
  switch (r.name) {
    case 'profiles': return <ProfilesScreen />;
    case 'welcome': return <WelcomeScreen />;
    case 'addSource': return <AddSourceScreen editId={r.editId} />;
    case 'home': return <HomeScreen />;
    case 'live': return <LiveScreen categoryId={r.categoryId} channelKey={r.channelKey} />;
    case 'guide': return <GuideScreen />;
    case 'vod': return <VodScreen kind={r.kind} categoryId={r.categoryId} />;
    case 'details': return <DetailsScreen itemKey={r.key} />;
    case 'search': return <SearchScreen scope={r.scope} q={r.q} />;
    case 'player': return <PlayerScreen />;
    case 'list': return <ListScreen listId={r.listId} />;
    case 'settings': return <SettingsScreen section={r.section} />;
    case 'categories': return <CategoriesScreen kind={r.kind} />;
  }
}

export function App() {
  const stack = useStore(router, (s) => s.stack);
  const theme = useStore(user, (s) => s.data.settings.theme);
  const language = useStore(user, (s) => s.app.language);
  const dialogs = useStore(ui, (s) => s.dialogs);
  const toastMsg = useStore(ui, (s) => s.toast);
  const playing = useStore(player, (s) => (s.target ? (s.windowed ? 'window' : 'full') : 'none'));
  const partial = useStore(libraryState, (s) => !!s.partial);
  const entry = stack[stack.length - 1];
  const route = entry.route;
  const screenRef = useRef<HTMLDivElement>(null);

  setLanguage(language);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Each theme is its own stylesheet (CSS variables are resolved at build time for old TVs).
    const link = document.getElementById('theme-css') as HTMLLinkElement | null;
    if (link) link.href = `css/theme-${theme}.css`;
  }, [theme]);

  useEffect(() => {
    registerKeys();
    setGlobalHandler(globalKey);
    const onKeyDown = (e: KeyboardEvent) => {
      const k = mapKey(e);
      if (!k) return;
      if (dispatchKey(k)) e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Each new screen: restore focus where it was, or focus its default element.
  // Keyed on the screen itself, not the entry: screens update their route params as you browse.
  const screenKey =
    stack.length + ':' + route.name + ('kind' in route ? ':' + route.kind : '') + (partial && NEEDS_LIBRARY.indexOf(route.name) >= 0 ? ':wait' : '');
  useLayoutEffect(() => {
    const root = screenRef.current;
    if (!root || hasDialog()) return;
    const tryFocus = () => (entry.focus && focusById(entry.focus, root)) || focusFirst(root);
    if (!tryFocus()) setTimeout(tryFocus, 50);
  }, [screenKey]);

  const showSidebar = NO_SIDEBAR.indexOf(route.name) < 0;
  // The page is transparent where video plays: full screen player, or the live preview window.
  const backdrop = playing === 'none' || (playing === 'window' && route.name !== 'live' && route.name !== 'guide');

  return (
    <div class="shell">
      {backdrop && <div class="backdrop" />}
      {showSidebar && <Sidebar route={route} />}
      <div class={'screen' + (showSidebar ? '' : ' full')} ref={screenRef} data-focus-memory="" key={screenKey}>
        {renderRoute(route, partial)}
      </div>
      {dialogs.map((d) => (
        <div key={d.id}>{d.render(() => ui.set((s) => ({ dialogs: s.dialogs.filter((x) => x.id !== d.id) })))}</div>
      ))}
      {toastMsg && <div class="toast">{toastMsg}</div>}
    </div>
  );
}

function globalKey(k: { key: string }): boolean {
  const route = currentRoute();
  if (k.key === 'back' || k.key === 'del') {
    if (dismissTopDialog()) return true;
    if (route.name === 'player') {
      stop();
      back();
      return true;
    }
    if (route.name === 'profiles' || route.name === 'welcome' || (route.name === 'home' && router.get().stack.length === 1)) {
      // On the root screen: the sidebar first, then confirm exit.
      const side = document.querySelector('.sidebar') as HTMLElement | null;
      if (side && !side.contains(document.querySelector('[data-focused]'))) {
        focusInto(side);
        return true;
      }
      confirmDialog(t('app.exitTitle'), t('app.exitText'), t('app.exit')).then((ok) => ok && exitApp());
      return true;
    }
    if (route.name !== 'details' && route.name !== 'addSource' && route.name !== 'categories' && route.name !== 'list' && router.get().stack.length === 2) {
      goSection({ name: 'home' });
      return true;
    }
    return back();
  }
  if (k.key === 'guide') {
    goSection({ name: 'guide' });
    return true;
  }
  return false;
}

/** Sidebar expands while it has focus. */
onFocusChange((el) => {
  const side = document.querySelector('.sidebar');
  const expanded = !!(el && side && side.contains(el));
  if (ui.get().sidebarExpanded !== expanded) ui.set({ sidebarExpanded: expanded });
});
