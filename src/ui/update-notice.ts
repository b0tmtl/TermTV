import { t } from '@/i18n';
import { checkForUpdate, shouldAnnounce, updateState } from '@/state/updates';
import { native } from '@/platform/android';
import { alertDialog, confirmDialog } from './Dialog';
import { toast } from './ui-state';

/** The notes of the latest release, shortened to fit a dialog, with how to install it. */
export function showReleaseNotes(): Promise<void> {
  const s = updateState.get();
  let notes = s.notes || '';
  if (notes.length > 900) notes = notes.slice(0, 900).replace(/\s+\S*$/, '') + '…';
  const title = s.available ? t('updates.availableTitle', { version: s.latest || '' }) : t('updates.notesTitle', { version: s.latest || '' });
  // Android: the app downloads the APK and opens the system installer.
  const bridge = native;
  if (bridge && s.available && s.apkUrl) {
    const url = s.apkUrl;
    return confirmDialog(title, (notes ? notes + '\n\n' : '') + t('updates.howToAndroid'), t('updates.install')).then((ok) => {
      if (!ok) return;
      toast(t('updates.downloading'));
      bridge.installApk(url);
    });
  }
  return alertDialog(title, (notes ? notes + '\n\n' : '') + (s.available ? t('updates.howTo') : ''));
}

/** At launch: once a day, ask GitHub; announce each new version once. */
export function scheduleUpdateCheck(delayMs = 15000): void {
  setTimeout(async () => {
    await checkForUpdate();
    if (shouldAnnounce()) showReleaseNotes();
  }, delayMs);
}
