/**
 * selfUpdate: the command sequence, every refusal, and one run against a REAL
 * shallow git clone (pure fakes can happily agree with a wrong mental model of
 * git; the real-repo test is what proves the sequence actually works).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXPECTED_SLUG,
  findInstallDir,
  selfUpdate,
  type UpdateIo,
} from '../src/update/selfUpdate.js';

// ---------------------------------------------------------------------------
// Fake IO
// ---------------------------------------------------------------------------

const INSTALL_DIR = join('/opt', 'orbkey-under-test'); // never touched on disk

/** Temp dirs created by tests, removed after each. */
const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});


type Resp = { code?: number; stdout?: string; stderr?: string };

const HAPPY: Readonly<Record<string, Resp>> = {
  'git remote get-url origin': { stdout: 'git@github-claytantor:claytantor/orbkey.git\n' },
  'git status --porcelain': { stdout: '' },
  'git rev-parse --is-shallow-repository': { stdout: 'false\n' },
  'git fetch --tags --force origin': {},
  'git tag --list': { stdout: 'v0.1.0\nv0.2.0\n' },
  'git describe --tags --exact-match HEAD': { stdout: 'v0.1.0\n' },
  'git merge-base --is-ancestor HEAD v0.2.0': {},
  'git log --oneline --no-merges HEAD..v0.2.0': {
    stdout: 'abc1234 feat: a thing\ndef5678 fix: another thing\n',
  },
  'git -c advice.detachedHead=false checkout --detach v0.2.0': {},
  'pnpm install --frozen-lockfile': {},
  'pnpm run build': {},
};

interface Harness {
  io: UpdateIo;
  calls: string[];
  cwds: string[];
  logs: string[];
  questions: string[];
}

function makeIo(
  over: {
    responses?: Record<string, Resp>;
    files?: readonly string[];
    confirm?: boolean;
    installDir?: string;
  } = {},
): Harness {
  const dir = over.installDir ?? INSTALL_DIR;
  const responses: Record<string, Resp> = { ...HAPPY, ...(over.responses ?? {}) };
  const files = new Set(over.files ?? [join(dir, '.git'), join(dir, 'pnpm-lock.yaml')]);
  const calls: string[] = [];
  const cwds: string[] = [];
  const logs: string[] = [];
  const questions: string[] = [];

  const io: UpdateIo = {
    run(cmd, args, cwd) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      cwds.push(cwd);
      const r = responses[line] ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    log(line) {
      logs.push(line);
    },
    confirm(question) {
      questions.push(question);
      return over.confirm ?? true;
    },
    exists(path) {
      return files.has(path);
    },
  };
  return { io, calls, cwds, logs, questions };
}

/** Anything that changes the checkout or the installed build. */
const isMutating = (line: string): boolean =>
  line.includes('checkout') || line.startsWith('pnpm') || line.startsWith('npm');

const run = (h: Harness, opts: { yes?: boolean; dryRun?: boolean; installDir?: string } = {}) =>
  selfUpdate(h.io, {
    yes: opts.yes ?? true,
    dryRun: opts.dryRun ?? false,
    installDir: opts.installDir ?? INSTALL_DIR,
  });

// ---------------------------------------------------------------------------
// findInstallDir
// ---------------------------------------------------------------------------

