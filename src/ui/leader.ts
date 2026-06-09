/**
 * The which-key leader bindings (Variant B).
 *
 * A single source of truth shared by the grid overlay (`WhichKeyGrid`) and the
 * key dispatcher in `app.tsx`, so the cheat-sheet can never drift from what the
 * keys actually do. Every entry maps to REAL functionality — there are no faked
 * actions. `action` is interpreted by the app:
 *   - a command name → `commands.run(name)`
 *   - `focus-search` → switch the prompt into live-filter focus (browse)
 *   - `command`      → open `:` command mode
 *   - `close`        → leave leader mode
 */
export type LeaderAction =
  | { kind: 'command'; command: string }
  | { kind: 'focus-search' }
  | { kind: 'open-command' }
  | { kind: 'close' };

export interface LeaderBinding {
  key: string;
  label: string;
  action: LeaderAction;
}

export const LEADER_BINDINGS: readonly LeaderBinding[] = [
  { key: 'a', label: 'add', action: { kind: 'command', command: 'add' } },
  { key: 'e', label: 'edit', action: { kind: 'command', command: 'edit' } },
  { key: 'c', label: 'copy/yank', action: { kind: 'command', command: 'copy' } },
  { key: 'r', label: 'reveal', action: { kind: 'command', command: 'reveal' } },
  { key: 'd', label: 'delete', action: { kind: 'command', command: 'delete' } },
  { key: 'l', label: 'labels', action: { kind: 'command', command: 'labels' } },
  { key: '/', label: 'search', action: { kind: 'focus-search' } },
  { key: 's', label: 'sync', action: { kind: 'command', command: 'sync' } },
  { key: '?', label: 'help', action: { kind: 'command', command: 'help' } },
  { key: ':', label: 'command', action: { kind: 'open-command' } },
  { key: 'q', label: 'quit', action: { kind: 'command', command: 'exit' } },
  { key: 'esc', label: 'close', action: { kind: 'close' } },
];

/** Look up a binding by the pressed key (case-sensitive single char). */
export function leaderBindingFor(key: string): LeaderBinding | undefined {
  return LEADER_BINDINGS.find((b) => b.key === key);
}
