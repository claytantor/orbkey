import React from 'react';
import { Box, Text } from 'ink';
import { TextField } from './TextField.js';
import { theme, figures } from '../theme.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isActive: boolean;
  /** Prompt glyph: `:` in command mode, the `❯` caret otherwise. */
  glyph?: string;
}

/**
 * Bottom command/input bar. Bare typing live-filters; `:` opens command mode;
 * Ctrl+Space opens the which-key leader grid (both wired in app.tsx). The prompt
 * glyph reflects the active mode.
 */
export function CommandBar({
  value,
  onChange,
  onSubmit,
  isActive,
  glyph,
}: Props): React.ReactElement {
  const prompt = glyph ?? figures.pointer;
  const placeholder =
    glyph === ':'
      ? 'command — ⇥ complete · ↵ run'
      : 'type to filter · ↵ edit · Ctrl+Space for actions · : for commands';
  return (
    <Box paddingX={1}>
      <Text color={theme.accent}>{`${prompt} `}</Text>
      {isActive ? (
        <TextField
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          isActive={isActive}
          placeholder={placeholder}
        />
      ) : (
        <Text dimColor>{placeholder}</Text>
      )}
    </Box>
  );
}
