// Binary files in the app's private folder (`wgt-private`). Used for the library and guide caches:
// the IndexedDB quota on 2017 TVs is a few MB (QuotaExceededError), the app folder has no such
// limit. Tizen 5.0+ has `openFile` (Uint8Array in and out); Tizen 3-4 only has file streams, which
// take base64.

import { isTizen } from './tv';

declare const tizen: any;

const DIR = 'wgt-private';
/** A multiple of 3, so every piece encodes to base64 without padding in the middle. */
const PIECE = 3 * 256 * 1024;

export function fileStoreAvailable(): boolean {
  try {
    return isTizen && typeof tizen !== 'undefined' && !!tizen.filesystem;
  } catch {
    return false;
  }
}

const hasOpenFile = () => typeof tizen.filesystem.openFile === 'function';

function toBase64(u: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192) as unknown as number[]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function err(e: any): Error {
  return new Error(`File error${e && e.name ? ` (${e.name})` : ''}${e && e.message ? `: ${e.message}` : ''}`);
}

function privateDir(): Promise<any> {
  return new Promise((resolve, reject) => tizen.filesystem.resolve(DIR, resolve, (e: any) => reject(err(e)), 'rw'));
}

function findFile(dir: any, name: string): any | null {
  try {
    return dir.resolve(name);
  } catch {
    return null;
  }
}

export async function writeFile(name: string, parts: ArrayBuffer[]): Promise<void> {
  if (hasOpenFile()) {
    const fh = tizen.filesystem.openFile(`${DIR}/${name}`, 'w');
    try {
      for (const p of parts) fh.writeData(new Uint8Array(p));
    } finally {
      fh.close();
    }
    return;
  }
  const dir = await privateDir();
  const file = findFile(dir, name) || dir.createFile(name);
  await new Promise<void>((resolve, reject) =>
    file.openStream(
      'w',
      (stream: any) => {
        try {
          for (const p of parts) {
            const u = new Uint8Array(p);
            for (let i = 0; i < u.length; i += PIECE) stream.writeBase64(toBase64(u.subarray(i, i + PIECE)));
          }
          stream.close();
          resolve();
        } catch (e) {
          try {
            stream.close();
          } catch {
            /* already closed */
          }
          reject(err(e));
        }
      },
      (e: any) => reject(err(e)),
    ),
  );
}

/** The file's bytes, or undefined when it doesn't exist. */
export async function readFile(name: string): Promise<ArrayBuffer | undefined> {
  if (hasOpenFile()) {
    const path = `${DIR}/${name}`;
    try {
      if (!tizen.filesystem.pathExists(path)) return undefined;
    } catch {
      return undefined;
    }
    const fh = tizen.filesystem.openFile(path, 'r');
    try {
      const data: Uint8Array = fh.readData();
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } finally {
      fh.close();
    }
  }
  const dir = await privateDir();
  const file = findFile(dir, name);
  if (!file) return undefined;
  const size: number = file.fileSize;
  return new Promise<ArrayBuffer>((resolve, reject) =>
    file.openStream(
      'r',
      (stream: any) => {
        try {
          const out = new Uint8Array(size);
          let at = 0;
          while (at < size) {
            const piece = fromBase64(stream.readBase64(Math.min(PIECE, size - at)));
            if (!piece.length) break;
            out.set(piece, at);
            at += piece.length;
          }
          stream.close();
          resolve(out.buffer);
        } catch (e) {
          reject(err(e));
        }
      },
      (e: any) => reject(err(e)),
    ),
  );
}

export async function deleteFile(name: string): Promise<void> {
  try {
    if (hasOpenFile()) {
      const path = `${DIR}/${name}`;
      if (tizen.filesystem.pathExists(path)) await new Promise<void>((res) => tizen.filesystem.deleteFile(path, res, () => res()));
      return;
    }
    const dir = await privateDir();
    const file = findFile(dir, name);
    if (file) await new Promise<void>((res) => dir.deleteFile(file.fullPath, res, () => res()));
  } catch {
    /* nothing to delete */
  }
}
