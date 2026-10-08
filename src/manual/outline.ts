// Outline seeding + ManualContext construction (CHANGE-03 §3). The outline is
// the manual's spine and TOC source of truth: SEEDED from the confirmed intake
// (ExtractedProjectData) + the mode's locked_docs, then USER-CONFIRMED at Gate
// M0. We propose; we never auto-run. Deterministic, no LLM — automatic full-book
// generation from drawings is explicitly out of scope (§3).

import { baseSectionKey, divisionOf, orderSections, roleOf, selectAgencyVariant } from './division';
import type { ExtractedProjectData, ManualContext, ManualSectionRef } from '../shared/types';

// CHANGE-05 §2 — the mode-agnostic `seedOutline` (illustrative FINISH_TO_SECTION
// map + planted 09 72 00 scope gap) and `frontEndDocFor` are REMOVED. The SEC
// matcher (`computeOutlineFromCandidates`) is the only outline seeder; Div 00
// front-end docs come from the agency locked_docs passed to it.

// CHANGE-09 Stage 3 — the mandatory Division 01 checklist (db/seed-div01.sql /
// mandatory_div01_section), force-included in every outline regardless of intake
// features (they are required BY RULE, not implied by building features). Callers
// that can reach D1 pass the seeded list (db/corpus.ts getMandatoryDiv01Sections);
// this fallback keeps the pure functions below usable/testable without a DB.
export interface MandatoryDiv01Item {
  section: string;
  title: string;
}
export const DEFAULT_MANDATORY_DIV01: MandatoryDiv01Item[] = [
  { section: '01 11 00', title: 'Summary of Work' },
  { section: '01 20 00', title: 'Price and Payment Procedures' },
  { section: '01 30 00', title: 'Administrative Requirements' },
  { section: '01 32 00', title: 'Construction Progress Documentation' },
  { section: '01 33 00', title: 'Submittal Procedures' },
  { section: '01 45 00', title: 'Quality Control' },
  { section: '01 50 00', title: 'Temporary Facilities and Controls' },
  { section: '01 57 19', title: 'Temporary Environmental Controls' },
  { section: '01 60 00', title: 'Product Requirements' },
  { section: '01 70 00', title: 'Execution and Closeout Requirements' },
  { section: '01 78 00', title: 'Closeout Submittals' },
];

// A mandatory item names the CANONICAL bare number. If the ingested corpus has
// that exact number, use it; else look for an ingested `.00 NN` agency-tailored
// variant of the same base slot and prefer the one matching the project's agency
// (CHANGE-09 §2); else there is no SEC file at all for this requirement and it is
// honestly reserved under the canonical number (never invented, G-MAN).
function resolveMandatoryTarget(
  item: MandatoryDiv01Item,
  corpusSections: Set<string>,
  agency: string | null | undefined,
): MandatoryDiv01Item {
  if (corpusSections.has(item.section)) return item;
  const variants = [...corpusSections].filter((s) => baseSectionKey(s) === item.section);
  if (variants.length === 0) return item;
  const [chosen] = selectAgencyVariant(variants.map((section) => ({ section })), agency);
  return { section: chosen.section, title: item.title };
}

// Division 00 front-end docs come from the agency's `locked_docs`. When none are
// configured for this profile, the book still lists a Division 00 entry — a
// clearly-labeled government/contracting-furnished placeholder — rather than
// silently omitting the division (CHANGE-09 §3; the DoD reality that the A/E book
// often begins at Division 01, disclosed honestly instead of an unexplained gap).
const DIV00_UNCONFIGURED_TITLE = 'General Conditions (Government/Contracting-Furnished — Not Configured for This Profile)';

// CHANGE-05 §4 — the outline is seeded by the SEC-catalog matcher
// (`computeOutlineFromCandidates`, below), not the reverted OmniClass crosswalk.
// This function is the MINIMAL FALLBACK the endpoint uses only when no corpus is
// ingested or the intake yields no usable features: it proposes the mandatory
// front-end (Div 00) + Div 01 general requirements so the manual is never empty,
// with no fabricated technical sections (honest per G-MAN).
export interface ComputeOutlineInput {
  extracted: ExtractedProjectData | null;
  corpusSections: Set<string>; // sections with real UFGS corpus
  lockedDocs?: { ldid: string; title: string }[];
  agency?: string | null; // CHANGE-09 Stage 2
  mandatoryDiv01?: MandatoryDiv01Item[]; // CHANGE-09 Stage 3 — defaults to DEFAULT_MANDATORY_DIV01
}

