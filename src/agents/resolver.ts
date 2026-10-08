// Resolver (mode-specific ruleset, selected by ctx.rulesetId — data-driven, no
// `mode === X` branch). CHANGE-01: `brackets` are now `selections`, and Mode C
// adds `kind: 'perf-level'` handled by the SAME selection-axis machinery.
//   ufgs       : resolve option/fill against project data + UFC criteria + tailoring
//                (G2/G3/G6/G13); the Resolver's core job — resolve or default,
//                never invent. (The Mode B commercial + Mode C public rulesets were
//                removed in CHANGE-05; only the UFGS ruleset remains.)
//
// G13 precedence for a UFGS selection (CHANGE-05 §5 / CHANGE-06 §1.3):
//   1. Project data  — the finish schedule + ExtractedProjectData features.
//   2. UFC criteria  — the clause linked by the paragraph's criteriaRef.
//      * only data speaks        -> resolve, basis 'project-data'
//      * only criteria speaks    -> resolve, basis 'ufc-criteria'
//      * both agree              -> resolve (basis 'project-data'), corroboration noted
//      * both CONFLICT           -> DO NOT pick; leave unresolved + note (a coordination
//                                   conflict, surfaced for review — not a resolver decision)
//   3. UFGS default  — a multi-option selection defaults to its first-listed option.
//      A single-option optional span with no support stays UNRESOLVED (flagged); there
//      is no documented include/omit default, and inventing one would violate G13.
// Nothing here free-writes a resolved value: an option/perf resolution MUST be one of
// the selection's own listed options (assertOptionsSubset throws otherwise), and a fill
// value must trace to project data / a documented default — never a model-composed string.

import type { Env } from '../env';
import { exclusivityGuardrail, lockedSpanGuardrail } from '../shared/guardrails';
import { allSelections, cloneIR, eachParagraph, isSelectionResolved, joinList, lockedSpansUnchanged } from '../shared/section-ir';
import type {
  ExtractedProjectData,
  FinishScheduleRow,
  ModeContext,
  Paragraph,
  ResolutionBasis,
  ResolutionConfidenceTier,
  ResolutionLogEntry,
  SectionIR,
  Selection,
  TailoringDecision,
  TraceRow,
} from '../shared/types';
import type { ResolveInput, ResolveOutput } from './contracts';

export async function run(env: Env, ctx: ModeContext, input: ResolveInput): Promise<ResolveOutput> {
  const before = cloneIR(input.ir);
  const ruleset = RULESETS[ctx.rulesetId];
  if (!ruleset) throw new Error(`Resolver: unknown rulesetId '${ctx.rulesetId}'`);

  const ir = cloneIR(input.ir);
  const log: ResolutionLogEntry[] = [];
  const traces: TraceRow[] = [];

  const exclusivityViolations = checkExclusivity(ir); // G3
  await ruleset(env, ctx, ir, input, log, traces);

  // G2 — a locked span that SURVIVES must be byte-identical. Resolving a selection
  // only sets `selection.resolved`/`.value`; it never touches `paragraph.text`, so
  // this passes for legitimate resolution. A paragraph omitted by a recorded
  // tailoring decision is not a violation; anything else is. Fail LOUDLY: a mutated
  // locked span is a bug, never a silent "fix".
  const omitted = new Set((ir.tailoring ?? []).filter((d) => d.effect === 'omit').map((d) => d.target));
  const locked = lockedSpansUnchanged(before, ir, omitted);
  if (!locked.ok)
    throw new Error(`G2 violation: locked span text changed during resolution (${locked.changed.join(', ')})`);

  return {
    ir,
    resolutionLog: { entries: log },
    traces,
    exclusivityViolations,
    lockedViolations: locked.changed, // always [] when the assertion above didn't throw
    guardrails: [lockedSpanGuardrail(locked.changed), exclusivityGuardrail(exclusivityViolations)],
  };
}

