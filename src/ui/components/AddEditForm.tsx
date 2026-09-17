import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Field } from './Field.js';
import { TextField } from './TextField.js';
import { useFormFocus } from '../hooks/useFormFocus.js';
import { theme, figures } from '../theme.js';
import type { UiSecret } from '../types.js';

export interface AddEditResult {
  key: string;
  value: string;
  labels: string[];
  note: string;
}

/**
 * Everything App needs to draw the full-screen note editor on this form's
 * behalf. The FORM still owns the note draft: `initialText` is a snapshot of its
 * own `note` state and every callback writes straight back into that state.
 *
 * App renders the editor rather than the form because the form is clipped to the
 * detail pane, and moving the form to App's root to un-clip it would change its
 * position in the React tree — which unmounts it and destroys the draft this
 * indirection exists to protect.
 */
export interface NoteEditorSession {
  /** The draft text the editor opens with. */
  initialText: string;
  /** Title-bar subject, normally the secret's key. */
  title: string;
  /** `:wq` / `:x` — commit and close. */
  onSave: (text: string) => void;
  /** `:w` — commit, stay open. */
  onWrite: (text: string) => void;
  /** `:q` clean / `:q!` — close, keep the pre-open draft. */
  onCancel: () => void;
}

interface Props {
  mode: 'add' | 'edit';
  initial: UiSecret | null;
  isActive: boolean;
  width: number;
  /**
   * Rows the detail pane gives this form. The note preview expands to fill
   * whatever is left after the fixed fields, so a taller terminal shows more
   * of the note instead of a hardcoded three lines.
   */
  height: number;
  onSave: (result: AddEditResult) => void;
  onCopyNote: (note: string) => void;
  /**
   * Open (session) / close (null) the full-screen note editor. Always called
   * from a key handler, i.e. at EVENT time — never during render.
   */
  onNoteEditor: (session: NoteEditorSession | null) => void;
  /** Report the focused field (1-based, 1..4) so the status line can show it. */
  onFieldChange?: (field1Based: number) => void;
}

// Field order: name(0) value(1) labels(2) note(3). Save = Enter on any non-note
// field; Cancel = Esc (handled by the global key router). Four data fields.
const NOTE_INDEX = 3;
export const ADD_EDIT_FIELD_COUNT = 4;


/**
 * Rows this form spends on everything EXCEPT the note preview:
 *
 *   1  title (`edit · key`)          1  blank (labels field margin)
 *   1  blank (fields margin-top)     1  `note` label
 *   1  `name` label                  1  hint row (`+N more · Enter to edit`)
 *   1  name input                    1  blank (cheat-line margin-top)
 *   1  blank (name field margin)     1  cheat line
 *   1  `value` label
 *   1  value input
 *   1  blank (value field margin)
 *   1  `labels` label
 *   1  labels input
 *
 * The preview gets whatever the detail pane has left over.
 */
const FORM_FIXED_ROWS = 15;

/** Never collapse the preview to nothing, even in a very short terminal. */
const NOTE_PREVIEW_MIN_ROWS = 1;

/**
 * How many note lines the read-only preview can show in `paneRows` of space.
 * Pure so the budget is testable without a terminal.
 */
export function notePreviewRows(paneRows: number): number {
  return Math.max(NOTE_PREVIEW_MIN_ROWS, paneRows - FORM_FIXED_ROWS);
}

/**
 * Variant A inline add/edit form — rendered INSIDE the detail pane while the list
 * stays visible on the left. Reuses Field / TextField + useFormFocus. The value
 * field masks by default; Ctrl+R toggles its reveal (parity with the Home reveal
 * chord). Save funnels through `onSave`; the app surfaces the "reseal on save"
 * status string on the existing save path.
 *
 * The note is a READ-ONLY preview here. Editing it happens in the full-screen vi
 * editor (Enter on the note field, or Ctrl+E from anywhere), which owns its own
 * cursor — the defect the old inline TextArea could not fix.
 */
