import React from 'react';
import { Text, useInput } from 'ink';
import stringWidth from 'string-width';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  isActive: boolean;
  mask?: string;
  placeholder?: string;
}

/**
 * A single-line controlled text input that — unlike ink-text-input — IGNORES
 * control/meta chords (Ctrl+R, Ctrl+Q, etc.) so global app bindings are never
 * corrupted by stray letters in the field. Cursor is a simple end-anchored caret;
 * left/right move it. `string-width` keeps CJK/emoji widths correct.
 */
export function TextField({
  value,
  onChange,
  onSubmit,
  isActive,
  mask,
  placeholder,
}: Props): React.ReactElement {
  const [cursor, setCursor] = React.useState(value.length);
  // Keep cursor within bounds when value changes externally.
  const col = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      // Never consume control chords — let the global handler act on them.
      if (key.ctrl || key.meta || key.escape || key.tab) {
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, col - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, col + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (col > 0) {
          const next = value.slice(0, col - 1) + value.slice(col);
          onChange(next);
          setCursor(col - 1);
        }
        return;
      }
      if (input.length === 0) {
        return;
      }
      const next = value.slice(0, col) + input + value.slice(col);
      onChange(next);
      setCursor(col + input.length);
    },
    { isActive },
  );

  const shown = mask ? mask.repeat(stringWidth(value)) : value;
  if (!value) {
    return <Text dimColor>{placeholder ?? ''}</Text>;
  }
  if (!isActive) {
    return <Text>{shown}</Text>;
  }
  // Render with an inverse caret at `col`.
  const masked = mask ? mask.repeat(stringWidth(value)) : value;
  const before = masked.slice(0, col);
  const at = masked.slice(col, col + 1) || ' ';
  const after = masked.slice(col + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
