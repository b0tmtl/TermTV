// Virtualized grid / list. Only the rows on screen (plus a small margin) are in the DOM, so a
// category with 20,000 channels or movies stays fast. Arrow keys inside the grid move an index;
// leaving its edges hands the key back to spatial navigation.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { focus, focused, registerHandlers } from '@/navigation/focus';
import type { KeyInfo } from '@/platform/tv';

export interface VGridProps<T> {
  id: string;
  items: T[];
  columns: number;
  rowHeight: number;
  colWidth?: number;
  height: number;
  initialIndex?: number;
  /** Render one cell; spread `cellProps` on the focusable element. */
  render: (item: T, index: number, cellProps: { id: string; onFocus: () => void }) => ComponentChildren;
  onIndex?: (index: number) => void;
  /** Extra keys while an item is focused. */
  onKey?: (k: KeyInfo, index: number) => boolean | void;
  /** Rows kept above the focused one when scrolling. */
  leadRows?: number;
  class?: string;
}

export function VGrid<T>(p: VGridProps<T>) {
  const { items, columns, rowHeight, height } = p;
  const visibleRows = Math.max(1, Math.floor(height / rowHeight));
  const [index, setIndex] = useState(Math.min(p.initialIndex || 0, Math.max(0, items.length - 1)));
  const [top, setTop] = useState(() => clampTop(Math.floor((p.initialIndex || 0) / columns) - (p.leadRows || 0), visibleRows, items.length, columns));
  const pendingFocus = useRef(false);
  const root = useRef<HTMLDivElement | null>(null);

  const totalRows = Math.ceil(items.length / columns);

  const moveTo = (next: number) => {
    next = Math.max(0, Math.min(items.length - 1, next));
    const row = Math.floor(next / columns);
    let t = top;
    const lead = p.leadRows || 0;
    if (row < t + lead) t = row - lead;
    else if (row >= t + visibleRows - lead) t = row - visibleRows + 1 + lead;
    t = clampTop(t, visibleRows, items.length, columns);
    pendingFocus.current = true;
    setTop(t);
    setIndex(next);
    if (p.onIndex) p.onIndex(next);
  };

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const el = root.current && (root.current.querySelector(`[data-fid="${p.id}:${index}"]`) as HTMLElement | null);
    if (el) focus(el, { scroll: false });
  });

  // Items changed (another category): keep the index in range.
  useEffect(() => {
    if (index > items.length - 1) {
      setIndex(Math.max(0, items.length - 1));
      setTop(0);
    }
  }, [items]);

  const onKey = (k: KeyInfo): boolean => {
    const el = focused();
    if (!el || !root.current || !root.current.contains(el)) return false;
    const col = index % columns;
    if (p.onKey && p.onKey(k, index)) return true;
    switch (k.key) {
      case 'down':
        if (index + columns < items.length) return moveTo(index + columns), true;
        if (Math.floor(index / columns) < totalRows - 1) return moveTo(items.length - 1), true;
        return false;
      case 'up':
        if (index - columns >= 0) return moveTo(index - columns), true;
        return false;
      case 'right':
        if (col < columns - 1 && index + 1 < items.length) return moveTo(index + 1), true;
        return false;
      case 'left':
        if (col > 0) return moveTo(index - 1), true;
        return false;
      case 'chDown':
      case 'ff':
        return moveTo(index + columns * (visibleRows - 1)), true;
      case 'chUp':
      case 'rw':
        return moveTo(index - columns * (visibleRows - 1)), true;
      default:
        return false;
    }
  };

  const first = Math.max(0, top - 1);
  const last = Math.min(totalRows - 1, top + visibleRows);
  const rows: ComponentChildren[] = [];
  for (let r = first; r <= last; r++) {
    const cells: ComponentChildren[] = [];
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      if (i >= items.length) break;
      cells.push(
        p.render(items[i], i, {
          id: `${p.id}:${i}`,
          onFocus: () => {
            if (i !== index) {
              setIndex(i);
              if (p.onIndex) p.onIndex(i);
            }
          },
        }),
      );
    }
    rows.push(
      <div class="vgrid-row" key={r} style={{ top: r * rowHeight + 'px', height: rowHeight + 'px' }}>
        {cells}
      </div>,
    );
  }

  return (
    <div
      class={'vgrid ' + (p.class || '')}
      style={{ height: height + 'px' }}
      ref={(el) => {
        root.current = el;
        if (el) registerHandlers(el, { onKey });
      }}
    >
      {/* Rows sit at fixed positions inside one layer that slides: scrolling moves a GPU layer
          instead of repainting every poster on screen, which is what made old TVs stutter. */}
      <div class="vgrid-inner" style={{ transform: `translate3d(0, ${-top * rowHeight}px, 0)` }}>
        {rows}
      </div>
    </div>
  );
}

function clampTop(t: number, visibleRows: number, count: number, columns: number): number {
  const totalRows = Math.ceil(count / columns);
  return Math.max(0, Math.min(t, totalRows - visibleRows));
}
