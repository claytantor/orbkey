import { useEffect, useState } from 'react';
import { animationEnabled } from '../theme.js';
import { SHIMMER_BAND_MIN, nextShimmerBand } from '../components/Wordmark.js';

/** ~90ms per frame — a gentle, looping sheen, not a strobe. */
const SHIMMER_FRAME_MS = 90;

/**
 * Drives the lock-screen shimmer sweep: owns a manual interval that advances the
 * diagonal band position each frame, wrapping seamlessly (see
 * {@link nextShimmerBand}). The lit-cell geometry itself lives in the pure
 * `shimmerLit`/`shimmerSpans` helpers so it can be tested without fake timers;
 * this hook only owns the timer and the current `band` integer.
 *
 * Returns the current `band` to feed `<Wordmark shimmerBand>`, or `undefined`
 * when the animation is paused/disabled — in which case the caller renders the
 * static cyan art (no lit band). It pauses when:
 *   (a) `active` is false (not on the big tier, or the screen is busy/unlocking),
 *   (b) the terminal is dumb / `NO_COLOR` (see {@link animationEnabled}).
 *
 * The interval is `unref`'d so it never keeps Node's event loop alive, and is
 * cleared on unmount / when `active` flips false — a leaked timer corrupts a
 * clean `exit()`.
 */
export function useShimmer(active: boolean, frameMs = SHIMMER_FRAME_MS): number | undefined {
  const enabled = active && animationEnabled();
  const [band, setBand] = useState(SHIMMER_BAND_MIN);

  useEffect(() => {
    if (!enabled) {
      // Reset so the next activation starts a fresh sweep from the top.
      setBand(SHIMMER_BAND_MIN);
      return;
    }
    const id = setInterval(() => {
      setBand((b) => nextShimmerBand(b));
    }, frameMs);
    // Do not hold the process open just for decoration.
    if (typeof id.unref === 'function') {
      id.unref();
    }
    return () => {
      clearInterval(id);
    };
  }, [enabled, frameMs]);

  return enabled ? band : undefined;
}
