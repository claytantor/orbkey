/**
 * UI-facing types and the Session port.
 *
 * The UI layer consumes ONLY this port — never the core modules or @aws-sdk
 * directly (mirrors the Python boundary). Both the real `Session` (via a thin
 * adapter) and a `FakeSession` implement `SessionPort`.
 */

/** A secret as the UI renders it (camelCase, matches models.Secret). */
export interface UiSecret {
  key: string;
  value: string;
  note: string;
  labels: string[];
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type UiSyncStatus = 'SYNCED' | 'DIRTY' | 'OFFLINE';

export type UiOutcome =
  | 'created'
  | 'pulled'
  | 'in_sync'
  | 'local_ahead'
  | 'remote_advanced'
  | 'conflict'
  | 'offline_loaded'
  | 'remote_missing';

export type ConflictChoice = 'keep_local' | 'keep_remote' | 'save_then_pull';

/** Opaque conflict context handed back to resolveConflict. */
export interface UiConflict {
  // The UI never inspects the bytes; it only forwards the token.
  readonly token: unknown;
}

export interface UiLaunchResult {
  outcome: UiOutcome;
  status: UiSyncStatus;
  conflict: UiConflict | null;
}

export interface UiSyncReport {
  pushed: boolean;
  conflict: UiConflict | null;
}

export interface UiImportReport {
  imported: number;
  skipped: number;
  renamed: number;
  errors: number;
  keys: string[];
}

export interface UiKeepassEntry {
  title: string;
  username: string;
  url: string;
  labels: string[];
}

/**
 * Result of a `:export` run. Carries ONLY metadata — never a secret value and
 * never the passphrase — so it is safe to render in the status line.
 */
export interface UiExportReport {
  path: string;
  secretCount: number;
  bytes: number;
}

/**
 * What an import path actually is, decided by the port (not the UI).
 * `unknown` means "do not proceed" — the UI surfaces a clear message instead of
 * guessing a parser.
 */
export type UiImportKind = 'keepass' | 'orbkey' | 'unknown';

export interface UiIamCreds {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  accountId: string;
}

export interface FirstRunInput {
  accountId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  kmsKeyId: string;
  password: string;
  objectKey: string;
}

/** Account/region chrome shown in the header so users never act on the wrong account. */
export interface AccountContext {
  account: string | null;
  region: string | null;
  profile: string | null;
}

/**
 * The single imperative surface the UI is allowed to call. Mutations that touch
 * SQLite are synchronous; AWS-touching operations are async.
 */
export interface SessionPort {
  // state
  readonly locked: boolean;
  readonly status: UiSyncStatus;
  readonly isFirstRun: boolean;
  accountContext(): AccountContext;

  // reads
  listSecrets(): UiSecret[];
  search(term: string): UiSecret[];
  getSecret(key: string): UiSecret | null;

  // lifecycle
  unlock(password: string): Promise<UiLaunchResult>;
  firstRun(input: FirstRunInput): Promise<UiLaunchResult>;
  resolveConflict(conflict: UiConflict, choice: ConflictChoice): Promise<string | null>;
  lock(): void;
  close(): Promise<UiSyncReport>;

  // mutations
  addSecret(key: string, value: string, note: string, labels: string[]): UiSecret;
  editSecret(
    key: string,
    opts: { newKey?: string; value?: string; note?: string; labels?: string[] },
  ): UiSecret;
  removeSecret(key: string): boolean;

  // sync
  sync(): Promise<UiSyncReport>;

  // import
  /** Classify a file before any parser touches it. Never throws on content. */
  detectImportKind(path: string): UiImportKind;
  parseKeepass(path: string): UiKeepassEntry[];
  importKeepass(path: string): UiImportReport;
  /** Import an orbkey-native export. `passphrase` decrypts the file's values. */
  importOrbkey(path: string, passphrase: string): UiImportReport;

  // export
  /**
   * Write the vault to `path` as an orbkey-native export whose secret values are
   * encrypted under `passphrase`. Returns metadata only — the caller must never
   * receive (or render) a value.
   */
  exportVault(path: string, passphrase: string): UiExportReport;

  // rotation
  rotatePassword(oldPassword: string, newPassword: string): void;
  rotateIam(password: string, creds: UiIamCreds): void;
}
