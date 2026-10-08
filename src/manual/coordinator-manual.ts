// The Coordinator at MANUAL scope (CHANGE-03 §4.2). NO new agent, no new
// resolver — this is the Coordinator's existing "cross-check content, emit flags"
// remit widened from "spec vs drawings" to "section vs section", driven by
// ManualContext.scope = 'manual'. Deterministic. Emits manual_coordination_flag
// rows triaged at Gate M-COORD.
//
// Checks: reference/edition conflict (feeds G9), scope gap, scope overlap,
// submittal mismatch, Div 01 vs General Conditions (both docs now present), TOC
// integrity.

import { compareSections } from './division';
import type { SectionRunResult } from './orchestrator';
import type { ManualSectionRow } from '../db/manual';
import { eachParagraph } from '../shared/section-ir';
import type { DrawingRow, ManualCoordinationFlag } from '../shared/types';

// Coarse finish/material -> governing section, for the scope-gap check below
// (a scheduled finish whose governing section is missing from the outline). A
// coordination heuristic, not outline seeding.
const FINISH_SECTION_HINTS: { match: RegExp; section: string; title: string }[] = [
  { match: /paint|coating/i, section: '09 90 00', title: 'Paints and Coatings' },
  { match: /resilient|vinyl|lvt|rubber\s*floor/i, section: '09 65 00', title: 'Resilient Flooring' },
  { match: /carpet/i, section: '09 68 00', title: 'Carpeting' },
  { match: /ceramic|tile/i, section: '09 30 00', title: 'Tiling' },
  { match: /acoustic|ceiling/i, section: '09 51 00', title: 'Acoustical Ceilings' },
];

// Minimal finish/material view for scope-gap + scope-overlap — satisfied by the
// full ExtractedProjectData or a lightweight object built from the schedule.
export interface FinishLike {
  finishes?: { finish: string; substrate: string; location?: string }[];
  materials?: { category: string; descriptor?: string }[];
}

export interface ManualCoordinateInput {
  outline: ManualSectionRow[];
  results: SectionRunResult[]; // completed/validated draft sections
  extracted: FinishLike | null;
  drawings: DrawingRow[];
}

