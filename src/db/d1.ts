// D1 access layer — the "validate, don't generate" backbone. One validation
// path keyed by ctx.referenceListId. The LLM never produces authoritative
// values — it orchestrates and matches; D1 answers. Also holds the
// traceability/evidence writers (G6), criteria lookups (G7), and the
// approved-for-seal record (G8).
//
// NOTE vs. the prior POC: there is no `replaceRegister` / `submittal_register`
// writer (that table was write-only and is dropped — blueprint §2.2). The live
// submittal register is the in-memory run result, persisted into `traceability`.

import type {
  BuildManifest,
  ReviewEvidenceRow,
  TraceRow,
} from '../shared/types';

export interface RefRow {
  rid: string;
  list_id: string;
  org: string;
  designation: string;
  edition_date: string;
  title: string;
  active: number;
}
export interface SubRow {
  usid: string;
  list_id: string;
  section: string;
  sd_code: string | null;
  item: string;
  default_class: string | null;
  notes: string | null;
}
export interface ProductRow {
  pid: string;
  manufacturer: string;
  product_name: string;
  category: string;
  cut_sheet_r2: string | null;
  attributes: string | null;
}
export interface CriteriaRow {
  cid: string;
  profile: string;
  document: string;
  edition: string;
  clause: string;
  text: string;
  perf_level: string | null;
}
export interface LockedDocRow {
  ldid: string;
  profile: string;
  title: string;
  r2_key: string | null;
  alterable: number;
}

// ---- Authoritative lookups (exact — never fuzzy for final validation) ----

export async function lookupReference(
  db: D1Database,
  listId: string,
  org: string,
  designation: string,
): Promise<RefRow | null> {
  return db
    .prepare(
      `SELECT * FROM ref_list WHERE list_id = ?1 AND org = ?2 AND designation = ?3 AND active = 1 LIMIT 1`,
    )
    .bind(listId.trim(), org.trim(), designation.trim())
    .first<RefRow>();
}

export async function lookupSubmittal(
  db: D1Database,
  listId: string,
  section: string,
  item: string,
): Promise<SubRow | null> {
  return db
    .prepare(`SELECT * FROM sub_list WHERE list_id = ?1 AND section = ?2 AND item = ?3 LIMIT 1`)
    .bind(listId.trim(), section.trim(), item.trim())
    .first<SubRow>();
}

// G7: criteria (incl. editions) come ONLY from here, never from model memory.
export async function getCriteria(db: D1Database, cid: string): Promise<CriteriaRow | null> {
  return db.prepare(`SELECT * FROM criteria WHERE cid = ?1`).bind(cid.trim()).first<CriteriaRow>();
}
export async function getLockedDoc(db: D1Database, ldid: string): Promise<LockedDocRow | null> {
  return db.prepare(`SELECT * FROM locked_docs WHERE ldid = ?1`).bind(ldid.trim()).first<LockedDocRow>();
}
// The agency front-end documents for a profile — seeds the manual's Division 00
// include set. Unalterable (alterable = 0), enforced by G2.
export async function listLockedDocs(db: D1Database, profile: string): Promise<LockedDocRow[]> {
  const res = await db
    .prepare(`SELECT * FROM locked_docs WHERE profile = ?1 ORDER BY ldid`)
    .bind(profile.trim())
    .all<LockedDocRow>();
  return res.results ?? [];
}

// ---- Batched authoritative lookups (validator hot path) --------------------
// One query per controlled list PER RUN instead of one per item (kills the N+1).
// A miss simply has no Map entry -> the caller still produces a flag (never an
// invented value).

export async function loadReferenceMap(db: D1Database, listId: string): Promise<Map<string, RefRow>> {
  const res = await db
    .prepare(`SELECT * FROM ref_list WHERE list_id = ?1 AND active = 1`)
    .bind(listId.trim())
    .all<RefRow>();
  const map = new Map<string, RefRow>();
  for (const r of res.results ?? []) {
    const k = `${r.org}|${r.designation}`;
    if (!map.has(k)) map.set(k, r); // keep-first == LIMIT 1
  }
  return map;
}

export async function loadSubmittalMap(db: D1Database, listId: string, section: string): Promise<Map<string, SubRow>> {
  const res = await db
    .prepare(`SELECT * FROM sub_list WHERE list_id = ?1 AND section = ?2`)
    .bind(listId.trim(), section.trim())
    .all<SubRow>();
  const map = new Map<string, SubRow>();
  for (const r of res.results ?? []) if (!map.has(r.item)) map.set(r.item, r);
  return map;
}

export async function loadCriteriaMap(db: D1Database, cids: string[]): Promise<Map<string, CriteriaRow>> {
  const uniq = [...new Set(cids.map((c) => c.trim()).filter(Boolean))];
  const map = new Map<string, CriteriaRow>();
  if (uniq.length === 0) return map;
  const ph = uniq.map((_, i) => `?${i + 1}`).join(',');
  const res = await db.prepare(`SELECT * FROM criteria WHERE cid IN (${ph})`).bind(...uniq).all<CriteriaRow>();
  for (const r of res.results ?? []) map.set(r.cid, r);
  return map;
}

export async function loadProductMap(db: D1Database, pids: string[]): Promise<Map<string, ProductRow>> {
  const uniq = [...new Set(pids.map((p) => p.trim()).filter(Boolean))];
  const map = new Map<string, ProductRow>();
  if (uniq.length === 0) return map;
  const ph = uniq.map((_, i) => `?${i + 1}`).join(',');
  const res = await db.prepare(`SELECT * FROM product_library WHERE pid IN (${ph})`).bind(...uniq).all<ProductRow>();
  for (const r of res.results ?? []) map.set(r.pid, r);
  return map;
}

