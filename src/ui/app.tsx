import React, { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import {
  reducer,
  initialState,
  type AppState,
  type Action,
  type Screen,
} from './state.js';
import {
  makeCommands,
  applyConfirmIntent,
  neighborAfterDelete,
  fuzzyComplete,
  type Commands,
  type CommandHelpers,
  type CommandSpec,
} from './commands.js';
import { leaderBindingFor } from './leader.js';
import { useWindowSize } from './hooks/useWindowSize.js';
import { HomeScreen, homeLayout } from './screens/HomeScreen.js';
import { UnlockScreen } from './screens/UnlockScreen.js';
import { FirstRunScreen } from './screens/FirstRunScreen.js';
import { AddEditForm, type AddEditResult } from './components/AddEditForm.js';
import { ConfirmScreen } from './screens/ConfirmScreen.js';
import { ConflictScreen } from './screens/ConflictScreen.js';
import { HelpScreen } from './screens/HelpScreen.js';
import { ImportScreen } from './screens/ImportScreen.js';
import {
  RotateMenuScreen,
  RotatePasswordScreen,
  RotateIamScreen,
} from './screens/RotateScreens.js';
import { classifyError } from './errors.js';
import type {
  ConflictChoice,
  FirstRunInput,
  SessionPort,
  UiConflict,
  UiKeepassEntry,
  UiIamCreds,
} from './types.js';

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return def;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

const AUTOLOCK_SECONDS = envInt('ORBKEY_AUTOLOCK_MIN', 15) * 60;

export interface AppProps {
  session: SessionPort;
  /** Copy a value to the clipboard + flash + arm auto-clear. Injected for tests. */
  onCopyValue?: (value: string) => void;
  /** Probe clipboard backends. */
  clipInfo?: () => string;
  /** Read clipboard (paste-note). */
  readClipboard?: () => string | null;
  /** Initial screen override (tests inject 'home' with an unlocked session). */
  initialScreen?: Screen;
  /** Test hook fired whenever a busy async op settles. */
  onSettle?: () => void;
}

function pickInitialScreen(session: SessionPort, override?: Screen): Screen {
  if (override) {
    return override;
  }
  if (!session.locked) {
    return { kind: 'home' };
  }
  if (session.isFirstRun) {
    return { kind: 'firstRun', error: null };
  }
  return { kind: 'unlock', error: null };
}

export function App({
  session,
  onCopyValue,
  clipInfo,
  readClipboard,
  initialScreen,
  onSettle,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { write: writeStdout } = useStdout();
  const { columns, rows } = useWindowSize();

  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initialState(pickInitialScreen(session, initialScreen)),
  );

  // Imperative UI-only bits that must not trigger re-renders.
  // `commandValueRef` is the single shared bottom-bar buffer: in browse mode it
  // is the live filter; in command mode it is the `:`-command text (sans colon).
  const commandValueRef = useRef('');
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useReducer((_: boolean, v: boolean) => v, false);
  const lastActivityRef = useRef(Date.now());
  const pendingConflictRef = useRef<UiConflict | null>(null);
  // Highlighted completion in `:` command mode (Tab cycles). Reset on buffer edit.
  const [completionIndex, setCompletionIndex] = React.useReducer(
    (_: number, v: number) => v,
    0,
  );
  // 1-based focused field in the inline add/edit form, for the status line. This
  // is REACT STATE (not a ref) so the field counter in the status line actually
  // repaints as focus moves between fields during an edit.
  const [editField, setEditField] = React.useReducer((_: number, v: number) => v, 1);

  const setStatus = useCallback(
    (status: string) => dispatch({ type: 'SET_STATUS', status }),
    [],
  );
  const flash = useCallback((text: string) => {
    dispatch({ type: 'SET_FLASH', flash: text });
  }, []);

  // Auto-clear flash after 2.5s.
  useEffect(() => {
    if (state.flash === null) {
      return;
    }
    const t = setTimeout(() => dispatch({ type: 'SET_FLASH', flash: null }), 2500);
    return () => clearTimeout(t);
  }, [state.flash]);

  // Derived list/detail, memoized on [filter, storeVersion].
  const secrets = useMemo(
    () => (session.locked ? [] : session.search(state.filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, state.filter, state.storeVersion, session.locked],
  );
  const selectedKey =
    state.selectedKey && secrets.some((s) => s.key === state.selectedKey)
      ? state.selectedKey
      : (secrets[0]?.key ?? null);
  // Mirror the live selection into a ref. The command helpers below are built
  // ONCE (stable identity for the test seam), so their closures must read the
  // CURRENT selection through this ref rather than a stale first-render value
  // (null while the vault is still locked) — otherwise selection-based commands
  // like `:edit`/`get`/`rm` always resolve to "no secret selected".
  const selectedKeyRef = useRef<string | null>(selectedKey);
  selectedKeyRef.current = selectedKey;
  const selected = useMemo(
    () => (selectedKey ? session.getSecret(selectedKey) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, selectedKey, state.storeVersion],
  );

  // Fuzzy completions for `:` command mode (derived from the shared buffer).
  const completions: CommandSpec[] =
    state.mode === 'command' ? fuzzyComplete(commandValueRef.current) : [];

  const copyValue = useCallback(
    (value: string) => {
      if (onCopyValue) {
        onCopyValue(value);
      } else {
        flash('copied to clipboard');
      }
    },
    [onCopyValue, flash],
  );

  // Command runner (the test seam). Stable for the session lifetime.
  const commandsRef = useRef<Commands | null>(null);
  if (commandsRef.current === null) {
    const helpers: CommandHelpers = {
      getSelectedKey: () => selectedKeyRef.current,
      setSelectedKey: (key) => dispatch({ type: 'SET_SELECTED', key }),
      copyValue,
      clipInfo: () => (clipInfo ? clipInfo() : 'clipboard: status unknown'),
      requestExit: () => {
        void handleExit();
      },
    };
    commandsRef.current = makeCommands(session, dispatch, helpers);
  }
  // Helpers keep a stable identity (the test seam relies on it); the
  // render-dependent selection is read fresh via selectedKeyRef above.
  const commands = commandsRef.current;

  const handleExit = useCallback(async () => {
    try {
      if (!session.locked) {
        await session.close();
      }
    } finally {
      exit();
    }
  }, [session, exit]);

  // --- leader / command helpers -------------------------------------------
  const enterCommandMode = useCallback(() => {
    commandValueRef.current = '';
    setCompletionIndex(0);
    dispatch({ type: 'SET_FILTER', filter: '' });
    dispatch({ type: 'SET_MODE', mode: 'command' });
    forceRender();
  }, []);

  const exitToBrowse = useCallback(() => {
    commandValueRef.current = '';
    setCompletionIndex(0);
    dispatch({ type: 'SET_FILTER', filter: '' });
    dispatch({ type: 'SET_MODE', mode: 'browse' });
    forceRender();
  }, []);

  // --- global keys (one gated handler) ------------------------------------
  // The inline add/edit form is rendered inside Home (not a modal); it OWNS its
  // own input, so the global handler must not steal arrows / Ctrl+R while it is
  // open. Everything else with `screen.kind !== 'home'` is a real modal.
  const editing = state.screen.kind === 'addEdit';
  const modalOpen = state.screen.kind !== 'home';
  useInput(
    (input, key) => {
      lastActivityRef.current = Date.now();
      // Ctrl+Q / Ctrl+C always exit (clean teardown). We render with
      // exitOnCtrlC:false so we can close the session first, so Ctrl+C must be
      // handled here — otherwise it is dead on every screen, including the
      // unlock/first-run splash.
      if (key.ctrl && (input === 'q' || input === 'c')) {
        void handleExit();
        return;
      }

      // Esc: leave leader/command mode first; then close the inline form; then
      // close a real modal.
      if (key.escape) {
        if (state.mode !== 'browse') {
          exitToBrowse();
          return;
        }
        if (modalOpen) {
          dispatch({ type: 'CLOSE_MODAL' });
        }
        return;
      }

      // The inline form and real modals own the rest of their input.
      if (editing || (modalOpen && state.mode === 'browse')) {
        return;
      }

      // --- LEADER mode: the next listed key runs an action, then closes. -----
      if (state.mode === 'leader') {
        const binding = leaderBindingFor(input);
        if (!binding) {
          // Unknown key cancels the grid (forgiving).
          exitToBrowse();
          return;
        }
        const action = binding.action;
        switch (action.kind) {
          case 'close':
            exitToBrowse();
            return;
          case 'focus-search':
            dispatch({ type: 'SET_MODE', mode: 'browse' });
            return;
          case 'open-command':
            enterCommandMode();
            return;
          case 'command':
            dispatch({ type: 'SET_MODE', mode: 'browse' });
            void Promise.resolve(commands.run(action.command));
            return;
          default: {
            const exhaustive: never = action;
            return exhaustive;
          }
        }
      }

      // --- COMMAND mode: Tab cycles completions; Enter/Esc handled elsewhere. -
      if (state.mode === 'command') {
        if (key.tab) {
          const n = completions.length;
          if (n > 0) {
            setCompletionIndex((completionIndex + (key.shift ? n - 1 : 1)) % n);
          }
          return;
        }
        // Character editing flows through the CommandBar TextField; nothing else.
        return;
      }

      // --- BROWSE mode (Home) -------------------------------------------------
      // Ctrl+Space opens the which-key leader grid. Ctrl+Space arrives as a NUL
      // byte: Ink reports it as ctrl + name '`' (and ' ' on some terminals).
      if (key.ctrl && (input === '`' || input === ' ' || input === '\u0000')) {
        if (!session.locked) {
          dispatch({ type: 'SET_MODE', mode: 'leader' });
        }
        return;
      }
      // `:` on an empty buffer opens command mode. We check the reducer's
      // `filter` (stable during this synchronous event) rather than the bottom-
      // bar ref, because the CommandBar TextField's onChange may have already
      // mutated the ref to ":" in the same keystroke.
      if (input === ':' && state.filter === '' && !session.locked) {
        enterCommandMode();
        return;
      }
      if (key.ctrl && input === 'r') {
        if (!session.locked) {
          dispatch({ type: 'TOGGLE_REVEAL' });
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (secrets.length === 0) {
          return;
        }
        const idx = Math.max(
          0,
          secrets.findIndex((s) => s.key === selectedKey),
        );
        const nextIdx = key.downArrow
          ? Math.min(secrets.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        const next = secrets[nextIdx];
        if (next) {
          dispatch({ type: 'SET_SELECTED', key: next.key });
        }
      }
    },
    { isActive: isRawModeSupported !== false },
  );

  // --- idle auto-lock ------------------------------------------------------
  useEffect(() => {
    if (session.locked) {
      return;
    }
    const interval = setInterval(() => {
      if (session.locked) {
        return;
      }
      if ((Date.now() - lastActivityRef.current) / 1000 >= AUTOLOCK_SECONDS) {
        commands.lock('');
        setStatus('auto-locked due to inactivity');
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [session, commands, setStatus, state.storeVersion, state.screen.kind]);

  // --- command bar ---------------------------------------------------------
  // The bottom-bar input is shared: in command mode the buffer is the `:` command
  // text (sans colon) and edits recompute completions; in browse mode plain text
  // live-filters while a leading `/` is still treated as a legacy command.
  const onCommandChange = useCallback(
    (value: string) => {
      commandValueRef.current = value;
      forceRender();
      if (state.mode === 'command') {
        setCompletionIndex(0);
        return;
      }
      if (!value.startsWith('/')) {
        dispatch({ type: 'SET_FILTER', filter: value });
      }
    },
    [state.mode],
  );

  const onCommandSubmit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (state.mode === 'command') {
        // Run the highlighted completion if present, else the typed command.
        const picked = completions[completionIndex]?.name ?? text;
        commandValueRef.current = '';
        if (picked) {
          dispatch({ type: 'SET_MODE', mode: 'browse' });
          void Promise.resolve(commands.run(`:${picked}`));
        } else {
          exitToBrowse();
        }
        forceRender();
        return;
      }
      // Browse mode. A leading `/` is still a legacy command line.
      if (text.startsWith('/')) {
        commandValueRef.current = '';
        forceRender();
        void Promise.resolve(commands.run(text));
        return;
      }
      // Otherwise Enter opens the edit form for the selected row. Filtering is
      // already live (onCommandChange), so there is nothing to "submit" — Enter
      // is the discoverable filter → move → edit affordance. We keep the filter
      // buffer intact so the list stays where the user left it when the form
      // closes. `commands.edit('')` falls back to the selected key and surfaces
      // "no secret selected" when the filtered list is empty.
      commands.edit('');
    },
    [commands, state.mode, completions, completionIndex, exitToBrowse],
  );

  // --- async helpers -------------------------------------------------------
  const runBusy = useCallback(
    async (fn: () => Promise<void>) => {
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
      } finally {
        busyRef.current = false;
        setBusy(false);
        onSettle?.();
      }
    },
    [onSettle],
  );

  // --- screen handlers -----------------------------------------------------
  const handleUnlock = useCallback(
    (password: string) => {
      if (!password) {
        dispatch({ type: 'SET_SCREEN', screen: { kind: 'unlock', error: 'password required' } });
        return;
      }
      void runBusy(async () => {
        try {
          const result = await session.unlock(password);
          if (result.conflict) {
            pendingConflictRef.current = result.conflict;
            dispatch({
              type: 'SET_SCREEN',
              screen: { kind: 'conflict', conflict: result.conflict, context: 'launch' },
            });
            return;
          }
          dispatch({ type: 'CLOSE_MODAL' });
          dispatch({ type: 'STORE_CHANGED' });
          setStatus(`vault ready (${result.outcome})`);
        } catch (err) {
          dispatch({
            type: 'SET_SCREEN',
            screen: { kind: 'unlock', error: classifyError(err) },
          });
        }
      });
    },
    [runBusy, session, setStatus],
  );

  const handleFirstRun = useCallback(
    (input: FirstRunInput & { passwordConfirm: string }) => {
      if (input.password !== input.passwordConfirm) {
        dispatch({
          type: 'SET_SCREEN',
          screen: { kind: 'firstRun', error: 'passwords do not match' },
        });
        return;
      }
      void runBusy(async () => {
        try {
          const result = await session.firstRun(input);
          dispatch({ type: 'CLOSE_MODAL' });
          dispatch({ type: 'STORE_CHANGED' });
          setStatus(`vault ready (${result.outcome})`);
        } catch (err) {
          dispatch({
            type: 'SET_SCREEN',
            screen: { kind: 'firstRun', error: classifyError(err) },
          });
        }
      });
    },
    [runBusy, session, setStatus],
  );

  const handleAddEditSave = useCallback(
    (result: AddEditResult, mode: 'add' | 'edit', editingKey?: string) => {
      if (!result.key) {
        setStatus('key is required');
        return;
      }
      try {
        if (mode === 'add') {
          session.addSecret(result.key, result.value, result.note, result.labels);
          // "reseal on save": the vault re-encrypts on the existing save path; we
          // surface it as a status string (no new core op).
          setStatus(`added ${result.key} · resealed`);
        } else if (editingKey) {
          session.editSecret(editingKey, {
            newKey: result.key,
            value: result.value,
            note: result.note,
            labels: result.labels,
          });
          setStatus(`updated ${result.key} · resealed`);
        }
        dispatch({ type: 'STORE_CHANGED' });
        dispatch({ type: 'SET_SELECTED', key: result.key });
        dispatch({ type: 'CLOSE_MODAL' });
      } catch (err) {
        setStatus(classifyError(err));
      }
    },
    [session, setStatus],
  );

  const handleConflictChoice = useCallback(
    (choice: ConflictChoice) => {
      const conflict = pendingConflictRef.current;
      if (!conflict) {
        dispatch({ type: 'CLOSE_MODAL' });
        return;
      }
      void runBusy(async () => {
        try {
          const saved = await session.resolveConflict(conflict, choice);
          pendingConflictRef.current = null;
          dispatch({ type: 'STORE_CHANGED' });
          dispatch({ type: 'CLOSE_MODAL' });
          setStatus(
            `conflict resolved (${choice})${saved ? `; local copy saved to ${saved}` : ''}`,
          );
        } catch (err) {
          setStatus(classifyError(err));
        }
      });
    },
    [runBusy, session, setStatus],
  );

  const handleRotatePassword = useCallback(
    (data: { old: string; next: string; confirm: string }) => {
      if (data.next !== data.confirm) {
        dispatch({
          type: 'SET_SCREEN',
          screen: { kind: 'rotatePassword' },
        });
        setStatus('new passwords do not match');
        return;
      }
      try {
        session.rotatePassword(data.old, data.next);
        dispatch({ type: 'CLOSE_MODAL' });
        setStatus('password rotated');
      } catch {
        setStatus('current password incorrect');
      }
    },
    [session, setStatus],
  );

  const handleRotateIam = useCallback(
    (data: { password: string; creds: UiIamCreds }) => {
      try {
        session.rotateIam(data.password, data.creds);
        dispatch({ type: 'CLOSE_MODAL' });
        setStatus('IAM key rotated');
      } catch {
        setStatus('current password incorrect');
      }
    },
    [session, setStatus],
  );

  const handleImport = useCallback(
    (path: string) => {
      try {
        const report = session.importKeepass(path);
        dispatch({ type: 'STORE_CHANGED' });
        dispatch({ type: 'CLOSE_MODAL' });
        setStatus(
          `imported ${report.imported}` +
            (report.skipped ? `, skipped ${report.skipped}` : '') +
            (report.renamed ? `, renamed ${report.renamed}` : '') +
            (report.errors ? `, errors ${report.errors}` : ''),
        );
      } catch (err) {
        setStatus(classifyError(err));
      }
    },
    [session, setStatus],
  );

  const parseKeepass = useCallback(
    (path: string): UiKeepassEntry[] | { error: string } => {
      try {
        return session.parseKeepass(path);
      } catch (err) {
        return { error: classifyError(err) };
      }
    },
    [session],
  );

  // --- non-TTY fallback ----------------------------------------------------
  if (isRawModeSupported === false) {
    return (
      <Box flexDirection="column">
        <Text>orbkey requires an interactive terminal (raw mode unavailable).</Text>
        <Text dimColor>
          Run in a TTY, or use a non-interactive CLI mode (not yet implemented).
        </Text>
      </Box>
    );
  }

  // The Home screen is shared by the browse view and the inline add/edit form
  // (Variant A: the form lives in the detail pane while the list stays visible).
  const renderHome = (editForm?: React.ReactNode, editLabel?: string): React.ReactElement => (
    <HomeScreen
      vaultName="default"
      status={session.status}
      locked={session.locked}
      account={session.accountContext()}
      secrets={secrets}
      selected={selected}
      selectedKey={selectedKey}
      revealed={state.revealed}
      statusText={state.status}
      flash={state.flash}
      mode={state.mode}
      filter={state.filter}
      commandValue={commandValueRef.current}
      onCommandChange={onCommandChange}
      onCommandSubmit={onCommandSubmit}
      // The bottom command bar must be INACTIVE while the inline add/edit form is
      // open so the form owns ALL keystrokes (Tab cycling, typing, Ctrl+S). When
      // the bar is active its TextField registers a competing `useInput` that
      // fights the form for keys. `editForm !== undefined` is the same signal
      // HomeScreen uses to render the form into the detail slot.
      commandActive={editForm === undefined}
      completions={completions}
      completionIndex={completionIndex}
      columns={columns}
      rows={rows}
      {...(editForm !== undefined ? { editForm } : {})}
      {...(editLabel !== undefined ? { editLabel } : {})}
      editField={editField}
    />
  );

  // --- modal router ("swap, don't stack") ---------------------------------
  const screen = state.screen;
  switch (screen.kind) {
    case 'home':
      return renderHome();
    case 'unlock':
      return (
        <UnlockScreen
          error={screen.error}
          busy={busy}
          onSubmit={handleUnlock}
          vaultName="default"
          account={session.accountContext()}
          status={session.status}
          columns={columns}
          rows={rows}
        />
      );
    case 'firstRun':
      return (
        <FirstRunScreen
          isActive
          busy={busy}
          error={screen.error}
          onSubmit={handleFirstRun}
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    case 'addEdit': {
      const editingKey = screen.mode === 'edit' ? screen.editingKey : undefined;
      const initial = editingKey ? session.getSecret(editingKey) : null;
      const form = (
        <AddEditForm
          mode={screen.mode}
          initial={initial}
          isActive
          width={homeLayout(columns).detailWidth}
          onSave={(r) => handleAddEditSave(r, screen.mode, editingKey)}
          onCopyNote={(noteText) => {
            if (noteText) {
              copyValue(noteText);
            } else {
              setStatus('note is empty');
            }
          }}
          onPasteNote={() => (readClipboard ? readClipboard() : null)}
          onFieldChange={(f) => {
            setEditField(f);
          }}
        />
      );
      return renderHome(form, screen.mode === 'add' ? 'ADD' : 'EDIT');
    }
    case 'confirm':
      return (
        <ConfirmScreen
          message={screen.message}
          isActive
          onConfirm={() => {
            // Land selection on the previous neighbor (computed against the
            // current filtered view) instead of letting it fall back to row 0.
            const next =
              screen.intent.kind === 'removeSecret'
                ? neighborAfterDelete(secrets, screen.intent.key)
                : undefined;
            applyConfirmIntent(session, screen.intent, dispatch, next);
            dispatch({ type: 'CLOSE_MODAL' });
          }}
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    case 'conflict':
      return <ConflictScreen isActive busy={busy} onChoose={handleConflictChoice} />;
    case 'help':
      return <HelpScreen />;
    case 'import':
      return (
        <ImportScreen
          defaultPath={screen.defaultPath}
          isActive
          onParse={parseKeepass}
          onImport={handleImport}
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    case 'rotateMenu':
      return (
        <RotateMenuScreen
          isActive
          onChoose={(choice) =>
            dispatch({
              type: 'SET_SCREEN',
              screen: choice === 'password' ? { kind: 'rotatePassword' } : { kind: 'rotateIam' },
            })
          }
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    case 'rotatePassword':
      return (
        <RotatePasswordScreen
          isActive
          error={null}
          onSubmit={handleRotatePassword}
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    case 'rotateIam':
      return (
        <RotateIamScreen
          isActive
          error={null}
          onSubmit={handleRotateIam}
          onCancel={() => dispatch({ type: 'CLOSE_MODAL' })}
        />
      );
    default: {
      const exhaustive: never = screen;
      return <Text>unknown screen {String(exhaustive)}</Text>;
    }
  }
}

export type { AppState, Action };
