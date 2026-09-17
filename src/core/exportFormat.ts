/**
 * orbkey native export format v1 — the pure, injection-proof codec.
 *
 * The security property this module exists to provide: **no user-controlled
 * string can influence the structure of the exported document, break a JSON
 * parser, or attack a terminal.**
 *
 * It is achieved by encoding every user-controlled string (secret key, note,
 * label name) as a {@link SafeString}:
 *
 * - `plain` — the string is kept verbatim, but only if it contains no code
 *   point from the barred sets (C0/C1 controls, DEL, line/paragraph
 *   separators, bidi overrides, zero-width joiners/spaces, BOM), is NFC, is
 *   well-formed, and is at most 4096 UTF-16 code units.
 * - `b64` — everything else, encoded as unpadded base64url. That alphabet
 *   (`A-Z a-z 0-9 - _`) contains neither a double quote nor a backslash, so
 *   such a value cannot terminate a JSON string.
 *
 * Serialization is ALWAYS `JSON.stringify`, never concatenation and never a
 * template literal. Secret *values* never pass through here at all — they are
 * AEAD ciphertext by the time they reach a document (see ./exportVault.ts).
 *
 * Nothing in this module logs, prints, or embeds a secret value in an Error.
 * Error text built from untrusted input is run through an escaper first, so a
 * hostile document cannot smuggle an ANSI sequence out through a diagnostic.
 */

import { z } from 'zod';

// --- errors ------------------------------------------------------------------

/**
 * Raised for any structural problem with an export document.
 *
 * Never carries secret material. Any fragment of untrusted input included in
 * the message is escaped first.
 */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

// --- the SafeString union ----------------------------------------------------

/** A user-controlled string, encoded so it cannot affect document structure. */
export type SafeString =
  | { enc: 'plain'; s: string }
  | { enc: 'b64'; b: string }; // base64url, NO padding, of UTF-8 bytes

/** An AEAD-encrypted secret value. Both fields are unpadded base64url. */
export interface EncValue {
  enc: 'aead';
  nonce: string;
  ct: string;
}

/** A label as it appears in an export document. */
export interface ExportLabel {
  id: string;
  name: SafeString;
}

/** A secret entry as it appears in an export document. */
export interface ExportSecret {
  id: string;
  createdAt: string;
  updatedAt: string;
  key: SafeString;
  note: SafeString;
  labels: SafeString[];
  value: EncValue;
}

/** The whole export document. Key order here is the key order on disk. */
export interface ExportDoc {
  orbkey: {
    format: 'orbkey-export';
    version: 1;
    createdAt: string;
    secretCount: number;
  };
  crypto: {
    kdf: 'argon2id';
    kdfVersion: number;
    cipher: 'aes-256-gcm';
    salt: string;
    params: {
      time_cost: number;
      memory_cost: number;
      parallelism: number;
    };
  };
  labels: ExportLabel[];
  secrets: ExportSecret[];
}

// --- the `plain` predicate (normative — see the frozen contract §1.1) --------

/** Maximum UTF-16 code units a `plain` SafeString may hold. */
const MAX_PLAIN_LENGTH = 4096;

/**
 * True when `cp` is barred from a `plain` SafeString.
 *
 * Exactly the sets named by the contract — nothing added, nothing removed:
 * C0 controls (this covers TAB, LF, CR and ESC), DEL and the C1 controls, the
 * Unicode line/paragraph separators, the bidi controls, the zero-width
 * characters and the BOM. Accented Latin, CJK and emoji are all allowed.
 */
function isBarredCodePoint(cp: number): boolean {
  // C0 controls U+0000..U+001F (includes TAB, LF, CR, ESC).
  if (cp <= 0x001f) {
    return true;
  }
  // U+007F DEL and the C1 controls U+0080..U+009F.
  if (cp === 0x007f || (cp >= 0x0080 && cp <= 0x009f)) {
    return true;
  }
  // U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR.
  if (cp === 0x2028 || cp === 0x2029) {
    return true;
  }
  // Bidi controls: LRM/RLM, the embedding/override block, the isolate block.
  if (cp === 0x200e || cp === 0x200f) {
    return true;
  }
  if (cp >= 0x202a && cp <= 0x202e) {
    return true;
  }
  if (cp >= 0x2066 && cp <= 0x2069) {
    return true;
  }
  // Zero-width space/non-joiner/joiner, and the byte-order mark.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) {
    return true;
  }
  return false;
}

