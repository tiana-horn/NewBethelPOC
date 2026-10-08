// CHANGE-06 Part 1 (C5) — WBDG CIM public API client for real UFC technical
// criteria. Consumes the API; NEVER scrapes the SPA. The content endpoints are
// public (no API key — probe-confirmed 2026-08-20); only the collection listing
// and search routes are auth-gated, so criterion/version UUIDs are obtained
// out-of-band (a committed seed map + any known versionId).
//
// HARD LICENSING CONSTRAINT (G14 / §1.4): the CIM `masterFormatId` and
// `uniFormatId` fields are the licensed CSI classification IDs. They are NEVER
// destructured, read-into-persisted-state, stored, or emitted here or anywhere
// downstream, and no MasterFormat<->UniFormat correspondence is ever derived.
// The extractor below builds NEW clean objects containing ONLY the allowed
// provenance/text fields — it never returns the raw `data` node.
// MasterFormat/UniFormat IDs intentionally excluded pending CSI license.

export const CIM_BASE = 'https://api.digital.wbdg.org';

// The `criterion` block from a PublishedContentDto — provenance ONLY, all from the
// API response (G7), never model memory. No classification IDs (G14).
export interface UfcCriterionMeta {
  designation: string; // e.g. 'UFC 4-510-01'
  title: string;
  versionNumber: string | null;
  datePublished: string | null;
  changeNotice: string | null;
  // The criterion's stable UUID (NOT a CSI classification id — G14 only forbids
  // masterFormatId/uniFormatId). Captured at ingest so the staleness Cron can
  // check /v1/criteria/{criterionId}/versions without an out-of-band seed map.
  criterionId: string | null;
}

export interface UfcClause {
  clause: string; // section label / heading path, e.g. '2-1.3 EGRESS'
  text: string; // sentence / clause text
}

export interface UfcContent {
  criterion: UfcCriterionMeta;
  clauses: UfcClause[];
  // The edition string derived for the `criteria` table (G7): versionNumber,
  // else datePublished. `null` means the API response did NOT back an edition —
  // callers MUST refuse to load (flag for manual entry), never fabricate one.
  edition: string | null;
}

// NestJS response envelope: { statusCode, success, message, data|error, meta }.
interface CimEnvelope {
  statusCode?: number;
  success?: boolean;
  message?: string;
  data?: unknown;
  error?: unknown;
}

export class CimError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CimError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// CHANGE-07 §4 — every CIM request is bounded. Without this a hung connection
// wedges the quarterly staleness Cron (staleness-cron.ts awaits per source) and any
// admin ingest. A timeout/abort maps to CimError(504) so callers' existing catches
// (admin.ts try/catch; the cron's per-source catch) record it and move on.
const CIM_TIMEOUT_MS = 10_000;
async function cimFetch(doFetch: FetchLike, url: string): Promise<Response> {
  try {
    return await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIM_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof CimError) throw err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError')
      throw new CimError(`CIM request timed out after ${CIM_TIMEOUT_MS}ms: ${url}`, 504);
    throw new CimError(err instanceof Error ? err.message : String(err), 502);
  }
}

// GET /v1/versions/{versionId}/content — the primary content endpoint (§1.1).
export async function fetchUfcVersionContent(
  versionId: string,
  opts: { fetchImpl?: FetchLike; base?: string } = {},
): Promise<UfcContent> {
  const base = opts.base ?? CIM_BASE;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (!isUuid(versionId)) throw new CimError(`versionId must be a UUID (got "${versionId}")`, 400);

  const res = await cimFetch(doFetch, `${base}/v1/versions/${versionId}/content`);
  const body = (await res.json().catch(() => ({}))) as CimEnvelope;
  if (!res.ok || body.success === false) {
    throw new CimError(`CIM ${res.status} for version ${versionId}: ${body.message ?? 'request failed'}`, res.status);
  }
  if (body.data == null) throw new CimError(`CIM returned no data for version ${versionId}`, res.status);
  return extractPublishedContent(body.data);
}

