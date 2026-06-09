import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { truncateEnd } from '../truncate.js';
import type { CommandSpec } from '../commands.js';

/** Max completion rows shown above the `:` prompt (fixed for a stable budget). */
export const COMMAND_STRIP_MAX_ROWS = 4;

/** Rows this strip occupies for the given completions (always >= 1). */
export function commandStripRowCount(matches: number): number {
  return Math.max(1, Math.min(matches, COMMAND_STRIP_MAX_ROWS));
}

interface Props {
  completions: CommandSpec[];
  /** Index of the highlighted completion (Tab cycles it). */
  selected: number;
  columns: number;
}

/**
 * The fuzzy completion strip for `:` command mode (Variant B). Each row is
 * `name — description`; the selected name is accent + bold. When there are no
 * matches we say so warmly rather than rendering an empty band.
 */
export function CommandStrip({ completions, selected, columns }: Props): React.ReactElement {
  const inner = Math.max(1, columns - 2); // paddingX={1}

  if (completions.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.dim}>no matching command</Text>
      </Box>
    );
  }

  // Window the completions around the selection so the highlighted row is always
  // visible within the fixed row budget.
  const max = COMMAND_STRIP_MAX_ROWS;
  let start = 0;
  if (completions.length > max && selected >= max) {
    start = Math.min(selected - max + 1, completions.length - max);
  }
  const visible = completions.slice(start, start + max);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((c, i) => {
        const isSel = start + i === selected;
        const name = c.name;
        const descBudget = Math.max(1, inner - name.length - 3);
        return (
          <Box key={c.name}>
            <Text color={isSel ? theme.accent : theme.fg} bold={isSel} wrap="truncate-end">
              {name}
            </Text>
            <Text color={theme.dim} wrap="truncate-end">
              {' — ' + truncateEnd(c.description, descBudget)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
