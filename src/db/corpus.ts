// CHANGE-05 §1 — D1 access for the Mode A corpus. The OmniClass→MasterFormat
// crosswalk (CHANGE-04 §3.3, G10) is REVERTED and its helpers removed. What
// remains: the UFGS corpus-presence table (§5.3, also the SEC catalog §4.4) and
// the corpus provenance/staleness ledger (§9.1, G11/G12). Kept separate from
// db/d1.ts (validate-don't-generate backbone) and db/projects.ts (wizard state).

// §5.3 — the queryable answer to "is this section draftable?". Returns the set of
// MasterFormat sections that have real, ingested UFGS corpus text.
export async function getCorpusSections(db: D1Database): Promise<Set<string>> {
  const res = await db.prepare(`SELECT section FROM ufgs_corpus_section`).all<{ section: string }>();
  return new Set((res.results ?? []).map((r) => r.section));
}

// CHANGE-09 Stage 3 — the mandatory Division 01 checklist (db/seed-div01.sql).
// Force-included in every outline regardless of intake features (§3).
export interface MandatoryDiv01Row {
  section: string;
  title: string;
}
export async function getMandatoryDiv01Sections(db: D1Database): Promise<MandatoryDiv01Row[]> {
  const res = await db
    .prepare(`SELECT section, title FROM mandatory_div01_section ORDER BY sort_order, section`)
    .all<MandatoryDiv01Row>();
  return res.results ?? [];
}

