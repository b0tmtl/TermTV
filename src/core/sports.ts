// Sports from the TV guide: which programmes are sport events, which sport, which match.
// Pure, so it is unit-tested and can run anywhere. See docs/ARCHITECTURE.md ("Sports").
//
//   1. Is it a sport event? The guide category says sport, or the channel is a sports channel
//      (its category or its name), or the title looks like a match ("A vs B") or names a league.
//      Studio shows, highlights, magazines and news are left out.
//   2. Which sport? Keywords, strongest first: league names, then the guide category, then words
//      in the title / description, then the channel. "Football" alone depends on context.
//   3. Which match? Two team names (either order) + start time within 30 minutes, so the same
//      game on several channels (EN / FR, HD / 4K) is one event.

import { normalizeText } from './normalize';

export type SportId =
  | 'hockey' | 'soccer' | 'football' | 'basketball' | 'baseball' | 'tennis' | 'fighting' | 'motorsport'
  | 'golf' | 'rugby' | 'cricket' | 'cycling' | 'other';

/** Tab order (the user's choice first). */
export const SPORT_ORDER: SportId[] = [
  'hockey', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'fighting', 'motorsport', 'golf', 'rugby', 'cricket', 'cycling', 'other',
];

interface SportRule {
  id: SportId;
  /** League / competition names: decisive. Matched as whole words on normalized text. */
  leagues: string[];
  /** Generic words for the sport (title, description, guide category). */
  words: string[];
}

