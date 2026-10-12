import type { ComponentChildren } from 'preact';
import { Glyph } from '@/ui/Glyph';
import { useState } from 'preact/hooks';
import type { Source } from '@/core/models';
import { currentLanguage, formatDate, languages, t } from '@/i18n';
import { focusable } from '@/navigation/focus';
import { navigate, resetTo, updateRoute } from '@/navigation/router';
import { BACKUP_NAME, openTextFile, saveTextFile } from '@/platform/files';
import { deviceInfo } from '@/platform/tv';
import { counts, forgetSource, libraryState, refreshEpg, refreshSource, refreshSources, sourceLibrary, sourcesChanged } from '@/state/library';
import { cacheState, testStorage } from '@/state/cache';
import { useStore } from '@/state/store';
import {
  exportBackup, importBackup, saveSources, updateApp, updateCategoryPrefs, updateSettings, user, type ProfileSettings, type SubtitleStyle, type ThemeId,
} from '@/state/user';
import { Prompt } from '@/ui/Cards';
import { alertDialog, confirmDialog, promptPin, showMenu } from '@/ui/Dialog';
import { askPin } from '@/ui/actions';
import { Icon } from '@/ui/icons';
import { toast } from '@/ui/ui-state';
import { stageLabel } from './Sources';

const SECTIONS = ['sources', 'categories', 'appearance', 'player', 'subtitles', 'parental', 'guide', 'backup', 'language', 'about'] as const;
type Section = (typeof SECTIONS)[number];

const THEMES: ThemeId[] = ['midnight', 'matrix', 'amber', 'purple', 'synthwave', 'paper'];

export function SettingsScreen({ section }: { section?: string }) {
  const [sec, setSec] = useState<Section>((SECTIONS.indexOf(section as Section) >= 0 ? section : 'sources') as Section);
  const select = (s: Section) => {
    setSec(s);
    updateRoute({ section: s } as never);
  };
  return (
    <div class="settings">
      <div class="menu" data-focus-memory="">
        <div class="col-head">
          <span class="accent"><Glyph n="prompt" /></span> ~/settings <span class="dim">ls</span>
        </div>
        {SECTIONS.map((s) => (
          <div
            key={s}
            class={'list-item' + (s === sec ? ' active' : '')}
            data-focus-default={s === sec ? '' : undefined}
            {...focusable({ id: 'set:' + s, onEnter: () => select(s), onFocus: () => select(s) })}
          >
            <span class="name">{t('settings.' + s)}</span>
          </div>
        ))}
      </div>
      <div class="pane" data-scroll="y" data-scroll-pad="120" data-focus-memory="">
        <Prompt path={'~/settings/' + sec} cmd="vim" small />
        {sec === 'sources' && <SourcesPane />}
        {sec === 'categories' && <CategoriesPane />}
        {sec === 'appearance' && <AppearancePane />}
        {sec === 'player' && <PlayerPane />}
        {sec === 'subtitles' && <SubtitlesPane />}
        {sec === 'parental' && <ParentalPane />}
        {sec === 'guide' && <GuidePane />}
        {sec === 'backup' && <BackupPane />}
        {sec === 'language' && <LanguagePane />}
        {sec === 'about' && <AboutPane />}
      </div>
    </div>
  );
}

