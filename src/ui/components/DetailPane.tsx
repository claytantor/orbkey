import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, MASK } from '../theme.js';
import { truncateEnd, wrapText } from '../truncate.js';
import type { UiSecret } from '../types.js';

const ELLIPSIS = '…';

interface Props {
  secret: UiSecret | null;
  revealed: boolean;
  width: number;
  /**
   * Body height (rows) available to the whole pane — the same `bodyRows` budget
   * HomeScreen pins the list/detail split to. Used to grow the note vertically
   * and truncate it with `…` when it overflows. Optional so non-Home callers /
   * older tests still render (falls back to a single note line).
   */
  rows?: number;
}

// Rows the non-note sections consume inside the pane, so we can derive how many
// lines are left for the note body. Each `marginTop={1}` block costs its gap +
// its content row(s):
//   key line              = 1
//   value block (gap+row) = 2
//   labels block (gap+row)= 2
//   note: label (gap+row) = 2   (the `note:` heading; body lines follow it)
//   footer block (gap+row)= 2
// => 9 fixed rows; note body gets `bodyRows - 9` lines.
const FIXED_NOTE_OVERHEAD = 9;

/**
 * Wrap `note` to `width` columns and cap to `maxLines`, appending `…` to the
 * last visible line when there's more (replacing its tail so the line still fits
 * the width). Returns all lines (no ellipsis) when everything fits. Pure.
 */
export function noteLines(note: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0) {
    return [];
  }
  const wrapped = wrapText(note, width);
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const visible = wrapped.slice(0, maxLines);
  const last = visible[maxLines - 1] ?? '';
  visible[maxLines - 1] = withEllipsis(last, width);
  return visible;
}

/**
 * Force a trailing `…` onto `line`, trimming its tail (string-width aware) so the
 * result still fits `width`. Unlike `truncateEnd`, this ALWAYS adds the ellipsis
 * even when the line already fits — it signals vertical truncation ("more below"),
 * not horizontal overflow. Pure.
 */
function withEllipsis(line: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (width === 1) {
    return ELLIPSIS;
  }
  // Trim the line to width-1 columns, then append the ellipsis.
  const budget = width - 1;
  let out = '';
  let used = 0;
  for (const ch of line) {
    const w = stringWidth(ch);
    if (used + w > budget) {
      break;
    }
    out += ch;
    used += w;
  }
  // Drop a single trailing space so it doesn't read as "word …".
  out = out.replace(/ $/, '');
  return `${out}${ELLIPSIS}`;
}

/** Right pane: detail view for the selected secret. Value masked by default. */
export function DetailPane({ secret, revealed, width, rows }: Props): React.ReactElement {
  // paddingX={2} eats 4 columns.
  const innerWidth = Math.max(1, width - 4);

  if (!secret) {
    return (
      <Box width={width} paddingX={2} flexDirection="column">
        <Text dimColor>No secret selected.</Text>
      </Box>
    );
  }
  const value = revealed ? secret.value : MASK;
  const labels =
    secret.labels.length > 0
      ? secret.labels.map((n) => `#${n}`).join('  ')
      : '(none)';
  const revealHint = `    (Ctrl+R to ${revealed ? 'hide' : 'reveal'})`;

  // Note: word-wrapped to the inner width and grown to fill the rows left
  // between the labels block and the created/updated footer. When `rows` is
  // unknown (non-Home callers) fall back to a single line so the footer never
  // gets pushed off-screen.
  const noteBudget =
    rows !== undefined ? Math.max(0, rows - FIXED_NOTE_OVERHEAD) : 1;
  let noteBody: string[];
  if (secret.note) {
    noteBody = noteLines(secret.note, innerWidth, noteBudget);
  } else {
    // Empty note still shows `(none)` (when there's at least one row for it).
    noteBody = noteBudget > 0 ? ['(none)'] : [];
  }

  return (
    <Box width={width} paddingX={2} flexDirection="column">
      <Text bold color={theme.accent} wrap="truncate-end">
        {truncateEnd(secret.key, innerWidth)}
      </Text>
      <Box marginTop={1}>
        <Text bold>value: </Text>
        {/* Revealed values may be long; truncate so the pane never wraps off-screen. */}
        <Text color={revealed ? theme.warn : undefined} wrap="truncate-end">
          {truncateEnd(value, Math.max(1, innerWidth - 7 - revealHint.length))}
        </Text>
        <Text dimColor wrap="truncate-end">
          {revealHint}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>labels: </Text>
        <Text dimColor={secret.labels.length === 0} wrap="truncate-end">
          {truncateEnd(labels, Math.max(1, innerWidth - 8))}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>note:</Text>
        {noteBody.map((line, i) => (
          // Lines are pre-wrapped to innerWidth; truncate-end is a belt-and-
          // suspenders guard so a stray wide glyph can never overflow the pane.
          // Index key is stable enough here: the list is a derived render of a
          // single string, fully replaced whenever the note changes.
          // eslint-disable-next-line react/no-array-index-key
          <Text key={`note-${i}`} dimColor={!secret.note} wrap="truncate-end">
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {truncateEnd(`created ${secret.createdAt} · updated ${secret.updatedAt}`, innerWidth)}
        </Text>
      </Box>
    </Box>
  );
}
