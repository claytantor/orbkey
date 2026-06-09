import React from 'react';
import { Box } from 'ink';
import { VaultHeader } from '../components/VaultHeader.js';
import { SecretList } from '../components/SecretList.js';
import { DetailPane } from '../components/DetailPane.js';
import { StatusLine } from '../components/StatusLine.js';
import { CommandBar } from '../components/CommandBar.js';
import { WhichKeyGrid, whichKeyRowCount } from '../components/WhichKeyGrid.js';
import { CommandStrip, commandStripRowCount } from '../components/CommandStrip.js';
import { modeLabel, type UiMode } from '../state.js';
import type { CommandSpec } from '../commands.js';
import type { AccountContext, UiSecret, UiSyncStatus } from '../types.js';

interface Props {
  vaultName: string;
  status: UiSyncStatus;
  locked: boolean;
  account: AccountContext;
  secrets: UiSecret[];
  selected: UiSecret | null;
  selectedKey: string | null;
  revealed: boolean;
  statusText: string;
  flash: string | null;
  /** Home input model (browse / leader / command). */
  mode: UiMode;
  filter: string;
  commandValue: string;
  onCommandChange: (value: string) => void;
  onCommandSubmit: (value: string) => void;
  commandActive: boolean;
  /** Fuzzy completions for `:` command mode (empty otherwise). */
  completions: CommandSpec[];
  /** Highlighted completion index (Tab cycles). */
  completionIndex: number;
  /**
   * When set, the detail pane renders this inline add/edit form instead of the
   * read-only DetailPane (Variant A). The list stays visible on the left.
   */
  editForm?: React.ReactNode;
  /** EDIT/ADD field label for the status line, e.g. "ADD" / "EDIT". */
  editLabel?: string;
  /** 1-based field position within the edit form, for the status line. */
  editField?: number;
  columns: number;
  rows: number;
}

// Fixed chrome that always surrounds the body:
//   header     = 2 rows (1 content + 1 bottom border)
//   status bar = 1 row
//   command bar= 1 row
// Plus a DYNAMIC sub-options strip (which-key grid / completion list) whose
// height depends on the current mode. `chromeRows = BASE + suboptRows(mode)` and
// the body re-derives from it, so the status/command bars stay pinned to the
// bottom no matter how tall the sub-options strip is.
const HEADER_ROWS = 2;
const STATUS_ROWS = 1;
const COMMAND_ROWS = 1;
const BASE_CHROME_ROWS = HEADER_ROWS + STATUS_ROWS + COMMAND_ROWS;

/**
 * The list / detail split for a given terminal width. Exported so the inline
 * add/edit form (rendered by the app into the detail slot) sizes itself to the
 * exact same detail width the read-only DetailPane would use.
 */
export function homeLayout(columns: number): { listWidth: number; detailWidth: number } {
  const cols = Math.max(1, columns);
  const listWidth = Math.min(
    Math.max(12, Math.floor(cols * 0.4)),
    Math.max(12, cols - 13),
  );
  const detailWidth = Math.max(1, cols - listWidth - 1);
  return { listWidth, detailWidth };
}

/** Rows consumed by the sub-options strip for the current mode. */
export function suboptRows(
  mode: UiMode,
  columns: number,
  completionMatches: number,
): number {
  switch (mode) {
    case 'leader':
      return whichKeyRowCount(columns);
    case 'command':
      return commandStripRowCount(completionMatches);
    case 'browse':
      return 0;
    default: {
      const exhaustive: never = mode;
      return Number(exhaustive);
    }
  }
}