export function AddEditForm({
  mode,
  initial,
  isActive,
  width,
  height,
  onSave,
  onCopyNote,
  onNoteEditor,
  onFieldChange,
}: Props): React.ReactElement {
  const [key, setKey] = useState(initial?.key ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [labels, setLabels] = useState((initial?.labels ?? []).join(', '));
  const [note, setNote] = useState(initial?.note ?? '');
  const [revealValue, setRevealValue] = useState(false);
  // Mirrors App's editor state. While it is true this form must not react to a
  // single keystroke: Ink fans every key out to EVERY active handler, so an
  // ungated form would submit on the Ctrl+S the user typed at the editor.
  const [editorOpen, setEditorOpen] = useState(false);
  const formActive = isActive && !editorOpen;
  const [focus] = useFormFocus(ADD_EDIT_FIELD_COUNT, formActive, 0);

  // Surface the active field (1-based) to the parent for the status line.
  React.useEffect(() => {
    onFieldChange?.(Math.min(focus, NOTE_INDEX) + 1);
  }, [focus, onFieldChange]);

  const submit = (): void => {
    const labelList = labels
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    onSave({ key: key.trim(), value, labels: labelList, note });
  };

  const openNoteEditor = (): void => {
    const subject = key.trim() || initial?.key || (mode === 'edit' ? 'note' : 'new secret');
    setEditorOpen(true);
    onNoteEditor({
      initialText: note,
      title: subject,
      onSave: (text) => {
        setNote(text);
        setEditorOpen(false);
        onNoteEditor(null);
      },
      onWrite: (text) => {
        // `:w` commits into the draft and leaves the editor open.
        setNote(text);
      },
      onCancel: () => {
        setEditorOpen(false);
        onNoteEditor(null);
      },
    });
  };

  useInput(
    (input, k) => {
      // Ctrl+E opens the full-screen note editor from ANY field.
      if (k.ctrl && input === 'e') {
        openNoteEditor();
        return;
      }
      // Ctrl+S is the documented SAVE chord: it works from EVERY field. This
      // handler is always active while the form owns input, so it fires no
      // matter which field is focused.
      if (k.ctrl && input === 's') {
        submit();
        return;
      }
      // Ctrl+R toggles value reveal while editing (value field masks by default).
      if (k.ctrl && input === 'r') {
        setRevealValue((v) => !v);
        return;
      }
      // Ctrl+O copies the note (parity with the prior modal). There is no paste
      // chord any more: the editor handles bracketed paste properly, where the
      // old Ctrl+P appended blindly to the end of the note.
      if (k.ctrl && input === 'o') {
        onCopyNote(note);
        return;
      }
      if (k.return) {
        // On the note field Enter opens the editor; everywhere else it submits.
        if (focus === NOTE_INDEX) {
          openNoteEditor();
          return;
        }
        submit();
      }
    },
    { isActive: formActive },
  );

  if (editorOpen) {
    // App draws <NoteEditorScreen> full-screen while this subtree stays mounted
    // (laid out as display:none) so the note draft — and the key, value and
    // labels the user has already typed — survive the round trip. Rendering no
    // fields also guarantees no TextField can steal a keystroke from the editor.
    return <Box />;
  }

  const inner = Math.max(1, width - 4); // paddingX={2}
  const valueHint = `  (^R ${revealValue ? 'mask' : 'reveal'})`;
  // Always-visible cheat line — truthful to the wired keys. Glyphs route through
  // theme figures (ASCII fallback on dumb/non-UTF8 terminals). Tab/Shift+Tab
  // cycle fields, ^E opens the note editor, ^S saves from ANY field, Esc
  // discards (handled by the global Esc router). ^R is NOT listed here: the
  // detail pane is only ~55 columns and `Esc discard` must not be truncated
  // away, and `(^R reveal)` is already printed beside the value label.
  const b = figures.bullet;
  const cheat =
    `${figures.tab} next ${b} ⇧${figures.tab} prev ${b} ` +
    `^E note ${b} ^S save ${b} Esc discard`;

  const noteFocused = focus === NOTE_INDEX;
  const noteLines = note === '' ? [] : note.split('\n');
  const previewRows = notePreviewRows(height);
  const previewLines = noteLines.slice(0, previewRows);
  const hiddenLines = Math.max(0, noteLines.length - previewRows);

  return (
    <Box width={width} paddingX={2} flexDirection="column">
      <Text bold color={theme.accent} wrap="truncate-end">
        {mode === 'edit' ? `edit ${figures.bullet} ${initial?.key ?? key}` : 'add secret'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field
          label="name"
          value={key}
          onChange={setKey}
          focused={focus === 0}
          placeholder="name/identifier"
        />
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={focus === 1 ? theme.accent : undefined} dimColor={focus !== 1}>
              value
            </Text>
            <Text color={theme.dim}>{valueHint}</Text>
          </Box>
          <Box>
            <Text color={focus === 1 ? theme.accent : theme.muted}>
              {focus === 1 ? `${figures.pointer} ` : '  '}
            </Text>
            <TextField
              value={value}
              onChange={setValue}
              isActive={focus === 1}
              mask={revealValue ? undefined : '•'}
              placeholder="secret value"
            />
          </Box>
        </Box>
        <Field
          label="labels (comma separated)"
          value={labels}
          onChange={setLabels}
          focused={focus === 2}
          placeholder="aws, prod"
        />
        <Box flexDirection="column">
          <Text color={noteFocused ? theme.accent : undefined} dimColor={!noteFocused}>
            note
          </Text>
          {/* Borderless, READ-ONLY preview: the first few lines, truncated to the
              pane. The accent label above + left caret gutter are the focus
              affordance; editing happens in the full-screen vi editor. */}
          <Box width={inner} flexDirection="column">
            {previewLines.length === 0 ? (
              <Box>
                <Text color={noteFocused ? theme.accent : theme.muted}>
                  {noteFocused ? `${figures.pointer} ` : '  '}
                </Text>
                <Text dimColor>(empty)</Text>
              </Box>
            ) : (
              previewLines.map((line, i) => (
                // Index keys are correct here: these are positional slots in a
                // re-derived preview, not identities.
                <Box key={`note-line-${i}`}>
                  <Text color={noteFocused ? theme.accent : theme.muted}>
                    {noteFocused && i === 0 ? `${figures.pointer} ` : '  '}
                  </Text>
                  <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
                </Box>
              ))
            )}
            {/* One row for both hints: the detail pane's height budget is tight
                and the cheat line below must stay visible. */}
            <Text color={theme.dim} wrap="truncate-end">
              {hiddenLines > 0
                ? `  +${hiddenLines} more lines ${figures.bullet} Enter to edit note`
                : '  Enter to edit note'}
            </Text>
          </Box>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim} wrap="truncate-end">
          {cheat}
        </Text>
      </Box>
    </Box>
  );
}
