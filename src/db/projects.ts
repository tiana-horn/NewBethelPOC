// D1 access for the CHANGE-02 production workflow: projects (wizard lifecycle),
// raw intake uploads, the confirmed ExtractedProjectData, the master library,
// and comparisons. Kept separate from db/d1.ts (the validate-don't-generate
// backbone) so the two concerns stay legible.

import type {
  ComparisonScoreRow,
  ExtractedProjectData,
  MasterLibraryRow,
} from '../shared/types';

export interface ProjectRow {
  projectId: string;
  orgId: string | null;
  userEmail: string | null; // owner (null = anonymous/demo-org project) — used for authz
  name: string | null;
  agency: string | null;
  section: string | null;
  masterId: string | null;
  selectionsJson: string | null;
  status: string;
  deliveryKind?: string | null;
  manualStatus?: string | null;
}
export interface ProjectInputRow {
  id: number;
  projectId: string;
  kind: string;
  filename: string;
  r2Key: string;
  sha256: string;
  parseStatus: string;
}

// ---- users (Rev A) ----
export async function upsertUser(db: D1Database, email: string, name: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_user (email, name) VALUES (?1, ?2)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name`,
    )
    .bind(email, name)
    .run();
}

// Set who should receive the finished manual. Upserts the user and points the
// project at that address so getProjectOwner (and the completion email) resolve
// to it — no sign-in required.
export async function setProjectNotifyEmail(
  db: D1Database,
  projectId: string,
  email: string,
  name: string,
): Promise<void> {
  await upsertUser(db, email, name);
  await db.prepare(`UPDATE project SET user_email = ?2 WHERE project_id = ?1`).bind(projectId, email).run();
}

// The user who owns a project (for the "manual ready" email).
export async function getProjectOwner(
  db: D1Database,
  projectId: string,
): Promise<{ email: string; name: string } | null> {
  return db
    .prepare(
      `SELECT u.email as email, COALESCE(u.name, u.email) as name
       FROM project p JOIN app_user u ON u.email = p.user_email WHERE p.project_id = ?1`,
    )
    .bind(projectId)
    .first<{ email: string; name: string }>();
}

// ---- projects ----
// agency is set at CREATION (it decides the tailoring/parser path) and is
// immutable thereafter. `saveSelections` no longer touches it. (Mode is always
// UFGS — there is no mode/publicProfile column, blueprint §2.2/§5.)
export async function createProject(
  db: D1Database,
  row: {
    projectId: string;
    orgId: string;
    name?: string;
    userEmail?: string | null;
    agency?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project (project_id, org_id, user_email, name, agency, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'intake')`,
    )
    .bind(
      row.projectId,
      row.orgId,
      row.userEmail ?? null,
      row.name ?? null,
      row.agency ?? null,
    )
    .run();
}

export async function getProject(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db
    .prepare(
      `SELECT project_id as projectId, org_id as orgId, user_email as userEmail, name,
              agency, section, master_id as masterId,
              selections_json as selectionsJson, status, delivery_kind as deliveryKind,
              manual_status as manualStatus
       FROM project WHERE project_id = ?1`,
    )
    .bind(projectId)
    .first<ProjectRow>();
}

export async function listProjects(db: D1Database, orgId: string, userEmail?: string | null): Promise<ProjectRow[]> {
  // A signed-in user sees the manuals/sections saved to their profile; otherwise
  // fall back to the org's projects (demo/anonymous).
  const sql = `SELECT project_id as projectId, org_id as orgId, name,
              agency, section, master_id as masterId, selections_json as selectionsJson, status,
              delivery_kind as deliveryKind, manual_status as manualStatus
       FROM project WHERE ${userEmail ? 'user_email = ?1' : 'org_id = ?1'} ORDER BY created_at DESC`;
  const res = await db.prepare(sql).bind(userEmail ?? orgId).all<ProjectRow>();
  return res.results ?? [];
}

// Step-3 selections carry ONLY section/master/etc. agency is immutable after
// creation and is NOT updated here.
export async function saveSelections(
  db: D1Database,
  projectId: string,
  args: {
    name?: string;
    section: string;
    masterId?: string | null;
    selectionsJson: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE project SET name = COALESCE(?2, name), section = ?3,
              master_id = ?4, selections_json = ?5, status = 'ready'
       WHERE project_id = ?1`,
    )
    .bind(projectId, args.name ?? null, args.section, args.masterId ?? null, args.selectionsJson)
    .run();
}

export async function setProjectStatus(db: D1Database, projectId: string, status: string): Promise<void> {
  await db.prepare(`UPDATE project SET status = ?2 WHERE project_id = ?1`).bind(projectId, status).run();
}

// ---- raw inputs ----
export async function addProjectInput(
  db: D1Database,
  row: { projectId: string; kind: string; filename: string; r2Key: string; sha256: string; parseStatus?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_input (project_id, kind, filename, r2_key, sha256, parse_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(row.projectId, row.kind, row.filename, row.r2Key, row.sha256, row.parseStatus ?? 'pending')
    .run();
}

export async function listProjectInputs(db: D1Database, projectId: string): Promise<ProjectInputRow[]> {
  const res = await db
    .prepare(
      `SELECT id, project_id as projectId, kind, filename, r2_key as r2Key, sha256, parse_status as parseStatus
       FROM project_input WHERE project_id = ?1 ORDER BY id`,
    )
    .bind(projectId)
    .all<ProjectInputRow>();
  return res.results ?? [];
}

export async function setInputParseStatus(
  db: D1Database,
  projectId: string,
  filename: string,
  status: string,
): Promise<void> {
  await db
    .prepare(`UPDATE project_input SET parse_status = ?3 WHERE project_id = ?1 AND filename = ?2`)
    .bind(projectId, filename, status)
    .run();
}

// ---- extracted (Gate 0) ----
export async function saveExtracted(
  db: D1Database,
  projectId: string,
  data: ExtractedProjectData,
  confirmed: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO extracted_project_data (project_id, data_json, confirmed) VALUES (?1, ?2, ?3)
       ON CONFLICT(project_id) DO UPDATE SET data_json = excluded.data_json, confirmed = excluded.confirmed`,
    )
    .bind(projectId, JSON.stringify(data), confirmed ? 1 : 0)
    .run();
}

