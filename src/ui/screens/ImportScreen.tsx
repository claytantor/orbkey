import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { Field } from '../components/Field.js';
import { theme } from '../theme.js';
import type { UiImportKind, UiKeepassEntry } from '../types.js';

interface Props {
  defaultPath: string;
  isActive: boolean;
  /** Classify the path BEFORE any parser runs. Must never throw. */
  onDetect: (path: string) => UiImportKind;
  onParse: (path: string) => UiKeepassEntry[] | { error: string };
  onImport: (path: string) => void;
  /**
   * Import an orbkey-native export, decrypting values with `passphrase`.
   * Returns `null` on success (the app closes the modal) or a safe, already
   * classified message to render inline — never the passphrase.
   */
  onImportOrbkey: (path: string, passphrase: string) => { error: string } | null;
  onCancel: () => void;
}

/** `path` = choosing the file; `passphrase` = an orbkey export needs a key. */
type Stage = 'path' | 'passphrase';

interface Info {
  text: string;
  tone: 'ok' | 'error';
}

/**
 * Import a KeePass XML export or an orbkey-native export.
 *
 * The path is classified by the port (`onDetect`) before any parser touches it:
 *   - `keepass` — unchanged flow: parse, show a preview, Enter again to import.
 *   - `orbkey`  — a MASKED passphrase prompt, then decrypt-and-import.
 *   - `unknown` — a clear inline message; nothing is parsed or imported.
 *
 * The passphrase is masked at entry and is never echoed, previewed, or put into
 * a message; imported secret VALUES are never previewed either (the KeePass
 * preview deliberately shows title/user/url only).
 */
export function ImportScreen({
  defaultPath,
  isActive,
  onDetect,
  onParse,
  onImport,
  onImportOrbkey,
}: Props): React.ReactElement {
  const [path, setPath] = useState(defaultPath);
  const [entries, setEntries] = useState<UiKeepassEntry[] | null>(null);
  const [stage, setStage] = useState<Stage>('path');
  const [passphrase, setPassphrase] = useState('');
  const [info, setInfo] = useState<Info | null>(null);

  const doParse = (p: string): void => {
    const target = p.trim();
    if (!target) {
      setInfo({ text: 'file path is required', tone: 'error' });
      return;
    }
    const kind = onDetect(target);
    if (kind === 'orbkey') {
      setEntries(null);
      setStage('passphrase');
      setInfo({ text: 'orbkey export detected — enter its export passphrase.', tone: 'ok' });
      return;
    }
    if (kind === 'unknown') {
      setEntries(null);
      setStage('path');
      setInfo({
        text: 'unrecognized file — expected a KeePass XML export or an orbkey export.',
        tone: 'error',
      });
      return;
    }
    // KeePass: today's exact flow — parse, preview, Enter again to import.
    const result = onParse(target);
    if (Array.isArray(result)) {
      setEntries(result);
      const urls = result.filter((e) => e.url).length;
      setInfo({
        text: `${result.length} entries (${urls} with URLs). Press Enter again to import.`,
        tone: 'ok',
      });
    } else {
      setEntries(null);
      setInfo({ text: result.error, tone: 'error' });
    }
  };

  useInput(
    (_input, key) => {
      if (!key.return) {
        return;
      }
      if (stage === 'passphrase') {
        if (!passphrase) {
          setInfo({ text: 'passphrase is required to read an orbkey export', tone: 'error' });
          return;
        }
        const failure = onImportOrbkey(path.trim(), passphrase);
        if (failure) {
          // Wipe the attempt so a bad passphrase is retyped, not re-submitted.
          setPassphrase('');
          setInfo({ text: failure.error, tone: 'error' });
        }
        return;
      }
      if (entries !== null) {
        onImport(path.trim());
      }
    },
    { isActive },
  );

  const onPassphraseStage = stage === 'passphrase';

  return (
    <ModalFrame
      title={onPassphraseStage ? 'Import orbkey export' : 'Import'}
      width={80}
      hints={[
        {
          keys: 'Enter',
          label: onPassphraseStage ? 'decrypt & import' : entries ? 'import' : 'check path',
        },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      <Field
        label="file path"
        value={path}
        onChange={(v) => {
          setPath(v);
          // Editing the path invalidates whatever the last check concluded.
          setEntries(null);
          setStage('path');
          setPassphrase('');
          setInfo(null);
        }}
        onSubmit={doParse}
        focused={isActive && stage === 'path' && entries === null}
        placeholder="~/exports/db.xml"
      />
      {stage === 'path' && entries === null ? (
        <Box marginBottom={1}>
          <Text dimColor>KeePass XML export, or an orbkey export written by :export</Text>
        </Box>
      ) : null}
      {onPassphraseStage ? (
        <Field
          label="export passphrase"
          value={passphrase}
          onChange={(v) => {
            setPassphrase(v);
            setInfo(null);
          }}
          focused={isActive}
          password
        />
      ) : null}
      {info ? (
        <Box marginBottom={1}>
          <Text color={info.tone === 'ok' ? theme.success : theme.error}>{info.text}</Text>
        </Box>
      ) : null}
      {entries ? (
        <Box flexDirection="column">
          <Text bold>Preview (first 10):</Text>
          {entries.slice(0, 10).map((e, i) => {
            const labelStr = e.labels.length ? ` [${e.labels.join(', ')}]` : '';
            const extra = [e.url ? `URL: ${e.url}` : '', e.username ? `User: ${e.username}` : '']
              .filter(Boolean)
              .join('; ');
            return (
              <Box key={`${e.title}-${i}`}>
                <Text>
                  {'  • '}
                  {e.title}
                </Text>
                <Text dimColor>
                  {labelStr}
                  {extra ? ` (${extra})` : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </ModalFrame>
  );
}