export async function upsertUfgsCorpusSection(
  db: D1Database,
  row: { section: string; title?: string; r2Key: string; vectorizeNs?: string; sourceEdition: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO ufgs_corpus_section (section, title, r2_key, vectorize_ns, source_edition, ingested_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    )
    .bind(row.section, row.title ?? null, row.r2Key, row.vectorizeNs ?? 'ufgs', row.sourceEdition)
    .run();
}

// CHANGE-06 §3 (C4) — mark a section as embedded into the `ufgs` Vectorize
// namespace (resumable ingest). Best-effort: an older DB that predates the
// `embedded` column must not fail the ingest, so a missing-column error is
// swallowed (the embedding still happened; only the resumability flag is lost).
export async function markSectionEmbedded(db: D1Database, section: string): Promise<void> {
  try {
    await db.prepare(`UPDATE ufgs_corpus_section SET embedded = 1 WHERE section = ?1`).bind(section).run();
  } catch {
    /* column may not exist on a pre-CHANGE-06 DB — non-fatal */
  }
}

// §9.1 — provenance ledger. Every ingest records one row here; G12's test fails
// if a Mode A corpus row has no matching entry.
export interface CorpusSourceRow {
  sourceId: string;
  kind: string;
  identifier: string;
  edition: string;
  ingestedAt: string;
  checkedAt: string | null;
  latestKnownEdition: string | null;
  stale: number;
  r2Key: string | null;
  criterionId: string | null; // UFC criterion UUID (C6.2), null for other kinds
}

const slug = (s: string) => s.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

export async function insertCorpusSource(
  db: D1Database,
  row: { sourceId?: string; kind: string; identifier: string; edition: string; r2Key?: string | null; criterionId?: string | null },
): Promise<string> {
  // A source is identified by (kind, identifier) — so its source_id is DETERMINISTIC
  // (was a random UUID, which duplicated the ledger on every re-ingest). Also delete
  // any prior row for the same source under a different source_id, so re-ingest
  // self-heals earlier random-id duplicates instead of stacking them (G12 integrity).
  const sourceId = row.sourceId ?? `cs-${slug(row.kind)}-${slug(row.identifier)}`;
  await db
    .prepare(`DELETE FROM corpus_source WHERE kind = ?1 AND identifier = ?2 AND source_id != ?3`)
    .bind(row.kind, row.identifier, sourceId)
    .run();
  await db
    .prepare(
      `INSERT OR REPLACE INTO corpus_source (source_id, kind, identifier, edition, ingested_at, r2_key, stale, criterion_id)
       VALUES (?1, ?2, ?3, ?4, datetime('now'), ?5, 0, ?6)`,
    )
    .bind(sourceId, row.kind, row.identifier, row.edition, row.r2Key ?? null, row.criterionId ?? null)
    .run();
  return sourceId;
}

// CHANGE-06 §2.1 (C6.1) — the manifest's `corpusVersion` is DATA, not a literal.
// Read the real UFGS-Master edition(s) from the provenance ledger
// (kind='UFGS-MASTER'; one row per ingested section, edition = that section's
// header edition). Honest reporting (G-MAN):
//   * no rows                -> 'unverified' (never a fabricated version string)
//   * one distinct edition   -> that edition (e.g. 'February 2021')
//   * multiple distinct      -> a 'mixed' summary, so the manifest never implies a
//                               single edition the ingested sections don't share.
export async function getCorpusVersion(db: D1Database): Promise<string> {
  const res = await db
    .prepare(
      `SELECT edition, COUNT(*) AS n FROM corpus_source
       WHERE kind = 'UFGS-MASTER' AND edition IS NOT NULL AND TRIM(edition) <> ''
       GROUP BY edition ORDER BY n DESC, edition ASC`,
    )
    .all<{ edition: string; n: number }>();
  const rows = res.results ?? [];
  if (rows.length === 0) return 'unverified';
  if (rows.length === 1) return rows[0].edition.trim();
  const top = rows.slice(0, 3).map((r) => r.edition.trim()).join(', ');
  return `mixed (${rows.length} editions): ${top}${rows.length > 3 ? ', …' : ''}`;
}

export async function listStaleCorpusSources(db: D1Database): Promise<CorpusSourceRow[]> {
  const res = await db
    .prepare(
      `SELECT source_id as sourceId, kind, identifier, edition, ingested_at as ingestedAt,
              checked_at as checkedAt, latest_known_edition as latestKnownEdition, stale, r2_key as r2Key, criterion_id as criterionId
       FROM corpus_source WHERE stale = 1 ORDER BY kind, identifier`,
    )
    .all<CorpusSourceRow>();
  return res.results ?? [];
}

export async function listCorpusSources(db: D1Database): Promise<CorpusSourceRow[]> {
  const res = await db
    .prepare(
      `SELECT source_id as sourceId, kind, identifier, edition, ingested_at as ingestedAt,
              checked_at as checkedAt, latest_known_edition as latestKnownEdition, stale, r2_key as r2Key, criterion_id as criterionId
       FROM corpus_source ORDER BY kind, identifier`,
    )
    .all<CorpusSourceRow>();
  return res.results ?? [];
}

// §9.2 — mark a source (and every list row it fed, matched by edition) stale when
// a check finds a newer edition. NEVER auto-replaces the edition (G11): staleness
// is a flag for human re-verification, not a block and not a silent update.
export async function markStale(
  db: D1Database,
  sourceId: string,
  latestKnownEdition: string,
): Promise<void> {
  const src = await db
    .prepare(`SELECT kind, identifier, edition FROM corpus_source WHERE source_id = ?1`)
    .bind(sourceId)
    .first<{ kind: string; identifier: string; edition: string }>();
  if (!src) return;
  await db
    .prepare(
      `UPDATE corpus_source SET stale = 1, latest_known_edition = ?2, checked_at = datetime('now')
       WHERE source_id = ?1`,
    )
    .bind(sourceId, latestKnownEdition)
    .run();
  // Fan the flag out to the controlled-list rows fed by this edition.
  if (src.kind === 'UMRL')
    await db.prepare(`UPDATE ref_list SET stale = 1 WHERE list_id = 'UMRL' AND source_edition = ?1`).bind(src.edition).run();
  if (src.kind === 'UMSL')
    await db.prepare(`UPDATE sub_list SET stale = 1 WHERE list_id = 'UMSL' AND source_edition = ?1`).bind(src.edition).run();
  if (src.kind === 'UFC')
    await db.prepare(`UPDATE criteria SET stale = 1 WHERE profile = 'ufc' AND edition = ?1`).bind(src.edition).run();
}

// §9.3 — a human confirms the new edition is correct: adopt it and clear stale on
// the source and its fed rows. The ONLY path that clears a stale flag (G11).
export async function reverifyCorpusSource(db: D1Database, sourceId: string): Promise<{ ok: boolean; adopted?: string }> {
  const src = await db
    .prepare(`SELECT kind, edition, latest_known_edition as latest FROM corpus_source WHERE source_id = ?1`)
    .bind(sourceId)
    .first<{ kind: string; edition: string; latest: string | null }>();
  if (!src) return { ok: false };
  const adopted = src.latest ?? src.edition;
  await db
    .prepare(
      `UPDATE corpus_source SET edition = ?2, stale = 0, checked_at = datetime('now'), latest_known_edition = NULL
       WHERE source_id = ?1`,
    )
    .bind(sourceId, adopted)
    .run();
  if (src.kind === 'UMRL')
    await db.prepare(`UPDATE ref_list SET stale = 0, source_edition = ?2, verified_at = datetime('now') WHERE list_id = 'UMRL' AND source_edition = ?1`).bind(src.edition, adopted).run();
  if (src.kind === 'UMSL')
    await db.prepare(`UPDATE sub_list SET stale = 0, source_edition = ?2, verified_at = datetime('now') WHERE list_id = 'UMSL' AND source_edition = ?1`).bind(src.edition, adopted).run();
  if (src.kind === 'UFC')
    await db.prepare(`UPDATE criteria SET stale = 0, edition = ?2, verified_at = datetime('now') WHERE profile = 'ufc' AND edition = ?1`).bind(src.edition, adopted).run();
  return { ok: true, adopted };
}
