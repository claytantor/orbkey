import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, figures } from '../theme.js';
import { truncateEnd } from '../truncate.js';

/**
 * Large "orbkey" wordmark in the figlet "Slant" font. Pure ASCII
 * (`_ / \ , < |`) so it is safe in dumb terminals; reads as "orbkey" in a
 * slanted chrome style. 6 rows tall, 35 columns wide. Every line is padded to
 * exactly 35 columns (trailing spaces are significant) so the block stays
 * rectangular when centered and so the shimmer overlay can address cells by a
 * stable (row, col) grid.
 */
export const BIG_ART: readonly string[] = [
  '              __    __             ',
  '  ____  _____/ /_  / /_____  __  __',
  ' / __ \\/ ___/ __ \\/ //_/ _ \\/ / / /',
  '/ /_/ / /  / /_/ / ,< /  __/ /_/ / ',
  '\\____/_/  /_.___/_/|_|\\___/\\__, /  ',
  '                          /____/   ',
];

/** Widest line of the big art, measured in terminal columns. */
export const BIG_ART_WIDTH: number = BIG_ART.reduce((w, line) => Math.max(w, stringWidth(line)), 0);
/** Height of the big art in rows. */
export const BIG_ART_HEIGHT: number = BIG_ART.length;

/** Letter-spaced medium wordmark. */
export const SMALL_WORDMARK = 'O R B K E Y';
/** Plain fallback wordmark. */
export const PLAIN_WORDMARK = 'orbkey';

/** Horizontal breathing room kept on each side of the big art. */
const BIG_ART_HMARGIN = 3;
/**
 * Vertical rows the rest of the lock screen needs around the hero. With the
 * decorative orb removed, the chrome around the wordmark is: top bar (1),
 * subtitle (1), prompt margin+line (2), hint margin+line (2), bottom status (1),
 * plus a little centering slack — ~8 rows. If the viewport is shorter than the
 * art (6) plus this budget, we drop a tier so the prompt stays on-screen.
 * Lowered from 13 to 8 when the orb's ~6 rows were reclaimed, so the big tier
 * now shows on terminals as short as 14 rows (was 19).
 */
const BIG_ART_VBUDGET = 8;

export type WordmarkTier = 'big' | 'small' | 'plain';

export interface WordmarkChoice {
  tier: WordmarkTier;
  /** Lines to render (1 line for small/plain, BIG_ART for big). */
  lines: readonly string[];
  /** Widest rendered line, in columns — guaranteed <= columns. */
  width: number;
}

/**
 * Pick the largest wordmark tier that fits the viewport.
 *
 * Tiers, widest-line widths, and the gates:
 *  - `big`   — the 35x6 Slant ASCII-art block. Chosen only when it fits BOTH
 *              horizontally (`columns >= BIG_ART_WIDTH + 2*HMARGIN`, i.e.
 *              `35 + 6 = 41`) and vertically (`rows >= BIG_ART_HEIGHT + VBUDGET`,
 *              i.e. `6 + 8 = 14`).
 *  - `small` — letter-spaced `O R B K E Y` (11 cols). Chosen when the big art
 *              does not fit but `columns >= width(SMALL) + 2`.
 *  - `plain` — bare `orbkey` (6 cols). The always-safe backstop.
 *
 * The returned `width` is always <= `columns` so the caller can center without
 * risk of wrap/overflow.
 */
export function pickWordmark(columns: number, rows: number): WordmarkChoice {
  const cols = Math.max(1, Math.floor(columns));
  const rws = Math.max(1, Math.floor(rows));

  const bigFitsWide = cols >= BIG_ART_WIDTH + BIG_ART_HMARGIN * 2;
  const bigFitsTall = rws >= BIG_ART_HEIGHT + BIG_ART_VBUDGET;
  if (bigFitsWide && bigFitsTall) {
    return { tier: 'big', lines: BIG_ART, width: BIG_ART_WIDTH };
  }

  const smallWidth = stringWidth(SMALL_WORDMARK);
  if (cols >= smallWidth + 2) {
    return { tier: 'small', lines: [SMALL_WORDMARK], width: smallWidth };
  }

  // Absolute backstop: even `orbkey` (6 cols) can overflow a degenerate
  // <6-column viewport, so end-truncate it to the available width to guarantee
  // the no-overflow invariant.
  const plain = truncateEnd(PLAIN_WORDMARK, cols);
  return { tier: 'plain', lines: [plain], width: stringWidth(plain) };
}

/* ----------------------------------------------------------------------------
 * Shimmer sweep — a bright diagonal sheen band that slides across the Slant art.
 * The lit-cell predicate is a PURE function so it can be unit-tested without
 * timers; the React timer that advances `band` lives in
 * `../hooks/useShimmer.ts`.
 * ------------------------------------------------------------------------- */

/** Half-width of the lit band, in cells. ~1 yields a ~2-3 char sheen. */
export const SHIMMER_BAND_HALF = 1;

