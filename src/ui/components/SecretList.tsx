import React from 'react';
import { Box, Text } from 'ink';
import { theme, figures } from '../theme.js';
import { truncateEnd, splitHighlight } from '../truncate.js';
import type { UiSecret } from '../types.js';

interface Props {
  secrets: UiSecret[];
  selectedKey: string | null;
  /** Rows available for the list body (drives the windowing). */
  viewportRows: number;
  width: number;
  /** Current live-filter string; matched substrings in keys render in accent. */
  highlight?: string;
}

/**
 * Left pane: filtered list of secret keys with label chips. Windowed so it never
 * dumps hundreds of rows — keeps the selected row visible — and truncated to the
 * pane width with display-width awareness so wide chars never wrap.
 */
export function SecretList({
  secrets,
  selectedKey,
  viewportRows,
  width,
  highlight = '',
}: Props): React.ReactElement {
  // paddingX={1} eats 2 columns; the pointer + space eats 2 more.
  const innerWidth = Math.max(1, width - 2);

  if (secrets.length === 0) {
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Text dimColor>No secrets match.</Text>
      </Box>
    );
  }

  const selectedIdx = Math.max(
    0,
    secrets.findIndex((s) => s.key === selectedKey),
  );

  // When the list overflows, reserve the last row for the "X-Y of N" footer so
  // the pane height stays within viewportRows and never pushes content offscreen.
  const overflowing = secrets.length > viewportRows;
  const rows = Math.max(1, overflowing ? viewportRows - 1 : viewportRows);

  let start = 0;
  if (selectedIdx >= rows) {
    start = Math.min(selectedIdx - rows + 1, secrets.length - rows);
  }
  start = Math.max(0, start);
  const visible = secrets.slice(start, start + rows);
  const showFooter = secrets.length > rows;

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {visible.map((s) => {
        const active = s.key === selectedKey;
        const chips = s.labels.map((n) => `#${n}`).join(' ');
        const pointer = active ? figures.pointer : ' ';
        // Budget: keep at least the key visible; chips get whatever is left.
        const keyCols = Math.max(1, innerWidth - 2);
        const keyText = truncateEnd(s.key, keyCols);
        // Highlight is computed from the already-truncated display text so the
        // accent never marks characters that aren't actually drawn.
        const segments = splitHighlight(keyText, highlight);
        return (
          <Box key={s.id}>
            <Text color={active ? theme.accent : undefined} bold={active} wrap="truncate-end">
              {pointer}{' '}
              {segments.map((seg, i) =>
                seg.match ? (
                  <Text key={i} color={theme.accent} bold>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )}
            </Text>
            {chips ? (
              <Text dimColor wrap="truncate-end">
                {' '}
                {chips}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {showFooter ? (
        <Text dimColor wrap="truncate-end">
          {start + 1}-{start + visible.length} of {secrets.length}
        </Text>
      ) : null}
    </Box>
  );
}
