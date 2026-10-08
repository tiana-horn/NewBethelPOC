// D1 access for the CHANGE-03 Project Manual: the outline (manual_section), the
// cross-section coordination flags (manual_coordination_flag), the assembled book
// (manual_assembly), and the whole-manual comparison segments (comparison_section).
// Kept separate from db/projects.ts and db/d1.ts so the manual concern is legible.
// NOTHING here reads the quarantined comparison prefix into a generation path.

import type {
  ComparisonSectionRow,
  DeliveryKind,
  ManualCoordinationFlag,
  ManualCoverMeta,
  ManualSectionRef,
  ManualSectionStatus,
  ManualStatus,
  ReviewEvidenceRow,
  TocRow,
} from '../shared/types';

// ---- CHANGE-09 Stage 5 — manual-level DoD cover/title-page metadata ----
export async function getCoverMeta(db: D1Database, projectId: string): Promise<ManualCoverMeta | null> {
  const r = await db
    .prepare(
      `SELECT project_title as projectTitle, installation_location as installationLocation,
              solicitation_no as solicitationNo, preparing_firm as preparingFirm,
              design_district as designDistrict, dod_component as dodComponent,
              issue_date as issueDate, updated_at as updatedAt, updated_by as updatedBy
       FROM manual_cover_meta WHERE project_id = ?1`,
    )
    .bind(projectId)
    .first<ManualCoverMeta>();
  return r ?? null;
}

export async function upsertCoverMeta(db: D1Database, projectId: string, meta: ManualCoverMeta, updatedBy: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO manual_cover_meta
         (project_id, project_title, installation_location, solicitation_no, preparing_firm, design_district, dod_component, issue_date, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(project_id) DO UPDATE SET
         project_title = excluded.project_title, installation_location = excluded.installation_location,
         solicitation_no = excluded.solicitation_no, preparing_firm = excluded.preparing_firm,
         design_district = excluded.design_district, dod_component = excluded.dod_component,
         issue_date = excluded.issue_date, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(
      projectId,
      meta.projectTitle?.trim() || null,
      meta.installationLocation?.trim() || null,
      meta.solicitationNo?.trim() || null,
      meta.preparingFirm?.trim() || null,
      meta.designDistrict?.trim() || null,
      meta.dodComponent?.trim() || null,
      meta.issueDate?.trim() || null,
      new Date().toISOString(),
      updatedBy,
    )
    .run();
}

// Manual-scope review evidence: gate decisions (M0 / M-COORD / gate5) written
// with section '' so they collate under the project at book freeze.
export async function appendManualEvidence(db: D1Database, projectId: string, rows: ReviewEvidenceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO review_evidence (project_id, section, gate, element, action, before_val, after_val, user_id, at)
         VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(projectId, e.gate, e.element, e.action, e.beforeVal ?? null, e.afterVal ?? null, e.userId, e.at),
  );
  await db.batch(stmts);
}

export async function getManualEvidence(db: D1Database, projectId: string): Promise<ReviewEvidenceRow[]> {
  const res = await db
    .prepare(
      `SELECT gate, element, action, before_val as beforeVal, after_val as afterVal, user_id as userId, at
       FROM review_evidence WHERE project_id = ?1 ORDER BY id`,
    )
    .bind(projectId)
    .all<ReviewEvidenceRow>();
  return res.results ?? [];
}

// ---- delivery kind + manual status on the project row ----
export async function setDeliveryKind(
  db: D1Database,
  projectId: string,
  kind: DeliveryKind,
  manualStatus: ManualStatus | null,
): Promise<void> {
  await db
    .prepare(`UPDATE project SET delivery_kind = ?2, manual_status = ?3 WHERE project_id = ?1`)
    .bind(projectId, kind, manualStatus)
    .run();
}

export async function setManualStatus(db: D1Database, projectId: string, status: ManualStatus): Promise<void> {
  await db.prepare(`UPDATE project SET manual_status = ?2 WHERE project_id = ?1`).bind(projectId, status).run();
}

// ---- outline (manual_section) ----
export interface ManualSectionRow extends ManualSectionRef {
  id: string;
  status: ManualSectionStatus;
}

// Replace the whole outline in one batch (Gate M0 confirm re-writes it).
export async function replaceOutline(
  db: D1Database,
  projectId: string,
  sections: ManualSectionRef[],
  defaultMasterId: string | null,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM manual_section WHERE project_id = ?1`).bind(projectId),
  ];
  for (const s of sections) {
    const id = `ms-${projectId}-${s.section.replace(/\s/g, '')}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO manual_section (id, project_id, section, title, division, order_index, role, drafting_mode, master_id, locked_doc_id, status)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending')`,
        )
        .bind(
          id, projectId, s.section, s.title, s.division, s.orderIndex, s.role, s.draftingMode,
          s.masterId ?? defaultMasterId, s.lockedDocId ?? null,
        ),
    );
  }
  await db.batch(stmts);
}

export async function getOutline(db: D1Database, projectId: string): Promise<ManualSectionRow[]> {
  const res = await db
    .prepare(
      `SELECT id, section, title, division, order_index as orderIndex, role, drafting_mode as draftingMode,
              master_id as masterId, locked_doc_id as lockedDocId, run_id as runId, status
       FROM manual_section WHERE project_id = ?1 ORDER BY order_index`,
    )
    .bind(projectId)
    .all<ManualSectionRow>();
  return res.results ?? [];
}

