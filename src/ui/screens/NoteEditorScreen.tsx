import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { theme, figures } from '../theme.js';
import { truncateEnd } from '../truncate.js';
import { applyKey, initViState, toText, MSG_WRITTEN, type ViState } from '../vi/model.js';

export interface NoteEditorScreenProps {
  /** Text the editor opens with. Read ONCE, on mount; the editor owns it after. */
  initialText: string;
  /** Shown in the title bar, e.g. the secret's key. Truncated to fit. */
  title: string;
  /** Terminal columns to fill (from `useWindowSize`). */
  width: number;
  /** Terminal rows to fill (from `useWindowSize`). */
  height: number;
  /** Whether this editor owns the keyboard. Gate it off when a modal is over it. */
  isActive: boolean;
  /**
   * `:wq` / `:x` — commit the text and close. The parent is expected to store
   * the text and unmount the editor.
   */
  onSave: (text: string) => void;
  /** `:q` on a clean buffer, or `:q!` — close WITHOUT committing. */
  onCancel: () => void;
  /**
   * `:w` — commit the text but stay open. Optional: a parent that only cares
   * about the final result can omit it.
   */
  onWrite?: (text: string) => void;
}

/** Title bar + two rules + status line. */
const CHROME_ROWS = 4;

/**
 * The theme resolves one glyph set for the whole app (Unicode, or ASCII on
 * dumb/non-UTF8 terminals). Piggyback on that decision rather than re-detecting.
 */
const RULE = figures.bullet === '.' ? '-' : '─';

/**
 * First visible row. Stateless on purpose: derived from the cursor row alone, so
 * it stays correct across a terminal resize with no scroll state to go stale.
 * Keeps the cursor centered where the buffer allows (vim's `scrolloff=999`) and
 * clamps to the document so `~` only appears past a genuinely short buffer.
 */
export function viewportTop(row: number, total: number, rows: number): number {
  if (total <= rows) {
    return 0;
  }
  const centered = row - Math.floor((rows - 1) / 2);
  return Math.min(Math.max(0, centered), total - rows);
}

/**
 * Full-screen vi note editor.
 *
 * Contains NO editing logic: every keystroke goes straight to the pure
 * `applyKey` reducer in `../vi/model.js` and this component only draws the
 * result. If an editing rule ever seems to belong here, it belongs in the model.
 *
 * The parent owns the text: it passes `initialText` and gets it back through
 * `onSave` / `onWrite`, so a draft survives opening and closing the editor.
 *
 * Note text is rendered inside the frame and nowhere else — never logged,
 * never written to stdout outside Ink's frame, never put in an Error.
 */
