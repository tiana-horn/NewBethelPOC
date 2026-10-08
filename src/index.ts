// Worker entrypoint + HTTP router. ONE pipeline (blueprint §2.1): there is no
// /session / SpecWorkflow single-section path — the run path is always the
// Project Manual (a single-section delivery is a one-entry outline). The wizard
// routes (masters, project create, intake, Gate 0, selections) feed it.
//
// Auth (blueprint §6, §10): listing routes (/projects, /masters, /manuals/saved)
// require a session. Project creation and per-project routes are open so the
// ANONYMOUS DEMO works — an unowned project is shared (canAccessProject), an
// owned one is owner/assignee only. /admin/* is authenticated in its own handler
// (§2.4). /auth and /api/seed-r2 are the pre-auth surface.

export type { Env } from './env';
import type { Env } from './env';

import { handleAdminCorpusRoutes } from './corpus/admin';
import { getUser, handleAuthRoutes, type User } from './auth';
import { handleManualRoutes } from './manual/endpoints';
import { handleSavedManuals } from './manual/people-endpoints';
import { canAccessProject } from './authz';
import { isUserAssigned } from './db/people';
import { sweepCorpusStaleness } from './corpus/staleness-cron';
import { isNotInitialized } from './shared/errors';
import { seedR2 } from './seed-r2';
import { detectFileType } from './intake/filetype';
import { normalizeInputs, type InputKind, type RawInput } from './intake/normalize';
import { buildModeContext } from './mode/mode-context';
import { requiredInputsFor, missingRequiredInputs } from './mode/required-inputs';
import { ingestMaster } from './masters/embed';
import { sha256Hex } from './shared/seal';
import {
  addProjectInput, createProject, getExtracted, getLatestComparison,
  insertMaster, listMasters, listProjectInputs, listProjects, getProject,
  saveExtracted, saveSelections, setInputParseStatus, setMasterStatus,
} from './db/projects';

export { RenderContainer } from './render-container';
export { ManualDO } from './manual/manual-do';
export { ManualWorkflow } from './manual/manual-workflow';

const CORS = { 'access-control-allow-origin': '*' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json', ...CORS } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const DEFAULT_ORG = 'org-demo';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS')
      return new Response(null, {
        headers: { ...CORS, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-admin-secret' },
      });

    if (path === '/api/health') return json({ ok: true, useAi: env.USE_AI === 'true' });

    // Non-API paths -> static SPA.
    if (
      !path.startsWith('/api') && !path.startsWith('/project') && !path.startsWith('/masters') &&
      !path.startsWith('/manuals') && !path.startsWith('/admin') && !path.startsWith('/auth')
    ) {
      return env.ASSETS.fetch(req);
    }

    try {
      if (path.startsWith('/auth')) {
        const r = await handleAuthRoutes(req, env, url);
        if (r) return r;
      }
      if (path === '/api/seed-r2' && req.method === 'POST') {
        const keys = await seedR2(env);
        return json({ ok: true, count: keys.length, keys });
      }
      if (path.startsWith('/admin/corpus')) {
        const r = await handleAdminCorpusRoutes(req, env, url);
        if (r) return r;
      }

      const user = await getUser(env, req);

      // Listing routes require a session (they scope to the caller's own work).
      if (!user && (path === '/projects' || path === '/masters' || path === '/manuals/saved')) {
        return bad('authentication required — sign in to view your manuals', 401);
      }

      if (path === '/manuals/saved' && req.method === 'GET') return handleSavedManuals(env, user!);

      // Per-project authorization once, before any project-scoped route.
      const pm = path.match(/^\/project\/([^/]+)(\/.*)?$/);
      if (pm) {
        const authProj = await getProject(env.DB, pm[1]);
        if (authProj && !canAccessProject(authProj, user)) {
          const assigned = user ? await isUserAssigned(env.DB, pm[1], user.email) : false;
          if (!assigned) return bad('forbidden', 403);
        }
      }

      if (path.startsWith('/project') && path.includes('/manual')) {
        const r = await handleManualRoutes(req, env, url, user);
        if (r) return r;
      }
      if (path.startsWith('/project') || path.startsWith('/masters')) {
        const r = await handleProjectRoutes(req, env, url, user);
        if (r) return r;
      }
      return bad('not found', 404);
    } catch (err) {
      if (isNotInitialized(err)) return bad('not found', 404);
      return bad(err instanceof Error ? err.message : String(err), 500);
    }
  },

  // Quarterly corpus staleness sweep — flags newer editions for human
  // re-verification; never auto-adopts (G11). Tolerates the CIM being unreachable.
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepCorpusStaleness(env).catch((e) => console.error('[staleness-cron]', e instanceof Error ? e.message : String(e))),
    );
  },
};

