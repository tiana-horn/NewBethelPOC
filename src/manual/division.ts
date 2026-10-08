// Division derivation + MasterFormat ordering (CHANGE-03). Pure, deterministic —
// the manual's spine is sorted by MasterFormat number, and each section's role is
// implied by its division: Division 00 = front-end (procurement/contracting), 01
// = General Requirements, 02–49 = technical. No LLM, no mode branch.

import type { DraftingMode, ManualSectionRef, SectionRole } from '../shared/types';

// MasterFormat six-digit number -> its two-digit division ('00'..'49').
export function divisionOf(section: string): string {
  const digits = section.replace(/\D/g, '');
  return digits.slice(0, 2).padStart(2, '0') || '00';
}

// Role implied by the division. Front-end (Div 00) is included unaltered; Div 01
// is drafted (General Requirements); Div 02–49 are the technical sections.
export function roleOf(section: string): SectionRole {
  const div = divisionOf(section);
  if (div === '00') return 'front-end';
  if (div === '01') return 'div01';
  return 'technical';
}

// The default drafting mode for a role, before the user edits it. Front-end docs
// are `include` (from locked_docs); div01 + technical are `draft` where corpus
// exists (the caller downgrades to `outline` when no corpus is available).
export function defaultDraftingMode(role: SectionRole): DraftingMode {
  return role === 'front-end' ? 'include' : 'draft';
}

// Compare by MasterFormat number, then by the numeric section value, so the
// outline / List of Sections is always in canonical order.
export function compareSections(a: string, b: string): number {
  const na = Number(a.replace(/\D/g, ''));
  const nb = Number(b.replace(/\D/g, ''));
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

// Sort a set of section refs into MasterFormat order and (re)assign orderIndex so
// the outline is canonical and stable — the TOC integrity check depends on it.
export function orderSections(sections: ManualSectionRef[]): ManualSectionRef[] {
  const sorted = [...sections].sort((x, y) => compareSections(x.section, y.section));
  return sorted.map((s, i) => ({ ...s, division: divisionOf(s.section), role: roleOf(s.section), orderIndex: i }));
}

// ============================================================================
// CHANGE-09 Stage 2 — agency tailoring-suffix correctness. Real UFGS numbers
// carry an agency-tailoring suffix in the exact form `.00 NN` (e.g. `09 90 00.00
// 10` Army/USACE, `.00 20` NAVFAC, `.00 40` Air Force) — distinct from an ordinary
// SectionFormat sub-number like `35 20 16.33`, which names a genuinely DIFFERENT
// section, not an agency-tailored copy of the same one. Only the `.00 NN` form is
// ever collapsed/selected here; section numbers are otherwise used exactly as they
// appear in the free SEC files (CHANGE-05 §4.2), never synthesized.
// ============================================================================

const AGENCY_TAILORING_SUFFIX: Record<string, string> = { ARMY: '10', NAVY: '20', AIRFORCE: '40' };

// The base numbering slot a `.00 NN` agency-tailored section belongs to (identity
// for every other section number, including a non-agency `.NN` sub-number).
export function baseSectionKey(section: string): string {
  return section.replace(/\.00 \d{2}\s*$/, '').trim();
}

// Pick ONE catalog/candidate entry per base numbering slot: the one whose `.00 NN`
// suffix matches the project's agency; else the bare tri-service entry (no
// suffix) when one exists; else the first (stable, catalog order). Never
// fabricates a suffix or a variant with no backing SEC file — it only chooses
// among entries the caller already found. A slot with just one entry passes
// through untouched.
export function selectAgencyVariant<T extends { section: string }>(candidates: T[], agency?: string | null): T[] {
  const wantSuffix = agency ? AGENCY_TAILORING_SUFFIX[agency] : undefined;
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of candidates) {
    const key = baseSectionKey(c.section);
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(c);
  }
  const out: T[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) { out.push(group[0]); continue; }
    const preferred =
      (wantSuffix && group.find((g) => g.section.endsWith(`.00 ${wantSuffix}`))) ||
      group.find((g) => !/\.00 \d{2}$/.test(g.section)) ||
      group[0];
    out.push(preferred);
  }
  return out;
}
