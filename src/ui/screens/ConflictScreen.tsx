import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { theme, figures } from '../theme.js';
import type { ConflictChoice } from '../types.js';

interface Props {
  isActive: boolean;
  busy: boolean;
  onChoose: (choice: ConflictChoice) => void;
}

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: 'keep_local', label: 'Keep local (overwrite remote)' },
  { value: 'keep_remote', label: 'Keep remote (discard local changes)' },
  { value: 'save_then_pull', label: 'Save a local copy, then pull remote' },
];

/** Sync conflict resolution: three explicit choices, no auto-merge. */
export function ConflictScreen({ isActive, busy, onChoose }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput(
    (_input, key) => {
      if (busy) {
        return;
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(CHOICES.length - 1, i + 1));
      } else if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (key.return) {
        const choice = CHOICES[index];
        if (choice) {
          onChoose(choice.value);
        }
      }
    },
    { isActive },
  );

  return (
    <ModalFrame
      title="Sync conflict"
      borderColor={theme.warn}
      width={72}
      hints={[
        { keys: '↑/↓', label: 'choose' },
        { keys: 'Enter', label: 'apply' },
      ]}
    >
      <Box marginBottom={1}>
        <Text>
          The remote vault changed on another device while you had local changes.
          Choose how to resolve:
        </Text>
      </Box>
      {CHOICES.map((c, i) => {
        const active = i === index;
        return (
          <Box key={c.value}>
            <Text color={active ? theme.accent : undefined} bold={active}>
              {active ? figures.pointer : ' '} {c.label}
            </Text>
          </Box>
        );
      })}
      {busy ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>resolving…</Text>
        </Box>
      ) : null}
    </ModalFrame>
  );
}
