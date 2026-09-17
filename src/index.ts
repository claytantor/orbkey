#!/usr/bin/env node
/**
 * orbkey CLI entry. Parses argv first (`--help`, `--version`, `--update`), and
 * with no flags renders the Ink app over the real Session (via the adapter).
 * Branches on TTY / raw-mode availability and degrades gracefully.
 */

import React from 'react';
import { render } from 'ink';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './ui/app.js';
import { Session } from './core/session.js';
import { SessionAdapter } from './sessionAdapter.js';
import {
  CLIPBOARD_CLEAR_SECONDS,
  clipboardInfo,
  copyToClipboard,
  readClipboard,
} from './clipboard.js';
import {
  UPDATED_ENV_MARKER,
  parseArgs,
  readVersion,
  reexecArgs,
  usage,
} from './cli.js';
import {
  NOT_A_CHECKOUT_MESSAGE,
  findInstallDir,
  realUpdateIo,
  selfUpdate,
} from './update/selfUpdate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `--update` runs entirely outside Ink: plain stdout, plain stderr, and a
 * synchronous confirmation prompt. Returns the process exit code.
 */
function runUpdate(opts: { yes: boolean; dryRun: boolean }): number {
  const installDir = findInstallDir(HERE, realUpdateIo);
  if (installDir === null) {
    process.stderr.write(`${NOT_A_CHECKOUT_MESSAGE}\n`);
    return 1;
  }

  // The confirmation prompt needs a terminal. A dry run never prompts.
  if (!opts.dryRun && !opts.yes && process.stdin.isTTY !== true) {
    process.stderr.write(
      'orbkey --update needs a terminal to confirm the update.\n' +
        'Re-run it in a terminal, or pass --yes to update without confirming.\n',
    );
    return 1;
  }

  const result = selfUpdate(realUpdateIo, {
    yes: opts.yes,
    dryRun: opts.dryRun,
    installDir,
  });
  const stream = result.code === 0 ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);

  if (!result.ok || result.updatedTo === undefined) return result.code;

  // Re-exec the freshly built program. Guarded twice against looping: the env
  // marker, and argv with every update flag stripped.
  if (process.env[UPDATED_ENV_MARKER] === '1') return 0;
  if (process.stdout.isTTY !== true) return 0; // nothing to relaunch into
  const entry = join(installDir, 'dist', 'index.js');
  if (!realUpdateIo.exists(entry)) {
    process.stderr.write(`orbkey: rebuilt entry point is missing at ${entry}\n`);
    return 1;
  }
  const child = spawnSync(process.execPath, [entry, ...reexecArgs(process.argv.slice(2))], {
    stdio: 'inherit',
    env: { ...process.env, [UPDATED_ENV_MARKER]: '1' },
  });
  return child.status ?? 0;
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  switch (command.kind) {
    case 'help':
      process.stdout.write(usage());
      return;
    case 'version':
      process.stdout.write(`orbkey ${readVersion(HERE) ?? 'unknown'}\n`);
      return;
    case 'error':
      process.stderr.write(`orbkey: ${command.message}\n\n${usage()}`);
      process.exitCode = 2;
      return;
    case 'update':
      process.exitCode = runUpdate({ yes: command.yes, dryRun: command.dryRun });
      return;
    case 'tui':
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled command: ${JSON.stringify(exhaustive)}`);
    }
  }

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
      writeRaw: (d) => process.stdout.write(`${d}`),
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
