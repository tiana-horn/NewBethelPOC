import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, type TestDb } from './sqlite-d1';
import {
  lookupReference,
  loadReferenceMap,
  getCriteria,
  criteriaEditions,
  appendTraces,
  getTraces,
  countTraces,
  clearTraces,
  appendEvidence,
  getEvidence,
} from '../src/db/d1';
import type { TraceRow, ReviewEvidenceRow } from '../src/shared/types';

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  // Seed a couple of authoritative rows directly.
  t.raw.exec(`
    INSERT INTO ref_list (rid, list_id, org, designation, edition_date, title, active) VALUES
      ('rid-astm-d16', 'UMRL', 'ASTM', 'ASTM D16', '2020', 'Terminology for Paint', 1),
      ('rid-mpi-43', 'UMRL', 'MPI', 'MPI 43', '2021', 'Interior Latex, Eggshell', 1);
    INSERT INTO criteria (cid, profile, document, edition, clause, text) VALUES
      ('cid-ufc-fmt', 'ufc', 'UFC 1-300-02', '2023', 'Format', 'UFGS formatting.');
  `);
});

describe('authoritative lookups', () => {
  it('resolves a real reference and misses an absent one', async () => {
    const hit = await lookupReference(t.db, 'UMRL', 'ASTM', 'ASTM D16');
    expect(hit?.rid).toBe('rid-astm-d16');
    const miss = await lookupReference(t.db, 'UMRL', 'ASTM', 'ASTM D3960');
    expect(miss).toBeNull();
  });

  it('builds a reference map keyed by org|designation', async () => {
    const map = await loadReferenceMap(t.db, 'UMRL');
    expect(map.size).toBe(2);
    expect(map.get('MPI|MPI 43')?.edition_date).toBe('2021');
  });

  it('reads criteria + pinned editions from data (G7)', async () => {
    expect((await getCriteria(t.db, 'cid-ufc-fmt'))?.edition).toBe('2023');
    const ed = await criteriaEditions(t.db, 'ufc');
    expect(ed['UFC 1-300-02']).toBe('2023');
  });
});

describe('traceability (G6) — append is idempotent under Workflow retries', () => {
  const rows: TraceRow[] = [
    { element: 'voc-limit', decision: '50 g/L', sourceType: 'UFC', sourceRef: 'cid-ufc-fmt', confidence: 0.9, basis: 'ufc-criteria', justification: 'VOC limit from UFC clause.' },
    { element: 'sheen', decision: 'eggshell', sourceType: 'REF-LIST', sourceRef: 'rid-mpi-43', confidence: 0.8, basis: 'project-data', justification: 'Finish schedule says eggshell.' },
  ];

  it('round-trips rows and does NOT duplicate on a re-append', async () => {
    await appendTraces(t.db, 'p1', '09 90 00', rows);
    expect(await countTraces(t.db, 'p1', '09 90 00')).toBe(2);

    // Re-append the identical batch (simulating an at-least-once step retry).
    await appendTraces(t.db, 'p1', '09 90 00', rows);
    expect(await countTraces(t.db, 'p1', '09 90 00')).toBe(2);

    const got = await getTraces(t.db, 'p1', '09 90 00');
    expect(got.map((r) => r.element)).toEqual(['voc-limit', 'sheen']);
    expect(got[0].basis).toBe('ufc-criteria');
  });

  it('clearTraces removes only the given project+section', async () => {
    await appendTraces(t.db, 'p1', '09 90 00', rows);
    await appendTraces(t.db, 'p1', '09 91 00', rows);
    await clearTraces(t.db, 'p1', '09 90 00');
    expect(await countTraces(t.db, 'p1', '09 90 00')).toBe(0);
    expect(await countTraces(t.db, 'p1', '09 91 00')).toBe(2);
  });
});

describe('review evidence (G6) — append is idempotent', () => {
  it('does not duplicate an identical gate decision', async () => {
    const ev: ReviewEvidenceRow[] = [
      { gate: 'gate3', element: 'reference-not-found:ASTM D3960', action: 'clear-flag', userId: 'u1', at: '2026-01-01T00:00:00Z' },
    ];
    await appendEvidence(t.db, 'p1', '09 90 00', ev);
    await appendEvidence(t.db, 'p1', '09 90 00', ev);
    expect((await getEvidence(t.db, 'p1', '09 90 00')).length).toBe(1);
  });
});
