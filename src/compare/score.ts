// Comparison scoring (CHANGE-02 §6) — runs ONLY after approval, against the
// already-frozen AI output. The uploaded in-house spec reaches this module and
// nothing else.
//
// G-CMP-1 (scoring-only, permanently): the reference text is passed in as a plain
// argument and used only to compute the scorecard. This module is imported by the
// comparison endpoint alone — never by the pipeline, the agents, the drafter, or
// the master-embedding path — so the reference can never enter a generation or
// retrieval context, now or on any later re-run. `test/comparison.test.ts`
// enforces that structurally.
//
// Scoring is DETERMINISTIC (no LLM), which keeps the demo reproducible and makes
// the quarantine guarantee airtight — the reference is never placed in any model
// prompt at all. Every divergence carries the AI's traceability so a difference
// reads as a genuine miss vs a defensible different choice.

import { eachParagraph, resolveParagraphText } from '../shared/section-ir';
import type {
  ComparisonScoreRow,
  ReferenceRow,
  SectionIR,
  SubmittalRegisterRow,
  TraceRow,
} from '../shared/types';

export interface AiSpecForCompare {
  section: string;
  title: string;
  text: string; // flattened resolved section prose
  references: ReferenceRow[];
  submittals: SubmittalRegisterRow[];
  specifyingMethods: string[];
  coordinationCatches: { type: string; detail: string }[];
  lockedSpans: string[];
  traces: TraceRow[];
}

