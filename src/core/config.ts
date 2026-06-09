/**
 * XDG paths and device-local state.
 *
 * Two on-disk artifacts live under `$XDG_CONFIG_HOME/orbkey` (default
 * `~/.config/orbkey`):
 *   - `keychain.json` — password-encrypted DB key + IAM creds (see keychain).
 *   - `state.json` — device-local sync state. Per-device; never serialized into
 *     the synced vault.
 *
 * Encrypted local checkpoints are written under `checkpoints/`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const APP_NAME = 'orbkey';

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : join(homedir(), '.config');
  return join(base, APP_NAME);
}

export function keychainPath(): string {
  return join(configDir(), 'keychain.json');
}

export function vaultConfigPath(): string {
  return join(configDir(), 'config.json');
}

export function statePath(): string {
  return join(configDir(), 'state.json');
}

export function checkpointsDir(): string {
  return join(configDir(), 'checkpoints');
}

export function defaultCheckpointPath(): string {
  return join(checkpointsDir(), 'vault.checkpoint');
}

export function ensureDirs(): void {
  mkdirSync(configDir(), { recursive: true });
  mkdirSync(checkpointsDir(), { recursive: true });
}

export function isFirstRun(): boolean {
  return !existsSync(keychainPath());
}

/** Atomic text write: `.tmp` then rename (atomic on POSIX). */
export function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Atomic binary write. */
export function atomicWriteBytes(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Non-secret vault locators captured from the CDK stack outputs. */
export interface VaultConfigData {
  bucket: string;
  kmsKeyId: string;
  objectKey: string;
}

const DEFAULT_OBJECT_KEY = 'vaults/default/vault.bin';

export class VaultConfig implements VaultConfigData {
  bucket: string;
  kmsKeyId: string;
  objectKey: string;

  constructor(data: { bucket: string; kmsKeyId: string; objectKey?: string }) {
    this.bucket = data.bucket;
    this.kmsKeyId = data.kmsKeyId;
    this.objectKey = data.objectKey ?? DEFAULT_OBJECT_KEY;
  }

  static load(path: string = vaultConfigPath()): VaultConfig | null {
    if (!existsSync(path)) {
      return null;
    }
    const d = JSON.parse(readFileSync(path, 'utf-8')) as {
      bucket: string;
      kms_key_id: string;
      object_key?: string;
    };
    return new VaultConfig({
      bucket: d.bucket,
      kmsKeyId: d.kms_key_id,
      objectKey: d.object_key ?? DEFAULT_OBJECT_KEY,
    });
  }

  save(path: string = vaultConfigPath()): void {
    // Preserve the Python snake_case JSON shape exactly.
    const doc = {
      bucket: this.bucket,
      kms_key_id: this.kmsKeyId,
      object_key: this.objectKey,
    };
    atomicWriteText(path, JSON.stringify(doc, null, 2));
  }
}

/** Per-device sync bookkeeping. Never goes into the vault. */
export class DeviceState {
  lastSyncedEtag: string | null;
  localDirty: boolean;
  lastCheckpointPath: string | null;
  vaultObjectKey: string | null;

  constructor(
    data: {
      lastSyncedEtag?: string | null;
      localDirty?: boolean;
      lastCheckpointPath?: string | null;
      vaultObjectKey?: string | null;
    } = {},
  ) {
    this.lastSyncedEtag = data.lastSyncedEtag ?? null;
    this.localDirty = data.localDirty ?? false;
    this.lastCheckpointPath = data.lastCheckpointPath ?? null;
    this.vaultObjectKey = data.vaultObjectKey ?? null;
  }

  static load(path: string = statePath()): DeviceState {
    if (!existsSync(path)) {
      return new DeviceState();
    }
    const d = JSON.parse(readFileSync(path, 'utf-8')) as {
      last_synced_etag?: string | null;
      local_dirty?: boolean;
      last_checkpoint_path?: string | null;
      vault_object_key?: string | null;
    };
    return new DeviceState({
      lastSyncedEtag: d.last_synced_etag ?? null,
      localDirty: Boolean(d.local_dirty),
      lastCheckpointPath: d.last_checkpoint_path ?? null,
      vaultObjectKey: d.vault_object_key ?? null,
    });
  }

  save(path: string = statePath()): void {
    const doc = {
      last_synced_etag: this.lastSyncedEtag,
      local_dirty: this.localDirty,
      last_checkpoint_path: this.lastCheckpointPath,
      vault_object_key: this.vaultObjectKey,
    };
    atomicWriteText(path, JSON.stringify(doc, null, 2));
  }
}
