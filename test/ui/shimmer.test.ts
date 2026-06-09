import { describe, it, expect } from 'vitest';
import {
  shimmerLit,
  nextShimmerBand,
  SHIMMER_BAND_HALF,
  SHIMMER_BAND_MIN,
  SHIMMER_BAND_MAX,
  SHIMMER_BAND_PERIOD,
  BIG_ART,
  BIG_ART_WIDTH,
  BIG_ART_HEIGHT,
} from '../../src/ui/components/Wordmark.js';

describe('shimmerLit geometry', () => {
  it('lights cells on the diagonal c - r == band (within half-width)', () => {
    const band = 5;
    // Exactly on the diagonal: c - r == band.
    expect(shimmerLit(0, 5, band)).toBe(true);
    expect(shimmerLit(2, 7, band)).toBe(true);
    // Within the half-width band (default 1).
    expect(shimmerLit(0, 4, band)).toBe(true);
    expect(shimmerLit(0, 6, band)).toBe(true);
    // Outside the band.
    expect(shimmerLit(0, 3, band)).toBe(false);
    expect(shimmerLit(0, 7, band)).toBe(false);
  });

  it('the band width is symmetric and equals 2*half + 1 cells on a row', () => {
    const band = 10;
    const r = 0;
    const litCols: number[] = [];
    for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
      if (shimmerLit(r, c, band)) {
        litCols.push(c);
      }
    }
    expect(litCols).toEqual([band - SHIMMER_BAND_HALF, band, band + SHIMMER_BAND_HALF]);
    expect(litCols.length).toBe(2 * SHIMMER_BAND_HALF + 1);
  });

  it('honors a custom half-width', () => {
    expect(shimmerLit(0, 8, 5, 3)).toBe(true); // |8-0-5| = 3 <= 3
    expect(shimmerLit(0, 9, 5, 3)).toBe(false); // |9-0-5| = 4 > 3
  });

  it('moves down-right as the band increases (Slant diagonal)', () => {
    // At band b, row 0 lights col b; at band b+1 it lights col b+1.
    // The band center tracks the band value: center col == band on row 0.
    expect(shimmerLit(0, 4, 4)).toBe(true); // center at band 4
    expect(shimmerLit(0, 5, 5)).toBe(true); // center at band 5
    // Col 3 is the trailing edge at band 4 (|3-4|=1, lit) but falls outside at
    // band 5 (|3-5|=2 > half), so the lit window has shifted right by one.
    expect(shimmerLit(0, 3, 4)).toBe(true);
    expect(shimmerLit(0, 3, 5)).toBe(false);
  });
});

describe('shimmer band advance + wrap', () => {
  it('advances by one each frame', () => {
    expect(nextShimmerBand(0)).toBe(1);
    expect(nextShimmerBand(SHIMMER_BAND_MIN)).toBe(SHIMMER_BAND_MIN + 1);
  });

  it('wraps from the max back to the min for a seamless loop', () => {
    expect(nextShimmerBand(SHIMMER_BAND_MAX)).toBe(SHIMMER_BAND_MIN);
  });

  it('covers exactly SHIMMER_BAND_PERIOD distinct positions in one cycle', () => {
    const seen = new Set<number>();
    let b = SHIMMER_BAND_MIN;
    for (let i = 0; i < SHIMMER_BAND_PERIOD; i += 1) {
      seen.add(b);
      b = nextShimmerBand(b);
    }
    // Visited every position once, then wrapped back to the start.
    expect(seen.size).toBe(SHIMMER_BAND_PERIOD);
    expect(b).toBe(SHIMMER_BAND_MIN);
  });

  it('the sweep range spans the full diagonal incl. padding for enter/exit', () => {
    // Diagonal coordinate c - r ranges from -(H-1) to W-1; padded by half-width.
    expect(SHIMMER_BAND_MIN).toBe(-(BIG_ART_HEIGHT - 1) - SHIMMER_BAND_HALF);
    expect(SHIMMER_BAND_MAX).toBe(BIG_ART_WIDTH - 1 + SHIMMER_BAND_HALF);
  });
});

describe('shimmer never lights space cells (glyph-only sheen)', () => {
  // shimmerLit is geometry only; the renderer ANDs it with "char !== ' '".
  // This test re-applies that contract against the real art so a future art
  // edit that relies on lighting blanks is caught.
  function isGlyphLit(r: number, c: number, band: number): boolean {
    const line = [...BIG_ART[r]!];
    const ch = line[c];
    if (ch === undefined || ch === ' ') {
      return false;
    }
    return shimmerLit(r, c, band);
  }

  it('a band over a blank region lights nothing', () => {
    // Row 0 of the Slant art is mostly blank ("              __    __").
    // Band aimed at the left blank gutter lights no glyph.
    let anyLit = false;
    for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
      if (isGlyphLit(0, c, 2)) {
        anyLit = true;
      }
    }
    expect(anyLit).toBe(false);
  });

  it('lights at least one glyph somewhere across a full sweep', () => {
    let everLitAGlyph = false;
    let band = SHIMMER_BAND_MIN;
    for (let f = 0; f < SHIMMER_BAND_PERIOD; f += 1) {
      for (let r = 0; r < BIG_ART_HEIGHT; r += 1) {
        for (let c = 0; c < BIG_ART_WIDTH; c += 1) {
          if (isGlyphLit(r, c, band)) {
            everLitAGlyph = true;
          }
        }
      }
      band = nextShimmerBand(band);
    }
    expect(everLitAGlyph).toBe(true);
  });
});
