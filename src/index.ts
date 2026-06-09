#!/usr/bin/env node
/**
 * orbkey CLI entry. Renders the Ink app over the real Session (via the adapter).
 * Branches on TTY / raw-mode availability and degrades gracefully.
 */

import React from 'react';
import { render } from 'ink';
import { App } from './ui/app.js';
import { Session } from './core/session.js';
import { SessionAdapter } from './sessionAdapter.js';
import {
  CLIPBOARD_CLEAR_SECONDS,
  clipboardInfo,
  copyToClipboard,
  readClipboard,
} from './clipboard.js';

async function main(): Promise<void> {
  const isTty = process.stdout.isTTY === true;
  if (!isTty) {
    process.stderr.write(
      'orbkey is an interactive TUI and requires a TTY. ' +
        'Run it directly in a terminal.\n',
    );
    process.exitCode = 1;
    return;
  }

  const session = new SessionAdapter(new Session());

  // Track clipboard clear timers so they can't keep the process alive.
  const timers = new Set<NodeJS.Timeout>();

  const onCopyValue = (value: string): void => {
    const result = copyToClipboard(value, {
      writeRaw: (d) => process.stdout.write(`${d}`),
    });
    if (result.clearTimer) {
      timers.add(result.clearTimer);
    }
  };

  const { waitUntilExit, clear } = render(
    React.createElement(App, {
      session,
      onCopyValue,
      clipInfo: () => {
        const info = clipboardInfo();
        return `clipboard — ${info.detail} · clears in ${CLIPBOARD_CLEAR_SECONDS}s after copy`;
      },
      readClipboard: () => {
        try {
          return readClipboard();
        } catch {
          return null;
        }
      },
    }),
    {
      patchConsole: true,
      exitOnCtrlC: false, // we own Ctrl+Q teardown
    },
  );

  await waitUntilExit();
  for (const t of timers) {
    clearTimeout(t);
  }
  clear();
}

main().catch((err: unknown) => {
  // Never print secret values; only a terse classification.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`orbkey: fatal: ${message}\n`);
  process.exitCode = 1;
});