/**
 * True when `s` contains no lone surrogate.
 *
 * Semantically `String.prototype.isWellFormed()`, hand-rolled because this
 * package targets `lib: ES2022` and that method is ES2024.
 */
function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // High surrogate: the next unit must be a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // Low surrogate with no preceding high surrogate.
      return false;
    }
  }
  return true;
}

/** See the contract §1.1. This predicate is normative down to the code point. */
export function isPlainSafe(s: string): boolean {
  if (s.length > MAX_PLAIN_LENGTH) {
    return false;
  }
  if (!isWellFormedString(s)) {
    return false;
  }
  if (s !== s.normalize('NFC')) {
    return false;
  }
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isBarredCodePoint(cp)) {
      return false;
    }
  }
  return true;
}

// --- base64url ---------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url of `b`. */
export function b64urlEncode(b: Buffer): string {
  return b.toString('base64url');
}

/**
 * Strict inverse of {@link b64urlEncode}.
 *
 * Rejects padding, out-of-alphabet characters, impossible lengths and
 * non-canonical encodings (trailing bits that re-encode differently), so a
 * value has exactly one representation.
 */
export function b64urlDecode(s: string): Buffer {
  if (!B64URL_RE.test(s)) {
    throw new ExportError(
      'not base64url: contains a character outside [A-Za-z0-9_-] (padding is not allowed)',
    );
  }
  if (s.length % 4 === 1) {
    throw new ExportError(`not base64url: impossible length ${s.length}`);
  }
  const buf = Buffer.from(s, 'base64url');
  if (buf.toString('base64url') !== s) {
    throw new ExportError('not base64url: non-canonical encoding');
  }
  return buf;
}

// --- SafeString encode / decode ----------------------------------------------

/** Encode `s` as `plain` when {@link isPlainSafe}, otherwise as `b64`. */
export function encodeSafe(s: string): SafeString {
  if (!isWellFormedString(s)) {
    // Data corruption, not something to silently mangle into U+FFFD.
    throw new ExportError('string is not well-formed (contains a lone surrogate)');
  }
  if (isPlainSafe(s)) {
    return { enc: 'plain', s };
  }
  return { enc: 'b64', b: b64urlEncode(Buffer.from(s, 'utf8')) };
}

/** Inverse of {@link encodeSafe}. `decodeSafe(encodeSafe(s)) === s`. */
export function decodeSafe(v: SafeString): string {
  if (v.enc === 'plain') {
    return v.s;
  }
  if (v.enc === 'b64') {
    const buf = b64urlDecode(v.b);
    const s = buf.toString('utf8');
    if (!Buffer.from(s, 'utf8').equals(buf)) {
      throw new ExportError('b64 SafeString payload is not valid UTF-8');
    }
    return s;
  }
  const exhaustive: never = v;
  throw new ExportError(
    `unknown SafeString encoding: ${sanitizeForMessage(
      String((exhaustive as { enc: unknown }).enc),
    )}`,
  );
}

// --- diagnostics -------------------------------------------------------------

const MAX_MESSAGE_CHARS = 400;

/**
 * Make an untrusted fragment safe to put in an Error message.
 *
 * zod embeds unrecognized key names verbatim, so without this a hostile
 * document could smuggle an ANSI escape into the UI through an error line.
 */
function sanitizeForMessage(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) {
      continue;
    }
    if (isBarredCodePoint(cp) || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
    if (out.length >= MAX_MESSAGE_CHARS) {
      return `${out.slice(0, MAX_MESSAGE_CHARS)}...`;
    }
  }
  return out;
}

