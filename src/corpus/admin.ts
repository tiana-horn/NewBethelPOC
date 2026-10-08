// CHANGE-04 Part 6 + Part 9 — admin-triggered corpus ETL and the staleness
// surface. Per Stage 4 these are "manual file drop → parse → load" jobs: the
// endpoints accept ALREADY-PARSED rows (the mechanical parse of the large WBDG
// PDFs / SpecsIntact master.ref is a separate offline step) and load them under a
// `corpus_source` provenance row (G12). No table here is ever seeded from model
// output — editions are captured from the source, never asserted (G7/G11).

import type { Env } from '../env';
import {
  insertCorpusSource,
  listCorpusSources,
  listStaleCorpusSources,
  markSectionEmbedded,
  markStale,
  reverifyCorpusSource,
  upsertUfgsCorpusSection,
} from '../db/corpus';
import { secToSectionIR } from './sec-to-ir';
import { ufgsCorpusR2Key } from './ufgs-store';
import { fetchUfcVersionContent, isUuid, UFC_VERSION_SEED, CimError } from './ufc-cim';
import { buildCriteriaIndex, loadUfcCandidates, linkCorpusSection } from './criteria-link';
import { sweepCorpusStaleness } from './staleness-cron';
import { embedUfgsSection } from '../manual/sec-embed';
import { buildModeContext } from '../mode/mode-context';
import type { SectionIR } from '../shared/types';