describe('findInstallDir', () => {
  it('walks up to the directory holding both package.json and .git', () => {
    const root = join('/home', 'someone', 'orbkey');
    const io = {
      exists: (p: string) => p === join(root, 'package.json') || p === join(root, '.git'),
    };
    expect(findInstallDir(join(root, 'dist'), io)).toBe(root);
    expect(findInstallDir(join(root, 'src', 'update'), io)).toBe(root);
    expect(findInstallDir(root, io)).toBe(root);
  });

  it('returns null when nothing above startDir is a checkout', () => {
    // package.json but no .git — e.g. an npm-installed tree.
    const io = { exists: (p: string) => p.endsWith('package.json') };
    expect(findInstallDir(join('/usr', 'lib', 'node_modules', 'orbkey', 'dist'), io)).toBeNull();
    expect(findInstallDir('/', { exists: () => false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('selfUpdate refusals', () => {
  it('refuses when the install dir is not a git checkout', () => {
    const h = makeIo({ files: [] });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('not installed from a git checkout');
    expect(h.calls).toEqual([]);
  });

  it('refuses a wrong remote and names both slugs', () => {
    const h = makeIo({
      responses: {
        'git remote get-url origin': { stdout: 'git@github.com:attacker/orbkey.git\n' },
      },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain(EXPECTED_SLUG);
    expect(res.message).toContain('attacker/orbkey');
    expect(res.message).toContain('git@github.com:attacker/orbkey.git');
    expect(h.calls).toEqual(['git remote get-url origin']);
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('refuses an unparseable remote and echoes the raw origin url', () => {
    const h = makeIo({
      responses: { 'git remote get-url origin': { stdout: 'not-a-remote\n' } },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('(unrecognized remote)');
    expect(res.message).toContain('not-a-remote');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('refuses a remote that merely ends in the right two path segments', () => {
    // remoteSlug identifies owner/repo, not the host, so the refusal always
    // prints the raw url next to the slug it derived.
    const h = makeIo({
      responses: { 'git remote get-url origin': { stdout: 'file:///tmp/evil\n' } },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('tmp/evil');
    expect(res.message).toContain('file:///tmp/evil');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('refuses a dirty working tree', () => {
    const h = makeIo({
      responses: { 'git status --porcelain': { stdout: ' M src/ui/app.tsx\n?? scratch.ts\n' } },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('uncommitted changes');
    expect(h.calls).toEqual(['git remote get-url origin', 'git status --porcelain']);
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('refuses when HEAD is not an ancestor of the target tag', () => {
    const h = makeIo({
      responses: { 'git merge-base --is-ancestor HEAD v0.2.0': { code: 1 } },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('not an ancestor of v0.2.0');
    expect(h.calls).toContain('git merge-base --is-ancestor HEAD v0.2.0');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('aborts on a non-zero exit from any step and surfaces that stderr', () => {
    const h = makeIo({
      responses: {
        'git fetch --tags --force origin': {
          code: 128,
          stderr: 'fatal: could not read from remote repository',
        },
      },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('Fetching tags failed');
    expect(res.message).toContain('could not read from remote repository');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('aborts when the build fails, surfacing the builder stderr', () => {
    const h = makeIo({
      responses: { 'pnpm run build': { code: 2, stderr: 'error TS2345: nope' } },
    });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Building failed');
    expect(res.message).toContain('error TS2345');
  });
});

// ---------------------------------------------------------------------------
// Plans that stop early
// ---------------------------------------------------------------------------

describe('selfUpdate plans', () => {
  it('reports up-to-date and changes nothing', () => {
    const h = makeIo({
      responses: { 'git describe --tags --exact-match HEAD': { stdout: 'v0.2.0\n' } },
    });
    const res = run(h);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBeUndefined();
    expect(res.message).toContain('already the newest release');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('reports no-releases when the repo has no release tags', () => {
    const h = makeIo({ responses: { 'git tag --list': { stdout: 'nightly\nmain\n' } } });
    const res = run(h);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.message).toContain('No tagged release');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('leaves a dev build that is ahead of every tag alone', () => {
    const h = makeIo({
      responses: { 'git describe --tags --exact-match HEAD': { stdout: 'v0.9.0\n' } },
    });
    const res = run(h);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.message).toContain('newer than the latest release v0.2.0');
    expect(res.message).toContain('development build');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('falls back to package.json when HEAD is not exactly on a tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbkey-pkg-'));
    temps.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'orbkey', version: '0.2.0' }));
    const h = makeIo({
      installDir: dir,
      files: [join(dir, '.git'), join(dir, 'pnpm-lock.yaml')],
      responses: {
        'git describe --tags --exact-match HEAD': { code: 128, stderr: 'fatal: no tag exactly matches' },
      },
    });
    const res = run(h, { installDir: dir });
    // package.json says 0.2.0, the newest tag is v0.2.0 -> nothing to do.
    expect(res.ok).toBe(true);
    expect(res.message).toContain('0.2.0 is already the newest release');
    expect(h.calls.filter(isMutating)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dry run / confirmation
// ---------------------------------------------------------------------------

describe('selfUpdate gating', () => {
  it('dry run issues no mutating command and never prompts', () => {
    const h = makeIo();
    const res = run(h, { yes: false, dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBeUndefined();
    expect(res.message).toContain('Dry run');
    expect(h.calls).not.toContain('git -c advice.detachedHead=false checkout --detach v0.2.0');
    expect(h.calls.filter(isMutating)).toEqual([]);
    expect(h.questions).toEqual([]);
    // It still reports the delta it would apply.
    expect(h.logs.join('\n')).toContain('v0.1.0 -> v0.2.0');
    expect(h.logs.join('\n')).toContain('feat: a thing');
  });

  it('declining the prompt issues no mutating command', () => {
    const h = makeIo({ confirm: false });
    const res = run(h, { yes: false });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(0); // a decline is not a failure
    expect(res.message).toContain('cancelled');
    expect(h.questions).toEqual(['Update orbkey to v0.2.0?']);
    expect(h.calls.filter(isMutating)).toEqual([]);
  });

  it('--yes skips the prompt entirely', () => {
    const h = makeIo();
    const res = run(h, { yes: true });
    expect(res.ok).toBe(true);
    expect(h.questions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('selfUpdate happy path', () => {
  it('issues the commands in contract order', () => {
    const h = makeIo();
    const res = run(h);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBe('v0.2.0');
    expect(h.calls).toEqual([
      'git remote get-url origin',
      'git status --porcelain',
      'git rev-parse --is-shallow-repository',
      'git fetch --tags --force origin',
      'git tag --list',
      'git describe --tags --exact-match HEAD',
      'git merge-base --is-ancestor HEAD v0.2.0',
      'git log --oneline --no-merges HEAD..v0.2.0',
      'git -c advice.detachedHead=false checkout --detach v0.2.0',
      'pnpm install --frozen-lockfile',
      'pnpm run build',
    ]);
  });

  it('unshallows a shallow clone when fetching tags', () => {
    const h = makeIo({
      responses: {
        'git rev-parse --is-shallow-repository': { stdout: 'true\n' },
        'git fetch --tags --force --unshallow origin': {},
      },
    });
    const res = run(h);
    expect(res.ok).toBe(true);
    expect(h.calls).toContain('git fetch --tags --force --unshallow origin');
    expect(h.calls).not.toContain('git fetch --tags --force origin');
  });

  it('picks pnpm when pnpm-lock.yaml exists', () => {
    const h = makeIo({ files: [join(INSTALL_DIR, '.git'), join(INSTALL_DIR, 'pnpm-lock.yaml')] });
    run(h);
    expect(h.calls).toContain('pnpm install --frozen-lockfile');
    expect(h.calls).toContain('pnpm run build');
    expect(h.calls.some((c) => c.startsWith('npm'))).toBe(false);
  });

  it('picks npm when only package-lock.json exists', () => {
    const h = makeIo({
      files: [join(INSTALL_DIR, '.git'), join(INSTALL_DIR, 'package-lock.json')],
      responses: { 'npm ci': {}, 'npm run build': {} },
    });
    run(h);
    expect(h.calls).toContain('npm ci');
    expect(h.calls).toContain('npm run build');
    expect(h.calls.some((c) => c.startsWith('pnpm'))).toBe(false);
  });

  it('fails clearly when the checkout has no lockfile', () => {
    const h = makeIo({ files: [join(INSTALL_DIR, '.git')] });
    const res = run(h);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('No lockfile found');
  });

  it('caps the commit list and says how many were elided', () => {
    const many = Array.from({ length: 25 }, (_, i) => `c${i} commit ${i}`).join('\n');
    const h = makeIo({ responses: { 'git log --oneline --no-merges HEAD..v0.2.0': { stdout: many } } });
    run(h, { dryRun: true });
    const out = h.logs.join('\n');
    expect(out).toContain('c19 commit 19');
    expect(out).not.toContain('c20 commit 20');
    expect(out).toContain('... and 5 more');
  });

  it('only ever runs git and the package manager, always inside the install dir', () => {
    const h = makeIo();
    run(h);
    for (const call of h.calls) {
      expect(call.split(' ')[0], call).toMatch(/^(git|pnpm|npm)$/);
    }
    expect(new Set(h.cwds)).toEqual(new Set([INSTALL_DIR]));
  });
});

// ---------------------------------------------------------------------------
// Against a real git repository
// ---------------------------------------------------------------------------

/** Isolated from the developer's own git config (insteadOf rules, hooks, signing). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

/**
 * Build an origin at <tmp>/claytantor/orbkey.git with tags v0.1.0 and v0.2.0,
 * then make the SHALLOW clone that install.sh would make (`--depth 1`), parked
 * on v0.1.0. `file://` matters: git ignores --depth for plain local clones.
 */
function setupRealRepo(
  opts: { divergentTag?: boolean; checkout?: string } = {},
): { installDir: string; originDir: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'orbkey-selfupdate-'));
  temps.push(tmp);

  const originDir = join(tmp, 'claytantor', 'orbkey.git');
  mkdirSync(dirname(originDir), { recursive: true });
  git(tmp, 'init', '-q', '--bare', originDir);

  const work = join(tmp, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'orbkey test');
  git(work, 'config', 'commit.gpgsign', 'false');

  writeFileSync(join(work, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'orbkey', version: '0.1.0' }));
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'release 0.1.0');
  git(work, 'tag', 'v0.1.0');

  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'orbkey', version: '0.2.0' }));
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'feat: a real thing');
  writeFileSync(join(work, 'NOTES.md'), 'more\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'fix: a real bug');
  git(work, 'tag', 'v0.2.0');

  if (opts.divergentTag === true) {
    // A tag on a line of history the install has never seen — a rewritten
    // history, or someone else's fork pushed over the tag.
    git(work, 'checkout', '-q', '--orphan', 'rewritten');
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'orbkey', version: '0.3.0' }));
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'feat: unrelated history');
    git(work, 'tag', 'v0.3.0');
    git(work, 'checkout', '-q', 'main');
  }

  git(work, 'remote', 'add', 'origin', originDir);
  git(work, 'push', '-q', 'origin', 'main', '--tags');

  const installDir = join(tmp, 'install');
  git(
    tmp,
    'clone',
    '-q',
    '--depth',
    '1',
    '--branch',
    opts.checkout ?? 'v0.1.0',
    `file://${originDir}`,
    installDir,
  );
  return { installDir, originDir };
}

/** Real git, real fs; only the package manager is stubbed. */
function realGitIo(): { io: UpdateIo; pm: string[]; logs: string[] } {
  const pm: string[] = [];
  const logs: string[] = [];
  const io: UpdateIo = {
    run(cmd, args, cwd) {
      if (cmd !== 'git') {
        pm.push([cmd, ...args].join(' '));
        return { code: 0, stdout: '', stderr: '' };
      }
      const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: GIT_ENV });
      if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    log: (line) => logs.push(line),
    confirm: () => true,
    exists: (p) => existsSync(p),
  };
  return { io, pm, logs };
}

/**
 * These end-to-end tests serve the origin from a LOCAL PATH, which production
 * would rightly refuse to pull code from. Overriding the host policy keeps them
 * exercising the real git command sequence — the thing they exist to prove —
 * while the host policy itself is verified in test/update-remote-host.test.ts.
 */
const LOCAL_ORIGIN = (): boolean => true;

describe('selfUpdate against a real shallow clone', () => {
  it('starts from the shallow state install.sh produces', () => {
    const { installDir } = setupRealRepo();
    expect(git(installDir, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    // The release tag is not even visible until the updater unshallows.
    expect(git(installDir, 'tag', '--list').trim()).toBe('v0.1.0');
  });

  it('dry run fetches tags but leaves the checkout on v0.1.0', () => {
    const { installDir } = setupRealRepo();
    const { io, pm, logs } = realGitIo();
    const res = selfUpdate(io, { yes: false, dryRun: true, installDir, trustHost: LOCAL_ORIGIN });

    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBeUndefined();
    expect(logs.join('\n')).toContain('v0.1.0 -> v0.2.0');
    expect(logs.join('\n')).toContain('feat: a real thing');
    expect(pm).toEqual([]);
    expect(git(installDir, 'describe', '--tags', '--exact-match', 'HEAD').trim()).toBe('v0.1.0');
  });

  it('unshallows, moves HEAD to v0.2.0 and rebuilds', () => {
    const { installDir } = setupRealRepo();
    const { io, pm } = realGitIo();
    const res = selfUpdate(io, { yes: true, dryRun: false, installDir, trustHost: LOCAL_ORIGIN });

    expect(res.message).not.toContain('Refusing');
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBe('v0.2.0');
    expect(git(installDir, 'describe', '--tags', '--exact-match', 'HEAD').trim()).toBe('v0.2.0');
    expect(git(installDir, 'rev-parse', '--is-shallow-repository').trim()).toBe('false');
    expect(git(installDir, 'status', '--porcelain').trim()).toBe('');
    // The lockfile is read from the checked-out tag, so pnpm wins here.
    expect(pm).toEqual(['pnpm install --frozen-lockfile', 'pnpm run build']);
  });

  it('refuses a real dirty working tree', () => {
    const { installDir } = setupRealRepo();
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'orbkey', hacked: true }));
    const { io, pm } = realGitIo();
    const res = selfUpdate(io, { yes: true, dryRun: false, installDir, trustHost: LOCAL_ORIGIN });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('uncommitted changes');
    expect(pm).toEqual([]);
    expect(git(installDir, 'describe', '--tags', '--exact-match', 'HEAD').trim()).toBe('v0.1.0');
  });

  it('reports up-to-date when the install is already on the newest tag', () => {
    const { installDir } = setupRealRepo({ checkout: 'v0.2.0' });
    const { io, pm } = realGitIo();
    const res = selfUpdate(io, { yes: true, dryRun: false, installDir, trustHost: LOCAL_ORIGIN });

    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.updatedTo).toBeUndefined();
    expect(res.message).toContain('v0.2.0 is already the newest release');
    expect(pm).toEqual([]);
    expect(git(installDir, 'describe', '--tags', '--exact-match', 'HEAD').trim()).toBe('v0.2.0');
  });

  it('refuses a tag built on rewritten history (real ancestry check)', () => {
    const { installDir } = setupRealRepo({ divergentTag: true });
    const { io, pm } = realGitIo();
    const res = selfUpdate(io, { yes: true, dryRun: false, installDir, trustHost: LOCAL_ORIGIN });

    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.message).toContain('not an ancestor of v0.3.0');
    expect(pm).toEqual([]);
    expect(git(installDir, 'describe', '--tags', '--exact-match', 'HEAD').trim()).toBe('v0.1.0');
  });

  it('refuses when origin is not claytantor/orbkey', () => {
    const { installDir } = setupRealRepo();
    const elsewhere = join(dirname(installDir), 'someoneelse', 'orbkey.git');
    mkdirSync(dirname(elsewhere), { recursive: true });
    git(dirname(installDir), 'init', '-q', '--bare', elsewhere);
    git(installDir, 'remote', 'set-url', 'origin', `file://${elsewhere}`);

    const { io, pm } = realGitIo();
    const res = selfUpdate(io, { yes: true, dryRun: false, installDir, trustHost: LOCAL_ORIGIN });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('someoneelse/orbkey');
    expect(pm).toEqual([]);
  });
});
