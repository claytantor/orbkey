/** Command runner + reducer logic, decoupled from Ink (parity with app._cmd_*). */
import { describe, it, expect, vi } from 'vitest';
import { FakeSession } from '../../src/ui/FakeSession.js';
import {
  makeCommands,
  applyConfirmIntent,
  neighborAfterDelete,
  fuzzyComplete,
  COMMAND_SPECS,
} from '../../src/ui/commands.js';
import { reducer, initialState } from '../../src/ui/state.js';
import type { Action } from '../../src/ui/state.js';

function harness(session = new FakeSession()) {
  let state = initialState({ kind: 'home' });
  const dispatch = (a: Action): void => {
    state = reducer(state, a);
  };
  const copied: string[] = [];
  const commands = makeCommands(session, dispatch, {
    getSelectedKey: () => state.selectedKey,
    setSelectedKey: (key) => dispatch({ type: 'SET_SELECTED', key }),
    copyValue: (v) => copied.push(v),
    clipInfo: () => 'clip ok',
    requestExit: () => undefined,
  });
  return {
    session,
    commands,
    copied,
    dispatch,
    select: (key: string | null): void => dispatch({ type: 'SET_SELECTED', key }),
    get state() {
      return state;
    },
  };
}

describe('commands', () => {
  it('/add opens the add modal', () => {
    const h = harness();
    h.commands.add('');
    expect(h.state.screen.kind).toBe('addEdit');
  });

  it('/search sets the filter and reports a count', () => {
    const session = new FakeSession();
    session.addSecret('github/token', 'a', '', ['dev']);
    session.addSecret('gitlab/token', 'b', '', ['dev']);
    session.addSecret('aws/key', 'c', '', ['cloud']);
    const h = harness(session);
    h.commands.search('git');
    expect(h.state.filter).toBe('git');
    expect(h.state.status).toContain('2 match');
    const keys = new Set(session.search('git').map((s) => s.key));
    expect(keys).toEqual(new Set(['github/token', 'gitlab/token']));
  });

  it('/lock locks and routes to unlock', () => {
    const session = new FakeSession();
    session.addSecret('k', 'v');
    const h = harness(session);
    h.commands.lock('');
    expect(session.locked).toBe(true);
    expect(h.state.screen.kind).toBe('unlock');
  });

  it('/rm opens a confirm carrying the remove intent', () => {
    const session = new FakeSession();
    session.addSecret('doomed', 'x');
    const h = harness(session);
    h.commands.rm('doomed');
    expect(h.state.screen.kind).toBe('confirm');
    if (h.state.screen.kind === 'confirm') {
      expect(h.state.screen.intent).toEqual({ kind: 'removeSecret', key: 'doomed' });
      applyConfirmIntent(session, h.state.screen.intent, () => undefined);
      expect(session.getSecret('doomed')).toBeNull();
    }
  });

  describe('neighborAfterDelete', () => {
    const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    it('selects the previous neighbor for a middle row', () => {
      expect(neighborAfterDelete(list, 'b')).toBe('a');
    });
    it('selects the previous neighbor for the last row', () => {
      expect(neighborAfterDelete(list, 'c')).toBe('b');
    });
    it('falls back to the next row when the first row is deleted', () => {
      expect(neighborAfterDelete(list, 'a')).toBe('b');
    });
    it('returns null when deleting the only row', () => {
      expect(neighborAfterDelete([{ key: 'a' }], 'a')).toBeNull();
    });
    it('falls back to the first row when the key is not present', () => {
      expect(neighborAfterDelete(list, 'missing')).toBe('a');
    });
  });

  it('/rm moves selection to the previous neighbor, not row 0', () => {
    const session = new FakeSession();
    session.addSecret('a', '1');
    session.addSecret('b', '2');
    session.addSecret('c', '3');
    const h = harness(session);
    const visible = session.search('');
    h.select('c'); // last row selected
    h.commands.rm('c');
    if (h.state.screen.kind === 'confirm') {
      const next = neighborAfterDelete(visible, h.state.screen.intent.key);
      applyConfirmIntent(session, h.state.screen.intent, h.dispatch, next);
    }
    expect(session.getSecret('c')).toBeNull();
    expect(h.state.selectedKey).toBe('b');
  });

  it('/get copies the value and reveals (copy over display)', async () => {
    const session = new FakeSession();
    session.addSecret('k', 'topsecret');
    const h = harness(session);
    await h.commands.get('k');
    expect(h.copied).toEqual(['topsecret']);
    expect(h.state.revealed).toBe(true);
  });

  it('run() dispatches unknown command status', () => {
    const h = harness();
    const result = h.commands.run('/bogus');
    expect(result).toBe(false);
    expect(h.state.status).toContain('unknown command');
  });

  it('run() accepts BOTH the legacy /cmd form and the new :cmd form', () => {
    const slash = harness();
    slash.commands.run('/add');
    expect(slash.state.screen.kind).toBe('addEdit');

    const colon = harness();
    colon.commands.run(':add');
    expect(colon.state.screen.kind).toBe('addEdit');

    // Bare (no prefix) still works — the test seam relies on it.
    const bare = harness();
    bare.commands.run('add');
    expect(bare.state.screen.kind).toBe('addEdit');
  });

  it(':copy and :yank are aliases of get (copy over display)', async () => {
    const sessionA = new FakeSession();
    sessionA.addSecret('k', 'topsecret');
    const a = harness(sessionA);
    a.select('k');
    await a.commands.run(':copy k');
    expect(a.copied).toEqual(['topsecret']);

    const sessionB = new FakeSession();
    sessionB.addSecret('k', 'topsecret');
    const b = harness(sessionB);
    await b.commands.run(':yank k');
    expect(b.copied).toEqual(['topsecret']);
  });

  it(':reveal toggles reveal on the selection', () => {
    const session = new FakeSession();
    session.addSecret('k', 'v');
    const h = harness(session);
    expect(h.state.revealed).toBe(false);
    h.commands.run(':reveal');
    expect(h.state.revealed).toBe(true);
    h.commands.run(':reveal');
    expect(h.state.revealed).toBe(false);
  });

  it(':labels and :rename map to real edit ops (no faked backend)', () => {
    const session = new FakeSession();
    session.addSecret('k', 'v');
    const h1 = harness(session);
    h1.select('k');
    h1.commands.run(':labels');
    expect(h1.state.screen.kind).toBe('addEdit');

    const h2 = harness(session);
    h2.select('k');
    h2.commands.run(':rename');
    expect(h2.state.screen.kind).toBe('addEdit');
  });

  it('fuzzyComplete prefix-matches then subsequence-matches command names', () => {
    expect(fuzzyComplete('').length).toBe(COMMAND_SPECS.length);
    const co = fuzzyComplete('co');
    expect(co[0]?.name).toBe('copy'); // exact prefix wins
    expect(co.map((c) => c.name)).toContain('clipinfo'); // subsequence c-o..i
    // A query that matches nothing returns no specs.
    expect(fuzzyComplete('zzz')).toEqual([]);
  });

  it('commands are blocked while locked', () => {
    const session = new FakeSession({ locked: true });
    const h = harness(session);
    h.commands.add('');
    expect(h.state.screen.kind).toBe('home');
    expect(h.state.status).toBe('vault is locked');
  });

  it('/sync surfaces a conflict screen when reported', async () => {
    const session = new FakeSession({ status: 'DIRTY', conflictOnSync: true });
    const h = harness(session);
    await h.commands.sync('');
    expect(h.state.screen.kind).toBe('conflict');
  });
});
