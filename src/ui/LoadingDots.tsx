import { useEffect, useState } from 'preact/hooks';
import { t } from '@/i18n';

/**
 * "Loading..." with dots, redrawn as text. Not the rotating spinner: over AVPlay's video plane the
 * spinner's animated layer could stay on screen as a white dot after it was removed.
 */
export function LoadingDots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => (x + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontSize: 28 }}>
      {t('player.loading')}
      <span style={{ display: 'inline-block', width: 40, textAlign: 'left' }}>{'...'.slice(0, n)}</span>
    </span>
  );
}