// GET /v1/criteria/{criterionId}/versions — version history (used by the Part 2
// staleness Cron to discover a newer edition). Returns the raw list of version
// summaries with an edition label each; classification IDs are never read.
export interface UfcVersionSummary {
  versionId: string | null;
  versionNumber: string | null;
  datePublished: string | null;
  changeNotice: string | null;
}
export async function fetchUfcVersionHistory(
  criterionId: string,
  opts: { fetchImpl?: FetchLike; base?: string } = {},
): Promise<UfcVersionSummary[]> {
  const base = opts.base ?? CIM_BASE;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (!isUuid(criterionId)) throw new CimError(`criterionId must be a UUID (got "${criterionId}")`, 400);
  const res = await cimFetch(doFetch, `${base}/v1/criteria/${criterionId}/versions`);
  const body = (await res.json().catch(() => ({}))) as CimEnvelope;
  if (!res.ok || body.success === false) {
    throw new CimError(`CIM ${res.status} for criterion ${criterionId} versions: ${body.message ?? 'failed'}`, res.status);
  }
  const list = Array.isArray(body.data) ? body.data : [];
  return list.map((v) => summarizeVersion(v as Record<string, unknown>));
}

// --- Pure extraction (no network) — unit-testable, G14-clean ----------------

// Read ONLY the allowed provenance fields off the criterion block. Never touches
// masterFormatId / uniFormatId (they are not named anywhere in this function).
function readCriterionMeta(node: Record<string, unknown> | undefined): UfcCriterionMeta {
  const c = node ?? {};
  return {
    designation: str(c.designation) ?? str(c.number) ?? '',
    title: str(c.title) ?? '',
    versionNumber: str(c.versionNumber),
    datePublished: str(c.datePublished) ?? str(c.publishedDate),
    changeNotice: str(c.changeNotice),
    criterionId: str(c.criterionId) ?? str(c.id),
  };
}

function summarizeVersion(v: Record<string, unknown>): UfcVersionSummary {
  return {
    versionId: str(v.versionId) ?? str(v.id),
    versionNumber: str(v.versionNumber),
    datePublished: str(v.datePublished) ?? str(v.publishedDate),
    changeNotice: str(v.changeNotice),
  };
}

export function extractPublishedContent(data: unknown): UfcContent {
  const root = (data ?? {}) as Record<string, unknown>;
  const criterion = readCriterionMeta((root.criterion ?? root.criteria) as Record<string, unknown> | undefined);
  const clauses: UfcClause[] = [];
  // The section tree may hang off any of these keys depending on the endpoint.
  const treeRoots = firstArray(root.sections, root.content, root.body, root.children, root.tree);
  for (const n of treeRoots) walkSection(n, '', clauses);
  const edition = criterion.versionNumber?.trim() || criterion.datePublished?.trim() || null;
  return { criterion, clauses, edition };
}

// Tolerant recursive walk of the section tree. Collects a heading path as the
// clause label and any sentence/paragraph text as the clause text. Deliberately
// shape-tolerant (the DTO nests under several possible keys); it only ever reads
// text/label fields — never classification IDs.
function walkSection(node: unknown, parentLabel: string, out: UfcClause[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  const num = str(n.number) ?? str(n.label) ?? str(n.section);
  const heading = str(n.title) ?? str(n.heading) ?? str(n.name);
  const label = [parentLabel, [num, heading].filter(Boolean).join(' ').trim()].filter(Boolean).join(' > ');

  for (const text of collectText(n)) {
    const t = text.trim();
    if (t) out.push({ clause: label || heading || num || 'UFC', text: t });
  }
  for (const child of firstArray(n.sections, n.children, n.subsections, n.items, n.paragraphs)) {
    walkSection(child, label, out);
  }
}

// Pull sentence/paragraph text out of a node without recursing into child
// sections (those are walked separately for their own labels).
function collectText(n: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const direct = str(n.text) ?? str(n.content) ?? str(n.value);
  if (direct) texts.push(direct);
  const sentences = firstArray(n.sentences, n.lines);
  for (const s of sentences) {
    if (typeof s === 'string') texts.push(s);
    else if (s && typeof s === 'object') {
      const t = str((s as Record<string, unknown>).text) ?? str((s as Record<string, unknown>).content);
      if (t) texts.push(t);
    }
  }
  return texts;
}

// --- helpers ---------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}
function firstArray(...vals: unknown[]): unknown[] {
  for (const v of vals) if (Array.isArray(v)) return v;
  return [];
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// Out-of-band discovery: designation -> criterion/version UUID. CIM has NO public
// list/search route, so this seed map is how a designation resolves to an id. It
// is committed empty on purpose — real UUIDs are added out-of-band once obtained
// (an authenticated snapshot listing or a known starting versionId). Never guess
// a UUID; an unknown designation is a hard "not resolvable", not a fabrication.
export const UFC_VERSION_SEED: Record<string, string> = {
  // 'UFC 4-510-01': '<versionId-uuid>',   // add out-of-band
};
export const UFC_CRITERION_SEED: Record<string, string> = {
  // 'UFC 4-510-01': '<criterionId-uuid>', // add out-of-band
};
