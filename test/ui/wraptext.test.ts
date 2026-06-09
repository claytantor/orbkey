/** Pure `wrapText` word-wrap helper: boundaries, hard-break, width safety. */
import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { wrapText } from '../../src/ui/truncate.js';

describe('wrapText', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(wrapText('', 20)).toEqual([]);
    expect(wrapText('   ', 20)).toEqual([]);
    expect(wrapText('\n\n', 20)).toEqual([]);
    expect(wrapText('\t  \t', 20)).toEqual([]);
  });

  it('returns [] for a non-positive width', () => {
    expect(wrapText('hello world', 0)).toEqual([]);
    expect(wrapText('hello world', -5)).toEqual([]);
  });

  it('keeps a short line on one line', () => {
    expect(wrapText('hello world', 20)).toEqual(['hello world']);
  });

  it('wraps on word boundaries (breaks on spaces, no mid-word cut)', () => {
    const lines = wrapText('the quick brown fox jumps', 10);
    // Each line packs as many whole words as fit in 10 cols.
    expect(lines).toEqual(['the quick', 'brown fox', 'jumps']);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it('collapses runs of spaces/tabs between words', () => {
    expect(wrapText('a    b\t\tc', 20)).toEqual(['a b c']);
  });

  it('hard-breaks a single word longer than the width', () => {
    const lines = wrapText('supercalifragilistic', 6);
    expect(lines).toEqual(['superc', 'alifra', 'gilist', 'ic']);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(6);
    }
  });

  it('packs words after a hard-broken over-long word onto the tail line', () => {
    // The long word fills two full lines + a partial; the next word packs on.
    const lines = wrapText('abcdefghij end', 5);
    expect(lines).toEqual(['abcde', 'fghij', 'end']);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(5);
    }
  });

  it('never exceeds the width even with wide (CJK) characters', () => {
    // Each CJK glyph is 2 columns wide; width 5 fits 2 glyphs (4 cols) per line.
    const cjk = '漢字漢字漢字漢';
    const lines = wrapText(cjk, 5);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(5);
    }
  });

  it('preserves blank lines between paragraphs (multi-paragraph notes)', () => {
    const lines = wrapText('first para\n\nsecond para', 20);
    expect(lines).toEqual(['first para', '', 'second para']);
  });

  it('honors hard newlines as line breaks', () => {
    expect(wrapText('one\ntwo\nthree', 20)).toEqual(['one', 'two', 'three']);
  });

  it('normalizes CRLF newlines', () => {
    expect(wrapText('one\r\ntwo', 20)).toEqual(['one', 'two']);
  });
});