// ---- G3 (selection-mechanism exclusivity): a requirement is resolved by
// exactly ONE mechanism — tailoring, or a single selection kind. Covers Mode A
// (tailoring vs option/fill) and Mode C (perf-level vs option). ----
function checkExclusivity(ir: SectionIR): string[] {
  const mechs = new Map<string, Set<string>>();
  const add = (req: string | undefined, mech: string) => {
    if (!req) return;
    if (!mechs.has(req)) mechs.set(req, new Set());
    mechs.get(req)!.add(mech);
  };
  for (const { selection } of allSelections(ir)) add(selection.requirementId, `selection:${selection.kind}`);
  for (const { paragraph } of eachParagraph(ir)) if (paragraph.tailoring) add(paragraph.tailoring.requirementId, 'tailoring');
  const violations: string[] = [];
  for (const [req, set] of mechs) if (set.size > 1) violations.push(req);
  return violations;
}

type Ruleset = (
  env: Env,
  ctx: ModeContext,
  ir: SectionIR,
  input: ResolveInput,
  log: ResolutionLogEntry[],
  traces: TraceRow[],
) => Promise<void>;

// ============================================================================
// UFGS ruleset — option/fill selections resolved from project data + UFC criteria,
// defaulted to the documented UFGS default, or left flagged (G13). Plus tailoring.
// ============================================================================
const NAMED_UFGS = new Set(['substrate-scope', 'sheen-gwb', 'sheen-metal', 'voc-limit']);

const ufgsRuleset: Ruleset = async (env, ctx, ir, input, log, traces) => {
  // Structural tailoring FIRST (include/omit paragraphs), so selection resolution
  // only runs on surviving paragraphs and the G2 snapshot excludes omitted ones.
  applyTailoring(ctx, ir, traces);

  const substrates = scheduleSubstrates(input.schedule);
  const projectVocab = buildProjectVocab(input);
  const section = ir.section;
  // The whole loaded UFC corpus, indexed — the primary authority for which bracket
  // option applies (CHANGE-06). Cached across sections; empty when UFC isn't loaded.
  const ufcIndex = await getUfcIndex(env);

  for (const { paragraph, selection } of allSelections(ir)) {
    if (isSelectionResolved(selection)) continue; // idempotent
    const req = selection.requirementId ?? selection.id;
    if (NAMED_UFGS.has(req)) {
      resolveNamedUfgs(req, selection, input, substrates, log, traces);
      continue;
    }
    // General resolution for real-section selections (any UFGS section). Selections
    // inside locked ("shall/must") paragraphs ARE resolved — only the placeholder is
    // filled, never the mandatory prose (G2 asserts this after the fact).
    resolveGeneralUfgs(selection, paragraph, section, projectVocab, ufcIndex, log, traces);
  }
};

// The four hand-authored Painting requirements: real project-data matches with a
// documented UFGS default fallback. Routed through the same commit helpers so the
// G13 option-subset guard + traceability apply here too.
function resolveNamedUfgs(
  req: string,
  s: Selection,
  input: ResolveInput,
  substrates: string[],
  log: ResolutionLogEntry[],
  traces: TraceRow[],
): void {
  switch (req) {
    case 'substrate-scope': {
      const chosen = (s.options ?? []).filter((o) => substrates.includes(o));
      const fromData = chosen.length > 0;
      commitOption(s, chosen, 'finish-schedule', scheduleRef(input.schedule), 0.93,
        fromData ? `Substrates present in the finish schedule: ${joinList(chosen)}.` : 'No substrate scheduled; applied the UFGS default (no substrate included).',
        fromData ? 'project-data' : 'ufgs-default', fromData ? 'high' : 'medium-ufgs-default', log, traces);
      break;
    }
    case 'sheen-gwb': {
      const scheduled = sheenFor(input.schedule, 'gypsum board');
      const sheen = scheduled ?? 'eggshell'; // documented UFGS default for gypsum board
      commitOption(s, [sheen], 'finish-schedule', 'gypsum board rows', 0.9,
        scheduled ? `Sheen scheduled for gypsum board: ${sheen}.` : `No sheen scheduled; applied the UFGS default for gypsum board: ${sheen}.`,
        scheduled ? 'project-data' : 'ufgs-default', scheduled ? 'high' : 'medium-ufgs-default', log, traces);
      break;
    }
    case 'sheen-metal': {
      const scheduled = sheenFor(input.schedule, 'ferrous metal');
      const sheen = scheduled ?? 'semi-gloss'; // documented UFGS default for ferrous metal
      commitOption(s, [sheen], 'finish-schedule', 'ferrous metal rows', 0.9,
        scheduled ? `Sheen scheduled for ferrous metal: ${sheen}.` : `No sheen scheduled; applied the UFGS default for ferrous metal: ${sheen}.`,
        scheduled ? 'project-data' : 'ufgs-default', scheduled ? 'high' : 'medium-ufgs-default', log, traces);
      break;
    }
    case 'voc-limit': {
      const voc = input.params.vocLimitGL;
      if (voc == null) return; // no data -> unresolved (compliance flags it)
      commitFill(s, String(voc), 'project-criterion', 'sustainability: VOC limit', 0.95,
        `Maximum VOC content set from the project sustainability criterion: ${voc} g/L.`, 'project-data', 'high', log, traces);
      break;
    }
  }
}

