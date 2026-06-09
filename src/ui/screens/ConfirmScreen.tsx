import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { theme } from '../theme.js';

interface Props {
  message: string;
  isActive: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive confirmation. Requires an explicit chord: `y` confirms, `n`/Esc
 * cancels (Esc handled by the global handler). Mirrors the Python Delete/Cancel
 * modal but keyboard-native.
 */
export function ConfirmScreen({
  message,
  isActive,
  onConfirm,
  onCancel,
}: Props): React.ReactElement {
  useInput(
    (input) => {
      const c = input.toLowerCase();
      if (c === 'y') {
        onConfirm();
      } else if (c === 'n') {
        onCancel();
      }
    },
    { isActive },
  );

  return (
    <ModalFrame
      title="Confirm"
      borderColor={theme.error}
      hints={[
        { keys: 'y', label: 'delete' },
        { keys: 'n / Esc', label: 'cancel' },
      ]}
    >
      <Box>
        <Text>{message}</Text>
      </Box>
    </ModalFrame>
  );
}
