/**
 * Local password-encrypted keychain.
 *
 * `keychain.json` stores, under a key derived from the password (Argon2id), two
 * AES-256-GCM-wrapped blobs:
 *   - `wrapped_db_key` — a random 32-byte key used to encrypt the local checkpoint.
 *   - `wrapped_iam_creds` — the AWS IAM access key/secret + region + account id.
 *
 * It never contains plaintext keys or credentials. Password rotation only
 * re-wraps these two blobs — no AWS calls, and the vault is untouched.
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteText, keychainPath } from './config.js';
import * as crypto from './crypto.js';

export interface IamCredsData {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  accountId: string;
}

export class IamCreds implements IamCredsData {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  accountId: string;

  constructor(data: IamCredsData) {
    this.accessKeyId = data.accessKeyId;
    this.secretAccessKey = data.secretAccessKey;
    this.region = data.region;
    this.accountId = data.accountId;
  }

  /**
   * Serialize to the byte form Python wraps: a JSON object with snake_case keys,
   * sorted (matching `json.dumps(..., sort_keys=True)`).
   */
  toBytes(): Buffer {
    // sort_keys=True order: access_key_id, account_id, region, secret_access_key
    const obj = {
      access_key_id: this.accessKeyId,
      account_id: this.accountId,
      region: this.region,
      secret_access_key: this.secretAccessKey,
    };
    return Buffer.from(JSON.stringify(obj), 'utf-8');
  }

  static fromBytes(b: Buffer): IamCreds {
    const d = JSON.parse(b.toString('utf-8')) as {
      access_key_id: string;
      secret_access_key: string;
      region: string;
      account_id: string;
    };
    return new IamCreds({
      accessKeyId: d.access_key_id,
      secretAccessKey: d.secret_access_key,
      region: d.region,
      accountId: d.account_id,
    });
  }

  equals(other: IamCreds): boolean {
    return (
      this.accessKeyId === other.accessKeyId &&
      this.secretAccessKey === other.secretAccessKey &&
      this.region === other.region &&
      this.accountId === other.accountId
    );
  }
}

export interface UnlockedKeychain {
  dbKey: Buffer;
  iamCreds: IamCreds;
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

interface KeychainDoc {
  format_version: number;
  kdf_version: number;
  argon2_salt: string;
  argon2_params: { time_cost: number; memory_cost: number; parallelism: number };
  wrapped_db_key: string;
  wrapped_iam_creds: string;
}

const b64e = (b: Buffer): string => b.toString('base64');
const b64d = (s: string): Buffer => Buffer.from(s, 'base64');

export function exists(path: string = keychainPath()): boolean {
  return existsSync(path);
}

function writeDoc(path: string, doc: KeychainDoc): void {
  atomicWriteText(path, JSON.stringify(doc, null, 2));
}

export function create(
  password: string,
  iamCreds: IamCreds,
  params: crypto.Argon2Params = crypto.defaultArgon2Params(),
  path: string = keychainPath(),
): UnlockedKeychain {
  const salt = crypto.newSalt();
  const master = crypto.deriveKey(password, salt, params);

  const dbKey = crypto.randomKey();
  const wrappedDbKey = crypto.packLocalBlob(master, dbKey);
  const wrappedIam = crypto.packLocalBlob(master, iamCreds.toBytes());

  const doc: KeychainDoc = {
    format_version: crypto.LOCAL_FORMAT_VERSION,
    kdf_version: crypto.KDF_VERSION,
    argon2_salt: b64e(salt),
    argon2_params: crypto.argon2ParamsToJson(params),
    wrapped_db_key: b64e(wrappedDbKey),
    wrapped_iam_creds: b64e(wrappedIam),
  };
  writeDoc(path, doc);
  return { dbKey, iamCreds };
}

export function unlock(
  password: string,
  path: string = keychainPath(),
): UnlockedKeychain {
  if (!existsSync(path)) {
    throw new KeychainError('keychain does not exist (first run required)');
  }
  const doc = JSON.parse(readFileSync(path, 'utf-8')) as KeychainDoc;
  const salt = b64d(doc.argon2_salt);
  const params = crypto.argon2ParamsFromJson(doc.argon2_params);
  const master = crypto.deriveKey(password, salt, params);
  let dbKey: Buffer;
  let iamBytes: Buffer;
  try {
    dbKey = crypto.unpackLocalBlob(master, b64d(doc.wrapped_db_key));
    iamBytes = crypto.unpackLocalBlob(master, b64d(doc.wrapped_iam_creds));
  } catch (err) {
    if (err instanceof crypto.InvalidToken) {
      throw new KeychainError('incorrect password');
    }
    throw err;
  }
  return { dbKey, iamCreds: IamCreds.fromBytes(iamBytes) };
}

export function rotatePassword(
  oldPassword: string,
  newPassword: string,
  params: crypto.Argon2Params = crypto.defaultArgon2Params(),
  path: string = keychainPath(),
): UnlockedKeychain {
  const unlocked = unlock(oldPassword, path);
  const salt = crypto.newSalt();
  const master = crypto.deriveKey(newPassword, salt, params);

  const doc = JSON.parse(readFileSync(path, 'utf-8')) as KeychainDoc;
  doc.argon2_salt = b64e(salt);
  doc.argon2_params = crypto.argon2ParamsToJson(params);
  doc.wrapped_db_key = b64e(crypto.packLocalBlob(master, unlocked.dbKey));
  doc.wrapped_iam_creds = b64e(
    crypto.packLocalBlob(master, unlocked.iamCreds.toBytes()),
  );
  writeDoc(path, doc);
  return unlocked;
}

export function rotateIam(
  password: string,
  newCreds: IamCreds,
  path: string = keychainPath(),
): UnlockedKeychain {
  const doc = JSON.parse(readFileSync(path, 'utf-8')) as KeychainDoc;
  const salt = b64d(doc.argon2_salt);
  const params = crypto.argon2ParamsFromJson(doc.argon2_params);
  const master = crypto.deriveKey(password, salt, params);
  let dbKey: Buffer;
  try {
    dbKey = crypto.unpackLocalBlob(master, b64d(doc.wrapped_db_key));
  } catch (err) {
    if (err instanceof crypto.InvalidToken) {
      throw new KeychainError('incorrect password');
    }
    throw err;
  }
  doc.wrapped_iam_creds = b64e(crypto.packLocalBlob(master, newCreds.toBytes()));
  writeDoc(path, doc);
  return { dbKey, iamCreds: newCreds };
}
