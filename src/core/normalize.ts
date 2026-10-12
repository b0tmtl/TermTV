// Name cleaning for IPTV data. Provider names are noisy:
//   "US | CNN ᴴᴰ", "|FR| TF1 FHD", "[4K] Dune: Part Two (2024)", "★ SPORTS ★ ESPN 2"
// Everything here is pure so it can run in workers and tests.

const SMALL_CAPS: Record<string, string> = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
  'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't',
  'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

const SPECIAL: Record<string, string> = {
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i',
  'Æ': 'ae', 'Œ': 'oe', 'Ø': 'o', 'Ł': 'l', 'Đ': 'd',
};

const SPECIAL_RE = /[ßæœøłđðþıÆŒØŁĐᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/g;
const COMBINING_RE = /[̀-ͯ]/g;

/** Lowercase, remove accents, decompose stylized letters (ᴴᴰ, fullwidth, small caps). */
export function fold(input: string): string {
  let s = input.normalize ? input.normalize('NFKD') : input;
  s = s.replace(COMBINING_RE, '');
  s = s.replace(SPECIAL_RE, (c) => SMALL_CAPS[c] || SPECIAL[c] || c);
  return s.toLowerCase();
}

/**
 * Normalizes text for matching: folded, `&` handled, punctuation and symbols turned into spaces,
 * whitespace collapsed. "Law & Order: SVU" -> "law and order svu", "AT&T" -> "att".
 */
export function normalizeText(input: string): string {
  let s = fold(input);
  s = s.replace(/(\w)&(\w)/g, '$1$2'); // at&t, a&e
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\+/g, ' plus ');
  s = s.replace(/['’`´]/g, ''); // don't -> dont, grey's -> greys
  s = s.replace(/[^a-z0-9Ѐ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]+/g, ' ');
  return s.trim().replace(/\s+/g, ' ');
}

/** Splits normalized text into words. */
export function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(' ') : [];
}

// Quality / packaging tags that are not part of the actual title.
const QUALITY_TAGS = new Set([
  'hd', 'fhd', 'uhd', 'sd', 'hq', 'lq', '4k', '8k', '2k', 'hevc', 'h264', 'h265', 'x264', 'x265',
  '1080p', '1080i', '720p', '576p', '480p', '2160p', '4320p', '50fps', '60fps', 'fps', 'hdr', 'hdr10', 'dv',
  'raw', 'vip', 'backup', 'bk', 'alt', 'multi', 'multisub', 'plus', 'premium', 'low', 'high', 'ultra',
]);

export function isQualityTag(word: string): boolean {
  return QUALITY_TAGS.has(word);
}

// "US | CNN", "US: CNN", "UK - BBC", "AR ➤ MBC": an upper-case code of 1-4 chars then a separator.
// Upper-case only, so titles like "Dune: Part Two" or "X-Men" are not mistaken for prefixes;
// a dash only counts when preceded by a space ("UK - BBC", not "X-Men").
const PREFIX_RE = /^\s*([A-Z0-9]{1,4}(?:[ /][A-Z0-9]{1,4})?)(?:\s*[|:•▎┃►➤»›⇒→]+|\s+[-–—]+)\s*/;
// "|US| CNN", "[US] CNN", "(US) CNN", "◉US◉ CNN"
const WRAPPED_PREFIX_RE = /^\s*[|[(◉●★☆#]+\s*([A-Z0-9]{1,6}(?:[ /-][A-Z0-9]{1,6})?)\s*[|\])◉●★☆#]+\s*/;

export interface PrefixSplit {
  /** Upper-cased prefix ("US", "FR", "4K"), or empty when none. */
  prefix: string;
  rest: string;
}

/** Detects a leading country/group prefix in a category or channel name. */
export function splitPrefix(name: string): PrefixSplit {
  const folded = name.normalize ? name.normalize('NFKC') : name;
  let m = WRAPPED_PREFIX_RE.exec(folded);
  if (!m) m = PREFIX_RE.exec(folded);
  if (!m) return { prefix: '', rest: name.trim() };
  const rest = folded.slice(m[0].length).trim();
  if (!rest) return { prefix: '', rest: name.trim() };
  return { prefix: m[1].toUpperCase().replace(/\s+/g, ' '), rest };
}

// "Dune (2021)", "Dune [2021]", "Dune - 2021". A bare "Title 2021" is ambiguous ("Blade Runner 2049"),
// so it only counts when `bare` is set and the year is not in the future.
const YEAR_RE = /\s*(?:[([]\s*((?:19|20)\d{2})\s*[)\]]|[-–]\s*((?:19|20)\d{2}))\s*$/;
const BARE_YEAR_RE = /\s+((?:19|20)\d{2})\s*$/;

/** Extracts a trailing year: "Dune (2021)" -> { title: "Dune", year: 2021 }. */
export function splitYear(name: string, bare = false): { title: string; year?: number } {
  let m = YEAR_RE.exec(name);
  let year = m ? Number(m[1] || m[2]) : 0;
  if (!m && bare) {
    m = BARE_YEAR_RE.exec(name);
    year = m ? Number(m[1]) : 0;
    if (year > new Date().getFullYear() + 1) m = null;
  }
  if (!m) return { title: name.trim() };
  const title = name.slice(0, m.index).trim();
  if (!title) return { title: name.trim() };
  return { title, year };
}

/** Removes decorative symbols at the edges: "★ ESPN ★" -> "ESPN". */
export function stripDecorations(name: string): string {
  return name.replace(/^[\s|★☆●◉►➤»#*~=_.\-–—]+/, '').replace(/[\s|★☆●◉◄«#*~=_.\-–—]+$/, '');
}

/** Display title: removes provider prefix, decorations and trailing quality tags. */
export function cleanTitle(name: string): string {
  const { rest } = splitPrefix(name);
  let s = stripDecorations(rest);
  // Remove bracketed quality tags anywhere: "[FHD]", "(4K)".
  s = s.replace(/[[(]\s*([A-Za-z0-9 ]{1,12})\s*[\])]/g, (whole, inner: string) =>
    inner.split(/\s+/).every((w) => isQualityTag(normalizeText(w))) ? ' ' : whole,
  );
  // Remove trailing quality words: "CNN HD", "TF1 FHD 50FPS".
  const words = s.trim().split(/\s+/);
  while (words.length > 1 && isQualityTag(normalizeText(words[words.length - 1]))) words.pop();
  s = words.join(' ');
  return s.trim() || name.trim();
}

/** Key used for alphabetical sorting: ignores prefixes, decorations, case and accents. */
export function sortKey(name: string): string {
  return normalizeText(cleanTitle(name));
}

/**
 * Key used to merge duplicates (same movie from two sources, or in FHD and 4K).
 * Title without prefix, quality tags or year, plus the year when known.
 */
export function dedupeKey(name: string, year?: number): string {
  const split = splitYear(cleanTitle(name), true);
  const y = year || split.year;
  const words = tokenize(normalizeText(split.title)).filter((w) => !isQualityTag(w));
  return words.join(' ') + (y ? `|${y}` : '');
}

/** Natural compare so "Channel 2" sorts before "Channel 10". */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/(\d+|\D+)/g) || [];
  const bx = b.match(/(\d+|\D+)/g) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === y) continue;
    const xd = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
    const yd = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
    if (xd && yd) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    }
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}
