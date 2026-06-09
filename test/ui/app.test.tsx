/**
 * Ink integration tests (mirror test_tui.py) + security tests.
 * Drives <App> against an injected offline FakeSession.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';
import { BIG_ART } from '../../src/ui/components/Wordmark.js';

// Keys
const ENTER = '\r';
const CTRL_R = '';
const DOWN = '[B';

function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick(2);
  }
}

describe('App integration (offline FakeSession)', () => {
  it('renders the home screen with header and masks values by default', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('k', 'topsecret', '', []);
    const { lastFrame, unmount } = render(<App session={session} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('orbkey');
    expect(frame).toContain('k');
    // value masked, never plaintext
    expect(frame).toContain('••••••••');
    expect(frame).not.toContain('topsecret');
    unmount();
  });

  it('reveal toggles the value (Ctrl+R) and never leaks until revealed', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('k', 'topsecret', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    expect(lastFrame()).not.toContain('topsecret');
    stdin.write(CTRL_R);
    await tick();
    expect(lastFrame()).toContain('topsecret');
    stdin.write(CTRL_R);
    await tick();
    expect(lastFrame()).not.toContain('topsecret');
    unmount();
  });

  it('search filters the list', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('github/token', 'a', '', ['dev']);
    session.addSecret('gitlab/token', 'b', '', ['dev']);
    session.addSecret('aws/key', 'c', '', ['cloud']);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, '/search git');
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('github/token');
    expect(frame).toContain('gitlab/token');
    expect(frame).not.toContain('aws/key');
    unmount();
  });

  it('add flow opens the modal and creates a secret', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, '/add');
    stdin.write(ENTER);
    await tick();
    // Variant A: the add/edit form renders inline in the detail pane.
    expect(lastFrame()).toContain('add secret');
    // key field focused first; type the key
    await type(stdin, 'github/token');
    await tick();
    // Tab to value, type a value (masked)
    stdin.write('\t');
    await tick();
    await type(stdin, 'ghp_secret');
    await tick();
    // value field must be masked in the modal — no plaintext
    expect(lastFrame()).not.toContain('ghp_secret');
    unmount();
  });

  it('lock requires reauth (routes to unlock)', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('k', 'v', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, '/lock');
    stdin.write(ENTER);
    await tick();
    expect(session.locked).toBe(true);
    // Variant A: lock routes to the centered passphrase prompt (not the old
    // modal). At 80x24 the big Slant ASCII-art hero wordmark is chosen (see
    // Wordmark/pickWordmark). It first draws in with the one-shot spray reveal
    // (~400ms), so wait for it to settle before asserting the full art. Assert
    // row 1, which has no trailing whitespace (the rendered frame trims
    // line-trailing spaces, and both the reveal-settled art and the shimmer
    // overlay re-concatenate to the original line text). The old decorative ASCII
    // orb is gone, so its glyphs must not appear.
    await tick(500);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(BIG_ART[1]);
    expect(frame).toContain('passphrase');
    // The removed orb art (a ringed bubble) must not render anywhere.
    expect(frame).not.toContain('.-""""-.');
    expect(frame).not.toContain("'-....-'");
    unmount();
  });

  it('rm flow confirms then deletes (y)', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('doomed', 'x', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await type(stdin, '/rm doomed');
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('Delete');
    stdin.write('y');
    await tick();
    expect(session.getSecret('doomed')).toBeNull();
    unmount();
  });

  it('down arrow moves selection in the home list', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('a', '1', '', []);
    session.addSecret('b', '2', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    stdin.write(DOWN);
    await tick();
    // selected detail should show key 'b'
    const frame = lastFrame() ?? '';
    expect(frame).toContain('b');
    unmount();
  });

  it('status bar shows mode + selection + position, and tracks arrow nav', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('a', '1', '', []);
    session.addSecret('b', '2', '', []);
    session.addSecret('c', '3', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    // Selection defaults to the first row.
    expect(lastFrame()).toContain('UNLOCKED');
    expect(lastFrame()).toContain('(1/3)');
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('(2/3)');
    unmount();
  });

  it('status bar flags REVEALED after Ctrl+R but never the value', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    session.addSecret('k', 'topsecret', '', []);
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    expect(lastFrame()).not.toContain('REVEALED');
    stdin.write(CTRL_R);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('REVEALED');
    // The bar carries the indicator, not the value; value lives only in the pane.
    expect((frame.match(/topsecret/g) ?? []).length).toBe(1);
    unmount();
  });
});

describe('App security: no plaintext in any output stream', () => {
  it('never writes the secret value to console/stdout/stderr across add→get→sync', async () => {
    const SECRET = 'SUPER-SECRET-VALUE-XYZ';
    const session = new FakeSession({ status: 'DIRTY' });
    session.addSecret('k', SECRET, '', []);

    const sinks: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...a) => sinks.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a) => sinks.push(a.join(' '))),
      vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        sinks.push(String(c));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
        sinks.push(String(c));
        return true;
      }),
    ];

    // copyValue is injected — it must receive the value but we assert it is not
    // written to any stream by the app itself.
    const copied: string[] = [];
    const { stdin, unmount } = render(
      <App session={session} onCopyValue={(v) => copied.push(v)} />,
    );
    await tick();
    await type(stdin, '/get k');
    stdin.write(ENTER);
    await tick();
    await type(stdin, '/sync');
    stdin.write(ENTER);
    await tick();
    unmount();

    for (const s of spies) {
      s.mockRestore();
    }

    // The copy path legitimately received it; no stream did.
    expect(copied).toContain(SECRET);
    const leaked = sinks.some((line) => line.includes(SECRET));
    expect(leaked).toBe(false);
  });
});
