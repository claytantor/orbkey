/** Keychain wrap/unwrap, rotation (no AWS), no-plaintext-on-disk (mirrors test_keychain.py). */
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import * as keychain from '../src/core/keychain.js';
import { IamCreds, KeychainError } from '../src/core/keychain.js';
import * as crypto from '../src/core/crypto.js';

// Cheap KDF so the suite stays fast.
const FAST: crypto.Argon2Params = { timeCost: 1, memoryCost: 8, parallelism: 1 };

function creds(): IamCreds {
  return new IamCreds({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'superSecretValue/123',
    region: 'us-east-1',
    accountId: '123456789012',
  });
}

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbkey-kc-'));
  mkdirSync(dir, { recursive: true });
  path = join(dir, 'keychain.json');
});

describe('keychain', () => {
  it('create then unlock round-trip', () => {
    const unlocked = keychain.create('pw', creds(), FAST, path);
    const again = keychain.unlock('pw', path);
    expect(again.dbKey.equals(unlocked.dbKey)).toBe(true);
    expect(again.iamCreds.equals(creds())).toBe(true);
  });

  it('wrong password fails', () => {
    keychain.create('pw', creds(), FAST, path);
    expect(() => keychain.unlock('nope', path)).toThrow(KeychainError);
  });

  it('no plaintext secrets on disk', () => {
    const c = creds();
    const unlocked = keychain.create('pw', c, FAST, path);
    const raw = readFileSync(path, 'utf-8');
    expect(raw.includes(c.secretAccessKey)).toBe(false);
    expect(raw.includes(c.accessKeyId)).toBe(false);
    expect(raw.includes(unlocked.dbKey.toString('latin1'))).toBe(false);
    const doc = JSON.parse(raw) as Record<string, unknown>;
    for (const k of [
      'argon2_salt',
      'argon2_params',
      'wrapped_db_key',
      'wrapped_iam_creds',
      'kdf_version',
      'format_version',
    ]) {
      expect(k in doc).toBe(true);
    }
  });

  it('rotate password preserves keys without AWS', () => {
    const unlocked = keychain.create('old', creds(), FAST, path);
    keychain.rotatePassword('old', 'new', FAST, path);
    expect(() => keychain.unlock('old', path)).toThrow(KeychainError);
    const after = keychain.unlock('new', path);
    expect(after.dbKey.equals(unlocked.dbKey)).toBe(true);
    expect(after.iamCreds.equals(creds())).toBe(true);
  });

  it('rotate iam replaces creds only', () => {
    const unlocked = keychain.create('pw', creds(), FAST, path);
    const next = new IamCreds({
      accessKeyId: 'AKIANEW',
      secretAccessKey: 'newSecret/456',
      region: 'us-west-2',
      accountId: '123456789012',
    });
    keychain.rotateIam('pw', next, path);
    const after = keychain.unlock('pw', path);
    expect(after.iamCreds.equals(next)).toBe(true);
    expect(after.dbKey.equals(unlocked.dbKey)).toBe(true);
  });

  it('rotate password changes salt', () => {
    keychain.create('old', creds(), FAST, path);
    const before = (JSON.parse(readFileSync(path, 'utf-8')) as { argon2_salt: string }).argon2_salt;
    keychain.rotatePassword('old', 'new', FAST, path);
    const after = (JSON.parse(readFileSync(path, 'utf-8')) as { argon2_salt: string }).argon2_salt;
    expect(before).not.toBe(after);
  });
});