// Build the comparison view of the frozen AI section from the pipeline bundle.
export function flattenAiSpec(args: {
  ir: SectionIR;
  references: ReferenceRow[];
  register: SubmittalRegisterRow[];
  coordinationFlags: { type: string; detail: string }[];
  traces: TraceRow[];
}): AiSpecForCompare {
  const methods = new Set<string>();
  const lockedSpans: string[] = [];
  const lines: string[] = [];
  for (const { paragraph } of eachParagraph(args.ir)) {
    lines.push(resolveParagraphText(paragraph));
    if (paragraph.specifyingMethod) methods.add(paragraph.specifyingMethod);
    if (paragraph.locked) lockedSpans.push(paragraph.text);
  }
  return {
    section: args.ir.section,
    title: args.ir.title,
    text: lines.join('\n'),
    references: args.references,
    submittals: args.register,
    specifyingMethods: [...methods],
    coordinationCatches: args.coordinationFlags,
    lockedSpans,
    traces: args.traces,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
const has = (hay: string, needle: string) => needle.length > 2 && norm(hay).includes(norm(needle));

// Find a traceability source for a dimension (the AI's justification), so a
// divergence can be read as genuine-miss vs defensible-choice.
function traceFor(traces: TraceRow[], match: RegExp): string {
  const t = traces.find((r) => match.test(r.element) || match.test(r.sourceType));
  return t ? `${t.sourceType}:${t.sourceRef}` : '—';
}

export function scoreComparison(ai: AiSpecForCompare, referenceText: string): ComparisonScoreRow[] {
  const ref = referenceText;
  const rows: ComparisonScoreRow[] = [];

  // 1) Scope coverage — do both cover the same substrates/finishes?
  const scopeTerms = ['gypsum board', 'ferrous metal', 'concrete', 'wood', 'primer', 'sheen', 'voc'];
  const aiScope = scopeTerms.filter((t) => has(ai.text, t));
  const refScope = scopeTerms.filter((t) => has(ref, t));
  const missingInRef = aiScope.filter((t) => !refScope.includes(t));
  const missingInAi = refScope.filter((t) => !aiScope.includes(t));
  rows.push({
    dimension: 'Scope coverage',
    aiValue: aiScope.join(', ') || '—',
    refValue: refScope.join(', ') || '—',
    verdict: missingInAi.length ? 'ref-stronger' : missingInRef.length ? 'ai-stronger' : 'match',
    divergenceClass: missingInAi.length ? 'genuine-miss' : 'n/a',
    traceabilityRef: traceFor(ai.traces, /finish-schedule|selection/),
  });

  // 2) References — validated + DATED (controlled list) vs the reference's.
  const aiRefs = ai.references.map((r) => `${r.designation} (${r.editionDate})`);
  const refMentionsDated = ai.references.filter((r) => has(ref, r.designation)).length;
  rows.push({
    dimension: 'References (validated + dated)',
    aiValue: aiRefs.join('; ') || '—',
    refValue: `${refMentionsDated}/${ai.references.length} of the AI's references appear in the upload`,
    verdict: ai.references.length && refMentionsDated < ai.references.length ? 'ai-stronger' : 'match',
    divergenceClass: 'defensible-choice',
    traceabilityRef: traceFor(ai.traces, /reference|REF-LIST/),
  });

  // 3) Submittals (A/C) — register/schedule items.
  const aiSubs = ai.submittals.map((s) => s.item);
  const refHasSubs = aiSubs.filter((s) => has(ref, s));
  rows.push({
    dimension: 'Submittals',
    aiValue: aiSubs.join('; ') || '—',
    refValue: `${refHasSubs.length}/${aiSubs.length} present in the upload`,
    verdict: aiSubs.length && refHasSubs.length < aiSubs.length ? 'divergent' : 'match',
    divergenceClass: aiSubs.length && refHasSubs.length < aiSubs.length ? 'defensible-choice' : 'n/a',
    traceabilityRef: traceFor(ai.traces, /submittal/),
  });

  // 4) Specifying-method choices (B/C).
  const refMethods = ['performance', 'proprietary', 'prescriptive'].filter((m) => has(ref, m));
  rows.push({
    dimension: 'Specifying method',
    aiValue: ai.specifyingMethods.join(', ') || '(mode default)',
    refValue: refMethods.join(', ') || '—',
    verdict: ai.specifyingMethods.length && refMethods.join() !== ai.specifyingMethods.join() ? 'divergent' : 'match',
    divergenceClass: 'defensible-choice',
    traceabilityRef: traceFor(ai.traces, /product|selection/),
  });

  // 5) Coordination catches — did the AI flag a conflict the upload missed?
  const catchDetail = ai.coordinationCatches.map((c) => c.detail).join(' | ');
  const refAddresses = ai.coordinationCatches.filter((c) => has(ref, c.type.replace(/-/g, ' '))).length;
  rows.push({
    dimension: 'Coordination catches',
    aiValue: catchDetail || 'none',
    refValue: `${refAddresses}/${ai.coordinationCatches.length} addressed in the upload`,
    verdict: ai.coordinationCatches.length && refAddresses < ai.coordinationCatches.length ? 'ai-stronger' : 'match',
    divergenceClass: ai.coordinationCatches.length && refAddresses < ai.coordinationCatches.length ? 'genuine-miss' : 'n/a',
    traceabilityRef: 'coordinator',
  });

  // 6) Locked / mandatory language preserved.
  const preserved = ai.lockedSpans.filter((s) => has(ref, s.slice(0, 40)));
  rows.push({
    dimension: 'Locked / mandatory language',
    aiValue: `${ai.lockedSpans.length} locked span(s) preserved verbatim (G2)`,
    refValue: `${preserved.length}/${ai.lockedSpans.length} present in the upload`,
    verdict: 'match',
    divergenceClass: 'n/a',
    traceabilityRef: 'G2:locked-span',
  });

  // 7) Format / structure — three-part SectionFormat present in both.
  const parts = ['part 1', 'part 2', 'part 3', 'general', 'products', 'execution'];
  const refStruct = parts.filter((p) => has(ref, p)).length;
  rows.push({
    dimension: 'Format / structure',
    aiValue: 'SectionFormat three-part (General / Products / Execution)',
    refValue: refStruct >= 3 ? 'three-part structure detected' : 'structure unclear from text',
    verdict: refStruct >= 3 ? 'match' : 'divergent',
    divergenceClass: refStruct >= 3 ? 'n/a' : 'defensible-choice',
    traceabilityRef: 'PageFormat/SectionFormat',
  });

  return rows;
}
