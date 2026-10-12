import type { ComponentChildren } from 'preact';
import { Prompt } from './Cards';

/** A titled horizontal row. Remembers its focused card, so Up/Down between rows lands where you were. */
export function Row({ path, cmd, count, children, id }: { path: string; cmd?: string; count?: ComponentChildren; children: ComponentChildren; id?: string }) {
  return (
    <div class="row-block" data-row={id}>
      <Prompt path={path} cmd={cmd} count={count} small />
      <div class="row" data-scroll="x" data-scroll-pad="120" data-focus-memory="">
        <div class="row-inner">{children}</div>
      </div>
    </div>
  );
}
