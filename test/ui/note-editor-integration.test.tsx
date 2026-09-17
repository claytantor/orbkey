/**
 * Stage 2: the full-screen vi note editor wired into the inline add/edit form.
 *
 * The vi SEMANTICS live in test/ui/vi-model.test.ts and the editor's own frame in
 * test/ui/note-editor-screen.test.tsx. This file covers only the seam between
 * them and the app: who owns the keyboard while the editor is open, and whether
 * the form's draft survives the round trip.
 *
 * THE hazard under test: Ink fans every keystroke out to EVERY active `useInput`
 * handler — no consumption, no bubbling. So Esc and Ctrl+S pressed inside the
 * editor would otherwise ALSO reach App's global Esc router and the form's own
 * submit chord, closing or saving the form behind the user's back.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
const CTRL_S = '\x13';
const CTRL_E = '\x05';

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Type characters one at a time so nothing is mistaken for a bracketed paste. */
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

type Stdin = { write: (s: string) => void };

/** Run an ex command from the editor's normal mode, e.g. `wq` for `:wq`. */
async function ex(stdin: Stdin, command: string): Promise<void> {
  await type(stdin, `:${command}`);
  stdin.write(ENTER);
  await tick();
}

/** Open the add form and fill name / value / labels, leaving focus on the note. */
async function openAddForm(stdin: Stdin): Promise<void> {
  await type(stdin, ':add');
  stdin.write(ENTER);
  await tick();
  await type(stdin, 'svc/token');
  stdin.write(TAB); // → value
  await tick();
  await type(stdin, 'sup3r-secret');
  stdin.write(TAB); // → labels
  await tick();
  await type(stdin, 'prod, aws');
  stdin.write(TAB); // → note
  await tick();
}

const EDITOR_TITLE = 'note';

