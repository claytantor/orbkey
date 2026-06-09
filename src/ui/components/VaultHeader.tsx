import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, figures } from '../theme.js';
import { truncateEnd } from '../truncate.js';
import type { AccountContext, UiSyncStatus } from '../types.js';

interface Props {
  vaultName: string;
  status: UiSyncStatus;
  locked: boolean;
  account: AccountContext;
  /** Available terminal columns, so the header stays exactly one content row. */
  columns: number;
  /**
   * Optional input-mode segment appended as `· <mode>` after the vault name
   * (e.g. `-- LEADER --`, `COMMAND`). Omitted in the resting browse mode. Shed
   * before the vault name when space is tight.
   */
  mode?: string;
}

function statusColor(status: UiSyncStatus): string {
  switch (status) {
    case 'SYNCED':
      return theme.success;
    case 'DIRTY':
      return theme.warn;
    case 'OFFLINE':
      return theme.muted;
    default:
      return theme.text;
  }
}

/** A pre-budgeted, display-width-aware text fragment ready to render. */
interface Fragment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

function width(s: string): number {
  return stringWidth(s);
}

function fragWidth(frags: Fragment[]): number {
  return frags.reduce((acc, f) => acc + width(f.text), 0);
}

/**
 * Top status bar: vault identity, sync status, lock indicator, and account /
 * region / profile chips.
 *
 * Renders as exactly one content row (plus its bottom border) at any width. The
 * box has `paddingX={1}`, so the usable content budget is `columns - 2`. When
 * that budget is tight we shed the lowest-priority information first and keep
 * the highest-priority info visible longest:
 *
 *   1. drop the profile chip
 *   2. drop the region chip
 *   3. drop the account chip
 *   4. drop the `[STATUS]` badge
 *   5. truncate the vault name (display-width aware, with `…`)
 *   6. truncate the orbkey / lock cluster end-first as a hard backstop
 *
 * `orbkey`, the vault name, and the lock state are the last things to go: a user
 * must always be able to see which vault they are on and whether it is locked.
 * Wide chars (CJK / emoji) in the vault name, account, region, or profile are
 * measured in terminal columns so they never wrap onto a second line.
 */
export function VaultHeader({
  vaultName,
  status,
  locked,
  account,
  columns,
  mode,
}: Props): React.ReactElement {
  // paddingX={1} on the outer Box consumes 2 columns of content budget.
  const budget = Math.max(1, columns - 2);

  // Identity + lock cluster (highest priority, kept visible longest).
  const lockFrag: Fragment = {
    text: locked ? `${figures.lock} LOCKED` : `${figures.unlock} unlocked`,
    color: locked ? theme.error : theme.success,
  };
  const statusFrag: Fragment = {
    text: `[${status}]`,
    color: statusColor(status),
  };

  // Account chips (lowest priority, shed first). Order them low → high priority
  // so we can pop from the end when space is tight.
  const chipFrags: Fragment[] = [];
  if (account.account) {
    chipFrags.push({ text: `acct ${account.account}`, dim: true });
  }
  if (account.region) {
    chipFrags.push({ text: `· ${account.region}`, dim: true });
  }
  if (account.profile) {
    chipFrags.push({ text: `· ${account.profile}`, dim: true });
  }

  const GAP = 2; // visual gap between the left cluster and the right chips
  const CHIP_GAP = 1; // gap between adjacent account chips

  // Build the left cluster, shedding [STATUS] and truncating the vault name as
  // needed so the identity + lock state always survive.
  function buildLeft(maxCols: number): Fragment[] {
    const orbkey: Fragment = { text: 'orbkey', color: theme.accent, bold: true };
    const sep = '  '; // gap=2 between orbkey/vault/status/lock

    const modeFrag: Fragment | null = mode
      ? { text: `· ${mode}`, color: theme.accent }
      : null;

    // Tier 1: orbkey + vault + mode + status + lock (full).
    const vaultFull: Fragment = { text: `· ${vaultName}`, dim: true };
    const full: Fragment[] = [
      orbkey,
      vaultFull,
      ...(modeFrag ? [modeFrag] : []),
      statusFrag,
      lockFrag,
    ];
    const sepCount = (n: number): number => Math.max(0, n - 1) * width(sep);
    if (fragWidth(full) + sepCount(full.length) <= maxCols) {
      return full;
    }

    // Tier 1b: keep the mode + lock but drop [STATUS] (mode is more salient than
    // sync state while the user is mid-action).
    if (modeFrag) {
      const modeNoStatus: Fragment[] = [orbkey, vaultFull, modeFrag, lockFrag];
      if (fragWidth(modeNoStatus) + sepCount(modeNoStatus.length) <= maxCols) {
        return modeNoStatus;
      }
    }

    // Tier 2: drop the [STATUS] badge (and mode).
    const noStatus: Fragment[] = [orbkey, vaultFull, lockFrag];
    if (fragWidth(noStatus) + sepCount(noStatus.length) <= maxCols) {
      return noStatus;
    }

    // Tier 3: truncate the vault name, keeping orbkey + lock.
    const fixedWidth = width(orbkey.text) + width('· ') + width(lockFrag.text);
    const vaultBudget = maxCols - fixedWidth - sepCount(3);
    if (vaultBudget >= 1) {
      const truncated = truncateEnd(vaultName, vaultBudget);
      return [orbkey, { text: `· ${truncated}`, dim: true }, lockFrag];
    }

    // Tier 4: orbkey + lock only.
    const minimal: Fragment[] = [orbkey, lockFrag];
    if (fragWidth(minimal) + sepCount(minimal.length) <= maxCols) {
      return minimal;
    }

    // Tier 5 (hard backstop): a single end-truncated line.
    return [{ text: truncateEnd(`orbkey ${lockFrag.text}`, maxCols), bold: true }];
  }

  // Decide how many account chips fit on the right, then size the left cluster
  // with whatever budget remains. Chips are shed from the lowest priority
  // (profile → region → account) until the right side fits.
  let chips = chipFrags;
  const chipsWidth = (frags: Fragment[]): number =>
    fragWidth(frags) + Math.max(0, frags.length - 1) * CHIP_GAP;

  // Reserve a sane minimum for the left cluster (orbkey + lock) before chips get
  // any room; otherwise narrow terminals would show only chips.
  const minLeft = width('orbkey') + GAP + width(lockFrag.text);
  while (chips.length > 0 && minLeft + GAP + chipsWidth(chips) > budget) {
    chips = chips.slice(0, -1);
  }

  const rightWidth = chips.length > 0 ? chipsWidth(chips) : 0;
  const leftBudget = chips.length > 0 ? budget - rightWidth - GAP : budget;
  const left = buildLeft(Math.max(1, leftBudget));

  return (
    <Box
      width={Math.max(1, columns)}
      paddingX={1}
      justifyContent="space-between"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box gap={2}>
        {left.map((f, i) => (
          <Text key={i} wrap="truncate-end" color={f.color} bold={f.bold} dimColor={f.dim}>
            {f.text}
          </Text>
        ))}
      </Box>
      {chips.length > 0 ? (
        <Box gap={1}>
          {chips.map((f, i) => (
            <Text key={i} wrap="truncate-end" dimColor>
              {f.text}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
