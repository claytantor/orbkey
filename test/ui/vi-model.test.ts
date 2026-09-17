/**
 * Exhaustive tests for the pure vi state machine (`src/ui/vi/model.ts`).
 *
 * Every command in the frozen table, every named semantic, and every paste rule
 * gets its own assertion. These are plain function calls — no terminal, no Ink —
 * which is the whole reason the semantics live in a pure reducer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  applyKey,
  initViState,
  toText,
  MSG_E37,
  MSG_NO_UNDO,
  MSG_WRITTEN,
  msgPatternNotFound,
  msgNotAnEditorCommand,
  type ViKey,
  type ViState,
} from '../../src/ui/vi/model.js';

// Key shapes exactly as Ink's `useInput` delivers them
// (see node_modules/ink/build/hooks/use-input.js).
const NONE: ViKey = {};
const ESC: ViKey = { escape: true, meta: true }; // Ink flags Escape as meta too
const RET: ViKey = { return: true };
const BACKSPACE: ViKey = { backspace: true };
const DELETE: ViKey = { delete: true };
const UP: ViKey = { upArrow: true };
const DOWN: ViKey = { downArrow: true };
const LEFT: ViKey = { leftArrow: true };
const RIGHT: ViKey = { rightArrow: true };
const CTRL_S: ViKey = { ctrl: true };

/** Feed characters one at a time, so nothing is mistaken for a paste. */
function typeKeys(s: ViState, chars: string): ViState {
  let out = s;
  for (const ch of chars) {
    out = applyKey(out, ch, NONE);
  }
  return out;
}

/** `:<cmd>` + Enter. */
function ex(s: ViState, cmd: string): ViState {
  return applyKey(typeKeys(s, `:${cmd}`), '\r', RET);
}

/** `/<pattern>` + Enter. */
function search(s: ViState, pattern: string): ViState {
  return applyKey(typeKeys(s, `/${pattern}`), '\r', RET);
}

const SAMPLE = 'alpha beta\ngamma\n\ndelta epsilon';
const sample = (): ViState => initViState(SAMPLE);

// ---------------------------------------------------------------------------

describe('initViState / toText', () => {
  it('round-trips a multi-line string', () => {
    expect(toText(initViState(SAMPLE))).toBe(SAMPLE);
  });

  it('round-trips the empty string as a single empty line', () => {
    const s = initViState('');
    expect(s.lines).toEqual(['']);
    expect(toText(s)).toBe('');
  });

  it('round-trips a trailing newline (the trailing empty line is preserved)', () => {
    const s = initViState('a\nb\n');
    expect(s.lines).toEqual(['a', 'b', '']);
    expect(toText(s)).toBe('a\nb\n');
  });

  it('round-trips a string of only newlines', () => {
    expect(toText(initViState('\n\n'))).toBe('\n\n');
  });

  it('starts in normal mode at 0,0, clean, with no undo and no reserved count', () => {
    const s = sample();
    expect(s.mode).toBe('normal');
    expect(s.row).toBe(0);
    expect(s.col).toBe(0);
    expect(s.dirty).toBe(false);
    expect(s.exit).toBeNull();
    expect(s.undo).toEqual([]);
    expect(s.pending).toBe('');
    expect(s.cmdline).toBe('');
    expect(s.lastSearch).toBe('');
    expect(s.message).toBe('');
    expect(s.count).toBeNull();
    expect(s.register).toEqual({ text: '', linewise: false });
  });
});

describe('purity', () => {
  it('never mutates the state it is handed', () => {
    const cases: Array<[string, ViKey]> = [
      ['x', NONE],
      ['i', NONE],
      ['o', NONE],
      ['p', NONE],
      ['u', NONE],
      [':', NONE],
      ['\r', RET],
    ];
    for (const [input, key] of cases) {
      const before = typeKeys(sample(), 'jdd'); // a state with undo + register set
      const frozen = JSON.stringify(before);
      applyKey(before, input, key);
      expect(JSON.stringify(before)).toBe(frozen);
    }
  });

  it('does not alias the lines array into the next state', () => {
    const before = sample();
    const after = typeKeys(before, 'dd');
    expect(after.lines).not.toBe(before.lines);
    expect(before.lines).toEqual(SAMPLE.split('\n'));
  });

  it('does not alias the undo stack into the next state', () => {
    const before = sample();
    const after = typeKeys(before, 'x');
    expect(after.undo).not.toBe(before.undo);
    expect(before.undo).toHaveLength(0);
  });

  it('is deterministic: the same inputs give the same output', () => {
    const a = typeKeys(sample(), 'jwdd');
    const b = typeKeys(sample(), 'jwdd');
    expect(a).toEqual(b);
  });
});

// --- motion ----------------------------------------------------------------

