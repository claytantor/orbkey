/**
 * Imperative command API — the UI test seam.
 *
 * `makeCommands(session, dispatch, helpers)` returns the full slash-command
 * surface (parity with Python `app._cmd_*`). Tests call `commands.add('')`,
 * `commands.search('git')`, etc. directly, decoupled from keystroke simulation.
 * The CommandBar parses `/cmd arg` and dispatches into the same map.
 *
 * Every mutation bumps `storeVersion` via dispatch(STORE_CHANGED) so the view
 * never goes stale.
 */

import type { Action, ConfirmIntent } from './state.js';
import type { SessionPort, UiConflict } from './types.js';

export interface CommandHelpers {
  /** The current list filter (for selection fallback). */
  getSelectedKey: () => string | null;
  setSelectedKey: (key: string | null) => void;
  /** Copy a secret value; renders a flash and arms auto-clear. */
  copyValue: (value: string) => void;
  /** Report clipboard backend availability. */
  clipInfo: () => string;
  /** Begin the exit/teardown flow. */
  requestExit: () => void;
}

export type Dispatch = (action: Action) => void;

export interface Commands {
  add(arg: string): void;
  edit(arg: string): void;
  label(arg: string): void;
  note(arg: string): void;
  get(arg: string): Promise<void>;
  /** Copy the selected/named secret value to the clipboard (alias of `get`). */
  copy(arg: string): Promise<void>;
  /** Toggle reveal on the selected value. */
  reveal(arg: string): void;
  rm(arg: string): void;
  delete(arg: string): void;
  search(arg: string): void;
  import(arg: string): void;
  sync(arg: string): Promise<void>;
  lock(arg: string): void;
  rotate(arg: string): void;
  clipinfo(arg: string): void;
  help(arg: string): void;
  exit(arg: string): void;
  /** Run a parsed `/cmd arg` or `:cmd arg`. Returns false for an unknown command. */
  run(text: string): boolean | Promise<boolean>;
}

/** A command name + one-line description, for the `:` completion strip. */
export interface CommandSpec {
  name: string;
  description: string;
}

/**
 * The commands surfaced in the `:` completion strip. Only commands that map to
 * REAL functionality appear here — nothing is faked. `copy`/`yank` are the
 * existing get-to-clipboard op; `reveal` is the Ctrl+R toggle; `labels` is the
 * edit flow scoped to labels.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: 'add', description: 'add a new secret' },
  { name: 'edit', description: 'edit the selected secret' },
  { name: 'copy', description: 'copy value to clipboard' },
  { name: 'reveal', description: 'reveal / hide the value' },
  { name: 'labels', description: 'edit labels on the selected secret' },
  { name: 'delete', description: 'delete the selected secret' },
  { name: 'search', description: 'filter the list' },
  { name: 'sync', description: 'push local changes to AWS' },
  { name: 'rotate', description: 'rotate passphrase or IAM key' },
  { name: 'import', description: 'import from a KeePass file' },
  { name: 'lock', description: 'lock the vault' },
  { name: 'clipinfo', description: 'clipboard backend status' },
  { name: 'help', description: 'show the help reference' },
  { name: 'exit', description: 'close the vault and quit' },
];

/**
 * Rank the command specs against a (prefix of a) command name. A simple
 * subsequence fuzzy match: best matches first (exact prefix beats scattered
 * subsequence), stable for ties. Empty query returns all specs in declared
 * order. Pure — easy to unit-test without a terminal.
 */
export function fuzzyComplete(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...COMMAND_SPECS];
  }
  const scored: Array<{ spec: CommandSpec; score: number }> = [];
  for (const spec of COMMAND_SPECS) {
    const name = spec.name.toLowerCase();
    if (name.startsWith(q)) {
      scored.push({ spec, score: 0 });
      continue;
    }
    // Subsequence test.
    let i = 0;
    for (const ch of name) {
      if (ch === q[i]) {
        i += 1;
      }
      if (i === q.length) {
        break;
      }
    }
    if (i === q.length) {
      scored.push({ spec, score: 1 });
    }
  }
  return scored
    .map((s, idx) => ({ ...s, idx }))
    .sort((a, b) => a.score - b.score || a.idx - b.idx)
    .map((s) => s.spec);
}

