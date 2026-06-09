/**
 * Cryptographic primitives for orbkey.
 *
 * UI- and AWS-agnostic (the only AWS dependency is a KMS client passed in by the
 * caller). Two encryption layers, never conflated:
 *
 * - **Local layer** — vault bytes encrypted under a key derived from the user's
 *   password via Argon2id. Opens fully offline; never touches KMS.
 * - **Remote layer** — vault bytes encrypted under a fresh KMS data key per
 *   upload (`kms:GenerateDataKey`), then AES-256-GCM. The wrapped data key
 *   travels *with* the ciphertext as one blob.
 *
 * Both layers use AES-256-GCM with a fresh 96-bit nonce and fail closed.
 *
 * Byte-compatible with the Python implementation: Python's `AESGCM.encrypt`
 * returns `ciphertext || tag` (16-byte tag appended); Node's
 * `createCipheriv('aes-256-gcm')` exposes the tag separately via `getAuthTag()`,
 * so we concat on encrypt and split the trailing 16 bytes on decrypt.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { hashRawSync, Algorithm } from '@node-rs/argon2';

// --- constants ---------------------------------------------------------------

export const KEY_SIZE = 32; // AES-256
export const NONCE_SIZE = 12; // 96-bit GCM nonce
export const SALT_SIZE = 16;
export const TAG_SIZE = 16; // GCM auth tag

export const LOCAL_FORMAT_VERSION = 1;
export const REMOTE_FORMAT_VERSION = 1;
export const KDF_VERSION = 1;

/** Raised when decryption fails (wrong key or tampered/truncated ciphertext). */
export class InvalidToken extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToken';
  }
}

// --- Argon2id key derivation -------------------------------------------------

/** Argon2id cost parameters. `memoryCost` is in KiB (argon2-cffi units). */
export interface Argon2Params {
  timeCost: number;
  memoryCost: number; // KiB
  parallelism: number;
}

export function defaultArgon2Params(): Argon2Params {
  return { timeCost: 3, memoryCost: 64 * 1024, parallelism: 4 };
}

/** Serialize params to the on-disk JSON shape (snake_case, matching Python). */
export function argon2ParamsToJson(p: Argon2Params): {
  time_cost: number;
  memory_cost: number;
  parallelism: number;
} {
  return {
    time_cost: p.timeCost,
    memory_cost: p.memoryCost,
    parallelism: p.parallelism,
  };
}

export function argon2ParamsFromJson(d: {
  time_cost: number | string;
  memory_cost: number | string;
  parallelism: number | string;
}): Argon2Params {
  return {
    timeCost: Number(d.time_cost),
    memoryCost: Number(d.memory_cost),
    parallelism: Number(d.parallelism),
  };
}

export function newSalt(): Buffer {
  return randomBytes(SALT_SIZE);
}

/** A fresh random 32-byte symmetric key. */
export function randomKey(): Buffer {
  return randomBytes(KEY_SIZE);
}

/**
 * Derive a 32-byte key from `password` using Argon2id.
 *
 * Deterministic for a given (password, salt, params). Must produce the same 32
 * bytes as Python's argon2-cffi `hash_secret_raw(type=ID, ...)`.
 */
export function deriveKey(
  password: string,
  salt: Buffer,
  params: Argon2Params,
): Buffer {
  const out = hashRawSync(Buffer.from(password, 'utf-8'), {
    algorithm: Algorithm.Argon2id,
    timeCost: params.timeCost,
    memoryCost: params.memoryCost,
    parallelism: params.parallelism,
    outputLen: KEY_SIZE,
    salt,
  });
  return Buffer.from(out);
}

// --- raw AES-256-GCM ---------------------------------------------------------

/** Return `[nonce, ciphertextWithTag]`. The tag (16 bytes) is appended. */
export function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): [Buffer, Buffer] {
  if (key.length !== KEY_SIZE) {
    throw new Error('key must be 32 bytes');
  }
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) {
    cipher.setAAD(aad);
  }
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, Buffer.concat([ct, tag])];
}

/** Decrypt and verify. Throws {@link InvalidToken} on any failure. */
export function aesGcmDecrypt(
  key: Buffer,
  nonce: Buffer,
  ciphertextWithTag: Buffer,
  aad?: Buffer,
): Buffer {
  if (key.length !== KEY_SIZE) {
    throw new Error('key must be 32 bytes');
  }
  if (ciphertextWithTag.length < TAG_SIZE) {
    throw new InvalidToken('ciphertext too short for GCM tag');
  }
  const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_SIZE);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_SIZE);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    if (aad) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new InvalidToken(
      'authentication failed (wrong key or tampered data)',
    );
  }
}

