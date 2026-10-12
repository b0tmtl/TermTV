// On-screen keyboard built for the remote. The Samsung system keyboard covers the whole screen and is
// slow, so text entry happens here; a physical/USB keyboard also works (keys go to the dialog).

import { useState } from 'preact/hooks';
import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';

const LETTERS = ['abcdefghijklm', 'nopqrstuvwxyz', '1234567890-_.'];
const SYMBOLS = ['!@#$%^&*()+=/', ':;?,\'"<>[]{}|', '~`\\€£¥§°¿¡'];
const URL_KEYS = ['http://', 'https://', '.com', ':8080', '/'];

export function Keyboard({ value, onChange, onDone, url }: { value: string; onChange: (v: string) => void; onDone?: () => void; url?: boolean }) {
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);
  const rows = sym ? SYMBOLS : LETTERS;
  const type = (s: string) => onChange(value + (shift && !sym ? s.toUpperCase() : s));
  return (
    <div class="osk">
      {url && (
        <div class="k-row">
          {URL_KEYS.map((k) => (
            <span key={k} class="k wide" {...focusable({ onEnter: () => onChange(value + k) })}>
              {k}
            </span>
          ))}
        </div>
      )}
      {rows.map((r, ri) => (
        <div class="k-row" key={ri}>
          {r.split('').map((c) => (
            <span key={c} class="k" data-focus-default={ri === 0 && c === r[0] ? '' : undefined} {...focusable({ onEnter: () => type(c) })}>
              {shift && !sym ? c.toUpperCase() : c}
            </span>
          ))}
        </div>
      ))}
      <div class="k-row">
        <span class={'k wide' + (shift ? ' on' : '')} {...focusable({ onEnter: () => setShift(!shift) })}>
          {shift ? 'ABC' : 'abc'}
        </span>
        <span class="k wide" {...focusable({ onEnter: () => setSym(!sym) })}>
          {sym ? 'abc' : '#+='}
        </span>
        <span class="k xwide" {...focusable({ onEnter: () => onChange(value + ' ') })}>
          {t('keyboard.space')}
        </span>
        <span class="k wide" {...focusable({ onEnter: () => onChange(value.slice(0, -1)) })}>
          ⌫
        </span>
        <span class="k wide" {...focusable({ onEnter: () => onChange('') })}>
          {t('keyboard.clear')}
        </span>
        {onDone && (
          <span class="k wide" {...focusable({ onEnter: onDone })}>
            {t('keyboard.ok')}
          </span>
        )}
      </div>
    </div>
  );
}