export function makeCommands(
  session: SessionPort,
  dispatch: Dispatch,
  helpers: CommandHelpers,
): Commands {
  const setStatus = (status: string): void => dispatch({ type: 'SET_STATUS', status });
  const bump = (): void => dispatch({ type: 'STORE_CHANGED' });

  const requireUnlocked = (): boolean => {
    if (session.locked) {
      setStatus('vault is locked');
      return false;
    }
    return true;
  };

  const selectedSecret = (arg: string): ReturnType<SessionPort['getSecret']> => {
    if (arg) {
      return session.getSecret(arg);
    }
    const key = helpers.getSelectedKey();
    return key ? session.getSecret(key) : null;
  };

  const editFlow = (arg: string): void => {
    if (!requireUnlocked()) {
      return;
    }
    const secret = selectedSecret(arg);
    if (!secret) {
      setStatus('no secret selected');
      return;
    }
    dispatch({ type: 'SET_SCREEN', screen: { kind: 'addEdit', mode: 'edit', editingKey: secret.key } });
  };

  const rmFlow = (arg: string): void => {
    if (!requireUnlocked()) {
      return;
    }
    const secret = selectedSecret(arg);
    if (!secret) {
      setStatus('no secret selected');
      return;
    }
    const intent: ConfirmIntent = { kind: 'removeSecret', key: secret.key };
    dispatch({
      type: 'SET_SCREEN',
      screen: {
        kind: 'confirm',
        message: `Delete secret '${secret.key}'? This cannot be undone.`,
        intent,
      },
    });
  };

  const commands: Commands = {
    add(_arg: string): void {
      if (!requireUnlocked()) {
        return;
      }
      dispatch({ type: 'SET_SCREEN', screen: { kind: 'addEdit', mode: 'add' } });
    },

    edit: editFlow,
    label: editFlow,
    note: editFlow,

    async get(arg: string): Promise<void> {
      if (!requireUnlocked()) {
        return;
      }
      if (arg) {
        helpers.setSelectedKey(arg);
      }
      const secret = selectedSecret(arg);
      if (!secret) {
        setStatus('no secret selected');
        return;
      }
      dispatch({ type: 'SET_SELECTED', key: secret.key });
      dispatch({ type: 'SET_REVEALED', revealed: true });
      helpers.copyValue(secret.value);
    },

    async copy(arg: string): Promise<void> {
      await commands.get(arg);
    },

    reveal(_arg: string): void {
      if (!requireUnlocked()) {
        return;
      }
      dispatch({ type: 'TOGGLE_REVEAL' });
    },

    rm: rmFlow,
    delete: rmFlow,

    search(arg: string): void {
      dispatch({ type: 'SET_FILTER', filter: arg });
      const count = session.search(arg).length;
      setStatus(`search: '${arg}' (${count} match)`);
    },

    import(arg: string): void {
      if (!requireUnlocked()) {
        return;
      }
      dispatch({ type: 'SET_SCREEN', screen: { kind: 'import', defaultPath: arg } });
    },

    async sync(_arg: string): Promise<void> {
      if (!requireUnlocked()) {
        return;
      }
      const report = await session.sync();
      if (report.conflict) {
        dispatch({
          type: 'SET_SCREEN',
          screen: { kind: 'conflict', conflict: report.conflict, context: 'sync' },
        });
        return;
      }
      bump();
      setStatus(report.pushed ? 'synced' : 'nothing to push');
    },

    lock(_arg: string): void {
      session.lock();
      dispatch({ type: 'SET_SELECTED', key: null });
      dispatch({ type: 'SET_SCREEN', screen: { kind: 'unlock', error: null } });
    },

    rotate(_arg: string): void {
      if (!requireUnlocked()) {
        return;
      }
      dispatch({ type: 'SET_SCREEN', screen: { kind: 'rotateMenu' } });
    },

    clipinfo(_arg: string): void {
      setStatus(helpers.clipInfo());
    },

    help(_arg: string): void {
      dispatch({ type: 'SET_SCREEN', screen: { kind: 'help' } });
    },

    exit(_arg: string): void {
      helpers.requestExit();
    },

    run(text: string): boolean | Promise<boolean> {
      // Accept BOTH the legacy `/cmd` form (test seam + slash users) and the
      // new `:cmd` form (Variant B command mode). A leading prefix is optional.
      const body = text.startsWith('/') || text.startsWith(':') ? text.slice(1) : text;
      const spaceIdx = body.indexOf(' ');
      const cmd = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
      const arg = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();

      switch (cmd) {
        case 'add':
          commands.add(arg);
          return true;
        case 'edit':
        // `rename` has no dedicated backend op; map it to the closest real
        // command (edit, which can change the key) rather than faking it.
        case 'rename':
          commands.edit(arg);
          return true;
        case 'label':
        case 'labels':
          commands.label(arg);
          return true;
        case 'note':
          commands.note(arg);
          return true;
        case 'get':
        case 'copy':
        case 'yank':
          return commands.get(arg).then(() => true);
        case 'reveal':
          commands.reveal(arg);
          return true;
        case 'rm':
          commands.rm(arg);
          return true;
        case 'delete':
          commands.delete(arg);
          return true;
        case 'search':
          commands.search(arg);
          return true;
        case 'import':
          commands.import(arg);
          return true;
        case 'sync':
          return commands.sync(arg).then(() => true);
        case 'lock':
          commands.lock(arg);
          return true;
        case 'rotate':
          commands.rotate(arg);
          return true;
        case 'clipinfo':
          commands.clipinfo(arg);
          return true;
        case 'help':
          commands.help(arg);
          return true;
        case 'exit':
          commands.exit(arg);
          return true;
        default:
          setStatus(`unknown command: ${cmd}  (try :help)`);
          return false;
      }
    },
  };

  return commands;
}