// --- zod schema --------------------------------------------------------------

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const Uuid = z.string().regex(UUID_RE, 'must be a uuid');
const Timestamp = z
  .string()
  .regex(TIMESTAMP_RE, 'must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
const B64Url = z
  .string()
  .regex(B64URL_RE, 'must be unpadded base64url ([A-Za-z0-9_-], no "=")');

/** A `b64` payload must additionally decode canonically to valid UTF-8. */
function decodesToUtf8(b: string): boolean {
  try {
    const buf = b64urlDecode(b);
    return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
  } catch {
    return false;
  }
}

const SafeStringSchema = z.discriminatedUnion('enc', [
  z
    .object({
      enc: z.literal('plain'),
      // Re-assert the predicate on the way in: a document from elsewhere must
      // not be able to reintroduce a terminal escape through a `plain` field.
      s: z.string().refine(isPlainSafe, {
        message:
          'plain SafeString must be NFC, well-formed, at most 4096 chars, and free of control, bidi, zero-width and line-separator code points (use enc "b64")',
      }),
    })
    .strict(),
  z
    .object({
      enc: z.literal('b64'),
      b: B64Url.refine(decodesToUtf8, {
        message: 'b64 SafeString must decode canonically to valid UTF-8',
      }),
    })
    .strict(),
]);

const EncValueSchema = z.discriminatedUnion('enc', [
  z
    .object({
      enc: z.literal('aead'),
      nonce: B64Url,
      ct: B64Url,
    })
    .strict(),
]);

const Argon2ParamsSchema = z
  .object({
    time_cost: z.number().int().positive(),
    memory_cost: z.number().int().positive(),
    parallelism: z.number().int().positive(),
  })
  .strict();

const ExportLabelSchema = z
  .object({
    id: Uuid,
    name: SafeStringSchema,
  })
  .strict();

const ExportSecretSchema = z
  .object({
    id: Uuid,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    key: SafeStringSchema,
    note: SafeStringSchema,
    labels: z.array(SafeStringSchema),
    value: EncValueSchema,
  })
  .strict();

const ExportDocObject = z
  .object({
    orbkey: z
      .object({
        format: z.literal('orbkey-export'),
        version: z.literal(1),
        createdAt: Timestamp,
        secretCount: z.number().int().nonnegative(),
      })
      .strict(),
    crypto: z
      .object({
        kdf: z.literal('argon2id'),
        kdfVersion: z.number().int().positive(),
        cipher: z.literal('aes-256-gcm'),
        salt: B64Url,
        params: Argon2ParamsSchema,
      })
      .strict(),
    labels: z.array(ExportLabelSchema),
    secrets: z.array(ExportSecretSchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.orbkey.secretCount !== doc.secrets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orbkey', 'secretCount'],
        message: `secretCount ${doc.orbkey.secretCount} does not match secrets.length ${doc.secrets.length}`,
      });
    }
  });

/** The schema every export document is validated against. */
export const ExportDocSchema: z.ZodType<ExportDoc> = ExportDocObject;

/** Flatten zod issues into one escaped, bounded line. */
function formatIssues(err: z.ZodError): string {
  const MAX_ISSUES = 20;
  const shown = err.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${sanitizeForMessage(path)}: ${sanitizeForMessage(issue.message)}`;
  });
  if (err.issues.length > MAX_ISSUES) {
    shown.push(`(+${err.issues.length - MAX_ISSUES} more)`);
  }
  return shown.join('; ');
}

/**
 * Report a version mismatch before the full parse, so the user sees "wrong
 * version" rather than a wall of literal-mismatch issues.
 */
function versionProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const header = (raw as Record<string, unknown>).orbkey;
  if (typeof header !== 'object' || header === null) {
    return null;
  }
  const version = (header as Record<string, unknown>).version;
  if (version === undefined || version === 1) {
    return null;
  }
  // Only ever interpolate a number or a type name — never raw input.
  const shown =
    typeof version === 'number' && Number.isFinite(version)
      ? String(version)
      : `a ${typeof version}`;
  return `unsupported export version ${shown}: this build reads orbkey-export version 1 only`;
}

/** Validate `raw` against {@link ExportDocSchema}. Throws {@link ExportError}. */
export function parseExportDoc(raw: unknown): ExportDoc {
  const problem = versionProblem(raw);
  if (problem !== null) {
    throw new ExportError(problem);
  }
  const result = ExportDocSchema.safeParse(raw);
  if (!result.success) {
    throw new ExportError(`not a valid orbkey export: ${formatIssues(result.error)}`);
  }
  return result.data;
}
