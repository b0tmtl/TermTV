import './polyfills';
import { render } from 'preact';
import { App } from '@/app/App';
import { resetTo } from '@/navigation/router';
import { recoverInterruptedRebuild, rebuildDatabase } from '@/platform/db';
import { fileStoreAvailable } from '@/platform/filestore';
import { initLibrary, libraryState } from '@/state/library';
import { activateProfile, loadUser, user } from '@/state/user';

/** Startup progress on the boot screen (public/js/boot.js), to see where an old TV gets stuck. */
function step(name: string) {
  const fn = (window as unknown as { __termtvBootStep?: (n: string) => void }).__termtvBootStep;
  if (fn) fn(name);
}
step('app.js running');

/** Some TVs never answer the first IndexedDB request: don't wait forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      console.warn(`${label} timed out`);
      step(label + ' timed out');
      resolve(undefined);
    }, ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), console.error(label, e), resolve(undefined)),
    );
  });
}

async function start() {
  await withTimeout(recoverInterruptedRebuild(), 8000, 'restoring settings').catch((e) => console.warn(e));
  // Once per TV: earlier versions filled IndexedDB with library caches the TV never gave the space
  // back for, so even settings stopped saving. Rebuild it once (settings are kept).
  if (fileStoreAvailable() && readFlag() !== '1') {
    step('cleaning up storage');
    await withTimeout(rebuildDatabase(), 20000, 'cleaning up storage')
      .then(() => writeFlag('1'))
      .catch((e) => console.warn('storage rebuild failed', e));
  }
  step('loading settings');
  await withTimeout(loadUser(), 8000, 'loading settings');
  step('settings loaded');
  if (!user.get().loaded) user.set({ loaded: true, profiles: user.get().profiles.length ? user.get().profiles : [{ id: 'default', name: 'Me', avatar: 0 }] });
  const s = user.get();
  // One profile without a PIN: skip "Who's watching?".
  if (s.profiles.length === 1 && !s.profiles[0].pin) {
    await withTimeout(activateProfile(s.profiles[0].id), 5000, 'loading profile');
    if (!user.get().activeProfileId) user.set({ activeProfileId: s.profiles[0].id });
    resetTo(s.sources.length ? { name: 'home' } : { name: 'welcome' });
  } else {
    resetTo({ name: 'profiles' });
  }
  // Mark the library as loading before the first frame: reading the cache can keep the TV busy, and
  // the first frame would otherwise say "Your sources didn't return anything".
  if (user.get().activeProfileId && user.get().sources.some((x) => x.enabled)) libraryState.set({ status: 'loading' });
  step('rendering');
  render(<App />, document.getElementById('app')!);
  step('rendered');
  const splash = document.getElementById('splash');
  if (splash) splash.parentNode!.removeChild(splash);
  if (user.get().activeProfileId) initLibrary();
}

start().catch((e) => {
  const show = (window as unknown as { __termtvBootError?: (m: string) => void }).__termtvBootError;
  if (show) show('Startup failed: ' + (e && (e.stack || e.message) ? e.stack || e.message : String(e)));
});

const FLAG = 'termtv-storage-rebuilt';
function readFlag(): string | null {
  try {
    return localStorage.getItem(FLAG);
  } catch {
    return null;
  }
}
function writeFlag(v: string): void {
  try {
    localStorage.setItem(FLAG, v);
  } catch {
    /* ignore */
  }
}
