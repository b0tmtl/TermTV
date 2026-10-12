import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { resetTo } from '@/navigation/router';
import { initLibrary } from '@/state/library';
import { useStore } from '@/state/store';
import { activateProfile, saveProfiles, uid, user, type Profile } from '@/state/user';
import { Avatar, AVATAR_COUNT, Prompt } from '@/ui/Cards';
import { confirmDialog, promptPin, promptText, showMenu } from '@/ui/Dialog';
import { Icon } from '@/ui/icons';
import { toast } from '@/ui/ui-state';

export async function enterProfile(p: Profile): Promise<void> {
  if (p.pin) {
    const pin = await promptPin(t('profiles.enterPin', { name: p.name }));
    if (pin === null) return;
    if (pin !== p.pin) {
      toast(t('parental.wrongPin'));
      return;
    }
  }
  const first = !user.get().activeProfileId;
  await activateProfile(p.id);
  resetTo(user.get().sources.length ? { name: 'home' } : { name: 'welcome' });
  if (first || user.get().sources.length) initLibrary();
}

export async function editProfile(p?: Profile): Promise<void> {
  const name = await promptText(p ? t('profiles.rename') : t('profiles.newName'), p ? p.name : '');
  if (!name || !name.trim()) return;
  const profiles = user.get().profiles;
  if (p) saveProfiles(profiles.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x)));
  else saveProfiles(profiles.concat([{ id: uid(), name: name.trim(), avatar: (profiles.length * 5) % AVATAR_COUNT }]));
}

function profileMenu(p: Profile) {
  const profiles = user.get().profiles;
  showMenu(p.name, [
    { label: t('profiles.rename'), onSelect: () => editProfile(p) },
    {
      label: t('profiles.changeAvatar'),
      onSelect: () => saveProfiles(user.get().profiles.map((x) => (x.id === p.id ? { ...x, avatar: (x.avatar + 1) % AVATAR_COUNT } : x))),
    },
    {
      label: p.pin ? t('profiles.removePin') : t('profiles.setPin'),
      onSelect: async () => {
        if (p.pin) {
          saveProfiles(user.get().profiles.map((x) => (x.id === p.id ? { ...x, pin: undefined } : x)));
          return;
        }
        const pin = await promptPin(t('profiles.newPin'));
        if (pin) {
          saveProfiles(user.get().profiles.map((x) => (x.id === p.id ? { ...x, pin } : x)));
          toast(t('profiles.pinSet'));
        }
      },
    },
    ...(profiles.length > 1
      ? [
          {
            label: t('profiles.delete'),
            danger: true,
            onSelect: async () => {
              if (await confirmDialog(t('profiles.delete'), t('profiles.deleteText', { name: p.name }), t('common.delete'), true)) {
                saveProfiles(user.get().profiles.filter((x) => x.id !== p.id));
              }
            },
          },
        ]
      : []),
  ]);
}

export function ProfilesScreen() {
  const profiles = useStore(user, (s) => s.profiles);
  const lastId = useStore(user, (s) => s.app.lastProfileId);
  return (
    <div class="profiles">
      <Prompt path="~/whoami" cmd={t('profiles.title')} />
      <div class="list">
        {profiles.map((p) => (
          <div
            key={p.id}
            class="profile"
            data-focus-default={p.id === lastId ? '' : undefined}
            {...focusable({
              id: 'profile:' + p.id,
              onEnter: () => enterProfile(p),
              onKey: (k) => {
                if (k.key === 'yellow' || k.key === 'menu' || k.key === 'info') {
                  profileMenu(p);
                  return true;
                }
              },
            })}
          >
            <Avatar name={p.name} avatar={p.avatar} />
            <div class="name">
              {p.pin ? '🔒 ' : ''}
              {p.name}
            </div>
          </div>
        ))}
        {profiles.length < 8 && (
          <div class="profile" {...focusable({ id: 'profile:add', onEnter: () => editProfile() })}>
            <div class="avatar" style={{ background: 'transparent', color: 'var(--dim)' }}>
              <Icon name="plus" />
            </div>
            <div class="name">{t('profiles.add')}</div>
          </div>
        )}
      </div>
      <div class="hints" style={{ left: 0, right: 0, textAlign: 'center' }}>
        <span class="color-key yellow" />
        {t('profiles.hintManage')}
      </div>
    </div>
  );
}
