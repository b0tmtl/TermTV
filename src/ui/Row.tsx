import { toChildArray, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { onFocusChange } from '@/navigation/focus';
import { Prompt } from './Cards';

/** Cards rendered at first; about one screen width. More are added as focus moves right. */
const FIRST = 12;
const STEP = 12;

/**
 * A titled horizontal row. Remembers its focused card, so Up/Down between rows lands where you were.
 * Only the first cards are mounted: Home has up to ten rows of 40 posters, and mounting them all
 * at once took seconds on old TVs.
 */
export function Row({ path, cmd, count, children, id }: { path: string; cmd?: string; count?: ComponentChildren; children: ComponentChildren; id?: string }) {
  const all = toChildArray(children);
  const [shown, setShown] = useState(FIRST);
  const inner = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(
    () =>
      onFocusChange((el) => {
        const box = inner.current;
        if (!el || !box || el.parentElement !== box) return;
        const idx = Array.prototype.indexOf.call(box.children, el) as number;
        if (idx >= shownRef.current - 4) setShown(shownRef.current + STEP);
      }),
    [],
  );

  return (
    <div class="row-block" data-row={id}>
      <Prompt path={path} cmd={cmd} count={count} small />
      <div class="row" data-scroll="x" data-scroll-pad="120" data-focus-memory="">
        <div class="row-inner" ref={inner}>{all.length > shown ? all.slice(0, shown) : all}</div>
      </div>
    </div>
  );
}
