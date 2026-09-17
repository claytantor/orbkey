/**
 * Selection-based commands must act on the row the user is LOOKING at, which
 * in practice means after they have filtered down to it.
 *
 * Regression: `:` only opened command mode when the filter buffer was empty.
 * With a filter active the colon fell through to the bottom bar as a literal
 * character, so `gitlab` + `:edit` became the filter `gitlab:edit`, matched
 * nothing, and every selection-based command reported "no secret selected" —
 * breaking the one workflow (filter, then act) they exist for.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';

const ENTER = '\r';
const DOWN = '\x1b[B';

function tick(ms = 30): Promise<void> {
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
  s.addSecret('aws/key', 'aws-secret', '', ['cloud']);
  s.addSecret('github/token', 'gh-secret', '', ['dev']);
  s.addSecret('gitlab/token', 'gl-secret', '', ['dev']);
  return s;
}

describe('commands act on the filtered selection', () => {
  it('`:` opens command mode even when a filter is active', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    await type(stdin, 'gitlab');
    await tick();
    expect(lastFrame() ?? '').toContain('FILTER');

    await type(stdin, ':');
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('COMMAND');
    // The colon must not have leaked into the filter buffer.
    expect(frame).not.toContain('gitlab:');
    unmount();
  });

  it('filter then `:edit` edits the filtered row, not the first row overall', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    await type(stdin, 'gitlab'); // narrows to exactly one row
    await tick();
    await type(stdin, ':edit');
    await tick();
    stdin.write(ENTER);
    await tick(60);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('edit · gitlab/token');
    expect(frame).not.toContain('edit · aws/key');
    expect(frame).not.toContain('no secret selected');
    unmount();
  });

  it('filter, move the cursor, then `:edit` follows the cursor', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    await type(stdin, 'git'); // github/token, gitlab/token
    await tick();
    stdin.write(DOWN); // -> gitlab/token
    await tick();
    await type(stdin, ':edit');
    await tick();
    stdin.write(ENTER);
    await tick(60);

    expect(lastFrame() ?? '').toContain('edit · gitlab/token');
    unmount();
  });

  it('filter then `:delete` confirms against the filtered row', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    await type(stdin, 'gitlab');
    await tick();
    await type(stdin, ':delete');
    await tick();
    stdin.write(ENTER);
    await tick(60);

    const frame = lastFrame() ?? '';
    expect(frame).toContain("Delete secret 'gitlab/token'?");
    expect(frame).not.toContain("Delete secret 'aws/key'?");
    unmount();
  });

  it('still works with no filter at all', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    stdin.write(DOWN); // aws/key -> github/token
    await tick();
    await type(stdin, ':edit');
    await tick();
    stdin.write(ENTER);
    await tick(60);

    expect(lastFrame() ?? '').toContain('edit · github/token');
    unmount();
  });

  it('an explicit key argument still overrides the selection', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();

    await type(stdin, 'gitlab'); // selection is gitlab/token
    await tick();
    await type(stdin, ':edit aws/key'); // ...but the argument wins
    await tick();
    stdin.write(ENTER);
    await tick(60);

    expect(lastFrame() ?? '').toContain('edit · aws/key');
    unmount();
  });
});