/**
 * Full sweep range for the shimmer band. The diagonal coordinate `c - r` ranges
 * from `-(rows-1)` (bottom-left) to `width-1` (top-right). We let `band` travel
 * the inclusive integer range `[SHIMMER_BAND_MIN, SHIMMER_BAND_MAX]` (padded by
 * the half-width so the sheen fully enters and fully exits before wrapping) and
 * wrap back to the start for a seamless loop.
 */
export const SHIMMER_BAND_MIN = -(BIG_ART_HEIGHT - 1) - SHIMMER_BAND_HALF;
export const SHIMMER_BAND_MAX = BIG_ART_WIDTH - 1 + SHIMMER_BAND_HALF;
/** Number of distinct band positions in one full sweep cycle. */
export const SHIMMER_BAND_PERIOD = SHIMMER_BAND_MAX - SHIMMER_BAND_MIN + 1;

/**
 * Advance a band position by one step, wrapping seamlessly within the sweep
 * range `[SHIMMER_BAND_MIN, SHIMMER_BAND_MAX]`. Pure — the hook owns the timer
 * that calls this.
 */
export function nextShimmerBand(band: number): number {
  const next = band + 1;
  return next > SHIMMER_BAND_MAX ? SHIMMER_BAND_MIN : next;
}

/**
 * Is the cell at (row `r`, col `c`) lit by the shimmer band at position `band`?
 *
 * The band follows the Slant diagonal: a cell is lit when its diagonal
 * coordinate `c - r` is within `halfWidth` of `band`. Pure and side-effect
 * free. Note this is geometry only — callers must additionally require the cell
 * to be a non-space glyph before brightening it (spaces never light up).
 */
export function shimmerLit(r: number, c: number, band: number, halfWidth = SHIMMER_BAND_HALF): boolean {
  return Math.abs(c - r - band) <= halfWidth;
}

/* ----------------------------------------------------------------------------
 * Spray-on reveal — a one-shot left→right "spray paint" draw-in that runs once
 * when the splash mounts, before the looping shimmer takes over. A `cutoff`
 * column advances across the art width: cells at `c <= cutoff` are painted, the
 * 1-2 cells right at the cutoff read as a dim "wet overspray" edge, and cells
 * beyond are still blank. The geometry is PURE (no timer); the React timer that
 * advances `cutoff` lives in `../hooks/useSprayReveal.ts`.
 * ------------------------------------------------------------------------- */

/** Width (in cells) of the dim "overspray" edge trailing the reveal cutoff. */
export const REVEAL_EDGE_WIDTH = 2;
/**
 * The cutoff value at which the whole art is fully painted (no edge, no hidden
 * cells). The reveal is complete once `cutoff >= REVEAL_DONE_CUTOFF`. We pad by
 * the edge width so the overspray edge sweeps off the right side before the art
 * settles to solid.
 */
export const REVEAL_DONE_CUTOFF = BIG_ART_WIDTH - 1 + REVEAL_EDGE_WIDTH;

/** Paint state of a single cell during the spray reveal. */
export type RevealCell = 'solid' | 'edge' | 'hidden';

/**
 * Is the cell at column `c` painted at all (solid OR overspray edge) for the
 * given reveal `cutoff`? Pure. Columns at or left of the cutoff are visible;
 * columns to the right are still blank.
 */
export function revealVisible(c: number, cutoff: number): boolean {
  return c <= cutoff;
}

/**
 * Classify how column `c` should render for the given reveal `cutoff`:
 *  - `hidden` — beyond the cutoff; render blank.
 *  - `edge`   — within `REVEAL_EDGE_WIDTH` just left of the cutoff; the wet
 *               "overspray" leading edge (dim accent / speckle).
 *  - `solid`  — well left of the cutoff; the settled solid glyph.
 *
 * Pure and side-effect free. Once `cutoff >= REVEAL_DONE_CUTOFF` every column is
 * `solid` (the edge has swept off the right), i.e. the full static art.
 */
export function revealCell(c: number, cutoff: number, edgeWidth = REVEAL_EDGE_WIDTH): RevealCell {
  if (c > cutoff) {
    return 'hidden';
  }
  if (c > cutoff - edgeWidth) {
    return 'edge';
  }
  return 'solid';
}

interface WordmarkProps {
  columns: number;
  rows: number;
  /**
   * Current shimmer band position. When provided AND the big tier is selected,
   * the glyphs under the band render bright while the rest render in accent
   * cyan. When `undefined` (or on small/plain tiers) the art renders as static
   * accent cyan — used for the paused/disabled/degraded states.
   *
   * Ignored while a `revealCutoff` is supplied (the one-shot reveal owns the
   * frame until it completes, then the shimmer takes over).
   */
  shimmerBand?: number;
  /**
   * Current spray-reveal cutoff column. When provided AND the big tier is
   * selected, the art paints left→right up to this column (with a dim overspray
   * edge) and everything to the right stays blank. When `undefined` the reveal
   * is not running (either complete, disabled, or a smaller tier) and the art
   * renders fully per `shimmerBand`.
   */
  revealCutoff?: number;
}

