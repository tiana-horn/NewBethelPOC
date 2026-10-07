// Guardrail evaluation — THE single place guardrail statuses are produced, for
// the WHOLE set (blueprint §2.3). Rules:
//   1. Each guardrail is derived from real run state (a returned violation list,
//      a flag set, a trace count, a render mode) or is an explicitly documented
//      STRUCTURAL invariant — never a bare literal buried in a manifest builder.
//   2. `assembleGuardrails` enforces EXHAUSTIVENESS over GuardrailId: if ANY id
//      in ALL_GUARDRAILS is missing (never evaluated), it THROWS. A guardrail
//      that isn't evaluated therefore cannot be silently recorded as "pass".
//   3. A guardrail that does not apply to this run is present with status 'n/a'
//      and evidence saying why — NEVER silently absent.
//
// This is the key improvement over the prior POC, which hard-enforced
// exhaustiveness for G1–G8 only and left G9/G11–G16/G-MAN/G-CMP-1 to live at
// their own points of use with no "all evaluated this run" assertion.

import type {
  GuardrailId,
  GuardrailResult,
  ManualCoordinationFlag,
  ValidationFlag,
} from './types';

export const ALL_GUARDRAILS: readonly GuardrailId[] = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9',
  'G11', 'G12', 'G13', 'G14', 'G15', 'G16',
  'G-MAN', 'G-CMP-1',
] as const;

// Assemble the complete guardrail map from individually-evaluated results.
// Throws on a duplicate OR a MISSING guardrail — no silent gaps.
export function assembleGuardrails(
  results: readonly GuardrailResult[],
): Record<GuardrailId, GuardrailResult> {
  const map = {} as Record<GuardrailId, GuardrailResult>;
  for (const r of results) {
    if (map[r.id]) throw new Error(`duplicate guardrail result: ${r.id}`);
    map[r.id] = r;
  }
  const missing = ALL_GUARDRAILS.filter((id) => !map[id]);
  if (missing.length) throw new Error(`missing guardrail result(s): ${missing.join(', ')}`);
  return map;
}

export function guardrailStatuses(
  map: Record<GuardrailId, GuardrailResult>,
): Record<GuardrailId, GuardrailResult['status']> {
  const out = {} as Record<GuardrailId, GuardrailResult['status']>;
  for (const id of ALL_GUARDRAILS) out[id] = map[id].status;
  return out;
}

// A run "fails guardrails" iff any evaluated guardrail is 'fail' ('n/a' never fails).
export function anyGuardrailFailed(map: Record<GuardrailId, GuardrailResult>): boolean {
  return ALL_GUARDRAILS.some((id) => map[id].status === 'fail');
}

const pass = (id: GuardrailId, evidence: string): GuardrailResult => ({ id, status: 'pass', evidence });
const fail = (id: GuardrailId, evidence: string): GuardrailResult => ({ id, status: 'fail', evidence });
const na = (id: GuardrailId, evidence: string): GuardrailResult => ({ id, status: 'n/a', evidence });

// ---- Per-guardrail evaluators (data in -> GuardrailResult out) ----

// G1/G4/G7 — validate-don't-generate. Derived from the OPEN (unresolved)
// validation flags, so reviewer resolutions at the blocking gate flip to pass.
export function flagGuardrails(flags: readonly ValidationFlag[]): GuardrailResult[] {
  const open = (...kinds: string[]) => flags.filter((f) => kinds.includes(f.kind) && !f.resolved);
  const g1 = open('reference-not-found', 'submittal-not-found');
  const g4 = open('product-unverifiable');
  const g7 = open('criteria-not-found');
  return [
    g1.length === 0
      ? pass('G1', 'All references/submittals resolved to controlled-list ids.')
      : fail('G1', `${g1.length} reference/submittal request(s) unresolved against the controlled list.`),
    g4.length === 0
      ? pass('G4', 'All basis-of-design products grounded in the product library.')
      : fail('G4', `${g4.length} product(s) unverifiable against the product library.`),
    g7.length === 0
      ? pass('G7', 'All criteria clauses/editions resolved from the criteria table.')
      : fail('G7', `${g7.length} criteria reference(s) unresolved against the criteria table.`),
  ];
}

export function lockedSpanGuardrail(lockedViolations: readonly string[]): GuardrailResult {
  return lockedViolations.length === 0
    ? pass('G2', 'All locked spans byte-identical before and after resolution.')
    : fail('G2', `Locked span(s) changed during resolution: ${lockedViolations.join(', ')}.`);
}

export function exclusivityGuardrail(violations: readonly string[]): GuardrailResult {
  return violations.length === 0
    ? pass('G3', 'Each requirement resolved by exactly one mechanism.')
    : fail('G3', `Requirement(s) resolved by multiple mechanisms: ${violations.join(', ')}.`);
}

export function traceGuardrail(traceCount: number): GuardrailResult {
  return traceCount > 0
    ? pass('G6', `${traceCount} traceability row(s) recorded.`)
    : fail('G6', 'No traceability rows recorded for this run.');
}

// Everything the harness needs to evaluate the full set for one run.
export interface GuardrailInput {
  scope: 'section' | 'manual';
  resolverGuardrails: readonly GuardrailResult[]; // G2, G3 (returned by the Resolver)
  validationFlags: readonly ValidationFlag[]; // -> G1, G4, G7
  traceCount: number; // -> G6
  // Manual scope:
  manualCoordinationFlags?: readonly ManualCoordinationFlag[]; // -> G9, G-MAN
  openInBookSelections?: number; // -> G15 (M-DECIDE)
  // Corpus provenance / staleness:
  anyCorpusStale?: boolean; // -> G11 (flag, never auto-adopt — stale is not a fail)
  corpusProvenanceOk?: boolean; // -> G12 (default true: every row traced to an ingest)
  classificationIdsDropped?: boolean; // -> G14 (default true: no CSI ids persisted)
  // Issued-output hygiene (assertSectionIssuedClean ran clean). undefined = not
  // yet at emit/freeze -> n/a.
  issuedHygieneClean?: boolean; // -> G13
  // Freeze/seal:
  pdfRender?: 'container' | 'worker-fallback'; // undefined = not frozen yet -> n/a
  pdfVerified?: boolean; // -> G16 (container render + pagination verified)
  comparisonQuarantined?: boolean; // -> G-CMP-1 (default true: structural)
}