// --- local blob (password-derived key) ---------------------------------------
//
// Layout: version(1) || nonce(12) || ciphertext(+tag)

/** Encrypt `plaintext` under `key` into a self-describing local blob. */
export function packLocalBlob(key: Buffer, plaintext: Buffer): Buffer {
  const [nonce, ct] = aesGcmEncrypt(key, plaintext);
  const header = Buffer.from([LOCAL_FORMAT_VERSION]);
  return Buffer.concat([header, nonce, ct]);
}

/** Inverse of {@link packLocalBlob}. Throws {@link InvalidToken}. */
export function unpackLocalBlob(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < 1 + NONCE_SIZE) {
    throw new InvalidToken('local blob too short');
  }
  const version = blob.readUInt8(0);
  if (version !== LOCAL_FORMAT_VERSION) {
    throw new InvalidToken(`unsupported local format version ${version}`);
  }
  const nonce = blob.subarray(1, 1 + NONCE_SIZE);
  const ct = blob.subarray(1 + NONCE_SIZE);
  return aesGcmDecrypt(key, Buffer.from(nonce), Buffer.from(ct));
}

// --- remote blob (KMS envelope) ----------------------------------------------
//
// Layout: version(1) || wrapped_key_len(4, big-endian) || wrapped_key
//         || nonce(12) || ciphertext(+tag)

/** Minimal KMS client surface used by the crypto layer (SDK v3 shape). */
export interface KmsClientLike {
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
  }): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  decrypt(input: {
    CiphertextBlob: Uint8Array;
  }): Promise<{ Plaintext?: Uint8Array }>;
}

/**
 * Envelope-encrypt `plaintext` with a fresh KMS data key.
 *
 * Calls `kms:GenerateDataKey` (AES-256), uses the returned plaintext key for one
 * AES-GCM encryption, then discards it and stores only the KMS-wrapped
 * `CiphertextBlob` alongside the ciphertext.
 */
export async function kmsEncrypt(
  kms: KmsClientLike,
  keyId: string,
  plaintext: Buffer,
): Promise<Buffer> {
  const resp = await kms.generateDataKey({ KeyId: keyId, KeySpec: 'AES_256' });
  if (!resp.Plaintext || !resp.CiphertextBlob) {
    throw new Error('GenerateDataKey returned no key material');
  }
  let dataKey = Buffer.from(resp.Plaintext);
  const wrapped = Buffer.from(resp.CiphertextBlob);
  try {
    const [nonce, ct] = aesGcmEncrypt(dataKey, plaintext);
    const header = Buffer.alloc(5);
    header.writeUInt8(REMOTE_FORMAT_VERSION, 0);
    header.writeUInt32BE(wrapped.length, 1);
    return Buffer.concat([header, wrapped, nonce, ct]);
  } finally {
    dataKey.fill(0);
  }
}

/** Inverse of {@link kmsEncrypt}. Requires valid IAM creds + `kms:Decrypt`. */
export async function kmsDecrypt(
  kms: KmsClientLike,
  blob: Buffer,
): Promise<Buffer> {
  if (blob.length < 5) {
    throw new InvalidToken('remote blob too short');
  }
  const version = blob.readUInt8(0);
  if (version !== REMOTE_FORMAT_VERSION) {
    throw new InvalidToken(`unsupported remote format version ${version}`);
  }
  const wrappedLen = blob.readUInt32BE(1);
  let off = 5;
  const wrapped = blob.subarray(off, off + wrappedLen);
  off += wrappedLen;
  const nonce = blob.subarray(off, off + NONCE_SIZE);
  const ct = blob.subarray(off + NONCE_SIZE);
  if (wrapped.length !== wrappedLen || nonce.length !== NONCE_SIZE) {
    throw new InvalidToken('remote blob truncated');
  }
  const resp = await kms.decrypt({ CiphertextBlob: Buffer.from(wrapped) });
  if (!resp.Plaintext) {
    throw new InvalidToken('KMS decrypt returned no plaintext key');
  }
  let dataKey = Buffer.from(resp.Plaintext);
  try {
    return aesGcmDecrypt(dataKey, Buffer.from(nonce), Buffer.from(ct));
  } finally {
    dataKey.fill(0);
  }
}

// --- misc --------------------------------------------------------------------

/** Best-effort in-place wipe of a mutable byte buffer. */
export function zeroize(buf: Buffer): void {
  buf.fill(0);
}
