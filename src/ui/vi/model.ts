/**
 * Pure vi state machine for the full-screen note editor.
 *
 * NO React, NO Ink, NO I/O. `applyKey` is a plain function: same inputs, same
 * output, and it never mutates the state it is handed. Every vi semantic lives
 * here so that ~40 commands can be verified exhaustively as function calls
 * instead of through a terminal harness (see `test/ui/vi-model.test.ts`).
 *
 * The defect this replaces (`src/ui/components/TextArea.tsx`) derived the cursor
 * from the text on every render, so the cursor snapped to end-of-buffer. Here the
 * cursor is OWNED state: `row`/`col` are inputs to every transition, never
 * recomputed from `lines`.
 *
 * Note text is data. Nothing in this module logs, prints, or throws with it.
 */

export type ViMode = 'normal' | 'insert' | 'command' | 'search';

export interface ViState {
  /** Never empty; `['']` represents an empty note. */
  lines: string[];
  /** 0-based, always in range. */
  row: number;
  /** 0-based. In normal mode may equal `line.length` only on an empty line. */
  col: number;
  mode: ViMode;
  /** Partial normal-mode command: 'd', 'g', 'y', '"'. */
  pending: string;
  /** NOT used in v1; reserved, always null. */
  count: number | null;
  register: { text: string; linewise: boolean };
  undo: Array<{ lines: string[]; row: number; col: number }>;
  /** Buffer for ':' and '/' entry (excludes the leader). */
  cmdline: string;
  lastSearch: string;
  /** The bottom-line message, e.g. an E37 error. */
  message: string;
  dirty: boolean;
  /** null while editing; set when the user asked to leave. */
  exit: null | { save: boolean };
}

/** The subset of Ink's `Key` this model depends on. */
export interface ViKey {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
}

// ---------------------------------------------------------------------------
// Messages (exported so the screen and the tests share one source of truth).
// ---------------------------------------------------------------------------

export const MSG_NO_UNDO = 'Already at oldest change';
export const MSG_E37 = 'E37: No write since last change (add ! to override)';
export const MSG_WRITTEN = 'note written';

export function msgPatternNotFound(pattern: string): string {
  return `E486: Pattern not found: ${pattern}`;
}