// General G13 resolution for any UFGS selection: UFC criteria (the design
// authority for which option applies) + project data, else the documented UFGS
// default (a lower-confidence substitute), else flag. See the precedence in the
// file header.
function resolveGeneralUfgs(
  s: Selection,
  paragraph: Paragraph,
  section: string,
  projectVocab: ProjectVocab,
  ufcIndex: UfcIndex,
  log: ResolutionLogEntry[],
  traces: TraceRow[],
): void {
  // Fills: a blank has no listed alternatives, so neither project data nor a UFC
  // clause can be turned into a value DETERMINISTICALLY here (extracting a number
  // from prose would be guessing). Leave unresolved -> compliance flags it. The
  // named voc-limit handler is the deterministic exception.
  if (s.kind === 'fill') return;

  const opts = s.options ?? [];
  if (opts.length === 0) return;

  // The governing UFC clause — matched option-aware against the WHOLE loaded corpus
  // (always available when UFC is loaded), not just a pre-linked criteriaRef.
  const crit = ufcClauseForParagraph(ufcIndex, paragraph, opts.join(' '));
  const critVocab = crit ? new Set(tok(`${crit.clause} ${crit.text}`)) : undefined;

  // Match option-aware, keeping the LITERAL token that matched so the trace can
  // name a specific, locatable record (G6/G13) instead of a bare category label.
  const projHit = firstSupportedOption(opts, projectVocab.vocab);
  const projProposal = projHit?.option ?? null;
  const critProposal = critVocab ? (opts.find((o) => optionSupported(o, critVocab)) ?? null) : null;

  // Record the applicable UFC linkage on the paragraph (feeds the G7 criteria
  // matrix) whenever UFC informs the resolution — always the clause the resolver
  // ACTUALLY used, so the matrix and the resolution can never disagree.
  const linkCrit = () => {
    if (crit) paragraph.criteriaRef = crit.cid;
  };

  // A locatable pointer to the project record whose extracted value matched.
  const projRef = projHit ? projectVocab.provenance.get(projHit.token) ?? `project data (matched term "${projHit.token}")` : 'project data';
  const projTerm = projHit?.token ?? '';

  // Both sources speak.
  if (projProposal && critProposal) {
    if (projProposal === critProposal) {
      linkCrit();
      commitOption(s, [projProposal], 'project-data+ufc-criteria', `${projRef}; corroborated by UFC ${crit!.document} ${crit!.clause}`, 0.95,
        `Extracted project value "${projTerm}" (from ${projRef}) matches option "${projProposal}"; UFC ${crit!.document} clause "${crit!.clause}" independently corroborates it.`, 'project-data', 'high', log, traces);
    } else {
      // Conflict — do NOT silently pick one. Leave unresolved + record the conflict
      // as a review note (surfaced at compliance / M-DECIDE, coordination, not a
      // resolver decision).
      s.note = `Coordination conflict: project data indicates "${projProposal}", UFC ${crit!.document} indicates "${critProposal}". Left unresolved for review.`;
    }
    return;
  }
  // Only UFC criteria — the design authority. Resolve, basis 'ufc-criteria'.
  if (critProposal) {
    linkCrit();
    commitOption(s, [critProposal], crit!.document, `${crit!.document} clause "${crit!.clause}" (${crit!.edition})`, 0.9,
      `UFC ${crit!.document} clause "${crit!.clause}" specifies "${critProposal}"; no conflicting value in the project data.`, 'ufc-criteria', 'high', log, traces);
    return;
  }
  // Only project data — cite the SPECIFIC record + the literal extracted value that
  // matched (never the bare "project features" category label — that is unverifiable).
  if (projProposal) {
    commitOption(s, [projProposal], 'project-data', projRef, 0.85,
      `Extracted project value "${projTerm}" (from ${projRef}) matches option "${projProposal}"; no other listed option is supported by the project data.`, 'project-data', 'high', log, traces);
    return;
  }
  // Neither: multi-option -> documented UFGS default (a LOWER-CONFIDENCE substitute
  // for the applicable UFC criterion, surfaced as such). Single-option optional
  // span -> leave unresolved (flagged): no documented include/omit default.
  if (opts.length > 1) {
    const why =
      ufcIndex.count === 0
        ? 'No UFC criteria are loaded and no project data spoke to this choice'
        : crit
          ? `The applicable UFC criterion (${crit.document} "${crit.clause}") and the project data did not specify a choice among these options`
          : 'No applicable UFC criterion or project data spoke to this choice';
    // Cite the SEC clause the default comes from (the section + paragraph whose
    // first-listed bracket option is the documented UFGS default), not a bare label.
    const defaultRef = `UFGS ${section} ${paragraph.id} — first-listed bracket option`;
    commitOption(s, [opts[0]], 'ufgs-default', defaultRef, ufcIndex.count === 0 ? 0.6 : 0.7,
      `${why}; applied the documented UFGS default (the first-listed option "${opts[0]}" in ${section} ${paragraph.id}) — a lower-confidence substitute for the applicable UFC criterion.`,
      'ufgs-default', ufcIndex.count === 0 ? 'low-no-ufc' : 'medium-ufgs-default', log, traces);
  }
}

