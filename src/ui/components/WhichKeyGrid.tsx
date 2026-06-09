import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, figures } from '../theme.js';
import { LEADER_BINDINGS } from '../leader.js';

/** Width (in cells) of one rendered `key  label` cell, plus inter-cell gap. */
const COL_GAP = 3;

function cellText(key: string, label: string): string {
  return `${key}  ${label}`;
}

/** Width of the widest binding cell — every column is sized to this for alignment. */
function maxCellWidth(): number {
  return LEADER_BINDINGS.reduce(
    (m, b) => Math.max(m, stringWidth(cellText(b.key, b.label))),
    0,
  );
}

/** How many columns of bindings fit in the given content width (>= 1). */
export function whichKeyColumns(columns: number): number {
  const inner = Math.max(1, columns - 2); // paddingX={1}
  const cell = maxCellWidth();
  const per = cell + COL_GAP;
  return Math.max(1, Math.floor((inner + COL_GAP) / per));
}

/**
 * Total rows this strip occupies: 1 header line + ceil(bindings / columns) grid
 * rows. HomeScreen calls this to keep the chrome budget (and bottom-pinning)
 * exact when the grid is open.
 */
export function whichKeyRowCount(columns: number): number {
  const cols = whichKeyColumns(columns);
  const gridRows = Math.ceil(LEADER_BINDINGS.length / cols);
  return 1 + gridRows;
}

interface Props {
  vaultName: string;
  columns: number;
}

/**
 * The which-key leader cheat-sheet (Variant B). A header line
 * (`Ctrl+Space → <vault>`) over a multi-column `key  label` grid. Keys render in
 * accent, labels dim — purely presentational; the app owns key dispatch.
 */
export function WhichKeyGrid({ vaultName, columns }: Props): React.ReactElement {
  const cols = whichKeyColumns(columns);
  const cell = maxCellWidth();
  const rows = Math.ceil(LEADER_BINDINGS.length / cols);

  // Column-major fill so reading top-to-bottom within a column stays natural.
  const grid: Array<Array<(typeof LEADER_BINDINGS)[number] | null>> = [];
  for (let r = 0; r < rows; r += 1) {
    const row: Array<(typeof LEADER_BINDINGS)[number] | null> = [];
    for (let c = 0; c < cols; c += 1) {
      row.push(LEADER_BINDINGS[c * rows + r] ?? null);
    }
    grid.push(row);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.dim}>
        Ctrl+Space {figures.promptSearch} {vaultName}
      </Text>
      {grid.map((row, ri) => (
        <Box key={ri} gap={COL_GAP}>
          {row.map((b, ci) =>
            b ? (
              <Box key={ci} width={cell}>
                <Text color={theme.accent} bold>
                  {b.key}
                </Text>
                <Text color={theme.dim}>{'  ' + b.label}</Text>
              </Box>
            ) : (
              <Box key={ci} width={cell} />
            ),
          )}
        </Box>
      ))}
    </Box>
  );
}
