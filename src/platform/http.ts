// Small HTTP layer. Works on Chromium 56 (no AbortController): timeouts reject the promise and the
// late response is ignored.

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
  }
}

export interface HttpOptions {
  timeoutMs?: number;
}

/** Optional URL rewriter (the desktop dev server proxies provider URLs to avoid CORS). */
let rewrite: (url: string) => string = (u) => u;

export function setUrlRewriter(fn: (url: string) => string): void {
  rewrite = fn;
}

export function resolveUrl(url: string): string {
  return rewrite(url);
}

function withTimeout<T>(p: Promise<T>, ms: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new HttpError('Request timed out', 0, url)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function request(url: string, opts: HttpOptions): Promise<Response> {
  const res = await withTimeout(fetch(rewrite(url), { credentials: 'omit' }), opts.timeoutMs || 30000, url).catch((e) => {
    if (e instanceof HttpError) throw e;
    throw new HttpError('Network error: could not reach the server', 0, url);
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, url);
  return res;
}

export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await request(url, opts);
  const text = await withTimeout(res.text(), opts.timeoutMs || 120000, url);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError('The server returned an invalid response', res.status, url);
  }
}

export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await request(url, opts);
  return withTimeout(res.text(), opts.timeoutMs || 300000, url);
}

/**
 * Streams a response body as raw byte chunks (big playlists / guides), so they never have to be
 * held in memory as one string. Falls back to one chunk when streaming isn't available.
 */
export async function streamBytes(
  url: string,
  onChunk: (bytes: Uint8Array) => void,
  onProgress?: (loaded: number, total: number) => void,
  opts: HttpOptions = {},
): Promise<{ contentType: string }> {
  const res = await request(url, opts);
  const total = Number(res.headers.get('content-length') || 0);
  const contentType = res.headers.get('content-type') || '';
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk(buf);
    if (onProgress) onProgress(buf.length, total);
    return { contentType };
  }
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const r = await withTimeout(reader.read(), opts.timeoutMs || 60000, url);
    if (r.done) break;
    if (r.value) {
      loaded += r.value.length;
      onChunk(r.value);
      if (onProgress) onProgress(loaded, total);
    }
  }
  return { contentType };
}
