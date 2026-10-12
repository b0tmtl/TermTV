import './polyfills';
import { render } from 'preact';
import { App } from '@/app/App';
import { resetTo } from '@/navigation/router';
import { initLibrary } from '@/state/library';
import { activateProfile, loadUser, user } from '@/state/user';

async function start() {
  await loadUser().catch((e) => console.error('could not load settings', e));
  const s = user.get();
  // One profile without a PIN: skip "Who's watching?".
  if (s.profiles.length === 1 && !s.profiles[0].pin) {
    await activateProfile(s.profiles[0].id);
    resetTo(s.sources.length ? { name: 'home' } : { name: 'welcome' });
  } else {
    resetTo({ name: 'profiles' });
  }
  render(<App />, document.getElementById('app')!);
  if (user.get().activeProfileId) initLibrary();
  const splash = document.getElementById('splash');
  if (splash) splash.parentNode!.removeChild(splash);
}

start();
