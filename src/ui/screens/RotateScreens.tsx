import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalFrame } from '../components/ModalFrame.js';
import { Field } from '../components/Field.js';
import { useFormFocus } from '../hooks/useFormFocus.js';
import { theme, figures } from '../theme.js';
import type { UiIamCreds } from '../types.js';

// --- Rotate menu -------------------------------------------------------------

interface MenuProps {
  isActive: boolean;
  onChoose: (choice: 'password' | 'iam') => void;
  onCancel: () => void;
}

const MENU_CHOICES: { value: 'password' | 'iam'; label: string }[] = [
  { value: 'password', label: 'Password (re-wrap keychain)' },
  { value: 'iam', label: 'IAM key (replace cached creds)' },
];

export function RotateMenuScreen({ isActive, onChoose }: MenuProps): React.ReactElement {
  const [index, setIndex] = useState(0);
  useInput(
    (_input, key) => {
      if (key.downArrow) {
        setIndex((i) => Math.min(MENU_CHOICES.length - 1, i + 1));
      } else if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (key.return) {
        const c = MENU_CHOICES[index];
        if (c) {
          onChoose(c.value);
        }
      }
    },
    { isActive },
  );
  return (
    <ModalFrame
      title="Rotate"
      width={56}
      hints={[
        { keys: '↑/↓', label: 'choose' },
        { keys: 'Enter', label: 'select' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      {MENU_CHOICES.map((c, i) => (
        <Box key={c.value}>
          <Text color={i === index ? theme.accent : undefined} bold={i === index}>
            {i === index ? figures.pointer : ' '} {c.label}
          </Text>
        </Box>
      ))}
    </ModalFrame>
  );
}

// --- Rotate password ---------------------------------------------------------

interface PasswordProps {
  isActive: boolean;
  error: string | null;
  onSubmit: (data: { old: string; next: string; confirm: string }) => void;
  onCancel: () => void;
}

export function RotatePasswordScreen({
  isActive,
  error,
  onSubmit,
}: PasswordProps): React.ReactElement {
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [focus] = useFormFocus(4, isActive, 0);

  useInput(
    (_input, key) => {
      if (key.return && focus === 3) {
        onSubmit({ old, next, confirm });
      }
    },
    { isActive },
  );

  return (
    <ModalFrame
      title="Rotate password"
      error={error}
      hints={[
        { keys: 'Tab', label: 'next' },
        { keys: 'Enter', label: 'rotate (on button)' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      <Field label="current password" value={old} onChange={setOld} focused={focus === 0} password />
      <Field label="new password" value={next} onChange={setNext} focused={focus === 1} password />
      <Field label="confirm new password" value={confirm} onChange={setConfirm} focused={focus === 2} password />
      <Box>
        <Text color={focus === 3 ? theme.success : undefined} bold={focus === 3}>
          {focus === 3 ? figures.pointer : ' '} [ Rotate ]
        </Text>
      </Box>
    </ModalFrame>
  );
}

// --- Rotate IAM --------------------------------------------------------------

interface IamProps {
  isActive: boolean;
  error: string | null;
  onSubmit: (data: { password: string; creds: UiIamCreds }) => void;
  onCancel: () => void;
}

const IAM_FIELDS: { name: keyof IamForm; label: string; secret: boolean }[] = [
  { name: 'password', label: 'current vault password', secret: true },
  { name: 'accessKeyId', label: 'new IAM access key id', secret: false },
  { name: 'secretAccessKey', label: 'new IAM secret access key', secret: true },
  { name: 'region', label: 'region', secret: false },
  { name: 'accountId', label: 'account id', secret: false },
];

interface IamForm {
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  accountId: string;
}

export function RotateIamScreen({ isActive, error, onSubmit }: IamProps): React.ReactElement {
  const [form, setForm] = useState<IamForm>({
    password: '',
    accessKeyId: '',
    secretAccessKey: '',
    region: '',
    accountId: '',
  });
  const [focus] = useFormFocus(IAM_FIELDS.length + 1, isActive, 0);
  const submitIdx = IAM_FIELDS.length;

  useInput(
    (_input, key) => {
      if (key.return && focus === submitIdx) {
        onSubmit({
          password: form.password,
          creds: {
            accessKeyId: form.accessKeyId.trim(),
            secretAccessKey: form.secretAccessKey.trim(),
            region: form.region.trim(),
            accountId: form.accountId.trim(),
          },
        });
      }
    },
    { isActive },
  );

  return (
    <ModalFrame
      title="Rotate IAM key"
      width={70}
      error={error}
      hints={[
        { keys: 'Tab', label: 'next' },
        { keys: 'Enter', label: 'rotate (on button)' },
        { keys: 'Esc', label: 'cancel' },
      ]}
    >
      {IAM_FIELDS.map((f, i) => (
        <Field
          key={f.name}
          label={f.label}
          value={form[f.name]}
          onChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))}
          focused={focus === i}
          password={f.secret}
        />
      ))}
      <Box>
        <Text color={focus === submitIdx ? theme.success : undefined} bold={focus === submitIdx}>
          {focus === submitIdx ? figures.pointer : ' '} [ Rotate ]
        </Text>
      </Box>
    </ModalFrame>
  );
}
