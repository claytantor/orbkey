/**
 * End-to-end export/import through the REAL SessionAdapter.
 *
 * The codec suites (test/export-*.test.ts) cover the pure format, and the UI
 * suite covers the screens against FakeSession. Neither touches the seam that
 * actually ships: a real VaultStore -> a real file on disk -> a real vault on
 * the way back. That seam is what this file tests, including the file mode and
 * the content-sniffing classifier.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from '../src/core/crypto.js';
import { InvalidToken } from '../src/core/crypto.js';
import { Session } from '../src/core/session.js';
import { SessionAdapter } from '../src/sessionAdapter.js';
import { FakeAws, MOTO_ACCOUNT_ID, REGION } from './helpers/awsMock.js';

const BUCKET = 'orbkey-test-bucket';
const KMS_KEY = 'test-kms-key';
// Cheap KDF for the VAULT. The export's own Argon2 call uses the format's
// default params and is not configurable — that is the contract.
const FAST: crypto.Argon2Params = { timeCost: 1, memoryCost: 8, parallelism: 1 };

const PASS = 'export-passphrase-9271';

/** Notes that would break a naive serializer. Built from escapes, never raw. */
const HOSTILE: Record<string, string> = {
  jsonInjection: '","value":"pwned","x":"',
  lineSeparators: '\u2028\u2029',
  ansi: '\x1b[31mRED\x1b[0m\x07',
  bidi: '\u202Egnp.exe',
  zeroWidth: 'a\u200Bb\uFEFFc',
  multiline: 'line1\nline2\ttabbed\r\n',
  quotesAndSlashes: '"'.repeat(20) + '\\'.repeat(20),
  unicode: 'café 日本語 🔐 naïve',
};

let fake: FakeAws;
let prevXdg: string | undefined;
let tmp: string;

beforeEach(() => {
  fake = new FakeAws();
  prevXdg = process.env.XDG_CONFIG_HOME;
  tmp = mkdtempSync(join(tmpdir(), 'orbkey-exp-'));
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

/**
 * A brand-new independent vault. Each one needs its OWN config dir and its own
 * remote object key — two vaults sharing either would have the second open the
 * first's checkpoint and fail authentication.
 */
async function freshVault(tag: string): Promise<SessionAdapter> {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), `orbkey-xdg-${tag}-`));
  const s = new Session();
  await s.firstRun({
    accountId: MOTO_ACCOUNT_ID,
    region: REGION,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    bucket: BUCKET,
    kmsKeyId: KMS_KEY,
    password: 'vault-pw',
    objectKey: `vaults/${tag}/vault.bin`,
    params: FAST,
  });
  return new SessionAdapter(s);
}

/** A vault holding one secret per hostile note, plus a plain one. */
async function loadedVault(tag = 'src'): Promise<SessionAdapter> {
  const a = await freshVault(tag);
  a.addSecret('plain/key', 'plain-value', 'an ordinary note', ['work']);
  for (const [name, note] of Object.entries(HOSTILE)) {
    a.addSecret(`hostile/${name}`, `value-${name}`, note, ['danger', name]);
  }
  return a;
}

