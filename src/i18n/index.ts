// Translations. Every visible string goes through t('some.key').
//
// Adding a language: copy src/i18n/locales/en.json to xx.json, translate the values, rebuild.
// The language list in Settings is generated from the files present (scripts/gen-locales.mjs).
// Missing keys fall back to English, so a partial translation never shows blank labels.
//
// Values can contain {placeholders}. Plurals use an object: { "one": "{count} episode", "other": "{count} episodes" }.

import { LOCALES } from './locales.generated';

type Value = string | { [form: string]: string };
type Dict = Record<string, Value>;

const fallback: Dict = flatten(LOCALES.en.strings);
let dict: Dict = fallback;
let lang = 'en';
let plural: { select(n: number): string } | null = null;

function flatten(obj: Record<string, unknown>, prefix = '', out: Dict = {}): Dict {
  for (const k of Object.keys(obj)) {
    if (k === '_meta') continue;
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object' && isPluralObject(v as Record<string, unknown>)) out[key] = v as Value;
    else if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
  }
  return out;
}

function isPluralObject(o: Record<string, unknown>): boolean {
  return typeof o.other === 'string';
}

export interface LanguageInfo {
  code: string;
  name: string;
}

export function languages(): LanguageInfo[] {
  return Object.keys(LOCALES).map((code) => ({ code, name: LOCALES[code].name }));
}

export function setLanguage(code: string): void {
  const l = LOCALES[code] || LOCALES.en;
  lang = LOCALES[code] ? code : 'en';
  dict = lang === 'en' ? fallback : { ...fallback, ...flatten(l.strings) };
  const Intl_ = (window as any).Intl;
  plural = Intl_ && Intl_.PluralRules ? new Intl_.PluralRules(lang) : null;
  document.documentElement.setAttribute('lang', lang);
}

export function currentLanguage(): string {
  return lang;
}

export type Params = Record<string, string | number>;

export function t(key: string, params?: Params): string {
  let v = dict[key];
  if (v === undefined) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`missing translation: ${key}`);
    return key;
  }
  if (typeof v !== 'string') {
    const n = params && typeof params.count === 'number' ? params.count : 0;
    const form = plural ? plural.select(n) : n === 1 ? 'one' : 'other';
    v = v[form] || v.other;
  }
  if (!params) return v;
  return v.replace(/\{(\w+)\}/g, (m, p: string) => (params[p] !== undefined ? String(params[p]) : m));
}

/** Time of day in the user's clock format. */
export function formatTime(ms: number, h24: boolean): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const mm = (m < 10 ? '0' : '') + m;
  if (h24) return `${(h < 10 ? '0' : '') + h}:${mm}`;
  return `${h % 12 || 12}:${mm} ${h < 12 ? t('time.am') : t('time.pm')}`;
}

/** "March 3, 2027": dates where the year matters (subscription expiry). */
export function formatLongDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return new Date(ms).toDateString();
  }
}

export function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toDateString();
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => (n < 10 ? '0' : '') + n;
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return t('time.minutes', { count: m });
  return t('time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}