export async function getExtracted(
  db: D1Database,
  projectId: string,
): Promise<{ data: ExtractedProjectData; confirmed: boolean } | null> {
  const row = await db
    .prepare(`SELECT data_json as dataJson, confirmed FROM extracted_project_data WHERE project_id = ?1`)
    .bind(projectId)
    .first<{ dataJson: string; confirmed: number }>();
  if (!row) return null;
  return { data: JSON.parse(row.dataJson) as ExtractedProjectData, confirmed: row.confirmed === 1 };
}

// ---- master library ----
export async function listMasters(
  db: D1Database,
  filter: { mode?: string; owner?: string } = {},
): Promise<MasterLibraryRow[]> {
  // Built-in ('system') masters are always visible; org masters only to that org.
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (filter.owner) {
    clauses.push(`(owner = 'system' OR owner = ?${binds.length + 1})`);
    binds.push(filter.owner);
  }
  if (filter.mode) {
    clauses.push(`mode = ?${binds.length + 1}`);
    binds.push(filter.mode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = await db
    .prepare(
      `SELECT master_id as masterId, owner, name, mode, namespace, status
       FROM master_library ${where} ORDER BY owner, name`,
    )
    .bind(...binds)
    .all<MasterLibraryRow>();
  return res.results ?? [];
}

export async function getMaster(db: D1Database, masterId: string): Promise<MasterLibraryRow | null> {
  return db
    .prepare(
      `SELECT master_id as masterId, owner, name, mode, namespace, status FROM master_library WHERE master_id = ?1`,
    )
    .bind(masterId)
    .first<MasterLibraryRow>();
}

export async function insertMaster(
  db: D1Database,
  row: { masterId: string; owner: string; name: string; mode?: string; namespace: string; r2Prefix: string; status: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO master_library (master_id, owner, name, mode, namespace, r2_prefix, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(row.masterId, row.owner, row.name, row.mode ?? null, row.namespace, row.r2Prefix, row.status)
    .run();
}

export async function setMasterStatus(db: D1Database, masterId: string, status: string): Promise<void> {
  await db.prepare(`UPDATE master_library SET status = ?2 WHERE master_id = ?1`).bind(masterId, status).run();
}

// ---- comparison (post-approval) ----
export async function insertComparison(
  db: D1Database,
  row: { cmpId: string; projectId: string; referenceR2Key: string; referenceSha256: string; corpusProvenance: string; status: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO comparison (cmp_id, project_id, reference_r2_key, reference_sha256, corpus_provenance, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(row.cmpId, row.projectId, row.referenceR2Key, row.referenceSha256, row.corpusProvenance, row.status)
    .run();
}

export async function setComparisonStatus(db: D1Database, cmpId: string, status: string): Promise<void> {
  await db.prepare(`UPDATE comparison SET status = ?2 WHERE cmp_id = ?1`).bind(cmpId, status).run();
}

export async function insertComparisonScores(
  db: D1Database,
  cmpId: string,
  scores: (ComparisonScoreRow & { section?: string | null })[],
): Promise<void> {
  if (scores.length === 0) return;
  // CHANGE-03: `section` discriminates per-section rows from manual-scope rollup
  // rows (section NULL). Single-section compare passes no section (defaults NULL).
  const stmts = scores.map((s) =>
    db
      .prepare(
        `INSERT INTO comparison_score (cmp_id, section, dimension, ai_value, ref_value, verdict, divergence_class, traceability_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(cmpId, s.section ?? null, s.dimension, s.aiValue, s.refValue, s.verdict, s.divergenceClass, s.traceabilityRef),
  );
  await db.batch(stmts);
}

export async function getLatestComparison(
  db: D1Database,
  projectId: string,
): Promise<{ cmpId: string; corpusProvenance: string; status: string; scores: ComparisonScoreRow[] } | null> {
  const cmp = await db
    .prepare(
      `SELECT cmp_id as cmpId, corpus_provenance as corpusProvenance, status
       FROM comparison WHERE project_id = ?1 ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(projectId)
    .first<{ cmpId: string; corpusProvenance: string; status: string }>();
  if (!cmp) return null;
  const res = await db
    .prepare(
      `SELECT dimension, ai_value as aiValue, ref_value as refValue, verdict,
              divergence_class as divergenceClass, traceability_ref as traceabilityRef
       FROM comparison_score WHERE cmp_id = ?1 ORDER BY id`,
    )
    .bind(cmp.cmpId)
    .all<ComparisonScoreRow>();
  return { ...cmp, scores: res.results ?? [] };
}
