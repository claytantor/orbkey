import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { Field } from '../components/Field.js';
import { theme } from '../theme.js';
import type { UiKeepassEntry } from '../types.js';

interface Props {
  defaultPath: string;
  isActive: boolean;
  onParse: (path: string) => UiKeepassEntry[] | { error: string };
  onImport: (path: string) => void;
  onCancel: () => void;
}

/** Import KeePass XML: path input + parsed preview, then confirm. */
export function ImportScreen({
  defaultPath,
  isActive,
  onParse,
  onImport,
  onCancel,
}: Props): React.ReactElement {
  const [path, setPath] = useState(defaultPath);
  const [entries, setEntries] = useState<UiKeepassEntry[] | null>(null);
  const [info, setInfo] = useState<string>('');

  const doParse = (p: string): void => {
    const result = onParse(p.trim());
    if (Array.isArray(result)) {
      setEntries(result);
      const urls = result.filter((e) => e.url).length;
      setInfo(`${result.length} entries (${urls} with URLs). Press Enter again to import.`);
    } else {
      setEntries(null);
      setInfo(result.error);
    }
  };

  useInput(
    (_input, key) => {
      if (key.return && entries !== null) {
        onImport(path.trim());
      }
    },
    { isActive },
  );

  return (
    <ModalFrame
      title="Import KeePass XML"
      width={80}
      hints={[
        { keys: 'Enter', label: entries ? 'import' : 'parse path' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      <Field
        label="XML file path"
        value={path}
        onChange={setPath}
        onSubmit={doParse}
        focused={isActive && entries === null}
        placeholder="~/exports/db.xml"
      />
      {info ? (
        <Box marginBottom={1}>
          <Text color={entries ? theme.success : theme.error}>{info}</Text>
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
