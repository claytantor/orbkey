/** Full sync state-machine matrix, 412 conflict, resolution paths (mirrors test_sync.py). */
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from '../src/core/crypto.js';
import { DeviceState } from '../src/core/config.js';
import { VaultStore } from '../src/core/store.js';
import {
  ConflictError,
  Outcome,
  SyncEngine,
  SyncStatus,
  VaultLocation,
  type ConflictContext,
} from '../src/core/sync.js';
import { AwsClients } from '../src/core/aws.js';
import { IamCreds } from '../src/core/keychain.js';
import { FakeAws, MOTO_ACCOUNT_ID, REGION } from './helpers/awsMock.js';

const BUCKET = 'orbkey-test-bucket';
const VAULT_KEY = 'vaults/default/vault.bin';

let fake: FakeAws;
let clients: AwsClients;
let location: VaultLocation;
let dbKey: Buffer;
let root: string;

beforeEach(() => {
  fake = new FakeAws();
  clients = new AwsClients(
    new IamCreds({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: REGION,
      accountId: MOTO_ACCOUNT_ID,
    }),
  );
  location = new VaultLocation(BUCKET, 'test-kms-key', VAULT_KEY);
  dbKey = crypto.randomKey();
  root = mkdtempSync(join(tmpdir(), 'orbkey-sync-'));
});

function paths(name: string): { ckpt: string; statef: string } {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return { ckpt: join(d, 'vault.checkpoint'), statef: join(d, 'state.json') };
}

function engine(name: string, state: DeviceState): SyncEngine {
  const { ckpt, statef } = paths(name);
  return new SyncEngine(location, dbKey, state, clients, ckpt, statef);
}

describe('sync launch state machine', () => {
  it('row1 fresh, no remote -> creates', async () => {
    const st = new DeviceState();
    const eng = engine('A', st);
    const res = await eng.launch();
    expect(res.outcome).toBe(Outcome.CREATED);
    expect(res.status).toBe(SyncStatus.SYNCED);
    expect(eng.state.lastSyncedEtag).not.toBeNull();
    expect(eng.state.localDirty).toBe(false);
    // object exists
    expect(await clients.headObjectEtag(BUCKET, VAULT_KEY)).not.toBeNull();
  });

  it('row1 fresh, with remote -> pulls', async () => {
    const a = engine('A', new DeviceState());
    const store = (await a.launch()).store!;
    store.addSecret('k', 'v');
    await a.push(store);

    const b = engine('B', new DeviceState());
    const res = await b.launch();
    expect(res.outcome).toBe(Outcome.PULLED);
    expect(res.store!.getSecret('k')!.value).toBe('v');
  });

  it('row2 in sync clean', async () => {
    const st = new DeviceState();
    await engine('A', st).launch(); // CREATED
    const res = await engine('A', st).launch(); // relaunch
    expect(res.outcome).toBe(Outcome.IN_SYNC);
    expect(res.status).toBe(SyncStatus.SYNCED);
    expect(res.store).not.toBeNull();
  });

  it('row3 local ahead dirty', async () => {
    const st = new DeviceState();
    const e1 = engine('A', st);
    const store = (await e1.launch()).store!;
    store.addSecret('x', 'y');
    e1.checkpoint(store);
    const res = await engine('A', st).launch();
    expect(res.outcome).toBe(Outcome.LOCAL_AHEAD);
    expect(res.status).toBe(SyncStatus.DIRTY);
    expect(res.store!.getSecret('x')!.value).toBe('y');
  });

  it('row6 remote advanced clean -> pulls', async () => {
    const sta = new DeviceState();
    const a = engine('A', sta);
    const sa = (await a.launch()).store!;
    sa.addSecret('k1', 'v1');
    await a.push(sa);

    const stb = new DeviceState();
    await engine('B', stb).launch(); // B pulls etag1

    sa.addSecret('k2', 'v2');
    await a.push(sa); // remote advances to etag2

    const res = await engine('B', stb).launch();
    expect(res.outcome).toBe(Outcome.REMOTE_ADVANCED);
    expect(res.store!.getSecret('k2')!.value).toBe('v2');
  });

  it('row7 conflict', async () => {
    const { ctx } = await setupConflict();
    expect(ctx).not.toBeNull();
    expect(ctx!.localPlaintext.length).toBeGreaterThan(0);
    expect(ctx!.remote.etag).toBeTruthy();
  });

  it('offline loads checkpoint', async () => {
    const st = new DeviceState();
    await engine('A', st).launch(); // online create

    const { ckpt, statef } = paths('A');
    const offline = new SyncEngine(location, dbKey, st, null, ckpt, statef);
    const res = await offline.launch();
    expect(res.outcome).toBe(Outcome.OFFLINE_LOADED);
    expect(res.status).toBe(SyncStatus.OFFLINE);
    expect(res.store).not.toBeNull();
  });
});

describe('sync push optimistic concurrency', () => {
  it('concurrent push returns 412', async () => {
    const sta = new DeviceState();
    const a = engine('A', sta);
    const sa = (await a.launch()).store!;
    sa.addSecret('base', '0');
    await a.push(sa);

    const stb = new DeviceState();
    const b = engine('B', stb);
    const sb = (await b.launch()).store!; // B at etag from A's push

    sa.addSecret('a2', 'x');
    await a.push(sa); // remote moves under B

    sb.addSecret('b2', 'y');
    await expect(b.push(sb)).rejects.toThrow(ConflictError);
  });
});

async function setupConflict(): Promise<{ b2: SyncEngine; ctx: ConflictContext | null }> {
  const sta = new DeviceState();
  const a = engine('A', sta);
  const sa = (await a.launch()).store!;
  sa.addSecret('base', '0');
  await a.push(sa);

  const stb = new DeviceState();
  const b = engine('B', stb);
  const sb = (await b.launch()).store!;
  sb.addSecret('bonly', '1');
  b.checkpoint(sb);

  sa.addSecret('aonly', '2');
  await a.push(sa);

  const b2 = engine('B', stb);
  const res = await b2.launch();
  expect(res.outcome).toBe(Outcome.CONFLICT);
  return { b2, ctx: res.conflict };
}

describe('conflict resolution', () => {
  it('keep local', async () => {
    const { b2, ctx } = await setupConflict();
    const store = await b2.resolveKeepLocal(ctx!);
    expect(store.getSecret('bonly')).not.toBeNull();
    expect(b2.state.localDirty).toBe(false);
    const res = await engine('C', new DeviceState()).launch();
    const keys = new Set(res.store!.listSecrets().map((s) => s.key));
    expect(keys.has('bonly')).toBe(true);
    expect(keys.has('aonly')).toBe(false);
  });

  it('keep remote', async () => {
    const { b2, ctx } = await setupConflict();
    const store = await b2.resolveKeepRemote(ctx!);
    const keys = new Set(store.listSecrets().map((s) => s.key));
    expect(keys.has('aonly')).toBe(true);
    expect(keys.has('bonly')).toBe(false);
    expect(b2.state.localDirty).toBe(false);
  });

  it('save local then pull', async () => {
    const { b2, ctx } = await setupConflict();
    const { store, savePath } = await b2.resolveSaveLocalThenPull(ctx!);
    expect(store.getSecret('aonly')).not.toBeNull();
    expect(store.getSecret('bonly')).toBeNull();
    expect(existsSync(savePath)).toBe(true);
    const plain = crypto.unpackLocalBlob(dbKey, readFileSync(savePath));
    const saved = VaultStore.load(plain);
    expect(saved.getSecret('bonly')).not.toBeNull();
    saved.close();
  });
});
