import { useInput } from 'ink';
import { useState } from 'react';

/**
 * Controlled focus index across `count` fields. Tab / Down move forward,
 * Shift+Tab / Up move back. `isActive` gates so background screens don't react.
 * Returns the focused index and a setter (for click-like focus jumps).
 */
export function useFormFocus(
  count: number,
  isActive: boolean,
  initial = 0,
): [number, (i: number) => void] {
  const [index, setIndex] = useState(initial);

  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        setIndex((i) => (i - 1 + count) % count);
        return;
      }
      if (key.tab) {
        setIndex((i) => (i + 1) % count);
        return;
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(count - 1, i + 1));
        return;
      }
      if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
    },
    { isActive },
  );

  return [Math.min(index, count - 1), setIndex];
}
