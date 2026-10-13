// What happens when the user opens or long-presses an item, shared by every screen.

import type { Channel, Item } from '@/core/models';
import { t } from '@/i18n';
import { navigate } from '@/navigation/router';
import { isItemLocked, viewOfItem } from '@/state/library';
import { play, type PlaybackTarget } from '@/state/player';
import { addToList, createList, isFavorite, toggleFavorite, user } from '@/state/user';
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
  if (view) {
    options.push({
      label: t('item.goToCategory', { name: view.name }),
      onSelect: () => navigate(item.kind === 'live' ? { name: 'live', categoryId: view.id, channelKey: item.key } : { name: 'vod', kind: item.kind, categoryId: view.id }),
    });
  }
  showMenu(item.name, options.concat(extra));
}
