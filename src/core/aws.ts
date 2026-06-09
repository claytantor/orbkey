/**
 * AWS SDK v3 client factory and credential validation.
 *
 * Clients are built only from the in-memory IAM creds unwrapped from the
 * keychain — never from ambient profiles or environment variables — so the
 * tool's authority is exactly the scoped key the user configured.
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
} from '@aws-sdk/client-kms';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { KmsClientLike } from './crypto.js';
import type { IamCreds } from './keychain.js';

export class AwsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwsAuthError';
  }
}

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

const MAX_ATTEMPTS = 3;

/** Strip surrounding quotes from an S3 ETag. */
export function stripEtag(etag: string): string {
  return etag.replace(/^"+|"+$/g, '');
}

/** True when an SDK error looks like a lost-network / endpoint failure. */
export function isNetworkError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string };
  const name = e?.name ?? '';
  const code = e?.code ?? '';
  return (
    name === 'TimeoutError' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    name === 'EndpointConnectionError'
  );
}

/** HTTP status code from an SDK v3 error, if present. */
export function httpStatus(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode;
}

/** Error code/name from an SDK v3 error. */
export function errorCode(err: unknown): string {
  const e = err as { name?: string; Code?: string };
  return e?.name ?? e?.Code ?? 'Unknown';
}

/**
 * S3/KMS/STS clients bound to a single set of creds. The KMS client satisfies
 * {@link KmsClientLike} so the crypto layer can call it directly.
 */
export class AwsClients {
  readonly s3: S3Client;
  private readonly stsClient: STSClient;
  private readonly kmsClient: KMSClient;
  readonly kms: KmsClientLike;

  constructor(creds: IamCreds) {
    const credentials = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    };
    const region = creds.region;
    this.s3 = new S3Client({ region, credentials, maxAttempts: MAX_ATTEMPTS });
    this.kmsClient = new KMSClient({
      region,
      credentials,
      maxAttempts: MAX_ATTEMPTS,
    });
    this.stsClient = new STSClient({
      region,
      credentials,
      maxAttempts: MAX_ATTEMPTS,
    });

    // Adapt the SDK v3 command API to the simple KmsClientLike shape.
    this.kms = {
      generateDataKey: async (input) => {
        const out = await this.kmsClient.send(
          new GenerateDataKeyCommand({
            KeyId: input.KeyId,
            KeySpec: input.KeySpec,
          }),
        );
        return {
          ...(out.Plaintext !== undefined ? { Plaintext: out.Plaintext } : {}),
          ...(out.CiphertextBlob !== undefined
            ? { CiphertextBlob: out.CiphertextBlob }
            : {}),
        };
      },
      decrypt: async (input) => {
        const out = await this.kmsClient.send(
          new DecryptCommand({ CiphertextBlob: input.CiphertextBlob }),
        );
        return out.Plaintext !== undefined ? { Plaintext: out.Plaintext } : {};
      },
    };
  }

  // --- S3 helpers used by the sync engine ---------------------------------

  async headObjectEtag(bucket: string, key: string): Promise<string | null> {
    try {
      const out = await this.s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return out.ETag ? stripEtag(out.ETag) : null;
    } catch (err) {
      const status = httpStatus(err);
      const code = errorCode(err);
      if (status === 403 || status === 404) {
        return null;
      }
      if (['NoSuchKey', 'NotFound', '404'].includes(code)) {
        return null;
      }
      throw err;
    }
  }

  async getObject(
    bucket: string,
    key: string,
  ): Promise<{ blob: Buffer; etag: string }> {
    const out = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = out.Body as { transformToByteArray(): Promise<Uint8Array> };
    const bytes = await body.transformToByteArray();
    return {
      blob: Buffer.from(bytes),
      etag: out.ETag ? stripEtag(out.ETag) : '',
    };
  }

  async describeKey(kmsKeyId: string): Promise<void> {
    await this.kmsClient.send(new DescribeKeyCommand({ KeyId: kmsKeyId }));
  }

  async getCallerAccount(): Promise<string | undefined> {
    const ident = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return ident.Account;
  }

  async putObject(
    bucket: string,
    key: string,
    blob: Buffer,
    opts: { ifMatch?: string; ifNoneMatch?: boolean } = {},
  ): Promise<string> {
    const out = await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: blob,
        ...(opts.ifMatch ? { IfMatch: opts.ifMatch } : {}),
        ...(opts.ifNoneMatch ? { IfNoneMatch: '*' } : {}),
      }),
    );
    return out.ETag ? stripEtag(out.ETag) : '';
  }
}

/**
 * Verify the creds work and are scoped to the expected resources.
 *
 * Checks (in order):
 *   1. sts:GetCallerIdentity — assert the account id matches.
 *   2. s3:ListBucket on the vault prefix.
 *   3. kms:DescribeKey on the CMK.
 *
 * Returns live {@link AwsClients} on success; throws {@link AwsAuthError} or
 * {@link OfflineError} otherwise.
 */
export async function validateCreds(
  creds: IamCreds,
  bucket: string,
  vaultPrefix: string,
  kmsKeyId: string,
): Promise<AwsClients> {
  const clients = new AwsClients(creds);
  try {
    const account = await clients.getCallerAccount();
    if (account !== creds.accountId) {
      throw new AwsAuthError(
        `account id mismatch: creds resolve to ${account}, expected ${creds.accountId}`,
      );
    }
    await clients.s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: vaultPrefix,
        MaxKeys: 1,
      }),
    );
    await clients.describeKey(kmsKeyId);
  } catch (err) {
    if (err instanceof AwsAuthError) {
      throw err;
    }
    if (isNetworkError(err)) {
      throw new OfflineError(String((err as Error).message ?? err));
    }
    throw new AwsAuthError(explain(err));
  }
  return clients;
}

function explain(err: unknown): string {
  const code = errorCode(err);
  const msg = (err as { message?: string }).message ?? String(err);
  return `${code}: ${msg}`;
}
