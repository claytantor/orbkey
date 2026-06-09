/** Parity: open a Python-written serialized SQLite vault image with better-sqlite3. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { VaultStore } from '../../src/core/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
const b64 = (s: unknown): Buffer => Buffer.from(String(s), 'base64');

describe('store parity with Python', () => {
  it('opens a Python serialize() image and reads secrets + FTS', () => {
    const v = fx('store_image.json');
    const store = VaultStore.load(b64(v.image_b64));
    try {
      const got = new Set(store.listSecrets().map((s) => s.key));
      for (const k of v.expected_keys as string[]) {
        expect(got.has(k)).toBe(true);
      }
      const expectedValues = v.expected_values as Record<string, string>;
      for (const [k, val] of Object.entries(expectedValues)) {
        expect(store.getSecret(k)?.value).toBe(val);
      }
      expect(store.getMeta('vault_id')).toBe(v.vault_id);
      expect(store.getMeta('schema_version')).toBe('1');
      // FTS works after a Python-written image is rebuilt on load.
      const devKeys = new Set(store.search('dev').map((s) => s.key));
      for (const k of v.search_dev_keys as string[]) {
        expect(devKeys.has(k)).toBe(true);
      }
    } finally {
      store.close();
    }
  });
});
