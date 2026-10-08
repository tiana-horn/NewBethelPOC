// Manual HTTP surface (CHANGE-03 §7). All routes live under /project/:id/manual.
// The single-section endpoints are untouched (this file is additive). Manual scope
// lives here + the ManualDO/ManualWorkflow + the manual-scope passes + the
// Assembler + the compare layer — never inside an agent.

import type { Env } from '../env';
import type { User } from '../auth';
import { canAccessProject } from '../authz';
import { buildModeContext, type ModeSelections } from '../mode/mode-context';
import { toPipelineInputs } from '../intake/pipeline-inputs';
import { detectFileType } from '../intake/filetype';
import { extractDocxText, extractPdfText } from '../intake/text';
import { sha256Hex } from '../shared/seal';
import { unzip } from '../shared/inflate';
import { flattenAiSpec } from '../compare/score';
import { collectDesignerNotes } from '../shared/section-ir';
import {
  getExtracted,
  getMaster,
  getProject,
  insertComparison,
  insertComparisonScores,
  setProjectNotifyEmail,
} from '../db/projects';
import { appendTraces, listLockedDocs } from '../db/d1';
import type { TraceRow } from '../shared/types';
import {
  appendManualEvidence,
  getComparisonSections,
  getCoordinationFlags,
  getCoverMeta,
  getOutline,
  insertComparisonSections,
  nudgeAlignment,
  replaceOutline,
  resolveAllCoordinationFlags,
  setDeliveryKind,
  upsertCoverMeta,
} from '../db/manual';
import { buildManualContext, computeModeAOutline, computeOutlineFromCandidates } from './outline';
import { buildSecCatalogFromDb, buildSecIndex, extractFeatureTerms, matchSections } from './sec-match';
import { blendCandidates, embeddingRecall } from './sec-embed';
import { getCorpusSections, getMandatoryDiv01Sections } from '../db/corpus';
import { orderSections } from './division';
import {
  alignSections,
  scoreManualCompare,
  segmentManual,
  type ApprovedSectionForCompare,
  type ManualSegment,
} from './compare-manual';
import { isUserAssigned } from '../db/people';
import { handlePeopleRoutes } from './people-endpoints';
import type { ManualDO } from './manual-do';
import type {
  ComparisonScoreRow,
  ManualCoverMeta,
  ManualSectionRef,
  Mode,
} from '../shared/types';