// ============================================================================
// The project wizard + master library. The RUN path is the Project Manual
// (handleManualRoutes) — this prepares the project it runs on.
// ============================================================================
async function handleProjectRoutes(req: Request, env: Env, url: URL, user: User | null): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/masters' && req.method === 'GET') {
    const owner = user?.email ?? url.searchParams.get('owner') ?? DEFAULT_ORG;
    return json({ masters: await listMasters(env.DB, { owner, mode: url.searchParams.get('mode') ?? undefined }) });
  }
  if (path === '/masters' && req.method === 'POST') {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return bad('multipart field "file" required');
    const owner = user?.email ?? ((form.get('owner') as string) || DEFAULT_ORG);
    const name = (form.get('name') as string) || file.name;
    const masterId = `m-${crypto.randomUUID().slice(0, 8)}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const det = detectFileType(file.name, bytes);
    if (det.rejected) return bad(det.reason ?? 'unsupported master format');
    await insertMaster(env.DB, { masterId, owner, name, namespace: `master:${owner}:${masterId}`, r2Prefix: `masters/${owner}/${masterId}/`, status: 'processing' });
    try {
      const res = await ingestMaster(env, { masterId, owner, filename: file.name, bytes });
      await setMasterStatus(env.DB, masterId, 'ready');
      return json({ ok: true, masterId, owner, namespace: res.namespace, chunks: res.chunks, embedded: res.embedded, status: 'ready' });
    } catch (err) {
      await setMasterStatus(env.DB, masterId, 'error');
      return bad(`master ingest failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  }

  // Create a project. No auth required: an anonymous caller creates an UNOWNED
  // (shared) project — the one-section-manual demo (§10). A signed-in caller owns it.
  if (path === '/project' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { name?: string; orgId?: string; agency?: string };
    const agency = ['ARMY', 'NAVY', 'AIRFORCE', 'OTHER'].includes(body.agency ?? '') ? (body.agency as string) : 'ARMY';
    const projectId = `proj-${crypto.randomUUID().slice(0, 8)}`;
    await createProject(env.DB, { projectId, orgId: body.orgId ?? DEFAULT_ORG, name: body.name, userEmail: user?.email ?? null, agency });
    return json({ projectId, status: 'intake', mode: 'UFGS', agency });
  }
  if (path === '/projects' && req.method === 'GET') {
    return json({ projects: await listProjects(env.DB, url.searchParams.get('org') ?? DEFAULT_ORG, user?.email ?? null) });
  }

  const m = path.match(/^\/project\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const id = m[1];
  const rest = m[2] ?? '';

  // Intake: upload -> parse -> review (Gate 0) -> confirm.
  if (rest === '/inputs' && req.method === 'POST') {
    const form = await req.formData();
    const stored: { kind: string; filename: string }[] = [];
    for (const [key, val] of form.entries()) {
      if (!(val instanceof File)) continue;
      const bytes = new Uint8Array(await val.arrayBuffer());
      const sha = await sha256Hex(bytes);
      const r2Key = `projects/${id}/inputs/${key}-${val.name}`;
      await env.R2?.put(r2Key, bytes);
      await addProjectInput(env.DB, { projectId: id, kind: key, filename: val.name, r2Key, sha256: sha });
      stored.push({ kind: key, filename: val.name });
    }
    return json({ ok: true, stored });
  }
  if (rest === '/parse' && req.method === 'POST') {
    if (!(await getProject(env.DB, id))) return bad('project not found', 404);
    const inputs = await listProjectInputs(env.DB, id);
    const raws: RawInput[] = [];
    for (const inp of inputs) {
      const obj = await env.R2?.get(inp.r2Key);
      if (!obj) continue;
      raws.push({ kind: inp.kind as InputKind, filename: inp.filename, bytes: new Uint8Array(await obj.arrayBuffer()) });
    }
    const ctx = await buildModeContext(env, 'UFGS', {});
    const { data, perInput, events } = await normalizeInputs(env, ctx, id, raws);
    await saveExtracted(env.DB, id, data, false);
    for (const pi of perInput) await setInputParseStatus(env.DB, id, pi.filename, pi.parseStatus);
    return json({ ok: true, perInput, data, events });
  }
  if (rest === '/extracted' && req.method === 'GET') {
    const ex = await getExtracted(env.DB, id);
    const inputs = await listProjectInputs(env.DB, id);
    return ex ? json({ data: ex.data, confirmed: ex.confirmed, inputs }) : json({ data: null, confirmed: false, inputs });
  }
  if (rest === '/extracted/confirm' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { data?: import('./shared/types').ExtractedProjectData };
    const ex = await getExtracted(env.DB, id);
    const data = body.data ?? ex?.data;
    if (!data) return bad('no extracted data to confirm — run /parse first', 409);
    const inputs = await listProjectInputs(env.DB, id);
    const parsedKinds = new Set(inputs.filter((i) => i.parseStatus === 'parsed').map((i) => i.kind));
    const missing = missingRequiredInputs('UFGS', parsedKinds);
    if (missing.length > 0) return bad(`Gate 0 blocked — required input(s) missing or unparsed: ${missing.join(', ')}`, 409);
    await saveExtracted(env.DB, id, data, true);
    return json({ ok: true, confirmed: true });
  }
  if (rest === '/required-inputs' && req.method === 'GET') {
    if (!(await getProject(env.DB, id))) return bad('project not found', 404);
    const inputs = await listProjectInputs(env.DB, id);
    const parsedKinds = new Set(inputs.filter((i) => i.parseStatus === 'parsed').map((i) => i.kind));
    return json({ mode: 'UFGS', manifest: requiredInputsFor('UFGS'), missingRequired: missingRequiredInputs('UFGS', parsedKinds) });
  }
  if (rest === '/selections' && req.method === 'POST') {
    if (!(await getProject(env.DB, id))) return bad('project not found', 404);
    const sel = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const section = (sel.section as string) || '09 90 00';
    await saveSelections(env.DB, id, {
      name: sel.name as string | undefined,
      section,
      masterId: (sel.masterId as string) ?? null,
      selectionsJson: JSON.stringify(sel),
    });
    return json({ ok: true, mode: 'UFGS', section });
  }

  // Comparison is manual-scoped (handled by handleManualRoutes at
  // /project/:id/manual/comparison). The single-section comparison + run/state/
  // gate routes are gone with the single-section pipeline (§2.1).
  if (rest === '/comparison' && req.method === 'GET') {
    return json((await getLatestComparison(env.DB, id)) ?? { status: 'none', scores: [] });
  }

  return null;
}
