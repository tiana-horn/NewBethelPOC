// CHANGE-08 §2/§4/§5 — the multi-user HTTP surface for the Project Manual:
//   • GET  /manuals/saved                       — Saved Manuals (created or assigned)
//   • GET  /project/:id/manual/overview         — tiles/filter/pagination/needs-attn
//   • GET  /project/:id/manual/roles            — the controlled role list
//   • GET  /project/:id/manual/users            — app_user directory (assign picker)
//   • GET/POST /project/:id/manual/assignments  — list / assign / edit-scope / remove
//   • GET/POST /project/:id/manual/section-assignees — list / assign / unassign
// Mutations use POST (CORS allows GET,POST,OPTIONS only). Authorization for the
// project-scoped routes is done by the caller's choke point before dispatch here.

import type { Env } from '../env';
import type { User } from '../auth';
import { getProject } from '../db/projects';
import { getOutline } from '../db/manual';
import {
  assignSection,
  listAssignments,
  listRoles,
  listSectionAssignees,
  listSectionsAssignedToUser,
  listSavedManuals,
  listUserRolesOnProject,
  listUsers,
  removeAssignment,
  setAssignmentScope,
  unassignSection,
  upsertAssignment,
} from '../db/people';
import { deriveManualOverview, statusKeyFor, type FilterKey, type OverviewSectionInput } from './overview';
import type { ManualDO } from './manual-do';

const CORS = { 'access-control-allow-origin': '*' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json', ...CORS } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function manualStub(env: Env, id: string): DurableObjectStub<ManualDO> {
  return env.MANUAL.get(env.MANUAL.idFromName(id)) as unknown as DurableObjectStub<ManualDO>;
}

// Read the live per-section rows from the ManualDO, or fall back to the confirmed
// outline (all 'pending') when the manual has not been run yet — so the page works
// before AND during/after a run.
async function sectionsFor(env: Env, id: string): Promise<OverviewSectionInput[]> {
  try {
    const st = await manualStub(env, id).getState();
    if (st.sections?.length) return st.sections.map((s) => ({ section: s.section, title: s.title, role: s.role, draftingMode: s.draftingMode, status: s.status, openFlags: s.openFlags, error: s.error }));
  } catch {
    /* not run yet */
  }
  const outline = await getOutline(env.DB, id);
  return outline.map((o) => ({ section: o.section, title: o.title ?? '', role: o.role, draftingMode: o.draftingMode, status: 'pending', openFlags: 0 }));
}

// ---- Saved Manuals (top-level /manuals) ----
export async function handleSavedManuals(env: Env, user: User): Promise<Response> {
  const projects = await listSavedManuals(env.DB, user.email);
  const manuals = [];
  for (const p of projects) {
    const roles = await listUserRolesOnProject(env.DB, p.projectId, user.email);
    const outline = await getOutline(env.DB, p.projectId);
    const total = outline.length;
    let approved = 0;
    try {
      const st = await manualStub(env, p.projectId).getState();
      approved = (st.sections ?? []).filter((s) => statusKeyFor({ section: s.section, title: s.title, role: s.role, draftingMode: s.draftingMode, status: s.status, openFlags: s.openFlags }) === 'approved').length;
    } catch {
      /* not run */
    }
    manuals.push({
      projectId: p.projectId,
      name: p.name ?? 'Untitled Project Manual',
      deliveryKind: p.deliveryKind ?? 'single-section',
      manualStatus: p.manualStatus ?? null,
      isCreator: p.userEmail === user.email,
      roles,
      approved,
      total,
    });
  }
  return json({ manuals });
}