describe('motion: h j k l', () => {
  it('h moves left and stops at column 0', () => {
    let s = typeKeys(sample(), 'lll');
    expect(s.col).toBe(3);
    s = typeKeys(s, 'hh');
    expect(s.col).toBe(1);
    s = typeKeys(s, 'hhh');
    expect(s.col).toBe(0);
  });

  it('l stops on the LAST character, never past it', () => {
    const s = typeKeys(sample(), 'llllllllllllllll');
    expect(s.row).toBe(0);
    expect(s.col).toBe('alpha beta'.length - 1);
  });

  it('j and k move by row and stop at the buffer edges', () => {
    let s = typeKeys(sample(), 'jjj');
    expect(s.row).toBe(3);
    s = typeKeys(s, 'j');
    expect(s.row).toBe(3);
    s = typeKeys(s, 'kkkkk');
    expect(s.row).toBe(0);
  });

  it('j onto a shorter line clamps the column', () => {
    const s = typeKeys(sample(), '$j');
    expect(s.row).toBe(1);
    expect(s.col).toBe('gamma'.length - 1);
  });

  it('j onto an empty line puts the column at 0', () => {
    const s = typeKeys(sample(), '$jj');
    expect(s.row).toBe(2);
    expect(s.col).toBe(0);
  });
});

describe('motion: arrow keys mirror h j k l', () => {
  it('right/left move the column', () => {
    let s = applyKey(sample(), '', RIGHT);
    s = applyKey(s, '', RIGHT);
    expect(s.col).toBe(2);
    s = applyKey(s, '', LEFT);
    expect(s.col).toBe(1);
  });

  it('down/up move the row and clamp the column', () => {
    let s = typeKeys(sample(), '$');
    s = applyKey(s, '', DOWN);
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 4 });
    s = applyKey(s, '', UP);
    expect(s.row).toBe(0);
  });

  it('left at column 0 does not cross to the previous line', () => {
    let s = typeKeys(sample(), 'j');
    s = applyKey(s, '', LEFT);
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
  });
});

describe('motion: 0 and $', () => {
  it('0 goes to column 0', () => {
    const s = typeKeys(sample(), 'lll0');
    expect(s.col).toBe(0);
  });

  it('$ puts the cursor on the LAST character in normal mode (len-1)', () => {
    const s = typeKeys(sample(), '$');
    expect(s.col).toBe('alpha beta'.length - 1);
  });

  it('$ then insert puts the cursor at len (insert mode allows one past the end)', () => {
    const s = typeKeys(sample(), '$a');
    expect(s.mode).toBe('insert');
    expect(s.col).toBe('alpha beta'.length);
  });

  it('$ on an empty line is column 0', () => {
    const s = typeKeys(sample(), 'jj$');
    expect({ row: s.row, col: s.col }).toEqual({ row: 2, col: 0 });
  });
});

describe('motion: gg and G', () => {
  it('gg goes to the first line', () => {
    const s = typeKeys(sample(), 'jjjgg');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
    expect(s.pending).toBe('');
  });

  it('a single g only arms the pending operator', () => {
    const s = typeKeys(sample(), 'jg');
    expect(s.pending).toBe('g');
    expect(s.row).toBe(1);
  });

  it('G goes to the last line', () => {
    const s = typeKeys(sample(), 'G');
    expect({ row: s.row, col: s.col }).toEqual({ row: 3, col: 0 });
  });

  it('g followed by anything else is rejected silently', () => {
    const s = typeKeys(sample(), 'jgx');
    expect(s.pending).toBe('');
    expect(toText(s)).toBe(SAMPLE);
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
  });
});

describe('motion: w and b (word = run of non-whitespace)', () => {
  it('w moves to the start of the next word on the same line', () => {
    const s = typeKeys(sample(), 'w');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 6 });
  });

  it('w crosses a line boundary', () => {
    const s = typeKeys(sample(), 'ww');
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
  });

  it('w skips an empty line entirely', () => {
    const s = typeKeys(sample(), 'www');
    expect({ row: s.row, col: s.col }).toEqual({ row: 3, col: 0 });
  });

  it('w from the middle of a word jumps past the rest of that word', () => {
    const s = typeKeys(sample(), 'llw');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 6 });
  });

  it('w at the end of the buffer parks on the last character', () => {
    const s = typeKeys(sample(), 'wwwwwwww');
    expect({ row: s.row, col: s.col }).toEqual({ row: 3, col: 'delta epsilon'.length - 1 });
  });

  it('b moves to the start of the previous word, crossing lines', () => {
    let s = typeKeys(sample(), 'G'); // 3,0
    s = typeKeys(s, 'b');
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
    s = typeKeys(s, 'b');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 6 });
    s = typeKeys(s, 'b');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('b from mid-word goes to the start of that word', () => {
    const s = typeKeys(sample(), 'wlb');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 6 });
  });

  it('b at the start of the buffer stays put', () => {
    const s = typeKeys(sample(), 'bbb');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('w treats a run of non-whitespace as one word, punctuation included', () => {
    const s = typeKeys(initViState('a.b,c d'), 'w');
    expect(s.col).toBe(6);
  });
});

