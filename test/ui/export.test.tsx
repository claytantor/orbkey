/**
 * `:export` (ExportScreen) and the dual-format `:import` flow.
 *
 * Drives <App> against an injected offline FakeSession via ink-testing-library,
 * in the same style as hybrid.test.tsx. No core module, no AWS, no crypto — the
 * three new port methods (detectImportKind / exportVault / importOrbkey) are
 * exercised entirely through FakeSession.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { App } from '../../src/ui/app.js';
import { FakeSession } from '../../src/ui/FakeSession.js';
import { COMMAND_SPECS } from '../../src/ui/commands.js';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';

/** The passphrase used everywhere below; must never show up in a frame. */
const PASSPHRASE = 'correct-horse-battery-staple';

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick(3);
  }
}

/** Run a `:command` through the bottom command bar. */
async function runCommand(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  await type(stdin, text);
  stdin.write(ENTER);
  await tick();
}

function seeded(): FakeSession {
  const s = new FakeSession({ status: 'OFFLINE' });
  s.addSecret('github/token', 'gh-secret', '', ['dev']);
  s.addSecret('aws/key', 'aws-secret', '', ['cloud']);
  return s;
}

describe(':export command surface', () => {
  it('is listed in the completion strip with its description', () => {
    const spec = COMMAND_SPECS.find((c) => c.name === 'export');
    expect(spec).toBeDefined();
    expect(spec?.description).toBe('export the vault to a file');
  });
});

describe(':export → ExportScreen', () => {
  it('opens the screen and states that values are encrypted and the passphrase is unrecoverable', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Export vault');
    expect(frame).toContain('destination file');
    expect(frame).toContain('export passphrase');
    expect(frame).toContain('confirm export passphrase');
    // The two non-negotiable statements.
    expect(frame).toContain('encrypted under this');
    expect(frame).toContain('NOT recoverable');
    unmount();
  });

  it('prefills the destination from `:export <path>`', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    expect(lastFrame() ?? '').toContain('/tmp/x.json');
    unmount();
  });

  it('masks both passphrase fields — the typed passphrase never reaches the frame', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');

    stdin.write(ENTER); // path → passphrase
    await tick();
    await type(stdin, PASSPHRASE);
    await tick();
    expect(lastFrame()).not.toContain(PASSPHRASE);
    expect(lastFrame()).toContain('••');

    stdin.write(ENTER); // passphrase → confirm
    await tick();
    await type(stdin, PASSPHRASE);
    await tick();
    expect(lastFrame()).not.toContain(PASSPHRASE);
    unmount();
  });

  it('blocks a mismatched passphrase with an inline error and exports nothing', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'something-else');
    stdin.write(ENTER); // submit from the confirm field
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('passphrases do not match');
    // Still on the export screen; nothing was written.
    expect(frame).toContain('Export vault');
    expect(session.exportCount).toBe(0);
    // The error must not quote either passphrase.
    expect(frame).not.toContain(PASSPHRASE);
    expect(frame).not.toContain('something-else');
    unmount();
  });

  it('blocks an empty passphrase with an inline error and exports nothing', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    stdin.write(ENTER); // path → passphrase
    await tick();
    stdin.write(ENTER); // passphrase (empty) → confirm
    await tick();
    stdin.write(ENTER); // submit with nothing typed
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('passphrase is required');
    expect(frame).toContain('Export vault');
    expect(session.exportCount).toBe(0);
    unmount();
  });

  it('blocks an empty destination path', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export'); // no path
    stdin.write(ENTER); // path (empty) → passphrase
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER); // submit
    await tick();

    expect(lastFrame() ?? '').toContain('destination path is required');
    expect(session.exportCount).toBe(0);
    unmount();
  });

  it('exports on a matching passphrase, routes home, and reports the count and destination', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER); // submit
    await tick();

    expect(session.exportCount).toBe(1);
    expect(session.lastExportPath).toBe('/tmp/x.json');

    const frame = lastFrame() ?? '';
    // Back on home (the list is visible again), with a metadata-only status.
    expect(frame).toContain('github/token');
    expect(frame).not.toContain('Export vault');
    expect(frame).toContain('exported 2 secrets to');
    // Neither the passphrase nor any secret value is in the status line/frame.
    expect(frame).not.toContain(PASSPHRASE);
    expect(frame).not.toContain('gh-secret');
    unmount();
  });

  it('Esc cancels the export screen without exporting', async () => {
    const session = seeded();
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ESC);
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Export vault');
    expect(session.exportCount).toBe(0);
    expect(frame).not.toContain(PASSPHRASE);
    unmount();
  });

  it('a failed export keeps the screen open with the error inline (no crash)', async () => {
    const session = seeded();
    // Make the port reject this destination.
    session.exportVault = (): never => {
      throw new Error('EACCES: permission denied');
    };
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /root/x.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Export vault');
    expect(frame).toContain('permission denied');
    expect(frame).not.toContain(PASSPHRASE);
    unmount();
  });

  it('never writes the export passphrase to console/stdout/stderr', async () => {
    const session = seeded();
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

    const { stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':export /tmp/x.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();
    unmount();

    for (const s of spies) {
      s.mockRestore();
    }
    expect(session.exportCount).toBe(1);
    expect(sinks.some((line) => line.includes(PASSPHRASE))).toBe(false);
    expect(sinks.some((line) => line.includes('gh-secret'))).toBe(false);
  });
});

