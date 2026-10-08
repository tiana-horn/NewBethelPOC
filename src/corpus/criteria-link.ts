// CHANGE-06 §1.3 (C5) — the criteria-linkage enrichment pass. Attaches a
// `criteriaRef` (a `criteria.cid`) onto UFGS Section-IR paragraphs by ranking the
// paragraph's text against candidate UFC clause text. This is a RANKING aid over
// already-ingested, edition-backed `criteria` rows — it authors nothing (G1/G7
// unaffected). It runs as a re-runnable enrichment over the R2 Section IR (the
// caller re-writes the IR JSON), so it is reversible per section.
//
// FLAG-DON'T-GUESS (G14 / G-MAN): where a paragraph cannot be mapped to a clause
// with confidence, `criteriaRef` is left UNSET and the paragraph is reported as
// unresolved — the choice then falls to the documented UFGS default (G13.2),
// exactly as before. A `criteriaRef` is NEVER fabricated.
//
// The join key is the UFGS section number (the caller scopes `candidates` to the
// UFC criteria relevant to the manual). The CSI `masterFormatId`/`uniFormatId`
// are NOT used as a join key or anywhere else.
// MasterFormat/UniFormat IDs intentionally excluded pending CSI license.

import { eachParagraph } from '../shared/section-ir';
import { tokenize } from '../manual/sec-match';
import { ufgsCorpusR2Key } from './ufgs-store';
import type { Env } from '../env';
import type { SectionIR } from '../shared/types';

export interface CriteriaCandidate {
  cid: string;
  clause: string;
  text: string;
  document?: string;
}

export interface LinkOptions {
  minSharedTokens: number; // a match must share at least this many distinctive tokens
  minScore: number; // and clear this idf-weighted cosine threshold
  overwrite: boolean; // re-link paragraphs that already carry a criteriaRef
}
export const DEFAULT_LINK_OPTIONS: LinkOptions = {
  minSharedTokens: 3,
  minScore: 0.18,
  overwrite: false,
};

export interface LinkResult {
  ir: SectionIR;
  linked: { paragraphId: string; cid: string; clause: string; score: number }[];
  unresolved: { paragraphId: string; reason: string }[];
  candidateCount: number;
}

interface IndexedCandidate {
  cand: CriteriaCandidate;
  tokens: Set<string>;
  norm: number; // cached idf-weighted L2 norm (computed once at index build)
}

// A prebuilt candidate index: the tokenized/normed candidates, the idf table, and
// an INVERTED index (token -> candidate indices). The inverted index lets each
// paragraph score ONLY the candidates that share ≥1 token — the rest have cosine
// 0 and can never win — turning an O(paragraphs × all-candidates) scan (35k+ UFC
// clauses) into a small per-paragraph lookup. Build ONCE and reuse across every
// section in a manual run.
export interface CriteriaIndex {
  indexed: IndexedCandidate[];
  idf: Map<string, number>;
  inverted: Map<string, number[]>;
}

