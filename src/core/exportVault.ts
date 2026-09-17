/**
 * orbkey native export — building, serializing and reading export documents.
 *
 * Crypto shape (frozen contract §2):
 *
 * - one Argon2id derivation per document, never per value (a derivation costs
 *   roughly 800ms — per-value would make a 50-entry export unusable);
 * - a fresh 96-bit GCM nonce per value;
 * - mandatory additional authenticated data `orbkey-export:1:<secret id>`,
 *   which binds a ciphertext to its entry, so moving a ciphertext from one
 *   entry to another fails authentication instead of quietly swapping secrets.
 *
 * The derived key is zeroized on the way out of both directions, as is every
 * plaintext buffer this module allocates.
 *
 * No function here logs, prints, or puts a secret value into an Error.
 */

import type { Label, Secret, VaultSnapshot } from '../models.js';
import { utcnowIso } from '../models.js';
import {
  KDF_VERSION,
  SALT_SIZE,
  aesGcmDecrypt,
  aesGcmEncrypt,
  argon2ParamsFromJson,
  argon2ParamsToJson,
  defaultArgon2Params,
  deriveKey,
  newSalt,
  zeroize,
  type Argon2Params,
} from './crypto.js';
import {
  ExportError,
  type EncValue,
  type ExportDoc,
  type ExportLabel,
  type ExportSecret,
  type SafeString,
  b64urlDecode,
  b64urlEncode,
  decodeSafe,
  encodeSafe,
  parseExportDoc,
} from './exportFormat.js';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Upper bounds on the KDF parameters accepted from a document. An export file
// is untrusted input; without a cap, `memory_cost` is a one-line way to make
// an import allocate terabytes.
const MAX_TIME_COST = 64;
const MAX_MEMORY_COST_KIB = 4 * 1024 * 1024; // 4 GiB
const MAX_PARALLELISM = 64;

/** AAD binding a ciphertext to exactly one entry of exactly this format. */
function aadFor(secretId: string): Buffer {
  return Buffer.from(`orbkey-export:1:${secretId}`, 'utf8');
}

/**
 * Render an untrusted short string for an Error message, or a placeholder.
 *
 * Only bounded printable ASCII is ever echoed back, so a malformed id or
 * timestamp cannot carry a terminal escape into a diagnostic.
 */
function showable(s: string): string {
  return /^[\x20-\x7e]{0,64}$/.test(s) ? `'${s}'` : '<non-printable>';
}

/** Encode a user string, naming the entry and field if it is corrupt. */
function encodeField(value: string, secretId: string, field: string): SafeString {
  try {
    return encodeSafe(value);
  } catch (err) {
    if (err instanceof ExportError) {
      throw new ExportError(`secret ${secretId} field "${field}": ${err.message}`);
    }
    throw err;
  }
}

function assertSaneParams(p: Argon2Params): void {
  if (p.timeCost < 1 || p.timeCost > MAX_TIME_COST) {
    throw new ExportError(
      `refusing KDF time_cost ${p.timeCost} (allowed 1..${MAX_TIME_COST})`,
    );
  }
  if (p.memoryCost < 8 || p.memoryCost > MAX_MEMORY_COST_KIB) {
    throw new ExportError(
      `refusing KDF memory_cost ${p.memoryCost} KiB (allowed 8..${MAX_MEMORY_COST_KIB})`,
    );
  }
  if (p.parallelism < 1 || p.parallelism > MAX_PARALLELISM) {
    throw new ExportError(
      `refusing KDF parallelism ${p.parallelism} (allowed 1..${MAX_PARALLELISM})`,
    );
  }
}

/**
 * Build an export document from `snap`, encrypting every value under a key
 * derived once from `passphrase`.
 *
 * `now` overrides the document timestamp (tests, reproducible exports) and must
 * already be in `YYYY-MM-DDTHH:MM:SSZ` form.
 *
 * NOTE: format v1 has no place for `VaultSnapshot.meta`; it is not exported.
 */
