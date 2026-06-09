import React from 'react';
import { Box, Text } from 'ink';
import { TextField } from './TextField.js';
import { theme } from '../theme.js';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focused: boolean;
  password?: boolean;
  placeholder?: string;
}

/** A single labelled text field; masks input when `password`. */
export function Field({
  label,
  value,
  onChange,
  onSubmit,
  focused,
  password = false,
  placeholder,
}: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} dimColor={!focused}>
        {label}
      </Text>
      <Box>
        <Text color={focused ? theme.accent : theme.muted}>{focused ? '❯ ' : '  '}</Text>
        <TextField
          value={value}
          onChange={onChange}
          {...(onSubmit ? { onSubmit } : {})}
          isActive={focused}
          mask={password ? '•' : undefined}
          placeholder={placeholder ?? ''}
        />
      </Box>
    </Box>
  );
}
