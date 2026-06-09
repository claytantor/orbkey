import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  pickWordmark,
  BIG_ART,
  BIG_ART_WIDTH,
  BIG_ART_HEIGHT,
  SMALL_WORDMARK,
  PLAIN_WORDMARK,
} from '../../src/ui/components/Wordmark.js';

describe('pickWordmark tier selection', () => {
  it('chooses the big ASCII art on a wide AND tall viewport', () => {
    const choice = pickWordmark(120, 40);
    expect(choice.tier).toBe('big');
    expect(choice.lines).toEqual(BIG_ART);
    expect(choice.width).toBe(BIG_ART_WIDTH);
  });

  it('falls back to the small letter-spaced wordmark on a medium viewport', () => {
    // Wide enough for the small wordmark but too short for the big art.
    const choice = pickWordmark(40, 12);
    expect(choice.tier).toBe('small');
    expect(choice.lines).toEqual([SMALL_WORDMARK]);
  });

  it('falls back to small when wide but too short for the big art', () => {
    const choice = pickWordmark(120, BIG_ART_HEIGHT + 5);
    expect(choice.tier).toBe('small');
  });

  it('falls back to small when tall but too narrow for the big art', () => {
    const choice = pickWordmark(BIG_ART_WIDTH, 40);
    expect(choice.tier).toBe('small');
  });

  it('falls back to plain `orbkey` on a tiny viewport', () => {
    const choice = pickWordmark(10, 8);
    expect(choice.tier).toBe('plain');
    expect(choice.lines).toEqual([PLAIN_WORDMARK]);
  });

  it("never lets the chosen art's widest line exceed the given columns", () => {
    for (let columns = 1; columns <= 140; columns += 1) {
      for (const rows of [4, 8, 12, 18, 24, 40]) {
        const choice = pickWordmark(columns, rows);
        const widest = choice.lines.reduce((w, l) => Math.max(w, stringWidth(l)), 0);
        expect(choice.width).toBe(widest);
        expect(widest).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('big art is a pure-ASCII rectangular block of the Slant dimensions (35x6)', () => {
    expect(BIG_ART_WIDTH).toBe(35);
    expect(BIG_ART_HEIGHT).toBe(6);
    expect(BIG_ART).toHaveLength(BIG_ART_HEIGHT);
    for (const line of BIG_ART) {
      // eslint-disable-next-line no-control-regex
      expect(line).toMatch(/^[\x00-\x7F]*$/);
      expect(stringWidth(line)).toBe(BIG_ART_WIDTH);
    }
  });

  it('chooses big at the exact horizontal+vertical thresholds (41 cols, 14 rows)', () => {
    // 35 + 2*3 = 41 cols, 6 + 8 = 14 rows (VBUDGET dropped 13 -> 8 when the
    // decorative orb was removed from the lock screen).
    expect(pickWordmark(41, 14).tier).toBe('big');
    expect(pickWordmark(40, 14).tier).toBe('small'); // one col too narrow
    expect(pickWordmark(41, 13).tier).toBe('small'); // one row too short
  });
});
