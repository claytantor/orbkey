/**
 * Standalone render of <NoteEditorScreen> through ink-testing-library.
 *
 * The vi SEMANTICS are covered exhaustively in test/ui/vi-model.test.ts; this
 * file covers only what the component adds: the frame it draws, the keystroke →
 * applyKey wiring, and the save / write / cancel callbacks the parent gets.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { NoteEditorScreen, viewportTop } from '../../src/ui/screens/NoteEditorScreen.js';

const ENTER = '\r';
const ESC = '\x1b';

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Type characters one at a time so nothing is mistaken for a paste. */
async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick(4);
  }
}

/** Drop SGR color codes so assertions read against the plain frame. */
function strip(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const NOTE = 'deploy key for CI\n\nrotate every 90 days';

interface Harness {
  onSave: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  onWrite: ReturnType<typeof vi.fn>;
}

function mount(
  overrides: Partial<React.ComponentProps<typeof NoteEditorScreen>> = {},
): ReturnType<typeof render> & Harness {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onWrite = vi.fn();
  const instance = render(
    <NoteEditorScreen
      initialText={NOTE}
      title="github/token"
      width={64}
      height={14}
      isActive
      onSave={onSave}
      onCancel={onCancel}
      onWrite={onWrite}
      {...overrides}
    />,
  );
  return { ...instance, onSave, onCancel, onWrite };
}

describe('NoteEditorScreen · frame', () => {
  it('draws the title bar, a numbered gutter and the note text', async () => {
    const { lastFrame, unmount } = mount();
    await tick();
    const frame = strip(lastFrame());
    expect(frame).toContain('orbkey');
    expect(frame).toContain('note');
    expect(frame).toContain('github/token');
    expect(frame).toContain('1');
    expect(frame).toContain('deploy key for CI');
    expect(frame).toContain('rotate every 90 days');
    expect(frame).toContain('3');
    unmount();
  });

  it('marks rows past end of buffer with ~', async () => {
    const { lastFrame, unmount } = mount();
    await tick();
    expect(strip(lastFrame())).toContain('~');
    unmount();
  });

  it('shows a 1-based row,col position that tracks the cursor', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    expect(strip(lastFrame())).toContain('1,1');
    await type(stdin, 'll');
    expect(strip(lastFrame())).toContain('1,3');
    await type(stdin, 'jj');
    expect(strip(lastFrame())).toContain('3,1');
    unmount();
  });

  it('splitting the cursor row into before/at/after keeps the line intact', async () => {
    // The cursor is drawn as <Text inverse> on the character under it, which
    // splits the line into three nodes. Ink strips color in a non-TTY test run,
    // so the SGR itself is not observable here — what IS observable, and what
    // actually breaks, is the split losing or duplicating characters.
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    const at00 = strip(lastFrame());
    expect(at00).toContain('deploy key for CI');
    expect(at00.split('deploy key for CI')).toHaveLength(2);

    await type(stdin, 'lll');
    const at03 = strip(lastFrame());
    expect(at03).toContain('deploy key for CI');
    expect(at03).toContain('1,4');

    // The cursor on an empty line must still render that row, not collapse it.
    await type(stdin, 'j');
    const onBlank = strip(lastFrame());
    expect(onBlank).toContain('2,1');
    expect(onBlank).toContain('rotate every 90 days');
    unmount();
  });

  it('greets an empty note with a hint instead of a blank screen', async () => {
    const { lastFrame, unmount } = mount({ initialText: '' });
    await tick();
    const frame = strip(lastFrame());
    expect(frame).toContain('empty note');
    expect(frame).toContain('i insert');
    unmount();
  });

  it('renders at a narrow width without overflowing it', async () => {
    const { lastFrame, unmount } = mount({ width: 24, height: 10 });
    await tick();
    const lines = strip(lastFrame()).split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(24);
    }
    unmount();
  });

  it('renders at a tiny height without crashing', async () => {
    const { lastFrame, unmount } = mount({ width: 40, height: 4 });
    await tick();
    expect(strip(lastFrame())).toContain('orbkey');
    unmount();
  });
});

describe('NoteEditorScreen · modes', () => {
  it('i enters insert mode and the banner appears', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    expect(strip(lastFrame())).not.toContain('-- INSERT --');
    await type(stdin, 'i');
    expect(strip(lastFrame())).toContain('-- INSERT --');
    unmount();
  });

  it('typed text lands in the buffer and flags the note dirty', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    await type(stdin, 'iHELLO');
    const frame = strip(lastFrame());
    expect(frame).toContain('HELLOdeploy key for CI');
    expect(frame).toContain('[+]');
    unmount();
  });

  it('Esc returns to normal mode and does NOT invoke a callback', async () => {
    const { lastFrame, stdin, onSave, onCancel, unmount } = mount();
    await tick();
    await type(stdin, 'i');
    stdin.write(ESC);
    await tick();
    expect(strip(lastFrame())).not.toContain('-- INSERT --');
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the : prompt while an ex command is typed', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    await type(stdin, ':wq');
    expect(strip(lastFrame())).toContain(':wq');
    unmount();
  });

  it('shows the / prompt while a search pattern is typed, then jumps', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await tick();
    await type(stdin, '/rotate');
    expect(strip(lastFrame())).toContain('/rotate');
    stdin.write(ENTER);
    await tick();
    expect(strip(lastFrame())).toContain('3,1');
    unmount();
  });
});

