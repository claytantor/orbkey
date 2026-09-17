/**
 * `orbkey --update` — move the installed git checkout to the newest tagged
 * release, reinstall deps and rebuild.
 *
 * Every command goes through the injected `UpdateIo`, which is what makes the
 * whole sequence testable without shelling out or touching the network. The
 * decision logic lives in `./version.js` (pure); this module only executes.
 *
 * Scope discipline: this touches NOTHING but the install checkout. No vault, no
 * keychain, no config, no AWS. Nothing it prints can contain a secret.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import {
  isTrustedRemoteHost,
  planUpdate,
  remoteHost,
  remoteSlug,
  type SemVer,
} from './version.js';

export interface UpdateIo {
  run(
    cmd: string,
    args: readonly string[],
    cwd: string,
  ): { code: number; stdout: string; stderr: string };
  log(line: string): void;
  confirm(question: string): boolean;
  exists(path: string): boolean;
}

export interface UpdateOptions {
  yes: boolean;
  dryRun: boolean;
  installDir: string;
  /**
   * Policy for which remote HOSTS we will pull executable code from. Defaults
   * to {@link isTrustedRemoteHost}, which is what production uses — the CLI
   * never sets this.
   *
   * It exists because the end-to-end tests have to serve a real git origin from
   * a local path, and a local path is (correctly) not a host we would ever
   * trust in production. Overriding it there keeps those tests exercising the
   * real git command sequence, while the host policy itself is verified
   * separately in test/update-remote-host.test.ts.
   */
  trustHost?: (host: string | null) => boolean;
}

export type UpdateResult = {
  ok: boolean;
  code: number;
  message: string;
  updatedTo?: string;
};

/** The only repository `--update` will ever pull from. */
export const EXPECTED_SLUG = 'claytantor/orbkey';

/** Shown when orbkey is not running out of a git checkout. */
export const NOT_A_CHECKOUT_MESSAGE =
  'orbkey was not installed from a git checkout, so it cannot update itself in place.\n' +
  'Reinstall with install.sh:\n' +
  '  curl -fsSL https://raw.githubusercontent.com/claytantor/orbkey/main/install.sh | bash';

/** Commit subjects listed before the delta is elided. */
const MAX_LOG_LINES = 20;

/**
 * Walk UP from `startDir` looking for a directory that holds both
 * `package.json` and `.git` — the repo root of the installed checkout.
 */
