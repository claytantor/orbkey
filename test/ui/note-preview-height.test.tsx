/**
 * The read-only note preview in the add/edit form must use the space the detail
 * pane actually has, not a hardcoded line count.
 *
 * Regression: the preview was fixed at 3 lines regardless of terminal height, so
 * a tall terminal showed "+12 more lines" next to acres of empty pane.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';
import { notePreviewRows } from '../../src/ui/components/AddEditForm.js';
import { homeBodyRows } from '../../src/ui/screens/HomeScreen.js';

const ENTER = '\r';

function tick(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick(4);
  }
}

/** A note with numbered lines so we can tell exactly how many are rendered. */
const LINES = Array.from({ length: 14 }, (_, i) => `note-line-${i + 1}`);

function seeded(): FakeSession {
  const s = new FakeSession({ status: 'OFFLINE' });
  s.addSecret('github/token', 'gh-secret', LINES.join('\n'), ['dev']);
  return s;
}

/** How many `note-line-N` markers are visible in a frame. */
function visibleNoteLines(frame: string): number {
  return LINES.filter((l) => frame.includes(l)).length;
}

describe('note preview height budget', () => {
  describe('notePreviewRows (pure)', () => {
    it('grows one line per extra pane row', () => {
      expect(notePreviewRows(21) - notePreviewRows(20)).toBe(1);
      expect(notePreviewRows(40) - notePreviewRows(30)).toBe(10);
    });

    it('never collapses below one line, however short the pane', () => {
      for (const rows of [0, 1, 5, 15, 16]) {
        expect(notePreviewRows(rows)).toBeGreaterThanOrEqual(1);
      }
    });

    it('leaves room for the form chrome rather than claiming the whole pane', () => {
      // Whatever the budget is, the fixed fields must still fit.
      expect(notePreviewRows(20)).toBeLessThan(20);
      expect(notePreviewRows(60)).toBeLessThan(60);
    });
  });

  describe('through the real form', () => {
    it('shows more of the note on a taller terminal', async () => {
      // ink-testing-library's stdout stub reports a fixed size, so drive the
      // budget directly: the pane rows App computes must grow with the terminal.
      const short = homeBodyRows(24, 'browse', 100, 0);
      const tall = homeBodyRows(50, 'browse', 100, 0);
      expect(notePreviewRows(tall)).toBeGreaterThan(notePreviewRows(short));

      const session = seeded();
      const { lastFrame, stdin, unmount } = render(<App session={session} />);
      await tick();
      await type(stdin, ':edit');
      stdin.write(ENTER);
      await tick(80);

      const frame = lastFrame() ?? '';
      const shown = visibleNoteLines(frame);
      const expected = Math.min(LINES.length, notePreviewRows(homeBodyRows(24, 'browse', 100, 0)));

      // The old hardcoded behavior was exactly 3. Anything more proves the
      // budget is being consulted.
      expect(shown).toBeGreaterThan(3);
      expect(shown).toBe(expected);
      unmount();
    });

    it('still summarises the remainder it could not fit', async () => {
      const session = seeded();
      const { lastFrame, stdin, unmount } = render(<App session={session} />);
      await tick();
      await type(stdin, ':edit');
      stdin.write(ENTER);
      await tick(80);

      const frame = lastFrame() ?? '';
      const shown = visibleNoteLines(frame);
      expect(frame).toContain(`+${LINES.length - shown} more lines`);
      expect(frame).toContain('Enter to edit note');
      unmount();
    });

    it('keeps the cheat line visible — the preview must not push it out', async () => {
      const session = seeded();
      const { lastFrame, stdin, unmount } = render(<App session={session} />);
      await tick();
      await type(stdin, ':edit');
      stdin.write(ENTER);
      await tick(80);

      const frame = lastFrame() ?? '';
      expect(frame).toContain('^S save');
      expect(frame).toContain('Esc discard');
      unmount();
    });

    it('a short note is shown whole, with no "more lines" hint', async () => {
      const session = new FakeSession({ status: 'OFFLINE' });
      session.addSecret('short/key', 'v', 'only one line', []);
      const { lastFrame, stdin, unmount } = render(<App session={session} />);
      await tick();
      await type(stdin, ':edit');
      stdin.write(ENTER);
      await tick(80);

      const frame = lastFrame() ?? '';
      expect(frame).toContain('only one line');
      expect(frame).not.toContain('more lines');
      unmount();
    });
  });
});
