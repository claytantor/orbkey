/**
 * In-memory, offline `SessionPort` for UI development and tests.
 *
 * No core modules, no AWS, no crypto — just enough behavior to drive every UI
 * flow deterministically. Search is a simple case-insensitive prefix match over
 * key / note / labels (NOT values), mirroring the FTS contract the UI relies on.
 */

import type {
  AccountContext,
  ConflictChoice,
  FirstRunInput,
  SessionPort,
  UiConflict,
  UiExportReport,
  UiIamCreds,
  UiImportKind,
  UiImportReport,
  UiKeepassEntry,
  UiLaunchResult,
  UiSecret,
  UiSyncReport,
  UiSyncStatus,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let counter = 0;
function fakeId(): string {
  counter += 1;
  return `fake-${counter}`;
}

/**
 * What a *previously unseen* orbkey export file "contains" in the fake, so the
 * import flow is drivable without exporting first. Values are obvious
 * placeholders — the fake never holds real secret material.
 */
const FAKE_ORBKEY_ENTRIES: ReadonlyArray<Pick<UiSecret, 'key' | 'value' | 'note' | 'labels'>> = [
  { key: 'orbkey/restored-1', value: 'restored-secret-1', note: 'from export', labels: ['restored'] },
  { key: 'orbkey/restored-2', value: 'restored-secret-2', note: '', labels: ['restored'] },
];

export interface FakeSessionOptions {
  firstRun?: boolean;
  locked?: boolean;
  status?: UiSyncStatus;
  account?: string;
  region?: string;
  /** Force the next sync() to surface a conflict (token is opaque). */
  conflictOnSync?: boolean;
}

export class FakeSession implements SessionPort {
  private secrets = new Map<string, UiSecret>();
  locked: boolean;
  status: UiSyncStatus;
  isFirstRun: boolean;
  private account: string;
  private region: string;
  private conflictOnSync: boolean;

  // Audit-friendly counters that tests can assert on.
  syncCount = 0;
  closed = false;
  /** Number of completed `exportVault` calls (a rejected one does not count). */
  exportCount = 0;
  /** Destination of the last completed export. Never the passphrase. */
  lastExportPath: string | null = null;
  /**
   * Snapshot written per destination path, standing in for the file on disk.
   * The export PASSPHRASE is deliberately not retained anywhere — the fake
   * models a bad passphrase with the sentinel below, exactly as
   * `rotatePassword` does.
   */
  private exports = new Map<string, UiSecret[]>();

  constructor(opts: FakeSessionOptions = {}) {
    this.locked = opts.locked ?? false;
    this.status = opts.status ?? 'OFFLINE';
    this.isFirstRun = opts.firstRun ?? false;
    this.account = opts.account ?? '123456789012';
    this.region = opts.region ?? 'us-east-1';
    this.conflictOnSync = opts.conflictOnSync ?? false;
  }

  accountContext(): AccountContext {
    return {
      account: this.locked ? null : this.account,
      region: this.locked ? null : this.region,
      profile: null,
    };
  }

  listSecrets(): UiSecret[] {
    return [...this.secrets.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  search(term: string): UiSecret[] {
    const t = term.trim().toLowerCase();
    if (!t) {
      return this.listSecrets();
    }
    const tokens = t.split(/\s+/);
    return this.listSecrets().filter((s) => {
      const haystack = [s.key, s.note, ...s.labels].join(' ').toLowerCase();
      // prefix match: every token must prefix-match some word in the haystack.
      const words = haystack.split(/\s+/);
      return tokens.every((tok) => words.some((w) => w.startsWith(tok)));
    });
  }

  getSecret(key: string): UiSecret | null {
    return this.secrets.get(key) ?? null;
  }

  async unlock(_password: string): Promise<UiLaunchResult> {
    this.locked = false;
    this.status = 'OFFLINE';
    return { outcome: 'offline_loaded', status: this.status, conflict: null };
  }

  async firstRun(input: FirstRunInput): Promise<UiLaunchResult> {
    this.locked = false;
    this.isFirstRun = false;
    this.account = input.accountId;
    this.region = input.region;
    this.status = 'SYNCED';
    return { outcome: 'created', status: this.status, conflict: null };
  }

  async resolveConflict(
    _conflict: UiConflict,
    _choice: ConflictChoice,
  ): Promise<string | null> {
    this.conflictOnSync = false;
    this.status = 'SYNCED';
    return null;
  }

  lock(): void {
    this.locked = true;
    this.secrets.clear();
  }

  async close(): Promise<UiSyncReport> {
    this.closed = true;
    this.lock();
    return { pushed: false, conflict: null };
  }

  addSecret(key: string, value: string, note = '', labels: string[] = []): UiSecret {
    if (this.secrets.has(key)) {
      throw new Error(`a secret with key '${key}' already exists`);
    }
    const s: UiSecret = {
      key,
      value,
      note,
      labels: [...labels],
      id: fakeId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.secrets.set(key, s);
    this.markDirty();
    return s;
  }

  editSecret(
    key: string,
    opts: { newKey?: string; value?: string; note?: string; labels?: string[] },
  ): UiSecret {
    const existing = this.secrets.get(key);
    if (!existing) {
      throw new Error(`no secret with key '${key}'`);
    }
    const newKey = opts.newKey ?? existing.key;
    if (newKey !== key && this.secrets.has(newKey)) {
      throw new Error(`a secret with key '${newKey}' already exists`);
    }
    const updated: UiSecret = {
      ...existing,
      key: newKey,
      value: opts.value ?? existing.value,
      note: opts.note ?? existing.note,
      labels: opts.labels ?? existing.labels,
      updatedAt: nowIso(),
    };
    this.secrets.delete(key);
    this.secrets.set(newKey, updated);
    this.markDirty();
    return updated;
  }

  removeSecret(key: string): boolean {
    const ok = this.secrets.delete(key);
    if (ok) {
      this.markDirty();
    }
    return ok;
  }

  async sync(): Promise<UiSyncReport> {
    this.syncCount += 1;
    if (this.conflictOnSync) {
      return { pushed: false, conflict: { token: { fake: true } } };
    }
    if (this.status === 'OFFLINE') {
      return { pushed: false, conflict: null };
    }
    this.status = 'SYNCED';
    return { pushed: true, conflict: null };
  }

  /**
   * Classify by extension, plus anything this fake has already exported (so a
   * round-trip works whatever the caller named the file).
   */
  detectImportKind(path: string): UiImportKind {
    const p = path.trim();
    if (this.exports.has(p)) {
      return 'orbkey';
    }
    const lower = p.toLowerCase();
    if (lower.endsWith('.xml')) {
      return 'keepass';
    }
    if (lower.endsWith('.json') || lower.endsWith('.orbkey')) {
      return 'orbkey';
    }
    return 'unknown';
  }

  /**
   * "Write" an export. Returns metadata only. `bytes` is an envelope estimate
   * derived from the entry COUNT, never from plaintext lengths, so the report
   * cannot be used to infer a value's size.
   */
  exportVault(path: string, passphrase: string): UiExportReport {
    if (this.locked) {
      throw new Error('vault is locked');
    }
    const dest = path.trim();
    if (!dest) {
      throw new Error('destination path is required');
    }
    if (!passphrase) {
      throw new Error('passphrase is required');
    }
    const snapshot = this.listSecrets().map((s) => ({ ...s, labels: [...s.labels] }));
    this.exports.set(dest, snapshot);
    this.exportCount += 1;
    this.lastExportPath = dest;
    return { path: dest, secretCount: snapshot.length, bytes: 512 + snapshot.length * 384 };
  }

  /** Read back an export. `'wrong'` is the fake's incorrect-passphrase sentinel. */
  importOrbkey(path: string, passphrase: string): UiImportReport {
    if (!passphrase) {
      throw new Error('passphrase is required');
    }
    if (passphrase === 'wrong') {
      throw new Error('incorrect export passphrase');
    }
    const entries = this.exports.get(path.trim()) ?? FAKE_ORBKEY_ENTRIES;
    let imported = 0;
    let skipped = 0;
    for (const e of entries) {
      if (this.secrets.has(e.key)) {
        skipped += 1;
        continue;
      }
      this.addSecret(e.key, e.value, e.note, e.labels);
      imported += 1;
    }
    return { imported, skipped, renamed: 0, errors: 0, keys: entries.map((e) => e.key) };
  }

  parseKeepass(_path: string): UiKeepassEntry[] {
    return [
      { title: 'github', username: 'clay', url: 'https://github.com', labels: ['dev'] },
      { title: 'aws/prod', username: 'root', url: '', labels: ['cloud'] },
    ];
  }

  importKeepass(_path: string): UiImportReport {
    const entries = this.parseKeepass(_path);
    let imported = 0;
    for (const e of entries) {
      if (!this.secrets.has(e.title)) {
        this.addSecret(e.title, 'imported-secret', '', e.labels);
        imported += 1;
      }
    }
    return { imported, skipped: 0, renamed: 0, errors: 0, keys: entries.map((e) => e.title) };
  }

  rotatePassword(oldPassword: string, _newPassword: string): void {
    if (oldPassword === 'wrong') {
      throw new Error('incorrect password');
    }
  }

  rotateIam(password: string, creds: UiIamCreds): void {
    if (password === 'wrong') {
      throw new Error('incorrect password');
    }
    this.account = creds.accountId;
    this.region = creds.region;
  }

  private markDirty(): void {
    if (this.status !== 'OFFLINE') {
      this.status = 'DIRTY';
    }
  }
}
