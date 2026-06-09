/**
 * Session controller — UI-agnostic orchestration of the whole lifecycle.
 *
 * The Ink app is a thin shell over this class: first-run, unlock, every mutating
 * operation, sync, conflict resolution, lock, and rotation all live here so they
 * can be unit-tested headlessly. The UI never talks to the core modules directly.
 */

import * as config from './config.js';
import { DeviceState, VaultConfig } from './config.js';
import * as crypto from './crypto.js';
import { AwsClients, OfflineError, validateCreds } from './aws.js';
import type { KeePassEntry } from './keepass.js';
import * as keychain from './keychain.js';
import { IamCreds, type UnlockedKeychain } from './keychain.js';
import { type BulkImportReport, VaultStore } from './store.js';
import {
  type ConflictContext,
  ConflictError,
  type LaunchResult,
  type Outcome,
  SyncEngine,
  type SyncStatus,
  VaultLocation,
} from './sync.js';
import type { Secret } from '../models.js';

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SyncReport {
  pushed: boolean;
  conflict: ConflictContext | null;
}

export type ConflictChoice = 'keep_local' | 'keep_remote' | 'save_then_pull';

export interface FirstRunArgs {
  accountId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  kmsKeyId: string;
  password: string;
  objectKey?: string;
  params?: crypto.Argon2Params;
}

/** Holds all live (unlocked) state for one running instance. */
export class Session {
  vaultConfig: VaultConfig | null = null;
  keychain: UnlockedKeychain | null = null;
  clients: AwsClients | null = null;
  engine: SyncEngine | null = null;
  store: VaultStore | null = null;
  state: DeviceState | null = null;
  status: SyncStatus = 'OFFLINE';
  locked = true;

  // --- lifecycle -----------------------------------------------------------

  get isFirstRun(): boolean {
    return config.isFirstRun() || VaultConfig.load() === null;
  }

  async firstRun(args: FirstRunArgs): Promise<LaunchResult> {
    config.ensureDirs();
    const creds = new IamCreds({
      accessKeyId: args.accessKeyId,
      secretAccessKey: args.secretAccessKey,
      region: args.region,
      accountId: args.accountId,
    });
    const objectKey = args.objectKey ?? 'vaults/default/vault.bin';
    const vaultCfg = new VaultConfig({
      bucket: args.bucket,
      kmsKeyId: args.kmsKeyId,
      objectKey,
    });
    // Probe AWS before writing anything persistent.
    const prefix = new VaultLocation(args.bucket, args.kmsKeyId, objectKey)
      .vaultPrefix;
    this.clients = await validateCreds(creds, args.bucket, prefix, args.kmsKeyId);
    vaultCfg.save();
    this.vaultConfig = vaultCfg;
    this.keychain = keychain.create(args.password, creds, args.params);
    return this.startEngineAndLaunch();
  }

  async unlock(password: string): Promise<LaunchResult> {
    this.vaultConfig = VaultConfig.load();
    if (this.vaultConfig === null) {
      throw new SessionError('no vault config; first run required');
    }
    this.keychain = keychain.unlock(password); // throws KeychainError on bad pw
    try {
      this.clients = new AwsClients(this.keychain.iamCreds);
      // A cheap reachability check happens inside launch() via headObject.
    } catch (err) {
      if (err instanceof OfflineError) {
        this.clients = null;
      } else {
        throw err;
      }
    }
    return this.startEngineAndLaunch();
  }

  private async startEngineAndLaunch(): Promise<LaunchResult> {
    if (!this.vaultConfig || !this.keychain) {
      throw new SessionError('cannot launch without config and keychain');
    }
    this.state = DeviceState.load();
    const location = new VaultLocation(
      this.vaultConfig.bucket,
      this.vaultConfig.kmsKeyId,
      this.vaultConfig.objectKey,
    );
    this.engine = new SyncEngine(
      location,
      this.keychain.dbKey,
      this.state,
      this.clients,
      config.defaultCheckpointPath(),
      config.statePath(),
    );
    const result = await this.engine.launch();
    this.store = result.store;
    this.status = result.status;
    this.locked = false;
    return result;
  }

  // --- conflict resolution (forwarded to the engine) ----------------------