// --- insert ----------------------------------------------------------------

describe('insert entry: i a I A o O', () => {
  it('i inserts at the cursor without moving it', () => {
    const s = typeKeys(sample(), 'lli');
    expect(s.mode).toBe('insert');
    expect(s.col).toBe(2);
    expect(s.dirty).toBe(false);
  });

  it('a moves one right then inserts', () => {
    const s = typeKeys(sample(), 'lla');
    expect(s.col).toBe(3);
  });

  it('a on an empty line stays at column 0', () => {
    const s = typeKeys(sample(), 'jja');
    expect({ row: s.row, col: s.col, mode: s.mode }).toEqual({
      row: 2,
      col: 0,
      mode: 'insert',
    });
  });

  it('I goes to the first non-blank character', () => {
    const s = typeKeys(initViState('   hi there'), '$I');
    expect(s.col).toBe(3);
    expect(s.mode).toBe('insert');
  });

  it('I on an all-blank line goes to column 0', () => {
    const s = typeKeys(initViState('    '), 'I');
    expect(s.col).toBe(0);
  });

  it('A is $ then insert-at-end', () => {
    const s = typeKeys(sample(), 'A');
    expect(s.col).toBe('alpha beta'.length);
    expect(typeKeys(s, '!').lines[0]).toBe('alpha beta!');
  });

  it('o opens an empty line BELOW and enters insert there', () => {
    const s = typeKeys(sample(), 'o');
    expect(s.lines).toEqual(['alpha beta', '', 'gamma', '', 'delta epsilon']);
    expect({ row: s.row, col: s.col, mode: s.mode, dirty: s.dirty }).toEqual({
      row: 1,
      col: 0,
      mode: 'insert',
      dirty: true,
    });
  });

  it('O opens an empty line ABOVE and enters insert there', () => {
    const s = typeKeys(sample(), 'jO');
    expect(s.lines).toEqual(['alpha beta', '', 'gamma', '', 'delta epsilon']);
    expect({ row: s.row, mode: s.mode, dirty: s.dirty }).toEqual({
      row: 1,
      mode: 'insert',
      dirty: true,
    });
  });
});

describe('insert mode editing', () => {
  it('typed characters land at the cursor', () => {
    const s = typeKeys(typeKeys(sample(), 'i'), 'XY');
    expect(s.lines[0]).toBe('XYalpha beta');
    expect(s.col).toBe(2);
    expect(s.dirty).toBe(true);
  });

  it('Enter splits the line and moves to column 0 of the new line', () => {
    let s = typeKeys(sample(), 'lllll'); // col 5 (the space)
    s = typeKeys(s, 'i');
    s = applyKey(s, '\r', RET);
    expect(s.lines.slice(0, 2)).toEqual(['alpha', ' beta']);
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
  });

  it('backspace deletes the character before the cursor', () => {
    let s = typeKeys(sample(), 'lli');
    s = applyKey(s, '', BACKSPACE);
    expect(s.lines[0]).toBe('apha beta');
    expect(s.col).toBe(1);
  });

  it('Ink reports DEL as key.delete; it backspaces too', () => {
    let s = typeKeys(sample(), 'lli');
    s = applyKey(s, '', DELETE);
    expect(s.lines[0]).toBe('apha beta');
  });

  it('backspace at column 0 joins with the previous line', () => {
    let s = typeKeys(sample(), 'ji');
    s = applyKey(s, '', BACKSPACE);
    expect(s.lines[0]).toBe('alpha betagamma');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 'alpha beta'.length });
  });

  it('backspace at the very start of the buffer is a no-op', () => {
    let s = typeKeys(sample(), 'i');
    s = applyKey(s, '', BACKSPACE);
    expect(toText(s)).toBe(SAMPLE);
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('Tab is not bound in v1 and inserts nothing', () => {
    let s = typeKeys(sample(), 'i');
    s = applyKey(s, '', { tab: true });
    expect(toText(s)).toBe(SAMPLE);
  });

  it('arrow keys move without leaving insert mode', () => {
    let s = typeKeys(sample(), 'i');
    s = applyKey(s, '', RIGHT);
    s = applyKey(s, '', DOWN);
    expect(s.mode).toBe('insert');
    expect(s.row).toBe(1);
  });

  it('a chord (ctrl) is ignored rather than inserted', () => {
    const s = applyKey(typeKeys(sample(), 'i'), 's', CTRL_S);
    expect(toText(s)).toBe(SAMPLE);
  });
});