// Words are normalized (lowercase, no accents, punctuation = spaces) and matched as whole words or
// word sequences.
const RULES: SportRule[] = [
  {
    id: 'hockey',
    leagues: ['nhl', 'lnh', 'ahl', 'khl', 'ohl', 'whl', 'lhjmq', 'qmjhl', 'chl', 'iihf', 'stanley cup', 'coupe stanley', 'shl', 'liiga', 'del', 'nla'],
    words: ['hockey', 'canadiens', 'canadien', 'maple leafs', 'bruins', 'oilers', 'flames', 'canucks', 'senators', 'jets', 'penguins', 'rangers', 'blackhawks', 'red wings', 'avalanche', 'lightning', 'capitals', 'flyers', 'islanders', 'devils', 'sabres', 'kraken', 'golden knights', 'hurricanes', 'predators', 'blues', 'wild', 'stars', 'ducks', 'sharks', 'coyotes', 'panthers', 'blue jackets'],
  },
  {
    id: 'football',
    leagues: ['nfl', 'cfl', 'lcf', 'ncaa football', 'college football', 'super bowl', 'grey cup', 'coupe grey', 'xfl', 'usfl', 'ufl'],
    words: ['american football', 'football americain', 'touchdown', 'patriots', 'cowboys', 'packers', 'steelers', 'chiefs', 'eagles', '49ers', 'bills', 'ravens', 'broncos', 'raiders', 'chargers', 'seahawks', 'alouettes', 'argonauts', 'tiger cats', 'roughriders', 'stampeders', 'blue bombers', 'redblacks', 'elks'],
  },
  {
    id: 'soccer',
    leagues: [
      'premier league', 'epl', 'la liga', 'laliga', 'liga', 'serie a', 'bundesliga', 'ligue 1', 'ligue 2', 'ligue des champions', 'champions league',
      'europa league', 'conference league', 'uefa', 'fifa', 'mls', 'liga mx', 'eredivisie', 'primeira liga', 'super lig', 'saudi pro league',
      'copa america', 'copa libertadores', 'fifa world cup', 'coupe du monde fifa', 'euro 2024', 'euro 2028', 'fa cup', 'carabao cup', 'efl', 'championship',
      'coupe de france', 'copa del rey', 'dfb pokal', 'coppa italia', 'concacaf', 'caf', 'can 2025', 'afcon', 'cpl', 'nwsl',
    ],
    words: [
      // "World Cup" alone: skiing, rugby and cricket have one too.
      'world cup', 'coupe du monde', 'soccer', 'futbol', 'fussball', 'calcio', 'real madrid', 'barcelona', 'barca', 'atletico', 'manchester', 'liverpool', 'arsenal', 'chelsea',
      'tottenham', 'juventus', 'inter', 'milan', 'napoli', 'roma', 'bayern', 'dortmund', 'psg', 'paris sg', 'paris saint germain', 'marseille',
      'lyon', 'monaco', 'lille', 'benfica', 'porto', 'ajax', 'psv', 'celtic', 'cf montreal', 'galaxy', 'inter miami', 'toronto fc',
    ],
  },
  {
    id: 'basketball',
    leagues: ['nba', 'wnba', 'euroleague', 'eurocup', 'ncaa basketball', 'march madness', 'acb', 'fiba', 'nbl', 'cebl', 'g league'],
    words: ['basketball', 'basket ball', 'basket', 'lakers', 'celtics', 'warriors', 'raptors', 'knicks', 'bulls', 'heat', 'nets', 'bucks', 'nuggets', 'suns', 'mavericks', 'clippers', 'spurs', 'thunder', 'timberwolves', '76ers', 'sixers', 'grizzlies', 'pelicans', 'hawks', 'hornets', 'cavaliers', 'pistons', 'pacers', 'magic', 'wizards', 'kings', 'trail blazers', 'jazz', 'rockets'],
  },
  {
    id: 'baseball',
    leagues: ['mlb', 'world series', 'serie mondiale', 'npb', 'kbo'],
    words: ['baseball', 'blue jays', 'yankees', 'red sox', 'dodgers', 'mets', 'cubs', 'white sox', 'astros', 'braves', 'phillies', 'padres', 'mariners', 'orioles', 'guardians', 'twins', 'tigers', 'royals', 'brewers', 'cardinals', 'reds', 'pirates', 'giants', 'diamondbacks', 'rockies', 'marlins', 'nationals', 'athletics', 'angels', 'rays'],
  },
  {
    id: 'tennis',
    leagues: ['atp', 'wta', 'roland garros', 'wimbledon', 'us open tennis', 'australian open', 'open d australie', 'davis cup', 'coupe davis', 'billie jean king', 'masters 1000'],
    words: ['tennis'],
  },
  {
    id: 'fighting',
    leagues: ['ufc', 'bellator', 'pfl', 'one championship', 'wwe', 'aew', 'wbc', 'wba', 'ibf', 'wbo', 'glory'],
    words: ['mma', 'boxing', 'boxe', 'fight night', 'wrestling', 'lutte', 'kickboxing', 'muay thai', 'combat'],
  },
  {
    id: 'motorsport',
    leagues: ['formula 1', 'formule 1', 'f1', 'f2', 'f3', 'nascar', 'indycar', 'motogp', 'moto gp', 'wrc', 'wec', 'formula e', 'le mans', 'dtm', 'supercars'],
    words: ['grand prix', 'grand prix de', 'gp', 'qualifying', 'qualifications', 'qualifs', 'course automobile', 'rally', 'rallye', 'motorsport', 'karting', 'superbike'],
  },
  {
    id: 'golf',
    leagues: ['pga', 'lpga', 'liv golf', 'dp world tour', 'ryder cup', 'masters tournament', 'the open championship', 'us open golf'],
    words: ['golf'],
  },
  {
    id: 'rugby',
    leagues: ['six nations', 'six nations', 'tournoi des six nations', 'top 14', 'pro d2', 'super rugby', 'premiership rugby', 'urc', 'nrl', 'rugby world cup'],
    words: ['rugby', 'xv de france', 'all blacks', 'springboks', 'wallabies'],
  },
  {
    id: 'cricket',
    leagues: ['ipl', 'big bash', 'the ashes', 'icc', 'psl', 'cpl t20', 't20', 'odi'],
    words: ['cricket', 'test match'],
  },
  {
    id: 'other',
    leagues: ['olympics', 'olympic games', 'jeux olympiques', 'paralympics', 'commonwealth games', 'world championships', 'championnats du monde'],
    words: ['athletics', 'athletisme', 'swimming', 'natation', 'skiing', 'ski alpin', 'ski', 'slalom', 'giant slalom', 'downhill', 'descente', 'super g', 'snowboard', 'biathlon', 'volleyball', 'volley', 'handball', 'curling', 'darts', 'snooker', 'esports', 'figure skating', 'patinage', 'lacrosse', 'water polo', 'badminton', 'table tennis', 'ping pong', 'gymnastics', 'gymnastique', 'triathlon', 'marathon', 'horse racing', 'courses de chevaux'],
  },
  {
    id: 'cycling',
    leagues: ['tour de france', 'giro', 'giro d italia', 'vuelta', 'paris roubaix', 'uci'],
    words: ['cycling', 'cyclisme', 'velo'],
  },
];

/** Guide categories that mean "sport" (normalized). */
const SPORT_CATEGORY = /\b(sports?|sportif|sportive|deportes?|football|soccer|hockey|basketball|basket|baseball|tennis|golf|rugby|cricket|boxing|boxe|mma|motorsport|cyclisme|cycling|athletics|athletisme|olympi\w*)\b/;