function applyTailoring(ctx: ModeContext, ir: SectionIR, traces: TraceRow[]): void {
  const decisions: TailoringDecision[] = [];
  for (const part of ir.parts)
    for (const article of part.articles) {
      article.paragraphs = article.paragraphs.filter((p) => {
        if (!p.tailoring) return true;
        const t = p.tailoring;
        const match =
          (t.includeWhen.agency ? t.includeWhen.agency === ctx.agency : true) &&
          (t.includeWhen.delivery ? t.includeWhen.delivery === ctx.delivery : true);
        decisions.push({
          requirementId: t.requirementId,
          axis: t.axis,
          chosen: t.axis === 'agency' ? String(ctx.agency) : String(ctx.delivery),
          effect: match ? 'include' : 'omit',
          target: p.id,
        });
        traces.push({
          element: `paragraph:${p.id}`,
          decision: match ? `include (${t.axis}=${t.axis === 'agency' ? ctx.agency : ctx.delivery})` : 'omit',
          sourceType: 'tailoring',
          sourceRef: t.requirementId,
          confidence: 1,
        });
        return match;
      });
    }
  if (decisions.length) ir.tailoring = decisions;
}

// CHANGE-05 §2 — the Mode B commercial ruleset (specifying method + "or equal" +
// product grounding) and the Mode C public-sector ruleset (perf-level + VOC +
// basis-of-design) were removed with those modes. Only the UFGS ruleset remains;
// the registry retains the seam so a future ruleset is a data addition, not a
// branch. `run()` above throws on an unknown ctx.rulesetId.
const RULESETS: Record<string, Ruleset> = {
  'ufgs-brackets-tailoring-v1': ufgsRuleset,
};