const CORS = { 'access-control-allow-origin': '*' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json', ...CORS } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const DEFAULT_ORG = 'org-demo';
const QUARANTINE = (id: string) => `projects/${id}/comparison/reference/`;

function manualStub(env: Env, id: string): DurableObjectStub<ManualDO> {
  return env.MANUAL.get(env.MANUAL.idFromName(id)) as unknown as DurableObjectStub<ManualDO>;
}

// Entry — returns a Response if it owned the route, else null.
export async function handleManualRoutes(
  req: Request,
  env: Env,
  url: URL,
  user: User | null,
): Promise<Response | null> {
  const m = url.pathname.match(/^\/project\/([^/]+)\/manual(\/.*)?$/);
  if (!m) return null;
  const id = m[1];
  const rest = m[2] ?? '';

  // CHANGE-07 §1.2 — authorize the manual routes with the same choke point as the
  // project routes (before any ManualDO access or artifact stream). CHANGE-08 §2 —
  // an owned manual is also reachable by anyone ASSIGNED to it (creator OR assignee).
  const authProj = await getProject(env.DB, id);
  if (authProj && !canAccessProject(authProj, user)) {
    const assigned = user ? await isUserAssigned(env.DB, id, user.email) : false;
    if (!assigned) return bad('forbidden', 403);
  }

  // CHANGE-08 §2/§4/§5 — people, roles, assignments, and the page overview derive.
  const peopleResp = await handlePeopleRoutes(req, env, url, user, id, rest);
  if (peopleResp) return peopleResp;

  // ---- Outline (Gate M0) ----
  if (rest === '/outline' && req.method === 'GET') return getOutlineRoute(env, id);
  if (rest === '/outline/proposed' && req.method === 'GET') return getProposedOutline(env, id);
  if (rest === '/outline' && req.method === 'POST') return confirmOutline(req, env, id, user);

  // ---- CHANGE-09 Stage 5 — manual-level DoD cover/title-page metadata ----
  // Auth already enforced above (creator or assignee) at the top of this handler.
  if (rest === '/cover-meta' && req.method === 'GET') {
    const meta = await getCoverMeta(env.DB, id);
    return json({ coverMeta: meta ?? {} });
  }
  if (rest === '/cover-meta' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as ManualCoverMeta;
    await upsertCoverMeta(
      env.DB,
      id,
      {
        projectTitle: body.projectTitle,
        installationLocation: body.installationLocation,
        solicitationNo: body.solicitationNo,
        preparingFirm: body.preparingFirm,
        designDistrict: body.designDistrict,
        dodComponent: body.dodComponent,
        issueDate: body.issueDate,
      },
      user?.email ?? 'demo-architect',
    );
    const meta = await getCoverMeta(env.DB, id);
    return json({ ok: true, coverMeta: meta ?? {} });
  }

  // ---- Run ----
  if (rest === '/run' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { email?: string; name?: string };
    const email = (body.email || '').trim().toLowerCase();
    const owner = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ? { email, name: (body.name || email.split('@')[0]).trim() }
      : null;
    return runManual(env, id, owner);
  }

  // ---- State / coordination / artifacts ----
  if (rest === '/state' && req.method === 'GET') {
    try {
      return json(await manualStub(env, id).getState());
    } catch {
      const proj = await getProject(env.DB, id);
      return json({ status: 'outline', manualStatus: proj?.manualStatus ?? 'outline', sections: [], pendingGate: null });
    }
  }
  if (rest === '/coordination' && req.method === 'GET') {
    const flags = await getCoordinationFlags(env.DB, id);
    let sections: unknown[] = [];
    try {
      const b = await manualStub(env, id).getBundle();
      sections = b.results.map((r) => ({ section: r.section, status: r.status, openFlags: r.validationFlags.filter((f) => !f.resolved), error: r.error }));
    } catch {
      /* not run yet */
    }
    return json({ coordinationFlags: flags, sections });
  }
  // Per-section drafted content — lets the manual UI show each section's actual
  // text and review notes (the same content the single-section flow reviews).
  // CHANGE-08 §6 — per-section resolution submit (re-enterable single-section flow).
  const rsm = rest.match(/^\/section\/(.+)\/resolve$/);
  if (rsm && req.method === 'POST') {
    const section = decodeURIComponent(rsm[1]);
    const body = (await req.json().catch(() => ({}))) as { resolutions?: { selectionId: string; value: string | string[] }[] };
    const resolutions = body.resolutions ?? [];
    const applied = await manualStub(env, id).resolveSection(section, resolutions).catch(() => null);
    if (!applied) return bad('manual has not been run', 409);
    if (!applied.ok) return bad(applied.error ?? 'could not resolve section', 409);
    // Each reviewer resolution writes a traceability row (G6/G13) naming it as a
    // reviewer-entered value with a locatable pointer + non-circular justification.
    const rows: TraceRow[] = resolutions
      .filter((r) => r.value != null && (Array.isArray(r.value) ? r.value.length : String(r.value).trim()))
      .map((r) => {
        const val = Array.isArray(r.value) ? r.value.join(', ') : String(r.value);
        return {
          element: `selection:${r.selectionId}`,
          decision: val,
          sourceType: 'REVIEWER-DECISION',
          sourceRef: `UFGS ${section} — selection ${r.selectionId} (per-section review workspace)`,
          confidence: 1,
          basis: 'project-data' as const,
          justification: `Reviewer resolved selection ${r.selectionId} in ${section} to "${val}" in the per-section review workspace.`,
        };
      });
    if (rows.length) await appendTraces(env.DB, id, section, rows);
    await appendManualEvidence(env.DB, id, [
      { gate: 'section-resolve', element: section, action: 'edit', afterVal: `${applied.resolved} resolved, ${applied.open} open`, userId: user?.email ?? 'demo-architect', at: new Date().toISOString() },
    ]);
    return json({ ok: true, resolved: applied.resolved, open: applied.open });
  }

  const sm = rest.match(/^\/section\/(.+)$/);
  if (sm && req.method === 'GET') {
    const section = decodeURIComponent(sm[1]);
    try {
      const b = await manualStub(env, id).getBundle();
      const r = b.results.find((x) => x.section === section);
      if (!r) return bad('section not found in this run', 404);
      return json({
        section: r.section,
        status: r.status,
        error: r.error,
        ir: r.ir ?? null,
        validationFlags: r.validationFlags ?? [],
        references: r.referencesList?.references ?? [],
        register: r.register?.rows ?? [],
        // CHANGE-08 §6/§7 — the resolution traces (with sourceRef/justification) so
        // the per-section workspace shows each decision's traceable provenance.
        traces: (r.traces ?? []).filter((t) => t.element?.startsWith('selection:')),
        // CHANGE-06 §4 (C3) — review-only Notes to the Designer (never issued).
        designerNotes: r.ir ? collectDesignerNotes(r.ir) : [],
      });
    } catch {
      return bad('manual has not been run', 409);
    }
  }

  // CHANGE-06 §5 (C1) — book-scope open decisions aggregated across all sections.
  if (rest === '/decisions' && req.method === 'GET') {
    try {
      const decisions = await manualStub(env, id).getOpenDecisions();
      return json({ decisions, open: decisions.length });
    } catch {
      return bad('manual has not been run', 409);
    }
  }

  const am = rest.match(/^\/artifact\/([a-z0-9-]+)$/);
  if (am && req.method === 'GET') return manualArtifact(env, id, am[1]);

  // ---- Manual gates (M-COORD, gate5) ----
  const gm = rest.match(/^\/gate\/([A-Za-z0-9-]+)$/);
  if (gm && req.method === 'POST') return manualGate(req, env, id, gm[1], user);

  // ---- Stop / restart / reset (Rev B) ----
  if (rest === '/stop' && req.method === 'POST') return stopManual(env, id);
  if (rest === '/reset' && req.method === 'POST') return resetManual(env, id);
  if (rest === '/restart' && req.method === 'POST') {
    await resetManual(env, id);
    // Reuse the notify email already stored on the project (no body needed).
    return runManual(env, id, null);
  }

  // ---- Whole-manual compare (post-approval) ----
  if (rest === '/comparison' && req.method === 'POST') return manualCompareUpload(req, env, id);
  if (rest === '/comparison' && req.method === 'GET') return getManualComparison(env, id);
  if (rest === '/comparison/align' && req.method === 'POST') return alignNudge(req, env, id);

  return null;
}

// ---- Outline (§3) ----
async function getOutlineRoute(env: Env, id: string): Promise<Response> {
  const proj = await getProject(env.DB, id);
  if (!proj) return bad('project not found', 404);
  const current = await getOutline(env.DB, id);
  const suggested = await suggestOutline(env, proj);
  return json({ suggested, current, confirmed: current.length > 0 });
}

// CHANGE-04 §5 / Part 12 — the computed candidate outline BEFORE Gate M0.
async function getProposedOutline(env: Env, id: string): Promise<Response> {
  const proj = await getProject(env.DB, id);
  if (!proj) return bad('project not found', 404);
  const suggested = await suggestOutline(env, proj);
  return json({
    suggested,
    computedFrom: 'sec-catalog-match', // CHANGE-05 §4 — feature-matched, not OmniClass
    sectionCount: suggested.length,
    draftCount: suggested.filter((s) => s.draftingMode === 'draft').length,
    outlineCount: suggested.filter((s) => s.draftingMode === 'outline').length,
  });
}

// Mode A: seeded by the SEC-catalog matcher off intake features (CHANGE-05 §4),
// with a minimal front-end/Div-01 fallback. Modes B/C: CHANGE-03 finish seed.
async function suggestOutline(env: Env, proj: Awaited<ReturnType<typeof getProject>>): Promise<ManualSectionRef[]> {
  if (!proj) return [];
  const ex = await getExtracted(env.DB, proj.projectId);
  // CHANGE-05 §2/§4 — one mode (UFGS): select sections by matching the intake's
  // features against the SEC catalog (title). Falls back to a minimal front-end +
  // Div 01 outline when no corpus is ingested or no usable features exist, so the
  // endpoint never returns empty just because selection couldn't run.
  const lockedDocs = (await listLockedDocs(env.DB, 'ufc')).map((d) => ({ ldid: d.ldid, title: d.title }));
  const corpusSections = await getCorpusSections(env.DB);
  // CHANGE-09 Stage 3 — the mandatory Division 01 checklist, required by rule on
  // every outline regardless of intake features.
  const mandatoryDiv01 = await getMandatoryDiv01Sections(env.DB);
  const catalog = await buildSecCatalogFromDb(env.DB);
  const features = extractFeatureTerms(ex?.data ?? null);
  if (catalog.length && features.length) {
    const lexical = matchSections(features, buildSecIndex(catalog));
    // CHANGE-06 §3 (C4) — blend embedding recall (remote-only; the `ufgs`
    // namespace). Offline / no Vectorize -> recall is empty and `blendCandidates`
    // returns the lexical list unchanged, so the offline floor never regresses.
    const ctx = await buildModeContext(env, 'UFGS', {});
    const recall = await embeddingRecall(env, ctx, features.map((f) => f.text).join(' '));
    const candidates = blendCandidates(lexical, recall, catalog);
    // CHANGE-09 Stage 2 — the project's agency selects the correct `.00 NN`
    // tailored SEC variant when more than one exists for the same base slot.
    if (candidates.length) return computeOutlineFromCandidates({ candidates, corpusSections, lockedDocs, agency: proj.agency, mandatoryDiv01 });
  }
  return computeModeAOutline({ extracted: ex?.data ?? null, corpusSections, lockedDocs, agency: proj.agency, mandatoryDiv01 });
}

async function confirmOutline(req: Request, env: Env, id: string, user: User | null): Promise<Response> {
  const proj = await getProject(env.DB, id);
  if (!proj) return bad('project not found', 404);
  const body = (await req.json().catch(() => ({}))) as { sections?: ManualSectionRef[]; dividers?: boolean };
  const sections = orderSections(body.sections ?? []);
  if (sections.length === 0) return bad('outline must have at least one section (Gate M0)');
  // Section numbers are the key for fan-out step names, per-section results, and
  // status rows — duplicates would silently collapse (one run overwrites another,
  // Workflow step-name collision). Reject them at Gate M0 instead.
  const seen = new Set<string>();
  const dupes = sections.map((s) => s.section).filter((sec) => seen.size === seen.add(sec).size);
  if (dupes.length > 0) return bad(`outline has duplicate section(s): ${[...new Set(dupes)].join(', ')}`);
  await setDeliveryKind(env.DB, id, 'project-manual', 'outline');
  await replaceOutline(env.DB, id, sections, proj.masterId);
  await appendManualEvidence(env.DB, id, [
    { gate: 'M0', element: 'outline', action: 'confirm', afterVal: `${sections.length} sections`, userId: user?.email ?? 'demo-architect', at: new Date().toISOString() },
  ]);
  return json({ ok: true, sections, confirmed: true });
}

// ---- Run (fan out) ----
async function runManual(env: Env, id: string, owner: { email: string; name: string } | null): Promise<Response> {
  const proj = await getProject(env.DB, id);
  if (!proj) return bad('project not found', 404);
  if (!proj.selectionsJson) return bad('selections not set (step 3)', 409);
  const ex = await getExtracted(env.DB, id);
  if (!ex || !ex.confirmed) return bad('Gate 0: confirm the extracted project data before running', 409);
  const outline = await getOutline(env.DB, id);
  if (outline.length === 0) return bad('Gate M0: confirm the manual outline before running', 409);

  // Record who should receive the finished manual (skipped on restart, which
  // reuses whatever address was captured on the first run).
  if (owner) await setProjectNotifyEmail(env.DB, id, owner.email, owner.name);

  // Guard a run already in flight (Rev B semantics: stop/reset before re-running).
  try {
    const cur = await manualStub(env, id).getState();
    if (cur.status === 'running' || cur.status === 'awaiting-gate')
      return bad('the manual is already running — stop or reset it before re-running', 409);
  } catch {
    /* first run */
  }

  const sel = JSON.parse(proj.selectionsJson) as Record<string, unknown>;
  const master = proj.masterId ? await getMaster(env.DB, proj.masterId) : null;
  const selections: ModeSelections = {
    agency: (proj.agency as ModeSelections['agency']) ?? (sel.agency as ModeSelections['agency']),
    delivery: sel.delivery as ModeSelections['delivery'],
    stylePackId: sel.stylePackId as string | undefined,
    units: sel.units as 'imperial' | 'dual' | undefined,
    masterId: master?.masterId,
    masterOwner: master?.owner,
    masterNamespace: master?.namespace,
  };
  const ctx = await buildModeContext(env, 'UFGS', selections);
  const manualCtx = buildManualContext(id, outline);
  const inputs = toPipelineInputs(ex.data, selections);

  // Front-end (include) doc text for the Assembler.
  const includes: Record<string, { title: string; text: string }> = {};
  for (const s of outline)
    if (s.draftingMode === 'include')
      includes[s.section] = { title: s.title ?? '', text: `${s.title ?? 'Agency front-end document'} — included unaltered; may not be modified by the A/E (G2).` };

  const stub = manualStub(env, id);
  await stub.init({
    projectId: id,
    projectName: proj.name ?? 'Project Manual',
    ctx,
    manualCtx,
    // CHANGE-09 Stage 6 — carry the intake's drawingsIndex through so the
    // Assembler's List of Drawings front matter can read it at assemble time.
    inputs: { ...inputs, drawingsIndex: ex.data.drawingsIndex ?? [] },
    outline,
    includes,
    user: owner,
  });
  const instance = await env.MANUAL_WORKFLOW.create({ params: { projectId: id } });
  await stub.setWorkflowInstance(instance.id);
  await setDeliveryKind(env.DB, id, 'project-manual', 'running');
  return json({ ok: true, instanceId: instance.id, status: 'running' });
}

async function manualGate(req: Request, env: Env, id: string, gateId: string, user: User | null): Promise<Response> {
  if (gateId !== 'M-DECIDE' && gateId !== 'M-COORD' && gateId !== 'gate5') return bad(`unknown manual gate ${gateId}`);
  const decision = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const stub = manualStub(env, id);
  const applied = await stub.applyGate(gateId, decision);
  if (!applied.ok) return bad(applied.error ?? 'gate decision rejected', 409);
  if (gateId === 'M-COORD') await resolveAllCoordinationFlags(env.DB, id);
  // CHANGE-06 §5 (C1/G15) — each resolved/defaulted decision writes a traceability
  // row (G13), preserving whether it came from project data or the UFGS default.
  if (gateId === 'M-DECIDE' && applied.decided?.length) {
    const bySection = new Map<string, TraceRow[]>();
    for (const d of applied.decided) {
      const reviewerEntered = d.basis === 'project-data'; // M-DECIDE explicit resolutions are reviewer decisions
      const row: TraceRow = {
        element: `selection:${d.selectionId}`,
        decision: d.chosen,
        sourceType: d.basis === 'ufgs-default' ? 'UFGS-DEFAULT' : 'REVIEWER-DECISION',
        // Locatable pointer: the section + the paragraph the selection lives in.
        sourceRef: `UFGS ${d.section} ${d.paragraphId} — selection ${d.selectionId}`,
        confidence: 1,
        basis: d.basis,
        justification: reviewerEntered
          ? `Reviewer resolved selection ${d.selectionId} in ${d.section} ${d.paragraphId} to "${d.chosen}" at the book-scope decision gate (M-DECIDE).`
          : `No project data or UFC criterion specified this choice; applied the documented UFGS default "${d.chosen}" (first-listed option in ${d.section} ${d.paragraphId}) at M-DECIDE.`,
      };
      (bySection.get(d.section) ?? bySection.set(d.section, []).get(d.section)!).push(row);
    }
    for (const [section, rows] of bySection) await appendTraces(env.DB, id, section, rows);
  }
  await appendManualEvidence(env.DB, id, [
    { gate: gateId, element: gateId === 'gate5' ? 'attestation' : gateId === 'M-DECIDE' ? 'decisions' : 'coordination', action: gateId === 'gate5' ? 'attest' : 'acknowledge', afterVal: JSON.stringify(decision).slice(0, 180), userId: user?.email ?? 'demo-architect', at: new Date().toISOString() },
  ]);
  const instanceId = await stub.getWorkflowInstance();
  if (!instanceId) return bad('manual workflow not started', 409);
  const instance = await env.MANUAL_WORKFLOW.get(instanceId);
  await instance.sendEvent({ type: gateId, payload: decision });
  return json({ ok: true });
}

async function manualArtifact(env: Env, id: string, kind: string): Promise<Response> {
  const stub = manualStub(env, id);
  // Binary artifacts (docx/pdf/seal-package) from the DO.
  if (kind === 'docx' || kind === 'pdf' || kind === 'seal-package') {
    const rec = await stub.getArtifact(kind).catch(() => null);
    if (!rec?.r2Key) return bad(`artifact '${kind}' not ready`, 404);
    const obj = await env.R2.get(rec.r2Key);
    if (!obj) return bad(`artifact '${kind}' not ready`, 404);
    const ext = kind === 'seal-package' ? 'zip' : kind;
    return new Response(obj.body, { headers: { 'content-type': rec.contentType, 'content-disposition': `attachment; filename="project-manual.${ext}"`, ...CORS } });
  }
  // JSON/CSV projections from the bundle.
  let bundle;
  try {
    bundle = await stub.getBundle();
  } catch {
    return bad('manual not run', 404);
  }
  if (kind === 'toc') return json(bundle.toc);
  if (kind === 'references') return json(bundle.masterReferences);
  if (kind === 'submittal-register') return json(bundle.masterRegister);
  if (kind === 'coordination') return json(bundle.coordinationFlags);
  if (kind === 'compliance') return json(bundle.compliance ?? null);
  return bad(`unknown artifact '${kind}'`, 404);
}

// ---- Rev B: stop / reset ----
async function stopManual(env: Env, id: string): Promise<Response> {
  try {
    await manualStub(env, id).stop();
  } catch {
    /* nothing running */
  }
  return json({ ok: true, status: 'stopped' });
}
async function resetManual(env: Env, id: string): Promise<Response> {
  try {
    await manualStub(env, id).reset();
  } catch {
    /* nothing to reset */
  }
  await setDeliveryKind(env.DB, id, 'project-manual', 'outline');
  return json({ ok: true, status: 'reset' });
}

// ---- Whole-manual compare (§6A) — QUARANTINED upload -> segment -> align -> score ----
async function manualCompareUpload(req: Request, env: Env, id: string): Promise<Response> {
  const stub = manualStub(env, id);
  let state;
  try {
    state = await stub.getState();
  } catch {
    return bad('manual has not been run', 409);
  }
  if (state.status !== 'done' || !state.contentHash)
    return bad('whole-manual compare is available only after the manual is approved and frozen', 409);

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return bad('multipart field "file" required');
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Accept a combined DOCX/PDF/txt OR a ZIP of section files. Segments are stored
  // under the QUARANTINE prefix and read ONLY by the scoring path (G-CMP-1).
  const det = detectFileType(file.name, bytes);
  const cmpId = `cmp-${crypto.randomUUID().slice(0, 8)}`;
  const sha = await sha256Hex(bytes);
  const referenceR2Key = `${QUARANTINE(id)}manual-${sha.slice(0, 8)}-${file.name}`;
  await env.R2?.put(referenceR2Key, bytes).catch(() => {});

  let segments: ManualSegment[] = [];
  if (det.type === 'docx') segments = segmentManual(extractDocxText(bytes));
  else if (det.type === 'pdf') segments = segmentManual(extractPdfText(bytes)); // scanned accepted (Rev D)
  else if (file.name.toLowerCase().endsWith('.zip')) {
    for (const entry of unzip(bytes)) {
      if (entry.name.endsWith('/')) continue;
      const txt = entry.name.toLowerCase().endsWith('.docx') ? extractDocxText(entry.data) : new TextDecoder().decode(entry.data);
      const segs = segmentManual(txt);
      segments.push(...(segs.length ? segs : [{ section: sectionFromName(entry.name), title: entry.name, text: txt }]));
    }
  } else segments = segmentManual(new TextDecoder().decode(bytes));

  const bundle = await stub.getBundle();
  const master = (await getProject(env.DB, id))?.masterId;
  const corpusProvenance = master ? (await getMaster(env.DB, master))?.owner ?? 'system' : 'system';

  // Approved sections -> per-section AiSpecForCompare (frozen).
  const approved: ApprovedSectionForCompare[] = bundle.outline.map((o) => {
    const r = bundle.results.find((x) => x.section === o.section);
    const ai =
      r?.ir
        ? flattenAiSpec({ ir: r.ir, references: r.referencesList?.references ?? [], register: r.register?.rows ?? [], coordinationFlags: (r.coordinationFlags ?? []).map((f) => ({ type: f.type, detail: f.detail })), traces: r.traces })
        : { section: o.section, title: o.title ?? '', text: '', references: [], submittals: [], specifyingMethods: [], coordinationCatches: [], lockedSpans: [], traces: [] };
    return { section: o.section, title: o.title ?? '', role: o.role as any, drafted: o.draftingMode === 'draft' && !!r?.ir, ai };
  });

  const alignment = alignSections(approved.map((a) => ({ section: a.section, title: a.title })), segments, cmpId);
  // Persist each segment under its quarantined key + record the alignment rows.
  const segTextByRefSection: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const key = `${QUARANTINE(id)}${cmpId}/segment-${i + 1}`;
    await env.R2?.put(key, new TextEncoder().encode(seg.text)).catch(() => {});
    if (seg.section) segTextByRefSection[seg.section] = seg.text;
  }
  for (const row of alignment) row.refSegmentR2Key = row.refSection ? `${QUARANTINE(id)}${cmpId}/segment` : '';

  const { perSection, rollup } = scoreManualCompare({ approved, alignment, segTextByRefSection });

  await insertComparison(env.DB, { cmpId, projectId: id, referenceR2Key, referenceSha256: sha, corpusProvenance, status: 'scored', scope: 'manual' } as any);
  await insertComparisonSections(env.DB, cmpId, alignment);
  const scoreRows: (ComparisonScoreRow & { section?: string | null })[] = [
    ...rollup.map((r) => ({ ...r, section: null })),
    ...perSection.flatMap((p) => p.scores.map((s) => ({ ...s, section: p.section }))),
  ];
  await insertComparisonScores(env.DB, cmpId, scoreRows as any);

  return json({ cmpId, scope: 'manual', corpusProvenance, coverage: alignment, perSection, rollup });
}