export function NoteEditorScreen({
  initialText,
  title,
  width,
  height,
  isActive,
  onSave,
  onCancel,
  onWrite,
}: NoteEditorScreenProps): React.ReactElement {
  const [state, setState] = useState<ViState>(() => initViState(initialText));
  // Mirror of `state` so the key handler can compute the next state and fire the
  // parent callbacks at EVENT time, never during render.
  const stateRef = useRef<ViState>(state);
  const { isRawModeSupported } = useStdin();

  // Bracketed paste: the terminal then brackets a paste with \x1b[200~ / \x1b[201~
  // so a pasted document arrives as one chunk instead of a key storm. The model
  // strips the markers. Guarded on isTTY so nothing is emitted into a pipe.
  useEffect(() => {
    if (!process.stdout.isTTY) {
      return;
    }
    process.stdout.write('\x1b[?2004h');
    return () => {
      process.stdout.write('\x1b[?2004l');
    };
  }, []);

  useInput(
    (input, key) => {
      const prev = stateRef.current;
      const next = applyKey(prev, input, key);
      if (next === prev) {
        return;
      }
      stateRef.current = next;
      setState(next);

      if (next.exit !== null) {
        if (next.exit.save) {
          onSave(toText(next));
        } else {
          onCancel();
        }
        return;
      }
      // `:w` writes without leaving. The model has no write counter (ViState is
      // frozen), so detect the transition that only `:w` can produce.
      if (prev.mode === 'command' && next.mode === 'normal' && next.message === MSG_WRITTEN) {
        onWrite?.(toText(next));
      }
    },
    { isActive: isActive && isRawModeSupported },
  );

  const bodyRows = Math.max(1, height - CHROME_ROWS);
  const gutterWidth = Math.max(2, String(state.lines.length).length);
  const gutterCols = gutterWidth + 3;
  const textWidth = Math.max(1, width - gutterCols);
  const top = viewportTop(state.row, state.lines.length, bodyRows);

  const rows: React.ReactElement[] = [];
  for (let i = 0; i < bodyRows; i++) {
    const abs = top + i;
    if (abs >= state.lines.length) {
      rows.push(
        <Box key={`eof-${i}`} width={width}>
          <Text color={theme.dim}>{` ${'~'.padStart(gutterWidth)}  `}</Text>
        </Box>,
      );
      continue;
    }
    const line = state.lines[abs] ?? '';
    const isCursorRow = abs === state.row;
    rows.push(
      <Box key={`line-${abs}`} width={width}>
        <Box width={gutterCols} flexShrink={0}>
          <Text color={isCursorRow ? theme.accent : theme.dim}>
            {` ${String(abs + 1).padStart(gutterWidth)}  `}
          </Text>
        </Box>
        <Box width={textWidth} flexShrink={0}>
          {isCursorRow ? (
            <Text color={theme.fg} wrap="truncate-end">
              {line.slice(0, state.col)}
              <Text inverse>{line.slice(state.col, state.col + 1) || ' '}</Text>
              {line.slice(state.col + 1)}
            </Text>
          ) : (
            <Text color={theme.fg} wrap="truncate-end">
              {line === '' ? ' ' : line}
            </Text>
          )}
        </Box>
      </Box>,
    );
  }

  const position = `${state.row + 1},${state.col + 1}`;
  const rightText = `${state.dirty ? '[+]  ' : ''}${position}`;
  const leftBudget = Math.max(1, width - rightText.length - 2);

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        <Text bold color={theme.accent} wrap="truncate-end">
          {truncateEnd(`orbkey ${figures.bullet} note ${figures.bullet} ${title}`, width)}
        </Text>
      </Box>
      <Text color={theme.dim}>{RULE.repeat(Math.max(1, width))}</Text>
      <Box flexDirection="column">{rows}</Box>
      <Text color={theme.dim}>{RULE.repeat(Math.max(1, width))}</Text>
      <Box width={width}>
        <Box width={leftBudget} flexShrink={0}>
          <StatusLeft state={state} budget={leftBudget} />
        </Box>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text color={state.dirty ? theme.warn : theme.dim} wrap="truncate-end">
            {rightText}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Left half of the status line, in priority order: the `:`/`/` prompt while it
 * is being typed, then any message, then the mode banner, then a first-run hint
 * for an empty note. Normal mode on a non-empty note shows nothing, as vi does.
 */
function StatusLeft({ state, budget }: { state: ViState; budget: number }): React.ReactElement {
  if (state.mode === 'command' || state.mode === 'search') {
    const prefix = state.mode === 'command' ? ':' : '/';
    return (
      <Text color={theme.accent} wrap="truncate-end">
        {truncateEnd(prefix + state.cmdline, Math.max(1, budget - 1))}
        <Text inverse> </Text>
      </Text>
    );
  }
  if (state.message !== '') {
    // vi error codes (E37, E486, E492) read as errors; anything else is neutral.
    const isError = /^E\d+:/.test(state.message);
    return (
      <Text color={isError ? theme.error : theme.success} wrap="truncate-end">
        {truncateEnd(state.message, budget)}
      </Text>
    );
  }
  if (state.mode === 'insert') {
    return (
      <Text bold color={theme.accent} wrap="truncate-end">
        -- INSERT --
      </Text>
    );
  }
  const isEmpty = state.lines.length === 1 && state.lines[0] === '';
  return (
    <Text color={theme.dim} wrap="truncate-end">
      {truncateEnd(isEmpty ? 'empty note — i insert, :wq save, :q! discard' : '', budget)}
    </Text>
  );
}
