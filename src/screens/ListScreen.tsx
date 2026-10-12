import type { Channel, Item } from '@/core/models';
import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { back } from '@/navigation/router';
import { itemByKey } from '@/state/library';
import { useStore } from '@/state/store';
import { deleteList, removeFromList, user } from '@/state/user';
import { ItemCard, Prompt } from '@/ui/Cards';
import { confirmDialog, promptText } from '@/ui/Dialog';
import { itemMenu, openItem } from '@/ui/actions';
import { VGrid } from '@/ui/VGrid';
import { updateData } from '@/state/user';
import { slug } from './Home';

export function ListScreen({ listId }: { listId: string }) {
  const list = useStore(user, (s) => s.data.lists.find((l) => l.id === listId));
  if (!list) return <div class="center-msg">{t('lists.notFound')}</div>;
  const items = list.items.map((k) => itemByKey(k)).filter((i): i is Item => !!i);
  const channels = items.filter((i) => i.kind === 'live') as Channel[];
  return (
    <div class="screen-pad">
      <Prompt path={`~/lists/${slug(list.name)}`} cmd="ls" count={items.length} />
      <div style={{ marginBottom: 10 }}>
        <span
          class="btn small"
          {...focusable({
            onEnter: async () => {
              const name = await promptText(t('lists.rename'), list.name);
              if (name && name.trim()) updateData((d) => ({ lists: d.lists.map((l) => (l.id === listId ? { ...l, name: name.trim() } : l)) }));
            },
          })}
        >
          {t('lists.rename')}
        </span>
        <span
          class="btn small danger"
          {...focusable({
            onEnter: async () => {
              if (await confirmDialog(t('lists.delete'), t('lists.deleteText', { name: list.name }), t('common.delete'), true)) {
                deleteList(listId);
                back();
              }
            },
          })}
        >
          {t('lists.delete')}
        </span>
      </div>
      {items.length ? (
        <VGrid
          id="lg"
          items={items}
          columns={7}
          rowHeight={420}
          height={860}
          onKey={(k, i) => {
            if (k.key === 'yellow' || k.key === 'menu') {
              const it = items[i];
              itemMenu(it, [{ label: t('lists.remove'), onSelect: () => removeFromList(listId, it.key) }]);
              return true;
            }
            return false;
          }}
          render={(it, _i, cell) => (
            <div key={it.key} style={{ padding: '14px 4px 0 6px' }}>
              <ItemCard item={it} id={cell.id} onFocus={cell.onFocus} onEnter={() => openItem(it, channels)} />
            </div>
          )}
        />
      ) : (
        <div class="dim">{t('lists.empty')}</div>
      )}
    </div>
  );
}
