import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Field } from './Field.js';
import { TextField } from './TextField.js';
import { TextArea } from './TextArea.js';
import { useFormFocus } from '../hooks/useFormFocus.js';
import { theme, figures } from '../theme.js';
import type { UiSecret } from '../types.js';

export interface AddEditResult {
  key: string;
  value: string;
  labels: string[];
  note: string;
}

interface Props {
  mode: 'add' | 'edit';
  initial: UiSecret | null;
  isActive: boolean;
  width: number;
  onSave: (result: AddEditResult) => void;
  onCopyNote: (note: string) => void;
  onPasteNote: () => string | null;
  /** Report the focused field (1-based, 1..4) so the status line can show it. */
  onFieldChange?: (field1Based: number) => void;
}

// Field order: name(0) value(1) labels(2) note(3). Save = Enter on any non-note
// field; Cancel = Esc (handled by the global key router). Four data fields.
const NOTE_INDEX = 3;
export const ADD_EDIT_FIELD_COUNT = 4;

/**
 * Variant A inline add/edit form — rendered INSIDE the detail pane while the list
 * stays visible on the left. Reuses Field / TextField / TextArea + useFormFocus.
 * The value field masks by default; Ctrl+R toggles its reveal (parity with the
 * Home reveal chord). Save funnels through `onSave`; the app surfaces the
 * "reseal on save" status string on the existing save path.
 */
export function AddEditForm({
  mode,
  initial,
  isActive,
  width,
  onSave,
  onCopyNote,
  onPasteNote,
  onFieldChange,
}: Props): React.ReactElement {
  const [key, setKey] = useState(initial?.key ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [labels, setLabels] = useState((initial?.labels ?? []).join(', '));
  const [note, setNote] = useState(initial?.note ?? '');
  const [revealValue, setRevealValue] = useState(false);
  const [focus] = useFormFocus(ADD_EDIT_FIELD_COUNT, isActive, 0);

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

  useInput(
    (input, k) => {
      // Ctrl+S is the documented SAVE chord: it works from EVERY field including
      // the note (where Enter inserts a newline, so Enter can't save). This
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
      // Ctrl+O / Ctrl+P copy/paste the note (parity with the prior modal).
      if (k.ctrl && input === 'o') {
        onCopyNote(note);
        return;
      }
      if (k.ctrl && input === 'p') {
        const pasted = onPasteNote();
        if (pasted !== null) {
          setNote((n) => (n ? `${n}${pasted}` : pasted));
        }
        return;
      }
      // Enter outside the note submits too (convenience). Inside the note Enter
      // inserts a newline, so Ctrl+S is the only save path from the note.
      if (k.return && focus !== NOTE_INDEX) {
        submit();
      }
    },
    { isActive },
  );

  const inner = Math.max(1, width - 4); // paddingX={2}
  const valueHint = `  (^R ${revealValue ? 'mask' : 'reveal'})`;
  // Always-visible cheat line — truthful to the wired keys. Glyphs route through
  // theme figures (ASCII fallback on dumb/non-UTF8 terminals). Tab/Shift+Tab
  // cycle fields, ^R toggles value reveal, ^S saves from ANY field (incl. note),
  // Esc discards (handled by the global Esc router — closes without persisting).
  const b = figures.bullet;
  const cheat = `${figures.tab} next ${b} ⇧${figures.tab} prev ${b} ^R reveal ${b} ^S save ${b} Esc discard`;

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
          <Text color={focus === NOTE_INDEX ? theme.accent : undefined} dimColor={focus !== NOTE_INDEX}>
            note
          </Text>
          {/* Borderless: free-form note that soft-wraps to the pane width. The
              accent label above + left caret gutter are the focus affordance. */}
          <Box width={inner}>
            <TextArea
              value={note}
              onChange={setNote}
              focused={focus === NOTE_INDEX}
              rows={3}
              bordered={false}
            />
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
