/** Pure update logic: semver parsing/ordering, remote-URL normalization, plan selection, argv. */
import { describe, it, expect } from 'vitest';
import {
  compareSemVer,
  latestTag,
  parseSemVer,
  planUpdate,
  remoteSlug,
} from '../src/update/version.js';
import { parseArgs, reexecArgs, usage } from '../src/cli.js';

describe('parseSemVer', () => {
  it('accepts v-prefixed and bare versions', () => {
    expect(parseSemVer('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, raw: 'v1.2.3' });
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, raw: '1.2.3' });
    expect(parseSemVer('v10.0.1')).toEqual({ major: 10, minor: 0, patch: 1, raw: 'v10.0.1' });
    expect(parseSemVer('v0.0.0')).toEqual({ major: 0, minor: 0, patch: 0, raw: 'v0.0.0' });
  });

  it('keeps raw exactly as given so git can check it out', () => {
    expect(parseSemVer('v1.2.3')?.raw).toBe('v1.2.3');
    expect(parseSemVer('1.2.3')?.raw).toBe('1.2.3');
  });

  it('rejects partials, prereleases, four-part versions and branch names', () => {
    for (const bad of [
      'v1.2',
      '1.2',
      '1.2.3-rc1',
      'v1.2.3-rc1',
      '1.2.3+build5',
      'v1.2.3.4',
      'main',
      'v',
      '',
      'release-1.2.3',
      'v1.2.3 ',
      ' v1.2.3',
      'vx.y.z',
    ]) {
      expect(parseSemVer(bad), bad).toBeNull();
    }
  });
});

describe('compareSemVer', () => {
  const sv = (t: string) => {
    const parsed = parseSemVer(t);
    if (parsed === null) throw new Error(`bad fixture: ${t}`);
    return parsed;
  };

  it('compares numerically, not as strings', () => {
    // The classic string-sort bug: '1.10.0' < '1.9.0' lexically.
    expect(compareSemVer(sv('v1.10.0'), sv('v1.9.0'))).toBe(1);
    expect(compareSemVer(sv('v1.9.0'), sv('v1.10.0'))).toBe(-1);
    expect(compareSemVer(sv('v0.10.0'), sv('v0.9.9'))).toBe(1);
    expect(compareSemVer(sv('v2.0.0'), sv('v10.0.0'))).toBe(-1);
    expect(compareSemVer(sv('v1.0.10'), sv('v1.0.9'))).toBe(1);
  });

  it('orders major over minor over patch, and treats v-prefix as equal', () => {
    expect(compareSemVer(sv('v2.0.0'), sv('v1.99.99'))).toBe(1);
    expect(compareSemVer(sv('v1.2.0'), sv('v1.1.99'))).toBe(1);
    expect(compareSemVer(sv('v1.2.3'), sv('v1.2.3'))).toBe(0);
    expect(compareSemVer(sv('v1.2.3'), sv('1.2.3'))).toBe(0);
  });

  it('is usable as a sort comparator', () => {
    const sorted = ['v1.9.0', 'v1.10.0', 'v0.2.0', 'v1.2.3']
      .map(sv)
      .sort(compareSemVer)
      .map((s) => s.raw);
    expect(sorted).toEqual(['v0.2.0', 'v1.2.3', 'v1.9.0', 'v1.10.0']);
  });
});

describe('latestTag', () => {
  it('picks the highest valid tag out of a mixed list', () => {
    const tags = [
      'v0.1.0',
      'main',
      'v1.9.0',
      'nightly',
      'v1.10.0',
      'v2.0.0-rc1',
      'v1.2',
      'release/v3.0.0',
    ];
    expect(latestTag(tags)?.raw).toBe('v1.10.0');
  });

  it('ignores prereleases entirely', () => {
    expect(latestTag(['v1.0.0', 'v2.0.0-rc1', 'v2.0.0-beta'])?.raw).toBe('v1.0.0');
  });

  it('returns null for an empty list or a list with no valid tags', () => {
    expect(latestTag([])).toBeNull();
    expect(latestTag(['main', 'dev', 'v1.2', ''])).toBeNull();
  });
});

