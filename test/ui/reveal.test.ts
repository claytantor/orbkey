import { describe, it, expect } from 'vitest';
import {
  revealVisible,
  revealCell,
  REVEAL_EDGE_WIDTH,
  REVEAL_DONE_CUTOFF,
  BIG_ART_WIDTH,
} from '../../src/ui/components/Wordmark.js';

describe('revealVisible geometry', () => {
  it('paints columns at or left of the cutoff, blanks those beyond', () => {
    const cutoff = 10;
    expect(revealVisible(0, cutoff)).toBe(true);
    expect(revealVisible(10, cutoff)).toBe(true); // exactly at the cutoff
    expect(revealVisible(11, cutoff)).toBe(false); // just beyond
    expect(revealVisible(34, cutoff)).toBe(false);
  });

  it('paints nothing before the sweep starts (cutoff -1)', () => {
    for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
      expect(revealVisible(c, -1)).toBe(false);
    }
  });

  it('paints the whole art once the cutoff reaches the done value', () => {
    for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
      expect(revealVisible(c, REVEAL_DONE_CUTOFF)).toBe(true);
    }
  });
});

describe('revealCell paint-state classification', () => {
  it('classifies columns well left of the cutoff as solid', () => {
    const cutoff = 20;
    expect(revealCell(0, cutoff)).toBe('solid');
    expect(revealCell(cutoff - REVEAL_EDGE_WIDTH, cutoff)).toBe('solid');
  });

  it('classifies the leading edge columns just left of the cutoff as edge', () => {
    const cutoff = 20;
    // The REVEAL_EDGE_WIDTH columns ending at the cutoff are the wet overspray.
    expect(revealCell(cutoff, cutoff)).toBe('edge');
    expect(revealCell(cutoff - REVEAL_EDGE_WIDTH + 1, cutoff)).toBe('edge');
    // One column further left has settled to solid.
    expect(revealCell(cutoff - REVEAL_EDGE_WIDTH, cutoff)).toBe('solid');
  });

  it('classifies columns beyond the cutoff as hidden', () => {
    const cutoff = 20;
    expect(revealCell(21, cutoff)).toBe('hidden');
    expect(revealCell(34, cutoff)).toBe('hidden');
  });

  it('honors a custom edge width', () => {
    const cutoff = 10;
    expect(revealCell(7, cutoff, 4)).toBe('edge'); // 10-4=6, c>6 -> edge
    expect(revealCell(6, cutoff, 4)).toBe('solid'); // c==6 -> solid
  });

  it('renders the full art as all-solid once the cutoff is at/after done', () => {
    for (const cutoff of [REVEAL_DONE_CUTOFF, REVEAL_DONE_CUTOFF + 5]) {
      for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
        expect(revealCell(c, cutoff)).toBe('solid');
      }
    }
  });

  it('the done cutoff pads past the art width by the edge width (edge sweeps off)', () => {
    expect(REVEAL_DONE_CUTOFF).toBe(BIG_ART_WIDTH - 1 + REVEAL_EDGE_WIDTH);
  });

  it('shows a hidden / edge / solid gradient mid-sweep across a row', () => {
    const cutoff = 15;
    const states = Array.from({ length: BIG_ART_WIDTH }, (_, c) => revealCell(c, cutoff));
    // Solids on the left, exactly REVEAL_EDGE_WIDTH edges, then hidden on the right.
    expect(states.filter((s) => s === 'edge')).toHaveLength(REVEAL_EDGE_WIDTH);
    // The last solid is left of the first edge, which is left of the first hidden.
    const lastSolid = states.lastIndexOf('solid');
    const firstEdge = states.indexOf('edge');
    const firstHidden = states.indexOf('hidden');
    expect(lastSolid).toBeLessThan(firstEdge);
    expect(firstEdge).toBeLessThan(firstHidden);
  });
});
