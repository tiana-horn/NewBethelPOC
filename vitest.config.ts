import { defineConfig } from 'vitest/config';

// Plain node environment. Tests exercise the real agent/pipeline logic against a
// real in-memory SQLite D1 adapter (test/sqlite-d1.ts) with USE_AI=false — no
// Workers runtime needed, so they run fast and deterministically.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // node:sqlite is a Node builtin (experimental) that Vite's resolver doesn't
    // know about; keep it external so it loads from the Node runtime.
    server: { deps: { external: ['node:sqlite'] } },
  },
});