// ---- commit helpers (structural G13 + G6) --------------------------------

// G13 fabrication guard: a resolved option/perf value MUST be one of the
// selection's own listed options — never a novel string. Throws otherwise, so a
// free-written resolution is impossible by construction, not by convention.
function assertOptionsSubset(s: Selection, chosen: string[]): void {
  const allowed = new Set(s.options ?? []);
  for (const c of chosen)
    if (!allowed.has(c))
      throw new Error(`G13 fabrication: resolved value "${c}" for selection ${s.id} is not one of its options [${[...allowed].join(', ')}]`);
}

// Resolve an option/perf-level selection: guard, set, and trace — atomically, so a
// resolution can never reach `resolved` without a traceability row (G6).
function commitOption(
  s: Selection,
  chosen: string[],
  sourceType: string,
  sourceRef: string,
  confidence: number,
  justification: string,
  basis: ResolutionBasis,
  tier: ResolutionConfidenceTier,
  log: ResolutionLogEntry[],
  traces: TraceRow[],
): void {
  assertOptionsSubset(s, chosen);
  s.resolved = chosen;
  record(log, traces, s.id, chosen, sourceType, sourceRef, confidence, justification, basis, tier);
}

// Resolve a fill selection: value must be a non-empty data-derived string (never a
// model-composed sentence). Empty -> leave unresolved.
function commitFill(
  s: Selection,
  value: string,
  sourceType: string,
  sourceRef: string,
  confidence: number,
  justification: string,
  basis: ResolutionBasis,
  tier: ResolutionConfidenceTier,
  log: ResolutionLogEntry[],
  traces: TraceRow[],
): void {
  if (!value || !value.trim()) return;
  s.value = value;
  record(log, traces, s.id, value, sourceType, sourceRef, confidence, justification, basis, tier);
}

// ---- UFC criteria corpus (always available to the Resolver) ---------------
// UFC criteria drive which bracket option applies for a given facility. The
// Resolver consults the WHOLE loaded UFC corpus at resolution time (option-aware
// match) — NOT only a pre-linked criteriaRef — so a UFC criterion is available
// whenever it is loaded in D1, regardless of whether the ingest-time enrichment
// pass linked that specific paragraph. The corpus-wide index is CACHED per isolate
// (keyed on a cheap version) so it is built once, not once per section.

interface CriteriaClause {
  cid: string;
  clause: string;
  text: string;
  document: string;
  edition: string;
}
interface IndexedClause {
  c: CriteriaClause;
  tokens: Set<string>;
  norm: number;
}
interface UfcIndex {
  clauses: IndexedClause[];
  idf: Map<string, number>;
  inverted: Map<string, number[]>; // token -> clause indices
  byCid: Map<string, CriteriaClause>;
  count: number;
}

let ufcIndexCache: { version: string; index: UfcIndex } | null = null;
// Test seam: clear the module-level cache so a fresh criteria seed is picked up.
export function resetUfcIndexCache(): void {
  ufcIndexCache = null;
}

async function getUfcIndex(env: Env): Promise<UfcIndex> {
  // Cheap version probe — reuse the cached index while the UFC corpus is unchanged.
  const ver = await env.DB
    .prepare(`SELECT COUNT(*) AS n, MAX(verified_at) AS v FROM criteria WHERE profile = 'ufc'`)
    .first<{ n: number; v: string | null }>();
  const version = `${ver?.n ?? 0}:${ver?.v ?? ''}`;
  if (ufcIndexCache && ufcIndexCache.version === version) return ufcIndexCache.index;

  const res = await env.DB
    .prepare(`SELECT cid, clause, text, document, edition FROM criteria WHERE profile = 'ufc'`)
    .all<CriteriaClause>();
  const rows = res.results ?? [];
  const index = buildUfcIndex(rows);
  ufcIndexCache = { version, index };
  return index;
}

