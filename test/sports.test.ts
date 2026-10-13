import { classifyProgramme, groupEvents, splitTeams } from '@/core/sports';

const at = (h: number) => Date.UTC(2026, 9, 13, h);
const c = (title: string, chName: string, chCat = '', category?: string, desc?: string) =>
  classifyProgramme({ title, category, desc, start: at(19) }, { name: chName, category: chCat });

describe('sports: classify', () => {
  it('finds matches and their sport', () => {
    expect(c('NHL: Canadiens vs Maple Leafs', 'CA | TSN 4 HD', 'CA | Sports')).toMatchObject({ sport: 'hockey', league: 'NHL', title: 'Canadiens vs Maple Leafs' });
    expect(c('LNH : Canadiens contre Bruins', 'CA | RDS', 'CA | Sports FR')).toMatchObject({ sport: 'hockey', home: 'Canadiens', away: 'Bruins' });
    expect(c('Premier League: Arsenal v Chelsea (LIVE)', 'UK | Sky Sports Main Event', 'UK | Sports')).toMatchObject({ sport: 'soccer', league: 'Premier League', title: 'Arsenal vs Chelsea' });
    expect(c('Real Madrid - Barcelona', 'ES | Movistar LaLiga', 'ES | Deportes')).toMatchObject({ sport: 'soccer' });
    expect(c('NBA Basketball: Lakers @ Celtics', 'US | ESPN', 'US | Sports')).toMatchObject({ sport: 'basketball', league: 'NBA' });
    expect(c('MLB: Blue Jays at Yankees', 'CA | Sportsnet One', 'CA | Sports')).toMatchObject({ sport: 'baseball' });
    expect(c('UFC 310: Pantoja vs Asakura', 'US | ESPN+ PPV', 'US | PPV')).toMatchObject({ sport: 'fighting', league: 'UFC' });
    expect(c('Formula 1: Grand Prix du Mexique', 'FR | Canal+ Sport', 'FR | Sport')).toMatchObject({ sport: 'motorsport' });
    expect(c('Roland-Garros: Alcaraz vs Sinner', 'FR | France 2', 'FR | Généraliste')).toMatchObject({ sport: 'tennis' });
  });

  it('reads the guide category when the channel says nothing', () => {
    expect(c('Raptors vs Knicks', 'CA | CTV 2', 'CA | General', 'Sports')).toMatchObject({ sport: 'basketball' });
    expect(c('Golf: The Masters, final round', 'US | CBS', 'US | Network', 'Sports event')).toMatchObject({ sport: 'golf' });
  });

  it('tells football from soccer', () => {
    expect(c('NFL Football: Bills vs Chiefs', 'US | CBS', 'US | Network', 'Football')).toMatchObject({ sport: 'football', league: 'NFL' });
    expect(c('Football: PSG - Marseille', 'FR | beIN Sports 1', 'FR | Sport')).toMatchObject({ sport: 'soccer' });
    expect(c('Football: Lyon vs Nice', 'FR | Canal+ Foot', 'FR | Sport')).toMatchObject({ sport: 'soccer' });
  });

  it('leaves out shows, highlights and non-sport titles', () => {
    expect(c('SportsCenter', 'US | ESPN', 'US | Sports')).toBeNull();
    expect(c('NHL Highlights', 'CA | TSN 1', 'CA | Sports')).toBeNull();
    expect(c("L'antichambre", 'CA | RDS', 'CA | Sports FR')).toBeNull();
    expect(c('Avant-match: Canadiens vs Bruins', 'CA | RDS', 'CA | Sports FR')).toBeNull();
    expect(c('Batman vs Superman', 'US | HBO', 'US | Movies')).toBeNull();
    expect(c('The Simpsons', 'US | FOX', 'US | Network')).toBeNull();
    expect(c('Le Téléjournal', 'CA | ICI RDI', 'CA | News')).toBeNull();
  });

  it('splits teams on strong separators before weak ones', () => {
    expect(splitTeams('NBA - Lakers vs Celtics')).toEqual({ home: 'NBA - Lakers', away: 'Celtics' });
    expect(splitTeams('Brazil x Argentina')).toEqual({ home: 'Brazil', away: 'Argentina' });
    expect(splitTeams('Season 2023 - 2024')).toBeNull();
  });
});

describe('sports: group', () => {
  it('merges the same match on several channels (either team order, 30 min window)', () => {
    const e = (title: string, ch: string, h: number, m = 0) => {
      const start = at(h) + m * 60000;
      const event = classifyProgramme({ title, start }, { name: ch, category: 'Sports' })!;
      return { event, airing: { channel: ch, start, end: start + 3 * 3600000, title } };
    };
    const matches = groupEvents([
      e('NHL: Canadiens vs Bruins', 'TSN 2', 19),
      e('LNH: Bruins contre Canadiens', 'RDS', 19, 10),
      e('Canadiens vs Bruins (4K)', 'TSN 4K', 19),
      e('NHL: Canadiens vs Bruins', 'TSN 2', 23), // rerun later: a separate airing
      e('Oilers vs Flames', 'Sportsnet', 21),
    ]);
    expect(matches.map((m) => [m.title, m.airings.length])).toEqual([
      ['Canadiens vs Bruins', 3],
      ['Oilers vs Flames', 1],
      ['Canadiens vs Bruins', 1],
    ]);
  });
});

describe('sports: robustness and speed', () => {
  it('ignores short league codes in ordinary titles', () => {
    expect(c('Love in Del Mar', 'US | Hallmark', 'US | Movies')).toBeNull();
    expect(c('The Giro Bandits', 'US | Comedy Central', 'US | Entertainment')).toBeNull();
    expect(c('NHL Tonight: Live from Toronto', 'US | NHL Network', 'US | Sports')).toBeNull();
    expect(c('Hockey Night in Canada: Canadiens vs Leafs', 'CA | CBC', 'CA | General')).toMatchObject({ sport: 'hockey' });
  });
  it('classifies 100k guide entries quickly', () => {
    const titles = ['The Simpsons', 'News at 6', 'Canadiens vs Bruins', 'Movie: Heat', 'Premier League: Arsenal v Chelsea', 'Cooking Show', 'Weather', 'Jeopardy!'];
    const chans = [{ name: 'US | FOX', category: 'US | Network' }, { name: 'CA | TSN 2', category: 'CA | Sports' }, { name: 'UK | BBC One', category: 'UK | General' }];
    const t0 = Date.now();
    let n = 0;
    for (let i = 0; i < 100000; i++) if (classifyProgramme({ title: titles[i % titles.length] + ' ' + (i % 50), start: i }, chans[i % 3])) n++;
    const ms = Date.now() - t0;
    console.log('100k entries:', ms, 'ms,', n, 'events');
    expect(ms).toBeLessThan(3000);
  });
});

describe('sports: descriptions alone', () => {
  it('needs the sport in the title or category when there are no teams', () => {
    expect(c('Chicago Fire', 'ES | Movistar LaLiga', 'ES | Deportes', 'Sports', 'Chicago Fire on Movistar LaLiga.')).toBeNull();
    expect(c('Skiing: World Cup Slalom', 'EU | Eurosport 1', 'EU | Sports')).toMatchObject({ sport: 'other' });
  });
});