/** Channel names / categories that are sports channels (normalized). */
const SPORT_CHANNEL = /\b(sports?|sportsnet|sn ?1|sn ?360|tsn ?\d?|rds ?\d?|tva sports?|espn\w*|bein\w*|dazn ?\d*|sky sports?|bt sport|tnt sports?|eurosport ?\d?|canal\+? sport|rmc sport|l equipe|fox sports?|fs1|fs2|nbc sports?|cbs sports?|nfl network|nba tv|nhl network|mlb network|golf channel|tennis channel|super ?sport|arena sport|setanta|premier sports?|viaplay sports?|movistar deportes|sport ?tv|sports? ?\d+)\b/;

/** Not a live event: studio shows, highlights, magazines, news, documentaries, replays of classics. */
const NOT_EVENT = /\b(highlights?|resume|resumes|magazine|mag|news|nouvelles|infos?|journal|talk|debrief|analyse|analysis|preview|pre ?game|post ?game|avant match|apres match|studio|show|podcast|documentary|documentaire|best of|classics?|classiques?|retro|retrospective|top 10|top10|bloopers|sportscenter|that s hockey|c est hockey|l antichambre|le 5 a 7|5 a 7|inside the nba|countdown|bonjour|matin|morning|tonight|panorama|weekly|recap|magazines)\b/;

/** "A vs B", "A v B", "A @ B", "A contre B"; weaker: "A - B", "A x B", "A at B" (only without the others). */
const VS_STRONG = /^(.{2,60}?)\s+(?:vs\.?|v\.|v|versus|contre|@)\s+(.{2,60}?)$/i;
const VS_WEAK = /^(.{2,60}?)\s+(?:at|x|[-–—])\s+(.{2,60}?)$/i;
const VS_RE = { test: (s: string) => VS_STRONG.test(s) || VS_WEAK.test(s) };

// Prefixes / suffixes to drop from a title before reading the teams.
const TITLE_NOISE = /\b(live|en direct|direct|en vivo|hd|fhd|uhd|4k|sd|en|fr|eng|fra|ar|es|replay|rediffusion|reprise|ppv)\b/gi;

export interface SportEvent {
  sport: SportId;
  /** League / competition when found ("NHL", "Premier League"). */
  league?: string;
  /** Display title, cleaned ("Canadiens vs Maple Leafs"). */
  title: string;
  home?: string;
  away?: string;
  /** Same match on other channels shares this key (sport + teams, or the cleaned title). */
  matchKey: string;
}

export interface ProgrammeLike {
  title: string;
  desc?: string;
  category?: string;
  start: number;
}

export interface ChannelContext {
  /** Channel name ("CA | TSN 4 HD"). */
  name: string;
  /** Category name of the channel ("CA | Sports"). */
  category?: string;
  /** Precomputed isSportsChannel(name, category), when classifying many entries of one channel. */
  isSportsChannel?: boolean;
}

export function isSportsChannel(name: string, category?: string): boolean {
  return SPORT_CHANNEL.test(normalizeText(name + ' ' + (category || '')));
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words / phrases on normalized text (words are separated by single spaces). */
const phrases = (list: string[]) => new RegExp('(?:^| )(' + list.map(esc).sort((a, b) => b.length - a.length).join('|') + ')(?= |$)', 'g');

// Every league and word of every sport in ONE regex, with a lookup table: classifying a whole guide
// (tens of thousands of entries) is one scan per text instead of one per keyword or per sport.
interface Hit {
  sport: SportId;
  league: boolean;
}
const HITS = new Map<string, Hit[]>();
for (const r of RULES) {
  for (const l of r.leagues) (HITS.get(l) || HITS.set(l, []).get(l)!).push({ sport: r.id, league: true });
  for (const w of r.words) (HITS.get(w) || HITS.set(w, []).get(w)!).push({ sport: r.id, league: false });
}
const ALL_PHRASES = phrases(Array.from(HITS.keys()));
const ANY_LEAGUE = phrases(([] as string[]).concat(...RULES.map((r) => r.leagues)));

/** Which sport the text is about, with a score (league names count most). */
function scoreSports(parts: { text: string; weight: number }[]): { sport: SportId; league?: string; score: number } | null {
  const scores: Partial<Record<SportId, number>> = {};
  const leagues: Partial<Record<SportId, string>> = {};
  for (const p of parts) {
    if (!p.text) continue;
    ALL_PHRASES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ALL_PHRASES.exec(p.text))) {
      for (const h of HITS.get(m[1]) || []) {
        scores[h.sport] = (scores[h.sport] || 0) + (h.league ? 10 : 3) * p.weight;
        if (h.league && !leagues[h.sport]) leagues[h.sport] = m[1];
      }
    }
  }
  let best: { sport: SportId; league?: string; score: number } | null = null;
  for (const id of SPORT_ORDER) {
    const sc = scores[id];
    if (sc && (!best || sc > best.score)) best = { sport: id, league: leagues[id], score: sc };
  }
  return best;
}

