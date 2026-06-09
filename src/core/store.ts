/**
 * In-memory SQLite vault store with FTS5 search.
 *
 * The vault lives entirely in an in-memory SQLite database — the only place
 * plaintext secret values exist, and only while unlocked. The whole database is
 * snapshotted to/from bytes via better-sqlite3's `serialize()` /
 * `new Database(buffer)`, which produce/consume the same standard on-disk format
 * Python's `sqlite3.Connection.serialize()/deserialize()` uses.
 *
 * Search is local-only over `key`, `note` and concatenated `labels` via an FTS5
 * index, prefix-enabled. Secret *values* are never indexed.
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { type Label, type Secret, newId, utcnowIso } from '../models.js';
import type { KeePassEntry } from './keepass.js';

export const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT NOT NULL,
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE labels (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE secret_labels (
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id)  ON DELETE CASCADE,
  PRIMARY KEY (secret_id, label_id)
);

CREATE TABLE vault_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE VIRTUAL TABLE secrets_fts USING fts5(key, note, labels, id UNINDEXED);
`;

export class DuplicateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateKeyError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface BulkImportReport {
  imported: number;
  skipped: number;
  renamed: number;
  errors: number;
  keys: string[];
}

const USERNAME_RE = /UserName:\s*(.+)$/m;

/** Build a prefix-enabled FTS5 MATCH expression from free text. */
function ftsQuery(term: string): string {
  return term
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
    .join(' ');
}

interface SecretRow {
  id: string;
  key: string;
  value: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export class VaultStore {
  private readonly db: DB;

  private constructor(db: DB) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
  }

  // --- lifecycle -----------------------------------------------------------

  static openEmpty(vaultId?: string): VaultStore {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const store = new VaultStore(db);
    store.setMeta('schema_version', SCHEMA_VERSION);
    store.setMeta('vault_id', vaultId ?? newId());
    return store;
  }

  static load(blob: Buffer): VaultStore {
    const db = new Database(blob);
    const store = new VaultStore(db);
    store.rebuildFts(); // ensure the index matches content (spec: rebuild on load)
    return store;
  }

  serialize(): Buffer {
    return this.db.serialize();
  }

  close(): void {
    this.db.close();
  }

  // --- meta ----------------------------------------------------------------

