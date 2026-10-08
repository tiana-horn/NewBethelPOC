// D1 access for CHANGE-08 people/roles/assignments (multi-user Project Manual).
// Everything here is a MANY-TO-MANY join over the existing app_user + project +
// manual_role tables (see db/schema.sql), so multi-role / multi-holder /
// multi-assignee cases never need a migration. Kept separate from db/projects.ts
// (wizard lifecycle) and db/manual.ts (outline/coordination) so the concern is
// legible. No raw SQL leaks into route handlers — the endpoints call these.

import { upsertUser } from './projects';
import type { ProjectRow } from './projects';

export interface RoleRow {
  roleId: string;
  label: string;
  isSealingRole: boolean;
  tier: number;
  defaultDivisionScope: string[] | null;
  sortOrder: number | null;
}

export interface AssignmentRow {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  roleId: string;
  roleLabel: string;
  isSealingRole: boolean;
  tier: number;
  divisionScope: string[] | null; // the assignment's own scope, or the role default
  assignedAt: string | null;
  assignedBy: string | null;
}

export interface AppUserRow {
  email: string;
  name: string;
}

function parseScope(s: string | null): string[] | null {
  if (s == null) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

// ---- roles ----
export async function listRoles(db: D1Database): Promise<RoleRow[]> {
  const res = await db
    .prepare(
      `SELECT role_id as roleId, label, is_sealing_role as isSealingRole, tier,
              default_division_scope as defaultDivisionScope, sort_order as sortOrder
       FROM manual_role ORDER BY sort_order, role_id`,
    )
    .all<{ roleId: string; label: string; isSealingRole: number; tier: number; defaultDivisionScope: string | null; sortOrder: number | null }>();
  return (res.results ?? []).map((r) => ({
    roleId: r.roleId,
    label: r.label,
    isSealingRole: r.isSealingRole === 1,
    tier: r.tier,
    defaultDivisionScope: parseScope(r.defaultDivisionScope),
    sortOrder: r.sortOrder,
  }));
}

export async function getRole(db: D1Database, roleId: string): Promise<RoleRow | null> {
  const r = await db
    .prepare(
      `SELECT role_id as roleId, label, is_sealing_role as isSealingRole, tier,
              default_division_scope as defaultDivisionScope, sort_order as sortOrder
       FROM manual_role WHERE role_id = ?1`,
    )
    .bind(roleId)
    .first<{ roleId: string; label: string; isSealingRole: number; tier: number; defaultDivisionScope: string | null; sortOrder: number | null }>();
  if (!r) return null;
  return { roleId: r.roleId, label: r.label, isSealingRole: r.isSealingRole === 1, tier: r.tier, defaultDivisionScope: parseScope(r.defaultDivisionScope), sortOrder: r.sortOrder };
}

// ---- app_user directory (for the assign picker) ----
export async function listUsers(db: D1Database): Promise<AppUserRow[]> {
  const res = await db
    .prepare(`SELECT email, COALESCE(name, email) as name FROM app_user ORDER BY name`)
    .all<AppUserRow>();
  return res.results ?? [];
}

// ---- manual_assignment (project × person × role, many-to-many) ----
// Upsert: assigning the SAME person the SAME role again is idempotent (the
// unique (project,user,role) index catches it) and just updates the scope. A new
// assignment defaults its division_scope to the role's default when not given.
export async function upsertAssignment(
  db: D1Database,
  args: { projectId: string; userId: string; userEmailName?: string; roleId: string; divisionScope?: string[] | null; assignedBy?: string | null },
): Promise<{ id: string }> {
  // The assignee must exist in app_user (they may not have signed in yet).
  await upsertUser(db, args.userId, args.userEmailName || args.userId.split('@')[0]);
  const role = await getRole(db, args.roleId);
  if (!role) throw new Error(`unknown role_id '${args.roleId}'`);
  const scope = args.divisionScope !== undefined ? args.divisionScope : role.defaultDivisionScope;
  const id = `asg-${crypto.randomUUID().slice(0, 8)}`;
  const scopeJson = scope == null ? null : JSON.stringify(scope);
  await db
    .prepare(
      `INSERT INTO manual_assignment (id, project_id, user_id, role_id, division_scope, assigned_at, assigned_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(project_id, user_id, role_id) DO UPDATE SET division_scope = excluded.division_scope`,
    )
    .bind(id, args.projectId, args.userId, args.roleId, scopeJson, new Date().toISOString(), args.assignedBy ?? null)
    .run();
  return { id };
}

export async function setAssignmentScope(db: D1Database, id: string, divisionScope: string[] | null): Promise<void> {
  await db
    .prepare(`UPDATE manual_assignment SET division_scope = ?2 WHERE id = ?1`)
    .bind(id, divisionScope == null ? null : JSON.stringify(divisionScope))
    .run();
}

export async function removeAssignment(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM manual_assignment WHERE id = ?1`).bind(id).run();
}

// List all assignments on a project, joined to app_user (name) + manual_role
// (label / sealing flag / tier). Ordered sealing-first for the assignment UI.
export async function listAssignments(db: D1Database, projectId: string): Promise<AssignmentRow[]> {
  const res = await db
    .prepare(
      `SELECT a.id as id, a.project_id as projectId, a.user_id as userId,
              COALESCE(u.name, a.user_id) as userName, a.role_id as roleId,
              r.label as roleLabel, r.is_sealing_role as isSealingRole, r.tier as tier,
              a.division_scope as divisionScope, r.default_division_scope as roleDefaultScope,
              a.assigned_at as assignedAt, a.assigned_by as assignedBy
       FROM manual_assignment a
       LEFT JOIN app_user u ON u.email = a.user_id
       LEFT JOIN manual_role r ON r.role_id = a.role_id
       WHERE a.project_id = ?1
       ORDER BY r.is_sealing_role DESC, r.sort_order, u.name`,
    )
    .bind(projectId)
    .all<{ id: string; projectId: string; userId: string; userName: string; roleId: string; roleLabel: string | null; isSealingRole: number | null; tier: number | null; divisionScope: string | null; roleDefaultScope: string | null; assignedAt: string | null; assignedBy: string | null }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    projectId: r.projectId,
    userId: r.userId,
    userName: r.userName,
    roleId: r.roleId,
    roleLabel: r.roleLabel ?? r.roleId,
    isSealingRole: r.isSealingRole === 1,
    tier: r.tier ?? 2,
    // Fall back to the role default when the assignment carries no explicit scope.
    divisionScope: parseScope(r.divisionScope) ?? parseScope(r.roleDefaultScope),
    assignedAt: r.assignedAt,
    assignedBy: r.assignedBy,
  }));
}

// The distinct role labels a user holds on a project (for the Saved Manuals row).
export async function listUserRolesOnProject(db: D1Database, projectId: string, userId: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT r.label as label
       FROM manual_assignment a JOIN manual_role r ON r.role_id = a.role_id
       WHERE a.project_id = ?1 AND a.user_id = ?2
       ORDER BY r.is_sealing_role DESC, r.sort_order`,
    )
    .bind(projectId, userId)
    .all<{ label: string }>();
  return (res.results ?? []).map((r) => r.label);
}