  async resolveConflict(
    ctx: ConflictContext,
    choice: ConflictChoice,
  ): Promise<string | null> {
    if (!this.engine) {
      throw new SessionError('no engine');
    }
    let saved: string | null = null;
    if (choice === 'keep_local') {
      this.store = await this.engine.resolveKeepLocal(ctx);
    } else if (choice === 'keep_remote') {
      this.store = await this.engine.resolveKeepRemote(ctx);
    } else if (choice === 'save_then_pull') {
      const res = await this.engine.resolveSaveLocalThenPull(ctx);
      this.store = res.store;
      saved = res.savePath;
    } else {
      const exhaustive: never = choice;
      throw new SessionError(`unknown conflict choice ${String(exhaustive)}`);
    }
    this.status = 'SYNCED';
    this.locked = false;
    return saved;
  }

  // --- mutations -----------------------------------------------------------

  private afterMutation(): void {
    if (!this.engine || !this.store) {
      throw new SessionError('not unlocked');
    }
    this.engine.checkpoint(this.store);
    this.status = this.engine.online ? 'DIRTY' : 'OFFLINE';
  }

  private requireStore(): VaultStore {
    if (!this.store) {
      throw new SessionError('vault is locked');
    }
    return this.store;
  }

  addSecret(key: string, value: string, note = '', labels: string[] = []): Secret {
    const s = this.requireStore().addSecret(key, value, note, labels);
    this.afterMutation();
    return s;
  }

  importKeepass(entries: KeePassEntry[]): BulkImportReport {
    const report = this.requireStore().addSecretsBulk(entries);
    if (report.imported > 0) {
      this.afterMutation();
    }
    return report;
  }

  editSecret(
    key: string,
    opts: { newKey?: string; value?: string; note?: string; labels?: string[] },
  ): Secret {
    const s = this.requireStore().editSecret(key, opts);
    this.afterMutation();
    return s;
  }

  removeSecret(key: string): boolean {
    const ok = this.requireStore().removeSecret(key);
    if (ok) {
      this.afterMutation();
    }
    return ok;
  }

  setNote(key: string, note: string): Secret {
    const s = this.requireStore().setNote(key, note);
    this.afterMutation();
    return s;
  }

  setLabels(key: string, labels: string[]): Secret {
    const s = this.requireStore().setLabels(key, labels);
    this.afterMutation();
    return s;
  }

  // --- sync ----------------------------------------------------------------

  async sync(): Promise<SyncReport> {
    if (!this.engine || !this.state) {
      throw new SessionError('not unlocked');
    }
    if (!this.engine.online) {
      return { pushed: false, conflict: null };
    }
    if (!this.state.localDirty) {
      this.status = 'SYNCED';
      return { pushed: false, conflict: null };
    }
    try {
      await this.engine.push(this.requireStore());
    } catch (err) {
      if (err instanceof ConflictError) {
        const localPlaintext = this.engine.readCheckpoint();
        const remote = await this.engine.getRemotePublic();
        return { pushed: false, conflict: { localPlaintext, remote } };
      }
      throw err;
    }
    this.status = 'SYNCED';
    return { pushed: true, conflict: null };
  }

  // --- rotation ------------------------------------------------------------

  rotatePassword(oldPassword: string, newPassword: string): void {
    this.keychain = keychain.rotatePassword(oldPassword, newPassword);
  }

  rotateIam(password: string, newCreds: IamCreds): void {
    this.keychain = keychain.rotateIam(password, newCreds);
    this.clients = new AwsClients(newCreds);
    if (this.engine) {
      this.engine.clients = this.clients;
    }
  }

  // --- lock / exit ---------------------------------------------------------

  lock(): void {
    if (this.keychain !== null) {
      crypto.zeroize(this.keychain.dbKey);
      this.keychain = null;
    }
    if (this.store !== null) {
      this.store.close();
      this.store = null;
    }
    this.clients = null;
    this.engine = null;
    this.locked = true;
  }

  async close(): Promise<SyncReport> {
    let report: SyncReport = { pushed: false, conflict: null };
    if (
      this.engine &&
      this.store &&
      this.state &&
      this.engine.online &&
      this.state.localDirty
    ) {
      report = await this.sync();
    }
    this.lock();
    return report;
  }
}

export type { Outcome };