describe('NoteEditorScreen · callbacks', () => {
  it(':wq hands the edited text to onSave', async () => {
    const { stdin, onSave, onCancel, unmount } = mount();
    await tick();
    await type(stdin, 'A!');
    stdin.write(ESC);
    await tick();
    await type(stdin, ':wq');
    stdin.write(ENTER);
    await tick();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('deploy key for CI!\n\nrotate every 90 days');
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it(':x saves too', async () => {
    const { stdin, onSave, unmount } = mount();
    await tick();
    await type(stdin, ':x');
    stdin.write(ENTER);
    await tick();
    expect(onSave).toHaveBeenCalledWith(NOTE);
    unmount();
  });

  it(':q! discards: onCancel fires and onSave never does', async () => {
    const { stdin, onSave, onCancel, unmount } = mount();
    await tick();
    await type(stdin, 'iJUNK');
    stdin.write(ESC);
    await tick();
    await type(stdin, ':q!');
    stdin.write(ENTER);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    unmount();
  });

  it(':q on a dirty note refuses with E37 and calls nothing', async () => {
    const { lastFrame, stdin, onSave, onCancel, unmount } = mount();
    await tick();
    await type(stdin, 'x');
    await type(stdin, ':q');
    stdin.write(ENTER);
    await tick();
    expect(strip(lastFrame())).toContain('E37: No write since last change');
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it(':q on a clean note cancels', async () => {
    const { stdin, onCancel, unmount } = mount();
    await tick();
    await type(stdin, ':q');
    stdin.write(ENTER);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it(':w writes without closing: onWrite fires, onSave/onCancel do not', async () => {
    const { lastFrame, stdin, onSave, onCancel, onWrite, unmount } = mount();
    await tick();
    await type(stdin, 'x');
    expect(strip(lastFrame())).toContain('[+]');
    await type(stdin, ':w');
    stdin.write(ENTER);
    await tick();
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith('eploy key for CI\n\nrotate every 90 days');
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    const frame = strip(lastFrame());
    expect(frame).toContain('note written');
    expect(frame).not.toContain('[+]');
    unmount();
  });

  it('ignores every keystroke while isActive is false', async () => {
    const { lastFrame, stdin, onSave, onCancel, unmount } = mount({ isActive: false });
    await tick();
    const before = strip(lastFrame());
    await type(stdin, 'iJUNK');
    await type(stdin, ':q!');
    stdin.write(ENTER);
    await tick();
    expect(strip(lastFrame())).toBe(before);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });
});

describe('NoteEditorScreen · paste', () => {
  it('a bracketed CRLF paste arrives intact, with no stray CR and no markers', async () => {
    const { lastFrame, stdin, onSave, unmount } = mount({ initialText: '' });
    await tick();
    stdin.write('\x1b[200~first line\r\nsecond line\x1b[201~');
    await tick();
    const frame = strip(lastFrame());
    expect(frame).toContain('first line');
    expect(frame).toContain('second line');
    expect(frame).not.toContain('200~');
    expect(frame).not.toContain('201~');

    await type(stdin, ':wq');
    stdin.write(ENTER);
    await tick();
    expect(onSave).toHaveBeenCalledWith('first line\nsecond line');
    unmount();
  });

  it('an unbracketed multi-character chunk in normal mode is text, not commands', async () => {
    const { stdin, onSave, unmount } = mount({ initialText: 'keep' });
    await tick();
    stdin.write('dd');
    await tick();
    await type(stdin, ':wq');
    stdin.write(ENTER);
    await tick();
    expect(onSave).toHaveBeenCalledWith('ddkeep');
    unmount();
  });
});

describe('NoteEditorScreen · viewport', () => {
  it('viewportTop keeps a short buffer pinned to the top', () => {
    expect(viewportTop(0, 3, 10)).toBe(0);
    expect(viewportTop(2, 3, 10)).toBe(0);
  });

  it('viewportTop keeps the cursor row inside the window and clamps at both ends', () => {
    for (const row of [0, 1, 17, 40, 99]) {
      const top = viewportTop(row, 100, 10);
      expect(top).toBeLessThanOrEqual(row);
      expect(row).toBeLessThan(top + 10);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(90);
    }
  });

  it('scrolls so the cursor row stays visible in a long note', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join('\n');
    const { lastFrame, stdin, unmount } = mount({ initialText: long, height: 12 });
    await tick();
    expect(strip(lastFrame())).toContain('line-1');
    await type(stdin, 'G');
    const frame = strip(lastFrame());
    expect(frame).toContain('line-60');
    expect(frame).not.toContain('line-1\n');
    expect(frame).toContain('60,1');
    unmount();
  });
});

describe('NoteEditorScreen · never leaks the note', () => {
  it('writes nothing to console during a full edit session', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stdin, unmount } = mount({ initialText: 'super-secret-note' });
    await tick();
    await type(stdin, 'iprefix-');
    stdin.write(ESC);
    await tick();
    stdin.write('\x1b[200~pasted-secret\x1b[201~');
    await tick();
    await type(stdin, ':wq');
    stdin.write(ENTER);
    await tick();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
    unmount();
  });
});