export function computeModeAOutline(input: ComputeOutlineInput): ManualSectionRef[] {
  const refs: ManualSectionRef[] = [];
  const seen = new Set<string>();
  const add = (section: string, title: string, draftingMode: ManualSectionRef['draftingMode'], lockedDocId?: string) => {
    if (seen.has(section)) return;
    seen.add(section);
    refs.push({ section, title, division: divisionOf(section), orderIndex: 0, role: roleOf(section), draftingMode, lockedDocId });
  };
  const draftOrOutline = (section: string): ManualSectionRef['draftingMode'] =>
    input.corpusSections.has(section) ? 'draft' : 'outline';

  // Division 00 front-end docs (agency locked_docs), included unaltered; an
  // honest reserved placeholder when none are configured (CHANGE-09 §3).
  if ((input.lockedDocs ?? []).length > 0) {
    for (const ld of input.lockedDocs!) add('00 72 00', ld.title, 'include', ld.ldid);
  } else {
    add('00 72 00', DIV00_UNCONFIGURED_TITLE, 'outline');
  }
  // Division 01 general requirements — the mandatory checklist, proposed even
  // when uncorpused (G-MAN), independent of any feature match.
  for (const item of input.mandatoryDiv01 ?? DEFAULT_MANDATORY_DIV01) {
    const t = resolveMandatoryTarget(item, input.corpusSections, input.agency);
    add(t.section, t.title, draftOrOutline(t.section));
  }

  return orderSections(refs);
}

// CHANGE-05 §4.3 — seed the outline from the SEC-catalog matcher's candidate
// sections (replaces the reverted OmniClass `impliedSections` path). Every
// candidate resolved to a real SEC catalog entry, so it is `draft` when the
// corpus is ingested (else `outline`, honest per G-MAN). Div 00 front-end docs
// and Div 01 general requirements are added regardless (they don't come from
// feature matching). The matcher SEEDS; Gate M0 still confirms.
export interface CandidateOutlineInput {
  candidates: { section: string; title: string; confidence?: number }[];
  corpusSections: Set<string>;
  lockedDocs?: { ldid: string; title: string }[];
  // CHANGE-09 Stage 2 — the project's agency ('ARMY'|'NAVY'|'AIRFORCE'|'OTHER'),
  // for selecting the correct `.00 NN` tailored variant when the matcher surfaces
  // more than one SEC file for the same base numbering slot (see division.ts
  // selectAgencyVariant). Undefined/'OTHER' prefers the bare tri-service entry.
  agency?: string | null;
  // CHANGE-09 Stage 3 — the mandatory Division 01 checklist; defaults to
  // DEFAULT_MANDATORY_DIV01 when the caller has no DB-seeded list at hand.
  mandatoryDiv01?: MandatoryDiv01Item[];
}
export function computeOutlineFromCandidates(input: CandidateOutlineInput): ManualSectionRef[] {
  const refs: ManualSectionRef[] = [];
  const seen = new Set<string>();
  const add = (section: string, title: string, draftingMode: ManualSectionRef['draftingMode'], lockedDocId?: string) => {
    if (seen.has(section)) return;
    seen.add(section);
    refs.push({ section, title, division: divisionOf(section), orderIndex: 0, role: roleOf(section), draftingMode, lockedDocId });
  };
  const draftOrOutline = (section: string): ManualSectionRef['draftingMode'] =>
    input.corpusSections.has(section) ? 'draft' : 'outline';

  // Div 00 front-end docs (agency locked_docs), included unaltered; an honest
  // reserved placeholder when none are configured (CHANGE-09 §3).
  if ((input.lockedDocs ?? []).length > 0) {
    for (const ld of input.lockedDocs!) add('00 72 00', ld.title, 'include', ld.ldid);
  } else {
    add('00 72 00', DIV00_UNCONFIGURED_TITLE, 'outline');
  }
  // Div 01 general requirements — the mandatory checklist, always proposed
  // (G-MAN), not feature-driven (CHANGE-09 §3).
  for (const item of input.mandatoryDiv01 ?? DEFAULT_MANDATORY_DIV01) {
    const t = resolveMandatoryTarget(item, input.corpusSections, input.agency);
    add(t.section, t.title, draftOrOutline(t.section));
  }
  // Technical sections from the matcher, highest-confidence first (order within a
  // division is normalized by orderSections; confidence only breaks catalog ties).
  // CHANGE-09 Stage 2 — collapse same-base-slot agency variants to the one
  // matching the project's agency (or the sole/bare one) BEFORE adding, so the
  // outline never carries two SEC files for the same tailored numbering slot.
  for (const c of selectAgencyVariant(input.candidates, input.agency)) add(c.section, c.title || c.section, draftOrOutline(c.section));

  return orderSections(refs);
}

export function buildManualContext(
  projectId: string,
  sections: ManualSectionRef[],
  opts: { dividers?: boolean; coverTemplateId?: string } = {},
): ManualContext {
  const ordered = orderSections(sections);
  return {
    projectId,
    scope: 'manual',
    sections: ordered,
    frontEndDocIds: ordered.filter((s) => s.role === 'front-end' && s.lockedDocId).map((s) => s.lockedDocId!),
    assembly: {
      coverTemplateId: opts.coverTemplateId ?? 'csi-baseline',
      tocStyle: 'list-of-sections',
      dividers: opts.dividers ?? true,
      sealPageScope: 'manual',
    },
  };
}
