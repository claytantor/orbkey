/**
 * Domain model for orbkey.
 *
 * Lightweight in-memory representations. Persistence lives in
 * {@link ./core/store} (SQLite) and {@link ./core/sync} (S3/KMS). Plaintext
 * secret values exist only on these objects while the process is unlocked.
 */

import { randomUUID } from 'node:crypto';

/** ISO-8601 UTC timestamp (second precision, `Z` suffix). */
export function utcnowIso(): string {
  // Strip milliseconds to match Python's `utcnow_iso()` exactly.
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A fresh uuid4 string, used for primary keys. */
export function newId(): string {
  return randomUUID();
}

/** A free-text tag that can be attached to many secrets. */
export interface Label {
  name: string;
  id: string;
}

export function makeLabel(name: string, id: string = newId()): Label {
  return { name, id };
}

/** A single secret entry. `value` is plaintext and RAM-only. */
export interface Secret {
  key: string;
  value: string;
  note: string;
  labels: string[];
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** An in-memory view of the whole vault (used by tests and import/export). */
export interface VaultSnapshot {
  secrets: Secret[];
  labels: Label[];
  meta: Record<string, string>;
}
