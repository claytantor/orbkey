import { useEffect, useState } from 'react';

/**
 * A blinking block cursor for text/passphrase prompts.
 *
 * Ink 5 has no cursor primitive, so we toggle visibility on a manual interval.
 * The interval is the ONLY motion in the UI (per the design brief, ~1.1s steps)
 * and MUST be torn down on unmount — a leaked timer keeps Node's event loop
 * alive and corrupts a clean `exit()`.
 *
 * Returns whether the cursor glyph should currently be shown. When `active` is
 * false the cursor is steady-on (no timer armed), so background prompts don't
 * burn CPU.
 */
export function useBlinkCursor(active = true, periodMs = 1100): boolean {
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }
    setOn(true);
    const id = setInterval(() => {
      setOn((v) => !v);
    }, periodMs / 2);
    return () => {
      clearInterval(id);
    };
  }, [active, periodMs]);

  return active ? on : true;
}
