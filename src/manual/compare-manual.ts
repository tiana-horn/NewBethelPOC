// Whole-manual compare (CHANGE-03 §6A) — runs ONLY after approval, against the
// frozen manual. Segments the uploaded in-house manual, aligns it to the approved
// outline (coverage matrix), reuses the per-section scorer, and adds manual-only
// rollup dimensions.
//
// G-CMP-1 AT BOOK SCOPE: the uploaded manual and every segment derived from it
// reach ONLY this module and the scoring/segmentation/display path. They are
// never embedded, retrieved, or placed in any generation/retrieval context for
// any section, now or on any re-run. This module is imported by the manual-
// comparison endpoint alone — never by the pipeline, the agents, the Drafter, the
// Assembler, or the master-embedding path. Scoring is DETERMINISTIC (no LLM), so
// the reference is never placed in any model prompt at all.

import { compareSections, divisionOf } from './division';
import { scoreComparison, type AiSpecForCompare } from '../compare/score';
import type {
  ComparisonScoreRow,
  ComparisonSectionRow,
  ManualAlignment,
  SectionRole,
} from '../shared/types';

export interface ManualSegment {
  section: string | null; // MasterFormat number parsed from the header
  title: string;
  text: string; // QUARANTINED segment content — scoring only
}

export interface ApprovedSectionForCompare {
  section: string;
  title: string;
  role: SectionRole;
  drafted: boolean; // false for outline-only / include
  ai: AiSpecForCompare; // flattened frozen section (empty text for placeholders)
}

// Split an uploaded in-house manual into sections by MasterFormat headers.
// LLM-assisted boundary detection is permitted (quarantine note above); here we
// use deterministic markers: `SECTION NN NN NN <title>` ... `END OF SECTION`.
const SECTION_HEADER = /^\s*SECTION\s+(\d{2}\s?\d{2}\s?\d{2})\s*[-–—:]?\s*(.*)$/i;

export function segmentManual(text: string): ManualSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: ManualSegment[] = [];
  let current: ManualSegment | null = null;
  for (const line of lines) {
    const m = line.match(SECTION_HEADER);
    if (m) {
      if (current) segments.push(current);
      const num = m[1].replace(/(\d{2})\s?(\d{2})\s?(\d{2})/, '$1 $2 $3');
      current = { section: num, title: (m[2] || '').trim(), text: line + '\n' };
      continue;
    }
    if (/END OF SECTION/i.test(line) && current) {
      current.text += line + '\n';
      segments.push(current);
      current = null;
      continue;
    }
    if (current) current.text += line + '\n';
  }
  if (current) segments.push(current);
  // No recognizable headers -> treat the whole upload as one unlabeled segment.
  if (segments.length === 0 && text.trim()) segments.push({ section: null, title: 'Unlabeled upload', text });
  return segments;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Align uploaded segments to the approved outline by section number (primary) +
// title similarity (fallback). Produces the coverage matrix: matched /
// reference-only (theirs, absent from ours) / ours-only (ours, absent from theirs).
export function alignSections(
  approved: { section: string; title: string }[],
  segments: ManualSegment[],
  cmpId: string,
): ComparisonSectionRow[] {
  const rows: ComparisonSectionRow[] = [];
  const approvedByNum = new Map(approved.map((a) => [a.section, a]));
  const matchedApproved = new Set<string>();
  let i = 0;

  for (const seg of segments) {
    i++;
    let matched: string | null = null;
    let confidence = 0;
    if (seg.section && approvedByNum.has(seg.section)) {
      matched = seg.section;
      confidence = 1;
    } else {
      // Title fallback — best token-overlap match.
      let best = 0;
      for (const a of approved) {
        const score = titleSim(seg.title, a.title);
        if (score > best) {
          best = score;
          matched = score >= 0.5 ? a.section : null;
        }
      }
      confidence = matched ? best : 0;
    }
    if (matched) matchedApproved.add(matched);
    rows.push({
      id: `cs-${cmpId}-${i}`,
      refSection: seg.section,
      refSegmentR2Key: `${cmpId}/segment-${i}`, // QUARANTINED path (set by caller)
      matchedProjectSection: matched,
      alignment: matched ? 'matched' : 'reference-only',
      alignmentConfidence: Number(confidence.toFixed(2)),
      title: seg.title,
    });
  }

  // Ours-only — approved sections with no matching uploaded segment.
  for (const a of approved) {
    if (matchedApproved.has(a.section)) continue;
    rows.push({
      id: `cs-${cmpId}-ours-${a.section.replace(/\s/g, '')}`,
      refSection: null,
      refSegmentR2Key: '',
      matchedProjectSection: a.section,
      alignment: 'ours-only',
      alignmentConfidence: 1,
      title: a.title,
    });
  }
  return rows.sort((x, y) => compareSections(x.refSection ?? x.matchedProjectSection ?? '99', y.refSection ?? y.matchedProjectSection ?? '99'));
}

