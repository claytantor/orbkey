/**
 * Clipboard with two backends and an auto-clear timer.
 *
 * - Native (clipboardy → wl-copy/xclip/pbcopy): talks to the desktop clipboard
 *   directly and DOES throw when no backend exists, so it is our source of truth
 *   for whether the copy really landed.
 * - OSC 52: asks the terminal to set the clipboard. Great over SSH/tmux, but some
 *   terminals (e.g. Gnome Terminal) silently drop it AND never error, so we
 *   cannot treat "no exception" as success.
 *
 * NEVER logs the value. The auto-clear timer is returned so callers can cancel
 * it on unmount (a leaked timer keeps Node alive and corrupts exit).
 */

import clipboard from 'clipboardy';

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return def;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

export const CLIPBOARD_CLEAR_SECONDS = envInt('ORBKEY_CLIP_CLEAR_SEC', 30);

/** OSC 52 escape sequence to set the clipboard. base64 of the value. */
function osc52(value: string): string {
  const b64 = Buffer.from(value, 'utf-8').toString('base64');
  return `]52;c;${b64}`;
}

export interface CopyResult {
  nativeOk: boolean;
  osc52Sent: boolean;
  /** Active clear timer; cancel on unmount/lock. */
  clearTimer: NodeJS.Timeout | null;
}

export interface CopyDeps {
  /** Write a raw escape sequence to the terminal (Ink's stdout.write). */
  writeRaw?: (data: string) => void;
  /** Schedule the auto-clear (defaults to setTimeout). */
  schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

/** Copy a value; returns which backends succeeded plus the clear timer. */
export function copyToClipboard(value: string, deps: CopyDeps = {}): CopyResult {
  const writeRaw = deps.writeRaw ?? ((d: string) => process.stdout.write(d));
  const schedule = deps.schedule ?? setTimeout;

  let osc52Sent = false;
  try {
    writeRaw(osc52(value));
    osc52Sent = true;
  } catch {
    osc52Sent = false;
  }

  let nativeOk = false;
  try {
    clipboard.writeSync(value);
    nativeOk = true;
  } catch {
    nativeOk = false;
  }

  if (value === '') {
    return { nativeOk, osc52Sent, clearTimer: null };
  }

  let clearTimer: NodeJS.Timeout | null = null;
  if (nativeOk || osc52Sent) {
    clearTimer = schedule(() => {
      clearClipboard({ writeRaw });
    }, CLIPBOARD_CLEAR_SECONDS * 1000);
  }
  return { nativeOk, osc52Sent, clearTimer };
}

export function clearClipboard(deps: Pick<CopyDeps, 'writeRaw'> = {}): void {
  const writeRaw = deps.writeRaw ?? ((d: string) => process.stdout.write(d));
  try {
    writeRaw(osc52(''));
  } catch {
    /* ignore */
  }
  try {
    clipboard.writeSync('');
  } catch {
    /* ignore */
  }
}

/** Read the native clipboard (used by /clipinfo and paste-note). */
export function readClipboard(): string {
  return clipboard.readSync();
}

/** Probe which backends are available without copying anything sensitive. */
export function clipboardInfo(): { nativeReady: boolean; detail: string } {
  try {
    clipboard.readSync();
    return { nativeReady: true, detail: 'native ready' };
  } catch (err) {
    const name = (err as Error).name ?? 'Error';
    return { nativeReady: false, detail: `native unavailable (${name})` };
  }
}