function Setting({ label, desc, value, onEnter }: { label: string; desc?: string; value?: ComponentChildren; onEnter?: () => void }) {
  return (
    <div class="setting" {...focusable({ onEnter })}>
      <span class="l">
        {label}
        {desc && <span class="d">{desc}</span>}
      </span>
      {value !== undefined && <span class="v">{value}</span>}
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return <span class={'toggle' + (on ? ' on' : '')} />;
}

function choose<T extends string | number>(title: string, options: Array<{ value: T; label: string }>, current: T, set: (v: T) => void) {
  showMenu(
    title,
    options.map((o) => ({ label: o.label, checked: o.value === current, onSelect: () => set(o.value) })),
  );
}

// ---- Sources -----------------------------------------------------------------------------------

function SourcesPane() {
  const sources = useStore(user, (s) => s.sources);
  const refreshing = useStore(libraryState, (s) => s.refreshing);
  const errors = useStore(libraryState, (s) => s.errors);
  useStore(libraryState, (s) => s.version);
  const c = counts();

  const sourceMenu = (src: Source) => {
    showMenu(src.name, [
      { label: t('sources.refresh'), onSelect: () => refreshSource(src) },
      { label: t('sources.refreshGuide'), onSelect: () => refreshEpg(src).then(() => toast(t('sources.guideUpdated'))) },
      { label: t('sources.edit'), onSelect: () => navigate({ name: 'addSource', editId: src.id }) },
      {
        label: src.enabled ? t('sources.disable') : t('sources.enable'),
        onSelect: () => {
          saveSources(user.get().sources.map((s) => (s.id === src.id ? { ...s, enabled: !s.enabled } : s)));
          sourcesChanged();
          if (!src.enabled && !sourceLibrary(src.id)) refreshSource({ ...src, enabled: true });
        },
      },
      {
        label: t('sources.moveUp'),
        onSelect: () => {
          const list = user.get().sources.slice();
          const i = list.findIndex((s) => s.id === src.id);
          if (i > 0) {
            list.splice(i - 1, 0, list.splice(i, 1)[0]);
            saveSources(list);
            sourcesChanged();
          }
        },
      },
      {
        label: t('sources.delete'),
        danger: true,
        onSelect: async () => {
          if (!(await confirmDialog(t('sources.delete'), t('sources.deleteText', { name: src.name }), t('common.delete'), true))) return;
          saveSources(user.get().sources.filter((s) => s.id !== src.id));
          await forgetSource(src.id);
        },
      },
    ]);
  };

  return (
    <div>
      <div class="dim" style={{ marginBottom: 20, fontSize: 22 }}>
        {t('sources.summary', { live: c.live, movies: c.movie, series: c.series })}
      </div>
      {sources.map((src) => {
        const lib = sourceLibrary(src.id);
        const r = refreshing[src.id];
        const err = errors[src.id];
        const acct = lib && lib.account;
        let desc = src.config.type === 'xtream' ? `Xtream · ${src.config.server}` : `M3U · ${src.config.url}`;
        if (lib) desc += ` · ${t('sources.items', { live: lib.live.length, movies: lib.movies.length, series: lib.series.length })}`;
        if (acct && acct.expiresAt) desc += ` · ${t('sources.expires', { date: formatDate(acct.expiresAt) })}`;
        return (
          <Setting
            key={src.id}
            label={src.enabled ? src.name : `${src.name} (${t('sources.disabled')})`}
            desc={r ? stageLabel(r.stage, r.loaded, r.total) : err ? t('sources.errorPrefix', { error: err }) : desc}
            value={r ? <span class="spinner" style={{ width: 30, height: 30 }} /> : lib ? t('sources.updated', { date: formatDate(lib.updatedAt) }) : ''}
            onEnter={() => sourceMenu(src)}
          />
        );
      })}
      <div style={{ marginTop: 18 }}>
        <span class="btn primary" {...focusable({ onEnter: () => navigate({ name: 'addSource' }) })}>
          <Icon name="plus" />
          {t('sources.add')}
        </span>
        {sources.length > 0 && (
          <span class="btn" {...focusable({ onEnter: () => refreshSources() })}>
            <Icon name="refresh" />
            {t('sources.refreshAll')}
          </span>
        )}
      </div>
      <Setting
        label={t('settings.refreshOnLaunch')}
        desc={t('settings.refreshOnLaunchDesc')}
        value={<Toggle on={user.get().app.refreshOnLaunch} />}
        onEnter={() => updateApp({ refreshOnLaunch: !user.get().app.refreshOnLaunch })}
      />
      <Setting
        label={t('settings.skipHidden')}
        desc={t('settings.skipHiddenDesc')}
        value={<Toggle on={user.get().app.skipHidden} />}
        onEnter={() => {
          const on = !user.get().app.skipHidden;
          updateApp({ skipHidden: on });
          toast(on ? t('settings.skipHiddenOn') : t('settings.skipHiddenOff'));
        }}
      />
    </div>
  );
}

// ---- Categories --------------------------------------------------------------------------------

function CategoriesPane() {
  const app = useStore(user, (s) => s.app);
  const settings = useStore(user, (s) => s.data.settings);
  return (
    <div>
      <div class="dim" style={{ marginBottom: 20, fontSize: 22 }}>{t('categories.intro')}</div>
      <Setting label={t('categories.live')} value={<Glyph n="arrow" />} onEnter={() => navigate({ name: 'categories', kind: 'live' })} />
      <Setting label={t('categories.movies')} value={<Glyph n="arrow" />} onEnter={() => navigate({ name: 'categories', kind: 'movie' })} />
      <Setting label={t('categories.series')} value={<Glyph n="arrow" />} onEnter={() => navigate({ name: 'categories', kind: 'series' })} />
      <Setting
        label={t('categories.newPolicy')}
        desc={t('categories.newPolicyDesc')}
        value={app.newCategories === 'show' ? t('categories.newShow') : t('categories.newHide')}
        onEnter={() => {
          const v = app.newCategories === 'show' ? 'hide' : 'show';
          updateApp({ newCategories: v });
          for (const k of ['live', 'movie', 'series'] as const) updateCategoryPrefs(k, (p) => ({ ...p, newCategories: v }));
        }}
      />
      <Setting
        label={t('settings.searchHidden')}
        desc={t('settings.searchHiddenDesc')}
        value={<Toggle on={settings.searchHidden} />}
        onEnter={() => updateSettings({ searchHidden: !settings.searchHidden })}
      />
    </div>
  );
}

// ---- Appearance --------------------------------------------------------------------------------

function AppearancePane() {
  const s = useStore(user, (x) => x.data.settings);
  return (
    <div>
      <Setting
        label={t('settings.theme')}
        value={t('theme.' + s.theme)}
        onEnter={() => choose(t('settings.theme'), THEMES.map((v) => ({ value: v, label: t('theme.' + v) })), s.theme, (v) => updateSettings({ theme: v }))}
      />
      <Setting label={t('settings.clock24h')} value={<Toggle on={s.clock24h} />} onEnter={() => updateSettings({ clock24h: !s.clock24h })} />
      <Setting label={t('settings.showRecent')} desc={t('settings.showRecentDesc')} value={<Toggle on={s.showRecent} />} onEnter={() => updateSettings({ showRecent: !s.showRecent })} />
    </div>
  );
}

// ---- Player ------------------------------------------------------------------------------------

function PlayerPane() {
  const s = useStore(user, (x) => x.data.settings);
  return (
    <div>
      <Setting
        label={t('settings.engine')}
        desc={t('settings.engineDesc')}
        value={s.playerEngine === 'native' ? t('settings.engineNative') : t('settings.engineHtml5')}
        onEnter={() => updateSettings({ playerEngine: s.playerEngine === 'native' ? 'html5' : 'native' })}
      />
      <Setting
        label={t('settings.liveFormat')}
        desc={t('settings.liveFormatDesc')}
        value={s.liveFormat === 'ts' ? 'MPEG-TS (.ts)' : 'HLS (.m3u8)'}
        onEnter={() => updateSettings({ liveFormat: s.liveFormat === 'ts' ? 'm3u8' : 'ts' })}
      />
      <Setting label={t('settings.autoplayNext')} value={<Toggle on={s.autoplayNext} />} onEnter={() => updateSettings({ autoplayNext: !s.autoplayNext })} />
      <Setting
        label={t('settings.audioLanguage')}
        value={s.audioLanguage || t('settings.default')}
        onEnter={() => choose(t('settings.audioLanguage'), LANG_CHOICES.map((l) => ({ value: l.code, label: l.name })), s.audioLanguage, (v) => updateSettings({ audioLanguage: v }))}
      />
    </div>
  );
}

const LANG_CHOICES = [
  { code: '', name: 'Default' }, { code: 'en', name: 'English' }, { code: 'fr', name: 'Français' }, { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' }, { code: 'it', name: 'Italiano' }, { code: 'pt', name: 'Português' }, { code: 'ar', name: 'العربية' },
  { code: 'tr', name: 'Türkçe' }, { code: 'nl', name: 'Nederlands' }, { code: 'pl', name: 'Polski' }, { code: 'ru', name: 'Русский' },
];

// ---- Subtitles ---------------------------------------------------------------------------------

function SubtitlesPane() {
  const s = useStore(user, (x) => x.data.settings);
  const st = s.subtitles;
  const setStyle = (patch: Partial<SubtitleStyle>) => updateSettings({ subtitles: { ...st, ...patch } } as Partial<ProfileSettings>);
  const colors = [
    { value: '#ffffff', label: t('color.white') }, { value: '#ffeb3b', label: t('color.yellow') }, { value: '#00e5ff', label: t('color.cyan') }, { value: '#76ff03', label: t('color.green') },
  ];
  return (
    <div>
      <div style={{ position: 'relative', height: 150, background: '#222 linear-gradient(135deg,#334,#111)', borderRadius: 10, marginBottom: 22, overflow: 'hidden' }}>
        <div class={`subs ${st.size} ${st.background}`} style={{ color: st.color, bottom: 20, fontSize: undefined }}>
          <span>{t('settings.subtitlePreview')}</span>
        </div>
      </div>
      <Setting label={t('settings.subtitlesAuto')} desc={t('settings.subtitlesAutoDesc')} value={<Toggle on={s.subtitlesAuto} />} onEnter={() => updateSettings({ subtitlesAuto: !s.subtitlesAuto })} />
      <Setting
        label={t('settings.subtitleLanguage')}
        value={(LANG_CHOICES.find((l) => l.code === s.subtitleLanguage) || { name: s.subtitleLanguage }).name}
        onEnter={() => choose(t('settings.subtitleLanguage'), LANG_CHOICES.slice(1).map((l) => ({ value: l.code, label: l.name })), s.subtitleLanguage, (v) => updateSettings({ subtitleLanguage: v }))}
      />
      <Setting
        label={t('settings.subtitleSize')}
        value={t('size.' + st.size)}
        onEnter={() => choose(t('settings.subtitleSize'), (['small', 'medium', 'large', 'xlarge'] as const).map((v) => ({ value: v, label: t('size.' + v) })), st.size, (v) => setStyle({ size: v }))}
      />
      <Setting
        label={t('settings.subtitleColor')}
        value={<span style={{ color: st.color }}><Glyph n="box" gap />{(colors.find((c) => c.value === st.color) || colors[0]).label}</span>}
        onEnter={() => choose(t('settings.subtitleColor'), colors, st.color, (v) => setStyle({ color: v }))}
      />
      <Setting
        label={t('settings.subtitleBackground')}
        value={t('subbg.' + st.background)}
        onEnter={() => choose(t('settings.subtitleBackground'), (['none', 'shadow', 'box'] as const).map((v) => ({ value: v, label: t('subbg.' + v) })), st.background, (v) => setStyle({ background: v }))}
      />
      <Setting
        label={t('settings.subtitlePosition')}
        value={t('subpos.' + st.position)}
        onEnter={() => choose(t('settings.subtitlePosition'), (['bottom', 'raised', 'top'] as const).map((v) => ({ value: v, label: t('subpos.' + v) })), st.position, (v) => setStyle({ position: v }))}
      />
    </div>
  );
}

// ---- Parental ----------------------------------------------------------------------------------

function ParentalPane() {
  const app = useStore(user, (s) => s.app);
  const locked = useStore(user, (s) => s.data.locked);
  const setPin = async () => {
    if (app.parentalPin && !(await askPin())) return;
    const pin = await promptPin(t('parental.newPin'));
    if (!pin) return;
    const again = await promptPin(t('parental.confirmPin'));
    if (again !== pin) return toast(t('parental.mismatch'));
    updateApp({ parentalPin: pin });
    toast(t('parental.pinSaved'));
  };
  return (
    <div>
      <div class="dim" style={{ marginBottom: 20, fontSize: 22 }}>{t('parental.intro')}</div>
      <Setting label={app.parentalPin ? t('parental.changePin') : t('parental.setPin')} value={app.parentalPin ? '••••' : t('parental.notSet')} onEnter={setPin} />
      {app.parentalPin && (
        <>
          <Setting
            label={t('parental.mode')}
            desc={t('parental.modeDesc')}
            value={app.lockMode === 'hide' ? t('parental.modeHide') : t('parental.modePin')}
            onEnter={async () => (await askPin()) && updateApp({ lockMode: app.lockMode === 'hide' ? 'pin' : 'hide' })}
          />
          <Setting label={t('parental.lockedCount', { count: locked.length })} desc={t('parental.howToLock')} value={<Glyph n="arrow" />} onEnter={() => navigate({ name: 'categories', kind: 'live' })} />
          <Setting
            label={t('parental.removePin')}
            onEnter={async () => {
              if (!(await askPin())) return;
              updateApp({ parentalPin: '' });
              toast(t('parental.pinRemoved'));
            }}
          />
        </>
      )}
      <Setting label={t('settings.profiles')} desc={t('settings.profilesDesc')} value={<Glyph n="arrow" />} onEnter={() => resetTo({ name: 'profiles' })} />
    </div>
  );
}

// ---- Guide -------------------------------------------------------------------------------------

function GuidePane() {
  const app = useStore(user, (s) => s.app);
  return (
    <div>
      <Setting
        label={t('settings.epgDays')}
        desc={t('settings.epgDaysDesc')}
        value={t('settings.hours', { count: app.epgHoursAhead })}
        onEnter={() => choose(t('settings.epgDays'), [12, 24, 48, 72].map((h) => ({ value: h, label: t('settings.hours', { count: h }) })), app.epgHoursAhead, (v) => updateApp({ epgHoursAhead: v }))}
      />
      <Setting
        label={t('sources.refreshGuide')}
        onEnter={() => {
          user.get().sources.filter((s) => s.enabled).forEach((s) => refreshEpg(s));
          toast(t('sources.guideRefreshing'));
        }}
      />
    </div>
  );
}

// ---- Backup ------------------------------------------------------------------------------------

function BackupPane() {
  const doExport = async () => {
    try {
      const b = await exportBackup();
      const where = await saveTextFile(BACKUP_NAME, JSON.stringify(b, null, 1));
      alertDialog(t('backup.saved'), t('backup.savedText', { where }));
    } catch (e) {
      alertDialog(t('backup.failed'), e instanceof Error && e.message === 'NO_USB' ? t('backup.noUsb') : String(e));
    }
  };
  const doImport = async () => {
    try {
      const text = await openTextFile(BACKUP_NAME);
      const b = JSON.parse(text);
      if (!(await confirmDialog(t('backup.restore'), t('backup.restoreText'), t('backup.restore'), true))) return;
      await importBackup(b);
      location.reload();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      alertDialog(t('backup.failed'), m === 'NO_USB' ? t('backup.noUsb') : m === 'NO_FILE' ? t('backup.noFile', { name: BACKUP_NAME }) : m);
    }
  };
  return (
    <div>
      <div class="dim" style={{ marginBottom: 20, fontSize: 22 }}>{t('backup.intro')}</div>
      <Setting label={t('backup.export')} desc={t('backup.exportDesc', { name: BACKUP_NAME })} onEnter={doExport} />
      <Setting label={t('backup.import')} desc={t('backup.importDesc', { name: BACKUP_NAME })} onEnter={doImport} />
    </div>
  );
}

// ---- Language & About --------------------------------------------------------------------------

function LanguagePane() {
  const cur = currentLanguage();
  return (
    <div>
      {languages().map((l) => (
        <Setting key={l.code} label={l.name} value={l.code === cur ? <Glyph n="dot" /> : ''} onEnter={() => updateApp({ language: l.code })} />
      ))}
      <div class="dim" style={{ marginTop: 20, fontSize: 21 }}>{t('settings.translateHelp')}</div>
    </div>
  );
}

function CacheStatus() {
  const cache = useStore(cacheState, (s) => s.library);
  const sources = useStore(user, (s) => s.sources);
  if (!sources.length) return null;
  const size = (b?: number) => (!b ? '' : b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  return (
    <div class="dim" style={{ marginTop: 10 }}>
      {t('about.cache')}:
      {sources.map((src) => {
        const c = cache[src.id];
        const vars = {
          source: src.name,
          size: size(c && c.bytes),
          date: c ? formatDate(c.at) : '',
          error: (c && c.error) || '',
          stage: (c && c.stage) || '',
          where: c && c.where === 'file' ? t('about.whereFile') : t('about.whereIdb'),
        };
        const text = !c
          ? t('about.cacheNone', vars)
          : c.stage
            ? t('about.cacheWorking', vars)
            : !c.ok
              ? t('about.cacheFailed', vars)
              : !c.bytes
                ? t('about.cacheNone', vars)
                : c.loaded
                  ? t('about.cacheLoaded', vars)
                  : t('about.cacheSaved', vars);
        return (
          <div key={src.id} class={c && !c.ok ? 'bad' : ''} style={{ fontSize: 21 }}>
            {text}
            {c && c.loaded && (c.read || c.decode) ? <div class="faint">{[c.read, c.decode].filter(Boolean).join(' · ')}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function AboutPane() {
  const d = deviceInfo();
  return (
    <div style={{ fontSize: 24, lineHeight: 1.7 }}>
      <div>
        <b>TermTV</b> {__VERSION__}
      </div>
      <div class="dim">{t('about.tagline')}</div>
      <div style={{ marginTop: 20 }}>
        {t('about.license')}: GNU GPL v3.0
      </div>
      <div>{t('about.source')}: github.com/b0tmtl/termtv</div>
      <div style={{ marginTop: 20 }} class="dim">
        {t('about.device')}: {d.model} {d.tizenVersion ? `· Tizen ${d.tizenVersion}` : ''}
      </div>
      <CacheStatus />
      <div class="dim" style={{ fontSize: 20 }}>{t('about.disclaimer')}</div>
      <div style={{ marginTop: 20 }}>
        <span class="btn" {...focusable({ onEnter: () => alertDialog(t('about.credits'), t('about.creditsText')) })}>
          {t('about.credits')}
        </span>
        <span
          class="btn"
          {...focusable({
            onEnter: async () => {
              toast(t('about.testStorageRunning'));
              alertDialog(t('about.testStorage'), (await testStorage()).join('\n'));
            },
          })}
        >
          {t('about.testStorage')}
        </span>
      </div>
    </div>
  );
}
