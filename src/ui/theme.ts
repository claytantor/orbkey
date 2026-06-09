/**
 * Palette + glyphs for the OrbKey TUI.
 *
 * Colors are the wireframe truecolor set (see `requirements/.../OrbKey
 * Wireframes.html` `:root`). Ink renders these as 24-bit hex on capable
 * terminals and degrades to the nearest ANSI when the terminal is limited;
 * `NO_COLOR` is honored by Ink itself. The user-configurable theming knobs
 * (accent / density / framing / sidebar width) from the handoff are NOT built
 * this pass — the palette is intentionally hardcoded.
 */
export const theme = {
  /** Caret, dividers, highlight, cursor, active labels. */
  accent: '#4fc3d6',
  /** Revealed secret values only. */
  reveal: '#d99a52',
  /** Success / sync-ok / ✓. */
  success: '#6fb86b',
  /** #label text & tag chips. */
  tag: '#6fae9f',
  /** Selected / emphasis text. */
  bright: '#e8eff3',
  /** Body text. */
  fg: '#9fb1bb',
  /** Secondary / meta text. */
  dim: '#5e7077',
  /** Warnings (DIRTY sync, mismatches). */
  warn: '#d99a52',
  /** Errors (locked badge, failures). */
  error: '#d2655a',
  /** Back-compat alias used by older components (== dim). */
  muted: '#5e7077',
  /** Back-compat alias used by older components (== bright). */
  text: '#e8eff3',
} as const;

export const MASK = '••••••••';

/**
 * Whether the terminal can render the Unicode wireframe glyphs. We degrade to an
 * ASCII set for dumb terminals (TERM=dumb), when `NO_COLOR` is set (a strong
 * signal of a minimal/log-capture context), or when the locale is not UTF-8.
 * Centralizing this keeps every screen consistent.
 */
function unicodeOk(): boolean {
  if (process.env['ORBKEY_ASCII'] === '1') {
    return false;
  }
  if (process.env['TERM'] === 'dumb') {
    return false;
  }
  const ctype = process.env['LC_ALL'] ?? process.env['LC_CTYPE'] ?? process.env['LANG'] ?? '';
  if (ctype && !/utf-?8/i.test(ctype)) {
    return false;
  }
  return true;
}

const UNICODE = {
  pointer: '❯',
  promptSearch: '›',
  ringEmpty: '○',
  ringFull: '●',
  search: '⌕',
  tick: '✓',
  cross: '✖',
  tab: '⇥',
  enter: '↵',
  up: '↑',
  down: '↓',
  updown: '↑↓',
  hash: '#',
  bullet: '·',
  cursor: '▌',
  lock: '🔒',
  unlock: '🔓',
  /** Wet-overspray speckle at the spray-reveal leading edge. */
  spray: '░',
} as const;

const ASCII: Record<keyof typeof UNICODE, string> = {
  pointer: '>',
  promptSearch: '>',
  ringEmpty: 'o',
  ringFull: '*',
  search: '/',
  tick: 'v',
  cross: 'x',
  tab: 'tab',
  enter: 'enter',
  up: '^',
  down: 'v',
  updown: '^v',
  hash: '#',
  bullet: '.',
  cursor: '_',
  lock: '[L]',
  unlock: '[U]',
  spray: ':',
};

/** Resolved glyph set for this terminal (Unicode by default, ASCII fallback). */
export const figures: Record<keyof typeof UNICODE, string> = unicodeOk() ? UNICODE : ASCII;

/**
 * Whether decorative animation (e.g. the lock-screen shimmer sweep) should run.
 * We disable it for color-less / log-capture contexts where a moving highlight
 * is pointless or actively annoying: `NO_COLOR` set, `TERM=dumb`, or the
 * `ORBKEY_ASCII` opt-out. Callers fall back to a static render. Note Ink still
 * honors `NO_COLOR` for its own color output; this only gates the timer.
 */
export function animationEnabled(): boolean {
  if (process.env['ORBKEY_ASCII'] === '1') {
    return false;
  }
  if (process.env['TERM'] === 'dumb') {
    return false;
  }
  // NO_COLOR (any value, even empty) disables color per the spec.
  if (process.env['NO_COLOR'] !== undefined) {
    return false;
  }
  return true;
}
