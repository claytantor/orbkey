/**
 * Adapter: wraps the core `Session` to satisfy the UI's `SessionPort`.
 *
 * This is the ONLY place that bridges core <-> UI. It lives outside `src/ui/`
 * so the UI package keeps a clean boundary (no core / @aws-sdk imports there).
 */

import { Session } from './core/session.js';
import { IamCreds } from './core/keychain.js';
import { parseKeepassXml } from './core/keepass.js';
import type { Secret } from './models.js';
import type { ConflictContext } from './core/sync.js';
import type {
  AccountContext,
  ConflictChoice,
  FirstRunInput,
  SessionPort,
  UiConflict,
  UiIamCreds,
  UiImportReport,
  UiKeepassEntry,
  UiLaunchResult,
  UiSecret,
  UiSyncReport,
} from './ui/types.js';

function toUiSecret(s: Secret): UiSecret {
  return {
    key: s.key,
    value: s.value,
    note: s.note,
    labels: s.labels,
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export class SessionAdapter implements SessionPort {
  private readonly session: Session;

  constructor(session: Session = new Session()) {
    this.session = session;
  }

  get locked(): boolean {
    return this.session.locked;
  }

  get status(): 'SYNCED' | 'DIRTY' | 'OFFLINE' {
    return this.session.status;
  }

  get isFirstRun(): boolean {
    return this.session.isFirstRun;
  }

  accountContext(): AccountContext {
    const creds = this.session.keychain?.iamCreds;
    return {
      account: creds?.accountId ?? null,
      region: creds?.region ?? null,
      profile: process.env.AWS_PROFILE ?? null,
    };
  }

  listSecrets(): UiSecret[] {
    return (this.session.store?.listSecrets() ?? []).map(toUiSecret);
  }

  search(term: string): UiSecret[] {
    return (this.session.store?.search(term) ?? []).map(toUiSecret);
  }

  getSecret(key: string): UiSecret | null {
    const s = this.session.store?.getSecret(key) ?? null;
    return s ? toUiSecret(s) : null;
  }

  async unlock(password: string): Promise<UiLaunchResult> {
    return this.fromLaunch(await this.session.unlock(password));
  }

  async firstRun(input: FirstRunInput): Promise<UiLaunchResult> {
    return this.fromLaunch(await this.session.firstRun(input));
  }

  async resolveConflict(
    conflict: UiConflict,
    choice: ConflictChoice,
  ): Promise<string | null> {
    return this.session.resolveConflict(
      conflict.token as ConflictContext,
      choice,
    );
  }

  lock(): void {
    this.session.lock();
  }

  async close(): Promise<UiSyncReport> {
    const r = await this.session.close();
    return { pushed: r.pushed, conflict: r.conflict ? { token: r.conflict } : null };
  }

  addSecret(key: string, value: string, note: string, labels: string[]): UiSecret {
    return toUiSecret(this.session.addSecret(key, value, note, labels));
  }

  editSecret(
    key: string,
    opts: { newKey?: string; value?: string; note?: string; labels?: string[] },
  ): UiSecret {
    return toUiSecret(this.session.editSecret(key, opts));
  }

  removeSecret(key: string): boolean {
    return this.session.removeSecret(key);
  }

  async sync(): Promise<UiSyncReport> {
    const r = await this.session.sync();
    return { pushed: r.pushed, conflict: r.conflict ? { token: r.conflict } : null };
  }

  parseKeepass(path: string): UiKeepassEntry[] {
    return parseKeepassXml(path).map((e) => ({
      title: e.title,
      username: e.username,
      url: e.url,
      labels: e.labels,
    }));
  }

  importKeepass(path: string): UiImportReport {
    const entries = parseKeepassXml(path);
    const r = this.session.importKeepass(entries);
    return {
      imported: r.imported,
      skipped: r.skipped,
      renamed: r.renamed,
      errors: r.errors,
      keys: r.keys,
    };
  }

  rotatePassword(oldPassword: string, newPassword: string): void {
    this.session.rotatePassword(oldPassword, newPassword);
  }

  rotateIam(password: string, creds: UiIamCreds): void {
    this.session.rotateIam(
      password,
      new IamCreds({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        region: creds.region,
        accountId: creds.accountId,
      }),
    );
  }

  private fromLaunch(r: {
    outcome: UiLaunchResult['outcome'];
    status: UiLaunchResult['status'];
    conflict: ConflictContext | null;
  }): UiLaunchResult {
    return {
      outcome: r.outcome,
      status: r.status,
      conflict: r.conflict ? { token: r.conflict } : null,
    };
  }
}
