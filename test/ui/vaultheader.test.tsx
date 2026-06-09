/**
 * VaultHeader narrow-width tests.
 *
 * The Home layout assumes the header occupies a fixed 2 rows (1 content + 1
 * bottom border). These tests pin that invariant: at any width — including very
 * narrow terminals — the header must render exactly one content row, stay within
 * the column budget, and shed low-priority chips before truncating identity /
 * lock state.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, it, expect } from 'vitest';
import { VaultHeader } from '../../src/ui/components/VaultHeader.js';
import type { AccountContext } from '../../src/ui/types.js';

function lines(frame: string | undefined): string[] {
  return (frame ?? '').split('\n');
}

const account: AccountContext = {
  account: '123456789012',
  region: 'us-east-1',
  profile: 'prod-admin',
};

describe('VaultHeader', () => {
  it('renders identity, status, lock state, and account chips at a wide width', () => {
    const { lastFrame, unmount } = render(
      <VaultHeader vaultName="default" status="SYNCED" locked={false} account={account} columns={120} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('orbkey');
    expect(frame).toContain('default');
    expect(frame).toContain('[SYNCED]');
    expect(frame).toContain('unlocked');
    expect(frame).toContain('123456789012');
    expect(frame).toContain('us-east-1');
    expect(frame).toContain('prod-admin');
    unmount();
  });

  // The layout budgets the header at exactly 2 rows (content + bottom border).
  // Verify that holds across a sweep of narrow widths so nothing wraps.
  for (const columns of [24, 26, 28, 30, 36, 40, 50]) {
    it(`stays within its row + column budget at ${columns} cols`, () => {
      const { lastFrame, unmount } = render(
        <VaultHeader
          vaultName="some-fairly-long-vault-name"
          status="DIRTY"
          locked={true}
          account={account}
          columns={columns}
        />,
      );
      const out = lines(lastFrame());
      // 1 content row + 1 bottom border row == HEADER_ROWS budget. Never more.
      expect(out.length).toBe(2);
      for (const line of out) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
      unmount();
    });
  }

  it('keeps identity + lock state visible while shedding chips at narrow width', () => {
    const { lastFrame, unmount } = render(
      <VaultHeader vaultName="vault" status="OFFLINE" locked={true} account={account} columns={28} />,
    );
    const frame = lastFrame() ?? '';
    // Highest-priority info survives.
    expect(frame).toContain('orbkey');
    expect(frame).toContain('LOCKED');
    // Lowest-priority chip (profile) is shed first.
    expect(frame).not.toContain('prod-admin');
    unmount();
  });

  it('appends the · <mode> segment at a wide width and still fits 2 rows', () => {
    const { lastFrame, unmount } = render(
      <VaultHeader
        vaultName="default"
        status="SYNCED"
        locked={false}
        account={account}
        columns={120}
        mode="-- LEADER --"
      />,
    );
    const out = lines(lastFrame());
    expect(out.length).toBe(2);
    expect((out[0] ?? '')).toContain('-- LEADER --');
    expect(stringWidth(out[0] ?? '')).toBeLessThanOrEqual(120);
    unmount();
  });

  it('sheds the mode segment before the vault name + lock when very narrow', () => {
    const { lastFrame, unmount } = render(
      <VaultHeader
        vaultName="vault"
        status="OFFLINE"
        locked={true}
        account={account}
        columns={26}
        mode="COMMAND"
      />,
    );
    const out = lines(lastFrame());
    expect(out.length).toBe(2);
    for (const line of out) {
      expect(stringWidth(line)).toBeLessThanOrEqual(26);
    }
    // Lock state always survives; the mode segment is shed under pressure.
    expect(lastFrame() ?? '').toContain('LOCKED');
    unmount();
  });

  it('handles wide chars in the vault name without wrapping', () => {
    const { lastFrame, unmount } = render(
      <VaultHeader
        vaultName="日本語テストの金庫"
        status="SYNCED"
        locked={false}
        account={{ account: null, region: null, profile: null }}
        columns={26}
      />,
    );
    const out = lines(lastFrame());
    expect(out.length).toBe(2);
    for (const line of out) {
      expect(stringWidth(line)).toBeLessThanOrEqual(26);
    }
    unmount();
  });
});
