import React from 'react';
import { Box, Text } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { theme } from '../theme.js';

const COMMANDS: [string, string][] = [
  ['/import [path]', 'Import secrets from a KeePass XML export'],
  ['/add', 'Add a secret (key, value, labels, note)'],
  ['/get [key]', 'Reveal the selected/named secret; copy to clipboard'],
  ['/edit [key]', 'Edit the selected/named secret'],
  ['/rm [key]', 'Delete the selected/named secret (confirms first)'],
  ['/search <term>', 'FTS5 search (also: just type to filter live)'],
  ['/label', 'Edit labels on the selected secret'],
  ['/note', 'Edit the note on the selected secret'],
  ['/sync', 'Push/pull now (runs the sync state machine)'],
  ['/lock', 'Zeroize keys and require the password again'],
  ['/clipinfo', 'Report which clipboard backends are available'],
  ['/rotate', 'Rotate the password or the cached IAM key'],
  ['/exit', 'Final checkpoint, sync if dirty, then quit'],
  ['/help', 'This overlay'],
];

/** Command reference overlay. */
export function HelpScreen(): React.ReactElement {
  return (
    <ModalFrame
      title="orbkey commands"
      width={72}
      hints={[{ keys: 'Esc', label: 'close' }]}
    >
      <Box flexDirection="column">
        {COMMANDS.map(([cmd, desc]) => (
          <Box key={cmd}>
            <Box width={18}>
              <Text color={theme.accent}>{cmd}</Text>
            </Box>
            <Text dimColor>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>keys</Text>
          <Text dimColor>
            {'  Ctrl+R reveal/hide · Ctrl+Q exit · Esc close modal'}
          </Text>
        </Text>
        <Text>
          <Text bold>edit modal</Text>
          <Text dimColor>{'  Ctrl+O copy note · Ctrl+P paste into note'}</Text>
        </Text>
        <Text dimColor>
          Copy needs a clipboard backend (Wayland: wl-clipboard; X11: xclip).
        </Text>
      </Box>
    </ModalFrame>
  );
}