const DISTINCT_LEAGUES = / (nhl|lnh|nfl|cfl|nba|wnba|mlb|mls|ufc|wwe|aew|premier league|champions league|ligue des champions|europa league|ligue 1|la liga|laliga|serie a|bundesliga|formula 1|formule 1|nascar|indycar|motogp|roland garros|wimbledon|pga|lpga|super bowl|stanley cup|coupe stanley|world series|serie mondiale|tour de france|ryder cup|six nations|coupe du monde|world cup|fifa|uefa|atp|wta|ipl) /;

const LEAGUE_LABEL: Record<string, string> = {
  nhl: 'NHL', lnh: 'LNH', ahl: 'AHL', khl: 'KHL', lhjmq: 'LHJMQ', nfl: 'NFL', cfl: 'CFL', lcf: 'LCF', nba: 'NBA', wnba: 'WNBA', mlb: 'MLB',
  mls: 'MLS', ufc: 'UFC', wwe: 'WWE', atp: 'ATP', wta: 'WTA', pga: 'PGA', lpga: 'LPGA', f1: 'F1', nascar: 'NASCAR', motogp: 'MotoGP', ipl: 'IPL', uefa: 'UEFA', fifa: 'FIFA',
};

function leagueLabel(l?: string): string | undefined {
  if (!l) return undefined;
  if (LEAGUE_LABEL[l]) return LEAGUE_LABEL[l];
  return l.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Removes "NHL:", "LIVE", "(HD)", "| EN" and similar from a title. */
export function cleanEventTitle(title: string): string {
  let s = title.replace(/[[(][^\])]{0,20}[\])]/g, ' ');
  // "NHL: A vs B", "Premier League - A vs B": keep what follows a leading label + colon.
  const colon = s.indexOf(':');
  if (colon > 0 && colon < 30 && VS_RE.test(s.slice(colon + 1).trim())) s = s.slice(colon + 1);
  s = s.replace(TITLE_NOISE, ' ').replace(/\s*[|•]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return s.replace(/^[-–—:\s]+|[-–—:\s]+$/g, '');
}

