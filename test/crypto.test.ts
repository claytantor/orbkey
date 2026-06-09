/** Crypto round-trips and fail-closed behavior (mirrors test_crypto.py). */
import { describe, it, expect } from 'vitest';
import * as crypto from '../src/core/crypto.js';

describe('crypto', () => {
  it('argon2 deterministic and salt/password sensitive', () => {
    const salt = crypto.newSalt();
    const params = crypto.defaultArgon2Params();
    const k1 = crypto.deriveKey('hunter2', salt, params);
    const k2 = crypto.deriveKey('hunter2', salt, params);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.length).toBe(crypto.KEY_SIZE);
    expect(k1.equals(crypto.deriveKey('hunter2', crypto.newSalt(), params))).toBe(false);
    expect(k1.equals(crypto.deriveKey('wrong', salt, params))).toBe(false);
  });

  it('local blob round-trip', () => {
    const key = crypto.randomKey();
    const pt = Buffer.from('the quick brown fox'.repeat(100));
    const blob = crypto.packLocalBlob(key, pt);
    expect(blob.equals(pt)).toBe(false);
    expect(crypto.unpackLocalBlob(key, blob).equals(pt)).toBe(true);
  });

  it('local blob uses a fresh nonce each time', () => {
    const key = crypto.randomKey();
    const pt = Buffer.from('same plaintext');
    expect(crypto.packLocalBlob(key, pt).equals(crypto.packLocalBlob(key, pt))).toBe(false);
  });

  it('local blob wrong key fails closed', () => {
    const blob = crypto.packLocalBlob(crypto.randomKey(), Buffer.from('secret'));
    expect(() => crypto.unpackLocalBlob(crypto.randomKey(), blob)).toThrow(crypto.InvalidToken);
  });

  it('local blob tamper fails closed', () => {
    const key = crypto.randomKey();
    const blob = Buffer.from(crypto.packLocalBlob(key, Buffer.from('secret')));
    blob[blob.length - 1] ^= 0x01;
    expect(() => crypto.unpackLocalBlob(key, blob)).toThrow(crypto.InvalidToken);
  });

  it('kms envelope round-trips with a fresh data key each time', async () => {
    // In-process fake KMS: generates a random data key, "wraps" it as
    // version||rawkey, and unwraps by stripping the marker. Different ciphertext
    // each encrypt because of fresh data key + nonce.
    const pt = Buffer.from('vault snapshot bytes'.repeat(50));
    const marker = Buffer.from('WRAP:');
    const kms: crypto.KmsClientLike = {
      async generateDataKey() {
        const k = crypto.randomKey();
        return { Plaintext: k, CiphertextBlob: Buffer.concat([marker, k]) };
      },
      async decrypt(input) {
        const blob = Buffer.from(input.CiphertextBlob);
        return { Plaintext: blob.subarray(marker.length) };
      },
    };
    const blob1 = await crypto.kmsEncrypt(kms, 'key', pt);
    const blob2 = await crypto.kmsEncrypt(kms, 'key', pt);
    expect(blob1.equals(blob2)).toBe(false);
    expect((await crypto.kmsDecrypt(kms, blob1)).equals(pt)).toBe(true);
    expect((await crypto.kmsDecrypt(kms, blob2)).equals(pt)).toBe(true);
  });
});