export function findInstallDir(
  startDir: string,
  io: Pick<UpdateIo, 'exists'>,
): string | null {
  let dir = startDir;
  const root = parsePath(dir).root;
  for (;;) {
    if (io.exists(join(dir, 'package.json')) && io.exists(join(dir, '.git'))) {
      return dir;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function fail(message: string, code = 1): UpdateResult {
  return { ok: false, code, message };
}

/** A failed command aborts the run with that command's stderr surfaced. */
function commandFailure(
  label: string,
  cmd: string,
  args: readonly string[],
  res: { code: number; stdout: string; stderr: string },
): UpdateResult {
  const detail = (res.stderr.trim() || res.stdout.trim() || '(no output)').trim();
  return fail(`${label} failed (${cmd} ${args.join(' ')} exited ${res.code}):\n${detail}`);
}

/**
 * Fall back to package.json's version when HEAD is not exactly on a tag.
 * Read directly rather than through `UpdateIo` — the injected surface is
 * commands, not files — and treated as best-effort: an unreadable or malformed
 * package.json just means the version is unknown.
 */
function readPackageVersion(installDir: string): string | null {
  try {
    const raw = readFileSync(join(installDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string' && version.trim() !== '') return version.trim();
    }
    return null;
  } catch {
    return null;
  }
}

type PackageManager = { bin: string; install: readonly string[]; build: readonly string[] };

function detectPackageManager(installDir: string, io: UpdateIo): PackageManager | null {
  if (io.exists(join(installDir, 'pnpm-lock.yaml'))) {
    return { bin: 'pnpm', install: ['install', '--frozen-lockfile'], build: ['run', 'build'] };
  }
  if (io.exists(join(installDir, 'package-lock.json'))) {
    return { bin: 'npm', install: ['ci'], build: ['run', 'build'] };
  }
  return null;
}

function formatDelta(logOutput: string): string[] {
  const lines = logOutput
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  if (lines.length <= MAX_LOG_LINES) return lines;
  const shown = lines.slice(0, MAX_LOG_LINES);
  shown.push(`... and ${lines.length - MAX_LOG_LINES} more`);
  return shown;
}

/**
 * Run the update sequence. Order is fixed by contract; every guard below is a
 * refusal point, and no mutating command runs until all of them have passed
 * and the user has confirmed.
 */
export function selfUpdate(io: UpdateIo, opts: UpdateOptions): UpdateResult {
  const dir = opts.installDir;

  // 1. The install dir must be a git checkout.
  if (!io.exists(join(dir, '.git'))) {
    return fail(NOT_A_CHECKOUT_MESSAGE);
  }

  const git = (...args: string[]): { code: number; stdout: string; stderr: string } =>
    io.run('git', args, dir);

  // 2. Remote identity. Refuse to pull code from anywhere but the real repo.
  const remote = git('remote', 'get-url', 'origin');
  if (remote.code !== 0) {
    return commandFailure('Reading the git remote', 'git', ['remote', 'get-url', 'origin'], remote);
  }
  const remoteUrl = remote.stdout.trim();
  const slug = remoteSlug(remoteUrl);
  if (slug !== EXPECTED_SLUG) {
    return fail(
      `Refusing to update: origin is not ${EXPECTED_SLUG}.\n` +
        `  expected: ${EXPECTED_SLUG}\n` +
        `  found:    ${slug ?? '(unrecognized remote)'}\n` +
        `  origin:   ${remoteUrl}`,
    );
  }
  // The slug alone reads the last two path segments, so
  // `https://evil.example.com/claytantor/orbkey.git` matches EXPECTED_SLUG.
  // Check the host too, or the identity check is theatre.
  const host = remoteHost(remoteUrl);
  const trustHost = opts.trustHost ?? isTrustedRemoteHost;
  if (!trustHost(host)) {
    return fail(
      `Refusing to update: origin ${EXPECTED_SLUG} is served from an untrusted host.\n` +
        `  host:   ${host ?? '(none)'}\n` +
        `  origin: ${remoteUrl}\n` +
        'Expected github.com, or an ssh_config alias from your own ~/.ssh/config.',
    );
  }

  // 3. Clean working tree, or this is a dev checkout and an update clobbers work.
  const status = git('status', '--porcelain');
  if (status.code !== 0) {
    return commandFailure('Checking the working tree', 'git', ['status', '--porcelain'], status);
  }
  if (status.stdout.trim() !== '') {
    return fail(
      `Refusing to update: the checkout at ${dir} has uncommitted changes.\n` +
        'This looks like a development checkout. Commit, stash or discard them first.',
    );
  }

  // 4. Fetch tags. install.sh clones --depth 1, so shallow is the common case
  //    and a plain fetch would never see the release tags.
  const shallow = git('rev-parse', '--is-shallow-repository');
  if (shallow.code !== 0) {
    return commandFailure(
      'Checking clone depth',
      'git',
      ['rev-parse', '--is-shallow-repository'],
      shallow,
    );
  }
  const isShallow = shallow.stdout.trim() === 'true';
  const fetchArgs = isShallow
    ? ['fetch', '--tags', '--force', '--unshallow', 'origin']
    : ['fetch', '--tags', '--force', 'origin'];
  io.log(isShallow ? 'Fetching release tags (unshallowing clone)...' : 'Fetching release tags...');
  const fetched = git(...fetchArgs);
  if (fetched.code !== 0) {
    return commandFailure('Fetching tags', 'git', fetchArgs, fetched);
  }

  // 5. What is installed, and what is the newest release?
  const tagList = git('tag', '--list');
  if (tagList.code !== 0) {
    return commandFailure('Listing tags', 'git', ['tag', '--list'], tagList);
  }
  const tags = tagList.stdout
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t !== '');

  const described = git('describe', '--tags', '--exact-match', 'HEAD');
  const currentVersion =
    described.code === 0 && described.stdout.trim() !== ''
      ? described.stdout.trim()
      : (readPackageVersion(dir) ?? 'unknown');

  const plan = planUpdate(currentVersion, tags);
  switch (plan.kind) {
    case 'no-releases':
      return { ok: true, code: 0, message: 'No tagged release exists yet — nothing to update to.' };
    case 'up-to-date':
      return {
        ok: true,
        code: 0,
        message: `orbkey ${plan.current} is already the newest release.`,
      };
    case 'ahead':
      return {
        ok: true,
        code: 0,
        message:
          `Installed version ${plan.current} is newer than the latest release ${plan.latest.raw}.\n` +
          'This is a development build; leaving it alone.',
      };
    case 'update':
      break;
    default: {
      const exhaustive: never = plan;
      return fail(`Unhandled update plan: ${JSON.stringify(exhaustive)}`);
    }
  }

  const target: SemVer = plan.target;

  // 6. Ancestry — the tag-channel equivalent of --ff-only. Blocks a downgrade
  //    and blocks a tag built on rewritten history.
  const ancestor = git('merge-base', '--is-ancestor', 'HEAD', target.raw);
  if (ancestor.code !== 0) {
    return fail(
      `Refusing to update: HEAD is not an ancestor of ${target.raw}.\n` +
        'The tag does not build on what is installed — history was rewritten, or this\n' +
        'checkout is on a different line of development. Reinstall with install.sh instead.',
    );
  }

  // 7. Show the delta.
  const log = git('log', '--oneline', '--no-merges', `HEAD..${target.raw}`);
  if (log.code !== 0) {
    return commandFailure(
      'Reading the changelog',
      'git',
      ['log', '--oneline', '--no-merges', `HEAD..${target.raw}`],
      log,
    );
  }
  io.log('');
  io.log(`orbkey ${plan.current} -> ${target.raw}`);
  const delta = formatDelta(log.stdout);
  if (delta.length > 0) {
    io.log('');
    for (const line of delta) io.log(`  ${line}`);
  }
  io.log('');

  // 8. Dry run stops here, having changed nothing.
  if (opts.dryRun) {
    return {
      ok: true,
      code: 0,
      message: `Dry run: would update ${plan.current} -> ${target.raw} in ${dir}. Nothing was changed.`,
    };
  }

  // 9. Explicit confirmation. Default is NO; a bare Enter does not update.
  if (!opts.yes && !io.confirm(`Update orbkey to ${target.raw}?`)) {
    return { ok: false, code: 0, message: 'Update cancelled. Nothing was changed.' };
  }

  // 10. Move to the tag.
  const checkoutArgs = ['-c', 'advice.detachedHead=false', 'checkout', '--detach', target.raw];
  io.log(`Checking out ${target.raw}...`);
  const checkout = git(...checkoutArgs);
  if (checkout.code !== 0) {
    return commandFailure(`Checking out ${target.raw}`, 'git', checkoutArgs, checkout);
  }

  // 11. Install dependencies with the manager this checkout actually uses.
  const pm = detectPackageManager(dir, io);
  if (pm === null) {
    return fail(
      `No lockfile found in ${dir} (expected pnpm-lock.yaml or package-lock.json).\n` +
        `The checkout is now on ${target.raw} but was not rebuilt; reinstall with install.sh.`,
    );
  }
  io.log(`Installing dependencies (${pm.bin} ${pm.install.join(' ')})...`);
  const install = io.run(pm.bin, pm.install, dir);
  if (install.code !== 0) {
    return commandFailure('Installing dependencies', pm.bin, pm.install, install);
  }

  // 12. Build.
  io.log(`Building (${pm.bin} ${pm.build.join(' ')})...`);
  const build = io.run(pm.bin, pm.build, dir);
  if (build.code !== 0) {
    return commandFailure('Building', pm.bin, pm.build, build);
  }

  // 13. Done — the caller re-execs.
  return {
    ok: true,
    code: 0,
    message: `Updated orbkey to ${target.raw}.`,
    updatedTo: target.raw,
  };
}

/** Wait `ms` without a dependency, from synchronous code. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * Read one line from a TTY synchronously. `UpdateIo.confirm` is sync by
 * contract, so this reads fd 0 directly rather than using readline.
 */
function promptLine(question: string): string {
  process.stdout.write(`${question} [y/N] `);
  const buf = Buffer.alloc(1);
  let answer = '';
  // Bounded so a stdin that never becomes readable cannot spin forever.
  for (let guard = 0; guard < 12_000; guard += 1) {
    let read = 0;
    try {
      read = readSync(0, buf, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
        sleepSync(10);
        continue;
      }
      break;
    }
    if (read === 0) break; // EOF
    const ch = buf.toString('utf8', 0, 1);
    if (ch === '\n' || ch === '\r') break;
    answer += ch;
  }
  process.stdout.write('\n');
  return answer;
}

/** The real IO: spawnSync for commands, stdout for logs, fd 0 for the prompt. */
export const realUpdateIo: UpdateIo = {
  run(cmd, args, cwd) {
    const res = spawnSync(cmd, [...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) {
      return { code: 127, stdout: '', stderr: res.error.message };
    }
    return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  },
  log(line) {
    process.stdout.write(`${line}\n`);
  },
  confirm(question) {
    return /^y(es)?$/i.test(promptLine(question).trim());
  },
  exists(path) {
    return existsSync(path);
  },
};