describe('remoteSlug', () => {
  it('handles every remote form orbkey can be installed from', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['https://github.com/claytantor/orbkey.git', 'claytantor/orbkey'],
      ['https://github.com/claytantor/orbkey', 'claytantor/orbkey'],
      ['git@github.com:claytantor/orbkey.git', 'claytantor/orbkey'],
      // The maintainer's own remote: an ssh_config host alias.
      ['git@github-claytantor:claytantor/orbkey.git', 'claytantor/orbkey'],
      ['git@github-claytantor:claytantor/orbkey', 'claytantor/orbkey'],
      ['ssh://git@github.com/claytantor/orbkey.git', 'claytantor/orbkey'],
      ['ssh://git@github.com:22/claytantor/orbkey.git', 'claytantor/orbkey'],
      ['https://github.com/claytantor/orbkey.git/', 'claytantor/orbkey'],
      ['https://github.com/claytantor/orbkey///', 'claytantor/orbkey'],
      ['  https://github.com/claytantor/orbkey.git  ', 'claytantor/orbkey'],
      ['https://user:token@github.com/claytantor/orbkey.git', 'claytantor/orbkey'],
      ['git+ssh://git@github.com/claytantor/orbkey.git', 'claytantor/orbkey'],
      ['https://github.com/claytantor/orbkey.GIT', 'claytantor/orbkey'],
    ];
    for (const [url, slug] of cases) {
      expect(remoteSlug(url), url).toBe(slug);
    }
  });

  it('returns null for anything that is not an owner/repo remote', () => {
    for (const bad of [
      '',
      '   ',
      'main',
      'not a url',
      'https://github.com',
      'https://github.com/',
      'https://github.com/claytantor',
      'https://github.com/claytantor/',
      'git@github.com:',
      'git@github.com:orbkey.git',
    ]) {
      expect(remoteSlug(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('planUpdate', () => {
  it('plans an update when a newer tag exists', () => {
    const plan = planUpdate('v0.1.0', ['v0.1.0', 'v0.2.0']);
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') throw new Error('expected update');
    expect(plan.current).toBe('v0.1.0');
    expect(plan.target.raw).toBe('v0.2.0');
  });

  it('accepts a bare package.json version as current', () => {
    const plan = planUpdate('0.1.0', ['v0.1.0', 'v1.10.0', 'v1.9.0']);
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') throw new Error('expected update');
    expect(plan.target.raw).toBe('v1.10.0');
  });

  it('reports up-to-date when current equals the newest tag', () => {
    expect(planUpdate('v0.2.0', ['v0.1.0', 'v0.2.0'])).toEqual({
      kind: 'up-to-date',
      current: 'v0.2.0',
    });
    // The v-prefix must not make an identical version look different.
    expect(planUpdate('0.2.0', ['v0.2.0'])).toEqual({ kind: 'up-to-date', current: '0.2.0' });
  });

  it('reports no-releases when nothing in the list is a release tag', () => {
    expect(planUpdate('0.1.0', [])).toEqual({ kind: 'no-releases' });
    expect(planUpdate('0.1.0', ['main', 'v1.2', 'v2.0.0-rc1'])).toEqual({ kind: 'no-releases' });
  });

  it('reports ahead for a dev build newer than any tag', () => {
    const plan = planUpdate('0.3.0', ['v0.1.0', 'v0.2.0']);
    expect(plan.kind).toBe('ahead');
    if (plan.kind !== 'ahead') throw new Error('expected ahead');
    expect(plan.current).toBe('0.3.0');
    expect(plan.latest.raw).toBe('v0.2.0');
  });

  it('plans an update when the current version is unparseable but a release exists', () => {
    // Ancestry check is what protects this case, not the version compare.
    const plan = planUpdate('unknown', ['v0.2.0']);
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') throw new Error('expected update');
    expect(plan.target.raw).toBe('v0.2.0');
  });
});

describe('parseArgs', () => {
  it('launches the TUI with no arguments', () => {
    expect(parseArgs([])).toEqual({ kind: 'tui' });
  });

  it('recognizes help and version in both spellings', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('parses the update flags', () => {
    expect(parseArgs(['--update'])).toEqual({ kind: 'update', yes: false, dryRun: false });
    expect(parseArgs(['--update', '--yes'])).toEqual({ kind: 'update', yes: true, dryRun: false });
    expect(parseArgs(['--update', '-y'])).toEqual({ kind: 'update', yes: true, dryRun: false });
    expect(parseArgs(['--update', '--dry-run'])).toEqual({
      kind: 'update',
      yes: false,
      dryRun: true,
    });
  });

  it('errors on unknown flags and stray positionals', () => {
    expect(parseArgs(['--nope']).kind).toBe('error');
    expect(parseArgs(['secrets']).kind).toBe('error');
    expect(parseArgs(['--update', '--force']).kind).toBe('error');
    // --yes / --dry-run alone would silently do nothing; that is an error too.
    expect(parseArgs(['--yes']).kind).toBe('error');
    expect(parseArgs(['--dry-run']).kind).toBe('error');
  });

  it('help wins over update so `--update --help` never updates', () => {
    expect(parseArgs(['--update', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--update', '--version'])).toEqual({ kind: 'version' });
  });
});

describe('reexecArgs', () => {
  it('strips every update flag so the relaunched process cannot loop', () => {
    expect(reexecArgs(['--update', '--yes', '--dry-run', '-y'])).toEqual([]);
    expect(reexecArgs(['--update'])).toEqual([]);
    expect(reexecArgs([])).toEqual([]);
  });
});

describe('usage', () => {
  it('documents every flag in the CLI surface', () => {
    const text = usage();
    for (const flag of ['--version', '--help', '--update', '--yes', '--dry-run']) {
      expect(text, flag).toContain(flag);
    }
  });
});