describe('note editor ↔ add/edit form integration', () => {
  it('Enter on the note field opens the editor full-screen; typing + :wq persists the note', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);

    // The read-only preview advertises how to edit.
    expect(strip(lastFrame())).toContain('Enter to edit note');

    stdin.write(ENTER); // open the editor
    await tick();
    const editor = strip(lastFrame());
    expect(editor).toContain(EDITOR_TITLE);
    expect(editor).toContain('svc/token'); // title bar names the secret
    // Full-screen: the home list pane and the form chrome are gone.
    expect(editor).not.toContain('field 1/4');
    expect(editor).not.toContain('reseal on save');
    expect(editor).toContain('empty note'); // the editor's own first-run hint

    await type(stdin, 'i'); // insert mode
    await type(stdin, 'deploy key for CI');
    stdin.write(ESC);
    await tick();
    await ex(stdin, 'wq');

    // Back in the form, with the note in the preview.
    const form = strip(lastFrame());
    expect(form).toContain('ADD · field');
    expect(form).toContain('deploy key for CI');

    stdin.write(CTRL_S); // save the form
    await tick();
    expect(session.getSecret('svc/token')?.note).toBe('deploy key for CI');
    unmount();
  });

  it('Esc inside the editor returns to normal mode and does NOT close the add/edit form', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'i');
    await type(stdin, 'half written');
    await tick();
    expect(strip(lastFrame())).toContain('-- INSERT --');

    // THE regression: App's global Esc router closes the inline form on Esc. It
    // must be gated off while the editor is mounted, or this keystroke — the
    // ordinary way to leave insert mode — destroys the note and the form.
    stdin.write(ESC);
    await tick();
    const afterEsc = strip(lastFrame());
    expect(afterEsc).toContain(EDITOR_TITLE); // still in the editor
    expect(afterEsc).toContain('half written'); // buffer intact
    expect(afterEsc).not.toContain('-- INSERT --'); // back in normal mode
    // A second Esc in normal mode is a no-op, not a way out of the form.
    stdin.write(ESC);
    await tick();
    expect(strip(lastFrame())).toContain(EDITOR_TITLE);

    // Leaving properly lands back on the form, not on home.
    await ex(stdin, 'wq');
    const form = strip(lastFrame());
    expect(form).toContain('ADD · field');
    expect(form).toContain('svc/token'); // the name field survived
    unmount();
  });

  it('Ctrl+S inside the editor does NOT submit the form', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'i');
    await type(stdin, 'draft only');

    // The form's save chord must be inert while the editor owns the keyboard —
    // otherwise the secret is written mid-sentence, before the user said so.
    stdin.write(CTRL_S);
    await tick();
    expect(session.getSecret('svc/token')).toBeNull();
    expect(strip(lastFrame())).toContain(EDITOR_TITLE);

    stdin.write(ESC);
    await tick();
    await ex(stdin, 'q!');
    expect(session.getSecret('svc/token')).toBeNull();
    unmount();
  });

  it(':q! discards the edit and leaves the stored note intact', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('github/token', 'gh-secret', 'original note', ['dev']);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, ':edit github/token');
    stdin.write(ENTER);
    await tick();
    expect(strip(lastFrame())).toContain('original note'); // preview

    stdin.write(CTRL_E); // Ctrl+E opens the editor from the name field
    await tick();
    expect(strip(lastFrame())).toContain('original note');
    await type(stdin, 'A'); // append at end of line
    await type(stdin, ' WRECKED');
    stdin.write(ESC);
    await tick();
    await ex(stdin, 'q!');

    const form = strip(lastFrame());
    expect(form).toContain('EDIT · field');
    expect(form).toContain('original note');
    expect(form).not.toContain('WRECKED');

    stdin.write(CTRL_S);
    await tick();
    expect(session.getSecret('github/token')?.note).toBe('original note');
    unmount();
  });

  it(':w commits into the draft but leaves the editor open', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'i');
    await type(stdin, 'written not closed');
    stdin.write(ESC);
    await tick();

    await ex(stdin, 'w');
    const afterWrite = strip(lastFrame());
    expect(afterWrite).toContain(EDITOR_TITLE); // STILL open
    expect(afterWrite).toContain('note written');
    expect(afterWrite).toContain('written not closed');
    // :w cleared the dirty marker, so a plain :q is now allowed to leave.
    await ex(stdin, 'q');

    const form = strip(lastFrame());
    expect(form).toContain('ADD · field');
    // The draft took the :w text even though the editor closed via :q (cancel).
    expect(form).toContain('written not closed');
    stdin.write(CTRL_S);
    await tick();
    expect(session.getSecret('svc/token')?.note).toBe('written not closed');
    unmount();
  });

  it('key, value and labels survive a round trip through the editor', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'i');
    await type(stdin, 'round trip');
    stdin.write(ESC);
    await tick();
    await ex(stdin, 'wq');

    const form = strip(lastFrame());
    expect(form).toContain('svc/token');
    expect(form).toContain('prod, aws');
    // The value stays masked on the way back, as it was on the way in.
    expect(form).not.toContain('sup3r-secret');

    stdin.write(CTRL_S);
    await tick();
    const saved = session.getSecret('svc/token');
    expect(saved?.key).toBe('svc/token');
    expect(saved?.value).toBe('sup3r-secret');
    expect(saved?.labels).toEqual(['prod', 'aws']);
    expect(saved?.note).toBe('round trip');
    unmount();
  });

  it('the form preview shows the first lines and a +N more lines hint', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    // Deliberately longer than any plausible preview budget, so some lines are
    // summarised no matter how tall the pane is.
    const written = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    await type(stdin, 'i');
    for (const line of written) {
      await type(stdin, line);
      stdin.write(ENTER); // newline inside insert mode
      await tick(4);
    }
    stdin.write(ESC);
    await tick();
    await ex(stdin, 'wq');

    const form = strip(lastFrame());
    // The preview is sized from the pane, not a fixed constant, so derive the
    // expectation the same way the form does rather than pinning a number.
    const shown = written.filter((l) =>
      new RegExp(`\\b${l}\\b`).test(form),
    ).length;
    const total = written.length + 1; // + the empty line the last Enter opened

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total); // something must be summarised
    // What is shown is a PREFIX: the first `shown` lines, and no later one.
    for (const l of written.slice(0, shown)) {
      expect(form).toMatch(new RegExp(`\\b${l}\\b`));
    }
    expect(form).not.toMatch(new RegExp(`\\b${written[written.length - 1]!}\\b`));
    expect(form).toContain(`+${total - shown} more lines`);
    expect(form).toContain('Enter to edit note');
    unmount();
  });

  it('never writes the note into the frame outside the editor or the preview', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await openAddForm(stdin);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'i');
    await type(stdin, 'topsecret');
    stdin.write(ESC);
    await tick();
    await ex(stdin, 'q!');
    // Cancelled: the note never entered the draft, so it is nowhere on screen.
    const form = strip(lastFrame());
    expect(form).not.toContain('topsecret');
    // And nothing was persisted.
    expect(session.getSecret('svc/token')).toBeNull();
    unmount();
  });
});
