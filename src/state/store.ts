// Tiny observable store with a Preact hook. Enough for TermTV, no extra dependency.

import { useEffect, useRef, useState } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: (s: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<(s: T) => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? (patch as (s: T) => Partial<T>)(state) : patch;
      state = { ...state, ...p };
      subs.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Subscribes a component to a slice of a store; re-renders only when the slice changes (shallow). */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  const [, force] = useState(0);
  const sel = useRef(selector);
  sel.current = selector;
  const last = useRef<S>(selector(store.get()));
  last.current = selector(store.get());
  useEffect(() => {
    const check = (s: T) => {
      const next = sel.current(s);
      if (!shallowEqual(next, last.current)) {
        last.current = next;
        force((n) => n + 1);
      }
    };
    const off = store.subscribe(check);
    // Effects run after the first paint: catch changes made between render and subscribing
    // (e.g. the library starting to load right after the app renders).
    check(store.get());
    return off;
  }, [store]);
  return last.current;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as any)[k], (b as any)[k])) return false;
  return true;
}