describe(':import detects the file kind', () => {
  it('a KeePass path keeps today’s flow: preview, then Enter imports', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':import /tmp/db.xml');

    // Enter on the prefilled path parses and previews (no passphrase prompt).
    stdin.write(ENTER);
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('Preview (first 10)');
    expect(frame).toContain('Press Enter again to import');
    expect(frame).not.toContain('export passphrase');

    stdin.write(ENTER);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('imported 2');
    expect(session.getSecret('github')).not.toBeNull();
    unmount();
  });

  it('an orbkey export prompts for a MASKED passphrase, then imports', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':import /tmp/vault.json');

    stdin.write(ENTER); // classify the prefilled path
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('orbkey export detected');
    expect(frame).toContain('export passphrase');
    // Not the KeePass path: no preview list.
    expect(frame).not.toContain('Preview (first 10)');

    await type(stdin, PASSPHRASE);
    await tick();
    expect(lastFrame()).not.toContain(PASSPHRASE);
    expect(lastFrame()).toContain('••');

    stdin.write(ENTER);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('imported 2');
    expect(frame).not.toContain(PASSPHRASE);
    expect(session.getSecret('orbkey/restored-1')).not.toBeNull();
    unmount();
  });

  it('a wrong export passphrase reports inline and imports nothing', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':import /tmp/vault.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, 'wrong'); // FakeSession's incorrect-passphrase sentinel
    stdin.write(ENTER);
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('incorrect export passphrase');
    // Still on the import screen, nothing imported.
    expect(frame).toContain('Import orbkey export');
    expect(session.getSecret('orbkey/restored-1')).toBeNull();
    unmount();
  });

  it('`:import <unknown>` refuses with a clear status and never opens the screen', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':import /tmp/notes.txt');

    const frame = lastFrame() ?? '';
    expect(frame).toContain('unrecognized import file');
    expect(frame).not.toContain('file path');
    expect(frame).not.toContain('Preview (first 10)');
    unmount();
  });

  it('an unknown path typed into the screen shows an inline message and does not proceed', async () => {
    const session = new FakeSession({ status: 'OFFLINE' });
    const { lastFrame, stdin, unmount } = render(<App session={session} />);
    await tick();
    await runCommand(stdin, ':import'); // no argument → screen opens empty
    expect(lastFrame() ?? '').toContain('file path');

    await type(stdin, '/tmp/notes.txt');
    stdin.write(ENTER);
    await tick();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('unrecognized file');
    expect(frame).not.toContain('export passphrase');
    expect(frame).not.toContain('Preview (first 10)');
    unmount();
  });

  it('round-trips: export then import the same file back into an empty vault', async () => {
    const source = seeded();
    source.exportVault('/tmp/round.json', PASSPHRASE);

    const target = new FakeSession({ status: 'OFFLINE' });
    // Hand the target the same "file" the source wrote.
    target.exportVault = source.exportVault.bind(source);
    target.detectImportKind = source.detectImportKind.bind(source);
    target.importOrbkey = (path: string, passphrase: string) => {
      const report = source.importOrbkey(path, passphrase);
      for (const key of report.keys) {
        const s = source.getSecret(key);
        if (s && !target.getSecret(key)) {
          target.addSecret(s.key, s.value, s.note, s.labels);
        }
      }
      return { ...report, imported: report.keys.length, skipped: 0 };
    };

    const { lastFrame, stdin, unmount } = render(<App session={target} />);
    await tick();
    await runCommand(stdin, ':import /tmp/round.json');
    stdin.write(ENTER);
    await tick();
    await type(stdin, PASSPHRASE);
    stdin.write(ENTER);
    await tick();

    expect(target.getSecret('github/token')).not.toBeNull();
    expect(target.getSecret('aws/key')).not.toBeNull();
    // Values restored but still never rendered.
    expect(lastFrame()).not.toContain('gh-secret');
    unmount();
  });
});