function buildUfcIndex(rows: CriteriaClause[]): UfcIndex {
  const base = rows
    .map((c) => ({ c, tokens: new Set(tok(`${c.clause} ${c.text}`)) }))
    .filter((x) => x.tokens.size > 0);
  const df = new Map<string, number>();
  for (const b of base) for (const t of b.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const n = base.length || 1;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  const clauses: IndexedClause[] = [];
  const inverted = new Map<string, number[]>();
  const byCid = new Map<string, CriteriaClause>();
  base.forEach((b, i) => {
    let sq = 0;
    for (const t of b.tokens) {
      const w = idf.get(t) ?? 1;
      sq += w * w;
      const arr = inverted.get(t);
      if (arr) arr.push(i);
      else inverted.set(t, [i]);
    }
    clauses.push({ c: b.c, tokens: b.tokens, norm: Math.sqrt(sq) });
    byCid.set(b.c.cid, b.c);
  });
  return { clauses, idf, inverted, byCid, count: rows.length };
}

// The best-matching UFC clause for a query (paragraph prose + the selection's
// options), via the inverted index. Conservative threshold: a weak/cross-domain
// match must NOT drive a resolution (better to fall to the UFGS default than to
// apply the wrong criterion).
function queryUfcIndex(index: UfcIndex, queryText: string, minScore = 0.22): CriteriaClause | null {
  const qtok = [...new Set(tok(queryText))];
  if (qtok.length === 0) return null;
  const qnorm = Math.sqrt(qtok.reduce((a, t) => a + (index.idf.get(t) ?? 1) ** 2, 0));
  const dot = new Map<number, number>();
  for (const t of qtok) {
    const posts = index.inverted.get(t);
    if (!posts) continue;
    const w2 = (index.idf.get(t) ?? 1) ** 2;
    for (const i of posts) dot.set(i, (dot.get(i) ?? 0) + w2);
  }
  let best: { c: CriteriaClause; score: number } | null = null;
  for (const [i, d] of dot) {
    const denom = qnorm * index.clauses[i].norm;
    const score = denom > 0 ? d / denom : 0;
    if (!best || score > best.score) best = { c: index.clauses[i].c, score };
  }
  return best && best.score >= minScore ? best.c : null;
}

// The UFC clause that governs a paragraph's choice: a single, option-aware direct
// match against the loaded corpus. This is the ONLY link mechanism — there is no
// second "trust the pre-linked criteriaRef" fallback stacked behind it (that
// mechanism was removed so one path can't mask the other's errors). Returns null
// when no UFC is loaded or nothing matches above threshold (-> honest UFGS default).
function ufcClauseForParagraph(index: UfcIndex, paragraph: Paragraph, optionText: string): CriteriaClause | null {
  if (index.count === 0) return null;
  const q = `${paragraph.text.replace(/\{\{[^}]*\}\}/g, ' ')} ${optionText}`;
  return queryUfcIndex(index, q);
}

// The project's own vocabulary — the finish schedule + ExtractedProjectData
// features (spaces / finishes / materials / IFC+COBie element keywords). A
// selection option is "supported" if it shares a distinctive token with this set.
// CHANGE-08 §7 — each distinctive token also carries a LOCATABLE provenance pointer
// (the specific schedule row / IFC space / material / element it came from) so a
// data-driven resolution's `sourceRef` names a real record, never a category label.
interface ProjectVocab {
  vocab: Set<string>;
  provenance: Map<string, string>; // token -> "finish schedule row 3 (Room 214) substrate 'concrete'"
}

function buildProjectVocab(input: ResolveInput): ProjectVocab {
  const vocab = new Set<string>();
  const provenance = new Map<string, string>();
  const add = (t: string | null | undefined, ref: string) => {
    for (const w of tok(t ?? '')) {
      vocab.add(w);
      if (!provenance.has(w)) provenance.set(w, ref); // first (most specific) wins
    }
  };
  input.schedule.forEach((r, i) => {
    const where = `finish schedule row ${i + 1}${r.room ? ` (Room ${r.room})` : ''}`;
    add(r.substrate, `${where} — substrate "${r.substrate}"`);
    add(r.finish, `${where} — finish "${r.finish}"`);
    add(r.sheen, `${where} — sheen "${r.sheen}"`);
    add(r.room, `${where}`);
  });
  const epd: ExtractedProjectData | undefined = input.extracted;
  if (epd) {
    (epd.finishes ?? []).forEach((f, i) => {
      add(f.finish, `finish schedule (extracted) row ${i + 1} — finish "${f.finish}" on "${f.substrate}"`);
      add(f.substrate, `finish schedule (extracted) row ${i + 1} — substrate "${f.substrate}"`);
    });
    for (const m of epd.materials ?? []) add(m.category, `IFC/COBie material "${m.category}"`);
    for (const sp of epd.spaces ?? []) add(sp.name, `IfcSpace "${sp.name ?? sp.id}"`);
    for (const e of epd.elements ?? []) {
      add(e.keyword, `building element ${e.ifcType} ("${e.keyword}", ${e.count} instance${e.count === 1 ? '' : 's'})`);
      for (const n of e.typeNames ?? []) add(n, `building element ${e.ifcType} type "${n}"`);
    }
  }
  return { vocab, provenance };
}

function optionSupported(optionText: string, vocab: Set<string>): boolean {
  // A distinctive token (kept by `tok`) shared with the project/criteria vocabulary.
  return tok(optionText).some((t) => vocab.has(t));
}

// Like optionSupported, but returns the FIRST option that matches together with the
// literal token that matched — so the resolution can cite the exact extracted value.
function firstSupportedOption(options: string[], vocab: Set<string>): { option: string; token: string } | null {
  for (const o of options) {
    const t = tok(o).find((x) => vocab.has(x));
    if (t) return { option: o, token: t };
  }
  return null;
}

// ---- helpers ----
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'shall', 'must', 'other', 'all', 'any', 'each',
  'per', 'not', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'into', 'onto', 'over', 'under',
  'such', 'when', 'where', 'which', 'their', 'they', 'them', 'will', 'may', 'can', 'used', 'use',
]);
function tok(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function scheduleSubstrates(schedule: FinishScheduleRow[]): string[] {
  const set = new Set<string>();
  for (const r of schedule) {
    const s = r.substrate.toLowerCase();
    if (s.includes('gypsum board')) set.add('gypsum board');
    if (s.includes('concrete')) set.add('concrete');
    if (s.includes('ferrous metal')) set.add('ferrous metal');
    if (s.includes('wood')) set.add('wood');
  }
  return [...set];
}

function sheenFor(schedule: FinishScheduleRow[], substrateKey: string): string | undefined {
  const row = schedule.find((r) => r.substrate.toLowerCase().includes(substrateKey));
  return row?.sheen?.toLowerCase() || undefined;
}

function scheduleRef(schedule: FinishScheduleRow[]): string {
  const rooms = [...new Set(schedule.map((r) => r.room))];
  return `rooms ${rooms.join(', ')}`;
}

function record(
  log: ResolutionLogEntry[],
  traces: TraceRow[],
  selectionId: string,
  chosen: string[] | string,
  sourceType: string,
  sourceRef: string,
  confidence: number,
  justification: string,
  basis: ResolutionBasis = 'project-data', // G13 (§5)
  confidenceTier?: ResolutionConfidenceTier, // labeled tier — the honest category
): void {
  log.push({ selectionId, chosen, sourceType, sourceRef, justification, confidence, basis, confidenceTier });
  traces.push({
    element: `selection:${selectionId}`,
    decision: Array.isArray(chosen) ? joinList(chosen) : chosen,
    sourceType,
    sourceRef,
    confidence,
    confidenceTier,
    basis,
    justification, // G6/G13 — the human-verifiable reasoning travels with the trace
  });
}
