// What happens when the user opens or long-presses an item, shared by every screen.

import type { CategoryView } from '@/core/categories';
import type { Channel, Item } from '@/core/models';
import { t } from '@/i18n';
import { navigate } from '@/navigation/router';
import { isFavoriteCategory, isItemLocked, viewOfItem } from '@/state/library';
import { play, type PlaybackTarget } from '@/state/player';
import { addToList, createList, isFavorite, isWatched, setWatched, toggleFavorite, toggleFavoriteCategory, user } from '@/state/user';
import { promptPin, promptText, showMenu, type MenuOption } from './Dialog';
import { toast } from './ui-state';

/** Asks for the parental PIN when the item's category is locked. Resolves true when allowed. */
export async function unlockIfNeeded(item: Item): Promise<boolean> {
  if (!isItemLocked(item)) return true;
  return askPin();
}

export async function askPin(): Promise<boolean> {
  const pin = await promptPin(t('parental.enterPin'), t('parental.lockedText'));
  if (pin === null) return false;
  if (pin === user.get().app.parentalPin) {
    user.set({ unlocked: true });
    return true;
  }
  toast(t('parental.wrongPin'));
  return false;
}

/**
 * Opens the player at once and starts the stream behind it. Waiting for the stream first (the
 * player connecting to the provider, ~5 s on IPTV) left the previous screen frozen meanwhile.
 */
export function startPlayback(target: PlaybackTarget, opts?: { startAt?: number }): void {
  play(target, opts).catch((e) => console.warn('play failed', e));
  navigate({ name: 'player' });
}

export async function openItem(item: Item, list?: Channel[]): Promise<void> {
  if (!(await unlockIfNeeded(item))) return;
  if (item.kind === 'live') {
    startPlayback({ kind: 'live', channel: item, list: list && list.length ? list : [item] });
  } else {
    navigate({ name: 'details', key: item.key });
  }
}

export function favoriteToggle(item: Item): void {
  const on = toggleFavorite(item.key);
  toast(on ? t('fav.added') : t('fav.removed'));
}

/** Options menu (Yellow / long OK): favorite, add to list, go to category. */
export function itemMenu(item: Item, extra: MenuOption[] = []): void {
  const fav = isFavorite(item.key);
  const lists = user.get().data.lists;
  const view = viewOfItem(item);
  const options: MenuOption[] = [
    { label: fav ? t('fav.remove') : t('fav.add'), onSelect: () => favoriteToggle(item) },
    {
      label: t('lists.addTo'),
      onSelect: () =>
        showMenu(
          t('lists.addTo'),
          lists
            .map<MenuOption>((l) => ({
              label: l.name,
              checked: l.items.indexOf(item.key) >= 0,
              onSelect: () => {
                addToList(l.id, item.key);
                toast(t('lists.added', { name: l.name }));
              },
            }))
            .concat([
              {
                label: t('lists.new'),
                onSelect: async () => {
                  const name = await promptText(t('lists.newName'));
                  if (name && name.trim()) {
                    const id = createList(name.trim());
                    addToList(id, item.key);
                    toast(t('lists.added', { name: name.trim() }));
                  }
                },
              },
            ]),
        ),
    },
  ];
  if (item.kind !== 'live') options.push(watchedOption(item));
  if (view) {
    options.push({
      label: t('item.goToCategory', { name: view.name }),
      onSelect: () => navigate(item.kind === 'live' ? { name: 'live', categoryId: view.id, channelKey: item.key } : { name: 'vod', kind: item.kind, categoryId: view.id }),
    });
  }
  showMenu(item.name, options.concat(extra));
}

/** Stars or unstars a category (shown first, with a star, in its section and the guide). */
export function favoriteCategoryToggle(view: CategoryView): void {
  const on = toggleFavoriteCategory(view.kind, view);
  toast(on ? t('categories.favAdded', { name: view.name }) : t('categories.favRemoved', { name: view.name }));
}

export function favoriteCategoryOption(view: CategoryView): MenuOption {
  return { label: isFavoriteCategory(view) ? t('categories.favRemove') : t('categories.favAdd'), onSelect: () => favoriteCategoryToggle(view) };
}

/** "Mark as watched / not watched" for a movie or a whole series. */
export function watchedOption(item: Item): MenuOption {
  const on = !isWatched(item.key);
  return {
    label: on ? t('watched.mark') : t('watched.unmark'),
    onSelect: () => {
      // A series: also drop the resume points of the episodes watched from it.
      const eps = item.kind === 'series' ? user.get().data.history.filter((h) => h.key === item.key && h.episodeKey).map((h) => h.episodeKey!) : [];
      setWatched([item.key], on, eps);
      toast(on ? t('watched.marked', { name: item.name }) : t('watched.unmarked', { name: item.name }));
    },
  };
}

/** Same for one episode. */
export function episodeWatchedOption(ep: { key: string; season: number; episode: number }): MenuOption {
  const on = !isWatched(ep.key);
  const name = 'S' + ep.season + ' · E' + ep.episode;
  return {
    label: on ? t('watched.mark') : t('watched.unmark'),
    onSelect: () => {
      setWatched([ep.key], on);
      toast(on ? t('watched.marked', { name }) : t('watched.unmarked', { name }));
    },
  };
}