async function getManualComparison(env: Env, id: string): Promise<Response> {
  const cmp = await env.DB.prepare(
    `SELECT cmp_id as cmpId, corpus_provenance as corpusProvenance, status FROM comparison WHERE project_id = ?1 AND scope = 'manual' ORDER BY rowid DESC LIMIT 1`,
  ).bind(id).first<{ cmpId: string; corpusProvenance: string; status: string }>();
  if (!cmp) return json({ status: 'none', coverage: [], perSection: [], rollup: [] });
  const coverage = await getComparisonSections(env.DB, cmp.cmpId);
  const scores = await env.DB.prepare(
    `SELECT section, dimension, ai_value as aiValue, ref_value as refValue, verdict, divergence_class as divergenceClass, traceability_ref as traceabilityRef FROM comparison_score WHERE cmp_id = ?1 ORDER BY id`,
  ).bind(cmp.cmpId).all<ComparisonScoreRow & { section: string | null }>();
  const rows = scores.results ?? [];
  const rollup = rows.filter((r) => !r.section);
  const bySection = new Map<string, ComparisonScoreRow[]>();
  for (const r of rows) if (r.section) (bySection.get(r.section) ?? bySection.set(r.section, []).get(r.section)!).push(r);
  const perSection = [...bySection.entries()].map(([section, scores]) => ({ section, scores }));
  return json({ cmpId: cmp.cmpId, corpusProvenance: cmp.corpusProvenance, status: cmp.status, coverage, rollup, perSection });
}

async function alignNudge(req: Request, env: Env, id: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { rowId?: string; matchedProjectSection?: string | null; alignment?: string };
  if (!body.rowId) return bad('rowId required');
  await nudgeAlignment(env.DB, body.rowId, body.matchedProjectSection ?? null, (body.alignment as any) ?? 'matched');
  return json({ ok: true });
}

function sectionFromName(name: string): string | null {
  const m = name.match(/(\d{2})\s?(\d{2})\s?(\d{2})/);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : null;
}
