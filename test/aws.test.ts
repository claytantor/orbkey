/** Credential validation against the in-memory AWS mock (mirrors test_aws.py). */
import { describe, it, expect, beforeEach } from 'vitest';
import { AwsAuthError, validateCreds } from '../src/core/aws.js';
import { IamCreds } from '../src/core/keychain.js';
import { VaultLocation } from '../src/core/sync.js';
import { FakeAws, MOTO_ACCOUNT_ID, REGION } from './helpers/awsMock.js';

const BUCKET = 'orbkey-test-bucket';

let fake: FakeAws;
let location: VaultLocation;
function goodCreds(): IamCreds {
  return new IamCreds({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: REGION,
    accountId: MOTO_ACCOUNT_ID,
  });
}

beforeEach(() => {
  fake = new FakeAws();
  location = new VaultLocation(BUCKET, 'test-kms-key', 'vaults/default/vault.bin');
});

describe('validateCreds', () => {
  it('succeeds for valid scoped creds', async () => {
    const clients = await validateCreds(
      goodCreds(),
      BUCKET,
      location.vaultPrefix,
      location.kmsKeyId,
    );
    expect(clients).toBeTruthy();
  });

  it('rejects account id mismatch', async () => {
    const bad = new IamCreds({
      accessKeyId: goodCreds().accessKeyId,
      secretAccessKey: goodCreds().secretAccessKey,
      region: REGION,
      accountId: '999999999999',
    });
    await expect(
      validateCreds(bad, BUCKET, location.vaultPrefix, location.kmsKeyId),
    ).rejects.toThrow(/account id mismatch/);
  });

  it('rejects when ListObjects fails (missing bucket)', async () => {
    // Make ListObjectsV2 raise AccessDenied.
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    fake.s3Mock.on(ListObjectsV2Command).rejects(
      Object.assign(new Error('NoSuchBucket'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(
      validateCreds(goodCreds(), 'no-such-bucket-xyz', 'vaults/default/', location.kmsKeyId),
    ).rejects.toThrow(AwsAuthError);
  });
});