describe('Esc clamps on the mode transition', () => {
  it('Esc from insert at end-of-line clamps to the last character', () => {
    let s = typeKeys(sample(), 'A');
    expect(s.col).toBe(10);
    s = applyKey(s, '', ESC);
    expect(s.mode).toBe('normal');
    expect(s.col).toBe(9);
  });

  it('Esc from insert on an empty line leaves column 0', () => {
    let s = typeKeys(sample(), 'jji');
    s = applyKey(s, '', ESC);
    expect({ row: s.row, col: s.col }).toEqual({ row: 2, col: 0 });
  });

  it('Esc in normal mode clears pending and message but changes nothing else', () => {
    let s = typeKeys(sample(), 'd');
    s = { ...s, message: 'stale' };
    const after = applyKey(s, '', ESC);
    expect(after.pending).toBe('');
    expect(after.message).toBe('');
    expect(toText(after)).toBe(SAMPLE);
    expect({ row: after.row, col: after.col }).toEqual({ row: s.row, col: s.col });
  });

  it('Esc leaves command mode and discards the cmdline', () => {
    let s = typeKeys(sample(), ':wq');
    expect(s.mode).toBe('command');
    s = applyKey(s, '', ESC);
    expect(s.mode).toBe('normal');
    expect(s.cmdline).toBe('');
    expect(s.exit).toBeNull();
  });

  it('Esc leaves search mode and discards the pattern', () => {
    let s = typeKeys(sample(), '/gam');
    expect(s.mode).toBe('search');
    s = applyKey(s, '', ESC);
    expect(s.mode).toBe('normal');
    expect(s.cmdline).toBe('');
    expect(s.lastSearch).toBe('');
  });
});

// --- edit ------------------------------------------------------------------

describe('x', () => {
  it('deletes the character under the cursor', () => {
    const s = typeKeys(sample(), 'x');
    expect(s.lines[0]).toBe('lpha beta');
    expect(s.dirty).toBe(true);
  });

  it('at end of line clamps col to max(0, len-1)', () => {
    const s = typeKeys(initViState('abc'), '$x');
    expect(s.lines[0]).toBe('ab');
    expect(s.col).toBe(1);
  });

  it('deleting the only character leaves an empty line at column 0', () => {
    const s = typeKeys(initViState('z'), 'x');
    expect(s.lines).toEqual(['']);
    expect(s.col).toBe(0);
  });

  it('does nothing when the line is empty — no undo snapshot, still clean', () => {
    const s = typeKeys(sample(), 'jjx');
    expect(toText(s)).toBe(SAMPLE);
    expect(s.dirty).toBe(false);
    expect(s.undo).toHaveLength(0);
  });
});