// ---- project-scoped people/overview routes (called from handleManualRoutes) ----
// Returns a Response if it owned `rest`, else null so the caller continues.
export async function handlePeopleRoutes(
  req: Request,
  env: Env,
  url: URL,
  user: User | null,
  id: string,
  rest: string,
): Promise<Response | null> {
  // Overview — the single derive that backs the whole Project Manual page.
  if (rest === '/overview' && req.method === 'GET') {
    const proj = await getProject(env.DB, id);
    if (!proj) return bad('project not found', 404);
    const sections = await sectionsFor(env, id);
    const assignees = await listSectionAssignees(env.DB, id);
    const assigneesBySection = new Map<string, { userId: string; userName: string }[]>();
    for (const a of assignees) (assigneesBySection.get(a.section) ?? assigneesBySection.set(a.section, []).get(a.section)!).push({ userId: a.userId, userName: a.userName });
    const assignedToMe = new Set(user ? await listSectionsAssignedToUser(env.DB, id, user.email) : []);
    const pendingOpenBySection = new Map<string, number>();
    try {
      const decisions = await manualStub(env, id).getOpenDecisions();
      for (const d of decisions as { section: string }[]) pendingOpenBySection.set(d.section, (pendingOpenBySection.get(d.section) ?? 0) + 1);
    } catch {
      /* not run */
    }
    const filter = (url.searchParams.get('filter') as FilterKey) || 'all';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.max(1, parseInt(url.searchParams.get('pageSize') || '10', 10) || 10);
    const result = deriveManualOverview({ sections, assignedToMe, assigneesBySection, filter, page, pageSize, pendingOpenBySection });
    return json({ projectId: id, projectName: proj.name ?? 'Project Manual', ...result });
  }

  if (rest === '/roles' && req.method === 'GET') {
    return json({ roles: await listRoles(env.DB) });
  }
  if (rest === '/users' && req.method === 'GET') {
    return json({ users: await listUsers(env.DB) });
  }

  // ---- role assignments (project × person × role) ----
  if (rest === '/assignments' && req.method === 'GET') {
    return json({ assignments: await listAssignments(env.DB, id) });
  }
  if (rest === '/assignments' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { userId?: string; userName?: string; roleId?: string; divisionScope?: string[] | null };
    const userId = (body.userId || '').trim().toLowerCase();
    if (!userId || !body.roleId) return bad('userId and roleId are required');
    try {
      const { id: asgId } = await upsertAssignment(env.DB, { projectId: id, userId, userEmailName: body.userName, roleId: body.roleId, divisionScope: body.divisionScope, assignedBy: user?.email ?? null });
      return json({ ok: true, id: asgId, assignments: await listAssignments(env.DB, id) });
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err));
    }
  }
  if (rest === '/assignments/scope' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { assignmentId?: string; divisionScope?: string[] | null };
    if (!body.assignmentId) return bad('assignmentId required');
    await setAssignmentScope(env.DB, body.assignmentId, body.divisionScope ?? null);
    return json({ ok: true, assignments: await listAssignments(env.DB, id) });
  }
  if (rest === '/assignments/remove' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { assignmentId?: string };
    if (!body.assignmentId) return bad('assignmentId required');
    await removeAssignment(env.DB, body.assignmentId);
    return json({ ok: true, assignments: await listAssignments(env.DB, id) });
  }

  // ---- section assignees (section × person) ----
  if (rest === '/section-assignees' && req.method === 'GET') {
    return json({ assignees: await listSectionAssignees(env.DB, id) });
  }
  if (rest === '/section-assignees' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { section?: string; userId?: string; userName?: string };
    const userId = (body.userId || '').trim().toLowerCase();
    if (!body.section || !userId) return bad('section and userId are required');
    await assignSection(env.DB, { projectId: id, section: body.section, userId, userEmailName: body.userName });
    return json({ ok: true, assignees: await listSectionAssignees(env.DB, id) });
  }
  if (rest === '/section-assignees/remove' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { section?: string; userId?: string };
    const userId = (body.userId || '').trim().toLowerCase();
    if (!body.section || !userId) return bad('section and userId are required');
    await unassignSection(env.DB, { projectId: id, section: body.section, userId });
    return json({ ok: true, assignees: await listSectionAssignees(env.DB, id) });
  }

  return null;
}
