import { useEffect, useState } from 'react';
import { animationEnabled } from '../theme.js';
import { REVEAL_DONE_CUTOFF } from '../components/Wordmark.js';

/**
 * Frame cadence and step size for the spray-on reveal. The cutoff column starts
 * just left of the art (`-1`, fully blank) and advances by `REVEAL_STEP_COLS`
 * every `REVEAL_FRAME_MS`. With the Slant art ~37 cutoff-columns wide
 * (`REVEAL_DONE_CUTOFF`), 3 cols / 30ms completes the draw-in in ~13 frames ≈
 * 390ms — the ~400ms target — without flickering at a sub-terminal-refresh rate.
 */
const REVEAL_FRAME_MS = 30;
const REVEAL_STEP_COLS = 3;
/** The cutoff before the first frame: everything blank. */
const REVEAL_START_CUTOFF = -1;

export interface SprayReveal {
  /**
   * The current reveal cutoff column to feed `<Wordmark revealCutoff>`, or
   * `undefined` once the reveal is complete / disabled — in which case the
   * caller renders the full art (and may start the shimmer).
   */
  cutoff: number | undefined;
  /** True once the one-shot reveal has finished (or was never going to run). */
  done: boolean;
}

/**
 * Drives the one-shot spray-on reveal: owns a manual interval that advances the
 * reveal `cutoff` column left→right across the art, then stops and reports
 * `done` so the caller can hand off to the looping shimmer. The paint geometry
 * itself lives in the pure `revealCell`/`revealVisible` helpers (testable
 * without fake timers); this hook only owns the timer and the cutoff integer.
 *
 * When `active` is false — not the big tier, the screen is busy/unlocking, or
 * the terminal is dumb / `NO_COLOR` (see {@link animationEnabled}) — the reveal
 * is SKIPPED entirely: `cutoff` is `undefined` and `done` is `true` from the
 * first render, so the full static art shows immediately with no partial states
 * and no from-blank flash.
 *
 * The interval is `unref`'d so it never keeps Node's event loop alive, and is
 * cleared on unmount / when `active` flips false — a leaked timer corrupts a
 * clean `exit()`. If the component unmounts mid-reveal (user types / unlocks),
 * the interval stops cleanly.
 */
export function useSprayReveal(active: boolean): SprayReveal {
  const enabled = active && animationEnabled();
  // Start fully drawn when disabled so there is never a blank flash; start blank
  // (-1) and animate in when enabled.
  const [cutoff, setCutoff] = useState<number>(() =>
    enabled ? REVEAL_START_CUTOFF : REVEAL_DONE_CUTOFF,
  );
  const done = cutoff >= REVEAL_DONE_CUTOFF;

  useEffect(() => {
    if (!enabled) {
      // Skip the reveal: jump straight to fully painted.
      setCutoff(REVEAL_DONE_CUTOFF);
      return;
    }
    // Begin a fresh sweep from blank each time the reveal (re)activates.
    setCutoff(REVEAL_START_CUTOFF);
    const id = setInterval(() => {
      setCutoff((c) => {
        const next = c + REVEAL_STEP_COLS;
        if (next >= REVEAL_DONE_CUTOFF) {
          clearInterval(id);
          return REVEAL_DONE_CUTOFF;
        }
        return next;
      });
    }, REVEAL_FRAME_MS);
    // Do not hold the process open just for a one-shot draw-in.
    if (typeof id.unref === 'function') {
      id.unref();
    }
    return () => {
      clearInterval(id);
    };
  }, [enabled]);

  // While running, expose the cutoff; once done, expose undefined so the caller
  // renders the full art and the shimmer takes over.
  return { cutoff: enabled && !done ? cutoff : undefined, done: !enabled || done };
}
