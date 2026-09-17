import React from 'react';
import { Box, Text } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { theme } from '../theme.js';

const COMMANDS: [string, string][] = [
  ['/import [path]', 'Import from a KeePass XML or an orbkey export'],
  ['/export [path]', 'Export the vault to an encrypted orbkey JSON'],
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

// Only the keys the editor actually wires (src/ui/vi/model.ts). Counts, visual
// mode, operator+motion, registers, `.` and redo are NOT implemented, so they
// are deliberately absent here.
const NOTE_EDITOR_KEYS: [string, string][] = [
  ['i a I A o O', 'Enter insert mode; Esc returns to normal'],
  ['h j k l ←↓↑→', 'Move; 0 / $ line start / end; w b by word'],
  ['gg G', 'First / last line'],
  ['x dd yy p P u', 'Delete char / line, yank line, put below / above, undo'],
  ['/text n N', 'Literal search forward, next / previous match'],
  [':w :wq :x', 'Save the draft; :wq and :x also close the editor'],
  [':q :q!', 'Close; :q refuses on unsaved changes, :q! discards them'],
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
          <Text bold>edit form</Text>
          <Text dimColor>
            {'  Tab/Shift+Tab field · Ctrl+O copy note · Enter on note / Ctrl+E edit note · Ctrl+S save'}
          </Text>
        </Text>
        <Text dimColor>
          Copy needs a clipboard backend (Wayland: wl-clipboard; X11: xclip).
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>note editor (vi)</Text>
        {NOTE_EDITOR_KEYS.map(([keys, desc]) => (
          <Box key={keys}>
            <Box width={18}>
              <Text color={theme.accent}>{keys}</Text>
            </Box>
            <Text dimColor>{desc}</Text>
          </Box>
        ))}
      </Box>
    </ModalFrame>
  );
}