export function msgNotAnEditorCommand(cmd: string): string {
  return `E492: Not an editor command: ${cmd}`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function initViState(text: string): ViState {
  const lines = text.split('\n');
  return {
    lines: lines.length > 0 ? lines : [''],
    row: 0,
    col: 0,
    mode: 'normal',
    pending: '',
    count: null,
    register: { text: '', linewise: false },
    undo: [],
    cmdline: '',
    lastSearch: '',
    message: '',
    dirty: false,
    exit: null,
  };
}

export function toText(s: ViState): string {
  return s.lines.join('\n');
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Bracketed-paste markers, with the leading ESC optional.
 *
 * Ink strips a single leading ESC from every chunk before calling `useInput`
 * (`node_modules/ink/build/hooks/use-input.js`), so a paste arrives as
 * `[200~...<ESC>[201~` — the opening marker has lost its ESC and the closing one
 * has not. Matching both shapes is what makes paste survive Ink.
 */
const PASTE_MARKER_G = /\x1b?\[20[01]~/g;
const PASTE_MARKER = /\x1b?\[20[01]~/;

function hasPasteMarker(text: string): boolean {
  return PASTE_MARKER.test(text);
}

function stripPasteMarkers(text: string): string {
  return text.replace(PASTE_MARKER_G, '');
}

/** CRLF and bare CR both become LF, so a pasted document never leaves stray CRs. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function lineAt(lines: readonly string[], row: number): string {
  return lines[row] ?? '';
}

function clampCol(mode: ViMode, line: string, col: number): number {
  const max = mode === 'insert' ? line.length : Math.max(0, line.length - 1);
  return Math.min(Math.max(0, col), max);
}

/** Shallow next-state with `message` cleared by default; `patch` wins. */
function commit(s: ViState, patch: Partial<ViState>): ViState {
  return { ...s, message: '', ...patch };
}

/** Clamp row into the buffer and col into the current line for the current mode. */
function normalize(s: ViState): ViState {
  const row = Math.min(Math.max(0, s.row), s.lines.length - 1);
  const col = clampCol(s.mode, lineAt(s.lines, row), s.col);
  if (row === s.row && col === s.col) {
    return s;
  }
  return { ...s, row, col };
}

function pushUndo(s: ViState): ViState['undo'] {
  return [...s.undo, { lines: [...s.lines], row: s.row, col: s.col }];
}

function firstNonBlank(line: string): number {
  const idx = line.search(/\S/);
  return idx === -1 ? 0 : idx;
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

// --- flat-offset helpers, used by the word motions -------------------------

function toOffset(lines: readonly string[], row: number, col: number): number {
  let off = 0;
  for (let i = 0; i < row; i++) {
    off += lineAt(lines, i).length + 1;
  }
  return off + col;
}

function fromOffset(lines: readonly string[], off: number): { row: number; col: number } {
  let rem = Math.max(0, off);
  for (let i = 0; i < lines.length; i++) {
    const len = lineAt(lines, i).length;
    if (rem <= len) {
      return { row: i, col: Math.min(rem, len) };
    }
    rem -= len + 1;
  }
  const last = Math.max(0, lines.length - 1);
  return { row: last, col: lineAt(lines, last).length };
}

/**
 * `w`: start of the next word, crossing line boundaries. Word = run of
 * non-whitespace (the newline between lines counts as whitespace). Running off
 * the end parks on the last position of the buffer, as vi does.
 */
function wordForward(
  lines: readonly string[],
  row: number,
  col: number,
): { row: number; col: number } {
  const flat = lines.join('\n');
  const n = flat.length;
  let i = toOffset(lines, row, col);
  if (i < n && !isSpace(flat[i])) {
    while (i < n && !isSpace(flat[i])) {
      i++;
    }
  }
  while (i < n && isSpace(flat[i])) {
    i++;
  }
  if (i >= n) {
    const last = Math.max(0, lines.length - 1);
    return { row: last, col: Math.max(0, lineAt(lines, last).length - 1) };
  }
  return fromOffset(lines, i);
}

/** `b`: start of the previous word, crossing line boundaries. */
function wordBackward(
  lines: readonly string[],
  row: number,
  col: number,
): { row: number; col: number } {
  const flat = lines.join('\n');
  let i = toOffset(lines, row, col) - 1;
  while (i >= 0 && isSpace(flat[i])) {
    i--;
  }
  if (i < 0) {
    return { row: 0, col: 0 };
  }
  while (i > 0 && !isSpace(flat[i - 1])) {
    i--;
  }
  return fromOffset(lines, i);
}

// --- literal (NOT regex) search -------------------------------------------

function searchForward(
  lines: readonly string[],
  row: number,
  col: number,
  pattern: string,
): { row: number; col: number } | null {
  if (pattern === '') {
    return null;
  }
  const n = lines.length;
  const here = lineAt(lines, row).indexOf(pattern, Math.max(0, col));
  if (here !== -1) {
    return { row, col: here };
  }
  for (let i = 1; i <= n; i++) {
    const r = (row + i) % n;
    const idx = lineAt(lines, r).indexOf(pattern, 0);
    if (idx !== -1) {
      return { row: r, col: idx };
    }
  }
  return null;
}

function searchBackward(
  lines: readonly string[],
  row: number,
  col: number,
  pattern: string,
): { row: number; col: number } | null {
  if (pattern === '') {
    return null;
  }
  const n = lines.length;
  if (col > 0) {
    const here = lineAt(lines, row).lastIndexOf(pattern, col - 1);
    if (here !== -1) {
      return { row, col: here };
    }
  }
  for (let i = 1; i <= n; i++) {
    const r = ((row - i) % n + n) % n;
    const idx = lineAt(lines, r).lastIndexOf(pattern);
    if (idx !== -1) {
      return { row: r, col: idx };
    }
  }
  return null;
}

// --- text mutation ---------------------------------------------------------

/**
 * Insert literal text at the cursor. Handles embedded newlines, so this is the
 * single path for typed characters, Enter, and pasted chunks alike. Does NOT
 * push an undo snapshot — callers decide (insert sessions snapshot once on
 * entry; a paste snapshots itself).
 */
function insertText(s: ViState, raw: string): ViState {
  const text = normalizeNewlines(raw);
  if (text === '') {
    return s;
  }
  const lines = [...s.lines];
  const cur = lineAt(lines, s.row);
  const col = Math.min(Math.max(0, s.col), cur.length);
  const before = cur.slice(0, col);
  const after = cur.slice(col);
  const parts = text.split('\n');
  if (parts.length === 1) {
    lines[s.row] = before + text + after;
    return commit(s, { lines, col: col + text.length, dirty: true });
  }
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  const middle = parts.slice(1, -1);
  lines.splice(s.row, 1, before + first, ...middle, last + after);
  return commit(s, {
    lines,
    row: s.row + parts.length - 1,
    col: last.length,
    dirty: true,
  });
}

// ---------------------------------------------------------------------------
// applyKey
// ---------------------------------------------------------------------------

/**
 * Apply one keystroke. Pure: `s` is never mutated.
 *
 * `input`/`key` are shaped exactly as Ink's `useInput` delivers them, so the
 * screen component does no translation of its own.
 */
export function applyKey(s: ViState, rawInput: string, key: ViKey): ViState {
  // Once the user has asked to leave, the buffer is frozen until the host
  // unmounts us. Keeps a late keystroke from mutating text we already handed up.
  if (s.exit !== null) {
    return s;
  }

  const bracketed = hasPasteMarker(rawInput);
  const input = bracketed ? stripPasteMarkers(rawInput) : rawInput;
  if (bracketed && input === '') {
    // A marker-only chunk (the terminal opening or closing a paste). Nothing to do.
    return s;
  }

  // Bracketed chunks are paste BY DEFINITION — the terminal said so, so they are
  // text even when only one character survives stripping. Unbracketed chunks fall
  // back to the length heuristic: >1 char with no modifier is a paste.
  const isPaste = bracketed || (!key.ctrl && !key.meta && input.length > 1);
  if (isPaste) {
    return applyPaste(s, input);
  }

  // Esc first: Ink reports Escape with `meta: true`, so it must be handled
  // before the modifier guard below or it would be swallowed.
  if (key.escape) {
    return normalize(commit(s, { mode: 'normal', pending: '', cmdline: '' }));
  }

  // No chord is bound inside the editor in v1; ignore rather than mis-handle.
  if (key.ctrl || key.meta) {
    return s;
  }

  switch (s.mode) {
    case 'normal':
      return applyNormal(s, input, key);
    case 'insert':
      return applyInsert(s, input, key);
    case 'command':
      return applyCommand(s, input, key);
    case 'search':
      return applySearch(s, input, key);
    default: {
      const never: never = s.mode;
      return never;
    }
  }
}

/**
 * A pasted chunk is literal text and ONE undo step. In normal mode it is
 * inserted rather than executed — the one deliberate deviation from real vi,
 * which would run the characters as commands and shred the note.
 */
function applyPaste(s: ViState, text: string): ViState {
  if (s.mode === 'command' || s.mode === 'search') {
    // A pasted pattern / ex command: one line only.
    const flat = normalizeNewlines(text).split('\n').join('');
    return commit(s, { cmdline: s.cmdline + flat });
  }
  const undo = pushUndo(s);
  const inserted = insertText(s, text);
  // Mode is preserved: normal stays normal, insert stays insert.
  return normalize(commit(inserted, { undo, pending: '' }));
}

// ---------------------------------------------------------------------------
// normal mode
// ---------------------------------------------------------------------------

function moveTo(s: ViState, row: number, col: number): ViState {
  return normalize(commit(s, { row, col, pending: '' }));
}

function applyNormal(s: ViState, input: string, key: ViKey): ViState {
  const cur = lineAt(s.lines, s.row);

  // Complete a pending operator, or reject it silently. Counts (`3dd`), visual
  // mode, operator+motion (`dw`) and registers (`"ayy`) are not in v1: they
  // consume the key and do nothing rather than half-executing.
  if (s.pending !== '') {
    if (s.pending === 'd' && input === 'd') {
      return deleteLine(s);
    }
    if (s.pending === 'y' && input === 'y') {
      return yankLine(s);
    }
    if (s.pending === 'g' && input === 'g') {
      return moveTo(s, 0, 0);
    }
    return commit(s, { pending: '' });
  }

  if (key.upArrow) {
    return moveTo(s, s.row - 1, s.col);
  }
  if (key.downArrow) {
    return moveTo(s, s.row + 1, s.col);
  }
  if (key.leftArrow) {
    return moveTo(s, s.row, s.col - 1);
  }
  if (key.rightArrow) {
    return moveTo(s, s.row, s.col + 1);
  }
  // Enter / Tab / Backspace / Delete are not bound in normal mode.
  if (key.return || key.tab || key.backspace || key.delete) {
    return commit(s, { pending: '' });
  }

  switch (input) {
    // --- motion ---
    case 'h':
      return moveTo(s, s.row, s.col - 1);
    case 'l':
      return moveTo(s, s.row, s.col + 1);
    case 'j':
      return moveTo(s, s.row + 1, s.col);
    case 'k':
      return moveTo(s, s.row - 1, s.col);
    case '0':
      return moveTo(s, s.row, 0);
    case '$':
      return moveTo(s, s.row, Math.max(0, cur.length - 1));
    case 'w': {
      const p = wordForward(s.lines, s.row, s.col);
      return moveTo(s, p.row, p.col);
    }
    case 'b': {
      const p = wordBackward(s.lines, s.row, s.col);
      return moveTo(s, p.row, p.col);
    }
    case 'g':
      return commit(s, { pending: 'g' });
    case 'G':
      return moveTo(s, s.lines.length - 1, 0);

    // --- insert ---
    case 'i':
      return enterInsert(s, s.col);
    case 'a':
      return enterInsert(s, Math.min(cur.length, s.col + 1));
    case 'I':
      return enterInsert(s, firstNonBlank(cur));
    case 'A':
      return enterInsert(s, cur.length);
    case 'o':
      return openLine(s, 1);
    case 'O':
      return openLine(s, 0);

    // --- edit ---
    case 'x':
      return deleteChar(s);
    case 'd':
      return commit(s, { pending: 'd' });
    case 'y':
      return commit(s, { pending: 'y' });
    case 'p':
      return put(s, true);
    case 'P':
      return put(s, false);
    case 'u':
      return undoOnce(s);

    // --- registers are not in v1: swallow the register name and its command ---
    case '"':
      return commit(s, { pending: '"' });

    // --- ex / search ---
    case ':':
      return commit(s, { mode: 'command', cmdline: '' });
    case '/':
      return commit(s, { mode: 'search', cmdline: '' });
    case 'n':
      return repeatSearch(s, true);
    case 'N':
      return repeatSearch(s, false);

    default:
      // Everything else (counts, unbound keys) is rejected silently.
      return commit(s, { pending: '' });
  }
}

/** One undo snapshot per insert SESSION, pushed here on entry. */
function enterInsert(s: ViState, col: number): ViState {
  return normalize(commit(s, { mode: 'insert', col, pending: '', undo: pushUndo(s) }));
}

/** `o` (delta 1) / `O` (delta 0): open an empty line and enter insert there. */
function openLine(s: ViState, delta: 0 | 1): ViState {
  const undo = pushUndo(s);
  const lines = [...s.lines];
  const at = s.row + delta;
  lines.splice(at, 0, '');
  return normalize(
    commit(s, { lines, row: at, col: 0, mode: 'insert', dirty: true, pending: '', undo }),
  );
}

/** `x`: no-op on an empty line; otherwise delete under the cursor and clamp. */
function deleteChar(s: ViState): ViState {
  const cur = lineAt(s.lines, s.row);
  if (cur.length === 0) {
    return commit(s, { pending: '' });
  }
  const undo = pushUndo(s);
  const col = Math.min(s.col, cur.length - 1);
  const lines = [...s.lines];
  const next = cur.slice(0, col) + cur.slice(col + 1);
  lines[s.row] = next;
  return commit(s, {
    lines,
    col: Math.min(col, Math.max(0, next.length - 1)),
    dirty: true,
    pending: '',
    undo,
  });
}

/** `dd`: linewise delete + yank. The last remaining line leaves `['']`, not `[]`. */
function deleteLine(s: ViState): ViState {
  const undo = pushUndo(s);
  const removed = lineAt(s.lines, s.row);
  const lines = [...s.lines];
  lines.splice(s.row, 1);
  if (lines.length === 0) {
    lines.push('');
  }
  return normalize(
    commit(s, {
      lines,
      row: Math.min(s.row, lines.length - 1),
      col: 0,
      dirty: true,
      pending: '',
      undo,
      register: { text: removed, linewise: true },
    }),
  );
}

/** `yy`: linewise yank. Non-mutating, so no undo snapshot and no dirty flag. */
function yankLine(s: ViState): ViState {
  return commit(s, {
    pending: '',
    register: { text: lineAt(s.lines, s.row), linewise: true },
  });
}

/**
 * `p` (after) / `P` (before). A linewise register opens a NEW line below/above.
 * An empty register is a no-op. The charwise branch is unreachable in v1 (only
 * `dd`/`yy` fill the register, both linewise) but the flag is honored.
 */
function put(s: ViState, after: boolean): ViState {
  const reg = s.register;
  if (reg.text === '') {
    return commit(s, { pending: '' });
  }
  const undo = pushUndo(s);
  if (reg.linewise) {
    const regLines = reg.text.split('\n');
    const lines = [...s.lines];
    const at = after ? s.row + 1 : s.row;
    lines.splice(at, 0, ...regLines);
    return normalize(commit(s, { lines, row: at, col: 0, dirty: true, pending: '', undo }));
  }
  const cur = lineAt(s.lines, s.row);
  const col = after ? Math.min(cur.length, s.col + 1) : Math.min(s.col, cur.length);
  const lines = [...s.lines];
  lines[s.row] = cur.slice(0, col) + reg.text + cur.slice(col);
  return normalize(
    commit(s, { lines, col: col + reg.text.length - 1, dirty: true, pending: '', undo }),
  );
}

/**
 * `u`: pop one snapshot. An empty stack sets the message and changes nothing
 * else. `dirty` is intentionally left set — an undo is itself a change, and the
 * model has no saved-baseline to compare against.
 */
function undoOnce(s: ViState): ViState {
  const snap = s.undo[s.undo.length - 1];
  if (s.undo.length === 0 || snap === undefined) {
    return { ...s, pending: '', message: MSG_NO_UNDO };
  }
  return normalize(
    commit(s, {
      lines: [...snap.lines],
      row: snap.row,
      col: snap.col,
      mode: 'normal',
      pending: '',
      undo: s.undo.slice(0, -1),
    }),
  );
}

// ---------------------------------------------------------------------------
// insert mode
// ---------------------------------------------------------------------------

function applyInsert(s: ViState, input: string, key: ViKey): ViState {
  if (key.return) {
    return insertText(s, '\n');
  }
  if (key.backspace || key.delete) {
    return backspace(s);
  }
  if (key.upArrow) {
    return moveTo(s, s.row - 1, s.col);
  }
  if (key.downArrow) {
    return moveTo(s, s.row + 1, s.col);
  }
  if (key.leftArrow) {
    return moveTo(s, s.row, s.col - 1);
  }
  if (key.rightArrow) {
    return moveTo(s, s.row, s.col + 1);
  }
  if (key.tab || input === '') {
    // Tab is not bound in v1 (it is the form's navigation key upstream).
    return s;
  }
  return insertText(s, input);
}

/** Backspace joins lines at column 0. Ink reports DEL as `key.delete`. */
function backspace(s: ViState): ViState {
  const cur = lineAt(s.lines, s.row);
  const col = Math.min(Math.max(0, s.col), cur.length);
  if (col > 0) {
    const lines = [...s.lines];
    lines[s.row] = cur.slice(0, col - 1) + cur.slice(col);
    return commit(s, { lines, col: col - 1, dirty: true });
  }
  if (s.row === 0) {
    return commit(s, {});
  }
  const prev = lineAt(s.lines, s.row - 1);
  const lines = [...s.lines];
  lines.splice(s.row - 1, 2, prev + cur);
  return commit(s, { lines, row: s.row - 1, col: prev.length, dirty: true });
}

// ---------------------------------------------------------------------------
// command (':') mode
// ---------------------------------------------------------------------------

function applyCommand(s: ViState, input: string, key: ViKey): ViState {
  if (key.return) {
    return execEx(s, s.cmdline.trim());
  }
  if (key.backspace || key.delete) {
    if (s.cmdline === '') {
      return normalize(commit(s, { mode: 'normal', cmdline: '' }));
    }
    return commit(s, { cmdline: s.cmdline.slice(0, -1) });
  }
  if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
    return s;
  }
  if (input === '') {
    return s;
  }
  return commit(s, { cmdline: s.cmdline + input });
}

function execEx(s: ViState, cmd: string): ViState {
  const base = normalize(commit(s, { mode: 'normal', cmdline: '', pending: '' }));
  switch (cmd) {
    case '':
      return base;
    case 'w':
      return { ...base, dirty: false, message: MSG_WRITTEN };
    case 'wq':
    case 'x':
      return { ...base, dirty: false, exit: { save: true } };
    case 'q':
      return s.dirty ? { ...base, message: MSG_E37 } : { ...base, exit: { save: false } };
    case 'q!':
      return { ...base, exit: { save: false } };
    default:
      return { ...base, message: msgNotAnEditorCommand(cmd) };
  }
}

// ---------------------------------------------------------------------------
// search ('/') mode
// ---------------------------------------------------------------------------

function applySearch(s: ViState, input: string, key: ViKey): ViState {
  if (key.return) {
    const pattern = s.cmdline === '' ? s.lastSearch : s.cmdline;
    if (pattern === '') {
      return normalize(commit(s, { mode: 'normal', cmdline: '' }));
    }
    return runSearch(s, pattern, true);
  }
  if (key.backspace || key.delete) {
    if (s.cmdline === '') {
      return normalize(commit(s, { mode: 'normal', cmdline: '' }));
    }
    return commit(s, { cmdline: s.cmdline.slice(0, -1) });
  }
  if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
    return s;
  }
  if (input === '') {
    return s;
  }
  return commit(s, { cmdline: s.cmdline + input });
}

/** Literal (NOT regex) search from the cursor, wrapping around the buffer. */
function runSearch(s: ViState, pattern: string, forward: boolean): ViState {
  const hit = forward
    ? searchForward(s.lines, s.row, s.col + 1, pattern)
    : searchBackward(s.lines, s.row, s.col, pattern);
  if (hit === null) {
    return {
      ...s,
      mode: 'normal',
      cmdline: '',
      pending: '',
      lastSearch: pattern,
      message: msgPatternNotFound(pattern),
    };
  }
  return normalize({
    ...s,
    mode: 'normal',
    cmdline: '',
    pending: '',
    lastSearch: pattern,
    message: '',
    row: hit.row,
    col: hit.col,
  });
}

/** `n` / `N`. With no previous search this is a silent no-op. */
function repeatSearch(s: ViState, forward: boolean): ViState {
  if (s.lastSearch === '') {
    return commit(s, { pending: '' });
  }
  return runSearch(s, s.lastSearch, forward);
}