/** One contiguous run of same-color characters within an art row. */
interface Span {
  text: string;
  lit: boolean;
}

/**
 * Coalesce an art line into runs of lit / unlit characters so we emit one
 * `<Text>` span per run rather than one per character. Space cells are always
 * treated as unlit (and stay blank) regardless of the band.
 */
function shimmerSpans(line: string, row: number, band: number, halfWidth: number): Span[] {
  const chars = [...line];
  const spans: Span[] = [];
  for (let c = 0; c < chars.length; c += 1) {
    const ch = chars[c]!;
    const lit = ch !== ' ' && shimmerLit(row, c, band, halfWidth);
    const last = spans[spans.length - 1];
    if (last && last.lit === lit) {
      last.text += ch;
    } else {
      spans.push({ text: ch, lit });
    }
  }
  return spans;
}

/** One contiguous run of same-paint-state characters within an art row. */
interface RevealSpan {
  text: string;
  state: RevealCell;
}

/**
 * Coalesce an art line into runs by spray-reveal paint state for the given
 * `cutoff`, emitting one `<Text>` span per run rather than one per character.
 * Hidden cells render as blanks (preserving width); edge cells render the wet
 * overspray glyph in dim accent; solid cells render the settled glyph. Space
 * cells stay blank in every state.
 */
function revealSpans(line: string, cutoff: number): RevealSpan[] {
  const chars = [...line];
  const spans: RevealSpan[] = [];
  for (let c = 0; c < chars.length; c += 1) {
    const ch = chars[c]!;
    // Spaces are never painted; treat them as solid-blank so they coalesce with
    // neighbours without ever showing an edge speckle.
    const state: RevealCell = ch === ' ' ? 'solid' : revealCell(c, cutoff);
    const last = spans[spans.length - 1];
    if (last && last.state === state) {
      last.text += ch;
    } else {
      spans.push({ text: ch, state });
    }
  }
  return spans;
}

/**
 * Renders the adaptive "orbkey" hero wordmark, centered. Selects the big Slant
 * ASCII-art block, the letter-spaced medium wordmark, or the plain word
 * depending on the viewport (see {@link pickWordmark}).
 *
 * On the big tier the art renders in one of three modes, in priority order:
 *  1. `revealCutoff` defined — the one-shot left→right spray-on draw-in: cells
 *     left of the cutoff are solid, the leading 1-2 cells are a dim overspray
 *     edge (speckle glyph), and cells beyond the cutoff are blank. This owns the
 *     frame until the reveal completes.
 *  2. `shimmerBand` defined — the looping diagonal sheen: glyphs under the band
 *     render bright, the rest accent cyan.
 *  3. neither — static accent cyan art (paused / disabled / smaller tiers).
 */
export function Wordmark({ columns, rows, shimmerBand, revealCutoff }: WordmarkProps): React.ReactElement {
  const choice = pickWordmark(columns, rows);

  if (choice.tier === 'big') {
    // Mode 1: spray-on reveal in progress — owns the frame, ignores shimmer.
    if (revealCutoff !== undefined) {
      return (
        <Box flexDirection="column" alignItems="center">
          {choice.lines.map((line, i) => (
            <Box key={i}>
              {revealSpans(line, revealCutoff).map((span, j) => {
                if (span.state === 'hidden') {
                  // Keep the column count stable by painting blanks.
                  return <Text key={j}>{' '.repeat([...span.text].length)}</Text>;
                }
                if (span.state === 'edge') {
                  // Wet overspray: dim accent speckle for the non-space glyphs.
                  const speckle = [...span.text].map((ch) => (ch === ' ' ? ' ' : figures.spray)).join('');
                  return (
                    <Text key={j} bold dimColor color={theme.accent}>
                      {speckle}
                    </Text>
                  );
                }
                return (
                  <Text key={j} bold color={theme.accent}>
                    {span.text}
                  </Text>
                );
              })}
            </Box>
          ))}
        </Box>
      );
    }

    // Mode 2 / 3: shimmer sweep, or static when no band.
    const animate = shimmerBand !== undefined;
    return (
      <Box flexDirection="column" alignItems="center">
        {choice.lines.map((line, i) =>
          animate ? (
            <Box key={i}>
              {shimmerSpans(line, i, shimmerBand, SHIMMER_BAND_HALF).map((span, j) => (
                <Text
                  key={j}
                  bold
                  color={span.lit ? theme.bright : theme.accent}
                >
                  {span.text}
                </Text>
              ))}
            </Box>
          ) : (
            <Text key={i} bold color={theme.accent}>
              {line}
            </Text>
          ),
        )}
      </Box>
    );
  }

  // small / plain: a single line. Small is letter-spaced and bright-bold to read
  // as a wordmark; plain is the minimal backstop.
  return (
    <Text bold color={choice.tier === 'small' ? theme.bright : theme.accent}>
      {choice.lines[0]}
    </Text>
  );
}
