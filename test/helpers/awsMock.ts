/**
 * In-memory S3 + KMS mock for sync/session tests.
 *
 * Implements just enough of S3's optimistic-concurrency contract to drive the
 * sync state machine: HeadObject/GetObject/PutObject with IfMatch / IfNoneMatch
 * and ETag bookkeeping, plus ListObjectsV2 for validateCreds. KMS GenerateDataKey
 * returns a real random data key wrapped as `WRAP:<key>` so crypto round-trips;
 * Decrypt unwraps it. STS GetCallerIdentity returns a fixed account.
 */
import { mockClient } from 'aws-sdk-client-mock';
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
import { randomBytes, randomUUID } from 'node:crypto';

export const MOTO_ACCOUNT_ID = '123456789012';
export const REGION = 'us-east-1';

interface S3Object {
  body: Buffer;
  etag: string;
}

export class FakeAws {
  private readonly bucket = new Map<string, S3Object>();
  account = MOTO_ACCOUNT_ID;
  private readonly wrapMarker = Buffer.from('WRAP:');

  readonly s3Mock = mockClient(S3Client);
  readonly kmsMock = mockClient(KMSClient);
  readonly stsMock = mockClient(STSClient);

  constructor() {
    this.wire();
  }

  reset(): void {
    this.s3Mock.reset();
    this.kmsMock.reset();
    this.stsMock.reset();
    this.bucket.clear();
    this.wire();
  }

  private newEtag(): string {
    return randomUUID().replace(/-/g, '');
  }

  private wire(): void {
    // --- STS ---
    this.stsMock.on(GetCallerIdentityCommand).callsFake(() => ({
      Account: this.account,
      Arn: `arn:aws:iam::${this.account}:user/test`,
      UserId: 'AIDtest',
    }));

    // --- KMS ---
    this.kmsMock.on(GenerateDataKeyCommand).callsFake(() => {
      const key = randomBytes(32);
      return {
        Plaintext: new Uint8Array(key),
        CiphertextBlob: new Uint8Array(Buffer.concat([this.wrapMarker, key])),
      };
    });
    this.kmsMock.on(DecryptCommand).callsFake((input) => {
      const blob = Buffer.from(input.CiphertextBlob as Uint8Array);
      return { Plaintext: new Uint8Array(blob.subarray(this.wrapMarker.length)) };
    });
    this.kmsMock.on(DescribeKeyCommand).callsFake((input) => ({
      KeyMetadata: { KeyId: input.KeyId as string },
    }));

    // --- S3 ---
    this.s3Mock.on(ListObjectsV2Command).callsFake(() => ({ KeyCount: 0 }));

    this.s3Mock.on(HeadObjectCommand).callsFake((input) => {
      const obj = this.bucket.get(input.Key as string);
      if (!obj) {
        const err = new Error('Not Found') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return { ETag: `"${obj.etag}"`, ContentLength: obj.body.length };
    });

    this.s3Mock.on(GetObjectCommand).callsFake((input) => {
      const obj = this.bucket.get(input.Key as string);
      if (!obj) {
        const err = new Error('NoSuchKey') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'NoSuchKey';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      const body = obj.body;
      return {
        ETag: `"${obj.etag}"`,
        Body: {
          transformToByteArray: async () => new Uint8Array(body),
        },
      };
    });

    this.s3Mock.on(PutObjectCommand).callsFake((input) => {
      const key = input.Key as string;
      const existing = this.bucket.get(key);
      const ifMatch = input.IfMatch
        ? String(input.IfMatch).replace(/^"+|"+$/g, '')
        : undefined;
      const ifNoneMatch = input.IfNoneMatch
        ? String(input.IfNoneMatch)
        : undefined;

      const fail412 = (): never => {
        const err = new Error('At least one of the pre-conditions failed') as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = 'PreconditionFailed';
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      };

      if (ifNoneMatch === '*' && existing) {
        fail412();
      }
      if (ifMatch !== undefined) {
        if (!existing || existing.etag !== ifMatch) {
          fail412();
        }
      }

      const body = Buffer.from(input.Body as Uint8Array | Buffer);
      const etag = this.newEtag();
      this.bucket.set(key, { body, etag });
      return { ETag: `"${etag}"` };
    });
  }
}
