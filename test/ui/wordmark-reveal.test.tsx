import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import {
  Wordmark,
  BIG_ART,
  REVEAL_DONE_CUTOFF,
} from '../../src/ui/components/Wordmark.js';

// A viewport that selects the big tier (>=41 cols, >=14 rows).
const BIG_COLS = 120;
const BIG_ROWS = 40;

describe('Wordmark spray-reveal render', () => {
  it('renders the full art when the reveal cutoff is at the done value', () => {
    const { lastFrame } = render(
      <Wordmark columns={BIG_COLS} rows={BIG_ROWS} revealCutoff={REVEAL_DONE_CUTOFF} />,
    );
    const frame = lastFrame() ?? '';
    // Row 1 has no trailing whitespace, so it survives the frame trim intact.
    expect(frame).toContain(BIG_ART[1]);
  });

  it('hides the art entirely at the pre-sweep cutoff (-1) without crashing', () => {
    const { lastFrame } = render(
      <Wordmark columns={BIG_COLS} rows={BIG_ROWS} revealCutoff={-1} />,
    );
    const frame = lastFrame() ?? '';
    // Nothing of the slanted glyph rows has been painted yet.
    expect(frame).not.toContain(BIG_ART[1]);
    // The solid wordmark glyphs are absent (only blanks were emitted).
    expect(frame.trim()).toBe('');
  });

  it('partially reveals: left columns painted, right columns still blank', () => {
    // Cutoff at column 8 — only the first ~9 columns of each row are visible.
    const { lastFrame } = render(
      <Wordmark columns={BIG_COLS} rows={BIG_ROWS} revealCutoff={8} />,
    );
    const frame = lastFrame() ?? '';
    // The fully-painted right-hand tail of row 1 must NOT be present yet.
    expect(frame).not.toContain(BIG_ART[1]);
    // ...but the reveal did paint *something* (left columns + edge speckle).
    expect(frame.trim().length).toBeGreaterThan(0);
  });
});