// The one entry point: evaluate ALL guardrails from final run state and assemble
// them with the exhaustiveness guarantee. Every id in ALL_GUARDRAILS is present.
export function evaluateGuardrails(input: GuardrailInput): Record<GuardrailId, GuardrailResult> {
  const results: GuardrailResult[] = [];

  // G2, G3 from the Resolver.
  results.push(...input.resolverGuardrails);
  // G1, G4, G7 from validation flags.
  results.push(...flagGuardrails(input.validationFlags));
  // G6 from the trace count.
  results.push(traceGuardrail(input.traceCount));

  // G5, G8 — structural invariants of the architecture.
  results.push(pass('G5', 'HITL gates are blocking: gate3/gate5 (and M-DECIDE/M-COORD) reject decisions that leave items unresolved.'));
  results.push(pass('G8', 'No signing key is held and no seal/signature is applied; the certification block is a placeholder only.'));

  // G9 — cross-section reference-edition consistency (manual scope only).
  if (input.scope === 'manual') {
    const open = (input.manualCoordinationFlags ?? []).filter(
      (f) => f.kind === 'ref-edition-conflict' && f.status === 'open',
    );
    results.push(
      open.length === 0
        ? pass('G9', 'No open ref-edition conflicts across sections.')
        : fail('G9', `${open.length} open ref-edition conflict(s) across sections.`),
    );
  } else {
    results.push(na('G9', 'Single-section scope: no cross-section reference-edition comparison applies.'));
  }

  // G11 — corpus staleness is FLAGGED, never auto-adopted. A stale flag is a
  // human-review signal, not a run failure (G11 never blocks).
  results.push(
    input.anyCorpusStale
      ? pass('G11', 'Stale corpus source(s) flagged for human re-verification; none auto-adopted.')
      : pass('G11', 'No corpus source newer than its ingested edition.'),
  );

  // G12 — every authoritative row traces to a real ingest.
  results.push(
    input.corpusProvenanceOk === false
      ? fail('G12', 'An authoritative row has no corpus_source provenance.')
      : pass('G12', 'Every authoritative row traces to a corpus_source ingest.'),
  );

  // G13 — issued-output hygiene (assertSectionIssuedClean).
  if (input.issuedHygieneClean === undefined) {
    results.push(na('G13', 'Not yet at emit/freeze: issued-output hygiene not evaluated for this phase.'));
  } else {
    results.push(
      input.issuedHygieneClean
        ? pass('G13', 'Issued output carries no unresolved markup or Note-to-Designer leak.')
        : fail('G13', 'Issued output contains unresolved markup or a Note-to-Designer leak.'),
    );
  }

  // G14 — no licensed CSI classification ids ingested/persisted (structural).
  results.push(
    input.classificationIdsDropped === false
      ? fail('G14', 'A licensed CSI classification id (masterFormatId/uniFormatId) was persisted.')
      : pass('G14', 'No licensed CSI classification ids ingested or persisted (dropped at the extractor).'),
  );

  // G15 — M-DECIDE refuses an open in-book selection (manual scope only).
  if (input.scope === 'manual') {
    const open = input.openInBookSelections ?? 0;
    results.push(
      open === 0
        ? pass('G15', 'No open in-book selections remain at M-DECIDE.')
        : fail('G15', `${open} open in-book selection(s) remain; M-DECIDE cannot close.`),
    );
  } else {
    results.push(na('G15', 'Single-section scope: the book-level M-DECIDE gate does not apply.'));
  }

  // G16 — seal-grade PDF requires container render + pagination verification.
  if (input.pdfRender === undefined) {
    results.push(na('G16', 'Not frozen yet: no PDF produced for this phase.'));
  } else {
    const ok = input.pdfRender === 'container' && input.pdfVerified === true;
    results.push(
      ok
        ? pass('G16', 'Frozen PDF was container-rendered and pagination-verified.')
        : fail('G16', `Frozen PDF is ${input.pdfRender}${input.pdfVerified ? '' : ' / unverified'}: refused at seal.`),
    );
  }

  // G-MAN — honest manual scope (manual scope only).
  if (input.scope === 'manual') {
    const gap = (input.manualCoordinationFlags ?? []).filter(
      (f) => f.kind === 'seal-coverage-gap' && f.status === 'open',
    );
    results.push(
      gap.length === 0
        ? pass('G-MAN', 'Every division in the outline is covered by a sealing assignment; Div 00/01 presented honestly.')
        : fail('G-MAN', `${gap.length} division(s) present in the outline with no sealing coverage.`),
    );
  } else {
    results.push(na('G-MAN', 'Single-section scope: manual outline/seal-coverage honesty does not apply.'));
  }

  // G-CMP-1 — comparison upload permanently quarantined (structural).
  results.push(
    input.comparisonQuarantined === false
      ? fail('G-CMP-1', 'A comparison upload was read outside the scoring path.')
      : pass('G-CMP-1', 'Comparison upload is quarantined: never embedded, retrieved, or placed in a generation prompt.'),
  );

  return assembleGuardrails(results);
}
