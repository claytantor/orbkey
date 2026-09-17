/**
 * Pure version / tag / remote-URL logic for `orbkey --update`.
 *
 * PURE BY CONTRACT: no fs, no child_process, no network, no `process`. Every
 * decision the updater makes about *what* to do lives here so it can be tested
 * as plain function calls; `selfUpdate.ts` owns the *doing*.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** The tag exactly as it was given, e.g. `v1.2.3` — what git is asked to check out. */
  raw: string;
}

/** `v1.2.3` / `1.2.3` only. Prereleases, build metadata and partials are rejected. */
const SEMVER_RE = /^v?(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/;

/** Owner and repo names as git forges allow them. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** `scheme://[user@]host/path` */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/;

/** scp-style `user@host:path` (host may be an ssh_config alias, e.g. `github-claytantor`). */
const SCP_RE = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/;

/**
 * Parse `v1.2.3` or `1.2.3`.
 * Returns null for anything else, including prereleases (`1.2.3-rc1`),
 * partials (`v1.2`), four-part versions (`v1.2.3.4`) and branch names.
 */
export function parseSemVer(tag: string): SemVer | null {
  if (typeof tag !== 'string') return null;
  const m = SEMVER_RE.exec(tag);
  if (!m) return null;
  const [, major, minor, patch] = m;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    raw: tag,
  };
}

/**
 * -1 when a < b, 0 when equal, 1 when a > b.
 * Numeric on every field — `v1.10.0` is greater than `v1.9.0`.
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Highest valid semver tag in the list, or null when it contains none. */
export function latestTag(tags: readonly string[]): SemVer | null {
  let best: SemVer | null = null;
  for (const tag of tags) {
    const parsed = parseSemVer(tag);
    if (parsed === null) continue;
    if (best === null || compareSemVer(parsed, best) > 0) best = parsed;
  }
  return best;
}

/**
 * Normalize any git remote URL to `owner/repo`, or null if unparseable.
 *
 * Handles https, scp-style ssh (including ssh_config host aliases such as
 * `git@github-claytantor:...`), `ssh://`, an optional `.git` suffix and
 * trailing slashes. The last two path segments are the owner and the repo,
 * which is what every forge URL — and a bare local mirror — ends with.
 *
 * NOTE: this identifies the *repository*, not the *host*. Host identity is not
 * checked, and cannot be: the maintainer's own remote uses an ssh_config alias
 * host, so any host allow-list would reject the maintainer's machine.
 */
export function remoteSlug(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  let rawPath: string;
  const scheme = SCHEME_RE.exec(trimmed);
  if (scheme) {
    const afterScheme = scheme[1] ?? '';
    const slash = afterScheme.indexOf('/');
    if (slash < 0) return null; // authority but no path
    rawPath = afterScheme.slice(slash + 1);
  } else {
    const scp = SCP_RE.exec(trimmed);
    if (!scp) return null;
    rawPath = scp[2] ?? '';
  }

  let path = rawPath.replace(/\/+$/, '');
  if (/\.git$/i.test(path)) path = path.slice(0, -4);
  path = path.replace(/\/+$/, '');

  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (owner === undefined || repo === undefined) return null;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * The host portion of a git remote URL, lowercased. `null` when there is no
 * authority to speak of — notably `file:///...`, which has an empty host.
 *
 * `remoteSlug` deliberately reads the LAST TWO path segments, so on its own it
 * cannot tell `github.com/claytantor/orbkey` from
 * `evil.example.com/claytantor/orbkey`. Pair it with {@link isTrustedRemoteHost}.
 */
export function remoteHost(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  const scheme = SCHEME_RE.exec(trimmed);
  if (scheme) {
    const afterScheme = scheme[1] ?? '';
    const slash = afterScheme.indexOf('/');
    const authority = slash < 0 ? afterScheme : afterScheme.slice(0, slash);
    // Strip any `user[:pass]@` prefix, then any `:port` suffix.
    const at = authority.lastIndexOf('@');
    const hostPort = at < 0 ? authority : authority.slice(at + 1);
    const host = hostPort.replace(/:\d+$/, '');
    return host === '' ? null : host.toLowerCase();
  }
  const scp = SCP_RE.exec(trimmed);
  const host = scp?.[1];
  return host === undefined || host === '' ? null : host.toLowerCase();
}

/** The canonical upstream host. */
export const GITHUB_HOST = 'github.com';

/**
 * Is this host one we are willing to pull executable code from?
 *
 * - `github.com` (and its subdomains) — the real upstream.
 * - A bare name with NO dot, e.g. `github-claytantor` — an ssh_config alias.
 *   Aliases resolve through the user's OWN ssh config, which is local trusted
 *   configuration we cannot see from here; the maintainer's own remote is one,
 *   so refusing them would break the updater for the person who ships it.
 *
 * Everything else is refused, which is what stops a remote quietly repointed at
 * `https://evil.example.com/claytantor/orbkey.git` — that URL yields the right
 * owner/repo slug and would otherwise sail through the identity check.
 *
 * This is a MISCONFIGURATION guard, not a security boundary: anyone who can
 * rewrite your git remote can also just edit `dist/` directly.
 */
export function isTrustedRemoteHost(host: string | null): boolean {
  if (host === null || host === '') return false;
  const h = host.toLowerCase();
  if (h === GITHUB_HOST || h.endsWith(`.${GITHUB_HOST}`)) return true;
  // No dot and no path separator => an ssh_config alias, not a domain.
  return !h.includes('.') && !h.includes('/');
}

export type UpdatePlan =
  | { kind: 'up-to-date'; current: string }
  | { kind: 'update'; current: string; target: SemVer }
  | { kind: 'no-releases' }
  | { kind: 'ahead'; current: string; latest: SemVer };

/**
 * Decide what an update run should do.
 *
 * `current` may be a tag (`v0.2.0`) or a bare package.json version (`0.2.0`).
 * An unparseable `current` with releases available plans an update: the caller
 * still has to clear the ancestry check before anything is touched.
 */
export function planUpdate(current: string, tags: readonly string[]): UpdatePlan {
  const latest = latestTag(tags);
  if (latest === null) return { kind: 'no-releases' };

  const parsed = parseSemVer(current);
  if (parsed === null) return { kind: 'update', current, target: latest };

  const cmp = compareSemVer(parsed, latest);
  if (cmp === 0) return { kind: 'up-to-date', current };
  if (cmp > 0) return { kind: 'ahead', current, latest };
  return { kind: 'update', current, target: latest };
}
