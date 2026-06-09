import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.js';
import { truncateEnd, truncateMiddle } from '../truncate.js';

export interface StatusLineProps {
  /** Mode label, e.g. "UNLOCKED", "LOCKED", "ADD", "EDIT", "HELP". */
  mode: string;
  /** Whether the selected value is currently revealed (home only). */
  revealed: boolean;
  /** Selected secret key, or null when nothing is selected. */
  selectedKey: string | null;
  /** 1-based position of the selection within the (filtered) list. */
  position: number | null;
  /** Size of the (filtered) list. */
  total: number;
  /** Persistent status text. */
  status: string;
  /** Transient flash text; overrides `status` when present. */
  flash: string | null;
  /** Available terminal columns, so the line stays exactly one row. */
  columns: number;
  /**
   * Optional left-segment override (e.g. `FILTER · "tr" · 2/8 match`,
   * `EDIT · field 2/4`). When set it replaces the computed mode/selection text.
   */
  overrideLeft?: string;
  /** Optional right-segment override (e.g. `reseal on save`, `⇥ complete · ↵ run`). */
  overrideRight?: string;
}

/**
 * A single-line status bar pinned to the bottom of the screen.
 *
 * Layout (one row, never wraps): `MODE · key (3/27) [REVEALED]` on the left and
 * the status / flash message on the right. Everything is truncated to the
 * terminal width with display-width awareness so wide chars never push the bar
 * onto a second line. It is truthful to reducer state and never renders a
 * secret value.
 */
export function StatusLine({
  mode,
  revealed,
  selectedKey,
  position,
  total,
  status,
  flash,
  columns,
  overrideLeft,
  overrideRight,
}: StatusLineProps): React.ReactElement {
  const width = Math.max(1, columns);

  // Left segment: an explicit override (mode-specific) or the default mode +
  // selection + position + reveal summary.
  let leftRaw: string;
  if (overrideLeft !== undefined) {
    const extra = revealed ? '  ·  REVEALED' : '';
    leftRaw = `${overrideLeft}${extra}`;
  } else {
    const parts: string[] = [mode];
    if (selectedKey) {
      const pos = position !== null && total > 0 ? ` (${position}/${total})` : '';
      parts.push(`${selectedKey}${pos}`);
    } else if (total > 0) {
      parts.push(`0/${total}`);
    }
    if (revealed) {
      parts.push('REVEALED');
    }
    leftRaw = parts.join('  ·  ');
  }

  // Right segment: a flash always wins; else an override; else persistent status.
  const rightRaw = flash ?? overrideRight ?? status ?? '';

  // Budget split: keep the mode/selection legible; the right side gets the rest.
  // Reserve at least a 1-col gap between the two segments.
  let left = leftRaw;
  let right = rightRaw;
  const gap = 1;

  if (truncWidth(left) + gap + truncWidth(right) > width) {
    // Give the left segment up to ~60% of the row, the right the remainder.
    const leftBudget = Math.max(0, Math.min(truncWidth(left), Math.floor(width * 0.6)));
    left = truncateMiddle(left, leftBudget);
    const rightBudget = Math.max(0, width - truncWidth(left) - gap);
    right = truncateEnd(right, rightBudget);
  }

  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate-end" color={theme.muted} dimColor>
        {left || ' '}
      </Text>
      {right ? (
        <Text wrap="truncate-end" color={flash ? theme.accent : theme.muted} dimColor={!flash}>
          {right}
        </Text>
      ) : null}
    </Box>
  );
}

function truncWidth(s: string): number {
  return stringWidth(s);
}
