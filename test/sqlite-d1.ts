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
  putR2: (key: string, value: string) => void;
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
  // Minimal in-memory KV (buildModeContext self-seeds profiles through it).
  const kvStore = new Map<string, string>();
  const kv = {
    async get(k: string) { return kvStore.get(k) ?? null; },
    async put(k: string, v: string) { kvStore.set(k, v); },
    async delete(k: string) { kvStore.delete(k); },
  };
  // R2 that holds nothing by default (the drafter's un-ingested path returns an
  // honestly-empty IR). Tests can put objects via `putR2`.
  const r2Store = new Map<string, string>();
  const r2 = {
    async get(k: string) {
      const v = r2Store.get(k);
      return v === undefined ? null : { text: async () => v };
    },
    async put(k: string, v: string) { r2Store.set(k, v); },
  };
  const env = {
    DB: d1,
    KV: kv,
    R2: r2,
    USE_AI: 'false',
    AI_GATEWAY_ID: 'test',
  } as unknown as Env;
  return { db: d1 as D1Database, raw, env, putR2: (k: string, v: string) => r2Store.set(k, v) };
}