  private setMeta(k: string, v: string): void {
    this.db
      .prepare(
        'INSERT INTO vault_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      )
      .run(k, v);
  }

  getMeta(k: string): string | null {
    const row = this.db
      .prepare('SELECT v FROM vault_meta WHERE k = ?')
      .get(k) as { v: string } | undefined;
    return row ? row.v : null;
  }

  // --- labels --------------------------------------------------------------

  private labelId(name: string): string {
    const row = this.db
      .prepare('SELECT id FROM labels WHERE name = ?')
      .get(name) as { id: string } | undefined;
    if (row) {
      return row.id;
    }
    const lid = newId();
    this.db.prepare('INSERT INTO labels(id, name) VALUES(?, ?)').run(lid, name);
    return lid;
  }

  private labelsFor(secretId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT l.name FROM labels l JOIN secret_labels sl ON sl.label_id = l.id WHERE sl.secret_id = ? ORDER BY l.name',
      )
      .all(secretId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private applyLabels(secretId: string, labels: string[]): void {
    this.db
      .prepare('DELETE FROM secret_labels WHERE secret_id = ?')
      .run(secretId);
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of labels) {
      const name = raw.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        cleaned.push(name);
      }
    }
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO secret_labels(secret_id, label_id) VALUES(?, ?)',
    );
    for (const name of cleaned) {
      insert.run(secretId, this.labelId(name));
    }
    this.pruneOrphanLabels();
  }

  private pruneOrphanLabels(): void {
    this.db.exec(
      'DELETE FROM labels WHERE id NOT IN (SELECT label_id FROM secret_labels)',
    );
  }

  listLabels(): Label[] {
    const rows = this.db
      .prepare('SELECT id, name FROM labels ORDER BY name')
      .all() as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  // --- secrets -------------------------------------------------------------

  private rowToSecret(row: SecretRow): Secret {
    return {
      id: row.id,
      key: row.key,
      value: row.value,
      note: row.note ?? '',
      labels: this.labelsFor(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  addSecret(
    key: string,
    value: string,
    note = '',
    labels: string[] = [],
  ): Secret {
    if (this.getSecret(key) !== null) {
      throw new DuplicateKeyError(
        `a secret with key '${key}' already exists`,
      );
    }
    const now = utcnowIso();
    const sid = newId();
    this.db
      .prepare(
        'INSERT INTO secrets(id, key, value, note, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(sid, key, value, note, now, now);
    this.applyLabels(sid, labels);
    this.rebuildFts();
    return this.getSecretById(sid) as Secret;
  }

  addSecretsBulk(entries: KeePassEntry[]): BulkImportReport {
    const existingRows = this.db
      .prepare('SELECT key, value, note FROM secrets')
      .all() as Array<{ key: string; value: string; note: string | null }>;

    const existingCreds = new Set<string>();
    const credKey = (value: string, username: string): string =>
      JSON.stringify([value, username]);
    for (const row of existingRows) {
      let username = '';
      const m = USERNAME_RE.exec(row.note ?? '');
      if (m && m[1]) {
        username = m[1].trim();
      }
      existingCreds.add(credKey(row.value, username));
    }
    const existingKeys = new Set<string>(existingRows.map((r) => r.key));

    const report: BulkImportReport = {
      imported: 0,
      skipped: 0,
      renamed: 0,
      errors: 0,
      keys: [],
    };

    const insert = this.db.prepare(
      'INSERT INTO secrets(id, key, value, note, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)',
    );

    for (const entry of entries) {
      const title = entry.title;
      const password = entry.password;
      const username = entry.username;

      if (!title) {
        report.errors += 1;
        continue;
      }

      const noteParts: string[] = [];
      if (entry.notes) {
        noteParts.push(entry.notes);
      }
      if (entry.url) {
        noteParts.push(`URL: ${entry.url}`);
      }
      if (username) {
        noteParts.push(`UserName: ${username}`);
      }
      const note = noteParts.join('\n');

      if (existingCreds.has(credKey(password, username))) {
        report.skipped += 1;
        continue;
      }

      let key = title;
      if (existingKeys.has(key)) {
        let suffix = 1;
        while (existingKeys.has(`${title}-copy-${suffix}`)) {
          suffix += 1;
        }
        key = `${title}-copy-${suffix}`;
        report.renamed += 1;
      }

      try {
        const now = utcnowIso();
        const sid = newId();
        insert.run(sid, key, password, note, now, now);
        this.applyLabels(sid, entry.labels);
        existingKeys.add(key);
        existingCreds.add(credKey(password, username));
        report.imported += 1;
        report.keys.push(key);
      } catch {
        report.errors += 1;
      }
    }

    this.rebuildFts();
    return report;
  }

  getSecret(key: string): Secret | null {
    const row = this.db
      .prepare('SELECT * FROM secrets WHERE key = ?')
      .get(key) as SecretRow | undefined;
    return row ? this.rowToSecret(row) : null;
  }

  getSecretById(sid: string): Secret | null {
    const row = this.db
      .prepare('SELECT * FROM secrets WHERE id = ?')
      .get(sid) as SecretRow | undefined;
    return row ? this.rowToSecret(row) : null;
  }

  listSecrets(): Secret[] {
    const rows = this.db
      .prepare('SELECT * FROM secrets ORDER BY key')
      .all() as SecretRow[];
    return rows.map((r) => this.rowToSecret(r));
  }

  editSecret(
    key: string,
    opts: {
      newKey?: string;
      value?: string;
      note?: string;
      labels?: string[];
    } = {},
  ): Secret {
    const existing = this.getSecret(key);
    if (existing === null) {
      throw new NotFoundError(`no secret with key '${key}'`);
    }
    if (
      opts.newKey &&
      opts.newKey !== key &&
      this.getSecret(opts.newKey) !== null
    ) {
      throw new DuplicateKeyError(
        `a secret with key '${opts.newKey}' already exists`,
      );
    }
    this.db
      .prepare(
        'UPDATE secrets SET key = ?, value = ?, note = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        opts.newKey ?? existing.key,
        opts.value === undefined ? existing.value : opts.value,
        opts.note === undefined ? existing.note : opts.note,
        utcnowIso(),
        existing.id,
      );
    if (opts.labels !== undefined) {
      this.applyLabels(existing.id, opts.labels);
    }
    this.rebuildFts();
    return this.getSecretById(existing.id) as Secret;
  }

  setNote(key: string, note: string): Secret {
    return this.editSecret(key, { note });
  }

  setLabels(key: string, labels: string[]): Secret {
    return this.editSecret(key, { labels });
  }

  removeSecret(key: string): boolean {
    const existing = this.getSecret(key);
    if (existing === null) {
      return false;
    }
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(existing.id);
    this.pruneOrphanLabels();
    this.rebuildFts();
    return true;
  }

  // --- search --------------------------------------------------------------

  rebuildFts(): void {
    this.db.exec('DELETE FROM secrets_fts');
    const insert = this.db.prepare(
      'INSERT INTO secrets_fts(key, note, labels, id) VALUES(?, ?, ?, ?)',
    );
    for (const s of this.listSecrets()) {
      insert.run(s.key, s.note, s.labels.join(' '), s.id);
    }
  }

  search(term: string): Secret[] {
    const trimmed = term.trim();
    if (!trimmed) {
      return this.listSecrets();
    }
    const query = ftsQuery(trimmed);
    const rows = this.db
      .prepare(
        'SELECT id FROM secrets_fts WHERE secrets_fts MATCH ? ORDER BY rank',
      )
      .all(query) as Array<{ id: string }>;
    const out: Secret[] = [];
    for (const r of rows) {
      const s = this.getSecretById(r.id);
      if (s) {
        out.push(s);
      }
    }
    return out;
  }
}