// Pinned criteria editions for a profile (MANIFEST — G7).
export async function criteriaEditions(db: D1Database, profile: string): Promise<Record<string, string>> {
  const res = await db
    .prepare(`SELECT DISTINCT document, edition FROM criteria WHERE profile = ?1`)
    .bind(profile.trim())
    .all<{ document: string; edition: string }>();
  const out: Record<string, string> = {};
  for (const r of res.results ?? []) out[r.document] = r.edition;
  return out;
}

// ---- Traceability writers (G6) ----
// INSERT OR IGNORE + the ux_trace unique index make this idempotent: a Workflow
// step that commits this batch and then retries (at-least-once execution) will
// not duplicate rows.
export async function appendTraces(
  db: D1Database,
  projectId: string,
  section: string,
  rows: TraceRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((t) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO traceability (project_id, section, element, decision, source_type, source_ref, confidence, basis, confidence_tier, justification)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(projectId, section, t.element, t.decision, t.sourceType, t.sourceRef, t.confidence, t.basis ?? null, t.confidenceTier ?? null, t.justification ?? null),
  );
  await db.batch(stmts);
}

export async function clearTraces(db: D1Database, projectId: string, section: string): Promise<void> {
  await db.prepare(`DELETE FROM traceability WHERE project_id = ?1 AND section = ?2`).bind(projectId, section).run();
}

export async function getTraces(db: D1Database, projectId: string, section: string): Promise<TraceRow[]> {
  const res = await db
    .prepare(
      `SELECT element, decision, source_type as sourceType, source_ref as sourceRef, confidence,
              basis, confidence_tier as confidenceTier, justification
       FROM traceability WHERE project_id = ?1 AND section = ?2 ORDER BY id`,
    )
    .bind(projectId, section)
    .all<TraceRow>();
  return res.results ?? [];
}

export async function countTraces(db: D1Database, projectId: string, section: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) as n FROM traceability WHERE project_id = ?1 AND section = ?2`)
    .bind(projectId, section)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ---- Approved-for-seal — every gate writes evidence (G6 evidence) ----

export async function appendEvidence(
  db: D1Database,
  projectId: string,
  section: string,
  rows: ReviewEvidenceRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // INSERT OR IGNORE + ux_evidence: a re-submitted identical gate decision (or a
  // retried write) does not create duplicate evidence rows.
  const stmts = rows.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO review_evidence (project_id, section, gate, element, action, before_val, after_val, user_id, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(projectId, section, e.gate, e.element, e.action, e.beforeVal ?? null, e.afterVal ?? null, e.userId, e.at),
  );
  await db.batch(stmts);
}

export async function getEvidence(db: D1Database, projectId: string, section: string): Promise<ReviewEvidenceRow[]> {
  const res = await db
    .prepare(
      `SELECT gate, element, action, before_val as beforeVal, after_val as afterVal, user_id as userId, at
       FROM review_evidence WHERE project_id = ?1 AND section = ?2 ORDER BY id`,
    )
    .bind(projectId, section)
    .all<ReviewEvidenceRow>();
  return res.results ?? [];
}

export async function backfillEvidenceSpid(
  db: D1Database,
  projectId: string,
  section: string,
  spid: string,
): Promise<void> {
  await db
    .prepare(`UPDATE review_evidence SET spid = ?3 WHERE project_id = ?1 AND section = ?2 AND spid IS NULL`)
    .bind(projectId, section, spid)
    .run();
}

export async function writeSealPackage(
  db: D1Database,
  row: {
    spid: string;
    projectId: string;
    section: string;
    pdfKey: string | null;
    docxKey: string | null;
    zipKey: string | null;
    contentHash: string;
    frozenAt: string;
    attestedBy?: string | null;
    attestedAt?: string | null;
    licenseNo?: string | null;
    licenseExp?: string | null;
    status: string;
    scope?: 'section' | 'manual'; // a seal package can cover a whole book
    sectionsJson?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO seal_package (spid, project_id, section, scope, sections_json, pdf_r2_key, docx_r2_key, zip_r2_key, content_hash, frozen_at, attested_by, attested_at, license_no, license_exp, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
       ON CONFLICT(spid) DO UPDATE SET zip_r2_key=excluded.zip_r2_key, attested_by=excluded.attested_by, attested_at=excluded.attested_at, license_no=excluded.license_no, license_exp=excluded.license_exp, status=excluded.status`,
    )
    .bind(
      row.spid, row.projectId, row.scope === 'manual' ? null : row.section, row.scope ?? 'section', row.sectionsJson ?? null,
      row.pdfKey, row.docxKey, row.zipKey, row.contentHash,
      row.frozenAt, row.attestedBy ?? null, row.attestedAt ?? null, row.licenseNo ?? null, row.licenseExp ?? null, row.status,
    )
    .run();
}

export async function writeBuildManifest(db: D1Database, spid: string, m: BuildManifest): Promise<void> {
  await db
    .prepare(
      `INSERT INTO build_manifest (spid, corpus_version, model_config_json, prompt_version, criteria_editions_json, guardrail_results_json)
       VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(spid) DO UPDATE SET guardrail_results_json=excluded.guardrail_results_json`,
    )
    .bind(spid, m.corpusVersion, JSON.stringify(m.modelConfig), m.promptVersion, JSON.stringify(m.criteriaEditions), JSON.stringify(m.guardrailResults))
    .run();
}
