import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { HintBar, type Hint } from './HintBar.js';

interface Props {
  title: string;
  borderColor?: string;
  width?: number;
  error?: string | null;
  hints?: Hint[];
  children: React.ReactNode;
}

/** A centered bordered modal panel. The "swap, don't stack" router renders one. */
export function ModalFrame({
  title,
  borderColor = theme.accent,
  width = 64,
  error,
  hints,
  children,
}: Props): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={borderColor}
        paddingX={2}
        paddingY={1}
        width={width}
      >
        <Text bold color={borderColor}>
          {title}
        </Text>
        {error ? (
          <Box marginTop={1}>
            <Text color={theme.error}>{error}</Text>
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        {hints && hints.length > 0 ? <HintBar hints={hints} /> : null}
      </Box>
    </Box>
  );
}