describe('SessionAdapter export/import (real vault, real file)', () => {
  it('writes an export whose text carries no raw dangerous character', async () => {
    const a = await loadedVault();
    const dest = join(tmp, 'vault.json');
    const report = a.exportVault(dest, PASS);

    expect(report.secretCount).toBe(Object.keys(HOSTILE).length + 1);
    expect(report.path).toBe(dest);

    const text = readFileSync(dest, 'utf8');
    expect(report.bytes).toBe(Buffer.byteLength(text, 'utf8'));

    // The whole point of the format: none of these survive into the file.
    for (const ch of [
      '\u2028', '\u2029', '\x1b', '\x07', '\u202E', '\u200B', '\uFEFF',
    ]) {
      expect(text.includes(ch)).toBe(false);
    }
    // No C0 control other than the newlines the pretty-printer itself emits.
    expect(/[\x00-\x09\x0B-\x1F\x7F]/.test(text)).toBe(false);

    // Structurally intact, and the injection attempt did not create a key.
    const parsed = JSON.parse(text) as { orbkey: { format: string }; secrets: unknown[] };
    expect(parsed.orbkey.format).toBe('orbkey-export');
    expect(parsed.secrets).toHaveLength(Object.keys(HOSTILE).length + 1);
    expect((parsed as Record<string, unknown>).value).toBeUndefined();
  });

  it('creates the export file as 0600', async () => {
    const a = await loadedVault();
    const dest = join(tmp, 'perm.json');
    a.exportVault(dest, PASS);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions when overwriting a world-readable file', async () => {
    const a = await loadedVault();
    const dest = join(tmp, 'loose.json');
    writeFileSync(dest, 'stale', { mode: 0o644 });
    expect(statSync(dest).mode & 0o777).toBe(0o644);

    a.exportVault(dest, PASS);

    // writeFileSync's `mode` applies only on create, so an overwrite would
    // otherwise leave this at 0644 with secrets inside it.
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, 'utf8')).not.toBe('stale');
  });

  it('never writes a plaintext secret value into the file', async () => {
    const a = await loadedVault();
    const dest = join(tmp, 'novalues.json');
    a.exportVault(dest, PASS);
    const text = readFileSync(dest, 'utf8');
    for (const name of Object.keys(HOSTILE)) {
      expect(text.includes(`value-${name}`)).toBe(false);
    }
    expect(text.includes('plain-value')).toBe(false);
    expect(text.includes(PASS)).toBe(false);
  });

  it('round-trips every hostile note byte-exactly into a fresh vault', async () => {
    const src = await loadedVault();
    const dest = join(tmp, 'roundtrip.json');
    src.exportVault(dest, PASS);

    const target = await freshVault('dst');
    const report = target.importOrbkey(dest, PASS);

    expect(report.imported).toBe(Object.keys(HOSTILE).length + 1);
    expect(report.errors).toBe(0);
    expect(report.skipped).toBe(0);

    for (const [name, note] of Object.entries(HOSTILE)) {
      const got = target.getSecret(`hostile/${name}`);
      expect(got, `missing hostile/${name}`).not.toBeNull();
      expect(got?.note).toBe(note);
      expect(got?.value).toBe(`value-${name}`);
      expect(got?.labels.sort()).toEqual(['danger', name].sort());
    }
    const plain = target.getSecret('plain/key');
    expect(plain?.value).toBe('plain-value');
    expect(plain?.labels).toEqual(['work']);
  });

  it('preserves timestamps but mints fresh ids on import', async () => {
    const src = await loadedVault();
    const original = src.getSecret('plain/key');
    const dest = join(tmp, 'ids.json');
    src.exportVault(dest, PASS);

    const target = await freshVault('dst');
    target.importOrbkey(dest, PASS);
    const copy = target.getSecret('plain/key');

    expect(copy?.createdAt).toBe(original?.createdAt);
    expect(copy?.updatedAt).toBe(original?.updatedAt);
    expect(copy?.id).not.toBe(original?.id);
  });

  it('rejects a wrong passphrase without importing anything', async () => {
    const src = await loadedVault();
    const dest = join(tmp, 'wrongpass.json');
    src.exportVault(dest, PASS);

    const target = await freshVault('dst');
    expect(() => target.importOrbkey(dest, 'not-the-passphrase')).toThrow(InvalidToken);
    expect(target.listSecrets()).toHaveLength(0);
  });

  it('skips an identical secret and renames a conflicting one', async () => {
    const src = await loadedVault();
    const dest = join(tmp, 'collide.json');
    src.exportVault(dest, PASS);

    // Importing into a vault that already holds an identical row, plus one
    // that shares a key but holds a different value.
    const target = await freshVault('dst');
    target.addSecret('plain/key', 'plain-value', 'an ordinary note', ['work']);
    target.addSecret('hostile/ansi', 'DIFFERENT-VALUE', '', []);

    const report = target.importOrbkey(dest, PASS);

    expect(report.skipped).toBe(1); // plain/key was already there, identically
    expect(report.renamed).toBe(1); // hostile/ansi collided on key only
    expect(target.getSecret('hostile/ansi')?.value).toBe('DIFFERENT-VALUE');
    expect(target.getSecret('hostile/ansi-copy-1')?.value).toBe('value-ansi');
  });

  it('classifies files by content, not by extension', async () => {
    const a = await loadedVault();

    const misnamed = join(tmp, 'actually-orbkey.xml');
    a.exportVault(misnamed, PASS);
    expect(a.detectImportKind(misnamed)).toBe('orbkey');

    const keepass = join(tmp, 'actually-keepass.json');
    writeFileSync(keepass, '<?xml version="1.0"?>\n<KeePassFile></KeePassFile>\n');
    expect(a.detectImportKind(keepass)).toBe('keepass');

    writeFileSync(join(tmp, 'junk.json'), '{"not":"ours"}');
    expect(a.detectImportKind(join(tmp, 'junk.json'))).toBe('unknown');
  });

  it('classifies a missing or unreadable file as unknown rather than throwing', async () => {
    const a = await loadedVault();
    expect(a.detectImportKind(join(tmp, 'does-not-exist.json'))).toBe('unknown');
    expect(a.detectImportKind(tmp)).toBe('unknown'); // a directory
  });

  it('exports an empty vault without error', async () => {
    const a = await freshVault('empty-src');
    const dest = join(tmp, 'empty.json');
    const report = a.exportVault(dest, PASS);
    expect(report.secretCount).toBe(0);

    const target = await freshVault('dst');
    expect(target.importOrbkey(dest, PASS).imported).toBe(0);
  });
});
