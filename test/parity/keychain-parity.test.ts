/** Parity: TS unlocks a Python-written keychain.json with the same password. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as keychain from '../../src/core/keychain.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));

describe('keychain parity with Python', () => {
  it('unlocks a Python-written keychain', () => {
    const v = fx('keychain.json');
    const dir = mkdtempSync(join(tmpdir(), 'orbkey-kcp-'));
    const path = join(dir, 'keychain.json');
    writeFileSync(path, JSON.stringify(v.doc));

    const unlocked = keychain.unlock(String(v.password), path);
    expect(unlocked.dbKey.toString('base64')).toBe(v.expected_db_key_b64);

    const expected = v.expected_creds as {
      access_key_id: string;
      secret_access_key: string;
      region: string;
      account_id: string;
    };
    expect(unlocked.iamCreds.accessKeyId).toBe(expected.access_key_id);
    expect(unlocked.iamCreds.secretAccessKey).toBe(expected.secret_access_key);
    expect(unlocked.iamCreds.region).toBe(expected.region);
    expect(unlocked.iamCreds.accountId).toBe(expected.account_id);
  });
});
