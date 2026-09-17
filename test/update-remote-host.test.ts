/**
 * The remote identity check must verify the HOST, not just the owner/repo slug.
 *
 * Regression: `remoteSlug` reads the last two path segments, so
 * `https://evil.example.com/claytantor/orbkey.git` produced the expected
 * `claytantor/orbkey` and sailed through the identity check. An updater that
 * announces it verified the remote, while accepting any host that happens to
 * end in the right two segments, is worse than one that makes no claim.
 *
 * This is a MISCONFIGURATION guard, not a security boundary: an attacker who
 * can rewrite your git remote can also edit `dist/` directly.
 */
import { describe, it, expect } from 'vitest';
import {
  GITHUB_HOST,
  isTrustedRemoteHost,
  remoteHost,
  remoteSlug,
} from '../src/update/version.js';

/** What the updater actually requires before it will pull code. */
function accepted(url: string): boolean {
  return remoteSlug(url) === 'claytantor/orbkey' && isTrustedRemoteHost(remoteHost(url));
}

describe('remoteHost', () => {
  it('reads the host from every remote form git produces', () => {
    expect(remoteHost('https://github.com/claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('http://github.com/claytantor/orbkey')).toBe('github.com');
    expect(remoteHost('git@github.com:claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('ssh://git@github.com/claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('git@github-claytantor:claytantor/orbkey.git')).toBe('github-claytantor');
  });

  it('strips credentials and ports', () => {
    expect(remoteHost('https://user@github.com/claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('https://user:tok@github.com/claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('ssh://git@github.com:22/claytantor/orbkey.git')).toBe('github.com');
  });

  it('lowercases, and reports no host for file:// URLs', () => {
    expect(remoteHost('https://GitHub.COM/claytantor/orbkey.git')).toBe('github.com');
    expect(remoteHost('file:///tmp/whatever/claytantor/orbkey.git')).toBeNull();
  });
});

describe('isTrustedRemoteHost', () => {
  it('accepts github.com and its subdomains', () => {
    expect(isTrustedRemoteHost(GITHUB_HOST)).toBe(true);
    expect(isTrustedRemoteHost('www.github.com')).toBe(true);
  });

  it('accepts a dotless ssh_config alias', () => {
    // The maintainer's own remote is one of these. Refusing aliases would break
    // the updater for the person who ships it.
    expect(isTrustedRemoteHost('github-claytantor')).toBe(true);
    expect(isTrustedRemoteHost('work')).toBe(true);
  });

  it('refuses any other domain, and a missing host', () => {
    expect(isTrustedRemoteHost('evil.example.com')).toBe(false);
    expect(isTrustedRemoteHost('github.com.evil.example.com')).toBe(false);
    expect(isTrustedRemoteHost('notgithub.com')).toBe(false);
    expect(isTrustedRemoteHost(null)).toBe(false);
    expect(isTrustedRemoteHost('')).toBe(false);
  });
});

describe('what the updater will actually pull from', () => {
  it('accepts every legitimate form of the real remote', () => {
    for (const url of [
      'https://github.com/claytantor/orbkey.git',
      'https://github.com/claytantor/orbkey',
      'git@github.com:claytantor/orbkey.git',
      'git@github-claytantor:claytantor/orbkey.git', // the maintainer's own
      'ssh://git@github.com/claytantor/orbkey.git',
    ]) {
      expect(accepted(url), url).toBe(true);
    }
  });

  it('refuses a lookalike host carrying the right owner/repo', () => {
    for (const url of [
      'https://evil.example.com/claytantor/orbkey.git',
      'https://evil.example.com/a/b/claytantor/orbkey.git',
      'https://github.com.evil.example.com/claytantor/orbkey.git',
      'file:///tmp/whatever/claytantor/orbkey.git',
    ]) {
      // The slug check alone would pass all of these — that was the hole.
      expect(remoteSlug(url), `slug for ${url}`).toBe('claytantor/orbkey');
      expect(accepted(url), url).toBe(false);
    }
  });

  it('still refuses the wrong owner on the right host', () => {
    expect(accepted('https://github.com/someoneelse/orbkey.git')).toBe(false);
  });
});
