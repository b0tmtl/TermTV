import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n';
import { focusable, keyHandler, popLayer, pushLayer } from '@/navigation/focus';
import { Keyboard } from './Keyboard';
import { typedChar } from './typing';
import { openDialog } from './ui-state';

/** A modal layer: arrows stay inside, Back closes it, focus returns where it was. */
export function Layer({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    pushLayer(el);
    return () => popLayer(el);
  }, []);
  return (
    <div class={'overlay ' + (cls || '')} ref={ref}>
      {children}
    </div>
  );
}

export interface MenuOption {
  label: string;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  onSelect: () => void;
  /** Keep the menu open after selecting (toggles). */
  keepOpen?: boolean;
}

export function MenuDialog({ title, text, options, close }: { title: string; text?: string; options: MenuOption[]; close: () => void }) {
  return (
    <Layer>
      <div class="dialog">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        <div class="opts" data-scroll="y" data-scroll-pad="80">
          {options.map((o, i) => (
            <div
              key={i}
              class="menu-item"
              {...focusable({
                onEnter: () => {
                  if (!o.keepOpen) close();
                  o.onSelect();
                },
              })}
              data-focus-default={o.checked ? '' : undefined}
            >
              <span class="check">{o.checked ? '●' : ''}</span>
              <span class={o.danger ? 'bad' : ''}>{o.label}</span>
              {o.hint && <span class="hint">{o.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </Layer>
  );
}

export function showMenu(title: string, options: MenuOption[], text?: string): void {
  openDialog((close) => <MenuDialog title={title} text={text} options={options} close={close} />);
}

export function confirmDialog(title: string, text: string, okLabel?: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog(
      (close) => (
        <Layer>
          <div class="dialog">
            <h2>{title}</h2>
            <p>{text}</p>
            <div>
              <span class="btn" data-focus-default="" {...focusable({ onEnter: () => (close(), resolve(false)) })}>
                {t('common.cancel')}
              </span>
              <span class={'btn primary' + (danger ? ' danger' : '')} {...focusable({ onEnter: () => (close(), resolve(true)) })}>
                {okLabel || t('common.ok')}
              </span>
            </div>
          </div>
        </Layer>
      ),
      () => resolve(false),
    );
  });
}

export function alertDialog(title: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    openDialog(
      (close) => (
        <Layer>
          <div class="dialog">
            <h2>{title}</h2>
            <p style={{ whiteSpace: 'pre-line' }}>{text}</p>
            <span class="btn primary" {...focusable({ onEnter: () => (close(), resolve()) })}>
              {t('common.ok')}
            </span>
          </div>
        </Layer>
      ),
      () => resolve(),
    );
  });
}

function TextPrompt({ title, initial, secret, close, done, hint }: { title: string; initial: string; secret?: boolean; hint?: string; close: () => void; done: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    close();
    done(value);
  };
  return (
    <Layer>
      <div class="dialog" {...keyHandler((k) => {
        // A physical keyboard types directly.
        const typed = typedChar(k);
        if (typed) {
          setValue((v) => v + typed);
          return true;
        }
        if (k.key === 'del') {
          setValue((v) => v.slice(0, -1));
          return true;
        }
        return false;
      })}>
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
        <div class="field" style={{ width: 1100 }}>
          <span class="value">
            {secret ? value.replace(/./g, '•') : value}
            <span class="caret" />
          </span>
        </div>
        <Keyboard value={value} onChange={setValue} onDone={submit} url={!secret && /url|server|http/i.test(title)} />
        <div style={{ marginTop: 18 }}>
          <span class="btn" {...focusable({ onEnter: () => (close(), done(null)) })}>
            {t('common.cancel')}
          </span>
          <span class="btn primary" {...focusable({ onEnter: submit })}>
            {t('common.done')}
          </span>
        </div>
      </div>
    </Layer>
  );
}

export function promptText(title: string, initial = '', opts: { secret?: boolean; hint?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    openDialog(
      (close) => <TextPrompt title={title} initial={initial} secret={opts.secret} hint={opts.hint} close={close} done={resolve} />,
      () => resolve(null),
    );
  });
}

function PinPad({ title, text, close, done }: { title: string; text?: string; close: () => void; done: (pin: string | null) => void }) {
  const [pin, setPin] = useState('');
  const press = (d: string) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      close();
      done(next);
    }
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <Layer>
      <div class="dialog" style={{ minWidth: 600, textAlign: 'center' }} {...keyHandler((k) => {
        if (k.key === 'digit') {
          press(String(k.digit));
          return true;
        }
        if (k.key === 'del') {
          setPin((p) => p.slice(0, -1));
          return true;
        }
        return false;
      })}>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        <div style={{ fontSize: 60, letterSpacing: 24, margin: '10px 0 26px', color: 'var(--accent)' }}>
          {'●●●●'.slice(0, pin.length) + '○○○○'.slice(pin.length)}
        </div>
        <div class="osk" style={{ display: 'inline-block' }}>
          {[0, 1, 2, 3].map((r) => (
            <div class="k-row" key={r}>
              {keys.slice(r * 3, r * 3 + 3).map((k) =>
                k ? (
                  <span key={k} class="k" style={{ width: 110, height: 80, fontSize: 34 }} {...focusable({ onEnter: () => (k === '⌫' ? setPin((p) => p.slice(0, -1)) : press(k)) })}>
                    {k}
                  </span>
                ) : (
                  <span key="blank" class="k" style={{ width: 110, height: 80, visibility: 'hidden' }} />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </Layer>
  );
}

export function promptPin(title: string, text?: string): Promise<string | null> {
  return new Promise((resolve) => {
    openDialog((close) => <PinPad title={title} text={text} close={close} done={resolve} />, () => resolve(null));
  });
}
