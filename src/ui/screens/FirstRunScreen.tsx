import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { Field } from '../components/Field.js';
import { useFormFocus } from '../hooks/useFormFocus.js';
import { useWindowSize } from '../hooks/useWindowSize.js';
import { theme, figures } from '../theme.js';
import type { FirstRunInput } from '../types.js';

interface Props {
  isActive: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (input: FirstRunInput & { passwordConfirm: string }) => void;
  onCancel: () => void;
}

interface FieldDef {
  name: keyof FormState;
  label: string;
  secret: boolean;
}

interface FormState {
  accountId: string;
  region: string;
  bucket: string;
  kmsKeyId: string;
  objectKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  password: string;
  passwordConfirm: string;
}

const FIELDS: FieldDef[] = [
  { name: 'accountId', label: 'AWS account id', secret: false },
  { name: 'region', label: 'Region (e.g. us-east-1)', secret: false },
  { name: 'bucket', label: 'S3 bucket name (CDK output)', secret: false },
  { name: 'kmsKeyId', label: 'KMS key id / arn (CDK output)', secret: false },
  { name: 'objectKey', label: 'Vault object key', secret: false },
  { name: 'accessKeyId', label: 'IAM access key id', secret: false },
  { name: 'secretAccessKey', label: 'IAM secret access key', secret: true },
  { name: 'password', label: 'New vault password', secret: true },
  { name: 'passwordConfirm', label: 'Confirm password', secret: true },
];

const SUBMIT_INDEX = FIELDS.length; // 9

/** First-run setup form: AWS locators, IAM creds, and a new password. */
export function FirstRunScreen({
  isActive,
  busy,
  error,
  onSubmit,
  onCancel,
}: Props): React.ReactElement {
  const [form, setForm] = useState<FormState>({
    accountId: '',
    region: '',
    bucket: '',
    kmsKeyId: '',
    objectKey: 'vaults/default/vault.bin',
    accessKeyId: '',
    secretAccessKey: '',
    password: '',
    passwordConfirm: '',
  });
  const [focus] = useFormFocus(FIELDS.length + 1, isActive && !busy, 0);
  const { rows } = useWindowSize();

  const set = (name: keyof FormState, v: string): void =>
    setForm((f) => ({ ...f, [name]: v }));

  const submit = (): void => {
    onSubmit({
      accountId: form.accountId.trim(),
      region: form.region.trim(),
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey.trim(),
      bucket: form.bucket.trim(),
      kmsKeyId: form.kmsKeyId.trim(),
      objectKey: form.objectKey.trim() || 'vaults/default/vault.bin',
      password: form.password,
      passwordConfirm: form.passwordConfirm,
    });
  };

  useInput(
    (_input, key) => {
      if (busy) {
        return;
      }
      if (key.return && focus === SUBMIT_INDEX) {
        submit();
      }
    },
    { isActive },
  );

  // Focus-following viewport: how many fields fit (leave room for chrome).
  const maxVisible = Math.max(3, Math.floor((rows - 10) / 2));
  let start = 0;
  if (focus >= maxVisible) {
    start = Math.min(focus - maxVisible + 1, FIELDS.length - maxVisible);
  }
  start = Math.max(0, start);
  const visibleFields = FIELDS.slice(start, start + maxVisible);

  return (
    <ModalFrame
      title="orbkey first-run setup"
      width={76}
      error={error}
      hints={[
        { keys: 'Tab', label: 'next' },
        { keys: 'Enter', label: 'initialize (on button)' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      <Text dimColor>Paste values from your CDK stack outputs.</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleFields.map((f, i) => {
          const realIndex = start + i;
          return (
            <Field
              key={f.name}
              label={f.label}
              value={form[f.name]}
              onChange={(v) => set(f.name, v)}
              focused={focus === realIndex}
              password={f.secret}
            />
          );
        })}
        {FIELDS.length > maxVisible ? (
          <Text dimColor>
            field {focus + 1 <= FIELDS.length ? focus + 1 : FIELDS.length} of {FIELDS.length}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text
          color={focus === SUBMIT_INDEX ? theme.success : undefined}
          bold={focus === SUBMIT_INDEX}
        >
          {focus === SUBMIT_INDEX ? figures.pointer : ' '} [ Initialize vault ]
        </Text>
      </Box>
      {busy ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>validating credentials…</Text>
        </Box>
      ) : null}
    </ModalFrame>
  );
}

export type { FormState as FirstRunFormState };