export function buildExportDoc(
  snap: VaultSnapshot,
  passphrase: string,
  now?: string,
): ExportDoc {
  const createdAt = now ?? utcnowIso();
  if (!TIMESTAMP_RE.test(createdAt)) {
    throw new ExportError(
      `export timestamp ${showable(createdAt)} is not YYYY-MM-DDTHH:MM:SSZ`,
    );
  }

  // Validate identifiers and timestamps before spending ~800ms on Argon2, and
  // so that the produced document is guaranteed to satisfy ExportDocSchema.
  snap.secrets.forEach((secret, i) => {
    if (!UUID_RE.test(secret.id)) {
      throw new ExportError(`secrets[${i}].id ${showable(secret.id)} is not a uuid`);
    }
    if (!TIMESTAMP_RE.test(secret.createdAt)) {
      throw new ExportError(
        `secrets[${i}].createdAt ${showable(secret.createdAt)} is not YYYY-MM-DDTHH:MM:SSZ`,
      );
    }
    if (!TIMESTAMP_RE.test(secret.updatedAt)) {
      throw new ExportError(
        `secrets[${i}].updatedAt ${showable(secret.updatedAt)} is not YYYY-MM-DDTHH:MM:SSZ`,
      );
    }
    // A lone surrogate would be silently rewritten to U+FFFD by the UTF-8
    // encode below. Refuse rather than corrupt a secret. The value itself is
    // never named in the message.
    if (Buffer.from(secret.value, 'utf8').toString('utf8') !== secret.value) {
      throw new ExportError(
        `secret ${secret.id} field "value": string is not well-formed (contains a lone surrogate)`,
      );
    }
  });
  snap.labels.forEach((label, i) => {
    if (!UUID_RE.test(label.id)) {
      throw new ExportError(`labels[${i}].id ${showable(label.id)} is not a uuid`);
    }
  });

  const salt = newSalt();
  const params = defaultArgon2Params();
  const key = deriveKey(passphrase, salt, params); // exactly once per document
  try {
    const labels: ExportLabel[] = snap.labels.map((label) => ({
      id: label.id,
      name: encodeSafe(label.name),
    }));

    const secrets: ExportSecret[] = snap.secrets.map((secret) => {
      const plaintext = Buffer.from(secret.value, 'utf8');
      let value: EncValue;
      try {
        const [nonce, ct] = aesGcmEncrypt(key, plaintext, aadFor(secret.id));
        value = {
          enc: 'aead',
          nonce: b64urlEncode(nonce),
          ct: b64urlEncode(ct),
        };
      } finally {
        zeroize(plaintext);
      }
      // Property order here is the property order on disk.
      return {
        id: secret.id,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        key: encodeField(secret.key, secret.id, 'key'),
        note: encodeField(secret.note, secret.id, 'note'),
        labels: secret.labels.map((name, i) =>
          encodeField(name, secret.id, `labels[${i}]`),
        ),
        value,
      };
    });

    return {
      orbkey: {
        format: 'orbkey-export',
        version: 1,
        createdAt,
        secretCount: snap.secrets.length,
      },
      crypto: {
        kdf: 'argon2id',
        kdfVersion: KDF_VERSION,
        cipher: 'aes-256-gcm',
        salt: b64urlEncode(salt),
        params: argon2ParamsToJson(params),
      },
      labels,
      secrets,
    };
  } finally {
    zeroize(key);
  }
}

/** Serialize to the on-disk text: 2-space JSON, LF, no BOM, trailing newline. */
export function serializeExportDoc(doc: ExportDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Parse on-disk text into a validated document. Throws {@link ExportError}. */
export function parseExportJson(text: string): ExportDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // The engine's message can quote the offending input, which would carry
    // hostile bytes into the UI; report only the position, if it has one.
    const detail = err instanceof Error ? /position (\d+)/.exec(err.message) : null;
    const where = detail !== null && detail[1] !== undefined ? ` at position ${detail[1]}` : '';
    throw new ExportError(`export file is not valid JSON${where}`);
  }
  return parseExportDoc(raw);
}

/**
 * Decrypt `doc` back into a vault snapshot.
 *
 * Throws `InvalidToken` (from ./crypto.js) on a wrong passphrase or on any
 * tampering — including a ciphertext moved between entries, which the AAD
 * catches. Never returns garbage plaintext.
 *
 * NOTE: format v1 carries no `meta`, so `meta` comes back empty.
 */
export function readExportDoc(doc: ExportDoc, passphrase: string): VaultSnapshot {
  if (doc.crypto.kdfVersion !== KDF_VERSION) {
    throw new ExportError(
      `unsupported kdfVersion ${doc.crypto.kdfVersion}: this build understands ${KDF_VERSION}`,
    );
  }
  const salt = b64urlDecode(doc.crypto.salt);
  if (salt.length !== SALT_SIZE) {
    throw new ExportError(
      `invalid salt: expected ${SALT_SIZE} bytes, got ${salt.length}`,
    );
  }
  const params = argon2ParamsFromJson(doc.crypto.params);
  assertSaneParams(params);

  const key = deriveKey(passphrase, salt, params); // exactly once per document
  try {
    const secrets: Secret[] = doc.secrets.map((entry) => {
      const nonce = b64urlDecode(entry.value.nonce);
      const ct = b64urlDecode(entry.value.ct);
      // Throws InvalidToken on a wrong passphrase, tampering, or a ciphertext
      // lifted from a different entry (the AAD will not match).
      const plaintext = aesGcmDecrypt(key, nonce, ct, aadFor(entry.id));
      try {
        return {
          key: decodeSafe(entry.key),
          value: plaintext.toString('utf8'),
          note: decodeSafe(entry.note),
          labels: entry.labels.map((name) => decodeSafe(name)),
          id: entry.id,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        };
      } finally {
        zeroize(plaintext);
      }
    });

    const labels: Label[] = doc.labels.map((label) => ({
      name: decodeSafe(label.name),
      id: label.id,
    }));

    return { secrets, labels, meta: {} };
  } finally {
    zeroize(key);
  }
}
