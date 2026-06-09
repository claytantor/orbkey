import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface Hint {
  keys: string;
  label: string;
}

/** Per-screen keybinding footer. */
export function HintBar({ hints }: { hints: Hint[] }): React.ReactElement {
  return (
    <Box gap={2} marginTop={1}>
      {hints.map((h) => (
        <Box key={h.keys} gap={1}>
          <Text bold color={theme.accent}>
            {h.keys}
          </Text>
          <Text dimColor>{h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
