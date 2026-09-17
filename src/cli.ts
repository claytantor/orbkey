/**
 * Argv parsing for the `orbkey` binary.
 *
 * Everything here runs BEFORE Ink: with no flags the result is `tui` and
 * `src/index.ts` renders exactly as it always has.
 *
 * `parseArgs` and `reexecArgs` are pure so they can be tested as plain calls;
 * `readVersion` is the one function that touches the filesystem.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

export type Command =
  | { kind: 'tui' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'update'; yes: boolean; dryRun: boolean }
  | { kind: 'error'; message: string };

/** Flags stripped from argv before re-exec, so an update can never loop. */
export const UPDATE_FLAGS: readonly string[] = ['--update', '--yes', '-y', '--dry-run'];

/** Set when the re-exec'd child starts, so it never updates again. */
export const UPDATED_ENV_MARKER = 'ORBKEY_UPDATED';

export function usage(): string {
  return [
    'orbkey — an AWS-backed, local-first secrets vault in your terminal.',
    '',
    'Usage:',
    '  orbkey                       launch the interactive TUI',
    '  orbkey --version, -v         print the installed version',
    '  orbkey --help, -h            show this help',
    '  orbkey --update              update to the newest tagged release, then relaunch',
    '  orbkey --update --yes, -y    update without the confirmation prompt',
    '  orbkey --update --dry-run    report what an update would do, change nothing',
    '',
    'The updater only ever touches the git checkout orbkey runs from. It never',
    'reads your vault, your keychain, your config or your AWS credentials.',
    '',
  ].join('\n');
}

/**
 * Parse argv (without `node` and the script path).
 * Unknown flags and stray positional arguments are errors — the caller prints
 * usage to stderr and exits 2.
 */
export function parseArgs(argv: readonly string[]): Command {
  let help = false;
  let version = false;
  let update = false;
  let yes = false;
  let dryRun = false;

  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      case '--update':
        update = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        return { kind: 'error', message: `unknown argument: ${arg}` };
    }
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  if (update) return { kind: 'update', yes, dryRun };
  if (yes || dryRun) {
    return {
      kind: 'error',
      message: `${dryRun ? '--dry-run' : '--yes'} only makes sense with --update`,
    };
  }
  return { kind: 'tui' };
}

/** The original argv with every update-related flag removed. */
export function reexecArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => !UPDATE_FLAGS.includes(arg));
}

/**
 * Read the installed version out of the nearest package.json at or above
 * `startDir`. Returns null when it cannot be determined.
 */
export function readVersion(startDir: string): string | null {
  let dir = startDir;
  const root = parsePath(dir).root;
  for (;;) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
        const version = (parsed as { version: unknown }).version;
        if (typeof version === 'string' && version.trim() !== '') return version.trim();
      }
      return null;
    } catch {
      // fall through and walk up
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
