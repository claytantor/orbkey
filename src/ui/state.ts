/**
 * App-level UI state + a pure reducer.
 *
 * The reducer never calls the Session (so it unit-tests with zero AWS). Every
 * Session mutation funnels through `useCommandRunner`, which dispatches
 * STORE_CHANGED to bump `storeVersion`; derived list/detail are memoized on
 * `[filter, storeVersion]`.
 */

import type { UiConflict } from './types.js';

/** A discriminated union of every screen. Exhaustive `switch` + `never` default. */
export type Screen =
  | { kind: 'home' }
  | { kind: 'unlock'; error: string | null }
  | { kind: 'firstRun'; error: string | null }
  | { kind: 'addEdit'; mode: 'add' }
  | { kind: 'addEdit'; mode: 'edit'; editingKey: string }
  | { kind: 'confirm'; message: string; intent: ConfirmIntent }
  | { kind: 'conflict'; conflict: UiConflict; context: 'launch' | 'sync' }
  | { kind: 'help' }
  | { kind: 'import'; defaultPath: string }
  | { kind: 'rotateMenu' }
  | { kind: 'rotatePassword' }
  | { kind: 'rotateIam' };

/** The yes-action carried by a confirm dialog (replaces Python's _removing_key). */
export type ConfirmIntent = { kind: 'removeSecret'; key: string };

/**
 * The bottom-bar input model on the Home screen (the "hybrid" grammar):
 *   - `browse`  — bare typing live-filters the list (preserves today's behavior).
 *   - `leader`  — the which-key grid is open (entered via Ctrl+Space); the next
 *                 listed key runs an action and closes the grid.
 *   - `command` — `:`-prefixed command mode with a fuzzy completion strip.
 * Orthogonal to `screen`: a `UiMode` only ever matters while `screen.kind` is
 * `home`; opening a modal resets it to `browse`.
 */
export type UiMode = 'browse' | 'leader' | 'command';

export interface AppState {
  screen: Screen;
  /** Home bottom-bar input model. */
  mode: UiMode;
  filter: string;
  /** Bumped after every Session mutation to recompute derived data. */
  storeVersion: number;
  /** Currently highlighted secret key in the list (selection). */
  selectedKey: string | null;
  /** Whether the detail value is revealed. */
  revealed: boolean;
  /** Persistent status line text. */
  status: string;
  /** Transient flash text; when set, overrides `status` until it clears. */
  flash: string | null;
}

export type Action =
  | { type: 'SET_SCREEN'; screen: Screen }
  | { type: 'CLOSE_MODAL' }
  | { type: 'STORE_CHANGED' }
  | { type: 'SET_MODE'; mode: UiMode }
  | { type: 'SET_FILTER'; filter: string }
  | { type: 'SET_SELECTED'; key: string | null }
  | { type: 'SET_REVEALED'; revealed: boolean }
  | { type: 'TOGGLE_REVEAL' }
  | { type: 'SET_STATUS'; status: string }
  | { type: 'SET_FLASH'; flash: string | null };

export function initialState(screen: Screen): AppState {
  return {
    screen,
    mode: 'browse',
    filter: '',
    storeVersion: 0,
    selectedKey: null,
    revealed: false,
    status: '',
    flash: null,
  };
}

/**
 * A short, uppercase mode label for the status bar, derived purely from the
 * active screen, lock state, and (on Home) the input mode. Never includes
 * secret data.
 */
export function modeLabel(screen: Screen, locked: boolean, mode: UiMode = 'browse'): string {
  switch (screen.kind) {
    case 'home':
      if (locked) {
        return 'LOCKED';
      }
      switch (mode) {
        case 'leader':
          return '-- LEADER --';
        case 'command':
          return 'COMMAND';
        case 'browse':
          return 'UNLOCKED';
        default: {
          const exhaustiveMode: never = mode;
          return String(exhaustiveMode);
        }
      }
    case 'unlock':
      return 'UNLOCK';
    case 'firstRun':
      return 'FIRST-RUN';
    case 'addEdit':
      return screen.mode === 'add' ? 'ADD' : 'EDIT';
    case 'confirm':
      return 'CONFIRM';
    case 'conflict':
      return 'CONFLICT';
    case 'help':
      return 'HELP';
    case 'import':
      return 'IMPORT';
    case 'rotateMenu':
      return 'ROTATE';
    case 'rotatePassword':
      return 'ROTATE-PW';
    case 'rotateIam':
      return 'ROTATE-IAM';
    default: {
      const exhaustive: never = screen;
      return String(exhaustive);
    }
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_SCREEN':
      // Opening any non-home screen resets the Home input model to browse so a
      // stale leader/command mode never lingers behind a modal.
      return {
        ...state,
        screen: action.screen,
        mode: action.screen.kind === 'home' ? state.mode : 'browse',
      };
    case 'CLOSE_MODAL':
      return { ...state, screen: { kind: 'home' }, mode: 'browse' };
    case 'STORE_CHANGED':
      return { ...state, storeVersion: state.storeVersion + 1 };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'SET_FILTER':
      return { ...state, filter: action.filter };
    case 'SET_SELECTED':
      // Changing selection always re-masks the value.
      return { ...state, selectedKey: action.key, revealed: false };
    case 'SET_REVEALED':
      return { ...state, revealed: action.revealed };
    case 'TOGGLE_REVEAL':
      return { ...state, revealed: !state.revealed };
    case 'SET_STATUS':
      return { ...state, status: action.status, flash: null };
    case 'SET_FLASH':
      return { ...state, flash: action.flash };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