function teamKey(team: string): string {
  return normalizeText(team)
    .replace(/\b(fc|cf|sc|ac|afc|club|the|les|le|la|de)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits "A vs B" into teams, or null. */
export function splitTeams(title: string): { home: string; away: string } | null {
  const m = VS_STRONG.exec(title) || VS_WEAK.exec(title);
  if (!m) return null;
  const home = m[1].trim();
  const away = m[2].trim();
  // "x" and "-" are too common: require short, name-like sides.
  if (!home || !away || home.length > 40 || away.length > 40) return null;
  // Dates and scores, not teams: "2023 - 2024", "Season 2023 - 2024", "3 - 1".
  if (/^\d+$/.test(away) || /^\d+$/.test(home) || (/\b(19|20)\d\d\b/.test(home) && /\b(19|20)\d\d\b/.test(away))) return null;
  return { home, away };
}

// Guides repeat titles a lot (the same match on several channels, reruns): remember answers.
const memo = new Map<string, SportEvent | null>();

/** Classifies a guide entry; null when it isn't a live sport event. */
export function classifyProgramme(p: ProgrammeLike, ch: ChannelContext): SportEvent | null {
  const sportsCh = ch.isSportsChannel !== undefined ? ch.isSportsChannel : isSportsChannel(ch.name, ch.category);
  const mk = p.title + '\u0001' + (p.category || '') + '\u0001' + (sportsCh ? 1 : 0) + '\u0001' + (p.desc ? p.desc.slice(0, 80) : '') + '\u0001' + (ch.category || '');
  if (memo.has(mk)) return memo.get(mk)!;
  if (memo.size > 50000) memo.clear();
  const r = classifyUncached(p, { ...ch, isSportsChannel: sportsCh });
  memo.set(mk, r);
  return r;
}

function classifyUncached(p: ProgrammeLike, ch: ChannelContext): SportEvent | null {
  const title = normalizeText(p.title || '');
  if (!title) return null;
  const cat = normalizeText(p.category || '');
  const desc = normalizeText(p.desc || '').slice(0, 400);
  const chan = normalizeText(ch.name + ' ' + (ch.category || ''));

  const catSays = SPORT_CATEGORY.test(cat);
  const channelSays = ch.isSportsChannel !== undefined ? ch.isSportsChannel : SPORT_CHANNEL.test(chan);
  const cleaned = cleanEventTitle(p.title);
  const teams = splitTeams(cleaned);
  // Fast exit for the vast majority of the guide (films, news, series on general channels).
  ANY_LEAGUE.lastIndex = 0;
  if (!catSays && !channelSays && !teams && !ANY_LEAGUE.test(title)) return null;
  const scored = scoreSports([
    { text: title, weight: 3 },
    { text: cat, weight: 2 },
    { text: desc, weight: 1 },
    { text: normalizeText(ch.category || ''), weight: 1 },
  ]);
  // A league name alone (no teams, no sport category, not a sports channel) must be unmistakable:
  // "DEL", "CAF" or "Giro" also appear in ordinary titles.
  const hasLeague = !!(scored && scored.league && DISTINCT_LEAGUES.test(' ' + scored.league + ' '));

  // 1. Is it a sport event?
  const sporty = catSays || channelSays || (teams && scored) || hasLeague;
  if (!sporty) return null;
  if (NOT_EVENT.test(title)) return null;
  // Without teams, it must be recognizably a sport: guide categories say "Sports" for talk shows
  // and series on sports channels too ("Sports non-event").
  // ...and named in the title or category: descriptions often just repeat the channel's name
  // ("... on Movistar LaLiga").
  if (!teams && !scoreSports([{ text: title, weight: 1 }, { text: cat, weight: 1 }])) return null;
  if (/\bnon event\b/.test(cat)) return null;

  // 2. Which sport? "Football" alone: American with NFL/CFL/NCAA context, otherwise soccer.
  let sport: SportId = scored ? scored.sport : 'other';
  if (!scored || scored.score < 3) {
    const any = title + ' ' + cat + ' ' + desc;
    if (/\bfootball\b/.test(any)) sport = /\b(nfl|cfl|lcf|ncaa|college|american|americain)\b/.test(any + ' ' + chan) ? 'football' : 'soccer';
    else if (!scored) {
      const fromCat = scoreSports([{ text: cat, weight: 1 }]);
      if (fromCat) sport = fromCat.sport;
    }
  }

  // 3. Which match? (Start times are compared when grouping: see groupEvents.)
  const matchKey = teams
    ? sport + '|' + [teamKey(teams.home), teamKey(teams.away)].sort().join('~')
    : sport + '|' + normalizeText(cleaned);

  return {
    sport,
    league: leagueLabel(scored ? scored.league : undefined),
    title: teams ? teams.home + ' vs ' + teams.away : cleaned || p.title,
    home: teams ? teams.home : undefined,
    away: teams ? teams.away : undefined,
    matchKey,
  };
}

export interface Airing<C> {
  channel: C;
  start: number;
  end: number;
  /** The guide title on this channel. */
  title: string;
}

export interface SportMatch<C> {
  key: string;
  sport: SportId;
  league?: string;
  title: string;
  start: number;
  end: number;
  airings: Array<Airing<C>>;
}

/**
 * Groups classified entries into matches: same key and start within 30 minutes of the match's
 * first airing. Sorted by start time.
 */
export function groupEvents<C>(entries: Array<{ event: SportEvent; airing: Airing<C> }>): Array<SportMatch<C>> {
  const byKey = new Map<string, Array<SportMatch<C>>>();
  const sorted = entries.slice().sort((a, b) => a.airing.start - b.airing.start);
  const out: Array<SportMatch<C>> = [];
  for (const { event, airing } of sorted) {
    let list = byKey.get(event.matchKey);
    if (!list) byKey.set(event.matchKey, (list = []));
    let m = list.find((x) => Math.abs(x.start - airing.start) <= 30 * 60000);
    if (!m) {
      m = { key: event.matchKey + '|' + airing.start, sport: event.sport, league: event.league, title: event.title, start: airing.start, end: airing.end, airings: [] };
      list.push(m);
      out.push(m);
    }
    if (!m.league && event.league) m.league = event.league;
    if (airing.end > m.end) m.end = airing.end;
    m.airings.push(airing);
  }
  return out;
}
