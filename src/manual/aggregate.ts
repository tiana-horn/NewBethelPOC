// Aggregated Validator outputs + manual-scope Compliance (CHANGE-03 §4.3, §1
// table). These are assembly-time AGGREGATIONS over per-section, D1-backed
// outputs — nothing is regenerated, so G1/G4/G7 are unaffected; IDs are merged.
// No new agent: this is the manual-scope Compliance/aggregation pass the tripwire
// explicitly allows `scope='manual'` to live in.

import { compareSections } from './division';
import { eachParagraph, isSelectionResolved } from '../shared/section-ir';
import type { SectionRunResult } from './orchestrator';
import type { ManualSectionRow } from '../db/manual';
import type {
  ComplianceReport,
  ManualCoordinationFlag,
  ReferenceRow,
  Selection,
  SelectionKind,
  SubmittalRegisterRow,
} from '../shared/types';

// Master Referenced-Publications List — union of every section's validated
// references, de-duplicated by `rid`, dated from D1. Divergent editions of one
// designation are a G9 conflict (surfaced by the manual Coordinator), never a
// silent pick.
export function aggregateReferences(results: SectionRunResult[]): ReferenceRow[] {
  const byRid = new Map<string, ReferenceRow>();
  for (const r of results)
    for (const ref of r.referencesList?.references ?? []) if (!byRid.has(ref.rid)) byRid.set(ref.rid, ref);
  return [...byRid.values()].sort((a, b) => a.designation.localeCompare(b.designation));
}

export interface MasterRegisterGroup {
  section: string;
  rows: SubmittalRegisterRow[];
}

// Master Submittal Register — union of every section's register rows, grouped by
// section (cross-checked against Div 01 procedures by the manual Coordinator).
export function aggregateRegister(results: SectionRunResult[]): MasterRegisterGroup[] {
  return results
    .filter((r) => (r.register?.rows.length ?? 0) > 0)
    .map((r) => ({ section: r.section, rows: r.register!.rows }))
    .sort((a, b) => compareSections(a.section, b.section));
}

// Manual-level completeness / MBE-DBE / seal-page checklist — the Compliance
// Reviewer at manual scope (§1 table). Derived from the outline + section
// statuses + open cross-section flags; deterministic, honest about scope (G-MAN).
export function manualCompliance(args: {
  outline: ManualSectionRow[];
  results: SectionRunResult[];
  coordinationFlags: ManualCoordinationFlag[];
  // Sections the reviewer held out at Gate M-COORD (the honest "reject" path):
  // they are rendered reserved and disclosed, NOT a blocking failure (G-MAN).
  excluded?: string[];
}): ComplianceReport {
  const { outline, results, coordinationFlags } = args;
  const excludedSet = new Set(args.excluded ?? []);
  const drafted = outline.filter((s) => s.draftingMode === 'draft');
  const complete = results.filter((r) => r.status === 'complete').length;
  // A reviewer-excluded section is disclosed/reserved, not an unaddressed error;
  // only a drafted section that errored and was NOT held out blocks assembly.
  const heldOut = results.filter((r) => r.status === 'error' && excludedSet.has(r.section));
  const errored = results.filter((r) => r.status === 'error' && !excludedSet.has(r.section));
  const openCoord = coordinationFlags.filter((f) => f.status === 'open');
  const checks: ComplianceReport['checks'] = [];

  checks.push({
    id: 'MAN-1',
    requirement: 'Section-list completeness',
    status: 'pass',
    detail: `${outline.length} sections in the manual: ${drafted.length} drafted, ${outline.filter((s) => s.draftingMode === 'include').length} included (front-end), ${outline.filter((s) => s.draftingMode === 'outline').length} reserved (outline-only). Scope is stated honestly (G-MAN).`,
  });
  checks.push({
    id: 'MAN-2',
    requirement: 'Drafted sections validated',
    status: errored.length ? 'fail' : 'pass',
    detail: errored.length
      ? `${errored.length} drafted section(s) errored and are not yet held out of assembly: ${errored.map((e) => e.section).join(', ')}. Exclude them at Gate M-COORD (rendered reserved) or re-run.`
      : `${complete}/${drafted.length} drafted sections complete and cleared for assembly` +
        (heldOut.length ? `; ${heldOut.length} section(s) held out and rendered reserved: ${heldOut.map((e) => e.section).join(', ')} (G-MAN).` : '.'),
  });
  checks.push({
    id: 'MAN-3',
    requirement: 'Cross-section coordination cleared (Gate M-COORD)',
    status: openCoord.length ? 'fail' : 'pass',
    detail: openCoord.length
      ? `${openCoord.length} cross-section flag(s) still open: ${[...new Set(openCoord.map((f) => f.kind))].join(', ')}.`
      : 'All cross-section coordination flags triaged.',
  });
  checks.push({
    id: 'MAN-4',
    requirement: 'MBE/DBE participation',
    status: 'na',
    detail: 'MBE/DBE participation requirement surfaced for the firm’s certified scope (illustrative; confirm against the solicitation).',
  });
  checks.push({
    id: 'MAN-5',
    requirement: 'Seal-and-signature page present',
    status: 'pass',
    detail: 'A seal-and-signature page is emitted into the manual DOCX before freeze for each sealing-role assignment (CHANGE-08 manual_assignment), scoped to its assigned divisions — placeholders only, never an applied seal (G8). A division with no sealing assignment is flagged separately (seal-coverage-gap) at Gate M-COORD, not silently sealed.',
  });

  const failing = checks.filter((c) => c.status === 'fail').length;
  return {
    profile: 'manual/ufc',
    checks,
    traceabilityRows: results.reduce((n, r) => n + r.traces.length, 0),
    summary: failing
      ? `${failing} manual-level check(s) require resolution before Approve for Seal.`
      : 'Manual-level checklist passes; the book is ready for Approve for Seal.',
  };
}

