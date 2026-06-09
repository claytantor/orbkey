/**
 * Status bar + adaptive-layout tests.
 *
 * Covers: mode + selection + position rendering, the one-line invariant under
 * narrow widths, width-aware truncation, and the no-secret-in-output guarantee
 * for the status bar.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, it, expect } from 'vitest';
import { StatusLine } from '../../src/ui/components/StatusLine.js';
import { modeLabel } from '../../src/ui/state.js';
import { truncateEnd, truncateMiddle } from '../../src/ui/truncate.js';

function lines(frame: string | undefined): string[] {
  return (frame ?? '').split('\n');
}

describe('truncate helpers (display-width aware)', () => {
  it('truncateEnd leaves short strings untouched', () => {
    expect(truncateEnd('abc', 10)).toBe('abc');
  });

  it('truncateEnd appends an ellipsis and fits the column budget', () => {
    const out = truncateEnd('abcdefghij', 5);
    expect(out.endsWith('…')).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
  });

  it('truncateEnd counts wide chars by column, not by code point', () => {
    // Each CJK char is width 2; budget of 5 columns fits 2 chars + ellipsis.
    const out = truncateEnd('日本語テスト', 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
  });

  it('truncateMiddle keeps both ends within budget', () => {
    const out = truncateMiddle('arn:aws:secretsmanager:us-east-1:123:secret:foo', 20);
    expect(out).toContain('…');
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
    expect(out.startsWith('arn')).toBe(true);
  });
});

describe('modeLabel', () => {
  it('reports LOCKED/UNLOCKED for home based on lock state', () => {
    expect(modeLabel({ kind: 'home' }, true)).toBe('LOCKED');
    expect(modeLabel({ kind: 'home' }, false)).toBe('UNLOCKED');
  });

  it('distinguishes add vs edit', () => {
    expect(modeLabel({ kind: 'addEdit', mode: 'add' }, false)).toBe('ADD');
    expect(modeLabel({ kind: 'addEdit', mode: 'edit', editingKey: 'k' }, false)).toBe('EDIT');
  });

  it('reflects the Home input mode (browse / leader / command)', () => {
    expect(modeLabel({ kind: 'home' }, false, 'browse')).toBe('UNLOCKED');
    expect(modeLabel({ kind: 'home' }, false, 'leader')).toBe('-- LEADER --');
    expect(modeLabel({ kind: 'home' }, false, 'command')).toBe('COMMAND');
    // Locked always wins regardless of input mode.
    expect(modeLabel({ kind: 'home' }, true, 'command')).toBe('LOCKED');
  });
});

describe('StatusLine', () => {
  it('renders mode, selection key, and position', () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        mode="UNLOCKED"
        revealed={false}
        selectedKey="github/token"
        position={3}
        total={27}
        status="ready"
        flash={null}
        columns={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('UNLOCKED');
    expect(frame).toContain('github/token');
    expect(frame).toContain('(3/27)');
    expect(frame).toContain('ready');
    unmount();
  });

  it('is exactly one line even at a very narrow width', () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        mode="UNLOCKED"
        revealed={true}
        selectedKey="a/very/long/secret/key/that/would/overflow"
        position={12}
        total={400}
        status="a fairly long persistent status message that also wants room"
        flash={null}
        columns={24}
      />,
    );
    const out = lines(lastFrame());
    expect(out.length).toBe(1);
    expect(stringWidth(out[0] ?? '')).toBeLessThanOrEqual(24);
    unmount();
  });

  it('shows the flash text over the persistent status when present', () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        mode="UNLOCKED"
        revealed={false}
        selectedKey="k"
        position={1}
        total={1}
        status="persistent"
        flash="copied to clipboard"
        columns={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('copied to clipboard');
    expect(frame).not.toContain('persistent');
    unmount();
  });

  it('flags REVEALED but never renders a secret value (it has none)', () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        mode="UNLOCKED"
        revealed={true}
        selectedKey="k"
        position={1}
        total={1}
        status=""
        flash={null}
        columns={80}
      />,
    );
    expect(lastFrame()).toContain('REVEALED');
    unmount();
  });
});
