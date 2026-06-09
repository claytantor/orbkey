import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  focused: boolean;
  rows?: number;
  /**
   * Render the rounded frame (default). When false the editor is borderless —
   * just free-form text that soft-wraps to the available width, with a left
   * gutter caret as the focus affordance. Used by the inline add/edit note.
   */
  bordered?: boolean;
  /** Reserve Tab for form navigation: never insert it here. */
}

interface Model {
  lines: string[];
  /** Cursor row/col into `lines`. */
  row: number;
  col: number;
}

function fromValue(value: string): Model {
  const lines = value.split('\n');
  const lastRow = lines.length - 1;
  return { lines, row: lastRow, col: (lines[lastRow] ?? '').length };
}

function toValue(m: Model): string {
  return m.lines.join('\n');
}

/**
 * Hand-rolled multi-line editor for the note field (ink-text-input is
 * single-line only). Controlled {lines, cursor}; v1 omits selection/undo and
 * reserves Tab for form navigation (Tab must bubble so focus can LEAVE the
 * note). Pasted text (a multi-char `input` chunk with no control key) is
 * inserted intact rather than echoed char-by-char.
 *
 * Two render modes: bordered (a rounded box, default — used by other callers)
 * and borderless (`bordered={false}` — free-form wrapping text with a left
 * caret gutter, used by the inline add/edit form). In both modes long logical
 * lines SOFT-WRAP to the available width via Ink's own `<Text wrap="wrap">`
 * rather than truncating, and the visible window scrolls to keep the cursor row
 * in view so the note never exceeds its `rows` budget (preserving Home's
 * pin-to-bottom invariant).
 */
export function TextArea({
  value,
  onChange,
  focused,
  rows = 6,
  bordered = true,
}: Props): React.ReactElement {
  const model = fromValue(value);

  const commit = (next: Model): void => {
    onChange(toValue(next));
  };

  useInput(
    (input, key) => {
      const lines = [...model.lines];
      let { row, col } = model;
      const cur = lines[row] ?? '';

      if (key.return) {
        const before = cur.slice(0, col);
        const after = cur.slice(col);
        lines[row] = before;
        lines.splice(row + 1, 0, after);
        commit({ lines, row: row + 1, col: 0 });
        return;
      }
      if (key.tab) {
        // Reserved for form navigation — ignore here so Tab/Shift+Tab can move
        // focus INTO and OUT OF the note (mirrors TextField ignoring Tab).
        return;
      }
      if (key.leftArrow) {
        if (col > 0) {
          commit({ lines, row, col: col - 1 });
        } else if (row > 0) {
          commit({ lines, row: row - 1, col: (lines[row - 1] ?? '').length });
        }
        return;
      }
      if (key.rightArrow) {
        if (col < cur.length) {
          commit({ lines, row, col: col + 1 });
        } else if (row < lines.length - 1) {
          commit({ lines, row: row + 1, col: 0 });
        }
        return;
      }
      if (key.upArrow) {
        if (row > 0) {
          const target = lines[row - 1] ?? '';
          commit({ lines, row: row - 1, col: Math.min(col, target.length) });
        }
        return;
      }
      if (key.downArrow) {
        if (row < lines.length - 1) {
          const target = lines[row + 1] ?? '';
          commit({ lines, row: row + 1, col: Math.min(col, target.length) });
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (col > 0) {
          lines[row] = cur.slice(0, col - 1) + cur.slice(col);
          commit({ lines, row, col: col - 1 });
        } else if (row > 0) {
          const prev = lines[row - 1] ?? '';
          const merged = prev + cur;
          lines.splice(row - 1, 2, merged);
          commit({ lines, row: row - 1, col: prev.length });
        }
        return;
      }
      // Ignore other control chords (Ctrl+*, escape handled upstream).
      if (key.ctrl || key.meta || key.escape || input.length === 0) {
        return;
      }

      // Plain text or a pasted chunk (may contain newlines).
      if (input.includes('\n')) {
        const parts = input.split('\n');
        const before = cur.slice(0, col);
        const after = cur.slice(col);
        const first = parts[0] ?? '';
        const last = parts[parts.length - 1] ?? '';
        const middle = parts.slice(1, -1);
        const newLines = [before + first, ...middle, last + after];
        lines.splice(row, 1, ...newLines);
        commit({
          lines,
          row: row + parts.length - 1,
          col: last.length,
        });
        return;
      }
      lines[row] = cur.slice(0, col) + input + cur.slice(col);
      commit({ lines, row, col: col + input.length });
    },
    { isActive: focused },
  );

  // Scroll a window of logical lines so the cursor row stays visible. (Each
  // logical line may still soft-wrap to several terminal rows; this keeps the
  // note bounded enough for the form's row budget without exact wrap math.)
  const start = Math.max(0, Math.min(model.row - (rows - 1), model.lines.length - rows));
  const window = model.lines.slice(Math.max(0, start), Math.max(0, start) + rows);
  const isEmpty = model.lines.length === 1 && model.lines[0] === '';

  const renderLine = (line: string, absRow: number, idx: number): React.ReactElement => {
    const isCursorRow = focused && absRow === model.row;
    if (!isCursorRow) {
      // wrap="wrap" makes Ink soft-wrap long lines to the box width.
      return (
        <Text key={idx} wrap="wrap">
          {line || ' '}
        </Text>
      );
    }
    const before = line.slice(0, model.col);
    const at = line.slice(model.col, model.col + 1) || ' ';
    const after = line.slice(model.col + 1);
    return (
      <Text key={idx} wrap="wrap">
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    );
  };

  if (!bordered) {
    // Borderless: free-form wrapping text with a left gutter caret as the only
    // focus affordance (the parent also turns the `note` label accent).
    return (
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={1}>
          <Text color={focused ? theme.accent : theme.muted}>{focused ? '❯' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {isEmpty ? (
            <Text dimColor>(empty — type, or Ctrl+P to paste)</Text>
          ) : (
            window.map((line, i) => renderLine(line, Math.max(0, start) + i, i))
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.accent : theme.muted}
      paddingX={1}
      minHeight={rows + 2}
    >
      {isEmpty ? (
        <Text dimColor>(empty — type, or Ctrl+P to paste)</Text>
      ) : (
        window.map((line, i) => renderLine(line, Math.max(0, start) + i, i))
      )}
    </Box>
  );
}
