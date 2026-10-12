// Small symbols drawn as SVG. TV system fonts often lack ❯ ★ ✓ ⌫ ▶ etc. and show a box or an X.

const PATHS: Record<string, string> = {
  prompt: 'M8 5l7 7-7 7',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  dot: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  ring: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  backspace: 'M21 5H8l-6 7 6 7h13zM11 9l6 6M17 9l-6 6',
  arrow: 'M4 12h15M13 6l6 6-6 6',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM14 4h4v16h-4z',
  cross: 'M6 6l12 12M18 6L6 18',
  box: 'M4 4h16v16H4z',
  boxCheck: 'M4 4h16v16H4zM7.5 12.5l3 3 6-7',
  boxHalf: 'M4 4h16v16H4zM4 20L20 4',
  updown: 'M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5',
  recent: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  spark: 'M12 2l2 8 8 2-8 2-2 8-2-8-8-2 8-2z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
};

const FILLED = { star: 1, dot: 1, play: 1, pause: 1, spark: 1 } as Record<string, number>;

export function Glyph({ n, gap }: { n: keyof typeof PATHS | string; gap?: boolean }) {
  const filled = !!FILLED[n];
  return (
    <svg
      class="glyph-svg"
      viewBox="0 0 24 24"
      style={{ width: '0.9em', height: '0.9em', verticalAlign: '-0.1em', marginRight: gap ? '0.35em' : undefined }}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={filled ? 0 : 2.4}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={PATHS[n] || PATHS.dot} />
    </svg>
  );
}
