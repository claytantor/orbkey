/** Session controller: first-run, unlock, mutation/sync, lock, rotation (mirrors test_session.py). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as config from '../src/core/config.js';
import * as crypto from '../src/core/crypto.js';
import { AwsAuthError } from '../src/core/aws.js';
import { IamCreds, KeychainError } from '../src/core/keychain.js';
import { Session } from '../src/core/session.js';
import { Outcome, SyncStatus } from '../src/core/sync.js';
import { FakeAws, MOTO_ACCOUNT_ID, REGION } from './helpers/awsMock.js';

const BUCKET = 'orbkey-test-bucket';
const VAULT_KEY = 'vaults/default/vault.bin';
const KMS_KEY = 'test-kms-key';
// Cheap KDF so the suite stays fast.
const FAST: crypto.Argon2Params = { timeCost: 1, memoryCost: 8, parallelism: 1 };

let fake: FakeAws;
let prevXdg: string | undefined;

function creds(): IamCreds {
  return new IamCreds({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: REGION,
    accountId: MOTO_ACCOUNT_ID,
  });
}

beforeEach(() => {
  fake = new FakeAws();
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'orbkey-xdg-'));
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

async function firstRun(password = 'pw'): Promise<{ s: Session; res: Awaited<ReturnType<Session['firstRun']>> }> {
  const s = new Session();
  const res = await s.firstRun({
    accountId: MOTO_ACCOUNT_ID,
    region: REGION,
    accessKeyId: creds().accessKeyId,
    secretAccessKey: creds().secretAccessKey,
    bucket: BUCKET,
    kmsKeyId: KMS_KEY,
    password,
    objectKey: VAULT_KEY,
    params: FAST,
  });
  return { s, res };
}

describe('Session', () => {
  it('first run creates and persists', async () => {
    const { s, res } = await firstRun();
    expect(res.outcome).toBe(Outcome.CREATED);
    expect(s.status).toBe(SyncStatus.SYNCED);
    expect(existsSync(config.keychainPath())).toBe(true);
    expect(existsSync(config.vaultConfigPath())).toBe(true);
  });

  it('first run account mismatch writes nothing', async () => {
    const s = new Session();
    await expect(
      s.firstRun({
        accountId: '999999999999',
        region: REGION,
        accessKeyId: creds().accessKeyId,
        secretAccessKey: creds().secretAccessKey,
        bucket: BUCKET,
        kmsKeyId: KMS_KEY,
        password: 'pw',
        objectKey: VAULT_KEY,
        params: FAST,
      }),
    ).rejects.toThrow(AwsAuthError);
    expect(existsSync(config.keychainPath())).toBe(false);
    expect(existsSync(config.vaultConfigPath())).toBe(false);
  });

  it('unlock after first run sees data', async () => {
    const { s } = await firstRun();
    s.addSecret('k', 'v', '', ['x']);
    await s.close();

    const s2 = new Session();
    const res = await s2.unlock('pw');
    expect([Outcome.IN_SYNC, Outcome.PULLED, Outcome.LOCAL_AHEAD]).toContain(res.outcome);
    expect(s2.store!.getSecret('k')!.value).toBe('v');
  });

  it('mutation marks dirty, then sync clears', async () => {
    const { s } = await firstRun();
    s.addSecret('k', 'v');
    expect(s.status).toBe(SyncStatus.DIRTY);
    expect(s.state!.localDirty).toBe(true);
    const report = await s.sync();
    expect(report.pushed).toBe(true);
    expect(s.status).toBe(SyncStatus.SYNCED);
    expect(s.state!.localDirty).toBe(false);
  });

  it('lock zeroizes', async () => {
    const { s } = await firstRun();
    s.lock();
    expect(s.locked).toBe(true);
    expect(s.store).toBeNull();
    expect(s.keychain).toBeNull();
  });

  it('wrong password unlock fails', async () => {
    await firstRun();
    const s = new Session();
    await expect(s.unlock('wrong')).rejects.toThrow(KeychainError);
  });

  it('rotate password', async () => {
    const { s } = await firstRun();
    s.rotatePassword('pw', 'newpw');
    s.lock();
    const s2 = new Session();
    await expect(s2.unlock('pw')).rejects.toThrow(KeychainError);
    const res = await s2.unlock('newpw');
    expect(res.store).not.toBeNull();
  });

  it('rotate iam keeps vault', async () => {
    const { s } = await firstRun();
    s.addSecret('k', 'v');
    const next = new IamCreds({
      accessKeyId: creds().accessKeyId,
      secretAccessKey: creds().secretAccessKey,
      region: REGION,
      accountId: MOTO_ACCOUNT_ID,
    });
    s.rotateIam('pw', next);
    const report = await s.sync();
    expect(report.pushed).toBe(true);
    expect(s.store!.getSecret('k')!.value).toBe('v');
  });
});