// PART 1 scope text for the embedding pass: the title + PART 1 article/paragraph
// text, tags already stripped by the IR builder. Bounded — the embedder caps too.
function part1ScopeText(ir: SectionIR): string {
  const p1 = ir.parts.find((p) => p.part === 1);
  if (!p1) return '';
  const parts: string[] = [];
  for (const a of p1.articles) {
    parts.push(a.title);
    for (const para of a.paragraphs) parts.push(para.text);
  }
  return parts.join(' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

const CORS = { 'access-control-allow-origin': '*' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json', ...CORS } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

// Blueprint §2.4 — the admin corpus surface is NO LONGER open (the prior POC
// shipped it unauthenticated, live-confirmed in prod). Require a shared secret
// via the `x-admin-secret` header. If ADMIN_SECRET is unset, deny in all cases
// EXCEPT local dev (ALLOW_DEV_LOGIN=true, a .dev.vars-only flag) so the offline
// ETL path still works without configuring a secret.
function adminAuthorized(req: Request, env: Env): boolean {
  if (env.ADMIN_SECRET) return req.headers.get('x-admin-secret') === env.ADMIN_SECRET;
  return String(env.ALLOW_DEV_LOGIN).toLowerCase() === 'true';
}

// Returns a Response if it owns the route, else null.
export async function handleAdminCorpusRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/admin/corpus')) return null;

  if (!adminAuthorized(req, env))
    return new Response(JSON.stringify({ error: 'admin authorization required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', ...CORS },
    });

  // --- Part 9.3 — staleness dashboard + re-verify ---
  if (path === '/admin/corpus/staleness' && req.method === 'GET') {
    return json({ stale: await listStaleCorpusSources(env.DB), all: await listCorpusSources(env.DB) });
  }
  // CHANGE-06 §2.2 (C6.2) — run the staleness sweep on demand (the Cron fires
  // quarterly; this is the ops/verify trigger). Flag-only, never adopts (G11).
  if (path === '/admin/corpus/staleness/sweep' && req.method === 'POST') {
    return json(await sweepCorpusStaleness(env));
  }
  const rv = path.match(/^\/admin\/corpus\/([^/]+)\/reverify$/);
  if (rv && req.method === 'POST') {
    const r = await reverifyCorpusSource(env.DB, rv[1]);
    if (!r.ok) return bad('corpus_source not found', 404);
    return json({ ok: true, adopted: r.adopted });
  }
  // Test/ops hook for G11: record that a source has a newer live edition -> flags
  // it and every list row it fed stale (§9.2). The scheduled Worker (§9.2) calls
  // the same path with the edition it discovered on the live WBDG page.
  const ms = path.match(/^\/admin\/corpus\/([^/]+)\/mark-stale$/);
  if (ms && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { latestKnownEdition?: string };
    if (!body.latestKnownEdition) return bad('latestKnownEdition required');
    await markStale(env.DB, ms[1], body.latestKnownEdition);
    return json({ ok: true });
  }

  // CHANGE-05 §1 — POST /admin/corpus/xwalk REMOVED (OmniClass crosswalk withdrawn).

  // --- Part 6.3 — register an ingested UFGS section (flips outline -> draft) ---
  if (path === '/admin/corpus/ufgs-section' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { section?: string; title?: string; r2Key?: string; sourceEdition?: string };
    if (!body.section || !body.r2Key || !body.sourceEdition)
      return bad('section, r2Key, and sourceEdition are required');
    await upsertUfgsCorpusSection(env.DB, { section: body.section, title: body.title, r2Key: body.r2Key, sourceEdition: body.sourceEdition });
    await insertCorpusSource(env.DB, { kind: 'UFGS-MASTER', identifier: body.section, edition: body.sourceEdition, r2Key: body.r2Key });
    return json({ ok: true, section: body.section, draftable: true });
  }

  // --- Working-prototype expansion — bulk-ingest REAL .SEC files (any/all of
  // the UFGS master), converting each to a real SectionIR (src/corpus/sec-to-
  // ir.ts) instead of registering presence only. This is the general engine: it
  // works on ANY section a firm's own project resolves to, not a hardcoded list
  // — "no rebuild per project" is a property of ingesting the corpus, not of
  // any one demo dataset. ---
  if (path === '/admin/corpus/ufgs-bulk' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { files?: { filename: string; xml: string }[] };
    const files = body.files ?? [];
    if (files.length === 0) return bad('files[] required ({ filename, xml }[])');
    // CHANGE-06 §3 (C4) — one ModeContext for the batch drives the (remote-only)
    // `ufgs` embedding pass. Offline / no Vectorize -> embedUfgsSection is a no-op.
    const ctx = await buildModeContext(env, 'UFGS', {});
    const results: { filename: string; section?: string; ok: boolean; error?: string; warnings?: number; embedded?: boolean }[] = [];
    for (const f of files) {
      try {
        const fallback = f.filename.replace(/\.SEC$/i, '');
        const { ir, edition, warnings } = secToSectionIR(f.xml, fallback);
        if (ir.parts.length === 0 || ir.parts.every((p) => p.articles.length === 0)) {
          results.push({ filename: f.filename, ok: false, error: 'converted to an empty IR (0 articles)' });
          continue;
        }
        const slug = ir.section.replace(/[^0-9A-Za-z]+/g, '-');
        const r2Key = ufgsCorpusR2Key(ir.section); // canonical section->key (shared with the loader)
        await env.R2?.put(r2Key, JSON.stringify(ir));
        const sourceEdition = edition ?? 'edition unknown (not captured from source header)';
        await upsertUfgsCorpusSection(env.DB, { section: ir.section, title: ir.title, r2Key, sourceEdition });
        await insertCorpusSource(env.DB, {
          sourceId: `cs-ufgs-${slug}`,
          kind: 'UFGS-MASTER',
          identifier: ir.section,
          edition: sourceEdition,
          r2Key,
        });
        // §3 (C4) — embed title + PART 1 scope into the `ufgs` Vectorize namespace
        // (remote-only recall enhancement). Never blocks ingest.
        const embedded = await embedUfgsSection(env, ctx, { section: ir.section, title: ir.title, scopeText: part1ScopeText(ir) });
        if (embedded) await markSectionEmbedded(env.DB, ir.section);
        results.push({ filename: f.filename, section: ir.section, ok: true, warnings: warnings.length, embedded });
      } catch (err) {
        results.push({ filename: f.filename, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    return json({ ok: true, ingested: ok, failed: results.length - ok, results });
  }

  // --- Part 6.1/6.2/6.4 — UMRL / UMSL / UFC criteria loaders (parsed rows in) ---
  if (path === '/admin/corpus/umrl' && req.method === 'POST') return loadRefList(req, env, 'UMRL');
  if (path === '/admin/corpus/umsl' && req.method === 'POST') return loadSubList(req, env);
  if (path === '/admin/corpus/criteria' && req.method === 'POST') return loadCriteria(req, env);
  // CHANGE-06 §1 (C5) — fetch REAL UFC criteria from the WBDG CIM API, load them
  // into `criteria` (real editions, G7), and optionally link them onto UFGS IR.
  if (path === '/admin/corpus/ufc-criteria' && req.method === 'POST') return loadUfcCriteria(req, env);

  return bad(`unknown admin corpus route ${path}`, 404);
}

// §6.1 — load a parsed UMRL into ref_list (list_id='UMRL') + corpus_source (G12).
async function loadRefList(req: Request, env: Env, listId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { edition?: string; rows?: any[] };
  if (!body.edition || !Array.isArray(body.rows)) return bad('edition + rows[] required');
  const stmts = body.rows.map((r) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO ref_list (rid, list_id, org, designation, edition_date, title, active, source_edition, verified_at, stale)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, datetime('now'), 0)`,
    ).bind(r.rid ?? `rid-${crypto.randomUUID().slice(0, 8)}`, listId, r.org, r.designation, r.editionDate ?? r.edition_date ?? '', r.title, body.edition),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await insertCorpusSource(env.DB, { kind: 'UMRL', identifier: 'UMRL', edition: body.edition });
  return json({ ok: true, loaded: stmts.length, edition: body.edition });
}

// §6.2 — load a parsed UMSL into sub_list (list_id='UMSL') + corpus_source.
async function loadSubList(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { edition?: string; rows?: any[] };
  if (!body.edition || !Array.isArray(body.rows)) return bad('edition + rows[] required');
  const stmts = body.rows.map((r) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO sub_list (usid, list_id, section, sd_code, item, default_class, notes, source_edition, verified_at, stale)
       VALUES (?1, 'UMSL', ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), 0)`,
    ).bind(r.usid ?? `usid-${crypto.randomUUID().slice(0, 8)}`, r.section, r.sdCode ?? r.sd_code ?? null, r.item, r.defaultClass ?? r.default_class ?? null, r.notes ?? null, body.edition),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await insertCorpusSource(env.DB, { kind: 'UMSL', identifier: 'UMSL', edition: body.edition });
  return json({ ok: true, loaded: stmts.length, edition: body.edition });
}

// §6.4 — load extracted UFC criteria into criteria (profile='ufc') + corpus_source.
// G7: the edition must be provided (captured from the PDF), never inferred here.
async function loadCriteria(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { document?: string; edition?: string; rows?: any[] };
  if (!body.document || !body.edition || !Array.isArray(body.rows))
    return bad('document + edition + rows[] required (G7 — edition captured from the source PDF, not inferred)');
  const stmts = body.rows.map((r) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO criteria (cid, profile, document, edition, clause, text, perf_level, verified_at, stale)
       VALUES (?1, 'ufc', ?2, ?3, ?4, ?5, ?6, datetime('now'), 0)`,
    ).bind(r.cid ?? `cid-${crypto.randomUUID().slice(0, 8)}`, body.document, body.edition, r.clause, r.text, r.perfLevel ?? null),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await insertCorpusSource(env.DB, { kind: 'UFC', identifier: body.document, edition: body.edition });
  return json({ ok: true, loaded: stmts.length, document: body.document, edition: body.edition });
}

// §1 (C5) — fetch a published UFC version from the WBDG CIM API, load its clauses
// into `criteria` (profile='ufc') with the edition CAPTURED FROM THE RESPONSE
// (G7 — never model memory), and optionally run the linkage enrichment over the
// given UFGS Section IRs. Remote-only ingest; degrades honestly when the API is
// unreachable. CSI classification IDs are never read (G14 — enforced in ufc-cim.ts).
async function loadUfcCriteria(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    versionId?: string;
    designation?: string;
    link?: boolean;
    sections?: string[];
  };
  const versionId = body.versionId ?? (body.designation ? UFC_VERSION_SEED[body.designation] : undefined);
  if (!versionId)
    return bad(
      body.designation
        ? `no versionId known for "${body.designation}" (CIM has no public search route; add it to UFC_VERSION_SEED out-of-band or pass versionId)`
        : 'versionId or a resolvable designation is required',
    );
  if (!isUuid(versionId)) return bad(`versionId must be a UUID (got "${versionId}")`);

  let content;
  try {
    content = await fetchUfcVersionContent(versionId);
  } catch (err) {
    const status = err instanceof CimError ? err.status ?? 502 : 502;
    return json({ error: `CIM fetch failed: ${err instanceof Error ? err.message : String(err)}` }, status);
  }

  // G7 HARD CONSTRAINT: no edition backed by the response -> do NOT load; flag it.
  if (!content.edition) {
    return json(
      {
        error: 'edition-unconfirmed',
        detail: `The CIM criterion block for ${content.criterion.designation || versionId} carries no versionNumber/datePublished; the rows are NOT loaded (G7). Flag for manual edition entry.`,
        designation: content.criterion.designation || null,
      },
      422,
    );
  }

  const document = content.criterion.designation || `UFC (version ${versionId})`;
  const slug = document.replace(/[^0-9A-Za-z]+/g, '-');
  const rows = content.clauses.map((c, i) => ({
    cid: `cid-ufc-${slug}-${i}`.toLowerCase(),
    clause: c.clause,
    text: c.text,
  }));
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO criteria (cid, profile, document, edition, clause, text, perf_level, verified_at, stale)
       VALUES (?1, 'ufc', ?2, ?3, ?4, ?5, NULL, datetime('now'), 0)`,
    ).bind(r.cid, document, content.edition, r.clause, r.text),
  );
  if (stmts.length) await env.DB.batch(stmts);
  await insertCorpusSource(env.DB, {
    kind: 'UFC',
    identifier: document,
    edition: content.edition,
    criterionId: content.criterion.criterionId, // C6.2 — enables the staleness Cron
  });

  const result: Record<string, unknown> = {
    ok: true,
    document,
    edition: content.edition,
    loaded: rows.length,
    changeNotice: content.criterion.changeNotice ?? null,
  };

  // Optional §1.3 linkage enrichment over the requested Section IRs (re-runnable;
  // flag-don't-guess). Uses ALL loaded UFC criteria as candidates.
  if (body.link && Array.isArray(body.sections) && body.sections.length) {
    const index = buildCriteriaIndex(await loadUfcCandidates(env.DB));
    const linkReports: unknown[] = [];
    for (const section of body.sections) {
      linkReports.push(await linkCorpusSection(env, section, index));
    }
    result.linkage = linkReports;
  }
  return json(result);
}
