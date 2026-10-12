// Small polyfills for Chromium 47 (Samsung 2017, Tizen 3.0). Babel lowers the syntax; these
// cover the runtime APIs TermTV uses that arrived after Chromium 47.

/* eslint-disable no-extend-native */

if (!Promise.prototype.finally) {
  // Chromium 63
  Promise.prototype.finally = function <T>(this: Promise<T>, fn?: (() => void) | null) {
    return this.then(
      (v) => {
        if (fn) fn();
        return v;
      },
      (e) => {
        if (fn) fn();
        throw e;
      },
    );
  };
}

if (!(Object as any).fromEntries) {
  // Chromium 73
  (Object as any).fromEntries = (entries: Iterable<[string, unknown]>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Array.from(entries)) o[k] = v;
    return o;
  };
}

if (!(Array.prototype as any).flat) {
  // Chromium 69
  (Array.prototype as any).flat = function (this: unknown[], depth = 1): unknown[] {
    return depth > 0
      ? this.reduce<unknown[]>((acc, v) => acc.concat(Array.isArray(v) ? (v as any).flat(depth - 1) : v), [])
      : this.slice();
  };
}

if (!String.prototype.padStart) {
  // Chromium 57
  String.prototype.padStart = function (this: string, len: number, fill = ' ') {
    let s = String(this);
    while (s.length < len) s = fill + s;
    return s.slice(s.length - Math.max(len, this.length));
  };
}

export {};
