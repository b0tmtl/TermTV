// First launch ("Welcome") and the Add / Edit source form.

import { useState } from 'preact/hooks';
import { Glyph } from '@/ui/Glyph';
import type { Source, SourceConfig } from '@/core/models';
import { t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { back, navigate, resetTo } from '@/navigation/router';
import { normalizeServer, xtreamFromUrl } from '@/providers/xtream';
import { libraryState, refreshSource, sourcesChanged } from '@/state/library';
import { useStore } from '@/state/store';
import { saveSources, uid, user } from '@/state/user';
import { Prompt } from '@/ui/Cards';
import { promptText } from '@/ui/Dialog';
import { Icon } from '@/ui/icons';
import { toast } from '@/ui/ui-state';

export function WelcomeScreen() {
  return (
    <div class="screen-pad" style={{ paddingTop: 120, paddingLeft: 160 }}>
      <div style={{ fontSize: 30, color: 'var(--dim)', marginBottom: 12 }}>TermTV {__VERSION__}</div>
      <Prompt path="~/welcome" cmd="./setup.sh" />
      <div style={{ fontSize: 30, maxWidth: 1300, lineHeight: 1.5, marginBottom: 40 }}>
        {t('welcome.text')}
        <div class="dim" style={{ fontSize: 24, marginTop: 16 }}>{t('welcome.free')}</div>
      </div>
      <span class="btn primary" data-focus-default="" {...focusable({ onEnter: () => navigate({ name: 'addSource' }) })}>
        <Icon name="plus" />
        {t('sources.add')}
      </span>
      <span class="btn" {...focusable({ onEnter: () => navigate({ name: 'settings', section: 'backup' }) })}>
        {t('welcome.restore')}
      </span>
    </div>
  );
}

type Mode = 'xtream' | 'm3u';

export function AddSourceScreen({ editId }: { editId?: string }) {
  const existing = user.get().sources.find((s) => s.id === editId);
  const [mode, setMode] = useState<Mode>(existing ? existing.config.type : 'xtream');
  const [name, setName] = useState(existing ? existing.name : '');
  const [server, setServer] = useState(existing && existing.config.type === 'xtream' ? existing.config.server : '');
  const [username, setUsername] = useState(existing && existing.config.type === 'xtream' ? existing.config.username : '');
  const [password, setPassword] = useState(existing && existing.config.type === 'xtream' ? existing.config.password : '');
  const [url, setUrl] = useState(existing && existing.config.type === 'm3u' ? existing.config.url : '');
  const [epgUrl, setEpgUrl] = useState(existing && existing.config.type === 'm3u' ? existing.config.epgUrl || '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refreshing = useStore(libraryState, (s) => s.refreshing);

  const edit = (label: string, value: string, set: (v: string) => void, secret = false) => async () => {
    const v = await promptText(label, value, { secret });
    if (v !== null) set(v.trim());
  };

  const save = async () => {
    setError('');
    let config: SourceConfig;
    if (mode === 'xtream') {
      if (!server || !username || !password) return setError(t('sources.missing'));
      config = { type: 'xtream', server: normalizeServer(server), username, password };
    } else {
      if (!/^https?:\/\//i.test(url)) return setError(t('sources.badUrl'));
      // A pasted Xtream "get.php" link works better through the Xtream API.
      const asXtream = xtreamFromUrl(url);
      config = asXtream || { type: 'm3u', url, epgUrl: epgUrl || undefined };
      if (asXtream) toast(t('sources.detectedXtream'));
    }
    const source: Source = {
      id: existing ? existing.id : uid(),
      name: name || defaultName(config),
      enabled: true,
      config,
      addedAt: existing ? existing.addedAt : Date.now(),
    };
    setBusy(true);
    const ok = await refreshSource(source);
    setBusy(false);
    if (!ok) {
      setError(libraryState.get().errors[source.id] || t('sources.failed'));
      return;
    }
    const sources = user.get().sources;
    saveSources(existing ? sources.map((s) => (s.id === source.id ? source : s)) : sources.concat([source]));
    sourcesChanged();
    toast(t('sources.saved'));
    if (existing) back();
    else resetTo({ name: 'home' });
  };

  const stage = Object.keys(refreshing).length ? refreshing[Object.keys(refreshing)[0]] : null;

  return (
    <div class="screen-pad" style={{ paddingLeft: 120, paddingTop: 60 }}>
      <Prompt path="~/sources" cmd={existing ? t('sources.edit') : t('sources.add')} />
      <div class="chips" style={{ marginBottom: 26 }}>
        <span class={'chip' + (mode === 'xtream' ? ' active' : '')} data-focus-default="" {...focusable({ onEnter: () => setMode('xtream') })}>
          Xtream Codes
        </span>
        <span class={'chip' + (mode === 'm3u' ? ' active' : '')} {...focusable({ onEnter: () => setMode('m3u') })}>
          {t('sources.m3u')}
        </span>
      </div>
      <div style={{ width: 1300 }}>
        <Field label={t('sources.name')} value={name} placeholder={t('sources.namePlaceholder')} onEnter={edit(t('sources.name'), name, setName)} />
        {mode === 'xtream' ? (
          <>
            <Field label={t('sources.server')} value={server} placeholder="http://provider.example:8080" onEnter={edit(t('sources.server'), server, setServer)} />
            <Field label={t('sources.username')} value={username} onEnter={edit(t('sources.username'), username, setUsername)} />
            <Field label={t('sources.password')} value={password ? '•'.repeat(password.length) : ''} onEnter={edit(t('sources.password'), password, setPassword, true)} />
          </>
        ) : (
          <>
            <Field label={t('sources.playlistUrl')} value={url} placeholder="http://…/playlist.m3u" onEnter={edit(t('sources.playlistUrl'), url, setUrl)} />
            <Field label={t('sources.epgUrl')} value={epgUrl} placeholder={t('sources.epgOptional')} onEnter={edit(t('sources.epgUrl'), epgUrl, setEpgUrl)} />
          </>
        )}
      </div>
      <div style={{ marginTop: 20 }}>
        <span class="btn primary" {...focusable({ onEnter: () => !busy && save() })}>
          {busy ? <span class="spinner" style={{ width: 30, height: 30, marginRight: 14 }} /> : <Icon name="check" />}
          {busy ? t('sources.connecting') : t('sources.connect')}
        </span>
        <span class="btn" {...focusable({ onEnter: () => back() })}>
          {t('common.cancel')}
        </span>
      </div>
      {busy && stage && <div class="status-line">{stageLabel(stage.stage, stage.loaded, stage.total)}</div>}
      {error && <div class="bad" style={{ marginTop: 10, fontSize: 24, maxWidth: 1300 }}><Glyph n="cross" gap />{error}</div>}
      <div class="dim" style={{ marginTop: 30, fontSize: 21, maxWidth: 1300 }}>{t('sources.privacy')}</div>
    </div>
  );
}

function Field({ label, value, placeholder, onEnter }: { label: string; value: string; placeholder?: string; onEnter: () => void }) {
  return (
    <div class="field" {...focusable({ onEnter })}>
      <span class="label">{label}</span>
      <span class={'value' + (value ? '' : ' placeholder')}>{value || placeholder || ''}</span>
    </div>
  );
}

function defaultName(c: SourceConfig): string {
  const host = /^https?:\/\/([^/:?#]+)/i.exec(c.type === 'xtream' ? c.server : c.url);
  return host ? host[1] : 'Source';
}

export function stageLabel(stage: string, loaded?: number, total?: number): string {
  const mb = (n: number) => (n / 1048576).toFixed(1);
  switch (stage) {
    case 'auth':
      return t('progress.auth');
    case 'library':
      return t('progress.library');
    case 'download':
      return loaded ? t('progress.download', { done: mb(loaded), total: total ? ' / ' + mb(total) : '' }) : t('progress.downloadStart');
    case 'epg':
      return loaded ? t('progress.epg', { done: mb(loaded) }) : t('progress.epgStart');
    default:
      return t('progress.start');
  }
}
