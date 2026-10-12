import type { ComponentChildren } from 'preact';
import { Glyph } from './Glyph';
import { useState } from 'preact/hooks';
import type { Channel, Item } from '@/core/models';
import { cleanTitle, splitYear } from '@/core/normalize';
import { focusable, type FocusHandlers } from '@/navigation/focus';
import { playableUrl } from '@/state/library';

/** Image with a text placeholder when missing or broken. */
export function Img({ src, alt }: { src?: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div class="ph">{alt}</div>;
  return <img src={imageUrl(src)} alt="" onError={() => setBroken(true)} />;
}

function imageUrl(src: string): string {
  // Images don't need CORS, but https-only CDNs sometimes serve http in playlists: keep as is.
  return /^\/\//.test(src) ? 'http:' + src : src;
}

export function displayTitle(item: Item): string {
  return item.kind === 'live' ? cleanTitle(item.name) : splitYear(cleanTitle(item.name)).title;
}

interface CardProps extends FocusHandlers {
  item: Item;
  id?: string;
  progress?: number; // 0..1
  favorite?: boolean;
  locked?: boolean;
  badge?: string;
  sub?: ComponentChildren;
}

export function PosterCard({ item, id, progress, favorite, locked, badge, sub, ...h }: CardProps) {
  const title = displayTitle(item);
  const year = item.kind !== 'live' ? item.year || splitYear(item.name).year : undefined;
  return (
    <div class="card poster" {...focusable({ ...h, id })}>
      <div class="art">
        <Img src={item.image} alt={title} />
        {badge && <span class="badge">{badge}</span>}
        {favorite && <span class="fav"><Glyph n="star" /></span>}
        {locked && <span class="lock"><Glyph n="lock" /></span>}
        {progress !== undefined && progress > 0 && (
          <div class="progress">
            <i style={{ width: Math.min(100, progress * 100) + '%' }} />
          </div>
        )}
      </div>
      <div class="title clamp2">{title}</div>
      <div class="sub">{sub !== undefined ? sub : year || ''}</div>
    </div>
  );
}

export function ChannelCard({ item, id, favorite, locked, sub, ...h }: CardProps & { item: Channel }) {
  const title = cleanTitle(item.name);
  return (
    <div class="card channel" {...focusable({ ...h, id })}>
      <div class="art">
        <Img src={item.image} alt={title} />
        {favorite && <span class="fav"><Glyph n="star" /></span>}
        {locked && <span class="lock"><Glyph n="lock" /></span>}
      </div>
      <div class="title ellipsis">{title}</div>
      {sub && <div class="sub ellipsis" style={{ width: 210, textAlign: 'center' }}>{sub}</div>}
    </div>
  );
}

export function ItemCard(props: CardProps) {
  return props.item.kind === 'live' ? <ChannelCard {...(props as CardProps & { item: Channel })} /> : <PosterCard {...props} />;
}

export function Prompt({ path, cmd, count, small }: { path: string; cmd?: string; count?: ComponentChildren; small?: boolean }) {
  return (
    <div class={'prompt' + (small ? ' small' : '')}>
      <span class="caret"><Glyph n="prompt" /></span>
      <span class="path">{path}</span>
      {cmd && <span class="cmd">{cmd}</span>}
      {count !== undefined && <span class="count">{count}</span>}
    </div>
  );
}

const AVATAR_COLORS = ['#2f7de1', '#2ea36b', '#d9822b', '#b84cc9', '#d64550', '#1d9aa8', '#7a5ce6', '#c9a227', '#4f6d8f', '#e0567c', '#3c9d3a', '#a0522d'];
const AVATAR_GLYPHS = ['>_', '$', '#', '~', 'λ', '%', '&&', '::', '[]', '{}', '=>', '//'];

export function Avatar({ name, avatar, small }: { name: string; avatar: number; small?: boolean }) {
  const color = AVATAR_COLORS[avatar % AVATAR_COLORS.length];
  const glyph = AVATAR_GLYPHS[Math.floor(avatar / AVATAR_COLORS.length) % AVATAR_GLYPHS.length];
  return (
    <div class={'avatar' + (small ? ' small' : '')} style={{ background: color }}>
      <span class="glyph">{glyph}</span>
      {(name.trim()[0] || '?').toUpperCase()}
    </div>
  );
}

export const AVATAR_COUNT = AVATAR_COLORS.length * AVATAR_GLYPHS.length;

export { playableUrl };