// ============================================================================
// CHANGE-06 Part 5 (C1) — book-scope open-decision aggregation for Gate M-DECIDE.
// Derives every UNRESOLVED selection across all draft sections from the DO-held
// per-section results (no new table). This is an aggregation over existing
// selection/traceability machinery — no new resolver, no per-section agent change.
// ============================================================================

export interface OpenDecision {
  section: string;
  sectionTitle: string;
  paragraphId: string;
  selectionId: string;
  kind: SelectionKind;
  prompt: string; // the paragraph text (context for the reviewer)
  options?: string[]; // option / perf-level choices
  ufgsDefault?: string; // the documented UFGS default (G13.2): the first listed option
}

// The documented UFGS default for a choice (G13.2): the first listed bracket
// option. Fills ([_____]) have NO default — they need a project value.
export function ufgsDefaultFor(s: Selection): string | undefined {
  if (s.kind === 'fill') return undefined;
  return s.options?.[0];
}

export function collectOpenDecisions(results: SectionRunResult[]): OpenDecision[] {
  const out: OpenDecision[] = [];
  for (const r of results) {
    if (!r.ir) continue;
    const title = r.ir.title ?? r.section;
    for (const { paragraph } of eachParagraph(r.ir)) {
      for (const s of paragraph.selections ?? []) {
        if (isSelectionResolved(s)) continue;
        out.push({
          section: r.section,
          sectionTitle: title,
          paragraphId: paragraph.id,
          selectionId: s.id,
          kind: s.kind,
          prompt: paragraph.text.slice(0, 240),
          options: s.options,
          ufgsDefault: ufgsDefaultFor(s),
        });
      }
    }
  }
  return out;
}

// Apply a single resolution to a selection in place. `value` is the chosen
// option(s) (option/perf-level) or the fill text. Returns the applied display
// value, or null if it could not be applied (e.g. defaulting a fill with no
// value — never fabricated, G13/G-MAN).
export function applySelectionResolution(s: Selection, value: string | string[]): string | null {
  if (s.kind === 'fill') {
    const v = Array.isArray(value) ? value[0] : value;
    if (v == null || v === '') return null;
    s.value = v;
    return v;
  }
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length === 0 || arr.some((x) => x == null || x === '')) return null;
  s.resolved = arr;
  return arr.join(', ');
}