// ---- Saved Manuals: projects a user CREATED or is ASSIGNED to ----
export async function listSavedManuals(db: D1Database, userEmail: string): Promise<ProjectRow[]> {
  const res = await db
    .prepare(
      `SELECT project_id as projectId, org_id as orgId, user_email as userEmail, name, mode,
              public_profile as publicProfile, agency, section, master_id as masterId,
              selections_json as selectionsJson, status, delivery_kind as deliveryKind,
              manual_status as manualStatus
       FROM project
       WHERE user_email = ?1
          OR project_id IN (SELECT DISTINCT project_id FROM manual_assignment WHERE user_id = ?1)
       ORDER BY created_at DESC`,
    )
    .bind(userEmail)
    .all<ProjectRow>();
  return res.results ?? [];
}

// Visibility (Stage 2): a user may see a manual if they created it OR hold ANY
// assignment on it (role assignment or section assignment). The creator check is
// done via project.user_email at the choke point; this covers the assigned case.
export async function isUserAssigned(db: D1Database, projectId: string, userId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 as hit FROM manual_assignment WHERE project_id = ?1 AND user_id = ?2
       UNION ALL
       SELECT 1 as hit FROM manual_section_assignee WHERE project_id = ?1 AND user_id = ?2
       LIMIT 1`,
    )
    .bind(projectId, userId)
    .first<{ hit: number }>();
  return !!r;
}

// ---- manual_section_assignee (section × person, many-to-many) ----
export async function assignSection(
  db: D1Database,
  args: { projectId: string; section: string; userId: string; userEmailName?: string },
): Promise<{ id: string }> {
  await upsertUser(db, args.userId, args.userEmailName || args.userId.split('@')[0]);
  const id = `sca-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO manual_section_assignee (id, project_id, section, user_id, assigned_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(project_id, section, user_id) DO NOTHING`,
    )
    .bind(id, args.projectId, args.section, args.userId, new Date().toISOString())
    .run();
  return { id };
}

export async function unassignSection(db: D1Database, args: { projectId: string; section: string; userId: string }): Promise<void> {
  await db
    .prepare(`DELETE FROM manual_section_assignee WHERE project_id = ?1 AND section = ?2 AND user_id = ?3`)
    .bind(args.projectId, args.section, args.userId)
    .run();
}

export interface SectionAssigneeRow {
  section: string;
  userId: string;
  userName: string;
}

// Every section assignee on a project, joined to app_user for display.
export async function listSectionAssignees(db: D1Database, projectId: string): Promise<SectionAssigneeRow[]> {
  const res = await db
    .prepare(
      `SELECT s.section as section, s.user_id as userId, COALESCE(u.name, s.user_id) as userName
       FROM manual_section_assignee s LEFT JOIN app_user u ON u.email = s.user_id
       WHERE s.project_id = ?1 ORDER BY s.section`,
    )
    .bind(projectId)
    .all<SectionAssigneeRow>();
  return res.results ?? [];
}

// The sections a specific user is assigned to on a project (drives "Assigned to
// me" and the Needs-Attention scoping in §4).
export async function listSectionsAssignedToUser(db: D1Database, projectId: string, userId: string): Promise<string[]> {
  const res = await db
    .prepare(`SELECT section FROM manual_section_assignee WHERE project_id = ?1 AND user_id = ?2 ORDER BY section`)
    .bind(projectId, userId)
    .all<{ section: string }>();
  return (res.results ?? []).map((r) => r.section);
}