describe('dd / yy / p / P', () => {
  it('dd removes the line and yanks it LINEWISE', () => {
    const s = typeKeys(sample(), 'jdd');
    expect(s.lines).toEqual(['alpha beta', '', 'delta epsilon']);
    expect(s.register).toEqual({ text: 'gamma', linewise: true });
    expect(s.dirty).toBe(true);
    expect(s.col).toBe(0);
  });

  it('dd on the last remaining line leaves [""] — not []', () => {
    const s = typeKeys(initViState('only'), 'dd');
    expect(s.lines).toEqual(['']);
    expect(toText(s)).toBe('');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('dd on the last line of several clamps the row', () => {
    const s = typeKeys(sample(), 'Gdd');
    expect(s.lines).toEqual(['alpha beta', 'gamma', '']);
    expect(s.row).toBe(2);
  });

  it('yy yanks linewise without modifying the buffer or the undo stack', () => {
    const s = typeKeys(sample(), 'jyy');
    expect(s.register).toEqual({ text: 'gamma', linewise: true });
    expect(toText(s)).toBe(SAMPLE);
    expect(s.dirty).toBe(false);
    expect(s.undo).toHaveLength(0);
  });

  it('p after a linewise yank opens a NEW line BELOW', () => {
    const s = typeKeys(sample(), 'jyyp');
    expect(s.lines).toEqual(['alpha beta', 'gamma', 'gamma', '', 'delta epsilon']);
    expect({ row: s.row, col: s.col }).toEqual({ row: 2, col: 0 });
    expect(s.dirty).toBe(true);
  });

  it('P after a linewise yank opens a NEW line ABOVE', () => {
    const s = typeKeys(sample(), 'jyyP');
    expect(s.lines).toEqual(['alpha beta', 'gamma', 'gamma', '', 'delta epsilon']);
    expect(s.row).toBe(1);
  });

  it('dd then p moves the line down one', () => {
    const s = typeKeys(sample(), 'ddp');
    expect(s.lines).toEqual(['gamma', 'alpha beta', '', 'delta epsilon']);
  });

  it('p with an empty register is a no-op', () => {
    const s = typeKeys(sample(), 'p');
    expect(toText(s)).toBe(SAMPLE);
    expect(s.dirty).toBe(false);
    expect(s.undo).toHaveLength(0);
  });

  it('P with an empty register is a no-op', () => {
    const s = typeKeys(sample(), 'P');
    expect(toText(s)).toBe(SAMPLE);
    expect(s.dirty).toBe(false);
    expect(s.undo).toHaveLength(0);
  });

  it('honors the linewise flag: a charwise register pastes into the line', () => {
    const base: ViState = {
      ...sample(),
      register: { text: 'XY', linewise: false },
    };
    const after = applyKey(base, 'p', NONE);
    expect(after.lines[0]).toBe('aXYlpha beta');
    expect(after.col).toBe(2);

    const before = applyKey(base, 'P', NONE);
    expect(before.lines[0]).toBe('XYalpha beta');
  });
});

describe('u (undo)', () => {
  it('pops one snapshot and restores lines and cursor', () => {
    const s = typeKeys(sample(), 'jddu');
    expect(toText(s)).toBe(SAMPLE);
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
    expect(s.undo).toHaveLength(0);
  });

  it('with an empty undo stack it sets the message and changes nothing else', () => {
    const before = sample();
    const after = applyKey(before, 'u', NONE);
    expect(after.message).toBe(MSG_NO_UNDO);
    expect(toText(after)).toBe(SAMPLE);
    expect({ row: after.row, col: after.col, mode: after.mode }).toEqual({
      row: before.row,
      col: before.col,
      mode: before.mode,
    });
    expect(after.undo).toHaveLength(0);
  });

  it('pushes ONE snapshot per insert session, not per typed character', () => {
    const s = typeKeys(typeKeys(sample(), 'i'), 'hello');
    expect(s.undo).toHaveLength(1);
  });

  it('undoing an insert session restores the whole session at once', () => {
    let s = typeKeys(typeKeys(sample(), 'i'), 'hello');
    s = applyKey(s, '', ESC);
    s = applyKey(s, 'u', NONE);
    expect(toText(s)).toBe(SAMPLE);
    expect(s.mode).toBe('normal');
  });

  it('pushes a snapshot BEFORE each mutating command and pops them in order', () => {
    let s = typeKeys(sample(), 'x'); // 1
    s = typeKeys(s, 'x'); // 2
    s = typeKeys(s, 'dd'); // 3
    expect(s.undo).toHaveLength(3);
    s = applyKey(s, 'u', NONE);
    expect(s.lines[0]).toBe('pha beta');
    s = applyKey(s, 'u', NONE);
    expect(s.lines[0]).toBe('lpha beta');
    s = applyKey(s, 'u', NONE);
    expect(toText(s)).toBe(SAMPLE);
    expect(applyKey(s, 'u', NONE).message).toBe(MSG_NO_UNDO);
  });

  it('u is a literal character while in insert mode, not an undo', () => {
    const s = applyKey(typeKeys(typeKeys(sample(), 'i'), 'zz'), 'u', NONE);
    expect(s.mode).toBe('insert');
    expect(s.lines[0]).toBe('zzualpha beta');
  });

  it('Esc then u leaves the editor in normal mode with the text restored', () => {
    let s = typeKeys(typeKeys(sample(), 'i'), 'zz');
    s = applyKey(s, '', ESC);
    s = applyKey(s, 'u', NONE);
    expect(s.mode).toBe('normal');
    expect(toText(s)).toBe(SAMPLE);
  });
});

// --- pending operators / explicitly-unsupported commands --------------------

describe('rejected silently (not in v1)', () => {
  it('dw does nothing — no operator+motion in v1', () => {
    const s = typeKeys(sample(), 'dw');
    expect(toText(s)).toBe(SAMPLE);
    expect(s.pending).toBe('');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
    expect(s.dirty).toBe(false);
  });

  it('a count is dropped: 3dd deletes exactly ONE line', () => {
    const s = typeKeys(sample(), '3dd');
    expect(s.lines).toEqual(['gamma', '', 'delta epsilon']);
    expect(s.count).toBeNull();
  });

  it('a register name is swallowed: "ayy still yanks to the one register', () => {
    const s = typeKeys(sample(), '"ayy');
    expect(s.register).toEqual({ text: 'alpha beta', linewise: true });
    expect(s.pending).toBe('');
  });

  it('the register leader alone only arms pending', () => {
    expect(typeKeys(sample(), '"').pending).toBe('"');
  });

  it('Esc cancels a pending operator so the next d does not complete a dd', () => {
    let s = typeKeys(sample(), 'd');
    s = applyKey(s, '', ESC);
    s = typeKeys(s, 'd');
    expect(s.pending).toBe('d');
    expect(toText(s)).toBe(SAMPLE);
  });

  it('unbound normal-mode keys do nothing', () => {
    for (const ch of ['z', 'q', '~', '%', 'v', '.']) {
      const s = typeKeys(sample(), ch);
      expect(toText(s)).toBe(SAMPLE);
      expect(s.dirty).toBe(false);
      expect(s.exit).toBeNull();
    }
  });

  it('Enter, Tab, backspace and delete are not bound in normal mode', () => {
    for (const key of [RET, { tab: true }, BACKSPACE, DELETE]) {
      const s = applyKey(sample(), '', key);
      expect(toText(s)).toBe(SAMPLE);
      expect(s.mode).toBe('normal');
    }
  });

  it('ctrl and meta chords are ignored in normal mode', () => {
    expect(toText(applyKey(sample(), 'd', CTRL_S))).toBe(SAMPLE);
    expect(applyKey(sample(), 'd', CTRL_S).pending).toBe('');
    expect(applyKey(sample(), 'x', { meta: true }).lines[0]).toBe('alpha beta');
  });
});

// --- ex commands -----------------------------------------------------------

describe('ex commands', () => {
  it(':w clears dirty, confirms, and does NOT exit', () => {
    const s = ex(typeKeys(sample(), 'x'), 'w');
    expect(s.dirty).toBe(false);
    expect(s.message).toBe(MSG_WRITTEN);
    expect(s.exit).toBeNull();
    expect(s.mode).toBe('normal');
    expect(s.cmdline).toBe('');
  });

  it(':wq exits asking to save', () => {
    const s = ex(typeKeys(sample(), 'x'), 'wq');
    expect(s.exit).toEqual({ save: true });
    expect(s.dirty).toBe(false);
  });

  it(':x exits asking to save', () => {
    expect(ex(sample(), 'x').exit).toEqual({ save: true });
  });

  it(':q on a DIRTY buffer refuses with E37 and does not exit', () => {
    const s = ex(typeKeys(sample(), 'x'), 'q');
    expect(s.exit).toBeNull();
    expect(s.message).toBe(MSG_E37);
    expect(s.message).toBe('E37: No write since last change (add ! to override)');
    expect(s.mode).toBe('normal');
  });

  it(':q on a CLEAN buffer exits without saving', () => {
    expect(ex(sample(), 'q').exit).toEqual({ save: false });
  });

  it(':q after :w is allowed again', () => {
    const s = ex(ex(typeKeys(sample(), 'x'), 'w'), 'q');
    expect(s.exit).toEqual({ save: false });
  });

  it(':q! discards a dirty buffer', () => {
    const s = ex(typeKeys(sample(), 'x'), 'q!');
    expect(s.exit).toEqual({ save: false });
  });

  it('an unknown ex command reports E492 and does not exit', () => {
    const s = ex(sample(), 's/a/b/');
    expect(s.message).toBe(msgNotAnEditorCommand('s/a/b/'));
    expect(s.exit).toBeNull();
    expect(toText(s)).toBe(SAMPLE);
  });

  it('a bare colon then Enter returns to normal mode quietly', () => {
    const s = ex(sample(), '');
    expect(s.mode).toBe('normal');
    expect(s.message).toBe('');
    expect(s.exit).toBeNull();
  });

  it('backspace edits the cmdline and leaves command mode when it empties', () => {
    let s = typeKeys(sample(), ':wq');
    s = applyKey(s, '', BACKSPACE);
    expect(s.cmdline).toBe('w');
    s = applyKey(s, '', BACKSPACE);
    expect(s.cmdline).toBe('');
    expect(s.mode).toBe('command');
    s = applyKey(s, '', BACKSPACE);
    expect(s.mode).toBe('normal');
  });

  it('the buffer is frozen once exit is set', () => {
    const s = ex(sample(), 'q!');
    const after = typeKeys(s, 'idestroy');
    expect(after).toBe(s);
    expect(toText(after)).toBe(SAMPLE);
  });
});

// --- search ----------------------------------------------------------------

describe('search', () => {
  it('/pattern + Enter searches FORWARD from the cursor', () => {
    const s = search(sample(), 'gamma');
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
    expect(s.mode).toBe('normal');
    expect(s.lastSearch).toBe('gamma');
    expect(s.cmdline).toBe('');
  });

  it('finds a later match on the SAME line', () => {
    const s = search(initViState('one two one'), 'one');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 8 });
  });

  it('wraps around the end of the buffer', () => {
    const s = search(typeKeys(sample(), 'G'), 'alpha');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('n repeats forward and wraps', () => {
    let s = search(initViState('x\nhit\nhit'), 'hit');
    expect(s.row).toBe(1);
    s = applyKey(s, 'n', NONE);
    expect(s.row).toBe(2);
    s = applyKey(s, 'n', NONE);
    expect(s.row).toBe(1);
  });

  it('N reverses the direction', () => {
    let s = search(initViState('hit\nx\nhit'), 'hit');
    expect(s.row).toBe(2);
    s = applyKey(s, 'N', NONE);
    expect(s.row).toBe(0);
    s = applyKey(s, 'N', NONE);
    expect(s.row).toBe(2);
  });

  it('no match sets E486 and leaves the cursor put', () => {
    const before = typeKeys(sample(), 'jl');
    const after = search(before, 'zzz');
    expect(after.message).toBe(msgPatternNotFound('zzz'));
    expect(after.message).toBe('E486: Pattern not found: zzz');
    expect({ row: after.row, col: after.col }).toEqual({ row: before.row, col: before.col });
    expect(after.mode).toBe('normal');
  });

  it('search is LITERAL text, not a regex', () => {
    const dot = search(initViState('abc\na.c'), 'a.c');
    expect(dot.row).toBe(1);

    const noMatch = search(initViState('abc'), 'a.c');
    expect(noMatch.message).toBe(msgPatternNotFound('a.c'));
  });

  it('regex metacharacters are matched literally, not compiled', () => {
    const s = search(initViState('plain\n[a-z]+'), '[a-z]+');
    expect({ row: s.row, col: s.col }).toEqual({ row: 1, col: 0 });
  });

  it('a bare / + Enter re-runs the last search', () => {
    let s = search(initViState('hit\nx\nhit'), 'hit');
    expect(s.row).toBe(2);
    s = applyKey(typeKeys(s, '/'), '\r', RET);
    expect(s.row).toBe(0);
  });

  it('n with no previous search is a silent no-op', () => {
    const s = applyKey(sample(), 'n', NONE);
    expect(s.message).toBe('');
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 0 });
  });

  it('backspace edits the pattern and leaves search mode when it empties', () => {
    let s = typeKeys(sample(), '/ga');
    s = applyKey(s, '', BACKSPACE);
    expect(s.cmdline).toBe('g');
    s = applyKey(s, '', BACKSPACE);
    s = applyKey(s, '', BACKSPACE);
    expect(s.mode).toBe('normal');
  });

  it('a search does not dirty the buffer', () => {
    expect(search(sample(), 'gamma').dirty).toBe(false);
  });
});