/**
 * Pick the key selection should land on after `deletedKey` is removed from the
 * currently visible (filtered) list: the previous neighbor, falling back to the
 * next item when the first row is deleted, and null when nothing remains. This
 * keeps the cursor on the row above the deleted one instead of jumping to the
 * top of the list.
 */
export function neighborAfterDelete(
  visible: readonly { key: string }[],
  deletedKey: string,
): string | null {
  const idx = visible.findIndex((s) => s.key === deletedKey);
  if (idx < 0) return visible[0]?.key ?? null;
  return visible[idx - 1]?.key ?? visible[idx + 1]?.key ?? null;
}

/**
 * Resolve a confirmed intent into a Session mutation. When `nextSelectedKey` is
 * provided (UI path), selection is moved there after the delete so the cursor
 * lands on a sensible neighbor rather than resetting to the first row.
 */
export function applyConfirmIntent(
  session: SessionPort,
  intent: ConfirmIntent,
  dispatch: Dispatch,
  nextSelectedKey?: string | null,
): void {
  switch (intent.kind) {
    case 'removeSecret': {
      session.removeSecret(intent.key);
      dispatch({ type: 'STORE_CHANGED' });
      if (nextSelectedKey !== undefined) {
        dispatch({ type: 'SET_SELECTED', key: nextSelectedKey });
      }
      dispatch({ type: 'SET_STATUS', status: `deleted ${intent.key}` });
      return;
    }
    default: {
      const exhaustive: never = intent.kind;
      throw new Error(`unknown intent ${String(exhaustive)}`);
    }
  }
}

export type { UiConflict };
