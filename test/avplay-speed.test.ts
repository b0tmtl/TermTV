import { AvPlayEngine } from '@/platform/player/avplay';

describe('AVPlay speed', () => {
  const fake = (ok: number[]) => {
    const calls: number[] = [];
    return { calls, av: { setSpeed: (r: number) => { calls.push(r); if (ok.indexOf(r) < 0) throw new Error('INVALID_VALUES'); } } };
  };
  const set = (f: { av: unknown }, r: number) => AvPlayEngine.prototype.setSpeed.call(f as unknown as AvPlayEngine, r);
  it('uses whole speeds the stream accepts, nearest first', () => {
    const f = fake([1, 2, 4, 8, 16]);
    expect(set(f, 4)).toBe(4);
    expect(set(f, 10)).toBe(8);
    expect(set(f, 1.5)).toBe(1);
    const g = fake([1, 2]);
    expect(set(g, 4)).toBe(2);
  });
});
