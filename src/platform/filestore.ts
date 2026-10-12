// Binary files in the app's private folder (`wgt-private`). Used for the library and guide caches:
// the IndexedDB quota on 2017 TVs is a few MB (QuotaExceededError), the app folder has no such
// limit.
//
// Speed matters: on a 2017 TV the Tizen file streams move about 1 MB/s through base64, and every
// call blocks the UI. So:
//   - reading first tries a plain XHR on the file's `file://` URI (native, asynchronous);
//   - streams are used in small pieces with a pause between them, so the screen keeps updating.
// Tizen 5.0+ has `openFile` (Uint8Array in and out), used for writing when present.

import { isTizen } from './tv';

declare const tizen: any;

const DIR = 'wgt-private';
/** A multiple of 3, so every piece encodes to base64 without padding in the middle. ~0.2 s on a 2017 TV. */
const PIECE = 3 * 64 * 1024;

export function fileStoreAvailable(): boolean {
  try {
    return isTizen && typeof tizen !== 'undefined' && !!tizen.filesystem;
  } catch {
    return false;
  }
}

/** How the last read was done, for Settings > About. */
export let lastReadMethod = '';

const hasOpenFile = () => typeof tizen.filesystem.openFile === 'function';
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

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
  return new Error('File error' + (e && e.name ? ' (' + e.name + ')' : '') + (e && e.message ? ': ' + e.message : ''));
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

function openStream(file: any, mode: 'r' | 'w'): Promise<any> {
  return new Promise((resolve, reject) => file.openStream(mode, resolve, (e: any) => reject(err(e))));
}

export async function writeFile(name: string, parts: ArrayBuffer[]): Promise<void> {
  if (hasOpenFile()) {
    const fh = tizen.filesystem.openFile(DIR + '/' + name, 'w');
    try {
      for (const p of parts) {
        fh.writeData(new Uint8Array(p));
        await pause();
      }
    } finally {
      fh.close();
    }
    return;
  }
  const dir = await privateDir();
  const file = findFile(dir, name) || dir.createFile(name);
  const stream = await openStream(file, 'w');
  try {
    for (const p of parts) {
      const u = new Uint8Array(p);
      for (let i = 0; i < u.length; i += PIECE) {
        stream.writeBase64(toBase64(u.subarray(i, i + PIECE)));
        await pause();
      }
    }
  } catch (e) {
    throw err(e);
  } finally {
    try {
      stream.close();
    } catch {
      /* already closed */
    }
  }
}

/** Reads a local file:// URI natively. Resolves undefined when the TV doesn't allow it. */
function xhrRead(uri: string, size: number): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve) => {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', uri, true);
      x.responseType = 'arraybuffer';
      x.onload = () => {
        const buf = x.response as ArrayBuffer | null;
        resolve(buf && buf.byteLength === size ? buf : undefined);
      };
      x.onerror = () => resolve(undefined);
      x.ontimeout = () => resolve(undefined);
      x.timeout = 30000;
      x.send();
    } catch {
      resolve(undefined);
    }
  });
}

/** The file's bytes, or undefined when it doesn't exist. */
export async function readFile(name: string): Promise<ArrayBuffer | undefined> {
  const t0 = Date.now();
  if (hasOpenFile()) {
    const path = DIR + '/' + name;
    try {
      if (!tizen.filesystem.pathExists(path)) return undefined;
    } catch {
      return undefined;
    }
    try {
      const uri: string = tizen.filesystem.toURI(path);
      const size = tizen.filesystem.openFile(path, 'r');
      const total = size.seek(0, 'END');
      size.close();
      const fast = await xhrRead(uri, total);
      if (fast) {
        lastReadMethod = 'direct, ' + (Date.now() - t0) + ' ms';
        return fast;
      }
    } catch {
      /* fall back to openFile */
    }
    const fh = tizen.filesystem.openFile(path, 'r');
    try {
      const data: Uint8Array = fh.readData();
      lastReadMethod = 'file API, ' + (Date.now() - t0) + ' ms';
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } finally {
      fh.close();
    }
  }
  const dir = await privateDir();
  const file = findFile(dir, name);
  if (!file) return undefined;
  const size: number = file.fileSize;
  try {
    const fast = await xhrRead(file.toURI(), size);
    if (fast) {
      lastReadMethod = 'direct, ' + (Date.now() - t0) + ' ms';
      return fast;
    }
  } catch {
    /* fall back to the stream */
  }
  const stream = await openStream(file, 'r');
  try {
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const piece = fromBase64(stream.readBase64(Math.min(PIECE, size - at)));
      if (!piece.length) break;
      out.set(piece, at);
      at += piece.length;
      await pause();
    }
    lastReadMethod = 'file stream, ' + (Date.now() - t0) + ' ms';
    return at === size ? out.buffer : out.buffer.slice(0, at);
  } catch (e) {
    throw err(e);
  } finally {
    try {
      stream.close();
    } catch {
      /* already closed */
    }
  }
}

export async function deleteFile(name: string): Promise<void> {
  try {
    if (hasOpenFile()) {
      const path = DIR + '/' + name;
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