/** Home (no modal): header / list+detail / [sub-options] / status bar / command bar. */
export function HomeScreen(props: Props): React.ReactElement {
  const columns = Math.max(1, props.columns);

  const suboptionRows = suboptRows(props.mode, columns, props.completions.length);
  const chromeRows = BASE_CHROME_ROWS + suboptionRows;
  const rows = Math.max(chromeRows + 1, props.rows);

  // List takes ~40% of the width, the detail pane the rest (minus the 1-col
  // divider border). Clamp so neither pane collapses on narrow terminals.
  const { listWidth, detailWidth } = homeLayout(columns);

  // Body rows = everything not consumed by the (now dynamic) chrome. Always >= 1.
  const bodyRows = Math.max(1, rows - chromeRows);

  const editing = props.editForm !== undefined;
  const mode = editing
    ? (props.editLabel ?? 'EDIT')
    : modeLabel({ kind: 'home' }, props.locked, props.mode);
  const position =
    props.selectedKey !== null
      ? props.secrets.findIndex((s) => s.key === props.selectedKey) + 1 || null
      : null;

  // Status line content: edit mode shows the field counter + reseal note; the
  // command mode shows the completion count + key hints; otherwise the normal
  // selection summary lives in StatusLine itself.
  let statusOverrideLeft: string | null = null;
  let statusOverrideRight: string | null = null;
  if (editing) {
    const field = props.editField ?? 1;
    statusOverrideLeft = `${mode} · field ${field}/4`;
    statusOverrideRight = 'reseal on save';
  } else if (props.mode === 'command') {
    const n = props.completions.length;
    statusOverrideLeft = `COMMAND · ${n} match${n === 1 ? '' : 'es'}`;
    statusOverrideRight = '⇥ complete · ↵ run';
  } else if (props.mode === 'leader') {
    statusOverrideLeft = '-- LEADER -- · press a key';
    statusOverrideRight = 'esc cancel';
  } else if (props.filter) {
    const n = props.secrets.length;
    statusOverrideLeft = `FILTER · "${props.filter}" · ${position ?? 0}/${n} match`;
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <VaultHeader
        vaultName={props.vaultName}
        status={props.status}
        locked={props.locked}
        account={props.account}
        columns={columns}
        {...(editing || props.mode !== 'browse'
          ? { mode: editing ? mode : modeLabel({ kind: 'home' }, props.locked, props.mode) }
          : {})}
      />
      <Box height={bodyRows} overflow="hidden">
        <Box
          height={bodyRows}
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
        >
          <SecretList
            secrets={props.secrets}
            selectedKey={props.selectedKey}
            viewportRows={bodyRows}
            width={listWidth}
            highlight={props.filter}
          />
        </Box>
        {editing ? (
          <Box width={detailWidth} overflow="hidden">
            {props.editForm}
          </Box>
        ) : (
          <DetailPane
            secret={props.selected}
            revealed={props.revealed}
            width={detailWidth}
            rows={bodyRows}
          />
        )}
      </Box>
      {props.mode === 'leader' ? (
        <WhichKeyGrid vaultName={props.vaultName} columns={columns} />
      ) : null}
      {props.mode === 'command' ? (
        <CommandStrip
          completions={props.completions}
          selected={props.completionIndex}
          columns={columns}
        />
      ) : null}
      <StatusLine
        mode={mode}
        revealed={props.revealed}
        selectedKey={props.selectedKey}
        position={position}
        total={props.secrets.length}
        status={props.statusText}
        flash={props.flash}
        columns={columns}
        {...(statusOverrideLeft !== null ? { overrideLeft: statusOverrideLeft } : {})}
        {...(statusOverrideRight !== null ? { overrideRight: statusOverrideRight } : {})}
      />
      <CommandBar
        value={props.commandValue}
        onChange={props.onCommandChange}
        onSubmit={props.onCommandSubmit}
        // The bottom-bar input is live in browse (filter) and command (the `:`
        // buffer) modes, but DISABLED while the leader grid is up (its keys are
        // actions, not text) or while the inline form owns input.
        isActive={props.commandActive && !editing && props.mode !== 'leader'}
        glyph={props.mode === 'command' ? ':' : undefined}
      />
    </Box>
  );
}
