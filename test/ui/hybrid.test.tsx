/**
 * Variant decisions: the hybrid leader + live-filter + command-mode input model,
 * the inline filter highlight, the inline add/edit form, and the orb unlock.
 *
 * Drives <App> against an injected offline FakeSession via ink-testing-library.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';
import { BIG_ART } from '../../src/ui/components/Wordmark.js';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
const CTRL_SPACE = '\x00'; // NUL byte — what Ctrl+Space sends.
const CTRL_R = '\x12';

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick(3);
  }
}

function seeded(): FakeSession {
  const s = new FakeSession({ status: 'OFFLINE' });
  s.addSecret('github/token', 'gh-secret', '', ['dev']);
  s.addSecret('gitlab/token', 'gl-secret', '', ['dev']);
  s.addSecret('aws/key', 'aws-secret', '', ['cloud']);
  return s;
}

describe('which-key leader grid (Variant 4B)', () => {
  it('Ctrl+Space opens the grid (LEADER), a listed key runs an action, and it closes', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    // Open the leader grid.
    stdin.write(CTRL_SPACE);
    await tick();
    const open = lastFrame() ?? '';
    expect(open).toContain('LEADER');
    // Grid lists key→label pairs.
    expect(open).toContain('add');
    expect(open).toContain('reveal');

    // Press 'a' → runs add → grid closes, add form opens.
    stdin.write('a');
    await tick();
    const after = lastFrame() ?? '';
    expect(after).not.toContain('-- LEADER --');
    expect(after).toContain('add secret');
    unmount();
  });

  it('Esc closes the leader grid without running anything', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    stdin.write(CTRL_SPACE);
    await tick();
    expect(lastFrame()).toContain('LEADER');
    stdin.write(ESC);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('-- LEADER --');
    expect(frame).toContain('UNLOCKED');
    unmount();
  });

  it("leader 'r' reveals the selected value (real Ctrl+R toggle)", async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('k', 'topsecret', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    expect(lastFrame()).not.toContain('topsecret');
    stdin.write(CTRL_SPACE);
    await tick();
    stdin.write('r');
    await tick();
    expect(lastFrame()).toContain('topsecret');
    unmount();
  });
});

describe('command mode (Variant 4B `:`)', () => {
  it('`:` opens command mode with a completion strip and runs a command', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    stdin.write(':');
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('COMMAND');

    await type(stdin, 'ad');
    await tick();
    frame = lastFrame() ?? '';
    // Completion strip shows the command name + its description.
    expect(frame).toContain('add');
    expect(frame).toContain('add a new secret');

    // Enter runs the highlighted completion (add) → form opens, mode resets.
    stdin.write(ENTER);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('add secret');
    expect(frame).not.toContain('COMMAND ·');
    unmount();
  });

  it('Tab cycles completions; Esc leaves command mode back to browse', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    stdin.write(':');
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('COMMAND');
    stdin.write(ESC);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('COMMAND ·');
    expect(frame).toContain('UNLOCKED');
    unmount();
  });
});

describe('inline live filter (Variant 3A) — bare typing still filters', () => {
  it('bare typing filters the list live and shows a FILTER status', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, 'git');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('github/token');
    expect(frame).toContain('gitlab/token');
    expect(frame).not.toContain('aws/key');
    // Inline-filter status with match count.
    expect(frame).toContain('FILTER');
    expect(frame).toContain('"git"');
    unmount();
  });
});

describe('filter → Enter edits the selected item', () => {
  it('Enter opens the inline EDIT form for the filtered selection', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    // Filter down to a single match, then Enter (no arrow needed — it is row 0).
    await type(stdin, 'gitlab');
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // The inline edit form opened for the filtered row.
    expect(frame).toContain('EDIT · field');
    expect(frame).toContain('gitlab/token');
    // It is an EDIT, not an ADD.
    expect(frame).not.toContain('ADD · field');
    unmount();
  });

  it('Enter on an empty filtered list surfaces "no secret selected"', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, 'zzz-no-match');
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('no secret selected');
    // No edit form was opened.
    expect(frame).not.toContain('EDIT · field');
    unmount();
  });
});

describe('inline add/edit form (Variant 5A)', () => {
  it('opens in the detail pane with the list still visible; value field masked', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // EDIT/ADD status with the field counter + reseal note.
    expect(frame).toContain('ADD · field');
    expect(frame).toContain('reseal on save');
    // The list is still visible on the left.
    expect(frame).toContain('github/token');
    // Type a value and confirm it is masked.
    await type(stdin, 'newkey');
    stdin.write(TAB); // → value
    await tick();
    await type(stdin, 'plain-value');
    await tick();
    expect(lastFrame()).not.toContain('plain-value');
    unmount();
  });

  it('Tab cycles all four fields (name→value→labels→note→wrap) and the field counter tracks focus', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    // Field 1 (name) focused initially.
    expect(lastFrame()).toContain('field 1/4');
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('field 2/4'); // value
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('field 3/4'); // labels
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('field 4/4'); // note
    // Tab off the note wraps back to name (proves Tab leaves the note field).
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('field 1/4');
    // Shift+Tab goes back to the note.
    stdin.write('\x1b[Z'); // Shift+Tab
    await tick();
    expect(lastFrame()).toContain('field 4/4');
    unmount();
  });

  it('the bottom command bar does NOT capture input while the form is open (it shows the inactive placeholder)', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    // Typing into the focused name field must land in the form, not the filter
    // bar — the list stays unfiltered and the command bar shows its inactive
    // placeholder (the active TextField is not rendered for the bar during edit).
    await type(stdin, 'github');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('type to filter'); // inactive bar placeholder
    // All three seeded secrets still listed (the form captured the keystrokes,
    // so they did NOT live-filter the list down to github/*).
    expect(frame).toContain('aws/key');
    unmount();
  });

  it('renders a borderless note (no round frame) that wraps, plus an always-visible cheat line', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    // The cheat hint line is present and truthful to the wired keys.
    const opened = lastFrame() ?? '';
    expect(opened).toContain('^S save');
    expect(opened).toContain('Esc discard');
    expect(opened).toContain('next');
    // Move to the note field and type a long line.
    stdin.write(TAB); // value
    await tick();
    stdin.write(TAB); // labels
    await tick();
    stdin.write(TAB); // note
    await tick();
    await type(
      stdin,
      'this is a long note that should soft wrap to the detail pane width without any border',
    );
    await tick();
    const frame = lastFrame() ?? '';
    // The note value wrapped across more than one rendered line (the words land
    // on different rows), and there is NO rounded box-drawing frame around it.
    expect(frame).toContain('this is a long note');
    expect(frame).not.toContain('╭'); // no round border top corner
    expect(frame).not.toContain('╰'); // no round border bottom corner
    unmount();
  });

  it('Ctrl+S saves from the note field (where Enter inserts a newline) and persists the note', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'svc/token');
    stdin.write(TAB); // value
    await tick();
    await type(stdin, 'val');
    stdin.write(TAB); // labels
    await tick();
    stdin.write(TAB); // note
    await tick();
    await type(stdin, 'a multi line note');
    // Enter inside the note must NOT save (it inserts a newline).
    stdin.write(ENTER);
    await tick();
    expect(session.getSecret('svc/token')).toBeNull();
    // Ctrl+S from the note field saves.
    stdin.write('\x13'); // Ctrl+S
    await tick();
    const saved = session.getSecret('svc/token');
    expect(saved).not.toBeNull();
    expect(saved?.note).toContain('a multi line note');
    // The newline from the earlier Enter survived (multi-line note).
    expect(saved?.note).toContain('\n');
    unmount();
  });

  it('Esc discards the form without persisting anything', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'ghost/key');
    await tick();
    stdin.write(ESC);
    await tick();
    expect(session.getSecret('ghost/key')).toBeNull();
    unmount();
  });

  it('never leaks a typed secret value into the rendered frame or status line', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} columns={100} rows={32} />);
    await tick();
    await type(stdin, ':add');
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'leaky/key');
    stdin.write(TAB); // value
    await tick();
    await type(stdin, 'super-secret-value');
    await tick();
    expect(lastFrame()).not.toContain('super-secret-value');
    // After save the value stays masked in the detail pane + status line.
    stdin.write('\x13'); // Ctrl+S
    await tick();
    expect(lastFrame()).not.toContain('super-secret-value');
    unmount();
  });
});

describe('selection-based commands after a locked-start unlock', () => {
  // Regression: the command helpers are built once, on the first render. While
  // the vault is still locked that render has no secrets, so a stale closure
  // froze the selection at null and `:edit`/`get`/`rm` always reported
  // "no secret selected". The selection must be read fresh (via a ref).
  it(':edit opens the inline form for the selected secret (not "no secret selected")', async () => {
    const session = new FakeSession({ status: 'OFFLINE', locked: true, firstRun: false });
    session.addSecret('github/token', 'gh-secret', '', ['dev']);
    session.addSecret('aws/key', 'aws-secret', '', ['cloud']);
    const { lastFrame, stdin, unmount } = render(
      <App session={session} initialScreen={{ kind: 'unlock', error: null }} />,
    );
    await tick(500); // let the splash spray-reveal settle

    // Unlock (FakeSession accepts any passphrase).
    await type(stdin, 'pw');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame() ?? '').toContain('github/token'); // home is shown

    // `:edit` with no argument targets the selected (first) secret.
    await type(stdin, ':edit');
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('EDIT · field'); // the inline form opened
    expect(frame).toContain('reseal on save');
    expect(frame).not.toContain('no secret selected');
    expect(frame).toContain('github/token'); // editing the selected secret; list still visible
    unmount();
  });
});

describe('orb unlock screen (Variant 2A)', () => {
  it('renders the centered orb wordmark + masked passphrase; never echoes plaintext', async () => {
    const session = new FakeSession({ status: 'OFFLINE', locked: true, firstRun: false });
    const { lastFrame, stdin, unmount } = render(
      <App session={session} initialScreen={{ kind: 'unlock', error: null }} />,
    );
    // At the test shim's default 80x24 the big Slant ASCII-art hero is chosen.
    // It first draws in with the one-shot spray reveal (~400ms); wait for it to
    // settle before asserting the full art (row 1 has no trailing whitespace),
    // the lowercase top-bar wordmark, and the prompt.
    await tick(500);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(BIG_ART[1]);
    expect(frame).toContain('orbkey');
    expect(frame).toContain('passphrase');
    // The old decorative ASCII orb is gone; its glyphs must not render.
    expect(frame).not.toContain('.-""""-.');
    expect(frame).not.toContain("'-....-'");
    // Type a passphrase — only mask dots may appear, never the plaintext.
    await type(stdin, 'hunter2');
    await tick();
    expect(lastFrame()).not.toContain('hunter2');
    expect(lastFrame()).toContain('••');
    unmount();
  });
});