export function buildCriteriaIndex(candidates: CriteriaCandidate[]): CriteriaIndex {
  const base = candidates
    .map((cand) => ({ cand, tokens: new Set(tokenize(`${cand.clause} ${cand.text}`)) }))
    .filter((c) => c.tokens.size > 0);
  // idf over the candidate corpus.
  const df = new Map<string, number>();
  for (const c of base) for (const t of c.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const n = base.length || 1;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  // cache each candidate's idf-weighted norm + build the inverted token index.
  const indexed: IndexedCandidate[] = [];
  const inverted = new Map<string, number[]>();
  base.forEach((c, i) => {
    let sq = 0;
    for (const t of c.tokens) {
      const w = idf.get(t) ?? 1;
      sq += w * w;
      const arr = inverted.get(t);
      if (arr) arr.push(i);
      else inverted.set(t, [i]);
    }
    indexed.push({ cand: c.cand, tokens: c.tokens, norm: Math.sqrt(sq) });
  });
  return { indexed, idf, inverted };
}

// Link over a PREBUILT index (see buildCriteriaIndex). Identical result to scoring
// every candidate — the inverted index only skips zero-overlap candidates.
export function linkIRWithIndex(
  ir: SectionIR,
  index: CriteriaIndex,
  options: Partial<LinkOptions> = {},
): LinkResult {
  const opt = { ...DEFAULT_LINK_OPTIONS, ...options };
  const { indexed, idf, inverted } = index;
  const linked: LinkResult['linked'] = [];
  const unresolved: LinkResult['unresolved'] = [];

  for (const { paragraph } of eachParagraph(ir)) {
    if (paragraph.criteriaRef && !opt.overwrite) continue; // idempotent re-run
    const paraTokens = [...new Set(tokenize(paragraph.text))];
    if (paraTokens.length === 0) continue; // headings / empty — nothing to link
    const paraNorm = Math.sqrt(paraTokens.reduce((a, t) => a + (idf.get(t) ?? 1) ** 2, 0));

    // Candidate subset = union of the inverted-index postings for the paragraph's
    // tokens (only candidates sharing ≥1 token). dot/shared accumulated per hit.
    const dot = new Map<number, number>();
    const shared = new Map<number, number>();
    for (const t of paraTokens) {
      const postings = inverted.get(t);
      if (!postings) continue;
      const w2 = (idf.get(t) ?? 1) ** 2;
      for (const i of postings) {
        dot.set(i, (dot.get(i) ?? 0) + w2);
        shared.set(i, (shared.get(i) ?? 0) + 1);
      }
    }

    let best: { cand: CriteriaCandidate; sim: number; shared: number } | null = null;
    for (const [i, d] of dot) {
      const denom = paraNorm * indexed[i].norm;
      const sim = denom > 0 ? d / denom : 0;
      if (sim <= 0) continue;
      if (!best || sim > best.sim) best = { cand: indexed[i].cand, sim, shared: shared.get(i) ?? 0 };
    }

    if (best && best.sim >= opt.minScore && best.shared >= opt.minSharedTokens) {
      paragraph.criteriaRef = best.cand.cid;
      linked.push({ paragraphId: paragraph.id, cid: best.cand.cid, clause: best.cand.clause, score: Math.round(best.sim * 1000) / 1000 });
    } else {
      // Left unresolved on purpose — the choice defaults via G13.2. Do NOT set a
      // criteriaRef we cannot back (G14 / G-MAN).
      delete paragraph.criteriaRef;
      unresolved.push({
        paragraphId: paragraph.id,
        reason: best ? `best match ${best.cand.cid} below threshold (sim=${best.sim.toFixed(3)}, shared=${best.shared})` : 'no candidate overlap',
      });
    }
  }

  return { ir, linked, unresolved, candidateCount: indexed.length };
}

// Convenience wrapper: build the index and link one IR (used by single-section
// callers and unit tests). Multi-section callers should build the index ONCE
// (buildCriteriaIndex) and call linkIRWithIndex per section.
export function linkCriteriaToIR(
  ir: SectionIR,
  candidates: CriteriaCandidate[],
  options: Partial<LinkOptions> = {},
): LinkResult {
  return linkIRWithIndex(ir, buildCriteriaIndex(candidates), options);
}

// ============================================================================
// I/O-side helpers — load candidates from D1 and link R2 corpus IRs in place.
// Shared by the admin ingest endpoint AND the ManualWorkflow auto-link step, so
// linkage behaves identically whether triggered by ingest or by a manual run.
// ============================================================================

// Candidate clauses for linkage = every loaded UFC criterion (edition-backed, G7).
export async function loadUfcCandidates(db: D1Database): Promise<CriteriaCandidate[]> {
  const res = await db
    .prepare(`SELECT cid, clause, text, document FROM criteria WHERE profile = 'ufc'`)
    .all<{ cid: string; clause: string; text: string; document: string }>();
  return (res.results ?? []).map((r) => ({ cid: r.cid, clause: r.clause, text: r.text, document: r.document }));
}

export interface SectionLinkReport {
  section: string;
  ok: boolean;
  error?: string;
  linked?: number;
  unresolved?: number;
  candidateCount?: number;
}

// Load one section's shared corpus IR from R2, run the linkage pass against a
// PREBUILT criteria index, and re-write the IR JSON (reversible per section).
// Never throws — a missing/broken IR is reported, not fatal.
export async function linkCorpusSection(
  env: Env,
  section: string,
  index: CriteriaIndex,
): Promise<SectionLinkReport> {
  const r2Key = ufgsCorpusR2Key(section);
  const obj = await env.R2?.get(r2Key);
  if (!obj) return { section, ok: false, error: `no R2 IR at ${r2Key}` };
  let ir: SectionIR;
  try {
    ir = JSON.parse(await obj.text()) as SectionIR;
  } catch (err) {
    return { section, ok: false, error: `IR parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const report = linkIRWithIndex(ir, index);
  await env.R2?.put(r2Key, JSON.stringify(report.ir));
  return { section, ok: true, linked: report.linked.length, unresolved: report.unresolved.length, candidateCount: report.candidateCount };
}

// Link a set of UFGS sections against the loaded UFC criteria. Builds the criteria
// index ONCE (not per section — 35k+ clauses). Returns [] as a no-op when NO UFC
// criteria are loaded (offline / not yet ingested) — the unmapped choices then
// fall to the UFGS default (G13.2), exactly as before. Safe to call on every run.
export async function linkCorpusSections(env: Env, sections: string[]): Promise<SectionLinkReport[]> {
  const candidates = await loadUfcCandidates(env.DB);
  if (candidates.length === 0) return [];
  const index = buildCriteriaIndex(candidates);
  const reports: SectionLinkReport[] = [];
  for (const section of sections) reports.push(await linkCorpusSection(env, section, index));
  return reports;
}
