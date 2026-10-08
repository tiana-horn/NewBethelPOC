// Manual freeze -> package (CHANGE-03 §6). Extends CHANGE-01 Part 5 to BOOK
// scope: assemble the whole manual -> one DOCX -> one PDF -> SHA-256 of the PDF
// bytes -> content-addressed in R2, immutable. Any edit to any section after
// freeze supersedes the whole manual (new hash, addendum flow). ONE architect-of-
// record seal page for the book, rendered INTO the DOCX before the freeze. G8
// still holds: no signing key, no applied seal — placeholders only.
//
// Two-pass render (§5): assemble -> render -> read per-section page counts ->
// re-assemble with verified counts -> re-render -> verify. Offline (no container)
// the estimated counts stand and are reported honestly.

import type { Env } from '../env';
import { assembleManual, resolveSealRoster, verifyManualPagination, type AssembleInput } from './assembler';
import type { MasterRegisterGroup } from './aggregate';
import { renderPdfViaContainer } from '../shared/render';
import { toCsv } from '../shared/csv';
import { assertSectionIssuedClean } from '../shared/specsintact';
import { disclosureMd, complianceMd, sha256Hex } from '../shared/seal';
import { textToPdf } from '../shared/pdf';
import { zip } from '../shared/zip';
import type {
  ComplianceReport,
  ManualSectionRef,
  Mode,
  ReferenceRow,
  ReviewEvidenceRow,
  TocRow,
} from '../shared/types';

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

// CHANGE-09 Stage 1 — one emitted seal page, recorded alongside the per-section
// hashes so MANIFEST.json discloses exactly who sealed what division/sections.
export interface ManualManifestSealPage {
  discipline: string;
  userName?: string;
  sections: string[];
}

export interface ManualManifestSection {
  section: string;
  role: string;
  draftingMode: string;
  hash: string; // sha256 of the section's rendered body (or lockedDocId for front-end)
  lockedDocId?: string;
  alterable?: number;
  corpusVersion?: string;
  criteriaEditions?: Record<string, string>;
}

export interface ManualManifest {
  scope: 'manual';
  contentHash: string;
  frozenAt: string;
  attestedBy: { userId: string; name: string; licenseNo: string; licenseExp: string } | null;
  mode: Mode;
  stylePackId: string;
  corpusVersion: string;
  criteriaEditions: Record<string, string>;
  modelConfig: Record<string, string>;
  promptVersion: string;
  guardrailResults: Record<string, { id: string; status: string; evidence: string }>;
  sections: ManualManifestSection[];
  sealRoster: ManualManifestSealPage[];
  // CHANGE-09 Stage 5 — the solicitation/contract number (manual_cover_meta),
  // stamped in now as the natural correlator for the future addenda/revision
  // model (out of scope for this change; captured here so it exists before
  // freeze). Undefined when the cover metadata was never filled in.
  solicitationNo?: string;
  pdfRender: 'container' | 'worker-fallback';
  pdfPages: number;
  // CHANGE-06 §6 (C2 / G16) — true iff the PDF was CONTAINER-rendered AND
  // pagination-verified. A worker-fallback (or a container render whose page
  // counts didn't verify) is preview-grade only and can NEVER be sealed.
  pdfVerified: boolean;
}

// G16 — a PDF that enters the Approved-for-Seal package must be container-rendered
// AND pagination-verified. Returns the block reason (message) when a seal is being
// attempted over a non-verified PDF, else null (not sealing, or seal-grade OK).
export function sealBlockedReason(
  m: { pdfRender: 'container' | 'worker-fallback'; pdfVerified: boolean },
  hasAttestation: boolean,
): string | null {
  if (!hasAttestation) return null; // preview freeze — not a seal package
  if (m.pdfVerified) return null; // container-rendered + verified — seal-grade
  const why =
    m.pdfRender === 'container'
      ? 'the container render did not pass pagination verification'
      : 'rendered via worker-fallback (render container unavailable)';
  return `Approve-for-Seal blocked (G16): the PDF of record requires the render container; this is preview only — ${why}.`;
}

