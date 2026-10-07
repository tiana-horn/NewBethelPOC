// A D1Database-compatible adapter backed by real in-memory SQLite (node:sqlite),
// loaded from db/schema.sql. This gives the test suite AUTHENTIC database
// semantics — including the UNIQUE indexes that make appendTraces/appendEvidence
// idempotent — instead of a hand-mocked fake. Deterministic, no Workers runtime.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Env } from '../src/env';

// node:sqlite is a very new Node builtin that Vite's static resolver doesn't
// know; require() it at runtime so it loads straight from the Node runtime.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');

function boundStatement(db: DatabaseSync, sql: string) {
  let args: unknown[] = [];
  const stmt = db.prepare(sql);
  const api = {
    bind(...a: unknown[]) {
      args = a.map((v) => (v === undefined ? null : v));
      return api;
    },
    async first<T = unknown>(): Promise<T | null> {
      const row = stmt.get(...(args as any[]));
      return (row ?? null) as T | null;
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      return { results: stmt.all(...(args as any[])) as T[] };
    },
    async run(): Promise<{ success: boolean }> {
      stmt.run(...(args as any[]));
      return { success: true };
    },
  };
  return api;
}

export interface TestDb {
  db: D1Database;
  raw: DatabaseSync;
  env: Env;
}

export function makeTestDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const d1: any = {
    prepare: (sql: string) => boundStatement(raw, sql),
    async batch(stmts: any[]) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const env = { DB: d1, USE_AI: 'false', AI_GATEWAY_ID: 'test' } as unknown as Env;
  return { db: d1 as D1Database, raw, env };
}
