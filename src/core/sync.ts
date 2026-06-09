/**
 * S3 + KMS sync engine and the launch/push state machine.
 *
 * The vault's canonical plaintext is a serialized SQLite snapshot. Two
 * encryptions of that same plaintext exist:
 *   - Remote — KMS-enveloped, one S3 object, optimistic-concurrency controlled
 *     by ETag (If-Match conditional PutObject).
 *   - Local checkpoint — encrypted under the password-derived DB key, openable
 *     fully offline.
 *
 * Device-local bookkeeping (lastSyncedEtag, localDirty) lives in DeviceState and
 * never enters the vault.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AwsClients } from './aws.js';
import { errorCode, httpStatus, isNetworkError } from './aws.js';
import {
  DeviceState,
  atomicWriteBytes,
  checkpointsDir,
  defaultCheckpointPath,
  statePath,
} from './config.js';
import * as crypto from './crypto.js';
import { VaultStore } from './store.js';

export type SyncStatus = 'SYNCED' | 'DIRTY' | 'OFFLINE';
export const SyncStatus = {
  SYNCED: 'SYNCED' as const,
  DIRTY: 'DIRTY' as const,
  OFFLINE: 'OFFLINE' as const,
};

export type Outcome =
  | 'created'
  | 'pulled'
  | 'in_sync'
  | 'local_ahead'
  | 'remote_advanced'
  | 'conflict'
  | 'offline_loaded'
  | 'remote_missing';
export const Outcome = {
  CREATED: 'created' as const,
  PULLED: 'pulled' as const,
  IN_SYNC: 'in_sync' as const,
  LOCAL_AHEAD: 'local_ahead' as const,
  REMOTE_ADVANCED: 'remote_advanced' as const,
  CONFLICT: 'conflict' as const,
  OFFLINE_LOADED: 'offline_loaded' as const,
  REMOTE_MISSING: 'remote_missing' as const,
};

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class CheckpointMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointMissingError';
  }
}

export class VaultLocation {
  bucket: string;
  kmsKeyId: string;
  objectKey: string;

  constructor(bucket: string, kmsKeyId: string, objectKey = 'vaults/default/vault.bin') {
    this.bucket = bucket;
    this.kmsKeyId = kmsKeyId;
    this.objectKey = objectKey;
  }

  get vaultPrefix(): string {
    const idx = this.objectKey.lastIndexOf('/');
    return this.objectKey.slice(0, idx) + '/';
  }
}

export interface RemoteObject {
  blob: Buffer;
  etag: string;
}

export interface ConflictContext {
  localPlaintext: Buffer;
  remote: RemoteObject;
}

export interface LaunchResult {
  store: VaultStore | null;
  outcome: Outcome;
  status: SyncStatus;
  conflict: ConflictContext | null;
}

/** Format a UTC timestamp as Python's `%Y%m%dT%H%M%SZ`. */
function compactUtc(d: Date): string {
  const iso = d.toISOString(); // 2026-06-08T11:22:33.444Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export class SyncEngine {
  readonly location: VaultLocation;
  readonly dbKey: Buffer;
  readonly state: DeviceState;
  clients: AwsClients | null;
  readonly checkpointPath: string;
  readonly stateFile: string;

  constructor(
    location: VaultLocation,
    dbKey: Buffer,
    state: DeviceState,
    clients: AwsClients | null,
    checkpointPath: string = defaultCheckpointPath(),
    stateFile: string = statePath(),
  ) {
    this.location = location;
    this.dbKey = dbKey;
    this.state = state;
    this.clients = clients;
    this.checkpointPath = checkpointPath;
    this.stateFile = stateFile;
    if (this.state.vaultObjectKey === null) {
      this.state.vaultObjectKey = location.objectKey;
    }
  }

  private saveState(): void {
    this.state.save(this.stateFile);
  }

  get online(): boolean {
    return this.clients !== null;
  }

  private clientsOrThrow(): AwsClients {
    if (this.clients === null) {
      throw new Error('engine is offline');
    }
    return this.clients;
  }

  // --- remote I/O ----------------------------------------------------------

  private async headRemote(): Promise<string | null> {
    return this.clientsOrThrow().headObjectEtag(
      this.location.bucket,
      this.location.objectKey,
    );
  }

  private async getRemote(): Promise<RemoteObject> {
    const { blob, etag } = await this.clientsOrThrow().getObject(
      this.location.bucket,
      this.location.objectKey,
    );
    return { blob, etag };
  }

  async getRemotePublic(): Promise<RemoteObject> {
    return this.getRemote();
  }

  private async putRemote(
    blob: Buffer,
    opts: { ifMatch?: string; ifNoneMatch?: boolean } = {},
  ): Promise<string> {
    try {
      return await this.clientsOrThrow().putObject(
        this.location.bucket,
        this.location.objectKey,
        blob,
        opts,
      );
    } catch (err) {
      const status = httpStatus(err);
      const code = errorCode(err);
      if (
        status === 412 ||
        ['PreconditionFailed', 'ConditionalRequestConflict'].includes(code)
      ) {
        throw new ConflictError('remote vault changed since last sync');
      }
      throw err;
    }
  }

  // --- local checkpoint ----------------------------------------------------

  writeCheckpoint(plaintext: Buffer): void {
    atomicWriteBytes(
      this.checkpointPath,
      crypto.packLocalBlob(this.dbKey, plaintext),
    );
    this.state.lastCheckpointPath = this.checkpointPath;
  }

  readCheckpoint(): Buffer {
    if (!existsSync(this.checkpointPath)) {
      throw new CheckpointMissingError(
        `no checkpoint at ${this.checkpointPath}`,
      );
    }
    return crypto.unpackLocalBlob(
      this.dbKey,
      readFileSync(this.checkpointPath),
    );
  }

  // --- high-level operations ----------------------------------------------

  private async pull(): Promise<VaultStore> {
    const remote = await this.getRemote();
    const plaintext = await crypto.kmsDecrypt(
      this.clientsOrThrow().kms,
      remote.blob,
    );
    const store = VaultStore.load(plaintext);
    this.writeCheckpoint(plaintext);
    this.state.lastSyncedEtag = remote.etag;
    this.state.localDirty = false;
    this.saveState();
    return store;
  }

  private async createAndPush(): Promise<VaultStore> {
    const store = VaultStore.openEmpty();
    const plaintext = store.serialize();
    const cipher = await crypto.kmsEncrypt(
      this.clientsOrThrow().kms,
      this.location.kmsKeyId,
      plaintext,
    );
    const etag = await this.putRemote(cipher, { ifNoneMatch: true });
    this.writeCheckpoint(plaintext);
    this.state.lastSyncedEtag = etag;
    this.state.localDirty = false;
    this.saveState();
    return store;
  }

  async launch(): Promise<LaunchResult> {
    if (!this.online) {
      const store = VaultStore.load(this.readCheckpoint());
      return {
        store,
        outcome: Outcome.OFFLINE_LOADED,
        status: SyncStatus.OFFLINE,
        conflict: null,
      };
    }

    let remoteEtag: string | null;
    try {
      remoteEtag = await this.headRemote();
    } catch (err) {
      if (isNetworkError(err)) {
        const store = VaultStore.load(this.readCheckpoint());
        return {
          store,
          outcome: Outcome.OFFLINE_LOADED,
          status: SyncStatus.OFFLINE,
          conflict: null,
        };
      }
      throw err;
    }

    const synced = this.state.lastSyncedEtag;

    // Row 1: fresh device (no synced etag yet).
    if (synced === null) {
      if (remoteEtag !== null) {
        const store = await this.pull();
        return {
          store,
          outcome: Outcome.PULLED,
          status: SyncStatus.SYNCED,
          conflict: null,
        };
      }
      const store = await this.createAndPush();
      return {
        store,
        outcome: Outcome.CREATED,
        status: SyncStatus.SYNCED,
        conflict: null,
      };
    }

    // Object vanished remotely though we had synced state.
    if (remoteEtag === null) {
      const store = VaultStore.load(this.readCheckpoint());
      this.state.localDirty = true;
      this.saveState();
      return {
        store,
        outcome: Outcome.REMOTE_MISSING,
        status: SyncStatus.DIRTY,
        conflict: null,
      };
    }

    if (remoteEtag === synced) {
      // Rows 2 & 3: in sync. Load local checkpoint; dirty just means unpushed
      // local changes.
      const store = VaultStore.load(this.readCheckpoint());
      if (this.state.localDirty) {
        return {
          store,
          outcome: Outcome.LOCAL_AHEAD,
          status: SyncStatus.DIRTY,
          conflict: null,
        };
      }
      return {
        store,
        outcome: Outcome.IN_SYNC,
        status: SyncStatus.SYNCED,
        conflict: null,
      };
    }

    // remoteEtag != synced: remote advanced on another device.
    if (!this.state.localDirty) {
      // Row 6: clean locally — safe to replace with remote.
      const store = await this.pull();
      return {
        store,
        outcome: Outcome.REMOTE_ADVANCED,
        status: SyncStatus.SYNCED,
        conflict: null,
      };
    }

    // Row 7: both sides moved — CONFLICT.
    const localPlaintext = this.readCheckpoint();
    const remote = await this.getRemote();
    return {
      store: null,
      outcome: Outcome.CONFLICT,
      status: SyncStatus.DIRTY,
      conflict: { localPlaintext, remote },
    };
  }

  checkpoint(store: VaultStore): void {
    this.writeCheckpoint(store.serialize());
    this.state.localDirty = true;
    this.saveState();
  }

  async push(store: VaultStore): Promise<string> {
    const plaintext = store.serialize();
    const cipher = await crypto.kmsEncrypt(
      this.clientsOrThrow().kms,
      this.location.kmsKeyId,
      plaintext,
    );
    let etag: string;
    if (this.state.lastSyncedEtag === null) {
      etag = await this.putRemote(cipher, { ifNoneMatch: true });
    } else {
      etag = await this.putRemote(cipher, { ifMatch: this.state.lastSyncedEtag });
    }
    this.writeCheckpoint(plaintext);
    this.state.lastSyncedEtag = etag;
    this.state.localDirty = false;
    this.saveState();
    return etag;
  }

  // --- conflict resolution (v1: explicit, no auto-merge) ------------------

  async resolveKeepLocal(ctx: ConflictContext): Promise<VaultStore> {
    const store = VaultStore.load(ctx.localPlaintext);
    const cipher = await crypto.kmsEncrypt(
      this.clientsOrThrow().kms,
      this.location.kmsKeyId,
      ctx.localPlaintext,
    );
    const etag = await this.putRemote(cipher); // unconditional overwrite
    this.writeCheckpoint(ctx.localPlaintext);
    this.state.lastSyncedEtag = etag;
    this.state.localDirty = false;
    this.saveState();
    return store;
  }

  async resolveKeepRemote(ctx: ConflictContext): Promise<VaultStore> {
    const plaintext = await crypto.kmsDecrypt(
      this.clientsOrThrow().kms,
      ctx.remote.blob,
    );
    const store = VaultStore.load(plaintext);
    this.writeCheckpoint(plaintext);
    this.state.lastSyncedEtag = ctx.remote.etag;
    this.state.localDirty = false;
    this.saveState();
    return store;
  }

  async resolveSaveLocalThenPull(
    ctx: ConflictContext,
  ): Promise<{ store: VaultStore; savePath: string }> {
    const ts = compactUtc(new Date());
    const savePath = join(checkpointsDir(), `conflict-local-${ts}.checkpoint`);
    atomicWriteBytes(
      savePath,
      crypto.packLocalBlob(this.dbKey, ctx.localPlaintext),
    );
    const store = await this.resolveKeepRemote(ctx);
    return { store, savePath };
  }
}