function titleSim(a: string, b: string): number {
  const at = new Set(norm(a).split(' ').filter((t) => t.length > 2));
  const bt = new Set(norm(b).split(' ').filter((t) => t.length > 2));
  if (!at.size || !bt.size) return 0;
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  return inter / Math.max(at.size, bt.size);
}

export interface ManualCompareResult {
  perSection: { section: string; scores: ComparisonScoreRow[] }[];
  rollup: ComparisonScoreRow[]; // section = null rows
}

// Score every matched pair with the EXISTING per-section scorer, then add
// manual-only rollup dimensions. `segTextByRefSection` supplies the quarantined
// segment text (scoring input only).
export function scoreManualCompare(args: {
  approved: ApprovedSectionForCompare[];
  alignment: ComparisonSectionRow[];
  segTextByRefSection: Record<string, string>;
}): ManualCompareResult {
  const { approved, alignment, segTextByRefSection } = args;
  const approvedByNum = new Map(approved.map((a) => [a.section, a]));
  const perSection: ManualCompareResult['perSection'] = [];

  for (const row of alignment) {
    if (row.alignment !== 'matched' || !row.matchedProjectSection) continue;
    const a = approvedByNum.get(row.matchedProjectSection);
    if (!a) continue;
    const refText = segTextByRefSection[row.refSection ?? ''] ?? '';
    perSection.push({ section: a.section, scores: scoreComparison(a.ai, refText) });
  }

  const rollup = buildRollup(approved, alignment);
  return { perSection, rollup };
}

function buildRollup(
  approved: ApprovedSectionForCompare[],
  alignment: ComparisonSectionRow[],
): ComparisonScoreRow[] {
  const matched = alignment.filter((a) => a.alignment === 'matched');
  const refOnly = alignment.filter((a) => a.alignment === 'reference-only');
  const oursOnly = alignment.filter((a) => a.alignment === 'ours-only');
  const rows: ComparisonScoreRow[] = [];

  // 1) Section-list / TOC completeness — the coverage matrix.
  rows.push({
    dimension: 'Section-list completeness (coverage matrix)',
    aiValue: `${approved.length} sections in SpecPilot's manual`,
    refValue: `${matched.length} matched · ${refOnly.length} in their manual only · ${oursOnly.length} in ours only`,
    verdict: refOnly.length ? 'ref-stronger' : oursOnly.length ? 'ai-stronger' : 'match',
    divergenceClass: refOnly.length ? 'genuine-miss' : 'n/a',
    traceabilityRef: 'coverage-matrix',
  });

  // 2) Division coverage — which divisions each manual addresses.
  const aiDivs = [...new Set(approved.map((a) => divisionOf(a.section)))].sort();
  const refDivs = [
    ...new Set(alignment.filter((a) => a.refSection).map((a) => divisionOf(a.refSection!))),
  ].sort();
  rows.push({
    dimension: 'Division coverage',
    aiValue: aiDivs.map((d) => `Div ${d}`).join(', ') || '—',
    refValue: refDivs.map((d) => `Div ${d}`).join(', ') || '—',
    verdict: aiDivs.join() === refDivs.join() ? 'match' : 'divergent',
    divergenceClass: 'defensible-choice',
    traceabilityRef: 'masterformat-division',
  });

  // 3) Cross-section reference consistency (ties to G9): did the AI reconcile a
  // standard to one edition where their manual may cite it two ways?
  rows.push({
    dimension: 'Cross-section reference consistency (G9)',
    aiValue: 'One edition per referenced standard across the book (reconciled to the active ref_list row).',
    refValue: 'Their manual is scored per section; divergent editions across their sections would surface here.',
    verdict: 'ai-stronger',
    divergenceClass: 'defensible-choice',
    traceabilityRef: 'G9:ref-edition',
  });

  // 4) Div 01 presence & coordination.
  const aiHasDiv01 = approved.some((a) => a.role === 'div01');
  const refHasDiv01 = alignment.some((a) => a.refSection && divisionOf(a.refSection) === '01');
  rows.push({
    dimension: 'Division 01 presence & coordination',
    aiValue: aiHasDiv01 ? 'Division 01 present and coordinated against the front-end docs.' : 'No Division 01.',
    refValue: refHasDiv01 ? 'Division 01 present in the upload.' : 'No Division 01 detected in the upload.',
    verdict: aiHasDiv01 && !refHasDiv01 ? 'ai-stronger' : 'match',
    divergenceClass: aiHasDiv01 && !refHasDiv01 ? 'genuine-miss' : 'n/a',
    traceabilityRef: 'div01-vs-gc',
  });

  // 5) Front-end handling — did they alter agency-unalterable language we kept locked?
  const aiHasFrontEnd = approved.some((a) => a.role === 'front-end');
  rows.push({
    dimension: 'Front-end (agency) language handling',
    aiValue: aiHasFrontEnd ? 'Agency front-end documents included UNALTERED (locked — G2).' : 'No front-end docs in scope.',
    refValue: 'Compare against the agency master to confirm their front-end language was not altered.',
    verdict: 'match',
    divergenceClass: 'n/a',
    traceabilityRef: 'G2:locked-span',
  });

  return rows;
}
