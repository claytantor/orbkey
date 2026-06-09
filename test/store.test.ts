/** VaultStore CRUD, labels, FTS5 prefix search, serialize/deserialize (mirrors test_store.py). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VaultStore,
  DuplicateKeyError,
  NotFoundError,
} from '../src/core/store.js';

describe('VaultStore', () => {
  let store: VaultStore;
  beforeEach(() => {
    store = VaultStore.openEmpty();
  });
  afterEach(() => {
    store.close();
  });

  const keys = (res: { key: string }[]): Set<string> =>
    new Set(res.map((s) => s.key));

  it('add / get / list', () => {
    store.addSecret('aws/prod', 'sekret', 'prod root', ['aws', 'prod']);
    const got = store.getSecret('aws/prod');
    expect(got).not.toBeNull();
    expect(got?.value).toBe('sekret');
    expect(got?.note).toBe('prod root');
    expect(new Set(got?.labels)).toEqual(new Set(['aws', 'prod']));
    expect(store.listSecrets().map((s) => s.key)).toEqual(['aws/prod']);
  });

  it('duplicate key rejected', () => {
    store.addSecret('dup', 'a');
    expect(() => store.addSecret('dup', 'b')).toThrow(DuplicateKeyError);
  });

  it('edit and rename', () => {
    store.addSecret('k1', 'v1', '', ['x']);
    store.editSecret('k1', {
      newKey: 'k2',
      value: 'v2',
      note: 'n',
      labels: ['y', 'z'],
    });
    expect(store.getSecret('k1')).toBeNull();
    const got = store.getSecret('k2');
    expect(got?.value).toBe('v2');
    expect(got?.note).toBe('n');
    expect(new Set(got?.labels)).toEqual(new Set(['y', 'z']));
  });

  it('edit missing raises', () => {
    expect(() => store.editSecret('ghost', { value: 'x' })).toThrow(NotFoundError);
  });

  it('remove and prune orphan label', () => {
    store.addSecret('k', 'v', '', ['solo']);
    expect(store.removeSecret('k')).toBe(true);
    expect(store.getSecret('k')).toBeNull();
    expect(store.removeSecret('k')).toBe(false);
    expect(store.listLabels().map((l) => l.name)).toEqual([]);
  });

  it('search prefix and fields (not values)', () => {
    store.addSecret('github/token', 'ghp_xxx', 'personal access', ['dev']);
    store.addSecret('gitlab/token', 'glpat', 'ci', ['dev']);
    store.addSecret('aws/key', 'akia', 'billing', ['cloud']);

    expect(keys(store.search('git'))).toEqual(new Set(['github/token', 'gitlab/token']));
    expect(keys(store.search('github'))).toEqual(new Set(['github/token']));
    expect(keys(store.search('dev'))).toEqual(new Set(['github/token', 'gitlab/token']));
    expect(keys(store.search('billing'))).toEqual(new Set(['aws/key']));
    expect(keys(store.search(''))).toEqual(
      new Set(['github/token', 'gitlab/token', 'aws/key']),
    );
  });

  it('value is not searchable', () => {
    store.addSecret('k', 'topsecretvalue', 'note');
    expect(store.search('topsecretvalue')).toEqual([]);
  });

  it('serialize / deserialize round-trip', () => {
    store.addSecret('a', '1', '', ['l1']);
    store.addSecret('b', '2', 'bee');
    const blob = store.serialize();
    const loaded = VaultStore.load(blob);
    expect(keys(loaded.listSecrets())).toEqual(new Set(['a', 'b']));
    expect(loaded.getSecret('a')?.value).toBe('1');
    expect(keys(loaded.search('bee'))).toEqual(new Set(['b']));
    expect(loaded.getMeta('schema_version')).toBe('1');
    loaded.close();
  });

  it('large vault search', () => {
    for (let i = 0; i < 1000; i++) {
      const n = String(i).padStart(4, '0');
      store.addSecret(`svc/${n}`, `val${i}`, '', [`group${i % 10}`]);
    }
    expect(store.listSecrets().length).toBe(1000);
    expect(store.search('group3').length).toBe(100);
    expect(keys(store.search('svc/0001'))).toEqual(new Set(['svc/0001']));
  });
});
