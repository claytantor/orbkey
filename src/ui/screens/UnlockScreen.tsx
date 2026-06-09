import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, figures } from '../theme.js';
import { useBlinkCursor } from '../hooks/useBlinkCursor.js';
import { useShimmer } from '../hooks/useShimmer.js';
import { useSprayReveal } from '../hooks/useSprayReveal.js';
import { truncateEnd } from '../truncate.js';
import { Wordmark, pickWordmark } from '../components/Wordmark.js';
import type { AccountContext, UiSyncStatus } from '../types.js';

interface Props {
  error: string | null;
  busy: boolean;
  onSubmit: (password: string) => void;
  vaultName?: string;
  account?: AccountContext;
  status?: UiSyncStatus;
  columns?: number;
  rows?: number;
}

/** A short, discrete sync descriptor for the bottom-right (no relative time). */
function syncDescriptor(status: UiSyncStatus | undefined): string {
  switch (status) {
    case 'SYNCED':
      return 'synced';
    case 'DIRTY':
      return 'unsynced changes';
    case 'OFFLINE':
      return 'offline';
    default:
      return 'offline';
  }
}

/**
 * Variant A — centered passphrase prompt. A full-viewport "screen" (not a
 * modal): a slim top bar, a HERO ASCII-art "orbkey" wordmark (the big
 * figlet-style Slant block, degrading to a letter-spaced `O R B K E Y` then
 * plain `orbkey` on small terminals — see {@link Wordmark}/`pickWordmark`), a
 * dim account line, a masked `passphrase › ••••` with a blinking block cursor,
 * the dim Argon2id hint, and a bottom status line. The passphrase is never
 * echoed as plaintext — only mask dots are rendered.
 *
 * On the big tier with animation enabled, the wordmark draws in with a one-shot
 * left→right "spray paint" reveal (~400ms, see {@link useSprayReveal}) and then
 * hands off to the looping diagonal shimmer sweep (see {@link useShimmer}); the
 * two never run at once. When animation is disabled or on smaller tiers, the
 * full static art shows immediately.
 *
 * Sync time: the design's "last sync 4m ago" needs a `lastSyncAt` the
 * `SessionPort` does not expose. We render only the DISCRETE sync status here
 * (e.g. `offline`); a `lastSyncAt` could be added to the port later.
 */
export function UnlockScreen({
  error,
  busy,
  onSubmit,
  vaultName = 'default',
  account,
  status,
  columns = 80,
  rows = 24,
}: Props): React.ReactElement {
  const [password, setPassword] = useState('');
  const cursorOn = useBlinkCursor(!busy);
  const width = Math.max(20, columns);
  const height = Math.max(12, rows);

  // Local controlled input (masked). Ignores control chords so Ctrl+Q etc. fall
  // through to the global handler; Enter submits.
  useInput(
    (input, key) => {
      if (busy) {
        return;
      }
      if (key.return) {
        onSubmit(password);
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab) {
        return;
      }
      if (key.backspace || key.delete) {
        setPassword((p) => p.slice(0, -1));
        return;
      }
      if (input.length === 0) {
        return;
      }
      setPassword((p) => p + input);
    },
    { isActive: true },
  );

  const tier = pickWordmark(width, height).tier;
  const bigIdle = tier === 'big' && !busy;
  // One-shot spray-on reveal: paints the wordmark left→right when the splash
  // mounts (big tier, animation enabled, idle), then reports `done`. Skipped
  // entirely (full static art) when disabled/busy/smaller tier.
  const reveal = useSprayReveal(bigIdle);
  // The looping diagonal sheen takes over ONLY after the reveal completes, so
  // the two never fight. Returns undefined (static art) when paused or on
  // dumb/NO_COLOR terminals.
  const shimmerBand = useShimmer(bigIdle && reveal.done);
  const mask = '•'.repeat(password.length);
  const cursor = cursorOn ? figures.cursor : ' ';

  const acctId = account?.account ?? '—';
  const region = account?.region ?? 'us-west-2';
  const topRight = truncateEnd(region, Math.max(4, Math.floor(width / 3)));

  // Reserve 1 top bar row + 1 bottom status row; center the orb in the middle.
  const middleRows = Math.max(1, height - 2);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Slim top bar */}
      <Box width={width} paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={theme.bright}>
            orbkey
          </Text>
          <Text color={theme.dim}>{figures.bullet}</Text>
          <Text color={theme.dim}>{vaultName}</Text>
          <Text color={theme.warn}>[LOCKED]</Text>
        </Box>
        <Text color={theme.dim}>{topRight}</Text>
      </Box>

      {/* Centered hero cluster */}
      <Box
        width={width}
        height={middleRows}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Box flexDirection="column" alignItems="center">
          <Wordmark
            columns={width}
            rows={height}
            shimmerBand={shimmerBand}
            revealCutoff={reveal.cutoff}
          />
          <Box marginTop={1}>
            <Text color={theme.dim}>
              vault: {vaultName} {figures.bullet} acct {acctId}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.dim}>passphrase </Text>
            <Text color={theme.accent}>{figures.promptSearch}</Text>
            <Text color={theme.bright}> {mask}</Text>
            <Text color={theme.accent}>{cursor}</Text>
          </Box>
          {busy ? (
            <Box marginTop={1}>
              <Text color={theme.accent}>unlocking…</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color={theme.dim}>Argon2id KDF · {figures.enter} unlock · ^C quit</Text>
            </Box>
          )}
          {error ? (
            <Box marginTop={1}>
              <Text color={theme.error}>{error}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {/* Bottom status line */}
      <Box width={width} justifyContent="space-between">
        <Text color={theme.dim}>
          LOCKED {figures.bullet} {busy ? 'verifying passphrase' : 'awaiting passphrase'}
        </Text>
        <Text color={theme.dim}>{syncDescriptor(status)}</Text>
      </Box>
    </Box>
  );
}
