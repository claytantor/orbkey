import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface WindowSize {
  columns: number;
  rows: number;
}

/**
 * Ink 5 has no `useWindowSize`; this subscribes to stdout 'resize' and falls
 * back to sane defaults for non-TTY / piped output.
 */
export function useWindowSize(): WindowSize {
  const { stdout } = useStdout();
  const read = (): WindowSize => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  const [size, setSize] = useState<WindowSize>(read);

  useEffect(() => {
    if (!stdout) {
      return;
    }
    const onResize = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
