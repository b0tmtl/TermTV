// Language codes (ISO 639-1 / 639-2, as streams and players report them) to English names.
// Small table instead of Intl.DisplayNames, which 2017 TVs don't have.

const NAMES: Record<string, string> = {
  en: 'English', eng: 'English', fr: 'French', fre: 'French', fra: 'French', es: 'Spanish', spa: 'Spanish',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', ar: 'Arabic', ara: 'Arabic', tr: 'Turkish', tur: 'Turkish',
  ru: 'Russian', rus: 'Russian', pl: 'Polish', pol: 'Polish', el: 'Greek', gre: 'Greek', ell: 'Greek',
  sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian', nb: 'Norwegian', nob: 'Norwegian',
  da: 'Danish', dan: 'Danish', fi: 'Finnish', fin: 'Finnish', cs: 'Czech', cze: 'Czech', ces: 'Czech',
  hu: 'Hungarian', hun: 'Hungarian', ro: 'Romanian', rum: 'Romanian', ron: 'Romanian', bg: 'Bulgarian', bul: 'Bulgarian',
  hr: 'Croatian', hrv: 'Croatian', sr: 'Serbian', srp: 'Serbian', sl: 'Slovenian', slv: 'Slovenian',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak', uk: 'Ukrainian', ukr: 'Ukrainian', he: 'Hebrew', heb: 'Hebrew',
  fa: 'Persian', per: 'Persian', fas: 'Persian', hi: 'Hindi', hin: 'Hindi', ur: 'Urdu', urd: 'Urdu',
  bn: 'Bengali', ben: 'Bengali', ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', pa: 'Punjabi', pan: 'Punjabi',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  th: 'Thai', tha: 'Thai', vi: 'Vietnamese', vie: 'Vietnamese', id: 'Indonesian', ind: 'Indonesian',
  ms: 'Malay', may: 'Malay', msa: 'Malay', tl: 'Tagalog', tgl: 'Tagalog', fil: 'Filipino',
  sq: 'Albanian', alb: 'Albanian', sqi: 'Albanian', ku: 'Kurdish', kur: 'Kurdish', hy: 'Armenian', arm: 'Armenian',
  ka: 'Georgian', geo: 'Georgian', az: 'Azerbaijani', aze: 'Azerbaijani', ca: 'Catalan', cat: 'Catalan',
  eu: 'Basque', baq: 'Basque', gl: 'Galician', glg: 'Galician', is: 'Icelandic', ice: 'Icelandic',
  et: 'Estonian', est: 'Estonian', lv: 'Latvian', lav: 'Latvian', lt: 'Lithuanian', lit: 'Lithuanian',
  mk: 'Macedonian', mac: 'Macedonian', bs: 'Bosnian', bos: 'Bosnian', so: 'Somali', som: 'Somali', sw: 'Swahili', swa: 'Swahili',
  am: 'Amharic', amh: 'Amharic', af: 'Afrikaans', afr: 'Afrikaans',
};

/** "fre" / "fr" / "fr-CA" / "French" -> "French"; unknown codes come back upper-cased, empty stays empty. */
export function languageName(code: string): string {
  const c = (code || '').trim();
  if (!c || c === 'und' || c === 'unknown') return '';
  const base = c.toLowerCase().split(/[-_]/)[0];
  if (NAMES[base]) return NAMES[base];
  return c.length <= 3 ? c.toUpperCase() : c;
}
