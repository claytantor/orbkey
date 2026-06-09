/** splitHighlight helper + SecretList accent highlight + chrome-budget helpers. */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { splitHighlight } from '../../src/ui/truncate.js';
import { SecretList } from '../../src/ui/components/SecretList.js';
import { whichKeyRowCount } from '../../src/ui/components/WhichKeyGrid.js';
import { commandStripRowCount } from '../../src/ui/components/CommandStrip.js';
import { suboptRows } from '../../src/ui/screens/HomeScreen.js';
import type { UiSecret } from '../../src/ui/types.js';

function secret(key: string): UiSecret {
  return {
    key,
    value: 'v',
    note: '',
    labels: [],
    id: key,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('splitHighlight', () => {
  it('returns one non-match segment when the needle is empty', () => {
    expect(splitHighlight('github/token', '')).toEqual([{ text: 'github/token', match: false }]);
  });

  it('marks every case-insensitive occurrence of the needle', () => {
    const segs = splitHighlight('GitLab-git', 'git');
    expect(segs).toEqual([
      { text: 'Git', match: true },
      { text: 'Lab-', match: false },
      { text: 'git', match: true },
    ]);
  });

  it('returns a single non-match segment when the needle is absent', () => {
    expect(splitHighlight('aws/key', 'zzz')).toEqual([{ text: 'aws/key', match: false }]);
  });
});

describe('SecretList highlight', () => {
  it('renders the matched key substring (it stays present in the frame)', () => {
    const { lastFrame } = render(
      <SecretList
        secrets={[secret('github/token'), secret('aws/key')]}
        selectedKey="github/token"
        viewportRows={10}
        width={40}
        highlight="git"
      />,
    );
    const frame = lastFrame() ?? '';
    // The key (split into highlighted + plain segments) is still fully rendered.
    expect(frame).toContain('github/token');
  });
});

describe('dynamic chrome budget', () => {
  it('browse mode adds zero sub-option rows; leader/command add a positive band', () => {
    expect(suboptRows('browse', 100, 0)).toBe(0);
    expect(suboptRows('leader', 100, 0)).toBe(whichKeyRowCount(100));
    expect(suboptRows('leader', 100, 0)).toBeGreaterThan(0);
    expect(suboptRows('command', 100, 3)).toBe(commandStripRowCount(3));
  });

  it('command strip row count is clamped to its max', () => {
    expect(commandStripRowCount(0)).toBe(1);
    expect(commandStripRowCount(2)).toBe(2);
    expect(commandStripRowCount(99)).toBe(4);
  });

  it('which-key grid uses fewer rows when wider (more columns fit)', () => {
    const narrow = whichKeyRowCount(30);
    const wide = whichKeyRowCount(120);
    expect(wide).toBeLessThanOrEqual(narrow);
    expect(wide).toBeGreaterThanOrEqual(1);
  });
});