export function coordinateManual(input: ManualCoordinateInput): ManualCoordinationFlag[] {
  const flags: ManualCoordinationFlag[] = [];
  const outlineSections = new Set(input.outline.map((s) => s.section));
  const byId = new Map(input.results.map((r) => [r.section, r]));

  // --- Reference/edition conflict (G9): one designation cited at two editions ---
  // Editions are DATA (from ref_list); the book cannot cite the same standard two
  // ways. Divergence FLAGS — it is never silently reconciled.
  const editionsByDesig = new Map<string, Map<string, string[]>>(); // designation -> edition -> [sections]
  for (const r of input.results) {
    for (const ref of r.referencesList?.references ?? []) {
      const m = editionsByDesig.get(ref.designation) ?? new Map<string, string[]>();
      const secs = m.get(ref.editionDate) ?? [];
      secs.push(r.section);
      m.set(ref.editionDate, secs);
      editionsByDesig.set(ref.designation, m);
    }
  }
  for (const [designation, editions] of editionsByDesig) {
    if (editions.size > 1) {
      const involved = [...new Set([...editions.values()].flat())];
      flags.push({
        kind: 'ref-edition-conflict',
        detail: `${designation} is cited at ${editions.size} different editions across the manual (${[...editions.keys()].join(', ')}). Editions are data; reconcile to the active ref_list edition (G9).`,
        sections: involved.sort(compareSections),
        severity: 'high',
        status: 'open',
      });
    }
  }

  // --- Scope gap: a scheduled finish/material with no governing section ---
  const required = new Map<string, string>(); // section -> title
  const descriptors = [
    ...(input.extracted?.finishes ?? []).map((f) => `${f.finish} ${f.substrate} ${f.location ?? ''}`),
    ...(input.extracted?.materials ?? []).map((m) => `${m.category} ${m.descriptor ?? ''}`),
    ...input.drawings.map((d) => d.shownFinish),
  ];
  for (const d of descriptors) {
    const hit = FINISH_SECTION_HINTS.find((m) => m.match.test(d));
    if (hit) required.set(hit.section, hit.title);
  }
  for (const [section, title] of required) {
    if (!outlineSections.has(section)) {
      flags.push({
        kind: 'scope-gap',
        detail: `A scheduled finish governed by ${section} ${title} has no section in the outline. Add the section or confirm it is out of scope.`,
        sections: [section],
        severity: 'high',
        status: 'open',
      });
    }
  }

  // --- Scope overlap: two sections specify the same finish/material category ---
  const catToSections = new Map<string, string[]>();
  for (const r of input.results) {
    if (!r.ir) continue;
    for (const { paragraph } of eachParagraph(r.ir)) {
      if (!paragraph.productCategory) continue;
      const arr = catToSections.get(paragraph.productCategory) ?? [];
      if (!arr.includes(r.section)) arr.push(r.section);
      catToSections.set(paragraph.productCategory, arr);
    }
  }
  for (const [cat, secs] of catToSections) {
    if (secs.length > 1) {
      flags.push({
        kind: 'scope-overlap',
        detail: `More than one section specifies "${cat}". Confirm the governing section to avoid conflicting requirements.`,
        sections: secs.sort(compareSections),
        severity: 'medium',
        status: 'open',
      });
    }
  }

  // --- Submittal mismatch: a technical submittal not reflected in Div 01 ---
  const div01 = input.outline.find((s) => s.role === 'div01');
  if (div01) {
    const div01Items = new Set(
      (byId.get(div01.section)?.register?.rows ?? []).map((r) => r.item.toLowerCase()),
    );
    if (div01Items.size) {
      const technicals = input.results.filter((r) => r.section !== div01.section);
      for (const r of technicals) {
        for (const row of r.register?.rows ?? []) {
          if (!div01Items.has(row.item.toLowerCase())) {
            flags.push({
              kind: 'submittal-mismatch',
              detail: `${r.section} requires submittal "${row.item}" which is not administered by Division 01 (${div01.section}). Reconcile the Div 01 submittal procedures.`,
              sections: [div01.section, r.section],
              severity: 'medium',
              status: 'open',
            });
          }
        }
      }
    }
  }

  // --- Div 01 vs General Conditions (both docs now present) ---
  const frontEnd = input.outline.find((s) => s.role === 'front-end');
  if (div01 && frontEnd) {
    flags.push({
      kind: 'div01-vs-gc',
      detail: `Division 01 (${div01.section}) submittal/administrative language must be edited to eliminate any conflict with the unalterable "${frontEnd.title}" (${frontEnd.section}). The General Conditions may not be altered by the A/E (G2).`,
      sections: [div01.section, frontEnd.section],
      severity: 'high',
      status: 'open',
    });
  }

  // --- TOC integrity: duplicates, out-of-order, drafted-but-no-body ---
  const counts = new Map<string, number>();
  for (const s of input.outline) counts.set(s.section, (counts.get(s.section) ?? 0) + 1);
  for (const [section, n] of counts)
    if (n > 1)
      flags.push({ kind: 'toc-integrity', detail: `Duplicate section number ${section} in the outline.`, sections: [section], severity: 'high', status: 'open' });
  for (let i = 1; i < input.outline.length; i++) {
    if (compareSections(input.outline[i - 1].section, input.outline[i].section) > 0) {
      flags.push({
        kind: 'toc-integrity',
        detail: `Outline is out of MasterFormat order at ${input.outline[i].section}.`,
        sections: [input.outline[i - 1].section, input.outline[i].section],
        severity: 'medium',
        status: 'open',
      });
    }
  }
  for (const s of input.outline) {
    if (s.draftingMode === 'draft' && byId.get(s.section)?.status === 'error') {
      flags.push({
        kind: 'toc-integrity',
        detail: `${s.section} is listed as drafted but produced no body (section errored). It will be shown as reserved until re-run.`,
        sections: [s.section],
        severity: 'medium',
        status: 'open',
      });
    }
  }

  return flags;
}