// --- paste (section 4) -----------------------------------------------------

describe('paste', () => {
  const CHUNK = 'one two three';

  it('a multi-character chunk in INSERT mode is inserted at the cursor', () => {
    const s = applyKey(typeKeys(sample(), 'i'), CHUNK, NONE);
    expect(s.lines[0]).toBe(`${CHUNK}alpha beta`);
    expect(s.mode).toBe('insert');
    expect(s.col).toBe(CHUNK.length);
    expect(s.dirty).toBe(true);
  });

  it('a multi-character chunk in NORMAL mode is inserted and the mode STAYS normal', () => {
    const s = applyKey(sample(), CHUNK, NONE);
    expect(s.lines[0]).toBe(`${CHUNK}alpha beta`);
    expect(s.mode).toBe('normal');
    expect(s.dirty).toBe(true);
  });

  it('pasted command characters are NOT executed in normal mode', () => {
    const s = applyKey(sample(), 'dd', NONE);
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]).toBe('ddalpha beta');
  });

  it('normalizes CRLF to LF', () => {
    const s = applyKey(initViState(''), 'a\r\nb\r\nc', NONE);
    expect(s.lines).toEqual(['a', 'b', 'c']);
    expect(toText(s)).toBe('a\nb\nc');
    expect(toText(s)).not.toContain('\r');
  });

  it('normalizes a bare CR to LF', () => {
    const s = applyKey(initViState(''), 'a\rb', NONE);
    expect(s.lines).toEqual(['a', 'b']);
    expect(toText(s)).not.toContain('\r');
  });

  it('pastes a CRLF document in INSERT mode', () => {
    const s = applyKey(typeKeys(initViState(''), 'i'), 'l1\r\nl2\r\nl3', NONE);
    expect(s.lines).toEqual(['l1', 'l2', 'l3']);
    expect({ row: s.row, col: s.col }).toEqual({ row: 2, col: 2 });
  });

  it('pastes a CRLF document in NORMAL mode', () => {
    const s = applyKey(initViState(''), 'l1\r\nl2\r\nl3', NONE);
    expect(s.lines).toEqual(['l1', 'l2', 'l3']);
    expect(s.mode).toBe('normal');
  });

  it('splices into the middle of an existing line', () => {
    let s = typeKeys(initViState('HEADTAIL'), 'llll'); // col 4
    s = applyKey(s, 'mid\nline', NONE);
    expect(s.lines).toEqual(['HEADmid', 'lineTAIL']);
  });

  it('strips bracketed-paste markers in their full form', () => {
    const s = applyKey(initViState(''), '\x1b[200~hello\x1b[201~', NONE);
    expect(s.lines).toEqual(['hello']);
    expect(toText(s)).not.toContain('200~');
    expect(toText(s)).not.toContain('201~');
  });

  it("strips markers after Ink has eaten the chunk's leading ESC", () => {
    // Ink slices one leading ESC off every chunk before calling useInput.
    const s = applyKey(initViState(''), '[200~hello\x1b[201~', NONE);
    expect(s.lines).toEqual(['hello']);
  });

  it('strips markers around a multi-line paste', () => {
    const s = applyKey(initViState(''), '[200~a\r\nb\x1b[201~', NONE);
    expect(s.lines).toEqual(['a', 'b']);
  });

  it('a marker-only chunk is a no-op (the very same state object comes back)', () => {
    const before = sample();
    expect(applyKey(before, '[200~', NONE)).toBe(before);
    expect(applyKey(before, '\x1b[201~', NONE)).toBe(before);
    expect(applyKey(before, '\x1b[200~\x1b[201~', NONE)).toBe(before);
  });

  it('a BRACKETED single character is text, not a command', () => {
    const s = applyKey(sample(), '[200~x\x1b[201~', NONE);
    expect(s.lines[0]).toBe('xalpha beta');
    expect(s.mode).toBe('normal');
  });

  it('a pasted chunk is ONE undo step', () => {
    let s = applyKey(sample(), CHUNK, NONE);
    expect(s.undo).toHaveLength(1);
    s = applyKey(s, 'u', NONE);
    expect(toText(s)).toBe(SAMPLE);
  });

  it('a paste inside an insert session is its own undo step', () => {
    let s = typeKeys(sample(), 'i'); // snapshot 1
    s = typeKeys(s, 'ab'); // no snapshot
    s = applyKey(s, CHUNK, NONE); // snapshot 2
    expect(s.undo).toHaveLength(2);
    s = applyKey(s, '', ESC);
    s = applyKey(s, 'u', NONE);
    expect(s.lines[0]).toBe('abalpha beta');
    s = applyKey(s, 'u', NONE);
    expect(toText(s)).toBe(SAMPLE);
  });

  it('a multi-character chunk WITH ctrl is not treated as paste', () => {
    const s = applyKey(sample(), 'abc', CTRL_S);
    expect(toText(s)).toBe(SAMPLE);
    expect(s.dirty).toBe(false);
  });

  it('a single typed character is still a command in normal mode', () => {
    expect(applyKey(sample(), 'x', NONE).lines[0]).toBe('lpha beta');
  });

  it('a paste into COMMAND mode appends to the cmdline, newlines removed', () => {
    const s = applyKey(typeKeys(sample(), ':'), 'w\nq', NONE);
    expect(s.cmdline).toBe('wq');
    expect(s.mode).toBe('command');
  });

  it('a paste into SEARCH mode appends to the pattern', () => {
    const s = applyKey(typeKeys(sample(), '/'), 'gam', NONE);
    expect(s.cmdline).toBe('gam');
    const done = applyKey(s, '\r', RET);
    expect(done.row).toBe(1);
  });

  it('a pasted document survives the round trip through toText', () => {
    const doc = 'line one\r\nline two\r\n\r\nline four';
    const s = applyKey(initViState(''), doc, NONE);
    expect(toText(s)).toBe('line one\nline two\n\nline four');
  });
});

