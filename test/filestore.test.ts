import { vi } from 'vitest';

vi.mock('@/platform/tv', () => ({ isTizen: true }));

/** Tizen 3 style filesystem: file streams with base64 reads and writes. */
function oldApi() {
  const files = new Map<string, Uint8Array>();
  const file = (name: string) => ({
    fullPath: 'wgt-private/' + name,
    get fileSize() {
      return (files.get(name) || new Uint8Array(0)).length;
    },
    openStream(mode: string, ok: (s: unknown) => void) {
      let data = mode === 'w' ? new Uint8Array(0) : files.get(name)!;
      let pos = 0;
      ok({
        writeBase64(b64: string) {
          const add = Uint8Array.from(Buffer.from(b64, 'base64'));
          const next = new Uint8Array(data.length + add.length);
          next.set(data);
          next.set(add, data.length);
          data = next;
        },
        readBase64(n: number) {
          const out = Buffer.from(data.subarray(pos, pos + n)).toString('base64');
          pos += n;
          return out;
        },
        close() {
          if (mode === 'w') files.set(name, data);
        },
      });
    },
  });
  const dir = {
    resolve(name: string) {
      if (!files.has(name)) throw new Error('NotFound');
      return file(name);
    },
    createFile(name: string) {
      files.set(name, new Uint8Array(0));
      return file(name);
    },
    deleteFile(path: string, ok: () => void) {
      files.delete(path.replace('wgt-private/', ''));
      ok();
    },
  };
  return { files, filesystem: { resolve: (_l: string, ok: (d: unknown) => void) => ok(dir) } };
}

/** Tizen 5+ style: openFile with Uint8Array. */
function newApi() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    filesystem: {
      openFile(path: string, mode: string) {
        let data = mode === 'w' ? new Uint8Array(0) : files.get(path)!;
        return {
          writeData(u: Uint8Array) {
            const next = new Uint8Array(data.length + u.length);
            next.set(data);
            next.set(u, data.length);
            data = next;
          },
          readData: () => data,
          close() {
            if (mode === 'w') files.set(path, data);
          },
        };
      },
      pathExists: (p: string) => files.has(p),
      deleteFile(p: string, ok: () => void) {
        files.delete(p);
        ok();
      },
    },
  };
}

function bytes(n: number, seed: number): ArrayBuffer {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 0xff;
  return u.buffer;
}

for (const [label, make] of [['Tizen 3 streams', oldApi], ['Tizen 5 openFile', newApi]] as const) {
  describe('file store: ' + label, () => {
    it('writes chunks and reads them back exactly', async () => {
      const api = make();
      (globalThis as any).tizen = { filesystem: api.filesystem };
      const fs = await import('@/platform/filestore');
      expect(fs.fileStoreAvailable()).toBe(true);
      // Uneven sizes, so pieces cross the base64 3-byte boundaries.
      const parts = [bytes(1048576, 1), bytes(1048576, 2), bytes(123457, 3)];
      await fs.writeFile('library-x.bin', parts);
      const back = new Uint8Array((await fs.readFile('library-x.bin'))!);
      const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        all.set(new Uint8Array(p), at);
        at += p.byteLength;
      }
      expect(back.length).toBe(all.length);
      expect(Buffer.from(back).equals(Buffer.from(all))).toBe(true);
      // Overwriting truncates.
      await fs.writeFile('library-x.bin', [bytes(10, 9)]);
      expect((await fs.readFile('library-x.bin'))!.byteLength).toBe(10);
      await fs.deleteFile('library-x.bin');
      expect(await fs.readFile('library-x.bin')).toBeUndefined();
      expect(await fs.readFile('missing.bin')).toBeUndefined();
    });
  });
}