// Render a manual PDF: LibreOffice container (verifiable pagination) if bound,
// else a flat in-Worker PDF of the section text (valid PDF, not layout-verified).
async function renderManualPdf(
  env: Env,
  docx: Uint8Array,
  fallbackLines: string[],
): Promise<{ pdf: Uint8Array; pageCount: number; path: 'container' | 'worker-fallback' }> {
  if (env.RENDER) {
    try {
      const { pdf, pageCount } = await renderPdfViaContainer(env, docx);
      if (pageCount >= 1 && pdf.length > 100) return { pdf, pageCount, path: 'container' };
    } catch {
      /* fall through */
    }
  }
  const pdf = textToPdf(fallbackLines, 'PROJECT MANUAL');
  const s = new TextDecoder('latin1').decode(pdf);
  const pageCount = (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;
  return { pdf, pageCount, path: 'worker-fallback' };
}

export interface FreezeManualInput {
  env: Env;
  assemble: AssembleInput; // cover/toc/bodies/includes/cert/pack/outline/dividers
  sections: ManualSectionRef[]; // outline (for the manifest section list)
  sectionHashes: Record<string, string>; // per-section body hash
  masterReferences: ReferenceRow[];
  masterRegister: MasterRegisterGroup[];
  compliance: ComplianceReport;
  evidence: ReviewEvidenceRow[];
  mode: Mode;
  stylePackId: string;
  modelConfig: Record<string, string>;
  criteriaEditions: Record<string, string>;
  corpusVersion: string; // C6.1 — real UFGS-Master edition from corpus_source, or 'unverified' (never a literal)
  guardrailResults: Record<string, { id: string; status: string; evidence: string }>;
}

export interface FrozenManual {
  contentHash: string;
  hash8: string;
  frozenAt: string;
  docx: Uint8Array;
  pdf: Uint8Array;
  zip: Uint8Array;
  toc: TocRow[];
  manifest: ManualManifest;
  pdfPages: number;
}

export async function freezeManual(input: FreezeManualInput): Promise<FrozenManual> {
  // CHANGE-07 §2 (G13) — issued-output hygiene on the REAL issued text (the bound
  // book bodies), not just the SpecsIntact review export. Fail closed before
  // packaging if any drafted section still carries unresolved markup / a Note to
  // Designer — in paragraph prose OR the section/part/article titles the assembler
  // issues verbatim. This is the single freeze path both single-section and manual
  // runs share, so the guarantee holds for both (unit-tested in hygiene.test.ts).
  for (const [section, body] of Object.entries(input.assemble.bodies))
    assertSectionIssuedClean(body.ir, `issued ${section}`);

  // Pass 1: assemble with estimated counts, render, read the page count.
  const pass1 = assembleManual(input.assemble);
  const flat1 = tocToLines(pass1.toc, input.assemble.projectName);
  const r1 = await renderManualPdf(input.env, pass1.docx, flat1);

  // Pass 2: distribute the verified total page count across sections proportional
  // to their estimated counts, inject into the List of Sections, re-render, verify.
  const verifiedCounts =
    r1.path === 'container' ? distributeCounts(pass1.toc, r1.pageCount) : undefined;
  const pass2 = assembleManual({ ...input.assemble, pageCounts: verifiedCounts });
  const flat2 = tocToLines(pass2.toc, input.assemble.projectName);
  const r2 = await renderManualPdf(input.env, pass2.docx, flat2);

  const docx = pass2.docx;
  const pdf = r2.pdf;
  const problems = verifyManualPagination(new TextDecoder().decode(docx), pass2.toc);
  const contentHash = 'sha256:' + (await sha256Hex(pdf));
  const hash8 = contentHash.slice(7, 15);
  const frozenAt = new Date().toISOString();

  const attestation = input.assemble.certification
    ? {
        userId: 'demo-architect',
        name: input.assemble.certification.printedName,
        licenseNo: input.assemble.certification.licenseNo,
        licenseExp: input.assemble.certification.licenseExp,
      }
    : null;

  // CHANGE-09 Stage 1 — the roster actually emitted into pass2 (real division
  // intersection with this book, including the honest AOR placeholder when no one
  // is yet assigned that role), not the raw assignment rows.
  const { pages: sealPages } = resolveSealRoster(input.assemble.outline, input.assemble.sealAssignments, input.assemble.certification);
  const sealRoster: ManualManifestSealPage[] = sealPages.map((p) => ({
    discipline: p.discipline,
    userName: p.userName,
    sections: p.sections.map((s) => s.section),
  }));

  const manifest: ManualManifest = {
    scope: 'manual',
    contentHash,
    frozenAt,
    attestedBy: attestation,
    solicitationNo: input.assemble.coverMeta?.solicitationNo?.trim() || undefined,
    mode: input.mode,
    stylePackId: input.stylePackId,
    corpusVersion: input.corpusVersion,
    criteriaEditions: input.criteriaEditions,
    modelConfig: input.modelConfig,
    promptVersion: 'v1',
    guardrailResults: input.guardrailResults,
    sealRoster,
    sections: input.sections.map((s) => ({
      section: s.section,
      role: s.role,
      draftingMode: s.draftingMode,
      hash: input.sectionHashes[s.section] ?? (s.lockedDocId ? `locked:${s.lockedDocId}` : 'reserved'),
      lockedDocId: s.lockedDocId,
      alterable: s.role === 'front-end' ? 0 : undefined,
      criteriaEditions: s.role === 'front-end' ? undefined : input.criteriaEditions,
    })),
    pdfRender: r2.path,
    pdfPages: r2.pageCount,
    // Seal-grade iff container-rendered AND pagination verified clean (§6 / G16).
    pdfVerified: r2.path === 'container' && problems.length === 0,
  };

  const zipBytes = zip([
    { name: 'project-manual.pdf', content: pdf },
    { name: 'project-manual.docx', content: docx },
    { name: 'MANIFEST.json', content: JSON.stringify(manifest, null, 2) },
    { name: 'table-of-contents.csv', content: toCsv(pass2.toc, ['section', 'title', 'role', 'draftingMode', 'pageCount']) },
    { name: 'master-references.csv', content: toCsv(input.masterReferences, ['org', 'designation', 'editionDate', 'title', 'rid']) },
    // CHANGE-09 §4 — ENG-4025-style column layout: section, paragraph, SD-code,
    // description, classification, approving authority, action ('action' is
    // intentionally always blank — no invented review status; it's the
    // reviewer's column to fill in post-award).
    {
      name: 'master-submittal-register.csv',
      content: toCsv(
        input.masterRegister.flatMap((g) => g.rows.map((r) => ({ section: g.section, ...r }))),
        ['section', 'paragraphId', 'sdCode', 'item', 'classification', 'approvingAuthority', 'action'],
      ),
    },
    { name: 'review-evidence.csv', content: toCsv(input.evidence, ['gate', 'element', 'action', 'beforeVal', 'afterVal', 'userId', 'at']) },
    { name: 'compliance.md', content: complianceMd(input.compliance) },
    { name: 'DISCLOSURE.md', content: disclosureMd(input.mode) + `\n\n_Book scope: outline-only and errored sections are shown as reserved (G-MAN). A seal-and-signature page is emitted for each sealing-role assignment (${sealRoster.length} on this book), scoped to its assigned divisions — placeholders only, never an applied seal (G8). Any division with no sealing assignment is flagged (seal-coverage-gap) at Gate M-COORD, not silently sealed._` },
    ...(problems.length ? [{ name: 'pagination-warnings.txt', content: problems.join('\n') }] : []),
  ]);

  return { contentHash, hash8, frozenAt, docx, pdf, zip: zipBytes, toc: pass2.toc, manifest, pdfPages: r2.pageCount };
}

function tocToLines(toc: TocRow[], projectName: string): string[] {
  const lines = ['PROJECT MANUAL', projectName, '', 'TABLE OF CONTENTS — LIST OF SECTIONS', ''];
  for (const t of toc) lines.push(`${t.section}  ${t.title}  —  ${t.pageCount} p.  (${t.draftingMode})`);
  return lines;
}

// Distribute the verified total page count across sections proportional to their
// estimates, giving each at least one page. Uses largest-remainder apportionment
// so the parts ALWAYS sum to `total` exactly (naive per-section rounding could
// overshoot, forcing the last section to a clamped 1 and desyncing the counts).
function distributeCounts(toc: TocRow[], total: number): Record<string, number> {
  const out: Record<string, number> = {};
  const n = toc.length;
  if (n === 0) return out;
  const est = toc.map((t) => Math.max(0, t.pageCount));
  const sum = est.reduce((a, b) => a + b, 0) || 1;
  const target = Math.max(total, n); // can't show fewer than 1 page per section
  const counts = toc.map(() => 1); // floor: one page each
  const remaining = target - n; // pages left to apportion (>= 0)
  const share = est.map((e) => (e / sum) * remaining);
  const add = share.map((x) => Math.floor(x));
  for (let i = 0; i < n; i++) counts[i] += add[i];
  let assigned = add.reduce((a, b) => a + b, 0);
  const byRemainder = share
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; assigned < remaining; k++, assigned++) counts[byRemainder[k % n].i]++;
  toc.forEach((t, i) => (out[t.section] = counts[i]));
  return out;
}

export { b64 as manualB64 };
