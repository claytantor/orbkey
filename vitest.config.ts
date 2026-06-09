import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Native modules (better-sqlite3, @node-rs/argon2) + Ink need the real
    // runtime; keep a single fork pool so SQLite handles don't cross threads.
    pool: 'forks',
    testTimeout: 30000,
  },
});
