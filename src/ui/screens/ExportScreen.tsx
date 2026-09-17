import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { Field } from '../components/Field.js';
import { useFormFocus } from '../hooks/useFormFocus.js';
import { theme, figures } from '../theme.js';

interface Props {
  defaultPath: string;
  isActive: boolean;
  /** Error from the last failed export attempt (raised by the port, classified). */
  error: string | null;
  /** Called ONLY after local validation passes. Never called with an empty pass. */
  onExport: (path: string, passphrase: string) => void;
  onCancel: () => void;
}

const PATH = 0;
const PASS = 1;
const CONFIRM = 2;
const SUBMIT = 3;
const FIELD_COUNT = 4;

/**
 * `:export` — write the vault to an orbkey-native export file.
 *
 * Three fields (destination path, passphrase, confirm passphrase) plus a submit
 * button, navigated with Tab / arrows exactly like the rotate-password screen.
 *
 * Security:
 *   - BOTH passphrase fields are masked (`Field password`), so the typed
 *     passphrase never reaches the rendered frame — only mask dots do.
 *   - Validation failures render as an inline message; the passphrase is never
 *     echoed back in an error, a status line, or a log.
 *   - The copy explicitly states that the file's secret values are encrypted
 *     under THIS passphrase and that the passphrase is not recoverable, because
 *     an export is the one artifact that leaves the vault's custody.
 */
export function ExportScreen({
  defaultPath,
  isActive,
  error,
  onExport,
}: Props): React.ReactElement {
  const [path, setPath] = useState(defaultPath);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [focus, setFocus] = useFormFocus(FIELD_COUNT, isActive, PATH);

  const submit = (): void => {
    const dest = path.trim();
    if (!dest) {
      setLocalError('destination path is required');
      setFocus(PATH);
      return;
    }
    if (!passphrase) {
      // Never name, echo, or measure the passphrase in the message.
      setLocalError('passphrase is required — the export cannot be written unencrypted');
      setFocus(PASS);
      return;
    }
    if (passphrase !== confirm) {
      setLocalError('passphrases do not match');
      setFocus(CONFIRM);
      return;
    }
    setLocalError(null);
    onExport(dest, passphrase);
  };

  useInput(
    (_input, key) => {
      if (!key.return) {
        return;
      }
      // Enter advances through the fields and submits from the confirm field or
      // the button, so the flow works without ever hunting for the button.
      if (focus === PATH || focus === PASS) {
        setFocus(focus + 1);
        return;
      }
      submit();
    },
    { isActive },
  );

  const shown = localError ?? error;

  return (
    <ModalFrame
      title="Export vault"
      width={76}
      error={shown}
      hints={[
        { keys: 'Tab', label: 'next field' },
        { keys: 'Enter', label: 'next / export' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      <Field
        label="destination file"
        value={path}
        onChange={(v) => {
          setPath(v);
          setLocalError(null);
        }}
        focused={isActive && focus === PATH}
        placeholder="~/orbkey-export.json"
      />
      <Field
        label="export passphrase"
        value={passphrase}
        onChange={(v) => {
          setPassphrase(v);
          setLocalError(null);
        }}
        focused={isActive && focus === PASS}
        password
      />
      <Field
        label="confirm export passphrase"
        value={confirm}
        onChange={(v) => {
          setConfirm(v);
          setLocalError(null);
        }}
        focused={isActive && focus === CONFIRM}
        password
      />

      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.warn}>
          {figures.lock} Secret values in this file are encrypted under this
          passphrase.
        </Text>
        <Text color={theme.warn}>
          The passphrase is NOT recoverable. Lose it and the export is lost.
        </Text>
        <Text dimColor>
          Independent of your vault password. Written owner-only (0600).
        </Text>
        <Text dimColor>Argon2id runs once on export — this takes a moment.</Text>
      </Box>

      <Box>
        <Text color={focus === SUBMIT ? theme.success : undefined} bold={focus === SUBMIT}>
          {focus === SUBMIT ? figures.pointer : ' '} [ Export ]
        </Text>
      </Box>
    </ModalFrame>
  );
}