// --- combined / regression -------------------------------------------------

describe('regression: the cursor is OWNED, not derived from the text', () => {
  it('typing in the middle of the first line stays in the middle', () => {
    // The old TextArea recomputed row/col from the text on every render, so the
    // cursor snapped to end-of-buffer and you could only type at the very end.
    let s = initViState('first\nsecond\nthird');
    s = typeKeys(s, 'lli'); // row 0, col 2
    s = typeKeys(s, 'XYZ');
    expect(s.lines).toEqual(['fiXYZrst', 'second', 'third']);
    expect({ row: s.row, col: s.col }).toEqual({ row: 0, col: 5 });
  });

  it('an edit on line 2 does not disturb lines 1 and 3', () => {
    let s = initViState('first\nsecond\nthird');
    s = typeKeys(s, 'jA');
    s = typeKeys(s, '!');
    expect(s.lines).toEqual(['first', 'second!', 'third']);
  });
});

describe('a full edit session', () => {
  it('open, navigate, edit, save and exit', () => {
    let s = initViState('deploy key for CI\n\nrotate every 90 days');
    s = typeKeys(s, 'G'); // last line
    s = typeKeys(s, 'A');
    s = typeKeys(s, ' (ping ops)');
    s = applyKey(s, '', ESC);
    expect(s.dirty).toBe(true);
    s = ex(s, 'wq');
    expect(s.exit).toEqual({ save: true });
    expect(toText(s)).toBe('deploy key for CI\n\nrotate every 90 days (ping ops)');
  });

  it('discarding with :q! keeps the model text but flags save:false', () => {
    let s = initViState('original');
    s = typeKeys(typeKeys(s, 'A'), ' edited');
    s = applyKey(s, '', ESC);
    expect(toText(s)).toBe('original edited');
    s = ex(s, 'q!');
    expect(s.exit).toEqual({ save: false });
  });
});

describe('never logs the note', () => {
  it('runs a full session without touching console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let s = initViState('super-secret-note');
    s = applyKey(s, 'topsecret\r\nvalue', NONE);
    s = typeKeys(s, 'ddpuGx');
    s = search(s, 'nope');
    s = ex(s, 'q');
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  });
});