export async function setSectionStatus(
  db: D1Database,
  projectId: string,
  section: string,
  status: ManualSectionStatus,
  runId?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE manual_section SET status = ?3, run_id = COALESCE(?4, run_id) WHERE project_id = ?1 AND section = ?2`,
    )
    .bind(projectId, section, status, runId ?? null)
    .run();
}

// ---- cross-section coordination flags ----
export async function replaceCoordinationFlags(
  db: D1Database,
  projectId: string,
  flags: ManualCoordinationFlag[],
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM manual_coordination_flag WHERE project_id = ?1`).bind(projectId),
  ];
  for (const f of flags) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO manual_coordination_flag (project_id, kind, detail, sections, severity, status)
           VALUES (?1,?2,?3,?4,?5,?6)`,
        )
        .bind(projectId, f.kind, f.detail, JSON.stringify(f.sections), f.severity, f.status),
    );
  }
  await db.batch(stmts);
}

export async function getCoordinationFlags(db: D1Database, projectId: string): Promise<ManualCoordinationFlag[]> {
  const res = await db
    .prepare(
      `SELECT id, kind, detail, sections, severity, status FROM manual_coordination_flag WHERE project_id = ?1 ORDER BY id`,
    )
    .bind(projectId)
    .all<{ id: number; kind: string; detail: string; sections: string; severity: string; status: string }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    kind: r.kind as ManualCoordinationFlag['kind'],
    detail: r.detail,
    sections: safeParseArray(r.sections),
    severity: r.severity as ManualCoordinationFlag['severity'],
    status: r.status as 'open' | 'resolved',
  }));
}

export async function resolveAllCoordinationFlags(db: D1Database, projectId: string): Promise<void> {
  await db
    .prepare(`UPDATE manual_coordination_flag SET status = 'resolved' WHERE project_id = ?1`)
    .bind(projectId)
    .run();
}

// ---- assembled book ----
export async function writeAssembly(
  db: D1Database,
  row: { projectId: string; toc: TocRow[]; docxKey: string | null; pdfKey: string | null; contentHash: string | null; assembledAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO manual_assembly (project_id, toc_json, docx_r2_key, pdf_r2_key, content_hash, assembled_at)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(project_id) DO UPDATE SET toc_json=excluded.toc_json, docx_r2_key=excluded.docx_r2_key,
         pdf_r2_key=excluded.pdf_r2_key, content_hash=excluded.content_hash, assembled_at=excluded.assembled_at`,
    )
    .bind(row.projectId, JSON.stringify(row.toc), row.docxKey, row.pdfKey, row.contentHash, row.assembledAt)
    .run();
}

export async function getAssembly(
  db: D1Database,
  projectId: string,
): Promise<{ toc: TocRow[]; docxKey: string | null; pdfKey: string | null; contentHash: string | null; assembledAt: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT toc_json as tocJson, docx_r2_key as docxKey, pdf_r2_key as pdfKey, content_hash as contentHash, assembled_at as assembledAt
       FROM manual_assembly WHERE project_id = ?1`,
    )
    .bind(projectId)
    .first<{ tocJson: string; docxKey: string | null; pdfKey: string | null; contentHash: string | null; assembledAt: string | null }>();
  if (!row) return null;
  return { toc: safeParseToc(row.tocJson), docxKey: row.docxKey, pdfKey: row.pdfKey, contentHash: row.contentHash, assembledAt: row.assembledAt };
}

// ---- whole-manual comparison segments (QUARANTINED) ----
export async function insertComparisonSections(
  db: D1Database,
  cmpId: string,
  rows: ComparisonSectionRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO comparison_section (id, cmp_id, ref_section, ref_segment_r2_key, matched_project_section, alignment, alignment_confidence, title)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET matched_project_section=excluded.matched_project_section, alignment=excluded.alignment, alignment_confidence=excluded.alignment_confidence`,
      )
      .bind(r.id, cmpId, r.refSection, r.refSegmentR2Key, r.matchedProjectSection, r.alignment, r.alignmentConfidence, r.title ?? null),
  );
  await db.batch(stmts);
}

export async function getComparisonSections(db: D1Database, cmpId: string): Promise<ComparisonSectionRow[]> {
  const res = await db
    .prepare(
      `SELECT id, ref_section as refSection, ref_segment_r2_key as refSegmentR2Key,
              matched_project_section as matchedProjectSection, alignment, alignment_confidence as alignmentConfidence, title
       FROM comparison_section WHERE cmp_id = ?1 ORDER BY ref_section`,
    )
    .bind(cmpId)
    .all<ComparisonSectionRow>();
  return res.results ?? [];
}

export async function nudgeAlignment(
  db: D1Database,
  id: string,
  matchedProjectSection: string | null,
  alignment: ComparisonSectionRow['alignment'],
): Promise<void> {
  await db
    .prepare(`UPDATE comparison_section SET matched_project_section = ?2, alignment = ?3, alignment_confidence = 1 WHERE id = ?1`)
    .bind(id, matchedProjectSection, alignment)
    .run();
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function safeParseToc(s: string): TocRow[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
