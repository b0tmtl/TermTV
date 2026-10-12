import { vi } from 'vitest';

const db = new Map<string, unknown>();
vi.mock('@/platform/db', () => ({
  dbGet: async (s: string, k: string) => db.get(s + '/' + k),
  dbPut: async (s: string, k: string, v: unknown) => {
    if (s === 'library') throw new Error('Storage error (QuotaExceededError)');
    db.set(s + '/' + k, v);
  },
  dbDelete: async (s: string, k: string) => void db.delete(s + '/' + k),
  dbKeys: async () => [],
}));
vi.mock('@/platform/filestore', () => ({
  fileStoreAvailable: () => true,
  writeFile: () => new Promise(() => undefined), // a TV API that never calls back
  readFile: async () => undefined,
  deleteFile: async () => undefined,
}));

describe('saveCache', () => {
  it('turns a hanging file write into a visible error', async () => {
    vi.useFakeTimers();
    const { saveCache, cacheState } = await import('@/state/cache');
    const p = saveCache('library', 'src1', [new ArrayBuffer(10)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cacheState.get().library.src1.stage).toMatch(/writing file/);
    await vi.advanceTimersByTimeAsync(120000);
    await p;
    const n = cacheState.get().library.src1;
    expect(n.ok).toBe(false);
    expect(n.stage).toBeUndefined();
    expect(n.error).toMatch(/Writing file: no answer after 60 s/);
    expect(n.error).toMatch(/QuotaExceededError/);
    vi.useRealTimers();
  });
});
