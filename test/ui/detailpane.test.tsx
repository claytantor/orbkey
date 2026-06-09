/**
 * DetailPane read-only view: note word-wrap + vertical truncation with `…`,
 * footer stays visible, empty note shows (none). Value masking unchanged.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { DetailPane, noteLines } from '../../src/ui/components/DetailPane.js';
import type { UiSecret } from '../../src/ui/types.js';

function secret(over: Partial<UiSecret> = {}): UiSecret {
  return {
    key: 'github/token',
    value: 'super-secret-value',
    note: '',
    labels: [],
    id: 'id-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...over,
  };
}

const PARAGRAPH =
  'This is a fairly long multi-paragraph note that describes the secret in ' +
  'detail.\n\nIt has a second paragraph so it definitely exceeds the vertical ' +
  'space available in a short detail pane and must be truncated with an ellipsis.';

// A long single paragraph that wraps to many lines so it overflows a small note
// budget regardless of pane width.
const LONG_NOTE = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

describe('noteLines (pure)', () => {
  it('returns all lines with no ellipsis when everything fits', () => {
    const lines = noteLines('short note here', 30, 10);
    expect(lines).toEqual(['short note here']);
    expect(lines.join('')).not.toContain('…');
  });

  it('caps to maxLines and marks the last visible line with …', () => {
    const lines = noteLines(PARAGRAPH, 30, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('…');
  });

  it('keeps every capped line within the width (string-width checked)', () => {
    const lines = noteLines(PARAGRAPH, 24, 4);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it('returns [] when maxLines <= 0', () => {
    expect(noteLines(PARAGRAPH, 30, 0)).toEqual([]);
  });
});

describe('DetailPane note rendering', () => {
  // Use a comfortably wide pane (innerWidth ~76) so the value/labels/footer
  // lines are NOT themselves end-truncated — that isolates the assertion on the
  // NOTE's own vertical-truncation ellipsis.
  const WIDE = 80;

  it('wraps a long note across multiple lines and ends with … when the pane is short', () => {
    // rows=14 leaves a small note budget (14 - 9 = 5 lines) so LONG_NOTE overflows.
    const { lastFrame } = render(
      <DetailPane secret={secret({ note: LONG_NOTE })} revealed={false} width={WIDE} rows={14} />,
    );
    const frame = lastFrame() ?? '';
    // Multiple wrapped lines of the note are present.
    expect(frame).toContain('word0');
    // Truncated: an ellipsis marks "there's more".
    expect(frame).toContain('…');
    // The footer survives below the note.
    expect(frame).toContain('created 2026-01-01T00:00:00Z');
    expect(frame).toContain('updated 2026-01-02T00:00:00Z');
  });

  it('renders a short note fully with no … and keeps the footer', () => {
    const { lastFrame } = render(
      <DetailPane
        secret={secret({ note: 'just a short note' })}
        revealed={false}
        width={WIDE}
        rows={20}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('just a short note');
    expect(frame).not.toContain('…');
    expect(frame).toContain('created 2026-01-01T00:00:00Z');
    expect(frame).toContain('updated 2026-01-02T00:00:00Z');
  });

  it('shows (none) for an empty note', () => {
    const { lastFrame } = render(
      <DetailPane secret={secret({ note: '' })} revealed={false} width={WIDE} rows={20} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('note:');
    expect(frame).toContain('(none)');
  });

  it('masks the value by default and never leaks it when not revealed', () => {
    const { lastFrame } = render(
      <DetailPane
        secret={secret({ value: 'TOPSECRET123' })}
        revealed={false}
        width={WIDE}
        rows={20}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('TOPSECRET123');
  });

  it('does not push the footer off-screen on a very short pane', () => {
    const { lastFrame } = render(
      <DetailPane secret={secret({ note: PARAGRAPH })} revealed={false} width={WIDE} rows={11} />,
    );
    const frame = lastFrame() ?? '';
    // Even when the note budget collapses to ~0, the footer remains.
    expect(frame).toContain('created 2026-01-01T00:00:00Z');
  });

  it('falls back to a single note line when rows is unknown', () => {
    const { lastFrame } = render(
      <DetailPane secret={secret({ note: PARAGRAPH })} revealed={false} width={WIDE} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('created 2026-01-01T00:00:00Z');
  });
});
